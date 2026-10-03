# Engineering Practices Research: Lidarr Similar-Artist Discovery

## Executive Summary

Issue #203 should add one Last.fm-specific, read-only discovery path and compose it with Lidarr only
at an explicit handoff boundary. The current search implementation provides good patterns for safe
text normalization, immutable ranking, command/action separation, output provenance, scheduler
metadata, and completion parity, but its Lidarr client, resilience context, and SQLite cache are the
wrong dependencies for ordinary discovery. `rfmedia lidarr discover --artist "Name"` must require
only Last.fm configuration and must not initialize or contact Lidarr.

The KISS design is a thin `lidarr-discover.ts` command, one framework-independent action, and one
Last.fm module that owns fixed-origin HTTP, strict response projection, and the single new external
Fetch call site. Use native Node 22 `fetch`, `URL`, `URLSearchParams`, `AbortSignal`, and small
runtime guards; do not add a Last.fm SDK. Register that module explicitly in the existing
architecture scanner and its fixture tests.

Apply the rule of three strictly. Issue #203 has one provider, so it should not ship a provider
registry, weighted merger, source-selection flag, generic aggregation model, or Plex/MusicBrainz/
ListenBrainz adapters; those are issue #204. A fixed, typed `source` object is enough to preserve
Last.fm attribution and a stable future extension point. Likewise, a boolean `--add` must not issue
an immediate POST. If #203 must implement addition rather than merely identify a selected handoff,
`--add <rank>` should create a sealed, single-artist `artist-add` plan for the existing
`rfmedia lidarr apply` path. The repository has no artist-add facade or plan operation today, so
that is real plan/apply work, not a reuse-only three-file change.

## Existing Reusable Code

