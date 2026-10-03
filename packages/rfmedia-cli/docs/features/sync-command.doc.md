# Sync Command

This document describes incremental synchronization of previously inventoried album and filtered
music copies.

## Overview

`rfmedia sync` compares current source state with an inventory and processes only changes:

- new files that meet the selected mode;
- modified files and missing destinations;
- rating upgrades that now meet a filter threshold;
- rating downgrades that should be removed from the destination.

Database mode stores inventory in the schema-version-9 SQLite tracking database. Legacy mode keeps
using per-configuration JSONL inventory files.

## Command Line Usage

```bash
# Filter mode
rfmedia sync <destination> --file=<path> --min-rating=<N> [options]

# Album mode
rfmedia sync <destination> --file=<path> --range=<START-END> [options]

# YAML-defined sources and destination
rfmedia sync --paths=<yaml-file> [options]
```

### Required Selection

Use `--file` or `--paths` to select sources, then choose filter mode with `--min-stars` or
`--min-rating`, or album mode with `--range`. YAML source definitions can provide the mode and its
options.

### Filter Options

| Option                   | Description                                   |
| ------------------------ | --------------------------------------------- |
| `--min-stars <N>`        | Minimum star rating for track inclusion       |
| `--min-rating <N>`       | Minimum rating on the 0-100 scale             |
| `--output-folder <name>` | Output folder name                            |
| `--preserve-structure`   | Keep album subfolders in output               |
| `--album-mode`           | Preserve album folders with only liked tracks |

### Sync Options

| Option                   | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `--reset-inventory`      | Clear this operation's inventory and rescan sources      |
| `--delete-downgraded`    | Delete files that fall below the threshold (default)     |
| `--no-delete-downgraded` | Keep downgraded destination files                        |
| `--force`                | Re-copy files even when inventory reports them unchanged |

### Common Options

| Option                   | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `--hardlink`             | Use hardlinks instead of byte copies                  |
| `-c, --convert <format>` | Convert audio to `alac`, `mp3`, `aac`, or `opus`      |
| `-w, --workers <N>`      | Number of parallel workers                            |
| `--progress`             | Show a progress bar                                   |
| `--dry-run`              | Preview changes without writing                       |
| `--plex-scan`            | Trigger a Plex library scan after a successful change |

## Examples

```bash
# Initial database inventory from copy
rfmedia copy --file=paths.txt /dest --min-rating=50

# Apply only subsequent changes
rfmedia sync /dest --file=paths.txt --min-rating=50

# Preview changes and deletions
rfmedia sync /dest --file=paths.txt --min-rating=50 --dry-run

# Rebuild this operation's inventory
rfmedia sync /dest --file=paths.txt --min-rating=50 --reset-inventory

# Keep files whose ratings were downgraded
rfmedia sync /dest --file=paths.txt --min-rating=50 --no-delete-downgraded

# Album range with final-output conversion
rfmedia sync /dest --file=paths.txt --range=001-005 --convert=mp3
```

## Inventory and Operation Identity

Database inventory belongs to the existing operation selected by mode, input identifier, rating,
range, and conversion options. Sync does not introduce a second hash-specific identity.

Each source file has one inventory row per operation, keyed by:

```text
(operation_id, source_path, relative_path)
```

For a range that creates multiple destinations, sync retains its existing one-row-per-source-file
model and records the destination represented by that row. Content fingerprinting does not create a
row for every ranged artifact.

The row contains source snapshot data (`mtime`, `size`, rating and available media metadata), the
represented `dest_path`, the write timestamp, and `content_hash`.

### Legacy JSONL Inventory

With `tracking.useLegacy: true`, sync routes inventory through a per-configuration JSONL file such as:

- `paths.inventory.album-001-010.jsonl`;
- `paths.inventory.filter-r50.jsonl`;
- `paths.inventory.filter-s4-mp3.jsonl`.

Legacy records remain portable through `contentHash?: string | null`. Older records may omit the
field or contain `null`; those values mean unknown and are not automatically backfilled. Selecting
legacy mode does not initialize or migrate SQLite solely to persist a fingerprint.

## Content Fingerprints

For a successful database-inventoried sync write, `content_hash` is a lowercase SHA-256 fingerprint
of the final destination bytes.

| Write method | Fingerprint semantics                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| Copy         | Digest from the completed destination copy pipeline                           |
| Conversion   | Hash calculated after conversion, over the converted destination              |
| Hardlink     | Snapshot hash calculated after link creation over the shared inode's contents |

A hardlink fingerprint is not a permanent guarantee: modifying any path to the same inode changes
the bytes without automatically updating historical inventory.

The stored value is a write-time fingerprint, not a destination read-back check. The copy command's
`--verify` behavior is a separate integrity operation; sync does not silently turn inventory hashes
into read-time verification or deduplication.

## Processing and Failure Ordering

For each file that needs to be synchronized:

```text
copy, link, or convert destination
  -> finalize SHA-256
  -> persist inventory row
  -> allow successful completion tracking
```

If the write, conversion, hash, or inventory write fails, the file is reported as failed and no new
successful completion may be recorded for it with an unknown hash. Other files continue according to
the existing sync failure aggregation behavior.

## Change Detection

Sync loads the operation inventory and classifies each source file:

| Classification | Typical condition                                                          |
| -------------- | -------------------------------------------------------------------------- |
| New            | No inventory row and the file meets the selected mode                      |
| Updated        | Source metadata changed, rating became eligible, or destination is missing |
| Unchanged      | Source snapshot and rating match and destination exists                    |
| Downgraded     | Previously eligible rating now falls below the threshold                   |
| Removed        | Inventoried source path no longer exists                                   |

When downgrade deletion is enabled, the represented destination is removed and its inventory state
is updated. Different rating, range, or conversion configurations remain separate operations.

## Dry-Run Behavior

`--dry-run` computes and displays the proposed diff without executing the write lifecycle. It does
not:

- copy, link, convert, or delete files;
- read destination bytes to compute fingerprints;
- create or migrate the tracking database;
- write SQLite or JSONL inventory;
- record completion.

The summary is still displayed, and a Plex scan is not triggered.

## Output and Errors

Sync output ends with counts for new, updated, unchanged, deleted, and failed files. Routine output
does not print full content hashes.

Missing sources and individual file failures are collected and reported while other sources continue.
An inventory-persistence failure is a file failure, not a warning that can be followed by successful
completion.

## Plex Integration

With `--plex-scan`, sync requests a path-based Plex scan only when at least one destination changed,
the run is not a dry-run, and Plex configuration is available. Plex scanning is a notification step;
it does not make Plex query copy or playlist operations producers of general sync inventory rows.

## Implementation Files

| File                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `src/commands/sync.ts`   | Command definition and option parsing                |
| `src/actions/sync.ts`    | Diff orchestration, artifact writes, and persistence |
| `src/lib/inventory.ts`   | SQLite/JSONL inventory routing and diff calculation  |
| `src/lib/integrity.ts`   | Final-file SHA-256 calculation                       |
| `src/types/inventory.ts` | Portable inventory types                             |

## Related Documentation

- [Centralized Tracking Database](centralized-tracking-db.doc.md)
- [Tracking System](tracking-system.md)
- [Audio Conversion](audio-conversion.doc.md)
- [Parallel Processing](parallel-processing.doc.md)
