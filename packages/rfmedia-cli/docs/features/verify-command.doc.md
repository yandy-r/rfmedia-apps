# Verify Command

`rfmedia verify` checks the artifacts selected by the album or filter workflow. Verification uses
one of three evidence tiers: quick metadata comparison, stored final-artifact SHA-256 comparison,
or stored SHA-256 plus a direct byte comparison where that comparison is meaningful.

Verification is an integrity check against local evidence. A stored fingerprint is not proof of
authenticity or provenance: a party that can alter both an artifact and its tracking database can
also alter that evidence. The command never creates, migrates, refreshes, or backfills a
fingerprint.

## Command Line Syntax

```bash
# Album mode: verify numbered album copies
rfmedia verify <source> <destination> --range=001-010 [options]

# Filter mode: verify rating-filtered tracks
rfmedia verify <source> <destination> --min-stars=4 [options]

# Filter plus album mode: verify numbered albums containing selected tracks
rfmedia verify <source> <destination> --min-rating=80 --album-mode --range=001-005
```

The existing album/filter selection, range precedence, conversion mapping, duplicate-name
handling, multiple-source input, and file input apply in every tier. A tier changes the evidence
used for each expected artifact; it does not change which artifacts are expected or which files
are reported as extra.

## Selecting a Tier

| Selection    | Evidence and guarantee                                                                                                                                          | Content-read cost                                                                 | Tracking database             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| `--quick`    | Current source and destination regular-file size plus integer-millisecond modification time. Equal metadata is freshness evidence, not content-integrity proof. | None                                                                              | Not opened                    |
| No tier flag | Destination SHA-256 compared with the exact stored final-artifact fingerprint.                                                                                  | One complete destination read                                                     | Required, existing, read-only |
| `--deep`     | Default verification first, followed by a bounded-memory source/destination byte comparison when byte identity is meaningful.                                   | One destination hash read plus applicable source and destination comparison reads | Required, existing, read-only |

`--quick` and `--deep` conflict and are rejected before verification starts. The no-flag behavior
is the `default` tier; it is not an existence-only check.

Examples:

```bash
# Frequent metadata-only check
rfmedia verify /music/Artist /backup --range=001-010 --quick

# Default stored-fingerprint check
rfmedia verify /music/Artist /backup --range=001-010

# Strongest applicable local integrity check
rfmedia verify /music/Artist /backup --range=001-010 --deep

# Select an existing tracking database explicitly
rfmedia verify /music/Artist /backup --range=001-010 \
  --tracking-database=/state/rfmedia.db
```

For default and deep verification, `--tracking-database` takes precedence over configured
database paths. The resolved file must already exist and have a supported schema. Verification
opens it read-only and does not create or migrate it. Quick verification ignores fingerprint
storage and performs no database open.

`--verify-size` remains an optional, additive size precheck for non-converted content. It does not
select a tier, replace its required evidence, or weaken the selected guarantee.

## Baseline Coverage

Default and deep verification accept a fingerprint only when one inventory row matches the exact
artifact identity:

- normalized source root;
- source-relative path;
- exact derived destination path; and
- conversion identity.

The fingerprint is the SHA-256 recorded for the final artifact produced by the copy workflow.
Verification does not borrow evidence from a different destination, operation, range member, or
conversion. Multiple exact matches are ambiguous and fail closed.

Baseline limitations are reported per artifact:

| Condition                                     | Result                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| Exact usable fingerprint                      | Continue the selected content check                         |
| No matching row                               | `unverifiable` with `fingerprint-missing`                   |
| Legacy `NULL` fingerprint                     | `unverifiable` with `fingerprint-null`                      |
| Malformed fingerprint                         | `unverifiable` with `fingerprint-invalid`                   |
| Multiple exact candidates                     | `unverifiable` with `fingerprint-ambiguous`                 |
| Historically unrepresented ranged destination | `unverifiable`; evidence is not guessed from another output |
| Database missing, unreadable, or unsupported  | Operational failure; the database is not created or changed |

An unavailable baseline is missing coverage, not proof of corruption and not success. Run quick
when metadata-only evidence is sufficient, or reproduce the artifact through a trusted,
fingerprint-producing copy workflow. Verify never adopts current bytes as a new baseline.

## Conversions and Hardlinks

### Converted outputs

Source and converted destination bytes intentionally differ.

- Quick cannot compare destination metadata with the schema-v9 source metadata baseline, so the
  artifact is `unverifiable` with `conversion-metadata-unavailable`.
- Default hashes the final converted destination and compares it with that destination's stored
  fingerprint.
- Deep performs the same stored-hash check. Direct source/destination comparison is
  `not-applicable` with `conversion-byte-compare`.

A converted deep artifact is verified when its stored hash matches. Its `notApplicable` coverage
counter also increases to make the omitted byte comparison visible; that coverage note alone does
not make the result incomplete.

### Hardlinks

Source and destination can refer to the same inode. Deep still performs the historical stored-hash
check first because comparing a hardlink with itself cannot detect joint drift. When both paths
are the same inode, the direct comparison is `not-applicable` with
`same-inode-byte-compare`; it is not reported as independent byte evidence.

## Verification Outcomes

Only a file that satisfies every required and applicable check increments `verified`.

