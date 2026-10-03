# Feature Spec: Plex Adapter Refactor

## Executive Summary

GitHub issue #119 completes the media-server boundary introduced by issue #117 without changing
existing Plex workflows. Every Plex request, credential decision, wire type, rating conversion, and
cache entry becomes owned by `PlexAdapter` and private support modules, while compatibility
projections preserve CLI, MCP, JSON, SQLite, config, and completion contracts. The implementation
uses server-neutral domain types, native Node HTTP primitives, header-only opaque tokens,
origin-bound overrides, and per-adapter caching. Automatic JWT enrollment and refresh is tracked by
linked child issue #251 because it requires a distinct key-storage, authorization, persistence, and
retry design.

## External Dependencies

### APIs and Services

#### Plex Media Server API

- **Documentation**: <https://developer.plex.tv/pms/>
- **Authentication**: An opaque legacy token or Plex JWT sent in `X-Plex-Token`.
- **Content type**: Request JSON with `Accept: application/json`.
- **Key endpoints**:
  - `GET /`: server identity and machine identifier.
  - `GET /library/sections`: libraries and section identifiers.
  - `GET /library/sections/{id}/all`: track, album, and artist queries.
  - `GET /library/metadata/{id}/children`: album, playlist, and collection contents.
  - `GET /library/sections/{id}/refresh`: whole-library or path-scoped scan.
  - `PUT /:/rate`: track rating mutation.
  - `GET|POST|PUT|DELETE /playlists...`: playlist operations.
  - `GET|POST|PUT|DELETE /library/.../collections...`: collection operations.
- **Pagination**: Send `X-Plex-Container-Start` and `X-Plex-Container-Size`; advance from response
  metadata and fail on zero progress.
- **Rate limits**: PMS publishes no numeric request quota. Preserve the existing 100 ms live-request
  pacing; bounded `429` interpretation is supported without automatic mutation replay.
- **Pricing and entitlement**: Local PMS API access is not separately metered. Sonic Analysis is a
  Plex Pass, server, platform, and library-dependent feature and is described as
  `server-dependent`, not guaranteed.
- **Versioning**: Preserve historical API behavior by not opting into a newer
  `X-Plex-Pms-Api-Version` during this refactor.

#### Plex Authentication Service

- **Documentation**: <https://developer.plex.tv/pms/>
- **Current scope**: Existing `plex.token` and `--plex-token` values are opaque and may contain a
  legacy token or already-issued JWT.
- **Deferred scope**: PIN enrollment, Ed25519/JWK management, client identity persistence, JWT
  acquisition, seven-day expiry, nonce refresh, revocation, and atomic secret replacement belong
  to child issue #251.
- **Relevant failures**: `401`/`403` for authorization problems and JWT-specific `422`, `429`, and
  `498` responses. #119 maps these to typed, redacted errors but its static provider does not
  refresh or replay requests.

### Libraries and SDKs

| Library or platform                                     | Version           | Purpose                                                  | Decision                                              |
| ------------------------------------------------------- | ----------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Node.js native `fetch`, `URL`, `Headers`, `AbortSignal` | Node 22+          | Plex transport, encoding, headers, and cancellation      | Reuse; no installation                                |
| Existing Vitest toolchain                               | Repository-pinned | Unit, contract, action, command, and compatibility tests | Reuse                                                 |
| Third-party Plex SDK                                    | N/A               | Plex API client                                          | Do not add; it increases parity and supply-chain risk |
| `jose`                                                  | Deferred          | Future Ed25519/JWK/JWT lifecycle                         | Add only in the child issue if needed                 |

### External Documentation

