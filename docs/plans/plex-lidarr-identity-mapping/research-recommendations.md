# Plex-Lidarr Identity Mapping Recommendations

## Executive Summary

Issue #207 should deliver a small, read-only artist identity foundation:

- an additive, optional, provider-neutral Plex artist-identity capability;
- a private Plex projector for bounded external GUID evidence;
- one pure, deterministic artist resolver;
- one dedicated SQLite table containing one strictly projected JSON snapshot per complete scope;
- one pure expansion-impact calculator for later workflows.

Only a unique, one-to-one, entity-typed MusicBrainz artist ID (MBID) may resolve
automatically. Normalized-name and fuzzy results are suggestions only and require an explicit
review surface in a future issue; #207 must not silently accept or promote them.

The cache scope is the credential-free Plex origin, Plex machine ID, Plex library ID, entity kind,
and credential-free Lidarr origin. Refreshes use one atomic upsert after complete in-memory
validation, and both fresh and cached payloads pass the same strict projection.

This issue adds no public command, makes no Bash/Zsh/Fish completion changes, does not activate
`plex-alignment`, adds no dependency or direct MusicBrainz access, and leaves #208, #209, and #221
as downstream consumers.

## Implementation Recommendations

1. **Keep the v1 domain artist-only.** Use entity kind `artist` throughout #207. Do not reserve or
   expose album behavior until sanitized Plex fixtures prove that Plex album GUID semantics match
   Lidarr release-group MBIDs.
2. **Add an optional provider-neutral identity capability.** Expose only opaque artist ID, title,
   bounded external IDs, pagination, cancellation, and an opaque provider instance ID. Keep raw
   Plex `Guid` wire shapes, tokens, request details, and machine-identifier mechanics private.
3. **Reuse existing provider boundaries.** Plex identity reads must use the existing origin-bound
   Plex transport, library lookup, pagination, and instance-ID seam. Lidarr data must come through
   the existing handwritten facade and artist projection. Bridge code must not own `fetch`, import
   generated Lidarr modules, construct handwritten Lidarr endpoints, or import private Plex code.
4. **Use one pure ordered resolver.**
   - Validate and canonicalize typed artist MBIDs first.
   - Resolve only a unique Plex artist MBID matched to exactly one Lidarr artist MBID.
   - Report malformed, duplicate, or conflicting MBIDs explicitly and do not fall through to names.
   - Produce bounded, deterministic normalized/fuzzy candidates only when authoritative MBID
     evidence is absent.
   - Require both a conservative score floor and runner-up margin, but keep every name-derived
     winner in `suggested` state pending explicit future review.
   - Represent ordinary uncertainty as discriminated outcomes such as `resolved`, `suggested`,
     `ambiguous`, `unmatched`, `conflict`, and `unavailable`.
5. **Keep matching policy local and versioned.** Reuse the installed Levenshtein primitive, but
   implement bridge-specific normalization, candidate caps, stable ordering, short-name handling,
   threshold, margin, and scoring/normalization versions. Do not use a first-winner helper, change
   existing global normalization, or describe a similarity score as probability.
6. **Persist one strict JSON snapshot table.** Use a dedicated table rather than the Lidarr
   metadata-response cache or normalized child tables. Its unique scope must contain:
   credential-free Plex origin, Plex machine ID, Plex library ID, entity kind, and
   credential-free Lidarr origin. Store schema/projection/resolver versions, bounded `payload_json`,
   observation and verification timestamps, and only the minimum provenance needed for
   deterministic offline replay.
7. **Make refresh atomic.** Fully acquire, resolve, and strictly project a snapshot in memory;
   perform one transactional upsert with uniqueness and version/conflict checks; roll back on any
   failure so readers see the old complete snapshot or the new complete snapshot, never a mixed
   generation.
8. **Use strict projection on both cache boundaries.** Treat decoded JSON as `unknown`; enforce a
   payload-byte cap before parsing; validate exact keys, enum values, UUIDs, timestamps, bounds,
   references, and versions; return fresh frozen domain objects. Corrupt or incompatible rows are
   unavailable/quarantined evidence, never accepted mappings.
9. **Define explicit offline semantics.** Offline means zero provider, health-check, DNS, or
   MusicBrainz requests. An offline miss is `unavailable`, not `unmatched`. Cached evidence exposes
   source, age, last verification, status, and versions and remains read-only. Stale use requires
   explicit consent; negative and fuzzy evidence refresh sooner than exact-MBID evidence.
10. **Ship pure expansion impact only.** Calculate distinct source tracks, distinct target albums,
    known target tracks, unknown-count evidence, ratio when complete, and whether confirmation is
    required. Do not prompt or select an action in #207. Future action lanes must show raw counts,
    fail closed on missing evidence, seal the impact in their plan, and revalidate before apply.
11. **Preserve scope boundaries.** Do not add a command, presenter, prompt, review workflow,
    reconciliation report, policy action, or mutation. Keep Bash, Zsh, and Fish templates unchanged
    and prove completion parity. Keep `plex-alignment` reserved and inactive.
