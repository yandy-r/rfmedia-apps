# Local Review — Plex Adapter Refactor

**Reviewed**: 2026-07-20T02:52:16Z
**Mode**: Local, three parallel reviewers
**Author**: local
**Branch**: `feat/plex-adapter-refactor` → `origin/master`
**Decision**: APPROVE

## Summary

The generic boundary, private transport security, compatibility coverage, and legacy deletion are
well tested. The initial review found eight actionable issues; all eight were fixed and independently
re-reviewed. The three verification reviewers found no remaining correctness, security, or quality
issues. The dedicated security reviews found no credential, origin, redirect, redaction,
cache-isolation, retry, or path-traversal vulnerability.

## Verification Re-review

Three independent reviewers re-examined the fixed implementation for correctness, security, and
architecture/quality. Each returned zero actionable findings across all severity levels.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/lib/adapters/plex/collections.ts:195` — Collection-item wire validation accepts any finite `userRating`, but mapping can throw a raw `RangeError` for ratings outside `0..10` instead of the adapter's typed malformed-response failure.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Wrap collection-item mapping in `try/catch` and rethrow the typed `invalidResponse(operation, ...)`, then add an out-of-range collection-child rating regression test.

- **[F002]** `packages/rfmedia-cli/src/lib/adapters/plex/collections.ts:103` — The new collection capability factory is over 200 lines and combines every read, mutation, batching, fallback, and invalidation path in one closure.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract read capabilities, mutation helpers, and returned capability assembly into focused functions while keeping shared transport/cache dependencies explicit.

- **[F003]** `packages/rfmedia-cli/src/lib/adapters/plex/client.ts:313` — `PlexClient.request()` is roughly 130 lines with nested auth retry, abort, body, and error-classification branches.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract one-attempt execution, non-success response handling, and success-body parsing into focused private helpers while leaving `request()` responsible for the bounded auth-retry loop.

- **[F004]** `packages/rfmedia-cli/src/lib/adapters/plex/playlists.ts:184` — The new playlist capability factory is over 130 lines and combines lookup, pagination, creation, batching, partial-mutation invalidation, and deletion.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract playlist reads, create/delete mutations, and batched item addition into focused helpers so the factory only binds immutable dependencies.

- **[F005]** `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts:376` — The new query/library family factory is over 250 lines and combines queries, library lookup, identity caching, scan fallback, path mapping, and capability construction.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Split query, library/identity, and scan construction into focused factories that share a small immutable dependency object.

### MEDIUM

- **[F006]** `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs:142` — The architecture gate permits extra `fetch` owners under the private Plex directory and only catches an upper-layer fetch when an authentication literal appears in the same file.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Reject every production `fetch(` outside exactly `src/lib/adapters/plex/client.ts`, require exactly one fetch site there, and add fixtures for private-module and upper-layer bypasses.

- **[F007]** `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts:275` — Five generic-to-Plex compatibility projectors are production dead code and duplicate live boundary-owned projections.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Delete the unused projector exports and their isolated tests because action-owned compatibility projection is the established live boundary, then update legacy ownership citations to live action tests.

- **[F008]** `packages/rfmedia-cli/src/types/media-server.ts:178` — Filter pushdown feature fields and operators use arbitrary strings even though provider-neutral field/operator vocabularies already exist.
  - **Status**: Fixed
  - **Category**: Type Safety
  - **Suggested fix**: Type the properties as readonly `MediaFilterField` and `MediaFilterOperator` arrays and retain a compile-time adapter feature contract.

### LOW

None.

## Validation Results

| Check         | Result                                                                                 |
| ------------- | -------------------------------------------------------------------------------------- |
| Architecture  | Pass: real tree plus 9 seeded violation/allowance tests                                |
| Type check    | Pass: all three workspaces                                                             |
| Tests         | Pass: focused 100-test compatibility gate, full repository suite, and rfmedia coverage |
| Build         | Pass: `npm run build:all` after clean `npm ci`                                         |
| Format        | Pass: repository-wide Prettier check                                                   |
| Markdown lint | Pass for all 20 changed Markdown files; 4 unrelated baseline errors remain on `master` |

## Files Reviewed

- `docs/plans/plex-adapter-refactor/*.md` (Added, 14 design/planning artifacts)
- `packages/rfmedia-cli/src/lib/adapters/plex/*.ts` (Added, 16 private implementation/test files)
- `packages/rfmedia-cli/src/types/media-server.ts` and `media-server.test.ts` (Modified/Added)
- `packages/rfmedia-cli/src/types/media-filters.ts` and `media-filters.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/media-filter-evaluator.ts` and test (Added)
- `packages/rfmedia-cli/src/lib/pagination.ts` and test (Added)
- `packages/rfmedia-cli/src/lib/media-file-paths.ts` and test (Added)
- `packages/rfmedia-cli/src/lib/http-url.ts` (Added)
- `packages/rfmedia-cli/src/lib/adapters/{index,action-helpers,plex-adapter}.ts` and tests (Modified)
- `packages/rfmedia-cli/src/actions/plex-{query,copy,playlist,collection,sync}.ts` and tests/mocks (Modified)
- `packages/rfmedia-cli/src/actions/{filter,playlist}.ts` and affected tests/helpers (Modified)
- `packages/rfmedia-cli/src/commands/plex.test.ts` (Modified)
- `packages/rfmedia-cli/src/mcp/{adapters,schema}.*` (Modified tests/projection boundary)
- `packages/rfmedia-cli/src/types/{config,index,plex,plex-filters}.*` (Modified compatibility types/tests)
- `packages/rfmedia-cli/src/lib/{config,shell-completions/templates.spec}.*` (Modified tests/config)
- `packages/rfmedia-cli/src/lib/plex*.ts` legacy facade/cache/filter/pagination modules and tests (Deleted, 9 files)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and test (Modified/Added)
- `packages/rfmedia-cli/package.json` (Modified validation wiring)
- `packages/rfmedia-cli/README.md` and five feature documents (Modified)
