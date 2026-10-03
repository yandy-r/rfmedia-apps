# Reconciliation Command Pattern Research

## Architectural Patterns

### Thin command registration, boundary action, data-only coordinator

The repository's strongest recent precedent is the managed-update split:

- `packages/rfapps-cli/src/commands/update.ts` defines the Commander surface, validates option
  conflicts that Commander can detect, dynamically imports the action, and passes `program.opts()`
  as global options.
- `packages/rfapps-cli/src/actions/update.ts` owns configuration loading, CLI overrides, service
  selection, environment-tool resolution, approval, output, exit state, signals, and resource
  cleanup.
- `packages/rfapps-cli/src/lib/managed-update.ts` owns the deterministic lifecycle. It accepts a
  grouped dependency interface, returns typed data, and does not print or change `process.exitCode`.
- `packages/rfapps-cli/src/types/update.ts` owns the versioned plan/result contracts.

Reconciliation should use the same direction of dependency:
`commands/reconcile.ts -> actions/reconcile.ts -> lib/reconcile.ts`, with the action constructing
production dependencies and the coordinator remaining independent of Commander, logging, prompts,
formatters, databases, and process-global state. Unlike managed update, bare reconciliation must not
write an artifact or open SQLite; the architectural split is reusable, not update's persistence
behavior.

### One immutable reviewed scope and authority identity

`packages/rfapps-cli/src/actions/update.ts` already establishes useful authority primitives:

- `resolveComposeProjectIdentity()` rejects empty/NUL paths, noncanonical saved paths, symlinked
  components, non-files, and unsafe project names; it returns one canonical Compose path, project
  directory, and effective Compose project name.
- `dockerAuthorityFingerprint()` binds context name, context endpoint, effective `DOCKER_HOST`, and
  daemon ID without exposing those values.
- `packages/rfapps-cli/src/lib/managed-update.ts` exposes `environmentSourceFingerprint()` and
  revalidates Compose, project, daemon, resolved service configuration, and container identity.

These helpers should be extracted into a shared identity module and consumed unchanged by both
managed update and reconciliation. Reconciliation's action fingerprint should add the sorted
profiles, explicit sorted scope, normalized drift, policy decision, observed container identities,
and proposed actions. Hash inputs should use explicit delimiters and canonical ordering, as the
existing SHA-256 helpers do. Timestamps, messages, durations, secret values, and raw Docker payloads
must remain outside the fingerprint.

### Frozen scope through existing selection helpers

`packages/rfapps-cli/src/lib/interactive-selection.ts` is the established boundary for combining
`--service`, comma-split `--services`, `--group`, optional sidecars, validation, interactive
selection, and profile detection. `packages/rfapps-cli/src/actions/update.ts` demonstrates the
important all-services follow-up: when selection returns an empty service array, call
`getComposeServices()` and materialize the full service list before planning.

For reconciliation, normalize and lexically sort the final profiles and services once, preserve
that explicit list through observe/revalidate/apply/verify, and include every selected service in
the terminal result. Dependency ordering may use the pure graph functions in
`packages/rfapps-cli/src/lib/dependency-graph.ts`, but terminal results must be restored to lexical
service order. Dependencies outside the frozen scope must not be added implicitly.

### Reuse drift comparison, strengthen observation

`packages/rfapps-cli/src/lib/drift.ts` is the shipped desired-versus-actual definition. It already
normalizes images, environment, ports, volumes, networks, and runtime status into `ServiceDrift`,
and masks suspected secret environment values. `packages/rfapps-cli/src/types/drift.ts` defines the
stable category vocabulary and service-drift shape.

Current observation uses `getRunningServiceContainerMap()`, so stopped containers are not inspected
and a service maps to at most one running container. Reconciliation must extend the Docker/drift
observation boundary to enumerate `compose ps --all`, preserve exact container IDs, and distinguish
missing, stopped, and ambiguous/scaled instances. The existing `ServiceDrift` schema and detect,
show, and import behavior must remain compatible; reconciliation-specific observation failure or
ambiguity belongs in the new result/action layer rather than being silently collapsed.

### Shared lock, revalidation, bounded sequential apply

`packages/rfapps-cli/src/lib/lifecycle-lock.ts` provides the shared project/daemon exclusion
primitive and explicit release contract. `packages/rfapps-cli/src/lib/managed-update.ts` shows the
correct lifecycle shape: skip lock acquisition for a no-op, acquire before mutation, revalidate
global identity, revalidate each service immediately before its mutation, execute sequentially,
stabilize interruption/failure, and release in cleanup.

