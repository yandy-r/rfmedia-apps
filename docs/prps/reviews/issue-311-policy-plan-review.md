# Local Review — Issue #311 Policy Plan

**Reviewed**: 2026-07-31T21:03:37Z
**Re-reviewed**: 2026-07-31T21:39:13Z
**Mode**: Local
**Author**: local
**Branch**: feat/issue-311-policy-plan → origin/master
**Decision**: APPROVE

## Summary

The implementation follows the intended producer, artifact, cancellation, completion, and
documentation boundaries. Parallel full-diff review found nine fail-closed, evidence-completeness,
or user-surface gaps; all nine are fixed with focused regression or parity coverage and re-reviewed.

## Findings

### CRITICAL

- **[F001]** `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts:233` — Selected unsafe rule outcomes can be silently omitted while sibling proposals are sealed, producing an incomplete authorization artifact.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Inspect every selected rule result before no-change or producer dispatch, ignore only `not-selected` and intentionally disabled outcomes, and block plan mode on `signal-unavailable`, `consumption-signal-empty`, or `rule-error`; add degraded-sibling and degraded-only zero-dispatch tests.

### HIGH

- **[F002]** `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts:257` — Cancellation after a producer seals rethrows through the generic failure path and loses the completed artifact evidence.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Preserve non-empty completed outcomes in a typed, sanitized `partial` result when cancellation occurs between producers or inside a later producer; continue propagating cancellation before any artifact exists and add both regression tests.

- **[F003]** `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts:543` — Policy-plan CSV drops evaluation `skip` rows, omitting their decision keys, codes, details, checks, and evidence.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Include deterministic evaluation skip rows in the policy-plan CSV projection and assert their complete fields in focused presenter or command tests.

- **[F004]** `packages/rfmedia-cli/src/commands/lidarr-policy.ts:562` — `--explain` key validation happens after plan producers may have sealed artifacts, and the explain branch suppresses complete typed failure or partial rendering.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Validate the explain key after the single evaluation but before producer dispatch, prove an unknown plan-mode key invokes zero producers, and retain complete plan-result rendering when explanation is requested.

- **[F005]** `packages/rfmedia-cli/src/commands/lidarr-policy.ts:542` — The CLI does not forward the process cancellation signal to policy-plan execution, so production interruption cannot reliably preserve typed partial artifact evidence.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Resolve the established process-wide signal, pass that exact signal to `executeLidarrPolicyPlan`, and add a command-boundary regression test.

### MEDIUM

- **[F006]** `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md:118` — Documentation says degraded rule outcomes remain visible without documenting the selected unsafe skip outcomes that now block producer dispatch.
  - **Status**: Fixed
  - **Category**: Documentation
  - **Suggested fix**: Document the blocking skip outcomes and typed failure-envelope behavior in the feature guide and README.

- **[F007]** `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md:867` — CSV documentation excludes evaluation `skip` rows even though the fixed projection includes their full evidence.
  - **Status**: Fixed
  - **Category**: Documentation
  - **Suggested fix**: Include `skip` in the documented deterministic row order in the feature guide and README.

- **[F008]** `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md:208` — Human `--explain` documentation says the explanation replaces the report, but the fixed command renders the complete report first and appends the explanation.
  - **Status**: Fixed
  - **Category**: Documentation
  - **Suggested fix**: Correct the option and troubleshooting text in the feature guide and README.

### LOW

- **[F009]** `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts:498` — Zsh and Fish completion descriptions still present `policy` as evaluation-only.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Align both descriptions with the review-and-seal parent command help and keep completion parity tests green.

## Validation Results

| Check      | Result                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| Type check | Pass — package and monorepo typechecks, architecture, and Lidarr codegen |
| Lint       | Pass — Prettier, markdownlint, and scoped whitespace checks              |
| Tests      | Pass — 119 focused, 4,310 rfmedia, and full monorepo suites              |
| Build      | Pass — `build:rfmedia` and `build:all`                                   |

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/README.md` (Modified)
- `docs/plans/issue-311-policy-plan/analysis-architecture.md` (Added)
- `docs/plans/issue-311-policy-plan/analysis-docs.md` (Added)
- `docs/plans/issue-311-policy-plan/analysis-integration.md` (Added)
- `docs/plans/issue-311-policy-plan/analysis-patterns.md` (Added)
- `docs/plans/issue-311-policy-plan/analysis-tasks.md` (Added)
- `docs/plans/issue-311-policy-plan/feature-spec.md` (Added)
- `docs/plans/issue-311-policy-plan/parallel-plan.md` (Added)
- `docs/plans/issue-311-policy-plan/research-business.md` (Added)
- `docs/plans/issue-311-policy-plan/research-external.md` (Added)
- `docs/plans/issue-311-policy-plan/research-practices.md` (Added)
- `docs/plans/issue-311-policy-plan/research-recommendations.md` (Added)
- `docs/plans/issue-311-policy-plan/research-security.md` (Added)
- `docs/plans/issue-311-policy-plan/research-technical.md` (Added)
- `docs/plans/issue-311-policy-plan/research-ux.md` (Added)
- `docs/plans/issue-311-policy-plan/shared.md` (Added)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md` (Modified)
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts` (Added)
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-policy.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts` (Added)
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` (Modified)
- `packages/rfmedia-cli/src/types/index.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts` (Added)
