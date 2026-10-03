# Integration Analysis: Issue 208 Plex-Lidarr Reconciliation

## Executive Summary

Issue #208 should compose the provider-neutral Plex identity capability, the handwritten Lidarr
facade, and the pure #207 bridge resolver into a report-first `rfmedia lidarr reconcile` workflow.
The online path can enumerate both artist catalogs today, but the persisted v1 bridge snapshot is
not sufficient for the required offline bidirectional report: it stores Plex-side outcomes and only
a Lidarr artist count, so it cannot reconstruct `lidarr_only`; exact cache reads also require Plex
machine/library IDs that cannot be discovered while offline.

The default command must remain read-only with respect to Plex and Lidarr. Name matches, cached
evidence, duplicates, and gap membership are suggestions, never mutation authority; any corrective
write must use the existing sealed Lidarr plan/apply lifecycle and revalidate a unique exact MBID
against live provider state. The live GitHub issue currently has no child issues, but children are
required if all stated acceptance criteria remain in scope: one prerequisite for a complete,
discoverable offline snapshot contract, one for the report/action/CLI integration, and a separate
mutation child only if #208 must execute corrections rather than merely suggest existing
plan/apply commands.

## API Endpoints

### Plex Media Server

| Purpose                | Request                                                                                                                     | Existing owner                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Resolve music library  | `GET /library/sections`                                                                                                     | `lib/adapters/plex/query-library.ts`          |
| Resolve server scope   | `GET /identity`                                                                                                             | private machine-ID seam in `query-library.ts` |
| Page artist identities | `GET /library/sections/{sectionId}/all?type=8&includeGuids=1&X-Plex-Container-Start={offset}&X-Plex-Container-Size={limit}` | `lib/adapters/plex/identity.ts`               |

- `MediaServerAdapter.identity` is optional. Reconciliation must fail with a stable unsupported
  capability result when it is absent; it must not import Plex-private modules to bypass the
  provider-neutral boundary.
- `identity.listArtists()` resolves the configured library name to its stable section ID, validates
  bounded pages, and exposes projected artist IDs/titles plus MusicBrainz artist GUIDs. The action
  must page until `hasMore === false`, require forward progress, deduplicate opaque Plex IDs, and
  refuse to emit a complete gap report from a partial enumeration.
- `identity.getInstanceId()` and the returned `libraryId` supply the cache scope. Every call accepts
  an `AbortSignal`.
- `PlexClient` remains the only authenticated Fetch owner. It binds requests to the configured
  origin, sends `X-Plex-Token` only as a header, rejects redirects and sensitive query material,
  bounds bodies, composes timeout/caller cancellation, and emits typed sanitized
  `MediaServerError`s.

### Lidarr

| Purpose                                              | Request                                        | Existing facade method                            |
| ---------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Enumerate installed artists                          | `GET /api/v1/artist`                           | `LidarrClientApi.listArtists(signal?)`            |
| Revalidate an exact target                           | `GET /api/v1/artist?foreignArtistId={mbid}`    | `getArtistByForeignId(mbid, signal?)`             |
| Resolve an add candidate                             | `GET /api/v1/artist/lookup?term=lidarr:{mbid}` | `lookupArtists({ mode: "artist", term, signal })` |
| Add an artist, if separately planned                 | `POST /api/v1/artist`                          | `addArtist(input, signal?)`                       |
| Read/alter an existing artist, if separately planned | `GET/PUT/DELETE /api/v1/artist/{id}`           | existing facade mutation methods                  |

- Reconciliation consumes `listArtists()` only for its live report. `LidarrArtist` already projects
  the local ID, `foreignArtistId`, monitored state, profiles, path, tags, and optional
  `statistics.trackFileCount`/`sizeOnDisk`; the last fields can qualify a `lidarr_only` item as
  files-present/files-absent without adding an album scan.
- Handwritten bridge/action modules must not import `lib/lidarr/generated/**`, construct
  `/api/v1/` paths, or own Fetch. `lib/lidarr/client.ts` is the sole generated SDK importer and
  strictly projects all responses.
- The local artist list is a `local-only` Lidarr operation. Run it through the existing scheduler
  with retries disabled or explicitly bounded, and pass the scheduler signal through the facade.
  The Plex read is outside the Lidarr scheduler but must share the same caller/global signal.

### Reconciliation result contract

`lib/bridge/reconcile.ts` should be pure and deterministic. Its input must contain a complete
identity snapshot plus the complete projected Lidarr artist catalog (live or durably cached), and
its output should include:

- `matched` grouped by authoritative `exact-mbid` and review-only `normalized-name` /
  `fuzzy-name` suggestion bands;
- `plex_only` from `unmatched` outcomes, while `ambiguous`, `conflict`, and `unavailable` remain
  separate uncertainty categories rather than false gaps;
- `lidarr_only` by subtracting **only unique exact-MBID resolved Lidarr IDs** from the complete
  Lidarr catalog; fuzzy suggestions must not remove a target from this set without explicit review;
