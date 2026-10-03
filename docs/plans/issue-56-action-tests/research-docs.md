# Documentation Research: Issue 56 Action Tests

Issue #56 is governed primarily by the existing rfmedia verification, sync, tracking, and history
documentation. Those guides already state the intended observe-repair-recheck and
materialize-hash-persist contracts; the principal documentation work is to make manual migration's
durability and cleanup guarantees explicit and to close all live ROADMAP references.

## Architecture Docs

- `docs/plans/issue-56-action-tests/feature-spec.md`: **Required.** Source of truth for scope,
  business rules, affected seams, success criteria, and the no-new-schema/no-new-option decision.
- `docs/plans/issue-56-action-tests/research-architecture.md`: **Required.** Maps command, action,
  filesystem, inventory, database, and migration-import boundaries, including resource ownership.
- `docs/plans/issue-56-action-tests/research-patterns.md`: **Required.** Defines exported-action
  testing, ESM mock lifecycle, sync ordering, migration proof, and fixture patterns.
- `packages/rfmedia-cli/CLAUDE.md`: Package architecture and development contract: NodeNext ESM,
  command/action separation, Node 22, package scripts, and colocated Vitest conventions.
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`: SQLite schema and ownership,
  inventory producers, write/failure ordering, and legacy import behavior. Audit unchanged unless
  the implementation changes a documented public migration behavior or schema.
- `packages/rfmedia-cli/docs/features/tracking-system.md`: Database/legacy routing and automatic
  completed/failed sidecar import. Audit unchanged; the reusable importer must preserve this path.
- `packages/rfmedia-cli/docs/features/undo-history-system.md`: History schema and JSONL migration.
  Update its migration notes to distinguish automatic undo migration from explicit
  `migrate-tracking`, document custom-directory forwarding, and state proof-gated preservation.

## API/Feature Docs

- `packages/rfmedia-cli/docs/features/verify-command.doc.md`: **Required for verification work.**
  Missing outcome semantics, expected-set selection, machine counters, and final exit status.
  Audit unchanged because the requested fixes enforce its current contract.
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`: **Required for verification work.**
  Repair authorization, staged proof, dry-run exclusions, final recheck, and unresolved outcomes.
  Audit unchanged.
- `packages/rfmedia-cli/docs/features/sync-command.doc.md`: **Required for sync work.** Defines
  new/updated/unchanged/downgraded classification, write-hash-persist ordering, continuation,
  dry-run, and Plex scan gating. Audit unchanged if the fix merely makes updated existing
  destinations honor this already-documented behavior.
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`: Final-artifact
  fingerprint ownership and failure ordering shared by copy/sync. Audit unchanged.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`: Documents both migration aliases and
  existing options. Audit unchanged because issue #56 adds no command or option.
- `docs/features/dry-run-mode.md`, `docs/features/error-handling.md`, and
  `docs/features/output-formats.md`: Repository-wide expectations for mutation-free preview,
  structured failures, and machine output. Useful consistency checks; no planned edits.

## Development Guides

- `packages/rfmedia-cli/docs/testing/troubleshooting.md`: **Required.** Explains
  `vi.clearAllMocks()` versus `vi.resetAllMocks()`, hoisted mocks, implementation restoration, and
  suite-order failures directly relevant to the four action suites.
- `packages/rfmedia-cli/vitest.config.ts`: Executable test documentation: Node environment,
  `src/**/*.test.ts`/`src/**/*.spec.ts` discovery, V8 coverage, and exclusions. Audit unchanged; do
  not add a global threshold for this focused issue.
- `packages/rfmedia-cli/package.json`: Canonical package commands and dependency/runtime contract:
  `test:run`, `test:coverage`, `typecheck`, build, architecture checks, Vitest 4, coverage-v8, and
  Node 22+.
- `.mise.toml`: Pins Node `22.22.2`; use `mise exec -- ...` for all verification commands.
- `.github/workflows/rfmedia-cli.yml`: Registered CI contract: Node 22, codegen drift, rf-common
  build, package typecheck, full coverage, and benchmark smoke run.
- `lefthook.yml` and `docs/lefthook-usage.md`: Real pre-commit/pre-push gates and the required
  `npm run test:run` wrapper behavior (`umask 022`, no inherited `FORCE_COLOR`).
- `.github/pull_request_template.md`: Required delivery evidence, including exact test outcomes,
  `Closes #56`, risk, rollback, and documentation rationale.

## README Files

- `packages/rfmedia-cli/README.md`: **Must update if the migration behavior changes as specified.**
  In `rfmedia migrate-tracking`, clarify that success means durable SQLite equivalence, that
  `--delete-old` deletes only individually proven files, that `--force` skips only confirmation,
  and that `--history-path` governs both discovery and import. Its sync and verify sections should
  otherwise be audited unchanged because they already describe the target contracts.
- `README.md`: Repository/package navigation only; audit unchanged because no installation,
  top-level command surface, or service behavior changes.
