# Queue Command

This document describes the queue command for managing batch copy and delete jobs with persistent storage and deferred execution.

## Overview

The `rfmedia queue` command enables batch job management for copy and delete operations. Instead of executing operations immediately, jobs can be queued for later execution. This is useful for:

- **Batch processing** - Queue multiple jobs and run them all at once
- **Deferred execution** - Add jobs throughout the day, run overnight
- **Resume support** - Jobs persist across CLI restarts
- **Parallel execution** - Run multiple jobs concurrently with configurable workers
- **Mixed operations** - Queue both copy and delete jobs in the same batch

Jobs are stored persistently in a SQLite database at `~/.config/rfmedia/tracking.db` and survive CLI restarts. (Legacy JSON storage at `~/.rfmedia/queue.json` is automatically migrated on first use.)

## User Interface

### Command Structure

The queue command uses a subcommand structure:

```bash
rfmedia queue <subcommand> [options]
```

### Subcommands Overview

| Subcommand   | Description                            |
| ------------ | -------------------------------------- |
| `add copy`   | Add a copy job to the queue            |
| `add delete` | Add a delete job to the queue          |
| `list`       | List jobs in the queue with statistics |
| `run`        | Execute all pending jobs in the queue  |
| `clear`      | Remove jobs from the queue             |

### queue add copy

Add a copy job to the queue for later execution.

```bash
rfmedia queue add copy [source] [destination] [options]
```

#### Arguments

| Argument        | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `[source]`      | Source path for the copy operation (optional when using `--paths`)      |
| `[destination]` | Destination path for the copy operation (optional when using `--paths`) |

#### YAML-Based Input

| Option                   | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `--paths <file>`         | Read sources and destination from YAML paths file                        |
| `--source-idx <indices>` | Select sources by index (e.g., `"1,3"` or `"2-5"`) - requires `--paths`  |
| `--source-name <names>`  | Unified search: matches groups, artist, or basename - requires `--paths` |
| `--artist <names>`       | Select sources by artist name (case-insensitive) - requires `--paths`    |
| `--group <names>`        | Select sources by group name (case-insensitive) - requires `--paths`     |
| `-i, --interactive`      | Interactively select sources before queuing                              |

#### Album Mode Options

| Option                    | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `-r, --range <START-END>` | Range of suffixes to create (e.g., `001-010`)        |
| `--count <N>`             | Number of copies to create (auto-detects next range) |
| `--album-only`            | Treat source as single album                         |
| `--file <path>`           | Read source paths from file                          |

#### Filter Mode Options

| Option                   | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `--min-stars <N>`        | Minimum star rating (1.0-5.0)                            |
| `--min-rating <N>`       | Minimum rating (0-100)                                   |
| `--output-folder <name>` | Folder name for filtered tracks (default: `liked-songs`) |
| `--preserve-structure`   | Keep album subfolders in output                          |
| `--album-mode`           | Preserve album folders with only liked tracks            |

#### Common Options

| Option                   | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `--hardlink`             | Use hardlinks instead of copies                |
| `--force`                | Overwrite existing copies                      |
| `-w, --workers <N>`      | Number of parallel workers                     |
| `-c, --convert <format>` | Convert audio to format (alac, mp3, aac, opus) |
| `--progress`             | Show visual progress bar                       |
| `--plex-scan`            | Trigger Plex scan after completion             |
| `--plex-library <name>`  | Plex library name to scan                      |

#### Example Usage

```bash
# Add album mode job with range
rfmedia queue add copy /music/Artist /dest --range=001-005

# Add filter mode job with star rating
rfmedia queue add copy /music/Artist /dest --min-stars=4

# Add job with audio conversion
rfmedia queue add copy /music/Artist /dest --range=001-003 --convert=mp3

# Add job with Plex integration
rfmedia queue add copy /music/Artist /dest --min-rating=80 --plex-scan

# Preview without adding (dry-run)
rfmedia queue add copy /music/Artist /dest --range=001-005 --dry-run

# Queue from YAML paths file (destination from YAML)
rfmedia queue add copy --paths sources.yml

# Queue with source filtering by group
rfmedia queue add copy --paths sources.yml --group=pop-divas

# Queue with source filtering by artist
rfmedia queue add copy --paths sources.yml --artist="Taylor Swift,Beyoncé"

# Queue with source filtering by index
rfmedia queue add copy --paths sources.yml --source-idx="1,3-5"

# Queue with interactive source selection
rfmedia queue add copy --paths sources.yml --interactive

# Combine filters: select from a group interactively
rfmedia queue add copy --paths sources.yml --group=rock --interactive
```

#### Limitations with Interactive Selection

