# Task Structure Analysis: Metadata Drift Reconciliation

## Executive Summary

Issue #125 should be implemented as one feature with a narrow dependency spine and several
parallel-safe foundations. The settled contract is a four-field observational scan
(`rating`, `artist`, first `genre`, and `year`) plus an apply path that requests only rating repair
and exact database-stat refresh. Rating authority is selected by exactly one of `--file-wins`,
`--db-wins`, or `--server-wins`; execution remains independently gated by `--execute`, approval or
`--yes`, and `--allow-partial` when known blockers exist.

The plan should separate public reconciliation types, database persistence, safe file acquisition,
the pure comparison engine, action orchestration, Commander integration, completions, and
documentation. This keeps every implementation task within one to three owned files and permits
the database, discovery, metadata-reader, and public-type foundations to proceed concurrently.
There is no child issue, schema migration, provider-specific import, or generic non-rating writer.

## Recommended Phase Structure

### Phase 0: Freeze the approved contract

Treat `feature-spec.md` and the final **Approve** verdict in `design-review.md` as immutable
implementation inputs. In particular:

- `DatabaseStatOutcome` remains a distinct `kind: "database-stat"` result carrying the inventory
  row ID and old/intended `mtime` and `size`; it is not a metadata field or winner-selected value.
- `requestedFields` is exactly `["rating"]`, while `requestedOperations` includes both rating and
  database-stat refresh.
- Non-rating drift is observation-only and remains in separately counted residuals.
- Non-rating residuals never block the requested rating/stat plan, make a preview non-executable,
  or require `--allow-partial`.
- Stat refresh is permitted only for one uniquely selected, still-present regular destination and
  uses freshly observed filesystem facts.
- Known blockers cause zero writes unless `--allow-partial` is explicit; partial execution remains
  nonzero while requested work is unresolved.

No implementation agent should reopen these decisions or add field-selection, path-mapping,
database-deletion, persisted-plan, schema-migration, or generic metadata-writer scope.

### Phase 1: Parallel foundations

Run the following four tasks concurrently. They own disjoint files.

#### T1 — Public reconciliation contract

- **Depends on:** Phase 0
- **Create:** `packages/rfmedia-cli/src/types/reconciliation.ts`
- **Modify:** `packages/rfmedia-cli/src/types/index.ts`
- **Responsibility:** Define readonly discriminated evidence, finding, rating outcome,
  database-stat outcome, strategy, counts, postcondition, status, and versioned result types.
  Preserve stable reason codes and make exhaustive switches possible.
- **Checkpoint:** Type-only compilation succeeds; stat maintenance is representable without adding
  `"stat"` to `ReconciliationField`.

#### T2 — Operation-aware SQLite queries and guarded writes

- **Depends on:** Phase 0
- **Modify:** `packages/rfmedia-cli/src/types/db.ts`,
  `packages/rfmedia-cli/src/lib/db.ts`, `packages/rfmedia-cli/src/lib/db.test.ts`
- **Responsibility:** Add a bounded reconciliation inventory projection selected by root and
  optional operation ID, preserving every duplicate destination. Add a short-transaction update
  guarded by row ID, operation ID, exact destination, expected prior rating, mtime, and size. The
  update must support intended rating and/or database-stat refresh, reject zero affected rows as
  stale evidence, and never delete or replace historical rows.
- **Critical tests:** Root and operation selection, duplicate preservation, empty result,
  deterministic order, successful exact update, and refusal after one captured guard changes.
- **Checkpoint:** Existing hardened `openDatabaseReadOnly()` tests remain green; `schema.sql` and
  migration files are unchanged.

#### T3 — No-follow audio discovery

- **Depends on:** Phase 0
- **Modify:** `packages/rfmedia-cli/src/lib/audio.ts`
- **Create:** `packages/rfmedia-cli/src/lib/audio.test.ts`
- **Responsibility:** Add a reconciliation-safe discovery mode/helper that does not follow
  symlinks, returns deterministic candidates, and allows the action to enforce normalized
  root containment and regular-file checks. Preserve existing callers' behavior unless they opt
  into the new safe path.