12. **Add no dependency or external lookup.** Reuse SQLite and the installed distance library.
    Do not add an ORM, entity-resolution package, UUID package, Plex SDK, MusicBrainz SDK, new
    authenticated transport, or direct MusicBrainz access.

## Improvement Ideas

- Capture sanitized artist GUID fixtures from supported Plex server/music-agent combinations,
  including matched, unmatched, missing-GUID, duplicate-GUID, and malformed-GUID cases.
- Calibrate fuzzy score and separation thresholds with a representative collision corpus rather
  than treating research examples as a public contract.
- Add an explicit review, supersession, rejection, and purge surface in a downstream issue; review
  input must identify the fully scoped Plex entity and exact target artist MBID.
- Normalize cache storage into child tables only after #208 demonstrates measured size or indexed
  partial-query needs that the whole-snapshot model cannot meet.
- Consider album identity only after fixtures prove the Plex identifier is a MusicBrainz release
  group rather than a release; track and recording identities require separate semantic proof.
- Consider direct MusicBrainz enrichment only as a separately designed, opt-in feature with a fixed
  origin, privacy disclosure, rate limiting, bounded parsing, caching, and independent errors.
- Define an explicit retention/purge policy and a privacy-sensitive dedicated database option if
  shared-database metadata exposure becomes an operator concern.

## Risk Assessment

The following are implementation gates, not optional hardening.

| ID          | Required gate                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL-01 | Fuzzy evidence never becomes canonical or mutation-authorizing. Require score and runner-up-margin gates, bounded corroborating evidence where available, explicit ambiguity, and future review of an exact target MBID.                                                              |
| CRITICAL-02 | No downstream action may dispatch from a snapshot. Re-read the exact current Lidarr entity, confirm local ID, artist kind, and canonical MBID, reject zero/multiple/conflicting results, and seal the evidence in the existing plan/checksum flow.                                    |
| CRITICAL-03 | Track-to-album expansion is an explicit bounded projection with distinct source tracks, target albums, estimated tracks, and ratio. Future non-interactive use requires an explicit limit/acknowledgement and fails closed when counts are missing or exceeded.                       |
| WARNING-01  | Treat Plex GUIDs as untrusted: private projection, allowlisted verified scheme, bounded count/bytes, control-character rejection, lowercase UUID canonicalization, no URL dereference, and atomic rejection of conflicting MBIDs.                                                     |
| WARNING-02  | Brand/tag every MBID with entity kind. Never compare a bare UUID across artist, release-group, release, recording, or track semantics.                                                                                                                                                |
| WARNING-03  | Scope the snapshot by schema/projection version, credential-free Plex origin, machine ID, library ID, artist kind, and credential-free Lidarr origin; retain scoped opaque entity IDs inside the payload. Quarantine incompatible server replacement evidence.                        |
| WARNING-04  | Bound GUID/name lengths, metadata arrays, candidate count, normalized bytes, and total comparisons; support cancellation and reject an over-budget identity projection atomically.                                                                                                    |
| WARNING-05  | Parse cached JSON as `unknown`, cap bytes before parsing, apply the same strict projector as live data, check versions, and quarantine or ignore malformed rows.                                                                                                                      |
| WARNING-06  | Minimize stored data: no credentials, paths, query strings, raw GUID URLs, wire payloads, or debug transcripts. Enforce owner-only database directory/file permissions and reject unsafe symlink/non-regular-file opens before treating the cache as suitable for sensitive metadata. |
| WARNING-07  | Use one transaction and atomic upsert only after all projections succeed, with uniqueness plus compare-and-swap/version checks and rollback on conflict.                                                                                                                              |
| WARNING-08  | Use a bridge-specific pure scorer with no per-candidate raw-name logging. Log bounded counts, opaque IDs/hashes, reason codes, and scores; terminal-project any displayed names safely.                                                                                               |
| WARNING-09  | Direct MusicBrainz search is excluded. Any future enrichment must be explicit, off by default, privacy-disclosed, cache-first, and must never send local credentials, paths, or collection data.                                                                                      |
| WARNING-10  | Never dereference provider-supplied GUID/response URLs or forward Plex/Lidarr credentials. Preserve existing origin-bound transports; any future MusicBrainz client needs a fixed HTTPS origin, redirect rejection, and bounded bodies.                                               |
| WARNING-11  | Version normalization, preserve bounded raw labels for review, calculate all eligible candidates, expose ties/near-ties, and use stable ordering only for presentation. Ordering never decides identity.                                                                              |
| WARNING-12  | Store observation/verification timestamps, evidence source, state, and versions; show stale status; require explicit stale consent; use shorter freshness windows for negative/fuzzy evidence; never let a negative snapshot suppress a new live exact match.                         |

Additional residual risks are Plex GUID availability, recycled Plex item IDs, restored/replaced
Lidarr instances, large-library fuzzy cost, and database metadata disclosure. Mitigate these with
source fingerprints, exact-MBID revalidation, full-scope isolation, bounded comparison budgets,
owner-only storage, and fail-closed typed outcomes.

