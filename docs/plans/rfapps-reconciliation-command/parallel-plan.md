# rfapps Reconciliation Command Implementation Plan

Implement issue #151 as a report-first controller that produces one deterministic
reconcile.v1 result from resolved Docker Compose intent and complete Docker runtime evidence.
Mutation remains unreachable unless --auto-apply is explicitly present, and then uses the existing
lifecycle lock, full stale-evidence revalidation, exact one-service Compose actions, and fresh
convergence observation. The top-level CLI, legacy drift spelling, and existing MCP tool will
delegate to one action/coordinator, while documentation, completions, ROADMAP, and tests ship as
part of the same integrated change.

## Critically Relevant Files and Documentation

- docs/plans/rfapps-reconciliation-command/feature-spec.md: Source-of-truth requirements, safety
  boundaries, result contract, and acceptance criteria.
- docs/plans/rfapps-reconciliation-command/shared.md: Verified code, pattern, and documentation map.
- packages/rfapps-cli/src/actions/update.ts: Canonical project/Docker identity and action-boundary
  pattern to extract without changing managed-update behavior.
- packages/rfapps-cli/src/lib/managed-update.ts: Closest lock/revalidation/sequential-action/cleanup
  coordinator pattern.
- packages/rfapps-cli/src/lib/drift.ts: Sole desired-versus-actual comparison and masking authority.
- packages/rfapps-cli/src/lib/docker.ts: Bounded Docker/Compose subprocess boundary.
- packages/rfapps-cli/src/lib/lifecycle-lock.ts: Shared project/Docker exclusion contract.
- packages/rfapps-cli/src/lib/dependency-graph.ts: Deterministic dependency ordering primitives.
- packages/rfapps-cli/src/lib/health.ts: Bounded readiness observation.
- packages/rfapps-cli/src/actions/completion.ts: Manually maintained Bash, Zsh, and Fish templates.
- packages/rfapps-cli/src/mcp/adapters.ts: Structured action capture and compatibility adapter.
- packages/rfapps-cli/CLAUDE.md: Package conventions and validation commands.
- docs/features/rfapps-drift-command.md: Existing drift and legacy reconcile behavior.
- docs/features/plan-apply-workflow.md: Review-before-mutation precedent and persistence boundary.
- docs/features/json-output.md: Clean stdout and machine-output contract.
- docs/features/rfapps-mcp-server.md: Existing MCP tool naming and schema conventions.
- ROADMAP.md: Issue #151 and #169 delivery context.

## Implementation Plan

### Phase 1: Deterministic Contract and Complete Evidence

#### Task 1.1: Define reconcile.v1 and the pure planner Depends on [none]

**READ THESE BEFORE TASK**

- docs/plans/rfapps-reconciliation-command/feature-spec.md
- packages/rfapps-cli/src/types/update.ts
- packages/rfapps-cli/src/lib/managed-update.ts

**Instructions**

Files to Create

- packages/rfapps-cli/src/types/reconcile.ts
- packages/rfapps-cli/src/lib/reconcile.ts
- packages/rfapps-cli/src/lib/reconcile.spec.ts

Files to Modify

- None.

Define the versioned result, service comparison, action, policy, outcome, status, summary, reason,
and exit contracts. Implement pure canonicalization, complete one-entry-per-service accounting,
none/create/start/recreate/blocked selection, value-free drift projection, allow-all v1 policy,
semantic summary/status derivation, and SHA-256 action fingerprints. Sort all set-like fields
explicitly; exclude timestamps, messages, durations, raw observations, authority components, and
secret values. Tests must prove input-order invariance, ambiguity blocking, stable reason ordering,
complete scope accounting, and absence of secret data or process side effects.

#### Task 1.2: Extract shared canonical authority identity Depends on [none]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/actions/update.ts
- packages/rfapps-cli/src/lib/managed-update.ts
- packages/rfapps-cli/src/lib/plan-generator.ts

**Instructions**

Files to Create

- packages/rfapps-cli/src/lib/identity.ts
- packages/rfapps-cli/src/lib/identity.spec.ts

Files to Modify

- packages/rfapps-cli/src/actions/update.ts

Move canonical Compose/project resolution and Docker-authority fingerprinting into a neutral
library and expose the existing environment-source and resolved-service fingerprint concepts
through one secret-safe authority boundary. Preserve compatibility exports when useful and make
managed update consume the same implementation without changing its lock identity or behavior.
Retain path/symlink/NUL/project-name hardening and never expose Docker endpoints, environment source
paths, or resolved configuration values. Keep environmentSourceFingerprint in managed-update and
resolvedServiceConfigFingerprint in plan-generator unless moving them is required; import and reuse
them instead of forking their algorithms. Run identity, action/update, plan-generator, and
managed-update focused tests after the extraction.