Reconciliation should follow the same shape with one data-oriented, injected policy decision.
Policy and action evidence must be re-evaluated under the lock and immediately before each action.
The allow-all v1 policy should still return typed `allowed` or `blocked` data so issue #169 can add
maintenance windows without changing coordinator structure.

### Dedicated target-only Docker primitive

`packages/rfapps-cli/src/lib/docker.ts` centralizes typed, argument-array Docker execution,
environment-tool wrapping, SSH retry, timeouts, and bounded stdout/stderr capture. Reconciliation
should add a dedicated primitive that constructs exact Compose argv for one reviewed service:
`-f`, canonical project/profile arguments, `up -d`, optional `--force-recreate`, `--pull never`,
`--no-deps`, and the single service operand.

Do not reuse `startServices()` for reconciliation: it unconditionally adds `--remove-orphans` and
can operate on a broad service set. Do not reuse managed update's `recreateServiceWithImage()` as-is:
it is image-update/recovery oriented and may pull. Exact argv construction is a security boundary
and should be directly unit tested.

### Bounded post-action verification

`packages/rfapps-cli/src/lib/health.ts` provides bounded polling and separates target readiness from
dependency evidence. Its tests cover elapsed-time bounds, stable-running windows for containers
without health checks, and profile-aware observation. Reconciliation should reuse the configured
timeout/interval/retry values, then combine readiness with a fresh drift observation. Compose exit
zero is only action completion; `converged` requires no relevant final drift plus the desired ready
runtime condition.

### Output and compatibility are adapters over one result

`packages/rfapps-cli/src/lib/formatters/index.ts` keeps text rendering in actions and routes
JSON/YAML/CSV/table through `formatOutput()`. `withFormatOutputCapture()` provides an
`AsyncLocalStorage` capture boundary used by `packages/rfapps-cli/src/mcp/adapters.ts` so MCP calls
can invoke the same action without scraping stdout.

The top-level command, legacy `rfapps drift reconcile`, and existing `rfapps.drift.reconcile` MCP
tool should all delegate to `executeReconcile()` and return `reconcile.v1`. The MCP name stays
stable, but its schema and adapter must stop returning the current generic
`{ success, operation, services? }` fallback. No separate MCP mutation coordinator or policy path
should exist.

## Code Conventions

- Use TypeScript ESM and include `.js` on every relative import. Group imports in the existing
  order: Node built-ins, external packages, type imports, then local runtime imports.
- Keep command files small. Export `registerReconcileCommand(program: Command): void`, use
  `.configureHelp({ showGlobalOptions: true })`, declare option defaults explicitly where safety
  depends on them, add an exit-code help block, and dynamically import the action inside `.action()`.
- Name raw Commander shapes `RawReconcileOptions`, normalized internal shapes
  `NormalizedReconcileOptions`, boundary dependencies `ReconcileActionDependencies`, and grouped
  coordinator dependencies `ReconcileDependencies`. Use `readonly` arrays at library boundaries and
  clone before passing mutable arrays to lower-level APIs.
- Put versioned public contracts in `types/reconcile.ts`, with
  `RECONCILE_SCHEMA_VERSION = "reconcile.v1" as const`; export them through `types/index.ts`. Export
  coordinator and Docker helpers through `lib/index.ts` only when they are intended shared APIs.
- Prefer literal unions and exhaustive `switch` statements for comparison, action, outcome, stage,
  policy, and status values. Compose result objects with conditional spreads so optional fields are
  omitted rather than serialized as `undefined`.
- Normalize at the boundary: trim and validate comma-separated services, require a positive finite
  health timeout, reject conflicting/unsafe options before Docker, lock, or prompt calls, and map
  Commander `sidecars === false` to the repository's `noSidecars` convention.
- Use code-point lexical ordering for services/profiles/networks and explicit rank constants for
  drift categories. Do not inherit `Object.keys()`, Compose discovery, inspect, map, or dependency
  traversal order into the public result.
- Keep subprocess calls as argument arrays through `execDocker()`/`execDockerCompose()`; never use a
  shell command string. Pass the selected environment tool through identity, observe, and mutation
  calls so review and apply use the same environment.
- Human detail/progress belongs on stderr through the existing logging functions or
  `console.error`; machine output belongs on stdout through exactly one `formatOutput()` call.
  Libraries never log, prompt, write output, or set `process.exitCode`.
