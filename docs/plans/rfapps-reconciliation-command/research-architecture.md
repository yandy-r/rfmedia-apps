# Architecture Research: rfapps Reconciliation Command

## System Overview

`rfapps reconcile` should be a report-first controller layered over the existing rfapps command,
action, and library boundaries. Docker Compose remains the source of desired state; Docker Engine
and Compose project containers provide actual state. The feature must not create a second deploy
engine or persist a reconciliation plan. Instead, it should produce one deterministic
`reconcile.v1` result from a frozen scope and, only when `--auto-apply` is present, carry that same
reviewed result through a same-process lock, revalidation, targeted mutation, and final
observation cycle.

The intended dependency direction is:

```text
CLI and MCP registration
  -> action boundary (configuration, scope, approval, output, exit status)
    -> reconcile coordinator (observe, plan, policy, lock, revalidate, act, verify)
      -> drift comparison + dependency ordering + readiness polling
      -> canonical project/Docker/environment identity
      -> Docker/Compose subprocess boundary
```

The action layer may print, prompt, and set `process.exitCode`; the coordinator and lower-level
libraries must return typed data and remain independent of Commander, terminal output, and process
global state. Report mode ends after observation and planning. It must not prompt, acquire the
lifecycle lock, initialize SQLite, write a plan/result/history/generation artifact, or invoke a
Docker mutation. Auto-apply is a bounded extension of the same report, not a separate plan or a
replay mechanism.

The current code has most required primitives, but they are split across drift detection and the
managed image-update path. `detectDrift()` provides the canonical desired-versus-actual diff,
managed update provides the security model for project and Docker authority, and the lifecycle
lock and health verifier provide safe execution boundaries. Reconciliation should extract only
the shared identity pieces and otherwise keep its result aggregation, policy, action selection,
and rendering feature-local.

## Relevant Components with Exact Paths

### Public command and action boundaries

| Path                                            | Current role                                                                                          | Reconciliation role                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/cli.ts`                | Defines global options and registers top-level commands                                               | Import and call `registerReconcileCommand(program)` so global `--dry-run`, `--output`, `--json`, `--yes`, and secrets-tool options reach reconciliation unchanged                                                                   |
| `packages/rfapps-cli/src/commands/reconcile.ts` | New file                                                                                              | Register the top-level command and its service, scope, `--auto-apply`, `--show-unchanged`, `--health-timeout`, Compose, environment, and profile options; lazy-load the action                                                      |
| `packages/rfapps-cli/src/actions/reconcile.ts`  | New file                                                                                              | Normalize options, load and override configuration, resolve a complete frozen scope, build the production coordinator dependencies, render/confirm the reviewed report, emit one machine document, and set the documented exit code |
| `packages/rfapps-cli/src/commands/drift.ts`     | Registers legacy `drift detect/show/reconcile/import` syntax                                          | Preserve `rfapps drift reconcile`, but route it to the new action with auto-apply intent instead of its current direct force-recreate behavior                                                                                      |
| `packages/rfapps-cli/src/actions/drift.ts`      | Detects drift and currently calls `startServices(..., forceRecreate: true)` for legacy reconciliation | Keep detect, show, and import behavior; replace `executeDriftReconcile()` implementation with a compatibility delegation to the new action/coordinator                                                                              |

### Reconciliation contract and coordinator

| Path                                         | Current role                               | Reconciliation role                                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/types/reconcile.ts` | New file                                   | Own `RECONCILE_SCHEMA_VERSION`, result, service comparison, action, outcome, automation-policy, summary, status, and exit-code types                                                                                       |
| `packages/rfapps-cli/src/lib/reconcile.ts`   | New file                                   | Own deterministic normalization, action selection, policy evaluation, action fingerprinting, dependency-aware order, lock/revalidation/apply/verify coordination, interruption handling, and aggregate result construction |
| `packages/rfapps-cli/src/types/index.ts`     | Barrel for public rfapps types             | Export the reconciliation schema constant and types                                                                                                                                                                        |
| `packages/rfapps-cli/src/lib/index.ts`       | Barrel for action-facing library functions | Export the reconciliation coordinator and any new Docker/identity primitives needed by actions and tests                                                                                                                   |

### Desired state, actual state, and comparison

