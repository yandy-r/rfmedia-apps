# Recommendations: Plex Adapter Refactor

## Executive Summary

Issue #119 should finish the boundary that issue #117 started. The current branch already has a
`MediaServerAdapter`, a factory, action-level adapter resolution, mocks, and a thin `PlexAdapter`,
but it does not yet isolate Plex. The generic interface imports Plex and database types; the
adapter delegates to the 2,800-line `lib/plex.ts`; cache state reads global Plex config; auth tokens
are embedded in most request URLs; and actions still understand Plex rating keys, machine IDs,
0-10 ratings, metadata codes, filter helpers, and pagination.

The recommended implementation is an ownership inversion with compatibility projections:

```text
existing CLI / MCP / actions
        -> server-neutral MediaServerAdapter contract
        -> PlexAdapter
        -> private Plex auth, HTTP, cache, wire DTOs, mappers, and endpoint logic

generic results
        -> explicit legacy Plex presenter / saved-query projection
        -> unchanged CLI JSON, MCP schema, SQLite rows, and text output
```

Use native Node.js `fetch`, `URL`, `Headers`, and `AbortSignal`; do not adopt a Plex SDK or add a
JWT library for this refactor. Introduce a private auth strategy/token-provider seam and ship a
static opaque-token strategy. Existing `plex.token` and `--plex-token` values continue to work,
whether the supplied opaque value is a legacy token or a pre-issued Plex JWT, and authentication
moves to the supported `X-Plex-Token` header. Do not add JWT enrollment, PIN authorization,
private-key persistence, refresh storage, or a new public auth command/flag to #119.

**Child issue decision:** one child issue is required for automatic Plex JWT enrollment and refresh
lifecycle. That work has a distinct security model, persistent client/key state, authorization UX,
rate-limit/revocation handling, and non-idempotent retry policy. Create it as a dependency-aware
follow-up, not as a blocker for the ownership boundary or opaque supplied-JWT support. No child
issues are required for the core type/transport/cache/action phases; they should be dependency-
ordered commits/tasks in one PR because an intermediate merged state would leave the boundary
porous. A future Sonic Analysis operation/provider discovery may be a separate enhancement, but
Issue #119 only needs truthful `server-dependent` feature metadata and must not claim an executable
Sonic
feature.

The release gates are strict: no command/config/completion change, no database migration, no MCP or
JSON schema change, no rating-scale drift, no optional-scan behavior change, no token disclosure,
and no permanent compatibility network facade. Delete the old Plex API/cache/filter/pagination
bypass modules after callers migrate, expand import-boundary enforcement, update documentation and
`ROADMAP.md`, and prove the complete behavior with adapter, action, command, MCP, cache, and shell
template tests.

## Implementation Recommendations

### Recommended approach

#### 1. Make the generic contract genuinely server-neutral

Refactor `packages/rfmedia-cli/src/types/media-server.ts` so it imports neither
`types/plex.ts` nor `types/db.ts`. Introduce discriminated domain entities for track, album, and
artist; generic library/playlist/collection types; generic query pages; normalized ratings; feature
descriptors; and typed media-server errors.

Key contract decisions:

- Use `id`, not `ratingKey`, at the generic boundary.
- Represent ratings internally as `null` or a finite normalized value in the closed interval 0-1.
- Keep track-only fields on `MediaTrack`, album-only fields on `MediaAlbum`, and artist-only fields
  on `MediaArtist`; use a discriminated union instead of one optional-field record.
- Remove `machineIdentifier()` from the generic library capability. Plex obtains and caches it
  internally when constructing collection/playlist source URIs.
- Change collection membership to `addItems(collectionId, itemIds)`. The caller never passes a
  Plex machine ID or rating keys.
- Move file-path extraction/existence checking out of the adapter. It is local filesystem/persistence
  orchestration, not media-server behavior.
- Preserve the current scan and rating-update result forms; query/CRUD continues to throw.

