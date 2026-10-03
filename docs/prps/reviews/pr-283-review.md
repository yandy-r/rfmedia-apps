# PR Review #283 — feat(rfmedia): add artist identity mapping

**Reviewed**: 2026-07-27T20:59:06Z
**Re-reviewed**: 2026-07-27T21:12:08Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/issue-207-identity-mapping → master
**Decision**: APPROVE

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-207/` (branch: `feat/issue-207-identity-mapping`)

## Summary

The provider boundaries, strict snapshot persistence, schema migration, exact-MBID authority rule,
scope closeout, and all prior review fixes are present at active head
`011e06ee90a3c0eeb00b920d743bf4af6b9304d3`. The incremental F001 fix closes the exact-MBID-miss
comparison-budget bypass, and the late F002 fix rejects stale Plex pagination metadata at the exact
non-advancing boundary. Both fixes have matching regression coverage, and the focused re-reviews
found no new issues.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/lib/bridge/mapping.ts:227` — The comparison-budget calculation counts only sources whose MBID is absent, but a source with a valid MBID that has no exact target still scans every target at lines 432–437 to detect a contradictory exact-name MBID. Consequently, up to 10,000 valid-MBID sources and 10,000 targets can trigger 100,000,000 target scans, each calling the Levenshtein scorer four times, despite `BRIDGE_ARTIST_MAX_COMPARISONS` being 1,000,000. A focused 101-source × 9,901-target case (1,000,001 pairs) returned 101 outcomes instead of throwing `comparison budget exceeded`, proving the guard is bypassed.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Include every source that can reach `scoreTarget()` in the preflight work budget, including valid source MBIDs without an exact target, or replace the contradictory-name scan with a normalized-name index that avoids pairwise distance work. Add a regression test whose valid-MBID miss matrix exceeds `BRIDGE_ARTIST_MAX_COMPARISONS` and must fail before scoring.

### MEDIUM

None.

### LOW

None.

## Validation Results

| Check      | Result                                                                |
| ---------- | --------------------------------------------------------------------- |
| Type check | Pass — existing active-head PR/pre-push evidence                      |
| Lint       | Pass — existing active-head PR/pre-push evidence                      |
| Tests      | Pass — focused resolver 29/29 and Plex identity 7/7                   |
| Build      | Pass — existing active-head `npm run build:all` and pre-push evidence |

## Re-review Validation

- F001 verified fixed: valid source MBIDs missing from the target MBID index now count toward the
  same preflight budget as MBID-absent fuzzy comparisons.
- The 101-source × 9,901-target regression now throws before contradictory-name scoring.
- `mapping.test.ts` passes 29/29 tests; targeted Prettier and `git diff --check` pass.

## Late Feedback

- **[F002]** `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts:142` — A `hasMore`
  response whose reported offset and returned count did not advance beyond the requested start
  could move pagination backward or stall.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Reject pages unless `offset + returned > requestedStart`, retaining an
    exact equality-boundary regression.
  - **Re-review validation**: The `offset 4 + returned 1 === requested 5` case now fails with the
    bounded `invalid-response` contract. The focused identity suite passes 7/7 tests; targeted
    Prettier and `git diff --check` pass.

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/plans/plex-lidarr-identity-mapping/analysis-code.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/analysis-context.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/analysis-tasks.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/parallel-plan.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-business.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-external.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-practices.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-recommendations.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-security.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-technical.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/research-ux.md` (Added)
- `docs/plans/plex-lidarr-identity-mapping/shared.md` (Added)
- `docs/prps/reviews/fixes/local-20260727-201851-fixes.md` (Added)
- `docs/prps/reviews/fixes/local-20260727-203852-fixes.md` (Added)
- `docs/prps/reviews/local-20260727-201851-review.md` (Added)
- `docs/prps/reviews/local-20260727-203852-review.md` (Added)
- `docs/prps/reviews/local-20260727-204140-review.md` (Added)
- `docs/roadmap-archive.md` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs` (Modified)
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts` (Added)
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` (Modified)
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/bridge/cache.ts` (Added)
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts` (Added)
- `packages/rfmedia-cli/src/lib/db.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/db.ts` (Modified)
- `packages/rfmedia-cli/src/lib/migrations.ts` (Modified)
- `packages/rfmedia-cli/src/lib/schema.sql` (Modified)
- `packages/rfmedia-cli/src/types/bridge.ts` (Added)
- `packages/rfmedia-cli/src/types/index.ts` (Modified)
- `packages/rfmedia-cli/src/types/media-server.ts` (Modified)
