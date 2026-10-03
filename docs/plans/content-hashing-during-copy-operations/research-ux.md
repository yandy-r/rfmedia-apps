# UX Research: Content Hash Persistence During Copy

## Executive Summary

Issue #111 should feel like a reliability improvement, not a new CLI feature. In the default
database-backed workflow, every successfully completed copy should gain a stored SHA-256 baseline
without a new option, prompt, per-file message, or machine-output field. Existing copy summaries,
progress, and exit behavior should remain stable.

The most important user-facing distinction is between persistence and verification:

- Automatic hash persistence computes and stores an identity for the bytes written. It does not
  reread the destination and does not prove that durable storage can return those bytes later.
- Existing `rfmedia copy --verify` is an explicit, more expensive post-copy integrity check. It
  rereads source and destination for byte-identical copy/hardlink paths and fails the copy if their
  SHA-256 values differ. Issue #111 must not silently weaken, remove, or redefine it.
- Existing `rfmedia verify` checks expected files and optionally sizes. Issue #116 will later add
  quick/default/deep tiers and consume stored hashes as the default tier's baseline.

A copy is not successfully tracked until both the file operation and hash persistence succeed. If
hashing or the database write fails, do not mark the file, suffix, or source completed. Clean up the
new destination where safe, return a stage-specific failure, continue other independent files under
the current partial-success model, and exit nonzero when any failure remains. Rerunning the same copy
must naturally retry rather than requiring `--reset-completed`.

Schema migration should be automatic and quiet. Add the nullable hash column before filesystem
mutation, preserve existing inventory rows as "hash unavailable," and never launch an unbounded
backfill during normal startup. A migration failure should abort before copying and name the database
path plus the next action. Successful migration detail belongs in `--debug`, not normal output.

The `<5%` overhead target is part of the operator contract. Normal copy progress must continue moving
while hashing; the CLI should not sit at 100% during an unexplained hashing/database tail. Hardlinks
and conversions have different cost profiles and need explicit acceptance criteria rather than a
single average that hides slow paths.

## User Workflows

### 1. Ordinary copy with default database tracking

```bash
rfmedia copy /music/Artist /dest --range=001-005
```

Expected experience:

1. The command performs the same selection, conflict handling, copy, progress, and summary flow as
   before.
2. SHA-256 is computed as part of the file operation and stored with inventory metadata.
3. No digest is printed and no confirmation is requested.
4. `created`, `skipped`, `filtered`, `failed`, and exit status preserve their established meanings.
5. A successful file counts as created only after its required tracking write succeeds.

The current copy JSON contract contains command, mode, source, destination, and created/skipped/
filtered/failed counts. Internal persistence should not add raw hashes to this response. That avoids
large outputs and preserves scripts that treat copy as an operation summary rather than an inventory
export.

### 2. Copy with explicit post-write verification

```bash
rfmedia copy /music/Artist /dest --range=001-005 --verify
```

Expected experience:

- Automatic persistence still occurs.
- `--verify` still performs its additional readback check on supported byte-identical operations.
- The extra I/O and elapsed time remain attributable to the user's explicit option.
- A mismatch removes the bad destination where the current copy path promises cleanup, records a
  failed operation, and prevents completion tracking.
- Converted files remain a documented exception until product behavior is deliberately expanded;
  the current copy implementation skips source/destination integrity comparison for conversions.

Help text should continue describing `--verify` as post-copy integrity verification. Do not relabel
automatic persistence as "verification" in normal logs, because that would make users believe the
destination was reread.

### 3. Interrupted or partially failed copy

If the process is aborted or a stream/hash read fails:

- close the active streams;
- remove the partial destination;
- write no hash and no completion marker;
- preserve successful independent files already committed;
- make the rerun retry the incomplete file automatically.

If the file is complete but SQLite persistence fails, there is no atomic rollback across the
filesystem and database. Choose and document one deterministic policy:

1. Preferred for newly created destinations: remove the destination, report
   `HASH_PERSIST_FAILED`, and retry normally on rerun.
2. If removal is unsafe because the destination pre-existed or was selected through a skip/resume
   path: retain it, report an explicit untracked-file failure, and backfill only after hashing the
   actual destination on a later run.