Add `MediaServerFeatures` alongside coarse method capabilities. It should describe readable/
writable ratings and native scale, smart playlist/collection support, path-scoped scan behavior,
filter pushdown, and Sonic Analysis as `server-dependent`. A feature descriptor must not claim a
callable method that does not exist.

#### 2. Build a private, cohesive Plex implementation below `PlexAdapter`

Create private modules under `packages/rfmedia-cli/src/lib/adapters/plex/`:

- `types.ts` for Plex connection, wire DTO, metadata-code, cache-category, and credential types;
- `auth.ts` for an opaque token strategy/provider and future auth lifecycle seam;
- `client.ts` for the only direct Plex HTTP request boundary;
- `cache.ts` for isolated TTL state and invalidation;
- `mappers.ts` for wire-to-domain conversion and native/normalized ratings.

`plex-adapter.ts` remains the public concrete adapter and composes those modules. It must no longer
import endpoint functions from `lib/plex.ts`. The dependency direction must be testable and one-way:

```text
actions -> MediaServerAdapter -> PlexAdapter -> adapters/plex/*
```

The client should preserve the current 30-second timeout and 100 ms live-request pacing initially,
request JSON, construct paths/queries with `URL` and `URLSearchParams`, and inject auth centrally.
Send `X-Plex-Token` as a header rather than in URLs. Add stable product/version headers and a stable
client identifier only when their lifecycle and compatibility are explicitly defined; do not
silently require a new persisted identity in the same refactor. Do not opt into a newer PMS API
version header because that could exclude older servers.

#### 3. Add the JWT migration seam without creating a public enrollment feature

Treat `plex.token`/`--plex-token` as an opaque credential. A supplied legacy token or pre-issued JWT
uses the same static strategy and `X-Plex-Token` header. Do not decode an unverified JWT to choose
behavior, silently overwrite the configured token source, or invent refresh state.

The internal strategy interface should support a future `handleUnauthorized`/refresh decision, but
the static production strategy does not retry. The request layer may allow at most one strategy-
authorized retry for a future refresh implementation. Mutations are never automatically replayed
unless the first request is proven not to have applied. Typed errors should distinguish 401, 403,
404, 429, timeout/network, malformed response, and other HTTP failure, while the CLI formatter/
compatibility edge preserves familiar current wording.

Create one child issue with at least this scope:

- stable client identifier policy;
- Ed25519/JWK generation and private-key storage;
- PIN/account authorization UX;
- token acquisition, seven-day expiry, nonce/refresh, revocation, and persistence;
- `429`/`Retry-After`, clock skew, cancellation, and bounded recovery;
- safe retry rules for reads versus ambiguous mutations;
- configuration migration, secret redaction, and recovery documentation;
- all-shell completion updates only if that child introduces a public command or flag.

#### 4. Put cache ownership inside the adapter lifecycle

Replace the global `lib/plex-cache.ts` store with an adapter-private cache whose enablement and TTL
are captured from the existing `plex.cache` config at construction. Keep caching opt-in and preserve
the current 300-second default when enabled without a TTL.

Recommended cache rules:

- isolate cache instances by adapter lifecycle and normalized server URL;
- do not place tokens, JWTs, authorization headers, or full credential-bearing URLs in keys/logs;
- inject a clock for deterministic expiry tests;
- cache only the same categories currently cached unless tests justify expansion: server identity,
  libraries, playlists, and collection lists;
- skip pacing delay on cache hits;
- invalidate playlist entries after successful create/add/delete;
- invalidate collection entries after successful create/add/delete;
- never cache 401/403/404/429/network/timeout/malformed responses;
- preserve ordering, totals, filter semantics, and the current visible result on a hit.

Per-instance isolation is preferable to a process-global store because it prevents cross-test,
cross-server, and cross-credential leakage. If the implementation later needs shared reuse, add an
explicit cache owner keyed by non-secret authorization identity rather than silently returning one
user's authorization-sensitive response to another credential on the same URL.

#### 5. Generalize reusable domain helpers, not Plex transport concepts

Create provider-neutral helpers where the behavior is truly domain-level:

- `types/media-filters.ts` for the current music filter AST;
- `lib/media-filter-evaluator.ts` for residual/client-side evaluation;
- `lib/pagination.ts` for forward-progress calculation;
- `lib/media-file-paths.ts` for local path extraction/existence checking.

Keep Plex query-parameter names, numeric metadata types, returned Plex keys, source URI formation,
and filter pushdown compilation private to the adapter. Retain `plexFilters` and deprecated Plex
type aliases only as compatibility inputs/exports. Do not generalize by renaming user configuration
or persisting generic values into old Plex columns.

#### 6. Preserve outward behavior through explicit compatibility projections

Actions should consume generic entities, pages, IDs, and normalized ratings. At deliberately
Plex-branded edges, map those values back to the established contract:

- `commands/plex.ts` retains every command, option, alias, help term, text table, JSON discriminator,
  JSON field, and exit behavior;
- MCP retains `rfmedia.plex.query` and its existing schema/output fields;
- saved query storage retains `plex_queries`, `plex_query_results`, `rating_key`, `user_rating`, and
  the existing 0-10 value interpretation;
- exported Plex types may remain deprecated aliases if `types/index.ts` is a public programmatic API;
- existing `--plex-*`, `plex:`, and `plexFilters:` inputs retain precedence and meaning.

Put mapping logic in one clearly named compatibility presenter/repository boundary rather than
scattering `rating * 10`, `id -> ratingKey`, and legacy field assembly across actions. Add round-trip
tests for unrated, zero, half-star, full-star, and out-of-range cases.

#### 7. Remove the bypass and enforce the completed architecture

After callers and behavior tests migrate, delete:

- `packages/rfmedia-cli/src/lib/plex.ts`;
- `packages/rfmedia-cli/src/lib/plex-cache.ts`;
- `packages/rfmedia-cli/src/lib/plex-filter-evaluator.ts`;
- `packages/rfmedia-cli/src/lib/plex-pagination.ts`.

Do not leave `PlexAdapter` calling deprecated wrappers. A temporary compatibility facade is allowed
only during implementation and must contain no network/cache behavior in the final PR.

Expand `scripts/check-direct-plex-imports.mjs` beyond thirteen paths and one exact import string.
Check all actions, MCP modules, generic types, and generic helpers for imports of legacy Plex API/
cache/filter/pagination modules and adapter-private Plex modules. Use a narrow allowlist for the
Plex adapter and explicit compatibility presenter. Wire the check into normal rfmedia validation/CI
so the boundary cannot regress silently.

### Technology recommendations

| Concern        | Recommendation                                                                      | Rationale                                                                           |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| HTTP           | Node 22 native `fetch`, `URL`, `URLSearchParams`, `Headers`, composed abort signals | Existing stack is sufficient; avoids SDK semantic drift                             |
| Plex SDK       | Add none                                                                            | No official TypeScript SDK; a third-party transport migration increases parity risk |
| JWT/JOSE       | Add no dependency in #119                                                           | Opaque supplied JWT needs no parsing; enrollment/refresh belongs to the child issue |
| Validation     | Narrow runtime guards/mappers for consumed response fields                          | Prevent malformed Plex data from becoming false empty success                       |
| Errors         | Typed `MediaServerError` internally, compatibility formatter externally             | Enables future adapters without breaking current wording                            |
| Ratings        | Normalized 0-1 or `null` internally; Plex 0-10 only in mapper/projection            | Removes backend scale leakage while preserving outputs/storage                      |
| Cache          | Adapter-private TTL cache with injected clock                                       | Deterministic, isolated, secret-free behavior                                       |
| Tests          | Vitest with injected transport/cache/clock; command and MCP compatibility fixtures  | Avoids pervasive global-fetch mocks and proves public behavior                      |
| Persistence    | No schema migration                                                                 | Existing Plex saved queries remain compatible                                       |
| CLI/completion | No candidate changes                                                                | Internal refactor adds no public command, argument, or option                       |

### Phasing