| Existing code                                                                                   | Reuse                                                                                                                                                                                                         | Adaptation or caution                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/lidarr/search.ts:normalizeLidarrSearchTerm()`                                          | Copy its trim, NFC, code-point/byte bounds, and terminal-control rejection policy for an artist-name validator.                                                                                               | Do not call it directly: it accepts Lidarr/MBID prefixes and throws `LidarrValidationError` with a Lidarr-search operation label. Last.fm accepts an artist name, not that wider grammar.                                                                                  |
| `src/lib/lidarr/search.ts:rankLidarrSearchCandidates()`, `pageLidarrSearchCandidates()`         | Reuse the first-win dedupe, rank-before-slice, immutable-copy, and bounded-collection practices.                                                                                                              | Do not reuse the candidate types or MusicBrainz identity key. Last.fm ranking includes a provider `match` value and may omit MBID; preserve provider order and dedupe by canonical MBID, then normalized name.                                                             |
| `src/commands/lidarr-search.ts:createSearchLeaf()` and `renderSearchResults()`                  | Follow the DI command-factory pattern, pre-import validation, lazy action import, human stderr, machine stdout, explicit CSV columns, and execution summary.                                                  | Create `src/commands/lidarr-discover.ts`; do not add another large inline section to `commands/lidarr.ts` or make discovery another `LidarrSearchMode`.                                                                                                                    |
| `src/actions/lidarr/search.ts:executeLidarrSearch()`                                            | Follow one scheduled task, abort forwarding, frozen result objects, full-set shaping before local selection, and explicit provenance metadata.                                                                | Do not call `resolveRequiredLidarrExecutionContext()`, use `LidarrClientApi`, or write `lidarr_metadata_cache`. Those bind execution to Lidarr credentials/origin and its metadata-server circuits.                                                                        |
| `src/commands/lidarr.ts:reportLidarrFailure()`                                                  | Reuse via command-factory injection for stable machine envelopes, exit-code behavior, structural execution metadata, URL/query redaction, and `sensitiveValues`.                                              | Pass the Last.fm key as sensitive and set `staleHint: false` unless #203 explicitly ships a separate discovery cache. The current human prefix, “Lidarr discover failed,” is acceptable for the command namespace; do not extract a generic reporter solely for this leaf. |
| `src/commands/lidarr.ts:renderExecutionSummary()`                                               | Reuse unchanged so text output reports the `discovery` lane and attempt count consistently.                                                                                                                   | Attribution is domain output and must render separately even when execution metadata is hidden or abbreviated.                                                                                                                                                             |
| `src/lib/lidarr/scheduler.ts:resolveLidarrSchedulerPolicy()` and `createLidarrScheduler()`      | Reuse the existing `discovery` lane limiter, operation budget, cancellation, attempt metadata, and scheduler-owned delay.                                                                                     | The retry classifier currently accepts only `LidarrError`; a Last.fm error becomes non-retryable `unknown`. Generalize the scheduler's error-metadata seam narrowly or accept one attempt. Never make a Last.fm error subclass pretend to be a Lidarr outage.              |
| `src/lib/lidarr/tiers.ts:LIDARR_TIER_DESCRIPTORS.discovery`                                     | Reuse the declared lane: no Lidarr metadata-server health gate and isolation from local/destructive work.                                                                                                     | The comments mention multi-source fallback, but that roadmap text is not authorization to implement #204 federation.                                                                                                                                                       |
| `src/lib/config.ts:validateLidarrConfigOptions()` and `src/types/config.ts:LidarrConfigOptions` | Follow the typed nested-section validation, positive timeout checks, config-path errors, redaction, and template resolution patterns.                                                                         | Put credentials under an independent `discovery.lastfm` section, not `lidarr`; read-only discovery must not inherit Lidarr connection requirements, retry policy, cache origin, or API key.                                                                                |
| `src/lib/config.ts:loadConfig()` and `rfmedia.example.yaml`                                     | Reuse `{{ VAR_NAME }}` injection and immediate `SecretsInjectionError` behavior. Document `{{ LASTFM_API_KEY }}` rather than shipping a shared key.                                                           | Ensure config merge/redaction recognizes the nested `apiKey`; `SENSITIVE_FIELD_NAMES` already includes `apiKey`. Never log the resolved key or include it in URLs, cache identities, plans, or output.                                                                     |
| `src/lib/lidarr/metadata-cache.ts`                                                              | Reuse only its design lessons: credential-free keys, strict cache revalidation, explicit stale consent, deterministic clock seams, and non-authoritative cache failure.                                       | Do not reuse the table or `LidarrCacheCategory`: rows require a Lidarr origin and represent Lidarr metadata. Persistent Last.fm caching is not required by #203 and should wait for an approved retention/terms contract.                                                  |
| `src/lib/lidarr/plan-operation-definitions.ts` and `src/lib/lidarr/plan-engine.ts`              | Reuse the sealed-operation model if selected discovery results can produce an add plan: exact schema, target origin, checksum, live classification, risk, execution, verification, and explicit registration. | There is no `artist-add` definition, entry, live-state variant, or executor. Do not bend artist monitoring/profile/tag/delete definitions or emit a plan shape the validator does not own.                                                                                 |
| `src/actions/lidarr/apply.ts`                                                                   | Reuse approval, claim, dry-run, target-origin binding, immediate revalidation, ordered history, and stop-on-uncertain orchestration for a real artist-add plan.                                               | Artist creation is non-idempotent after possible dispatch. It must not enter current retry/deferred replay paths until read-back reconciliation proves absence.                                                                                                            |
| `src/lib/lidarr/client.ts:LidarrClientApi`, `search()`, and `lookupArtists()`                   | Reuse `lookupArtists()` to resolve only the explicitly selected candidate when its MBID is missing; use the stable facade and strict projection.                                                              | Ordinary discovery must not call it. The selected add target must be one unique exact MBID/name match; a Last.fm display name is not a Lidarr mutation identity.                                                                                                           |
| `src/lib/lidarr/generated/sdk.gen.ts:postApiV1Artist`                                           | The generated operation already exists for a future narrow `LidarrClientApi.addArtist()` method.                                                                                                              | Only `client.ts` may import it. New root-folder reads/projectors and a narrow writable input are also required; never pass a Last.fm object or broad generated DTO upward.                                                                                                 |
| `src/actions/test-helpers/lidarr-client-mocks.ts:createLidarrClientMock()`                      | Extend only if the add-plan path adds `addArtist()` or root-folder reads to `LidarrClientApi`.                                                                                                                | Keep Last.fm test doubles separate. Adding Last.fm methods to this mock would falsely couple independent systems.                                                                                                                                                          |
| `src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`                          | Add `discover` and its exact options to all three static templates, then extend the existing parity matrix and no-side-effect assertions.                                                                     | Completion generation must not read config, initialize a scheduler/client, or contact Last.fm.                                                                                                                                                                             |
| `scripts/check-direct-plex-imports.mjs` and `.test.mjs`                                         | Extend the existing `FETCH_OWNERS` map and exact-one-site fixture pattern.                                                                                                                                    | The scanner reads raw production source, including comments. The authorized Last.fm owner must contain exactly one matching call, and every other production call remains a violation.                                                                                     |

## Modularity Design

The minimum clean dependency direction is:

```text
commands/lidarr.ts
  -> commands/lidarr-discover.ts
    -> actions/lidarr/discover.ts
      -> lib/lidarr/scheduler.ts (discovery lane only)
      -> lib/discovery/lastfm.ts
        -> fixed https://ws.audioscrobbler.com origin
