# Implementation Recommendations: Lidarr Similar-Artist Discovery

## Executive Summary

Implement issue #203 as a focused Last.fm read path:

```bash
rfmedia lidarr discover --artist "Radiohead"
```

The command should make one bounded `artist.getSimilar` request in the existing `discovery` lane,
work without Lidarr configuration, preserve Last.fm order and provenance, and perform no mutation.
The safest optional add handoff in #203 is a copyable, MusicBrainz-ID-bound next command using the
existing typed Lidarr lookup surface. A literal artist-create `--add` is not a small extension:
the current code has no artist-create facade, root-folder projection, or `artist-add` plan
operation, while issues #205, #206, and #219 explicitly own later selection, add-policy, and
cascade controls.

Do not close #203 with an unsafe inline POST. If project owners decide that a real `--add` mutation
is a hard acceptance criterion, make the artist-add plan/apply work an explicit blocking child (or
make #206 the blocking prerequisite), complete it before closing #203, and retain a one-artist,
separately approved plan/apply boundary. Do not leave that child as uncompleted follow-up work.

The recommended v1 deliberately avoids speculative provider federation, persistent caching,
thresholds, deep traversal, and automatic add. It adds a small Last.fm-specific transport and
strict domain projection while keeping public provenance extensible enough for #204.

## Implementation Recommendations

### Approach

1. Add a `lidarr-discover` command sibling modeled on `lidarr-search`, but resolve Last.fm
   configuration independently and never call `resolveRequiredLidarrExecutionContext` in the
   default path.
2. Add one dedicated Last.fm transport as the sole fetch owner. Hard-code
   `https://ws.audioscrobbler.com/2.0/`, use `redirect: "error"`, inject the API key only when
   constructing the request, cap bodies, and project the response from `unknown`.
3. Schedule the provider call as one idempotent task in the existing `discovery` lane. Add
   `discovery-provider-unavailable` rather than misclassifying Last.fm as
   `metadata-provider-unavailable` or `lidarr-unreachable`.
4. Preserve Last.fm order after self-removal and deterministic first-win deduplication. Assign
   contiguous one-based display ranks after filtering performed by #203.
5. Render human output to stderr and one deterministic JSON/YAML/CSV stream to stdout. Every
   successful format, including empty results, must identify Last.fm, the method, the requested
   and resolved seed, fetch time, and catalogue links.
6. End the read-only result with an optional exact handoff:
   `rfmedia lidarr lookup artist "mbid:<uuid>"`. Candidates without a valid MBID remain visible
   but are marked as requiring identity resolution. Do not name this a completed add.

### Technology Decisions

| Topic               | Decision                                                                                                                                                                                    | Rationale                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP client         | Native Node.js 22 `fetch`, `URL`, `URLSearchParams`, `AbortSignal`, and bounded decoding                                                                                                    | One endpoint does not justify an unsupported Last.fm SDK or another runtime dependency.                                                                                                                    |
| Provider structure  | One Last.fm-specific facade and private wire types; no provider registry, weights, fallback, or aggregation                                                                                 | #204 explicitly owns provider abstraction and federation. A stable `source.provider: "lastfm"` field is sufficient preparation.                                                                            |
| Configuration       | Use `discovery.lastfm.apiKey` with `{{ LASTFM_API_KEY }}`; do not add a provider selector or configurable base URL                                                                          | The independent namespace preserves the command's separation from Lidarr and gives #204 a stable home without implementing its provider registry early.                                                    |
| Credential override | Do not expose `--lastfm-api-key` in v1 unless repository owners require CLI parity                                                                                                          | Query credentials already risk URL leakage; argv and shell history add avoidable exposure. Config templates and existing secret re-exec paths are sufficient.                                              |
| Result limit        | Default 15, range 1 through 100                                                                                                                                                             | Fifteen is reviewable and agrees with business/UX research. One hundred is a local safety cap, not a claimed Last.fm maximum.                                                                              |
| Autocorrection      | Send `autocorrect=1` by default only after a sanitized fixture proves the response evidence; expose `--no-autocorrect`                                                                      | Artist-name discovery benefits from correction, but requested and resolved names must remain distinct and correction must never be inferred. If the fixture is inconclusive, default to off.               |
| Thresholds          | No `--min-match` in #203                                                                                                                                                                    | Threshold policy belongs to #205 and would change the visible recommendation set.                                                                                                                          |
| Score               | Preserve the validated finite `0..1` Last.fm similarity value                                                                                                                               | It is not confidence, identity strength, popularity, or add safety.                                                                                                                                        |
| Cache               | No persistent cache or `--allow-stale` in #203                                                                                                                                              | One invocation normally makes one request; #204 owns provider caching, and the existing Lidarr cache is stale-fallback infrastructure keyed to Lidarr semantics.                                           |
| Retry               | Existing scheduler is the only retry owner; add a narrow provider-neutral scheduled-error metadata seam for `discovery-provider-unavailable` and admit that code only in the discovery lane | The current scheduler retries only `LidarrError` subclasses. A structural scheduler contract preserves accurate output without making Last.fm inherit from a Lidarr error or creating a second retry loop. |
| Add                 | Read-only identity-bound handoff in #203; real artist creation through a separately completed plan/apply deliverable                                                                        | Current plan unions, operation registry, facade, codegen assertions, history, and recovery paths do not support artist creation.                                                                           |

The new error code should extend the scheduler execution-failure type, not `LidarrErrorCode`.
Teach scheduler classification and retry to read a narrowly validated provider-neutral metadata
shape (`code`, `retryable`, optional status and retry delay), and admit
`discovery-provider-unavailable` only for idempotent discovery-lane work. It must feed neither the
Lidarr nor metadata circuit, must not be deferable, and must not become eligible for Lidarr
stale-cache hints. Map invalid keys to `authentication`, suspended keys to `authorization`, rate
limiting to `rate-limited`, unresolved seeds to `not-found`, malformed data to
`invalid-response`, and local setup failures to `configuration`.

### Phasing

#### Phase 0: Release Gate

- Confirm the intended distribution/use is compatible with Last.fm's current non-commercial,
  attribution, linking, storage, and artwork restrictions.
- Confirm that terminal text credit plus Last.fm catalogue links is acceptable.
- Capture credential-free fixtures for success, autocorrection, empty results, logical errors,
  HTTP errors, and cache headers.
- If the terms or observed headers require persistent caching for release, create a narrowly scoped
  prerequisite child and complete it before #203 closes; do not invent a TTL inside #203.

#### Phase 1: Read-Only Core

- Add typed Last.fm configuration, private transport, strict response projection, error mapping,
  discovery action, command, output contracts, documentation, and tests.
- Prove one Last.fm request, no Lidarr resolution, no mutation, no persistent cache, and complete
  attribution.
- Add Bash, Zsh, and Fish completion parity.

#### Phase 2: Explicit Handoff

- Emit an exact `mbid:` Lidarr lookup next step for add-eligible results.
- For missing MBIDs, state that an explicit Lidarr lookup and identity choice is required.
- Preserve discovery success independently from any manually initiated later Lidarr lookup.

#### Phase 3: Real Add, Only If Required to Close #203

- Treat artist creation as a blocking child or completed #206 prerequisite.
- Add a generated-client-backed `addArtist` facade and root-folder reads, a sealed one-artist
  `artist-add` plan, complete policy fields, apply-time absence/resource revalidation, separate
  approval, non-retrying dispatch, possible-dispatch reconciliation, and durable history.
- Keep #203 open until this work is implemented, reviewed, tested, and merged. Do not substitute an
  inline POST or an uncompleted child issue.

### Quick Wins

- Reuse `normalizeLidarrSearchTerm` safety concepts, fixed CSV projection, dynamic action import,
  stream discipline, execution metadata, and shared failure redaction without reusing the Lidarr
  client or cache.
- Reuse the existing `discovery` scheduler lane; no new lane or health gate is needed.
- Add the Last.fm transport to the architecture checker's exact fetch-owner allowlist.
- Drop image, streamability, biography, tag, and raw provider fields at the projection boundary.
- Make a valid empty recommendation list exit 0 with normal attribution and a CSV summary row.

## Improvement Ideas

### Current Issue

- Support one terminal-safe artist-name seed and a documented local limit.
- Show requested versus provider-resolved seed and explicit autocorrection evidence.
- Preserve provider ordering, remove the seed, deduplicate deterministically, and validate MBIDs.
- Include `rank`, `name`, `similarity`, optional `musicBrainzId`, and validated `sourceUrl`.
- Include one non-lossy source object with provider, method, attribution, site URL, and fetched time.
- Add deterministic text, JSON, YAML, and summary-plus-recommendation CSV output.
- Add accurate provider errors, cancellation, bounded retry, timeout, body caps, redaction, and
  terminal-safety tests.
- Document a copyable typed Lidarr lookup as the optional add handoff.

### Future Issues

- **#204:** Provider interface/registry, ListenBrainz and MusicBrainz providers, Plex seeds,
  weighted merge, provider selection, fallback, and provider-response caching.
- **#205:** Score thresholds, preview/quarantine, multi-select, deep traversal, diversity,
  popularity dampening, loop prevention, and bulk-add caps.
- **#206:** Artist-add command/facade, root/profile/monitor/search defaults, post-add normalization,
  and safe acquisition behavior.
- **#219:** Indexer/download cascade analysis, budgeting, warnings, and batching recommendations.
- A later UX issue may add strict seed disambiguation via `artist.search`; it should never silently
  choose result zero.
- A repository-wide reliability issue may rename Lidarr-specific scheduler/error types to
  provider-neutral names. That refactor is not required to deliver one safe discovery command.

## Risk Assessment

### Delivery and Product Risks

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| #203 expands from the stated 3–5 files into the full artist-add lifecycle    | High       | High   | Ship the read-only core plus exact handoff. Put real add behind a completed blocking child/#206 prerequisite if it remains mandatory. |
| Optional handoff is presented as if it added an artist                       | Medium     | High   | Use explicit wording: discovery and lookup are read-only; no artist was added. Do not expose a misleading boolean `--add`.            |
| Provider abstraction duplicates #204                                         | Medium     | Medium | Keep only a Last.fm facade and explicit provenance fields; defer registries and selection to #204.                                    |
| Persistent cache conflicts with Last.fm terms or exposes listening interests | Medium     | High   | Omit persistent cache initially; treat any legally required cache as a release-blocking, fully implemented prerequisite.              |
| Public defaults drift across research documents                              | High       | Medium | Freeze default 15/max 100, no threshold, and conditional autocorrect behavior in contract tests and docs.                             |
| Last.fm outage gets reported as a Lidarr outage                              | Medium     | Medium | Add `discovery-provider-unavailable`; exclude it from Lidarr/metadata circuits and stale hints.                                       |
| Completion/docs surface is incomplete                                        | Medium     | Medium | Audit Bash, Zsh, Fish, parity tests, README, feature docs, examples, and changelog together.                                          |
| Last.fm terms change after implementation                                    | Medium     | High   | Recheck live terms at release and document the date; require user-owned keys.                                                         |

### Security Risks

| Severity | Risk                                                                                                                   | Required control                                                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRITICAL | Untrusted Last.fm data or ambiguous selection reaches artist creation and triggers monitoring/search/download cascades | Default read-only; exact MBID-first selection; authoritative Lidarr lookup; full add policy; sealed plan; separate approval; one-artist cap; live revalidation; no automatic replay after possible dispatch. |
| WARNING  | API key leaks through query URLs, errors, logs, debug output, argv, cache keys, or plans                               | Config-template credential; fixed local error text; exact-value and query-key redaction; no full URL/`Request` logging; no key in outputs, cache, or artifacts.                                              |
| WARNING  | Redirects or configurable provider origins exfiltrate the query credential or enable SSRF                              | Fixed HTTPS origin/path, no production endpoint override, `redirect: "error"`, no fetch of returned URLs.                                                                                                    |
| WARNING  | Oversized, malformed, or type-confused JSON exhausts memory or poisons results                                         | Bounded streamed body, fatal UTF-8 decode, JSON-only parsing, exact envelope and collection caps, atomic strict projection.                                                                                  |
| WARNING  | Artist names, error messages, or URLs inject terminal controls or bidirectional spoofing                               | Reject C0/C1, ESC, CR/LF, and bidi controls before truncation, logging, tables, prompts, plans, or machine output.                                                                                           |
| WARNING  | Scheduler concurrency/retries amplify provider traffic                                                                 | One normal request, one retry owner, discovery-lane-only transient allowlist, capped abortable backoff, no retries for bad key/input/response, conservative provider pacing.                                 |
| WARNING  | Cached recommendations reveal interests or authorize a poisoned add                                                    | No v1 persistent cache. Any future cache needs private permissions, header-aware expiry, size/purge bounds, strict provenance revalidation, and must never authorize add without fresh Lidarr resolution.    |
| WARNING  | Missing attribution violates provider terms or obscures recommendation ownership                                       | Preserve Last.fm provider/method/link/fetch evidence in every format and any future plan/history; omit artwork.                                                                                              |
| ADVISORY | Unnecessary Last.fm user authentication or SDK expands credential and supply-chain surface                             | Store only the application API key and use native Node.js APIs.                                                                                                                                              |

## Alternative Approaches

| Approach                                                           | Pros                                                                                                                 | Cons                                                                                                                                            | Effort                              | Recommendation                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| Read-only discovery plus exact lookup handoff                      | Delivers the core user value, preserves Lidarr independence, fits #203 boundaries, and avoids unsafe policy defaults | Does not itself create an artist                                                                                                                | Medium                              | **Recommended for #203**                                                          |
| Read-only discovery plus `--add <rank>` that creates a sealed plan | Provides a concrete add workflow while retaining separate apply approval                                             | Requires new facade methods, root-folder projection, plan schema/registry work, codegen assertions, recovery/history, and #206 policy decisions | High                                | Use only as a blocking child/#206 prerequisite and complete it before #203 closes |
| Inline confirmed `--add` POST                                      | Fewer visible commands and fastest happy path                                                                        | Bypasses current plan/apply contracts, risks ambiguous identity and acquisition cascades, and has weak possible-dispatch recovery               | Medium initially, high to make safe | Reject                                                                            |
| Full provider abstraction and persistent cache now                 | Prepares for federation and reduces repeated calls                                                                   | Duplicates #204, expands configuration/storage/privacy scope, and risks premature abstractions                                                  | High                                | Defer to #204                                                                     |
| Route recommendations through Lidarr search                        | Reuses the current client and metadata resilience                                                                    | Lidarr does not supply similar-artist recommendations; destroys independence and misstates provenance                                           | Low                                 | Reject                                                                            |
| Use a Last.fm SDK                                                  | Less handwritten request construction                                                                                | Officially unsupported ecosystem, stale wrappers, additional supply-chain surface, and validation/redaction still required                      | Low to adopt, medium to secure      | Reject                                                                            |

## Task Breakdown Preview

| Task                                  | Implementation ownership                        | Dependencies                                   | Deliverable                                                                                            |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 0. Terms and fixtures gate            | Release/product owner with implementation owner | None                                           | Recorded licence/attribution decision and sanitized wire fixtures                                      |
| 1. Public contracts and config        | CLI/config owner                                | Task 0                                         | `discovery.lastfm.apiKey`, discovery result types, validation, examples, redaction tests               |
| 2. Last.fm transport and projection   | Provider-boundary owner                         | Tasks 0–1                                      | Fixed-origin fetch owner, bounded parser, error classes, normalization/deduplication                   |
| 3. Scheduler integration and action   | Lidarr reliability owner                        | Tasks 1–2                                      | Discovery-lane task, accurate execution metadata, provider-neutral unavailable code, cancellation      |
| 4. Command and presenters             | CLI UX owner                                    | Tasks 1 and 3                                  | `lidarr discover`, text/JSON/YAML/CSV output, attribution, exact lookup handoff                        |
| 5. Completion and documentation       | CLI/docs owner                                  | Task 4                                         | Bash/Zsh/Fish parity, feature docs, README, changelog, release limitations                             |
| 6. Contract verification              | Test/architecture owner                         | Tasks 1–5                                      | Provider, action, command, config, architecture, completion, typecheck, build, and regression evidence |
| 7. Artist-add plan/apply, conditional | Dedicated mutation owner                        | Tasks 0–6 plus completed #206 policy decisions | One-artist sealed plan, facade/codegen changes, apply/recovery/history, approval, full test matrix     |

Tasks 1 and 2 may proceed in parallel once the public config/result contract is agreed. Tasks 3 and
4 should remain separate so the action stays framework-independent. Conditional task 7 is not a
small extension to task 4 and must have its own acceptance criteria and owner.

Minimum implementation verification should include:

```bash
npm run test:run -w packages/rfmedia-cli
npm run test:architecture -w packages/rfmedia-cli
npm run test:codegen:lidarr -w packages/rfmedia-cli
npm run typecheck -w packages/rfmedia-cli
npm run build:rfmedia
npm run lint:md
```

## Key Decisions Needed

1. **Acceptance boundary:** Does #203 close with a read-only command and exact Lidarr lookup
   handoff, or is a real artist-create operation mandatory? If mandatory, designate and complete
   the blocking child/#206 prerequisite before closure.
2. **Release/legal gate:** Has project ownership accepted Last.fm's current licence, CLI
   attribution form, link requirements, and user-owned-key model?
3. **Cache gate:** Do observed response headers or provider guidance require persistent caching?
   The default recommendation is no v1 cache; a required cache becomes blocking prerequisite work.
4. **Autocorrection:** Approve default-on only if a sanitized fixture supplies trustworthy
   correction evidence; otherwise default off.
5. **Configuration name:** Approve `discovery.lastfm.apiKey` without a
   `discovery.provider` selector or provider registry.
6. **Credential surface:** Confirm that config/template-only credentials are acceptable and that
   no `--lastfm-api-key` flag is required.
7. **Error taxonomy:** Approve additive scheduler failure
   `discovery-provider-unavailable` through a narrow provider-neutral metadata seam, with
   discovery-only retry behavior and no `LidarrErrorCode`, circuit, cache, or deferred-queue
   participation.
8. **Absent values:** Choose omission or `null` once for optional MBID/catalogue URL and freeze it
   across JSON and YAML.

## Open Questions

- What exact successful, corrected, empty, error, and rate-limit JSON shapes are returned by the
  current HTTPS endpoint?
- What `Cache-Control`, `Expires`, `ETag`, `Last-Modified`, and `Retry-After` headers are observed?
- Is a validated candidate catalogue URL mandatory per row, or is command-level attribution
  sufficient when Last.fm omits a link?
- What maximum provider string lengths and timeout should be frozen after fixture inspection?
- Should an unresolved seed map to `not-found` or `validation` for Last.fm errors 6/7?
- Does a plain terminal attribution line satisfy Last.fm's current brand requirements?
- If real add is required, should the plan schema extend the existing v2 parallel unions or
  introduce v3 for a foreign-ID target that does not yet have a local numeric Lidarr ID?
- If real add is required, must MBID-less candidates be ineligible in v1, or may an interactive
  exact-name Lidarr lookup resolve them?
- Which explicit root folder, quality profile, metadata profile, monitored state,
  `monitorNewItems`, album-monitor mode, and search settings are safe enough to seal into the
  initial add plan?
