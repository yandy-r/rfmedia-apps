# rfapps Reconciliation Command: Engineering Practices Research

## Executive Summary

The repository already has the right architectural vocabulary for issue #151: a Commander
registration layer, an action layer for configuration and operator interaction, data-oriented
library coordinators with injected dependencies, a Docker execution boundary, versioned public
result types, and Vitest coverage at unit and integration levels. `rfapps reconcile` should follow
those existing seams rather than introduce a controller framework or another deployment engine.

The recommended shape is deliberately small:

- `commands/reconcile.ts` owns only CLI declaration and option-combination validation.
- `actions/reconcile.ts` owns configuration, service selection, confirmation, output, and exit
  behavior.
- `lib/reconcile.ts` owns deterministic drift-to-action calculation, locking, under-lock
  revalidation, apply coordination, convergence polling, and aggregate results without printing or
  changing `process.exitCode`.
- `lib/drift.ts` remains the one comparison engine and secret-masking authority.
- `lib/docker.ts` gains one targeted Compose-up helper that cannot remove orphans.
- `types/reconcile.ts` defines the versioned public result.

The best reusable implementation precedent is the managed-update workflow in
`actions/update.ts` and `lib/managed-update.ts`, especially its dependency interfaces, canonical
Compose identity, Docker-authority fingerprint, shared lifecycle lock, fail-closed revalidation,
bounded evidence, and final-state verification. Reconciliation should reuse those practices, not
copy the managed-update persistence, exact-image recovery, sequential service transaction, signal
recovery, or registry logic. Reconciliation is a same-process, level-triggered observation and
convergence workflow.

No new runtime dependency is warranted. Docker Compose should continue to resolve and apply the
model through the existing subprocess boundary; Node's built-in crypto is sufficient for the
action fingerprint; Commander, existing formatters, and Vitest already cover the remaining needs.

## Existing Reusable Code

