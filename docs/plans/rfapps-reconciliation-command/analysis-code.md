# Code Analysis: rfapps Reconciliation Command

## Executive Summary

The implementation should add a dedicated command/action/coordinator stack while reusing three
existing authorities: `lib/drift.ts` for desired-versus-actual comparison, the managed-update
identity and lifecycle patterns for fail-closed mutation, and the existing formatter/MCP capture
path for one structured result. The current legacy reconciliation path is unsafe for the new
contract: `actions/drift.ts::executeDriftReconcile()` treats any machine format as permission to
mutate and calls `startServices()`, whose Compose arguments always include `--remove-orphans`.

The main structural gap is observation fidelity. Current Docker helpers and status parsing collapse
containers into `Map<service, container>`, ignore stopped containers for inspection, and silently
overwrite duplicate service instances. Reconciliation needs a new multiplicity-preserving
`compose ps --all --format json` observation primitive, exact container inspection, deterministic
normalization, and an explicit blocked result for ambiguous instances. Auto-apply should then use a
feature-local dependency-injected coordinator that acquires the existing lifecycle lock, rechecks
the canonical project, Docker/environment authority, scope, resolved service fingerprints,
container evidence, policy, and proposed action, and invokes a new target-only Compose primitive.

## Existing Code Structure

### CLI and action boundaries

- `packages/rfapps-cli/src/cli.ts` creates the Commander program, defines global `--dry-run`,
  `--json`, `--output`, `--yes`, and secrets-provider options, and configures logger/output state in
  a `preAction` hook. It imports and invokes dedicated registration functions for larger command
  surfaces (`registerUpdateCommand()`, `registerDriftCommand()`, audit, and doctor). A new
  `registerReconcileCommand(program)` fits this existing registration pattern.
- `packages/rfapps-cli/src/commands/update.ts` is the closest command-module example: it owns the
  option declarations and argument-conflict validation, uses `.configureHelp({
showGlobalOptions: true })`, dynamically imports the action, and passes `program.opts()` as the
  global option object.
- `packages/rfapps-cli/src/actions/update.ts` is the closest boundary-action example. It normalizes
  raw Commander values, validates profile/timeout/service lists, loads and overrides config,
  resolves the environment tool and canonical project, freezes an explicit target list, owns
  confirmation/signals/formatting/exit state, and delegates lifecycle work through an injected
  `UpdateActionDependencies` interface.
- `packages/rfapps-cli/src/commands/drift.ts` currently defines `drift reconcile` with targeting and
  Compose options, but no explicit mutation flag. Its action dynamically imports
  `executeDriftReconcile()`.
- `packages/rfapps-cli/src/actions/drift.ts::executeDriftReconcile()` loads config, calls
  `resolveServicesWithInteractive()`, calls `detectDrift()`, and force-recreates every drifted
  service through `startServices()`. It prompts only for non-machine formats, so JSON/YAML/CSV can
  currently mutate without `--yes`. Detect, show, and import are independent functions in the same
  file and should remain intact.

### Drift and observation

- `packages/rfapps-cli/src/types/drift.ts` defines `DRIFT_SCHEMA_VERSION = "1.0.0"`, the ordered
  categories (`image`, `environment`, `ports`, `volumes`, `networks`, `runtime-status`),
  `RuntimeStatusDrift`, `ServiceDrift`, and `DriftResult`.
- `packages/rfapps-cli/src/lib/drift.ts::detectDrift(options, envTool)` resolves Compose with
  `getComposeConfig()`, obtains a running-only service/container map, inspects those container
  names, requests a fresh status map, and builds one `ServiceDrift` per requested Compose service.
  Missing inspection evidence becomes undefined current configuration; missing runtime status
  defaults to `{ state: "created", health: "none" }`.
- `buildServiceDrift()` is private and is the single comparison implementation. It compares image,
  environment, ports, volumes, networks, and runtime status, then derives categories and direction.
  Reconciliation must either expose a narrow way to feed complete observations into this function
  or extend `detectDrift()` without duplicating these comparison rules.
- `compareEnv()` masks secret-looking values as `********`, but non-secret current/desired values
  remain present in `ServiceDrift`. The public `reconcile.v1` projection must omit all environment
  values and retain only variable name, change kind, and secret classification; raw drift evidence
  can remain process-local for revalidation.
- `packages/rfapps-cli/src/lib/docker.ts::getRunningServiceContainerMap()` executes
  `compose ps --status running --format "{{.Service}}\t{{.Name}}"` and returns
  `Map<string, string>`. Duplicate instances overwrite earlier entries, and stopped containers are
  absent.
