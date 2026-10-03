# Documentation Research: Content Hashing During Copy Operations

## Architecture Docs

### Required

- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` is the most important existing
  architecture document to correct. It still says schema version 1, shows an inventory table without
  `genre`, `year`, `bpm`, `artist`, or `content_hash`, and describes inventory as sync-only. Update it
  to schema version 9, nullable legacy hashes, current album/filter/sync producers, the guarded v8-to-v9
  migration, and the write -> hash -> inventory -> completion ordering.
- Add a focused package feature document at
  `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`. No current document
  explains persisted write-time fingerprints. It should define lowercase SHA-256, regular-copy
  streaming, converted-output hashing, hardlink snapshot semantics, legacy `NULL`, tracking-disabled
  behavior, dry-run behavior, failure behavior, and the explicit inventory-backed scope.
- `ROADMAP.md` has three current #111 references at lines around 73, 139, and 252. Mark all as shipped,
  credit PR #233 as the initial implementation, and add the closeout PR link once available. Preserve
  #116 as downstream read-time verification work.

### Nice to have

- `docs/architecture/data-flow.md` accurately documents the general command -> action -> lib flow.
  Add an rfmedia hash/persistence diagram only if the new feature document would otherwise duplicate
  substantial architecture; no system-wide architecture change requires it.
- `docs/architecture/overview.md` needs no required change because package dependencies and system
  layers are unchanged. A link to the new rfmedia feature document is optional.
- `packages/rfmedia-cli/docs/features/tracking-system.md` correctly explains unified SQLite tracking
  and granular completion. A short cross-link to the new hash document and a note that new
  database-inventoried rows carry final-artifact fingerprints would improve discoverability.

Do not edit the historical plan/report under
`docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md` and
`docs/prps/reports/content-hashing-during-copy-operations-report.md`; they are evidence of PR #233,
not current canonical architecture.

## API/CLI Docs

### Required

- `packages/rfmedia-cli/README.md` is the canonical CLI reference and currently contradicts the code:
  its “Inventory Table Empty” section says copy never populates inventory and the table is sync-only,
  while PR #233 added album/filter inventory writes. Update the copy, sync, tracking database,
  troubleshooting, and schema/table-summary sections.
- In that README, distinguish persisted fingerprints from `--verify`:
  - persisted SHA-256 is quiet and automatic only for successful SQLite-inventoried writes;
  - ordinary stream hashing fingerprints bytes submitted to the writer and is not destination
    read-back proof;
  - `--verify` remains the explicit source/destination comparison for byte-identical copies;
  - converted files hash final converted output, while immediate source/output comparison remains
    inapplicable;
  - hardlink hashes are snapshots and can become stale after writes through any linked path;
  - legacy and migrated rows can have `NULL`, meaning unknown rather than mismatch;
  - legacy/disabled tracking and dry-run create no hidden SQLite hash row.
- Correct README troubleshooting text that says tracking errors are warnings that do not stop copy.
  For an in-scope row, hash or database failure cannot be documented as successful completion with an
  unknown digest.
- `docs/features/file-integrity-verification.md` is the existing detailed `--verify` guide. Add a
  concise cross-link/note separating read-back comparison from the new persisted write-time
  fingerprint. The same distinction should appear in the shorter
  `docs/features/file-integrity-quick-reference.md` if it remains a supported user entry point.

### Nice to have / no-op

- `packages/rfmedia-cli/docs/features/verify-command.doc.md` and
  `verify-auto-fix.doc.md` do not need behavioral rewrites; #116 owns future stored-hash comparison.
  A cross-link is optional.
- MCP tool names, schemas, and output envelopes are unchanged. The existing MCP catalog in
  `packages/rfmedia-cli/README.md` needs no new fields; queue/MCP inherit behavior by delegation.
- Command help and bash/zsh/fish completion text are unchanged because there is no `--hash`,
  `--no-hash`, or algorithm option. Do not edit `src/lib/shell-completions/{bash,zsh,fish}.ts`; run
  `src/lib/shell-completions/templates.spec.ts` to prove the no-op.
- Plex query copy, Plex playlist export/sync, verify repair, video linking, and non-inventoried watch
  behavior are deferred. Do not imply their files are hash-inventoried.

## Development Guides

### Required

- `packages/rfmedia-cli/docs/features/graceful-interruption.md` should document that the hash-copy
  stream receives the operation `AbortSignal`, retries create fresh stream/hash state, and cleanup is
  limited to a newly created partial destination. It must not promise deletion of pre-existing paths.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md` should identify the paired cases in
  `benchmarks/copy.bench.ts`: tracked SQLite baseline with hashing disabled versus the same tracked
  workload with hashing enabled. Document warmup/repetition, median/spread reporting, direct-copy
  versus hardlink/conversion cost models, and that `<5%` is evidence rather than a flaky CI assertion.
- `packages/rfmedia-cli/docs/features/sync-command.doc.md` should mention that database-backed sync
  inventory rows include the SHA-256 of the represented final destination and that legacy/file-backed
  inventory can omit it.
