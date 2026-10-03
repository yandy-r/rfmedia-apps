# Context Analysis: rfapps Reconciliation Command

## Executive Summary

Issue #151 should land as a one-shot, report-first controller over the existing drift detector and
Docker Compose execution boundary. `rfapps reconcile` resolves one explicit service scope, compares
resolved Compose intent with complete Docker evidence, and returns a deterministic
`reconcile.v1` result without prompting, locking, persisting, or mutating by default.
`--auto-apply` alone promotes that reviewed report into a same-process cycle that confirms in human
mode, acquires the managed-update lifecycle lock, revalidates all authority and action evidence,
applies one reviewed service action at a time, and re-observes convergence.

The implementation must preserve one behavior behind the top-level command, legacy
`rfapps drift reconcile`, and existing `rfapps.drift.reconcile` MCP tool. Compose remains
authoritative; runtime import stays in `rfapps drift import`, registry freshness stays in
`rfapps update`, and maintenance-window scheduling stays in issue #169. V1 adds no saved plan,
SQLite record, generation, rollback, daemon, scheduler, queue, or runtime dependency.

Where earlier research proposed bulk or force-recreate-only execution, the validated feature spec
is authoritative: actions are `none | create | start | recreate | blocked`; execution is
per-service, dependency-phased, sequential, uses `--pull never --no-deps`, and force-recreates only
an explicitly reviewed `recreate` action.

## Architecture Context

The required dependency direction is:

```text
commands/reconcile.ts
  -> actions/reconcile.ts
    -> lib/reconcile.ts
      -> lib/drift.ts
      -> lib/identity.ts + lifecycle-lock.ts
      -> dependency-graph.ts + health.ts
      -> lib/docker.ts
```

- The command declares Commander options, validates argv-only conflicts, lazy-loads the action, and
  passes global options through unchanged.
- The action loads configuration, resolves the environment wrapper and canonical project, expands
  and freezes scope, owns approval and rendering, emits one machine document, and sets exit state.
- The coordinator is data-only. It normalizes observations, chooses actions, evaluates policy,
  fingerprints reviewed intent, locks/revalidates/applies/verifies, aggregates complete results,
  and never prints, prompts, persists, or changes `process.exitCode`.
- `lib/drift.ts` remains the single comparison and secret-masking authority. Reconciliation adds
  observation/action/outcome state around `ServiceDrift`; it must not fork field comparison rules.
- `lib/docker.ts` remains the only subprocess boundary. New observation and mutation helpers use
  argument arrays, the selected environment tool, bounded capture, and typed failures.

### Report flow

1. Resolve canonical Compose/project/environment/Docker authority and an explicit unique sorted
   service/profile scope.
2. Resolve desired state and enumerate all project containers with `compose ps --all`, preserving
   exact identities and multiplicity.
3. Build one normalized comparison and action per selected service, including failed or ambiguous
   observations, then compute the action fingerprint.
4. Return a complete lexical-order report. Do not prompt, acquire a lock, initialize state, write
   artifacts/history/generations, or invoke Docker mutation. `--dry-run` always follows this path.

### Auto-apply flow

1. Render the same reviewed report; no-op runs return without confirmation or locking.
2. Confirm the exact target/action list in human mode unless `--yes`; machine auto-apply requires
   `--yes` and never prompts or streams Compose output.
3. Acquire the shared lifecycle lock for canonical project, Docker authority, and project name.
4. Re-resolve project, environment, Docker authority, scope, service configuration, container
   identity, drift, policy, and action fingerprint. Any unexplained change blocks all stale intent.
5. Traverse dependency phases, then service names, sequentially. Recheck the service and policy
   immediately before each action; record `became_in_sync` if drift disappeared.
6. Run exactly one targeted Compose action and prove readiness plus zero relevant drift afterward.
   Stop later unsafe work after action/stabilization failure.
7. Re-observe the complete scope, restore lexical result order, aggregate `0/1/2/3`, and release
   signals/lock in `finally` without masking the primary outcome.

## Critical Files Reference

