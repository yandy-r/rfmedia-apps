# Lidarr Search and Lookup

Issue #222 extends the existing Lidarr vertical slice with three read-only identity-resolution
commands backed by one mode-parameterized action. Commander leaves call the
`metadata-dependent` scheduler, which owns preflight and retries while a resilient facade owns
circuit feedback, query-keyed caching, and explicit stale fallback. The stable facade remains the
only handwritten consumer of the private generated operations, and strict projectors prevent
generated DTOs from crossing into command-facing types. Paging, ranking, and output shaping are
deterministic client-side operations over a complete bounded response.

## Relevant Files

- `docs/plans/lidarr-search-lookup/feature-spec.md`: Settled scope and acceptance contract.
- `docs/plans/lidarr-search-lookup/analysis-architecture.md`: Layer boundaries and execution ownership.
- `docs/plans/lidarr-search-lookup/analysis-patterns.md`: Existing code and test patterns.
- `docs/plans/lidarr-search-lookup/analysis-integration.md`: Endpoint, cache, and failure contracts.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Public generated-independent domain projections.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict unknown-to-domain boundary projectors.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-operation facade owner.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Connection and resilience composition root.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Breakers, retries, cache, and fallback.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: Sole metadata-cache CRUD owner.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Preflight, retry, terminal fallback, and metadata.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: Client-side paging and action-result precedent.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Parent hierarchy and shared presentation/failures.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Fail-closed generated contract.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Executable SDK coupling.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: All-shell parity gate.

## Relevant Tables

- `lidarr_metadata_cache`: Origin/category/discriminator-scoped validated projection cache.
- `lidarr_circuit_state`: Persisted `lidarr` and `metadata` breaker state shared by execution.

No migration or schema-version change is required. The cache columns are unconstrained text and
already enforce uniqueness across origin, category, and discriminator.

## Relevant Patterns

**Generated boundary**: Only
[`packages/rfmedia-cli/src/lib/lidarr/client.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/client.ts)
imports generated operations; public contracts stay narrow and generated-independent.

**Scheduler-owned retry**: Gated idempotent reads use
[`packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/scheduler.ts)
for one preflight, bounded live retries, and one terminal fallback; scheduled resilience calls
disable their internal gate, retries, and stale serving.

**Strict projection**: Unknown wire and cached data are atomically validated and copied in
[`packages/rfmedia-cli/src/lib/lidarr/types.ts`](../../../packages/rfmedia-cli/src/lib/lidarr/types.ts)
before entering actions.

**Machine stream discipline**: Commands emit human output to stderr and one
`{ command, result }` JSON/YAML/CSV document to stdout, following
[`packages/rfmedia-cli/src/commands/lidarr.ts`](../../../packages/rfmedia-cli/src/commands/lidarr.ts).

## Relevant Docs

**`packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**: You _must_ read this when
changing facade operations, projections, codegen gates, or generated ownership.

**`packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**: You _must_ read this when
changing metadata preflight, retries, cancellation, or execution metadata.

**`docs/plans/lidarr-metadata-resilience/design.md`**: You _must_ read this when changing breaker,
cache-key, TTL, stale, or fallback behavior.

**`docs/features/shell-completion.md`**: Reference for static Bash, Zsh, and Fish completion parity.
