# Metadata Reconciliation

`rfmedia reconcile` reports metadata drift across three evidence planes:

1. embedded tags in local audio files;
2. operation-scoped rows in the rfmedia SQLite inventory; and
3. a current media-server track snapshot.

`scan` is read-only. `apply` selects one rating authority and creates a preview by default.
Mutation requires the separate `--execute` gate and approval.

## Choose the Right Reconciliation Command

These similarly named commands have different scopes:

| Command                    | Evidence                                          | Purpose                                                     | Writes                                               |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| `rfmedia reconcile`        | Files, rfmedia inventory, and media server tracks | Per-track rating, artist, first genre, and year drift       | Rating and selected inventory stat repair only       |
| `rfmedia plex sync`        | Files and Plex                                    | Older two-plane rating push, pull, or bidirectional sync    | Ratings; uses its own `--dry-run` and `--prefer` API |
| `rfmedia lidarr reconcile` | Plex artists and Lidarr artists                   | Report artist identity matches, review candidates, and gaps | No provider/file mutation; live cache refresh only   |

Use `rfmedia reconcile` when SQLite inventory evidence must participate. See
[Plex metadata sync](plex-metadata-sync.md) and
[Plex-Lidarr reconciliation](plex-lidarr-reconciliation.md) for the other workflows.

## Prerequisites

Before scanning:

- choose an absolute, non-symlink local music root;
- configure a media-server connection and credential;
- identify the media-server music library, either with `--library` or `plex.libraryName`; and
- have an existing schema-version-11 rfmedia tracking database.

The source path and the paths reported by the media server must describe the same host-visible
files. A container path such as `/music/Artist/Track.flac` does not match a host path such as
`/mnt/media/music/Artist/Track.flac`.

See the [media-server adapter](media-server-adapter.md) for connection and credential behavior and
the [centralized tracking database](centralized-tracking-db.doc.md) for the SQLite contract.

## Commands

### Scan

```text
rfmedia reconcile scan <source-path>
  [--library <name>]
  [--tracking-database <path>]
  [--operation-id <positive-integer>]
  [--workers <positive-integer>]
  [--no-progress]
```

Scan recursively reads supported audio files below the source root, inventory candidates below the
same destination root, and a complete media-server library snapshot. It does not initialize,
migrate, checkpoint, or write the database; write file tags; or send a provider mutation.

```bash
rfmedia reconcile scan /mnt/media/music --library Music
```

### Preview an Apply

`apply` requires exactly one winner flag:

```text
rfmedia reconcile apply <source-path>
  (--file-wins | --db-wins | --server-wins)
  [--library <name>]
  [--tracking-database <path>]
  [--operation-id <positive-integer>]
  [--workers <positive-integer>]
  [--popm-email <email>]
  [--execute]
  [--allow-partial]
  [-y|--yes]
  [--no-progress]
```

With no `--execute`, `apply` only computes a preview:

```bash
rfmedia reconcile apply /mnt/media/music --library Music --server-wins
```

There is no `rfmedia reconcile --dry-run` option. The absence of `--execute` is the dry-run
boundary. A preview can be blocked and still exit successfully because it produced the requested
report.

### Execute Interactively

Add `--execute` to request writes:

```bash
rfmedia reconcile apply /mnt/media/music \
  --library Music \
  --server-wins \
  --execute
```

In an interactive terminal, rfmedia shows a default-No confirmation. Declining performs no writes
and exits nonzero.

### Execute Non-Interactively

Machine output and non-TTY execution cannot prompt. They require both `--execute` and `--yes`:

```bash
rfmedia --output json reconcile apply /mnt/media/music \
  --library Music \
  --server-wins \
  --execute \
  --yes
```

`--yes` by itself never enables mutation. Selecting JSON, YAML, or CSV also never implies approval.

## Options

### Shared Scan and Apply Options

