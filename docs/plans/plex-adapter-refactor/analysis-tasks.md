# Task Structure Analysis: Plex Adapter Refactor

## Executive Summary

Issue #119 is an ownership inversion, not a thin-adapter cleanup. The current 124-line
`PlexAdapter` delegates to a 2,874-line `lib/plex.ts`, while the supposedly generic
`MediaServerAdapter` imports Plex and database types. The safest implementation shape is therefore
to establish generic contracts and characterization tests first, build private Plex foundations and
endpoint families second, migrate consumers third, and only then delete the four legacy bypass
modules and tighten the architecture guard.

The plan should prefer narrow tasks with exclusive file ownership. Most implementation tasks can
own one production file and its test; compatibility-heavy action tasks can own an action, its test,
and its adapter mock. The only intentional convergence points are `types/media-server.ts`,
`lib/adapters/plex-adapter.ts`, `lib/adapters/index.ts`, and the final architecture script. Those
files should be changed by one task at a time and never shared within a parallel batch.

Private endpoint-family modules under `lib/adapters/plex/` are recommended even though the public
class remains `PlexAdapter`. They keep the class as the sole public Plex implementation boundary
without recreating a monolith, and they allow query/scan, playlist, collection, and metadata parity
work to proceed independently after the common client, cache, wire types, and mappers are stable.

## Recommended Phase Structure

### Phase 0: Compatibility Baseline and GitHub Scope

Capture observable behavior before moving types or implementations. The JWT enrollment/refresh
follow-up is already created and linked beneath #119 as child issue #251. Treat that item as
complete external tracking, not implementation work in this plan; #119 retains only the static
opaque token-provider seam.

| ID  | Task                                                                                                                                                         | Owned files                                                                       | Depends on | Validation                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| B1  | Add origin-provenance and factory characterization tests, including zero fetches for a cross-origin URL-only override and compatibility for paired overrides | `src/lib/adapters/plex-adapter.test.ts`                                           | None       | Focused adapter/factory test initially demonstrates the unsafe case, then remains the acceptance harness |
| B2  | Freeze CLI and MCP compatibility for help/options, machine envelopes, schema fields, and override forwarding                                                 | `src/commands/plex.test.ts`, `src/mcp/schema.spec.ts`, `src/mcp/adapters.spec.ts` | None       | Focused command and MCP specs pass before and after migration                                            |
| B3  | Record the static completion candidate baseline; add assertions only if current parity coverage does not already freeze all Plex candidates                  | `src/lib/shell-completions/templates.spec.ts`                                     | None       | Bash, Zsh, and Fish candidate parity test passes without initializing an adapter                         |

Do not edit the Bash, Zsh, or Fish templates in B3. The feature spec resolves that the public CLI
surface is unchanged; the task is validation, not regeneration.

### Phase 1: Generic Foundation

Create provider-neutral contracts and pure helpers while retaining temporary Plex aliases so the
repository stays typecheckable during consumer migration.