- Avoid raw Compose config, Docker inspect documents, endpoints, environment source paths, or
  stderr in public data. Environment changes should expose only variable name and change kind.
  Apply bounded structural redaction before an error enters a result or cleanup record.

## Error Handling

The repository separates invalid usage from runtime lifecycle evidence:

- `packages/rfapps-cli/src/lib/errors.ts` defines dependency-free custom errors with a descriptive
  `Error` message, literal `name`, and readonly context fields. `InvalidArgumentError` is the
  established choice for malformed values, unsafe combinations, invalid profiles, and missing
  explicit authorization.
- `packages/rfapps-cli/src/lib/error-formatters.ts` registers user-facing messages, suggestions,
  and exit categories. New reconciliation-specific CLI errors should be registered there only if
  existing `InvalidArgumentError`/`DockerCommandError` cannot represent them safely.
- `packages/rfapps-cli/src/lib/managed-update.ts` demonstrates stable, bounded lifecycle evidence:
  stage plus reason code plus redacted message. Expected observation, policy, stale-review, action,
  verification, and cleanup failures should be returned in `reconcile.v1`, not thrown after useful
  per-service evidence exists.
- Throw before result construction for invalid/unsafe input. Once observation starts, preserve all
  trustworthy service evidence and aggregate a complete terminal result. Unexpected exceptions
  must be converted into a bounded, redacted operational failure without exposing raw Docker or
  Compose payloads.
- Cleanup belongs in `finally`. Signal listeners and locks must always be disposed; cleanup failure
  must not overwrite the primary failure, but it must be represented and can downgrade an otherwise
  successful result.

Exit behavior should be derived from the result contract, then applied once by the action:

- Report mode: exit `0` for a trustworthy complete report, even when drift is reported.
- Auto-apply: exit `0` only when the complete requested scope converges; exit `3` for mixed,
  blocked, or residual-drift results; exit `1` for operational/observation/action failure; exit `2`
  for invalid or unsafe usage.
- `packages/rfapps-cli/src/lib/exit-codes.ts` already names `Success = 0`,
  `OperationalError = 1`, `UsageError = 2`, and `PartialSuccess = 3`. Add a pure reconcile resolver
  there if needed, while keeping the definitive `exitCode` on `ReconcileResult`.
- Set `process.exitCode` only after the single machine document has been emitted. The coordinator
  must be tested to leave both console output and `process.exitCode` untouched.
- Global `--dry-run` always forces nonmutation. `--yes` only skips a human confirmation; it never
  grants mutation. Machine-format auto-apply without `--yes` is a usage error and must not prompt,
  lock, or mutate.

## Testing Approach

### Pure coordinator tests with injected dependencies

Follow `packages/rfapps-cli/src/lib/managed-update.spec.ts`: build a complete deterministic fake for
the grouped dependency interface and override one dependency per scenario. Assert returned data and
call order rather than mocking module globals. Required coordinator cases include:

- all in sync returns a complete no-op without lock or mutation;
- missing, stopped, config/image/runtime drift, multiple drift categories, and one action per
  service;
- every selected service appears exactly once in lexical order;
- normalized-equivalent observations produce identical semantic results and fingerprints;
- ambiguous/scaled and incomplete observations produce `blocked`, never speculative mutation;
- policy allow, deny, and error behavior, including a second decision under lock;
- global identity, scope, Compose, daemon, environment source, container identity, drift, policy,
  and action staleness all fail closed before mutation;
- drift disappearing on revalidation becomes `became_in_sync`;
- actions run sequentially in dependency phases and later unsafe work stops after an uncertain
  failure;
- post-action drift/readiness yields `converged`, `not_converged`, or `action_failed` accurately;
- SIGINT/SIGTERM stops scheduling, stabilizes the active unit, and releases the lock;
- the coordinator never prints, prompts, persists, or changes process exit state.

Use call-order arrays for security-critical sequencing, as action/update tests already do for
reserve/run/final-output and close/save/output ordering.

### Action tests through an explicit dependency object

Follow `packages/rfapps-cli/src/actions/update.spec.ts`: export
`ReconcileActionDependencies`, provide a `defaultDependencies`, and accept an optional third
dependency argument in `executeReconcile()`. Tests should prove:

- raw options and environment-tool overrides reach selection, identity, and coordinator calls;
- implicit all-services selection is expanded before planning and the canonical project directory
  is used regardless of current working directory;
