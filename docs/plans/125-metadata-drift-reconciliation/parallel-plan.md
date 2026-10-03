# Metadata Drift Detection and Reconciliation Implementation Plan

Issue #125 adds a top-level `rfmedia reconcile scan|apply` workflow over embedded audio tags,
operation-scoped SQLite inventory, and a fresh provider-neutral media-server snapshot. The
implementation uses a pure exact-path report/planning engine behind a dependency-injected action,
with a thin Commander boundary for one-of winner flags, preview-first authorization, deterministic
machine output, and exit status. V1 observes rating, artist, first genre, and year but mutates only
requested rating targets plus distinctly modeled database-stat refreshes; known requested-plan
blockers fail closed unless `--allow-partial` is explicit.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/.worktrees/rfmedia-apps-125-metadata-reconciliation/ (branch: feat/125-metadata-reconciliation)

## Critically Relevant Files and Documentation

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md: Approved public and safety contract.
- docs/plans/125-metadata-drift-reconciliation/design-review.md: Final approval and resolved blockers.
- docs/plans/125-metadata-drift-reconciliation/shared.md: Consolidated architecture and repository context.
- packages/rfmedia-cli/src/cli.ts: Top-level command registration and root output-option handling.
- packages/rfmedia-cli/src/actions/plex-sync.ts: Rating, pagination, and exact-path precedents only.
- packages/rfmedia-cli/src/commands/lidarr-reconcile.ts: Thin lazy command and machine-output pattern.
- packages/rfmedia-cli/src/lib/db.ts: Hardened read-only snapshots and writable SQLite boundary.
- packages/rfmedia-cli/src/lib/metadata.ts: Existing normalized audio metadata projection.
- packages/rfmedia-cli/src/lib/tag-writer.ts: MP3/FLAC rating mutation and unsupported results.
- packages/rfmedia-cli/src/types/media-server.ts: Provider-neutral query and rating capabilities.
- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts: Configured adapter resolution.
- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts: Cross-shell parity contract.
- packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md: Inventory and database precedence.
- docs/features/output-formats.md: Shared machine-output and stdout/stderr contract.
- .github/pull_request_template.md: Required pull-request body structure.

## Implementation Plan

### Phase 1: Parallel Safety Foundations

#### Task 1.1: Define the Public Reconciliation Contract Depends on [none]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- docs/plans/125-metadata-drift-reconciliation/design-review.md
- packages/rfmedia-cli/src/types/index.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/types/reconciliation.ts

Files to Modify

- packages/rfmedia-cli/src/types/index.ts

Define readonly discriminated unions for planes, fields, observation states, findings, rating
outcomes, `DatabaseStatOutcome`, strategies, blockers, counts, postconditions, statuses, and the
`rfmedia.reconcile.v1` result. Keep `requestedFields` exactly `["rating"]`; model
`database-stat-refresh` through `requestedOperations` and the separate outcome kind. Use closed
reason codes and types that support exhaustive switches without adding stat data to
`ReconciliationField`.

#### Task 1.2: Add Operation-Aware Inventory Queries and Guarded Updates Depends on [none]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- packages/rfmedia-cli/src/types/db.ts
- packages/rfmedia-cli/src/lib/db.ts
- packages/rfmedia-cli/src/lib/db.test.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/src/types/db.ts
- packages/rfmedia-cli/src/lib/db.ts
- packages/rfmedia-cli/src/lib/db.test.ts

Add a bounded, deterministic inventory projection selected by exact root-contained
`inventory.dest_path` and optional operation ID. Preserve duplicate destination rows and validate
all SQLite values. Add a short-transaction update guarded by row ID, operation ID, exact
destination, prior rating, mtime, and size; allow intended rating and/or stat refresh, reject a
zero-row update as stale evidence, and never replace/delete history. Cover root and operation
selection, wildcard-looking roots, duplicate preservation, empty results, hard caps, successful
updates, and changed-guard refusal without modifying schema or migrations.

#### Task 1.3: Add Deterministic No-Follow Audio Discovery Depends on [none]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/audio.ts
- packages/rfmedia-cli/src/lib/integrity.ts
- docs/plans/125-metadata-drift-reconciliation/feature-spec.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/audio.test.ts

Files to Modify

- packages/rfmedia-cli/src/lib/audio.ts

Add an opt-in reconciliation-safe discovery helper or mode that returns deterministic audio
candidates without following file or directory symlinks. Preserve every existing caller's default
behavior. Tests must prove a regular nested file is found, symlinked files/directories are skipped,
and order is stable; root containment and immediate pre-write fingerprints remain action
responsibilities.

