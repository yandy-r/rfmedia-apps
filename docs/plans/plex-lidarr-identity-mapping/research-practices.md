# Engineering Practices Research: Plex-Lidarr Identity Mapping

## Executive Summary

Issue #207 should add a small internal identity subsystem, not a second Plex client, a generic
entity-resolution framework, or an early reconciliation command. The maintainable shape is:

1. an additive provider-neutral artist-identity capability on `MediaServerAdapter`;
2. a private Plex implementation that reuses the existing transport, library lookup, pagination,
   cache, and machine-identifier seams;
3. one pure artist resolver that consumes provider-neutral Plex identities and existing
   `LidarrArtist` projections;
4. one dedicated SQLite snapshot owner for durable/offline reads; and
5. typed, pure expansion-impact evidence for later command presenters.

MusicBrainz artist IDs are the only automatic join. Normalized/fuzzy names produce deterministic,
bounded suggestions that require explicit review; they must not silently become mappings. Issue
207 has no public command, so it should neither prompt nor modify Bash, Zsh, or Fish templates.
Issue 208 is the first consumer, and the existing `plex-alignment` audit slot must remain reserved.

The principal KISS recommendation is to persist one strictly validated snapshot JSON document per
scope in a dedicated table. A three-table entity/mapping schema adds migration, indexes, joins, and
partial-row invariants without a demonstrated SQL-query consumer. Split the document only when
issue 208 proves that indexed per-entity SQL queries are needed.

## Existing Reusable Code

| Existing code                                                  | Reuse in #207                                                                                                                          | Boundary or caveat                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types/media-server.ts`                                    | Add an artist-identity capability beside the existing query/library capabilities.                                                      | Do not put Plex `Guid` wire shapes in the public contract.                                                                                             |
| `src/lib/adapters/plex-adapter.ts`                             | Compose identity from the same origin-bound `PlexClient`, response cache, and query/library family.                                    | Keep token and machine identity off enumerable adapter state.                                                                                          |
| `src/lib/adapters/plex/query-library.ts`                       | Reuse library resolution, structured `/library/sections/{id}/all` requests, `advancePaginationOffset()`, and `getMachineIdentifier()`. | Prefer injecting its narrow `find`/identity seams into `plex/identity.ts`; do not duplicate configuration reads.                                       |
| `src/lib/adapters/plex/client.ts`                              | Sole authenticated Plex transport.                                                                                                     | `lib/bridge/**` must never import it or call `fetch`.                                                                                                  |
| `src/lib/adapters/plex/types.ts`                               | Extend the private wire guards with a bounded `Guid` array consumed only by the identity endpoint.                                     | Existing query DTOs intentionally omit GUIDs; do not widen ordinary query output.                                                                      |
| `src/lib/lidarr/client.ts`                                     | Use `LidarrClientApi.listArtists()` unchanged.                                                                                         | It is the only generated-client importer; no new endpoint or handwritten `/api/v1/` path is needed.                                                    |
| `src/types/lidarr.ts`                                          | `LidarrArtist.foreignArtistId` is already the artist MBID and `id` is the local locator.                                               | Validate/canonicalize the MBID at the bridge boundary; do not treat the numeric ID as durable identity.                                                |
| `src/lib/lidarr/types.ts`                                      | Reuse its fresh, frozen projections and collection bounds.                                                                             | Its artist guard accepts a safe label, not necessarily a canonical UUID, so the resolver still needs source-identity validation.                       |
| `src/lib/fuzzy-match.ts` and `fastest-levenshtein`             | Reuse the installed Levenshtein dependency.                                                                                            | Do not reuse `findClosestMatch()` or its `0.4` default; it picks one winner and has no ambiguity margin. Do not change `normalizeForMatch()` globally. |
| `src/lib/lidarr/audit-identity.ts`                             | Use its accent/case/article fixtures as precedent for edge cases.                                                                      | `foldArtistName()` is audit policy and removes information differently from bridge policy; importing it would couple two features.                     |
| `src/lib/db.ts`, `src/lib/schema.sql`, `src/lib/migrations.ts` | Reuse database initialization, WAL/foreign-key behavior, sequential schema migration, and `better-sqlite3` transactions.               | Bump both writable and exact read-only supported versions together.                                                                                    |
| `src/lib/lidarr/metadata-cache.ts`                             | Reuse its credential-free scope, injected clock, strict timestamp handling, and sole-CRUD-owner conventions.                           | Do not store identity snapshots in `lidarr_metadata_cache`; response-cache TTL/category semantics do not model cross-provider reviewed identity.       |
| `src/actions/test-helpers/media-server-adapter-mocks.ts`       | Extend the typed capability mock once, with an empty identity page default.                                                            | Avoid one-off Plex bridge mocks in multiple suites.                                                                                                    |
| `src/actions/test-helpers/lidarr-client-mocks.ts`              | Existing `listArtists` mock is the Lidarr acquisition seam.                                                                            | Resolver tests should use domain inputs directly and need no client mock.                                                                              |
| `scripts/check-direct-plex-imports.mjs`                        | Existing gates already reject private Plex imports, generated Lidarr imports, handwritten endpoints, and new Fetch owners.             | Add one fixture proving `lib/bridge/**` receives no exemption.                                                                                         |
| `src/lib/lidarr/cascade-analysis.ts`                           | Reuse its design precedent: pure typed evidence, checked arithmetic, stable codes, presentation elsewhere.                             | Do not import its plan-specific types/errors into the bridge merely to multiply two counts.                                                            |