#### Task 1.3: Add multiplicity-preserving all-container observation Depends on [none]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/lib/docker.ts
- packages/rfapps-cli/src/lib/service-status.ts
- packages/rfapps-cli/src/lib/docker.spec.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/lib/docker.ts
- packages/rfapps-cli/src/lib/docker.spec.ts

Add a bounded compose ps --all --format json API that accepts array and JSON-Lines variants and
retains every exact container ID, name, service, state, and health entry. Validate schema, item and
byte bounds, duplicate identities, operands, canonical project/profile arguments, and the selected
environment wrapper. Preserve the existing running-only map for current callers, and never collapse
instances before reconciliation classifies multiplicity. Cover missing, stopped, scaled,
malformed, oversized, and reordered observations.

#### Task 1.4: Feed complete observations through the existing drift comparator Depends on [1.3]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/lib/drift.ts
- packages/rfapps-cli/src/types/drift.ts
- packages/rfapps-cli/src/lib/drift.spec.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/lib/drift.ts
- packages/rfapps-cli/src/lib/drift.spec.ts
- packages/rfapps-cli/src/types/drift.ts

Extend the observation boundary without forking field-level image/environment/port/volume/network/
runtime comparison. Preserve DriftResult and detect/show/import compatibility while supplying
an internal ReconcileServiceObservation adapter, not a DriftResult field, that distinguishes
missing, one stopped, and multiple ambiguous instances for the planner. Keep legacy callers on the
existing detectDrift return shape.
Never silently omit a selected service on Compose or inspect failure. Keep raw comparison evidence
internal and project public reconciliation environment differences to variable name and change
kind only. Add regression coverage for legacy behavior plus missing/stopped/scaled/failed
observations.

#### Task 1.5: Refresh the locked YAML dependency Depends on [none]

**READ THESE BEFORE TASK**

- package.json
- package-lock.json

**Instructions**

Files to Create

- None.

Files to Modify

- package-lock.json

Resolve the existing yaml package to a patched release at or above 2.8.3 without introducing a new
runtime dependency or unrelated lockfile churn. Change package.json only if the existing range
cannot express the patched version. Verify a reproducible install, inspect the lockfile diff, and
rerun configuration parsing tests.

#### Task 1.6: Create and map the GitHub child issue hierarchy Depends on [none]

**READ THESE BEFORE TASK**

- .github/ISSUE_TEMPLATE/enhancement.yml
- docs/plans/rfapps-reconciliation-command/parallel-plan.md
- ROADMAP.md

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Create one GitHub child issue under #151 for each plan phase, following the repository enhancement
issue form exactly. Embed the phase task checklist, paths, dependencies, acceptance criteria, and
source-plan link; record the child numbers for ROADMAP and PR close linkage. Add each child through
GitHub's sub-issue relationship rather than using plain body links alone. Do not close children
until their acceptance criteria and the integrated validation gate pass.

### Phase 2: Safe Targeted Mutation and Coordination

#### Task 2.1: Add exact one-service Compose reconciliation actions Depends on [1.3]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/lib/docker.ts
- packages/rfapps-cli/src/lib/docker.spec.ts
- packages/rfapps-cli/src/lib/managed-update.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/lib/docker.ts
- packages/rfapps-cli/src/lib/docker.spec.ts

Add a dedicated validated primitive for one reviewed service. Create/start use up -d --pull never
--no-deps SERVICE; recreate adds --force-recreate only for that action. Bind canonical Compose
path, effective project, sorted profiles, working directory, environment wrapper, timeout, and
bounded capture. Exact-argv tests must reject hostile operands and prove the absence of
--remove-orphans, pull, build, volume renewal, implicit dependencies, and extra targets. Do not
reuse or weaken startServices().

#### Task 2.2: Implement the locked fail-closed reconciliation lifecycle Depends on [1.1, 1.2, 1.4, 2.1]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/lib/reconcile.ts
- packages/rfapps-cli/src/lib/managed-update.ts
- packages/rfapps-cli/src/lib/lifecycle-lock.ts
- packages/rfapps-cli/src/lib/dependency-graph.ts
- packages/rfapps-cli/src/lib/health.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/lib/reconcile.ts
- packages/rfapps-cli/src/lib/reconcile.spec.ts