When using `--interactive` with `queue add copy`, only **source-level selection** is preserved in the queue job. Any album-level or track-level refinements made during the interactive session are **not preserved** because the `CopySelection.sourceSelections` Map is non-serializable.

**What is preserved:**

- Which sources you selected (the paths)

**What is NOT preserved:**

- Per-album selections within a source
- Per-track selections within an album
- Any refinements beyond source-level selection

For full interactive control including album/track refinements, use the `copy` command directly instead of queuing.

### queue add delete

Add a delete job to the queue for later execution.

```bash
rfmedia queue add delete [paths...] [options]
```

#### Arguments

| Argument     | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| `[paths...]` | Source and destination paths (same format as delete command) |

#### YAML-Based Input

| Option                   | Description                                                              |
| ------------------------ | ------------------------------------------------------------------------ |
| `--paths <file>`         | Read sources and destination from YAML paths file                        |
| `--source-idx <indices>` | Select sources by index (e.g., `"1,3"` or `"2-5"`) - requires `--paths`  |
| `--source-name <names>`  | Unified search: matches groups, artist, or basename - requires `--paths` |
| `--artist <names>`       | Select sources by artist name (case-insensitive) - requires `--paths`    |
| `--group <names>`        | Select sources by group name (case-insensitive) - requires `--paths`     |
| `-i, --interactive`      | Interactively select sources before queuing                              |

#### Album Mode Options

| Option                    | Description                                        |
| ------------------------- | -------------------------------------------------- |
| `-r, --range <START-END>` | Range of suffixes to delete (e.g., `008-010`)      |
| `--count <N>`             | Number of copies to delete (deletes highest first) |
| `--album-only`            | Treat source as single album                       |
| `--file <path>`           | Read source paths from file                        |

#### Filter Mode Options

| Option                   | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `--min-stars <N>`        | Delete copies with this star rating filter (1.0-5.0) |
| `--min-rating <N>`       | Delete copies with this rating filter (0-100)        |
| `--output-folder <name>` | Output folder name used for filtered tracks          |
| `--album-mode`           | Match album folders pattern                          |

#### Delete-Specific Options

| Option            | Description                               |
| ----------------- | ----------------------------------------- |
| `--trash`         | Move to trash instead of permanent delete |
| `--keep-tracking` | Keep database tracking entries            |

#### Common Options

| Option                   | Description                        |
| ------------------------ | ---------------------------------- |
| `-w, --workers <N>`      | Number of parallel workers         |
| `-c, --convert <format>` | Match files converted to format    |
| `--progress`             | Show visual progress bar           |
| `--plex-scan`            | Trigger Plex scan after completion |
| `--plex-library <name>`  | Plex library name to scan          |

#### Example Usage

```bash
# Add album mode delete job with range
rfmedia queue add delete /music/Artist /dest --range=008-010

# Add delete job with count (deletes highest 3 suffixes)
rfmedia queue add delete /music/Artist /dest --count=3

# Add filter mode delete job
rfmedia queue add delete /music/Artist /dest --min-stars=4

# Add delete job with trash mode
rfmedia queue add delete /music/Artist /dest --range=001-005 --trash

# Preview without adding (dry-run)
rfmedia queue add delete /music/Artist /dest --range=001-005 --dry-run

# Queue from YAML paths file
rfmedia queue add delete --paths sources.yml

# Queue with source filtering by group
rfmedia queue add delete --paths sources.yml --group=pop-divas

# Queue with interactive source selection
rfmedia queue add delete --paths sources.yml --interactive
```

#### Limitations with Interactive Selection

When using `--interactive` with `queue add delete`, only **source-level selection** is preserved in the queue job. Any album-level or suffix-level refinements made during the interactive session are **not preserved** because the `DeleteSelection.sourceSelections` Map is non-serializable.

**What is preserved:**

- Which sources you selected (the paths)

**What is NOT preserved:**

- Per-source suffix selections
- Album-level refinements within a source
- Any refinements beyond source-level selection

For full interactive control including suffix-level refinements, use the `delete` command directly instead of queuing.

### queue list

List jobs in the queue with status filtering and detailed information.

```bash
rfmedia queue list [options]
```

#### Options

| Option              | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `--status <status>` | Filter by status: `pending`, `running`, `completed`, `failed` |
| `-v, --verbose`     | Show detailed job information                                 |

#### Example Usage

```bash
# List all jobs
rfmedia queue list

# List only pending jobs
rfmedia queue list --status=pending

# List failed jobs with details
rfmedia queue list --status=failed --verbose
```

#### Output Format

The list command displays:

1. **Summary statistics** - Counts by status (pending, running, completed, failed)
2. **Jobs table** - ID, type, status, mode, source, and age for each job
3. **Verbose details** - Full source/destination paths, mode-specific options, errors

Example output:

```
Queue Status
  Pending:   3
  Running:   0
  Completed: 5
  Failed:    1

Jobs
┌──────────┬────────┬───────────┬────────┬──────────────────────────────────────────┬──────────┐
│ ID       │ Type   │ Status    │ Mode   │ Source                                   │ Added    │
├──────────┼────────┼───────────┼────────┼──────────────────────────────────────────┼──────────┤
│ a1b2c3d4 │ copy   │ pending   │ album  │ .../music/Artist1                        │ 5m ago   │
│ e5f6g7h8 │ delete │ pending   │ filter │ .../music/Artist2                        │ 2h ago   │
│ i9j0k1l2 │ copy   │ failed    │ album  │ .../music/Artist3                        │ 1d ago   │
└──────────┴────────┴───────────┴────────┴──────────────────────────────────────────┴──────────┘
```

### queue run

Execute all pending jobs in the queue.

```bash
rfmedia queue run [options]
```

#### Options

| Option                | Description                                 |
| --------------------- | ------------------------------------------- |
| `-w, --workers <N>`   | Number of parallel job workers (default: 1) |
| `--continue-on-error` | Continue running jobs after failures        |
| `--plex-scan`         | Trigger Plex scan after completion          |
| `--no-plex-scan`      | Disable Plex scan                           |

#### Example Usage

```bash
# Run all pending jobs sequentially
rfmedia queue run

# Run with parallel workers
rfmedia queue run --workers=4

# Continue despite failures
rfmedia queue run --continue-on-error

# Run with Plex scan at completion
rfmedia queue run --plex-scan

# Preview what would run (dry-run)
rfmedia queue run --dry-run
```

#### Execution Behavior

1. All pending jobs are marked as `running`
2. Jobs are processed in parallel (up to `--workers` count)
3. Successful jobs are marked `completed` and removed from queue
4. Failed jobs are marked `failed` with error message and remain in queue
5. Plex scan triggered if enabled and at least one job completed

### queue clear

Remove jobs from the queue.

```bash
rfmedia queue clear [options]
```

#### Options

| Option        | Description               |
| ------------- | ------------------------- |
| `--completed` | Only clear completed jobs |
| `--failed`    | Only clear failed jobs    |
| `--pending`   | Only clear pending jobs   |
| `-f, --force` | Skip confirmation prompt  |

**Note:** Completed jobs are now kept in the queue for history and search features. Use `queue clear --completed` to remove them when no longer needed.

#### Example Usage

