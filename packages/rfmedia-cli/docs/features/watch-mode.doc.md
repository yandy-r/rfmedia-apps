# Watch Mode

This document describes the watch mode feature for the rfmedia CLI, which monitors directories for new content and automatically processes it using existing copy logic.

## Overview

Watch mode enables continuous monitoring of a source directory, automatically copying new albums or tracks to a destination as they arrive. This is useful for automation workflows where new music is added regularly (e.g., from download clients) and should be processed immediately.

## User Interface

### Command Line Usage

```bash
# Album mode - requires --range
rfmedia watch /source /dest --mode=album --range=001-010

# Filter mode - requires --min-stars or --min-rating
rfmedia watch /source /dest --mode=filter --min-stars=4

# With optional settings
rfmedia watch /source /dest --mode=album --range=001-005 --hardlink --debounce=10000
```

### Required Options

| Option                                  | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| `--mode <album\|filter>`                | Copy mode to use for processing (required)  |
| `--range <START-END>`                   | Range of suffixes (required for album mode) |
| `--min-stars <N>` or `--min-rating <N>` | Rating threshold (required for filter mode) |

### Album Mode Options

| Option                    | Default | Description                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `-r, --range <START-END>` | -       | Range of suffixes to create (e.g., `001-010`)               |
| `--album-only`            | false   | Treat detected folders as single albums, not artist folders |

### Filter Mode Options

| Option                   | Default       | Description                                 |
| ------------------------ | ------------- | ------------------------------------------- |
| `--min-stars <N>`        | -             | Minimum star rating (1-5)                   |
| `--min-rating <N>`       | -             | Minimum rating percentage (0-100)           |
| `--output-folder <name>` | `liked-songs` | Folder name for filtered tracks             |
| `--preserve-structure`   | false         | Keep album subfolders in filter mode output |

### Common Options

| Option            | Default | Description                                      |
| ----------------- | ------- | ------------------------------------------------ |
| `--hardlink`      | false   | Use hardlinks instead of file copies             |
| `--debounce <ms>` | 5000    | Debounce delay in milliseconds before processing |

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Watch Command                             │
├─────────────────────────────────────────────────────────────────┤
│  1. Validate source and destination directories exist            │
│  2. Validate mode-specific options (range or rating filter)      │
│  3. Initialize chokidar file system watcher                      │
│  4. Register SIGINT/SIGTERM handlers for graceful shutdown       │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    File System Watcher                           │
├─────────────────────────────────────────────────────────────────┤
│  - Monitors source directory recursively (depth: 10)             │
│  - Ignores existing files on startup (ignoreInitial: true)       │
│  - Waits for files to stabilize (awaitWriteFinish: 2000ms)       │
│  - Triggers on file and directory additions                      │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Event Processing                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Determine target type: artist, album, or file                │
│  2. Filter out ignored files (.part, .tmp, .crdownload, etc.)    │
│  3. Filter out non-audio files                                   │
│  4. Schedule processing with debounce delay                      │
│  5. Process using album or filter copy mode                      │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Files

| File                    | Purpose                                   |
| ----------------------- | ----------------------------------------- |
| `src/commands/watch.ts` | CLI command definition and option parsing |
| `src/actions/watch.ts`  | Watch mode implementation with chokidar   |
| `src/types/watch.ts`    | Type definitions for watch mode           |
| `src/types/index.ts`    | Re-exports watch types                    |
| `src/cli.ts`            | Registers watch command                   |

## Key Functions

### watch.ts (command)

- `buildWatchOptions()`: Validates and transforms raw CLI options into typed `WatchOptions`
- `parseIntArg()`: Parses numeric option values

### watch.ts (action)

- `executeWatch()`: Main entry point that sets up the watcher and event handlers
- `determineProcessTarget()`: Analyzes file paths to determine what level to process (artist/album/file)
- `scheduleProcessing()`: Implements debouncing logic to batch rapid file additions
- `processChange()`: Delegates to album or filter copy modes
- `isIgnoredFile()`: Filters out partial downloads and temp files

## Design Decisions

### Why Debouncing?

When a new album is added, many files arrive in rapid succession. Without debouncing, each file would trigger a separate copy operation. The debounce delay (default 5000ms) waits for the stream of events to settle before processing, resulting in a single efficient operation per album.

### Target Detection Logic

The watcher determines what to process based on directory depth:

- **1 level deep** (Source/Artist): Process as artist folder (all albums)
- **2 levels deep** (Source/Artist/Album): Process as album
- **3+ levels deep** (Source/Artist/Album/file.flac): Process parent album

### Ignored File Extensions

Partial downloads from clients like SABnzbd are ignored:

- `.part` - Partial download
- `.tmp` - Temporary file
- `.crdownload` - Chrome download
- `.download` - Generic download
- `.partial` - Partial file

### Sequential Processing

To avoid race conditions and ensure consistent state, only one path is processed at a time. Paths already being processed are skipped if new events arrive for them.

### Graceful Shutdown

SIGINT (Ctrl+C) and SIGTERM signals trigger cleanup:

1. Clear all pending debounce timers
2. Close the file system watcher
3. Exit cleanly with code 0

## Performance Considerations

| Setting   | Recommendation       | Notes                              |
| --------- | -------------------- | ---------------------------------- |
| Debounce  | 5000ms default       | Increase for slow networks/disks   |
| Hardlinks | Enable when possible | Much faster than file copies       |
| Workers   | 1 (built-in)         | Processing is sequential by design |

## Example Workflows

### Usenet Download Automation

```bash
# Watch completed downloads folder and create album copies
rfmedia watch /data/downloads/completed /music/library \
  --mode=album \
  --range=001-003 \
  --hardlink
```

### Liked Songs Collection

```bash
# Watch for new albums and extract highly-rated tracks
rfmedia watch /music/library /music/playlists \
  --mode=filter \
  --min-stars=5 \
  --output-folder="favorites" \
  --preserve-structure
```

## Related Documentation

- README.md - General CLI usage
- CLAUDE.md - Development patterns
- docs/features/parallel-processing.doc.md - Parallel processing in copy modes
