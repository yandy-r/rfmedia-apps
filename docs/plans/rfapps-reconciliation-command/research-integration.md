# rfapps Reconciliation Command: Integration Research

## Executive Summary

Issue #151 fits the repository's existing command/action/library boundaries without adding a new
runtime dependency, database schema, saved-plan format, daemon, or scheduler. The top-level
`rfapps reconcile` command should resolve one explicit service scope, observe resolved Compose
intent and all matching Docker containers, and return the versioned `reconcile.v1` result. Bare
report mode stops there. `--auto-apply` carries that same reviewed result into a same-process,
locked, fail-closed convergence cycle.

The strongest existing integration seams are:

- `resolveServicesWithInteractive()` for group, profile, and sidecar scope resolution;
- `detectDrift()` for the desired-versus-actual comparison and secret masking contract;
- `resolveComposeProjectIdentity()`, `dockerAuthorityFingerprint()`,
  `environmentSourceFingerprint()`, and `resolvedServiceConfigFingerprint()` for binding review to
  the exact Compose project, environment source, Docker daemon, and resolved services;
- `acquireLifecycleLock()` for exclusion with managed update;
- `getServiceStatusMap()` and the health polling configuration for fresh final-state observation;
- `formatOutput()` and the MCP action-capture adapter for one structured result across CLI and MCP.

Several current APIs are insufficient as-is. `getRunningServiceContainerMap()` observes only
running containers and collapses multiple instances into one map entry. `startServices()` always
adds `--remove-orphans`. Legacy `executeDriftReconcile()` consequently broadens mutation beyond the
reviewed scope and performs no under-lock revalidation or final convergence proof. Reconciliation
needs an all-container, multiplicity-preserving observation API and an exact per-service apply
helper using `--pull never --no-deps`, with `--force-recreate` only for a reviewed `recreate`
action. The validated design's actions remain `none | create | start | recreate | blocked` and
mutation remains sequential in dependency-phase then service-name order.

No database migration is needed. Current evidence positively supports no SQLite integration at
all: reconciliation is level-triggered from Compose and Docker, the `reconcile.v1` contract has no
history or rollback semantics, and both report and auto-apply must avoid deployment/generation
writes. Report mode must additionally avoid the lifecycle lock and every filesystem artifact write.

## API/CLI/MCP endpoints

### Top-level CLI

Register `commands/reconcile.ts` from `src/cli.ts` beside the existing drift/update command
registrations. The Commander surface from the validated spec is:

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

