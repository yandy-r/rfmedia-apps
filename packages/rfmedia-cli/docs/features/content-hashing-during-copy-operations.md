# Content Hashing During Copy Operations

## Overview

`rfmedia` records a SHA-256 content fingerprint for successful inventory-backed album copies,
filter copies, and sync operations. The fingerprint is quiet and automatic: it is stored with the
inventory row and does not add a CLI option or change normal command output.

The producer work associated with issue #111 and PRs #233 and #248 established this stored
final-artifact fingerprint. Issue #116 adds a separate read-only consumer: the default and deep
tiers of `rfmedia verify` compare a destination later with its exact schema-version-9 inventory
fingerprint.

The stored value is evidence about integrity at write or finalization time. It is not proof that the
destination was read back then, and SHA-256 alone does not establish who created the file or whether
its source was trusted. It is therefore an integrity fingerprint, not an authenticity guarantee.

## Fingerprint Contract

- Algorithm: SHA-256.
- Encoding: exactly 64 lowercase hexadecimal characters matching `/^[a-f0-9]{64}$/`.
- Subject: the final destination artifact represented by the inventory row.
- Persistence: the nullable `inventory.content_hash` column in schema version 9, or the equivalent
  portable `contentHash` field in sync's legacy JSONL inventory.
- Ordering: materialize the artifact, finalize its fingerprint, persist inventory, then record
  successful completion.

Invalid non-null values are rejected by inventory write APIs. The read-only verifier treats a
legacy `NULL`, omitted, malformed, missing, or ambiguous fingerprint as unverifiable; none of those
states alone means that the file is corrupt.

## How Each Copy Method Is Fingerprinted

| Method               | Fingerprint behavior                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular album copy   | A transparent SHA-256 transform observes the source chunks while the same chunks are written to the destination, avoiding a second full-file read.                                  |
| Filter copy and sync | The finalized destination selected by the action is read and hashed before its inventory row is persisted.                                                                          |
| Conversion           | The converted output is read and hashed only after conversion completes successfully. The source hash would describe different bytes and is not stored for the converted artifact.  |
| Hardlink             | The linked destination is read and hashed after link creation because no copy stream exists. This is a snapshot: later writes through any hardlink can make the stored value stale. |

Each streamed-copy retry creates fresh streams and fresh hash state. Bytes from a failed attempt
cannot contaminate the fingerprint returned by a later successful attempt. Timestamps are restored
only after the copy pipeline completes.

For ranged copies, the existing inventory identity is unchanged. Album/filter/sync actions store the
fingerprint for the destination currently represented by their established inventory model; this
feature does not add one inventory row for every ranged artifact.

## Tracking and Legacy Behavior

Fingerprint persistence follows the existing inventory lifecycle:

- Album and filter copies persist fingerprints when their SQLite inventory tracking context is
  active.
- Sync persists through its selected inventory backend. Database mode uses `content_hash`; legacy
  mode keeps using the existing JSONL `contentHash` field and does not open a hidden database.
- Disabling tracking does not create a database solely to store fingerprints.
- Dry-run performs no copy, hash read, schema migration, inventory write, or completion write.
- Existing schema-version-8 rows migrated to version 9 retain `NULL`; there is no automatic backfill.
- Older JSONL entries with `null` or no `contentHash` remain readable as unknown fingerprints.

## Failure and Interruption Behavior

A file is not reported as successfully completed when materialization, hashing, or inventory
persistence fails. Database batch validation rejects the whole batch when any non-null digest is
invalid, so completion cannot advance on partially persisted inventory.

Stream copies receive the action's `AbortSignal`. Cancellation reaches the read/hash/write pipeline,
and retry-local resources are discarded. On cancellation or exhausted failure, the filesystem
helper removes only a destination it established did not exist before the operation and may have
partially created. A pre-existing destination is not recursively removed by this helper. Cleanup is
best effort and preserves the primary abort or filesystem error.

See [Graceful Interruption](./graceful-interruption.md) for the wider signal and cleanup lifecycle.

## Relationship to Verification

The project has three related but distinct integrity mechanisms:

| Mechanism                      | When it runs             | Evidence                                                                  |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------- |
| Automatic fingerprint producer | During a tracked write   | SHA-256 of the final destination artifact stored in inventory             |
| `rfmedia copy --verify`        | Immediately after a copy | Source and destination are read back and compared for byte-identical work |
| `rfmedia verify`               | Later, without copying   | Quick metadata, stored destination SHA-256, or SHA-256 plus byte compare  |

`rfmedia copy --verify` skips conversions because the source and destination bytes intentionally
differ. The producer still hashes the converted output after conversion. Later, the default and
deep `rfmedia verify` tiers can validate that converted destination against its stored final-output
hash; deep source-to-destination byte comparison is reported as not applicable for conversions.

The non-quick verifier resolves the tracking database in this order: explicit
`--tracking-database`, `undo.database`, `tracking.database`, then the existing default-path search.
It opens only an existing schema-version-9 regular file through an immutable read-only snapshot. It
does not create a database, migrate a schema, write inventory, backfill hashes, or create SQLite
WAL/SHM/journal sidecars.

Candidate lookup joins `inventory` with `operations` and requires one exact normalized match across
source path, relative path, destination path, and conversion key. Duplicate exact rows are
ambiguous. Ranged workflows remain limited by the established one-row-per-source inventory model,
so a ranged destination that is not the represented artifact has no inferred fingerprint.

## Explicit Exclusions

This feature does not add:

- A `--hash`, `--no-hash`, or algorithm-selection option.
- Routine full-digest logging or changes to JSON, MCP, queue, or completion schemas.
- Fingerprints for Plex query copy, playlist export/sync, repair/conflict writes, watch operations
  without inventory, or video linking.
- One-to-many artifact identity for ranged outputs.
- Deduplication indexes, conversion-cache keys, signatures, authenticity checks, or atomic
  temporary-file replacement.
- Automatic backfill or corruption classification for historical `NULL` values.

## Related Documentation

- [File Integrity Verification](../../../../docs/features/file-integrity-verification.md)
- [Graceful Interruption](./graceful-interruption.md)
- [Centralized Tracking Database](./centralized-tracking-db.doc.md)
- [Tracking System](./tracking-system.md)
