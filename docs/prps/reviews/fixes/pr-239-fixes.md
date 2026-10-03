# Fix Report: pr-239-review

**Source**: `docs/prps/reviews/pr-239-review.md`
**Applied**: 2026-07-17T23:25:28Z
**Mode**: Parallel sub-agents (2 severity batches, max width 4)
**Severity threshold**: MEDIUM

## Summary

- **Total findings in source**: 16
- **Already processed before this run**:
  - Fixed: 0
  - Failed: 0
- **Eligible this run**: 16
- **Applied this run**:
  - Fixed: 16
  - Failed: 0
- **Skipped this run**:
  - Below severity threshold: 0
  - No suggested fix: 0
  - Missing file: 0

## Fixes Applied

| ID   | Severity | File                                            | Line | Status | Notes                                                                                                              |
| ---- | -------- | ----------------------------------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| F001 | HIGH     | `packages/rfapps-cli/src/actions/update.ts`     | 147  | Fixed  | Fingerprints selected Docker context endpoint and daemon identity through the active secrets environment.          |
| F002 | HIGH     | `packages/rfapps-cli/src/actions/update.ts`     | 494  | Fixed  | Canonical approved Compose path/root binding rejects alternate, outside-root, and symlinked saved-plan targets.    |
| F003 | HIGH     | `packages/rfapps-cli/src/actions/update.ts`     | 629  | Fixed  | Canonical Compose project directory now drives selection, locking, coordinator readiness, and cross-CWD apply.     |
| F004 | HIGH     | `packages/rfapps-cli/src/lib/docker.ts`         | 1432 | Fixed  | Selects local repository digests by normalized configured repository rather than array order.                      |
| F005 | HIGH     | `packages/rfapps-cli/src/lib/docker.ts`         | 1498 | Fixed  | Produces validated, pullable `repository@sha256` remote identities end to end.                                     |
| F006 | HIGH     | `packages/rfapps-cli/src/lib/managed-update.ts` | 865  | Fixed  | Treats recreation exceptions as uncertain mutation and routes them through exact-image stabilization/recovery.     |
| F007 | HIGH     | `packages/rfapps-cli/src/lib/managed-update.ts` | 983  | Fixed  | Converts update/restore verifier rejections into bounded typed evidence and preserves terminal recovery reporting. |
| F008 | HIGH     | `packages/rfapps-cli/src/lib/managed-update.ts` | 1267 | Fixed  | Revalidates each service’s digest, platform, daemon identity, and recovery generation immediately before mutation. |
| F009 | HIGH     | `packages/rfapps-cli/src/lib/migrations.ts`     | 150  | Fixed  | Adds v3 identity columns only when absent and covers schema-first initialization of an on-disk v1 database.        |
| F010 | HIGH     | `packages/rfapps-cli/src/lib/plan-generator.ts` | 820  | Fixed  | Threads normalized platform through registry inspection and requires an exact manifest-platform match.             |
| F011 | MEDIUM   | `packages/rfapps-cli/src/actions/update.ts`     | 180  | Fixed  | Uses a direct indexed exact-image recovery-generation query.                                                       |
| F012 | MEDIUM   | `packages/rfapps-cli/src/actions/update.ts`     | 324  | Fixed  | Preview emits `planned`; `cancelled` is reserved for an actual declined approval.                                  |
| F013 | MEDIUM   | `packages/rfapps-cli/src/actions/update.ts`     | 593  | Fixed  | Securely reserves an empty output path without publishing a false terminal lifecycle document.                     |
| F014 | MEDIUM   | `packages/rfapps-cli/src/lib/docker.ts`         | 166  | Fixed  | Caps and classifies stdout/stderr overflow while continuing to drain and terminate the child safely.               |
| F015 | MEDIUM   | `packages/rfapps-cli/src/lib/managed-update.ts` | 455  | Fixed  | Emits dependency-specific verification codes and bounded failed/pending dependency evidence.                       |
| F016 | MEDIUM   | `packages/rfapps-cli/src/lib/plan-generator.ts` | 797  | Fixed  | Limits registry detection to four concurrent checks and 128 candidate services per plan.                           |

## Files Changed

- `packages/rfapps-cli/src/actions/update.ts` and `update.spec.ts` (F001, F002, F003, F011, F012, F013)
- `packages/rfapps-cli/src/lib/docker.ts` and `docker.spec.ts` (F004, F005, F014)
- `packages/rfapps-cli/src/lib/managed-update.ts` and `managed-update.spec.ts` (F003, F006, F007, F008, F015)
- `packages/rfapps-cli/src/lib/migrations.ts` and `migrations.spec.ts` (F009, F011)
- `packages/rfapps-cli/src/lib/plan-generator.ts` and `plan-generator.spec.ts` (F010, F016)
- `packages/rfapps-cli/src/lib/generations.ts` and `generations.spec.ts` (F011)
- `packages/rfapps-cli/src/lib/plan-storage.ts` and `plan-storage.spec.ts` (F013)
- `packages/rfapps-cli/src/lib/schema.sql`, `lib/index.ts`, and `types/update.ts` (F011, F012)
- `docs/prps/reviews/pr-239-review.md` (all attempted finding statuses updated in place)

## Failed Fixes

_(none)_

## Validation Results

| Check                     | Result                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Formatting                | Pass — Prettier over every modified file                                  |
| Whitespace                | Pass — repository-standard `git diff --check`                             |
| Type check                | Pass — `npm run typecheck --workspace packages/rfapps-cli`                |
| Unit/integration tests    | Pass — 64 files, 1,060 tests; one opt-in test skipped in the normal suite |
| Live Docker Compose smoke | Pass — exact reviewed target update and original local-image restore      |
| Build                     | Pass — `npm run build:rfapps`                                             |

## Worktree Summary

- **Parent**: `/home/yandy/.codex-worktrees/rfmedia-apps-issue-148/`
- **Branch**: `feat/148-managed-update-lifecycle`
- **Review artifact**: `docs/prps/reviews/pr-239-review.md`
- **PR**: #239

### Next steps

- Commit and push the fixes and audit artifacts to PR #239.
- Re-run the parallel PR review against the new head revision.
- Require green GitHub CI before squash merge and worktree cleanup.