#### Task 1.4: Add Strict Metadata Read Evidence Depends on [none]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/metadata.ts
- packages/rfmedia-cli/src/lib/metadata.test.ts
- docs/plans/125-metadata-drift-reconciliation/feature-spec.md

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/src/lib/metadata.ts
- packages/rfmedia-cli/src/lib/metadata.test.ts

Add a reconciliation-facing result that distinguishes successful metadata with missing fields from
read/parse failure while preserving `readExtendedMetadata()` for existing consumers. Project only
the approved rating, primary artist, first genre, and year evidence. Add focused tests for populated
metadata, genuinely missing fields, and typed failure; do not duplicate exhaustive parser-format
coverage.

### Phase 2: Deterministic Comparison and Planning

#### Task 2.1: Implement the Pure Exact-Path Reconciliation Engine Depends on [1.1]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- docs/plans/125-metadata-drift-reconciliation/analysis-code.md
- packages/rfmedia-cli/src/actions/plex-sync.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/lib/reconciliation.ts
- packages/rfmedia-cli/src/lib/reconciliation.test.ts

Files to Modify

- None.

Implement pure path/value normalization, root-contained exact joins, duplicate database/server
ambiguity, four-field classification, native-step rating comparison, stable finding IDs/order,
exactly-one winner resolution, rating target planning, database-stat planning, blocker reduction,
and aggregate status calculation. Missing authority never falls back; non-rating findings live in
`observedResiduals`, never become target writes, and never block requested rating/stat work.
Without `--allow-partial`, any known requested-plan blocker makes the plan non-executable; with it,
only independent actionable records are eligible and unresolved requested work remains partial and
nonzero. Table-test genuinely distinct identity, evidence, strategy, capability, stat, blocker, and
ordering cases without a field-by-strategy-by-format matrix.

### Phase 3: Read-Only Scan and Authorized Apply

#### Task 3.1: Orchestrate Acquisition, Preview, Mutation, and Post-Verification Depends on [1.2, 1.3, 1.4, 2.1]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- packages/rfmedia-cli/src/lib/db.ts
- packages/rfmedia-cli/src/lib/parallel.ts
- packages/rfmedia-cli/src/lib/adapters/action-helpers.ts
- packages/rfmedia-cli/src/lib/tag-writer.ts

**Instructions**

Files to Create

- packages/rfmedia-cli/src/actions/reconcile.ts
- packages/rfmedia-cli/src/actions/reconcile.test.ts

Files to Modify

- None.

Build a dependency-injected scan/apply action. Scan and preview must resolve an existing database,
open it only through `openReconciliationDatabaseReadOnly()`, retain the reviewed database identity,
collect checked file evidence, and bracket a complete bounded server snapshot with uncached
`libraryContentVersion()` reads through `MediaServerAdapter`. Pass the caller's `AbortSignal`
through every provider query and return the pure result with no incidental write. Repeat
exactly-one winner and execution checks inside the action; evaluate blockers before confirmation or
writable dependencies; require default-No approval interactively and `--execute --yes` in
machine/non-TTY mode. For execution, use uncached `trackById()` and
`libraryContentVersion()` freshness reads, repeat containment/`lstat`/fingerprint checks, validate
the rating, and write file/server before an identity-checked
`withReconciliationDatabaseWritable()` update. For each `db-wins` record with authority-derived
external mutations, hold one short writable, identity-pinned SQLite `BEGIN IMMEDIATE` authority
reservation across those mutations, commit the refreshed generation on success, and roll back on
error or cancellation. For external-only records under the other strategies, use a non-mutating
current-generation guard.
Stop later per-record targets after failure, honor cancellation, and post-scan touched records
through fresh dependencies. Tests must prove every no-write gate, blocker/partial behavior, one
verified rating-plus-stat path, changed evidence refusal, authority-lease and generation-guard
behavior, target ordering, mid-record failure, uncached freshness, and truthful cancellation.

### Phase 4: Commander and Output Integration

#### Task 4.1: Register Commands and Render Stable Results Depends on [3.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/cli.ts
- packages/rfmedia-cli/src/commands/lidarr-reconcile.ts
- packages/rfmedia-cli/src/lib/formatters/index.ts
- docs/features/output-formats.md

**Instructions**

Files to Create

- packages/rfmedia-cli/src/commands/reconcile.ts
- packages/rfmedia-cli/src/commands/reconcile.test.ts

Files to Modify

- packages/rfmedia-cli/src/cli.ts

