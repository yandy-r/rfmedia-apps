# PR Review #279 — feat(rfmedia): harden Lidarr artist adds

**Reviewed**: 2026-07-27T03:58:32Z
**Mode**: PR
**Author**: yandy-r
**Branch**: feat/lidarr-safe-add-guardrails → master
**Decision**: APPROVE

## Summary

The plan and compatibility work is strong, but the parallel review found three high-severity
fail-closed gaps in post-add normalization plus one legacy facade regression. The suggestion to
normalize artists that already existed before apply was excluded because the approved contract
intentionally limits post-add mutation to artists created by this plan.

## Findings

### CRITICAL

- None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:445` —
  Artist-scoped normalization trusts an unbounded album response without requiring unique IDs or
  confirming every album belongs to the newly created artist, so an invalid response could mutate
  another artist's albums or amplify into unbounded bulk writes.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Fail closed before mutation and again during verification unless the album
    response is bounded, has unique positive IDs, and every `album.artistId` equals the durable
    created artist ID. Add oversized, duplicate-ID, and wrong-artist regression tests.

- **[F002]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:654` —
  Normalization resume does not compare the fresh exact-MBID result with the `lidarrId` captured in
  durable normalization history, so a deleted and replaced artist could receive the old plan's
  album mutations.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Carry the latest normalization history into entry execution and require the
    reconciled artist ID to equal its durable `lidarrId` before album reads or writes. Treat an ID
    mismatch as stale or uncertain while preserving the no-POST resume barrier.

- **[F003]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:676` —
  A failed normalization-stage reconciliation overwrites durable creation evidence with a generic
  terminal `uncertain` record. A later resume can lose the no-POST barrier and return to the fresh
  path, risking a second non-idempotent artist create.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Preserve creation and normalization evidence on every reconciliation
    failure after creation is verified. Retain or rewrite the durable normalization stage,
    idempotency key, and Lidarr ID instead of replacing it with a generic terminal record. Add a
    two-resume regression test asserting `addArtist` remains called once.

- **[F006]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:914` —
  The validated artist ID returned by a successful create is discarded before exact-MBID
  reconciliation, so a replacement artist with the same MBID could receive normalization intended
  for the newly created artist.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Durably retain the successful POST response ID and require the fresh
    exact-MBID result to match it before recording normalization progress or reading and mutating
    albums. Add replacement-race and no-second-POST regressions.

- **[F007]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:972` —
  If persisting the returned create ID fails, the original unbound possible-dispatch marker remains
  resumable and could authorize normalization of a replacement artist on the next invocation.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Keep unbound possible-dispatch history readable and no-POST, but never
    authorize extended album normalization without a durable Lidarr artist ID. Add a two-invocation
    identity-history-failure regression.

### MEDIUM

- **[F004]** `packages/rfmedia-cli/src/lib/lidarr/client.ts:1355` — The legacy
  `listMetadataProfiles()` method uses the new strict detailed-profile projector before narrowing
  to `{id, name}`, so sparse id/name responses now fail despite the separate detailed facade method
  and documented compatibility boundary.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Restore the narrow profile projector for `listMetadataProfiles()` and use
    the strict structural projector only in `listMetadataProfileDetails()`. Add a regression test
    showing that the narrow method still accepts a bounded id/name-only response.

- **[F005]** `packages/rfmedia-cli/src/lib/lidarr/client.ts:1360` — The first F004 repair reused the
  quality-profile-named summary projector for metadata profiles, coupling two otherwise separate
  facade domains and making later quality-specific validation changes risky.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract a domain-neutral bounded profile-summary projector and use it for
    both summary facade methods while keeping detailed metadata projection strict.

### LOW

- None.

## Validation Results

| Check      | Result |
| ---------- | ------ |
| Type check | Pass   |
| Lint       | Pass   |
| Tests      | Pass   |
| Build      | Pass   |

## Re-review

**Completed**: 2026-07-27T04:37:53Z

Correctness, security, and maintainability re-reviews found no remaining actionable issues after
F001–F007 were fixed. The final validation passed 3,443 rfmedia tests, 60 architecture tests, 75
codegen tests, type checking, the rfmedia build, formatting, and markdownlint across 429 files.

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/plans/lidarr-safe-add-guardrails/analysis-architecture.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/analysis-docs.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/analysis-integration.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/analysis-patterns.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/analysis-tasks.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/parallel-plan.md` (Added)
- `docs/plans/lidarr-safe-add-guardrails/shared.md` (Added)
- `docs/roadmap-archive.md` (Modified)
- `packages/rfmedia-cli/CHANGELOG.md` (Modified)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs` (Modified)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` (Modified)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` (Modified)
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr-plan.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr.ts` (Modified)
