# Lidarr Search and Lookup Implementation Plan

Implement issue #222 as three read-only Commander paths backed by one mode-parameterized action,
the existing `metadata-dependent` scheduler, a query-aware resilient facade, strict
generated-independent projections, and the private generated Lidarr client. Keep live Lidarr as the
only network provider, preserve upstream relevance order, and apply deterministic dedupe, rank, and
client-side paging after validating the complete bounded response. Share raw client, persisted
breakers, and preflight construction so the scheduler is the sole retry and health-gate owner for
scheduled lookups. Complete the surface with deterministic human/machine output, all-shell
completion parity, operator and architecture documentation, roadmap history, review, and full
validation.

## Critically Relevant Files

- `docs/plans/lidarr-search-lookup/feature-spec.md`: Settled scope, contracts, and merge stops.
- `docs/plans/lidarr-search-lookup/shared.md`: Architecture, patterns, tables, and must-read index.
- `docs/plans/lidarr-search-lookup/analysis-architecture.md`: Layer and execution ownership.
- `docs/plans/lidarr-search-lookup/analysis-integration.md`: Endpoints, cache identity, and failures.
- `packages/rfmedia-cli/src/types/lidarr.ts`: Public generated-independent Lidarr projections.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict unknown-to-domain projector boundary.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-operation facade owner.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Connection, breaker, and resilience composition.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Retry, circuit, cache, and fallback policy.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Gated admission and retry ownership.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`: Terminal fallback and attempt accounting.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Existing hierarchy, presentation, and failures.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Generated/manual ownership.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Preflight and execution contract.
- `docs/plans/lidarr-metadata-resilience/design.md`: Persisted circuit/cache rationale.
- `.github/pull_request_template.md`: Required pull-request evidence contract.
- `ROADMAP.md`: Living issue sequencing and completion record.

## Implementation Plan

### Phase 1: Stabilize the Search Boundary

#### Task 1.1: Add Domain Contracts and Strict Search Projectors Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`

Add the `search | artist | album` mode, generated-independent query/input/candidate contracts, and
the ranked action-result shape from the feature spec. Add strict projectors for combined search,
artist lookup, and album lookup that treat generated data as unknown, construct fresh frozen
objects, and reject the full response atomically when any record is malformed or the collection
exceeds 1,000. Require durable foreign IDs, accept optional positive local Lidarr IDs, require
exactly one artist/album branch for combined records, ignore response-local combined `id`, omit
management/generated fields, and reject unsafe descriptive text. Create focused source-adjacent
projector tests covering valid and hostile wire shapes; do not export generated types.

#### Task 1.2: Extend the Fail-Closed Generated Client Contract Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/research-external.md`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Add `getApiV1Search`, `getApiV1ArtistLookup`, and `getApiV1AlbumLookup` plus their exact GET paths
to the generator's required operation/endpoint set. Extend generator fixtures and the executable
contract test to pin NodeNext imports, `term` query serialization, response envelopes, custom
Fetch, abort forwarding, and two-client origin isolation for all three operations. The pinned
snapshot already contains these operations: do not refresh the OpenAPI file, edit generated output,
add a dependency, or perform network I/O.

#### Task 1.3: Implement Pure Query Normalization and Result Shaping Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/feature-spec.md`
- `docs/plans/lidarr-search-lookup/research-security.md`
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/search.ts`
- `packages/rfmedia-cli/src/lib/lidarr/search.test.ts`

Files to Modify

- None.

Implement pure helpers for outer trim plus NFC normalization, C0/C1/bidi rejection, the 1–256 code
point and 1,024 UTF-8 byte bounds, exact `lidarr:`, `lidarrid:`, and `mbid:` UUID recognition, and
canonical `lidarr:<lowercase-uuid>` output. Build the privacy-preserving discriminator
`v1:<mode>:sha256(normalized-term)`, stable first-win dedupe by `(kind, foreignId)`, one-based rank
assignment before slicing, and safe `offset`/`limit` page metadata. Test Unicode boundaries,
malformed prefixes, cleartext exclusion from keys, stable ordering, duplicate identity, empty and
offset-past-total results, integer overflow, and immutability. Keep I/O, Commander, and SQLite out
of this module.

#### Task 1.4: Add Lookup Cache Category and Discriminator Coverage Depends on [1.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/analysis-integration.md`
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.test.ts`

Add the `lookup` category while retaining the existing schema-v10
`(origin, category, discriminator)` key and sole SQL ownership. Prove origin/mode/term/version
isolation, complete empty-array storage, TTL/stale-ceiling behavior, corruption handling, pruning,
and the absence of API keys and cleartext queries in stored keys or payload metadata. Do not add a
migration or schema-version bump.

#### Task 1.5: Add the Three Stable Facade Methods Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`

Extend `LidarrClientApi` and `LidarrClient` with explicit `search`, `lookupArtists`, and
`lookupAlbums` methods. Call only the corresponding generated operations, pass the normalized
`term` and caller signal through the existing sanitized execution boundary, unwrap the generated
envelope privately, and apply the strict projectors from Task 1.1. Test exact URL/query shape,
empty arrays, optional local IDs, malformed/ambiguous/oversized responses, fresh frozen copies,
abort identity, and redacted typed failures. Add exhaustive typed mock defaults returning frozen
empty arrays.

