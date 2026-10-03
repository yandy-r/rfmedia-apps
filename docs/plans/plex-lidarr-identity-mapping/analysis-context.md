# Context Analysis: Plex-Lidarr Identity Mapping

## Executive Summary

Issue #207 is an internal, read-only foundation for later Plex-to-Lidarr reconciliation and policy
work. It adds an optional provider-neutral Plex artist-identity capability, a private bounded Plex
GUID projector, one pure MBID-first artist resolver, one strict SQLite snapshot table, and one pure
track-to-album expansion calculator. It does not add an operator-facing workflow.

The final planning decisions intentionally narrow several earlier research options:

- The v1 domain is artist-only. Do not reserve or expose album, release-group, recording, or track
  identity behavior.
- A unique, one-to-one, entity-typed artist MBID is the sole automatic resolution path.
- Normalized-name and fuzzy results are suggestions only. The versioned fuzzy gate is a `0.90`
  minimum score and a `0.08` lead over the runner-up; passing both gates does not make a suggestion
  authoritative.
- Persistence is one dedicated `bridge_identity_snapshots` JSON snapshot row per complete scope,
  not normalized entity/mapping child tables and not `lidarr_metadata_cache`.
- The scope key contains credential-free Plex origin, Plex machine ID, stable Plex library section
  ID, credential-free Lidarr origin, and entity kind.
- Expansion work stops at immutable evidence. There is no prompt, action selection, plan mutation,
  album acquisition, or presenter in #207.
- There is no command, flag, configuration, completion-template, dependency, generated-client,
  OpenAPI, direct MusicBrainz, or `plex-alignment` activation change.

These constraints make the implementation naturally separable into provider-neutral contracts,
private Plex acquisition, pure resolution/expansion, strict persistence, and boundary verification.
Issues #208, #209, and #221 remain the consumers that add reporting, policy, and actions.

## Architecture Context

The existing repository already has the provider and persistence boundaries needed by this
feature:

```text
private Plex transport
  -> private artist GUID guard/projector
  -> optional provider-neutral identity capability
                                         \
                                          -> pure artist resolver
existing Lidarr facade -> projected artists /
                                          -> immutable snapshot/evidence
                                              -> strict single-row SQLite cache
                                              -> pure expansion calculator
```

### Provider boundaries

- `MediaServerAdapter` is the only provider-neutral media-server surface. Add an optional identity
  capability rather than widening ordinary `MediaArtist` query results, which would change existing
  query and machine-output contracts.
- `PlexAdapter` is the composition root. The new private identity endpoint family must receive the
  existing `PlexTransport`, library resolver, pagination behavior, response cache, and private
  machine-identifier seam by injection.
- `PlexTransport` remains the sole authenticated Plex request owner. Bridge modules cannot import
  private Plex modules, own `fetch`, see a token, or construct Plex requests.
- `LidarrClientApi.listArtists()` already returns the projected local artist ID, title, and
  `foreignArtistId`. The bridge consumes that facade unchanged; it cannot import generated Lidarr
  modules or construct `/api/v1` paths.
- No MusicBrainz transport is needed. Plex and Lidarr supply the artist identifiers, and provider
  GUID strings must be parsed as untrusted data rather than dereferenced as URLs.

### Domain flow

1. Plex privately resolves the requested music library to its stable section ID, fetches bounded
   artist pages with GUID evidence, and exposes fresh frozen provider-neutral identities plus the
   opaque machine ID required for snapshot scope.
2. Lidarr supplies a complete projected artist catalog through `listArtists()`.
3. The pure bridge resolver validates entity-typed artist MBIDs, indexes exact identifiers, and
   emits deterministic discriminated outcomes.
4. A complete strictly projected snapshot is written by one feature-owned cache module after all
   acquisition and resolution succeeds.
5. Explicit cache reads return the same domain shape after byte-capped `unknown` projection.
   Offline cache misses are `unavailable`, not `unmatched`; offline orchestration must make zero
   provider or health-check requests.