#### Phase 0 — Capture the compatibility baseline

- Record current generated help for every `rfmedia plex` leaf command.
- Capture representative text and machine output fixtures, exit statuses, and error messages.
- Run and preserve current adapter/action/command/MCP/cache/completion tests.
- Inventory every production import of Plex modules/types and every `fetch` in `lib/plex.ts`.
- Create the JWT enrollment/refresh child issue with the explicit security scope above.

This phase must precede contract changes; otherwise “backward compatible” is asserted rather than
measured.

#### Phase 1 — Introduce generic domain types and compatibility mapping

- Add generic entities/pages/features/errors and provider-neutral filter/pagination/path helpers.
- Add explicit generic-to-legacy Plex projection functions and round-trip tests.
- Keep deprecated type aliases and SQLite schema intact.
- Update generic mocks/fixtures before changing production actions.

#### Phase 2 — Build the private Plex implementation

- Add private auth/client/cache/types/mappers and unit tests.
- Move one cohesive capability family at a time behind the new client: server/libraries/query,
  scans/ratings, playlists, then collections.
- Preserve endpoint behavior before considering provider discovery or API-version modernization.
- Move tokens to headers and prove secret-free URLs, logs, errors, snapshots, and cache keys.

#### Phase 3 — Migrate consumers and delete legacy behavior

- Migrate Plex query/copy/playlist/collection/sync and shared playlist actions to generic contracts.
- Hide machine identifier, metadata codes, rating conversion, and native pagination inside the
  adapter.
- Update MCP and persistence edges through the compatibility projections.
- Delete old Plex API/cache/filter/pagination modules once import inventory is zero.

#### Phase 4 — Enforce, validate, document, and close

- Broaden and wire the import-boundary check into validation.
- Run focused tests after each capability family, then full typecheck/build/test/coverage.
- Run exact CLI/MCP/output/error/completion compatibility fixtures and `git diff --check`.
- Update adapter/config/cache docs, README references, and `ROADMAP.md` with the final PR link.
- Run `graphify update .` after code changes as required by repository guidance, resolving the
  current absence of `graphify-out/graph.json` before staging.

These are implementation phases/commits in one PR, not child issues. The final merge must not leave
two callable Plex network paths.

### Quick wins

Quick wins are early risk reducers, not permission to merge a partial boundary:

1. Move token placement from query strings to one tested header-injection helper.
2. Add secret-leak assertions covering debug logs, thrown errors, cache keys, and serialized plans.
3. Extract an injected transport and clock so subsequent migration tests are deterministic.
4. Add generic `id`/normalized-rating mappers with compatibility round-trip fixtures.
5. Remove machine identifier from the public collection capability and make the adapter fetch it.
6. Expand the import checker before migration, using an allowlist that shrinks as files move.
7. Snapshot shell template output and assert no candidate changes for this issue.

## Improvement Ideas

These ideas should not expand #119 unless they are necessary to prove compatibility:

1. **Provider discovery and API negotiation:** Follow `/media/providers` returned keys and add an
   older-PMS fallback in a separate compatibility enhancement. Do not silently opt into an API
   version with a higher server minimum now.
2. **Automatic JWT enrollment/refresh:** Implement the required child issue after the auth seam and
   threat model exist. Consider `jose` then rather than hand-implementing JOSE.
3. **Runtime Sonic capability probe:** Add only with a consumer and Plex Pass/server fixtures. Until
   then, `server-dependent` is more truthful than an unconditional flag.
4. **Generic persistence v2:** Add `server_type`, generic item IDs, and normalized ratings only when
   a second adapter creates concrete storage requirements. Version/migrate explicitly.
5. **Generated shell completions:** Derive Bash/Zsh/Fish candidates from Commander metadata to reduce
   drift in a dedicated tooling change; do not mix it with the adapter refactor.
6. **Uniform structured error envelopes:** The CLI has typed error formatters, but Plex commands
   currently mix logged failures and thrown errors. Standardize only as a separately reviewed UX
   change with machine-schema versioning.