| Exact path                                              | Implementation responsibility                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/cli.ts`                        | Register the top-level command while preserving global format, dry-run, confirmation, and secrets-tool behavior.                              |
| `packages/rfapps-cli/src/commands/reconcile.ts`         | New thin Commander surface for selectors, `--auto-apply`, `--show-unchanged`, `--health-timeout`, Compose/env/profile options, and exit help. |
| `packages/rfapps-cli/src/actions/reconcile.ts`          | New boundary for config, frozen scope, identity, approval, rendering, signals, output purity, and exit mapping.                               |
| `packages/rfapps-cli/src/types/reconcile.ts`            | New `reconcile.v1` contracts for mode, comparison, action, eligibility, outcome, status, summary, success, and exit code.                     |
| `packages/rfapps-cli/src/lib/reconcile.ts`              | New deterministic planner and lock/revalidate/act/verify coordinator with injected dependencies.                                              |
| `packages/rfapps-cli/src/lib/drift.ts`                  | Preserve comparison/masking semantics while supporting missing, stopped, failed, and multiplicity-aware observation.                          |
| `packages/rfapps-cli/src/types/drift.ts`                | Reuse stable `ServiceDrift` and category vocabulary; do not add a competing diff schema.                                                      |
| `packages/rfapps-cli/src/lib/docker.ts`                 | Add bounded `ps --all` parsing that retains every instance and a one-service `up -d --pull never --no-deps` helper.                           |
| `packages/rfapps-cli/src/lib/service-status.ts`         | Reuse parsing concepts only; its one-entry-per-service map cannot be reconciliation authority.                                                |
| `packages/rfapps-cli/src/lib/identity.ts`               | New shared home for canonical Compose/project and non-secret Docker/environment authority fingerprints.                                       |
| `packages/rfapps-cli/src/actions/update.ts`             | Consume extracted identity helpers without changing managed-update behavior or lock identity.                                                 |
| `packages/rfapps-cli/src/lib/managed-update.ts`         | Reuse environment fingerprint and lifecycle sequencing patterns, not registry/persistence/restore semantics.                                  |
| `packages/rfapps-cli/src/lib/plan-generator.ts`         | Reuse `resolvedServiceConfigFingerprint()` for stale desired-state detection.                                                                 |
| `packages/rfapps-cli/src/lib/lifecycle-lock.ts`         | Shared exclusion for auto-apply only; preserve private, fail-closed, manual stale-lock behavior.                                              |
| `packages/rfapps-cli/src/lib/dependency-graph.ts`       | Build strict deterministic phases filtered to frozen scope; block missing/cyclic evidence.                                                    |
| `packages/rfapps-cli/src/lib/health.ts`                 | Supply bounded readiness semantics paired with fresh drift observation.                                                                       |
| `packages/rfapps-cli/src/lib/interactive-selection.ts`  | Reuse/extract group, sidecar, validation, and profile resolution without prompting in report mode.                                            |
| `packages/rfapps-cli/src/lib/services.ts`               | Expand groups/sidecars/profiles before scope is materialized, sorted, and frozen.                                                             |
| `packages/rfapps-cli/src/commands/drift.ts`             | Preserve compatibility syntax and route reconciliation through the new action.                                                                |
| `packages/rfapps-cli/src/actions/drift.ts`              | Remove independent `startServices()` reconciliation while leaving detect/show/import compatible.                                              |
| `packages/rfapps-cli/src/mcp/schema.ts`                 | Publish explicit mutation input and the complete typed `reconcile.v1` result schema.                                                          |
| `packages/rfapps-cli/src/mcp/adapters.ts`               | Invoke the shared action under structured-output capture; remove generic success fallback.                                                    |
| `packages/rfapps-cli/src/mcp/tools-mutate.ts`           | Retain the sole `rfapps.drift.reconcile` name and require explicit machine authorization.                                                     |
| `packages/rfapps-cli/src/actions/completion.ts`         | Mirror the complete command/options in Bash, Zsh, and Fish templates.                                                                         |
| `packages/rfapps-cli/src/actions/completion.spec.ts`    | Parameterize shell parity and dynamic service/group/profile/path/timeout completion assertions.                                               |
| `packages/rfapps-cli/src/lib/formatters/index.ts`       | Emit one nested JSON/YAML document; use only an explicit documented summary projection for flat formats.                                      |
| `packages/rfapps-cli/src/lib/exit-codes.ts`             | Derive stable report/apply `0/1/2/3` behavior without coordinator process state.                                                              |
| `packages/rfapps-cli/src/lib/managed-redaction.ts`      | Reuse bounded credential/control-character sanitization for external error evidence.                                                          |
| `packages/rfapps-cli/src/lib/errors.ts`                 | Reuse typed invalid-input and Docker/runtime errors at the action boundary.                                                                   |
| `packages/rfapps-cli/src/reconcile.integration.spec.ts` | Exercise assembled report/apply, stale review, partial outcomes, output purity, and optional Docker-backed targeting.                         |
| `packages/rfapps-cli/README.md`                         | Canonical operator reference for modes, options, output schema, exits, examples, and legacy delegation.                                       |
| `docs/features/rfapps-reconcile-command.md`             | New safety, lifecycle, result-contract, and workflow guide.                                                                                   |
| `docs/features/rfapps-drift-command.md`                 | Separate top-level convergence from runtime import and describe legacy delegation.                                                            |
| `docs/features/rfapps-mcp-server.md`                    | Document explicit authorization and typed compatibility result.                                                                               |
| `docs/features/json-output.md`                          | Document `reconcile.v1`, deterministic ordering, and clean stdout.                                                                            |
| `docs/features/shell-completion.md`                     | Document command availability across all three shells.                                                                                        |
| `docs/features/plan-apply-workflow.md`                  | Contrast same-process reconciliation with saved deployment plans/history/rollback.                                                            |
| `docs/features/quick-reference.md`, `docs/README.md`    | Add concise command examples and navigation.                                                                                                  |
| `ROADMAP.md`                                            | Mark #151 and child work complete while keeping #169 as the scheduling follow-up.                                                             |
| `package-lock.json`                                     | Resolve the existing `yaml` dependency to patched `>=2.8.3`; add no runtime package.                                                          |

## Patterns to Follow

- Mirror `packages/rfapps-cli/src/commands/update.ts`,
  `packages/rfapps-cli/src/actions/update.ts`, and
  `packages/rfapps-cli/src/lib/managed-update.ts` for thin registration, injected action
  dependencies, data-only lifecycle coordination, revalidation, interruption, and cleanup.
- Materialize the all-services sentinel from `resolveServicesWithInteractive()` with
  `getComposeServices()` before review. Validate, deduplicate, then code-point sort services and
  profiles; dependency ordering must never add services outside this list.
- Parse Compose `ps` defensively as either JSON Lines or an array, with byte/item/string bounds and
  exact schema checks. Preserve `Map<service, ContainerSnapshot[]>`; do not collapse before
  classifying missing, stopped, or scaled/ambiguous states.
- Canonicalize semantic data in the model, not only the renderer: fixed category order
  (`image`, `environment`, `ports`, `volumes`, `networks`, `runtime-status`), lexical set-like
  values, and explicit port/volume comparators.
- Build the SHA-256 action fingerprint from canonical project/environment/Docker identity,
  profiles, frozen scope, resolved service fingerprints, exact container identities, normalized
  drift, policy, and actions. Exclude timestamps, durations, messages, raw evidence, and secrets.
- Use explicit dependency objects and fake clock/sleep in library/action tests. Assert call order and
  absence of side effects; do not rely only on module mocks or snapshots.
- Keep subprocesses as validated argv arrays through `execDockerCompose()`/`execDocker()`. Directly
  test exact argv and the absence of `--remove-orphans`, pull/build/volume flags, and extra targets.
- Emit optional fields with conditional spreads rather than `undefined`. Keep libraries output-free;
  send human progress to sanitized stderr and one machine result to stdout via `formatOutput()`.
- Preserve useful per-service evidence once observation begins. Invalid usage throws before result
  construction; expected observation/policy/stale/action/verification failures become stable,
  bounded reason-coded result data.
- Keep cleanup in `finally`; release errors must not hide the primary failure but may downgrade an
  otherwise successful result.

## Cross-Cutting Concerns

### Authorization and stale authority

Docker access can be host-root equivalent. `--auto-apply` authorizes only the reviewed service
actions; `--yes` controls confirmation and `--dry-run` vetoes mutation. Bind every phase to the same
canonical Compose file/project directory/project name, environment provider/source, profiles, and
actual Docker context/endpoint/host/daemon fingerprint. Recheck under lock and per service with no
force bypass.

### Scope and destructive effects

Every selected service appears exactly once. Missing containers map to `create`, one stopped
matching container to `start`, safely correctable drift to `recreate`, and incomplete/ambiguous or
unsafe runtime evidence to `blocked`. V1 never removes orphans, prunes, builds, pulls, imports,
renews volumes, starts implicit dependencies, or acts on services outside frozen scope.

### Secrets and untrusted subprocess data

Resolved Compose and Docker inspect data are sensitive and untrusted. Keep them process-local;
public environment diffs contain only variable names and change kinds. Never emit raw config,
inspect documents, endpoints, source paths, credentials, lock tokens, or raw stderr. Bound and
validate output before use, then allowlist result fields and structurally redact error evidence.

### Determinism and output compatibility

Equivalent normalized inputs must yield identical semantic comparisons, actions, summaries, and
fingerprints. JSON/YAML are normative nested formats; machine modes emit exactly one complete
document and never gain mutation authority from format selection. Human and machine surfaces must
describe the same scope and outcomes. Table/CSV are allowed only as an explicitly documented
service-summary projection.

### Convergence, failure, and exits

Compose exit zero is not convergence. Readiness plus a fresh drift-free observation is required.
Report mode returns `0` for a trustworthy report even with drift. Auto-apply returns `0` only for a
converged requested scope, `3` for blocked/mixed/residual results, `1` for operational failure, and
`2` for invalid or unsafe use. Interruption stops scheduling, stabilizes/reports the active unit,
and leaves the next run to derive fresh state; no rollback or replay is promised.

### Maintenance compatibility

Add only an injected data-only allow/block policy with an allow-all v1 implementation. Observation
always runs. Reevaluate policy during planning, under the lock, and immediately before each action;
errors fail closed. Issue #169 owns configuration, time zones, windows, and scheduling.

## Parallelization Opportunities

1. **Contract/planner lane**: add `types/reconcile.ts`, canonical ordering, action selection,
   fingerprinting, summaries, and pure tests. This defines the shared contract for later lanes.
2. **Observation lane**: add multiplicity-preserving Docker enumeration and adapt drift observation
   for missing/stopped/ambiguous instances while retaining existing drift behavior and tests.
3. **Identity lane**: extract Compose/Docker/environment authority helpers and update managed update
   to consume them with unchanged behavior.

These three foundation lanes can begin independently, but coordinator integration waits for their
contracts. After foundation:

- **Coordinator/Docker lane** combines policy, lifecycle lock, strict dependency phases, targeted
  actions, verification, signal cleanup, and exact argv tests.
- **CLI/output lane** builds command/action registration, scope resolution, confirmation, rendering,
  format projection, and exit behavior against the coordinator contract.
- **Compatibility/completion lane** can update legacy CLI, MCP schema/adapter/tool, and all shell
  templates once action input/result shapes stabilize.
- **Integration/docs lane** can draft docs against the validated contract, but final examples,
  schemas, ROADMAP status, and Graphify refresh wait for the actual surface and full validation.

File ownership must stay non-overlapping during each batch. The main collision points are
`lib/docker.ts`, `actions/update.ts`, `actions/drift.ts`, `mcp/schema.ts`, and
`actions/completion.ts`; assign each to one lane and integrate through committed types/interfaces.

## Implementation Constraints

- Use TypeScript ESM/NodeNext and `.js` on relative imports; follow existing import grouping.
- Add no runtime dependency, database migration, saved report/plan, history/generation record,
  daemon, scheduler, retry queue, registry lookup, or maintenance-window configuration.
- Bare report and dry-run paths must prove zero prompt, lock, Docker mutation, filesystem artifact,
  SQLite, history, and generation calls.
- Scope is explicit, unique, sorted, validated against resolved Compose, and immutable across the
  cycle. Scaled/ambiguous multiplicity is reportable but non-remediable in v1.
- Mutation is one service at a time, sequential within strict dependency phases, with
  `--pull never --no-deps`; `--force-recreate` is used only for `recreate`.
- Machine auto-apply requires `--yes`; structured output must remain valid even when observation,
  action, verification, or cleanup partially fails.
- Preserve `drift detect`, `drift show`, and `drift import` schemas/behavior and managed-update
  identity/lock behavior.
- Upgrade the locked `yaml` version to `>=2.8.3` and run config/drift/reconcile regression tests.
- Update Bash, Zsh, and Fish together, including dynamic service, comma-list, group, profile,
  Compose/env path, boolean, and timeout completion.
- Validate focused suites first, then full rfapps tests, typecheck, build, lint, format check,
  Markdown lint, `git diff --check`, optional Docker-backed tests, docs/ROADMAP, and
  `graphify update .` after source changes.

## Key Recommendations

1. Land the public contract and deterministic pure planner before UI or mutation work; use it to
   prevent compatibility surfaces from inventing parallel schemas.
2. Fix observation completeness at the Docker/drift boundary first. Never derive safe actions from
   the existing running-only, one-container-per-service map.
3. Extract only the shared security invariants—canonical identity, authority fingerprints, lock,
   redaction, subprocess boundary—and keep reconciliation policy, ordering, aggregation, and
   rendering feature-local.
4. Make report mode structurally incapable of reaching approval, locking, persistence, or mutation,
   and cover every prohibited side effect with negative tests.
5. Recompute the complete reviewed fingerprint under the shared lock and revalidate service/policy
   immediately before mutation. Stale evidence is a typed block, never a warning.
6. Use a dedicated one-service Compose helper and exact argv tests. Do not reuse
   `startServices()` or any helper with orphan removal, pull, restore, or broad-target semantics.
7. Treat post-action observation as the success criterion and retain initial action plus final drift
   for partial/failure diagnosis.
8. Route top-level CLI, legacy CLI, and MCP through the same action/coordinator; retain names for
   compatibility, not behavior forks.
9. Finish the release surface as one unit: code, full tests, machine schema, all completion
   templates, feature/reference docs, patched lockfile, ROADMAP, and Graphify.
