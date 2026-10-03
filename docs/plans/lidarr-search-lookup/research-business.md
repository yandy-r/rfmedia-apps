# Business Research — Lidarr Search and Lookup

## Executive Summary

Issue [#222](https://github.com/yandy-r/rfmedia-apps/issues/222) should expose Lidarr's existing
artist, album, and mixed metadata lookups as first-class, read-only `rfmedia` workflows. Its value
is a scriptable identity-resolution step before later add/edit workflows, with explicit handling of
Lidarr's fragile remote metadata dependency.

Recommend `lidarr search <term>` for mixed results and `lidarr lookup artist|album <term>` for typed
lookup. All run in the shipped `metadata-dependent` lane, preserve upstream order, page bounded
results client-side, and emit stable provider/execution evidence. Successful whole result sets are
cached by query; fallback requires `--allow-stale`. Direct MusicBrainz/Last.fm/configurable-provider
support remains out of scope under #220/#204.

## User Stories

- As an operator, I can search artists/albums by text or MusicBrainz ID before taking write action.
- As an operator, I can choose a typed lookup when mixed search would be ambiguous.
- As automation, I can page deterministic results and distinguish no match from provider failure.
- As automation, I receive stable foreign IDs, entity kinds, source, cache age, and error codes.
- As an operator during an outage, I may explicitly accept an exact cached result.
- As an operator who did not consent, I never receive silent stale substitution.
- As a maintainer, I can add lookup coverage without exposing generated DTOs or handwritten paths.

## Scope

### In Scope

- `GET /api/v1/search`, `/artist/lookup`, and `/album/lookup`.
- Plain-text and supported exact MusicBrainz-ID queries.
- Narrow artist/album projections, client-side paging, deterministic machine output.
- Metadata health gate, scheduler/circuit behavior, query cache, and explicit fallback.
- Human output, global JSON/YAML/CSV behavior, tests, docs, and shell completions.

### Out of Scope

- Similar-artist discovery, ranking, provider merging, or Plex seeds (#203/#204).
- Direct MusicBrainz/Last.fm/ListenBrainz calls or configurable endpoint order (#220).
- Adds, metadata refresh, indexer searches, monitoring, edits, deletes, or plan/apply.
- Album library management (#223), search history, or interactive selection.
- Server-side pagination or relevance scores that Lidarr does not expose.

## Business Rules

### Command Contract

| Command                               | Mode     | Upstream operation | Machine ID             |
| ------------------------------------- | -------- | ------------------ | ---------------------- |
| `rfmedia lidarr search <term>`        | `all`    | `/search`          | `lidarr-search`        |
| `rfmedia lidarr lookup artist <term>` | `artist` | `/artist/lookup`   | `lidarr-lookup-artist` |
| `rfmedia lidarr lookup album <term>`  | `album`  | `/album/lookup`    | `lidarr-lookup-album`  |

Each supports `--limit`, `--offset`, `--allow-stale`, `--lidarr-url`, and
`--lidarr-api-key`. Defaults: `limit=50`, `offset=0`; limit is 1–200 and offset is a
non-negative safe integer.

### Query Semantics

1. The required term is outer-trimmed and otherwise sent unchanged.
2. It must contain 1–512 Unicode code points and no C0/C1, bidi-control, or NUL characters.
3. Plain text uses upstream matching; rfmedia adds no fuzzy threshold, score, or re-ranking.
4. Exact prefixes are case-insensitive: `lidarr:`, `lidarrid:`, and `mbid:`. The suffix must be one
   UUID with optional outer whitespace and no embedded whitespace.
5. Mixed exact-ID search retains Lidarr's artist-first then album behavior. Typed lookup removes
   that ambiguity.
6. A malformed prefixed query fails locally as `validation`; a valid unmatched ID succeeds empty.
7. `200 []` is “no results,” never an outage and never a fallback trigger.

### Ordering, Identity, and Paging

1. Preserve Lidarr order and assign one-based `rank` before paging.
2. Deduplicate by `(kind, foreignId)`, preserving the first occurrence.
3. `foreignId` is authoritative; missing/malformed foreign IDs fail as `invalid-response`.
4. Pagination slices the complete projected set and causes no additional provider request.
5. Return `total`, `offset`, `limit`, `returned`, and `hasMore`.
6. `returned === results.length`; `hasMore === offset + returned < total`.
7. Offset past the end succeeds with an empty page and `hasMore=false`.
8. Validate at most 1,000 projected upstream entries. Oversize responses fail atomically.
9. Do not offer sorting: local sorting would misrepresent upstream relevance.

## Stable Result Contract

Every result has `rank`, `kind` (`artist|album`), `foreignId`, and `name`. Optional `lidarrId`
appears only for a positive local ID; optional `disambiguation` is bounded. Artist rows may add
`artistType`/`status`; album rows may add `artistName`, `artistForeignId`, `albumType`, and ISO
`releaseDate`.

Exclude paths, overviews, images/URLs, tracks, releases, profiles, tags, add options, and generated
DTOs. Project into fresh bounded objects; omit absent optional fields rather than emitting `null`.

JSON/YAML use `{command,result}`. Result contains `query`, `results`, all five paging fields,
`provider`, optional `cacheStatus`, and the existing `execution` object. Query contains the echoed
trimmed `term`, `mode` (`all|artist|album`), and `exactId`. Provider contains `requested`, `used`,
and `degraded`.

CSV uses existing dot-path flattening and JSON compound cells. Human tables go to stderr; machine
formats use stdout only. Command IDs, field names, enums, omission rules, and paging meanings are
compatibility contracts.

## Cache and Provider Fallback

1. `lidarr` is #222's only live source; `sqlite-cache` is its only shipped fallback.
2. Do not silently call any direct external provider. Future #220 sources must preserve this domain
   shape and report their own source ID.
3. Cache every successful complete projected result set, including valid empty sets, before paging.
4. Key by canonical origin × mode × versioned normalized term. Normalization outer-trims and
   case-folds but does not collapse internal whitespace. Paging is not part of the key.
5. Store projections only—never generated responses, API keys, credential URLs, or error bodies.
6. Reuse `cacheTtlSeconds` (900 default) and `cacheStaleMaxAgeSeconds` (86,400 default).
7. Normal execution attempts Lidarr first; cache is degradation, not hidden read-through behavior.
8. Cache-write failure warns but does not fail a successful lookup.

Fallback requires all of:

- `--allow-stale`;
- an exact cache entry within the stale ceiling; and
- `metadata-provider-unavailable`, `lidarr-unreachable`, or `timeout`.

Never fall back for rate limiting, validation, configuration, authentication, authorization,
not-found, invalid-response, or cancellation. A degraded success reports `used=sqlite-cache`,
`degraded=true`, the classified `fallbackReason`, and the existing `cacheStatus` fields `source`,
`fetchedAt`, and `ageSeconds`.

Corrupt/expired/wrong-origin cache is a miss and cannot mask the original error.

## Failure and Recovery Rules

1. Validate inputs before client or cache I/O.
2. Resolve scheduler/client as `metadata-dependent`, with the scheduler as retry owner.
3. Run the required metadata health/circuit preflight, then exactly one generated lookup operation.
4. A known metadata outage is `metadata-provider-unavailable`; local connection/5xx/timeout remains
   `lidarr-unreachable`/`timeout` unless health evidence identifies the upstream provider.
5. Preserve `rate-limited` and `retryAfterSeconds`; do not hide quota pressure with cache.
6. Authentication/configuration failures never fall back and provide actionable errors.
7. Malformed JSON/union members/unsafe strings/oversize collections fail the entire response as
   `invalid-response`; partial results are forbidden.
8. Caller cancellation stops request/wait and cannot fall back.
9. Machine failures retain `{command,error}` with lane, attempts, failure type, status,
   retryability, and retry-after. Text failures retain the existing stderr contract and exit 1.
10. Valid empty output exits 0. Failed live lookup with accepted cache exits 0 but is visibly
    degraded.

## Existing Codebase Integration

- `src/commands/lidarr.ts`: hierarchy, validation, rendering, output/error parity.
- `src/actions/lidarr/search.ts`: one mode-parameterized scheduled action and page projection.
- `src/lib/lidarr/client.ts`: stable facade over generated lookup operations.
- `src/lib/lidarr/types.ts`: strict wire guards and narrow projections.
- `src/lib/lidarr/errors.ts`: local-versus-metadata taxonomy authority.
- `src/lib/lidarr/resilience.ts`: explicitly allowlist new idempotent methods.
- `src/lib/lidarr/metadata-cache.ts`: add origin/mode/query cache category/discriminator.
- `src/lib/lidarr/tiers.ts`: reuse the existing `metadata-dependent` contract.
- Shell-completion templates: add every new command path and flag with parity tests.

## Compatibility Requirements

1. Preserve Node 22+, strict TypeScript, ESM/NodeNext, build, and package contracts.
2. Use generated operations; add no handwritten `/api/v1` path or production fetch owner.
3. Preserve origin-bound header auth, redirect rejection, abort/timeout, body limits, and redaction.
4. Keep generated modules private and introduce no required config or runtime dependency.
5. Preserve existing Lidarr commands, flags, output fields, cache/error meanings, and plan/apply.
6. Preserve `--json` and global `--output json|yaml|csv|table|text` behavior.
7. Never emit API keys, raw bodies, DB paths, credential URLs, or unsafe terms.

## Success Metrics and Acceptance Criteria

1. The three pinned lookup operations are covered by fixture-based client/action/command tests.
2. Same fixture/options produce stable machine structure and CSV columns.
3. Tests cover text/ID queries, artist-first ambiguity, order, dedupe, empty results, paging
   invariants, offset past end, invalid/oversize response, and cancellation.
4. Every success identifies source; every fallback identifies reason, age, and degraded state.
5. Tests prove no fallback without consent, cross origin/mode/query, or for non-eligible failures.
6. Whole pre-page results—including empty results—are cached by origin/mode/normalized query.
7. Failure categories remain distinguishable in human and machine modes.
8. The feature performs zero mutations and zero direct external-provider calls.
9. Existing Lidarr tests, typecheck, build, architecture gates, formatters, and completions pass.
10. User docs and Bash/Zsh/Fish completions cover the complete surface.

## Gotchas and Edge Cases

- Mixed ID search is artist-first upstream; rfmedia must not infer entity type.
- Endpoints are unpaged arrays; output paging cannot reduce upstream response cost.
- Search ranks may change with upstream metadata. Determinism preserves one response, not relevance
  across time.
- Cache mode is part of identity; mixed results cannot satisfy artist-only lookup.
- Empty results are cacheable only after a successful provider response.
- Health may be green immediately before an upstream failure; endpoint errors still feed circuits.
- OpenAPI fields are broadly optional; generated types do not replace runtime validation.

## Relevant Docs

- [Issue #222](https://github.com/yandy-r/rfmedia-apps/issues/222)
- [Integration research](../../../research/rfmedia-lidarr-integration/report.md)
- [Metadata resilience design](../lidarr-metadata-resilience/design.md)
- [Execution lanes](../../../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md)
- [Generated client](../../../packages/rfmedia-cli/docs/features/lidarr-generated-client.md)
- [Pinned OpenAPI manifest](../../../packages/rfmedia-cli/openapi/lidarr-v1.manifest.json)
- [Pinned upstream search](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Search/SearchController.cs)
- [Pinned upstream lookup semantics](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/NzbDrone.Core/MetadataSource/SkyHook/SkyHookProxy.cs)

## Open Questions

- None blocks planning. If product owners prefer flat `search --type`, decide before implementation
  because command IDs/completions are compatibility surfaces; nested typed lookup is recommended.
- Direct provider fallback should be revisited only under #220 with attribution, rate limits,
  result equivalence, and telemetry designed together.