| ID  | Task                                                                                                                                                                                            | Owned files                                                                                                                                           | Depends on | Validation                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| G1  | Replace Plex-shaped adapter entities, pages, operations, features, and errors with server-neutral contracts; add a compile/runtime contract test using a fake adapter that imports no Plex type | `src/types/media-server.ts`, `src/types/media-server.test.ts`                                                                                         | B1-B3      | Focused test and package typecheck; static search confirms the test and contract have no Plex/DB imports             |
| G2  | Add the generic filter AST and guards, then make Plex filter names deliberate deprecated aliases                                                                                                | `src/types/media-filters.ts`, `src/types/media-filters.test.ts`, `src/types/plex-filters.ts`                                                          | G1         | Generic and existing Plex filter guard tests pass; package typecheck                                                 |
| G3  | Add provider-neutral residual filter evaluation with current pushdown/residual semantics                                                                                                        | `src/lib/media-filter-evaluator.ts`, `src/lib/media-filter-evaluator.test.ts`                                                                         | G1, G2     | Ported evaluator cases cover nested groups, smart rules, server context, query variants, and rating scale boundaries |
| G4  | Generalize forward-progress pagination                                                                                                                                                          | `src/lib/pagination.ts`, `src/lib/pagination.test.ts`                                                                                                 | G1         | Ported pagination cases prove response-count advancement and zero-progress termination                               |
| G5  | Move file-path extraction/existence checks out of the server capability                                                                                                                         | `src/lib/media-file-paths.ts`, `src/lib/media-file-paths.test.ts`, `src/lib/adapters/action-helpers.ts`                                               | G1         | Focused valid/missing-path tests; adapter contract no longer includes local filesystem work                          |
| G6  | Define deliberate Plex compatibility projections and exports without allowing production generic code to depend on them                                                                         | `src/types/plex.ts`, `src/types/index.ts`, `src/types/plex-filters.test.ts`                                                                           | G1, G2     | Typecheck plus exact ID/rating/media-type alias and guard tests                                                      |
| G7  | Convert shared adapter mocks and fixtures to the generic contract                                                                                                                               | `src/actions/test-helpers/media-server-adapter-mocks.ts`, `src/actions/test-helpers/media-server-fixtures.ts`, `src/actions/playlist-adapter.test.ts` | G1, G5, G6 | Focused adapter integration test and typecheck                                                                       |

G3, G4, and G5 can run in parallel after G1/G2. G6 should follow the final contract vocabulary so
compatibility aliases do not become accidental source-of-truth types. G7 follows G1 and should be
complete before action migration begins.

### Phase 2: Private Plex Core

Build the private implementation in layers. No phase-2 module may import from an action, command,
MCP module, or database module.

| ID  | Task                                                                                                                                                                                                                       | Owned files                                                                 | Depends on | Validation                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Add private connection, request, and consumed-wire DTO types; keep the token opaque                                                                                                                                        | `src/lib/adapters/plex/types.ts`, `src/lib/adapters/plex/types.test.ts`     | G1, G6     | Runtime guards reject malformed consumed fields; typecheck                                                                                                          |
| P2  | Add the static async token-provider seam                                                                                                                                                                                   | `src/lib/adapters/plex/auth.ts`, `src/lib/adapters/plex/auth.test.ts`       | P1         | Legacy-looking token and JWT-looking token are returned unchanged; auth recovery always fails without retry                                                         |
| P3  | Add the only authenticated Plex transport with relative paths, header auth, stable client headers, JSON accept, timeout/cancellation, live pacing, bounded sanitized errors, typed status mapping, and `redirect: "error"` | `src/lib/adapters/plex/client.ts`, `src/lib/adapters/plex/client.test.ts`   | G1, P1, P2 | Focused transport tests prove no token in URL/error, header injection, redirect rejection, abort behavior, pacing, status mapping, and no automatic mutation replay |
| P4  | Add a deterministic per-adapter TTL cache with injected clock and scoped invalidation                                                                                                                                      | `src/lib/adapters/plex/cache.ts`, `src/lib/adapters/plex/cache.test.ts`     | P1         | Disabled/default/custom TTL, expiry, instance isolation, secret-free keys, and prefix invalidation cases pass                                                       |
| P5  | Add Plex wire-to-domain, domain-to-wire, media-code, rating, and persistence compatibility mappers                                                                                                                         | `src/lib/adapters/plex/mappers.ts`, `src/lib/adapters/plex/mappers.test.ts` | G1, G6, P1 | Exact `0..1` to `0..10` to `0..5` round trips, null/unrated, invalid values, IDs, and entity mapping cases pass                                                     |

P3, P4, and P5 can run in parallel once P1/P2 are stable because their file ownership does not
overlap. The transport, not endpoint modules, owns authentication, redirects, timeouts, pacing, and
error-body handling. The cache must be constructed per adapter rather than reading mutable global
loaded config.

### Phase 3: Plex Endpoint Families and Adapter Composition

Move endpoint behavior out of `lib/plex.ts` by capability family. Each family receives the shared
transport/cache/mappers through construction; it must not call global fetch or loaded-config
helpers. Endpoint modules are private implementation details, not an alternative public adapter.