```

`commands/lidarr-discover.ts` owns Commander options, option dependencies, output formatting,
attribution rendering, and redaction. `actions/lidarr/discover.ts` owns orchestration: validate
again at the trust boundary, submit exactly one idempotent discovery task, shape/filter the
complete result, and optionally hand one explicit candidate to an add-plan producer.
`lib/discovery/lastfm.ts` owns request construction, credential attachment, timeout/cancellation,
bounded body handling, provider error mapping, strict projection, and fixed Last.fm attribution.
Public result types may live in `src/types/discovery.ts` if commands and actions both consume them;
provider wire types stay private in `lastfm.ts`.

Do not route Last.fm through `lib/lidarr/transport.ts`. That transport binds a Lidarr origin,
injects `X-Api-Key`, understands generated-client requests, and maps Lidarr status failures. Last.fm
requires a fixed external origin and query-string `api_key`; combining the transports would weaken
both credential policies. Separate owners are the correct module boundary even though both use
native platform HTTP.

If addition is included, keep it outside the discovery task:

```text
Last.fm result -- explicit rank --> artist-add plan producer
  -> existing Lidarr lookup/resource reads
  -> sealed plan file
  -> existing `rfmedia lidarr apply`
  -> narrow `LidarrClientApi.addArtist()`
```

The discovery result must remain successful and inspectable if add planning fails. Do not wrap
Last.fm discovery, Lidarr lookup, and mutation in one scheduler task or one undifferentiated error.

## Shared vs Feature-Specific

Shared now:

- The existing scheduler and `discovery` lane for concurrency, operation budget, cancellation, and
  execution metadata.
- Global output selection, `isMachineFormat`, `formatOutput`, CSV formula neutralization, command
  failure reporting, logging, and config-template injection.
- The safe-input policy and immutable-projection practices, copied or applied through small
  feature functions.
- The plan/apply engine only if an actual artist-add operation is registered as a complete new
  operation.

Feature-specific in #203:

- Last.fm URL/query construction, API error numbers, body limits, attribution constants, `match`
  parsing, MBID optionality, catalogue URL validation, and API-key resolution.
- The single-source result schema and text/CSV presentation.
- Selection of one displayed result for an add handoff.
- Any discovery cache policy, if explicitly approved; it must not share Lidarr cache categories or
  origin keys.

Reserved for #204:

- `DiscoveryProvider`, provider registries/factories, `--source`, fallback chains, aggregation,
  weighted scoring, normalization across providers, cross-provider dedupe, Plex seeds, and
  ListenBrainz/MusicBrainz clients.
- Generalizing `source.provider` beyond the fixed literal `"lastfm"` is harmless at the serialized
  boundary, but implementing runtime selection is not.

## KISS Assessment

| Area               | Simplest sufficient choice                                       | Avoid                                                               | Reason                                                                                                              |
| ------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Provider model     | One `LastFmClient`/function with one operation                   | Generic provider registry or aggregator                             | One implementation does not prove a useful abstraction; #204 owns federation.                                       |
| HTTP               | Native Node 22 platform APIs                                     | Last.fm SDK, Axios, Got, or another generated client                | The endpoint is one GET, available SDKs are unofficial, and repository policy needs custom redaction/bounds anyway. |
| Projection         | Small explicit runtime guards and fresh readonly objects         | Raw JSON escape or schema framework                                 | Only a handful of fields cross the boundary; strict local guards are clearer and cheaper.                           |
| Ranking            | Preserve Last.fm order, dedupe, assign one-based rank            | Local relevance model or weighted score                             | The provider already supplies order and `match`; re-ranking belongs with later policy work.                         |
| Cache              | No persistent cache unless product/terms requirements approve it | Reusing `lidarr_metadata_cache` or inventing provider fallback      | #203 does not require stale discovery, and the existing cache has the wrong identity and lifecycle.                 |
| Add                | Explicit single selection that creates/reviews a plan            | Boolean add-all or immediate POST                                   | Discovery evidence is not mutation consent or a complete Lidarr artist-create policy.                               |
| Error output       | Reuse injected Lidarr command reporter structurally              | New application-wide error framework                                | One additional leaf does not justify a reporter refactor.                                                           |
| Config             | `discovery.lastfm.apiKey` plus optional timeout                  | Lidarr credentials, OAuth/session auth, or provider registry config | Last.fm discovery is independent and needs only an application key.                                                 |
| Architecture check | Add one owner to existing scanner                                | New lint framework                                                  | The current scanner already enforces owner count and is wired into build/typecheck.                                 |

The issue's “3–5 files” estimate is realistic only for read-only discovery without persistent cache
or addition. A safe artist-add plan touches the generated facade, public types, plan schema,
operation registry, apply execution, tests, and docs. Do not hide that scope by implementing a
direct POST in the discovery action.

## Extract vs Repeat

Extract or extend where policy already has a named owner:

- Extend `FETCH_OWNERS` with a `LASTFM_FETCH_OWNER` constant and a
  `lastfm-fetch-owner-count` rule. This is one shared authorization registry, not a second scanner.
- Extend the existing scheduler's failure-metadata seam so independent discovery failures can
  provide a stable code, retryability, status, and optional retry-after value without inheriting
  from `LidarrError`. Keep the change limited to classification/retry metadata; do not rename the
  entire Lidarr scheduler during #203.
- Extend config validation/template generation in the existing config owner; do not parse
  `process.env` directly in the action.
- Extend the existing plan operation registry only if `artist-add` is a fully supported plan/apply
  operation.

Prefer small explicit repetition where semantics differ:

- Repeat the short safe-string guard in Last.fm code rather than extracting
  `normalizeLidarrSearchTerm()` or making it accept provider modes.
- Keep Last.fm and Lidarr transport code separate despite similar timeout and body-reading steps.
  Credential placement, trusted origins, wire envelopes, and failure taxonomies differ.
- Keep Last.fm fixtures and error cases independent from Lidarr client fixtures.
- Write one explicit Last.fm CSV projector rather than teaching the generic Lidarr one-row
  projector how to flatten arbitrary recommendation arrays.

Avoid extracting a provider-neutral cache, provider interface, score normalizer, or source registry
before #204 supplies the second and third concrete implementations. Stable serialized provenance
is the only future-facing abstraction #203 needs.

## Interface Design

Keep the Last.fm-facing interface narrow and provider-specific:

```typescript
interface LastFmSimilarArtistQuery {
  readonly artist: string;
  readonly limit: number;
  readonly autocorrect: boolean;
  readonly signal?: AbortSignal;
}