```bash
# Clear all jobs (with confirmation)
rfmedia queue clear

# Clear only completed jobs
rfmedia queue clear --completed

# Clear failed jobs without confirmation
rfmedia queue clear --failed --force

# Preview what would be cleared (dry-run)
rfmedia queue clear --dry-run
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Queue Add Command (copy/delete)                     │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Parse CLI options (mode, range/rating, convert, etc.)               │
│  2. Check for --paths option:                                           │
│     ├─ If --paths: Load YAML file via loadAndValidatePathsYaml()        │
│     │   ├─ Apply source selection filters (--source-idx, --artist, etc.)│
│     │   ├─ Get destination from YAML                                    │
│     │   └─ Store resolved PathEntry[] (not YAML path) in job            │
│     └─ If no --paths: Use CLI source/destination arguments              │
│  3. Check for --interactive option:                                     │
│     └─ If --interactive: Run runInteractiveSelection() on sources       │
│        └─ Filter sourceEntries to only selected sources                 │
│        └─ Interactive selections ARE preserved in database              │
│  4. Build CopyOptions or DeleteOptions from CLI + config defaults       │
│  5. Convert to Serializable* (exclude non-serializable fields)          │
│  6. Create QueueJob with UUID, timestamp, pending status, jobType       │
│     ├─ jobType: 'copy' or 'delete'                                      │
│     ├─ Single-source: job.source = path string                          │
│     └─ Multi-source: job.sources = PathEntry[] (from --paths/--file)    │
│  7. Open database connection (SQLite)                                   │
│  8. Insert job into queue_jobs table                                    │
│  9. If multi-source: Insert into queue_job_sources table                │
│ 10. If interactive selection: Serialize to queue_job_selections         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Queue Storage                                  │
├─────────────────────────────────────────────────────────────────────────┤
│  Location: SQLite database (~/.config/rfmedia/tracking.db)              │
│                                                                         │
│  Tables:                                                                │
│  • queue_jobs - Main job records (id, type, status, source, options)   │
│  • queue_job_sources - Multi-source entries (from --paths YAML)        │
│  • queue_job_selections - Interactive selections (preserves Maps)      │
│  • queue_job_selected_items - Individual selected albums/tracks/suffixes│
│                                                                         │
│  Migration from JSON:                                                   │
│  • Legacy ~/.rfmedia/queue.json is automatically migrated on first load│
│  • After migration, JSON file renamed to queue.json.migrated           │
│  • Interactive selections in old jobs cannot be recovered (lost in JSON)│
│                                                                         │
│  Example: Single-source job                                            │
│    queue_jobs: { id, job_type='copy', source='/path', destination,     │
│                  options_json, status='pending' }                       │
│                                                                         │
│  Example: Multi-source job with interactive selection                  │
│    queue_jobs: { id, job_type='delete', destination, ... }             │
│    queue_job_sources: [                                                │
│      { job_id, source_path='/path/1', count=5 },                       │
│      { job_id, source_path='/path/2', range_start=1, range_end=3 }     │
│    ]                                                                    │
│    queue_job_selections: { job_id, source_path='/path/1', ... }        │
│    queue_job_selected_items: [                                         │
│      { selection_id, item_type='suffix', item_value='/path/1/Album-001'}│
│    ]                                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Queue List Command                             │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Open database connection                                            │
│  2. Query jobs from queue_jobs table (with status filter if provided)   │
│  3. Load related sources from queue_job_sources for multi-source jobs   │
│  4. Calculate statistics (pending, running, completed, failed counts)   │
│  5. Format and display table with job details                           │
│  6. If --verbose, show full paths and mode-specific options             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Queue Run Command                              │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Query pending jobs from database (queue_jobs table)                 │
│  2. Setup graceful interruption handlers                                │
│  3. Process jobs in parallel (up to N workers)                          │
│     For each job:                                                       │
│     a. Update status to 'running' with started_at timestamp             │
│     b. Load job sources from queue_job_sources if multi-source          │
│     c. Load interactive selection from queue_job_selections if present  │
│     d. Convert Serializable* back to full options with selection        │
│     e. Execute action based on jobType and mode:                        │
│        - copy + album: executeAlbumCopyWithFileInput()                  │
│        - copy + filter: executeFilterCopyWithFileInput()                │
│        - delete + album: executeAlbumDeleteWithFileInput()              │
│        - delete + filter: executeFilterDeleteWithFileInput()            │
│     f. On success: mark completed, keep in database for history         │
│     g. On failure: mark failed, keep in database with error             │
│  4. Trigger Plex scan if enabled and jobs completed                     │
│  5. Return aggregated results                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Queue Clear Command                            │
├─────────────────────────────────────────────────────────────────────────┤
│  1. Open database connection                                            │
│  2. Filter jobs by status (if --completed/--failed/--pending)           │
│  3. Prompt for confirmation (unless --force)                            │
│  4. Remove matching jobs from queue                                     │
│  5. Save updated queue file                                             │
│  6. Report removed and remaining counts                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

## Architecture

### Queue Storage Format

The queue is stored in a database-backed architecture using SQLite at `~/.config/rfmedia/tracking.db`. For backward compatibility, a legacy JSON file format is still supported at `~/.rfmedia/queue.json`.

**Single-source copy job example (legacy JSON format):**

```json
{
  "version": "1",
  "updatedAt": "2026-01-15T10:30:00.000Z",
  "jobs": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "jobType": "copy",
      "addedAt": "2026-01-15T10:00:00.000Z",
      "source": "/mnt/music/Artist/Album",
      "destination": "/mnt/backup/music",
      "options": {
        "mode": {
          "type": "album",
          "range": { "start": 1, "end": 5, "padWidth": 3 }
        },
        "albumOnly": false,
        "hardlink": false,
        "force": false,
        "workers": 4
      },
      "status": "pending",
      "startedAt": null,
      "completedAt": null,
      "error": null
    }
  ]
}
```

**Note:** The above JSON examples represent the legacy file format. Jobs are now stored in SQLite database (`~/.config/rfmedia/tracking.db`) with proper support for interactive selections. See the Database Schema section for the current storage format.

**Single-source delete job example (legacy JSON format):**

```json
{
  "version": "1",
  "updatedAt": "2026-01-15T11:00:00.000Z",
  "jobs": [
    {
      "id": "b2c3d4e5-f6g7-8901-bcde-f12345678901",
      "jobType": "delete",
      "addedAt": "2026-01-15T11:00:00.000Z",
      "source": "/mnt/music/Artist",
      "destination": "/mnt/backup/music",
      "options": {
        "mode": {
          "type": "album",
          "range": { "start": 8, "end": 10, "padWidth": 3 }
        },
        "albumOnly": false,
        "force": false,
        "workers": 2,
        "useTrash": true,
        "keepTracking": false
      },
      "status": "pending"
    }
  ]
}
```

**Multi-source copy job example (from --paths):**

```json
{
  "version": "1",
  "updatedAt": "2026-01-15T10:30:00.000Z",
  "jobs": [
    {
      "id": "c3d4e5f6-g7h8-9012-cdef-g23456789012",
      "jobType": "copy",
      "addedAt": "2026-01-15T11:00:00.000Z",
      "sources": [
        { "path": "/mnt/music/Artist1" },
        {
          "path": "/mnt/music/Artist2",
          "range": { "start": 1, "end": 3, "padWidth": 3 }
        },
        { "path": "/mnt/music/Artist3" }
      ],
      "destination": "/mnt/backup/music",
      "options": {
        "mode": {
          "type": "filter",
          "rating": { "minStars": 4 }
        },
        "albumOnly": false,
        "hardlink": false,
        "force": false,
        "workers": 4,
        "sourceGroup": "pop-divas"
      },
      "status": "pending",
      "startedAt": null,
      "completedAt": null,
      "error": null
    }
  ]
}
```

**Key differences:**

- Jobs have a `jobType` field ('copy' or 'delete')
- Single-source jobs have a `source` field (string)
- Multi-source jobs have a `sources` field (PathEntry[])
- Source selection filters (`sourceIdx`, `sourceGroup`, etc.) are stored in `options` for reference

### Type Definitions

#### QueueJobType

```typescript
type QueueJobType = "copy" | "delete";
```

#### QueueJobStatus

```typescript
type QueueJobStatus = "pending" | "running" | "completed" | "failed";
```

#### QueueJob

```typescript
interface QueueJob {
  /** Unique job identifier (UUID) */
  id: string;
  /** Job type discriminator (copy or delete) */
  jobType: QueueJobType;
  /** ISO timestamp when the job was added to the queue */
  addedAt: string;
  /**
   * Source path for single-source jobs.
   * Either `source` (single path) or `sources` (multi-path from --paths/--file) will be set.
   */
  source?: string;
  /**
   * Source paths for multi-source jobs (from --paths or --file).
   * Each entry may include an optional per-path range.
   * Either `source` or `sources` must be present.
   */
  sources?: PathEntry[];
  /** Destination path for the operation */
  destination: string;
  /** Operation options (serializable subset) */
  options: SerializableCopyOptions | SerializableDeleteOptions;
  /** Current job status */
  status: QueueJobStatus;
  /** ISO timestamp when the job started running (optional) */
  startedAt?: string;
  /** ISO timestamp when the job completed or failed (optional) */
  completedAt?: string;
  /** Error message if the job failed (optional) */
  error?: string;
}
```

**Note:** A job will have either `source` (single-source mode) or `sources` (multi-source mode), but not both. At runtime, one of these must be present.

#### SerializableCopyOptions

A subset of `CopyOptions` that excludes non-JSON-serializable fields:

```typescript
interface SerializableCopyOptions {
  mode: CopyMode;
  albumOnly: boolean;
  hardlink: boolean;
  convertFormat?: ConvertFormat;
  force: boolean;
  workers: number;
  file?: string;
  paths?: string;
  progress?: boolean;
  trackCompleted?: boolean;
  completedFile?: string;
  resetCompleted?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireDiskSpace?: boolean;
  cliRange?: CopyRange;
  configRange?: CopyRange;
  count?: number;
  cliSourceEntries?: PathEntry[];
  verbose?: boolean;
  /** Source index selection used at add time (for display in queue list --verbose) */
  sourceIdx?: string;
  /** Source name selection used at add time */
  sourceName?: string;
  /** Artist selection used at add time */
  sourceArtist?: string;
  /** Group selection used at add time */
  sourceGroup?: string;
  // Note: selection and dryRun are excluded
}
```

**Excluded fields:**

- `selection` - Contains `ReadonlyMap` which is not JSON serializable
- `dryRun` - Determined at execution time, not queue time

**Source selection fields:**

The `sourceIdx`, `sourceName`, `sourceArtist`, and `sourceGroup` fields document what source selection was applied at queue-add time. The actual filtering happens at add time and the results are stored in `cliSourceEntries` (or `job.sources`). These fields are primarily for display purposes in `queue list --verbose`.

#### SerializableDeleteOptions

A subset of `DeleteOptions` that excludes non-JSON-serializable fields:

```typescript
interface SerializableDeleteOptions {
  mode: DeleteMode;
  albumOnly: boolean;
  convertFormat?: ConvertFormat;
  force: boolean;
  workers: number;
  file?: string;
  progress?: boolean;
  useTrash: boolean;
  keepTracking: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  cliRange?: CopyRange;
  configRange?: CopyRange;
  count?: number;
  cliSourceEntries?: PathEntry[];
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  /** Source index selection used at add time */
  sourceIdx?: string;
  /** Source name selection used at add time */
  sourceName?: string;
  /** Artist selection used at add time */
  sourceArtist?: string;
  /** Group selection used at add time */
  sourceGroup?: string;
  // Note: selection and dryRun are excluded
}
```

**Excluded fields:**

- `selection` - Contains `ReadonlyMap` which is not JSON serializable
- `dryRun` - Determined at execution time, not queue time

#### QueueFile

```typescript
interface QueueFile {
  /** Schema version for forward compatibility */
  version: "1";
  /** ISO timestamp when the queue was last updated */
  updatedAt: string;
  /** Array of queued jobs */
  jobs: QueueJob[];
}
```

#### Options Interfaces

```typescript
interface QueueAddOptions {
  /** Preview mode (don't actually add to queue) */
  dryRun: boolean;
}