Global: --dry-run --json --output --verbose --yes --use-dotenvx --use-op
```

`commands/reconcile.ts` should only declare options and delegate. `actions/reconcile.ts` owns
config loading, scope resolution, policy evaluation, confirmation, output, and exit state.
`lib/reconcile.ts` returns data and must not print, prompt, persist, or set `process.exitCode`.

Authorization must remain unambiguous:

- bare `reconcile` is read-only and successful when it produces a trustworthy drift report;
- `--auto-apply` is the only reconciliation mutation gate;
- global `--yes` only skips confirmation and never grants mutation by itself;
- global `--dry-run` always suppresses prompting, locking, and Docker mutation;
- JSON/YAML auto-apply requires `--yes`, emits one final document on stdout, and captures rather
  than streams subprocess output;
- report success is exit `0`; invalid/unsafe usage is `2`; operational failure is `1`; blocked,
  mixed, or residual convergence is `3` as specified by the aggregate result.

The action should always return every frozen selected service in stable lexical order. Text may
hide unchanged details unless `--show-unchanged` or `--verbose` is set; structured output remains
complete. Existing global `--json`/`--output` precedence and log suppression stay in the `cli.ts`
pre-action hook.

### Legacy CLI compatibility

Keep `rfapps drift detect`, `show`, and `import` unchanged. Replace only the implementation behind
`rfapps drift reconcile`: `executeDriftReconcile()` should delegate to `executeReconcile()` with
auto-apply intent. This removes the current independent call to `startServices()` and ensures the
legacy spelling receives the lifecycle lock, policy, revalidation, safe Docker argv, final
observation, `reconcile.v1` output, and the same exit rules.

### MCP compatibility endpoint

The MCP server currently exposes one relevant mutation tool,
`rfapps.drift.reconcile`, through these layers:

```text
mcp/server.ts -> mcp/tools.ts -> mcp/tools-mutate.ts
-> mcp/adapters.ts::invokeDriftReconcile()
-> actions/drift.ts::executeDriftReconcile()
```

Retain that tool name and do not add a second MCP mutation tool in v1. Change its adapter to the
same reconciliation action/coordinator used by both CLI spellings. Replace the current loose
`{ success, operation, services? }`/fallback output with the complete `ReconcileResult` schema.
MCP is a machine mutation surface, so auto-apply must fail unless its input supplies explicit
`yes: true`; neither JSON capture nor the existence of a mutation-class tool is authorization.

Update `mcp/schema.ts`, adapters, tool metadata, and server/schema/adapter/tool tests together. The
server's JSON-RPC envelope remains unchanged: `tools/list` publishes the schema and `tools/call`
returns the action result in both text content and `structuredContent`. The adapter's global
format-capture lock is still useful, but reconciliation must always emit a real structured result
so the old success fallback can be removed.

## Database Schema

The current SQLite schema is version 3 and contains only:

- `metadata` for schema versioning;
- `deployments` for deploy/rebuild/delete/rollback/apply/prune/update history;
- `generations` for immutable deploy-like image/config recovery snapshots.

Reconciliation should not add a table, column, deployment action, generation action, migration,
query, or state-storage call. It does not have a persisted plan ID, a historical replay contract,
or a data/image rollback guarantee. Its source of truth is the current resolved Compose model plus
the current Docker observation, so durable state would introduce staleness and secret-retention
risks without satisfying an issue #151 requirement.

The action therefore must not call `initializeDatabase()`, `getStateDbPath()`,
`recordDeployment()`, `recordDeployments()`, or `createGeneration()`. This applies to report,
dry-run, and auto-apply. Add negative integration tests that inject state/database spies and prove
zero calls on every path. The lifecycle lock's default directory may share the parent of the
default database path, but creating a private lock file is not a database operation or migration;
it occurs only after approved auto-apply and is released in `finally`.

## External Services

### Docker Compose CLI

Compose remains the desired-state resolver and mutator. All calls must use the same canonical
Compose file, project directory, effective project name, sorted profiles, and environment-tool
wrapper throughout review and apply.

Required operations are:

- `docker compose ... config --format json` for the fully resolved desired model and effective
  project name;
- `docker compose ... ps --all --format json` for all running and stopped project containers while
  preserving every instance and exact container ID;
- per-service `docker compose ... up -d --pull never --no-deps SERVICE` for `create` or `start`;
- the same command plus `--force-recreate` for `recreate`;
- no Compose mutation for `none` or `blocked`.

Do not use `startServices()`: it unconditionally adds `--remove-orphans`. Do not add build, pull,
volume renewal, orphan removal, implicit dependency startup, or unreviewed targets. Commands should
be constructed as argv and executed with the existing `spawn`-based Docker boundary; shell
evaluation remains disabled.

The current `computeExecutionPhases()` is useful for its pure dependency graph behavior, but its
high-level helper falls back to treating all services as independent when Compose resolution
fails. Reconciliation must fail closed instead. Build ordering from the already resolved Compose
configuration with `buildServiceDependencyGraph()`/`topologicalSort()`, or add a strict mode that
turns missing/cyclic/ambiguous dependency evidence into blocked actions. Execute sequentially
within each phase even though the existing graph was originally written for parallel deploys.

### Docker Engine authority

Actual state comes from Compose project enumeration followed by `docker inspect` of exact container
IDs. The current Docker subprocess wrapper already provides bounded stdout/stderr, timeouts, and
SSH retry classification. Reconciliation should use those bounds and reject malformed, oversized,
or incomplete JSON rather than treating it as missing/in-sync state.

Reuse the managed-update authority fingerprint, which hashes active context name, context endpoint,
effective `DOCKER_HOST`, and daemon ID without exposing those components. The fingerprint must be
computed through the same dotenvx/1Password environment used for every Docker command. The typed
`docker.context` config field is currently merged but is not applied by `execDocker()`; do not
silently treat that unused field as the live authority or introduce issue #171 context-switching
semantics here. Bind to what the Docker CLI actually resolves and recheck it under the lock.

Docker access can be host-root equivalent. Results and errors must never expose Docker endpoints,
credentials, raw inspect documents, resolved environment values, environment-source paths, or lock
owner tokens.

### Environment providers

`getEnvToolExecConfig()` selects explicit `--use-dotenvx`/`--use-op` first, then configured
`envTool` plus `envFile`. `execDocker()` wraps Docker with `dotenvx run -q -f ... --` or
`op run --env-file ... --`. Every config, observation, authority probe, and mutation must receive
the same `EnvToolExecConfig`.

Reuse `environmentSourceFingerprint()` to bind approval to provider and canonical source without
putting the path into output. Resolved Compose service fingerprints may include secret-derived
values internally, but only their SHA-256 fingerprints may cross the result boundary. Drift output
continues to expose environment variable names and change kinds only, never values or value hashes.

### Registry and schedulers

Reconciliation performs no registry lookup. Same-tag remote digest freshness remains owned by
`rfapps update`; `--pull never` prevents accidental overlap. V1 also has no internal scheduler,
daemon, retry queue, or maintenance-window parser. Issue #169 will supply future policy semantics;
external cron/systemd automation may invoke the one-shot command now.

## Internal Services

### Scope and canonical identity

`resolveServicesWithInteractive()` already expands configured groups, validates named services,
applies optional sidecar expansion, and derives profiles. For reconciliation, immediately convert
its result into an explicit, unique, sorted service list. When non-interactive no-selector behavior
returns `[]` to mean all services, expand that sentinel with `getComposeServices()` before building
the report; an implicit empty scope must never reach review or mutation.

Move or re-export `resolveComposeProjectIdentity()` and `dockerAuthorityFingerprint()` from
`actions/update.ts` into a neutral library module so update and reconcile use exactly one authority
implementation. Preserve update's current exports temporarily if needed for compatibility.
Reuse `resolvedServiceConfigFingerprint()` and `environmentSourceFingerprint()` rather than
creating weaker substitutes.

The action fingerprint should bind canonical Compose/project identity, Compose content hash,
environment-source and Docker-authority fingerprints, sorted profiles and scope, resolved service
fingerprints, every observed container identity, normalized drift, policy decision, and proposed
actions. It excludes timestamps, durations, display messages, raw secrets, and secret value hashes.

### Drift observation

`detectDrift()` remains the only field-level comparison definition for image, environment, ports,
volumes, networks, and runtime status. Its secret-name classification and masking must remain
shared with drift CLI consumers.

Before reconciliation can rely on it, strengthen its observation boundary:

- replace the running-only `getRunningServiceContainerMap()` dependency with an all-container API
  returning `Map<string, ContainerSnapshot[]>` or an equivalent multiplicity-preserving model;
- distinguish no container (`create`) from one stopped matching container (`start`);
- keep all observed exact IDs in review/revalidation evidence;
- report and block scaled or otherwise ambiguous multiplicity in v1;
- treat desired service absence, Compose/inspect failure, or missing telemetry as
  `observation_failed`/`blocked`, never silently omit the selected service;
- keep `DriftResult` backward compatible for detect/show/import while adding internal observation
  evidence needed by reconciliation.

Reconciliation canonicalizes the resulting drift arrays and categories but must not implement a
second desired-versus-actual comparator.

### Coordinator and policy

`lib/reconcile.ts` should expose injected dependencies for observation, identity/hash, dependency
ordering, policy, lock, targeted Docker action, clock/sleep, and signal state. Its pure planner maps
one complete observation to exactly one action per service:

- `none` for in-sync services;
- `create` for a safely identified missing instance;
- `start` for one stopped instance whose configuration matches;
- `recreate` for safely correctable configuration/image/runtime drift;
- `blocked` for ambiguity, incomplete evidence, unsafe runtime state, dependency-cycle/policy
  denial, or any stale reviewed assumption.

Add a data-only automation policy interface with an allow-all v1 evaluator for explicitly requested
auto-apply. Evaluate it during planning, again under the lifecycle lock, and immediately before a
service action. A policy error fails closed. Do not add maintenance configuration; reserve stable
reason codes and `nextEligibleAt` for issue #169.

### Locking, revalidation, and interruption

Call `acquireLifecycleLock()` only when auto-apply remains authorized and actionable after
confirmation. Use canonical project directory, Docker authority fingerprint, effective Compose
project name, and the existing private state directory/lock format. This shares exclusion with
managed update. Preserve the current behavior for held, stale, invalid, unsafe, and I/O lock errors;
never auto-delete a stale lock.

Under the lock, re-resolve and compare every fingerprinted global assumption. Before each service,
re-observe its exact container identity, drift/action, and policy decision. If reviewed intent
changed, mark `became_in_sync` when the service no longer needs action or block with
`RECONCILE_REVIEW_STALE`; there is no force bypass. Stop scheduling unsafe subsequent work after an
action or stabilization failure while still returning a terminal result for every original
service. SIGINT/SIGTERM should stop new scheduling, stabilize/report the active unit, and release
the lock in `finally`.

### Health and convergence

Reuse `healthCheck.timeout`, `interval`, and `retries`, with `--health-timeout` overriding only the
timeout. `getServiceStatusMap()` already performs uncached `compose ps -a` observation when called
with `cacheTtlMs: 0` and `forceRefresh: true`. `verifyServiceReadiness()` is a useful polling and
dependency-readiness precedent, but it requires an expected image ID and alone cannot prove full
configuration convergence.

After each targeted action, poll a fresh reconciliation observation until both conditions hold:

1. the service has no relevant `ServiceDrift`; and
2. the desired runtime condition is ready under the existing health/running-only policy.

Compose exit zero is not success by itself. Timeout, observation failure, action failure, and
residual drift map to distinct terminal outcomes. After actions stop, re-observe the complete frozen
scope and return results in canonical service order.

## Configuration

Reuse the current layered configuration precedence:

1. required `rfapps.config.yaml` project defaults;
2. home config;
3. XDG config;
4. local `.rfapps.yaml|yml|json`;
5. `RFAPPS_*` environment overrides;
6. command-line Compose/env/profile/sidecar overrides.

Relevant existing fields are `composePath`, `envFile`, `groups`, `sidecars`, `profiles`,
`healthCheck`, `envTool`, `docker.sshRetry`, and `interactive.pageSize`. The repository currently
disables sidecars and defaults to profile `all`, but reconciliation must honor user overrides and
the general CLI contract rather than hard-code repository-local values.

Do not add reconciliation, retry, scheduler, maintenance-window, persistence, or database config in
v1. The policy is injected code, not user configuration. Do not use `parallel.enabled/workers` for
mutation: the validated design requires sequential per-service actions in dependency order. The
existing SSH retry values may continue to configure Docker subprocess retries when that wiring is
available, but a retry must never replay an uncertain mutation; re-observe before any retry.

All Bash, Zsh, and Fish templates in `actions/completion.ts` must gain the top-level command and
every option. Reuse dynamic service/group/profile/path helpers, include suggested health-timeout
values, and add parity tests so completion metadata cannot drift from Commander registration.

## Integration Points

| Integration point      | Current API/behavior                                                          | Required reconciliation integration                                            |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| CLI registration       | `cli.ts` registers drift/update command modules                               | Register top-level reconcile; retain global format/exit hooks                  |
| Service selection      | `resolveServicesWithInteractive()` may return `[]` for all                    | Freeze an explicit unique sorted list before observation                       |
| Compose identity       | `resolveComposeProjectIdentity()` lives in `actions/update.ts`                | Extract/re-export one shared canonical path/project implementation             |
| Docker authority       | `dockerAuthorityFingerprint()` probes actual CLI context/endpoint/host/daemon | Reuse before review and under lock; never emit raw parts                       |
| Environment authority  | `getEnvToolExecConfig()` and `environmentSourceFingerprint()`                 | Use the identical provider/source for every phase and fingerprint it           |
| Desired-state identity | `resolvedServiceConfigFingerprint()` hashes resolved service config           | Bind every reviewed service without exposing resolved values                   |
| Drift comparison       | `detectDrift()` owns categories and secret masking                            | Reuse; add complete multiplicity-preserving observation evidence               |
| Runtime enumeration    | running-only service map collapses instances; status uses `ps -a`             | Add all-container JSON observation with exact IDs and ambiguity handling       |
| Dependency order       | dependency graph supports deterministic phases but has a permissive fallback  | Reuse pure graph; fail closed on unavailable/cyclic evidence; run sequentially |
| Docker mutation        | `startServices()` always includes `--remove-orphans`                          | Add exact per-service `up -d --pull never --no-deps`, optional force recreate  |
| Health                 | fresh service status and bounded readiness polling exist                      | Combine readiness with fresh drift polling for proven convergence              |
| Lifecycle exclusion    | managed update uses `acquireLifecycleLock()`                                  | Share the same canonical project/daemon/project-name lock namespace            |
| Persistence            | SQLite deployment/generation history and plan artifacts exist                 | No database, artifact, history, generation, or migration integration           |
| Legacy CLI             | `drift reconcile` independently force-recreates drifted services              | Delegate with auto-apply intent to the single coordinator                      |
| MCP                    | `rfapps.drift.reconcile` returns a loose fallback mutation result             | Keep name; require explicit machine authorization; return `ReconcileResult`    |
| Output                 | `formatOutput()` supports structured CLI output; MCP captures action JSON     | Emit one complete result and sanitized stderr-only progress                    |
| Completion             | three generated shell templates enumerate commands/options                    | Add reconcile plus selector, path, profile, policy, and timeout helpers        |
| Future maintenance     | issue #169 owns window scheduling                                             | Expose and re-evaluate an injected allow/block policy; add no config now       |

Implementation should land contract/observation integration before mutation, then targeted Docker
actions and lock/revalidation, then CLI/legacy/MCP/completion adapters. Integration tests should
prove zero Docker mutation, lock, filesystem artifact, and database access in bare/dry-run modes;
exact safe argv and sequential ordering in auto-apply; stale authority rejection; complete
per-service accounting; secret-free output; legacy/MCP delegation; and final convergence rather
than subprocess success alone.
