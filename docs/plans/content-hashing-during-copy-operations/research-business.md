# Business Research: Content Hashing During Copy Operations

## Executive Summary

GitHub issue #111 establishes SHA-256 as a durable identity for files materialized by rfmedia copy
workflows. The user value is not displaying checksums during a copy; it is making every successful
destination artifact addressable and later verifiable by content. This is foundational data for
deduplication (#38), default hash verification (#116), and library-health duplicate advisories
(#120). Those consumer features are explicitly downstream and are not implementation scope for
issue #111.

The repository already contains an implementation shipped in the earlier PR #233. Schema version 9
adds `inventory.content_hash`; album copy, filter copy, and sync calculate hashes for some successful
destinations; and `copyOrLinkWithHash()` hashes ordinary copy streams without a second read. That work
is a useful baseline, but it does not yet prove the current issue's stated "every copy operation"
contract.

The remaining acceptance gaps are material:

- `inventory` is unique on `(operation_id, source_path, relative_path)`, so ranged or repeated copies
  of one source file can replace each other instead of retaining one record per destination.
- `sync` explicitly records only the first ranged destination.
- watch invokes low-level copy actions without a tracking context, while Plex query copy and Plex
  playlist export/sync use separate direct copy loops with no content-hash persistence.
- copy hashing is coupled to completed-source tracking; disabling completion tracking can also remove
  the hash record even though a destination was created.
- filter-copy skip paths adopt and hash existing files, while album, sync, and Plex skip paths do not
  follow one consistent adoption rule.
- some hashes are calculated before post-copy hooks or rating/tag synchronization can mutate the
  destination, so the stored value is not necessarily the hash of the final committed bytes.

Completion should therefore be defined by a destination-artifact invariant: every successful,
non-dry-run artifact produced or adopted by an in-scope copy workflow has exactly one durable SQLite
record containing the lowercase SHA-256 of its final bytes. A filesystem write and its database record
form one logical outcome; neither alone is success.

## User Stories

1. As a user copying an artist, album, or selected tracks, I want every destination file recorded by
   content so later tools can identify it even if timestamps or paths change.
2. As a user creating a numbered range, I want every numbered destination represented independently;
   the last suffix must not erase earlier suffix records.
3. As a user converting audio during copy, I want the hash to identify the converted destination,
   not the source encoding.
4. As a user choosing hardlinks, I want the recorded hash to describe the linked bytes at the moment
   the operation commits, with clear snapshot rather than immutability semantics.
5. As a user running `sync`, `watch`, queued copy jobs, MCP copy tools, Plex query copies, or Plex
   playlist exports, I expect the same integrity guarantee as an equivalent direct `rfmedia copy`.
6. As a user resuming a copy where a destination already exists, I want rfmedia either to leave it
   explicitly unadopted or to validate and record it; a silent "completed" state with no content
   identity is not acceptable.
7. As a user whose copy, conversion, hash, or database write fails, I want a non-success result with
   no trusted-but-stale hash record and no completed marker for the failed artifact.
8. As a user of an existing schema-version-8 or schema-version-9 database, I want migration to retain
   all tracking data, with older unhashed rows represented as unknown rather than fabricated.
9. As an operator, I want hashing overhead to stay below the issue's 5% target under a reproducible,
   like-for-like benchmark.
10. As a downstream feature author, I want a stable query boundary for destination paths and hashes
    without requiring #111 to implement dedupe, tiered verification, or health analytics.

## Business Rules

### Artifact and hash invariants

1. An artifact is a regular destination file materialized or explicitly adopted by an in-scope copy
   workflow. Direct copies, cross-device hardlink fallbacks, hardlinks, converted audio, subsequent
   ranged copies, renamed conflict results, and overwritten results are artifacts. Directories,
   symlinks, special files, dry-run projections, filtered-out files, and failed writes are not.
2. Each artifact has its own durable record keyed by destination identity within the logical copy
   operation. Multiple destinations derived from one source path must coexist.
3. Every newly committed artifact has a non-null SHA-256 encoded as exactly 64 lowercase hexadecimal
   characters. `NULL` is reserved for legacy/pre-feature rows or explicitly unsupported historical
   data, never for a new successful in-scope artifact.
4. The digest is calculated from the final destination bytes after conversion and after any in-scope
   post-copy byte mutation such as rating/tag synchronization. It is not a source hash unless the
   destination bytes are identical by construction.
5. The persisted destination path must be the actual final path after conflict rename, suffix
   assignment, output-folder selection, conversion extension changes, and path normalization.
6. `copied_at` represents the commit of the artifact record, not the start of the copy.
7. Source metadata used for incremental-change detection and destination identity metadata must not
   be conflated. A converted file may have a different destination size and timestamp even though its
   inventory source snapshot remains unchanged.

### Completion and adoption

8. Success requires both a complete destination artifact and its durable hash record. Completion
   markers, created counters, after-copy success hooks, and operation success/partial status must not
   advance before that logical commit.
9. A skipped existing file is not a new copy. If rfmedia merely declines a conflict, it does not need
   a new artifact record. If rfmedia adopts the existing file as a completed copy, uses it as the base
   for subsequent copies, or heals missing inventory, it must hash the existing final bytes and store
   the same artifact record that a newly created destination would receive.
10. `--force`/overwrite replaces the artifact identity at the same destination. The new hash must
    replace only that destination's prior record; it must not delete sibling range destinations.
11. Conflict rename creates a distinct artifact at the generated path and stores that exact path.
12. Reusing an earlier destination as the source for later ranged copies does not change source
    provenance: the record retains the original logical source and the actual destination.

### Failure, cancellation, and recovery

13. Copy, hardlink, conversion, finalization, hashing, or SQLite persistence failure makes the
    artifact non-successful. It must be reported through existing failure/result conventions.
14. No completed-source or completed-suffix marker may be written for an artifact whose hash record
    did not commit.
15. A failed or cancelled write must not leave a trusted hash row. Any row being replaced must not be
    deleted until the replacement can commit.
16. Newly created partial destinations should be removed on failure or cancellation. If cleanup or
    rollback cannot complete, the operation is partial/failed and must report the destination for
    recovery; it must not be presented as successful.
17. Multi-file and multi-suffix work may commit successful artifacts independently, but database
    writes for one logical batch must be transactional so a partial SQL write cannot create false
    completeness.
18. Retrying the same logical artifact is idempotent: it updates that destination record rather than
    producing duplicates, while other destinations from the same source remain intact.

### Compatibility and performance

19. Hash persistence is an integrity concern independent of completed-source tracking. Turning off
    completion tracking must not silently turn off the issue #111 guarantee for actual copy output.
20. Dry-run performs no hashing reads, destination writes, schema mutations, or artifact-row writes.
21. Existing databases migrate without dropping operations, inventory, history, queue, Plex query,
    or playlist data. Existing null hashes remain unknown unless an explicit adoption/backfill path
    observes the destination bytes.
22. Normal human and JSON copy result shapes remain backward-compatible. Issue #111 introduces no
    required CLI option, so bash, zsh, and fish completion templates should not change unless later
    design deliberately adds a user-facing hash policy flag.
23. Hash values are sensitive operational metadata only to the same degree as stored paths. Normal
    logs and summaries should not print full hashes; debug/error output may identify the destination
    without exposing unrelated secrets.
24. The `<5%` target is measured against the identical tracked-copy workflow with hashing disabled,
    using the same fixture, database mode, worker count, filesystem, warmup, and iteration policy.
    Report medians at representative small-file and large-file scales; a faster noisy sample is not
    by itself proof.

## Workflows

| Workflow                  | Variants and edges                                                                                                                        | Required hash behavior                                                                                                                 | Current baseline                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Direct album copy         | Artist mode, `--album-only`, single/multiple sources, `--file`, `--paths`, per-path range, `--count`, nested directories, non-audio files | One record for every file in every suffix destination; converted audio hashes converted output; non-audio hashes copied/linked output  | Hashing exists, but inventory uniqueness can collapse suffix destinations; adopted complete suffixes are not consistently inventoried |
| Direct filter copy        | Rating, stars, smart filters, library-root/artist source, flat/preserved/album structure, range, conversion                               | Every selected destination gets its own final-byte hash; filtered-out files get none                                                   | Hashing exists through post-copy destination reads; repeated destinations can replace each other; hash can precede after-copy hooks   |
| Hardlink and fallback     | Requested hardlink, same-filesystem link, `EXDEV`/different-filesystem fallback, later suffix linked from first copy                      | Same digest for identical bytes; method records actual outcome; fallback behaves as copy                                               | Shared helpers support hashing in some album paths, while other actions use unhashed `copyOrLink()` and hash later or never           |
| Conversion                | First output converted, later suffix copied/linked from converted output, metadata/rating writes                                          | Hash final converted and post-tag bytes; never compare/store source digest as destination identity                                     | Album/filter/sync hash converted destinations in tracked paths, but Plex rating sync occurs after its copy and has no hash record     |
| Conflict handling         | Skip, overwrite, rename, incomplete destination recreation, interactive/apply-to-all                                                      | Skip is either explicit non-adoption or a hashed adoption; overwrite updates only the exact destination; rename records generated path | Filter skip heals inventory; album/sync/Plex skip behavior differs                                                                    |
| Incremental sync          | Album/filter modes, new/updated files, ranges, force, reset inventory, delete downgraded                                                  | Each created/updated destination is hashed; deletions remove or retire its artifact record; unchanged files retain prior identity      | Only the first suffix is appended to inventory; a new operation is created per run and needs careful state semantics                  |
| Watch                     | Album/filter watch modes, debounce, hardlink                                                                                              | Same guarantee as direct copy for each triggered batch                                                                                 | Calls `executeAlbumCopy()`/`executeFilterCopy()` without tracking context, so no SQLite hash record is created                        |
| Queue                     | Queued direct copy, single/multi-source serialization, retries                                                                            | Same guarantee as direct copy; queue transport must not alter artifact identity                                                        | Delegates to direct copy entrypoints and inherits their coverage and gaps                                                             |
| MCP                       | `rfmedia.copy.album`, `rfmedia.copy.filter`, `rfmedia.sync`                                                                               | Same guarantee and result semantics as CLI entrypoints                                                                                 | Delegates to the same actions and inherits their coverage and gaps                                                                    |
| Plex query copy           | Query-results/query modes, flat/preserved/album mode, range/count, conversion, hardlink, rating sync                                      | Every final destination is hashed after optional rating sync and stored with query/copy provenance                                     | Opens SQLite for query history but explicitly creates no copy operation or inventory hash rows                                        |
| Plex playlist export/sync | Flat/folder/preserved structure, range/count, conversion, later hardlinks, rating sync, delete removed                                    | Every exported destination is hashed after final mutation; sync removals retire corresponding records                                  | Direct copy loops do not persist content hashes; playlist-export tables store paths but are not wired by this action                  |
| Existing-file adoption    | Completed conflict skip, first-copy optimization, resume/range expansion                                                                  | Hash observed bytes before treating the artifact as trusted input or completed output                                                  | Implemented in selected filter paths, not consistently elsewhere                                                                      |
| Failure/abort             | Stream error, ffmpeg error, hash read error, DB error, hook error, SIGINT/SIGTERM, cleanup failure                                        | No success marker or trusted row; clean new partial artifact; report partial recovery if cleanup fails                                 | Ordering and cleanup differ by action; album batches defer DB write, while filter can persist before an after-copy hook               |

Repair writes from `verify --fix` and the separate `link-videos` hardlink command also create files but
are not primarily copy/export/sync workflows. They need an explicit scope decision rather than being
silently assumed covered. The recommended boundary for #111 is all commands whose purpose is copy,
export, or sync; repair and video-link provenance can be follow-up work if they do not consume the
same artifact ledger.

## Domain Model

| Concept              | Business meaning                                 | Required fields/constraints                                                                                                               |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Copy operation       | One resumable user intent and its status         | Stable operation ID, command/surface, mode/options identity, timestamps, counts, status                                                   |
| Logical source       | Original file selected by the user               | Normalized source root, relative source path, source snapshot metadata                                                                    |
| Destination artifact | One concrete materialized or adopted file        | Operation/provenance link, absolute final destination path, actual method, commit timestamp; unique per logical operation and destination |
| Content digest       | Snapshot identity of destination bytes at commit | Algorithm fixed to SHA-256 for v1, 64 lowercase hex characters, non-null for new successful artifacts                                     |
| Source snapshot      | Inputs used for incremental sync                 | Source mtime, source size, rating/metadata; distinct from destination size/mtime after conversion                                         |
| Adoption             | Existing destination accepted into trusted state | Same destination-artifact record and digest as a new copy, plus outcome distinguishable from newly created if reporting needs it          |
| Legacy unknown       | Historical row for which no bytes were observed  | Nullable digest; must never be interpreted as match, mismatch, or duplicate                                                               |

The current `inventory` row combines source snapshot and destination artifact. That is workable only if
its uniqueness includes destination identity and its readers do not reduce multiple destinations back
to a `Map<relativePath, entry>`. Otherwise a dedicated artifact table or a one-to-many inventory model
is required. The business contract matters more than the table name: one source may produce many
destinations, and every destination must remain queryable.

Hardlink digests are snapshots. A later write through any linked path can invalidate all stored
digests for that inode. Issue #111 should not claim hardlink immutability; #116 can later detect drift
by recomputing the destination hash.

## Existing Codebase Integration

- `packages/rfmedia-cli/src/lib/schema.sql` and `src/lib/migrations.ts` already define schema version
  9 and nullable `inventory.content_hash`, but there is no hash index and the inventory uniqueness is
  source-relative rather than destination-aware.
- `src/lib/db.ts` persists hashes with `INSERT OR REPLACE`. Combined with the current uniqueness rule,
  multiple suffix destinations for one source-relative path can replace prior rows.
- `src/lib/filesystem.ts` contains `copyOrLinkWithHash()`. It hashes ordinary copy chunks during the
  write and hashes hardlinks after creation. This is a strong primitive for byte-identical copies,
  but post-copy mutations still require hashing at the final commit point.
- `src/actions/copy-album.ts` batches inventory records after directory processing. It covers copied,
  linked, converted, and non-audio files when a database-backed tracking context exists. Completion,
  verification, hooks, cleanup, and database commit order should be unified around the artifact
  invariant.
- `src/actions/copy-filter.ts` computes destination hashes in `recordCopiedFileInventory()` and heals
  selected skipped-file rows. It writes before after-copy hooks complete, so hook failure or mutation
  can make result status and stored digest disagree.
- `src/actions/sync.ts` hashes only `suffixes[0]`, leaving later range destinations without records.
- `src/actions/watch.ts` invokes the lower-level copy actions without a tracking configuration. Queue
  and MCP paths delegate through the database-aware top-level entrypoints and therefore inherit, but
  do not independently solve, the direct-copy gaps.
- `src/actions/plex-copy.ts` documents that it creates no copy tracking operation. `src/actions/plex-playlist.ts`
  uses separate copy/link/convert loops and can mutate copied tags after creation; neither path stores
  hashes today.
- `src/lib/inventory.ts` loads rows into `Map<relativePath, FileInventoryEntry>`, which cannot represent
  multiple destination artifacts for the same source-relative path without a separate structure.
- `src/lib/integrity.ts` already provides SHA-256 calculation and source/destination comparison. Reuse
  its algorithm contract, but do not make #111 implement #116's user-facing verification tiers.
- `packages/rfmedia-cli/benchmarks/copy.bench.ts` has a like-for-like SQLite baseline and an internal
  hash-disabled escape hatch. Acceptance still needs repeated, statistically meaningful overhead
  reporting for representative file-size distributions.
- Existing command output, MCP schemas, and shell completions need no feature surface change if hash
  persistence stays unconditional and internal.

Downstream boundaries:

- #38 may query hashes and group equal digests, but duplicate reporting/cleaning strategy is not part
  of #111.
- #116 may recompute destination bytes and compare them with stored hashes, but quick/default/deep
  flags and verification UX are not part of #111.
- #120 may count potential duplicates or unknown hashes, but the health command, analytics output,
  and remediation advice are not part of #111.

## Success Criteria

1. A coverage matrix test proves all in-scope copy/export/sync entrypoints produce the same artifact
   invariant through CLI-equivalent actions, queue delegation, and MCP delegation.
2. For direct copy, hardlink, cross-device fallback, conversion, subsequent ranged copies, conflict
   rename, overwrite, sync, watch, Plex query copy, and Plex playlist export/sync, recomputing SHA-256
   from every successful final destination equals the stored 64-character lowercase digest.
3. A source file copied to N distinct range destinations produces N simultaneously queryable artifact
   records. Re-running one destination updates only that destination.
4. Converted outputs are tested with destination bytes that differ from the source. Rating/tag
   synchronization and a byte-mutating post-copy hook are tested so the stored digest matches the
   final post-processing state.
5. Dry-run, filtered-out, missing-source, failed copy, failed conversion, failed hash, failed DB write,
   and cancelled operations create no successful artifact row or completion marker.
6. Existing-file behavior is consistent across actions: explicit non-adoption creates no row;
   adoption/completion creates a digest-backed row before the file is trusted or reused.
7. Failure-recovery tests prove partial newly created destinations are removed where safe, stale rows
   are not retained, sibling range records survive, and cleanup failures are surfaced as partial/failed.
8. Migration tests cover at least schema version 8 to the final schema and an existing version-9
   database from PR #233. Existing rows and null legacy hashes are preserved.
9. Database/query tests prove downstream code can look up all artifacts for a digest and distinguish
   `NULL` (unknown) from a real digest without implementing downstream commands.
10. The benchmark compares identical tracked-copy paths with hashing on/off, includes small-file and
    large-file fixtures, performs warmups and repeated samples, and reports median overhead below 5%.
11. Existing copy/sync human output, JSON output, exit behavior, queue serialization, MCP schemas, and
    shell completion snapshots remain unchanged unless a separately approved interface decision says
    otherwise.
12. Package typecheck, focused action/DB/migration tests, full rfmedia test suite, root build/test gates,
    and the copy benchmark complete successfully.

## Open Questions

1. Does "every copy operation" include Plex query copy and Plex playlist export/sync? Recommendation:
   yes, because they are user-facing copy/export workflows and already use the same copy, conversion,
   hardlink, range, and rating-mutation semantics. If excluded, issue #111 must say so explicitly and
   a child issue must own their missing integrity records.
2. Should hash persistence remain available when `--no-track-completed` or legacy tracking is selected?
   Recommendation: yes. Completion tracking is optional behavior; integrity metadata for newly
   materialized files is the core promise of #111. Keep SQLite artifact persistence independent.
3. Should skipped existing destinations be adopted automatically? Recommendation: only when rfmedia
   marks them completed, heals inventory, or reuses them as a trusted first copy; otherwise leave them
   explicitly unadopted.
4. Should destination artifacts stay in `inventory` or move to a dedicated one-to-many table?
   Recommendation: choose the smallest migration that preserves one row per destination and gives
   consumers a stable lookup. Do not keep the current source-relative uniqueness.
5. Should `content_hash` be indexed now? Recommendation: add an index or an equivalent supported
   lookup because all three named downstream consumers group or compare by digest; validate the write
   cost against the 5% budget.
6. What is the finalization boundary for plugins? Recommendation: hash after any hook explicitly
   allowed to mutate destination bytes, and run observational hooks only after the artifact commits.
   If existing `afterCopy` hooks may mutate, document and test that ordering.
7. On DB persistence failure after a completed filesystem write, should rfmedia remove the new file or
   leave it for recovery? Recommendation: remove newly created files when safe; for overwrite or
   uncertain ownership, report a partial failure with exact recovery guidance rather than deleting
   user data blindly.
8. Should historical null hashes be backfilled? Recommendation: no eager migration-time backfill.
   Preserve `unknown`, and let a future explicit scan/adoption workflow observe current bytes.
9. Do repair writes from `verify --fix` and hardlinks from `link-videos` share the artifact ledger?
   Recommendation: decide explicitly. They are adjacent materialization paths, but they are not needed
   to complete the primary copy/export/sync contract if tracked by follow-up issues.
10. How is the `<5%` threshold enforced in CI without filesystem-noise flakiness? Recommendation: use
    repeated local/CI benchmark evidence and a regression envelope based on medians, with raw samples
    retained; do not gate on a single iteration.