7. **Contract-test kit for future adapters:** Extract generic capability conformance tests after
   Plex passes them. Use them to guide OpenSubsonic/Navidrome rather than designing more speculative
   generic fields now.
8. **Cache observability:** Add debug-only hit/miss/invalidation counters without tokens or stable
   output changes. Avoid normal-mode cache noise.
9. **Request metrics and cancellation budget:** Measure real Plex latency/pacing before changing the
   100 ms policy, and adopt one overall cancellation budget if nested timeouts prove confusing.
10. **Public TypeScript deprecation policy:** Document whether `types/index.ts` is semver-stable and
    set a major-version removal window for Plex aliases if external consumers exist.

## Risk Assessment

| Risk                                                                        | Likelihood | Impact   | Mitigation                                                                               | Release evidence                                                 |
| --------------------------------------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| CLI/config/output behavior drifts during generic migration                  | High       | Critical | Baseline fixtures and explicit compatibility presenters                                  | All command/help/text/machine fixtures and precedence tests pass |
| Generic type conversion loses entity fields                                 | Medium     | High     | Discriminated unions and mapper fixtures for every kind                                  | Track/album/artist round-trip and collection-item tests          |
| 0-1/0-10/1-5/POPM conversion corrupts ratings                               | High       | Critical | One mapping boundary and exhaustive scale tests                                          | Unrated, zero, half-step, full-scale, invalid-value tests        |
| Token/JWT leaks through URLs, logs, errors, snapshots, plans, or cache keys | High today | Critical | Header-only auth, centralized redaction, negative-string tests                           | No credential material in captured request URLs or artifacts     |
| Automatic retry duplicates a mutation                                       | Medium     | Critical | Static strategy has no retry; future refresh retry is bounded and method-aware           | Mutation auth-failure tests prove one request only               |
| Cache returns stale or cross-credential data                                | Medium     | High     | Per-adapter instances, secret-free scoped keys, complete invalidation                    | TTL/isolation/invalidation tests with two servers/credentials    |
| Optional scan becomes fatal or broadens scope                               | Medium     | High     | Preserve optional resolver and mapped-path fallback tests                                | Copy/delete/sync/watch/queue scan regression tests               |
| Private/LAN Plex URLs are rejected as SSRF                                  | Medium     | High     | Keep current CLI format validation; enforce stricter policy only at exposed MCP boundary | Localhost/private URL config tests remain valid                  |
| Pagination skips, duplicates, or loops                                      | Medium     | High     | Response-driven `returned` metadata and zero-progress guard                              | Multi-page, short-page, missing-total, zero-progress fixtures    |
| Older PMS breaks due to modern API assumptions                              | Medium     | High     | Preserve current endpoints and historical API-version behavior                           | Existing endpoint fixtures plus old-shape tolerant mapper tests  |
| Error wording/exit behavior breaks automation                               | Medium     | High     | Typed internal errors with compatibility formatter; snapshot exit status                 | 401/404/network/partial failure command tests                    |
| Permanent `lib/plex.ts` facade preserves a bypass                           | Medium     | High     | Delete old network modules and enforce imports in CI                                     | Zero forbidden production imports; only one fetch boundary       |
| Large refactor creates an unreviewable diff                                 | High       | Medium   | Dependency-ordered phases/commits, capability-by-capability tests                        | Review maps each commit to a phase and compatibility gate        |
| MCP or saved queries change despite CLI tests                               | Medium     | Critical | Dedicated projections and no schema migration                                            | MCP schema snapshots and existing DB fixture compatibility       |
| Shell templates drift needlessly                                            | Low        | Medium   | No completion edits; run three-shell parity tests                                        | Generated candidate sets unchanged                               |
| Sonic flag overpromises unavailable Plex Pass behavior                      | Medium     | Medium   | Use `server-dependent`, no executable capability claim                                   | Feature descriptor test and accurate docs                        |
| Boundary checker misses alternate import paths                              | High today | Medium   | Layer-wide scan/resolver or AST-aware rule with narrow allowlist                         | Negative fixtures for forbidden import variants                  |