- Add exact validation commands to the implementation report/PR testing section rather than a
  permanent guide: focused filesystem/DB/action tests, completion template tests, package typecheck,
  full package tests/build, root gates, benchmark command, and `git diff --check`.

### Nice to have

- `packages/rfmedia-cli/CHANGELOG.md` has an `[Unreleased]` section but no PR #233 content-hashing
  entry. Add a concise entry if repository release practice treats closeout hardening as notable;
  describe both the existing fingerprint foundation and the hardening, without claiming read-time
  verification.
- `packages/rfmedia-cli/docs/testing/troubleshooting.md` only needs an update if new deterministic
  cancellation or SQLite compatibility tests introduce a reusable testing technique.
- `packages/rfmedia-cli/CLAUDE.md` / `AGENTS.md` are development instructions, not feature docs. Read
  and follow them; do not add issue-specific prose.

## README Files

| Path                                | Priority     | Required change                                                                                                                                          |
| ----------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/README.md`    | Required     | Correct inventory producer/schema claims; document fingerprint versus `--verify`, conversion, hardlink, `NULL`, tracking, dry-run, and failure semantics |
| `README.md`                         | Nice to have | No command/interface change; add a feature link only if this root overview maintains rfmedia feature highlights                                          |
| `docs/README.md`                    | Nice to have | Add the new package feature document under “rfmedia CLI / Plex Features” for discoverability                                                             |
| `packages/rfmedia-cli/CHANGELOG.md` | Nice to have | Add an Unreleased closeout/hardening entry if expected by release practice                                                                               |

The package README update is mandatory because its current sync-only inventory statements are
factually stale. Root indexes should not block implementation if they do not normally enumerate
internal rfmedia behavior.

## Must-Read Documents

### Required before implementation

1. `docs/plans/content-hashing-during-copy-operations/feature-spec.md` — authoritative scope,
   compatibility, failure, testing, documentation, delivery, and no-op completion decisions.
2. `docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md` — intended PR #233
   implementation boundaries and historical exclusions; use as evidence, not current truth.
3. `docs/prps/reports/content-hashing-during-copy-operations-report.md` — exact shipped files,
   benchmark caveat, and validation from PR #233.
4. `packages/rfmedia-cli/README.md` — canonical user/CLI documentation and the stale inventory claims
   that must be corrected.
5. `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` — database lifecycle and schema
   guide, currently stale at schema version 1.
6. `packages/rfmedia-cli/docs/features/tracking-system.md` — completion/range semantics that hash
   persistence must not redefine.
7. `docs/features/file-integrity-verification.md` and
   `docs/features/file-integrity-quick-reference.md` — existing meaning of `--verify`; prevent
   terminology collision.
8. `packages/rfmedia-cli/docs/features/graceful-interruption.md` — current cancellation and partial
   cleanup promises.
9. `packages/rfmedia-cli/docs/features/performance-benchmarks.md` — repository benchmark conventions
   and reporting limits.
10. `ROADMAP.md` — required closeout locations and the dependency order from #111 to #116.

### Useful references

- `packages/rfmedia-cli/docs/features/audio-conversion.doc.md` — conversion output and ffmpeg
  behavior; useful when documenting final-output hashing.
- `packages/rfmedia-cli/docs/features/sync-command.doc.md` — inventory user flow and legacy routing.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md` and
  `docs/features/shell-completion.md` — confirm why no template content change is needed.
- `docs/architecture/data-flow.md` — general command/action/lib pattern.

## Documentation Gaps

1. There is no canonical document for persisted content fingerprints; existing “file integrity” docs
   only describe opt-in `--verify` comparison.
2. `packages/rfmedia-cli/README.md` incorrectly states that copy does not populate inventory and that
   inventory is sync-only.
3. `centralized-tracking-db.doc.md` documents schema version 1 and an obsolete inventory schema rather
   than version 9 and `content_hash`.
4. No user documentation defines `NULL` as legacy/unknown, explains the lack of automatic backfill,
   or states that tracking-disabled/legacy modes create no SQLite hash row.
5. Write-time fingerprinting is easy to overstate as destination verification. Documentation needs a
   consistent vocabulary: “fingerprint” for stored write/finalization SHA-256 and “verification” only
   for a later comparison/read-back.
6. Hardlink mutability and conversion semantics are not connected to persisted hashes.
7. Failure documentation does not yet state that hash/DB failure prevents successful completion for
   an in-scope inventory row, or describe ownership-bounded partial cleanup.
8. The existing performance report claims a faster hash-enabled sample but does not provide repeated
   variance evidence. The closeout needs a reproducible benchmark report and an honest
   pass/inconclusive conclusion against `<5%`.
9. Scope exclusions are undocumented. The new feature doc must explicitly defer Plex/playlist,
   repair/video-link, one-to-many ranged artifact storage, read-time verification, dedupe indexes,
   and backfill.
10. `ROADMAP.md` still presents #111 as pending despite PR #233's initial implementation.