- `docs/README.md`: Documentation index; audit unchanged unless an edited/new migration guide needs
  an index entry.

## Code Documentation

- `packages/rfmedia-cli/src/actions/migrate-tracking.ts`: Module and function JSDoc describe
  discovery/import/cleanup; the in-function TODO explicitly exposes count-only tracking migration.
  Update comments while implementing so they no longer claim migration without persistence.
- `packages/rfmedia-cli/src/commands/migrate.ts`: Command JSDoc, alias, option descriptions, mutual
  exclusion, and JSON projection are the public CLI contract. No option-text change is required.
- `packages/rfmedia-cli/src/lib/completed-tracker.ts`: `migrateLegacyTracking()` and
  `initializeTracking()` comments document the existing completed/failed importer that manual
  migration should reuse rather than duplicate.
- `packages/rfmedia-cli/src/lib/history.ts`: `migrateLegacyHistory()` comments and history-directory
  helpers own JSONL import and default path semantics; update JSDoc if an optional directory or
  successful-file proof becomes part of the internal API.
- `packages/rfmedia-cli/src/actions/sync.ts`: `syncFile()`, `deleteDowngradedFiles()`, and the source
  orchestration comments define materialization, inventory recording, missing-destination handling,
  and contained failures. Keep comments aligned with classification-aware replacement.
- `packages/rfmedia-cli/src/actions/verify-album.ts` and
  `packages/rfmedia-cli/src/actions/verify-filter.ts`: Fix-function JSDoc says missing files are
  recopied and the action performs final re-verification; tests must prove those comments truthful.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: All already expose the migration,
  sync, and verify options. Audit parity unchanged and run
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`; do not edit templates without
  a CLI-surface change.

## External References

- [Vitest `vi` API](https://v4.vitest.dev/api/vi): hoisting, `vi.hoisted`, clear/reset behavior,
  spies, and restoration.
- [Vitest module mocking](https://v4.vitest.dev/guide/mocking/modules): ESM transformation and the
  same-file-call limitation behind exported-action boundary tests.
- [Vitest mock-function API](https://v4.vitest.dev/api/mock): sequenced resolved/rejected outcomes
  for initial verification, repair, and recheck.
- [Node.js 22.22.2 filesystem API](https://nodejs.org/download/release/v22.22.2/docs/api/fs.html):
  isolated temporary directories plus `readFile`, `readdir`, `unlink`, and cleanup semantics.
- [`fast-glob` README](https://github.com/mrmlnc/fast-glob): `cwd`, absolute result paths, and
  discovery behavior that migration action tests must mock safely.

## Must-Read Documents

1. `docs/plans/issue-56-action-tests/feature-spec.md` — accepted behavior and completion scope.
2. `docs/plans/issue-56-action-tests/research-technical.md` — exact scenario matrix, mock seams,
   focused coverage command, and ROADMAP/CI closeout.
3. `docs/plans/issue-56-action-tests/research-security.md` — deletion, containment, malformed input,
   durable equivalence, and resource-cleanup hard stops.
4. `docs/plans/issue-56-action-tests/research-practices.md` — KISS/reuse boundaries and prohibitions
   against filler tests, test-only exports, and a generic fake filesystem.
5. The action-specific feature guide: verify docs for verification tasks, `sync-command.doc.md` for
   sync, and README plus tracking/history docs for migration.
6. `packages/rfmedia-cli/docs/testing/troubleshooting.md` — mock lifecycle before editing any suite.

## Documentation Gaps

- **Must update — `ROADMAP.md`:** remove all three live #56 backlog/sprint/theme references (current
  entries under rfmedia current focus, medium-priority backlog, and test infrastructure) and record
  shipped completion consistently. Audit `docs/roadmap-archive.md` unchanged unless repository
  closeout convention requires a historical entry.
- **Must update — migration user contract:** `packages/rfmedia-cli/README.md` currently says files
  are removed after “successful migration” but does not define durable read-back, per-file cleanup
  eligibility, force semantics, partial success, or custom-path import consistency.
- **Must update — history migration guide:** `undo-history-system.md` contains superficially
  conflicting “automatic migration” and “not automatically migrated” wording and only documents
  the default-directory library call. Clarify command-specific behavior when the importer changes.
- **Audit unchanged — verify and sync guides:** their stated contracts already match the desired
  behavior; implementation and regression tests should restore conformance rather than rewrite the
  promises.
- **Audit unchanged — schema and migrations:** no SQLite schema migration is planned. Keep
  `centralized-tracking-db.doc.md`, schema-version text, and database migration docs unchanged unless
  implementation unexpectedly changes persistence shape.
- **Audit unchanged — completions:** no CLI option changes are planned; verify Bash/Zsh/Fish parity
  and the template suite, then explicitly report no edits.
- There is no dedicated manual migration feature guide beyond the README. If the strengthened
  migration contract becomes too large for that section, create one later and index it; issue #56
  does not require a new document when concise README corrections are sufficient.