Do not silently retain the file, mark the source completed, and omit its hash. That turns a visible
copy success into an invisible gap for issue #116 and downstream deduplication.

### 4. Existing destination or resumed operation

Conflict-skip and resume paths need a hash-specific rule:

- If a valid stored hash already corresponds to the selected inventory row, reuse the stored record
  without printing it.
- If the destination exists but its inventory hash is `NULL` or absent, do not claim that metadata
  equality proves content identity. Hash the destination before establishing the baseline, or return
  a distinct "baseline unavailable" result if the workflow cannot safely establish one.
- Only mark an album suffix/source complete after every required file has a valid inventory record.

Users should not need `--reset-completed` merely because issue #111 added a column or a previous run
ended between file completion and database persistence. Reset remains the destructive "start fresh"
operation it already represents.

### 5. First run after upgrade

Expected experience:

1. The CLI opens the existing tracking database.
2. It runs the small versioned schema migration before any copy begins.
3. Old inventory rows remain usable with `content_hash = NULL`.
4. Normal copy output is unchanged.
5. `--debug` may state the old/new schema version and successful migration.

Do not scan or hash the entire existing library during startup. That would make an apparently routine
copy command perform an unbounded read, distort progress and ETA, and surprise users with disk load.
Backfill should be a separate explicit workflow if it becomes necessary.

### 6. Future verification through issue #116

Issue #116 defines these user choices:

```bash
rfmedia verify ... --quick  # metadata only
rfmedia verify ...          # compare destination bytes with stored SHA-256
rfmedia verify ... --deep   # byte-by-byte source/destination comparison
```

Stored hashes should normally be exposed as outcomes, not raw values:

- `verified`: recalculated destination SHA-256 matches the stored baseline;
- `mismatch`: destination differs from the stored baseline;
- `hash-unavailable`: legacy/untracked row has no trusted baseline;
- `read-error`: the destination could not be hashed;
- `not-applicable`: a tier cannot support the file relationship, such as source/destination byte
  comparison after lossy conversion.

Human output should summarize counts and list actionable problem paths. Machine output should include
the selected tier and stable per-file status/code. Raw expected/actual digests are rarely actionable,
make output large, and should be omitted by default. A future explicit inventory/diagnostic command
can expose them if a real user workflow requires it.

## CLI/UX Best Practices

### Keep the default silent

- Add no public `--hash` switch: the database invariant should not depend on remembering an option.
- Add no per-file "hashing" or digest line to ordinary output.
- Keep human logs on stderr and machine documents on stdout, matching the current CLI convention.
- Preserve the current copy summary and JSON/YAML/CSV field meanings.
- In debug mode, log bounded facts such as `hashes persisted: N`, `hashes unavailable: N`, migration
  version, and failure stage. Avoid logging every 64-character digest.

### Use precise language

Prefer:

- "Recorded content hash" for persistence.
- "Verified destination against stored hash" for issue #116 default verification.
- "Verified source and destination after copy" for `copy --verify`.

Avoid saying "verified" when the implementation only hashed bytes on their way to the writer. The
baseline enables later verification but is not itself a readback check.

### Keep flags orthogonal

- `copy --verify` controls immediate post-write verification, not whether a hash is stored.
- `verify --quick` and `verify --deep` belong to issue #116 and should be mutually exclusive.
- `--dry-run` must perform no hashing, no database migration that changes persistent state if dry-run
  policy forbids initialization, and no hash writes. Its preview should not promise hashes for files
  that were not copied.
- `--no-track-completed` and `--use-legacy-tracking` need an explicit product decision; they must not
  silently mean different things across completion tracking and hash inventory.

### Preserve scriptability

Normal copy should continue returning exit code 1 when any file operation fails. Hash read and hash
persistence failures belong in the same `failed` collection, with stable machine-readable codes.
Extra debug logging must never contaminate stdout in machine-output mode.

Issue #116 should extend verify output deliberately, preferably with a schema version or additive
fields:

```json
{
  "command": "verify",
  "tier": "hash",
  "result": {
    "verified": 98,
    "mismatch": 1,
    "hashUnavailable": 1,
    "readErrors": 0
  }
}
```