### Resolution policy

Resolution order is a safety boundary, not a configurable strategy chain:

1. Validate and lowercase canonical artist MBIDs.
2. Resolve only when one Plex artist MBID maps to exactly one Lidarr artist with the same MBID.
3. Treat malformed, multiple, duplicate, or contradictory MBID evidence as `conflict`; never fall
   through to a name match.
4. Only when authoritative MBID evidence is absent, produce normalized-name and fuzzy candidates.
5. A name winner must meet score `>= 0.90` and winner margin `>= 0.08`, but its state remains
   `suggested`. Ties and insufficient margins are `ambiguous`; a complete search without a
   qualifying candidate is `unmatched`.

Bridge normalization is local and versioned. It may use the installed Levenshtein primitive, but
must not call the existing first-winner helper, reuse its `0.4` default, change
`normalizeForMatch()`, or log raw names per comparison. Candidate lists are bounded and stably
ordered by descending score, normalized title, then opaque target ID; ordering never decides
identity.

### Snapshot model

Schema v11 adds exactly one feature table. The table stores:

- the full unique scope: `plex_origin`, `plex_machine_id`, `plex_library_id`, `lidarr_origin`, and
  artist `entity_kind`;
- positive snapshot/projection/resolver versions;
- bounded `payload_json`;
- canonical observation/capture and verification timestamps.

The payload contains the complete provider catalogs, mapping outcomes, bounded candidate evidence,
and provenance needed for deterministic offline analysis. It excludes credentials, paths, raw GUID
URLs/arrays, request queries, response bodies, and debug transcripts. Replacement is one
transactional upsert after full in-memory validation, so readers see either the previous complete
snapshot or the new one. Both writes and reads use the same strict projector and return fresh
frozen values.

## Critical Files Reference

| File                                                                          | Planning relevance                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/bridge.ts`                                    | New artist-only identity, scope, outcome, snapshot, cache-error, provenance, and expansion contracts.                  |
| `packages/rfmedia-cli/src/types/media-server.ts`                              | Add the optional provider-neutral artist-identity capability without exposing Plex wire data.                          |
| `packages/rfmedia-cli/src/types/index.ts`                                     | Export the new stable contracts; keep provider-private types out.                                                      |
| `packages/rfmedia-cli/src/types/lidarr.ts`                                    | Existing generated-independent `LidarrArtist` projection consumed by the resolver.                                     |
| `packages/rfmedia-cli/src/types/db.ts`                                        | Add the single snapshot row projection only if the cache module needs a typed SQL row.                                 |
| `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`                      | New private bounded artist GUID acquisition, pagination, cancellation, and projection owner.                           |
| `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`                         | Private unknown-to-wire guards for bounded Plex `Guid` values and identity responses.                                  |
| `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`                 | Existing library-section resolution, pagination, and private machine-ID seams to reuse.                                |
| `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`                        | Sole authenticated Plex transport; no new request owner is allowed.                                                    |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`                       | Compose the optional identity capability from existing private dependencies.                                           |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                               | Existing `listArtists()` facade; no endpoint or generated-client change is needed.                                     |
| `packages/rfmedia-cli/src/lib/lidarr/types.ts`                                | Existing strict fresh/frozen Lidarr projections; bridge validation tightens artist MBIDs locally.                      |
| `packages/rfmedia-cli/src/lib/bridge/mapping.ts`                              | New pure ordered resolver, local normalizer/scorer, and expansion-impact calculator.                                   |
| `packages/rfmedia-cli/src/lib/bridge/cache.ts`                                | New sole owner of snapshot read/replace/purge, serialization, strict projection, and transactions.                     |
| `packages/rfmedia-cli/src/lib/fuzzy-match.ts`                                 | Reuse the installed distance dependency only; avoid its global normalization, logging, and first-winner helpers.       |
| `packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts`                       | Edge-case fixture precedent for accents, articles, duplicates, and deterministic folding; do not couple policies.      |
| `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`                       | Reuse sole-CRUD-owner, credential-free origin, injected-clock, and age precedents; do not store bridge snapshots here. |
| `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`                     | Precedent for pure frozen evidence, checked arithmetic, stable codes, and presentation separation.                     |
| `packages/rfmedia-cli/src/lib/schema.sql`                                     | Add the v11 single snapshot table, full-scope uniqueness, checks, and exact lookup index.                              |
| `packages/rfmedia-cli/src/lib/migrations.ts`                                  | Raise `CURRENT_SCHEMA_VERSION` from 10 to 11 through the existing sequential migration pattern.                        |
| `packages/rfmedia-cli/src/lib/db.ts`                                          | Raise the exact read-only supported version from 10 to 11 without weakening preflight checks.                          |
| `packages/rfmedia-cli/src/lib/db.test.ts`                                     | Prove fresh v11 schema, v10 preservation/migration, constraints, and newer-schema rejection.                           |
| `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts` | Extend the shared capability mock once; do not create scattered Plex-specific bridge mocks.                            |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`                  | Existing gate for private Plex imports, generated Lidarr imports, handwritten endpoints, and fetch ownership.          |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`             | Add bridge-specific fixtures proving the new modules receive no boundary exemptions.                                   |
| `ROADMAP.md` and `docs/roadmap/archive.md`                                    | Delivery-only update: archive #207 while leaving #208, #209, and #221 downstream.                                      |

