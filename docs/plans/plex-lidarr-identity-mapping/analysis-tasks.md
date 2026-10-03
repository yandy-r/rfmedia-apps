# Task Structure Analysis: Plex-Lidarr Identity Mapping

## Executive Summary

Issue #207 should be implemented as a read-only artist identity foundation with four narrow
boundaries: provider-neutral contracts, private Plex acquisition, pure resolution/expansion, and
strict SQLite snapshot persistence. The validated feature spec is authoritative where earlier
research alternatives differ: v1 is artist-only, only a unique one-to-one typed MBID resolves
automatically, names produce suggestions only, persistence uses one strictly projected JSON
snapshot row per complete scope, and the issue adds no command, prompt, generated client,
dependency, configuration, or completion entry.

The optimal execution shape starts two independent foundation tasks in parallel: domain contracts
and schema v11. Once contracts land, Plex acquisition and pure mapping can proceed concurrently;
cache CRUD joins the contract and schema work as a third lane. A boundary/compatibility phase then
converges the lanes before documentation and full delivery validation. This keeps production-file
ownership non-overlapping while preserving the safety-critical seams around provider privacy,
atomic persistence, and exact-MBID authority.

## Recommended Phase Structure

### Phase 1: Parallel Foundations

#### Task 1.1: Define the Stable Identity and Bridge Contracts

**Dependencies**: None

**Owns**:

- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/types/index.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`

**Deliverables**:

- Add immutable artist identity, external-ID, page, outcome, candidate, snapshot, full-scope,
  provenance, error, and expansion-impact contracts.
- Add an optional `MediaServerAdapter.identity` capability with `getInstanceId()` and bounded,
  cancellable, paginated `listArtists()`.
- Ensure the page or returned identity evidence carries the resolved stable Plex section ID; a
  configured library name is not sufficient for the snapshot key.
- Keep identity optional so non-Plex adapters and existing mocks remain valid. Do not add a public
  Plex machine-ID property or expose Plex wire types.
- Use final states `resolved`, `suggested`, `ambiguous`, `unmatched`, `conflict`, and `unavailable`.
  Keep observation provenance/completeness separate from identity state.
- Export only provider-neutral contracts and extend the shared adapter mock once with a safe empty
  identity default.

**Focused proof**: Typecheck all current adapters and mocks; add only focused runtime projection
tests where a contract has executable validation.

#### Task 1.2: Advance the Tracking Database to Schema v11

**Dependencies**: None

**Owns**:

- `packages/rfmedia-cli/src/lib/schema.sql`
- `packages/rfmedia-cli/src/lib/migrations.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `packages/rfmedia-cli/src/types/db.ts`
- `packages/rfmedia-cli/src/lib/db.test.ts`

**Deliverables**:

- Add one `bridge_identity_snapshots` table, not normalized entity/mapping child tables and not
  `lidarr_metadata_cache`.
- Use the full unique scope:
  `(plex_origin, plex_machine_id, plex_library_id, lidarr_origin, entity_kind)`.
- Store positive snapshot/resolver versions, bounded `payload_json`, `captured_at`, and
  `verified_at`; constrain v1 `entity_kind` to `artist`.
- Raise both writable and exact read-only supported schema versions from 10 to 11.
- Add the sequential v10-to-v11 migration without weakening newer/older-schema rejection.
- Preserve existing v10 data and exact database initialization behavior.

**Focused proof**: Cover fresh schema, migration of a populated v10 database, exact table/unique
index shape, full-scope isolation, existing-row preservation, and read-only version gates. Cache
payload behavior belongs to Task 2.3, not this migration suite.

### Phase 2: Three Implementation Lanes

#### Task 2.1: Implement Private Plex Artist Identity Acquisition

**Dependencies**: Task 1.1

**Owns**:

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.test.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`

**Deliverables**:

- Extend private wire guards with bounded `Guid?: readonly { id: string }[]` evidence.
- Add a private identity endpoint family using the existing `PlexTransport`, library `byName`
  lookup, response-driven pagination rules, page-size policy, and private machine-ID callback.
- Request `GET /library/sections/{sectionId}/all` with `type=8`, `includeGuids=1`,
  `X-Plex-Container-Start`, and `X-Plex-Container-Size`.
- Forward `AbortSignal`, prove pagination forward progress, and project fresh frozen
  provider-neutral artist identities.
- Bound item IDs, titles, GUID count/bytes, and page values. Ignore unknown GUID providers, but
  retain bounded MusicBrainz evidence so malformed or conflicting artist MBIDs cannot silently
  become name-only matches.
- Compose the optional capability on `PlexAdapter` from the already-created transport/cache/family
  dependencies. Tokens and machine IDs must remain absent from enumerable state and serialized
  output.

**Focused proof**: Cover zero/one/multiple/duplicate/unknown/malformed/oversized GUIDs, exact query
parameters, stable section ID, response-driven page metadata, abort forwarding, instance-ID reuse,
invalid responses, and adapter composition/credential non-disclosure.

**Integration seam**: Reuse `queryLibrary.library.byName` and
`queryLibrary.getMachineIdentifier`; do not modify `query-library.ts` unless a narrow private
injection seam is demonstrably missing.

#### Task 2.2: Implement Pure Artist Resolution and Expansion Evidence

**Dependencies**: Task 1.1

**Owns**:

- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`