| Path                                            | Current role                                                                                                                                         | Reconciliation role                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/drift.ts`          | Resolves Compose JSON, maps running service containers, inspects them, adds runtime status, and builds `ServiceDrift`                                | Remain the single comparison definition; make observation usable for stopped/missing services and preserve secret masking and the existing drift schema for detect/show/import callers                                                                                                                            |
| `packages/rfapps-cli/src/types/drift.ts`        | Defines stable drift categories and per-service diffs                                                                                                | Supply `ServiceDrift` and ordered `DriftCategory` values embedded in each reconciliation service result; do not create a competing diff model                                                                                                                                                                     |
| `packages/rfapps-cli/src/lib/docker.ts`         | Executes bounded Docker/Compose subprocesses, resolves Compose JSON, maps running containers, inspects identity, and recreates managed-update images | Add complete `ps --all --format json` observation retaining service name, container ID/name, state, health, and multiplicity; add a dedicated target-only reconciliation primitive using explicit project/profiles, `up -d --pull never --no-deps`, optional `--force-recreate`, and exactly one reviewed service |
| `packages/rfapps-cli/src/lib/service-status.ts` | Uses `docker compose ps -a --format json` for status, but collapses observations into one status per service                                         | Reuse parsing concepts where useful, but do not use its `Map<string, ServiceStatusEntry>` as reconciliation authority because it loses container identity and scaled-instance multiplicity                                                                                                                        |
| `packages/rfapps-cli/src/lib/plan-generator.ts` | Resolves Compose plans and exposes `resolvedServiceConfigFingerprint()`                                                                              | Reuse or extract its canonical resolved-service fingerprint so stale desired configuration is detected without reparsing Compose independently                                                                                                                                                                    |

The current drift observer only calls `getRunningServiceContainerMap()`. That helper filters to
running containers and stores one container per service, so a stopped container looks missing and
multiple instances silently collapse. Reconciliation requires an all-container observation that
retains every exact container identity. Missing is then distinguishable from stopped, while more
than one instance is reported and blocked in v1. `detectDrift()` also currently skips requested
services absent from resolved Compose; scope validation must reject that condition before planning
so the complete-accounting invariant is not weakened.

### Scope, identity, locking, ordering, and readiness

| Path                                                   | Current role                                                                                                                    | Reconciliation role                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/interactive-selection.ts` | Expands groups and sidecars, validates services, detects profiles, and optionally opens an interactive selector                 | Reuse/extract its deterministic group, sidecar, service-validation, and profile semantics, but suppress the selector for bare report mode; `--yes` must never determine scope or mutation authority      |
| `packages/rfapps-cli/src/lib/services.ts`              | Implements group expansion, sidecar expansion, and profile detection                                                            | Produce the explicit unique scope before observation; reconciliation then sorts and freezes services/profiles                                                                                            |
| `packages/rfapps-cli/src/actions/update.ts`            | Currently owns `resolveComposeProjectIdentity()` and `dockerAuthorityFingerprint()` plus the managed-update dependency assembly | Move the reusable canonical Compose/project and non-secret Docker-authority helpers behind a library boundary, then update managed update to consume that shared implementation without behavior changes |
| `packages/rfapps-cli/src/lib/identity.ts`              | New shared library proposed by the feature design                                                                               | Canonicalize the Compose file/project directory/project name, bind the environment source, and fingerprint Docker context/endpoint/effective host/daemon without exposing those values                   |
| `packages/rfapps-cli/src/lib/managed-update.ts`        | Demonstrates reviewed identity, same-process revalidation, sequential mutation, interruption, cleanup, and status aggregation   | Architectural reference and consumer of extracted identity helpers; reconciliation should not depend on managed-update result or persistence models                                                      |
| `packages/rfapps-cli/src/lib/lifecycle-lock.ts`        | Acquires a private project/Docker/project-name lock and detects held, stale, invalid, and unsafe locks                          | Auto-apply acquires it only after report/approval, then always releases it through terminal cleanup; report and dry-run paths never touch it                                                             |
| `packages/rfapps-cli/src/lib/dependency-graph.ts`      | Builds Compose/sidecar dependency graphs and deterministic topological phases                                                   | Order reviewed actions by dependency phase and then service name; execute sequentially and never add dependencies outside the frozen scope                                                               |
| `packages/rfapps-cli/src/lib/health.ts`                | Provides bounded target and dependency readiness polling through `verifyServiceReadiness()`                                     | Reuse configured timeout/interval/retry semantics for post-action readiness, paired with a fresh full-scope drift observation before a service can be called converged                                   |
| `packages/rfapps-cli/src/lib/config.ts`                | Loads layered configuration and applies health, profile, sidecar, state, and environment defaults                               | Supply existing health polling values and scope mappings; v1 adds no maintenance-window, daemon, retry-queue, or persistence configuration                                                               |