- **Critical tests:** A regular nested audio file is found, a symlinked file/directory is not
  followed, and ordering is deterministic.

#### T4 — Strict metadata-read evidence

- **Depends on:** Phase 0
- **Modify:** `packages/rfmedia-cli/src/lib/metadata.ts`,
  `packages/rfmedia-cli/src/lib/metadata.test.ts`
- **Responsibility:** Add a reconciliation-facing read result that distinguishes successful
  metadata with missing values from parse/read failure. Preserve the legacy
  `readExtendedMetadata()` contract for existing consumers.
- **Critical tests:** Successful rating/artist/first-genre/year projection, genuinely missing
  fields, and parser failure as typed failure rather than missing metadata.

### Phase 2: Pure engine

#### T5 — Exact-path comparison and plan engine

- **Depends on:** T1
- **Create:** `packages/rfmedia-cli/src/lib/reconciliation.ts`,
  `packages/rfmedia-cli/src/lib/reconciliation.test.ts`
- **Responsibility:** Implement pure normalization, exact root-contained path joining, duplicate
  ambiguity, four-field comparison, category precedence, deterministic finding order, rating
  strategy planning, blocker detection, observed residual separation, and database-stat refresh
  planning. Missing authority never falls back to another plane. Database-stat work is planned
  from filesystem evidence and remains independent of the selected rating winner. Only requested
  rating/stat work can create an execution blocker; observed non-rating residuals cannot.
- **Critical tests:** Exact-path/no-basename identity, missing versus unavailable versus invalid,
  duplicate database/server ambiguity, rating precision and text/year normalization, stable
  classification/order, each winner's losing rating targets, capability blockers, distinct stat
  outcomes, and `--allow-partial` plan eligibility. Use table cases where they prove genuinely
  distinct failure modes; do not create a full field/strategy/format cross-product.
- **Checkpoint:** The engine imports no Commander, SQLite, filesystem, adapter, Plex, formatter, or
  prompt module.

Phase 2 can overlap the tail of T2–T4 after T1 lands, but T5 must not absorb their I/O behavior.

### Phase 3: Action orchestration

#### T6 — Read-only scan, preview, and authorized apply

- **Depends on:** T2, T3, T4, T5
- **Create:** `packages/rfmedia-cli/src/actions/reconcile.ts`,
  `packages/rfmedia-cli/src/actions/reconcile.test.ts`
- **Responsibility:** Build one dependency-injected action surface for scan and apply. It must:
  resolve an existing database through `openDatabaseReadOnly()` for scan and preview; obtain a
  complete bounded server snapshot through `MediaServerAdapter`; gather checked file evidence;
  return the pure engine result; repeat exactly-one-winner and execution gates; prompt default-No
  only in an interactive text run; require `--execute --yes` for machine/non-TTY mutation; acquire
  writable SQLite only after authorization; reacquire fresh evidence; revalidate every target;
  attempt file/server targets before SQLite; apply guarded rating/stat updates; honor cancellation;
  and post-scan touched records.
- **Freshness rule:** Resolve a new adapter instance for each authoritative acquisition rather than
  extending `MediaServerAdapter`. Its cache is instance-local, and successful rating writes already
  invalidate the existing query cache. Do not import private Plex modules.
- **Critical tests:** Read-only scan, default apply preview, `--yes` without `--execute`, blocked
  execution before writable dependency acquisition, `--allow-partial` allowing only independent
  records, one successful rating plus stat repair with fresh verification, changed evidence
  blocking a write, mid-record failure preventing later targets, and cancellation/partial exit
  truthfulness.
- **Checkpoint:** Scan and preview spies prove zero writable DB opens, file writes, server writes,
  prompts, history writes, and incidental persistence.

### Phase 4: Command and public CLI integration

#### T7 — Commander grammar, rendering, and registration

- **Depends on:** T6
- **Create:** `packages/rfmedia-cli/src/commands/reconcile.ts`,
  `packages/rfmedia-cli/src/commands/reconcile.test.ts`