### Phase 2: Integrate Resilience and Scheduled Execution

#### Task 2.1: Add a Query-Aware Resilience Execution Context Depends on [1.3, 1.4, 1.5]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/feature-spec.md`
- `docs/plans/lidarr-metadata-resilience/design.md`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`

Add all three facade methods to exhaustive wrapper/retry metadata, but configure scheduled lookup
calls with no internal health gate, no in-place retry, and no per-attempt stale serving. Export a
resilience execution-context factory whose concrete contract exposes: the live decorated client,
a lazy shared breaker-pair accessor, a non-throwing `writeLookupCache(discriminator, value)`, and a
generic terminal `tryServeStale({ category, discriminator, error, validate })`. The write helper
caches the complete validated/deduplicated/ranked pre-page projection including `[]`; the terminal
helper revalidates cached JSON and emits the sole warning/callback only on a served hit. Retain
`createResilientLidarrClient()` as a compatibility wrapper for existing commands.

Test explicit consent, exact origin/mode/term/version isolation, eligible fallback only for
metadata-provider-unavailable, lidarr-unreachable, and timeout, no fallback for rate
limit/auth/cancellation/invalid-response, shared breaker identity, live result/error preservation
on cache failures, and the fact that a scheduled live attempt never serves stale itself.

#### Task 2.2: Add a Scheduler Terminal Fallback Hook Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`
- `docs/plans/lidarr-search-lookup/analysis-architecture.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`

Extend `runSingle` options with a typed asynchronous terminal-fallback hook that receives the final
preflight or task error only after preflight rejection or all scheduled live attempts finish. The
hook returns an explicit served/miss discriminated result. A served value makes `runSingle`
resolve with success metadata using the original task ID, operation, lane, and exact live-attempt
count (`0` for preflight rejection); a miss rethrows the original object with its failure metadata
unchanged. Never invoke the hook for caller cancellation, never run it between retry attempts, and
invoke it at most once. Add focused tests for preflight
hit/miss, retry exhaustion before fallback, exact attempt counts, successful live calls that skip
fallback, cancellation, fallback failure preserving the original error, and metadata.

#### Task 2.3: Compose One Client, Breaker Pair, Preflight, and Terminal Fallback Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/analysis-architecture.md`
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`

Add `resolveRequiredLidarrExecutionContext()` returning `{ client, preflight,
writeLookupCache, tryServeStale }` from one raw facade, canonical credential-free origin, resolved
policy, and the resilience context's one persisted `lidarr`/`metadata` breaker pair. The preflight
must use the raw client and that exact pair; the live client disables its own health gate, retries,
and stale serving. Preserve `resolveRequiredLidarrClient()` as a compatibility wrapper. Prove one
client/breaker context, one health probe, cancellation propagation, safe URL/config handling, lazy
database access, terminal fallback access after preflight failure, and no credential exposure.

#### Task 2.4: Add the Mode-Parameterized Scheduled Search Action Depends on [1.3, 1.5, 2.3]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/feature-spec.md`
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- `packages/rfmedia-cli/src/actions/lidarr/search.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Implement one `executeLidarrSearch` action with `TIER = "metadata-dependent"`. Validate the term
and paging before client/cache I/O, select exactly one facade method by mode, and submit one
idempotent scheduler task with the required shared preflight and task abort signal. Each live task
attempt must strictly project, deduplicate, rank, and non-fatally write the complete pre-page
projection; it must not read stale cache. Pass the scheduler a terminal fallback that consults the
exact query cache once after preflight rejection or retry exhaustion and returns the revalidated
complete projection on hit. Let the scheduler own retries, terminal fallback timing, and success
metadata. Return the normalized query, ranked page, true total, paging fields, provider/degradation,
fallback reason, optional cache status, and execution metadata. Test exact task IDs/operations, one
preflight, retry exhaustion before fallback, preflight rejection with cache hit/miss, `0` live
attempts on preflight fallback, one warning, each mode, empty results, cancellation, and original
typed errors on miss/corruption.

### Phase 3: Expose, Document, and Validate the Command Suite

#### Task 3.1: Register the CLI Tree and Deterministic Presenters Depends on [2.4]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/research-ux.md`
- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr-albums.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-search.ts`

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Register `lidarr search <term>`, `lidarr lookup artist <term>`, and
`lidarr lookup album <term>` with command IDs `lidarr-search`,
`lidarr-lookup-artist`, and `lidarr-lookup-album`. Add shared `--limit` default 50/range 1–200,
safe non-negative `--offset` default 0, `--allow-stale`, and connection overrides. Keep lazy action
and formatter imports, human heading/table/paging/provider/execution output on stderr, and one
machine document on stdout. JSON/YAML must retain `{ command, result }`; CSV must use a fixed flat
summary row followed by candidate rows so empty results retain query and provenance. Test command
hierarchy, option forwarding, invalid-input zero I/O, empty/degraded states, hostile text,
redaction, ANSI-free machine output, CSV formula neutralization, stream discipline, and exit codes.

#### Task 3.2: Add Static Bash, Zsh, and Fish Completion Paths Depends on [3.1]

**READ THESE BEFORE TASK**

- `docs/features/shell-completion.md`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Mirror the exact two-level hierarchy and shared option inventory in all three static templates.
Complete positional term arguments and argument-taking flags correctly, preserve existing help
order and global options, and do not query Lidarr, MusicBrainz, configuration, or network state
during completion.

#### Task 3.3: Lock All-Shell Completion Parity Depends on [3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add exact Bash/Zsh/Fish assertions for `search`, `lookup artist`, and `lookup album`, every shared
option, argument-taking behavior, static operation, and hierarchy parity with Commander. Preserve
all existing completion tests and add no snapshots that hide missing leaves.

#### Task 3.4: Document the Operator and Architecture Contracts Depends on [3.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-search-lookup/analysis-docs.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

Document all three commands, inputs/defaults, exact MBID syntax, candidate fields, ordering/paging,
empty results, human and machine output, explicit stale fallback, failure classes, exit behavior,
and no-mutation/no-direct-provider scope. Update generated-client documentation with the three
required operations and lookup projection boundary. Update execution lanes to describe the shipped
metadata-dependent use, one shared preflight, scheduler-only retries, cancellation, and query-cache
interaction.

#### Task 3.5: Add README, Changelog, and Documentation Discovery Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `docs/README.md`
- `docs/plans/lidarr-search-lookup/analysis-docs.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `docs/README.md`