Do not count `hash-unavailable` as verified and do not silently create a trusted baseline from the
same destination being checked; that would convert "unknown" into "good" without independent
evidence.

## Error Handling

### Failure categories

Use stage-specific codes while retaining an actionable sentence and original filesystem/SQLite code:

| Code                  | Meaning                                           | User-facing action                                   |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `HASH_READ_FAILED`    | Source/destination bytes could not be hashed      | Check path, permissions, hardware; rerun             |
| `HASH_ABORTED`        | Hash/copy pipeline was cancelled                  | Partial output removed; rerun when ready             |
| `HASH_PERSIST_FAILED` | File completed but SQLite record could not commit | Destination handled per policy; inspect DB and rerun |
| `HASH_INVALID`        | Stored digest is malformed or unsupported         | Run diagnostics/migration; do not trust the baseline |
| `HASH_UNAVAILABLE`    | Legacy row has no stored baseline                 | Use quick tier or explicit baseline/backfill flow    |
| `HASH_MISMATCH`       | Recalculated bytes differ from trusted baseline   | Preserve evidence; report path; do not auto-repair   |

Messages should identify the failed path and stage without exposing raw SQL. Database failures should
include the configured database path and suggest `--debug` for the underlying SQLite code.

### Copy result policy

- Hashing failure is a file failure, not a warning.
- Required database persistence failure is a file/tracking failure, not a warning.
- Independent files may continue under the current partial-result model.
- A source or suffix with any required hash failure remains incomplete.
- Final summary and machine output include the failure, and the command exits nonzero.
- Never trigger Plex scan for a source that the command treats as failed/incomplete unless existing
  behavior explicitly defines partial scans.

### Migration failure

Abort before the first filesystem mutation. Report:

- database path;
- current and expected schema version when known;
- stable SQLite error code;
- assurance that copying did not start;
- a recovery suggestion, such as permissions/free-space checks and restoring a database backup.

Do not catch migration failure, log a warning, and continue with nullable/unknown runtime behavior.

### Verification mismatch versus operational error

Issue #116 should distinguish content mismatch from inability to verify. Both make the run non-green,
but users need different remedies:

- mismatch: the file was read successfully and differed;
- read error: evidence is unavailable due to I/O/permission failure;
- hash unavailable: no trusted baseline exists;
- invalid hash: tracking metadata is malformed.

Repair remains explicit. Borg's official `check` behavior is read-only by default and warns strongly
about repair because it can lose data. rfmedia should preserve the same separation: verification
reports evidence; `--fix` is the separate mutating workflow.

## Performance UX

### Make hashing part of observable progress

For direct copies, the hash is computed while bytes flow, so existing byte progress can remain the
primary indicator. Do not mark a file complete until digest finalization and database persistence
finish.

Hardlinks and conversions need special care:

- A hardlink itself is nearly instant, but hashing a previously unseen file reads all bytes. Progress
  should show a hashing/recording phase or count those bytes so the UI does not appear frozen.
- Conversion hashing may reread the final output. The progress label should transition from
  converting to hashing/recording when the second phase is material.
- Short SQLite writes need no spinner. If batching creates a visible tail, label it "Recording copy
  metadata" and keep it bounded.

### Define the `<5%` promise honestly

Measure and report direct copies separately from hardlinks and conversions. Operator acceptance should
include representative media size, worker count, filesystem/storage, cold/warm cache, elapsed time,
throughput, and tail latency. A weighted overall average is not enough.

Do not expose a public "disable hashing for speed" option as the first response to a regression. It
would create an unreliable database invariant and make issue #116 behavior unpredictable. Fix the
pipeline, batching, progress, or concurrency; retain an internal benchmark escape hatch only if tests
need it.

### Do not surprise users with background work

- No automatic full-library backfill on database open.
- No verification reread unless `copy --verify` or issue #116 requests it.
- No unbounded migration progress hidden behind command startup.
- No retry loop that can run indefinitely on a failing disk or locked database.

## Competitive/Reference Patterns

### Git: content identity is infrastructure, explicit commands expose it

