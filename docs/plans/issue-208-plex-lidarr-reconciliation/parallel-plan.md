# Issue #208 Plex-Lidarr Reconciliation Implementation Plan

Deliver issue #208 as two dependency-ordered child contracts in one isolated feature worktree.
Child A evolves the #207 snapshot into complete offline evidence and adds credential-free,
ambiguity-safe scope selection. Child B consumes that foundation through a pure report engine,
online/offline action, public command, reserved-audit correction, Bash/Zsh/Fish parity, and operator
documentation; no provider mutation or `--apply` surface is added.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-issue-208/ (branch: issue-208-plex-lidarr-reconcile)

## Critically Relevant Files and Documentation

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`: Frozen design and acceptance contract.
- `docs/plans/issue-208-plex-lidarr-reconciliation/shared.md`: Architecture, patterns, and required reading.
- `docs/plans/plex-lidarr-identity-mapping/feature-spec.md`: Shipped #207 identity and snapshot decisions.
- `packages/rfmedia-cli/src/types/bridge.ts`: Identity snapshot and cache contracts.
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`: Exact-MBID resolver and snapshot construction.
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`: Sole SQLite snapshot persistence owner.
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`: Provider-neutral paged Plex identity input.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Handwritten complete Lidarr artist facade.
- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`: Multi-source action orchestration pattern.
- `packages/rfmedia-cli/src/commands/lidarr-audit.ts`: DI leaf and output/failure pattern.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Exact shell parity contract.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Provider-boundary architecture gate.
- `ROADMAP.md`: Live Layer 3 sequencing and issue counts.
- `docs/roadmap-archive.md`: Shipped-history destination.

## Implementation Plan

### Phase 1: Child A Snapshot-v2 Foundation

#### Task 1.1: Define Complete Snapshot-v2 Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/types/index.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Bump the identity snapshot document version to v2. Add an immutable minimal Lidarr target projection
with positive local ID, terminal-safe bounded title, and canonical nullable artist MBID. Add typed
credential-free compatible-scope selectors/results without weakening the full exact cache scope.
Keep v1 explicitly incompatible; do not reinterpret old payloads or bump the SQL schema solely for
the payload change.

#### Task 1.2: Expose Credential-Free Plex Origin Normalization Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/adapters/index.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/adapters/index.test.ts` if no focused test seam exists.

Files to Modify

- `packages/rfmedia-cli/src/lib/adapters/index.ts`

Export a narrow helper that canonicalizes the configured or overridden Plex origin without a token
or adapter construction. Preserve rejection of credentials, paths, query, fragment, malformed
schemes, and unsafe overrides. Add only the accepted canonical case and security-significant
rejections.

#### Task 1.3: Expose Credential-Free Lidarr Origin Normalization Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`

Separate canonical Lidarr-origin resolution from API-key validation so offline selection can resolve
the cache namespace without a client. Keep online `resolveRequiredLidarrOrigin()` and client
behavior compatible. Cover canonical, missing, malformed, and no-key offline cases only.

### Phase 2: Child A Construction, Persistence, and Scope Selection

#### Task 2.1: Construct and Validate the Complete Target Catalog Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.test.ts`

Have `resolveArtistIdentities()` derive `targetArtists` from the same validated complete Lidarr input
as the outcomes. Enforce unique positive IDs, canonical nullable MBIDs, terminal-safe bounded
titles, count parity, deterministic order, immutability, and existing byte/record limits. Add one
compact parameterized matrix for non-candidate targets, empty Plex, invalid/duplicate target IDs,
ordering, and frozen output; do not duplicate existing matcher policy tests.

#### Task 2.2: Persist Snapshot v2 and Select Exact Compatible Scopes Depends on [1.1, 2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/bridge/cache.ts`
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`
- `packages/rfmedia-cli/src/lib/schema.sql`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/bridge/cache.ts`
- `packages/rfmedia-cli/src/lib/bridge/cache.test.ts`

Strictly reproject and round-trip the complete target catalog under existing payload/cardinality
caps. Add a cache-owner query by canonical Plex origin, canonical Lidarr origin, entity kind, and
optional stable Plex library ID that returns bounded deterministic zero/one/many candidates while
retaining the full scope. Never choose newest, merge libraries, expose credentials, migrate during
offline reads, or write from a read path. Cover v2 round-trip, v1 incompatibility, zero/one/many
selection, library/origin isolation, corrupt catalog rejection, and old-generation retention.

#### Task 2.3: Validate Child A Contract Depends on [1.2, 1.3, 2.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `packages/rfmedia-cli/package.json`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Run these exact Child A gates:

- From `packages/rfmedia-cli`: `npx vitest run src/lib/bridge/mapping.test.ts
src/lib/bridge/cache.test.ts src/lib/adapters/index.test.ts src/lib/lidarr/index.test.ts`.
- `npm run build:common`.
- `npm run test:architecture --workspace packages/rfmedia-cli`.
- `npm run typecheck --workspace packages/rfmedia-cli`.
- `git diff --check`.