Add concise combined and typed lookup examples, option/output/fallback notes, and a link to the
canonical guide in the package README. Add an `[Unreleased]` entry without claiming a release, and
index the new and relevant existing Lidarr guides in the documentation hub. Do not rewrite the
historical resilience design or generic completion guide.

#### Task 3.6: Update Living and Archived Roadmap Records Depends on [3.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/plans/lidarr-search-lookup/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Mark both #222 entries shipped on 2026-07-23, remove it from open counts and narrative, advance
Sprint 1 sequencing, and add the issue to the appropriate Lidarr shipped-history track with an
operator note. Use only known issue/date facts during implementation; the orchestrator will add the
real closing PR number after PR creation before final merge. Preserve open #220/#223 and other
future-provider scope.

#### Task 3.7: Run Integrated Validation and Refresh the Knowledge Graph Depends on [3.3, 3.4, 3.5, 3.6]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `.github/workflows/rfmedia-cli.yml`
- `CLAUDE.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Run these exact gates, fixing failures through the owning task:

- `npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/types.test.ts src/lib/lidarr/search.test.ts src/lib/lidarr/client.test.ts src/lib/lidarr/metadata-cache.test.ts src/lib/lidarr/resilience.test.ts src/lib/lidarr/scheduler.test.ts src/lib/lidarr/index.test.ts src/actions/lidarr/search.test.ts src/commands/lidarr.test.ts src/lib/shell-completions/templates.spec.ts`
- `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`
- `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`
- `npm run test:architecture --workspace packages/rfmedia-cli`
- `npm run check:architecture --workspace packages/rfmedia-cli`
- `npm run typecheck --workspace packages/rfmedia-cli`
- `npm run test:coverage --workspace packages/rfmedia-cli`
- `npm run build --workspace packages/rfmedia-cli`
- `npm run format:check`
- `npx --no-install markdownlint-cli2 "docs/plans/lidarr-search-lookup/*.md" "packages/rfmedia-cli/docs/**/*.md" "ROADMAP.md" "docs/roadmap-archive.md"`
- `git diff --check`

Run `graphify update .` only when `graphify-out/graph.json` exists in this worktree; otherwise record
that the dedicated worktree has no graph to refresh and do not generate new graph artifacts.

## Advice

- Resolve any research conflict in favor of `feature-spec.md`: positional terms, exactly three
  paths, the 256-code-point/1,024-byte limit, live-first fallback, and the existing machine envelope.
- Do not compose the current resilient health gate with scheduler preflight naively. Scheduled
  lookup must prove one preflight and one retry owner while still feeding the shared persisted
  breakers. Stale lookup occurs once through the scheduler terminal hook, never inside a live
  attempt.
- Cache identity excludes API keys, cleartext terms, offset, and limit. Cache the complete validated,
  deduplicated, ranked projection, including `[]`, only after live shaping, and revalidate it before
  terminal serving.
- Preserve upstream relevance order and use `(kind, foreignId)` as identity. Combined response
  `id` is not durable, and lookup records are not installed-library records.
- Keep the generated tree private and unchanged. Only `client.ts` selects the existing generated
  operations, and `transport.ts` remains the sole production Fetch owner.
- Human output belongs on stderr; JSON/YAML/CSV must be the only stdout content. Use an explicit
  summary row for CSV so an empty result still communicates query, paging, provider, and execution.
- ROADMAP history can record #222 and the completion date during implementation, but the actual PR
  link must be added only after GitHub assigns it.