Extend the injected coordinator so report and dry-run terminate after planning with no prompt,
lock, mutation, persistence, or process state. Auto-apply with actionable work acquires the shared
lock, recomputes project/environment/Docker/scope/config/container/drift/policy/action evidence,
and blocks on any stale mismatch. Recheck each service and policy immediately before sequential
dependency-phase action; record became_in_sync when appropriate. Require bounded readiness plus
fresh zero-drift observation for convergence, stop unsafe later work after uncertain failures or
signals, preserve a terminal result for every original service, and release the lock in finally
without masking the primary failure.

Implement and table-test every terminal transition explicitly: reported, no_action, became_in_sync,
converged, blocked_policy, blocked_stale, observation_failed, action_failed, not_converged,
cancelled_before_action, cancelled_during_action, and skipped_after_unsafe_failure. Define which
outcomes stop later scheduling and how each contributes to success, partial, failed, and cancelled
aggregate status before wiring the executor.

#### Task 2.3: Publish narrow library/type exports and exit resolution Depends on [2.2]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/lib/index.ts
- packages/rfapps-cli/src/types/index.ts
- packages/rfapps-cli/src/lib/exit-codes.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/lib/index.ts
- packages/rfapps-cli/src/types/index.ts
- packages/rfapps-cli/src/lib/exit-codes.ts

Export the schema/types, coordinator entry point, complete observation/action primitive, and shared
identity helpers required by action and tests without exposing raw secret-bearing internals. Add a
pure reconcile exit resolver using existing 0/1/2/3 vocabulary. Verify ESM .js imports, exhaustive
status handling, public typecheck, and absence of action/Commander/formatter dependencies in
libraries.

### Phase 3: Public and Compatibility Surfaces

#### Task 3.1: Add the action boundary and operator behavior Depends on [2.3]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/actions/update.ts
- packages/rfapps-cli/src/lib/interactive-selection.ts
- packages/rfapps-cli/src/lib/formatters/index.ts
- docs/features/error-handling.md

**Instructions**

Files to Create

- packages/rfapps-cli/src/actions/reconcile.ts
- packages/rfapps-cli/src/actions/reconcile.spec.ts

Files to Modify

- packages/rfapps-cli/src/lib/error-formatters.ts

Normalize inputs, load/override configuration, resolve one environment wrapper and canonical
project, materialize and sort the full service/profile scope without prompting in report mode, and
assemble production coordinator dependencies. Render the reviewed report, confirm exact targets
only for human auto-apply, require --yes for machine auto-apply, make dry-run veto mutation, emit
one complete JSON/YAML result (and only a documented service-summary projection for flat formats),
with that flat projection implemented inside actions/reconcile.ts while formatOutput remains
generic, and set exit state after output. Use existing errors where possible; add only bounded actionable
guidance. Prove negative side effects, redaction, selection semantics, timeout override,
confirmation, cancellation, JSON/YAML parity, output purity, and exits.

#### Task 3.2: Register the top-level reconcile command Depends on [3.1]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/commands/update.ts
- packages/rfapps-cli/src/cli.ts
- docs/plans/rfapps-reconciliation-command/feature-spec.md

**Instructions**

Files to Create

- packages/rfapps-cli/src/commands/reconcile.ts
- packages/rfapps-cli/src/commands/reconcile.spec.ts

Files to Modify

- packages/rfapps-cli/src/cli.ts

Register rfapps reconcile with service/services/group/no-sidecars, --auto-apply, --show-unchanged,
--health-timeout, compose/env/profile options, global-option help, exit guidance, argv validation,
and a lazy action import. Inherit global dry-run, output, json, yes, debug, and secrets-provider
options without treating them as mutation authority. Test help, defaults, validation, forwarding,
lazy loading, and root registration.

#### Task 3.3: Delegate the legacy drift reconcile route Depends on [3.1]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/commands/drift.ts
- packages/rfapps-cli/src/actions/drift.ts
- packages/rfapps-cli/src/actions/drift.spec.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/commands/drift.ts
- packages/rfapps-cli/src/actions/drift.ts
- packages/rfapps-cli/src/actions/drift.spec.ts

Translate the legacy spelling into the shared action with explicit auto-apply intent while
preserving detect, show, and import. Remove the independent force-recreate/startServices path and
make legacy machine mutation require explicit --yes, with dry-run still authoritative. Assert
exact option mapping, reconcile.v1 output/exit behavior, and that legacy reconciliation cannot call
startServices().