The authoritative feature decisions are in
`docs/plans/plex-lidarr-identity-mapping/feature-spec.md` and
`docs/plans/plex-lidarr-identity-mapping/research-recommendations.md`. Where early research proposes
album union members, a `0.92` threshold, a `0.05` margin, or three normalized cache tables, the
final artist-only, `0.90`/`0.08`, single-table decisions above take precedence.

## Patterns to Follow

- **Additive optional capability:** preserve existing adapters, actions, query results, and mocks by
  making identity optional and provider-neutral.
- **Private wire projection:** validate provider responses from `unknown`, consume only allowlisted
  bounded fields, and create fresh frozen domain records.
- **Sole transport ownership:** reuse the origin-bound Plex transport and Lidarr facade; never
  duplicate authentication, same-origin, redirect, body-limit, or error-redaction logic.
- **Pure discriminated evidence:** model `resolved`, `suggested`, `ambiguous`, `unmatched`,
  `conflict`, and `unavailable` explicitly. Ordinary uncertainty is data, not an exception.
- **Exact identity before similarity:** canonical typed MBID indexes are the primary linear path;
  fuzzy comparison runs only for MBID-absent artists under explicit bounds.
- **Feature-local matching policy:** keep normalization, versions, thresholds, margin, short-name
  behavior, candidate cap, and stable ordering together in the bridge resolver.
- **Feature-owned SQLite CRUD:** one module owns parameterized reads, transactional replacement,
  purge, clock handling, payload caps, and strict row projection.
- **Exact sequential migration:** advance writable and read-only versions together and retain exact
  rejection of malformed/newer schema metadata.
- **Pure checked expansion evidence:** deduplicate IDs, validate safe integers, return raw counts
  and completeness, and leave presentation/action authorization to downstream consumers.
- **Layer-owned tests:** provider wire tests own malformed responses; resolver table tests own
  policy; cache integration tests own corruption and atomicity; adapter tests own composition;
  architecture tests own forbidden dependencies.

## Cross-Cutting Concerns

### Identity and correctness

- An MBID UUID is not self-describing. Every accepted identifier must carry artist semantics.
- Plex rating keys and Lidarr numeric IDs are instance-local locators, never cross-system identity.
- Distinct Plex MBIDs, duplicate Lidarr MBIDs, recycled Plex IDs, changed machine IDs, and changed
  resolver versions must fail closed rather than choose a row.