| Option                              | Behavior                                                              |
| ----------------------------------- | --------------------------------------------------------------------- |
| `<source-path>`                     | Required absolute local music root; must be a non-symlink directory   |
| `--library <name>`                  | Media-server library; falls back to `plex.libraryName`                |
| `--tracking-database <path>`        | Explicit existing rfmedia SQLite database                             |
| `--operation-id <positive-integer>` | Restrict inventory evidence to one operation generation               |
| `--workers <positive-integer>`      | Bound concurrent metadata readers                                     |
| `--no-progress`                     | Disable progress rendering; machine formats suppress it automatically |

### Apply-Only Options

| Option                 | Behavior                                                              |
| ---------------------- | --------------------------------------------------------------------- |
| `--file-wins`          | Use the embedded file rating as authority                             |
| `--db-wins`            | Use the selected inventory rating as authority                        |
| `--server-wins`        | Use the media-server rating as authority                              |
| `--popm-email <email>` | POPM owner used for supported MP3 rating writes                       |
| `--execute`            | Request execution of a freshly acquired plan                          |
| `--allow-partial`      | During execution, run independent actionable records despite blockers |
| `-y, --yes`            | Approve execution without an interactive prompt                       |

The winner flags conflict with one another. They select rating policy, not write authority.
`--execute`, followed by interactive approval or `--yes`, grants write authority.

`--allow-partial` is inert in a preview. It matters only with `--execute`.

## Configuration and Database Precedence

### Media Library

The library is selected in this order:

1. `--library <name>`
2. `plex.libraryName` in the loaded rfmedia configuration

The command fails if neither supplies a non-empty name. It does not silently assume `Music`.

### Tracking Database

The database path is selected in this order:

1. `--tracking-database <path>`
2. `undo.database` in the loaded configuration
3. `tracking.database` in the loaded configuration
4. existing `~/.config/rfmedia/tracking.db`
5. existing `~/.rfmedia/tracking.db`
6. `~/.config/rfmedia/tracking.db` as the path for a new writable database

Scan and apply preview are read-only, so the selected file must already exist. The final fallback
does not authorize either mode to create it. Use an explicit path if multiple inventory databases
exist and confirm the resolved `databasePath` in output before executing.

Example:

```yaml
plex:
  libraryName: Music

undo:
  database: /var/lib/rfmedia/tracking.db

tracking:
  database: /var/lib/rfmedia/other.db
```

In this example, reconciliation uses `undo.database` unless `--tracking-database` overrides it.

### Media-Server Connection

Reconciliation uses the provider-neutral media-server adapter and the normal Plex configuration
and credential precedence. It has no command-local URL or token options. See
[Media Server Adapter](media-server-adapter.md) and
[Plex Configuration](plex-configuration.md).

## Identity and Evidence Rules

### Exact Path Is the Only Track Identity

Evidence joins on normalized absolute paths contained by the selected source root:

- local file path;
- exact `inventory.dest_path`; and
- media-server track path.

Matching is case-sensitive and segment-aware. rfmedia does not match by basename, title, artist,
relative suffix, fuzzy similarity, or guessed path mapping. Empty paths, relative paths, paths that
escape the root, and server paths under a different mount prefix are not substituted.

This refusal is intentional: two files can share a name, and guessing could write the wrong track.
Correct the media-server path mapping or select the matching host-visible root instead.

### Operation-Scoped Inventory

Inventory is historical and operation-scoped, not one global mutable catalog. Multiple operations
can legitimately contain the same destination. If more than one candidate claims a path,
reconciliation reports `ambiguous-database-entry` rather than choosing the newest row.

Use `--operation-id` to select a known generation:

```bash
rfmedia reconcile scan /mnt/media/music \
  --library Music \
  --operation-id 417
```

The selector must still leave no duplicate candidate for a destination. Output retains operation
IDs and exact row provenance so an operator can investigate ambiguity.

### Duplicate Server Paths

