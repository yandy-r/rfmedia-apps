# rfapps Reconciliation Command: Technical Research

## Executive Summary

Issue #151 should add a top-level `rfapps reconcile` command as a thin, one-shot controller over the
existing drift detector and Docker Compose boundary. The first release is deliberately not a daemon,
scheduler, Git watcher, or second deployment engine. It observes resolved Compose desired state and
live Docker actual state, produces a versioned and deterministically ordered report, and stops. Only
the explicit `--auto-apply` gate authorizes remediation.

The implementation should preserve the current command/action/library split:

- `commands/reconcile.ts` declares options and validates mutation authorization.
- `actions/reconcile.ts` resolves configuration and service scope, owns confirmation/output/exit
  behavior, and supplies the future maintenance-window policy.
- `lib/reconcile.ts` converts `DriftResult` into canonical actions and coordinates locked,
  revalidated remediation without printing or setting `process.exitCode`.
- `lib/drift.ts` remains the sole desired-versus-actual detector.
- `lib/docker.ts` remains the only Docker mutation boundary.

All drift categories currently supported by `ServiceDrift` (`image`, `environment`, `ports`,
`volumes`, `networks`, and `runtime-status`) map to one Compose-authoritative action:
`force-recreate`. Direction does not change that decision: `container_ahead` and `diverged` are
reported as evidence, but `reconcile` never imports runtime state into Compose. Unchanged services
receive a `none` action. This keeps action selection explainable and avoids claiming fine-grained
runtime mutations that Compose cannot guarantee.

`--auto-apply` must acquire the same project/Docker-authority lifecycle lock used by managed update,
re-detect under the lock, reject a changed reviewed action set, run one targeted Compose `up` without
`--remove-orphans`, and then poll the drift detector until the selected services converge or the
configured health timeout expires. Default report mode never locks, prompts, writes files, opens the
SQLite state database, or mutates Docker.

Issue #169 is open and owns maintenance-window configuration and scheduling semantics. Issue #151
should provide a data-only automation-policy interface and include the decision in the result schema.
The v1 evaluator always allows an explicitly requested mutation. When #169 lands, it can block the
mutation through this seam without suppressing the report or changing reconciliation action
generation.

## Architecture Design

### Components and data flow

```text
  CLI argv / global flags
           |
           v
  commands/reconcile.ts
  - declare selectors and --auto-apply
  - reject unsafe machine mutation without --yes
           |
           v
  actions/reconcile.ts
  - loadConfig + applyCliOverrides
  - resolveServicesWithInteractive
  - resolve canonical Compose project / Docker authority
           |
           v
  lib/drift.ts::detectDrift ------------------------------+
  - resolved Compose desired state                        |
  - container inspect + runtime status actual state       |
           |                                              |
           v                                              |
  lib/reconcile.ts::buildReconcileReport                  |
  - canonicalize diffs                                    |
  - sort services/categories/collection values            |
  - map drift -> none | force-recreate                     |
           |                                              |
           +---------------- report-only -----------------> output
           |
           +-- --auto-apply
                   |
                   v
             automation policy gate <----- #169 scheduling.ts (future)
                   |
                   v
             explicit confirmation / --yes
                   |
                   v
             lifecycle-lock.ts
             project + Docker authority lock
                   |
                   v
             detectDrift again under lock
             compare canonical action fingerprint
                   |
             changed +----------> blocked result; retry required
                   |
             unchanged
                   v
             docker.ts::reconcileServices
             compose up -d --force-recreate TARGETS
             (no --remove-orphans)
                   |
                   v
             poll detectDrift until converged/timeout
                   |
                   v
             typed result + exit code; release lock in finally
```

### Layer responsibilities

`actions/reconcile.ts` is the interactive boundary. It may log human progress, prompt, call
`formatOutput`, and translate the typed result to an exit code. It must emit exactly one document in
machine formats and must not allow progress logs or streamed Compose output to corrupt that document.

`lib/reconcile.ts` is a data-only coordinator with injected drift, Docker, lock, policy, clock, and
sleep dependencies. It owns canonical ordering, action fingerprinting, under-lock revalidation,
post-apply observation, and aggregate status. It must not load configuration, prompt, print, persist
artifacts, or touch `process.exitCode`.