| Outcome             | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `present`           | Required and applicable checks passed                            |
| `missing`           | Expected destination artifact does not exist                     |
| `size-mismatch`     | Required or requested size comparison failed                     |
| `metadata-mismatch` | Quick modification-time comparison failed                        |
| `hash-mismatch`     | Destination SHA-256 differs from the stored fingerprint          |
| `content-mismatch`  | Deep source/destination byte comparison differs                  |
| `unverifiable`      | Required evidence is missing, invalid, ambiguous, or unavailable |
| `not-applicable`    | An additional check is not meaningful for this artifact          |
| `unstable`          | A file changed while content evidence was being read             |

Missing and extra detection is common to every tier. An extra file is not part of
`expectedTotal`, remains an unresolved discrepancy when kept, and does not become verified.
Filesystem and database errors are recorded separately in `failed` so one per-file error does not
discard other results.

If a file changes while hashing or comparing, verification reports `unstable` rather than a
success or mismatch based on inconsistent reads. Retry after writers have quiesced.

## Album and Filter Selection

### Album mode

Album mode verifies every expected non-directory entry in each numbered destination and reports
unexpected entries. `--album-only` treats the source as one album; otherwise each source album
subdirectory is processed.

```bash
rfmedia verify /music/Artist /backup --range=001-005
rfmedia verify /music/Artist/Album /backup --range=001-003 --album-only
```

### Filter mode

Filter mode retains the copy command's rating and metadata filters, output folder, preserved
structure, conversion naming, and duplicate-name mapping.

```bash
rfmedia verify /music/Artist /backup --min-stars=4
rfmedia verify /music/Artist /backup --min-rating=80 --preserve-structure
rfmedia verify /music/Artist /backup --min-rating=80 --album-mode --range=001-003
```

### Range precedence

| Priority | Source                | Example                           |
| -------- | --------------------- | --------------------------------- |
| 1        | CLI `--range`         | `--range=001-005`                 |
| 2        | Per-source range      | `/music/Artist,001-005`           |
| 3        | Configured copy range | `copy.range` in the loaded config |

Multiple CLI sources and `--file` input use the same tier for the entire invocation. Content tiers
preload candidate evidence once for the source batch and reuse it while preserving exact
per-artifact resolution.

## Machine Output

JSON and YAML retain the nested command envelope. Table and CSV output expose a flat projection of
the same counters. Routine output never contains expected or actual digest values.

```json
{
  "command": "verify",
  "mode": "album",
  "tier": "deep",
  "status": "incomplete",
  "source": "/music/Artist",
  "destination": "/backup",
  "result": {
    "verified": 2,
    "missing": 0,
    "sizeMismatch": 0,
    "metadataMismatch": 0,
    "hashMismatch": 1,
    "contentMismatch": 0,
    "unverifiable": 1,
    "notApplicable": 1,
    "unstable": 0,
    "extra": 0,
    "expectedTotal": 4,
    "issues": [
      {
        "path": "Album-001/track.flac",
        "status": "hash-mismatch",
        "sourcePath": "/music/Artist/Album/track.flac",
        "evidence": ["hash"]
      },
      {
        "path": "Album-001/legacy.flac",
        "status": "unverifiable",
        "reason": "fingerprint-null",
        "evidence": []
      },
      {
        "path": "Album-001/converted.m4a",
        "status": "not-applicable",
        "reason": "conversion-byte-compare",
        "evidence": ["hash"]
      }
    ],
    "failed": []
  }
}
```

The stable aggregate fields are:

- `tier`, `verified`, `missing`, `sizeMismatch`, `metadataMismatch`, `hashMismatch`,
  `contentMismatch`, `unverifiable`, `notApplicable`, `unstable`, `extra`, and `expectedTotal`;
- `issues`, whose entries can include `path`, `sourcePath`, `status`, `reason`, `evidence`,
  `expectedSize`, and `actualSize`;
- `failed`, whose entries include `path`, `message`, and an optional error `code`; and
- `fixResults` when a repair pass runs, as documented in
  [Verify Auto-Fix](verify-auto-fix.doc.md).

## Completion and Exit Behavior

The command reports `status: "complete"` and exits with code `0` only when no unresolved state
remains. It reports `status: "incomplete"` and sets exit code `1` for any missing file, mismatch,
unverifiable or unstable artifact, extra file, operational failure, failed/refused repair, or
remaining post-repair issue.

`notApplicable` is a coverage statement rather than a failure. It does not cause a nonzero exit by
itself when all required evidence passed.

Argument/configuration/database-opening failures also terminate unsuccessfully through the normal
CLI error path.

## Implementation Map

| File                             | Responsibility                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `src/commands/verify.ts`         | Tier flags, option resolution, machine projection, summaries, exit state |
| `src/actions/verify-album.ts`    | Album traversal, evidence preload, aggregation, repair recheck           |
| `src/actions/verify-filter.ts`   | Filter layouts, duplicate mapping, evidence preload, repair recheck      |
| `src/lib/tiered-verification.ts` | Exact candidate resolution, tier policy, shared aggregation              |
| `src/lib/integrity.ts`           | Abort-aware SHA-256 and bounded byte comparison                          |
| `src/lib/db.ts`                  | Existing-file read-only database open and fingerprint candidate query    |
| `src/types/results.ts`           | Stable outcomes, reasons, evidence, aggregate, and repair fields         |

## Related Documentation

- [Verify Auto-Fix](verify-auto-fix.doc.md)
- [Content Hashing During Copy Operations](content-hashing-during-copy-operations.md)
- [Centralized Tracking Database](centralized-tracking-db.doc.md)
- [Multiple Source Arguments](multiple-source-arguments.doc.md)