Child A is complete only when an offline v2 snapshot names every reverse gap and origin-only
selection yields one exact full scope or an explicit zero/many result.

### Phase 3: Child B Pure Reconciliation Engine

#### Task 3.1: Define the Versioned Report Contract Depends on [2.3]

**READ THESE BEFORE TASK**

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/types/results.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Define frozen, readonly result-v1 contracts for summary, scope/provenance, authoritative matches,
review suggestions, ambiguity/conflict/unavailable evidence, directional gaps, optional duplicate
findings, and inert remediation suggestions. Exact unique MBID is the only authoritative class;
numeric scores remain similarity evidence, not probability.

#### Task 3.2: Implement the Pure Bidirectional Engine Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/bridge.ts`
- `packages/rfmedia-cli/src/lib/bridge/mapping.ts`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/bridge/reconcile.ts`
- `packages/rfmedia-cli/src/lib/bridge/reconcile.test.ts`

Files to Modify

- None.

Project one complete snapshot into authoritative matches, review-only suggestions, ambiguity,
conflict, unavailable, `plex_only`, and `lidarr_only`. Subtract only exact resolved target IDs;
suggested pairs remain in both directional gaps until review. Optionally derive bounded duplicate
groups, preserve deterministic ordering/count parity, freeze output, and emit non-executable
remediation. Use one critical parameterized matrix spanning exact/review/uncertainty/gaps, empty
sides, duplicate opt-in, target reuse, input permutation, and immutability.

### Phase 4: Child B Online and Offline Action

#### Task 4.1: Add Reconciliation Orchestration Depends on [2.3, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/identity.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/db.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`
- `packages/rfmedia-cli/src/actions/lidarr/reconcile.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Online mode must require the provider-neutral identity capability, page one explicit Plex music
library to completion with stable scope/forward progress, list the full Lidarr catalog through the
handwritten facade, resolve identities, persist only after complete validation, and invoke the pure
engine. Offline mode must normalize origins without credentials, open the tracking database
read-only, enforce exact-one compatible scope with optional library ID, read v2, and invoke the same
engine without provider/client/scheduler construction, network, migration, fallback, or write.
Forward cancellation throughout and retain the previous cache on partial/failing reads. Use one
compact lifecycle table to cover cancellation before start, during Plex paging, during Lidarr
acquisition, and before cache replacement; missing identity capability; stalled paging;
corrupt/incompatible cache; database closure in `finally`; exact offline zero-I/O/no-write; and
live/offline equivalence from the same snapshot. Keep classification mathematics in Task 3.2.

### Phase 5: Child B CLI and Public Registration

#### Task 5.1: Add the Report-First Leaf and Presenters Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-audit.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`
- `packages/rfmedia-cli/src/commands/lidarr-reconcile.test.ts`

Files to Modify

- None.

Implement a lazy DI-factory leaf with `--plex-library`, `--plex-library-id`, `--offline`,
`--duplicates`, `--plex-url`, `--plex-token`, `--lidarr-url`, and `--lidarr-api-key`. Reject
offline credentials and invalid live/offline selector combinations before action import. Human
output uses stderr; JSON/YAML emit one `{ command: "lidarr-reconcile", result }` document; CSV uses
fixed columns and stable row types. Findings exit zero; invalid/incomplete/unusable evidence exits
one through the redacted Lidarr failure envelope. Do not add apply/repair flags.

#### Task 5.2: Register the Leaf in the Exact Command Hierarchy Depends on [5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Inject the shared format/failure/execution helpers and register `reconcile` in the pinned Lidarr
hierarchy. Preserve parent/global options, lazy imports, ordering, and zero-side-effect help. Add
only the hierarchy/global integration assertions; keep leaf behavior in Task 5.1.

### Phase 6: Child B Audit Guidance and Shell Parity

#### Task 6.1: Correct the Reserved Plex-Alignment Guidance Depends on [5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`
- `packages/rfmedia-cli/src/lib/lidarr/audit.ts`
- `packages/rfmedia-cli/docs/features/lidarr-audit.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/audit.ts`
- `packages/rfmedia-cli/src/lib/lidarr/audit.ts`
- `packages/rfmedia-cli/src/lib/lidarr/audit.test.ts`

Keep `plex-alignment` reserved without adding a second matcher or network budget. Replace obsolete
“no join key/#207/#208 not landed” text with accurate guidance to use `rfmedia lidarr reconcile`,
and adjust only the reserved-slot contract assertion.

#### Task 6.2: Update Bash, Zsh, and Fish Together Depends on [5.1]

**READ THESE BEFORE TASK**

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

Add the exact finalized reconcile leaf and options `--plex-library`, `--plex-library-id`,
`--offline`, `--duplicates`, `--plex-url`, `--plex-token`, `--lidarr-url`, `--lidarr-api-key`,
`-v`, and `--verbose` identically across all shells. The six URL/token/library options are
value-taking. Generation remains static and must not load config, open SQLite, import the action, or
contact providers.

