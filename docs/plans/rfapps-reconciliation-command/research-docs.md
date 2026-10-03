# Documentation Research: rfapps Reconciliation Command

## Executive Summary

The reconciliation feature crosses an established documentation chain rather than needing a new
standalone documentation system. The package command reference and drift guide must explain the
new report-first top-level command and the safe delegation from legacy `drift reconcile`; the
plan/apply, managed-update, output, error, secrets, MCP, and completion references define the
behavioral contracts it must preserve. Root and documentation indexes must advertise the command,
while `ROADMAP.md` must record issue #151 as shipped and identify issue #169 as the later
maintenance-window policy implementation. Package guidance and GitHub templates are required
implementation inputs because they contain the repository's testing, output, and contribution
rules.

## Architecture Docs

- `docs/architecture/overview.md` describes the CLI's command, action, library, Docker, state, and
  output layers. Add reconciliation only if its new coordinator changes the documented component
  map.
- `docs/architecture/data-flow.md` documents request-to-Docker flows and is the right architecture
  reference for report, approval, lock, revalidation, targeted action, and final observation.
- `docs/reference/architecture-diagram.md` is the broad component diagram. Update it only if the
  command/action/library path is represented at that level of detail.
- `packages/rfapps-cli/CLAUDE.md` is the package-level engineering contract. It documents command
  registration, config resolution, plan/apply boundaries, managed-update locking, structured
  output, errors, and tests; reconciliation implementation must follow those patterns.
- `docs/plans/managed-update-lifecycle/feature-spec.md` records the closest preview-first and
  fail-closed mutation design, including authority binding and exact target verification.
- `docs/plans/managed-update-lifecycle/shared.md` and
  `docs/plans/managed-update-lifecycle/parallel-plan.md` capture the shipped managed-update file
  map and implementation sequence that reconciliation should reuse rather than duplicate.

## API/Output Docs

- `packages/rfapps-cli/README.md` is the canonical CLI command reference. Add a `reconcile`
  section covering report-only default, `--auto-apply`, selection and health options, dry-run and
  confirmation behavior, versioned output, exit behavior, examples, and legacy delegation.
- `docs/features/rfapps-drift-command.md` defines drift categories, schemas, exit codes, and the
  existing `drift reconcile` and `drift import` paths. Clarify that top-level reconciliation owns
  safe convergence while runtime import remains separate.
- `docs/features/plan-apply-workflow.md` defines review-before-mutation, persisted deployment plans,
  validation, history, and rollback. Contrast same-process reconciliation explicitly so readers do
  not infer saved reconcile plans, deployment history, generation writes, or rollback semantics.
- `docs/features/json-output.md` defines clean stdout, stable machine output, and scripting
  examples. Document the `reconcile.v1` envelope and deterministic ordering here if the feature's
  package reference alone is insufficient.
- `docs/features/error-handling.md` defines typed errors, structured failures, exit-code mapping,
  and redaction. Add reconciliation errors such as stale review evidence and blocked actions.
- `docs/features/secrets-management.md` defines environment and secret handling. Reconciliation
  must document that environment comparisons expose names and change kinds, never values or raw
  Docker/Compose evidence.
- `docs/features/rfapps-mcp-server.md` is the MCP tool catalog and transport contract. Update the
  reconciliation tool description, input schema, mutation classification, approval behavior, and
  result schema when the legacy tool delegates to the shared coordinator.
- `docs/features/shell-completion.md` documents Bash, Zsh, and Fish setup and testing. Add the
  top-level command and its options to all three generated templates and any command inventory.
- `docs/features/quick-reference.md` is the operator command/options matrix and should gain concise
  report and auto-apply examples.

## Development Guides

- `CLAUDE.md` contains repository-wide workflow, validation, Markdown, Graphify, and documentation
  requirements.
- `packages/rfapps-cli/CLAUDE.md` contains the authoritative rfapps source layout, action patterns,
  machine-output rules, test commands, error conventions, and contribution checklist.
- `docs/README.md` is the documentation index and user-facing command overview. Add the new command
  reference and reconcile guide links, and keep its command table consistent.
- `ROADMAP.md` is the living issue plan. On completion, update the assessment date/status, Sprint 1
  row, rfapps backlog row, cross-cutting drift/reconcile row, and closing-PR references.
- `.github/ISSUE_TEMPLATE/enhancement.yml` is the source of truth for any child issue bodies.
- `docs/templates/github/issue-enhancement.md` is the offline drafting mirror for those child
  issues.
- `.github/pull_request_template.md` is the required PR body baseline, including exact test
  commands/results and `Closes #151` linkage.
- `docs/templates/github/pull-request.md` is the offline PR drafting mirror and must remain
  subordinate to the GitHub template.

## README Files

- `README.md` is the repository entry point. Update its CLI capability summary or links only when
  it enumerates rfapps lifecycle commands.
- `packages/rfapps-cli/README.md` is the primary operator-facing command documentation and must be
  updated for reconciliation.
- `docs/README.md` is the documentation index and secondary command overview and must link the
  reconciliation documentation.
- `packages/rf-common/README.md` is not expected to change unless shared public types are moved into
  `rf-common`; the current design keeps reconciliation in `rfapps-cli`.

## Must-Read Documents

Required before implementation:

1. `docs/plans/rfapps-reconciliation-command/feature-spec.md`
2. `packages/rfapps-cli/CLAUDE.md`
3. `packages/rfapps-cli/README.md`
4. `docs/features/rfapps-drift-command.md`
5. `docs/features/plan-apply-workflow.md`
6. `docs/plans/managed-update-lifecycle/feature-spec.md`
7. `docs/features/json-output.md`
8. `docs/features/error-handling.md`
9. `docs/features/secrets-management.md`
10. `docs/features/rfapps-mcp-server.md`
11. `docs/features/shell-completion.md`
12. `ROADMAP.md`

Nice to read for broader context:

1. `docs/architecture/overview.md`
2. `docs/architecture/data-flow.md`
3. `docs/reference/architecture-diagram.md`
4. `docs/features/quick-reference.md`
5. `docs/plans/managed-update-lifecycle/shared.md`
6. `docs/plans/managed-update-lifecycle/parallel-plan.md`
7. `docs/README.md`
8. `README.md`
9. `.github/ISSUE_TEMPLATE/enhancement.yml`
10. `.github/pull_request_template.md`

## Documentation Gaps

- There is no top-level reconciliation guide or command reference; existing material describes
  only `drift reconcile`, whose mutation behavior is materially less constrained.
- The distinction among deployment `plan/apply`, managed image update, drift import, and
  same-process reconciliation is not documented in one place. The new reference needs an explicit
  boundary table or compact comparison.
- No current document defines `reconcile.v1`, its complete per-service accounting, action and
  outcome enums, deterministic ordering, action fingerprint, or structured automation decision.
- Existing drift docs do not describe stale-evidence rejection, shared lifecycle locking,
  no-scope-widening Compose flags, ambiguity blocking, or post-action convergence observation.
- MCP documentation must be checked against the actual server registration because a legacy
  reconciliation endpoint exists and must not retain an independent unsafe execution path.
- Shell completion documentation does not guarantee that every template mirrors new options; tests
  must enforce parity across Bash, Zsh, and Fish.
- Maintenance-window behavior is not yet implementable. Documentation should describe the injected
  allow-all policy seam and refer future scheduling semantics to issue #169 without implying that
  schedules, time zones, or unattended operation ship in issue #151.
- `ROADMAP.md` still presents managed update as pending merge and reconcile as next; both status
  statements need reconciliation against GitHub before the closing update is written.