| ID  | Task                                                                                                                                                                         | Owned files                                                                                              | Depends on   | Validation                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Move query, album-track, library, machine-ID, and scan behavior, including filter pushdown, page metadata, path mapping, full-scan fallback, and machine-ID instance caching | `src/lib/adapters/plex/query-library.ts`, `src/lib/adapters/plex/query-library.test.ts`                  | G2-G5, P3-P5 | Port relevant `plex.test.ts` cases; cover malformed pages, no-progress pagination, scan result semantics, and cache-hit equivalence                                                                               |
| E2  | Move playlist list/find/get/create/add/delete behavior and batching                                                                                                          | `src/lib/adapters/plex/playlists.ts`, `src/lib/adapters/plex/playlists.test.ts`                          | P3-P5        | Port playlist cases, including smart option, URI encoding, batches, partial failures, and successful mutation invalidation                                                                                        |
| E3  | Move collection list/get/items/find/create/add/delete behavior and one-by-one fallback                                                                                       | `src/lib/adapters/plex/collections.ts`, `src/lib/adapters/plex/collections.test.ts`                      | P3-P5        | Port `plex-collection.test.ts` and collection portions of `plex.test.ts`; prove type mapping, fallback, and invalidation                                                                                          |
| E4  | Move normalized rating updates and result-object behavior                                                                                                                    | `src/lib/adapters/plex/metadata.ts`, `src/lib/adapters/plex/metadata.test.ts`                            | P3, P5       | Port rating cases, validate before request, preserve result-object semantics, and never replay a failed write                                                                                                     |
| E5  | Compose endpoint families into the full `MediaServerAdapter`, expose truthful feature metadata, and implement provenance-aware required/optional factory resolution          | `src/lib/adapters/plex-adapter.ts`, `src/lib/adapters/index.ts`, `src/lib/adapters/plex-adapter.test.ts` | B1, E1-E4    | Full adapter/factory matrix: required/optional, config/CLI precedence, same-origin inheritance, cross-origin rejection with zero requests, paired override, static JWT, features, and config access compatibility |

E1-E4 are a natural parallel batch. E5 is a convergence task and must run alone with respect to
the three owned files. If the endpoint family names change, preserve the same ownership split and
dependency direction.

### Phase 4: Consumer Migration and Compatibility Projection

Migrate actions against the complete adapter. An action owns orchestration only; it must not build
Plex URLs, attach credentials, parse wire payloads, convert Plex-native ratings, or access the
private cache. Plex-branded field names remain only at command, MCP, and SQLite projection edges.

