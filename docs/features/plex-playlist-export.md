# Plex Playlist Export

This document describes the Plex playlist export and sync commands in the rfmedia CLI, which enable exporting Plex playlist tracks to local folders with support for multiple suffixed copies, audio conversion, and incremental synchronization.

## Overview

The `plex playlist` command group provides tools for exporting and syncing Plex audio playlists to local folders. Key features include:

- Export all tracks from a Plex playlist to a destination folder
- Sync destination folders to match current playlist state
- Create multiple suffixed copies with hardlink optimization
- Preserve or flatten artist/album folder structure
- Convert audio formats during export (requires ffmpeg)
- Trigger Plex library scans after operations complete

## Prerequisites

Before using playlist export commands, configure your Plex connection in `.rfmedia.yaml`:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
```

To obtain your Plex token, see the [Plex support documentation](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

## Commands Reference

### plex playlist list

Lists all available audio playlists from your Plex server.

```bash
rfmedia plex playlist list [options]
```

**Options:**

| Option              | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--exportable`      | Show only playlists that can be exported (non-empty) |
| `--plex-url <url>`  | Override Plex server URL from config                 |
| `--plex-token <tk>` | Override Plex authentication token from config       |

**Example Output:**

```
Plex Playlists

+-----------------------+--------+-------+----------+
| Playlist              | Tracks | Smart | Duration |
+-----------------------+--------+-------+----------+
| My Favorites          |     50 |   No  |  3:25:00 |
| Workout Mix           |    120 |   No  |  8:15:32 |
| Recently Added (Auto) |     35 |  Yes  |  2:10:45 |
+-----------------------+--------+-------+----------+
```

### plex playlist export

Exports all tracks from a Plex playlist to a destination folder. This is a one-time copy operation.

```bash
rfmedia plex playlist export <playlist-name> <destination> [options]
```

**Arguments:**

| Argument          | Description                               |
| ----------------- | ----------------------------------------- |
| `<playlist-name>` | Name of the Plex playlist to export       |
| `<destination>`   | Destination directory for exported tracks |

**Options:**

| Option                    | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `--hardlink`              | Use hardlinks instead of copies (same filesystem)      |
| `--convert <format>`      | Convert to audio format: `mp3`, `aac`, `opus`, `alac`  |
| `-w, --workers <n>`       | Number of parallel workers (default: 4)                |
| `--dry-run`               | Preview operations without copying                     |
| `--no-progress`           | Disable progress bar                                   |
| `--plex-scan`             | Trigger Plex library scan after export                 |
| `--preserve-structure`    | Keep artist/album folder structure in destination      |
| `--flat`                  | Output directly to destination (no playlist subfolder) |
| `--folder <name>`         | Custom folder name (overrides playlist name)           |
| `-r, --range <START-END>` | Range of suffixes to create (e.g., `001-005`)          |
| `--count <N>`             | Number of copies to create (auto-detects next range)   |

### plex playlist sync

Syncs a destination folder to match the current state of a Plex playlist. This command:

1. Adds new tracks that are in the playlist but missing from the destination
2. Optionally removes tracks that are no longer in the playlist

```bash
rfmedia plex playlist sync <playlist-name> <destination> [options]
```

**Arguments:**

| Argument          | Description                          |
| ----------------- | ------------------------------------ |
| `<playlist-name>` | Name of the Plex playlist to sync    |
| `<destination>`   | Destination directory to synchronize |

**Options:**

All options from `export` command, plus:

| Option             | Description                                 |
| ------------------ | ------------------------------------------- |
| `--delete-removed` | Remove tracks no longer present in playlist |

## CLI Options Explained

### File Handling Options

#### --hardlink

Creates hardlinks instead of file copies when source and destination are on the same filesystem. This saves disk space since hardlinked files share the same data blocks.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --hardlink
```

**When to use:**

- Source and destination are on the same filesystem
- You want to save disk space
- You do not need independent copies of files

#### --convert

Converts audio files to a specified format during export. Requires ffmpeg to be installed.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --convert mp3
```

**Supported formats:**

| Format | Codec          | Quality  | Extension |
| ------ | -------------- | -------- | --------- |
| `alac` | Apple Lossless | Lossless | .m4a      |
| `mp3`  | libmp3lame     | 320kbps  | .mp3      |
| `aac`  | AAC            | 256kbps  | .m4a      |
| `opus` | libopus        | 128kbps  | .opus     |

#### --workers

Sets the number of parallel workers for file operations. Higher values can improve throughput for large exports.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --workers 8
```

**Default:** 4 workers

### Output Structure Options

#### --preserve-structure

Maintains the original artist/album folder hierarchy in the destination.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --preserve-structure
```