If two server tracks expose the same non-empty path, reconciliation reports
`ambiguous-server-path`. It never picks the first track. An empty or unavailable server path is not
joined using other metadata.

## Observed Fields and Write Capabilities

The scan observes four fields:

- `rating`: normalized `0..1`; `null` means missing or unrated, not numeric zero;
- `artist`: primary artist only;
- `genre`: first genre only; and
- `year`: a safe integer from 1000 through 9999.

Artist and genre comparison uses Unicode NFC normalization, trimming, and case-insensitive
comparison while retaining original source text for output. Ratings involving the server compare
at the adapter's declared native rating step.

| Field    | File read | DB read | Server read         | File write | DB write | Server write | V1 apply |
| -------- | --------- | ------- | ------------------- | ---------- | -------- | ------------ | -------- |
| `rating` | Yes       | Yes     | Yes                 | Linux MP3  | Yes      | Yes          | Repair   |
| `artist` | Yes       | Yes     | Yes                 | No         | No       | No           | Observe  |
| `genre`  | First     | First   | If adapter projects | No         | No       | No           | Observe  |
| `year`   | Yes       | Yes     | Yes                 | No         | No       | No           | Observe  |

Only rating participates in the winner strategy. Artist, genre, and year drift remains in
`observedResiduals` and never causes an implicit SQLite-only update.

The inventory schema has rating, genre, year, BPM, and artist columns, but existing producers may
leave metadata columns `NULL`. A `NULL` value is missing evidence. In particular, `--db-wins` never
interprets `NULL` as an instruction to clear a file or server rating.

## Findings

| Code                       | Meaning                                            |
| -------------------------- | -------------------------------------------------- |
| `missing-value`            | At least one plane lacks the compared field        |
| `missing-database-entry`   | No inventory candidate exists for the exact path   |
| `missing-server-track`     | No server track exists for the exact path          |
| `stale-database-entry`     | Destination is absent or stored size/mtime differs |
| `conflicting-value`        | Present values disagree after field normalization  |
| `ambiguous-database-entry` | Multiple inventory rows claim the exact path       |
| `ambiguous-server-path`    | Multiple server tracks claim the exact path        |
| `unsupported-target`       | Requested repair has no V1 writer                  |
| `in-sync`                  | All available required evidence agrees             |