`lib/drift.ts` remains authoritative for field comparison and secret masking. Reconciliation must
not reproduce the image/environment/port/volume/network/runtime comparison logic. Canonicalization is
an output concern layered over its result so existing drift consumers remain backward compatible.

`lib/docker.ts` should gain a targeted helper rather than reuse `startServices()`. The existing
helper always adds `--remove-orphans`, which can mutate services outside the reviewed reconciliation
scope. The new helper should invoke Compose with the canonical project directory/name, selected
profiles, environment-tool execution context, `up -d --force-recreate`, and only the sorted target
services. It should not add `--remove-orphans`; it should preserve Compose pull-policy behavior.

### Revalidation and convergence

The report shown before approval is the reviewed unit. Its action fingerprint is a SHA-256 hash of a
canonical JSON projection containing the Compose hash/project identity, selected profiles, and each
sorted actionable service with direction, ordered categories, and normalized current/desired values.
Timestamps, display strings, durations, and masked secret placeholder values are excluded from the
fingerprint. After acquiring the lifecycle lock, the coordinator re-detects and recomputes that
fingerprint. A mismatch blocks all mutation; it does not silently expand, shrink, or alter the
reviewed scope.

After Compose returns, the coordinator polls `detectDrift()` for the actionable service set. A
service is converged only when `hasDrift` is false, including runtime status/health. This makes
post-apply verification use the same definition as planning. Timeout, Docker failure, or residual
drift remains explicit per-service evidence. No automatic rollback is promised: reconciliation
applies the already-declared Compose state, and issue #151 does not add a recoverable image/data
transaction.

## Data Models/contracts

Add `packages/rfapps-cli/src/types/reconcile.ts` and re-export it from `types/index.ts`.

```typescript
import type { DriftCategory, DriftDirection, ServiceDrift } from "./drift.js";

export const RECONCILE_SCHEMA_VERSION = "reconcile.v1" as const;

export type ReconcileMode = "report" | "auto-apply";
export type ReconcileActionKind = "none" | "force-recreate";
export type ReconcileActionStatus = "not-required" | "planned" | "blocked" | "applied" | "converged" | "failed";

export interface ReconcileAction {
  kind: ReconcileActionKind;
  status: ReconcileActionStatus;
  direction: DriftDirection;
  categories: DriftCategory[];
  reasonCode?: string;
  message?: string;
}

export interface ReconcileServiceResult {
  service: string;
  drift: ServiceDrift;
  action: ReconcileAction;
  finalDrift?: ServiceDrift;
}

export interface ReconcileAutomationDecision {
  status: "not-requested" | "allowed" | "blocked";
  reasonCode?: string;
  message?: string;
  nextEligibleAt?: string;
}

export interface ReconcileSummary {
  selected: number;
  unchanged: number;
  actionable: number;
  blocked: number;
  converged: number;
  failed: number;
}

export type ReconcileResultStatus =
  | "in-sync"
  | "drift-reported"
  | "planned"
  | "blocked"
  | "converged"
  | "partial"
  | "failed";

export interface ReconcileResult {
  schemaVersion: typeof RECONCILE_SCHEMA_VERSION;
  operation: "reconcile";
  observedAt: string;
  completedAt: string;
  mode: ReconcileMode;
  dryRun: boolean;
  composePath: string;
  composeProjectName: string;
  profiles: string[];
  actionFingerprint: string;
  automation: ReconcileAutomationDecision;
  status: ReconcileResultStatus;
  success: boolean;
  exitCode: 0 | 1 | 2 | 3;
  services: ReconcileServiceResult[];
  summary: ReconcileSummary;
}
```

The exact result may use discriminated subtypes for stronger compile-time invariants, but the wire
fields above are the required v1 contract. `operation: "reconcile"` preserves compatibility with the
existing loose drift-mutation/MCP result convention. `success` means the requested workflow
completed: reporting drift is successful, while requested automation is successful only if every
planned action converged. `finalDrift` is present only after an apply attempt.