Register `rfmedia reconcile scan|apply` without altering existing `plex sync` or nested Lidarr
commands. Put mutually conflicting `--file-wins`, `--db-wins`, and `--server-wins` only on apply
and require exactly one before lazy action loading. Keep `--execute`, `--allow-partial`, and
`--yes` independent; validate numeric/source options before I/O. The exact scan leaf is
`<source-path>` plus `--library`, `--tracking-database`, `--operation-id`, `--workers`, and
`--no-progress`. Apply has those same options plus the three winner flags, `--popm-email`,
`--execute`, `--allow-partial`, and `--yes`. Preserve the existing global
`--output json|yaml|csv|table|text` and `--json` source rules. Render human output to stderr, one
JSON/YAML envelope to stdout, or a fixed row-kind CSV with a mandatory summary row, then set
`process.exitCode` without `process.exit()`. Cover invalid flags before import, all winner
normalizations, machine/non-TTY approval, blocked-preview zero exit, incomplete execution nonzero
exit, singular JSON/YAML, and empty CSV.

### Phase 5: Parallel Public Surfaces

#### Task 5.1: Extend Bash, Zsh, and Fish Completion Trees Depends on [4.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/commands/reconcile.ts
- packages/rfmedia-cli/src/lib/shell-completions/bash.ts
- packages/rfmedia-cli/src/lib/shell-completions/zsh.ts
- packages/rfmedia-cli/src/lib/shell-completions/fish.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/src/lib/shell-completions/bash.ts
- packages/rfmedia-cli/src/lib/shell-completions/zsh.ts
- packages/rfmedia-cli/src/lib/shell-completions/fish.ts

Add the identical `reconcile` parent and `scan`/`apply` leaves to every static template. Scan must
advertise only `<source-path>`, `--library`, `--tracking-database`, `--operation-id`, `--workers`,
and `--no-progress`. Apply exposes those same inputs plus all three winner flags, `--popm-email`,
`--execute`, `--allow-partial`, and `--yes`. Do not introduce or preserve a
false command-local/global `--dry-run` claim.

#### Task 5.2: Lock Cross-Shell Reconciliation Parity Depends on [5.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
- packages/rfmedia-cli/src/commands/reconcile.ts

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts

Add one order-sensitive parity contract proving Bash, Zsh, and Fish expose the same root/leaves and
leaf-correct options. Pin the full scan set (`--library`, `--tracking-database`, `--operation-id`,
`--workers`, `--no-progress`) and full apply additions (all winner flags, `--popm-email`,
`--execute`, `--allow-partial`, `--yes`). Assert the new top-level workflow does
not collide with `rfmedia lidarr reconcile`. Avoid three redundant shell-specific behavior suites.

#### Task 5.3: Write the Canonical Guide and Discovery References Depends on [4.1]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- packages/rfmedia-cli/README.md
- docs/README.md

**Instructions**

Files to Create

- packages/rfmedia-cli/docs/features/metadata-reconciliation.md

Files to Modify

- packages/rfmedia-cli/README.md
- docs/README.md

Document exact-path identity, observed fields, rating/stat apply scope, discriminated stat
outcomes, winner flags, preview/execute ceremony, blockers and `--allow-partial`, output/exit
contracts, limitations, safe reruns, and distinctions from both older reconciliation commands.
Use database-path precedence verified from code and keep detailed behavior in the canonical guide.

#### Task 5.4: Update Database, Output, and Completion Safety Contracts Depends on [4.1, 5.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md
- docs/features/output-formats.md
- packages/rfmedia-cli/docs/features/shell-completion.doc.md

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md
- docs/features/output-formats.md
- packages/rfmedia-cli/docs/features/shell-completion.doc.md

Document operation-scoped inventory, exact guarded rating/stat updates, no deletion/migration,
fixed reconciliation CSV rows, and that structured output is never consent. Align completion prose
with the executable Bash/Zsh/Fish trees and correct directly touched statements that call
`--dry-run` global.

#### Task 5.5: Record the Feature and Add Focused Cross-Links Depends on [4.1]

**READ THESE BEFORE TASK**

- packages/rfmedia-cli/CHANGELOG.md
- packages/rfmedia-cli/docs/features/plex-metadata-sync.md
- README.md

**Instructions**

Files to Create

- None.

Files to Modify

- packages/rfmedia-cli/CHANGELOG.md
- packages/rfmedia-cli/docs/features/plex-metadata-sync.md
- README.md

Add an unreleased entry without claiming arbitrary metadata mutation, link the older two-plane
rating guide to the new three-plane workflow, and add one concise root discovery example. Do not
rewrite unrelated historical documentation or predeclare issue #125 merged.

### Phase 6: Verification, Publication, and Authoritative Closeout

#### Task 6.1: Run Integrated Gates and Formal Review Depends on [5.2, 5.3, 5.4, 5.5]

**READ THESE BEFORE TASK**

- docs/plans/125-metadata-drift-reconciliation/feature-spec.md
- docs/plans/125-metadata-drift-reconciliation/design-review.md
- .github/pull_request_template.md

**Instructions**

Files to Create

- None; the code-review workflow selects and owns its artifact path.

Files to Modify

- Only files implicated by actionable review findings.