- **Modify:** `packages/rfmedia-cli/src/cli.ts`
- **Responsibility:** Register top-level `reconcile scan|apply`; parse positive integer options;
  declare and validate mutually conflicting `--file-wins`, `--db-wins`, and `--server-wins`;
  validate again before lazy action loading; reconcile global output-option sources; render human
  output to stderr; emit one JSON/YAML envelope or fixed-row-kind CSV document to stdout; and set
  `process.exitCode` without calling `process.exit()`.
- **Critical tests:** Zero or multiple winner flags fail before action import; all three flags
  normalize correctly; `--execute`, `--yes`, and `--allow-partial` retain independent semantics;
  machine execution without `--yes` never prompts; scan drift and blocked preview exit zero;
  incomplete execution exits nonzero; JSON/YAML are singular; empty CSV contains headers and a
  summary row.
- **Checkpoint:** Existing `plex sync` and `lidarr reconcile` command identifiers and syntax remain
  unchanged.

### Phase 5: Parallel public surfaces

After T7 fixes the final grammar, run completion and documentation work in parallel with disjoint
ownership.

#### T8 — Bash, Zsh, and Fish templates

- **Depends on:** T7
- **Modify:** `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- **Responsibility:** Add the identical root parent and two leaves. Keep scan free of mutation
  flags; place the three winner flags, `--execute`, `--allow-partial`, and `--yes` only on apply;
  include common source/library/database/worker/progress options on the correct leaves. Do not
  advertise a new global `--dry-run`.

#### T9 — Completion parity contract

- **Depends on:** T8
- **Modify:** `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- **Responsibility:** Assert complete Bash/Zsh/Fish hierarchy and option parity, including all
  three winner flags and leaf-only safety options. Cover the existing nested Lidarr reconcile
  distinction once, not with three shell-specific copies.
- **Checkpoint:** The focused template suite passes for all shells.

#### T10 — Canonical guide and discovery

- **Depends on:** T7
- **Create:** `packages/rfmedia-cli/docs/features/metadata-reconciliation.md`
- **Modify:** `packages/rfmedia-cli/README.md`, `docs/README.md`
- **Responsibility:** Document exact-path identity, four observed fields, rating/stat apply scope,
  the discriminated stat outcome, separate winner flags, default preview, execution/approval
  ceremony, blockers and `--allow-partial`, outputs/exits, limitations, reruns, and distinctions
  from `plex sync` and `lidarr reconcile`. Use the current database-path precedence from code.

#### T11 — Database, output, and completion contracts

- **Depends on:** T7, T8
- **Modify:** `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`,
  `docs/features/output-formats.md`,
  `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- **Responsibility:** Document operation-scoped inventory, exact guarded rating/stat updates,
  no deletion/migration, fixed reconciliation CSV rows, and that machine output is never consent.
  Align the documented static completion tree and remove directly touched claims that
  `--dry-run` is global.

#### T12 — Changelog and focused cross-links

- **Depends on:** T7
- **Modify:** `packages/rfmedia-cli/CHANGELOG.md`,
  `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`, `README.md`
- **Responsibility:** Record the unreleased feature without claiming arbitrary metadata writes,
  link the older Plex sync guide to three-plane reconciliation, and add one concise root discovery
  example. Do not rewrite unrelated historical documentation.

### Phase 6: Integration, review, and release closeout

#### T13 — Integrated verification and formal review

- **Depends on:** T9, T10, T11, T12
- **Files:** No new ownership; fixes return to the owner of the affected file.
- **Responsibility:** Run focused tests first, then package and repository gates. Run the required
  formal code review after all code changes, fix every actionable finding, and rerun the smallest
  affected tests plus the full release gates. Update the graph after source changes.
- **Review focus:** Read-only guarantees, mutation ceremony, ambiguity preservation, strict
  exact-path containment, fresh evidence, external-before-database ordering, stat-outcome honesty,
  output/exit contracts, private-Plex architecture, and tri-shell parity.

#### T14 — Pull request, ROADMAP, and archive

- **Depends on:** T13 and an actual GitHub pull-request number
- **Modify:** `ROADMAP.md`, `docs/roadmap-archive.md`
- **Responsibility:** Create the PR from `.github/pull_request_template.md` with `Closes #125` and
  exact passing commands. Immediately before merge, refresh live GitHub issue counts, use the real
  PR number, remove #125 from open focus/backlog positions, and add the shipped entry/archive note.
  Do not use a planned PR number or stale open counts.