| ID  | Task                                                                                                                 | Owned files                                                                                                            | Depends on     | Validation                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| C1  | Migrate query orchestration, generic filtering, pagination, and saved-query projection                               | `src/actions/plex-query.ts`, `src/actions/plex-query.test.ts`, `src/actions/plex-query-adapter.mock.ts`                | E5, G3, G4, G7 | Track/album/artist, named/default filters, page size, CLI override, DB row, JSON, and error tests pass        |
| C2  | Migrate copy query/result paths and optional scans to generic entities and file-path helper                          | `src/actions/plex-copy.ts`, `src/actions/plex-copy.test.ts`, `src/actions/plex-copy-adapter.mock.ts`                   | E5, G5, G7     | Live/saved queries, path existence, security, dry-run, mapped/full/skip scan, and sync-on-copy cases pass     |
| C3  | Migrate Plex playlist orchestration, query sourcing, and pagination                                                  | `src/actions/plex-playlist.ts`, `src/actions/plex-playlist.test.ts`, `src/actions/plex-playlist-adapter.mock.ts`       | E5, G3, G4, G7 | Export/sync/list/create/add, filter, pagination, default config, batch, and compatibility cases pass          |
| C4  | Migrate collection orchestration, generic media kinds, filter evaluation, pagination, and compatibility presentation | `src/actions/plex-collection.ts`, `src/actions/plex-collection.test.ts`, `src/actions/plex-collection-adapter.mock.ts` | E5, G3, G4, G7 | Create/add/list/show/delete, folder/filter/named-filter, dedupe, path matching, and error cases pass          |
| C5  | Migrate metadata sync to normalized ratings and generic pagination                                                   | `src/actions/plex-sync.ts`, `src/actions/plex-sync.test.ts`, `src/actions/plex-sync-adapter.mock.ts`                   | E5, G4, G7     | Push/pull/bidirectional, null/edge ratings, dry-run, error, pagination, and defaults pass                     |
| C6  | Migrate the shared playlist workflow away from Plex entities                                                         | `src/actions/playlist.ts`, `src/actions/playlist.test.ts`                                                              | E5, G7         | Create/update/source/list/show/delete and adapter-source cases pass                                           |
| C7  | Migrate filter authoring/config typing to generic filter names while retaining the existing YAML shape               | `src/actions/filter.ts`, `src/types/config.ts`                                                                         | G2, G6         | Typecheck plus existing filter/config tests; serialized config remains unchanged                              |
| C8  | Preserve Commander and human/machine compatibility through explicit projections                                      | `src/commands/plex.ts`, `src/commands/plex.test.ts`                                                                    | C1-C6, B2      | Full Plex command test passes; help/options/aliases and `plex-*` output envelopes are unchanged               |
| C9  | Preserve MCP schema and adapter projections while enforcing connection provenance                                    | `src/mcp/schema.ts`, `src/mcp/schema.spec.ts`                                                                          | E5, B2         | Schema snapshots/parse cases remain compatible; no new required fields                                        |
| C10 | Preserve MCP override forwarding and results                                                                         | `src/mcp/adapters.ts`, `src/mcp/adapters.spec.ts`                                                                      | C9, E5         | Adapter specs cover same-origin, rejected URL-only cross-origin, paired override, and unchanged output shapes |

C1-C7 can be scheduled in parallel only where file ownership is disjoint. C8 must follow all
Plex action result shapes; C9/C10 can proceed independently from C8 but must follow the finalized
factory provenance contract. Existing tests that only require compatibility aliases may keep Plex
names, but new production orchestration should use generic names.

### Phase 5: Legacy Deletion and Architecture Enforcement

Delete an old module only after its behavior has a new owner and repository imports reach zero.
Keep deletion tasks separate so a failed audit points to one responsibility.

| ID  | Task                                                                                    | Owned files                                                                  | Depends on           | Validation                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Remove the legacy pagination implementation and its superseded test                     | `src/lib/plex-pagination.ts`, `src/lib/plex-pagination.test.ts`              | G4, C1, C3-C5        | `rg` finds no import; generic pagination tests pass                                                                                                                                        |
| D2  | Remove the legacy filter evaluator and its superseded test                              | `src/lib/plex-filter-evaluator.ts`, `src/lib/plex-filter-evaluator.test.ts`  | G3, C1, C3, C4, C7   | `rg` finds no import; generic filter tests and consumer suites pass                                                                                                                        |
| D3  | Remove the process-global cache and its superseded test                                 | `src/lib/plex-cache.ts`, `src/lib/plex-cache.test.ts`                        | P4, E1-E3            | `rg` finds no import; private cache and mutation invalidation tests pass                                                                                                                   |
| D4  | Remove the legacy Plex network facade and migrate/delete its remaining monolithic tests | `src/lib/plex.ts`, `src/lib/plex.test.ts`, `src/lib/plex-collection.test.ts` | E1-E5, C1-C10, D1-D3 | Every legacy behavior is traceable to a focused replacement test; no production or test import remains                                                                                     |
| D5  | Broaden the dependency-direction audit and wire it into package validation              | `scripts/check-direct-plex-imports.mjs`, `package.json`                      | D1-D4                | Audit scans production layers, permits only `PlexAdapter`/private Plex modules and deliberate compatibility edges, detects a seeded violation during test development, then passes cleanly |