| Exact path and function                                                                                                              | Existing behavior                                                                                                                                        | Reconciliation use                                                                                          | Constraint                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/drift.ts::detectDrift()`                                                                                | Resolves Compose, inspects live containers, adds runtime status, masks secret-like environment values, and returns `DriftResult`                         | Use as the only desired-versus-actual detector before review, under the lock, and during post-apply polling | Treat `undefined` as detection failure; do not reinterpret it as an empty result                                                                     |
| `packages/rfapps-cli/src/lib/drift.ts::isSecretEnvVar()` and `compareEnv()`                                                          | Classify secret names and replace observed/desired secret values with `********`                                                                         | Preserve the existing masking contract by carrying `ServiceDrift`, not rebuilding environment diffs         | `compareEnv()` is private by design; reconciliation should consume its result rather than export it                                                  |
| `packages/rfapps-cli/src/lib/drift.ts::arraysEqualIgnoreOrder()`                                                                     | Compares set-like values independently of discovery order                                                                                                | Existing drift equality remains authoritative                                                               | Its object serialization is not a canonical public-output sorter; do not use it as the action fingerprint algorithm                                  |
| `packages/rfapps-cli/src/actions/drift.ts::executeDriftReconcile()`                                                                  | Selects services, detects drift, confirms, and calls `startServices(..., { forceRecreate: true })`                                                       | Preserve as a compatibility entry point that delegates to the new action                                    | Current behavior mutates in machine mode, performs no lock/revalidation/post-check, and must not remain an independent path                          |
| `packages/rfapps-cli/src/commands/drift.ts::registerDriftCommand()`                                                                  | Declares the legacy `drift reconcile` syntax                                                                                                             | Keep the syntax while routing its action to the new coordinator                                             | Do not duplicate new option parsing or safety rules inside both commands                                                                             |
| `packages/rfapps-cli/src/actions/update.ts::resolveComposeProjectIdentity()`                                                         | Canonicalizes a safe regular Compose file and derives its effective Compose project name                                                                 | Share this security-sensitive identity resolution with reconcile                                            | It currently lives in an action module; move it to a narrow library module rather than importing one action from another                             |
| `packages/rfapps-cli/src/actions/update.ts::dockerAuthorityFingerprint()`                                                            | Hashes context name, context endpoint, effective `DOCKER_HOST`, and daemon ID in the selected environment                                                | Use the same value in the reconciliation lock namespace and stale-review check                              | Preserve the environment-tool path; never expose its raw authority components in results                                                             |
| `packages/rfapps-cli/src/actions/update.ts::UpdateActionDependencies` and `executeUpdate()`                                          | Inject action-side config, selection, coordinator, confirmation, output, clock, and identity dependencies                                                | Follow this dependency-bundle pattern for `ReconcileActionDependencies`                                     | Reconciliation does not need database/artifact dependencies                                                                                          |
| `packages/rfapps-cli/src/lib/managed-update.ts::environmentSourceFingerprint()`                                                      | Produces a stable fingerprint for the selected secrets-provider source                                                                                   | Include it in stale-review evidence if environment source is part of the reviewed authority                 | Reuse the function; do not emit the environment file contents or resolved variables                                                                  |
| `packages/rfapps-cli/src/lib/managed-update.ts::runManagedUpdate()`                                                                  | Acquires the lifecycle lock, revalidates global and service identity, executes, verifies, aggregates, and cleans up                                      | Reuse the phase ordering and fail-closed posture                                                            | Do not reuse the whole coordinator: registry updates, durable generations, restore, and sequential transactions are different semantics              |
| `packages/rfapps-cli/src/lib/managed-update.ts::aggregateManagedUpdateStatus()`                                                      | Derives status/success/exit behavior from complete counts                                                                                                | Use as a style precedent for a pure reconciliation aggregator                                               | Reconciliation needs exit `3` for partial convergence and therefore needs its own function                                                           |
| `packages/rfapps-cli/src/lib/managed-redaction.ts::redactManagedMessage()`                                                           | Removes control characters, credentials, bearer tokens, and bounds error text                                                                            | Reuse for Docker/lock/policy error evidence crossing into machine output                                    | Keep stable reason codes separate from sanitized display text                                                                                        |
| `packages/rfapps-cli/src/lib/lifecycle-lock.ts::acquireLifecycleLock()`                                                              | Atomically locks canonical project plus Docker authority with private files and idempotent release                                                       | Acquire before the second observation and hold through mutation and verification                            | Use the same project/context namespace as managed update so update and reconcile contend                                                             |
| `packages/rfapps-cli/src/lib/lifecycle-lock.ts::withLifecycleLock()`                                                                 | Releases a lock in `finally` around a simple operation                                                                                                   | Useful only if cleanup failure does not need to be represented in the result                                | Prefer explicit acquisition in the coordinator when release failure must be retained as terminal evidence                                            |
| `packages/rfapps-cli/src/lib/docker.ts::execDockerCompose()`                                                                         | Centralizes Compose subprocess execution, environment-tool wrapping, capture/stream control, timeouts, and normalized results                            | All new Compose calls stay behind this function                                                             | Machine mode must capture output so stdout remains one structured document                                                                           |
| `packages/rfapps-cli/src/lib/docker.ts::startServices()`                                                                             | Runs `compose up -d --remove-orphans`, optionally with profiles, `--pull never`, and force recreation                                                    | Reuse its argument-building style only                                                                      | Do not call it from reconcile because unconditional `--remove-orphans` exceeds reviewed scope                                                        |
| `packages/rfapps-cli/src/lib/docker.ts::getComposeConfig()`                                                                          | Uses `docker compose config --format json` with project/profile/env-tool options                                                                         | Continue using it indirectly through drift and identity resolution                                          | The resolved object may contain secrets; keep it in memory and out of reports                                                                        |
| `packages/rfapps-cli/src/lib/docker.ts::getRunningServiceContainerMap()`                                                             | Maps running Compose services to one container name                                                                                                      | Existing drift relies on it                                                                                 | It excludes stopped containers and collapses scaled instances; first-release scope must explicitly account for this limitation                       |
| `packages/rfapps-cli/src/lib/health.ts::verifyServiceReadiness()`                                                                    | Polls one service for expected image identity, runtime health, stable-running time, and dependency readiness with injected clock/sleep/inspect functions | Reuse its testing style and configured polling concepts                                                     | It requires an expected image ID and is not a direct fit for configuration reconciliation; post-apply drift polling is the simpler convergence proof |
| `packages/rfapps-cli/src/lib/interactive-selection.ts::resolveServicesWithInteractive()`                                             | Resolves service/group selectors, sidecars, validation, profiles, and cancellation                                                                       | Use unchanged in the action layer                                                                           | Expand implicit “all” to an explicit reviewed scope before fingerprinting or mutation                                                                |
| `packages/rfapps-cli/src/lib/plan-generator.ts::resolvedServiceConfigFingerprint()`                                                  | Hashes recursively key-sorted resolved service configuration without exposing values                                                                     | Reuse when the reviewed Compose service model needs a secret-free identity                                  | Reconciliation still needs its own feature-specific action fingerprint over normalized drift/action data                                             |
| `packages/rfapps-cli/src/lib/exit-codes.ts::ExitCode` and `setExitCode()`                                                            | Centralize success, operational, usage, and partial-success codes                                                                                        | Map the final typed result to these constants at the action boundary                                        | The coordinator returns an exit code value but never writes global process state                                                                     |
| `packages/rfapps-cli/src/actions/completion.ts::generateBashCompletion()`, `generateZshCompletion()`, and `generateFishCompletion()` | Generate the three manually maintained completion templates with dynamic service/group/profile helpers                                                   | Add `reconcile` and every public option in all three generators                                             | Updating only one shell or only the command name is incomplete                                                                                       |
| `packages/rfapps-cli/src/mcp/adapters.ts::invokeDriftReconcile()`                                                                    | Captures action JSON for the existing mutation tool                                                                                                      | Keep the existing tool name as a compatibility adapter over the new result                                  | Do not create a second reconciliation mutation implementation                                                                                        |

## Modularity Design and Boundaries

### Command boundary

`packages/rfapps-cli/src/commands/reconcile.ts` should mirror
`packages/rfapps-cli/src/commands/update.ts`: declare the top-level command, selectors,
`--auto-apply`, `--show-unchanged`, `--health-timeout`, Compose/environment/profile flags, help text,
and option conflicts. The action should be dynamically imported. Validation that depends only on
argv belongs here; Docker, config, selection, and policy work do not.

The command module should export `registerReconcileCommand(program)` and keep its option interface
private unless another module truly needs it. Register it from `cli.ts` beside the drift and update
commands. This preserves the repository's lazy action imports and makes Commander behavior testable
without importing the top-level CLI module.

### Action boundary

`packages/rfapps-cli/src/actions/reconcile.ts` should be the only layer allowed to:

- load and override configuration;
- resolve selectors, sidecars, profiles, and cancellation;
- obtain the canonical Compose project and Docker authority;
- prompt for mutation;
- select human versus machine rendering;
- call `formatOutput()` exactly once for machine results; and
- set the process exit code from the final typed result.

Use an injected `ReconcileActionDependencies` object, following `UpdateActionDependencies`, rather
than broad module mocking. Its production implementation can bind `loadConfig`,
`applyCliOverrides`, `resolveServicesWithInteractive`, identity resolution, `runReconcile`,
`confirm`, and `formatOutput`. It should not include database, artifact-storage, or generation
operations because those are not part of issue #151.

### Coordinator boundary

`packages/rfapps-cli/src/lib/reconcile.ts` should be a data-only feature module. It should expose a
small public surface such as `buildReconcileReport()`, `runReconcile()`, and the dependency/options
interfaces required for testing. Internally it owns:

1. canonical ordering of services, categories, and collection-valued diffs;
2. one service-level action per drifted service;
3. a feature-specific action fingerprint;
4. maintenance-policy evaluation through an injected data-only interface;
5. lifecycle-lock acquisition and release;
6. under-lock re-observation and reviewed-fingerprint comparison;
7. one targeted Compose mutation for the fixed action set;
8. bounded re-observation until no selected service has drift or timeout is reached; and
9. complete per-service and aggregate terminal accounting.

The coordinator must not import logging, Commander, interactive UI, config loaders, formatters, or
write `process.exitCode`. The existing `managed-update.spec.ts` assertion that the library does not
print or change process state is a useful invariant to repeat for reconciliation.

### Detection boundary

`packages/rfapps-cli/src/lib/drift.ts` remains authoritative for comparison and masking. Avoid a
second desired/actual normalizer in `lib/reconcile.ts`. Reconciliation may canonicalize the already
typed `DriftResult` for deterministic output, but it must not independently decide whether images,
environment, ports, volumes, networks, or runtime status differ.

If issue #151 exposes a real detector gap, fix that gap in `drift.ts` with drift-specific tests so
`rfapps drift` and `rfapps reconcile` continue to agree. Do not add reconciliation-only comparison
branches.

### Docker boundary

Add a narrowly named helper such as `reconcileServices()` to
`packages/rfapps-cli/src/lib/docker.ts`. It should accept canonical project name, profiles, sorted
target services, and environment execution options and issue one targeted `compose up -d
--force-recreate` without `--remove-orphans`. Keep service and project operands validated using the
same safe operand rules already used by managed update.

Do not generalize `startServices()` into a large option matrix during this feature. Its established
deploy behavior includes orphan removal, while reconciliation has a stronger reviewed-scope
invariant. Two narrow helpers with different safety contracts are clearer than one boolean-heavy
helper whose defaults are dangerous for one caller.

### Type and compatibility boundaries

`packages/rfapps-cli/src/types/reconcile.ts` owns `RECONCILE_SCHEMA_VERSION` and all wire-facing
types. Re-export them from `types/index.ts`. Keep internal dependency interfaces in
`lib/reconcile.ts` unless they are genuine public API.

The legacy `drift reconcile` command and `rfapps.drift.reconcile` MCP tool should delegate to the
new workflow. Preserve the old names, not the old unsafe implementation. The drift detect/show/import
schemas and behavior remain untouched. This yields one reconciliation definition across CLI and
MCP without expanding the MCP catalog.

## Shared vs Feature-Specific

| Concern                     | Shared implementation                                                                          | Feature-specific implementation                                                   | Reason                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Desired/actual comparison   | `lib/drift.ts::detectDrift()`                                                                  | Canonical presentation of `DriftResult`                                           | Drift semantics must agree across commands; ordering/report fields belong to reconcile              |
| Compose project identity    | Extract `resolveComposeProjectIdentity()` from `actions/update.ts` into a small library module | Reconcile scope and action fingerprint                                            | The canonical path/project rule is a cross-feature security invariant                               |
| Docker authority            | Reuse `dockerAuthorityFingerprint()` through the same shared identity module                   | Reconcile stale-review reason code                                                | Both mutators must contend on the same actual daemon authority                                      |
| Environment-source identity | Reuse `environmentSourceFingerprint()`                                                         | Include or omit it from the reconcile fingerprint according to the final contract | The provider/source identity is shared; the reviewed projection is feature-specific                 |
| Lifecycle exclusion         | `lib/lifecycle-lock.ts`                                                                        | Reconcile lock error mapping and terminal outcome                                 | The lock mechanism is shared; public error taxonomy is not                                          |
| Secret/error sanitation     | `redactManagedMessage()` and drift masking                                                     | Stable `RECONCILE_*` reason codes                                                 | Sanitization is generic; reason codes communicate feature semantics                                 |
| Compose mutation            | `execDockerCompose()`                                                                          | New `reconcileServices()` argv contract                                           | Process handling is shared; no-orphan targeted mutation is a reconcile invariant                    |
| Readiness timing            | Existing `healthCheck` timeout/interval/retries config                                         | Poll `detectDrift()` until convergence                                            | Reuse operator configuration, not an image-ID-specific verifier that does not fit                   |
| Service selection           | `resolveServicesWithInteractive()`                                                             | Freeze and sort the reviewed reconciliation scope                                 | Selection rules are shared; reviewed-scope identity belongs to the cycle                            |
| Output formatting           | `formatOutput()` and existing logger/output-mode setup                                         | Human reconcile renderer and `reconcile.v1` shape                                 | Serialization infrastructure is shared; nested domain presentation is feature-specific              |
| Exit constants              | `ExitCode`                                                                                     | Pure `resolveReconcileExitCode()` or aggregate function                           | Numeric meanings are shared; status derivation is feature-specific                                  |
| Deterministic hashing       | Node `createHash()` and existing config fingerprint                                            | Canonical reconciliation action projection                                        | Reconcile arrays need domain-specific ordering; a generic canonicalization framework is unnecessary |
| Maintenance policy          | Small injected `ReconcileAutomationPolicy` interface                                           | V1 allow/not-requested implementation and reconcile result fields                 | The seam is needed now; issue #169 owns schedule configuration and evaluation                       |
| Persistence and recovery    | None                                                                                           | None in v1                                                                        | Managed-update generations and restore are not shared reconciliation requirements                   |

## KISS Assessment

| Decision           | Simpler recommended choice                                             | Avoid                                                                                | Repository-grounded rationale                                                                          |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Execution model    | One-shot command                                                       | Daemon, watcher, internal scheduler, retry queue                                     | The CLI and current issue model are invocation-based; issue #169 owns future scheduling                |
| Diff engine        | Consume `detectDrift()`                                                | New raw-object diff engine or reuse of deployment-plan change semantics              | Drift already covers the required categories and masking                                               |
| Action model       | `none` or one targeted Compose force-recreate action per service in v1 | Category-specific Docker commands, custom dependency scheduler, per-category retries | Existing legacy reconcile already uses force recreation; Compose owns project dependency ordering      |
| Apply batching     | One sorted target list in one Compose invocation                       | Hand-written parallel/sequential orchestration                                       | Compose already understands dependencies; result ordering can remain deterministic independently       |
| Review durability  | Same-process report, fingerprint, lock, and re-observation             | Saved reconcile-plan format and artifact storage                                     | No current acceptance criterion requires later replay; saved plans add validation and permissions work |
| Convergence proof  | Poll the same detector until clean or bounded timeout                  | Assume Compose exit zero means convergence; duplicate health controller              | Reusing the detector proves the exact promise that was reported                                        |
| Failure handling   | Return complete terminal evidence; rerun from current state            | Automatic rollback or action-log replay                                              | Reconciliation cannot roll back application or volume data, and its model is level-triggered           |
| Orphans            | Never remove in v1                                                     | Reuse `startServices()` default or infer pruning from missing desired services       | Orphan removal exceeds selected reviewed scope and is destructive                                      |
| Registry freshness | Leave to `rfapps update`                                               | Pull/check mutable tags during reconcile                                             | Managed update already owns digest discovery and exact-image recovery                                  |
| Persistence        | No SQLite access or history writes                                     | New reconciliation tables/generations                                                | Current drift is fully derivable and report-only must remain side-effect free                          |
| Policy             | Inject a small allow/block decision                                    | Implement cron/timezone/window parsing in #151                                       | The seam avoids future mutation bypass while respecting issue #169's scope                             |
| New dependencies   | None                                                                   | `dockerode`, Compose parser, controller framework, scheduling package                | Existing subprocess, crypto, Commander, YAML formatting, and Vitest cover the feature                  |

## Abstraction vs Repetition

### Extract or share now

- Move canonical Compose identity and Docker-authority fingerprinting out of
  `actions/update.ts` into a narrow library module. Two mutating workflows must use exactly the same
  path, project-name, environment, and daemon authority rules; divergence here is a safety bug, not
  harmless repetition.
- Reuse `redactManagedMessage()` for bounded external error evidence. Credential/control-character
  filtering is a cross-cutting persistence/output boundary and should not be reimplemented.
- Reuse lifecycle locking directly. Do not create a reconciliation lock format or directory.
- Reuse service selection and environment-tool resolution. Repeating selector expansion or secrets
  provider logic would create visible CLI inconsistencies.
- Add a single exported reconciliation Docker helper because every reconciliation mutation must
  enforce the same no-orphan argv contract.

### Keep feature-specific now

- Keep action canonicalization and fingerprint construction private to `lib/reconcile.ts`.
  `plan-generator.ts` recursively sorts object keys but preserves arrays, whereas reconciliation
  requires fixed category order and field-specific array ordering. A generic canonical JSON utility
  would conceal those domain rules.
- Keep `ReconcileAutomationPolicy` beside the coordinator until issue #169 supplies a real shared
  scheduling module. One future consumer is not a reason to design a framework now.
- Keep human reconcile rendering in `actions/reconcile.ts`; drift and update have different operator
  narratives and terminal states.
- Keep reconcile aggregation and exit mapping separate from managed update. Their notions of
  success, recovery, report-only drift, blocking, and partial completion differ.
- Keep the three shell completion templates explicit. Their syntax and dynamic helper integration
  differ enough that a generic completion AST would be a much larger change than adding one command.

### Accept small repetition

- Repeating short Commander option declarations is consistent with existing command modules and
  keeps help text local and readable.
- Repeating focused fixture builders in command, action, and coordinator tests is preferable to a
  global reconciliation test factory until fixture reuse is proven across suites.
- Repeating a short fixed category-order constant between schema validation and coordinator tests is
  acceptable if importing production implementation would weaken the test. Production should still
  have one authoritative order.

## Interface Design

### Public CLI surface

The new public command should be:

```text
rfapps reconcile
  -s, --service <name>
  --services <names>
  -g, --group <name>
  --no-sidecars
  --auto-apply
  --show-unchanged
  --health-timeout <seconds>
  -f, --compose <path>
  -e, --env-file <path>
  -p, --profile <name>