**Without `--preserve-structure` (default):**

```
/music/playlists/My Favorites/
  track1.flac
  track2.flac
  track3.flac
```

**With `--preserve-structure`:**

```
/music/playlists/My Favorites/
  Artist Name/
    Album Name/
      track1.flac
      track2.flac
  Another Artist/
    Another Album/
      track3.flac
```

#### --flat

Outputs files directly to the destination directory without creating a playlist subfolder.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --flat
```

**Default behavior:**

```
/music/playlists/My Favorites/
  track1.flac
```

**With `--flat`:**

```
/music/playlists/
  track1.flac
```

**Note:** `--flat` and `--folder` are mutually exclusive.

#### --folder

Specifies a custom folder name instead of using the playlist name.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --folder favorites
```

**Result:**

```
/music/playlists/favorites/
  track1.flac
  track2.flac
```

### Plex Integration Options

#### --plex-scan

Triggers a Plex library scan after the export completes. This ensures Plex indexes the newly exported files.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --plex-scan
```

## Range and Count Options

The `--range` and `--count` options enable creating multiple copies of exported tracks with numbered suffixes. This is useful for scenarios like:

- Creating multiple playlist folders for different devices
- DJ preparation with multiple copies of the same track
- Backup scenarios requiring numbered versions

### Understanding --range

The `--range` option creates copies with explicit suffix numbers.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --range=001-003
```

**Format:** `START-END` where both values are zero-padded numbers.

**Result:**

```
/music/playlists/My Favorites/
  track1-001.flac
  track1-002.flac
  track1-003.flac
  track2-001.flac
  track2-002.flac
  track2-003.flac
```

**Key behaviors:**

- The padding width is derived from the input format (e.g., `001` = 3-digit padding)
- Start must be less than or equal to end
- Files are created sequentially from start to end

### Understanding --count

The `--count` option automatically detects existing suffixed files and creates the next N copies.

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --count=3
```

**How auto-detection works:**

1. Scans the destination directory for files matching pattern `*-XXX.ext` (3+ digits)
2. Finds the highest existing suffix number
3. Creates copies starting from `highest + 1`

**Example scenario:**

If the destination already contains:

```
track1-001.flac
track1-002.flac
track1-003.flac
```

Running `--count=2` will create:

```
track1-004.flac
track1-005.flac
```

**Edge cases:**

- Empty destination: Creates suffixes starting from `001`
- No matching pattern: Creates suffixes starting from `001`
- Preserves detected padding width for consistency

### Hardlink Optimization for Multiple Copies

When creating multiple copies with `--range` or `--count`, the system optimizes disk usage:

1. **First copy:** Created from source (copy, hardlink, or convert based on options)
2. **Subsequent copies:** Hardlinked from the first copy (when possible)

This means creating 10 copies uses only slightly more disk space than a single copy, as all subsequent copies share data blocks with the first.

```bash
# Creates 10 copies, but disk usage is approximately 1x the source size
rfmedia plex playlist export "My Favorites" /music/playlists --range=001-010 --hardlink
```

**Fallback behavior:** If hardlinking fails (e.g., cross-filesystem), the system falls back to copying from source.

### Combining with Preserve Structure

Range suffixes are applied to filenames, not folders, when using `--preserve-structure`:

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --preserve-structure --range=001-002
```

**Result:**

```
/music/playlists/My Favorites/
  Artist Name/
    Album Name/
      track1-001.flac
      track1-002.flac
      track2-001.flac
      track2-002.flac
```

## Sync vs Export

| Aspect         | Export                       | Sync                                       |
| -------------- | ---------------------------- | ------------------------------------------ |
| Purpose        | One-time copy                | Keep destination in sync                   |
| New tracks     | Copies all tracks            | Only copies missing tracks                 |
| Removed tracks | N/A (no cleanup)             | Optionally removes with `--delete-removed` |
| Existing files | Skips if present             | Skips if present                           |
| Use case       | Initial setup, fresh exports | Ongoing maintenance                        |

### When to Use Export

- Creating a new playlist folder for the first time
- Making a fresh copy without regard to existing files
- One-time backups

```bash
rfmedia plex playlist export "My Favorites" /music/playlists/new-favorites
```

### When to Use Sync

- Keeping a playlist folder up-to-date with Plex
- Automated/scheduled updates
- Maintaining clean, accurate playlist mirrors

```bash
rfmedia plex playlist sync "My Favorites" /music/playlists/favorites --delete-removed
```

## Usage Examples

### Basic Export

Export a playlist to a folder:

```bash
rfmedia plex playlist export "Workout Mix" /music/playlists
```

### Export with Conversion