interface QueueListOptions {
  /** Filter jobs by status (undefined = show all) */
  status?: QueueJobStatus;
  /** Show detailed job information */
  verbose: boolean;
  /** Preview mode (no-op for list) */
  dryRun: boolean;
}

interface QueueRunOptions {
  /** Number of parallel job workers */
  workers: number;
  /** Continue running jobs after failures */
  continueOnError: boolean;
  /** Trigger Plex scan after completion (overrides per-job settings) */
  plexScan?: boolean;
  /** Preview mode (show what would run without executing) */
  dryRun: boolean;
}

interface QueueClearOptions {
  /** Filter which jobs to clear by status (undefined = clear all) */
  status?: QueueJobStatus;
  /** Skip confirmation prompt */
  force: boolean;
  /** Preview mode (show what would be cleared) */
  dryRun: boolean;
}
```

#### Result Interfaces

```typescript
interface QueueRunResult {
  /** Total number of jobs that were processed */
  total: number;
  /** Number of jobs that completed successfully */
  completed: number;
  /** Number of jobs that failed */
  failed: number;
  /** Per-job result details */
  jobs: Array<{
    id: string;
    source: string;
    status: QueueJobStatus;
    error?: string;
  }>;
}

interface QueueClearResult {
  /** Number of jobs removed from the queue */
  removed: number;
  /** Number of jobs remaining in the queue */
  remaining: number;
}
```

### Serialization and Deserialization

Jobs are converted between full options and serializable options for storage:

**Adding a copy job (serialization):**

```typescript
function toSerializableOptions(options: CopyOptions): SerializableCopyOptions {
  const {
    selection: _selection, // Excluded: ReadonlyMap not JSON serializable
    dryRun: _dryRun, // Excluded: determined at run time
    ...serializable
  } = options;
  return serializable;
}
```

**Adding a delete job (serialization):**

```typescript
function toSerializableDeleteOptions(options: DeleteOptions): SerializableDeleteOptions {
  const {
    selection: _selection, // Excluded: ReadonlyMap not JSON serializable
    dryRun: _dryRun, // Excluded: determined at run time
    ...serializable
  } = options;
  return serializable;
}
```

**Running a copy job (deserialization):**

```typescript
function toCopyOptions(serializable: SerializableCopyOptions, dryRun: boolean): CopyOptions {
  return {
    ...serializable,
    dryRun,
  };
}
```

**Running a delete job (deserialization):**

```typescript
function toDeleteOptions(serializable: SerializableDeleteOptions, dryRun: boolean): DeleteOptions {
  return {
    ...serializable,
    dryRun,
  };
}
```

## Integration Points

### Tracking System

Each queued job creates its own operation in the tracking database when executed:

- Operation ID is generated based on job source, destination, and options hash
- Completed sources are tracked per-operation for resume support
- If a job is re-run after failure, tracking allows resuming from where it left off

### History System

The queue run command creates a single history session for the entire batch:

- One `HistoryRecorder` session encompasses all jobs in the run
- Individual file operations (copy, hardlink, convert) are recorded
- Session is closed with final status (pending/undone/partial) when run completes
- Enables undo of the entire queue run as a single operation

### Plex Integration

Plex scanning integrates at two levels:

1. **Per-job settings** - Jobs can have `plexScan`, `plexLibrary` options stored
2. **Queue run override** - `--plex-scan` / `--no-plex-scan` overrides all job settings
3. **Batch scan** - Single Plex scan triggered after all jobs complete (not per-job)

```typescript
// In executeQueueRun
if (options.plexScan !== false && results.completed > 0) {
  const plexConfig = buildPlexConfig(config?.plex, {});
  if (plexConfig) {
    await triggerPlexScan(plexConfig);
  }
}
```

### Graceful Interruption

The queue run command supports graceful interruption:

1. **Signal handling** - SIGINT/SIGTERM captured via global signal manager
2. **Abort propagation** - Local `AbortController` linked to global signal
3. **In-progress protection** - Current job completes before stopping
4. **State preservation** - Queue state saved automatically (jobs already have status updates)

```typescript
// Setup in executeQueueRun
const signal = getGlobalSignal();
const localAbortController = new AbortController();

