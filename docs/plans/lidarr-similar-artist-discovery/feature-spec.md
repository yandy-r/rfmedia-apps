# Feature Spec: Lidarr Similar-Artist Discovery

## Executive Summary

Issue #203 adds `rfmedia lidarr discover --artist <name>` as an attributed Last.fm read path that
works without Lidarr. A fixed-origin transport runs in the existing `discovery` lane, strictly
projects bounded data, and preserves Last.fm order and similarity. Optional `--add <rank>` selects
one MusicBrainz-identified candidate and creates a sealed `artist-add` plan with explicit policy;
the existing `lidarr apply` gate owns the mutation. Fixed HTTPS transport, template-backed
credentials, strict projections, and apply-time revalidation address secret leakage, untrusted
provider data, attribution, and acquisition side effects.

## External Dependencies

### APIs and Services

#### Last.fm Web Services

- **Documentation**:
  - [API introduction](https://www.last.fm/api/intro)
  - [`artist.getSimilar`](https://www.last.fm/api/show/artist.getSimilar)
  - [REST and JSON conversion](https://www.last.fm/api/rest)
  - [API Terms of Service](https://www.last.fm/api/tos)
- **Authentication**: installation-owned application API key in the `api_key` query parameter; no
  Last.fm user session, API signature, shared secret, username, or password
- **Endpoint**: fixed `GET https://ws.audioscrobbler.com/2.0/` with
  `method=artist.getSimilar`, `artist`, `limit`, `autocorrect`, `api_key`, and `format=json`
- **Rate limits**: no fixed numeric quota is published; one ordinary request per invocation,
  conservative scheduling, and bounded retry are required
- **Licence and attribution**: current terms are non-commercial absent a separate agreement,
  require Last.fm credit and catalogue links, restrict retained data, and exclude artwork/images
- **Freshness**: live documentation is undated; recheck the method and terms before release

#### Lidarr API

- **Documentation**:
  [official OpenAPI document](https://github.com/Lidarr/Lidarr/blob/develop/src/Lidarr.Api.V1/openapi.json)
- **Authentication**: existing `X-Api-Key` header through the repository's sole Lidarr transport
- **Operations used only by add planning/apply**:
  - artist lookup and full-library read for exact MusicBrainz identity and current absence
  - root-folder, quality-profile, and metadata-profile reads for explicit policy resolution
  - generated artist-create operation behind a new narrow handwritten facade method
- **Boundary**: Last.fm records never become Lidarr request DTOs. The private facade constructs the
  writable body from an authoritative Lidarr lookup resource plus sealed explicit policy.

### Libraries and SDKs

No runtime dependency is added. Node.js 22 provides stable `fetch`, `URL`, `URLSearchParams`,
`AbortSignal`, `TextDecoder`, and cryptography. Last.fm labels its listed tools unofficial and
unsupported, and a one-method integration still requires local bounds, validation, redaction, and
error mapping.

### External Documentation

- [Node.js 22 globals](https://nodejs.org/download/release/v22.17.0/docs/api/globals.html):
  stable fetch and cancellation platform APIs
- [Lidarr search and lookup](../../../packages/rfmedia-cli/docs/features/lidarr-search-lookup.md):
  current identity, output, and private-facade conventions
- [Lidarr execution lanes](../../../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md):
  discovery-lane admission and retry ownership
- [Lidarr plan/apply](../../../packages/rfmedia-cli/docs/features/lidarr-plan-apply.md):
  mutation review, approval, drift, history, and uncertainty contracts

## Business Requirements

### User Stories

- As a music-library operator, I want to discover artists related to one seed without depending on
  Lidarr so that recommendations remain available during Lidarr or metadata-service outages.
- As a cautious operator, I want discovery to be read-only by default so that recommendation
  scores never imply mutation consent.
- As an operator, I want to see requested and provider-resolved seed identity, raw Last.fm
  similarity, MusicBrainz identity, and source links so that results are explainable.
- As automation, I want deterministic JSON, YAML, and CSV contracts with provider and execution
  metadata so that scripts do not parse human tables.
- As an operator who chooses one candidate, I want a reviewed, exact, policy-complete add plan so
  that the actual mutation occurs only through `lidarr apply`.
- As a security-conscious user, I want my Last.fm and Lidarr API keys absent from output, logs,
  URLs in errors, cache keys, and plan artifacts.

### Business Rules

1. **Command surface**: `rfmedia lidarr discover --artist <name>`.
2. **Read-only default**: ordinary discovery performs zero Lidarr calls and zero mutations.
3. **Input**: outer-trim and NFC-normalize one artist name; require 1–256 Unicode code points and
   at most 1,024 UTF-8 bytes; reject C0/C1, DEL, and bidi controls before any dependency or I/O.
4. **Limit**: default 15, accepted range 1–100. This is local policy, not a Last.fm quota claim.
5. **Autocorrection**: enabled by default with `--no-autocorrect` opt-out. Requested and resolved
   names remain distinct; correction is reported only from provider evidence.
6. **Request count**: the normal live path issues one `artist.getSimilar` request. It does not
   pre-call `artist.search` or `artist.getInfo`.
7. **Ranking**: validate the complete response, remove the resolved seed, deduplicate first by
   canonical MBID and then by conservative provider/name identity, preserve first occurrence, and
   assign contiguous one-based visible ranks.
8. **Similarity**: preserve a finite Last.fm value from 0 through 1. Never label it confidence,
   probability, identity strength, or add eligibility.
9. **Identity**: an empty MBID is omitted. A non-empty MBID must be one valid canonical lowercase
   UUID or the complete provider response fails atomically.
10. **Source**: every success format, including empty output, carries Last.fm provider, method,
    attribution text, site link, fetch time, and candidate catalogue links when valid.
11. **Data minimization**: do not project or retain Last.fm images, artwork, streamability,
    biographies, tags, raw bodies, or arbitrary fields.
12. **No provider cache**: #203 adds no persistent Last.fm cache or `--allow-stale`; #204 owns
    provider caching after cache-header and retention policy is approved.
13. **Add selection**: `--add <rank>` accepts exactly one positive visible rank. It never means
    first result, all results, a range, or a replayable durable identity.
14. **Add eligibility**: selected candidates must have a valid MBID in v1. MBID-less candidates
    remain useful discovery results but cannot create an add plan.
15. **Add policy**: `--add` requires `--root-folder`, `--quality-profile`,
    `--metadata-profile`, and `--plan-file`. The sealed v1 operation fixes
    `monitored=false`, `monitorNewItems=none`, and `searchForMissingAlbums=false`.
16. **Separate mutation**: `discover --add` creates a plan only. It does not accept `--yes` and
    cannot POST. `lidarr apply` owns interactive confirmation, `--yes`, dry-run, claims, history,
    dispatch, verification, and recovery.
17. **Already present**: fresh Lidarr state that already contains the MBID returns a satisfied
    handoff with no plan and no write.
18. **Mutation retry**: artist create is non-idempotent and non-deferable. A possibly dispatched
    POST is never automatically retried; read-back by MBID determines success or uncertainty.
19. **Scope boundary**: no `--source`, provider registry, provider merging, Plex seeds, deep
    traversal, threshold/diversity policy, add-all, quarantine, cascade budgets, configurable add
    defaults, or post-add normalization.

### Edge Cases

| Scenario                                              | Expected behavior                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Missing, repeated, empty, unsafe, or oversized artist | Local validation failure; zero scheduler/provider/Lidarr I/O             |
| Invalid limit or add rank                             | Local validation failure                                                 |
| Missing Last.fm key                                   | `configuration` failure naming the config/template path, never the value |
| Last.fm API error in HTTP 200                         | Classified failure, never an empty success                               |
| Invalid/suspended API key                             | Non-retryable authentication/authorization failure                       |
| Provider error 11/16 or transport failure             | Discovery-provider failure eligible for bounded scheduler retry          |
| Provider error 29 / HTTP 429                          | Rate-limited failure with bounded retry; honor safe `Retry-After`        |
| Caller abort                                          | Cancel queued/active/backoff work; no retry and no add planning          |
| Valid zero recommendations                            | Exit 0 with attributed empty output and one CSV summary row              |
| Malformed member or oversized body                    | Atomic `invalid-response`; no partial ranking                            |
| Missing candidate MBID                                | Visible `requires-resolution`; selected add fails closed                 |
| Off-origin or credential-bearing catalogue URL        | Reject the complete provider response                                    |
| Add rank absent from visible results                  | Validation failure; no Lidarr I/O                                        |
| Lidarr unavailable during add planning                | Discovery remains available; requested handoff fails separately          |
| Candidate already present                             | Satisfied no-op; no plan and no POST                                     |
| Root/profile reference missing or ambiguous           | Fail add planning before writing a plan                                  |
| Drift before apply                                    | Block or satisfy according to fresh operation-owned preflight            |
| Connection loss after artist-create dispatch          | Read back by MBID; mark succeeded or uncertain; never retry blindly      |

### Success Criteria

- [ ] Read-only discovery succeeds with Last.fm configuration alone and performs zero Lidarr calls.
- [ ] The provider request is fixed-origin HTTPS, redirect-rejecting, cancellable, body-bounded,
      and secret-safe.
- [ ] Strict projection, seed removal, first-win dedupe, rank, MBID, similarity, and URL contracts
      are deterministic and atomic.
- [ ] Text, JSON, YAML, and CSV retain Last.fm attribution and stream discipline.
- [ ] Provider errors, rate limits, timeouts, cancellation, invalid data, and empty success remain
      distinct.
- [ ] `--add <rank>` produces at most one sealed, origin-bound, checksum-protected plan from a
      fresh MBID-backed candidate and explicit policy.
- [ ] Artist create can run only through the registered plan operation and existing apply approval.
- [ ] Possibly dispatched artist creation is reconciled, not retried or deferred.
- [ ] Bash, Zsh, and Fish completion templates expose the exact same command/options and parity
      tests pass.
- [ ] No #204/#205/#206/#219-only surface is introduced, and those issues remain open in ROADMAP.

## Technical Specifications

### Architecture Overview

```text
Commander discover leaf
  -> discovery action
    -> existing scheduler: discovery lane
      -> private Last.fm client/transport
        -> fixed https://ws.audioscrobbler.com/2.0/
    -> strict attributed result
    -> optional one-rank add-plan producer
      -> fresh private Lidarr facade reads
      -> sealed artist-add plan
        -> existing lidarr apply
          -> metadata-dependent operation-owned dispatch
            -> private generated Lidarr artist-create operation
```

The command owns parsing and presentation. The action owns scheduling, ranking, immutable output,
and optional handoff orchestration. `lib/discovery/lastfm.ts` is the single authorized Last.fm
fetch owner and owns credential injection, fixed origin, body limits, response projection, and
provider errors. Ordinary discovery never resolves a Lidarr client. Add planning composes one
fresh discovery result with fresh Lidarr resource reads, while apply remains the sole mutation
owner.

### Data Models

```typescript
interface LastFmConfigOptions {
  readonly apiKey?: string;
  readonly timeoutMs?: number;
}

interface DiscoveryConfigOptions {
  readonly lastfm?: LastFmConfigOptions;
}

interface SimilarArtistRecommendation {
  readonly rank: number;
  readonly name: string;
  readonly similarity: number;
  readonly musicBrainzId?: string;
  readonly sourceUrl: string;
  readonly addEligibility: "exact-id" | "requires-resolution";
}

interface LidarrDiscoverResult {
  readonly seed: {
    readonly requestedName: string;
    readonly resolvedName: string;
    readonly autocorrected: boolean;
  };
  readonly request: {
    readonly limit: number;
    readonly autocorrect: boolean;
  };
  readonly recommendations: readonly SimilarArtistRecommendation[];
  readonly returned: number;
  readonly source: {
    readonly provider: "lastfm";
    readonly method: "artist.getSimilar";
    readonly attribution: "Recommendations provided by Last.fm";
    readonly url: "https://www.last.fm/";
    readonly fetchedAt: string;
  };
  readonly execution: LidarrExecutionSuccessMetadata;
  readonly handoff:
    | { readonly status: "not-requested" }
    | {
        readonly status: "plan-created";
        readonly selectedRank: number;
        readonly musicBrainzId: string;
        readonly planId: string;
        readonly planChecksum: string;
        readonly planPath: string;
        readonly nextCommand: string;
      }
    | {
        readonly status: "already-present";
        readonly selectedRank: number;
        readonly musicBrainzId: string;
        readonly lidarrId: number;
      }
    | {
        readonly status: "failed";
        readonly selectedRank: number;
        readonly code: "candidate-not-found" | "identity-required" | "lidarr-plan-failed";
        readonly message: string;
        readonly retryable: boolean;
      };
}
```

Optional JSON/YAML fields are omitted rather than serialized as `null`, matching current package
patterns. CSV uses one fixed summary row followed by recommendation rows, so empty output retains
seed, source, request, execution, and handoff metadata. When discovery succeeds but an explicitly
requested handoff fails, every machine format emits exactly one complete discovery document with
`handoff.status = "failed"`; CSV carries the same sanitized code, message, and retryability on its
summary row. The command sets a nonzero process exit code only after rendering that document.
Provider failure still follows the ordinary command failure contract because no successful
discovery result exists to preserve. Handoff messages pass through the same sensitive-value and
query-key redaction used by the command failure boundary.

The plan schema gains an exact `artist-add` operation and foreign-ID target:

```typescript
interface LidarrArtistAddInput {
  readonly artistName: string;
  readonly foreignArtistId: string;
  readonly rootFolderPath: string;
  readonly qualityProfileId: number;
  readonly metadataProfileId: number;
  readonly monitored: false;
  readonly monitorNewItems: "none";
  readonly searchForMissingAlbums: false;
}
```

The plan records expected absence, desired state, explicit resolved resource references, Last.fm
provenance, target Lidarr origin, plan ID/checksum, and a stable idempotency key. The existing plan
schema version remains v2 because the exact allowlist is additive and older binaries already
reject unknown operations fail-closed.

### API Design

#### CLI

```text
rfmedia lidarr discover --artist <name> [--limit <n>] [--no-autocorrect]

Optional add-plan handoff:
  --add <rank>
  --root-folder <reference>
  --quality-profile <reference>
  --metadata-profile <reference>
  --plan-file <path>
  --lidarr-url <url>
  --lidarr-api-key <key>
```

There is no `--lastfm-api-key`; use `discovery.lastfm.apiKey` with the existing environment,
dotenvx, or 1Password template paths. Add-only options conflict with ordinary use and are all
required when `--add` is present. `--add` conflicts with stale data because no provider cache is
shipped.

#### Provider client

```typescript
interface LastFmClient {
  getSimilarArtists(query: {
    readonly artist: string;
    readonly limit: number;
    readonly autocorrect: boolean;
    readonly signal?: AbortSignal;
  }): Promise<LastFmSimilarArtistResult>;
}
```

The fixed transport parses Last.fm logical errors before success, caps success bodies at 1 MiB and
error bodies at 4 KiB, validates fatal UTF-8 and JSON, and never exposes a full request URL, raw
body, `Request`, or secret-bearing cause.

#### Scheduler failure metadata

Introduce a narrow structural scheduled-error contract with `code`, `retryable`, optional
`statusCode`, and optional `retryAfterSeconds`. Add `discovery-provider-unavailable` to scheduler
failure output, not `LidarrErrorCode`. Only idempotent discovery-lane work may retry that code. It
does not feed Lidarr/metadata circuits, Lidarr stale hints, or deferred mutation queues.

#### Lidarr facade

```typescript
interface LidarrClientApi {
  listRootFolders(signal?: AbortSignal): Promise<readonly LidarrRootFolder[]>;
  addArtist(input: LidarrArtistAddInput, signal?: AbortSignal): Promise<LidarrArtist>;
}
```

Only `client.ts` imports the existing generated operations and writable DTOs. Generated source is
not edited; offline generator requirements and contract tests are extended to assert the already
present endpoints.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`
- `packages/rfmedia-cli/src/types/discovery.ts`
- focused provider/action tests beside their owners
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`

#### Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts` and command tests
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` and Lidarr client mocks
- `packages/rfmedia-cli/src/types/config.ts`, `src/types/index.ts`, and `src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` and failure metadata tests
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`, `types.ts`, and related tests
- `packages/rfmedia-cli/src/types/lidarr.ts` and `src/types/lidarr-plan.ts`
- plan engine, operation definitions, apply execution/verification, history, and resume tests
- generated-client requirement assertions and generated contract tests
- architecture scanner and scanner fixtures
- Bash, Zsh, and Fish completion templates plus parity tests
- `rfmedia.example.yaml`, package README, CHANGELOG, feature docs, ROADMAP, and roadmap archive

#### Configuration

```yaml
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
    timeoutMs: 15000
```

The section has no provider selector or configurable endpoint. A literal `apiKey` is read only by
discovery, but repository-wide config template expansion is intentionally eager: when the example
`{{ LASTFM_API_KEY }}` placeholder is present, that environment value must exist whenever the
configuration file is loaded, including for unrelated commands. Omitting the entire discovery
section leaves unrelated commands unaffected. The resolved key is never persisted and is redacted
recursively plus explicitly at discovery and handoff failure boundaries.

## UX Considerations

### User Workflows

#### Read-Only Discovery

1. Run `rfmedia lidarr discover --artist "Radiohead"`.
2. Validate seed, limit, config, and output selection before I/O.
3. Execute one cancellable Last.fm task in the discovery lane.
4. Render requested/resolved seed, ordered recommendations, similarity, identity eligibility,
   Last.fm attribution, and execution summary.
5. State that no artists were added.

#### Add-Plan Handoff

1. Run discovery with `--add <rank>` and all required resource/plan options.
2. Require the selected visible candidate to have an MBID.
3. Resolve fresh Lidarr state and resource references.
4. Return already-present or write one sealed plan.
5. Display plan ID, checksum, path, exact conservative policy, and
   `rfmedia lidarr apply <plan-file>` as the next step.
6. A later explicit apply revalidates and prompts before any mutation.

#### Error Recovery

- Provider failures name Last.fm, classification, attempts, retryability, and safe delay.
- Missing/invalid Last.fm config explains the template path without echoing the key.
- Ambiguous or missing candidate identity leaves discovery successful and blocks only the handoff.
- Lidarr planning failure preserves the successful discovery result in machine output and reports
  handoff failure separately.
- Uncertain artist-create dispatch stops further work and directs the operator to fresh MBID
  reconciliation; no automatic replay occurs.

### UI Patterns

| Component      | Pattern                                   | Notes                                                    |
| -------------- | ----------------------------------------- | -------------------------------------------------------- |
| Human result   | Compact stderr table                      | Rank, artist, 0–1 similarity, MBID, add eligibility      |
| Attribution    | Mandatory source footer                   | Present for normal, empty, and cached-independent output |
| Machine result | Stable `{command,result}`                 | Same logical schema in JSON and YAML                     |
| CSV            | Explicit summary plus recommendation rows | Formula-neutralized and non-empty for empty results      |
| Mutation       | Plan then apply                           | Discovery command never prompts or mutates               |
| Error labels   | Text plus optional color                  | Never rely on color alone                                |

### Accessibility Requirements

- Reject terminal controls and bidi spoofing before truncation or coloring.
- Keep labels meaningful with `NO_COLOR`.
- Do not rely on similarity color or addability icons.
- Preserve full untruncated values in machine output.

### Performance UX

- One provider request is the normal path; no Last.fm search preflight or Lidarr preflight.
- Do not stream partial candidates before full validation.
- Show a concise interactive stderr status only for perceptible delay or retry.
- Cancellation interrupts queue admission, fetch, body read, and scheduler backoff.

## Recommendations

### Implementation Approach

**Recommended strategy**: implement the read-only provider boundary first, then extend the existing
plan/apply registry with one non-deferable `artist-add` operation before wiring `--add <rank>`.
Keeping those phases separate preserves a testable trust boundary while delivering the complete
issue contract in one PR.

**Phasing:**

1. **Provider foundation**: configuration, strict Last.fm transport, error metadata, action, and
   public results.
2. **CLI surface**: command/presenters, attribution, completions, and read-only docs/tests.
3. **Add-plan boundary**: facade reads/create, exact plan operation, apply reconciliation, and
   one-rank handoff.
4. **Release hardening**: architecture/codegen gates, full validation, ROADMAP/archive, and review.

### Technology Decisions

| Decision             | Recommendation                                             | Rationale                                                      |
| -------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| HTTP                 | Native Node.js 22                                          | One endpoint; no supported SDK; local policy remains necessary |
| Provider abstraction | Last.fm-specific module plus fixed source object           | Avoid pre-implementing #204                                    |
| Credentials          | Template-backed `discovery.lastfm.apiKey` only             | Avoid argv and project-wide shared-key exposure                |
| Cache                | None in #203                                               | Avoid unapproved privacy/retention/stale semantics             |
| Retry                | Existing scheduler as sole owner with structural metadata  | Accurate provider errors without duplicate retry loops         |
| Add                  | One rank creates one sealed plan                           | Satisfies issue without implicit mutation or bulk scope        |
| Add defaults         | Explicit resources plus fixed unmonitored/no-search policy | Conservative and does not consume #206 configurable policy     |

### Quick Wins

- Reuse the shipped discovery lane and execution metadata.
- Mirror the `lidarr-search` command factory and explicit CSV shape.
- Extend the exact fetch-owner scanner rather than adding a new architecture framework.
- Consume generated artist-create/root-folder operations already in the committed snapshot.

### Future Enhancements

- #204: provider federation, fallback, selection, and response caching
- #205: thresholds, quarantine, multi-selection, diversity, deep traversal, and loop prevention
- #206: configurable safe add defaults and post-add normalization
- #219: cascade and indexer/download budgets

## Risk Assessment

### Technical Risks

| Risk                                                  | Likelihood | Impact | Mitigation                                                                       |
| ----------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------- |
| Query key leaks through URL/error objects             | Medium     | High   | Fixed transport, no full URL logging/causes, exact-value and query-key redaction |
| Provider response exhausts memory or injects controls | Medium     | High   | Body caps, fatal decode, strict atomic projection, terminal-safe fields          |
| Scheduler retries provider traffic incorrectly        | Medium     | Medium | One structural classifier, discovery-only transient allowlist, sole retry owner  |
| Add plan expands plan/apply complexity                | High       | High   | Exact operation definition, one candidate, fixed policy, non-deferable dispatch  |
| Generated boundary leaks                              | Low        | High   | Consume only in `client.ts`; architecture and codegen contract gates             |
| Last.fm terms change                                  | Medium     | High   | User-owned keys, documented terms date, release-time recheck                     |
| Completion/docs drift                                 | Medium     | Medium | Bash/Zsh/Fish parity test and one completion audit                               |

### Integration Challenges

- Existing scheduler names are Lidarr-specific but already own the discovery lane. Extend only the
  failure-metadata seam; do not perform a repository-wide rename.
- Plan targets currently assume local numeric resource IDs. `artist-add` must allow a
  MusicBrainz-ID target with expected absence while preserving existing v1/v2 operation behavior.
- Root-folder lookup is not yet exposed through the facade, although the generated operation
  exists.
- Artist create can be possibly dispatched on timeout; verification and resume must distinguish
  proven pre-dispatch failure from uncertainty.

### Security Considerations

#### Critical — Hard Stops

| Finding                                                      | Risk                                                             | Required Mitigation                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last.fm recommendation crosses directly into artist creation | Wrong identity or unintended monitoring/search/download cascades | Exact MBID-backed selection, fresh Lidarr lookup, explicit policy, sealed origin-bound plan, separate apply approval, one-artist cap, no blind retry |

#### Warnings — Must Address

| Finding                         | Risk                               | Mitigation                                                                             | Alternatives                                      |
| ------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| API key in query                | Secret leakage                     | Template credential, fixed safe errors, no full URL/Request retention, redaction tests | None; provider requires query key                 |
| Redirect or configurable origin | Credential exfiltration/SSRF       | Fixed HTTPS endpoint and `redirect: "error"`                                           | None in production                                |
| Malformed/oversized data        | Resource exhaustion/type confusion | Body and collection caps, strict projection                                            | No partial output                                 |
| Terminal controls               | Prompt/table/log spoofing          | Reject controls and bidi before all sinks                                              | None                                              |
| Rate/retry amplification        | Provider suspension                | One request, one retry owner, capped abortable backoff                                 | Ship one attempt if classification is unavailable |
| Missing provenance              | Misleading output/terms violation  | Mandatory source, method, seed, score, time, and links                                 | None                                              |
| Cache privacy/poisoning         | Interest disclosure/wrong add      | No provider cache in #203                                                              | Later private header-aware store                  |

#### Advisories — Best Practices

- Use only an application API key; do not add Last.fm user authentication.
- Add no Last.fm SDK or new HTTP dependency.
- Never fetch or auto-open provider-returned links.
- Document seed exposure in shell history and output without treating it as a secret.

## Task Breakdown Preview

### Phase 1: Provider and Contracts

**Focus**: Independent Last.fm trust boundary.

- Add config/result/error types and validation.
- Implement fixed transport, strict projection, cancellation, and secret safety.
- Generalize scheduler failure metadata narrowly.

**Parallelization**: config/types and transport architecture can be developed independently once
the schema is frozen.

### Phase 2: Read-Only Command

**Focus**: Complete attributed CLI surface.

- Add discovery action and command factory.
- Add human/JSON/YAML/CSV presenters and critical tests.
- Update Bash/Zsh/Fish completions and docs.

**Dependencies**: Phase 1.

### Phase 3: Artist-Add Plan

**Focus**: Safe optional handoff.

- Add root/profile lookup and narrow artist-create facade methods.
- Extend plan schema/registry with expected-absence artist-add.
- Add apply execution, verification, uncertain-dispatch reconciliation, and boundary tests.
- Connect `--add <rank>` to plan creation only.

**Dependencies**: Phases 1–2 and current plan/apply architecture.

### Phase 4: Validation and Release

**Focus**: Contract evidence and issue closeout.

- Run focused provider/action/command/plan tests.
- Run architecture, generated-client, completion, typecheck, coverage, build, formatting,
  markdown, and whitespace gates.
- Update ROADMAP/archive, create and review the PR, fix findings, wait for green CI, and merge.

## Decisions Needed

The design resolves the implementation decisions as follows:

1. **Add acceptance**: #203 includes one-candidate add-plan creation; actual mutation remains
   `lidarr apply`. No child issue is required because the bounded operation is implemented and
   verified in the same delivery.
2. **Add policy**: resource references are explicit; v1 is fixed unmonitored,
   `monitorNewItems=none`, and search-disabled. #206 remains responsible for configurable defaults.
3. **Configuration**: use `discovery.lastfm.apiKey` and optional `timeoutMs`; no provider selector
   or configurable endpoint.
4. **Credentials**: no `--lastfm-api-key`; use config templates/dotenvx/1Password.
5. **Limits**: default 15, maximum 100; no offset, page, total, `hasMore`, or threshold.
6. **Autocorrection**: default on with `--no-autocorrect`; only provider evidence sets
   `autocorrected`.
7. **Cache**: no persistent provider cache or stale output in #203.
8. **Error taxonomy**: scheduler output gains `discovery-provider-unavailable`; Lidarr error and
   circuit taxonomies remain accurate.
9. **Absent machine fields**: omit optional MBID and URLs consistently in JSON/YAML.
10. **Plan schema**: extend v2's exact operation allowlist; older binaries fail closed.

## Research References

- [research-external.md](./research-external.md): Last.fm and Lidarr API contracts
- [research-business.md](./research-business.md): user value, scope, rules, and acceptance
- [research-technical.md](./research-technical.md): architecture, types, files, and add-plan design
- [research-ux.md](./research-ux.md): command, output, attribution, and recovery UX
- [research-security.md](./research-security.md): severity-classified controls and test matrix
- [research-practices.md](./research-practices.md): reuse, KISS, module boundaries, and test seams
- [research-recommendations.md](./research-recommendations.md): alternatives, risks, and phasing