D4 should not mechanically discard tests. Before deleting each case, record its replacement suite;
if a case has no focused equivalent, move it to the relevant endpoint-family test first. D5 should
check prohibited imports and authenticated fetch ownership, not merely the original 13 action
paths.

### Phase 6: Documentation, Roadmap, and Delivery Validation

| ID  | Task                                                                                                                         | Owned files                                                                                                         | Depends on | Validation                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | Update adapter, configuration/auth, and caching documentation                                                                | `docs/features/media-server-adapter.md`, `docs/features/plex-configuration.md`, `docs/features/plex-api-caching.md` | D5         | Markdown lint; docs match static opaque token, provenance, header auth, optional mode, and per-adapter cache behavior                                                              |
| V2  | Update filter/metadata docs and package overview only where implementation changed documented ownership or rating boundaries | `docs/features/plex-filters.md`, `docs/features/plex-metadata-sync.md`, `README.md`                                 | D5         | Markdown lint and link checks available in repository scripts                                                                                                                      |
| V3  | Mark #119 and its PR as shipped and unblock, but do not mark dependent issues complete                                       | `ROADMAP.md`                                                                                                        | D5         | Markdown lint; issue/PR links and sprint/backlog references are consistent                                                                                                         |
| V4  | Run final validation without editing completion templates                                                                    | No owned source files                                                                                               | V1-V3      | Architecture audit, focused/full Vitest, coverage, package/root typecheck, build, three-shell parity, markdown lint, `git diff --check`, dependency audit, and `graphify update .` |

PR publication, local review/fix, CI monitoring, squash merge, branch/worktree removal, and remote
cleanup are root-workflow steps after V4. Child issue #251 remains open for the deferred JWT
lifecycle. These steps should not be delegated to implementation agents that lack the complete
GitHub lifecycle context.

## Task Granularity Recommendations

1. **Pair one implementation with one focused test.** This is the default for every new generic
   or private Plex module. A two-file task is easy to review, validate, and revert.
2. **Allow three files for a compatibility seam.** An action plus its test and dedicated adapter
   mock is a coherent unit. Splitting the mock from its consumer would create avoidable dependency
   churn.
3. **Split by endpoint capability, not arbitrary line ranges.** Query/library/scan, playlists,
   collections, and metadata have distinct behavior and tests. Multiple agents must not edit one
   large `plex-adapter.ts` concurrently.
4. **Keep convergence files single-owner.** `media-server.ts`, `plex-adapter.ts`, `adapters/index.ts`,
   `commands/plex.ts`, `types/index.ts`, and the architecture audit each need one owner in their
   batch.
5. **Treat deletion as behavior migration.** Each old module/test pair is a task with a zero-import
   condition and replacement-test evidence, not a bulk cleanup task.
6. **Keep generated/operational steps out of code tasks.** GitHub child-issue creation, PR work,
   CI monitoring, graph update decisions, and worktree cleanup belong to the orchestration layer.
7. **Avoid speculative public types.** The generic contract should contain only concepts required
   by current actions and the issue's feature metadata. Do not design a second provider in this PR.

## Dependency Analysis

### Critical Path

```text
B1-B3 compatibility baseline
        |
        v
G1 generic contract -> G2 filters -> G3 evaluator
        |                 |
        +-> G4 pagination +-> consumer migrations
        +-> G5 paths      |
        +-> G6 aliases -> G7 fixtures/mocks
        |
        v
P1 private types -> P2 auth -> P3 client
        |                    \
        +-> P4 cache --------+-> E1-E4 endpoint families
        +-> P5 mappers ------/          |
                                      v
                            E5 adapter + factory
                                      |
                                      v
                              C1-C10 consumers
                                      |
                                      v
                              D1-D4 deletions
                                      |
                                      v
                              D5 enforcement
                                      |
                                      v
                             V1-V4 delivery proof
```

### Parallel Batches