#### Task 3.4: Define the exact MCP reconciliation schema Depends on [2.3]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/mcp/schema.ts
- packages/rfapps-cli/src/mcp/schema.spec.ts
- docs/features/rfapps-mcp-server.md

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/mcp/schema.ts
- packages/rfapps-cli/src/mcp/schema.spec.ts

Keep the public rfapps.drift.reconcile name, define explicit auto-apply/yes machine authorization,
and replace the loose mutation result with an exact schema structurally anchored to
ReconcileResult. Cover every discriminated result branch, reject unknown/invalid fields, and keep
detect/show/import schemas unchanged.

#### Task 3.5: Route the MCP tool through the shared action Depends on [3.1, 3.4]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/mcp/adapters.ts
- packages/rfapps-cli/src/mcp/tools-mutate.ts
- packages/rfapps-cli/src/mcp/adapters.spec.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/mcp/adapters.ts
- packages/rfapps-cli/src/mcp/adapters.spec.ts
- packages/rfapps-cli/src/mcp/tools-mutate.ts

Invoke executeReconcile under structured-output capture, require explicit authorization, preserve
the complete result, restore process exit state, and remove generic fallback success for this tool.
Do not add a second reconcile MCP tool or let transport/tool classification count as consent.
Assert delegation, dry-run, redaction, capture failure, and structuredContent equality.

#### Task 3.6: Verify MCP registry and server integration Depends on [3.5]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/mcp/tools.spec.ts
- packages/rfapps-cli/src/mcp/server.spec.ts
- packages/rfapps-cli/src/mcp/tools.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/mcp/tools.spec.ts
- packages/rfapps-cli/src/mcp/server.spec.ts

Update registry and JSON-RPC expectations for the retained tool name, exact input/result schemas,
mutation classification, explicit yes requirement, and full structured result propagation.
Confirm there is one public reconcile mutation tool and no fallback result.

#### Task 3.7: Update Bash, Zsh, and Fish completion parity Depends on [3.2]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/actions/completion.ts
- packages/rfapps-cli/src/actions/completion.spec.ts
- docs/features/shell-completion.md

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfapps-cli/src/actions/completion.ts
- packages/rfapps-cli/src/actions/completion.spec.ts

Add the top-level command and every option to all three templates, including dynamic service,
comma-list service, group, profile, Compose/env path, boolean, and suggested timeout completion.
Keep legacy nested completion present. Parameterize parity assertions and compare the generated
surface with Commander help so partial-template changes fail.

### Phase 4: End-to-End Proof and Release Documentation

#### Task 4.1: Add assembled and Docker-backed reconciliation tests Depends on [3.3, 3.6, 3.7]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/src/managed-update.integration.spec.ts
- packages/rfapps-cli/src/managed-update.compose.integration.spec.ts

**Instructions**

Files to Create

- packages/rfapps-cli/src/reconcile.integration.spec.ts
- packages/rfapps-cli/src/reconcile.compose.integration.spec.ts

Files to Modify

- None.

Exercise root command/action/coordinator, legacy delegation, MCP capture, report/dry-run/no-op,
stale review, lock exclusion, sequential multi-service convergence, partial failure, residual
drift, complete result ordering, output purity, and zero database/history/generation writes. Use
small fixture projects and injected failures; guard Docker-backed exact-target cases using the
existing availability convention rather than the production stack or live secrets.

#### Task 4.2: Publish primary operator reconciliation documentation Depends on [3.2, 3.3]

**READ THESE BEFORE TASK**

- packages/rfapps-cli/README.md
- docs/features/rfapps-drift-command.md
- docs/features/plan-apply-workflow.md

**Instructions**

Files to Create

- docs/features/rfapps-reconcile-command.md

Files to Modify

- packages/rfapps-cli/README.md
- docs/features/rfapps-drift-command.md

Document report-first defaults, selection/options, explicit auto-apply authorization, safe action
boundaries, reconcile.v1, deterministic ordering, exits, examples, legacy delegation, and runtime
import separation. State that there is no persisted reconcile plan, history/generation write,
rollback, registry pull, daemon, or maintenance schedule.

#### Task 4.3: Update automation and completion documentation Depends on [3.6, 3.7]

**READ THESE BEFORE TASK**

- docs/features/json-output.md
- docs/features/rfapps-mcp-server.md
- docs/features/shell-completion.md

**Instructions**

Files to Create

- None.

Files to Modify

