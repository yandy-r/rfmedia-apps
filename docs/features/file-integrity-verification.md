# File Integrity Verification

## Overview

`rfmedia` has three complementary integrity mechanisms. They answer different questions and should
not be treated as interchangeable.

| Mechanism                      | Timing                      | Question answered                                                        |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------ |
| `rfmedia copy --verify`        | Immediately after copying   | Do the source and destination contain the same bytes now?                |
| Automatic fingerprint producer | During tracked finalization | What SHA-256 fingerprint did the final destination artifact have then?   |
| `rfmedia verify`               | Later, without copying      | Does the current destination satisfy the selected verification evidence? |

Issue #41 introduced copy-time read-back verification. The producer work associated with issue #111
and PRs #233 and #248 stores final-artifact fingerprints. Issue #116 consumes those fingerprints
later through tiered, read-only verification.

All SHA-256 checks described here provide local integrity evidence. They are not digital signatures,
do not prove who created an artifact, and do not establish that its source was authentic or trusted.

## Copy-Time Read-Back Verification

Pass `--verify` to `rfmedia copy`, or set `copy.verify: true`, to compare a byte-identical source and
destination immediately after materialization.

```bash
rfmedia copy --verify --paths /music/source/Artist/Album
rfmedia copy --no-verify --paths /music/source/Artist/Album
```

Configuration precedence is CLI `--verify` or `--no-verify`, then `copy.verify`, then the default of
disabled.

For an ordinary copy or hardlink, the command reads the source and destination and compares their
SHA-256 digests before continuing. A mismatch fails the operation and triggers destination cleanup
under the copy action's existing ownership rules. Read failures are surfaced rather than converted
to a successful result.

Converted audio is skipped because conversion intentionally changes the bytes. This immediate
read-back check is not the stored-fingerprint verifier described below.

## Final-Artifact Fingerprint Production

Successful tracked album copies, filter copies, and sync operations automatically persist a
lowercase 64-character SHA-256 digest in the nullable schema-version-9
`inventory.content_hash` column. The subject is always the final destination represented by the
inventory row:

- a regular streamed copy fingerprints the bytes written by the successful attempt;
- a conversion is hashed after conversion completes;
- a hardlink is hashed after link creation, so later writes through any link can make the stored
  snapshot stale;
- filter and sync workflows hash the finalized destination before inventory success is recorded.

The fingerprint is not proof that a separate destination read-back occurred at copy time. Historical
rows migrated from schema version 8 retain `NULL`, and legacy portable entries may omit
`contentHash`. No automatic backfill is performed.

See
[Content Hashing During Copy Operations](../../packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md)
for the full producer contract.

## Later Tiered Verification

`rfmedia verify` supports three explicit evidence levels:

| Tier    | Selection | Database use | Evidence and behavior                                                                                        |
| ------- | --------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| Quick   | `--quick` | None         | Compares size and modification time without reading file contents; converted files are unverifiable          |
| Default | Default   | Read-only    | Hashes the current destination and compares it with its exact stored final-artifact SHA-256                  |
| Deep    | `--deep`  | Read-only    | Requires the stored-hash match, then byte-compares source and destination when that comparison is meaningful |

Examples:

```bash
# Metadata only; does not open the tracking database
rfmedia verify --quick --range 1-3 /music/source/Artist/Album /music/destination

# Default stored-fingerprint verification
rfmedia verify --range 1-3 /music/source/Artist/Album /music/destination

# Stored fingerprint plus applicable source/destination byte comparison
rfmedia verify --deep --range 1-3 /music/source/Artist/Album /music/destination
```

`--verify-size` is additive and does not weaken the selected tier. The verifier reports distinct
outcomes such as missing, metadata mismatch, hash mismatch, content mismatch, unverifiable,
not-applicable, unstable, and failed.

### Exact Fingerprint Matching

For default and deep verification, candidate rows are read by joining `inventory` with `operations`
for the requested source paths. A fingerprint is used only when exactly one normalized row matches
all of these values:

- source path;
- relative path;
- destination path;
- conversion key.

The verifier does not guess across operations or destinations. No exact row is missing evidence, and
multiple exact rows are ambiguous evidence. A missing, ambiguous, `NULL`, or malformed fingerprint
is reported as unverifiable rather than corrupt.

### Conversion, Hardlink, and Range Limits

Default verification works for converted artifacts because it compares the current converted output
with the stored hash of that final output. In deep mode, the stored-hash result still applies, but a
source-to-destination byte comparison is not applicable to a conversion.

For a hardlink, source and destination can be the same inode. Deep verification retains the stored
hash evidence and reports the redundant byte comparison as not applicable.

Ranged copy workflows retain their established one-row-per-source inventory identity. Only the
destination represented by that row can provide exact stored fingerprint evidence. The verifier does
not infer fingerprints for other ranged artifacts, and it does not backfill them.

## Tracking Database Resolution and Safety

Quick verification bypasses database resolution entirely. Default and deep verification use this
precedence:

1. Explicit `--tracking-database`
2. `undo.database`
3. `tracking.database`
4. Existing `~/.config/rfmedia/tracking.db`
5. Existing `~/.rfmedia/tracking.db`
6. `~/.config/rfmedia/tracking.db` as the unresolved default candidate

Non-quick verification never redirects a configured path. It requires an existing, non-symlink,
regular database at exactly schema version 9 and reads an immutable in-memory snapshot with SQLite
`query_only` enabled. It does not:

- create a missing database;
- initialize or migrate a schema;
- accept an older or newer schema;
- change journal mode or create WAL/SHM/journal sidecars;
- write inventory or metadata;
- backfill nullable legacy fingerprints.

Active SQLite sidecars and a database that changes while the snapshot is being read are rejected.
See
[Centralized Tracking Database](../../packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md)
for the schema contract.

## Stable Reads and Interruption

Integrity reads operate on regular files in bounded chunks and accept the command's abort signal.
The hash and byte-comparison helpers capture file identity and metadata before and after reading. If
a file changes during the read, verification reports an unstable result instead of trusting partial
or mixed evidence. File handles are closed on success, failure, and cancellation.

Routine output reports outcomes without printing full content hashes.

## Related Issues and Documentation

- Issue #41: copy-time source/destination read-back verification
- Issue #111 and PRs #233 and #248: final-artifact fingerprint production
- Issue #116: tiered read-only fingerprint consumption
- [Content Hashing During Copy Operations](../../packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md)
- [Centralized Tracking Database](../../packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md)
- [Graceful Interruption](../../packages/rfmedia-cli/docs/features/graceful-interruption.md)