### Integration risks

The highest integration risk is not the HTTP client; it is the compatibility perimeter. Plex types
currently flow through actions, commands, MCP adapters, mocks, saved-query rows, filter evaluation,
rating sync, and collection logic. Migrate from the center outward: define generic contracts and
legacy projections first, implement the adapter second, then switch consumers. Do not rename
SQLite tables/columns or change MCP/JSON fields to make internal types look cleaner. Validate the
MCP and database edges independently of CLI tests.

The adapter factory currently owns Plex config precedence and optional scan semantics. Provider
registration can move parsing behind a Plex builder, but existing `--plex-*` overrides must still
win and required/optional errors must remain distinguishable. Config resolution, command parsing,
and auth strategy construction need separate tests so a connection refactor cannot silently alter
scan gating.

### Performance risks

Moving all calls through one client can accidentally double-apply the 100 ms delay, create nested
30-second timeouts, serialize previously parallel work, or cache filtered pages incorrectly. Apply
pacing once per live request, skip it on cache hits, compose rather than stack cancellation, and
preserve existing worker/pagination behavior. Do not broaden cache coverage until query/filter
semantics are proven. Benchmarking is useful for regression detection, but correctness gates must
not depend on unstable timing thresholds.

Large playlist/collection item URIs remain a known constraint. Preserve current playlist warnings
and collection batching/HTTP 400 one-by-one fallback rather than claiming arbitrary safe batching.
Do not auto-retry ambiguous large mutations after authentication or network failure.

### Security risks

The current dominant risk is token disclosure because most Plex calls put `X-Plex-Token` in the
URL. Central header injection is a required #119 hardening, backed by negative tests for URLs,
errors, debug output, cache keys, plans, and snapshots. Continue recursive config redaction and
ensure future fields such as JWT, private key, PIN, nonce, refresh token, or authorization header
are included by semantic redaction rather than one exact field name.

Do not replace the current CLI URL-format check with the public-only `isSecurePlexUrl` behavior:
local/private Plex servers are the expected use case. Instead, preserve the local trusted-user CLI
policy and enforce stricter destination policy for network-exposed/MCP callers at their boundary.
Always resolve adapter endpoint paths relative to the configured base URL and encode user-controlled
IDs/paths in the correct path/query position.

Automatic JWT enrollment/refresh is deliberately separated because it introduces persistent
private-key authority and a new attack surface. #119 must not decode unverified JWTs, persist tokens,
invent a client identity, or expose new auth arguments. The static opaque-token path plus a private
strategy seam is the safe migration-ready result.

## Alternative Approaches

