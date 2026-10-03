# Security Research: Plex-Lidarr Identity Mapping

## Executive Summary

The identity layer is security-sensitive because a bad join can turn harmless Plex metadata into a
wrong-target Lidarr action. The existing clients provide strong foundations: canonical
origin-bound credentials, header-only authentication, redirect rejection, bounded response bodies,
strict unknown-to-domain projection, terminal-safe strings, parameterized SQLite statements, and a
typed error boundary. The implementation should extend those private boundaries rather than add a
second Plex or Lidarr transport.

The design should treat evidence in this order: an entity-typed, canonical MBID is authoritative;
a validated durable-cache entry is reusable evidence; fuzzy matching is advisory evidence only.
Neither stale cache data nor a fuzzy result may independently authorize a mutation. Before any
future downstream action, the caller must re-read the selected Lidarr entity, confirm the exact
entity-typed MBID and expected local ID, calculate the expansion ratio from fresh data, and obtain
explicit plan/apply authorization. Issue #207 should produce identity evidence and prompts, not
implement the #208/#209 actions.

| Severity | Count | Meaning in this assessment                                                     |
| -------- | ----: | ------------------------------------------------------------------------------ |
| CRITICAL |     3 | Could select or authorize the wrong mutation target if the boundary is omitted |
| WARNING  |    12 | Could poison identity state, leak private metadata, or cause denial of service |
| ADVISORY |     8 | Hardening or operational control that should be retained or documented         |

## Severity Tables

### CRITICAL

| ID          | Finding                                                                                                                                                         | Required mitigation                                                                                                                                                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL-01 | A fuzzy winner can be a valid-looking but wrong artist/album, especially for aliases, tribute acts, compilations, transliterations, and equal-score candidates. | Fuzzy evidence must never be promoted to canonical or mutation-authorizing state. Require a minimum score **and** a minimum lead over the runner-up; require corroborating kind/artist/year/track-count evidence where available; return every ambiguity for user review; cache an explicit `ambiguous`/`rejected` outcome rather than a winner. |
| CRITICAL-02 | A mapping accepted at analysis time can become stale or point at a replaced Lidarr row before a destructive or acquisition action.                              | Downstream code must re-read the exact Lidarr ID immediately before dispatch, require the same canonical MBID and entity kind, reject zero/multiple/conflicting matches, seal the evidence in the existing plan/checksum flow, and stop on uncertainty. Never dispatch from a cache row alone.                                                   |
| CRITICAL-03 | Track-level Plex signals can silently expand to artist- or album-level Lidarr effects far beyond operator intent.                                               | Make expansion a first-class, bounded projection: selected Plex tracks, affected Lidarr albums, estimated tracks, and ratios. Require an explicit confirmation/plan threshold when granularity expands; non-interactive use must supply an explicit limit/acknowledgement and fail closed when counts are unavailable or exceed it.              |

### WARNING