- **Checkpoint:** After the final documentation commit, rerun Markdown lint, whitespace, relevant
  tests, and CI. Resolve every review thread before squash merge.

#### T15 — Authoritative merge and cleanup

- **Depends on:** T14 and green current-head CI
- **Files:** No repository-content ownership.
- **Responsibility:** Squash merge, verify the PR merged at the reviewed head, verify issue #125 is
  closed, re-audit ROADMAP counts against live GitHub state, update local `master`, remove only the
  issue-125 worktree/branch, and confirm the primary checkout remains aligned and unrelated
  worktrees remain untouched.

## Dependency Analysis

```text
Approved design
  ├─ T1 public types ───────────────┐
  │                                └─ T5 pure engine ───────────────┐
  ├─ T2 database query/update ───────────────────────────────────────┤
  ├─ T3 safe discovery ──────────────────────────────────────────────┤
  └─ T4 strict metadata evidence ────────────────────────────────────┤
                                                                   ▼
                                                            T6 action
                                                                   ▼
                                                            T7 command
                       ┌──────────────────────┬──────────────────────┼─────────────┐
                       ▼                      ▼                      ▼             ▼
                 T8 completions         T10 guide/docs        T11 contracts   T12 changelog
                       ▼                                         ▲
                 T9 parity test ──────────────────────────────────┘
                       └──────────────────────┬──────────────────────┘
                                              ▼
                                        T13 verify/review
                                              ▼
                                        T14 PR/roadmap
                                              ▼
                                        T15 merge/cleanup
```

- **Maximum implementation dependency depth:** seven edges from approved design through types,
  engine, action, command, completion parity, verification, and closeout.
- **Maximum safe code parallelism:** four tasks in Phase 1.
- **Serial bottleneck:** T5 → T6 → T7. This is intentional because the action consumes the pure
  contract, and the public CLI/completion/docs must follow the tested action semantics.
- **No circular dependency:** types know no implementation; the engine knows no I/O; actions know
  the engine and persistence boundaries; commands know actions; completions/docs know only the
  public grammar.

## File-to-Task Mapping

| Task | Owned files                                                                 | Why grouped                                          |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------- |
| T1   | `src/types/reconciliation.ts`, `src/types/index.ts`                         | One public discriminated contract and export surface |
| T2   | `src/types/db.ts`, `src/lib/db.ts`, `src/lib/db.test.ts`                    | Query/update contract plus real-SQLite proof         |
| T3   | `src/lib/audio.ts`, `src/lib/audio.test.ts`                                 | No-follow discovery and its direct contract          |
| T4   | `src/lib/metadata.ts`, `src/lib/metadata.test.ts`                           | Strict read result while preserving legacy behavior  |
| T5   | `src/lib/reconciliation.ts`, `src/lib/reconciliation.test.ts`               | Pure policy and focused table evidence               |
| T6   | `src/actions/reconcile.ts`, `src/actions/reconcile.test.ts`                 | I/O lifecycle and safety proof                       |
| T7   | `src/commands/reconcile.ts`, `src/commands/reconcile.test.ts`, `src/cli.ts` | Grammar, presentation, registration                  |
| T8   | `src/lib/shell-completions/bash.ts`, `zsh.ts`, `fish.ts`                    | One public tree across all shells                    |
| T9   | `src/lib/shell-completions/templates.spec.ts`                               | Cross-shell parity after template edits              |
| T10  | canonical feature guide, package README, `docs/README.md`                   | Operator contract plus discovery                     |
| T11  | centralized DB, output-format, and completion guides                        | Cross-cutting safety contracts                       |
| T12  | package changelog, Plex sync guide, root README                             | Release note and focused disambiguation              |
| T14  | `ROADMAP.md`, `docs/roadmap-archive.md`                                     | Live release state and real PR identity              |

