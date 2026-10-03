# Engineering Practices Research: Managed Update Lifecycle

## Executive Summary

Issue #148 should be implemented as a thin `update` action over existing plan, Docker, readiness,
and generation primitives. The repository already has most of the lifecycle mechanics:
`generatePlan({ checkUpdates: true })` detects registry digest differences, plan storage provides a
stale-compose guard, apply/deploy already pull and start services, readiness polling returns structured
evidence, and successful state records automatically create generations.

The missing piece is a small, testable coordinator that preserves the pre-update restore target,
revalidates the candidate immediately before mutation, executes one service lifecycle, verifies it,
and restores that service when verification fails. Do not call `executePlan`, `executeApply`,
`executeHealth`, or `executeRollback` from the new action: those functions own CLI output,
confirmation, exit codes, and database lifetimes. Reuse their lower-level library functions and
extract only the restore operation currently trapped inside `executeRollback`.

The highest-risk gap is snapshot fidelity. Current generations store `imageTag` and a serialized
config snapshot, but a mutable tag does not identify the pre-update image bytes. Restore-on-failure
must not be advertised as guaranteed until the workflow captures and restores an immutable digest or
image ID and verifies that the image is locally available. Volumes and application databases remain
outside the rollback boundary.

## Existing Reusable Code

| Exact path                                         | Function or contract                                                                   | Reuse in managed update                                                                                                      | Constraint                                                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/plan-generator.ts`    | `generatePlan(options, envTool)`                                                       | Detect selected services and populate `image.updateAvailable`, `localDigest`, and `remoteDigest` when `checkUpdates` is true | Returns `undefined` when compose inspection fails; locally built services deliberately bypass registry comparison                                                           |
| `packages/rfapps-cli/src/types/plan.ts`            | `DeploymentPlan`, `ServiceChange`, `ImageDiff`, `PlanSummary`, `PlanOptions`           | Base preview and machine-result inputs on the established plan vocabulary                                                    | `hasUpdate: false` and an unavailable digest are currently collapsed into `updateAvailable: false`; update orchestration needs an explicit unknown/skipped outcome          |
| `packages/rfapps-cli/src/lib/docker.ts`            | `checkImageUpdate`, `getLocalImageDigest`, `getRemoteImageDigest`, `ImageUpdateCheck`  | Revalidate local and remote digests immediately before each apply                                                            | `ImageUpdateCheck.hasUpdate` is boolean even on lookup error; callers must inspect `error` rather than treating false as confirmed current                                  |
| `packages/rfapps-cli/src/lib/plan-storage.ts`      | `savePlan`, `loadPlan`, `validatePlan`, `hashFile`                                     | Persist preview evidence and reject changed compose configuration before mutation                                            | Validation protects compose content and age, not registry-digest freshness; digest revalidation remains mandatory                                                           |
| `packages/rfapps-cli/src/actions/plan.ts`          | `executePlan`; private `displayPlan` and `displayServiceChange`                        | Follow option normalization and human-output conventions                                                                     | Display helpers are private and action-coupled; do not export them solely for the new command unless identical output is a requirement                                      |
| `packages/rfapps-cli/src/lib/docker.ts`            | `pullImages`, `startServices`, `getRunningContainers`, `inspectContainers`             | Execute pull/recreate and collect post-start evidence using established Docker wrappers                                      | Functions return command-shaped success/error results; coordinator should translate these once into lifecycle stage results                                                 |
| `packages/rfapps-cli/src/lib/health.ts`            | `waitForDependencyReadiness(options)`                                                  | Verify readiness with the configured timeout, interval, retries, and structured per-dependency details                       | It checks dependencies of target services, not necessarily the target container's own application health; define whether that satisfies issue #148                          |
| `packages/rfapps-cli/src/types/health.ts`          | `DependencyReadinessSummary`, `ReadinessSignalAvailability`, probe/result types        | Embed verification evidence in each service report                                                                           | Unavailable telemetry is distinct from failed readiness and must remain distinct in the update result                                                                       |
| `packages/rfapps-cli/src/lib/state-storage.ts`     | `recordDeployment`, `recordDeployments`, `maskSensitiveEnvVars`                        | Record successful/failed update attempts and obtain generations automatically for successful deploy-like actions             | `DeploymentAction` has no `update` member; reusing `apply` loses intent, while adding `update` requires the state type/schema-facing conventions to be updated consistently |
| `packages/rfapps-cli/src/lib/generations.ts`       | `createGeneration`, `getGenerations`, `findGenerationByNumber`, `findGenerationAtTime` | Resolve and report pre/post generation numbers                                                                               | Generation creation is intentionally behind successful state recording; do not call `createGeneration` separately and risk duplicate snapshots                              |
| `packages/rfapps-cli/src/actions/rollback.ts`      | `executeRollback`; private `generationToTarget` and restore sequence                   | Reuse generation lookup rules and extract a library restore primitive for automatic failure recovery                         | The action mixes lookup, confirmation, display, Docker mutation, and recording; calling it from update would nest UI and database policy                                    |
| `packages/rfapps-cli/src/lib/state-queries.ts`     | `getLatestDeployment`, `findRollbackTarget`, `findDeploymentById`                      | Resolve history-backed restore candidates where generation lookup is insufficient                                            | History entries may predate generations or lack a usable image reference                                                                                                    |
| `packages/rfapps-cli/src/lib/action-helpers.ts`    | `inspectContainersWithRetry`                                                           | Capture the running image after recreate before recording the post-update generation                                         | Mapping is by inspected container name; compose service/container-name differences must be handled as existing actions do                                                   |
| `packages/rfapps-cli/src/lib/services.ts`          | `resolveServicesWithInteractive`, `expandServicesWithSidecars` via library exports     | Preserve normal service/group/profile/sidecar selection behavior                                                             | Automatic per-service recovery should report sidecars separately and must not silently restore unrelated selected services                                                  |
| `packages/rfapps-cli/src/lib/db.ts`                | `initializeDatabase`, `closeDatabase`                                                  | Use one action-owned database lifetime for snapshot lookup and final recording                                               | Keep database handles out of CLI registration and always close in `finally`                                                                                                 |
| `packages/rfapps-cli/src/lib/parallel-executor.ts` | `computeExecutionPhases`, `executeParallelPhases`                                      | Potential future batch execution after semantics are stable                                                                  | Restore sequencing and dependency blast radius make parallel mutation inappropriate for the first implementation                                                            |

## Modularity Design

Use three layers consistent with the codebase:

1. `src/commands/update.ts` registers flags and forwards Commander options. It contains no Docker,
   state, or formatting policy.
2. `src/actions/update.ts` normalizes options, loads config, resolves services/profiles, renders the
   preview, asks for the one explicit apply confirmation, opens/closes state, formats text/JSON/YAML,
   and sets the process exit code.
3. `src/lib/managed-update.ts` owns lifecycle decisions and returns structured data. Its public entry
   point should accept resolved dependencies so unit tests can replace Docker, readiness, clock, and
   state behavior without process-level mocks.

A practical interface is `runManagedUpdate(input, dependencies): Promise<ManagedUpdateResult>`, with
one private `runServiceUpdate(candidate, context)` loop. Execute candidates sequentially in the first
version. That makes the restore target and failure boundary unambiguous, avoids overlapping pulls and
rollbacks, and yields deterministic reports. Dependency-order parallelism can be added later if an
actual performance problem is measured.

Keep preview as an ordinary persisted `DeploymentPlan`, but add explicit managed-update intent or
metadata rather than inferring intent from `checkUpdates` output. Ordinary `apply` currently selects
services by `changeType`; a digest-only update can remain `unchanged`, so a managed-update plan needs
an explicit candidate list or an apply rule based on `image.updateAvailable`. The generic
`executeApply` should not accidentally consume a managed-update plan without restore semantics.

## Shared vs Feature-Specific

| Shared infrastructure                          | Feature-specific policy                                             |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| Compose/config loading and service resolution  | Which services qualify as update candidates                         |
| Local/remote digest queries                    | Whether unknown digest state blocks apply or is skipped             |
| Plan serialization and compose-hash validation | Managed-update intent, preview summary, and revalidation rules      |
| Docker pull/start/inspect wrappers             | Per-service detect/apply/verify/restore state machine               |
| Readiness polling contracts                    | What constitutes update success versus unverifiable success         |
| Generation/history storage                     | Pre-update protection requirement and pre/post generation reporting |
| Error formatters and machine output dispatch   | Stable managed-update result schema and stage-specific errors       |
| Existing confirmation utility                  | One explicit confirmation after preview and before first mutation   |

Do not generalize the entire deploy/apply action family around a new workflow abstraction. The shared
pieces already exist below the action layer. Only restore execution and, if needed, update-result
classification should move into reusable libraries.

## KISS Assessment

The simplest safe implementation is a sequential coordinator with five visible stages per service:
detect, previewed, applied, verified, restored. It should stop mutating a failed service, attempt its
restore once, record both primary and restore outcomes, then continue or stop according to one clearly
documented policy. A single result object can support both human and machine formats.

Avoid a generic state-machine framework, event bus, plugin system, repository class, or Docker client
replacement. Those abstractions add indirection without solving an existing second use case. A string
union for lifecycle stage/status plus a small coordinator is enough. Also avoid making
`executeUpdate` call other `execute*` actions: that looks simple initially but creates nested prompts,
duplicated output, implicit `process.exitCode` changes, and state records that cannot be correlated.

## Extract vs Acceptable Duplication

Extract these seams:

- Extract the Docker mutation portion of rollback into a library function such as
  `restoreServiceToImage(input): Promise<RestoreResult>`. Both manual rollback and automatic restore
  should use it. Keep target selection, prompts, display, and state recording in their actions.
- Extract a small readiness-options builder only if update becomes the fourth action duplicating the
  exact timeout/interval/retry construction. Do not hide `waitForDependencyReadiness` behind an
  action-level helper that also logs or mutates exit codes.
- If richer update detection is required, move digest classification into `lib/image-updates.ts` and
  leave Docker command execution in `lib/docker.ts`. Preserve `checkImageUpdate` as a compatibility
  wrapper or update all callers and tests in one change.

Accept these small duplications:

- Command-specific option interfaces and parsing, matching existing action files.
- A concise update-specific preview/report renderer. Reusing the deployment-plan renderer would
  require exporting private UI helpers and still would not show restore/verification semantics.
- Stage-specific log messages around shared library calls.

Do not extract a universal `deployService()` from the large deploy/apply/rebuild actions during this
feature. Their sequential/parallel, sidecar, validation, and partial-failure semantics differ; a
cross-cutting refactor would enlarge issue #148 and make regression attribution difficult.

## Interface Design

Use explicit result types rather than booleans:

```ts
type UpdateStage = "detect" | "preview" | "apply" | "verify" | "restore";
type UpdateOutcome = "updated" | "current" | "skipped" | "failed" | "restored" | "restore-failed";

