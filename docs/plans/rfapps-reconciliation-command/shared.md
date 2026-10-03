# rfapps Reconciliation Command

Issue #151 adds a report-first `rfapps reconcile` workflow that compares resolved Docker Compose
intent with complete Docker runtime evidence and emits one deterministic `reconcile.v1` result.
Bare execution is read-only; `--auto-apply` alone authorizes a same-process, locked, revalidated,
target-only convergence cycle. The top-level CLI, legacy `rfapps drift reconcile`, and existing MCP
tool must share one coordinator, authorization model, output contract, and post-action convergence
proof without adding persistence, rollback, a daemon, or maintenance-window configuration.

## Relevant Files

- `packages/rfapps-cli/src/cli.ts`: Register the new top-level command while preserving global
  formatting, secrets-tool, dry-run, confirmation, and exit handling.
- `packages/rfapps-cli/src/commands/reconcile.ts`: Define the new Commander surface and delegate to
  the action boundary.
- `packages/rfapps-cli/src/actions/reconcile.ts`: Resolve config, canonical identity, frozen scope,
  confirmation, rendering, signals, and exit state around the data-only coordinator.
- `packages/rfapps-cli/src/types/reconcile.ts`: Define the versioned result, comparison, action,
  policy, outcome, summary, status, and exit contracts.
- `packages/rfapps-cli/src/lib/reconcile.ts`: Implement deterministic observe/plan and optional
  lock/revalidate/act/verify coordination.
- `packages/rfapps-cli/src/lib/drift.ts`: Preserve the single desired-versus-actual comparison and
  secret masking while accepting complete stopped/missing/ambiguous observations.
- `packages/rfapps-cli/src/types/drift.ts`: Reuse the existing drift categories and service diff
  rather than introducing a competing comparison model.
- `packages/rfapps-cli/src/lib/docker.ts`: Add multiplicity-preserving `compose ps --all`
  observation and exact one-service `up -d --pull never --no-deps` mutation primitives.
- `packages/rfapps-cli/src/lib/service-status.ts`: Reference its all-container parsing, but do not
  reuse the collapsing one-entry-per-service map as reconciliation authority.
- `packages/rfapps-cli/src/lib/interactive-selection.ts`: Reuse or extract deterministic service,
  group, sidecar, and profile scope resolution without prompting in report mode.
- `packages/rfapps-cli/src/lib/services.ts`: Supply group/sidecar expansion and profile detection
  before the scope is frozen and sorted.
- `packages/rfapps-cli/src/actions/update.ts`: Move canonical project and Docker authority helpers
  behind a shared library while preserving managed-update behavior.
- `packages/rfapps-cli/src/lib/managed-update.ts`: Follow its reviewed identity, shared lock,
  revalidation, sequential mutation, interruption, and cleanup patterns only.