- docs/features/json-output.md
- docs/features/rfapps-mcp-server.md
- docs/features/shell-completion.md

Document the exact machine schema/authorization, one-document stdout, MCP compatibility result,
and command parity in Bash, Zsh, and Fish. Validate examples against actual Commander help and MCP
tools/list output.

#### Task 4.4: Document architecture and workflow boundaries Depends on [2.2, 3.1]

**READ THESE BEFORE TASK**

- docs/architecture/data-flow.md
- docs/features/plan-apply-workflow.md
- docs/features/quick-reference.md

**Instructions**

Files to Create

- None.

Files to Modify

- docs/architecture/data-flow.md
- docs/features/plan-apply-workflow.md
- docs/features/quick-reference.md

Explain observe/plan and optional lock/revalidate/act/verify flow, contrast same-process
reconciliation with saved deployment plan/apply and managed image update, and add concise operator
examples. Keep issue #169 as the future policy provider rather than documenting unimplemented
windows.

#### Task 4.5: Update indexes and ROADMAP Depends on [4.2, 4.3, 4.4]

**READ THESE BEFORE TASK**

- docs/README.md
- README.md
- ROADMAP.md

**Instructions**

Files to Create

- None.

Files to Modify

- docs/README.md
- README.md
- ROADMAP.md

Link the feature guide and command reference where the indexes enumerate rfapps functionality.
Record #151 and its child issue numbers as implemented pending merge, retain #169 as the
maintenance-policy follow-up, and avoid claiming closure before GitHub merge. Reconcile all roadmap
claims with live GitHub state immediately before the final commit.

#### Task 4.6: Refresh Graphify and run the complete release gate Depends on [1.5, 4.1, 4.5]

**READ THESE BEFORE TASK**

- CLAUDE.md
- packages/rfapps-cli/CLAUDE.md
- graphify-out/wiki/index.md (if present)

**Instructions**

Files to Create

- None.

Files to Modify

- None (graphify-out/ is local generated validation output and remains untracked).

If graphify-out exists, inspect its wiki index first; otherwise let graphify update . create the
local graph. Run the update once after all source and documentation changes, inspect it for errors,
and do not force ignored generated output into the commit. Run at minimum:

- npm run test:run --workspace packages/rfapps-cli
- npm run test:coverage:rfapps
- npm run typecheck --workspace packages/rfapps-cli
- npm run build:rfapps
- npm run lint
- npm run format:check
- npm audit
- npx markdownlint-cli2 with the changed Markdown paths
- git diff --check
- graphify update .

Also run focused reconciliation/drift/update/MCP/completion and Docker-backed tests when available.
Fix every in-scope failure before PR creation and record exact commands/outcomes for the PR
template.

#### Task 4.7: Close the PR and issue hierarchy lifecycle Depends on [1.6, 4.6]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- docs/plans/rfapps-reconciliation-command/parallel-plan.md
- ROADMAP.md

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Create the PR with the repository template, exact validation evidence, Closes #151, and close
linkage for every child issue. After review fixes and green CI, verify ROADMAP wording against the
final PR/issue state, squash merge, confirm GitHub closed the complete issue hierarchy, and clean
the feature branch and worktree without altering the divergent main checkout.

## Advice

- The existing running/status maps collapse scaled containers; safe actions must consume the new
  multiplicity-preserving observer and block ambiguity.
- startServices() always adds --remove-orphans and is never an acceptable reconciliation mutation
  path, even if a caller passes one service.
- Treat reconcile.v1 and action fingerprints as semantic contracts: normalize in the model, not
  merely in renderers, and exclude volatile or secret-bearing evidence.
- Reuse one canonical project/environment/Docker identity and the lifecycle lock namespace so
  managed update and reconciliation exclude each other without duplicating security logic.
- Compose success is not convergence. A service is converged only after bounded readiness and a
  fresh drift-free observation; preserve residual drift and complete terminal accounting on error.
- Machine formatting is never authorization. --auto-apply grants mutation intent, --yes suppresses
  confirmation, and --dry-run vetoes all mutation.
- The legacy CLI and MCP names are compatibility adapters only; tests must prove their independent
  broad mutation and fallback-result paths are unreachable.
- Keep issue #169 to an injected allow/block policy seam. Do not add maintenance configuration,
  schedules, queues, or daemon behavior in issue #151.
- Preserve same-file ownership across sequential Docker and coordinator tasks to reduce conflicts,
  and land the final implementation in one PR because the old legacy path remains unsafe until all
  public surfaces delegate.