interface ManagedUpdateServiceResult {
  service: string;
  outcome: UpdateOutcome;
  failedStage?: UpdateStage;
  previousGeneration?: number;
  resultingGeneration?: number;
  previousImage?: string;
  requestedImage?: string;
  localDigest?: string;
  remoteDigest?: string;
  verification?: DependencyReadinessSummary;
  error?: string;
  restoreError?: string;
}
```

The top-level result should include a versioned machine schema identifier, plan ID/path, timestamps,
selected services, confirmation/apply status, service results, and counts. Keep errors as data in the
result and translate the aggregate outcome to exit codes once in `executeUpdate`.

Dependency injection should be a plain object of functions, defaulted to existing imports. Inject at
least plan generation/loading/validation, update recheck, pull/start, inspection, readiness, clock,
and state lookup/recording. This is cheaper than module-wide mocks and makes failure-stage tests
precise. Do not expose the database implementation through the public result.

Treat detection as a three-way result: update, current, or unknown. A registry error is not evidence
that an image is current. Before pull, compare the candidate's stored local/remote digests with a new
check; if either changed, mark the candidate stale and require a new preview rather than applying
different bytes than the user approved.

## Testability Patterns

Follow the repository's colocated Vitest pattern:

- `src/lib/managed-update.spec.ts`: table-driven lifecycle tests with injected fakes. Cover no-op,
  current image, local build skipped, missing local digest, remote lookup failure, stale digest before
  apply, pull failure, start failure, readiness timeout, readiness unavailable, successful restore,
  restore failure, and state-recording failure.
- `src/actions/update.spec.ts`: mock library boundaries and assert option resolution, one confirmation,
  cancellation before mutation, machine formats without prompts, exit-code mapping, and guaranteed DB
  close.
- `src/commands/update.spec.ts` only if command modules are already unit tested; otherwise extend the
  existing CLI registration/completion tests and use a repo-root subprocess smoke because `cli.ts`
  executes `main()` at module load.
- Extend `plan-generator.spec.ts` for digest-only candidates, locally built services, and unknown
  digest classification.
- Extend `rollback.spec.ts` around the extracted restore primitive to prove manual rollback behavior
  is unchanged.
- Extend `state-storage.spec.ts` and `generations.spec.ts` if `update` becomes a new deployment or
  generation action.

Use fake timers or an injected clock/sleep for polling-related orchestration; do not wait in unit
tests. Use temporary plan directories and temporary SQLite databases for storage integration tests.
Assert ordered calls for the safety path:
snapshot lookup -> revalidate -> pull -> start -> verify -> record success, and on failure:
verify failure -> restore -> verify restored state -> record outcomes. Include a test proving no
restore is claimed when no immutable pre-update image is available.

Validation should be layered: focused Vitest files first, then the rfapps-cli workspace test/typecheck
and coverage gates, followed by a repo-root CLI dry-run or no-op smoke. Docker-mutating integration
tests should be opt-in and use a disposable fixture compose project, not the repository's live stack.

## Build vs Depend

Build the coordinator and result contracts in-repo. No new runtime dependency is justified:

- Docker and Docker Compose behavior already flows through `lib/docker.ts`.
- Registry lookup already uses `docker manifest inspect`.
- Plan persistence already uses Node filesystem and crypto APIs.
- State/generations already use the repository's SQLite layer.
- Confirmation, logging, and structured formatting already come from `@rfmedia/common`.

Do not add a registry SDK, workflow engine, retry library, or state-machine package. Their credential,
platform, and error-model costs exceed the feature's needs. If immutable restoration cannot be
implemented with the existing local image ID/digest data, improve the existing Docker wrapper to tag
or reference the captured image by digest; do not introduce a second container client.

## Open Questions

1. What is the immutable restore artifact: local image ID, repo digest, or a protected temporary tag?
   Current `imageTag` generations are insufficient when the tag is mutable.
2. Does verification require the updated target container itself to be running/healthy, in addition
   to `waitForDependencyReadiness`, which focuses on dependencies?
3. Should unavailable readiness telemetry fail closed, restore, or produce an explicitly
   `unverified` outcome? Existing apply behavior warns and continues.
4. Should a failure stop the entire selected batch, or restore that service and continue with the
   next independent service? The first version should choose one deterministic default and report it.
5. Should `DeploymentAction`/`GenerationAction` gain `update`, or should managed updates record as
   `apply` with additional metadata? A first-class action improves history clarity but expands schema
   and formatter exhaustiveness work.
6. Are plans with ordinary compose changes plus image updates valid managed-update plans, or must the
   command reject them to avoid bundling unrelated configuration mutation into an image update?
7. Is a saved plan reusable after a partial run, or must any attempted mutation invalidate it?
8. How are sidecars represented in per-service reports when selection expansion adds services that
   had no independent image update?
9. Is restore-on-failure mandatory when state is disabled or no usable generation exists, or may an
   explicit expert flag opt out? The default should never imply protection that is unavailable.
10. Does restore success require a second readiness verification, and how is a restore that starts
    but remains unhealthy classified?