- [Plex Media Server API](https://developer.plex.tv/pms/): endpoints, headers, keys, pagination,
  versioning, and current JWT flow.
- [Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/):
  legacy token guidance and invalidation caveats.
- [Sonic Analysis for Music](https://support.plex.tv/articles/sonic-analysis-music/): entitlement,
  server, platform, and operational constraints.
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html):
  allowlisting and redirect controls used for connection-origin binding.

## Business Requirements

### User Stories

**Primary User: Existing rfmedia Plex operator**

- As an operator, I want upgrades to preserve my `plex:` config, `rfmedia plex` commands, flags,
  scripts, output parsers, saved queries, and shell completions so that the refactor is invisible.
- As an operator, I want optional scans to remain best effort while required Plex queries and
  mutations fail clearly so that primary media operations retain their current reliability.
- As an operator, I want credentials excluded from URLs, logs, errors, caches, and plans so that
  routine diagnostics cannot disclose Plex access.
- As an operator, I want an already-issued Plex JWT to work through the existing token field so
  that Plex's authentication migration does not force a new CLI workflow.

**Secondary User: Adapter maintainer**

- As a maintainer, I want one Plex-owned implementation boundary so that endpoint, authentication,
  cache, and response changes can be tested without touching action orchestration.
- As a future adapter author, I want server-neutral IDs, ratings, filters, pages, and capabilities
  so that a backend does not need to imitate Plex protocol concepts.

### Business Rules

1. **One Plex network boundary**: Only `PlexAdapter` and private modules beneath
   `lib/adapters/plex/` may construct Plex endpoints, attach credentials, call Plex, parse Plex wire
   payloads, or apply Plex cache and retry policy.
   - Validation: Repository boundary check plus a repository-wide production import/fetch audit.
   - Exception: A pure compatibility presenter may use Plex field names but performs no network or
     cache operation.

2. **Server-neutral adapter contract**: `MediaServerAdapter` uses generic `id`, media entities,
   pages, normalized ratings, filters, and operation results.
   - Validation: A compile-only fake adapter implements the contract without importing any Plex or
     Plex database type.

3. **Backward-compatible public behavior**: Existing config keys, precedence, commands, options,
   aliases, output fields, saved-query tables, error intent, and exit semantics remain valid.
   - Validation: Command, MCP, persistence, help, completion, and existing regression tests.
   - Exception: Unsafe cross-origin credential inheritance is rejected even when a caller supplies
     only a URL override; paired explicit overrides remain supported.

4. **Truthful feature metadata**: The adapter reports native Plex rating scale and whether ratings,
   smart containers, path scans, filter pushdown, and Sonic Analysis are available or
   server-dependent. Metadata must not imply an executable Sonic operation.

5. **Explicit rating conversion**: Generic ratings are finite `0..1` or `null`; Plex wire and
   persisted compatibility values remain `0..10`; CLI input/output remains `0..5` stars.

6. **Opaque static authentication**: Existing token sources may contain a legacy token or JWT and
   are never decoded for trust decisions. #119 has no enrollment, refresh, private-key, or secret
   persistence workflow.

7. **Credential and origin binding**: A configured credential is bound to its canonical configured
   origin. An override that changes origin must include an explicitly paired token; URL-only
   cross-origin fallback makes no request. Authenticated redirects are rejected.

8. **Adapter-owned caching**: Cache enablement and TTL are captured at adapter construction. State
   is isolated per adapter/credential context, remains opt-in with the 300-second default, omits
   secrets from keys, and is invalidated after successful playlist or collection mutation.

9. **Operation contract preservation**: Query and CRUD methods throw; scan and rating writes keep
   their established result objects. Optional scans remain skippable and dry runs remain
   non-mutating.

10. **No speculative platform work**: Do not add a Plex SDK, API-version opt-in, provider discovery,
    generic database migration, generic command namespace, or public JWT option in #119.

### Edge Cases

| Scenario                                          | Expected Behavior                                              | Notes                                          |
| ------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Missing Plex config in required mode              | Existing actionable configuration failure                      | Non-zero exit                                  |
| Missing or invalid config for optional scan       | Existing warning and skipped scan                              | Primary operation continues                    |
| URL override changes origin without token         | Reject before request                                          | Prevents configured-token exfiltration         |
| URL and token explicitly overridden together      | Preserve local CLI/MCP compatibility after URL validation      | Credential is bound to override origin         |
| Legacy token or pre-issued JWT supplied           | Send opaque value in `X-Plex-Token`                            | Never infer claims from token shape            |
| 3xx authenticated response                        | Reject; do not forward credential                              | No automatic redirect                          |
| `401`, `403`, `429`, or `498`                     | Typed, redacted failure with established outer behavior        | No retry from static provider                  |
| Two credentials target one server                 | No cross-credential cached response                            | Adapter-local state                            |
| Cache hit                                         | Same domain result as live request, without pacing delay       | No cache text on stdout                        |
| Successful container mutation                     | Relevant cache entries invalidated                             | Failures/dry runs do not invalidate as success |
| Malformed or oversized response                   | Typed invalid-response failure                                 | Never cached; sanitized bounded excerpt only   |
| Plex omits or varies page metadata                | Advance from returned count; stop safely on zero progress      | No skip/duplicate/infinite loop                |
| Unrated, zero, half-star, maximum, invalid rating | Exact supported round trip; invalid values fail before request | Compatibility value stays `0..10`              |
| Sonic Analysis unavailable                        | Feature remains `server-dependent`; no false callable support  | No CLI change                                  |
| Completion generation                             | No adapter initialization or Plex request                      | Templates remain unchanged                     |

### Success Criteria

- [ ] `MediaServerAdapter` and generic helpers have no Plex or Plex-database imports.
- [ ] Exactly one private Plex transport performs authenticated `fetch` calls; old Plex API, cache,
      filter-evaluator, and pagination bypass modules are removed after migration.
- [ ] Every authenticated request uses `X-Plex-Token`; request URLs, logs, errors, plans, and cache
      keys contain no credential material.
- [ ] URL-only cross-origin overrides are rejected without a request; authenticated redirects are
      not followed.
- [ ] A supplied legacy token and supplied JWT both use the static opaque provider; auth failures
      are typed and no mutation is automatically replayed.
- [ ] Feature metadata truthfully describes rating scale, rating operations, smart containers,
      filter pushdown, path scans, and server-dependent Sonic Analysis.
- [ ] Per-adapter cache tests prove disabled/default/custom TTL, expiry, isolation, secret-free
      keys, cache-hit equivalence, and mutation invalidation.
- [ ] Query, pagination, scan fallback, rating, playlist batching, collection fallback, and error
      regression tests retain current behavior.
- [ ] CLI help, options, human output intent, JSON/MCP fields, SQLite rows, and exit behavior remain
      compatible.
- [ ] Bash, Zsh, and Fish completion candidates are unchanged and the parity suite passes.
- [ ] Typecheck, build, focused/full tests, coverage gate, boundary audit, markdown checks,
      `git diff --check`, and `graphify update .` complete successfully.
- [ ] `ROADMAP.md` records #119 and its PR as shipped without marking dependent work complete.

## Technical Specifications

### Architecture Overview

```text
existing commands / MCP / actions
                |
                v
server-neutral MediaServerAdapter contract
                |
                v
           PlexAdapter
        /      |      \
       v       v       v
 private   private   private
 auth +    mappers   cache
 client      |        |
       \      |      /
        v     v     v
        Plex Media Server

generic results --> Plex compatibility presenter --> unchanged CLI/MCP/SQLite shapes
```

Required dependency direction:

```text
commands/MCP/actions -> generic contract -> PlexAdapter -> adapters/plex/*
```

Generic modules never import `types/plex.ts`, `lib/plex.ts`, or `adapters/plex/*`. Plex-branded
command, MCP, config, and persistence edges remain intentional compatibility surfaces.

### Data Models

#### Generic Media Entities

| Field                       | Type                             | Constraints                | Description              |
| --------------------------- | -------------------------------- | -------------------------- | ------------------------ | ----------------- |
| `id`                        | `string`                         | Non-empty, opaque          | Provider item identifier |
| `kind`                      | `"track" \| "album" \| "artist"` | Discriminator              | Generic media kind       |
| `title`                     | `string`                         | Required                   | Display title            |
| `rating`                    | `number                          | null`                      | Finite `0..1` or unrated | Normalized rating |
| `genres`, `styles`, `moods` | `readonly string[]`              | Optional/bounded from wire | Filterable metadata      |
| `year`                      | `number`                         | Optional                   | Release year             |

`MediaTrack`, `MediaAlbum`, and `MediaArtist` are a discriminated union. Track-only values such as
`artist`, `album`, `playCount`, `durationMs`, and `filePath` do not become optional fields on every
entity.

#### Generic Page and Query

| Field      | Type           | Constraints            | Description                                          |
| ---------- | -------------- | ---------------------- | ---------------------------------------------------- |
| `items`    | `readonly T[]` | Kind-specific entities | Current page                                         |
| `total`    | `number`       | Non-negative           | Server/compatibility total                           |
| `offset`   | `number`       | Non-negative           | Page start                                           |
| `returned` | `number`       | Non-negative           | Server-returned page count before residual filtering |
| `hasMore`  | `boolean`      | Derived defensively    | Whether pagination may continue                      |

Query options use library, kind, generic filter AST, limit, and offset. Plex numeric metadata codes
and query parameter names remain private mapper/client concepts.

#### Features and Errors

`MediaServerFeatures` includes rating readability/writability and native scale, smart playlist and
collection support, path-scoped scans, filter-pushdown descriptors, and Sonic availability as
`available | unavailable | server-dependent`.

`MediaServerError` carries `serverType`, `operation`, optional status, retryability, and one of:
`configuration`, `authentication`, `authorization`, `not-found`, `unsupported`, `rate-limited`,
`timeout`, `network`, `invalid-response`, or `request-failed`. The CLI formatter preserves current
Plex-oriented recovery wording without actions parsing error strings.

#### Persistence Compatibility

No schema migration is permitted. `plex_queries`, `plex_query_results`, `rating_key`,
`user_rating`, and `media_type` retain their current meanings. Pure projections map generic `id` to
`rating_key` and normalized rating to Plex `0..10` at the persistence and machine-output edges.

### API Design

#### Media Server Adapter

```typescript
export interface MediaServerAdapter {
  readonly type: MediaServerType;
  readonly capabilities: MediaServerCapabilities;
  readonly features: MediaServerFeatures;
  readonly query: MediaServerQueryCapability;
  readonly library: MediaServerLibraryCapability;
  readonly scan: MediaServerScanCapability;
  readonly playlist: MediaServerPlaylistCapability;
  readonly collection: MediaServerCollectionCapability;
  readonly metadata: MediaServerMetadataCapability;
}
```

- Query exposes explicit `tracks`, `albums`, `artists`, and `albumTracks` methods.
- Collection membership accepts collection ID and generic item IDs; machine identifiers and
  `server://` URIs are private.
- Rating writes accept normalized `number | null` after runtime validation.
- Local path existence checks move to a provider-neutral action helper, not a server capability.

#### Plex Token Provider

```typescript
interface PlexTokenProvider {
  getToken(): Promise<string>;
  handleAuthFailure?(status: number): Promise<"retry" | "fail">;
}
```

The production provider in #119 always returns the configured opaque value and returns `fail` for
auth recovery. The interface allows a future child implementation to refresh once without changing
endpoint methods.

#### Plex Client

```typescript
interface PlexRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  signal?: AbortSignal;
}

interface PlexTransport {
  request<T>(path: string, options?: PlexRequestOptions): Promise<T>;
}
```

The client resolves only relative paths against a normalized base URL, applies the token header,
uses `redirect: "error"`, requests JSON, composes request timeout and caller cancellation, paces
live requests once, bounds error bodies, and maps statuses to typed errors. Endpoint methods use
`URL` and `URLSearchParams`, validate the wire fields they consume, and never return `Response`
objects outside the private Plex layer.

#### Connection Override Resolution

```text
configured origin + configured credential -> allowed
same-origin URL override + configured credential -> allowed
different-origin URL override without explicit token -> reject
different-origin URL override + explicit token -> allowed after URL validation
token override + configured origin -> allowed
```

This retains current explicit override workflows while preventing independent fallback from
sending a configured credential to an attacker-controlled origin. MCP schemas remain compatible,
but the same provenance rule applies and a rejected combination makes no request.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/types/media-filters.ts`: provider-neutral filter AST and guards.
- `packages/rfmedia-cli/src/lib/media-filter-evaluator.ts`: residual generic evaluation.
- `packages/rfmedia-cli/src/lib/pagination.ts`: provider-neutral forward-progress calculation.
- `packages/rfmedia-cli/src/lib/media-file-paths.ts`: local path extraction and existence checks.
- `packages/rfmedia-cli/src/lib/adapters/plex/auth.ts`: static opaque token provider and seam.
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`: only Plex HTTP boundary.
- `packages/rfmedia-cli/src/lib/adapters/plex/cache.ts`: isolated TTL cache.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: Plex wire/domain and rating mapping.
- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`: private connection and wire types.
- Focused tests beside every new private/generic module.

#### Files to Modify

- `src/types/media-server.ts`, `types/plex.ts`, `types/plex-filters.ts`, and `types/index.ts`: generic
  contract plus deliberate deprecated compatibility exports.
- `src/lib/adapters/plex-adapter.ts`, `adapters/index.ts`, and `adapters/action-helpers.ts`: full
  implementation, provenance-aware factory, and generic action helpers.
- Plex query/copy/playlist/collection/sync actions, shared playlist action, fixtures, mocks, and
  tests: consume generic entities and normalized ratings.
- `src/commands/plex.ts` and MCP/persistence edges: explicit compatibility projection only where
  their established public shapes require Plex names/scales.
- `scripts/check-direct-plex-imports.mjs` and package validation scripts: broaden and enforce the
  architecture rule.
- Adapter/config/cache docs, package README, and `ROADMAP.md`: describe the completed behavior and
  shipped issue.

#### Files to Delete After Migration

- `src/lib/plex.ts`
- `src/lib/plex-cache.ts`
- `src/lib/plex-filter-evaluator.ts`
- `src/lib/plex-pagination.ts`

Their behavior tests migrate before deletion. A final compatibility module, if needed, may contain
pure projections only and must not preserve a second network path.

#### Configuration

- Preserve all existing `plex.*`, `plexFilters`, cache, library mapping, and scan settings.
- Add no required key, new auth flag, or public command.
- Preserve CLI-over-config precedence and required-versus-optional adapter resolution semantics.
- Bash, Zsh, and Fish templates require validation but no candidate changes.

## UX Considerations

### User Workflows

#### Primary Workflow: Existing Plex Query or Mutation

1. **Invoke existing command**
   - User: Runs the same `rfmedia plex query|copy|playlist|sync|collection` command and flags.
   - System: Applies the same validation, config precedence, lazy loading, and dry-run rules.
2. **Resolve adapter and execute**
   - User: Sees no adapter terminology or auth internals.
   - System: Performs generic orchestration while Plex-specific HTTP/cache/mapping stays private.
3. **Success state**
   - Human output, machine discriminator/fields, persistence, progress channel, and exit behavior
     retain current semantics.

#### Error Recovery Workflow

1. **Error occurs**: Configuration, authentication, authorization, not-found, network, timeout, or
   invalid response is classified inside the adapter.
2. **User sees**: The existing operation-oriented Plex prefix, status/reason where appropriate, and
   a secret-free actionable remedy.
3. **Recovery**: The user corrects URL/token/library/resource or retries manually. The static
   provider does not silently replay an ambiguous mutation.

#### Optional Scan Workflow

1. Disabled scan returns no adapter and performs no Plex work.
2. Requested scan with unusable config warns and skips without failing the completed primary work.
3. A valid mapped path receives the narrow scan; mapping failure preserves the established full
   scan fallback; dry run sends no request.

### UI Patterns

| Component           | Pattern                                        | Notes                                                 |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Command tree        | Existing Commander hierarchy                   | No rename, alias, option, default, or conflict change |
| Human output        | Existing tables, summaries, warnings, progress | Keep Plex terminology and 1-5 stars                   |
| Machine output      | Existing `plex-*` envelopes                    | No new cache/auth noise on stdout                     |
| Errors              | Operation-oriented formatter                   | Typed internally, compatible wording externally       |
| Destructive actions | Existing `--yes` confirmation and dry run      | No adapter mutation before confirmation               |
| Shell completion    | Static Bash/Zsh/Fish templates                 | Must not contact Plex; candidates unchanged           |

### Accessibility Requirements

- Color must not be the sole state signal; text, counts, warnings, and exit status remain primary.
- Every workflow remains fully flag/argument driven and usable non-interactively.
- Machine formats stay free of progress, ANSI control sequences, cache events, and auth diagnostics.
- Errors name the failed operation and recovery without exposing class names or secret material.

### Performance UX

- Preserve lazy action imports so unrelated help/completion does not initialize Plex code.
- Preserve the current 30-second per-request bound and one 100 ms pacing delay per live request.
- Cache hits skip the delay and remain output-equivalent to live results.
- Pagination maintains forward progress and cancellation; no nested unbounded retries are added.
- Existing playlist/collection batching and partial-failure reporting remain intact.

## Recommendations

### Implementation Approach

**Recommended Strategy**: Complete ownership inversion in one PR, using phased, dependency-ordered
tasks and compatibility projections. Intermediate implementation may mechanically move endpoint
families, but the merged state has no callable legacy Plex network/cache facade.

**Phasing:**

1. **Phase 0 - Compatibility Baseline and Child Issue**: Capture help/output/error/MCP/DB/completion
   behavior and inventory imports/requests; JWT lifecycle child issue #251 is already linked.
2. **Phase 1 - Generic Contract**: Add generic entities, features, errors, filters, pagination,
   paths, projections, fixtures, and contract tests.
3. **Phase 2 - Private Plex Foundation**: Implement auth, provenance-bound client, cache, private
   types, mappers, endpoint families, and security tests.
4. **Phase 3 - Consumer Migration**: Move actions, factory, commands, MCP, and persistence to the
   generic boundary; preserve established outward shapes.
5. **Phase 4 - Delete and Enforce**: Remove old bypass modules, broaden import enforcement, run all
   compatibility/full validation, update docs/ROADMAP/graph, and complete PR review and CI.

### Technology Decisions

| Decision                | Recommendation                                      | Rationale                                                  |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| HTTP                    | Node 22 native fetch behind injected private client | Existing platform is sufficient and testable               |
| Generic IDs             | Opaque `string` `id`                                | Removes `ratingKey` leakage without speculative branding   |
| Generic ratings         | Runtime-validated `0..1 \| null`                    | Provider-neutral with exact compatibility projection       |
| Query shape             | Explicit track/album/artist methods                 | Clearer than conditional generic complexity                |
| Authentication          | Static opaque provider plus future seam             | Supports legacy/pre-issued JWT without key lifecycle scope |
| Token transport         | `X-Plex-Token` header only                          | Prevents URL disclosure and matches Plex guidance          |
| Redirects               | Reject authenticated redirects                      | Prevents cross-origin credential forwarding                |
| Overrides               | Bind credential provenance to canonical origin      | Closes the critical exfiltration path compatibly           |
| Cache                   | Per-adapter TTL `Map` with injected clock           | Isolated, deterministic, no dependency                     |
| Errors                  | One typed media-server error with outer formatter   | Reliable branching without user-facing drift               |
| Database                | No schema migration                                 | Explicit projections preserve saved queries                |
| Plex SDK/JWT dependency | Add none in #119                                    | Avoids unrelated transport and crypto lifecycle changes    |
| Completions             | Validate unchanged candidates                       | Internal refactor has no public CLI delta                  |

### Quick Wins

- Centralize token header injection and add negative secret-leak tests first.
- Add URL/credential provenance regression coverage before factory refactoring.
- Create generic rating/ID projections with exact round-trip fixtures.
- Extract the current pagination guard and cache clock without changing behavior.
- Expand the import audit early so its allowlist shrinks as migration proceeds.

### Future Enhancements

- Automatic Plex JWT enrollment and refresh through linked child issue #251.
- Provider discovery and explicit PMS API-version negotiation with older-server fallback.
- Runtime Sonic capability probing when a real consumer and Plex Pass fixtures exist.
- Generic persistence v2 when a second backend creates concrete storage requirements.
- Generated completion templates from Commander metadata as an independent tooling improvement.
- A reusable adapter contract-test kit after Plex satisfies the generic contract.

## Risk Assessment

### Technical Risks

| Risk                                         | Likelihood | Impact   | Mitigation                                                          |
| -------------------------------------------- | ---------- | -------- | ------------------------------------------------------------------- |
| Public behavior drifts during type migration | High       | Critical | Baseline and compatibility fixtures at command/MCP/DB edges         |
| Rating scale drift                           | High       | Critical | One mapper/projection boundary and exhaustive round trips           |
| Pagination skips, duplicates, or loops       | Medium     | High     | Preserve response-driven count and zero-progress guard              |
| Cache returns stale/cross-credential data    | Medium     | High     | Adapter-local state, scoped keys, mutation invalidation tests       |
| Optional scan becomes fatal or broad         | Medium     | High     | Preserve required/optional factory matrix and mapped fallback tests |
| Legacy network facade remains callable       | Medium     | High     | Delete old modules and enforce whole-layer imports                  |
| Large refactor becomes unreviewable          | High       | Medium   | Dependency-ordered tasks/commits and capability-family validation   |
| Older PMS breaks due to modernization        | Medium     | High     | Preserve endpoints and historical API-version behavior              |

### Integration Challenges

- Plex-shaped types currently cross actions, commands, MCP, mocks, filters, ratings, and SQLite.
  Introduce generic types and compatibility projections before switching consumers.
- Factory semantics combine CLI precedence and optional scan behavior. Test the full mode/config/
  override matrix, including cross-origin provenance, before replacing resolution code.
- Existing endpoint tests are concentrated in deleted modules. Move each behavioral case to client,
  mapper, cache, adapter, or action tests before deleting its original owner.
- No `graphify-out/graph.json` exists in the worktree. Run `graphify update .`, verify the result,
  and stage generated output only if repository conventions confirm it belongs in the change.

### Security Considerations

#### Critical — Hard Stops

| Finding                                                             | Risk                                                                           | Required Mitigation                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint and credential overrides currently fall back independently | A URL-only caller can send the configured token to an attacker-controlled host | Bind credentials to canonical origin; require an explicit paired token for changed origin; regression-test zero requests on rejection |

#### Warnings — Must Address

| Finding                           | Risk                                      | Mitigation                                                                                           | Alternatives                                          |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Tokens in query strings           | Proxy/log/error disclosure                | Header-only auth and semantic redaction tests                                                        | No default query fallback                             |
| Implicit redirects                | Cross-origin credential forwarding        | `redirect: "error"`                                                                                  | Future explicitly validated same-origin handling only |
| Global URL-only cache scope       | Cross-identity response leakage           | Per-adapter/credential-context isolation                                                             | Disable long-lived sharing                            |
| Unbounded operation/body behavior | Resource exhaustion and log amplification | Request/operation/page/item/body bounds where behavior can be preserved                              | Conservative hard caps, configurable later            |
| Immutable raw token model         | Cannot safely evolve to JWT lifecycle     | Private async provider seam; static implementation now                                               | Full lifecycle in child issue                         |
| Raw CLI/MCP secret arguments      | Shell/model trace exposure                | Preserve compatibility, recommend secret-backed config, redact universally, and deprecate separately | Named connection design in future                     |
| HTTP LAN endpoints                | Network-visible token                     | Preserve local compatibility, prefer HTTPS, document risk, never disable TLS validation              | HTTPS-only would be breaking                          |

#### Advisories — Best Practices

- Use structured, control-character-safe debug fields and treat paths, titles, IDs, and machine
  identifiers as operationally sensitive.
- Validate and encode identifiers at their path/query position; validate only consumed wire fields.
- Never retry non-idempotent writes automatically; honor cancellation and bounded failure behavior.
- Run a clean-install production dependency audit and record/disposition pre-existing advisories;
  do not add an unofficial Plex client dependency.

## Task Breakdown Preview

### Phase 1: Baseline and Generic Foundation

**Focus**: Make compatibility measurable and establish the provider-neutral contract.

**Tasks**:

- Capture command/help/MCP/DB/completion/error baselines; child issue #251 is already linked.
- Add generic media types, features, errors, filters, pagination, path helpers, and projections.
- Convert canonical fixtures/mocks and prove a non-Plex fake adapter compiles.

**Parallelization**: Baseline fixture work and pure generic helper work can proceed concurrently
after their file ownership is separated.

### Phase 2: Plex Foundation and Endpoint Ownership

**Focus**: Build the only authenticated transport and move Plex behavior behind the adapter.
**Dependencies**: Generic error/entity contracts and compatibility baselines.

**Tasks**:

- Add origin-bound auth/client and security regression tests.
- Add private cache/types/mappers and deterministic tests.
- Move query/library/scan/rating, playlist, and collection endpoint families with parity tests.

**Parallelization**: Auth/client and cache/mapper foundations can be separate tasks; endpoint
families depend on their shared contracts and should avoid overlapping the facade concurrently.

### Phase 3: Consumer Migration and Compatibility

**Focus**: Remove Plex protocol knowledge above the adapter while retaining Plex-branded UX.
**Dependencies**: Complete adapter capabilities.

**Tasks**:

- Migrate query/copy/filter/path consumers and saved-query projections.
- Migrate playlist/collection/sync/shared playlist consumers and normalized ratings.
- Adapt command/MCP edges, mocks, tests, and factory resolution with origin binding.

### Phase 4: Enforcement and Delivery

**Focus**: Prove no bypass or user-visible regression remains and complete the GitHub lifecycle.
**Dependencies**: All production consumers use the generic boundary.

**Tasks**:

- Delete legacy modules and broaden/wire the architecture audit.
- Run focused/full validation, three-shell parity, clean audit, graph update, and documentation.
- Update `ROADMAP.md`, open the template-compliant PR, review/fix, monitor CI, squash merge, and
  clean local/remote branch and worktree.

## Decisions Needed

The design workflow resolves the issue-level decisions as follows:

1. **JWT scope**
   - Decision: #119 accepts opaque legacy tokens and pre-issued JWTs through the existing token
     field. Automatic enrollment/refresh is tracked by required child issue #251.
   - Impact: No new config, command, dependency, or completion candidate in this PR.

2. **Generic rating representation**
   - Decision: Use runtime-validated normalized `0..1 | null`; project exactly to Plex `0..10` and
     CLI `0..5` at explicit boundaries.

3. **Public compatibility**
   - Decision: Preserve runtime CLI/MCP/JSON/SQLite behavior and retain deprecated exported Plex
     aliases where `types/index.ts` currently exposes them. New production logic uses generic types.

4. **Legacy Plex modules**
   - Decision: Delete network/cache/filter/pagination bypass modules before merge. Only pure,
     narrowly named compatibility projections may remain.

5. **Cache lifecycle**
   - Decision: Per-adapter cache instances with captured config and credential isolation take
     precedence over implicit process-global reuse.

6. **Sonic Analysis and PMS modernization**
   - Decision: Report Sonic as `server-dependent`; add no operation or probe. Defer provider
     discovery and API-version opt-in.

7. **URL trust boundary**
   - Decision: Continue supporting configured HTTP(S) LAN Plex servers, while binding inherited
     credentials to their canonical origin and rejecting authenticated redirects.

8. **Shell completion policy**
   - Decision: No template edits because public CLI candidates do not change; passing all-template
     parity and help tests is required evidence.

## Research References

For detailed findings, see:

- [research-external.md](./research-external.md): Plex API, auth, SDK, and version research.
- [research-business.md](./research-business.md): Business rules, workflows, and success criteria.
- [research-technical.md](./research-technical.md): Architecture, contracts, files, and integration.
- [research-ux.md](./research-ux.md): CLI compatibility, errors, outputs, and completion behavior.
- [research-security.md](./research-security.md): Severity-ranked security findings and mitigations.
- [research-practices.md](./research-practices.md): Reuse, KISS, modularity, and testing patterns.
- [research-recommendations.md](./research-recommendations.md): Consolidated approach, phasing, and
  alternatives.
