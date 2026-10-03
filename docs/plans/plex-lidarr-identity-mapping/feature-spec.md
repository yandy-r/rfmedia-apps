# Feature Spec: Plex-Lidarr Identity Mapping

## Executive Summary

Issue #207 adds the read-only identity foundation for later Plex-to-Lidarr workflows. It discovers
bounded Plex artist MusicBrainz identifiers, resolves them against Lidarr artist MBIDs with exact
evidence first, emits review-only fuzzy suggestions, and persists complete scope snapshots for
offline analysis. The implementation extends the provider-neutral media-server adapter, keeps Plex
wire data private, and adds one pure resolver plus one feature-owned SQLite cache. Typed evidence,
full scope keys, strict projection, atomic replacement, and fail-closed expansion impact address
wrong-target identity, cache contamination, hostile GUID payloads, and track-to-album blast radius.

## External Dependencies

### APIs and Services

#### Plex Media Server API

- **Documentation**:
  [Plex API reference](https://developer.plex.tv/pms/)
- **Authentication**: Existing `X-Plex-Token` header through the private origin-bound
  `PlexTransport`.
- **Key endpoint**:
  - `GET /library/sections/{sectionId}/all`: enumerate artists with
    `type=8`, `includeGuids=1`, and bounded pagination.
- **Constraints**: GUID provider syntax and cardinality are untrusted response data. Unknown
  providers are ignored, but malformed or conflicting MusicBrainz artist GUIDs invalidate the
  source identity.

#### Lidarr API

- **Documentation**:
  [Lidarr API documentation](https://lidarr.audio/docs/api/)
- **Authentication**: Existing `X-Api-Key` header through the generated-client transport.
- **Key operation**:
  - Existing `LidarrClientApi.listArtists()`: supplies the local artist ID, title, and
    `foreignArtistId`.
- **Constraints**: The bridge validates `foreignArtistId` as an artist MBID. No generated-client,
  OpenAPI snapshot, or handwritten endpoint change is required.

#### MusicBrainz

- No MusicBrainz network access is in scope. Plex and Lidarr already expose the identifiers needed
  for the artist join.
- A future opt-in integration would require a separate fixed-origin transport, privacy disclosure,
  rate limiting, and independent error handling.

### Libraries and SDKs

| Library               | Version             | Purpose                         | Installation |
| --------------------- | ------------------- | ------------------------------- | ------------ |
| `better-sqlite3`      | Existing lockfile   | Atomic durable snapshot storage | No change    |
| `fastest-levenshtein` | Existing dependency | Suggestion-only name distance   | No change    |

### External Documentation

- [MusicBrainz identifiers](https://musicbrainz.org/doc/MusicBrainz_Identifier): entity-typed MBID
  semantics.
- [Plex API documentation](https://developer.plex.tv/pms/): external GUID and library endpoint
  behavior.

## Business Requirements

### User Stories

**Primary User: rfmedia operator**

- As an operator, I want Plex and Lidarr artists joined by stable MBIDs so that renamed artists do
  not become unrelated entities.
- As an operator, I want ambiguous and fuzzy matches exposed as reviewable evidence so that a name
  similarity cannot silently authorize a wrong Lidarr target.
- As an operator, I want complete identity evidence cached locally so that later read-only
  reconciliation can run during a provider outage.
- As an operator, I want track-to-album expansion quantified so that a later action cannot hide its
  blast radius.

**Secondary User: downstream rfmedia command author**

- As a command author, I want immutable provider-neutral identity, resolution, cache, and expansion
  contracts so that #208, #209, and #221 do not reimplement safety policy.

### Business Rules

1. **Exact typed MBID is the sole automatic identity**
   - Validation: canonicalize a valid MusicBrainz artist UUID to lowercase and require a unique
     one-to-one match across both systems.
   - Exception: none; names never override an MBID conflict.
2. **Name-derived evidence always requires review**
   - Validation: normalized and fuzzy candidates use a versioned `0.90` score floor and `0.08`
     runner-up margin, but the outcome remains `suggested`.
   - Exception: none in #207; no public review surface exists.
3. **Uncertainty is data, not an implicit choice**
   - Validation: return `resolved`, `suggested`, `ambiguous`, `unmatched`, `conflict`, or
     `unavailable` with stable reason codes.
4. **Cache scope is provider-instance complete**
   - Validation: key snapshots by credential-free Plex origin, Plex machine ID, stable Plex
     library section ID, credential-free Lidarr origin, and entity kind.
5. **Cache evidence is read-only**
   - Validation: cached results carry versions and timestamps and may support offline analysis.
     They never authorize a mutation without a future live exact-MBID revalidation.
6. **Expansion is explicit**
   - Validation: calculate distinct source tracks, distinct target albums, known target tracks,
     missing counts, numeric ratio when complete, and `requiresConfirmation`.
7. **The foundation owns no action**
   - Validation: #207 adds no command, prompt, presenter, Lidarr mutation, reconciliation policy,
     or MusicBrainz request.

### Edge Cases

| Scenario                                        | Expected Behavior                   | Notes                             |
| ----------------------------------------------- | ----------------------------------- | --------------------------------- |
| One Plex artist MBID maps to one Lidarr artist  | `resolved` by `exact-mbid`          | Only automatic path               |
| Plex exposes two distinct artist MBIDs          | `conflict`                          | Do not fall through to names      |
| Multiple Lidarr artists share an MBID           | `conflict`                          | Local duplicate is not one-to-one |
| No MBID and one strong separated name candidate | `suggested`                         | Review still required             |
| Top candidates tie or fall within margin        | `ambiguous`                         | Stable bounded candidate list     |
| Complete candidate set has no qualifying name   | `unmatched`                         | Distinct from cache miss          |
| Compatible offline snapshot is absent           | `unavailable`                       | Zero network requests             |
| Cache JSON is corrupt or version-incompatible   | Treat as unavailable evidence       | Never cast to a domain type       |
| One target album has unknown track count        | Ratio is `null` and incomplete      | Future action must fail closed    |
| Duplicate source track or target album IDs      | Count each distinct identifier once | Deterministic set semantics       |

### Success Criteria

- [ ] Plex artist identity acquisition is bounded, paginated, cancellable, and private.
- [ ] Unique exact artist MBIDs resolve automatically; every name-derived result remains
      non-authoritative.
- [ ] Resolver output is immutable, deterministic, bounded, and contains no per-candidate logging.
- [ ] A complete snapshot round-trips through a dedicated v11 SQLite table with strict projection.
- [ ] Scope isolation prevents cross-library, cross-machine, or cross-origin reuse.
- [ ] Expansion impact reports safe distinct counts and incomplete evidence without guessing.
- [ ] No public command, prompt, dependency, generated client, or completion template changes.
- [ ] `plex-alignment` remains reserved and all targeted/full validation is green.

## Technical Specifications

### Architecture Overview

```text
MediaServerAdapter.identity? ──▶ private Plex identity endpoint ──▶ PlexTransport
             │
             ▼
provider-neutral artist identities
             │
             ├──▶ pure bridge resolver ◀── LidarrClientApi.listArtists()
             │                 │
             │                 ├──▶ typed mapping outcomes
             │                 └──▶ pure expansion impact
             ▼
strict complete snapshot ──▶ feature-owned SQLite cache
```

The bridge layer receives projected domain values only. It cannot own `fetch`, import private Plex
modules, import generated Lidarr modules, or construct provider endpoints.

### Data Models

#### `bridge_identity_snapshots`

| Field              | Type      | Constraints              | Description                             |
| ------------------ | --------- | ------------------------ | --------------------------------------- |
| `id`               | `INTEGER` | primary key              | Internal row locator                    |
| `plex_origin`      | `TEXT`    | not null                 | Canonical credential-free Plex origin   |
| `plex_machine_id`  | `TEXT`    | not null                 | Opaque Plex instance discriminator      |
| `plex_library_id`  | `TEXT`    | not null                 | Stable Plex section ID                  |
| `lidarr_origin`    | `TEXT`    | not null                 | Canonical credential-free Lidarr origin |
| `entity_kind`      | `TEXT`    | not null, check `artist` | Entity semantic discriminator           |
| `snapshot_version` | `INTEGER` | not null, positive       | Stored document schema                  |
| `resolver_version` | `INTEGER` | not null, positive       | Resolution policy version               |
| `payload_json`     | `TEXT`    | not null                 | Strictly projected complete snapshot    |
| `captured_at`      | `TEXT`    | not null                 | Canonical ISO timestamp                 |
| `verified_at`      | `TEXT`    | not null                 | Last live exact-evidence observation    |

**Indexes:**

- Unique scope index on
  `(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)`.

**Storage rules:**

- No credentials, raw GUID URLs, paths, response bodies, or debug transcripts.
- The payload is byte-capped before parsing and projected from `unknown` on writes and reads.
- Replacement is a single transactional upsert after the full snapshot validates in memory.

#### Provider-neutral artist identity

| Field         | Type           | Constraints            | Description                      |
| ------------- | -------------- | ---------------------- | -------------------------------- |
| `kind`        | literal        | `artist`               | Prevents cross-entity MBID joins |
| `id`          | string         | bounded, non-empty     | Opaque provider-local item ID    |
| `title`       | string         | bounded, terminal-safe | Display and suggestion evidence  |
| `externalIds` | readonly array | bounded                | Typed canonical external IDs     |

#### Bridge resolution outcome

The immutable discriminated union uses stable states:

- `resolved`: unique exact artist MBID plus exact Lidarr target.
- `suggested`: one separated name candidate; review required.
- `ambiguous`: tied, close, or multiple viable candidates.
- `unmatched`: complete live candidate set produced no qualifying candidate.
- `conflict`: malformed, duplicate, or contradictory authoritative evidence.
- `unavailable`: compatible evidence was not available, such as an offline miss.

Candidates include target local ID, target artist MBID, title, score, and stable ordering evidence.
Similarity is a score, never probability or confidence.

#### Bridge expansion impact

| Field                     | Type             | Constraints               | Description                        |
| ------------------------- | ---------------- | ------------------------- | ---------------------------------- |
| `sourceTrackCount`        | number           | safe non-negative integer | Distinct Plex signals              |
| `targetAlbumCount`        | number           | safe non-negative integer | Distinct affected albums           |
| `knownTargetTrackCount`   | number           | safe non-negative integer | Sum for albums with evidence       |
| `unknownTargetAlbumCount` | number           | safe non-negative integer | Albums missing track totals        |
| `trackExpansionRatio`     | `number \| null` | finite and non-negative   | Target tracks per source track     |
| `complete`                | boolean          | derived                   | All required target counts known   |
| `requiresConfirmation`    | boolean          | derived                   | Non-empty cross-granularity action |

### API Design

There is no public CLI or HTTP API in #207. The internal TypeScript surface is:

```ts
interface MediaServerIdentityCapability {
  getInstanceId(options?: { signal?: AbortSignal }): Promise<string>;
  listArtists(options: {
    library: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<MediaIdentityPage>;
}

function resolveArtistIdentities(input: BridgeArtistResolutionInput): BridgeArtistIdentitySnapshot;

function readBridgeIdentitySnapshot(
  db: DbConnection,
  scope: BridgeIdentityScope,
): BridgeArtistIdentitySnapshot | undefined;

function replaceBridgeIdentitySnapshot(db: DbConnection, snapshot: BridgeArtistIdentitySnapshot): void;

function purgeBridgeIdentitySnapshot(db: DbConnection, scope: BridgeIdentityScope): number;

function calculateBridgeExpansionImpact(input: BridgeExpansionInput): BridgeExpansionImpact;
```

The identity capability is optional on `MediaServerAdapter`, preserving non-Plex adapters and
existing mocks.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/types/bridge.ts`: identity, outcomes, snapshot, cache scope, and
  expansion contracts.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`: private bounded Plex artist GUID
  acquisition and projection.
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`: pure MBID-first resolver and expansion
  calculator.
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`: sole snapshot CRUD and strict payload projector.
- Focused tests beside the three new modules.

#### Files to Modify

- `packages/rfmedia-cli/src/types/media-server.ts`: optional provider-neutral identity capability.
- `packages/rfmedia-cli/src/types/index.ts`: export bridge contracts.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: private bounded GUID wire guards.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: compose the identity capability from
  existing private dependencies.
- `packages/rfmedia-cli/src/lib/schema.sql`: add the v11 snapshot table and scope uniqueness.
- `packages/rfmedia-cli/src/lib/migrations.ts`: migrate v10 databases to v11.
- `packages/rfmedia-cli/src/lib/db.ts`: set current and read-only supported schema version to 11.
- `packages/rfmedia-cli/src/lib/db.test.ts`: verify fresh schema and v10 migration.
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`: optional identity
  test capability.
- Architecture tests as needed to enforce bridge boundaries.
- `ROADMAP.md` and `docs/roadmap-archive.md`: record #207 completion and identify #208 as next.

#### Configuration

- No new configuration, environment variable, dependency, command, flag, or completion entry.

## UX Considerations

### User Workflows

#### Primary Workflow: Exact live analysis

1. **Acquire identities**
   - User: a downstream command selects a configured Plex music library and Lidarr instance.
   - System: existing provider owners return projected artists and typed MBIDs.
2. **Resolve**
   - System: exact one-to-one MBIDs become `resolved`; every uncertainty remains explicit.
3. **Persist**
   - System: the complete validated snapshot atomically replaces the same-scope snapshot.
4. **Success state**
   - The result is ready for read-only comparison and includes evidence required for later live
     revalidation.

#### Error Recovery Workflow

1. **Error occurs**: GUID evidence conflicts, cache data is invalid, or provider evidence is absent.
2. **User sees**: a stable state/reason through the future #208 presenter, not a silently selected
   target.
3. **Recovery**: correct provider metadata, refresh online, or explicitly review an exact target
   MBID through a future review surface.

### UI Patterns

| Component      | Pattern                       | Notes                                     |
| -------------- | ----------------------------- | ----------------------------------------- |
| Resolver       | Pure typed evidence           | Never prompts or writes output            |
| Candidate list | Deterministic bounded ranking | Score and margin, not confidence          |
| Offline miss   | `unavailable`                 | Never misreported as complete `unmatched` |
| Expansion      | Raw counts plus ratio         | `null` ratio when incomplete              |

### Accessibility Requirements

- Untrusted names must be terminal-safe before any future display.
- State must never depend on color alone.
- Stable codes and complete machine data must not require prose parsing.

### Performance UX

- Exact MBID indexes make the primary resolution path linear.
- Fuzzy work is bounded by candidate count, input size, and comparison budget.
- Plex pagination must prove forward progress and honor cancellation.
- Snapshot replacement is one transaction, so readers never observe partial generations.

## Recommendations

### Implementation Approach

**Recommended Strategy**: Build four narrow layers: domain contracts, private Plex acquisition,
pure resolution/expansion, and strict feature-owned persistence. Keep orchestration and
presentation for #208.

**Phasing:**

1. **Phase 1 - Contracts and acquisition**: add provider-neutral identity types and private Plex
   support.
2. **Phase 2 - Resolution and persistence**: implement deterministic mapping plus the v11 snapshot
   cache.
3. **Phase 3 - Integration and verification**: compose the adapter, enforce architecture
   boundaries, update roadmap documentation, and run the full required suite.

### Technology Decisions

| Decision           | Recommendation                               | Rationale                                   |
| ------------------ | -------------------------------------------- | ------------------------------------------- |
| Automatic identity | Unique artist MBID only                      | Prevents wrong-target joins                 |
| Fuzzy policy       | `0.90` floor, `0.08` margin, suggestion only | Conservative and versioned                  |
| Cache model        | One strict snapshot JSON row per scope       | Atomic and KISS for whole-scope consumers   |
| Plex library key   | Stable section ID                            | Names can change and are presentation data  |
| Adapter surface    | Optional provider-neutral capability         | Preserves other providers and current mocks |
| MusicBrainz access | None                                         | Local provider evidence is sufficient       |
| Completion surface | Unchanged                                    | No public command or option is added        |

### Quick Wins

- Reuse the existing Lidarr artist facade unchanged.
- Reuse existing Plex transport, library resolution, pagination, and machine-ID seams.
- Reuse installed SQLite and Levenshtein dependencies.

### Future Enhancements

- Add #208 reconciliation output and explicit offline/stale UX.
- Add an exact-target review/supersession flow after a consumer exists.
- Calibrate suggestion policy against sanitized real-library fixtures.
- Add album or recording identity only after entity semantics are empirically proven.

## Risk Assessment

### Technical Risks

| Risk                               | Likelihood | Impact | Mitigation                                              |
| ---------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Fuzzy result selects wrong artist  | Medium     | High   | Suggestions never become canonical                      |
| Cache reused across server/library | Medium     | High   | Full provider-instance scope key                        |
| GUID payload exhausts resources    | Low        | High   | Array, string, body, and comparison caps                |
| Snapshot schema drifts             | Medium     | Medium | Explicit versions and strict reprojection               |
| Partial refresh becomes durable    | Low        | High   | One validated transactional upsert                      |
| Expansion hides blast radius       | Medium     | High   | Distinct counts, incomplete evidence, confirmation flag |

### Integration Challenges

- Plex artist GUID availability varies by music agent; keep absence typed and non-fatal.
- The existing media adapter has no identity surface; make the new capability optional and
  provider-neutral.
- Existing generic fuzzy matching chooses a winner too readily; implement bridge-local policy.

### Security Considerations

#### Critical — Hard Stops

| Finding                               | Risk                           | Required Mitigation                             |
| ------------------------------------- | ------------------------------ | ----------------------------------------------- |
| Fuzzy evidence authorizes a target    | Wrong Lidarr entity            | Fuzzy remains review-required evidence only     |
| Snapshot authorizes later mutation    | Stale/TOCTOU action            | Future action re-reads exact Lidarr ID and MBID |
| Track evidence silently expands scope | Excess acquisition or mutation | Seal counts and require downstream confirmation |

#### Warnings — Must Address

| Finding                        | Risk                                | Mitigation                                    | Alternatives           |
| ------------------------------ | ----------------------------------- | --------------------------------------------- | ---------------------- |
| Untrusted Plex GUIDs           | Conflict, injection, resource abuse | Private bounded strict projection             | None                   |
| Bare UUID crosses entity kinds | Semantic misjoin                    | Artist-tagged MBIDs                           | None                   |
| Incomplete cache scope         | Cross-instance contamination        | Origin, machine, library, kind, target origin | None                   |
| Cast parsed cache JSON         | Poisoned domain state               | Parse `unknown`, byte-cap, strict projector   | Treat as miss          |
| Raw fuzzy logging              | Metadata disclosure                 | Pure no-log scorer                            | Count-only diagnostics |
| Mixed-generation cache write   | Incoherent offline result           | Validate first, transactional upsert          | Retain old snapshot    |

#### Advisories — Best Practices

- Keep credentials, raw URLs, paths, raw GUID arrays, and provider bodies out of storage.
- Return fresh frozen values from both live and cached projection.
- Keep bridge network-free and preserve sole authenticated transport owners.
- Enforce owner-only tracking database directory/file behavior through existing database tests;
  if a deployment cannot meet it, treat cached collection metadata as privacy-sensitive.

## Task Breakdown Preview

### Phase 1: Contracts and Plex identity

**Focus**: establish the provider-neutral domain and bounded private acquisition.

**Tasks**:

- Add bridge and media identity types.
- Add private Plex wire projection and endpoint family.
- Compose and test the optional adapter capability.

**Parallelization**: domain/resolver contracts and Plex acquisition can begin concurrently with
explicit file ownership.

### Phase 2: Resolution, expansion, and cache

**Focus**: implement pure evidence and durable offline replay.

**Dependencies**: bridge contracts from Phase 1.

**Tasks**:

- Implement and table-test MBID-first resolution and suggestion ranking.
- Implement and test expansion impact.
- Add schema v11, strict snapshot cache, migrations, and integration tests.

### Phase 3: Integration and delivery

**Focus**: prove boundaries and repository-wide compatibility.

**Tasks**:

- Extend architecture/security checks where required.
- Update the roadmap and archive.
- Run focused, package, root, codegen, architecture, completion-parity, and pre-push validation.

## Decisions Needed

No blocking product decision remains for #207.

1. **Plex library scope**
   - Decision: use the stable section ID in the cache key; retain configured name only outside the
     identity key.
2. **Initial fuzzy defaults**
   - Decision: version a `0.90` floor and `0.08` separation margin as suggestion policy, not an
     identity guarantee.
3. **Reviewed overrides**
   - Decision: defer persistence of reviewed fuzzy overrides until #208 or a later review consumer
     defines an explicit exact-target workflow.
4. **Cache corruption**
   - Decision: low-level cache operations throw a typed bounded error; an online caller may retain
     its live read-only result while reporting degraded durability.

## Research References

- [research-external.md](./research-external.md): external provider and MBID details.
- [research-business.md](./research-business.md): business rules and value.
- [research-technical.md](./research-technical.md): repository architecture and implementation.
- [research-ux.md](./research-ux.md): evidence states, offline semantics, and expansion UX.
- [research-security.md](./research-security.md): severity-leveled safety findings.
- [research-practices.md](./research-practices.md): modularity, reuse, testing, and KISS analysis.
- [research-recommendations.md](./research-recommendations.md): consolidated decisions.
