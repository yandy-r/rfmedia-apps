# Plex-Lidarr Identity Mapping Implementation Plan

Issue #207 will add an internal, read-only artist identity foundation without adding a command or
mutation path. The implementation introduces provider-neutral contracts, a private Plex GUID
projection and acquisition family, a pure MBID-first resolver with suggestion-only fuzzy matching,
one strict SQLite snapshot cache, and pure expansion evidence. Work converges through architecture,
completion-parity, codegen, full-suite, review, CI, merge, roadmap, and cleanup gates so #208 can
consume the foundation without weakening provider or plan/apply boundaries.

## Critically Relevant Files and Documentation

- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`: Authoritative scope and acceptance
  decisions.
- `docs/plans/plex-lidarr-identity-mapping/research-security.md`: Required identity, cache, and
  expansion safety gates.
- `docs/plans/plex-lidarr-identity-mapping/analysis-code.md`: Concrete repository seams and
  migration gotchas.
- `packages/rfmedia-cli/src/types/media-server.ts`: Provider-neutral capability surface.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: Private Plex composition root.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: Library and machine-ID seams.
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`: Sole authenticated Plex transport.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Existing Lidarr artist facade.
- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`: Feature-owned SQLite CRUD precedent.
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`: Pure checked evidence precedent.
- `packages/rfmedia-cli/src/lib/schema.sql`: Fresh tracking database schema.
- `packages/rfmedia-cli/src/lib/migrations.ts`: Sequential schema migration owner.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Provider-boundary architecture
  gate.
- `ROADMAP.md`: Live issue ordering and totals.
- `docs/roadmap-archive.md`: Shipped-work history.

## Implementation Plan

### Phase 1: Contract and Database Foundations

#### Task 1.1: Define artist identity and bridge contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`
- `docs/plans/plex-lidarr-identity-mapping/research-security.md`
- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/types/bridge.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Add readonly artist-only external identity, identity page/capability, resolution outcome, candidate,
scope, snapshot, cache-error, provenance, and expansion contracts. Make
`MediaServerAdapter.identity` optional and provider-neutral with `getInstanceId()` and
`listArtists()` methods; each identity page carries the resolved stable library section ID. Keep
identity state separate from provenance/completeness; include stable snapshot, resolver,
normalization, and scoring versions. Only artist MBIDs are modeled, and no private Plex, SQL-row,
generated Lidarr, command, or presenter type may escape this boundary.

#### Task 1.2: Extend the shared adapter test mock Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/test-helpers/media-server-adapter-mocks.ts`

Extend the mapped capability mock with the optional identity surface and a safe empty-page default.
Preserve all current mock call signatures and avoid scattered Plex-specific bridge mocks.

#### Task 1.3: Add schema v11 and exact compatibility gates Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/schema.sql`
- `packages/rfmedia-cli/src/lib/migrations.ts`
- `packages/rfmedia-cli/src/lib/db.ts`
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/schema.sql`
- `packages/rfmedia-cli/src/lib/migrations.ts`
- `packages/rfmedia-cli/src/lib/db.ts`

Add one `bridge_identity_snapshots` table with full unique scope, artist-kind and positive-version
checks, bounded document columns, and observation timestamps. Advance the writable and exact
read-only schema versions from 10 to 11 together. Preserve the existing initialization order,
malformed/newer-schema preflight, and data-preserving sequential v10-to-v11 migration.

#### Task 1.4: Prove fresh and migrated v11 databases Depends on [1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/db.test.ts`
- `packages/rfmedia-cli/src/types/db.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`
- `packages/rfmedia-cli/src/lib/migrations.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/db.test.ts`

Test the fresh table/index shape, full-scope uniqueness, preservation of a populated v10 database,
exact v11 read-only acceptance, v10 read-only rejection, and v12 future-schema rejection. Keep any
bridge snapshot SQL row type private to the cache owner. Do not duplicate payload/corruption
behavior that belongs to the cache suite.

### Phase 2: Parallel Identity Implementation

#### Task 2.1: Implement private Plex artist identity acquisition Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`
- `docs/plans/plex-lidarr-identity-mapping/research-security.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/lib/adapters/plex/types.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/types.test.ts`

Add private bounded GUID/artist identity response guards and a capability factory injected with the
existing transport, library `byName`, machine-ID callback, and page-size policy. Request artists
with `type=8`, `includeGuids=1`, structured offsets/sizes, and caller cancellation. Bound IDs,
titles, GUID count/bytes, array sizes, page arithmetic, control characters, and bidirectional
controls; prove exact response-driven pagination metadata and forward progress. Ignore unknown GUID
providers but preserve malformed/conflicting consumed MusicBrainz evidence so the resolver can fail
closed. Return fresh frozen provider-neutral values and the stable library section ID.

#### Task 2.2: Compose the optional Plex identity capability Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.test.ts`

Compose `identity` from the already-created transport/cache/query-library seams. Do not create a
second client, expose the machine ID or token as adapter metadata, or widen ordinary query results.
Test capability presence, shared dependency behavior, frozen composition, and absence of
credential/raw-wire leakage.