## Alternative Approaches

| Approach                                                        | Decision                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three normalized snapshot/entity/mapping tables                 | Defer. One strict JSON snapshot row is simpler and atomic for the current whole-snapshot consumers. Revisit only with measured partial-query needs.     |
| Reuse `lidarr_metadata_cache`                                   | Reject. Response-cache TTL and single-provider scope do not model durable cross-provider identity evidence.                                             |
| Automatically accept normalized or fuzzy names                  | Reject. Names generate suggestions only; exact typed MBID is the sole automatic identity.                                                               |
| Add a generic entity-resolution framework or strategy hierarchy | Reject. One explicit pure ordered resolver is smaller and easier to audit.                                                                              |
| Expose Plex GUID DTOs or widen ordinary query results           | Reject. Use an additive optional provider-neutral capability and private Plex projection.                                                               |
| Add a public identity/review command in #207                    | Reject. #208 is the first consumer; #207 has no command or completion surface.                                                                          |
| Activate `lidarr audit plex-alignment`                          | Reject. Identity availability is not reconciliation; activation remains downstream.                                                                     |
| Direct MusicBrainz fallback or a new SDK                        | Reject for #207. It adds privacy, rate-limit, transport, entity-translation, and availability obligations without being required for artist MBID joins. |
| Implement album/track identity now                              | Reject. Artist-only is the proven common denominator; higher-level MusicBrainz semantics require fixtures and downstream design.                        |

## Task Breakdown Preview

1. Define immutable provider-neutral artist identity, bridge outcome/provenance, strict snapshot,
   error, and expansion-impact contracts.
2. Add the optional Plex identity capability and typed test mock without changing existing query or
   machine-output shapes.
3. Implement private bounded Plex artist GUID acquisition/projection through the existing
   transport, pagination, library resolution, cancellation, and machine-ID seam.
4. Implement and table-test the pure artist resolver: exact MBID precedence, conflict handling,
   suggestion-only normalized/fuzzy ranking, deterministic ordering, limits, and immutability.
5. Add the dedicated single-table JSON snapshot migration and sole cache owner with full-scope
   lookup, atomic upsert, strict read/write projection, explicit offline read, and purge.
6. Implement and test the pure expansion-impact calculator with deduplication, safe arithmetic,
   incomplete-count behavior, and confirmation evidence.
7. Extend security/architecture tests for transport ownership, private imports, generated Lidarr
   boundaries, handwritten endpoint bans, credential-free storage/logging, and cache filesystem
   protections.
8. Run focused resolver, adapter, cache, migration, and expansion tests plus typecheck, build, full
   package/root suites, architecture checks, Lidarr codegen drift, lint, completion parity, and
   pre-push validation.
9. Confirm regressions: no command or completion diff, `plex-alignment` remains reserved, and only
   #207 moves forward while #208, #209, and #221 remain downstream.

## Key Decisions Needed

- **Decided:** #207 is artist-only.
- **Decided:** only a unique exact typed artist MBID match resolves automatically.
- **Decided:** normalized/fuzzy results remain suggestions until an explicit future review names
  the exact target MBID.
- **Decided:** use one dedicated strict JSON snapshot table, keyed by credential-free Plex origin,
  Plex machine ID, Plex library ID, entity kind, and credential-free Lidarr origin.
- **Decided:** refresh with one atomic upsert after complete strict projection; apply the same
  strict projection on cache reads.
- **Decided:** expose an additive optional provider-neutral Plex artist-identity capability.
- **Decided:** ship pure expansion-impact evidence only.
- **Decided:** no command, prompt, presenter, or Bash/Zsh/Fish completion change.
- **Decided:** do not activate the reserved `plex-alignment` audit.
- **Decided:** add no dependency and make no direct MusicBrainz request.
- **Decided:** #208, #209, and #221 remain downstream.
- **Still needed before implementation:** choose whether Plex library scope uses the stable section
  ID alone or stores both section ID and configured name; the cache key must include the stable
  library ID.
- **Still needed before finalizing fuzzy defaults:** approve a fixture corpus and initial score/
  runner-up-margin values as versioned suggestion policy, not identity authority.

## Open Questions

1. Which supported Plex server and music-agent fixtures prove artist GUID availability,
   cardinality, and the exact MusicBrainz provider syntax?
2. Does the bulk artist response contain the required GUID evidence, or is a bounded detail-fetch
   phase needed?
3. What source fingerprint best detects recycled Plex artist IDs without invalidating mappings for
   harmless metadata edits?
4. What positive, negative, and suggestion freshness windows should govern explicit offline/stale
   reads?
5. Should cache corruption be quarantined in place, deleted, or surfaced for explicit purge while
   online resolution continues?
6. Will owner-only directory/file and no-symlink database hardening land within #207, or must it be
   an explicit prerequisite before sensitive cache use?
7. What representative artist corpus and false-positive budget set the initial fuzzy score,
   margin, short-name, and candidate-cap policy?
8. What exact minimal fields should the downstream expansion contract retain before #209/#221
   define sealed plan presentation?