- `packages/rfapps-cli/src/lib/plan-generator.ts`: Reuse resolved-service configuration
  fingerprinting for stale desired-state detection.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`: Share mutual exclusion with managed update for
  auto-apply only.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: Produce deterministic dependency phases without
  widening the frozen scope; execute sequentially within phases.
- `packages/rfapps-cli/src/lib/health.ts`: Combine bounded readiness polling with fresh drift
  observation before reporting convergence.
- `packages/rfapps-cli/src/commands/drift.ts`: Preserve the legacy spelling but delegate its
  reconciliation path to the new action.
- `packages/rfapps-cli/src/actions/drift.ts`: Remove the independent broad `startServices()`
  mutation path while leaving detect, show, and import compatible.
- `packages/rfapps-cli/src/mcp/schema.ts`: Publish the explicit reconciliation input and complete
  `reconcile.v1` result schema.
- `packages/rfapps-cli/src/mcp/adapters.ts`: Route the existing MCP tool through the shared action
  and structured-output capture without a generic fallback.
- `packages/rfapps-cli/src/mcp/tools-mutate.ts`: Keep `rfapps.drift.reconcile` as the sole MCP
  mutation spelling and require explicit machine authorization.
- `packages/rfapps-cli/src/actions/completion.ts`: Mirror the complete command and option surface in
  Bash, Zsh, and Fish templates.
- `packages/rfapps-cli/src/actions/completion.spec.ts`: Enforce completion parity and dynamic value
  helpers across all three shells.
- `packages/rfapps-cli/src/lib/formatters/index.ts`: Emit exactly one complete machine document and
  use an explicit summary projection for flat human formats.
- `packages/rfapps-cli/src/lib/exit-codes.ts`: Derive stable `0/1/2/3` outcomes from the result.
- `packages/rfapps-cli/src/lib/errors.ts`: Reuse typed input/runtime errors and bounded evidence.
- `packages/rfapps-cli/src/lib/error-formatters.ts`: Add only reconciliation-specific CLI guidance
  not covered by existing error categories.
- `packages/rfapps-cli/README.md`: Document report and auto-apply behavior, options, schemas, exits,
  examples, and legacy delegation.
- `docs/features/rfapps-drift-command.md`: Clarify the top-level safe convergence path and retain
  runtime import as a separate operation.
- `docs/features/rfapps-reconcile-command.md`: Add the operator-facing reconciliation contract,
  safety boundaries, result schema, and examples.
- `docs/features/rfapps-mcp-server.md`: Update the existing tool's authorization and result schema.
- `docs/features/shell-completion.md`: Document the new command across Bash, Zsh, and Fish.
- `docs/features/json-output.md`: Add `reconcile.v1` and deterministic machine-output guidance.
- `docs/features/quick-reference.md`: Add concise report and auto-apply examples.
- `docs/README.md`: Link the new feature documentation and command inventory.
- `ROADMAP.md`: Mark issue #151 and its child work complete while retaining issue #169 as follow-up.

## Relevant Patterns

- **Thin command, boundary action, data-only coordinator**:
  [`packages/rfapps-cli/src/commands/update.ts`](../../../packages/rfapps-cli/src/commands/update.ts),
  [`packages/rfapps-cli/src/actions/update.ts`](../../../packages/rfapps-cli/src/actions/update.ts),
  and [`packages/rfapps-cli/src/lib/managed-update.ts`](../../../packages/rfapps-cli/src/lib/managed-update.ts)
  establish the dependency direction, injection seam, and cleanup ownership.
- **Canonical reviewed authority**:
  [`packages/rfapps-cli/src/actions/update.ts`](../../../packages/rfapps-cli/src/actions/update.ts)
  and [`packages/rfapps-cli/src/lib/managed-update.ts`](../../../packages/rfapps-cli/src/lib/managed-update.ts)
  bind Compose project, environment source, Docker authority, resolved configuration, and container
  identity, then revalidate them under the lock.
- **Single drift definition**:
  [`packages/rfapps-cli/src/lib/drift.ts`](../../../packages/rfapps-cli/src/lib/drift.ts) and
  [`packages/rfapps-cli/src/types/drift.ts`](../../../packages/rfapps-cli/src/types/drift.ts) own
  deterministic categories and secret-safe comparisons.
- **Bounded argv execution**:
  [`packages/rfapps-cli/src/lib/docker.ts`](../../../packages/rfapps-cli/src/lib/docker.ts) uses
  argument arrays, environment-tool wrapping, timeouts, bounded capture, and typed failures.
- **Shared exclusion and fail-closed cleanup**:
  [`packages/rfapps-cli/src/lib/lifecycle-lock.ts`](../../../packages/rfapps-cli/src/lib/lifecycle-lock.ts)
  provides the private project/Docker lock and explicit release contract.
- **Complete structured output**:
  [`packages/rfapps-cli/src/lib/formatters/index.ts`](../../../packages/rfapps-cli/src/lib/formatters/index.ts)
  and [`packages/rfapps-cli/src/mcp/adapters.ts`](../../../packages/rfapps-cli/src/mcp/adapters.ts)
  enforce a single machine document and action-result capture.
- **Injected dependency tests**:
  [`packages/rfapps-cli/src/lib/managed-update.spec.ts`](../../../packages/rfapps-cli/src/lib/managed-update.spec.ts)
  and [`packages/rfapps-cli/src/actions/update.spec.ts`](../../../packages/rfapps-cli/src/actions/update.spec.ts)
  test lifecycle order and action behavior without module-global mocks.

## Relevant Docs

You _must_ read these documents before implementing tasks from the plan:

- `docs/plans/rfapps-reconciliation-command/feature-spec.md`: Source-of-truth behavior, schema,
  safety, compatibility, and acceptance requirements.
- `packages/rfapps-cli/CLAUDE.md`: Package architecture, command/action conventions, output rules,
  test commands, and contribution gates.
- `packages/rfapps-cli/README.md`: Current operator-facing command and option contracts.
- `docs/features/rfapps-drift-command.md`: Existing diff categories, legacy reconciliation, import,
  schemas, and exits that must remain compatible.
- `docs/features/plan-apply-workflow.md`: Review-before-mutation precedent and explicit boundary from
  same-process, non-persisted reconciliation.
- `docs/plans/managed-update-lifecycle/feature-spec.md`: Closest shipped preview-first, locked,
  authority-bound mutation design.
- `docs/features/json-output.md`: Clean stdout and stable machine-output requirements.
- `docs/features/error-handling.md`: Typed errors, redaction, structured failures, and exit mapping.
- `docs/features/secrets-management.md`: Environment provider and non-disclosure requirements.
- `docs/features/rfapps-mcp-server.md`: Existing MCP tool naming, schemas, transport, and mutation
  classification.
- `docs/features/shell-completion.md`: Bash, Zsh, and Fish generation/testing contract.
- `ROADMAP.md`: Issue #151 placement and issue #169 maintenance-window follow-up.

Nice-to-read supporting documents:

- `docs/architecture/overview.md`
- `docs/architecture/data-flow.md`
- `docs/features/quick-reference.md`
- `docs/plans/managed-update-lifecycle/shared.md`
- `docs/plans/managed-update-lifecycle/parallel-plan.md`
- `docs/README.md`
- `.github/ISSUE_TEMPLATE/enhancement.yml`
- `.github/pull_request_template.md`