Determinism requirements for every machine format are:

1. Services sort by Unicode code-point service name, independent of Compose declaration, selection,
   Docker inspection, or map iteration order.
2. Categories use the fixed order `image`, `environment`, `ports`, `volumes`, `networks`,
   `runtime-status`.
3. Environment entries sort by variable name; secret values remain the existing `********` mask.
4. Ports sort by `(container, protocol, host)`; volumes by `(target, source, readonly)`; networks
   lexicographically. Current and desired arrays use the same comparators.
5. Profiles are deduplicated and sorted. Action targets use the service order above.
6. Reason codes are stable uppercase identifiers; raw Docker stderr is sanitized and never embedded
   directly in the machine contract.
7. `observedAt`, `completedAt`, and duration-dependent evidence may vary by run; the action list,
   normalized diff, summary, and fingerprint are stable for the same observed states.

No database or migration is warranted. Existing drift detection derives its answer from resolved
Compose and Docker, and the issue asks for a current desired-versus-actual workflow rather than
historical reconciliation records. SQLite must remain optional and unopened in both report and
apply modes. Deployment history can be considered separately if a future requirement defines what a
reconciliation record means.

### Internal contracts

`lib/reconcile.ts` should expose narrow interfaces similar to managed update:

```typescript
export interface ReconcilePolicyContext {
  operation: "reconcile";
  requestedAt: Date;
  composePath: string;
  composeProjectName: string;
  services: readonly string[];
}

export interface ReconcileAutomationPolicy {
  evaluate(context: ReconcilePolicyContext):
    Promise<ReconcileAutomationDecision> | ReconcileAutomationDecision;
}

export interface RunReconcileOptions {
  mode: ReconcileMode;
  dryRun: boolean;
  composePath: string;
  composeProjectName: string;
  projectDir: string;
  dockerContextFingerprint: string;
  services: readonly string[];
  profiles: readonly string[];
  poll: { timeoutSeconds: number; intervalSeconds: number; retries: number };
}

export function buildReconcileReport(drift: DriftResult, context: ...): ReconcileResult;
export function runReconcile(
  initial: ReconcileResult,
  options: RunReconcileOptions,
  dependencies: ReconcileDependencies,
): Promise<ReconcileResult>;
```

The v1 production policy returns `{ status: "allowed" }` only when `--auto-apply` is requested;
otherwise the action result uses `not-requested`. #169 can implement `lib/scheduling.ts` and inject a
policy that returns `blocked`, `OUTSIDE_MAINTENANCE_WINDOW`, and `nextEligibleAt`. The policy is
evaluated after observation but before confirmation and lock acquisition. A blocked policy still
returns the full report and planned actions.

## CLI/API Design

### Command surface

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

Bare `rfapps reconcile` is report-only and returns a complete reconciliation result. Text output
hides unchanged service detail unless `--show-unchanged` or `--verbose` is supplied; machine formats
always include the complete selected scope so counts and ordering are reproducible.

`--auto-apply` is the only top-level mutation gate. In interactive text mode it presents the
canonical action count and target list for one confirmation unless global `--yes` is set. Consistent
with managed update, machine-format mutation requires both `--auto-apply` and `--yes`; otherwise it
is a usage error. `--dry-run --auto-apply` performs detection and policy evaluation but returns
planned actions without prompting, locking, or mutating.

Selectors use `resolveServicesWithInteractive` so group, profile, and sidecar behavior matches other
rfapps commands. An explicit empty selection cancels without mutation. A non-interactive invocation
with no selector evaluates all Compose services, matching current drift behavior.

`--health-timeout` controls post-apply convergence polling and defaults to
`finalConfig.healthCheck.timeout`; interval and retry defaults come from the same config. It does not
change default report behavior.

### Text output

Text mode should lead with the observer result, then the optional mutation result:

```text
Reconciliation report: 2 actionable, 45 in sync
  plex       force-recreate  image, runtime-status  compose_ahead
  sonarr     force-recreate  environment            diverged

Report only; no containers were changed.
Run with --auto-apply to apply the declared Compose state.
```

