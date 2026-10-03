# Engineering Practices Research: Lidarr Search and Lookup

## Executive Summary

Issue #222 should be implemented as one read-only lookup capability with three thin command leaves,
not three independent feature stacks. Reuse the generated-client facade, metadata-dependent
scheduler lane, resilience/cache primitives, output formatter, and completion parity tests; the only
material architectural gap is creating one execution context that shares the raw client and circuit
breakers between scheduler preflight and the resilient facade without running the health gate twice.

Keep direct external providers, discovery/ranking, and all add/edit mutations out of scope. The
smallest maintainable design is one mode-parameterized action, three explicit facade methods and
strict projectors, one query-aware cache category, and a command factory that owns all three leaves.

## Existing Reusable Code

- `packages/rfmedia-cli/src/commands/lidarr.ts`: Parent tree and shared failure/execution helpers;
  register a sibling search-command factory here.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: New owner of the three leaves, search
  rendering, versioned envelopes, and explicit CSV rows.
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`: New single orchestration action parameterized
  by `all | artist | album`.
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`: New pure term normalization, cache-key, stable
  dedupe/rank, and offset/limit slicing helpers.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable facade; only production importer of the
  three generated lookup operations.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Runtime wire guards and fresh frozen lookup
  projections.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Generated-independent candidate/query/result types.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Composition root for the shared client/preflight
  execution context.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Retry allowlist, query-aware cache
  discriminator, eligible stale fallback, and shared breaker lifecycle.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: Extend the category union only; its table
  already supports arbitrary discriminators, so no schema migration is needed.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Fail closed on all three required
  generated operations and endpoints.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Pin lookup exports, methods,
  paths, query serialization, and envelopes.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts`: Complete command/flag parity across all shells.

## Modularity Design

- **One capability, three modes:** Share validation, scheduling, cache behavior, paging, provenance,
  and output schema through `executeLidarrSearch({ mode, ... })`. Keep three facade methods because
  the upstream endpoints and wire shapes differ; avoid a generic `request(path)` or conditional DTO.
- **Explicit command leaves:** Preserve `lidarr search <term>` and
  `lidarr lookup artist|album <term>` with distinct command IDs. Do not flatten them behind a
  `--type` switch or infer entity kind from optional fields.
- **Command/action/facade/projection boundary:** Commands parse and render; the action orchestrates
  one scheduled unit; the facade chooses a generated operation; projectors validate unknown wire
  data; pure search helpers normalize, dedupe, rank, and page. No layer should absorb its neighbor's
  job.
- **Shared scheduler preflight context:** Add a narrow
  `resolveRequiredLidarrExecutionContext()` returning `{ client, preflight }`. It must create the raw
  facade, canonical origin, lazy store-backed breakers, resilient wrapper, and preflight once.
  Scheduler-owned execution must suppress the wrapper's internal pre-call gate while retaining
  breaker feeding, cache fallback, and success recording. Otherwise the obvious composition causes
  two health probes and competing circuit transitions.
- **Scheduler owns retry:** Submit one idempotent task to the `metadata-dependent` lane, pass its
  signal to the facade, and set resilience in-place retry to zero. Do not add action-level loops.
- **Query-aware whole-result cache:** Reuse `lidarr_metadata_cache`; store the complete validated,
  deduplicated, pre-page projection. Prefer one `"lookup"` category and a versioned discriminator
  containing mode plus a credential-free digest of normalized term. Paging never enters the key.
- **Explicit degradation:** Live Lidarr is always attempted first. SQLite is served only with
  `--allow-stale` after an eligible typed failure; it must report cache age, source, degradation,
  and fallback reason. Cache failures warn without replacing the primary result/error.
- **Output reuse with a narrow exception:** Reuse `isMachineFormat`, `formatOutput`, formula
  neutralization, shared failure envelopes, and execution summaries. Search CSV is one row per
  candidate and needs a dedicated explicit projection; the existing generic Lidarr CSV helper
  serializes arrays into one JSON cell and is not suitable.
- **Generated boundary:** Only `lib/lidarr/client.ts` imports generated code. Keep
  `transport.ts` as the sole authenticated Fetch owner and retain handwritten-path/import/fetch
  architecture gates.
- **Build, do not depend:** The pinned SDK already contains all three operations. Add no runtime
  dependency, direct MusicBrainz client, pagination library, cache package, or architecture-lint
  framework.

## Recommended File Structure

```text
src/commands/lidarr.ts                 # registration + injected shared helpers only
src/commands/lidarr-search.ts          # command tree, presenters, CSV projection
src/actions/lidarr/search.ts           # one mode-parameterized scheduled action
src/actions/lidarr/search.test.ts
src/lib/lidarr/search.ts               # pure normalization/dedupe/rank/page/cache key
src/lib/lidarr/search.test.ts
src/lib/lidarr/client.ts               # three typed facade methods
src/lib/lidarr/types.ts                # three strict wire projectors
src/types/lidarr.ts                    # public discriminated candidate/result contracts
```

Modify existing `index.ts`, resilience/cache tests, client/command tests, generator contract, and
three completion templates in place. Do not create separate artist and album actions, caches,
presenters, schedulers, provider abstractions, or repositories.

## Testing Seams and Ownership

- Extend `LidarrClientApi` and the existing typed mock builder with empty lookup defaults; action
  tests should mock the facade and scheduler/context resolver, never generated modules or Fetch.
- Client/projector fixtures cover each endpoint, query, abort forwarding, missing local IDs,
  malformed unions, duplicate/invalid foreign IDs, unsafe strings, and the 1,000-item bound.
- Pure-helper tables cover text and prefixed MBID normalization, the single chosen term cap
  (recommend 256 code points), stable first-win dedupe, pre-page ranks, offset past end, and
  `hasMore`.
- Action/resilience tests prove one preflight per invocation, scheduler-only retry, whole-result
  caching including empty success, origin/mode/term isolation, explicit stale consent, eligible
  error matrix, and cache I/O failure behavior.
- Command tests pin all three paths, IDs, option bounds, JSON/YAML shape, stable CSV columns,
  stdout/stderr separation, empty/degraded output, redaction, and exit code.
- Run focused Vitest first, then architecture tests, codegen check/tests, completion parity,
  typecheck, package build, and the full rfmedia suite.

## Gotchas & Edge Cases

- The companion research disagrees on 256 versus 512 term length and on case-folding cache keys.
  Settle one exported contract before implementation; 256 plus trim/NFC and canonical lowercase
  MBID prefixes is the conservative choice. Do not collapse internal whitespace.
- Combined search's numeric `id` is response-local, and exact-ID search is artist-first upstream.
  Require `kind + foreignId`; never expose the ordinal as durable identity.
- Lookup endpoints are unpaged arrays. `--limit/--offset` only slice locally and cannot reduce
  provider work; preserve upstream order and rank before slicing.
- A successful empty array is not an outage. Cache it under the normal policy; adding a special
  negative-cache TTL or schema/config knob now is premature.
- Generated TypeScript types do not validate runtime responses. Reject the entire collection on a
  malformed or oversize member rather than silently returning partial results.
- Adding facade methods without updating the resilience method map, retry allowlist, mock builder,
  generator requirements, and architecture/contract tests creates fail-open drift.
- The existing `src/lib/pagination.ts` advances server pages and is the wrong abstraction for local
  slicing; reuse the list command's offset/limit semantics, not that helper.
- Do not generalize `MetadataFallbackSource` for a provider that #222 does not ship. No direct
  MusicBrainz/Last.fm calls, provider merging, discovery, interactive selection, or add mutation.

## Relevant Docs

- [Issue #222](https://github.com/yandy-r/rfmedia-apps/issues/222)
- `docs/plans/lidarr-search-lookup/research-{external,business,technical}.md`
- `docs/plans/lidarr-metadata-resilience/design.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