- `packages/rfapps-cli/src/lib/service-status.ts::getServiceStatusMap()` does use
  `compose ps -a --format json` and accepts array or JSON-Lines output, but initializes a single map
  entry per Compose service and overwrites it for each returned instance. It is appropriate for UI
  status, not authoritative reconciliation evidence.

### Identity, locking, ordering, and verification

- `packages/rfapps-cli/src/actions/update.ts` currently owns exported
  `resolveComposeProjectIdentity()` and `dockerAuthorityFingerprint()`. The former rejects empty or
  NUL paths, can require absolute normalized saved input, rejects symlink path components, resolves
  a regular file with `realpath()`, and obtains a validated effective Compose project name. The
  latter hashes active context, context endpoint, effective `DOCKER_HOST`, and daemon ID without
  returning those raw authority values.
- `packages/rfapps-cli/src/lib/managed-update.ts` already owns
  `environmentSourceFingerprint()`, which hashes the environment provider and resolved source path.
  Shared identity extraction should leave compatibility exports or update every existing import so
  managed-update behavior and tests remain unchanged.
- `packages/rfapps-cli/src/lib/plan-generator.ts::resolvedServiceConfigFingerprint()` recursively
  sorts object keys, removes undefined object members, preserves array order, serializes the fully
  resolved service model, and hashes it with SHA-256. This is the existing secret-free stale-intent
  fingerprint; never emit the resolved service model itself.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts::acquireLifecycleLock()` binds a private lock file
  to canonical project path, Docker fingerprint, and optional Compose project name. It uses
  `O_CREAT | O_EXCL | O_NOFOLLOW`, `0700`/`0600` permissions, refuses automatic stale-lock takeover,
  and returns an idempotent `release()` function. Report mode must never call it.
- `packages/rfapps-cli/src/lib/managed-update.ts::runManagedUpdate()` demonstrates the required
  ordering: early interruption check, lock, parallel global revalidation, per-service immediate
  revalidation, sequential action, terminal result accounting, and `finally` cleanup via
  `Promise.allSettled()`. Its dependencies are grouped by concern rather than imported globally,
  which makes ordering and negative-mutation tests direct.
- `packages/rfapps-cli/src/lib/dependency-graph.ts::computeExecutionPhases()` resolves Compose,
  filters dependencies to the explicit target set, incorporates `depends_on`,
  `network_mode: service:*`, and configured sidecar relationships, and returns alphabetically
  sorted phases. It currently falls back to treating all targets as independent if Compose parsing
  fails. Reconciliation auto-apply should fail closed instead of accepting that fallback, or call
  the pure graph functions only after successful Compose resolution.
- `packages/rfapps-cli/src/lib/health.ts::verifyServiceReadiness()` provides injected clock/sleep
  and observer seams, bounded retry/timeout polling, stable-running assurance when no healthcheck
  exists, exact expected image checks, and dependency readiness evidence. Reconciliation also needs
  a fresh drift observation after readiness; readiness alone does not prove configuration
  convergence.

### Docker mutation helpers

- `startServices()` always builds `compose ... up -d --remove-orphans`, optionally adding
  `--pull never` and `--force-recreate`. It must not be used by reconciliation.
- `recreateServiceWithImage()` validates service/project/profile operands, canonicalizes Compose
  paths, creates a private temporary override, and performs exact-image recreation with
  `--pull never`. It is update-specific, can pull a reviewed digest, and currently does not add
  `--no-deps`; it should be treated as a safety-pattern reference rather than the reconcile API.
- The new reconciliation primitive should accept one exact service and action mode, validate all
  operands, bind `-f`, `--project-name`, and profiles, capture output when required, and emit one of:
  `up -d --pull never --no-deps SERVICE` for create/start or
  `up -d --pull never --no-deps --force-recreate SERVICE` for recreate. Tests should assert the
  complete argument array and explicitly reject orphan removal, pulling, builds, volumes, and
  additional service operands.

## Implementation Patterns

### Thin command, injected action, data-only coordinator

Follow `commands/update.ts -> actions/update.ts -> lib/managed-update.ts`:

1. `commands/reconcile.ts` declares and validates the public Commander options only.
2. `actions/reconcile.ts` normalizes inputs; loads config; resolves environment, canonical project,
   explicit sorted scope, profiles, and health settings; owns human rendering, confirmation,
   machine-format authorization, signal lifetime, formatter calls, and `process.exitCode`.
3. `lib/reconcile.ts` accepts a typed request and grouped injected dependencies, returns a complete
   `ReconcileResult`, and never logs, prompts, writes files/SQLite, or changes process-global state.

The coordinator should expose separate pure planning and lifecycle functions where practical. A
pure planner can canonicalize drift evidence, classify `none | create | start | recreate |
blocked`, evaluate the policy seam, produce the action fingerprint, and aggregate the report. The
auto-apply function should consume exactly that report in the same process and revalidate rather
than constructing a second plan.

### Discriminated, complete result contracts

Model `packages/rfapps-cli/src/types/reconcile.ts` after `types/update.ts`: export an `as const`
schema discriminator, discriminated unions for action/outcome/policy/verification state, stable
reason codes, and a terminal per-service record. Every resolved service must occur exactly once,
and terminal results must be returned in frozen service order even if execution uses dependency
phases.

Keep deterministic semantic fields separate from volatile metadata. Canonical fingerprint input
should include sorted profiles/services, canonical project and authority fingerprints, resolved
service fingerprints, normalized container identities, sanitized normalized drift, policy, and
proposed actions; exclude timestamps, durations, display messages, and secret values.

### Fail-closed revalidation and cleanup

Mirror managed-update's lifecycle shape, but do not reuse its image-update/result types:

- Report and dry-run stop after observation/planning and do not acquire a lock or initialize state.
- Auto-apply acquires the shared lock only when at least one action is eligible.
- Under the lock, recompute Compose/project, environment source, Docker authority, explicit scope,
  resolved configuration fingerprints, all-container observations, policy, actions, and action
  fingerprint. Any change becomes `RECONCILE_REVIEW_STALE`; there is no force bypass.
- Re-observe immediately before each service. If drift disappeared, emit `became_in_sync`; if the
  action or evidence changed, stop and block remaining unsafe work.
- Execute services sequentially within dependency phases, checking SIGINT/SIGTERM between units.
- After each action, run bounded readiness and fresh drift observation; Compose exit zero is not a
  successful `converged` outcome by itself.
- Release the lock in `finally`; record bounded sanitized cleanup failures in the result.

### Exact output and capture

`lib/formatters/index.ts::formatOutput()` returns for text, renders tables, or emits JSON/YAML/CSV;
`withFormatOutputCapture()` uses `AsyncLocalStorage` so MCP adapters capture the original payload.
`actions/reconcile.ts` should call `formatOutput()` exactly once with the complete result for every
non-text path. JSON/YAML should receive the nested result; table/CSV should receive one documented
service-summary projection if supported. Human progress and reports belong on stderr to preserve
stdout.

## Integration Points

### Public CLI and compatibility CLI

- Import and call `registerReconcileCommand(program)` from `cli.ts` alongside the existing
  dedicated command registrations.
- Register the exact options from the feature spec: service/services/group/no-sidecars,
  `--auto-apply`, `--show-unchanged`, `--health-timeout`, compose/env/profile, plus inherited globals.
- Change `commands/drift.ts` and `actions/drift.ts` so legacy `rfapps drift reconcile` delegates to
  the new action with auto-apply intent. Do not change drift detect/show/import behavior.
- Legacy machine mutation must still require explicit `--yes`; output format never grants
  authority. Global `--dry-run` always wins over legacy auto-apply intent.

### Service and profile scope

- `resolveServicesWithInteractive()` returns an empty service array to mean all services and can
  prompt when no target is supplied. Report mode must not prompt, so either extract a deterministic
  non-interactive resolution core or invoke it with explicit non-interactive semantics, then
  materialize empty/all scope with `getComposeServices()`.
- Deduplicate, validate, and code-point-sort services and profiles before observation. Preserve the
  current group and bidirectional sidecar rules from `lib/services.ts`, but never expand scope after
  the report is built.
- `ResolveOptions` and `ResolveResult` are currently private to `interactive-selection.ts`; expose a
  narrow reusable type/helper only if the action needs it rather than copying expansion logic.

### MCP

- Keep the existing public tool name `rfapps.drift.reconcile` in `RFAPPS_MCP_TOOL_NAMES` and
  `tools-mutate.ts`; do not add a second mutation tool.
- Define a reconciliation-specific input type/schema with `autoApply` or equivalent explicit
  mutation intent and `yes`; require both for machine mutation. Replace the permissive
  `driftMutationResultSchema` with the exact complete `reconcile.v1` schema.
- `invokeDriftReconcile()` must call `executeReconcile()` and return captured structured output.
  Remove its generic success fallback: `runActionWithJsonCapture()` should fail if reconciliation
  produces no document, because fallback success can hide incomplete execution.
- Keep `withActionCaptureLock()` around action calls because adapters temporarily use global
  `process.exitCode`; verify that the prior exit code is restored on success and error.

### Completion, barrels, errors, and exits

- `actions/completion.ts` contains three manually maintained templates. Add top-level `reconcile`,
  its full option set, service-list/group/profile/path helpers, and the legacy options consistently
  in Bash, Zsh, and Fish.
- Extend `completion.spec.ts` using the existing `it.each(["bash", "zsh", "fish"])` parity style,
  plus shell-specific assertions for dynamic service/group/profile/path completion.
- Export reconcile types from `types/index.ts` and coordinator/Docker helpers from `lib/index.ts`.
  ESM imports require explicit `.js` suffixes.
- Add a reconcile exit resolver to `lib/exit-codes.ts` returning the existing constants:
  trustworthy report/converged `0`, operational failure `1`, invalid usage via typed errors `2`, and
  mixed/blocked/residual auto-apply `3`.
- Reuse `InvalidArgumentError` for invalid option combinations and add a reconciliation-specific
  typed error/formatter only when actionable CLI guidance is not expressible in the result. Error
  classes remain dependency-free; formatters use `instanceof`, suggestions, and stable exit codes.

### Tests and documentation-adjacent code

- Add co-located `commands/reconcile.spec.ts`, `actions/reconcile.spec.ts`,
  `lib/reconcile.spec.ts`, `types`/schema assertions where useful, and
  `reconcile.integration.spec.ts`.
- Extend `docker.spec.ts` for all-container JSON/JSON-Lines parsing, duplicate instances, stopped
  instances, malformed/bounded output, exact argv, profiles/project binding, and no scope widening.
- Extend `drift.spec.ts` for missing, stopped, unhealthy, ambiguous, multiple-category, secret, and
  stable-order observations without regressing drift detect/import semantics.
- Extend MCP schema/adapter/tool/server tests so input and output schemas match the new result and
  no fallback success is possible.
- Update `package-lock.json` so `yaml` resolves to at least `2.8.3`; the declared `^2.7.0` range
  already permits that patch. Add no runtime dependency.

## Code Conventions

- TypeScript is strict ESM/NodeNext. Use `.js` on relative imports, `import type` for type-only
  imports, no `any`, and discriminated unions for mode- or status-specific data.
- Action functions accept raw command options and a global-options object. Dependency injection is
  an optional final parameter with production defaults, as in `executeUpdate()`.
- Libraries return data and throw validation/runtime errors; they do not print, prompt, or set
  `process.exitCode`. Actions own those process and UX effects.
- Custom errors extend `Error`, set a literal name, retain readonly bounded context, and avoid
  dependencies on action/library modules. Register specific formatters once at startup.
- Docker execution always uses argument arrays through `execDocker()`/`execDockerCompose()`, never a
  shell command string. Capture limits, timeouts, environment-tool wrapping, and SSH retry behavior
  are already centralized in `DockerExecOptions`.
- Tests are co-located Vitest files. Prefer injected dependencies for coordinators/actions and exact
  argument assertions for Docker helpers. Use `vi.clearAllMocks()` when retaining mock
  implementations and restore process-global state after every test.
- Deterministic collections should be copied, deduplicated, and explicitly sorted; do not depend on
  Compose, Map insertion, object enumeration, or asynchronous completion order.
- Log/progress output uses stderr; the formatter owns machine stdout. Do not interpolate raw Docker
  inspect, Compose config, environment values, endpoints, or secret-bearing errors into messages.

## Dependencies and Services

- **Docker Compose CLI**: desired model via `config --format json`, authoritative instance list via
  `ps --all --format json`, and target-only convergence via `up -d --pull never --no-deps` with
  optional `--force-recreate`.
- **Docker Engine CLI**: context/daemon authority and exact container inspection. Reuse bounded
  `execDocker()` calls and never publish raw endpoint or inspect payloads.
- **Commander v14**: existing command registration and validation mechanism.
- **`@rfmedia/common`**: logging, confirmation, machine-format detection, error formatting, and
  output serialization.
- **Node built-ins**: `crypto` for fingerprints, filesystem/path APIs for canonical identity, and
  process signals. No new controller, Docker SDK, scheduler, or persistence dependency is needed.
- **Lifecycle lock storage**: reuse `lib/lifecycle-lock.ts`; reconciliation does not use SQLite,
  generation history, or plan storage.
- **Health/readiness service**: reuse `verifyServiceReadiness()` settings from `RfappsConfig`, then
  combine that evidence with fresh drift observation.
- **Future maintenance policy**: define an injected data-only eligibility interface with an
  allow-all v1 implementation. Issue #169, not this change, owns schedules/time zones/config.
- **YAML**: retain the current package but refresh the lock from `2.8.2` to `>=2.8.3` as specified by
  the feature security review.

## Gotchas and Warnings

- `startServices()` is structurally incompatible because `--remove-orphans` is unconditional.
- Existing running/status maps collapse scaled services. Reusing either as reconciliation authority
  would silently select the last returned container and violate the ambiguity hard stop.
- `detectDrift()` inspects running containers only. A stopped matching container currently looks
  configuration-missing even though status knows it is exited; classification must distinguish
  `start` from `create` and `recreate` using complete evidence.
- `computeExecutionPhases()` deliberately degrades to an all-independent phase when Compose parsing
  fails. That convenience fallback is unsafe for auto-apply.
- `resolveServicesWithInteractive()` can prompt and uses an empty array as an implicit all-services
  sentinel. The result contract requires an explicit complete scope and report mode requires zero
  prompts.
- Current legacy machine formats skip confirmation and mutate. Delegation must deliberately tighten
  this behavior by requiring `--yes`; do not preserve it as compatibility.
- Existing drift objects retain non-secret environment values and masked secret placeholders.
  Do not serialize the raw object directly into `reconcile.v1`; build a value-free projection.
- Compose `up --no-deps` prevents implicit dependency startup, but ordering can only include
  dependencies already inside the frozen scope. Never widen scope to satisfy a dependency.
- Readiness success and Compose command success are insufficient if final drift remains. Always
  retain `finalDrift` for `not_converged` outcomes.
- Do not create saved reconcile plans, `.rfapps` artifacts, database rows, generations, retries, or
  rollback claims. A later run re-observes level-triggered state.
- Timestamps and durations make output bytes volatile. Determinism applies to semantic report
  content and the action fingerprint; exclude volatile data from the fingerprint.
- MCP schema helpers default to exact objects unless `allowUnknownProperties` is enabled. The new
  result schema should be exact and must stay aligned with exported TypeScript types.
- The completion system is not generated from Commander metadata; every Bash/Zsh/Fish template and
  its tests must be updated manually.

## Task-Specific Guidance

1. Land `types/reconcile.ts`, pure canonicalization/action classification, and deterministic tests
   first. Use explicit category/action ordering constants and sanitize environment drift at this
   boundary.
2. Extract canonical Compose, Docker authority, and environment-source helpers into a shared
   identity library. Preserve action/update exports temporarily if needed, and run the existing
   `actions/update.spec.ts` and `lib/managed-update.spec.ts` after the move.
3. Add a Docker all-instance observer that returns an array or service-to-array map, never a
   collapsing map. Parse array and JSON-Lines Compose output, retain exact container IDs/names and
   runtime state, and block zero-trust malformed or duplicate ambiguity.
4. Adapt `lib/drift.ts` so both ordinary drift and reconciliation still use one comparison
   implementation. Preserve `DriftResult` compatibility for detect/show/import while giving
   reconciliation enough process-local evidence to select create/start/recreate/blocked safely.
5. Add the exact one-service Compose mutation helper with complete argv tests before wiring
   auto-apply. Do not repurpose `startServices()`.
6. Implement the injected reconcile coordinator: report, allow-all policy seam, shared lock,
   whole-report revalidation, per-service revalidation, phase-ordered sequential actions,
   interruption, readiness plus final drift, aggregation, and cleanup.
7. Add the command/action boundary and prove negative properties: bare, dry-run, declined, machine
   without `--yes`, blocked policy, stale review, and ambiguous evidence never call lock, mutation,
   filesystem, DB, history, or generation dependencies.
8. Delegate legacy CLI and MCP paths to the action; delete fallback-success behavior for this MCP
   tool and assert that all public surfaces return the same `reconcile.v1` semantics.
9. Update barrels, exit mapping, error guidance, and all three completion templates with parity
   tests. Then add Docker-backed integration coverage when Docker is available.
10. Run focused suites after each seam, then the full rfapps typecheck/test/coverage/build gates.
    Include formatting, markdownlint, `git diff --check`, Graphify update, documentation, ROADMAP,
    and the YAML lock refresh in final validation.