### Output, compatibility, completion, and tests

| Path                                                                                                                                                           | Current role                                                                                        | Reconciliation role                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/formatters/index.ts`                                                                                                              | Routes JSON/YAML/CSV/table to stdout and supports scoped MCP capture                                | Emit the normative nested result once for JSON/YAML; use an explicit service-summary projection for CSV/table if those formats are supported                                       |
| `packages/rfapps-cli/src/actions/completion.ts`                                                                                                                | Generates Bash, Zsh, and Fish templates with command-specific dynamic service/group/profile helpers | Add top-level `reconcile` and every option to all three templates; update legacy completion metadata where its delegated option contract changes                                   |
| `packages/rfapps-cli/src/actions/completion.spec.ts`                                                                                                           | Verifies generated completion content and dynamic helpers                                           | Add parity assertions for Bash, Zsh, and Fish, including service, comma-list, group, profile, Compose/env paths, booleans, and timeout value completion                            |
| `packages/rfapps-cli/src/mcp/schema.ts`                                                                                                                        | Defines `rfapps.drift.reconcile` input/output schemas and tool names                                | Preserve the tool name, replace the generic mutation result with `reconcile.v1`, and make authorization fields explicit                                                            |
| `packages/rfapps-cli/src/mcp/adapters.ts`                                                                                                                      | Invokes CLI actions under scoped structured-output capture                                          | Delegate legacy MCP reconciliation to the same action/coordinator and return its typed result rather than a success fallback                                                       |
| `packages/rfapps-cli/src/mcp/tools-mutate.ts`                                                                                                                  | Registers `rfapps.drift.reconcile` as a mutation-capable MCP tool                                   | Keep one mutation tool and the existing name; require explicit auto-apply/confirmation authority through the shared path rather than adding a second reconcile tool                |
| `packages/rfapps-cli/src/mcp/tools.ts` and `packages/rfapps-cli/src/mcp/server.ts`                                                                             | Assemble and serve the MCP registry                                                                 | Continue exposing the updated compatibility tool/schema through the existing registry and JSON-RPC envelope                                                                        |
| `packages/rfapps-cli/src/reconcile.integration.spec.ts`                                                                                                        | New file                                                                                            | Exercise full report and auto-apply flows across action/coordinator/Docker seams, with Docker-backed cases guarded by availability                                                 |
| `packages/rfapps-cli/src/commands/reconcile.spec.ts`, `packages/rfapps-cli/src/actions/reconcile.spec.ts`, and `packages/rfapps-cli/src/lib/reconcile.spec.ts` | New focused tests                                                                                   | Prove option wiring, zero-mutation report behavior, deterministic actions/fingerprints, stale-review refusal, exact argv, partial outcomes, redaction, and convergence aggregation |

## Data Flow

### Report-only flow

1. `commands/reconcile.ts` passes command-local options and `program.opts()` to
   `actions/reconcile.ts` without granting mutation authority.
2. The action resolves the secrets execution wrapper, loads rfapps configuration, applies CLI
   Compose/environment/profile overrides, and canonicalizes the Compose project identity.
3. Scope resolution expands group and sidecar rules, validates every requested service against the
   resolved Compose model, resolves profiles, expands the all-services case to explicit names,
   deduplicates, sorts, and freezes the lists. A report invocation does not open the interactive
   service selector.
4. The coordinator resolves desired state once through `docker compose config --format json` under
   the canonical file, project, profiles, working directory, and environment source.
5. Docker observation runs `docker compose ps --all --format json`, retains all instances and exact
   IDs for every selected service, and inspects those IDs through the existing bounded subprocess
   boundary. Observation failures remain service-specific wherever trustworthy evidence exists.
6. The drift comparison normalizes image, environment-name/change-kind, port, volume, network, and
   runtime-status evidence. Secret environment values, raw Compose JSON, raw inspect documents,
   endpoints, and Docker credentials do not enter the result.
7. The pure planner assigns each service exactly one comparison and one action:
   `none`, `create`, `start`, `recreate`, or `blocked`. Every causal category is attached once;
   scaled/ambiguous or incomplete observations are blocked rather than guessed.
8. Dependency phases, the allow-all v1 policy decision, canonical scope/authority evidence,
   normalized drift, exact observed identities, and actions are reduced to a canonical SHA-256
   action fingerprint. Volatile timestamps, durations, display strings, and secrets are excluded.
9. The coordinator aggregates a complete `reconcile.v1` report in lexical service order. The
   action renders human text on the human surface or exactly one structured document on stdout.
   Reported drift is a successful report and does not set an operational-failure exit code.

No lifecycle lock, database, history, generation, plan file, result file, Docker mutation, or
confirmation is reachable in this flow. Global `--dry-run` forces this flow even when
`--auto-apply` is present.

### Auto-apply flow

1. The action first produces and renders the same report described above. If there are no actions,
   it returns a successful no-op without prompting or locking.
2. Human output asks one default-no confirmation naming the exact action count and targets unless
   global `--yes` is present. Machine formats require explicit `--yes`; structured output never
   prompts or streams Compose output.
3. The coordinator acquires the existing lifecycle lock using canonical project path, Docker
   authority, and effective Compose project name.
4. Under the lock it re-resolves Compose/project/environment/Docker authority, the explicit scope,
   resolved service fingerprints, container identities, drift, policy, and proposed actions. Any
   mismatch with reviewed evidence returns structured stale-review/blocked results and performs no
   mutation. There is no force bypass.
5. Actions are traversed by dependency phase and service name, but mutations are sequential. Before
   each action, current service identity and policy are checked again. Drift that disappeared is
   recorded as `became_in_sync`; changed or ambiguous evidence is blocked.
6. The Docker primitive executes exactly one selected service using canonical project and profile
   arguments, `up -d --pull never --no-deps`, and `--force-recreate` only for `recreate`. It never
   adds `--remove-orphans`, build, pull, volume, prune, import, or implicit dependency behavior.
7. After each successful command, bounded readiness observation and fresh drift detection determine
   whether the service is actually converged. Compose exit zero alone is insufficient.
8. Unsafe stabilization or action failure stops later unsafe mutations while preserving terminal
   results for all services. SIGINT/SIGTERM stops scheduling, records the active unit, completes
   aggregation, and releases the lock.
9. A final complete-scope observation supplies `finalDrift` and terminal outcomes. The result is
   returned in original lexical service order with aggregate status and exit `0`, `1`, or `3` as
   defined by the contract. Cleanup failures are represented without hiding the primary outcome.

### Compatibility flow

`rfapps drift reconcile` and the existing `rfapps.drift.reconcile` MCP tool must translate their
inputs into the top-level reconciliation action with auto-apply intent. They do not retain their
current `startServices()` mutation path, their generic success fallback, or an independent result
schema. `drift detect`, `drift show`, and `drift import` continue using the backward-compatible
drift model. This gives all reconciliation mutations one authorization, locking, revalidation,
redaction, output, and convergence path.

## Integration Points

1. **Commander registration**: add `registerReconcileCommand()` beside the current drift and update
   registrations in `packages/rfapps-cli/src/cli.ts`. Keep validation in the command/action boundary
   and implementation imports lazy.
2. **Deterministic scope**: separate the pure group/service/sidecar/profile resolution in
   `packages/rfapps-cli/src/lib/interactive-selection.ts` from the optional selector UI. Expand
   empty/all scope into explicit Compose service names before fingerprinting. Sorting must occur
   after uniqueness and validation.
3. **Canonical identity**: extract `resolveComposeProjectIdentity()` and
   `dockerAuthorityFingerprint()` from `packages/rfapps-cli/src/actions/update.ts` into
   `packages/rfapps-cli/src/lib/identity.ts`. Add the environment-source fingerprint currently in
   `packages/rfapps-cli/src/lib/managed-update.ts` to the same reusable boundary or expose it from a
   shared identity module. Managed update must consume the extracted functions unchanged.
4. **Complete Docker observation**: extend `packages/rfapps-cli/src/lib/docker.ts` with a typed,
   bounded all-container query. Parse both JSON array and JSON-Lines Compose output, reject malformed
   or oversized evidence, retain exact IDs, and never reduce to `Map<service, container>` before
   multiplicity validation.
5. **Single drift definition**: adapt `packages/rfapps-cli/src/lib/drift.ts` so reconciliation and
   legacy drift commands share normalization and comparison. Preserve `ServiceDrift`, category
   order, environment redaction, and existing detect/show/import behavior while allowing the
   coordinator to distinguish missing, stopped, ambiguous, and failed observation states.
6. **Fingerprint construction**: use canonical JSON/data ordering and Node `crypto` SHA-256 in
   `packages/rfapps-cli/src/lib/reconcile.ts`. Bind project, authority, environment source, profiles,
   scope, resolved service configuration, exact actual identities, policy, normalized drift, and
   action. Recompute it under the lock and before mutation.
7. **Safe mutation primitive**: do not call `startServices()` because it unconditionally includes
   `--remove-orphans` and permits broad service lists. Add an operand-validating reconciliation
   helper to `packages/rfapps-cli/src/lib/docker.ts` with exact argv tests for create/start/recreate
   and explicit `--no-deps --pull never` guarantees.
8. **Execution order**: reuse `buildServiceDependencyGraph()` and `topologicalSort()` from
   `packages/rfapps-cli/src/lib/dependency-graph.ts`, filter to frozen scope, block cycles, and run
   sequentially even when services share a phase.
9. **Mutual exclusion and cleanup**: acquire `acquireLifecycleLock()` only after approval and use a
   `try/finally` cleanup path equivalent to managed update. Lock path/context errors become stable
   reason codes and must not fall through to mutation.
10. **Post-action proof**: use the polling settings from `RfappsConfig.healthCheck` with
    `verifyServiceReadiness()` and fresh drift observation. Readiness and zero relevant drift are
    both required for `converged`.
11. **Output boundary**: keep libraries print-free. Human progress/reporting belongs in
    `packages/rfapps-cli/src/actions/reconcile.ts`; JSON/YAML output goes through `formatOutput()`
    once. All stderr evidence passes through bounded redaction before it reaches a typed error.
12. **Legacy and MCP delegation**: update the drift command/action, MCP schema, adapter, mutation
    tool description, and tests together. Preserve `rfapps.drift.reconcile` naming and avoid adding
    a second MCP mutation authority.
13. **Completion parity**: add the command and exact Commander options in the Bash, Zsh, and Fish
    sections of `packages/rfapps-cli/src/actions/completion.ts`; use existing dynamic helpers for
    services, comma-separated services, groups, and profiles.

## Key Dependencies

- **Docker CLI and Compose plugin**: the only runtime authority for resolved desired state,
  project-scoped all-container observation, exact inspection, and target-only apply. Every phase
  must use the same canonical Compose path, project name, profiles, environment source, working
  directory, and Docker authority.
- **Commander v14**: provides top-level and compatibility command parsing. Commander flags only
  express user intent; `--auto-apply` is the reconciliation mutation gate, `--yes` only skips the
  confirmation, and global `--dry-run` always wins.
- **Node `crypto`**: provides SHA-256 fingerprints without a new runtime dependency. Canonical
  input construction must be pure and independently unit-tested.
- **Existing rfapps drift types and comparison**: `ServiceDrift` remains the sole semantic diff and
  secret-masking contract. Reconciliation adds comparison/action/outcome state around it rather
  than forking drift semantics.
- **Managed-update safety primitives**: canonical project/Docker/environment identity,
  `acquireLifecycleLock()`, revalidation, interruption, bounded evidence, and cleanup behavior are
  established patterns to reuse. Managed-update plan storage, database generations, image pulls,
  and restore logic are explicitly not reconciliation dependencies.
- **Dependency graph and health libraries**: dependency phases constrain deterministic action
  order, while bounded readiness polling supplies runtime proof. Neither may widen the reviewed
  service scope.
- **`@rfmedia/common` output and logging**: supplies format selection, machine serialization,
  confirmation helpers, and log modes. Reconciliation must preserve the one-document stdout
  contract and keep sanitized progress on stderr.
- **`yaml`**: remains the existing configuration parser; the lockfile must resolve a patched
  `>=2.8.3` version, but reconciliation must not use it to independently interpret Compose.
- **Vitest and Docker-availability guards**: focused unit tests prove deterministic contracts and
  exact subprocess arguments; integration tests exercise the assembled flow and run Docker-backed
  cases only when the local Docker/Compose authority is available.
- **No new runtime package, database schema, saved reconcile plan, daemon, scheduler, queue, or
  maintenance-window configuration**: maintenance eligibility is a typed allow/block seam with an
  allow-all v1 implementation until issue #169 supplies scheduling policy.