- Identity state, evidence method, provenance, completeness, and freshness are separate dimensions.
  A cached exact result can support analysis while still being ineligible to authorize mutation.

### Security and privacy

- Treat GUID count, string bytes, names, arrays, payload bytes, candidate count, normalized bytes,
  and comparison work as bounded untrusted input.
- Reject control and bidirectional characters at projection/display boundaries. Unknown GUID
  providers may be ignored; malformed or conflicting consumed MusicBrainz evidence is not ignored.
- Canonicalize origins without credentials, paths, queries, or fragments. Never persist tokens,
  API keys, raw request/response data, filesystem paths, or credential-bearing URLs.
- Never dereference provider-supplied GUIDs or forward Plex/Lidarr credentials to another origin.
- Avoid raw-name debug logging during fuzzy work; diagnostics should use bounded counts, stable
  reason codes, and opaque identifiers.

### Cache, offline, and failure semantics

- Validate the complete snapshot before opening the replacement transaction. Roll back on any
  invalid row, reference, version, timestamp, or serialization failure.
- Cap `payload_json` bytes before `JSON.parse`, parse as `unknown`, require exact supported
  versions/keys/enums/references, and quarantine or reject incompatible evidence.
- Low-level cache operations may throw a typed bounded cache error. A future online caller may keep
  a successful live result as read-only degraded evidence, but must report that it was not durable.
- Offline means zero clients, DNS probes, health checks, or provider requests. An absent compatible
  snapshot is `unavailable`; only a complete live candidate search can produce `unmatched`.
- Snapshot evidence never authorizes a Lidarr mutation. Future actions must re-read the exact
  current Lidarr artist, confirm kind/local ID/MBID, seal expansion evidence, and use existing
  plan/apply authorization.

### Expansion and performance

- Calculate distinct source track count, distinct target album count, known target track count,
  unknown target-album count, `number | null` expansion ratio, completeness, and
  `requiresConfirmation`.
- A missing target track count makes the ratio `null`; never substitute zero or estimate missing
  evidence. Any non-empty cross-granularity action requires downstream confirmation even at
  `1.0x`.
- The calculator accepts already projected evidence. It must not fetch albums/tracks, select an
  action, format a prompt, mutate a plan, or perform provider I/O.
- Exact lookup should be linear. Fuzzy work must be limited to unresolved artists and enforce
  candidate/comparison budgets plus cancellation in acquisition paths.

## Parallelization Opportunities

Use one short contract gate followed by independent file-ownership lanes:

1. **Contract gate — must land first**
   - Own `src/types/bridge.ts`, the identity addition in `src/types/media-server.ts`, and the
     required type exports.
   - Freeze artist-only discriminators, exact state/reason vocabulary, snapshot scope, versions,
     fuzzy constants, and expansion fields before implementation lanes diverge.

2. **Plex acquisition lane**
   - Own `adapters/plex/identity.ts`, its tests, the necessary private additions in
     `adapters/plex/types.ts`, adapter composition, and the shared adapter mock update.
   - This lane can proceed independently after the provider-neutral contract exists.

3. **Resolver and expansion lane**
   - Own `lib/bridge/mapping.ts` and its table-driven tests.
   - It uses only stable domain inputs and the existing distance dependency, so it is independent
     of Plex transport and SQLite implementation.

4. **Persistence and migration lane**
   - Own `lib/bridge/cache.ts`, cache tests, `schema.sql`, `migrations.ts`, `db.ts`, `types/db.ts`,
     and the focused database migration assertions.
   - It depends on the frozen snapshot contract but not on Plex or Lidarr clients.

5. **Integration and boundary lane — after lanes 2–4**
   - Own architecture-test fixtures, reserved `plex-alignment` regression, completion-parity proof,
     codegen drift proof, and roadmap/archive updates.