| Approach                                                                       | Pros                                                                                          | Cons                                                                                                    | Effort            | Recommendation                                                                |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| **A. Ownership inversion with generic contract and compatibility projections** | Completes #119, enables future adapters, preserves UX/storage, centralizes security and cache | Large cross-cutting change requiring disciplined projections/tests                                      | High              | **Recommended**; implement in phased commits within one PR                    |
| B. Move `lib/plex.ts` under `adapters/plex/` with minimal edits                | Fast, improves file locality, low immediate regression risk                                   | Generic contract still leaks Plex; adapter remains nominal; future adapters mimic Plex                  | Low-Medium        | Reject as final state; may be a temporary mechanical step only                |
| C. Keep permanent `lib/plex.ts` compatibility facade behind adapter            | Reduces one-PR deletion pressure and preserves internal imports                               | Leaves a callable bypass and two ownership surfaces; fails isolation acceptance                         | Medium            | Reject unless facade is pure projection and removed before merge              |
| D. Adopt a third-party Plex SDK/generated client                               | Less handwritten endpoint code; possible broader API coverage                                 | No official TS SDK; changes transport/error/pagination behavior; adds dependency risk                   | High              | Reject for #119; reconsider only through a focused spike                      |
| E. Big-bang generic CLI/config/database rename                                 | Visually consistent provider-neutral product                                                  | Explicitly breaks `rfmedia plex`, config, JSON/MCP, saved queries, completions                          | Very High         | Reject; incompatible with issue requirements                                  |
| F. Merge type, transport, and action migrations as separate PRs                | Smaller reviews and easier per-PR rollback                                                    | Intermediate branches expose mismatched contracts or two API paths; repeated compatibility churn        | High coordination | Use phased commits/tasks, not separately merged child issues                  |
| G. Implement full JWT enrollment/refresh inside #119                           | One nominally complete auth story                                                             | Unspecified UX/security/persistence, requires key lifecycle and safe retry design, expands public scope | Very High         | Split to the required security child issue                                    |
| H. Leave generic ratings on Plex 0-10 scale                                    | Minimal conversion and output changes                                                         | Forces every adapter to imitate Plex and leaks backend semantics into sync                              | Low               | Reject; normalize internally and project 0-10 at compatibility edges          |
| I. Process-global cache keyed only by server URL                               | Maximizes reuse within a process and resembles current behavior                               | Cross-credential leakage/test contamination; hidden global config dependency                            | Low               | Reject; prefer explicit adapter lifecycle ownership                           |
| J. Add provider discovery/API version negotiation now                          | Aligns with modern official PMS guidance                                                      | Combines endpoint modernization with ownership refactor and risks old-server regressions                | High              | Defer; preserve endpoints first, add a separately tested fallback layer later |

## Task Breakdown Preview

| Phase | Task group                                                 | Key files/areas                                                                      | Dependencies                           | Complexity  |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- | ----------- |
| 0     | Capture CLI/MCP/DB/error/completion baselines              | `commands/plex.test.ts`, MCP tests, DB fixtures, shell template specs                | None                                   | Medium      |
| 0     | Create JWT lifecycle child issue                           | GitHub issue form and parent linkage                                                 | Confirm child scope from research      | Low         |
| 1     | Add generic media entities/pages/features/errors           | `types/media-server.ts`, `types/index.ts`                                            | Baseline fixtures                      | High        |
| 1     | Add compatibility presenters and rating/ID projections     | command/MCP/persistence compatibility modules and tests                              | Generic entities                       | High        |
| 1     | Generalize filters, pagination, and local path extraction  | new media filter/pagination/path helpers                                             | Generic types                          | Medium-High |
| 2     | Add private Plex auth/client/types                         | `lib/adapters/plex/{auth,client,types}.ts` and tests                                 | Generic errors; compatibility baseline | High        |
| 2     | Add private cache and mappers                              | `lib/adapters/plex/{cache,mappers}.ts` and tests                                     | Generic types; Plex private types      | High        |
| 2     | Implement library/query/scan/rating capabilities           | `plex-adapter.ts` plus private client/mappers                                        | Private Plex foundation                | High        |
| 2     | Implement playlist/collection capabilities                 | adapter/private modules                                                              | Identity cache; query/library behavior | High        |
| 3     | Migrate actions and mocks to generic contract              | Plex actions, shared playlist, adapter mocks/fixtures                                | Complete adapter capabilities          | Very High   |
| 3     | Migrate commands/MCP/persistence edges through projections | `commands/plex.ts`, MCP modules, DB action boundaries                                | Action migration; presenters           | High        |
| 3     | Delete old Plex API/cache/filter/pagination modules        | `lib/plex*.ts` and migrated tests                                                    | Zero production callers                | Medium      |
| 4     | Expand and wire architecture check                         | `scripts/check-direct-plex-imports.mjs`, package/CI scripts                          | Final dependency layout                | Medium      |
| 4     | Compatibility/full validation                              | typecheck, build, focused/full tests, coverage, help/output/exit/completion fixtures | All implementation tasks               | High        |
| 4     | Docs, graph, ROADMAP, PR/review/CI                         | adapter/config/cache docs, README, `ROADMAP.md`, graphify output                     | Green implementation                   | Medium      |

### Dependency notes