Applied output uses the same service order and marks `converged`, `failed`, or `blocked`. It must not
claim rollback or data recovery. In machine formats Compose subprocess output is captured rather
than streamed so stdout contains one valid document.

### Exit behavior

- `0`: report generated (`in-sync`, `drift-reported`, or dry-run `planned`), or every requested
  auto-apply action converged.
- `1`: Docker/detection/policy infrastructure failure, no requested action converged, or residual
  drift remains for every attempted service.
- `2`: invalid option combinations, unsafe/noncanonical inputs, or machine mutation without
  `--yes`.
- `3`: auto-apply partially converged and at least one requested service remains failed/blocked.

Drift itself is not an operational error for this report-first command. Automation should inspect
`status`, `summary.actionable`, and the per-service actions rather than infer drift from process code.

### Compatibility API

`rfapps drift reconcile` already exists and mutates immediately. Removing it would be a breaking
change, while leaving a second mutation implementation would bypass the lifecycle lock and future
maintenance-window policy. Keep the syntax as a documented compatibility command, but make
`executeDriftReconcile()` delegate to the new action with `autoApply: true`. Preserve its current
interactive confirmation and global `--yes` behavior. Its result should be the same `reconcile.v1`
document.

The existing `rfapps.drift.reconcile` MCP tool can continue using that compatibility adapter and the
`operation: "reconcile"` result. Issue #151 should tighten its output schema to `ReconcileResult`
rather than add a second `rfapps.reconcile` MCP mutation tool. This keeps v1 scoped and ensures MCP
mutation also passes through the same future maintenance gate. A new MCP name can be considered as a
separately versioned compatibility decision.

### Errors and reason codes

Use `InvalidArgumentError` for option and authorization errors and existing formatted Docker errors
at the action boundary. Coordinator results should use stable codes including:

- `RECONCILE_DETECTION_FAILED`
- `RECONCILE_REVIEW_STALE`
- `RECONCILE_LOCKED`
- `RECONCILE_APPLY_FAILED`
- `RECONCILE_TIMEOUT`
- `RECONCILE_RESIDUAL_DRIFT`
- `OUTSIDE_MAINTENANCE_WINDOW` (reserved for #169)

The report must not expose resolved secrets, environment-tool output, Docker credentials, lock owner
tokens, or raw subprocess stderr. Existing drift masking remains mandatory; new error messages use
the existing error formatter/redaction conventions.

## System Constraints

- Runtime is Node.js 22+ TypeScript ESM with NodeNext resolution; new relative imports use `.js`.
- Commander v14 owns option parsing. Global `--json`/`--output` reconciliation remains in the
  existing `cli.ts` pre-action hook.
- Docker Compose is the mutation authority. Reconciliation must not directly recreate containers
  with `docker run`, edit Compose YAML, import runtime state, pull registry updates proactively, or
  remove orphans.
- Desired state is the fully resolved Compose model produced through the selected environment tool,
  profile set, project directory, and project name. Raw YAML is not an equivalent authority.
- The current `detectDrift()` return of `undefined` is an operational failure, never an empty/in-sync
  result.
- Only selected, drifted services may be passed to the mutation helper. Sidecar expansion remains
  governed by existing service resolution and `--no-sidecars`.
- Mutation must share the managed-update lifecycle lock namespace so update and reconcile cannot
  race on the same canonical project and Docker authority.
- The lock covers under-lock re-observation, Compose mutation, convergence polling, and terminal
  result construction; release occurs in `finally` and cleanup failure is surfaced.
- V1 is one-shot. Cron/systemd timers may invoke it externally, but the CLI does not sleep until a
  window, create a daemon, watch Git, or loop indefinitely.
- V1 applies all reviewed targets in one Compose invocation so Compose retains dependency ordering.
  It does not implement custom parallel scheduling or per-service rollback.
- The action count is bounded by the resolved Compose service set. Canonicalization must avoid
  unbounded raw subprocess data and must preserve existing secret masking.
- Report mode performs no SQLite writes or filesystem artifact writes. `--auto-apply` also adds no
  database schema or report persistence in v1.
- All three completion generators (Bash, Zsh, Fish) must include the top-level command, selectors,
  `--auto-apply`, `--show-unchanged`, `--health-timeout`, and file/profile/group/service value
  completion.
- Existing behavior and schemas for `drift detect`, `drift show`, and `drift import` remain
  unchanged.

## Codebase Changes with exact paths

### New files

- `packages/rfapps-cli/src/commands/reconcile.ts`: Commander registration, option interface, and
  machine-mutation validation.
- `packages/rfapps-cli/src/actions/reconcile.ts`: configuration/scope resolution, canonical project
  identity, policy injection, confirmation, human rendering, structured output, and exit mapping.
- `packages/rfapps-cli/src/lib/reconcile.ts`: canonicalization, action mapping/fingerprinting,
  lifecycle lock coordination, revalidation, apply, convergence polling, and aggregation.
- `packages/rfapps-cli/src/types/reconcile.ts`: `reconcile.v1` public contracts and constants.
- `packages/rfapps-cli/src/commands/reconcile.spec.ts`: Commander defaults, options, help, and unsafe
  machine-mutation cases.
- `packages/rfapps-cli/src/actions/reconcile.spec.ts`: config/selection, report-only guarantees,
  confirmation, policy block, output purity, and exit behavior.
- `packages/rfapps-cli/src/lib/reconcile.spec.ts`: deterministic canonicalization/fingerprint,
  action mapping, stale review, lock cleanup, Docker failure, convergence, timeout, and partial
  results using injected dependencies.
- `packages/rfapps-cli/src/reconcile.integration.spec.ts`: resolved Compose plus mocked/fixture Docker
  observation through report and auto-apply boundaries; assert no mutation in default/dry-run paths.
- `docs/features/rfapps-reconcile-command.md`: report/apply behavior, safety boundary, JSON example,
  scheduling guidance, and compatibility command.

### Modified source and tests

- `packages/rfapps-cli/src/cli.ts`: import and call `registerReconcileCommand(program)` near
  `registerDriftCommand`.
- `packages/rfapps-cli/src/types/index.ts`: export reconcile types and
  `RECONCILE_SCHEMA_VERSION`.
- `packages/rfapps-cli/src/lib/index.ts`: export the reconciliation library and any shared identity
  helper.
- `packages/rfapps-cli/src/lib/docker.ts`: add `reconcileServices()` (targeted Compose up,
  force-recreate, no orphan removal) with unit coverage in `docker.spec.ts`.
- `packages/rfapps-cli/src/lib/drift.ts`: expose or consume canonical comparator helpers only where
  needed; do not change the existing `DriftResult` wire schema.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`: no semantic change expected; reuse its existing
  acquisition contract and errors.
- `packages/rfapps-cli/src/actions/update.ts`: move/reuse canonical Compose project and Docker
  authority resolution through a shared library helper so reconcile acquires the identical lock
  namespace; preserve exports temporarily if tests/consumers require them.
- `packages/rfapps-cli/src/actions/update.spec.ts`: update shared identity-helper imports without
  changing managed-update behavior.
- `packages/rfapps-cli/src/actions/drift.ts`: make `executeDriftReconcile()` a compatibility wrapper
  over `executeReconcile({ autoApply: true }, ...)`; leave detect/show/import paths intact.
- `packages/rfapps-cli/src/actions/drift.spec.ts`: retain legacy syntax tests and assert delegation,
  locking, and the `reconcile.v1` result.
- `packages/rfapps-cli/src/actions/completion.ts`: add `reconcile` and its options in Bash, Zsh, and
  Fish templates.
- `packages/rfapps-cli/src/actions/completion.spec.ts`: assert command/options and dynamic values in
  all three shell scripts.
- `packages/rfapps-cli/src/mcp/schema.ts`: replace the loose drift reconciliation mutation output
  with the typed `ReconcileResult` schema while retaining the existing tool name.
- `packages/rfapps-cli/src/mcp/schema.spec.ts`,
  `packages/rfapps-cli/src/mcp/adapters.spec.ts`,
  `packages/rfapps-cli/src/mcp/tools.spec.ts`, and
  `packages/rfapps-cli/src/mcp/server.spec.ts`: update the compatibility output and confirm no new
  MCP tool is registered.

### Modified documentation

- `packages/rfapps-cli/README.md`: command reference, examples, output contract, exit codes, and
  migration guidance from `drift reconcile`.
- `docs/features/rfapps-drift-command.md`: identify `drift reconcile` as the compatibility syntax
  and point to the top-level report-first workflow.
- `docs/features/plan-apply-workflow.md`: position reconcile as current-state convergence rather
  than a saved deployment-plan replacement.
- `docs/features/quick-reference.md`: add report and explicit auto-apply examples.
- `docs/features/shell-completion.md`: include the new command/options if the command inventory is
  enumerated.
- `docs/features/rfapps-mcp-server.md`: document the typed result returned by the existing drift
  reconcile compatibility tool.
- `docs/architecture/overview.md` and `packages/rfapps-cli/CLAUDE.md`: document the
  command/action/library split and shared lifecycle-lock boundary.
- `docs/README.md`: link the new feature guide.
- `ROADMAP.md`: mark #151 complete only after the implementation and tests land, update Assessment
  and Next Up, and leave #169 open as the maintenance-window follow-up.
- `graphify-out/*`: regenerate with `graphify update .` after code changes if the graph exists in the
  implementation checkout; do not hand-edit generated graph artifacts.

### Validation commands

```bash
npm run test:run --workspace packages/rfapps-cli -- \
  src/lib/reconcile.spec.ts \
  src/actions/reconcile.spec.ts \
  src/commands/reconcile.spec.ts \
  src/actions/completion.spec.ts \
  src/actions/drift.spec.ts \
  src/reconcile.integration.spec.ts
npm run typecheck --workspace packages/rfapps-cli
npm run build --workspace packages/rfapps-cli
npm run test:run --workspace packages/rfapps-cli
npm run lint
npm run format:check
git diff --check
```

Also exercise generated Bash, Zsh, and Fish scripts, verify default and `--dry-run --auto-apply`
paths make zero Docker mutation calls, verify machine auto-apply rejects omission of `--yes`, and run
the repository's Docker-backed integration test when Docker is available.

## Technical Decisions/options/recommendation/rationale

### One-shot command versus resident controller

- **Option A:** background daemon with periodic reconciliation.
- **Option B:** one-shot command suitable for explicit invocation and external schedulers.
- **Recommendation:** Option B.
- **Rationale:** issue #151 asks for a command and report-first safety, while #169 separately owns
  maintenance windows. A daemon adds lifecycle, concurrency, shutdown, logging, persistence, and
  scheduling contracts that are not present in the repository and contradict v1 scope.

### Reuse drift versus build a new comparison engine

- **Option A:** generate reconciliation diffs independently from `DeploymentPlan` or raw Docker
  inspection.
- **Option B:** consume `detectDrift()` and canonicalize its typed result.
- **Recommendation:** Option B.
- **Rationale:** drift already compares the required fields, masks secrets, handles runtime status,
  and has unit/MCP coverage. A second detector would inevitably disagree with `rfapps drift`.

### Reuse generic plan/apply versus a reconciliation coordinator

- **Option A:** create and apply an ordinary saved `DeploymentPlan`.
- **Option B:** keep a typed in-memory reconciliation report and call a narrow Docker helper.
- **Recommendation:** Option B.
- **Rationale:** ordinary apply is a persisted review workflow with compose-hash validation and its
  own change semantics; reconcile is a current-state observation that must revalidate under a lock.
  Persisting another plan format is not required, while calling the CLI action `executeApply()`
  would mix prompts/output/exit state and cannot enforce the future policy seam cleanly.

### Mutation granularity

- **Option A:** infer specialized restart/start/recreate commands per drift category.
- **Option B:** map any drift to targeted Compose `up -d --force-recreate`.
- **Recommendation:** Option B for v1.
- **Rationale:** force recreate is the existing reconcile behavior and the only uniform operation
  that reapplies image, environment, port, volume, network, and runtime declarations. Specialized
  actions would be an unproven orchestration engine and could leave mixed drift unresolved.

### Batch versus sequential mutation

- **Option A:** sequential alphabetical service operations.
- **Option B:** one sorted target list in a Compose invocation.
- **Recommendation:** Option B.
- **Rationale:** Compose retains dependency ordering and project semantics. Determinism belongs in
  the reviewed action list and result, not in replacing Compose scheduling. Post-observation maps
  convergence per service and can report partial success.

### Lifecycle locking and reviewed-state changes

- **Option A:** apply the first observation directly.
- **Option B:** lock, re-observe, and apply the changed set automatically.
- **Option C:** lock, re-observe, and fail closed if the canonical action fingerprint changed.
- **Recommendation:** Option C.
- **Rationale:** A and B can apply state the operator did not review. C matches managed update's
  fail-closed identity posture and shares its lock namespace, preventing concurrent update and
  reconcile mutations.

### Orphan and image behavior

- **Option A:** reuse `startServices()` with `--remove-orphans`.
- **Option B:** add a target-only helper without orphan removal and preserve Compose pull policy.
- **Recommendation:** Option B.
- **Rationale:** orphan removal exceeds the reviewed target scope. Forcing `--pull always` would
  turn reconciliation into update management; forcing `--pull never` could prevent a declared but
  locally absent image from converging. Compose's declared pull policy is the correct v1 authority.

### Persistent database state

- **Option A:** add reconciliation run/action tables or deployment rows.
- **Option B:** return the versioned result without database persistence.
- **Recommendation:** Option B.
- **Rationale:** no acceptance criterion requires history, and current drift is fully re-derived
  from Compose and Docker. A new schema would make a recoverable observation depend on state without
  defining rollback or audit retention semantics.

### Maintenance-window integration

- **Option A:** add `maintenanceWindows` config and time-zone logic in #151.
- **Option B:** omit all scheduling concerns until #169.
- **Option C:** add an injected automation-policy decision now, with an allow-all v1 implementation.
- **Recommendation:** Option C.
- **Rationale:** A duplicates open issue #169 and expands scope; B risks embedding mutation logic
  that #169 cannot gate consistently. C makes the future constraint explicit without inventing its
  configuration or calendar semantics. Reporting always runs; only mutation is gateable.

### Legacy `drift reconcile` and MCP

- **Option A:** remove the legacy command/tool.
- **Option B:** leave its independent mutation path unchanged.
- **Option C:** preserve syntax/tool name as wrappers over the new coordinator.
- **Recommendation:** Option C.
- **Rationale:** A is breaking, while B creates a safety and maintenance-window bypass. C produces
  one reconciliation definition and avoids adding another MCP tool in v1.

## Open Questions

1. Should text-mode report output return `0` on detected drift as recommended, or should the project
   add an opt-in Terraform-style detailed exit code? The machine contract already carries
   `summary.actionable`, so a nonzero default would make ordinary report mode look like failure.
2. Should `--show-unchanged` be retained as a top-level option, or should `--verbose` be the only text
   control? Machine output must include unchanged services either way.
3. Does product intent require a persisted reconciliation artifact (`--out`/`--from-plan`) in a
   later release? V1 can safely review and revalidate an in-memory fingerprint, but persistence
   would require a separate stale-plan and file-hardening contract.
4. When #169 defines overlapping maintenance windows, time zones, and daylight-saving behavior,
   should a blocked `--auto-apply` return exit `0` with `status: "blocked"` for scheduler retry, or
   operational exit `1`? The v1 result reserves the evidence fields but should not decide scheduler
   semantics prematurely.
5. Should post-apply convergence wait for a stable-running interval when no Docker healthcheck is
   configured, as managed update does, or is one drift-free observation sufficient? A short stable
   interval is safer but increases reconcile latency across large scopes.
6. Should the existing `rfapps.drift.reconcile` MCP input require an explicit `yes: true` after it
   delegates to the new coordinator? This is safer and consistent with machine CLI mutation, but it
   may be a breaking tightening for existing MCP clients and should be called out in release notes.