Run the focused reconciliation, database, discovery, metadata, action, command, and completion
tests first. Then run the exact release gates:

```bash
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/reconciliation.test.ts \
  src/lib/db.test.ts \
  src/lib/audio.test.ts \
  src/lib/metadata.test.ts \
  src/actions/reconcile.test.ts \
  src/commands/reconcile.test.ts \
  src/lib/shell-completions/templates.spec.ts
npm run build:common
npm run typecheck -w packages/rfmedia-cli
npm run test:rfmedia
npm run test:contracts
npm run build:rfmedia
npm run lint:md
npm run format:check
git diff --check
graphify update .
```

Invoke the formal code-review workflow after source changes, fix every actionable finding through
the affected file owner, rerun the smallest affected tests and every release gate whose inputs
changed, then re-review until no actionable finding remains. Do not bypass hooks or omit
architecture and Lidarr codegen contract suites.

#### Task 6.2: Commit, Push, and Open the Templated Pull Request Depends on [6.1]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- docs/plans/125-metadata-drift-reconciliation/feature-spec.md

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Inspect the final diff, commit intentionally without bypassing hooks, push
`feat/125-metadata-reconciliation` to the GitHub remote, and open a pull request using every
required template section. Include `Closes #125`, exact commands and outcomes, the rating/stat V1
boundary, no breaking changes unless evidence says otherwise, and a concrete rollback. Capture the
actual PR number and active head SHA; do not invent either value.

#### Task 6.3: Finalize Live ROADMAP and Archive State Depends on [6.2]

**READ THESE BEFORE TASK**

- ROADMAP.md
- docs/roadmap-archive.md
- docs/plans/125-metadata-drift-reconciliation/research-docs.md

**Instructions**

Files to Create

- None.

Files to Modify

- ROADMAP.md
- docs/roadmap-archive.md

Immediately before this edit, fetch the live open issue set and verify #125 is still open and is
the only issue this PR declares it will close. Derive the post-merge totals from that live set by
removing exactly #125; update all focus/backlog/cross-cutting references and archive entries with
the actual PR number and those derived totals. If issue state or the PR closing set changes before
merge, stop and refresh rather than copying the still-open count or guessing. Commit and push the
two documents, rerun Markdown lint, formatting, `git diff --check`, and any repository contract
affected by their content, then require green CI again.

#### Task 6.4: Verify Current-Head CI, Squash Merge, and Clean Up Depends on [6.3]

**READ THESE BEFORE TASK**

- .github/pull_request_template.md
- ROADMAP.md
- docs/roadmap-archive.md

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Verify every required check is green for the active head SHA and every review thread is resolved.
Immediately before merge, re-fetch the live open issue set and recompute the projected post-close
totals by removing exactly #125. If they differ from the committed ROADMAP, return to Task 6.3,
refresh the documents, commit/push, regain green current-head CI, and restart this task. Only then
squash-merge. Confirm the PR merged from that reviewed head and issue #125 closed; re-fetch the live
open issue set and treat the post-merge count check as verification only. Update the primary
checkout to `origin/master`, verify it is clean and aligned, remove only the issue-125 worktree and
local feature branch, delete or verify absence of the GitHub remote feature branch, and preserve
the unrelated issue-221 worktree and all other user state.

## Advice

- Treat the approved feature spec as immutable: rating and database-stat work are distinct outcome
  kinds, and artist/genre/year residuals never become requested V1 mutations or blockers.
- Keep `openReconciliationDatabaseReadOnly()` as the only scan/preview database entry point, retain
  its reviewed file identity, and use `withReconciliationDatabaseWritable()` only after strategy,
  blocker, execution, and approval gates. A `db-wins` external mutation requires a short writable
  authority reservation across the write; other external-only records retain a non-mutating
  current-generation guard.
- Pass `AbortSignal` through provider-neutral query options and use uncached
  `libraryContentVersion()` and `trackById()` methods for authoritative freshness. The signal must
  not affect query-cache identity; never import private Plex modules.
- Preserve the current audio discovery default and add an opt-in no-follow path so unrelated copy
  and sync commands do not change behavior.
- Linux MP3 publication pins its trusted directory chain and uses descriptor-anchored source,
  stage, replacement, and cleanup while preserving filesystem metadata. FLAC remains observable
  but unsupported for reconciliation mutation until it has the same boundary.
- Keep completion changes inseparable across Bash, Zsh, and Fish, and use parity tests as the
  public-contract proof.
- Task 2.1 depends only on Task 1.1 and may start as soon as the type contract lands while Tasks
  1.2 through 1.4 finish; run only focused per-owner checks during shared-worktree parallel edits
  and defer package-wide typecheck to Task 6.1.
- ROADMAP counts, archive state, and PR links are live release data. Never fill them from this plan
  or from stale issue totals.
