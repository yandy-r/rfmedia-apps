# Pattern & Code Analysis: Lidarr Search and Lookup

## Executive Summary

Issue #222 fits the existing command → action → resilient facade → generated client → hardened
transport layering, but is the first command combining a gated `metadata-dependent` lane with
query-keyed projections. Implement one mode-parameterized capability, three thin command leaves,
strict generated-independent projectors, and a shared execution context so the scheduler and
resilience wrapper do not duplicate health gates, retries, clients, or circuit breakers.

The generated operations already exist, so no SDK refresh or dependency is needed. Still update
every fail-closed surface: facade and mock, resilience maps, cache keys, generator requirements,
contract/hierarchy tests, and all three completion templates.

## Implementation Patterns

- **One capability, explicit endpoint methods:** Add one pure helper and one
  `executeLidarrSearch({ mode, ... })` action, but keep `search`, `lookupArtists`, and
  `lookupAlbums` as explicit `LidarrClientApi` methods because their generated operations and wire
  shapes differ. Follow the narrow method pattern in
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`.
- **Strict boundary projection:** Define candidate/query/result contracts in
  `packages/rfmedia-cli/src/types/lidarr.ts`; validate unknown wire values and return fresh frozen
  objects from `packages/rfmedia-cli/src/lib/lidarr/types.ts`. Reuse its atomic projector style,
  `1_000`-record bound, safe-string checks, optional-field omission, and `Object.freeze` copies.
- **Generated operation ownership:** Import the three generated operations only in `packages/rfmedia-cli/src/lib/lidarr/client.ts`; invoke them through `#execute` with `{ client, query: { term }, signal }`.
- **Pure search shaping:** Put trim/NFC normalization, exact-MBID canonicalization, hashed cache
  discriminator, stable first-win dedupe, rank-before-slice, and paging arithmetic in
  `packages/rfmedia-cli/src/lib/lidarr/search.ts`. Keep I/O, logging, and Commander out of this
  module so table-driven tests remain exhaustive.
- **Scheduler-owned execution:** Mirror `packages/rfmedia-cli/src/actions/lidarr/list.ts` with
  `runSingle`, an idempotent task, execution metadata, and a terminal fallback. Search uses
  `metadata-dependent`; its live facade disables internal gate/retry/stale serving.
- **Live-first whole-result cache:** Cache the complete validated/deduplicated/ranked array,
  including valid empty arrays, before paging. Consult it once only after scheduler preflight
  rejection or retry exhaustion. Use origin × category `lookup` ×
  `v1:<mode>:<sha256(NFC-term)>`; never include paging, cleartext terms, or credentials.
- **Thin command factory:** Create `packages/rfmedia-cli/src/commands/lidarr-search.ts` for the
  three leaves, presenters, and dedicated flat CSV projection, then register it from
  `packages/rfmedia-cli/src/commands/lidarr.ts`. Preserve lazy action/formatter imports and shared
  Lidarr failure reporting.

## Existing Code Structure

- `packages/rfmedia-cli/src/commands/lidarr.ts`: Commander hierarchy, numeric parsers,
  `{ command, result }` envelopes, stderr tables, execution summaries, redaction, and exit codes.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: Closest client-side paging and stale-status
  action precedent; its `total` is computed before `slice`.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable generated-client facade and sanitized
  `invalid-response` boundary; the only handwritten module allowed to call generated operations.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Connection/composition root. It currently returns
  only a resilient client, so it needs a shared client/preflight execution-context resolver.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Runs one required gated-lane preflight, owns
  retries, and attaches safe execution metadata to errors.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Exhaustive manual method wrapper, retry
  allowlist, circuit feeding, write-through cache, eligible stale fallback, and sole stale warning.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: Sole cache CRUD owner; its existing
  origin/category/discriminator schema requires no migration.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` and
  `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Fail-closed generated operation,
  endpoint, method, query, envelope, and per-client isolation gates.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Despite its name, this is also the
  Lidarr architecture gate for generated imports/re-exports, handwritten API paths, and the sole
  authenticated Fetch owner.

## Code Conventions

- Use strict TypeScript, NodeNext `.js` specifiers, readonly contracts, frozen projections, JSDoc,
  and exhaustive discriminated unions.
- Validate terms/options before I/O. Add a `1..200` limit parser because the existing positive
  parser has no upper bound; keep offset a safe non-negative integer.
- Preserve upstream order; dedupe on `(kind, foreignId)` with the first record winning; assign
  one-based rank before applying `offset` and `limit`.
- Treat `200 []` and offset-past-total as successful empty results. Reject malformed or oversized
  collections atomically as `invalid-response`; never salvage or cache partial data.
- Human output uses `console.error`; JSON/YAML/CSV is the only stdout output through
  `formatOutput`. Keep API keys and credential-bearing URLs in the existing sensitive-value
  redaction path.
- Tests use Vitest hoisted mocks and `vi.clearAllMocks()` rather than `resetAllMocks()`. Cache tests
  use real temporary SQLite files, while client tests inject Fetch and assert exact generated
  request URLs, query serialization, abort forwarding, freezing, and sanitized failures.

## Integration Points

- Extend `LidarrClientApi`, `LidarrClient`, and
  `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` together; new mock methods
  should default to frozen empty arrays.
- Add a resolver in `packages/rfmedia-cli/src/lib/lidarr/index.ts` returning
  `{ client, preflight, writeLookupCache, tryServeStale }` built from one raw facade, canonical
  origin, policy, database-backed breaker pair, and resilience context. Keep
  `resolveRequiredLidarrClient` as a compatibility wrapper.
- Extend `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` with all three method wrappers and
  retry classification. Parameterize cache metadata with a discriminator and revalidate cached
  search payloads before returning them.
- Add the three paths/operations to `REQUIRED_ENDPOINTS`/`REQUIRED_OPERATIONS` and test their GET
  method, `term` query, response envelopes, and two-client isolation.
- Update `packages/rfmedia-cli/src/actions/lidarr/index.ts`, command mocks/hierarchy tests, Bash/Zsh/
  Fish templates, and `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` in the
  same change; completions must remain static and network-free.
- Focus tests on helpers, scheduling/preflight, facade projection, cache isolation, output,
  codegen, architecture, and completion parity before typecheck/build/full tests.

## Gotchas and Warnings

- The current resilience wrapper performs its own gate, retries, stale fallback, and privately
  creates breakers, while the scheduler requires a preflight. Naively composing both causes
  duplicate health requests or early stale substitution; share one context and make the scheduler
  the sole preflight/retry/terminal-fallback owner for this action.
- Resilience cache calls currently hardcode the whole-list discriminator `""` and cache reads cast
  parsed JSON without domain revalidation. Search must carry its query discriminator end to end
  and validate cached projections before use.
- Combined-search `id` is only a response-local ordinal. Durable identity is `kind + foreignId`,
  and a combined member must have exactly one valid artist/album discriminator.
- Lookup endpoints are unpaginated. Local `--limit`/`--offset` does not reduce response size or
  provider work; validate the entire bounded response before slicing.
- Remote lookup candidates may have no positive local Lidarr ID. Do not reuse installed-library
  `LidarrArtist`/`LidarrAlbum` types or expose paths, profiles, tags, images, tracks, or releases.
- The generic Lidarr CSV projector serializes nested arrays into one cell and loses useful empty
  result context. Search needs a fixed summary row plus candidate rows with formula neutralization.
- Do not hand-edit generated files, add direct MusicBrainz/Last.fm access, add a Fetch owner, or
  introduce a provider abstraction/dependency; those belong to later issues.