- Generic contracts and compatibility projections must land together before action migration.
- The Plex private client/auth/cache/mappers can be developed in parallel after generic error/
  entity contracts stabilize, but capability integration depends on all four.
- Commands, MCP, and persistence can migrate in parallel only after actions return stable generic
  results and projection contracts exist.
- Deletion and broad import enforcement are final implementation gates, not cleanup that can be
  postponed beyond the PR.
- Documentation and `ROADMAP.md` must describe the final behavior, so they follow the validated
  implementation. Completion templates are validation-only unless a public auth surface is later
  approved in the child issue.

## Key Decisions Needed

1. **Approve the JWT scope split.** #119 ships static opaque-token/pre-issued-JWT support and an
   internal auth strategy seam; one child issue owns enrollment, key persistence, refresh, and any
   new user-facing auth workflow.
2. **Approve normalized ratings.** Use 0-1 or `null` in the generic contract, with exact 0-10
   projections for current Plex JSON/MCP/database compatibility and 1-5 display at the CLI.
3. **Confirm TypeScript export compatibility.** If `types/index.ts` is public, retain deprecated
   `Plex*` aliases plus compile-only compatibility tests for at least one release.
4. **Approve deletion of `lib/plex.ts` and related bypass modules.** A permanent network facade is
   incompatible with the requested isolation.
5. **Approve per-adapter cache lifecycle.** It sacrifices implicit global reuse for deterministic
   isolation and prevents cross-credential cache risk.
6. **Approve no API-version/provider-discovery modernization in #119.** Preserve known endpoints and
   old-PMS tolerance; modern discovery is a separate follow-up.
7. **Confirm no public Sonic workflow.** Report `server-dependent` metadata only; do not add a
   command, probe, or unconditional flag.
8. **Confirm the local URL trust boundary.** Retain HTTP/private-network Plex URLs for the local CLI;
   enforce any SSRF restriction at network-exposed/MCP entry points.
9. **Confirm completion policy.** No Bash/Zsh/Fish candidate changes because there is no CLI change;
   passing parity tests is the required evidence.
10. **Resolve graphify expectations for the worktree.** Repository guidance requires an update after
    code changes, but the graph is currently absent; decide whether it should be generated/staged.

## Open Questions

1. Is accepting a pre-issued JWT through the existing token field sufficient evidence for the
   parent issue's “JWT migration handling,” once automatic lifecycle work is linked as a child?
2. What exact external compatibility promise applies to exported `Plex*` TypeScript types versus
   runtime CLI/MCP/JSON behavior?
3. Should internal normalized ratings use `number` plus runtime validation, or a branded value type
   to prevent accidental unvalidated construction?
4. Should cache instances be per adapter invocation or shared by an explicitly scoped factory
   cache for one credential identity during a long-running MCP process?
5. Which existing Plex error messages are byte-for-byte contracts, and which may be preserved
   semantically through a typed formatter? Baseline fixtures should answer before implementation.
6. Does moving tokens from query parameters to headers affect any old Plex server or test fixture
   supported by this repository? Official guidance supports headers, but compatibility tests should
   cover the project's minimum server expectations.
7. Should commands retain `metadataType` and `ratingKey` indefinitely in machine output? The safe
   #119 answer is yes; a future versioned generic schema can deprecate them explicitly.
8. Does the existing MCP caller require stricter URL validation than the local CLI? If so, ensure the
   factory does not collapse both trust contexts into one validator.
9. Are current playlist batches known to replace rather than append on all supported PMS versions?
   Preserve warning/behavior now, but capture a real fixture before any later optimization.
10. Should the boundary checker use an AST/linter rule or a more robust repository script? The
    acceptance requirement is coverage of alternate relative paths/re-exports, not a specific tool.
11. Can `lib/plex.ts` be deleted without breaking undocumented deep imports from the built package?
    Search package exports and downstream usage; if compatibility is required, keep only deprecated
    type/pure projection exports, never a second network path.
12. Should provider discovery, API version negotiation, and runtime Sonic probing share one future
    Plex compatibility epic or remain independent enhancements?
