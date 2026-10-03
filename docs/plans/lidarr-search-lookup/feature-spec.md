# Feature Spec: Lidarr Search and Lookup

## Executive Summary

Issue #222 adds a read-only identity-resolution suite for Lidarr artists and albums before later
write workflows. It exposes combined search plus typed artist and album lookup through the existing
private generated client, hardened transport, `metadata-dependent` execution lane, and persistent
resilience cache. Results preserve upstream relevance order, use strict generated-independent
projections, and apply deterministic client-side `--offset`/`--limit` paging because Lidarr's lookup
endpoints are unpaginated. Live Lidarr remains the only network provider; stale SQLite fallback is
available only with explicit `--allow-stale` consent and always reports provenance and degradation.

## External Dependencies

### APIs and Services

#### Lidarr local API

- **Documentation**:
  [official OpenAPI document](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json)
- **Authentication**: existing `X-Api-Key` header through the repository's sole Lidarr transport
- **Endpoints**:
  - `GET /api/v1/search?term=...`: combined artist-or-album search
  - `GET /api/v1/artist/lookup?term=...`: typed artist lookup
  - `GET /api/v1/album/lookup?term=...`: typed album lookup
- **Paging**: none; every endpoint returns one complete array
- **Reliability**: metadata-dependent through Lidarr's hosted metadata service
- **Rate limits**: no stable numeric local/provider quota is published; existing 429,
  `Retry-After`, and metadata-circuit behavior remains authoritative

#### Local SQLite tracking database

- Reuse `lidarr_metadata_cache`; no schema migration is required.
- Cache rows remain scoped by credential-free canonical Lidarr origin, category, and
  discriminator.
- API keys and cleartext query terms must not enter keys or payloads.

### Libraries

No new runtime dependency is required. The pinned generated SDK already contains
`getApiV1Search`, `getApiV1ArtistLookup`, and `getApiV1AlbumLookup`. Reuse Node's built-in
cryptography for the cache discriminator, Commander for parsing, the shared output formatters, and
the existing scheduler/cache/database modules.

### External Documentation

