# Architecture Analysis: Lidarr Search and Lookup

## Executive Summary

Issue #222 should extend the existing Lidarr vertical slice, not introduce a new provider stack:
three thin Commander leaves feed one mode-parameterized action, the existing
`metadata-dependent` scheduler, a resilient facade, strict generated-independent projections, and
the sole authenticated transport. The main architectural risk is execution ownership: scheduler
preflight and retries must share the raw facade and persisted circuit breakers with resilience
without performing a second health probe or a second retry loop. The feature specification is the
authoritative contract where research differs: positional terms, modes `search | artist | album`,
256 code points plus 1,024 UTF-8 bytes, live-first cache fallback, and the existing
`{ command, result }` machine envelope.

## Architecture Context

```text
commands/lidarr-search.ts
  -> actions/lidarr/search.ts
    -> metadata-dependent scheduler (one preflight, retries, terminal fallback, metadata)
      -> live resilient LidarrClientApi (breaker feed; no internal gate/retry/stale)
        -> lib/lidarr/client.ts (generated-operation selection)
          -> private generated SDK
            -> lib/lidarr/transport.ts (sole authenticated Fetch owner)
      -> shaped full-projection cache write / terminal exact-query cache read
```

- **Command boundary:** Register `lidarr search <term>` and
  `lidarr lookup artist|album <term>` in `commands/lidarr.ts`; keep parsing, human presentation,
  machine/CSV projection, and failure reporting in a dedicated command factory.
- **Action boundary:** One `executeLidarrSearch` selects the facade method, submits one idempotent
  scheduled task, attaches paging/provenance/execution metadata, and never renders.
- **Domain boundary:** Public candidate/query/result types remain independent of generated DTOs.
  Projectors validate the complete unpaginated response atomically before dedupe, caching, ranking,
  or paging.
- **Client boundary:** `client.ts` alone imports and invokes `getApiV1Search`,
  `getApiV1ArtistLookup`, and `getApiV1AlbumLookup`; `transport.ts` remains unchanged.
- **Resilience boundary:** Cache complete validated, deduplicated, ranked pre-page projections under
  canonical origin × category `lookup` × `v1:<mode>:sha256(NFC(term))`. Live Lidarr is always
  attempted first; stale cache requires consent and an eligible terminal typed failure.
- **Composition root:** Add a resolver that constructs the raw facade, canonical origin,
  store-backed `lidarr`/`metadata` breakers, live resilient facade, scheduler preflight, cache
  writer, and terminal fallback once. Keep `resolveRequiredLidarrClient` as a compatibility
  wrapper.

## Critical Files Reference

- `packages/rfmedia-cli/src/commands/lidarr.ts`: Parent registration and shared output/failures.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: New command tree, presenters, and explicit
  summary-plus-candidate CSV projection.
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`: New mode-parameterized scheduled action.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Action/type exports.
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`: New pure normalization, discriminator,
  first-win dedupe/rank, and local offset/limit helpers.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Stable candidate/query/action-result contracts.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict projectors with the 1,000-record cap.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Facade methods and generated-operation dispatch.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Shared execution-context construction and
  compatibility resolver.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Retry/cache maps, breakers, and fallback.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: Add the `lookup` category; existing table
  and discriminator column require no migration.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Existing mandatory gated-lane preflight and
  sole scheduled retry owner.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` and
  `src/lib/lidarr/generated-contract.test.ts`: Fail-closed operation/endpoint requirements.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Exhaustive facade mock
  defaults for all three new reads.
- `src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`: Static parity.

## Cross-Cutting Concerns

- **Retry, preflight, and fallback ownership:** Pass the scheduler signal through preflight and
  lookup; suppress resilient internal gating, retry, and stale serving. The scheduler invokes the
  exact-query fallback once only after preflight rejection or live retry exhaustion. Tests must
  prove one health probe, bounded lookup attempts, and no early stale substitution.
- **Cache correctness and privacy:** Hash the NFC-normalized term, include mode and projection
  version, exclude paging/API keys/cleartext terms, cache valid empty arrays, and revalidate cached
  payloads before serving.
- **Failure semantics:** Only `metadata-provider-unavailable`, `lidarr-unreachable`, and `timeout`
  permit stale fallback. Empty `200 []`, authentication, rate limiting, cancellation, and
  `invalid-response` never do; cache failures preserve the live result or original error.
- **Untrusted data:** Enforce bounded/control-free input before any client or cache I/O. Reject an
  entire malformed/oversized response; sanitize descriptive display fields, preserve full IDs, and
  retain CSV formula neutralization.
- **Output compatibility:** Human output remains stderr-only and machine documents stdout-only.
  JSON/YAML retain `{ command, result }`; CSV needs a fixed summary row so empty results retain
  query, paging, provenance, and execution evidence.
- **Architecture drift:** Update the generated contract, retry/cache method maps, typed mocks, and
  all shell completions together. Architecture gates must continue rejecting generated imports,
  handwritten `/api/v1/` paths, and additional production Fetch owners.

## Parallelization Opportunities

- **Boundary track:** Public types/projectors and their hostile-response tests can proceed
  independently from generator requirement/contract updates, then converge in `client.ts`.
- **Execution track:** Pure search helpers/tests can proceed beside the scheduler terminal-fallback
  hook and discriminator-aware resilience/cache context after candidate types stabilize.
- **Surface track:** Command/presenter tests, shell completions, and user documentation can proceed
  in parallel once the action result contract is fixed.
- **Integration gates:** Client integration depends on boundary tracks; action integration depends
  on client plus execution context; command integration depends on the action contract. Run full
  codegen, architecture, completion, typecheck, coverage, and build gates only after convergence.

## Implementation Constraints

- Do not add a runtime dependency, direct MusicBrainz/Last.fm provider, provider abstraction,
  network completion, mutation, or generated-code edit.
- Use exactly the three command IDs and paths from `feature-spec.md`; do not adopt the conflicting
  `search artist|album|all --term|--mbid` research proposal.
- Normalize by outer trim plus NFC, preserve ordinary-text case/internal whitespace, validate
  prefixed UUIDs locally, and canonicalize exact IDs to `lidarr:<lowercase-uuid>`.
- Preserve upstream order, dedupe by `(kind, foreignId)` with first result winning, rank before
  slicing, and validate no more than 1,000 upstream records.
- Do not reuse installed-library `LidarrArtist`/`LidarrAlbum` types: lookup candidates require
  foreign identity while local numeric IDs and management fields are optional or excluded.
- No database schema migration is needed; extend the category union and use the existing
  `(origin, category, discriminator)` key.
- Preserve header-only API-key injection, origin pinning, redirect rejection, cancellation,
  timeout/body limits, fatal decoding, and redaction in the existing transport.
- Required validation includes focused helper/client/action/resilience/command tests, generated
  client check/tests, architecture tests, three-shell parity, typecheck, coverage, build, formatter
  checks, and `git diff --check`.