#### Task 6.3: Extend the Cross-Shell Parity Gate Depends on [5.2, 6.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add one shared expected option set and exact Bash/Zsh/Fish assertions for the command, all ten
flags, all six value-taking arguments, and side-effect freedom. Do not create three redundant shell
suites.

### Phase 7: Documentation, Roadmap, and Delivery Evidence

#### Task 7.1: Document the Operator Contract Depends on [5.1, 6.1, 6.3]

**READ THESE BEFORE TASK**

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-audit.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `docs/architecture/data-flow.md`
- `docs/architecture/overview.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/plex-lidarr-reconciliation.md`

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-audit.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`

Document exact versus review-only evidence, directional gap semantics, snapshot-v2 refresh,
offline exact-one scope/age/provenance, duplicates, output schemas, exit behavior, observational
cache persistence, and explicit no-mutation exclusions. Correct stale audit join-key and tracking
schema-v9 statements.

#### Task 7.2: Update Live Roadmap and Archive Depends on [7.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Prepare shipped-at-merge wording for #208, child #284, and child #285 in the merging PR; preserve
issues #209 and #221 as dependent future work, update live issue totals from GitHub rather than
arithmetic alone, and do not claim mutation capability. Treat the wording as authoritative only
after merge verification.

#### Task 7.3: Run Focused and Repository Delivery Gates Depends on [2.3, 3.2, 4.1, 5.2, 6.1, 6.3, 7.2]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Run these exact gates and record outcomes:

- From `packages/rfmedia-cli`: `npx vitest run src/lib/bridge/mapping.test.ts
src/lib/bridge/cache.test.ts src/lib/bridge/reconcile.test.ts
src/actions/lidarr/reconcile.test.ts src/commands/lidarr-reconcile.test.ts
src/commands/lidarr.test.ts src/lib/lidarr/audit.test.ts
src/lib/shell-completions/templates.spec.ts`.
- `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`.
- `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`.
- `npm run build:common`.
- `npm run test:architecture --workspace packages/rfmedia-cli`.
- `npm run typecheck --workspace packages/rfmedia-cli`.
- `npm run test:coverage --workspace packages/rfmedia-cli`.
- `RFMEDIA_BENCH_SCALES=10,100 npm run bench --workspace packages/rfmedia-cli`.
- `npm run build:all`, `npm run test:run`, `npm run format:check`, `npm run lint:md`, and
  `git diff --check`.

If `graphify-out/graph.json` exists in the worktree, run `graphify update .`. If it is absent, run
the supported worktree-local full initialization `graphify . --no-viz` and treat that fresh graph as
the required refresh. Never update the primary checkout's graph as a shortcut. No OpenAPI refresh
or generated-client change is expected.

### Phase 8: PR, Review, Merge, and Cleanup

#### Task 8.1: Commit, Push, and Open the Templated PR Depends on [7.3]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `lefthook.yml`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Commit with the repository's conventional format and allow commit/push hooks to run. Push the
feature branch to the GitHub remote. Open a PR against the verified default branch using every
required template section, exact validation outcomes, separate #284/#285 acceptance evidence, and
`Closes #208`, `Closes #284`, and `Closes #285`. Keep #209 and #221 explicitly out of scope.

#### Task 8.2: Perform Structured PR Review and Fix Every Finding Depends on [8.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-208-plex-lidarr-reconciliation/feature-spec.md`
- `docs/prps/reviews/`

**Instructions**

Files to Create

- `docs/prps/reviews/pr-<number>-review.md`

Files to Modify

- Any finding-owned file required by the reviewed fix.

Run correctness, security, and maintainability review against the active PR head. Commit the review
artifact, fix every actionable finding through the review-fix workflow, rerun affected focused and
repository gates, push, and verify all review threads are resolved on the current head SHA.

#### Task 8.3: Monitor Green CI, Squash Merge, and Clean Up Depends on [8.2]

**READ THESE BEFORE TASK**

- `.github/workflows/rfmedia-cli.yml`
- `ROADMAP.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Monitor the active PR head until every required check is green. Squash merge only after current-head
CI and review-thread resolution are authoritative. Verify PR merge state, closure of #208/#284/#285,
continued open state of #209/#221, final ROADMAP counts, and remote branch deletion. Fetch/prune,
align the primary checkout to merged `master` without overwriting unrelated work, remove this
dedicated worktree, and delete the obsolete local branch.

## Advice

- Treat snapshot v2 as a document-version change inside the existing SQL table unless bounded scope
  selection proves an index/schema change is required.
- Never derive reverse gaps from outcome candidates; only the complete target catalog is truthful.
- Preserve dual-gap visibility for fuzzy/name suggestions until explicit review.
- Make `--offline` a separate zero-I/O path, not a live-first stale fallback.
- Keep classifications in the pure engine, orchestration in the action, and formatting in the
  command so critical tests do not duplicate the same matrix.
- Cache persistence after a complete live observation is internal durability, not provider apply;
  document that distinction explicitly.
- Do not activate the reserved audit check in this delivery; correct its stale guidance and keep one
  reconciliation algorithm.
- Update all three shell templates in one ownership unit and prove exact parity before PR creation.