Git computes content-derived object IDs as part of its storage model, while normal workflows do not
print every blob hash. The dedicated
[`git hash-object`](https://git-scm.com/docs/git-hash-object) command reports an object ID when users
explicitly need it. rfmedia should follow the same separation: persist identities internally during
copy; expose them only through a focused inventory/diagnostic workflow.

Git also demonstrates that "content hash" may cover a normalized representation after filters rather
than raw source bytes. rfmedia must define its contract more simply: hash final destination bytes,
especially after conversion.

### Borg: cheap checks and full data verification are different operations

Borg's official [`check`](https://borgbackup.readthedocs.io/en/stable/usage/check.html) documentation
separates structural/archive checks from `--verify-data`, which reads and cryptographically verifies
all data and is described as time-consuming. Check is read-only by default; repair is explicit and
strongly warned. This supports keeping persistence silent, making expensive readback visible, and
keeping issue #116 verification separate from repair.

### restic: integrity depth has explicit time and bandwidth cost

restic's official
[`check` documentation](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency)
distinguishes structural checks from `--read-data` and subset reads because full verification costs
time and bandwidth. Its backup flow emits progress and a concise snapshot summary rather than every
content digest. rfmedia should similarly keep copy output concise and make future verification depth
an explicit tier.

### rclone: transfer verification failures are operational failures

rclone documents checksum checking after transfer and treats "corrupted on transfer" as an error;
disabling it is an explicit potentially unsafe choice. Its
[`checksum`](https://rclone.org/commands/rclone_checksum/) command is read-only and reports match,
difference, missing, and error states distinctly. Those status categories are a good model for the
future issue #116 workflow, while issue #111 remains the quiet baseline-generation step.

## Recommendations

1. Persist SHA-256 by default in database-backed copy workflows without adding a public flag or
   changing normal copy output.
2. Preserve `copy --verify` as an additional post-write readback check; never describe baseline
   persistence as verification.
3. Count a file/source/suffix complete only after its required hash and inventory record commit.
4. On hash or persistence failure, use stage-specific codes, clean up safely, leave completion state
   retryable, and return a nonzero final result.
5. Run the nullable schema migration automatically before copying; show success only in debug output
   and abort cleanly on migration failure.
6. Leave legacy inventory hashes `NULL`; do not auto-backfill a library during startup.
7. Keep raw digests out of normal human and machine copy output. Let issue #116 expose tier and status
   counts, with per-file statuses where appropriate.
8. Treat `hash-unavailable` as unknown, not verified. Establishing a new baseline must be an explicit,
   separately designed action.
9. Integrate hashing into progress/ETA and label visible hardlink/conversion hashing phases.
10. Validate `<5%` overhead per copy method and workload; do not hide regressions in a blended average.
11. Keep verification read-only by default and retain explicit `--fix` separation.
12. Document the exact coverage boundary for database tracking disabled/legacy modes before release.

## Open Questions

1. Does issue #111 require hash persistence when the user explicitly selects
   `--use-legacy-tracking`, or should that mode emit one warning that issue #116 hash verification is
   unavailable?
2. Does `--no-track-completed` disable only resume markers, or also inventory/hash persistence?
3. When SQLite persistence fails after a successful new copy, should rfmedia remove the destination
   or retain it as an explicit untracked artifact?
4. How should conflict-skip paths establish a trusted baseline for an existing destination without
   falsely treating the current bytes as independently verified?
5. Should hardlink hashing be allowed to reuse a known digest, and what file immutability evidence is
   required before doing so?
6. Is the `<5%` threshold required for hardlink-only and converted workloads, or only ordinary direct
   copies?
7. Should dry-run open/migrate the database, or must it be fully free of persistent schema writes?
8. What exact user-visible behavior should issue #116 use for legacy `NULL` hashes: fail as
   `hash-unavailable`, fall back to `--quick` with a warning, or require an explicit baseline command?
9. How does issue #116 deep byte comparison apply to converted files whose source and destination are
   intentionally different?
10. Does a future diagnostic command need to reveal raw hashes, or are verification statuses and
    inventory queries sufficient?
11. Should an aborted copy use exit code 130 distinctly from file/hash/database failures?
12. When a source partially succeeds, should Plex scanning remain source-level all-or-nothing after a
    hash persistence failure?