Paths under `src/` in this table are relative to `packages/rfmedia-cli/`.
`packages/rfmedia-cli/src/lib/schema.sql`, `src/lib/migrations.ts`,
`src/types/media-server.ts`, private Plex modules, generated Lidarr clients, and issue templates
should remain unmodified unless verification exposes a concrete contract defect.

## Integration Checkpoints

1. **Foundation checkpoint:** T1–T4 pass their focused tests and typecheck. Confirm no schema,
   adapter, or existing call-site behavior changed unintentionally.
2. **Pure-engine checkpoint:** T5 produces deterministic results twice from identical unordered
   input and expresses rating and stat work through distinct outcome kinds.
3. **Read-only checkpoint:** T6 proves scan and preview never acquire a writable dependency or
   perform any file/provider/database mutation.
4. **Mutation checkpoint:** One end-to-end action fixture proves fresh reacquisition, checked
   external-before-database ordering, exact guarded stat/rating update, and fresh postcondition.
5. **CLI checkpoint:** T7 proves invalid winner/safety combinations fail before action loading and
   machine output remains singular.
6. **Completion checkpoint:** T9 proves Bash, Zsh, and Fish expose the same parent/leaves/options.
7. **Documentation checkpoint:** Commands/options/capability tables in T10–T12 match Commander and
   template tests; no document calls machine output approval or `--dry-run` global.
8. **Release checkpoint:** The reviewed head SHA has green CI and no unresolved review threads
   before roadmap closeout and squash merge.

## Validation Gates

Run narrow evidence during each task and the following integrated gates after T9–T12:

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

After review fixes, rerun the affected focused test and all integrated gates whose inputs changed.
Do not add or run an exhaustive strategy × field × format matrix: the pure engine, one real SQLite
fixture, one successful rating/stat action path, one partial failure, command safety cases, and one
cross-shell parity suite establish the required contract.

## Optimization Opportunities

- T2, T3, and T4 do not depend on reconciliation public types and can begin with T1. T5 can start
  as soon as T1 lands without waiting for the I/O foundations.
- Resolve a fresh adapter instance inside the action instead of widening query interfaces,
  cancellation contracts, Plex mapper fields, or architecture tests. Cancellation may remain
  cooperative between requests and writes for V1, as documented.
- Reuse shared rating normalization, tag writers, bounded parallel processing, pagination,
  prompt, formatter, and adapter-resolution seams. Test reconciliation's use of those seams rather
  than duplicating their exhaustive native-format or transport suites.
- Keep CSV projection in the command module as a fixed row union. The generic formatter can
  serialize those rows without changing shared formatter internals.
- Use one canonical guide and concise cross-links. This limits documentation drift and lets T10,
  T11, and T12 proceed without overlapping files.

## Implementation Strategy Recommendations

1. Keep the engine total and deterministic: return typed failures/findings rather than logging or
   throwing for ordinary drift.
2. Keep inventory historical: exact updates are allowed, deletion and arbitrary newest-row
   selection are not.
3. Keep stat maintenance independent of winner policy: the filesystem supplies verified
   `mtime`/`size`, while the winner flags govern rating only.
4. Make authorization an ordered state machine: validate strategy → produce preview → evaluate
   blockers → require `--execute` → require approval/`--yes` → reacquire → revalidate → mutate.
5. Preserve per-target truth across the non-transactional file/server/database boundary and let
   the post-scan decide convergence.
6. Use a new adapter instance for authoritative pre/post snapshots and public adapter capabilities
   only; no direct Plex imports or persisted server-local IDs.
7. Do not broaden scope when an observed field is unwritable. Artist, genre, and year remain
   explicit residual evidence in V1.
8. Assign every implementation and review fix to the task owner for that file. Agents share one
   feature worktree and must never revert concurrent changes.