- optional duplicate groups from duplicate Plex MBIDs, duplicate Lidarr MBIDs, normalized-name
  collisions, or case/article variants, with stable reason codes and bounded candidates;
- completeness, provenance (`live` or `sqlite-cache`), capture/verification timestamps, cache age,
  and deterministic summary counts.

“Match confidence” should be represented as evidence categories and similarity scores, not as
probabilities. Existing #207 thresholds are `0.90` score and `0.08` runner-up margin, and all
name-derived winners remain `suggested`.

## Database

Schema version 11 adds `bridge_identity_snapshots`, owned exclusively by
`lib/bridge/cache.ts`:

| Column                                              | Role                                           |
| --------------------------------------------------- | ---------------------------------------------- |
| `plex_origin`, `plex_machine_id`, `plex_library_id` | exact Plex instance/library scope              |
| `lidarr_origin`, `entity_kind`                      | exact Lidarr origin and `artist` discriminator |
| `snapshot_version`, `resolver_version`              | compatibility gates                            |
| `payload_json`                                      | strictly reprojected immutable bridge snapshot |
| `captured_at`, `verified_at`                        | provenance and live-verification timestamps    |

The unique key is
`(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)`.
`replaceBridgeIdentitySnapshot()` validates the complete document before a transactional upsert and
does not overwrite a newer generation. `readBridgeIdentitySnapshot()` byte-caps and strictly
reprojects JSON, returns `undefined` only for absence, throws bounded typed errors for corruption or
version drift, and always returns cached evidence as `source: "sqlite-cache"`, `mode: "offline"`,
`freshness: "stale"` with computed `ageSeconds`.

### Blocking offline gaps

1. `BridgeArtistIdentitySnapshot` persists outcomes per Plex source but not the complete Lidarr
   artist catalog. `completeness.targetArtistCount` is only a count. Candidate lists are capped at
   five, so the reverse `lidarr_only` set cannot be recovered from payload v1.
2. Cache reads require the full scope, including Plex machine and section IDs. There is no safe
   cache API to list/select compatible scopes by canonical origins, and obtaining those IDs from the
   adapter requires Plex network access.
3. `resolveRequiredLidarrOrigin()` currently also requires an API key, and the media-server factory
   requires a Plex token. Eager config template expansion may therefore require secrets even for a
   no-network run.

The offline prerequisite should introduce a versioned v2 document (or a separate reconciliation
snapshot) containing a minimal, bounded, strictly projected Lidarr catalog: local ID, canonical
artist MBID or explicit invalid/missing state, terminal-safe title, and only the optional status
fields rendered by offline reports. It also needs a deterministic scope-selection API that never
crosses Plex machine/library or Lidarr origin boundaries. Prefer explicit cached-scope selection or
an exact-one-match rule; never silently choose the newest row across multiple libraries.

If the v1 table is reused, bump the document version and keep old rows as typed incompatible misses;
a schema migration is necessary only if new indexed scope-selection columns are added. If a new
table or columns are added, advance both `CURRENT_SCHEMA_VERSION` and
`SUPPORTED_READ_ONLY_SCHEMA_VERSION`, update `schema.sql`/`migrations.ts`, and cover fresh,
upgrade, future-version, corruption, and rollback paths.

Online reconciliation may replace the cache only after both provider enumerations and pure
resolution finish completely. A failed/cancelled/partial refresh must preserve the previous
snapshot. Offline mode performs zero provider requests and zero cache writes. A default online
report's local cache refresh is operational persistence, not permission to mutate Plex/Lidarr, but
it must be documented; if “all writes” is interpreted literally, expose a separate explicit
`--refresh-cache` gate.

## External Services

### Plex

- Configuration comes from `plex.url`, `plex.token`, `plex.libraryName`, optional library mappings,
  page size, and cache settings, with `--plex-url` / `--plex-token` overrides.
- Cross-origin URL overrides must retain the existing rule requiring an explicit matching token.
  Canonical origins contain no credentials, path, query, or fragment.
- Unknown GUID providers are ignored; malformed/conflicting MusicBrainz evidence becomes a conflict,
  not a name-match fallback.

### Lidarr

- Configuration comes from `lidarr.baseUrl`, `lidarr.apiKey`, timeout, resilience, and scheduler
  settings, with `--lidarr-url` / `--lidarr-api-key` overrides.
- The typed transport sends `X-Api-Key` only after same-origin validation, rejects redirects,
  bounds response bodies, supports cancellation/timeouts, and maps authentication, authorization,
  invalid-response, timeout, rate-limit, and unreachable failures into the existing taxonomy.
- Artist enumeration is local-only and must not contact MusicBrainz directly. No new external SDK
  or runtime dependency is needed.

### Secrets and offline semantics