## Modularity Design

### Current

```text
MediaServerAdapter -> private Plex endpoint families -> PlexClient
LidarrClientApi    -> handwritten facade             -> generated SDK/transport
tracking database -> feature-owned CRUD modules      -> better-sqlite3
```

### Recommended

```text
src/types/bridge.ts
  provider-independent artist identity, resolution, snapshot, review,
  cache provenance, and expansion-impact contracts

src/lib/adapters/plex/identity.ts
  private Plex GUID request/guard/projection; reuses Plex transport,
  library resolution, pagination, cache, and instance-id callback

src/lib/bridge/mapping.ts
  pure MBID validation, bridge-specific name normalization, ranking,
  ambiguity classification, and expansion-impact calculation

src/lib/bridge/cache.ts
  sole owner of snapshot read/replace/purge and stored-payload validation
```

`mapping.ts` must import only stable domain types and the already-installed string-distance
dependency. `cache.ts` may depend on `DbConnection` and bridge contracts, but not on Plex or Lidarr
clients. Network acquisition remains outside both modules, allowing #208 to choose live or explicit
offline orchestration without changing the resolver.

Do not add `lib/bridge/index.ts`, a repository class, a provider registry, or a dependency-injection
container for three functions. Direct ESM imports are clearer until a real public package boundary
appears.

## Shared vs Feature-Specific

### Shared

- The provider-neutral identity record should carry only opaque provider ID, kind `"artist"`,
  title, and bounded external IDs.
- The adapter identity capability, typed test mock, database initialization, and architecture
  checks are shared infrastructure.
- Cache provenance should use credential-free Plex/Lidarr origins, Plex library scope, captured
  time, resolver version, and source (`live` or `sqlite-cache`).

### Feature-Specific

- MBID precedence, fuzzy thresholds, winner margin, short-name handling, and candidate cap belong
  in `lib/bridge/mapping.ts`.
- Bridge name normalization is deliberately local. Existing audit, video matching, CLI suggestion,
  and discovery normalization have different semantics.
- Snapshot payload validation and reviewed-decision compatibility belong in `lib/bridge/cache.ts`.
- Expansion from Plex track signals to Lidarr album scope belongs in bridge contracts; the prompt
  and apply gate belong to the future command that performs an action.

Keep the v1 contract artist-only. Reserving album behavior now would assert unverified semantics for
Plex album `mbid://` GUIDs versus Lidarr release-group IDs. Adding an `"album"` union member later is
an additive change once fixtures prove equivalence.

## KISS Assessment