| Batch | Parallel tasks | Barrier condition                                                    |
| ----- | -------------- | -------------------------------------------------------------------- |
| 1     | B1, B2, B3     | Compatibility baselines are committed and passing                    |
| 2     | G1             | Generic vocabulary and operation semantics are stable                |
| 3     | G2, G4, G5     | No overlapping files; generic core compiles                          |
| 4     | G3, G6         | Filter contract and compatibility aliases pass                       |
| 5     | G7, P1         | Shared mocks and private Plex DTOs compile independently             |
| 6     | P2, P4, P5     | Private seams are tested; P2 is small and does not overlap P4/P5     |
| 7     | P3             | Security-critical transport passes its focused suite                 |
| 8     | E1, E2, E3, E4 | Each endpoint family passes parity tests with no legacy calls        |
| 9     | E5             | Complete adapter/factory matrix passes                               |
| 10    | C1, C2, C3     | Query/copy/playlist files are disjoint                               |
| 11    | C4, C5, C6     | Collection/sync/shared-playlist files are disjoint                   |
| 12    | C7, C9         | Config/filter typing and MCP schema are disjoint                     |
| 13    | C8, C10        | Command and MCP projection tests pass against stable actions/factory |
| 14    | D1, D2, D3     | Zero imports to each small legacy module                             |
| 15    | D4             | No legacy Plex facade references remain                              |
| 16    | D5             | Architecture check passes and is wired into validation               |
| 17    | V1, V2, V3     | Documentation owners are disjoint                                    |
| 18    | V4             | Full repository validation is green                                  |

The four-agent runtime means each listed batch naturally fits the available three worker slots plus
the orchestrator, except E1-E4. Schedule E1-E3 together and E4 immediately afterward, or let the
orchestrator implement the small metadata family while three workers handle E1-E3.

### High-Risk Dependency Constraints

- Do not migrate ratings before P5 establishes normalized runtime validation and exact projection.
- Do not enable header auth before negative token-leak and redirect tests exist in P3.
- Do not accept connection overrides until E5 enforces origin/credential provenance consistently
  for CLI and MCP callers.
- Do not delete `plex-filter-evaluator.ts` until all three filter consumers use G3.
- Do not delete `plex.ts` while any test mocks it; legacy mocks in unrelated action tests must be
  replaced with adapter mocks or explicitly removed.
- Do not tighten the audit before temporary compatibility imports have an intentional allowlist;
  shrink the allowlist to the final boundary in D5.
- Do not edit or regenerate completion templates unless a review proves an accidental public CLI
  change, in which case fix the public drift rather than accepting new candidates.

## File-to-Task Mapping

| File or area                                            | Primary task | Notes                                                   |
| ------------------------------------------------------- | ------------ | ------------------------------------------------------- |
| `types/media-server.ts`                                 | G1           | Sole generic-contract owner                             |
| `types/media-filters.ts`                                | G2           | New provider-neutral AST                                |
| `types/plex-filters.ts`                                 | G2           | Compatibility aliases/guards only                       |
| `types/plex.ts`, `types/index.ts`                       | G6           | Public compatibility projections and deprecated aliases |
| `lib/media-filter-evaluator.ts`                         | G3           | Pure residual evaluation; no Plex imports               |
| `lib/pagination.ts`                                     | G4           | Pure forward-progress logic                             |
| `lib/media-file-paths.ts`, `adapters/action-helpers.ts` | G5           | Local filesystem logic outside server capability        |
| Shared adapter fixtures/mocks                           | G7           | Generic canonical test vocabulary                       |
| `adapters/plex/types.ts`                                | P1           | Private consumed-wire and connection DTOs               |
| `adapters/plex/auth.ts`                                 | P2           | Static opaque token provider and future seam            |
| `adapters/plex/client.ts`                               | P3           | Exactly one authenticated fetch owner                   |
| `adapters/plex/cache.ts`                                | P4           | Instance-scoped cache                                   |
| `adapters/plex/mappers.ts`                              | P5           | Rating/ID/entity/wire projections                       |
| Private endpoint families                               | E1-E4        | Disjoint capability ownership                           |
| `adapters/plex-adapter.ts`, `adapters/index.ts`         | E5           | Composition, features, provenance-aware factory         |
| Plex action families                                    | C1-C6        | Generic orchestration with dedicated tests/mocks        |
| `actions/filter.ts`, `types/config.ts`                  | C7           | Generic internal names, stable YAML                     |
| `commands/plex.ts`                                      | C8           | Plex-branded UX projection                              |
| MCP schema/adapter                                      | C9-C10       | Stable machine surface and safe override forwarding     |
| Four legacy modules/tests                               | D1-D4        | Delete only after replacement evidence                  |
| Architecture script/package script                      | D5           | Final dependency direction and validation gate          |
| Feature docs                                            | V1-V2        | Document actual final semantics                         |
| `ROADMAP.md`                                            | V3           | Shipped issue/PR, dependents not completed              |
| Completion templates                                    | No edit      | Validation-only unless public CLI scope changes         |