#### Task 2.3: Implement deterministic artist resolution and expansion Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`
- `packages/rfmedia-cli/src/lib/fuzzy-match.ts`
- `packages/rfmedia-cli/src/lib/lidarr/audit-identity.ts`
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`

Implement one pure ordered resolver. Canonicalize artist MBIDs, resolve only unique one-to-one
exact joins, and return conflict without name fallback for malformed/duplicate/contradictory
authoritative evidence. Use bridge-local normalization and the installed Levenshtein primitive with
the versioned `0.90` score floor, `0.08` runner-up margin, short-name rule, candidate cap,
comparison budget, and stable ordering. Every name-derived winner remains `suggested`. Add pure
checked expansion impact with distinct-ID semantics, `null` ratio for incomplete counts, and a
derived confirmation requirement. Table-test policy boundaries, permutations, immutability,
deduplication, overflow, and incomplete evidence without provider/database mocks.

#### Task 2.4: Implement strict atomic snapshot persistence Depends on [1.1, 1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/metadata-cache.ts`
- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`
- `docs/plans/plex-lidarr-identity-mapping/research-security.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/bridge/cache.ts`
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`

Own all snapshot read, replace, and purge SQL in this module. Strictly validate scope, canonical
credential-free origins, IDs, versions, timestamps, references, outcomes, candidate bounds, and
MBIDs on both writes and reads. Cap UTF-8 payload bytes before parsing cached JSON as `unknown`.
Validate the complete snapshot before one transactional upsert so a failure preserves the prior
generation. Corrupt or version-incompatible low-level reads throw the bounded typed bridge cache
error; a future orchestration caller may translate that into explicit `unavailable` evidence.
Test all scope dimensions, corruption/version mismatch, old-generation preservation, purge,
immutability, and absence of secrets with real temporary databases.

### Phase 3: Architecture, Review, and Compatibility Convergence

#### Task 3.1: Enforce bridge provider boundaries Depends on [2.1, 2.3, 2.4]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

Add negative fixtures proving `packages/rfmedia-cli/src/lib/bridge/**` cannot import private
Plex/generated Lidarr modules, construct handwritten Lidarr endpoints, or own `fetch`. Keep the
real-tree audit and existing sole transport owners. Do not add broad exemptions for the new
modules. Assert that no MusicBrainz transport or dependency was introduced.

#### Task 3.2: Review implementation and prove public-surface parity Depends on [1.2, 1.4, 2.2, 3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/audit.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/audit.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`

**Instructions**

Files to Modify

- No files by default; fixes return to the owning implementation task.

Run an independent code review over the complete diff and fix every actionable finding. Prove
`plex-alignment` remains reserved, Plex query/MCP output remains unchanged, generated Lidarr and
OpenAPI files have no drift, package manifests/lockfile are unchanged, and Bash/Zsh/Fish static
completion parity remains green with no template edits.

### Phase 4: Documentation, Validation, and Delivery

#### Task 4.1: Run local validation and create the draft PR Depends on [3.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `packages/rfmedia-cli/package.json`
- `package.json`

**Instructions**

Files to Modify

- No files by default; any validation/review fix returns serially to its original file owner.

Bootstrap dependencies if needed and run `npm run build:common` before focused package tests. Run
focused identity, mapping, cache, migration, adapter, and architecture tests; Lidarr codegen drift
checks; rfmedia typecheck/build/full suite; root package, architecture, coverage, lint, format, and
pre-push validation. Run `graphify update .` after code changes. Commit and push without bypassing
hooks, then create a draft PR from the repository template with exact pass/fail evidence and
`Closes #207`.

#### Task 4.2: Update roadmap state using the real PR number Depends on [4.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`

**Instructions**

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Refresh live GitHub issue totals immediately before editing. Remove #207 from live roadmap
locations, make #208 the next Layer 3 dependency, and archive #207 with the real draft PR
number/date and concise implementation outcome. Keep #208, #209, and #221 open. Commit and push the
documentation update, update the PR testing summary if needed, and do not claim merge or issue
closure yet.

#### Task 4.3: Complete review, CI, merge, and cleanup Depends on [4.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`

**Instructions**

Files to Modify

- No files by default; any review or CI fix is applied serially and routed to the original file
  owner.

Mark the draft PR ready, perform the proper complete-diff review, fix every actionable finding,
resolve all review threads, rerun proportionate tests, push the active head, and wait for green
authoritative CI. Squash-merge only after the active SHA is green. Verify the PR merged, issue #207
closed, downstream issues remain open, and the default branch contains the merge. Only then remove
the dedicated worktree and local issue branch while preserving the primary checkout and unrelated
worktrees.

## Advice

- The final spec supersedes earlier suggestions for album identity, a three-table cache, alternate
  fuzzy thresholds, or a public review command.
- Plex GUID syntax is untrusted evidence, not a URL to dereference; the private projector must bound
  it before any comparison.
- A valid UUID is not enough: artist semantics and one-to-one cardinality are required for
  automatic identity.
- Snapshot scope must use credential-free origins, Plex machine ID, stable section ID, and entity
  kind; configured names are not durable identity.
- `initializeDatabase()` runs `schema.sql` before migrations, so v10 upgrade tests must prove both
  idempotent table creation and explicit metadata advancement.
- `findBestMatch()` and generic cache casts are unsafe precedents for this feature; reuse their
  dependencies and ownership patterns, not their decision shortcuts.
- Keep test ownership layered so hostile wire, resolver policy, cache corruption, and adapter
  composition matrices are not duplicated.
- No command means no completion diff, but Bash/Zsh/Fish parity remains a required regression gate
  and must be stated explicitly in the PR.
- Cached or suggested evidence remains read-only; #207 cannot authorize or dispatch a Lidarr
  mutation.
