# Feature Spec: Issue 56 Action Test Coverage

## Executive Summary

Issue [#56](https://github.com/yandy-r/rfmedia-apps/issues/56) closes the remaining critical
action-test gaps for album verification, filter verification, incremental sync, and legacy tracking
migration. Existing verification suites already cover size mismatch, extra files, conflict
strategies, dry-run, force, trash, and staged repair, so this work extends them only for missing-file
truth and adds the missing sync and migration lifecycle contracts. The tests also expose documented
production defects: updated sync destinations can be skipped, manual tracking migration can report
success without persistence, custom history discovery and import can diverge, and cleanup can delete
unproven legacy state. The implementation fixes those defects at their existing library/action
boundaries, proves durable state before deletion, and reaches focused 80% statement/line coverage
without a new dependency or filler permutations.

## External Dependencies

### APIs and Services

No network API or service is required. The feature operates at local CLI, filesystem, and SQLite
boundaries.

### Libraries and SDKs

| Library               | Version | Purpose                                    | Change                           |
| --------------------- | ------- | ------------------------------------------ | -------------------------------- |
| Vitest                | 4.0.17  | Hoisted ESM mocks and focused action tests | Reuse; no dependency change      |
| `@vitest/coverage-v8` | 4.0.17  | Focused statement/line coverage report     | Reuse; no threshold change       |
| Node.js               | 22.x    | Temporary paths and filesystem contracts   | Reuse pinned runtime             |
| `fast-glob`           | 3.3.3   | Legacy sidecar discovery                   | Reuse behind an action-test mock |
| `better-sqlite3`      | 12.6.2  | Durable tracking/history persistence       | Reuse existing database layer    |

### External Documentation

- [Vitest `vi` API](https://v4.vitest.dev/api/vi): hoisted mocks, reset behavior, and spies.
- [Vitest module mocking](https://v4.vitest.dev/guide/mocking/modules): ESM and same-file-call limits.
- [Node.js 22 filesystem API](https://nodejs.org/download/release/v22.22.2/docs/api/fs.html):
  isolated temporary fixtures and non-recursive file operations.

## Business Requirements

### User Stories

- As a library operator, I want missing verification artifacts reported and repaired only after a
  successful recheck so that completeness is truthful.
- As an operator running incremental sync, I want new, updated, unchanged, downgraded, and failed
  work classified accurately so that inventory remains resumable.
- As an operator migrating legacy state, I want database read-back proof before cleanup so that
  `--delete-old` cannot destroy the only recoverable copy.
- As an automation consumer, I want dry-run and partial-failure results to be deterministic,
  structured, and prompt-free.
- As a maintainer, I want scenario-dense tests that identify the broken contract without a generic
  fake filesystem or duplicated strategy/layout matrices.

### Business Rules

1. **Verification truth comes from observation**: a successful repair call is insufficient; the
   selected tier must pass on re-verification.
2. **Conflict coverage is retained, not duplicated**: the existing mismatch/extra strategy matrix
   remains the proof for skip, overwrite, remove, keep, force, trash, ask, and dry-run.
3. **Updated sync work replaces its represented destination**: destination existence cannot turn a
   detected update into a skip, while a genuinely new collision still respects force policy.
4. **Sync success ordering is fixed**: materialize, hash final bytes, persist inventory, then count
   success. Any failed step prevents false persistence.
5. **Migration success means durable equivalence**: discovery and line counts are preview data, not
   proof of import.
6. **Migration identity includes input and options**: different input sidecars with the same options
   hash remain separate operations.
7. **Cleanup is proof-gated**: `--delete-old` applies only to files proven imported or already
   equivalent. Force bypasses confirmation only.
8. **Dry-run is mutation-free**: it does not initialize/write SQLite, copy, remove, unlink, persist
   inventory, prompt, or trigger a media scan.
9. **Resources close on all paths**: an initialized database is closed exactly once after success or
   failure.

### Edge Cases

| Scenario                                    | Expected behavior                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| Missing expected album/filter destination   | Report unresolved; fix only after staged recheck passes                 |
| Updated sync destination already exists     | Replace and persist as updated, without globally forcing new collisions |
| Source directory is missing                 | Return `ENOENT` and continue with later sources                         |
| Downgraded destination is absent            | Count as already deleted without calling removal                        |
| Two sidecar basenames share an options hash | Create/import distinct operation identities                             |
| Custom history path is supplied             | Discover and import from the same resolved directory                    |
| Migration/import fails                      | Close database, retain all unproven files, surface stable failure data  |
| One unlink fails after proven migration     | Continue safe sibling deletion and aggregate the failed path/code       |
| Malformed legacy history                    | Do not report/import/delete it as a successful session                  |

### Success Criteria

- [ ] The existing verify suites prove missing detection, successful repair, and failed recheck.
- [ ] Sync proves classification, continuation, downgrade cleanup, lifecycle, and scan gating.
- [ ] `migrate-tracking.test.ts` proves durable import, identity, custom path, routing, cleanup, and
      close-on-error.
- [ ] No unproven legacy file becomes deletion-eligible.
- [ ] Each named action reaches at least 80% statements and lines in the focused V8 report, using
      only distinct behavioral partitions.
- [ ] Full rfmedia tests, typecheck, repository hooks, markdown lint, and registered CI pass.

## Technical Specifications

### Architecture Overview

```text
Commander / MCP entry
        |
        v
exported action boundary ------------------------> structured result
  |             |               |
  v             v               v
verification   sync diff       migration orchestration
and repair     and inventory   |-- tracking importer
  |             |               |-- history importer
  v             v               |-- proof-gated cleanup
filesystem / tier adapters      v
                         existing SQLite tables
```

Action tests mock lower-level boundaries and assert exported results plus observable mutation,
ordering, and cleanup. Library-owned persistence tests use a temporary SQLite database where actual
read-back is the contract.

### Architecture Design

- Keep verification test harnesses separate because album and filter layout/evidence ownership
  differs; add no shared abstraction without a third stable consumer.
- Carry classification-aware overwrite intent from the sync loop into `syncFile()` so only updated
  entries bypass an existing-destination skip.
- Reuse a single library-owned legacy tracking importer rather than copying its parser/database
  writes into `migrate-tracking.ts`.
- Allow the history importer to receive an optional directory while preserving the default.
- Return/import enough proof to derive cleanup eligibility from persistence, not discovery.
- Wrap migration work in exception-safe database cleanup.

### Data Models

No schema migration is required. Existing tables remain authoritative:

| Table                | Relevant fields                                                | Contract                                                                |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `operations`         | `command`, `mode`, `input_file`, `options_hash`, status/counts | Preserve `(input_file, options_hash)` identity and truthful final state |
| `completed_sources`  | `operation_id`, `source_path`                                  | Durable completed sidecar equivalence                                   |
| `failed_sources`     | `operation_id`, `source_path`, `error_message`                 | Durable failed sidecar equivalence                                      |
| `history_sessions`   | session identity/header fields                                 | Durable legacy history session equivalence                              |
| `history_operations` | operation data linked to session                               | Validate/import complete session operations                             |
| `inventory`          | source/destination fingerprint fields                          | Sync ordering and downgrade reconciliation                              |

### API Design

No HTTP or public JSON schema is added. Internal compatibility-preserving seam changes are allowed:

- legacy tracking import accepts the database, operation identity, and optional sidecar paths and
  returns counts plus successful-file proof;
- history migration accepts an optional history directory defaulting to `getHistoryDir()`;
- sync receives explicit updated-entry overwrite intent without changing CLI options;
- contained per-file migration/deletion failures continue using `MigrateResult.errors`; action-wide
  initialization failures may reject after resource cleanup.

### System Integration

#### Files to Create

- `packages/rfmedia-cli/src/actions/migrate-tracking.test.ts`: action-level migration contracts.

#### Files to Modify

- `packages/rfmedia-cli/src/actions/verify-album.test.ts`: missing detection/repair/recheck.
- `packages/rfmedia-cli/src/actions/verify-filter.test.ts`: eligible missing mapping/repair/recheck.
- `packages/rfmedia-cli/src/actions/sync.test.ts`: diff, continuation, deletion, lifecycle, scan.
- `packages/rfmedia-cli/src/actions/sync.ts`: classification-aware updated replacement and any
  directly proven cleanup guard.
- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: durable tracking import, identity-safe
  grouping, history directory forwarding, proof-gated cleanup, and `finally` close.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: reusable legacy import seam/proof.
- `packages/rfmedia-cli/src/lib/history.ts`: optional directory and atomic/equivalent outcome where
  required by the regression tests.
- `packages/rfmedia-cli/README.md`: correct migration behavior details only if wording must reflect
  the strengthened proof contract.
- `ROADMAP.md`: remove #56 from live backlog/sprint/theme references and record completion.

#### Configuration

No command, option, dependency, database schema, completion template, or MCP schema change.

## UX Considerations

### User Workflows

1. **Preview**: dry-run discovers and classifies work, returns exact proposed counts, and mutates
   nothing.
2. **Execute**: the action performs only authorized writes and records success after persistence.
3. **Partial failure**: independent work continues where safe; failed paths/codes remain visible and
   recoverable state stays intact.
4. **Cleanup**: the operator confirms only a proof-filtered list; force skips the prompt but not the
   proof.
5. **Success**: summary counts match observed filesystem/database state.

### UI Patterns

This is a CLI. Tests assert structured results and stable paths/codes; decorative logger, spinner,
table, and prompt rendering are outside the action contract unless notification is itself required.

### Accessibility Requirements

- Machine and non-interactive modes must not require a TTY decision.
- Failures must be understandable from text plus stable structured fields, without relying only on
  color or glyphs.

### Performance UX

- Keep fixtures tiny, serial, deterministic, and independent of home/cwd state.
- Use real temporary storage only where path or SQLite durability matters; mock destructive calls.
- Run focused files first and the full package suite second to detect mock leakage.

## Recommendations

### Implementation Approach

1. Extend the mature verification suites only at their missing-artifact seams.
2. Expand sync orchestration coverage and land the smallest classification-aware update fix.
3. Establish reusable migration proof at the library boundary, then make action cleanup consume it.
4. Measure focused coverage and add only a test for a new contract partition when a file remains
   below target.
5. Update ROADMAP/docs, audit Bash/Zsh/Fish as unchanged, and run the full lifecycle gates.

### Technology Decisions

| Decision              | Recommendation                             | Rationale                                                                      |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Test stack            | Existing Vitest/V8                         | All required capabilities are installed                                        |
| Filesystem strategy   | Hybrid temporary paths plus narrow mocks   | High fidelity without destructive risk                                         |
| Migration persistence | Reuse library owner and real-DB proof test | Prevents action-level mock-only false confidence                               |
| Coverage              | Per-file focused command                   | Honors issue target without global scope expansion                             |
| Child issues          | None                                       | Defects are local prerequisites for truthful #56 tests and fit one coherent PR |

### Future Enhancements

- Consider a dedicated migration result taxonomy only if later commands need the same proof states.
- Consider a shared scenario helper only after a third suite repeats the same stable domain setup.
- Track broader sync destination-hardening separately if it cannot be demonstrated within the
  issue's downgrade cleanup contract.

## Risk Assessment

### Technical Risks

| Risk                                                   | Likelihood | Impact   | Mitigation                                     |
| ------------------------------------------------------ | ---------- | -------- | ---------------------------------------------- |
| Count-only migration enables destructive false success | High       | Critical | Require durable importer proof before cleanup  |
| Same-hash inputs collide                               | Medium     | High     | Group by input plus hash and regression test   |
| Custom history path imports another directory          | High       | High     | Forward one resolved directory into importer   |
| Updated sync silently skips                            | High       | High     | Carry updated classification to write decision |
| Resource leak after import failure                     | Medium     | Medium   | Close in `finally`, test rejection path        |
| Mock leakage makes suite order-dependent               | Medium     | Medium   | Restore defaults and run full package suite    |
| Coverage chasing adds brittle tests                    | Medium     | Medium   | Admit only distinct contract partitions        |

### Security Considerations

#### Critical — Hard Stops

| Finding                          | Risk                                           | Required mitigation                                                                   |
| -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Unpersisted tracking cleanup     | Loss of resumability state                     | No deletion without durable equivalence proof                                         |
| Discovery/import path divergence | Deletion of state from an unimported directory | Bind discovery, import, and cleanup to one root                                       |
| Unvalidated cleanup target       | Deletion outside intended target               | Canonical containment and regular-file checks where the action trusts persisted paths |

#### Warnings — Must Address

| Finding                     | Risk                                        | Mitigation                               | Alternative                                                    |
| --------------------------- | ------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Hash-only grouping          | Cross-input state merge                     | Include input identity                   | Retain collided files and fail closed                          |
| Partial history parse       | Incomplete undo state reported successful   | Validate/commit session atomically       | Retain source and surface error                                |
| Mock-only persistence proof | Tests pass while database writes are absent | One real temporary SQLite read-back test | Existing lower-level integration proof if exact seam is reused |

#### Advisories — Best Practices

- Use fixed isolated paths and never real worktree glob/delete operations.
- Prefer stable structured failure fields over full logger snapshots.
- Preserve existing completion parity; no template edit is required without a CLI surface change.

## Task Breakdown Preview

### Phase 1: Verification and sync contracts

- Extend album/filter suites for missing truth and re-verification.
- Extend sync suite for classification, continuation, deletion, lifecycle, and scan gating.
- Land only the production sync fixes demonstrated by those contracts.

### Phase 2: Migration proof and action coverage

- Reuse/strengthen library-owned tracking and history import seams.
- Make migration grouping, cleanup eligibility, and resource handling fail closed.
- Add migration action tests plus focused real-DB equivalence proof.

### Phase 3: Coverage and closeout

- Reach focused per-file 80% statement/line coverage with meaningful partitions.
- Run package/repository gates, update ROADMAP/docs, audit completions, review, CI, squash merge, and
  cleanup.

## Decisions Needed

1. **Production fixes discovered by tests**
   - Decision: include them in the same PR.
   - Rationale: documented behavior already promises durable migration and successful-only cleanup;
     tests that accept current behavior would codify data loss.
2. **Coverage interpretation**
   - Decision: target 80% statements and lines per named action file with a focused report.
   - Rationale: aggregate coverage could hide an untested migration action.
3. **Cleanup granularity**
   - Decision: delete only individually proven files; retain unproven siblings.
   - Rationale: partial success must remain recoverable.
4. **Child issues**
   - Decision: none required at design time; create one only if implementation uncovers a separable
     defect that cannot safely fit the coherent action-test PR.

## Research References

- [research-external.md](./research-external.md): Vitest, Node, and dependency guidance.
- [research-business.md](./research-business.md): action contracts and operator outcomes.
- [research-technical.md](./research-technical.md): exact boundaries, matrix, and coverage baseline.
- [research-ux.md](./research-ux.md): deterministic developer/operator feedback.
- [research-security.md](./research-security.md): data-loss and deletion risk classification.
- [research-practices.md](./research-practices.md): reuse, KISS, and testability constraints.
- [research-recommendations.md](./research-recommendations.md): synthesized implementation choices.