signal.addEventListener("abort", () => localAbortController.abort());

registerGlobalCleanup({
  priority: 10,
  name: "queue-run-abort",
  cleanup: () => localAbortController.abort(),
});

registerGlobalCleanup({
  priority: 50,
  name: "queue-run-save",
  cleanup: async () => {
    logInfo("Saving queue state...");
    // Queue state already saved after each job status update
  },
});
```

## Interactive Selection Preservation

**New in Database Storage:** Interactive selections made via `--interactive` are now fully preserved in the queue.

### What is Preserved

When you queue a job with `--interactive`, the database stores:

- **For Delete Jobs**: The specific album suffixes you selected (e.g., "Album-005", "Album-002")
- **For Copy Jobs**: The specific albums or tracks you selected

### How It Works

1. **During Queue Add**:
   - Interactive selection UI runs as normal
   - You select specific items (albums, tracks, or suffixes)
   - Selection data (ReadonlyMap) is serialized to database tables:
     - `queue_job_selections` - Per-source selection metadata
     - `queue_job_selected_items` - Individual selected items

2. **During Queue Run**:
   - Job execution loads selections from database
   - ReadonlyMap is reconstructed from table rows
   - Actions receive the exact same selection data
   - Only your selected items are processed

### Example Workflow

```bash
# Add delete job with interactive selection
rfmedia queue add delete --paths sources.yml --interactive

