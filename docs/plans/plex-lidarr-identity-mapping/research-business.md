# Business Research — Plex-Lidarr Identity Mapping

## Executive Summary

Issue [#207](https://github.com/yandy-r/rfmedia-apps/issues/207) supplies the identity boundary that
every later Plex-to-Lidarr gap, policy, and action workflow depends on. Its business value is not
merely “fuzzy matching”: it turns Plex consumption entities into stable, explainable Lidarr
identities, preserves reviewed decisions for repeatable and offline analysis, and refuses to turn an
uncertain name resemblance into a silent collection-management action.

The recommended contract is MBID-first and fail-closed. A unique, valid MusicBrainz ID shared by the
two systems is the only automatically resolved cross-system identity. A name match is a suggestion
until a user reviews it; ambiguity remains explicit rather than being broken by array order. Cached
mappings retain provenance and age, may be used for explicitly requested offline/read-only
analysis, and must be revalidated by exact MBID immediately before any Lidarr mutation. Whenever a
track-level Plex signal would cause album-level Lidarr action, the reviewed plan must show the
expansion counts and ratio and require a separate affirmative apply gate.

## User Stories

- As a Plex and Lidarr operator, I can reconcile the same artist consistently even when display
  names differ by punctuation, case, accents, articles, aliases, or minor spelling.
- As an operator with well-tagged media, I receive an automatic match only when both systems agree
  on one valid MusicBrainz identity.
- As an operator with incomplete Plex GUID metadata, I can review a unique name-based candidate and
  save my choice for later runs.
- As an operator facing two plausible candidates, I see all relevant candidates and why the result
  is ambiguous; rfmedia does not select the first one.
- As an operator correcting a prior choice, I can supersede or invalidate the cached mapping
  explicitly, with the previous decision remaining auditable.
- As an operator during a Plex, Lidarr, or metadata outage, I can run an explicitly offline,
  read-only analysis from durable mappings and see their source and age.
- As a cautious operator, stale or fuzzy identity evidence can never silently monitor, add, edit,
  search, delete, or download content.
- As an operator translating highly rated or frequently played tracks into Lidarr actions, I see
  the number of source tracks, target albums, and estimated target tracks before approval.
- As automation, I receive stable identity states, match methods, candidate evidence, cache
  freshness, expansion evidence, and review requirements in machine-readable output.
- As a maintainer, I can change Plex and Lidarr clients without changing the meaning of a resolved
  bridge identity or exposing provider wire DTOs above their adapters.

## Scope

### In Scope

- Artist-level identity as the initial common denominator, with entity-kind fields that prevent an
  artist mapping from being reused as an album or track mapping.
- Extraction and canonicalization of Plex MusicBrainz GUID evidence.
- Exact matching against Lidarr's `foreignArtistId`/MBID.
- Conservative normalized-name and fuzzy-name fallback when exact MBID evidence is unavailable.
- Explicit result states, candidate evidence, ambiguity handling, and user-reviewed resolution.
- A durable, origin-scoped local mapping cache with provenance, freshness, offline-read semantics,
  invalidation, and conflict detection.
- Expansion evidence and confirmation requirements at the boundary where track-level signals feed
  album-level action plans.
- Stable human/machine reporting, error classifications, tests, docs, and any required completion
  parity for a new public command or flag.

### Out of Scope

- Direct artist addition, monitoring/profile changes, album searches, downloads, deletes, or other
  Lidarr mutations; those must continue through the existing plan/apply lanes.
- Automatically merging duplicate artists, albums, folders, or files.
- Audio fingerprinting, file retagging, filesystem moves, or Beets-style metadata correction.
- Inventing an MBID from a name or treating a Plex rating key/Lidarr numeric ID as a cross-system
  canonical identifier.
- General direct MusicBrainz discovery or fallback requests. If introduced, they require their own
  provider attribution, rate limiting, cache, error, and fetch-ownership design.
- Track-level acquisition. Lidarr acquires albums; the mapping layer can expose the expansion but
  cannot remove the granularity mismatch.
- A broad Plex-Lidarr policy engine. Issue #207 establishes identity and safety evidence consumed by
  later bridge workflows.

## Business Rules

### Deterministic Identity Precedence

Identity resolution must use the following order and stop at the first conclusive state:

1. **Validate scope and kind.** Bind the request to one Plex server identity, Plex library, Plex
   entity kind and stable item ID, and one canonical credential-free Lidarr origin. Cross-kind,
   cross-library, or cross-origin cache reuse is forbidden.
2. **Collect canonical MBID evidence.** Normalize valid MusicBrainz UUIDs to lowercase. Ignore
   unrelated Plex agent GUID schemes, but report malformed or conflicting MusicBrainz GUID evidence
   instead of silently discarding it.
3. **Resolve a unique exact MBID.** Exactly one source MBID matching exactly one same-kind Lidarr
   entity is `resolved` with method `mbid`. This is the only live resolution that does not need
   identity review.
4. **Detect MBID conflict before names.** Multiple distinct valid Plex MBIDs, duplicate Lidarr
   entities with the same MBID, or disagreement between live MBID evidence and a cached decision is
   `conflict` or `ambiguous`; name similarity must not override it.
5. **Consult a compatible reviewed cache entry.** A previously user-confirmed mapping may resolve
   repeat analysis only when its source identity/fingerprint and target MBID remain compatible.
   Live contradictory MBID evidence always wins by invalidating/blocking the cached decision.
6. **Try normalized exact-name candidates.** A unique folded-name equality is a high-confidence
   `suggested` match, not an automatically resolved identity. Zero candidates proceeds to fuzzy
   comparison; multiple candidates are `ambiguous`.
7. **Try fuzzy-name candidates.** Rank all same-kind candidates deterministically by descending
   score and then stable MBID. A candidate must meet the documented minimum score and lead the
   runner-up by a documented minimum margin. Recommend a conservative initial threshold of `0.90`
   and separation margin of `0.05`, validated against fixtures before becoming a public contract.
8. **Require review for every name-derived result.** Even a unique high-scoring candidate remains
   `suggested` until the operator accepts it. Acceptance records the chosen MBID and evidence in
   the durable mapping cache. A tie, insufficient margin, or multiple normalized-exact candidates
   is `ambiguous`; no qualifying candidate is `unmatched`.

Numeric Lidarr IDs and Plex rating keys are local locators, not join keys. They may be cached for
efficient lookup but the target MBID is the durable identity and must survive a Lidarr rebuild that
reassigns numeric IDs.

### Identity States

| State       | Meaning                                                                | Permitted next step                                      |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `resolved`  | One exact MBID match or one compatible reviewed cached mapping         | Read-only analysis; fresh MBID revalidation before write |
| `suggested` | One name-derived candidate meets deterministic confidence rules        | User review; no action yet                               |
| `ambiguous` | Multiple plausible candidates, a tie, or insufficient score separation | Explicit candidate selection or metadata correction      |
| `unmatched` | No qualifying same-kind candidate                                      | Report gap; do not invent an identity                    |
| `conflict`  | Authoritative/live evidence disagrees or one MBID maps non-uniquely    | Block and require correction/review                      |

Freshness is orthogonal to state. A result can be `resolved` and `fresh`, `resolved` and `stale`, or
`resolved` and `offline`. Consumers must not collapse these into one boolean “matched” field.

### Name Normalization and Fuzzy Matching

- Normalize Unicode deterministically, case-fold, remove combining marks, normalize punctuation and
  whitespace, and optionally strip a genuine leading article. Retain raw names for display.
- Compare only same-kind entities. Artist-to-album or track-to-artist name similarity is invalid.
- Never use path, position, upstream response order, or “first best score” as an ambiguity
  tiebreaker.
- Empty normalized names, placeholder names such as `Unknown Artist`, malformed strings, and
  over-bounded input cannot participate in fuzzy resolution.
- Aliases, collaborations, “Artist feat. Guest,” various-artists compilations, transliterations,
  and artist-name collisions are expected ambiguous cases unless MBID evidence disambiguates them.
- A similarity score is evidence, not probability. Human output must not say “95% certain” merely
  because a Levenshtein-derived score is `0.95`.
- The scoring version, normalization version, threshold, and margin are part of cached provenance.
  An algorithm/version change must trigger re-evaluation rather than silently reinterpreting old
  scores.

### Ambiguity and Review

- Return a bounded candidate list with target MBID, display name, normalized/fuzzy score, match
  method, and disambiguating context available from the existing projections.
- Candidate ordering must be stable for identical inputs. Candidate rank is presentation evidence,
  not identity and must not be cached as the decision.
- Human interactive mode may prompt for one candidate, “leave unmatched,” or cancel. Pressing Enter
  must not accept the first candidate.
- Machine/non-TTY modes never prompt and never guess. They emit `suggested`, `ambiguous`, or
  `unmatched` and require a later explicit reviewed-resolution input.
- `--yes` may approve a fully resolved, sealed action plan, but it must not choose an ambiguous
  identity, waive a fuzzy review, or convert an unmatched item into a target.
- A user override must identify an exact target MBID. Free-form target names are insufficient.
- Review decisions should be reversible and auditable: record when, by which method, from which
  candidate set/version, and whether the entry supersedes a prior decision.

### Durable Cache, Freshness, and Offline Behavior

The cache is a durable decision/evidence store, not an invisible source of truth:

- Key entries by Plex server identity, library identity, entity kind, Plex item ID, and canonical
  Lidarr origin. Never key by credentials, credential-bearing URLs, names alone, or a global MBID.
- Persist the source fingerprint needed to detect reuse of a recycled Plex item ID: raw display
  identity plus canonical GUID evidence and relevant parent identity.
- Persist target MBID, optional current Lidarr numeric ID, match method, score/margin, normalization
  and scoring versions, review status, creation time, last validation time, and supersession or
  invalidation state.
- Successful exact and user-reviewed positive decisions are durable. `unmatched`, `ambiguous`, and
  rejected suggestions may be retained as diagnostic snapshots, but must not become negative
  identities that hide newly available candidates.
- Live compatible evidence refreshes `lastValidatedAt`; a changed source fingerprint, different
  live MBID, duplicate target MBID, or missing target marks the entry conflicted/stale rather than
  silently rewriting it.
- Cache-write failure must warn while preserving a successful live analysis. Corrupt rows, unknown
  schema/scoring versions, and cross-origin entries are misses/conflicts, never accepted mappings.
- An online run attempts live evidence first. Stale fallback requires explicit user intent such as
  `--allow-stale`; a deliberately disconnected run requires explicit `--offline`.
- Offline mode performs zero Plex, Lidarr, MusicBrainz, or other provider calls. It returns only
  exact compatible cached evidence and reports `offline=true`, age, last validation, and source.
- A cache miss in offline mode remains `unmatched`/`unavailable`; it must not fall back to fuzzy
  matching against an incomplete cache and imply a complete-library search.
- Stale/offline cache may support reports, comparisons, and plan drafting. It may not authorize a
  mutation. Apply must re-read the exact target from live Lidarr by MBID and verify current scope
  and desired state immediately before action.
- Cache retention must be long enough to make repeatable/offline analysis meaningful. Freshness
  should be computed at read time and entries should be superseded or explicitly purged, rather
  than opportunistically deleting the only record of a reviewed decision.

The existing Lidarr metadata-cache rule—secret-free origin scoping, timestamps, explicit stale
consent, and no failed-response caching—is a strong precedent. Identity decisions should use a
separate category/table or strongly versioned discriminator because their retention and review
semantics differ from short-lived API response snapshots.

### No-Silent-Action Safety

- Mapping and cache review are read-only by default. Resolving identity does not imply add,
  monitor, search, profile change, tag change, deletion, or download intent.
- Every downstream mutation must use the existing reviewable plan/apply boundary, exact target
  identities, drift checks, bounded scope, and confirmation rules.
- `resolved` is necessary but not sufficient for mutation. Fresh target existence, exact MBID,
  entity kind, current state, action scope, and policy must all be revalidated.
- `suggested`, `ambiguous`, `unmatched`, `conflict`, stale-only, or offline-only identity blocks
  apply. Neither a fuzzy score nor `--yes` bypasses this rule.
- Partial mapping success must not cause partial action admission. A workflow may report resolved
  and unresolved rows together, but action planning must explicitly select only review-complete
  identities and disclose exclusions.
- Machine output, piped input, JSON/YAML/CSV mode, and non-TTY execution never prompt. Absent an
  exact reviewed artifact and explicit apply authorization, they remain report-only.

### Expansion-Ratio Confirmation

Track-to-album translation must make its blast radius explicit:

- Define `signalTracks` as the distinct Plex tracks satisfying the reviewed source policy.
- Define `targetAlbums` as the distinct Lidarr albums the proposed action affects.
- Define `estimatedTargetTracks` from Lidarr album statistics when complete.
- Report `trackExpansionRatio = estimatedTargetTracks / signalTracks`, alongside all three raw
  counts. Do not report a numeric ratio when either count is zero or target track statistics are
  incomplete; report `unknown` plus the missing evidence instead.
- Deduplicate source tracks and target albums before calculating counts. Multiple signals for the
  same album must not inflate the album target count.
- Show per-artist and aggregate expansion. A low aggregate ratio must not conceal one extreme
  artist-level expansion.
- Any action derived from track-level evidence that affects one or more whole albums requires a
  confirmation that includes the exact action, target albums, signal count, estimated target-track
  count, ratio (or `unknown`), and whether acquisition/search may be triggered.
- The confirmation is required even when the ratio is `1.0`; crossing granularity is the risk, not
  merely exceeding an arbitrary threshold. A future configurable warning threshold may add
  emphasis, but cannot remove the base confirmation.
- Interactive text mode defaults to No. Non-interactive or machine mode must first produce a sealed
  review artifact; apply then requires the existing explicit `--yes` gate. `--yes` does not excuse
  missing/unknown expansion evidence or unresolved identity.
- If the target catalogue is incomplete, statistics are unavailable, or a plan would monitor an
  artist rather than enumerated albums, label the expansion as unbounded/unknown and block
  automated apply unless a separately designed high-risk override is explicitly added.

Example review:

> 3 rated Plex tracks map to 2 Lidarr albums containing an estimated 24 tracks (8.0x expansion).
> The proposed action monitors both albums and may search for missing releases. Proceed? [y/N]

## Primary Workflows

### Online Exact-MBID Mapping

1. Read bounded Plex artist entities and their provider GUID evidence through the Plex adapter.
2. Read bounded Lidarr artist projections containing `foreignArtistId`.
3. Canonicalize and group each side by same-kind MBID.
4. Emit `resolved` only for one-to-one exact matches; classify duplicates and contradictory GUIDs
   as `ambiguous`/`conflict`.
5. Upsert successful evidence into the durable mapping store.
6. Report resolved, suggested, ambiguous, unmatched, and conflicted counts without mutation.

### Fuzzy Review and Decision

1. For an item lacking conclusive MBID evidence, derive deterministic normalized and fuzzy
   candidates from the complete bounded same-kind Lidarr set.
2. Emit one `suggested` candidate only when threshold and separation rules pass; otherwise emit
   `ambiguous` or `unmatched`.
3. In interactive text mode, let the operator choose an exact candidate MBID, leave unmatched, or
   cancel. Machine mode emits evidence only.
4. Persist an accepted choice as a reviewed mapping with algorithm/candidate provenance.
5. Re-run reports using the reviewed cache decision until live evidence conflicts or the user
   supersedes it.

### Offline Repeat Analysis

1. The operator explicitly selects offline behavior.
2. Resolve entries only from compatible cached source identity/fingerprint and target MBID.
3. Mark every row with offline/stale age and last-validation evidence.
4. Report cache misses and conflicts; perform no live completion or partial fuzzy scan.
5. Produce read-only analysis. Any requested apply is rejected until online exact-MBID
   revalidation succeeds.

### Track Signal to Album Action

1. Aggregate reviewed Plex signals by resolved artist/album identity.
2. Enumerate exact Lidarr album targets and available track statistics.
3. Build a sealed, reviewable plan that carries source counts, target counts, expansion ratio or
   unknown evidence, action semantics, and acquisition/search implications.
4. Present the expansion confirmation. Decline/cancel produces no mutation and preserves analysis.
5. At apply, revalidate every target MBID and current Lidarr state, then use the existing explicit
   confirmation/`--yes` contract.

## Entity and Cache State Transitions

```text
unseen
  -> resolved (unique live MBID)
  -> suggested (unique name candidate)
  -> ambiguous (multiple/conflicting candidates)
  -> unmatched (no candidate)

suggested -> resolved (explicit exact-MBID review)
suggested -> unmatched (explicit rejection)
resolved  -> stale (freshness window elapsed or offline read)
resolved  -> conflict (live source/target identity disagrees)
stale     -> resolved (successful live exact-MBID revalidation)
conflict  -> resolved (metadata corrected or explicit reviewed supersession)

Only fresh resolved -> reviewed plan -> confirmed apply is action-eligible.
```

## Existing Codebase and Domain Patterns

- **Narrow provider boundaries:** Plex wire DTOs are private to
  `src/lib/adapters/plex/`; generic entities currently expose opaque IDs and display metadata.
  Issue #207 must add GUID evidence deliberately without leaking raw Plex responses.
- **Canonical Lidarr foreign identity:** `LidarrArtist.foreignArtistId` already documents the
  MusicBrainz artist UUID as the future bridge join key. Lidarr numeric IDs remain local.
- **Strict exact-MBID safety:** artist-add planning and read-back checks validate canonical lowercase
  MBIDs, re-read by exact MBID, and fail closed on zero/multiple results.
- **Pure deterministic identity helpers:** the Lidarr audit separates name/path folding and
  duplicate grouping from I/O and preserves deterministic insertion order.
- **Existing fuzzy utility:** `fuzzy-match.ts` provides normalization and Levenshtein similarity,
  but `findBestMatch` chooses the first highest score and has no ambiguity margin. It cannot be used
  directly as the bridge decision policy.
- **Durable secret-free cache:** `lidarr_metadata_cache` is keyed by credential-free origin,
  computes age at read time, and serves stale snapshots only with explicit consent.
- **Plan/apply safety:** Lidarr mutations use sealed artifacts, exact identity, pre-mutation
  revalidation, bounded batches, drift checks, and interactive or `--yes` authorization.
- **Machine-output discipline:** prompts and human tables use stderr; machine envelopes use stdout;
  non-TTY execution never waits for interactive input.

## Gotchas and Edge Cases

- Current Plex wire/domain artist, album, and track projections do not carry GUID arrays. The
  research corpus explicitly marks Plex MBID availability as an unverified critical gap, so fixture
  and live-shape validation must precede assuming MBIDs exist on every library item.
- Plex may expose multiple agent GUIDs, nested MusicBrainz GUIDs only after metadata expansion, old
  agent formats, or no GUID at all. Absence is not evidence that an artist is absent from Lidarr.
- One Plex artist may represent several MusicBrainz artists after bad merges; one MusicBrainz artist
  may appear as multiple Plex artists after library splits.
- Lidarr duplicates can share an MBID because of metadata/data-quality defects. Exact MBID is
  canonical only when the match is one-to-one.
- Numeric Lidarr IDs may change after restore/rebuild. Cached IDs are hints and must be refreshed by
  MBID.
- Names made equivalent by article/accent/punctuation folding may still refer to different artists.
  “The The,” “A,” non-Latin transliterations, aliases, tribute acts, collaborations, and various
  artists require conservative review.
- The existing normalization helper does not decompose accents; the audit adds NFKD decomposition.
  Bridge normalization needs one versioned canonical policy rather than accidentally mixing both.
- A first-place fuzzy tie is silently order-dependent in the existing helper. The bridge needs a
  score margin and stable MBID tiebreak for display, while retaining ambiguity for the decision.
- A cached user choice may become wrong when Plex recycles a rating key, metadata is corrected, an
  artist is split/merged, or the Lidarr origin points at a restored database.
- Negative cache results age differently from reviewed positive mappings. Treating an old
  `unmatched` result as authoritative would hide new library content.
- Track-to-album expansion can be non-integer, extremely large, or unknowable. Album statistics may
  be missing on newly added/unscanned artists; “unknown” must not be rendered as zero.
- Compilations and tracks featuring multiple artists can map one Plex signal to several artist or
  album candidates. The bridge must not duplicate action scope or attribute the signal arbitrarily.
- Fuzzy comparison is potentially quadratic across large libraries. Candidate generation and
  input/result bounds must preserve deterministic behavior without flooding debug output.
- Direct MusicBrainz calls would add a strict rate limit and external availability dependency. They
  are not an innocuous fallback hidden inside matching.

## Measurable Success Criteria

1. Every valid one-to-one shared MBID fixture resolves identically across repeated runs, regardless
   of input ordering, name spelling, case, punctuation, or locale.
2. Zero name-only/fuzzy matches become action-eligible without an explicit exact-MBID review.
3. Duplicate source MBIDs, duplicate Lidarr MBIDs, tied scores, insufficient score margins, and
   live/cache disagreements produce explicit non-resolved states in human and machine output.
4. Identical inputs, scoring version, and cache state produce byte-stable ordered machine identity
   results, excluding deliberately variable timestamps.
5. Cache tests prove separation by Plex server, library, entity kind/item ID, and Lidarr origin, and
   prove credentials never enter keys, rows, output, or errors.
6. Offline mode performs zero network requests, labels every returned mapping with age/provenance,
   and reports cache misses without inventing candidates.
7. Stale/offline/conflicted/suggested/ambiguous/unmatched identities are rejected before any Lidarr
   mutation call; fresh apply performs exact-MBID and current-state revalidation.
8. Cache corruption, unknown scoring version, and source-fingerprint changes fail closed without
   erasing the evidence needed for review.
9. Expansion tests cover deduplication, `1.0`, fractional and large ratios, incomplete statistics,
   zero signals, per-artist outliers, and unknown/unbounded scope.
10. Every track-derived album mutation plan displays raw source/target counts and ratio or unknown
    evidence; default-No cancellation and non-TTY-without-explicit-apply produce zero writes.
11. Mapping a bounded library remains within the repository's agreed performance budget; benchmark
    fixtures should include at least 1,000 Plex and 1,000 Lidarr artists and prove candidate
    generation avoids an uncontrolled all-pairs/debug-output path.
12. Existing Lidarr/Plex commands, strict TypeScript, package tests, architecture checks, offline
    Lidarr codegen, build, docs, and Bash/Zsh/Fish completion parity remain green.

## Relevant Files

- `packages/rfmedia-cli/src/types/media-server.ts` — provider-neutral Plex entity boundary; currently
  lacks external GUID evidence.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts` — private consumed Plex wire shapes where
  GUID fields must first be validated.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts` — private Plex-to-domain projection.
- `packages/rfmedia-cli/src/types/lidarr.ts` — stable Lidarr artist/album projections and canonical
  `foreignArtistId`/`foreignAlbumId`.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` — exact-MBID lookup and strict one-result
  read-back precedent.
- `packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts` — deterministic Unicode/name folding and
  duplicate grouping.
- `packages/rfmedia-cli/src/lib/fuzzy-match.ts` — existing normalization/Levenshtein primitives and
  first-best ambiguity limitation.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts` — durable origin-scoped cache, freshness,
  and explicit stale-consent precedent.
- `packages/rfmedia-cli/src/lib/schema.sql` — current persistent Lidarr metadata-cache schema.
- `packages/rfmedia-cli/src/lib/prompt.ts` — default-No confirmation and non-TTY detection.
- `packages/rfmedia-cli/src/actions/lidarr/audit-plex.ts` — sole Plex probe boundary prepared for
  later bridge work.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — sealed plan, identity, drift, and apply
  safety boundary downstream consumers must retain.

## Relevant Docs

- [Issue #207](https://github.com/yandy-r/rfmedia-apps/issues/207)
- [Plex-Lidarr integration report](../../../research/rfmedia-lidarr-integration/report.md)
- [Negative-space findings](../../../research/rfmedia-lidarr-integration/persona-findings/negative-space.md)
- [Crucible analysis](../../../research/rfmedia-lidarr-integration/synthesis/crucible-analysis.md)
- [Tension mapping](../../../research/rfmedia-lidarr-integration/synthesis/tension-mapping.md)
- [Metadata resilience design](../lidarr-metadata-resilience/design.md)
- [Lidarr mutation plan/apply spec](../../prps/specs/lidarr-mutation-plan-apply.spec.md)
- [Lidarr import-validation safety spec](../../prps/specs/lidarr-import-validation-track-filtering.spec.md)

## Open Questions

1. Which Plex agent versions and response shapes expose artist, album, and track MusicBrainz GUIDs,
   and what percentage of representative libraries has usable IDs? This is the critical empirical
   feasibility gate identified by the original research.
2. Is issue #207's first public workflow artist-only, or must it expose album/track mappings now?
   Artist-first is recommended; the cache schema should still encode entity kind.
3. What public command owns mapping review, cache inspection, supersession, and purge? These are
   operator requirements if reviewed decisions are durable, but issue #207 does not name a command.
4. Should explicitly reviewed mappings remain usable for offline analysis indefinitely, or should
   configuration impose a stale ceiling? Preserve the record indefinitely and separate retention
   from “fresh enough to use” is recommended.
5. Which exact source fingerprint is stable enough to detect Plex rating-key reuse without making
   normal metadata edits invalidate every mapping?
6. Does an exact normalized-name match require the same explicit review as a fuzzy match?
   Recommended: yes; only a unique MBID match is authoritative enough for automatic resolution.
7. Are `0.90` minimum similarity and `0.05` separation appropriate for the representative artist
   corpus? Treat them as initial testable policy, not final truth, until false-positive fixtures and
   real library samples are evaluated.
8. Must all unknown expansion estimates block apply, or may a future explicit high-risk override
   approve them? Blocking is recommended for #207; any override needs a separate, visible contract.
9. Who/what is recorded as the reviewer in a local single-user CLI without introducing sensitive
   operating-system identity into persisted artifacts?