## Optimization Opportunities

1. **Port tests alongside each behavior move.** Copy a legacy test case to its new owner, make it
   pass through the new module, then remove the old case. This preserves evidence and reduces the
   size of D4.
2. **Use compatibility aliases as a temporary migration bridge.** This keeps typecheck usable while
   actions move independently. The final architecture audit must prevent new production use of
   Plex aliases outside explicit public edges.
3. **Inject fetch, clock, sleep, and cancellation once.** Shared deterministic seams make P3/P4 and
   all endpoint tests fast without globally mocking Node APIs.
4. **Centralize test fixtures.** Generic domain fixtures should feed actions, while literal private
   Plex wire fragments should feed mappers/endpoints. Do not reuse wire DTOs as domain fixtures.
5. **Run focused validation at every barrier.** Typecheck after contract batches; security tests
   after P3; old/new parity suites after endpoint batches; action suites after C batches; full
   coverage only after D5.
6. **Use static searches as cheap progress metrics.** Track remaining imports of `lib/plex`,
   `plex-cache`, `plex-pagination`, `plex-filter-evaluator`, and production `types/plex` after every
   migration batch.
7. **Preserve history through small commits.** Commit generic foundations, private transport,
   endpoint families, consumer batches, deletion/enforcement, and docs separately when practical.
   This makes the large PR reviewable without weakening the final one-PR outcome.

## Implementation Strategy Recommendations

1. Start by freezing compatibility and adding the security regression. The cross-origin fallback
   is the only intentional behavior tightening and must be visible in tests before factory changes.
2. Introduce the generic contract with compatibility aliases, not a repository-wide rename. Keep
   the repository compiling at each barrier and migrate consumers in bounded slices.
3. Make `client.ts` the security choke point. Endpoint code receives only relative paths and
   structured query values; it cannot choose an origin or attach a token.
4. Keep `PlexAdapter` as the public class, but compose private capability modules. Do not put 2,800
   lines back into the class and do not export a second Plex API facade.
5. Preserve established operation semantics explicitly: query/CRUD throw, scan and rating return
   result objects, optional scans warn/skip, cache hits skip pacing, and mutation retries remain
   disabled.
6. Project compatibility at the outermost edge. Generic `id` and normalized rating flow through
   actions; `rating_key`, Plex `0..10`, and `plex-*` discriminators appear only when writing SQLite
   rows or rendering established machine output.
7. Treat security acceptance as negative as well as positive: prove zero requests for invalid
   provenance, zero credential text in URLs/errors/cache keys, rejection of redirects, and no
   replay of writes.
8. Remove legacy modules only when zero-import searches and replacement-test mapping pass. The
   final codebase must have one callable Plex network/cache path, not a compatibility facade that
   quietly preserves the old implementation.
9. Run the full delivery matrix before publication: architecture audit, focused/full tests,
   coverage, typecheck, build, completion parity, markdown lint, `git diff --check`, dependency
   audit, and graph update. Generated graph output should only be staged if repository conventions
   show it is tracked.
10. Keep automatic JWT enrollment, key generation/storage, nonce refresh, and secret persistence in
    the linked child issue. #119 accepts a legacy token or pre-issued JWT as the same opaque
    credential through the existing config/CLI field and adds no dependency or completion change.