Avoid parallel edits to `src/types/index.ts`, `media-server-adapter-mocks.ts`, `schema.sql`,
`migrations.ts`, `db.ts`, or `db.test.ts`; assign one explicit owner for each shared file.
Integration should combine already projected provider catalogs outside `lib/bridge`, rather than
creating an orchestration module or command in #207.

## Implementation Constraints

- Use strict TypeScript with no `any`, `noUncheckedIndexedAccess`, exhaustive discriminated unions,
  `.js` ESM import extensions, and JSDoc on exported functions.
- Keep the v1 contract literally artist-only. Do not predeclare album kinds or implement album,
  release-group, recording, or track identity.
- Automatic resolution is unique exact artist MBID only. Normalized and fuzzy names remain
  suggestions at all scores.
- Use the fixed versioned suggestion policy of score `>= 0.90` and winner margin `>= 0.08`.
- Use one dedicated strict JSON snapshot table with the full origin/machine/library/kind scope. Do
  not create normalized child tables or reuse `lidarr_metadata_cache`.
- Raise both schema version constants from 10 to 11 and preserve exact read-only/newer-schema
  checks.
- Add no package, SDK, ORM, UUID library, fuzzy-search library, Plex client, or MusicBrainz client.
- Do not modify generated Lidarr code, the OpenAPI snapshot, codegen configuration, or handwritten
  endpoint inventory.
- Add no command, flag, config key, environment variable, action, prompt, presenter, or public
  machine-output envelope.
- Do not edit Bash, Zsh, or Fish completion templates. Run parity tests to prove they remain
  unchanged.
- Do not activate or reinterpret `lidarr audit plex-alignment`; #208 owns reconciliation.
- Do not add direct `fetch`, a new authenticated transport, private-Plex imports from bridge code,
  generated-Lidarr imports outside the existing owner, or handwritten `/api/v1` paths.
- Do not change global name normalization or reuse first-winner fuzzy helpers.
- Do not let cached, stale, offline, suggested, ambiguous, unmatched, conflict, or unavailable
  evidence authorize mutation.
- No source-provider fixture may contain real credentials, raw private payloads, or unsanitized
  collection metadata.

## Key Recommendations

1. Treat `feature-spec.md` and `research-recommendations.md` as the decision authority and use the
   other research documents for risks, fixtures, and precedents.
2. Lock the artist-only bridge contracts and exact snapshot scope before implementation. This is
   the dependency boundary for every parallel lane.
3. Build the Plex capability as a small private endpoint family composed by `PlexAdapter`; do not
   widen normal media query entities or expose machine/GUID wire mechanics.
4. Implement one auditable resolver with explicit ordered phases. Keep exact MBID resolution and
   advisory name ranking visibly separate in both types and tests.
5. Centralize the `0.90`/`0.08` policy, normalization/scoring versions, candidate cap, and stable
   ordering in `mapping.ts`; test threshold and margin boundaries exactly.
6. Prefer the single-row snapshot model until #208 demonstrates a measured indexed-query need.
   Atomic whole-snapshot replacement matches the current complete-catalog consumer.
7. Make the cache projector the durability trust boundary: byte-cap, parse as `unknown`, strictly
   validate, freeze, and reject incompatible versions on both read and write.
8. Keep expansion as pure evidence with checked distinct counts and fail-closed incompleteness.
   Defer all wording, prompting, plan sealing, and live revalidation to downstream action owners.
9. Extend the existing architecture gate rather than documenting boundaries only. A bridge fixture
   should fail if it imports private Plex/generated Lidarr code, owns `fetch`, or embeds an endpoint.
10. Verify with focused provider/resolver/cache/migration/expansion tests, rfmedia typecheck/build
    and full suite, root package and architecture suites, Lidarr codegen drift, lint, completion
    parity, and pre-push hooks. In a fresh worktree, install dependencies and build `rf-common`
    before diagnosing package failures.