**Deliverables**:

- Implement one explicit, pure MBID-first resolver over provider-neutral Plex artists and existing
  stable `LidarrArtist` projections.
- Canonicalize valid artist MBIDs to lowercase. Resolve only a unique Plex artist MBID matched to
  exactly one Lidarr artist MBID.
- Return `conflict` for malformed, contradictory, or non-unique authoritative evidence and never
  fall through to names after an MBID conflict.
- Implement bridge-local, versioned normalization and bounded Levenshtein scoring. Do not change
  global normalization or call the existing first-winner/logging helper.
- Use the finalized `0.90` score floor, `0.08` runner-up margin, bounded comparison budget, short
  name rule, candidate cap, and deterministic ordering. Every normalized/fuzzy winner remains
  `suggested`.
- Return fresh frozen snapshots and stable reason codes without provider calls, database access,
  prompts, mutation, or per-candidate logging.
- Implement `calculateBridgeExpansionImpact()` with distinct source-track and target-album
  semantics, checked counts, `null` ratio when evidence is incomplete, and derived confirmation
  requirement. Do not add presenter prose or action policy.

**Focused proof**: Table-test exact MBID priority, duplicate/conflicting/malformed MBIDs,
missing-MBID name suggestions, Unicode/diacritic/case/punctuation/article variants, short names,
ties, exact threshold/margin boundaries, stable order across permuted input, cap/budget behavior,
immutability, deduplication, zero counts, unsafe counts, incomplete album counts, and finite ratio.

**Integration seam**: Import stable `LidarrArtist` only; do not change the handwritten Lidarr
facade or import generated modules. `listArtists()` already supplies all required Lidarr evidence.

#### Task 2.3: Implement Strict Atomic Snapshot Persistence

**Dependencies**: Tasks 1.1 and 1.2

**Owns**:

- `packages/rfmedia-cli/src/lib/bridge/cache.ts`
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`

**Deliverables**:

- Make this module the sole owner of bridge snapshot read, replace, and purge SQL.
- Validate the full scope, versions, canonical credential-free origins, section/machine IDs,
  timestamps, payload structure, enum values, references, bounds, and canonical MBIDs.
- Apply the same strict unknown-to-domain projection on live writes and cache reads; cap payload
  bytes before parsing and return fresh frozen objects.
- Replace one complete same-scope snapshot with one transactional upsert only after in-memory
  validation. Invalid or failed replacement must retain the previous complete generation.
- Treat corrupt, oversized, or incompatible rows as typed unavailable/corrupt evidence, never as a
  cast domain value. Provide explicit purge behavior.
- Store no credentials, paths, request URLs, raw GUID arrays, response bodies, or debug
  transcripts.

**Focused proof**: Use real temporary databases to cover round-trip, all five scope dimensions,
same-scope replacement, old-snapshot preservation on invalid/write failure, corrupt/oversized JSON,
version mismatch, malformed references/timestamps/MBIDs, empty complete snapshots, injected clock,
purge count, immutability, and credential absence.

### Phase 3: Boundary and Compatibility Convergence

#### Task 3.1: Strengthen Architecture and Scope Regression Gates

**Dependencies**: Tasks 2.1, 2.2, and 2.3

**Owns**:

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

**Deliverables**:

- Prove `lib/bridge/**` cannot import `lib/adapters/plex/**`, generated Lidarr modules, or construct
  handwritten `/api/v1/` paths.
- Preserve the existing single Fetch owners. The new private Plex identity module may call
  `PlexTransport` but may not call `fetch`.
- Add negative fixtures for private Plex imports, generated imports, handwritten endpoints, and
  extra Fetch ownership without broad allowlist exemptions.
- Confirm no direct MusicBrainz transport or dependency was introduced.

**Focused proof**: Run both the executable architecture audit and its negative-fixture suite.

#### Task 3.2: Prove Public-Surface Non-Changes

**Dependencies**: Tasks 2.1, 2.2, 2.3, and 3.1

**Owns**: Validation only; no production files by default.

**Deliverables**:

- Confirm existing Plex query/MCP shapes remain unchanged.
- Confirm `plex-alignment` remains a reserved inactive audit check.
- Confirm no command, flag, option, config field, environment variable, generated Lidarr file,
  OpenAPI snapshot, dependency, or lockfile change.
- Run Bash, Zsh, and Fish completion parity tests and verify the templates are unchanged. Do not
  edit completion files merely to create churn.

### Phase 4: Documentation, Validation, and Delivery

#### Task 4.1: Document Completion and Preserve Downstream Sequencing

**Dependencies**: Tasks 3.1 and 3.2 plus green focused/package validation

**Owns**:

- `ROADMAP.md`
- `docs/roadmap-archive.md`

**Deliverables**:

- Remove #207 from every live roadmap location only after implementation and local validation are
  complete.
- Keep #208, #209, and #221 open and make #208 the next Layer 3 dependency.
- Archive #207 with the real PR number/date and a concise note about the MBID-first read-only
  foundation.
- Refresh live GitHub issue totals immediately before closeout; do not copy stale counts.
- Do not claim merge or issue closure until GitHub confirms them.

#### Task 4.2: Full Validation and Lifecycle Closeout

**Dependencies**: Task 4.1

**Owns**: Delivery workflow; any fixes return to the task that owns the affected files.

**Validation sequence**:

1. Install dependencies in the worktree if needed and run `npm run build:common`.
2. Run focused Plex identity, mapping/expansion, cache, database migration, adapter, and
   architecture tests.
3. Run `npm run codegen:lidarr:check -w packages/rfmedia-cli` and
   `npm run test:codegen:lidarr -w packages/rfmedia-cli`.
4. Run `npm run test:architecture -w packages/rfmedia-cli`.
5. Run rfmedia typecheck/build and the full rfmedia suite.
6. Run root `npm run test:run`, `npm run typecheck`, `npm run build:all`,
   `npm run test:coverage`, `npm run lint`, and `npm run format:check`.
7. Run completion parity and explicitly record that Bash/Zsh/Fish templates did not change.
8. Run the repository pre-push hooks without bypassing them.

**Delivery lifecycle**:

- Create the PR using `.github/pull_request_template.md`, with exact commands/outcomes and
  `Closes #207`.
- Review the complete diff and use the repository review artifact convention.
- Fix every actionable review finding, resolve all threads, rerun proportionate tests, and push.
- Verify the active PR head SHA, green GitHub CI, and absence of unresolved review threads.
- Squash-merge only after authoritative checks are green.
- Verify the PR merged, issue #207 closed, downstream issues remain open, and the default branch
  contains the merge.
- Remove only the dedicated issue worktree and local issue branch after merge verification; keep
  the primary checkout and unrelated worktrees untouched.

## Task Granularity Recommendations

- Keep Task 1.1 together because the adapter capability, bridge input/output types, type barrel, and
  shared mock must agree atomically.
- Keep schema/version/migration work in Task 1.2 and cache behavior in Task 2.3. This allows useful
  Phase 1 parallelism while preventing two agents from editing `db.test.ts` or `schema.sql`.
- Keep all private Plex identity files plus adapter composition in Task 2.1. Splitting wire
  projection from composition would duplicate fixtures and create an unstable intermediate
  capability.
- Keep resolver and expansion in Task 2.2 because both are pure bridge evidence over the same
  contracts and share checked immutable projection helpers.
- Keep cache production and integration tests together; atomic replacement and strict
  reprojection are one invariant.
- Keep architecture script and fixture changes under one owner. Broad allowlist changes must not be
  separated from their negative proof.
- Keep roadmap/archive updates in one late task so live status and shipped history cannot disagree.
- Avoid a separate orchestration/command task: #207 intentionally has no public consumer.

## Dependency Analysis

```text
1.1 contracts --------------------+--> 2.1 private Plex acquisition --+
                                  |                                   |
                                  +--> 2.2 resolver + expansion ------+--> 3.1 architecture
                                  |                                   |          |
1.2 schema v11 -------------------+--> 2.3 snapshot cache ------------+          +--> 3.2 parity
                                                                                         |
                                                                                         +--> 4.1 docs/ROADMAP
                                                                                                |
                                                                                                +--> 4.2 PR/CI/merge/cleanup
```

- **Maximum useful parallelism**: two tasks in Phase 1, then three tasks in Phase 2.
- **Critical path**: `1.1 + 1.2 -> 2.3 -> 3.1 -> 3.2 -> 4.1 -> 4.2`.
- **Join point**: Task 3.1 must see all three implementation lanes so architecture rules prove the
  real final paths.
- **No circular dependency**: provider-neutral contracts sit below Plex acquisition and bridge
  logic; cache depends only on bridge contracts plus `DbConnection`; no bridge module depends on a
  provider client.
- **Do not start cache CRUD before both foundations**: otherwise its SQL and projector will be
  built against unstable scope/payload shapes.
- **Do not parallelize roadmap closeout with implementation**: live counts, PR number, and final
  validation evidence are not known yet.

## File-to-Task Mapping

| File                                                                          | Task |
| ----------------------------------------------------------------------------- | ---- |
| `packages/rfmedia-cli/src/types/bridge.ts`                                    | 1.1  |
| `packages/rfmedia-cli/src/types/media-server.ts`                              | 1.1  |
| `packages/rfmedia-cli/src/types/index.ts`                                     | 1.1  |
| `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts` | 1.1  |
| `packages/rfmedia-cli/src/lib/schema.sql`                                     | 1.2  |
| `packages/rfmedia-cli/src/lib/migrations.ts`                                  | 1.2  |
| `packages/rfmedia-cli/src/lib/db.ts`                                          | 1.2  |
| `packages/rfmedia-cli/src/types/db.ts`                                        | 1.2  |
| `packages/rfmedia-cli/src/lib/db.test.ts`                                     | 1.2  |
| `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`                         | 2.1  |
| `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`                    | 2.1  |
| `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`                      | 2.1  |
| `packages/rfmedia-cli/src/lib/adapters/plex/identity.test.ts`                 | 2.1  |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`                       | 2.1  |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`                  | 2.1  |
| `packages/rfmedia-cli/src/lib/bridge/mapping.ts`                              | 2.2  |
| `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`                         | 2.2  |
| `packages/rfmedia-cli/src/lib/bridge/cache.ts`                                | 2.3  |
| `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`                           | 2.3  |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`                  | 3.1  |
| `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`             | 3.1  |
| `ROADMAP.md`                                                                  | 4.1  |
| `docs/roadmap-archive.md`                                                     | 4.1  |

Files deliberately left unchanged include the Lidarr facade/generated tree, commands/actions,
audit evaluator, configuration, package manifests/lockfile, README public CLI surface, and all
three completion templates.

## Optimization Opportunities

- Reuse `PlexTransport`, adapter-local response cache, library lookup, private machine-ID callback,
  and `advancePaginationOffset()` instead of creating another Plex client or pagination policy.
- Reuse `LidarrClientApi.listArtists()` unchanged; no generated operation, OpenAPI refresh, or
  handwritten endpoint is needed.
- Reuse `better-sqlite3` and `fastest-levenshtein`; add no package or ORM.
- Build MBID and normalized-name indexes once. Limit fuzzy work to MBID-unresolved artists, enforce
  a total comparison budget, and never log per comparison.
- Use one whole-snapshot JSON row. It matches the complete-snapshot consumer, makes replacement one
  upsert, and avoids speculative child-table joins/indexes.
- Apply one strict projector to both live and cached snapshots, reducing duplicated validation and
  preventing cache-only type drift.
- Share fixtures only at stable domain boundaries. Wire tests own hostile Plex payloads, mapping
  tests own the full resolution matrix, and cache tests own corruption/durability; do not repeat
  every case through adapter integration.
- Preserve source files that do not need change. In particular, do not modify
  `query-library.ts`, `lidarr/client.ts`, audit code, commands, or completions unless a verified
  missing seam makes it unavoidable.

## Implementation Strategy Recommendations

1. Treat `feature-spec.md` as the contract lock. Earlier normalized-table, album-reservation,
   public presenter, reviewed-override, or threshold alternatives are superseded.
2. Merge Task 1.1 first or publish its exact type shape to all Phase 2 implementors; no Phase 2
   lane should invent parallel domain types.
3. Keep provider acquisition, resolution, and persistence independently callable and independently
   testable. #208 should be able to orchestrate them without moving policy across boundaries.
4. Fail closed at every uncertainty boundary:
   - hostile/over-budget wire data is invalid response evidence;
   - malformed/duplicate/conflicting authoritative MBIDs are `conflict`;
   - names are never automatic identity;
   - incompatible/corrupt cache data is unavailable;
   - incomplete expansion has `null` ratio and cannot imply safe action.
5. Preserve exact scope material: credential-free Plex origin, machine ID, stable section ID,
   credential-free Lidarr origin, and artist kind. Names and numeric/local IDs are not durable
   cross-system identity.
6. Keep all output pure data. Do not add logging, prompts, mutation, reconciliation, or a
   `plex-alignment` evaluator in this issue.
7. Require completion parity as a regression gate even though templates remain untouched; record
   the audit result in the PR testing evidence.
8. Treat delivery as incomplete until review findings are fixed, CI is green on the active head,
   the squash merge and issue closure are verified, ROADMAP/archive reflect live state, and the
   dedicated worktree/branch are cleaned up safely.