```

Global `--dry-run`, `--json`, `--output`, `--verbose`, `--yes`, `--use-dotenvx`, and `--use-op`
continue to flow through `program.opts()`. `--auto-apply` is the only feature-specific mutation
gate; `--yes` skips confirmation but does not grant mutation authority or bypass future policy.
Machine-format auto-apply should require `--yes`, matching managed update's non-interactive safety
pattern. `--dry-run --auto-apply` remains mutation-free.

### Public TypeScript and wire surface

Expose a versioned `ReconcileResult` from `types/reconcile.ts` and `types/index.ts`. Prefer
discriminated string unions for mode, automation decision, action status, terminal service outcome,
and aggregate status. The result must contain every selected service exactly once and carry the
original drift plus final drift after apply where applicable.

The wire contract should include stable reason codes and bounded sanitized messages. Volatile
timestamps can remain, but they must be excluded from the action fingerprint. Services, profiles,
categories, environment entries, ports, volumes, and networks must have explicit ordering rules.
Do not expose resolved Compose configuration, Docker authority inputs, raw stderr, lock owner token,
or secrets-provider output.

Only export coordinator functions that have real callers. Helper functions for sorting,
fingerprinting, summaries, and result transitions should remain module-private unless a focused unit
test cannot reach them through public behavior.

### Extension points

Use narrow dependency interfaces rather than hooks or registries:

- `ReconcileAutomationPolicy.evaluate(context)` returns allowed/blocked data and has no side effects.
- Drift dependency observes the exact explicit scope.
- Docker dependency applies one explicit sorted service set.
- Lock dependency acquires the existing project/authority lock.
- Clock and sleep dependencies make fingerprints, timestamps, and polling deterministic in tests.

The maintenance policy is the only planned extension seam. Do not add pluggable action kinds,
observer registries, reconciler classes, event buses, or persistence backends.

### Compatibility surfaces

- `rfapps drift reconcile` delegates to `executeReconcile()` with auto-apply intent and preserves
  its command name/help as a compatibility route.
- `rfapps.drift.reconcile` remains the existing MCP tool name but returns the typed reconciliation
  result through its adapter/schema.
- `drift detect`, `drift show`, and `drift import` keep their existing schemas.
- Bash, Zsh, and Fish completions expose the same top-level command and flags, including dynamic
  service, group, profile, and file completion.

## Testability Patterns

### Patterns to reuse

| Test layer                             | Existing precedent                                                                                                                                    | Reconciliation coverage                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure/library unit                      | `lib/managed-update.spec.ts` builds a complete dependency harness and asserts mutation, ordering, revalidation, cleanup, and no logging/process state | Build a `ReconcileDependencies` harness with fake drift observations, lock, Docker apply, clock, and sleep; test deterministic reports, stale review, convergence, timeout, partial results, and release  |
| Action unit                            | `actions/update.spec.ts` injects `UpdateActionDependencies` instead of mocking every imported module                                                  | Inject `ReconcileActionDependencies`; test config/selector threading, explicit all-scope expansion, confirmation, cancellation, output purity, machine `--yes`, dry-run, policy block, and exit mapping   |
| Drift unit                             | `lib/drift.spec.ts` uses Docker/status fixtures for categories, masking, missing services, and unhealthy runtime                                      | Add only detector-gap tests here; reconciliation tests should consume `ServiceDrift` fixtures instead of retesting comparison internals                                                                   |
| Docker argv unit                       | `lib/docker.spec.ts` captures spawned argv and checks exact commands, errors, output bounds, unsafe operands, and environment propagation             | Assert exact targeted `compose up -d --force-recreate` argv, sorted targets, project/profile flags, no `--remove-orphans`, no unintended pull flag, capture/stream behavior, and unsafe operand rejection |
| Lock unit                              | `lib/lifecycle-lock.spec.ts` uses temporary directories to prove contention, privacy, stale owners, symlink defense, finally release, and idempotence | Reuse unchanged; coordinator tests prove it requests the same project/authority key and releases on every branch                                                                                          |
| Health/polling unit                    | `lib/health.spec.ts` injects time/sleep and sequences observations                                                                                    | Sequence drift observations with fake time: immediate convergence, convergence after retries, elapsed timeout, retry limit, and residual drift evidence                                                   |
| Completion unit                        | `actions/completion.spec.ts` parameterizes Bash/Zsh/Fish and checks dynamic helpers and paths                                                         | Parameterize all shells; assert every reconcile flag plus service/group/profile/file and timeout helpers                                                                                                  |
| Command/action/coordinator integration | `managed-update.integration.spec.ts` registers the command and runs the action/coordinator with controlled boundaries                                 | Cover help/defaults, report immutability, no-op, apply, stale review, policy block, partial convergence, and exactly one machine document                                                                 |
| Docker-backed integration              | `managed-update.compose.integration.spec.ts` is opt-in and proves exact real Compose targeting                                                        | When Docker is available, drift a fixture service, reconcile only that service, verify convergence, and prove unrelated services/orphans remain untouched                                                 |

### Required behavioral test matrix

- Report-only with drift: complete report, zero lock, zero Docker mutation, zero filesystem/database
  writes.
- Report-only with no drift: successful no-op with every selected service accounted for.
- `--dry-run --auto-apply`: planned result, zero prompt, zero lock, zero mutation.
- Text auto-apply: one confirmation over the canonical target list; cancellation has zero mutation.
- Machine auto-apply without `--yes`: usage error before lock or mutation.
- Machine auto-apply with `--yes`: one structured document and no progress text on stdout.
- Stale observation after lock: no mutation and a stable blocked reason.
- Compose path/project, Docker authority, environment source, scope, or action fingerprint changes:
  fail closed.
- Compose success followed by clean observation: converged.
- Compose success followed by residual drift: not converged, never success.
- Mixed final state: retain converged and failed/blocked services and return partial-success code.
- Secret drift and hostile subprocess error: no secret in text, JSON, YAML, persistence-free result,
  or test snapshots.
- Cleanup failure: preserve completed primary result while surfacing bounded sanitized cleanup
  evidence and non-success where required.
- Reordered equivalent inputs: identical semantic action list, summary, and fingerprint.
- Multiple categories on one service: exactly one mutation target.
- Sidecar/profile expansion: fixed explicit scope and one result per resolved service.
- Bash, Zsh, and Fish: identical command/option coverage with shell-appropriate value completion.

### Anti-patterns to avoid

- Do not import `cli.ts` in ordinary unit tests. It executes `main()` at module load; use a new
  `Command` instance with `registerReconcileCommand()` or a subprocess smoke test.
- Do not rely only on broad `vi.mock()` module replacement as the current drift action tests do.
  Explicit dependency objects make negative mutation assertions and call ordering clearer.
- Do not use snapshots as the sole assertion for safety behavior. Assert the exact absence of lock,
  mutation, orphan-removal arguments, persistence, prompts, and process-state writes.
- Do not use real sleeps or wall-clock time in polling tests. Inject clock and sleep.
- Do not assert only the aggregate status. Verify every selected service's original drift, proposed
  action, final drift, reason, and terminal outcome.
- Do not overfit drift fixtures with `as any`. Typed fixture builders should make schema changes
  visible at compile time.
- Do not treat a successful Compose subprocess mock as sufficient proof. Every apply test must
  provide and assert a final drift observation.
- Do not run only focused tests. The drift compatibility adapter, MCP schema, completion templates,
  full rfapps suite, typecheck, build, formatting, markdown lint, and `git diff --check` are part of
  the regression surface.

## Build vs Depend

| Capability                       | Build/reuse in repository                                                | Add dependency? | Decision                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| Compose model resolution         | `execDockerCompose()` plus `docker compose config --format json`         | No              | Reuse Compose's own interpolation, merge, profile, and project semantics                        |
| Docker mutation                  | New narrow wrapper over `execDockerCompose()`                            | No              | Avoid a second Docker authority path and community SDK behavior differences                     |
| Desired/actual diff              | `detectDrift()`                                                          | No              | Existing implementation owns categories and masking                                             |
| Fingerprinting                   | Node `node:crypto::createHash` plus existing resolved-config fingerprint | No              | Built-in, deterministic, and already used in the package                                        |
| Locking                          | `acquireLifecycleLock()`                                                 | No              | Existing private atomic file lock already coordinates managed mutations                         |
| Scheduling/windows               | Inject data-only policy interface                                        | No              | Issue #169 should choose calendar/config semantics later                                        |
| Polling                          | Small injected clock/sleep loop around `detectDrift()`                   | No              | A retry library would add weight without improving this bounded loop                            |
| Structured types                 | TypeScript discriminated unions in `types/reconcile.ts`                  | No              | Matches `types/update.ts`; runtime schema needs remain limited to MCP's existing schema helpers |
| CLI parsing/help                 | Commander v14                                                            | No              | Existing command modules and global option handling already use it                              |
| JSON/YAML/table output           | Existing `formatOutput()` stack                                          | No              | Keep one serialization path; define nested JSON/YAML as normative                               |
| Secret sanitation                | Drift masking and `redactManagedMessage()`                               | No              | Existing tested patterns cover values and error text                                            |
| Testing                          | Vitest v4 and existing Docker-backed test convention                     | No              | Supports injected mocks, fake clocks, temporary files, and opt-in integration                   |
| Persisted reconcile plan/history | Do not build in v1                                                       | No              | No current requirement justifies schema, migration, permissions, and replay semantics           |
| Controller/daemon framework      | Do not build                                                             | No              | A one-shot command is the requested and repository-consistent lifecycle                         |

## Open Questions

1. **Action taxonomy:** the business/external research distinguishes `create`, `start`, and
   `recreate`, while the technical recommendation maps every drift category to
   `force-recreate`. For the KISS v1 implementation, should the public result expose the actual
   Compose operation (`force-recreate`) or operator-oriented reasons for missing/stopped services
   while retaining one implementation path?
2. **Stopped and scaled containers:** `getRunningServiceContainerMap()` observes only running
   containers and stores one container per service. Is v1 explicitly single-instance, with scaled
   services returned as unsupported, or must drift observation first grow to model all instances
   and stopped containers without breaking `DriftResult`?
3. **Runtime-only drift:** should unhealthy/restarting state always authorize force recreation, or
   should some runtime conditions remain blocked until a repair policy is defined? The detector can
   report them today, but action eligibility is a separate product decision.
4. **Legacy CLI behavior:** should `rfapps drift reconcile` become an exact alias for
   `rfapps reconcile --auto-apply`, or retain a deprecation warning? It must not retain an independent
   machine-output-implies-mutation path.
5. **MCP authorization:** the existing `rfapps.drift.reconcile` tool is already mutation-oriented.
   Should its adapter always supply auto-apply plus explicit non-interactive authorization, or should
   its input schema gain an explicit `autoApply` field before returning `reconcile.v1`?
6. **Maintenance-policy timing:** the technical design evaluates policy before confirmation and
   revalidates state under the lock. Should policy also be evaluated again under the lock immediately
   before mutation so a long confirmation cannot cross into a denied window?
7. **Policy-blocked exit:** should a fully blocked auto-apply be operational error `1`, partial
   success `3`, or a successful structured blocked result for schedulers? The result schema can carry
   the distinction, but the CLI code must be stable and tested.
8. **Convergence bounds:** should `--health-timeout` override only timeout while interval/retry count
   come from `healthCheck`, and which bound wins when retry count expires before elapsed timeout?
9. **Dependency effects:** one Compose invocation may recreate dependencies that are not explicit
   action targets. Is Compose's default dependency behavior acceptable, or should the targeted
   helper use `--no-deps`? This needs an explicit safety decision and Docker-backed test.
10. **Persistence:** should a successful auto-apply record deployment history or generations? The
    current recommendation is no persistence in v1; if that changes, only verified convergence may
    be recorded and the report-only path must still avoid opening SQLite.
11. **Machine formats:** JSON and YAML can represent the complete nested result. Should CSV/table be
    rejected for reconcile, given that flattening per-category diffs would create a second public
    contract, or should they emit a documented service-summary projection?
12. **Action fingerprint contents:** should the fingerprint bind only sorted normalized drift and
    actions, or also the canonical Compose project, profiles, explicit scope, environment-source
    fingerprint, and Docker-authority fingerprint? The safest reviewed unit includes all of them,
    while raw secret-bearing values and timestamps remain excluded.