| ID         | Finding                                                                                                                                                                                                                                                                                       | Required mitigation                                                                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARNING-01 | Plex `Guid` values are untrusted server payloads and can contain unknown schemes, malformed URI text, wrong entity types, duplicate/conflicting MBIDs, credentials, or arbitrarily long strings.                                                                                              | Project `Guid` inside the private Plex adapter. Accept only the documented consumed shape and an allowlisted MusicBrainz scheme; parse as data, never as a fetch URL; bound count and UTF-8 length; canonicalize UUIDs to lowercase; reject multiple distinct MBIDs for the same entity.                                |
| WARNING-02 | UUID syntax alone does not distinguish artist, release-group, release, recording, and track identities. Cross-kind reuse can create a semantically wrong join.                                                                                                                                | Use branded/entity-tagged keys such as `artist:mbid`, `release-group:mbid`, and `recording:mbid`. The cache unique key and resolver API must include entity kind; never compare bare UUID strings across kinds.                                                                                                         |
| WARNING-03 | Keying a durable mapping only by MBID, display name, or origin allows cross-library, cross-server, and server-replacement contamination.                                                                                                                                                      | Scope rows by schema/projection version, Plex canonical origin, Plex machine identifier, Plex library ID, entity kind, Plex opaque ID, Lidarr canonical origin, and canonical MBID. Credentials must not be part of the key. Detect a machine-ID change at the same origin and invalidate or quarantine prior mappings. |
| WARNING-04 | Existing Plex wire guards bound the HTTP body to 8 MiB but do not consistently bound string length or metadata-array length. Fuzzy comparison can amplify a bounded payload into high CPU/memory use.                                                                                         | Add per-GUID/name length limits, array/candidate caps, total comparison-budget limits, and cancellation checks before fuzzy work. Reject the whole identity projection atomically when limits are exceeded.                                                                                                             |
| WARNING-05 | Existing SQLite metadata-cache reads parse JSON to `T` by assertion; one whole-list stale path also validates with a cast. A tampered or obsolete identity row could therefore cross the boundary unchecked if this pattern is copied.                                                        | Parse identity rows as `unknown`, enforce a payload-byte cap before `JSON.parse`, run the same strict projector used for fresh results, verify schema/projection version, and treat malformed rows as misses that are quarantined or deleted.                                                                           |
| WARNING-06 | Cache payloads can reveal listening interests, private artist/album names, internal origins, Plex opaque IDs, and possibly filesystem paths. The shared tracking database is not currently created with explicit `0700` directory/`0600` file enforcement or writable-open symlink rejection. | Minimize stored fields; do not persist file paths, query strings, raw GUID URLs, credentials, or full wire payloads. Enforce owner-only database/directory permissions and regular-file/no-symlink checks in the database owner before relying on the cache for sensitive deployments.                                  |
| WARNING-07 | A cache write assembled from several reads can persist a mixed-generation mapping after a partial failure or concurrent refresh.                                                                                                                                                              | Use one SQLite transaction for mapping, provenance, and freshness metadata. Write only after all projections succeed; use uniqueness constraints and compare-and-swap/version checks; rollback on any conflict.                                                                                                         |
| WARNING-08 | Raw names passed to the existing generic fuzzy helper are emitted through `logDebug`, which can disclose library contents and accept terminal-hostile text if projection is bypassed.                                                                                                         | Use a bridge-specific pure scorer with no per-candidate logging. Log only counts, opaque IDs/hashes, reason codes, and bounded scores; keep display names in normal user output only after terminal-safe projection.                                                                                                    |
| WARNING-09 | Optional direct MusicBrainz name search exposes the user's music interests and source IP to a third party, and a search result is weaker evidence than an exact MBID lookup.                                                                                                                  | Make network enrichment explicit and off by default for offline analysis. Prefer exact-MBID lookup; disclose the network contact; never send Plex/Lidarr tokens, internal paths, or private collection data; allow cache-only operation.                                                                                |
| WARNING-10 | Treating a GUID or MusicBrainz response URL as a request target creates an SSRF/credential-forwarding path. LAN targets are otherwise intentionally valid in this self-hosted application.                                                                                                    | Reuse the existing origin-bound Plex/Lidarr transports. If MusicBrainz is added, give it a separate fixed `https://musicbrainz.org` transport with `redirect: "error"` and bounded bodies. Never dereference server-supplied URLs or forward either local credential.                                                   |
| WARNING-11 | Fuzzy normalization can collapse distinct names through case, punctuation, article, compatibility, or diacritic folding; simple first-winner tie-breaking makes ordering security-relevant.                                                                                                   | Preserve the raw projected label for display, use a documented deterministic normalization version, compute all candidates, expose tied/near-tied results, and require a stable secondary evidence key. Candidate order must not decide identity.                                                                       |
| WARNING-12 | An offline cache can remain internally valid while being operationally stale, and negative results can suppress newly available exact matches.                                                                                                                                                | Store `observed_at`, `last_verified_at`, evidence source, resolution status, and version. Apply bounded TTLs separately to positive, negative, and fuzzy evidence; show stale status; require explicit stale consent; refresh negative/fuzzy entries sooner than exact-MBID entries.                                    |