- bare and dry-run modes never call confirm, acquire the lifecycle lock, mutate Docker, write files,
  initialize SQLite, record history, or create generations;
- report mode emits drift with exit `0` and auto-apply maps each terminal aggregate to `0/1/2/3`;
- human auto-apply asks exactly once with the exact action count/targets, default-decline performs no
  mutation, and `--yes` skips only confirmation;
- machine auto-apply without `--yes` fails before prompt/mutation;
- JSON and YAML emit exactly one full `reconcile.v1` document; text writes no structured stdout;
- secret-bearing fixtures and long/raw errors do not appear in output, logs, or fingerprints;
- signals and lock resources are disposed even when observation, mutation, verification, output, or
  cleanup fails.

### Command, Docker, and observation tests

- Add focused command registration tests like the registration portion of
  `packages/rfapps-cli/src/managed-update.integration.spec.ts`: inspect the Commander tree/help for
  the command name, every option, defaults, and exit-code guidance.
- Unit test exact Docker argv for `create`, `start`, and `recreate`. Assert `--pull never`,
  `--no-deps`, canonical project/profile arguments, and one service operand; explicitly assert the
  absence of `--remove-orphans`, `pull`, `build`, volume flags, and extra services.
- Extend `packages/rfapps-cli/src/lib/drift.spec.ts` and Docker parsing tests for JSON Lines,
  stopped containers, missing containers, duplicate/scaled instances, malformed/oversized output,
  inspect mismatch, stable ordering, and secret-value omission. Preserve all existing drift tests.
- Reuse bounded readiness cases from `packages/rfapps-cli/src/lib/health.spec.ts`, adding final
  re-observation cases where Compose succeeds but drift remains.

### Compatibility and completion tests

- Update `packages/rfapps-cli/src/mcp/schema.ts` with a structural schema for the full result and a
  compile-time `McpSchema<ReconcileResult>` anchor. Adapter tests must prove the legacy tool invokes
  the same action with `autoApply: true`, passes `yes` explicitly, captures one result, restores
  `process.exitCode`, and no longer uses the generic success fallback.
- Update `packages/rfapps-cli/src/actions/completion.spec.ts` with a parameterized
  `it.each(["bash", "zsh", "fish"])` assertion for every reconciliation option. Add shell-specific
  assertions for dynamic service, group, and profile helpers; comma-list service completion; path
  completion for Compose/env files; and suggested timeout values. Also verify legacy nested
  completion remains present.
- Add an integration test spanning command registration, action, and coordinator for report,
  no-op auto-apply, stale review, multi-service sequential convergence, partial failure, and MCP
  delegation. Add a Docker-backed test guarded by Docker availability, following
  `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts`, to prove only the reviewed
  service is changed.

### Completion gates

Run focused Vitest suites first, then the full rfapps test suite, typecheck, build, formatter,
markdownlint, `git diff --check`, and Docker-backed tests when available. Update Graphify after code
changes and verify documentation, all three shell templates, MCP schemas, and `ROADMAP.md` against
the actual Commander surface.

## Patterns to Follow

1. Model reconciliation as observe, decide, optionally lock/revalidate/act, then re-observe; never
   treat Compose success as convergence.
2. Reuse `ServiceDrift`, canonical identity helpers, service selection, lifecycle locking, Docker
   execution, dependency graph, readiness polling, format capture, and exit-code vocabulary.
3. Keep one coordinator and one `reconcile.v1` contract behind top-level CLI, legacy CLI, and MCP
   compatibility adapters.
4. Freeze, sort, fingerprint, and completely account for scope before approval; revalidate the
   exact authority and action immediately before mutation.
5. Use a dedicated one-service Compose primitive with no pulls, builds, dependencies, or orphan
   removal; do not route through the current broad `startServices()` helper.
6. Make report mode structurally incapable of locking, prompting, persisting, or mutating, and prove
   every prohibited side effect with negative tests.
7. Keep public evidence allowlisted, deterministic, bounded, and secret-free; never serialize raw
   Compose/Docker observations or environment values.
8. Preserve existing drift detect/show/import schemas and behavior while extending observation
   internally for stopped and ambiguous instances.
9. Treat `--auto-apply` as the only reconciliation mutation gate, `--yes` as confirmation control,
   and `--dry-run` as an unconditional mutation veto.
10. Update and parity-test Bash, Zsh, and Fish completions whenever the command surface changes.
