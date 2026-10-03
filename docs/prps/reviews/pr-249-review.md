# PR Review #249 — feat(rfmedia): add tiered verification

**Reviewed**: 2026-07-19T16:27:45Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/116-tiered-verification → master
**Decision**: COMMENT

## Summary

The tier architecture, evidence model, benchmarks, and broad regression coverage are strong. The
initial review found four high-severity and one medium-severity defects; all five are now fixed and
the combined patch passed re-review. The review is published as a comment because the author cannot
self-approve the PR.

## Findings

### CRITICAL

No findings.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/actions/verify-album.ts:506` — Album rename repair writes a new path instead of repairing the expected destination, so the final recheck still sees the original mismatch and also discovers an extra file; quick-tier repair can therefore report work performed without satisfying the requested repair.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Refuse rename for an expected verification path, as filter mode already does, and add a regression proving the original artifact remains unresolved without creating an extra file.

- **[F002]** `packages/rfmedia-cli/src/actions/verify-filter.ts:383` — Filter repair drops the active `AbortSignal`: `fixFilteredTracks` has no signal parameter and `replaceFileWithValidatedStage` receives none, so conversion, copy, hashing, and byte comparison can continue after command cancellation.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: Thread the worker/global signal through both filter repair call sites, the staged replacement, conversion/copy, and final re-verification, with an interrupted-repair regression that preserves the original destination.

- **[F003]** `packages/rfmedia-cli/src/actions/verify-filter.ts:1189` — Filter evidence queries use caller-supplied source strings without resolving them, while copy-time inventory stores absolute `source_path` values. A valid relative source therefore returns no candidates and makes default/deep verification incorrectly report every artifact as `fingerprint-missing`.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Resolve source roots before querying and use the same canonical root for task identities and repair lookup; add single- and multi-source relative-path regressions.

- **[F004]** `packages/rfmedia-cli/src/lib/integrity.ts:163` — Content-tier reads open paths normally and only inspect the opened target with `fstat`, so a per-artifact symlink is followed and can pass hash/deep verification. This contradicts the documented strict non-symlink contract and allows verification to attest bytes outside the requested artifact path.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Open with no-follow semantics where supported and bind pre/post pathname identity to the opened handle; reject source or destination symlinks in hash and byte comparison tests.

### MEDIUM

- **[F005]** `packages/rfmedia-cli/src/lib/tiered-verification.ts:414` — Extra files are emitted in the structured `issues` array with status `present`, making machine output misleading and forcing repair code to infer extras from a successful status.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: Add an explicit `extra` file status, aggregate it without increasing `expectedTotal`, update both repair classifiers, and cover JSON/CSV issue projection.

### LOW

No findings.

## Validation Results

| Check      | Result                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Type check | Pass — all three workspaces                                                                      |
| Lint       | Partial — changed Markdown passes; repo-wide lint has 319 pre-existing/generated Markdown errors |
| Tests      | Pass — rfmedia 1,748; rfapps 1,317 passed and 2 skipped                                          |
| Build      | Pass — `npm run build:rfmedia`                                                                   |

## Re-review

**Completed**: 2026-07-19T17:18:00Z
**Decision**: PASS
**Open findings**: 0

The combined fix patch was inspected against every suggested fix. No new correctness, security,
type-safety, or regression findings were identified. Full rfmedia validation passed with 66 test
files and 1,762 tests, plus package typecheck, production build, formatting, Markdown lint, and the
meaningful whitespace check.

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/features/file-integrity-verification.md` (Modified)
- `docs/plans/tiered-verification/analysis-architecture.md` (Added)
- `docs/plans/tiered-verification/analysis-docs.md` (Added)
- `docs/plans/tiered-verification/analysis-integration.md` (Added)
- `docs/plans/tiered-verification/analysis-patterns.md` (Added)
- `docs/plans/tiered-verification/analysis-tasks.md` (Added)
- `docs/plans/tiered-verification/benchmark-results.md` (Added)
- `docs/plans/tiered-verification/feature-spec.md` (Added)
- `docs/plans/tiered-verification/parallel-plan.md` (Added)
- `docs/plans/tiered-verification/research-business.md` (Added)
- `docs/plans/tiered-verification/research-external.md` (Added)
- `docs/plans/tiered-verification/research-practices.md` (Added)
- `docs/plans/tiered-verification/research-recommendations.md` (Added)
- `docs/plans/tiered-verification/research-security.md` (Added)
- `docs/plans/tiered-verification/research-technical.md` (Added)
- `docs/plans/tiered-verification/research-ux.md` (Added)
- `docs/plans/tiered-verification/shared.md` (Added)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/benchmarks/helpers.ts` (Modified)
- `packages/rfmedia-cli/benchmarks/verify.bench.ts` (Modified)
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` (Modified)
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` (Modified)
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md` (Modified)
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md` (Modified)
- `packages/rfmedia-cli/docs/features/verify-command.doc.md` (Modified)
- `packages/rfmedia-cli/src/actions/copy-filter.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/copy-filter.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-album.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-album.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/verify-filter.ts` (Modified)
- `packages/rfmedia-cli/src/cli.test.ts` (Modified)
- `packages/rfmedia-cli/src/commands/verify.ts` (Modified)
- `packages/rfmedia-cli/src/lib/db.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/db.ts` (Modified)
- `packages/rfmedia-cli/src/lib/filesystem.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/filesystem.ts` (Modified)
- `packages/rfmedia-cli/src/lib/integrity.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/integrity.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` (Modified)
- `packages/rfmedia-cli/src/lib/tiered-verification.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/tiered-verification.ts` (Added)
- `packages/rfmedia-cli/src/lib/verify.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/verify.ts` (Modified)
- `packages/rfmedia-cli/src/types/db.ts` (Modified)
- `packages/rfmedia-cli/src/types/index.ts` (Modified)
- `packages/rfmedia-cli/src/types/options.ts` (Modified)
- `packages/rfmedia-cli/src/types/results.ts` (Modified)