### ADVISORY

| ID          | Finding                                                                                                                                                     | Required mitigation                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADVISORY-01 | Plex already binds an opaque token off-object, sends it only as `X-Plex-Token`, rejects redirects and sensitive query keys, and redacts failures.           | Add GUID ingestion behind `PlexTransport` and the private Plex projector; do not add a direct `fetch`, token property, token-bearing cache key, or raw response error.                                                                                                                                                                              |
| ADVISORY-02 | Lidarr already binds its API key off-object, sends `X-Api-Key` only after same-origin validation, bounds bodies, and strictly projects generated responses. | Add only the narrow MBID fields required by the bridge to existing projectors/facade methods. Preserve the generated-client boundary, typed `LidarrError` taxonomy, cancellation, and no-raw-body rule.                                                                                                                                             |
| ADVISORY-03 | Parameterized statements in the existing metadata cache prevent SQL injection through origin/category/discriminator values.                                 | Continue positional binding for every identity-cache operation and constrain category/status/kind values in TypeScript and SQLite `CHECK` constraints. Never interpolate identifiers or values into SQL.                                                                                                                                            |
| ADVISORY-04 | Canonical origins exclude credentials, paths, queries, and fragments and preserve non-default ports.                                                        | Resolve both sides through the existing canonical-origin helpers before key creation. Reject any mapping API input that supplies a non-canonical URL; never key by raw CLI/config URL text.                                                                                                                                                         |
| ADVISORY-05 | The current projectors create fresh frozen domain objects and reject malformed collections atomically.                                                      | Return immutable identity evidence objects; do not retain references to wire payloads or mutable cache-decoded objects.                                                                                                                                                                                                                             |
| ADVISORY-06 | Existing error contracts are designed to exclude credentials and raw response bodies.                                                                       | Introduce stable identity error/reason codes (`missing`, `ambiguous`, `conflict`, `stale`, `invalid-response`) with bounded terminal-safe messages. Do not include raw GUIDs, URLs, queries, or candidate payloads in exceptions.                                                                                                                   |
| ADVISORY-07 | MusicBrainz currently documents an average one-request-per-second source-IP limit and asks clients to use a meaningful contactable User-Agent.              | A future optional transport must use a single shared limiter, backoff on `503`, cache exact lookups, avoid synchronized polling, and send a product/version plus public project contact URL rather than a user's email. See the official [rate-limiting guidance](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) (accessed 2026-07-27). |
| ADVISORY-08 | MusicBrainz search allows up to 100 results and returns relevance-ranked candidates, while exact lookup takes an entity type plus MBID.                     | Prefer exact lookup and cap any search well below the upstream maximum. Treat search scores as discovery evidence, not proof of identity. See the official [API](https://musicbrainz.org/doc/MusicBrainz_API) and [search documentation](https://musicbrainz.org/doc/MusicBrainz_API/Search) (accessed 2026-07-27).                                 |

## AuthN/AuthZ

The bridge needs no new privilege. It should consume the current Plex adapter and Lidarr facade,
whose credential bindings are private `WeakMap`s and whose transports attach credentials only after
same-origin validation. A mapping/cache component should receive projected data and canonical
origins, never tokens or API keys.

`CRITICAL-02` and `CRITICAL-03` define the downstream authorization boundary: identity resolution is
not permission to mutate. A future action must use the established plan/apply contract, revalidate
exact identity, show expansion, and require explicit authorization. Cached, stale, fuzzy, or
third-party results are never authority.

Cross-origin CLI overrides must retain the existing rule that a changed server origin requires an
explicit matching credential override. MusicBrainz, if later enabled, must be a credential-isolated
fixed-origin client and must never receive Plex or Lidarr headers.

## Data Protection

The minimum durable row is identity and provenance, not a copy of either server payload:

- schema/projection version and entity kind;
- canonical server scopes (or references to a server-scope table), Plex machine/library/opaque IDs,
  Lidarr local ID, and canonical typed MBID;
- resolution status and evidence source (`plex-guid`, `exact-mbid`, `fuzzy-review`);
- bounded score/margin for advisory evidence;
- observation and verification timestamps.

Do not store credentials, raw URLs with path/query, raw GUID arrays, filesystem paths, complete
artist/album payloads, query terms, or debug transcripts. Names are optional convenience data and
should be bounded; omitting them reduces disclosure and forces fresh presentation data. Hashing an
origin does not make it anonymous against a small set of local hostnames, so it is primarily a
key-compaction choice, not a privacy control.

Owner-only filesystem permissions are the primary protection for SQLite. Encryption at rest is an
operator/platform concern unless the project introduces a key-management design; application-level
field encryption without a durable protected key merely relocates the secret. A practical
alternative for privacy-sensitive users is a dedicated cache database under the same `0700`/`0600`
atomic-file conventions used for plans.

## Dependency Security

`better-sqlite3` and `fastest-levenshtein` are already dependencies, so issue #207 need not add a new
package. Reusing SQLite lowers supply-chain surface, but native-module updates should remain
lockfile-pinned and covered by the repository's audit/update process.

The generic fuzzy helper is suitable for suggestions, not identity proof: it logs raw comparisons,
has first-winner tie behavior, and exposes no ambiguity margin. Prefer a small bridge-specific
scorer around the existing pure `compareSimilarity`, or refactor a no-logging top-two scorer with
bounded inputs. Do not add a remote matching SDK merely to call MusicBrainz; a future fixed-origin
transport can follow the hardened Last.fm/Plex/Lidarr patterns.

Generated Lidarr modules must remain private. Handwritten bridge code should not import generated
types, construct `/api/v1` paths, or own authenticated fetch.

## Input Validation

Plex GUID ingestion should be an atomic unknown-to-domain projection. Validate the outer list and
every consumed element, cap list length and string bytes, reject control/bidi characters, accept
only the MusicBrainz scheme required by the supported Plex agent, parse the UUID, and emit a
lowercase canonical typed MBID. Unknown GUID providers are ignored only if the rest of the record
remains unambiguous; malformed or conflicting MusicBrainz entries fail the identity projection.

Lidarr artist MBIDs should be tightened from today's safe-label artist-list guard to the existing
canonical UUID contract when consumed by this bridge. Album `foreignAlbumId` is currently a
tolerantly sanitized optional string; the bridge must validate it as a release-group MBID before
joining. Missing identifiers remain `missing`, never the empty string and never a fuzzy match
silently presented as exact.

Fuzzy inputs require independent bounds on input length, candidate count, total normalized bytes,
and total comparisons. Normalization must be versioned because changing it changes cache meaning.
Exact post-normalization collisions and a runner-up within the configured margin produce
`ambiguous`, not a deterministic winner.

## Infrastructure

The tracking database already uses WAL, `synchronous=NORMAL`, a busy timeout, foreign keys, schema
version preflight, and prepared statements. The identity table should add:

- `CHECK` constraints for kind, status, source, score range, canonical UUID length/shape, and
  non-negative timestamps;
- unique constraints that prevent two canonical targets for one scoped Plex entity;
- indexes only for the exact scoped lookup paths;
- transactions for replace/invalidate operations;
- an explicit projection version so incompatible normalization changes miss safely.

WAL sidecars inherit the containing directory's protection, making owner-only directory permission
important. Cache corruption, lock contention, or migration failure must degrade identity resolution
to a typed cache miss/error; it must not bypass validation or cause a network query without the
operator's configured policy.

Optional MusicBrainz access is external infrastructure. Keep it disabled for offline mode, enforce
HTTPS and a fixed origin, use the documented shared limiter, bound success/error bodies and result
counts, reject redirects, support cancellation/timeouts, and distinguish rate limiting from invalid
responses. No background polling is needed for this foundation.

## Secure Coding

1. Keep transport, projection, resolution, persistence, and presentation separate.
2. Represent resolution as a discriminated union: `exact`, `reviewed`, `missing`, `ambiguous`,
   `conflict`, or `stale`; avoid nullable fields whose combination implies authority.
3. Make typed MBID and scoped server identity mandatory in `exact` cache entries.
4. Reproject both fresh and cached values into new frozen objects.
5. Use constant, stable reason codes and sanitized bounded messages.
6. Make cache writes non-throwing only for read-only analysis; a failed write must be visible as
   degraded durability. Any future apply lane must fail closed if required identity evidence cannot
   be persisted/sealed.
7. Test malformed GUIDs, wrong entity kinds, duplicate/conflicting MBIDs, oversized arrays/strings,
   Unicode collisions, tied scores, poisoned SQLite JSON, schema-version drift, cross-origin keys,
   server replacement, stale negative results, cancellation, and concurrent upserts.
8. Preserve architecture checks for single authenticated-fetch ownership and private generated
   imports.

## Trade-offs

| Choice                                   | Security benefit                                          | Cost / alternative                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Exact MBID only for automatic matches    | Prevents wrong-target joins                               | Lower coverage; fuzzy results require review                                                                        |
| Full server/library scoping              | Prevents cross-instance contamination                     | Wider keys and migration complexity; a server-scope table can reduce duplication                                    |
| Store minimal provenance, not payloads   | Reduces privacy exposure and schema drift                 | Fresh reads are needed for display and actions                                                                      |
| Revalidate before downstream action      | Closes stale-cache/TOCTOU risk                            | Extra local Lidarr request and possible fail-closed action                                                          |
| Explicit stale consent                   | Makes offline uncertainty visible                         | Less seamless offline operation                                                                                     |
| Fixed-origin optional MusicBrainz client | Prevents SSRF and credential forwarding                   | No configurable mirror in this issue; a future mirror option needs an explicit trust policy                         |
| Dedicated no-log fuzzy scorer            | Avoids metadata leakage and deterministic false certainty | Small amount of duplicate utility code or a careful refactor                                                        |
| Shared tracking database                 | Reuses migrations/concurrency/backup                      | Identity metadata shares the database's permission and retention posture; a dedicated DB offers stronger separation |

## Open Questions

1. Which exact Plex music agents and GUID shapes are supported, and does Plex return artist,
   release-group, release, and recording MBIDs consistently enough to define an allowlist?
2. Is issue #207 artist-only, or must the first schema support album/release-group and
   track/recording identities without exposing them yet?
3. What stable Lidarr instance identifier, if any, can supplement canonical origin? If none exists,
   what evidence triggers quarantine after an instance is replaced at the same origin?
4. Must mappings be isolated by Plex user/token scope in addition to server and library? A
   credential fingerprint must not be stored; a non-secret configured scope ID may be needed.
5. What score threshold, runner-up margin, and corroborating fields are acceptable for presenting a
   fuzzy candidate? These need corpus-based tests, not arbitrary defaults.
6. How are human-reviewed mappings revoked or corrected, and do they outrank newly discovered exact
   conflicting MBIDs? Recommended answer: exact conflict quarantines the reviewed row and requires
   review rather than silently replacing it.
7. What positive, negative, reviewed, and fuzzy TTLs meet the offline requirement?
8. What expansion metrics and non-interactive acknowledgement syntax will #208/#209 consume?
   Issue #207 should define the evidence contract only.
9. Should owner-only permission hardening of the shared tracking database be included in #207 or
   split into a prerequisite security issue?
10. Is direct MusicBrainz access needed at all for #207? The safest minimum is Plex GUID plus local
    Lidarr exact-MBID resolution, with optional external enrichment deferred.