interface LastFmSimilarArtist {
  readonly rank: number;
  readonly name: string;
  readonly match: number;
  readonly musicBrainzId?: string;
  readonly url?: string;
}

interface LastFmSimilarArtistResult {
  readonly requestedArtist: string;
  readonly resolvedArtist: string;
  readonly autocorrected: boolean;
  readonly recommendations: readonly LastFmSimilarArtist[];
  readonly source: {
    readonly provider: "lastfm";
    readonly displayName: "Last.fm";
    readonly method: "artist.getSimilar";
    readonly siteUrl: "https://www.last.fm/";
    readonly termsUrl: "https://www.last.fm/api/tos";
  };
}
```

Interface rules:

- Accept a caller `AbortSignal` and preserve cancellation identity.
- Return validated domain values, never `Response`, raw provider JSON, image URLs, biographies, or
  arbitrary provider fields.
- Validate `match` as a finite number from 0 through 1 and MBID as one canonical lowercase UUID
  when present. Missing MBID stays absent.
- Constrain catalogue links to HTTPS Last.fm hosts and reject credentials/query secrets.
- Preserve upstream order; assign ranks after seed removal and first-win dedupe.
- Make attribution non-optional in both action and serialized result types. Human output must name
  Last.fm and the method; CSV should repeat fixed source columns per recommendation or include a
  mandatory summary row.
- Use one fixed provider literal. Do not add `requestedProvider`, `providersTried`, weights, or
  fallback arrays in #203.

The action interface should keep read-only and add-plan outcomes distinct. `--add` should take an
explicit rank (or a stable candidate token), never a bare boolean. A selected rank is valid only
against the current result set; any persisted plan must store the resolved MusicBrainz ID and
review context, not rank as identity.

For a real add plan, add a narrow facade method such as:

```typescript
addArtist(input: LidarrArtistAddInput, signal?: AbortSignal): Promise<LidarrArtist>;
```

`LidarrArtistAddInput` must explicitly carry the validated MusicBrainz ID, root folder, quality and
metadata profile IDs, monitoring policy, monitor-new-items policy, and search behavior. It must be
constructed in `client.ts` into the generated `ArtistResource`; generated types remain private.
Plan creation must resolve the root folder and profiles through new narrow facade reads. Apply must
recheck absence by MusicBrainz ID immediately before dispatch and read back after an uncertain
response; it must not automatically retry or defer a possibly completed POST.

## Extension Points

- The fixed `source` object is the compatibility point for #204. Federation can later wrap multiple
  source-specific results and introduce normalized aggregate scores without changing what a
  Last.fm `match` means.
- `LIDARR_TIER_DESCRIPTORS.discovery` and `DEFAULT_LIDARR_SCHEDULER_POLICY.discovery` already isolate
  external API work. A narrow provider-neutral scheduler error-metadata contract makes that lane
  usable by later sources without building their registry now.
- `FETCH_OWNERS` is the mandatory registration point for every future external HTTP owner. Add
  Last.fm now; #204 must add each new provider explicitly rather than authorizing an entire
  directory.
- The command factory can later receive a provider resolver, but #203 should inject/resolve only
  Last.fm. Do not expose `--source` early.
- If persistent discovery caching becomes approved, use a provider-origin/category/discriminator
  model with versioned digests and strict revalidation. Do not retrofit it into the Lidarr-origin
  table.
- `getLidarrMutationOperationDefinition()` is the add-plan extension point. Register an exact
  `artist-add` kind; do not create an alternative apply command or hidden direct-mutation escape.

## Testability Patterns/Anti-patterns

Minimal critical seams:

1. `lib/discovery/lastfm.test.ts`: inject a Fetch-compatible function and deterministic timeout
   hooks. Cover exact fixed-origin/query construction, API-key placement without reflection,
   redirect rejection, timeout/abort, bounded body, representative success, empty success,
   Last.fm API error mapping, HTTP/rate-limit mapping, atomic malformed-member rejection, MBID
   optionality, dedupe/order, and secret-free errors. Use table cases rather than one test per
   field.
2. `actions/lidarr/discover.test.ts`: inject/mock the Last.fm resolver and scheduler. Prove local
   validation before dependency resolution, `discovery` lane use, one request, abort forwarding,
   immutable attributed output, zero Lidarr calls for read-only discovery, and exact one-candidate
   selection behavior. Do not retest transport JSON cases here.
3. Extend `commands/lidarr.test.ts`: pin command registration/help, option bounds/dependencies,
   action arguments, one representative human result, one machine envelope, fixed CSV columns,
   empty output, stderr/stdout separation, exit code, and Last.fm-key redaction. Do not duplicate
   the full same matrix independently for JSON and YAML when both use `formatOutput`.
4. Extend `templates.spec.ts` once with an exact discover-option set checked across Bash, Zsh, and
   Fish plus the existing no-config/client/network assertion. Avoid separate near-identical shell
   test files.
5. Extend `check-direct-plex-imports.test.mjs` with allow-owner, missing/multiple-owner, unauthorized
   action owner, and real-tree coverage. Do not snapshot the scanner output.
6. Extend config tests with one valid nested Last.fm section, representative invalid key/timeout
   cases, template resolution, and redaction. Reuse existing parameterized validators.

If artist-add planning is included, add only boundary evidence:

- Facade tests for the generated POST body, cancellation, strict returned projection, and
  no-retry-after-possible-dispatch behavior.
- Operation-definition tests for exact plan schema, checksum, expected absence, resource
  references, classification, risk, and verification.
- Existing apply tests extended with satisfied/already-present, successful add, definite
  pre-dispatch failure, and uncertain dispatch/read-back cases.

Anti-patterns:

- Mocking the global network in action or command tests; use the Last.fm boundary seam.
- Snapshotting raw Last.fm JSON, the generated Lidarr tree, whole help output, or all completion
  scripts.
- Testing every invalid string at every layer. Put exhaustive bounds/shape cases at the owning pure
  boundary and one delegation case above it.
- Reusing `createLidarrClientMock()` for Last.fm or making ordinary discovery fixtures supply
  Lidarr credentials.
- Treating empty recommendations as an error or partial malformed responses as success.
- Adding action-level retry loops alongside scheduler retries.

## Build vs Depend

| Need                 | Build/reuse decision                                                                  | Dependency decision                              | Rationale                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Last.fm HTTP         | Build a small fixed-origin module with native Node APIs                               | No Last.fm SDK or HTTP client                    | One documented GET does not justify an unofficial callback-era wrapper or another transport policy.      |
| Runtime validation   | Build focused guards for the consumed envelope/records                                | No Zod/Ajv/full schema package                   | The projection is small, provider JSON is untrusted, and explicit guards match existing Lidarr practice. |
| URL/query handling   | Reuse `URL` and `URLSearchParams`                                                     | No query-string package                          | Correct encoding and deterministic parameter construction are platform features.                         |
| Cancellation/timeout | Reuse `AbortSignal`/`AbortController` and existing transport patterns                 | No timeout/retry package                         | Scheduler owns retries; the transport only owns one attempt and its deadline.                            |
| Rate limiting        | Reuse the `discovery` lane and its shared limiter; add only proven pacing if required | No rate-limit library                            | Last.fm publishes no fixed numeric quota; avoid inventing a complex token bucket.                        |
| Ranking              | Build a small pure first-win projection preserving Last.fm order                      | No recommendation/ranking library                | Provider order and `match` are the contract for #203.                                                    |
| Caching              | Omit initially, or build a dedicated store only after policy approval                 | Do not reuse Lidarr cache or add a cache package | Persistence is not required and Last.fm retention/attribution obligations need an explicit decision.     |
| Attribution          | Use fixed typed constants and result fields                                           | No branding package/assets for terminal output   | The CLI needs transparent credit and links, not a web component system.                                  |
| Add-to-Lidarr        | Reuse generated Lidarr SDK plus existing plan/apply framework                         | No second Lidarr SDK                             | `postApiV1Artist` exists privately; safety work belongs in the stable facade and operation registry.     |
| Architecture         | Extend the current Node scanner                                                       | No ESLint boundary plugin                        | It is already tested and runs in prebuild/pretypecheck.                                                  |

## Open Questions

1. Does “optional `--add` integration path” require #203 to create an actual artist-add plan, or is
   a typed handoff that identifies the selected MBID and next command sufficient? The current
   repository cannot safely add an artist without new facade and plan/apply operation work.
2. If addition is required, what exact root folder, quality profile, metadata profile, monitored
   state, monitor-new-items value, and search-for-missing policy must the plan seal? Current config
   supplies none of these defaults, and issue #206 owns general add policy.
3. What is the exact selector syntax: `--add <rank>`, MBID, or a candidate token? A bare boolean and
   add-all behavior should be rejected.
4. Should a Last.fm candidate without MBID be non-addable, or may the handoff call existing
   `lookupArtists()` and require one exact result? How should multiple exact-name results be shown?
5. Should #203 generalize scheduler error classification so Last.fm transient failures use the
   existing discovery-lane retry budget, or intentionally ship one attempt? Current retries are
   `LidarrError`-only.
6. Is persistent discovery caching desired now? If yes, what retention/size ceiling and
   `--allow-stale` contract are approved under Last.fm terms, and what database migration owns it?
7. What default/hard maximum should `--limit` use? Last.fm documents the parameter but no public
   maximum; the CLI must choose and test a local bound.
8. Should autocorrection default on, be an explicit flag, or have a strict mode? Output must expose
   requested and resolved seed names whenever correction occurs.
9. Is `discovery.lastfm.apiKey` the accepted config path, and should a CLI
   `--lastfm-api-key` override be exposed despite process-list visibility? Template-backed config is
   the safer normal path.
10. What terminal attribution wording satisfies Last.fm, and should CSV repeat source fields on
    every recommendation or use one mandatory summary row?
11. Should catalogue URLs be optional when Last.fm omits them, and which exact Last.fm hosts are
    accepted after URL normalization?
12. Does commercial distribution or research use of this CLI require additional Last.fm approval
    or documentation before release?