- [Lidarr metadata incident #5498](https://github.com/Lidarr/Lidarr/issues/5498): current text
  search reliability context
- [Generated client guide](../../../packages/rfmedia-cli/docs/features/lidarr-generated-client.md):
  ownership and regeneration rules
- [Execution lanes](../../../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md):
  metadata-dependent admission and retry rules

## Business Requirements

### User Stories

- As an operator, I can search artists and albums by text or MusicBrainz identifier before choosing
  a later write operation.
- As an operator, I can select a typed lookup when combined search is ambiguous.
- As automation, I receive stable foreign identifiers, result kinds, ranks, paging fields,
  execution metadata, and source provenance.
- As an operator during an outage, I may explicitly accept an exact cached result rather than
  receiving silent stale substitution.
- As a maintainer, I can add the feature without exposing generated DTOs, handwritten API paths,
  another Fetch owner, or a new dependency.

### Business Rules

1. **Command surface**:
   - `rfmedia lidarr search <term>`
   - `rfmedia lidarr lookup artist <term>`
   - `rfmedia lidarr lookup album <term>`
2. **Command identifiers**: `lidarr-search`, `lidarr-lookup-artist`, and
   `lidarr-lookup-album`.
3. **Shared options**: `--limit`, `--offset`, `--allow-stale`, `--lidarr-url`, and
   `--lidarr-api-key`.
4. **Input contract**: outer-trim and NFC-normalize the term; require 1–256 Unicode code points and
   at most 1,024 UTF-8 bytes; reject C0/C1 and bidi controls before any client or cache I/O.
5. **Exact identifiers**: accept `lidarr:`, `lidarrid:`, and `mbid:` prefixes
   case-insensitively, validate the UUID locally, and canonicalize to
   `lidarr:<lowercase-uuid>`.
6. **Ordering**: preserve upstream order, deduplicate by `(kind, foreignId)` with first result
   winning, assign one-based rank, then page.
7. **Bounds**: validate at most 1,000 upstream records; default `limit=50`, enforce
   `limit=1..200`, and require a safe non-negative `offset`.
8. **Empty results**: `200 []` and an offset beyond the final result are successful empty outputs,
   never outage signals.
9. **Fallback**: live Lidarr is always attempted first. Cache fallback requires
   `--allow-stale`, an exact row inside the stale ceiling, and an eligible typed failure.
10. **No mutation**: search never adds, edits, monitors, refreshes, downloads, deletes, or enters
    plan/apply.

### Edge Cases

| Scenario                                                      | Expected behavior                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| Malformed prefixed MBID                                       | Local `validation` failure with zero network/cache I/O      |
| Valid unmatched MBID                                          | Successful empty result                                     |
| Ambiguous combined result                                     | Preserve explicit `kind`; never infer from display fields   |
| Response-local combined `id`                                  | Ignore as durable identity; use foreign ID                  |
| Malformed or oversized response                               | Atomic `invalid-response`; no partial output or cache write |
| Offset past total                                             | Empty page, true totals, exit 0                             |
| Metadata outage without cache consent                         | Typed failure, exit 1                                       |
| Eligible outage with exact cache hit and consent              | Degraded success with source, age, and reason               |
| Authentication, rate limit, cancellation, or invalid response | Never fall back                                             |
| Cache corruption or database failure                          | Preserve the original live result or original typed error   |

### Success Criteria

- All three command paths call their exact generated operation through the stable facade.
- Human and machine output preserve stream discipline and deterministic ordering.
- Query-keyed cache isolation is proven across origin, mode, term, and projection version.
- Bash, Zsh, and Fish completions cover every new path and option.
- No dependency, direct external provider, generated import leak, handwritten `/api/v1/` path, or
  additional production Fetch owner is introduced.

## Technical Specifications

### Architecture

```text
Commander leaves
  -> one mode-parameterized search action
    -> metadata-dependent scheduler + shared preflight + terminal fallback
      -> live resilient Lidarr facade (no internal gate/retry/stale serve)
        -> strict lookup/search projection
          -> private generated operation
            -> hardened authenticated transport
              -> local Lidarr -> hosted metadata service
      -> dedupe/rank complete projection -> query-keyed SQLite cache
      -> terminal cache read only after preflight rejection or retry exhaustion
  -> human presenter or deterministic machine projection
```

The command layer parses and renders. The action owns mode selection, scheduling, paging metadata,
and result provenance. A pure search helper owns normalization, cache identity, dedupe/rank, and
local slicing. `client.ts` alone selects generated operations. Runtime projectors validate unknown
wire data into narrow immutable domain values. The resilience execution context owns the shared
breakers, non-fatal full-projection cache writes, exact terminal cache reads, cached-value
revalidation, and the sole stale warning.

Add a composition-root resolver returning a live resilient client, scheduler preflight, cache
writer, and terminal fallback that share the same raw facade, canonical origin, policy, and
persisted circuit breakers. The scheduler owns preflight, live retries, terminal-fallback timing,
and success attempt metadata. Scheduled live calls disable resilient health gating, in-place
retries, and stale serving; after preflight rejection or retry exhaustion the scheduler invokes the
exact query fallback at most once. This avoids fake preflights, early stale substitution, duplicate
health probes, and competing retry/circuit owners.

### Data Models

```typescript
type LidarrSearchMode = "search" | "artist" | "album";

interface LidarrSearchQuery {
  readonly mode: LidarrSearchMode;
  readonly term: string;
  readonly signal?: AbortSignal;
}

type LidarrSearchCandidate =
  | {
      readonly kind: "artist";
      readonly foreignId: string;
      readonly name: string;
      readonly rank: number;
      readonly lidarrId?: number;
      readonly disambiguation?: string;
      readonly artistType?: string;
    }
  | {
      readonly kind: "album";
      readonly foreignId: string;
      readonly name: string;
      readonly rank: number;
      readonly lidarrId?: number;
      readonly artistName?: string;
      readonly artistForeignId?: string;
      readonly albumType?: string;
      readonly releaseDate?: string;
    };

interface LidarrSearchActionResult {
  readonly query: { readonly mode: LidarrSearchMode; readonly term: string };
  readonly results: readonly LidarrSearchCandidate[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly provider: {
    readonly requested: "lidarr";
    readonly used: "lidarr" | "sqlite-cache";
    readonly degraded: boolean;
    readonly fallbackReason?: string;
  };
  readonly cacheStatus?: LidarrCacheStatus;
  readonly execution: LidarrExecutionSuccessMetadata;
}
```

Lookup candidates are not installed-library records. Positive local Lidarr IDs are optional;
profiles, paths, tags, images, links, tracks, releases, and generated types do not cross the
facade.

### API Design

#### Facade methods

```typescript
interface LidarrClientApi {
  search(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
  lookupArtists(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
  lookupAlbums(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
}
```

The facade fetches and projects the complete array. The action applies rank, dedupe, and page
shaping above the client. New methods must be added explicitly to the resilience wrapper, scheduler
retry classification, typed mock builder, generator requirements, and generated contract tests.

#### Cache identity

```text
origin x category "lookup" x discriminator
discriminator = "v1:" + mode + ":" + sha256(NFC-normalized-term)
```

Cache complete validated/deduplicated/ranked pre-page projections after successful live shaping,
including valid empty arrays. Revalidate cached values before use. Paging is not part of the key.
Reuse the configured 900-second default TTL and 86,400-second stale ceiling; zero disables caching.
Never consult stale cache between scheduler attempts.

#### Machine output

JSON and YAML preserve the existing `{ "command": "...", "result": { ... } }` Lidarr convention;
do not add an inconsistent top-level schema version. The result carries query, records, paging,
provider, optional cache status, and execution. CSV uses a fixed flat summary row followed by
candidate rows so an empty result still retains query, paging, provenance, and execution data.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-search.ts`
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- `packages/rfmedia-cli/src/actions/lidarr/search.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`
- `packages/rfmedia-cli/src/lib/lidarr/search.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`

#### Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts` and command tests
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` and test helpers
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`, `types.ts`, `index.ts`, `resilience.ts`,
  `metadata-cache.ts`, `scheduler.ts`, and their tests
- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`
- Bash, Zsh, and Fish completion templates plus `templates.spec.ts`
- `packages/rfmedia-cli/README.md`, `ROADMAP.md`, and `docs/roadmap-archive.md`

## UX Considerations

### User Workflows

#### Combined search

1. Run `rfmedia lidarr search "Massive Attack"`.
2. Validate the term and connection before dispatch.
3. Execute one metadata-dependent lookup.
4. Render ranked artist/album rows with an explicit kind and foreign ID.
5. Show paging, provider, and execution summaries.

#### Typed lookup

1. Run `rfmedia lidarr lookup artist "mbid:<uuid>"` or the album equivalent.
2. Validate/canonicalize the exact identifier.
3. Call only the matching typed endpoint.
4. Return typed records without combined-search ambiguity.

#### Error recovery

1. A provider/circuit/timeout failure occurs.
2. Without consent, show the classified error and recovery hint.
3. With `--allow-stale`, consult only the exact query cache row.
4. On hit, return exit 0 with a visible stale warning and structured provenance.
5. On miss/corruption, preserve the original error and exit 1.

### UI Patterns

Human output uses a safely bounded query heading, ranked table, paging footer, provider/degradation
line, and the existing execution summary. Artist rows show rank, artist, type, disambiguation, and
MBID. Album rows show rank, album, artist, type, release date, and MBID. Combined output adds kind.
Human output goes to stderr; machine documents are the only stdout content.

### Accessibility Requirements

- Never encode kind, freshness, degradation, or success using color alone.
- Reject or sanitize terminal controls and bidi controls in both query and provider text.
- Preserve full identifiers and apply display-width-aware truncation only to descriptive fields.
- Machine output contains no ANSI escape sequences.
- Shell completions are static; never make network requests to complete queries or identifiers.

## Recommendations

### Implementation Approach

1. **Boundary first**: domain types/projectors, three facade methods, generator fail-closed
   requirements, mocks, and client tests.
2. **Execution second**: pure search helper, shared preflight/client/cache context, scheduler
   terminal fallback, resilience maps, one action, and focused tests.
3. **Surface last**: command factory/presenters, deterministic machine/CSV shapes, docs, all shell
   completions, ROADMAP/archive, and end-to-end regression tests.

### Technology Decisions

| Decision             | Recommendation                        | Rationale                                              |
| -------------------- | ------------------------------------- | ------------------------------------------------------ |
| Network provider     | Lidarr only                           | #220/#203/#204 own direct/federated providers          |
| Runtime dependency   | None                                  | Generated operations and repo primitives already exist |
| Paging               | Client-side offset/limit              | Upstream endpoints are unpaginated                     |
| Ranking              | Preserve upstream order               | No stable score or cross-kind sort exists              |
| Cache                | Full validated projection, live-first | Consistent totals and explicit degradation             |
| Cache key            | Versioned SHA-256 query discriminator | Origin/mode isolation without query history            |
| Retry/fallback owner | Scheduler                             | Exhaust live attempts before one stale lookup          |
| Machine envelope     | Existing `{command,result}`           | Preserve Lidarr CLI consistency                        |

### Future Enhancements

- #203: similar-artist discovery and explicit add handoff
- #204: federated providers, provider ranking/merging, and Plex seeds
- #220: configurable/direct metadata-provider strategy
- #223: installed-library album filtering and mutations

## Risk Assessment

### Technical Risks

| Risk                              | Likelihood | Impact | Mitigation                                                     |
| --------------------------------- | ---------- | ------ | -------------------------------------------------------------- |
| Duplicate health probes/retries   | Medium     | High   | Shared execution context and scheduler-only retries            |
| Metadata service outage           | High       | Medium | Metadata lane, circuit, typed failure, explicit cache fallback |
| Malformed/oversized provider data | Medium     | High   | Transport body cap, 1,000-row cap, atomic strict projection    |
| Query/cache collision             | Low        | High   | Origin + mode + versioned SHA-256 discriminator                |
| Stale result mistaken for live    | Medium     | High   | Consent, stderr warning, structured provenance                 |
| Command/completion drift          | Medium     | Medium | Exact all-shell parity tests and generated contract gates      |

### Security Considerations

#### Critical — Hard Stops

- API keys must remain header-only after origin validation and must never enter URLs, redirects,
  logs, errors, output, cache keys, or payloads.

#### Warnings — Must Address

- Validate query/options before I/O, revalidate cached payloads, atomically reject malformed
  responses, neutralize CSV formulas, preserve stdout/stderr discipline, and bound exact network
  attempts.

#### Advisories — Best Practices

- Opportunistically prune stale query rows and consider future per-origin cache caps if real usage
  shows growth.
- Track existing dependency audit findings separately; #222 adds no package and does not parse
  provider YAML.

## Task Breakdown Preview

### Phase 1: Stable Boundary

- Add candidate/query domain types and strict projectors.
- Add generated-operation requirements, facade methods, mocks, and contract/client tests.
- Parallelization: domain projection work and generator contract work can proceed independently
  until client integration.

### Phase 2: Execution and Resilience

- Add pure normalization/dedupe/rank/page/cache-key helpers.
- Add the shared execution context, query-aware cache flow, scheduler terminal fallback, and
  resilience method metadata.
- Add the mode-parameterized scheduled action and focused action/cache/resilience tests.
- Dependency: Phase 1 facade and types.

### Phase 3: CLI, Docs, and Release Gates

- Add command tree, human presenter, machine/CSV projections, and command tests.
- Update Bash/Zsh/Fish completions and parity tests.
- Add user guide/README, archive #222 in ROADMAP history, and run focused plus full validation.
- Dependency: Phase 2 action contract.

## Decisions Needed

All blocking design decisions are resolved:

1. Use the three command paths listed above, not a provider/type flag surface.
2. Use a 256-code-point and 1,024-byte query cap.
3. Keep live-first behavior; cache is failure fallback only.
4. Use the existing machine envelope with no new top-level schema version.
5. Ship no direct external provider or new dependency.

The only deferred operational question is whether real query volume later justifies a cache row/byte
cap; it does not block #222.

## Research References

- [External API research](./research-external.md)
- [Business requirements](./research-business.md)
- [Technical design](./research-technical.md)
- [UX research](./research-ux.md)
- [Security analysis](./research-security.md)
- [Engineering practices](./research-practices.md)
- [Recommendations](./research-recommendations.md)