Export and convert to MP3 for mobile devices:

```bash
rfmedia plex playlist export "Workout Mix" /music/mobile --convert mp3 --workers 8
```

### Space-Efficient Export

Use hardlinks to save disk space:

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --hardlink
```

### Multiple Copies for DJs

Create 5 copies of each track for DJ software:

```bash
rfmedia plex playlist export "DJ Set" /music/dj-prep --range=001-005
```

### Incremental Copy Creation

Add 3 more copies to an existing set:

```bash
rfmedia plex playlist export "DJ Set" /music/dj-prep --count=3
# Auto-detects existing copies and continues numbering
```

### Structured Export

Preserve artist/album hierarchy:

```bash
rfmedia plex playlist export "My Favorites" /music/organized --preserve-structure
```

### Flat Export to USB

Export directly to a USB drive root:

```bash
rfmedia plex playlist export "Car Music" /mnt/usb --flat --convert mp3
```

### Sync with Cleanup

Keep destination synchronized, removing old tracks:

```bash
rfmedia plex playlist sync "My Favorites" /music/playlists/favorites --delete-removed
```

### Preview Operations

See what would happen without making changes:

```bash
rfmedia plex playlist export "My Favorites" /music/playlists --dry-run
```

### Custom Folder Name

Export with a custom folder name:

```bash
rfmedia plex playlist export "My Playlist with a Long Name" /music/playlists --folder short-name
```

### JSON Output for Scripting

Get machine-readable output:

```bash
rfmedia --json plex playlist export "My Favorites" /music/playlists
```

**JSON output structure:**

```json
{
  "command": "plex-playlist-export",
  "result": {
    "playlistName": "My Favorites",
    "totalTracks": 50,
    "created": 48,
    "skipped": 2,
    "failed": 0,
    "totalSize": 512000000
  }
}
```

## Configuration

### Configuration File

Add Plex settings to `.rfmedia.yaml`:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"

copy:
  hardlink: true
  workers: 4
  progress: true
```

### Default Options

The `copy` section in configuration provides defaults that apply to playlist operations:

| Setting             | Description               | Default |
| ------------------- | ------------------------- | ------- |
| `hardlink`          | Use hardlinks by default  | `false` |
| `workers`           | Default parallel workers  | `4`     |
| `progress`          | Show progress bar         | `true`  |
| `convertFormat`     | Default conversion format | none    |
| `preserveStructure` | Preserve folder hierarchy | `false` |

### Library Roots Configuration

Optionally restrict exports to specific Plex library paths:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
  allowedLibraryRoots:
    - /mnt/music
    - /mnt/audio
```

Tracks from other library roots will be filtered out during export.

## Error Handling

### Common Errors

| Error                                     | Cause                        | Solution                                  |
| ----------------------------------------- | ---------------------------- | ----------------------------------------- |
| "Plex URL and token are required"         | Missing Plex configuration   | Add `plex.url` and `plex.token` to config |
| "Playlist not found"                      | Playlist name does not exist | Check spelling, use `plex playlist list`  |
| "Cannot use --flat and --folder together" | Mutually exclusive options   | Choose one option                         |
| "ENOSPC: no space left"                   | Insufficient disk space      | Free space or use `--hardlink`            |

### Missing Files

When playlist tracks reference missing files (deleted from library), they are automatically skipped with a warning. The export continues with available tracks.

### Path Validation

The system validates destination paths to prevent path traversal attacks. If artist or album names contain special characters like `../`, an error is raised.

## Troubleshooting

### Playlist Not Found

1. Run `rfmedia plex playlist list` to see available playlists
2. Check for exact name match (case-sensitive)
3. Verify Plex connection with `--plex-url` and `--plex-token` if needed

### Slow Export Performance

1. Increase workers: `--workers 8`
2. Use hardlinks when possible: `--hardlink`
3. Ensure destination is on fast storage

### Files Not Appearing in Plex

1. Add `--plex-scan` to trigger library scan
2. Verify destination is within a Plex library path
3. Check Plex library settings for automatic scanning

### Hardlinks Failing

Hardlinks require source and destination on the same filesystem. If they are on different filesystems, the operation falls back to copying.

## Related Documentation

- [rfmedia CLI README](../../packages/rfmedia-cli/README.md) - Complete command documentation
- [Smart Filters](../../packages/rfmedia-cli/docs/features/smart-filters.md) - Advanced filtering options for copy operations
- [Dry-Run Mode](dry-run-mode.md) - Preview operations before executing
- [JSON Output](json-output.md) - Machine-readable output for scripting
- [Plex Filters](../../packages/rfmedia-cli/docs/features/plex-filters.md) - Plex query filters configuration