- **Use one pure resolver.** A strategy interface for MBID, exact name, and fuzzy name would spread
  one ordered policy across objects. One explicit function with ordered phases is easier to audit.
- **Use a discriminated result, not exceptions for ordinary uncertainty.** `matched`, `suggested`,
  `ambiguous`, `unmatched`, and `invalid-source` make uncertainty visible. Cache corruption and I/O
  failure may throw typed errors.
- **Persist one complete snapshot document.** A dedicated
  `bridge_identity_snapshots(scope..., resolver_version, payload_json, captured_at)` table gives
  atomic replacement with one upsert and lets SQLite rollback preserve the previous generation.
  Validate the entire document before writing and after reading.
- **Do not normalize the existing query cache into an identity database.** Extending
  `lidarr_metadata_cache` looks smaller but hides Plex instance/library identity in an opaque
  discriminator and inherits stale-response semantics that do not fit reviewed mappings.
- **Do not add a review command in #207.** Name-based results remain suggestions until #208 or a
  later consumer supplies an explicit review decision. Persisting a suggestion is not approval.
- **Do not add a prompt formatter without a caller.** Ship `BridgeExpansionImpact` plus a pure
  calculator. The first command consumer owns wording, stderr, TTY, `--yes`, and sealed-plan
  integration.
- **Do not modify `plex-alignment`.** Identity availability is not reconciliation. Retain the
  evaluator-less reserved check and its regression test through #207.

The trade-off of a JSON snapshot is that SQL cannot index individual MBIDs. That cost is acceptable
while resolution and #208 gap-set construction are naturally whole-snapshot, in-memory operations.
Normalize into child tables only if measured snapshot size or a demonstrated partial-query use case
requires it.

## Abstraction vs Repetition

- Reuse the `fastest-levenshtein` package directly but keep bridge normalization and winner policy
  local. The existing generic fuzzy helper's “first best candidate” behavior is unsafe here.
- Do not import `foldArtistName()` from the audit. Two consumers with different `&`, article, and
  ambiguity rules are not one abstraction. A third identical normalization policy would justify a
  shared low-level normalizer.
- Canonical MusicBrainz UUID regexes already appear in several modules, but their semantics differ:
  some accept uppercase, some require lowercase, and discovery validates RFC version/variant bits.
  A repository-wide consolidation inside #207 risks changing plan/apply and discovery contracts.
  Add a bridge-local canonicalizer now; perform a separate semantic audit before extracting
  `lib/musicbrainz-id.ts`.
- Use the existing mapped-type mock pattern in both adapter and Lidarr helpers rather than creating
  bridge-specific mock classes.
- A small amount of repeated safe-integer checking in the expansion calculator is preferable to
  coupling bridge types to `LidarrPlanValidationError` and cascade-analysis internals.

## Public APIs and Extension Points

Keep the surface narrow and immutable:

```ts
interface MediaServerIdentityCapability {
  instanceId(): Promise<string>;
  artists(options: {
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
  now?: () => Date,
): BridgeArtistIdentitySnapshot | undefined;

function replaceBridgeIdentitySnapshot(db: DbConnection, snapshot: BridgeArtistIdentitySnapshot): void;

function purgeBridgeIdentitySnapshot(db: DbConnection, scope: BridgeIdentityScope): number;

function calculateBridgeExpansionImpact(input: BridgeExpansionInput): BridgeExpansionImpact;
```

The resolver input should accept arrays of stable domain records plus explicit options. It should
not accept clients, database handles, loaded config, or callbacks. Candidate ordering must be
stable (score descending, normalized title, then opaque ID), bounded, and returned as fresh frozen
objects.

Separate match method from review state. A fuzzy candidate can have a high score and still be
`suggested`; only unique MBID evidence is automatically `matched`. An explicit reviewed decision
must retain source/target MBIDs and be invalidated when later live MBID evidence conflicts.

Scope must include the Plex library discriminator in addition to credential-free Plex and Lidarr
origins and entity kind. Two music libraries on one Plex server must not overwrite each other.
Store the opaque Plex instance ID with the snapshot and refuse to merge decisions across a changed
instance.