`.rfmedia.yaml` templates are expanded eagerly after bootstrap re-exec through `--use-dotenvx` or
`--use-op`. Online mode therefore reuses the established `{{ PLEX_TOKEN }}` and
`{{ LIDARR_API_KEY }}` flow and must redact both CLI overrides from failures. Offline mode must mean
“zero provider requests,” and should not imply that cached evidence is fresh. If product intent also
requires running without credentials present, that is an additional config contract: add
credential-free canonical-origin/scope selectors or defer only the relevant secret templates;
never persist tokens or credential fingerprints in snapshot keys.

## Integration Points

1. **Pure bridge engine:** create `lib/bridge/reconcile.ts` over projected immutable values.
   Preserve `mapping.ts` as the sole identity policy owner; reconciliation classifies its outcomes
   and performs the reverse exact-target subtraction without reimplementing fuzzy matching.
2. **Types:** extend `types/bridge.ts` with versioned report/category/duplicate/suggestion contracts
   and the complete offline target projection. Keep raw Plex DTOs, generated Lidarr DTOs, database
   rows, Commander types, and presenter fields out of the bridge types.
3. **Live acquisition action:** create `actions/lidarr/reconcile.ts`. Validate options before I/O;
   resolve canonical origins; require `adapter.identity`; acquire instance ID and every Plex artist
   page; acquire one complete Lidarr artist list; resolve identities; atomically refresh cache; and
   then build the report. Export it from `actions/lidarr/index.ts`.
4. **Offline acquisition action:** open the existing tracking database, select an exact compatible
   scope, strictly read the complete cached document, and build the same report without constructing
   either provider client. Cache miss, ambiguity, corruption, incompatibility, or an operator
   freshness ceiling must fail closed with stable machine-readable codes. Stale use must require an
   explicit `--offline`/`--allow-stale` choice and expose age in all formats.
5. **CLI and output:** add a dedicated `commands/lidarr-reconcile.ts` rather than further enlarging
   `commands/lidarr.ts`; register `reconcile` in the existing ordered hierarchy. Reuse lazy action
   import, `isMachineFormat`, `formatOutput`, failure envelopes, execution summaries, secret
   redaction, and stderr-only human rendering. CSV needs a documented flat per-artist projection;
   JSON/YAML should emit one `{ command: "lidarr-reconcile", result }` document.
6. **Audit integration:** replace the permanent `plexIdentity` unavailable slot and reserved
   `plex-alignment` evaluator in `actions/lidarr/audit.ts` / `lib/lidarr/audit.ts` only after the
   reconciliation contract is stable. The audit should consume the same pure report rather than
   maintain a second gap algorithm. This integration is part of #211's advertised scope and should
   not be left permanently stale.
7. **Cancellation and failures:** accept an action-level `AbortSignal` (defaulting to the global
   signal at the action boundary), pass it to the scheduler, every Lidarr call, Plex instance
   lookup, and each Plex page. Caller cancellation is terminal: no retry, cache fallback, partial
   report, snapshot replacement, plan artifact, or mutation. Provider transport outages may fall
   back only when the operator explicitly selected cached/offline behavior; validation,
   authentication, authorization, cache corruption, and scope ambiguity never silently fall back.
8. **Mutation boundary:** default, `--offline`, duplicate detection, and suggestion modes never
   mutate Plex or Lidarr. Cached, stale, fuzzy, ambiguous, conflict, or unavailable evidence can
   only produce remediation text. A `plex_only` add may hand a reviewed exact MBID to a generalized
   artist-add plan producer, but the current producer is Last.fm-provenance-specific and must be
   widened honestly. `lidarr_only` removal/unmonitoring and duplicate resolution must use sealed
   exact-ID plans with explicit operation-specific authorization. Apply must perform fresh
   exact-MBID revalidation, show expansion/file impact, support dry-run/resume/history, and never
   issue a second non-idempotent add after uncertain dispatch.
9. **Completions and contracts:** update Bash, Zsh, and Fish static templates plus
   `shell-completions/templates.spec.ts`, the pinned `LIDARR_COMMAND_NAMES` hierarchy test, command
   grammar/output tests, action orchestration tests, bridge property/table tests, and real SQLite
   live-to-offline round trips. No completion path may contact either provider.

### Child-issue decision

The live #208 issue has no children, but its “Medium (3-5 files)” estimate is no longer accurate
against the completed #207 implementation. Create at least:

1. **Offline snapshot completeness and scope discovery (prerequisite):** evolve the cached document
   so `lidarr_only` and exact scope selection are possible without provider I/O.
2. **Read-only reconciliation engine, acquisition, CLI, audit integration, outputs, and shell
   parity:** implement the complete live/offline report after the prerequisite lands.

Create a third child only if #208 must execute corrective writes. Otherwise keep #208 report-first
and emit guided commands into the existing plan/apply surface; leave consumption-driven policy and
ratings mutations to #209 and #221. No existing issue found in the live repository covers the
specific v1 snapshot-completeness/scope-selection gap.