# Interactive UI shows:
# ✓ Britney Spears - Album - Blackout-005
# ✓ Paulina Rubio - Album - Las número 1-002
# (2 items selected)

# Job is queued with selections preserved in database

# Later, run the queue
rfmedia queue run

# Only the 2 selected suffixes are deleted, not all suffixes from count/range
```

### Viewing Completed Jobs

Completed jobs are kept in the queue after execution, allowing you to:

- **Review history**: `rfmedia queue list --status completed`
- **Search later**: Future `queue search` commands will work
- **Retry if needed**: Future `queue retry <id>` feature
- **Manual cleanup**: `rfmedia queue clear --completed` when no longer needed

### Legacy JSON Migration

**Important:** When migrating from JSON file-based queue:

- Jobs without interactive selections work identically
- Jobs that had `--interactive` selections **cannot** recover those selections
- This is because JSON serialization dropped the Map data
- After migration, such jobs fall back to `count`/`range` behavior

To preserve interactive selections, use the database-based queue (automatic after migration).

## Implementation Details

### File Locations

| File                    | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `src/types/queue.ts`    | Type definitions for queue system                    |
| `src/types/db.ts`       | Database types (DbQueueJob, DbQueueJobSelection)     |
| `src/lib/queue.ts`      | Queue operations (wraps database operations)         |
| `src/lib/queue-db.ts`   | Database CRUD operations and selection serialization |
| `src/lib/schema.sql`    | Database schema (queue_jobs, queue_job_selections)   |
| `src/actions/queue.ts`  | Action implementations for all subcommands           |
| `src/commands/queue.ts` | CLI command definitions and option parsing           |
| `src/cli.ts`            | Registers queue command                              |

### Key Functions

#### Queue Operations (`src/lib/queue.ts`)

| Function                                       | Description                                       |
| ---------------------------------------------- | ------------------------------------------------- |
| `getQueuePath()`                               | Returns path to legacy JSON file (for migration)  |
| `addJob(src, dest, opts, jobType, selection?)` | Creates and inserts job to database               |
| `getJobs(status?)`                             | Returns jobs from database, optionally filtered   |
| `getJobsByType(jobType, status?)`              | Returns jobs filtered by type and optional status |
| `getNextPendingJob()`                          | Returns first pending job from database           |
| `updateJobStatus(id, status, error?)`          | Updates job status and timestamps in database     |
| `removeJob(jobId)`                             | Removes job from database (CASCADE deletes)       |
| `removeJobsByStatus(status?)`                  | Removes jobs matching status (or all)             |
| `getQueueStats()`                              | Returns counts by status from database            |

#### Queue Database Operations (`src/lib/queue-db.ts`)

| Function                                             | Description                                 |
| ---------------------------------------------------- | ------------------------------------------- |
| `addJobToDb(db, job, selection?)`                    | Insert job with sources and selections      |
| `getJobsFromDb(db, status?)`                         | Query jobs with optional status filter      |
| `updateJobStatusInDb(db, id, status, error?)`        | Update status and timestamps                |
| `removeJobFromDb(db, jobId)`                         | Delete job (CASCADE handles related tables) |
| `serializeSelectionToDb(db, jobId, selection, type)` | Convert ReadonlyMap to table rows           |
| `deserializeDeleteSelectionFromDb(db, jobId)`        | Reconstruct DeleteSelection from database   |
| `deserializeCopySelectionFromDb(db, jobId)`          | Reconstruct CopySelection from database     |

#### Action Functions (`src/actions/queue.ts`)

| Function                        | Description                                     |
| ------------------------------- | ----------------------------------------------- |
| `executeQueueAdd()`             | Adds a copy job to the queue                    |
| `executeQueueAddDelete()`       | Adds a delete job to the queue                  |
| `executeQueueList()`            | Lists jobs with statistics and table formatting |
| `executeQueueRun()`             | Executes pending jobs with parallel processing  |
| `executeQueueClear()`           | Removes jobs from queue with confirmation       |
| `toSerializableOptions()`       | Converts CopyOptions for storage                |
| `toSerializableDeleteOptions()` | Converts DeleteOptions for storage              |

### Job Execution Flow

When `queue run` is executed:

```
1. Load pending jobs from queue
   └── getJobs('pending')