Avoid exposing cache row types, Plex machine identifiers as general adapter metadata, raw GUID
namespaces, generated Lidarr types, or SQL statements as extension points.

## Testability

- **Pure resolver table:** unique MBID, duplicate MBID, conflicting MBID, normalized-name
  suggestion, fuzzy threshold and margin boundaries, ties, short names, accents, punctuation,
  articles, empty/invalid identities, candidate cap, stable ordering, and immutability.
- **Plex private boundary:** zero/one/many `Guid` values, unknown schemes, malformed/oversized
  arrays, `includeGuids`, pagination forward progress, abort forwarding, library resolution, and
  instance ID reuse. Mock `PlexTransport`; never mock global Fetch in this unit.
- **Adapter composition:** identity is composed from the same private dependencies; tokens and
  machine IDs remain absent from serialization/reflection; existing query/MCP shapes stay
  unchanged.
- **Cache integration:** follow `metadata-cache.test.ts` and database tests by using real temporary
  files, an injected clock, and a real initialized schema. Cover scope isolation, replacement,
  rollback on invalid payload, corrupt JSON/timestamp, explicit offline miss, old snapshot
  preservation after failed replacement, and changed Plex instance.
- **Migration:** preserve an existing v10 database, create the v11 table/index, update exact
  writable/read-only version assertions, and retain the newer-schema rejection behavior.
- **Expansion:** deduplicate track and album IDs, reject unsafe counts, handle zero signaled tracks,
  omit the ratio when any target album count is unknown, and require confirmation only when a
  future album-level action has non-empty scope.
- **Architecture:** run and extend `check-direct-plex-imports.test.mjs` so bridge code cannot import
  `adapters/plex/**`, generated Lidarr modules, own Fetch, or contain handwritten Lidarr endpoints.
- **Regression:** keep the `plex-alignment` reserved-slot test green and run shell completion parity
  without template edits. Run Lidarr codegen drift tests even though no generated file changes.

Test ownership should stay layered: wire guards own malformed provider data, the resolver owns match
policy, the cache owns durability/corruption, and one adapter test owns composition. Do not repeat
the full matching matrix through cache, adapter, audit, and future command tests.

## Build vs Depend

- **Depend:** keep `better-sqlite3` for durability and transactions and `fastest-levenshtein` for
  distance calculation; both are already runtime dependencies.
- **Build locally:** the ordered MBID/name policy, typed outcomes, strict snapshot parser, and
  expansion calculation are small domain logic with repository-specific safety rules.
- **Do not add:** an ORM, migration framework, generic fuzzy-search package, entity-resolution
  framework, UUID package, cache package, or direct MusicBrainz client. Each adds maintenance or
  network policy without solving a current gap.
- **No generated-client work:** `listArtists()` already exposes the required Lidarr data. Preserve
  codegen checks, but do not refresh or modify the committed OpenAPI snapshot for #207.

## Open Questions

1. What exact Plex request option and sanitized fixture prove artist GUID availability, cardinality,
   and `mbid://` syntax for the configured music agent?
2. What is the cache's offline library key: stable Plex section ID, configured library name, or a
   tuple of both? This must be decided before schema migration; origins plus kind are insufficient.
3. Does #207 need to persist explicit reviewed overrides despite having no operator-facing
   consumer, or is persisting deterministic suggestions sufficient until #208 supplies the review
   workflow?
4. What corpus establishes the initial fuzzy threshold and winner margin? Until fixtures justify
   values, keep them explicit, conservative resolver options rather than configuration.
5. Should a compatible reviewed name decision survive a resolver-version change, or require
   re-review? Fail-closed re-review is simpler and safer for v1.
6. Is a whole-snapshot JSON row measurably too large for the expected largest artist library? If
   not, defer normalized entity/mapping tables until #208 demonstrates indexed query value.
7. What exact fields constitute `BridgeExpansionImpact` before a consumer exists? Keep only counts,
   unknown-count evidence, ratio, and confirmation requirement; do not predesign presenter prose or
   plan schema.