Path-level findings use `field: null`. Field findings contain file, database, and server evidence
with `present`, `missing`, `unavailable`, or `invalid` state. The public type reserves a `failed`
observation and `read-failed` finding for direct pure-engine inputs, but the CLI never emits either:
file metadata read or parse failure aborts acquisition and produces the invocation-level error
envelope described under [Exit Behavior](#exit-behavior).

`repairable` describes the V1 capability boundary; it does not guarantee that a particular apply
is safe. Authority, ambiguity, freshness, and target support are checked again during planning and
execution.

## Winner Strategies

Each strategy chooses the sole authority for normalized rating:

| Strategy        | Authority | Possible losing targets                |
| --------------- | --------- | -------------------------------------- |
| `--file-wins`   | File      | Selected database row and media server |
| `--db-wins`     | Database  | File and media server                  |
| `--server-wins` | Server    | File and selected database row         |

A missing, unavailable, invalid, failed, or ambiguous authority blocks that record. rfmedia never
falls back to another plane. For example, `--db-wins` with a missing database rating does not
borrow the server value.

Database stat refresh is separate from rating authority. When exactly one inventory row points to
a still-present regular file whose integer-millisecond mtime or size changed, apply can refresh
that row's stat evidence. The winner flag does not choose the source of those stats; the checked
file does.

## Preview, Blockers, and Partial Execution

Preview is always safe to run:

```bash
rfmedia reconcile apply /mnt/media/music --db-wins --output yaml
```

The result has `status: preview`, `executed: false`, and exit code `0`. If requested work has known
blockers, `executable` is `false` and the blockers explain why.

Without `--allow-partial`, any known rating or stat-plan blocker prevents every write:

```bash
rfmedia reconcile apply /mnt/media/music \
  --db-wins \
  --execute \
  --yes
```

The executed request returns `status: blocked` and exits `1` before opening writable dependencies.

To attempt only records that have no local blocker:

```bash
rfmedia reconcile apply /mnt/media/music \
  --db-wins \
  --execute \
  --allow-partial \
  --yes
```

Blocked records remain visible. Even if actionable records succeed, unresolved requested work
keeps the result `partial` with exit code `1`. The flag does not weaken exact-path, authority,
freshness, or target-write checks.

## Execution Safety and Ordering

An authorized apply follows these stages:

1. acquire and plan from all three planes;
2. obtain interactive approval, unless `--yes` was explicit;
3. reacquire all three planes and require the report and plan to remain unchanged;
4. before the first mutation for each record, require the exact identity-pinned SQLite row and
   operation generation to retain their reviewed values;
5. before each file write, repeat root containment, `lstat`, regular-file/no-symlink, fingerprint,
   trusted ownership/write-permission, and authority checks;
6. attempt external file and server targets before SQLite for that record, using the authority
   guard described below;
7. update SQLite using row ID, operation ID, destination path, old rating, old mtime, and old size
   as optimistic guards in a short transaction; and
8. run a fresh post-apply acquisition and verify requested rating convergence and pending stat
   refreshes.

A failed target prevents later targets for that record. SQLite is deliberately last so it cannot
claim convergence before non-transactional external writes succeed. The file, provider, and
database cannot share one transaction, so a truthful partial result is possible.

A zero-row guarded database update is `stale-evidence`, not last-writer-wins. Reconciliation never
deletes a stale inventory row or recreates a missing destination.

For `--db-wins`, each record with authority-derived file or server mutations requires a short
writable, identity-pinned SQLite authority reservation. It opens a `BEGIN IMMEDIATE` transaction
before exact-row and schema access and remains held across that record's external mutations. A
successful record commits and returns the refreshed generation; error or cancellation rolls back
and closes the lease. This prevents another database writer from changing the reviewed authority
during the write. An external-only record under `--file-wins` or `--server-wins` instead uses a
non-mutating current-generation guard; it does not open SQLite for writing merely to protect an
authority from another plane.

Writable reconciliation requires the tracking database, its parent, and the controlling ancestor
chain to exclude untrusted write/rename authority. The action accepts effective-user/root ownership
and safe sticky-directory ancestry, pins the chain and reviewed database with descriptors, and
opens the immediate SQLite transaction before schema access. Processes running as the same
effective user remain inside the trust boundary because they can already write the reviewed
database.

On Linux, MP3 publication pins a trusted directory chain and addresses source, stage, replacement,
and cleanup through the immediate parent descriptor. The source must be owned by the effective user
or root and must not grant group, world, or access-ACL-effective write permission. Reconciliation
revalidates that trust and the source snapshot immediately before publication. It preserves mode,
ownership, POSIX ACLs, and extended attributes or fails closed. The generic tag writer can update
FLAC for established workflows, but reconciliation treats FLAC as an unsupported mutation target
until it has the same descriptor-anchored publication and metadata-retention boundary.

### Platform Support

- Scan and preview are non-mutating and use the immutable database snapshot boundary.
- Safe MP3 reconciliation writes require Linux, `/proc/self/fd`, and GNU `cp` metadata-preservation
  support.
- Writable SQLite reconciliation requires Linux `/proc/self/fd` or macOS `/dev/fd`; other platforms
  fail closed before mutation.
- FLAC and every other local format remain observable but unsupported as reconciliation write
  targets.

## Output Formats

The global `--output <json|yaml|csv|table|text>` option may appear before or after the command
hierarchy. `--json` is shorthand for `--output json`.

### Human Output

`text` and `table` use the reconciliation human presenter. It writes headings, provenance, counts,
findings, blockers, outcomes, and post-apply verification to stderr. Detail sections display the
first 20 rows; use JSON, YAML, or CSV for the complete result. Human output replaces terminal
control and bidirectional-control characters in paths, labels, and projected values. Machine
formats preserve the raw result data.

```text
Metadata Reconciliation

  apply/preview · successful · exit 0
  Source: /mnt/media/music
  Library: Music · Database: /var/lib/rfmedia/tracking.db
  Strategy: server-wins · Executed: false · Executable: true
```

### JSON and YAML

JSON and YAML write one prose-free envelope to stdout:

```json
{
  "command": "reconcile",
  "result": {
    "schema": "rfmedia.reconcile.v1",
    "status": "scanned",
    "success": true,
    "exitCode": 0,
    "mode": "scan",
    "strategy": null,
    "sourceRoot": "/mnt/media/music",
    "library": "Music",
    "databasePath": "/var/lib/rfmedia/tracking.db",
    "operationId": null,
    "requestedFields": ["rating"],
    "requestedOperations": ["rating", "database-stat-refresh"],
    "executed": false,
    "executable": true,
    "allowPartial": false,
    "counts": {
      "paths": 0,
      "findings": 0,
      "inSync": 0,
      "observedResiduals": 0,
      "blockers": 0,
      "ratingOutcomes": {
        "total": 0,
        "planned": 0,
        "applied": 0,
        "skipped": 0,
        "unsupported": 0,
        "failed": 0
      },
      "databaseStatOutcomes": {
        "total": 0,
        "planned": 0,
        "applied": 0,
        "skipped": 0,
        "failed": 0
      }
    },
    "findings": [],
    "observedResiduals": [],
    "blockers": [],
    "failureCodes": [],
    "outcomes": [],
    "postApply": null
  }
}
```

Representative result states are:

| Scenario                    | Status    | Key evidence                                               | Exit |
| --------------------------- | --------- | ---------------------------------------------------------- | ---- |
| Complete scan with drift    | `scanned` | Findings contain the drift                                 | `0`  |
| Blocked apply preview       | `preview` | `executable: false`; blockers explain why                  | `0`  |
| Successful executed apply   | `applied` | `executed: true`; `postApply.status: verified`             | `0`  |
| Unsupported file target     | `preview` | Blocker code `unsupported-target`; observed drift retained | `0`  |
| Some targets applied/failed | `partial` | Per-target codes plus incomplete/failed post-apply         | `1`  |

Machine-mode validation or acquisition failure emits a redacted
`{ "command": "reconcile", "error": { "message": "...", "exitCode": 1 } }` envelope instead of a
result.

### CSV

CSV has a fixed schema and one of these `rowKind` discriminators:

1. `summary` — always first, including an empty successful scan;
2. `finding` — one row per finding; and
3. `outcome` — one row per planned or executed target.

Nested evidence, operation IDs, server track IDs, blockers, and before/intended values are
JSON-encoded inside fixed columns. Do not parse CSV by column position from a human example; use
the header names and `rowKind`.

```bash
rfmedia reconcile scan /mnt/media/music --output csv >reconciliation.csv
```

All formats use deterministic path, field, plane, blocker, and outcome ordering. Machine formats
suppress progress and human prose so stdout contains only the document. See
[Output Formats](../../../../docs/features/output-formats.md) for the shared root-option rules.

## Exit Behavior

| Exit  | Meaning                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Complete scan or preview; or an executed apply freshly verified all requested work                                              |
| `1`   | Validation/acquisition failure, declined or blocked execution, stale evidence, partial/failed apply, or incomplete verification |
| `130` | SIGINT cancellation during acquisition or execution                                                                             |
| `143` | SIGTERM cancellation during acquisition or execution                                                                            |

Ordinary drift, missing values, ambiguity, unsupported observation, and even a blocked preview are
report data and do not make a successfully produced scan or preview fail. A per-file metadata read
or parse failure is instead an acquisition failure: it exits `1` and produces neither a successful
reconciliation result nor a per-file `read-failed` finding. In machine mode, it emits the error
envelope described above. Database and provider acquisition failures follow the same contract.

Do not use scan's exit code as a "no drift" test. Inspect `result.counts`, `findings`,
`observedResiduals`, and `executable` instead. An authorized apply is stricter: declined, blocked,
stale, partial, failed, cancelled, or incompletely verified execution is nonzero.

## Supported Formats and Limitations

Discovery recognizes FLAC, WAV, MP3, OGG, Opus, M4A, AAC, WMA, AIFF, APE, WavPack, and ALAC
extensions. Successful metadata observation still depends on the file being parseable.

V1 limitations:

- only Linux MP3 has a supported reconciliation rating writer; FLAC and other formats remain
  observable but are unsupported mutation targets;
- OGG, Opus, M4A, AAC, and the other discovered formats remain observable but cannot receive a
  file rating through this workflow;
- artist, genre, and year are observation-only;
- genre compares only the first projected genre;
- a server adapter that does not project genres reports server genre as unavailable;
- inventory metadata may be absent even when path, stat, rating, or hash evidence exists;
- stale inventory rows are retained as history and never deleted;
- file discovery is bounded to 100,000 candidates and fails before metadata reads are scheduled;
- local acquisition uses a bounded worker queue and retains at most 64 MiB of projected metadata;
- the inventory query is bounded to 10,000 candidates;
- the complete server snapshot is bounded to 100,000 tracks and 64 MiB of retained projected JSON;
- provider identifiers are bounded to 1,024 UTF-8 bytes;
- projected text values are bounded to 2,048 UTF-8 bytes, paths to 16 KiB, and each tag family to
  256 values;
- the immutable database snapshot is bounded to 256 MiB;
- embedded rating writes require a singly linked file; hardlinked files remain observable but are
  unsupported mutation targets;
- MP3 rating targets must be owned by the effective user or root and must not have group, world, or
  access-ACL-effective write permission;
- MP3 rating writes are limited to files no larger than 32 MiB because the writer holds synchronous
  whole-file buffers;
- there is no saved or sealed plan artifact between invocations; and
- there is no cross-resource transaction.

## Safe Reruns and Recovery

After a partial or failed apply:

1. save the machine result and note every applied, failed, skipped, and unsupported outcome;
2. run `rfmedia reconcile scan` again to observe current truth;
3. correct path mappings, database selection, duplicates, unsupported targets, or provider access;
4. preview the same intended winner strategy again; and
5. execute only after reviewing the new plan.

Reruns reacquire evidence rather than replaying an old plan. Already converged targets are skipped,
and optimistic SQLite guards refuse to overwrite a row changed by another process.

## Troubleshooting

### Tracking Database Is Missing

Confirm the `databasePath` precedence above. Scan and preview do not create a database. Generate or
migrate tracking state with the appropriate write-capable rfmedia workflow, or pass the intended
existing file with `--tracking-database`.

### Database Is a Symlink, Old, New, Active, or Oversized

Read-only acquisition requires an existing non-symlink regular schema-version-11 database. It
rejects:

- schema versions older or newer than 11;
- `-wal`, `-shm`, or `-journal` sidecars;
- a file that changes while its immutable snapshot is read; and
- files larger than 256 MiB.

Stop the process actively using SQLite and allow it to checkpoint cleanly. Run a migration-capable
matching rfmedia version for an old database, upgrade rfmedia for a newer database, or compact and
archive historical state before retrying an oversized database.

### Database Evidence Is Ambiguous

Inspect `operationIds`, then retry with the intended positive `--operation-id`. If ambiguity
remains inside that generation, investigate the inventory rather than deleting history or selecting
a row by timestamp.

### Server Tracks Are Missing or Ambiguous

Verify that the selected library is correct and completely accessible. Ensure server track paths
use the same absolute host-visible prefix as `<source-path>`. Resolve duplicate server items in the
provider; rfmedia does not choose one.

### File Metadata Cannot Be Read

The command treats a file read or parse failure as a nonzero acquisition failure, not as report
data. It exits `1` without a successful reconciliation result or per-file finding. Machine output
is a redacted `{ "command": "reconcile", "error": { "message": "...", "exitCode": 1 } }` envelope.
Validate the file with a media inspection tool, repair the container/tag data outside
reconciliation, then rescan.

### File Rating Target Is Unsupported

Use preview output to identify `unsupported-target`. V1 writes embedded ratings only to Linux MP3,
requires a singly linked file, and limits MP3 targets to 32 MiB. Hardlinked files are never written
because replacing one directory entry would break the expectation that every link still names the
same inode. At execution, the MP3 writer also fails closed unless the file is owned by the effective
user or root and has no group, world, or access-ACL-effective write permission. Convert or update
other formats with a format-aware tool, copy a hardlinked file to a standalone trusted inode before
reconciling it, or update an oversized MP3 outside this workflow, then rescan. `--allow-partial`
does not make an unsupported writer safe.

### Projected Metadata Exceeds a Safety Limit

Acquisition refuses provider identifiers over 1,024 UTF-8 bytes, projected text over 2,048 UTF-8
bytes, projected paths over 16 KiB, tag families over 256 values, server snapshots over 100,000
tracks or 64 MiB of retained projected JSON, local snapshots over 64 MiB of projected metadata,
inventories over 10,000 candidates, file discovery over 100,000 candidates, and immutable database
snapshots over 256 MiB. Reduce or repair the oversized provider or inventory data, narrow the
selected library or source root, or compact the tracking database, then retry. These limits are
refusal boundaries and cannot be bypassed with `--allow-partial`.

### Provider Acquisition or Update Fails

Check media-server URL, credential, selected library, pagination completeness, and provider health.
A partial page is never accepted as a complete snapshot. If a write succeeded before another
target failed, follow the safe rerun procedure rather than manually editing SQLite.

### Evidence Changes After Approval

Reconciliation returns `stale-evidence` when the fresh pre-write report or plan differs from the
approved one, a file fingerprint changes, or an optimistic database update matches no row. Stop
other writers, rescan, and review a new preview. Do not repeatedly add `--allow-partial` to bypass
changing evidence; it does not disable freshness checks.

## Security and Privacy

- Prefer enrolled media-server credentials or environment-backed secret templates; never place a
  token in command history.
- Output includes selected local paths and metadata values. Treat saved JSON, YAML, and CSV as
  potentially sensitive library inventories.
- Reconciliation output excludes credentials, raw provider responses, database payloads, and full
  content hashes. Errors pass through credential redaction.
- Machine output is data, not consent. Always include `--execute --yes` explicitly in automation
  that is intended to mutate.
- Keep the source root and database writable only by trusted users. Reconciliation rejects
  symlinked roots, files discovered through symlinks, and symlinked read-only databases. Supported
  Linux MP3 writes additionally require effective-user/root file ownership without group, world, or
  access-ACL-effective write permission, pin the trusted directory chain, and address publication
  through directory descriptors; other local formats are refused as file-write targets before
  local mutation.
- Cancellation stops new admissions and reports completed outcomes truthfully. Because external
  writes are not transactional, inspect the result and rescan before retrying.

## Related Documentation

- [Centralized Tracking Database](centralized-tracking-db.doc.md)
- [Media Server Adapter](media-server-adapter.md)
- [Plex Metadata Sync](plex-metadata-sync.md)
- [Plex-Lidarr Reconciliation](plex-lidarr-reconciliation.md)
- [Output Formats](../../../../docs/features/output-formats.md)
- [Shell Completion](shell-completion.doc.md)