2. Setup graceful interruption
   ├── getGlobalSignal()
   ├── Create local AbortController
   └── Register cleanup handlers

3. Process jobs in parallel
   └── processInParallel(pendingJobs, async (job) => {
         a. Mark as 'running': updateJobStatus(job.id, 'running')
         b. Check jobType and convert options:
            - copy: toCopyOptions(job.options, dryRun)
            - delete: toDeleteOptions(job.options, dryRun)
         c. Execute based on jobType and mode:
            - copy + album: executeAlbumCopyWithFileInput()
            - copy + filter: executeFilterCopyWithFileInput()
            - delete + album: executeAlbumDeleteWithFileInput()
            - delete + filter: executeFilterDeleteWithFileInput()
         d. On success:
            - updateJobStatus(job.id, 'completed')
         e. On failure:
            - updateJobStatus(job.id, 'failed', error.message)
            - If not continueOnError: throw error
       })

4. Aggregate results
   └── Count completed/failed, build result array

5. Trigger Plex scan (if enabled and jobs completed)
   └── triggerPlexScan(plexConfig)

6. Cleanup
   └── unregisterGlobalCleanup() for all handlers
```

### Error Handling

**Job-level errors:**

- Errors during job execution are caught and stored in `job.error`
- Failed jobs remain in queue with status `'failed'`
- With `--continue-on-error`, processing continues to next job
- Without `--continue-on-error`, queue run stops on first failure

**Queue file errors:**

- If queue file is corrupted, starts with empty queue
- If version mismatch, logs warning but continues
- Directory is created if it doesn't exist

## Testing

### Manual Testing Commands

```bash
# Add copy jobs in different modes
rfmedia queue add copy /test/source1 /test/dest --range=001-003
rfmedia queue add copy /test/source2 /test/dest --min-stars=4 --convert=mp3

# Add delete jobs in different modes
rfmedia queue add delete /test/source1 /test/dest --range=008-010
rfmedia queue add delete /test/source2 /test/dest --count=3 --trash

# Verify jobs were added
rfmedia queue list
rfmedia queue list --verbose

# Preview what would run
rfmedia queue run --dry-run

# Execute with different configurations
rfmedia queue run --workers=1              # Sequential
rfmedia queue run --workers=4              # Parallel
rfmedia queue run --continue-on-error      # Don't stop on failure

# Test clearing
rfmedia queue clear --completed --force
rfmedia queue clear --failed --dry-run
rfmedia queue clear                        # Clear all (prompts)

# Test graceful interruption
rfmedia queue run &
# Press Ctrl+C
# Verify queue state is preserved
rfmedia queue list
```

### JSON Output Testing

```bash
# All commands support JSON output
rfmedia queue add copy /test/source /test/dest --range=001-003 --json
rfmedia queue add delete /test/source /test/dest --count=3 --json
rfmedia queue list --json
rfmedia queue run --json
rfmedia queue clear --completed --force --json
```

### Edge Cases to Test

1. **Empty queue** - All commands should handle gracefully
2. **Large queue** - Performance with many jobs
3. **Concurrent access** - Queue file is not locked
4. **Missing queue file** - Created on first add
5. **Corrupted queue file** - Starts fresh with warning
6. **Mixed job modes** - Album and filter jobs in same queue
7. **Mixed job types** - Copy and delete jobs in same queue
8. **Duplicate sources** - Multiple jobs for same source
9. **Interruption during run** - Queue state should be consistent
10. **Backward compatibility** - Old queue files without jobType field

## Related Documentation

- [Sync Command](./sync-command.doc.md) - Incremental sync operations
- [Graceful Interruption](./graceful-interruption.md) - Signal handling architecture
- [Smart Filters](./smart-filters.md) - Filter mode configuration
- CLAUDE.md - Development patterns and tracking system
