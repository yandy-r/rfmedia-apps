# Smart Playlists

This document describes the smart playlists feature in the rfmedia CLI, which generates M3U/M3U8 playlist files from two sources: named smart filters evaluated against local audio metadata, or existing Plex playlists fetched via API.

## Overview

The `playlist` command group provides tools for creating and managing M3U playlist files. Key features include:

- Generate playlists from named smart filters in your configuration
- Export Plex playlists to M3U format with local file paths
- Support for both relative and absolute paths in output
- Database persistence for playlist definitions and history
- Batch update capability for keeping playlists current

### Two Source Types

Smart playlists support two distinct source types, implemented as a discriminated union:

| Source Type     | Description                                                        | Use Case                                               |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `filter`        | Named filter from `.rfmedia.yaml` evaluated against local metadata | Create playlists based on ratings, genre, artist, etc. |
| `plex-playlist` | Existing Plex playlist fetched via API                             | Export Plex playlists to portable M3U format           |

The source type determines how tracks are selected:

- **Filter source**: Scans audio files in configured library paths, reads embedded metadata, and evaluates the filter criteria
- **Plex playlist source**: Fetches track list from Plex API and resolves local file paths

## Quick Start

### Creating Your First Playlist from a Filter

1. Define a filter in your `.rfmedia.yaml`:

```yaml
# .rfmedia.yaml
filters:
  favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0

plex:
  allowedLibraryRoots:
    - /mnt/music
```

2. Create the playlist:

```bash
rfmedia playlist create "My Favorites" -o /playlists/favorites.m3u8 --filter favorites
```

3. The playlist file is created and the definition is saved to the database for future updates.

### Creating a Playlist from Plex

1. Configure your Plex connection in `.rfmedia.yaml`:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
```

2. Create the playlist:

```bash
rfmedia playlist create "Workout Mix" -o /playlists/workout.m3u8 --plex-playlist "Workout"
```

## Creating Playlists from Filters

Filter-based playlists evaluate named smart filters from your configuration against local audio file metadata.

### Using Named Filters

The `--filter` option specifies a named filter defined in the `filters` section of your configuration:

```bash
rfmedia playlist create "High Quality Rock" -o /playlists/rock.m3u8 --filter high-quality-rock
```

The filter must exist in your configuration file. To list available filters:

```bash
rfmedia filter list
```

### Example Filter Configurations

**Rating-based filter:**

```yaml
filters:
  favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
```

**Genre-based filter with rating:**

```yaml
filters:
  high-quality-rock:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 3.5
      - type: group
        match: any
        rules:
          - field: genre
            operator: contains
            value: Rock
          - field: genre
            operator: contains
            value: Alternative
```

**Recent additions:**

```yaml
filters:
  recent-favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.5
      - field: date_added
        operator: within
        value: 30d
```

For comprehensive filter syntax documentation, see [Smart Filters](../../packages/rfmedia-cli/docs/features/smart-filters.md).

### Radio-Style Sequencing

A local named filter can optionally reorder its matched tracks after selection:

```yaml
filters:
  radio-rock:
    match: all
    rules:
      - type: rule
        field: genre
        operator: contains
        value: Rock
    separation:
      artist: 5
      genre: 3
      tempo: alternate
      era: distribute
      energy: wave
```

`artist` and `genre` specify the minimum number of intervening tracks before that metadata may
repeat. Tempo alternation, era distribution, and energy arcs are best-effort preferences. Energy is
derived from low, medium, and high BPM bands relative to the matched library; it is not acoustic
analysis.

The scheduler keeps every matched track. If greedy ordering stalls, it tries progressively wider
bounded rearrangements of recent choices. When bounded search still cannot find a valid placement,
it logs a warning and places the least-violating track. Missing metadata does not create a synthetic
artist, genre, era, or energy category.

### How Filter Evaluation Works

When creating a filter-based playlist:

1. **Library discovery**: Audio files are discovered from paths in `plex.allowedLibraryRoots` or `RFMEDIA_PLEX_LIBRARY_ROOTS`
2. **Metadata reading**: Extended metadata (rating, genre, artist, year, BPM) is read from each file in parallel
3. **Filter evaluation**: Each file's metadata is evaluated against the filter criteria
4. **Track collection**: Matching tracks are collected with their metadata (title, artist, duration)
5. **Optional sequencing**: A configured separation policy deterministically reorders the selected tracks
6. **M3U generation**: The playlist file is written with EXTINF metadata
7. **Database recording**: The playlist definition and generation history are saved

Filters without `separation` retain lexical path ordering. Plex-sourced playlists retain the order
returned by Plex.

### Configuring Library Paths

Filter evaluation requires library paths to scan. Configure these in `.rfmedia.yaml`:

```yaml
plex:
  allowedLibraryRoots:
    - /mnt/music
    - /mnt/audio/collection
```

Alternatively, set the environment variable:

```bash
export RFMEDIA_PLEX_LIBRARY_ROOTS="/mnt/music,/mnt/audio"
```

## Creating Playlists from Plex

Plex-based playlists fetch track lists from your Plex Media Server and resolve local file paths for M3U generation.

### Connecting to Plex

Configure your Plex server connection in `.rfmedia.yaml`:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
```

To obtain your Plex token, see the [Plex support documentation](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

### Specifying Plex Playlist by Name

Use the `--plex-playlist` option with the exact playlist name from Plex:

```bash
rfmedia playlist create "My Mix" -o /playlists/mix.m3u8 --plex-playlist "My Favorites"
```

To see available Plex playlists:

```bash
rfmedia plex playlist list
```

### Path Mapping Considerations

When fetching tracks from Plex, the CLI resolves file paths from the Plex API response. Important considerations:

- **File validation**: By default, each file path is validated to exist on the local filesystem
- **Missing files**: Tracks with unresolvable paths are skipped with a warning
- **Path consistency**: Ensure your Plex library paths match your local filesystem

If Plex returns paths that differ from your local mount points, you may need to configure path mappings or ensure consistent path naming.

## M3U Output Format

Smart playlists generate M3U8 files with extended metadata.

### UTF-8 Encoding

All playlist files use UTF-8 encoding with the `.m3u8` extension to ensure proper handling of international characters in filenames and metadata.

### EXTINF Metadata Format

Each track includes an EXTINF line with duration and display information:

```
#EXTM3U
#EXTINF:245,Artist Name - Track Title
/path/to/track.flac
#EXTINF:198,Another Artist - Another Track
/path/to/another.mp3
```

**Format breakdown:**

- `#EXTM3U` - Header indicating extended M3U format
- `#EXTINF:duration,display` - Track metadata line
  - `duration` - Track duration in seconds (0 if unknown)
  - `display` - `Artist - Title` if artist is available, otherwise just title

### Relative vs Absolute Paths

By default, playlists use absolute file paths. Use the `--relative` flag for portable playlists:

**Absolute paths (default):**

```bash
rfmedia playlist create "Portable" -o /usb/playlist.m3u8 --filter favorites
```

Output:

```
#EXTINF:245,Artist - Track
/mnt/music/Artist/Album/Track.flac
```

**Relative paths:**

```bash
rfmedia playlist create "Portable" -o /usb/playlist.m3u8 --filter favorites --relative
```

Output (relative to playlist location):

```
#EXTINF:245,Artist - Track
../music/Artist/Album/Track.flac
```

**Custom base directory:**

```bash
rfmedia playlist create "Portable" -o /usb/playlist.m3u8 --filter favorites --relative --base-dir /usb
```

The `--base-dir` option specifies the directory from which relative paths are computed. If not specified, the playlist's parent directory is used.

## Managing Playlists

### Listing Saved Playlists

View all playlists stored in the database:

```bash
rfmedia playlist list
```

Output:

```
Found 3 playlist(s):

NAME            TYPE           SOURCE          TRACKS  UPDATED
My Favorites    filter         favorites          150  2024-01-15 10:30:00
Workout Mix     plex-playlist  Workout             85  2024-01-14 09:15:00
Recent Adds     filter         recent-favorites    42  2024-01-13 14:20:00
```

For JSON output:

```bash
rfmedia playlist list --json
```

### Showing Playlist Details and History

View detailed information about a specific playlist:

```bash
rfmedia playlist show "My Favorites"
```

Output:

```
Playlist: My Favorites
  Source Type: filter
  Source Name: favorites
  Track Count: 150
  Output Path: /playlists/favorites.m3u8
  Relative Paths: No
  Created At: 2024-01-10 08:00:00
  Updated At: 2024-01-15 10:30:00

Generation History (last 10):
  2024-01-15 10:30:00 - 150 tracks
  2024-01-12 09:00:00 - 148 tracks
  2024-01-10 08:00:00 - 145 tracks
```

### Updating Playlists

Re-evaluate the source and regenerate the M3U file:

**Update a specific playlist:**

```bash
rfmedia playlist update "My Favorites"
```

**Update all playlists:**

```bash
rfmedia playlist update --all
```

Updates re-evaluate the filter criteria or re-fetch the Plex playlist, then overwrite the M3U file with current results. A new history entry is recorded.

### Deleting Playlists

Remove a playlist definition from the database:

```bash
rfmedia playlist delete "My Favorites"
```

With confirmation prompt bypass:

```bash
rfmedia playlist delete "My Favorites" --force
```

Also delete the M3U file from disk:

```bash
rfmedia playlist delete "My Favorites" --delete-file --force
```

## Database Persistence

### How Playlists Are Stored

Smart playlist definitions are stored in the SQLite database at the configured tracking database path (default: `~/.rfmedia/tracking.db`).

**Database tables:**

| Table                    | Purpose                                   |
| ------------------------ | ----------------------------------------- |
| `smart_playlists`        | Playlist definitions (name, source, path) |
| `smart_playlist_history` | Generation history (timestamps, counts)   |
| `smart_playlist_tracks`  | Track details for each generation         |

**Playlist record fields:**

| Field            | Description                         |
| ---------------- | ----------------------------------- |
| `name`           | Unique playlist name                |
| `output_path`    | Path to the M3U file                |
| `source_type`    | `filter` or `plex-playlist`         |
| `source_name`    | Filter name or Plex playlist name   |
| `relative_paths` | Whether relative paths are used     |
| `track_count`    | Current track count                 |
| `created_at`     | When the playlist was first created |
| `updated_at`     | When the playlist was last updated  |

### Generation History Tracking

Each time a playlist is created or updated, a history entry is recorded with:

- Timestamp of generation
- Number of tracks at that time
- Individual track details (path, title, artist, duration)

This enables:

- Tracking how playlists evolve over time
- Comparing track counts between generations
- Reviewing what was included in previous versions

## CLI Reference

### playlist create

Create a new M3U playlist from a filter or Plex playlist.

```bash
rfmedia playlist create <name> -o <output> [options]
```

**Arguments:**

| Argument | Description                   |
| -------- | ----------------------------- |
| `<name>` | Display name for the playlist |

**Required Options:**

| Option                | Description                       |
| --------------------- | --------------------------------- |
| `-o, --output <path>` | Output file path for M3U playlist |

**Source Options (exactly one required):**

| Option                       | Description              |
| ---------------------------- | ------------------------ |
| `-f, --filter <name>`        | Named filter from config |
| `-p, --plex-playlist <name>` | Plex playlist name       |

**Additional Options:**

| Option              | Description                       |
| ------------------- | --------------------------------- |
| `-r, --relative`    | Use relative paths in playlist    |
| `--base-dir <path>` | Base directory for relative paths |
| `--force`           | Overwrite existing playlist file  |
| `--dry-run`         | Preview without writing files     |
| `--json`            | Output in JSON format             |

### playlist update

Update existing playlist(s) by re-evaluating source.

```bash
rfmedia playlist update [name] [options]
```

**Arguments:**

| Argument | Description                      |
| -------- | -------------------------------- |
| `[name]` | Specific playlist name to update |

**Options:**

| Option      | Description                |
| ----------- | -------------------------- |
| `-a, --all` | Update all saved playlists |
| `--json`    | Output in JSON format      |

### playlist list

List all saved smart playlists.

```bash
rfmedia playlist list [options]
```

**Options:**

| Option   | Description           |
| -------- | --------------------- |
| `--json` | Output in JSON format |

### playlist show

Show details and history for a smart playlist.

```bash
rfmedia playlist show <name> [options]
```

**Arguments:**

| Argument | Description   |
| -------- | ------------- |
| `<name>` | Playlist name |

**Options:**

| Option   | Description           |
| -------- | --------------------- |
| `--json` | Output in JSON format |

### playlist delete

Delete a saved smart playlist.

```bash
rfmedia playlist delete <name> [options]
```

**Arguments:**

| Argument | Description   |
| -------- | ------------- |
| `<name>` | Playlist name |

**Options:**

| Option          | Description              |
| --------------- | ------------------------ |
| `-f, --force`   | Skip confirmation prompt |
| `--delete-file` | Also delete the M3U file |

### JSON Output Format

When using `--json`, output follows this structure:

**playlist create:**

```json
{
  "command": "playlist create",
  "result": {
    "success": true,
    "outputPath": "/playlists/favorites.m3u8",
    "trackCount": 150,
    "tracks": [
      {
        "filePath": "/music/Artist/Track.flac",
        "title": "Track Title",
        "artist": "Artist Name",
        "durationMs": 245000
      }
    ],
    "failed": [],
    "skipped": 0
  }
}
```

**playlist list:**

```json
{
  "command": "playlist list",
  "result": {
    "count": 3,
    "playlists": [
      {
        "name": "My Favorites",
        "sourceType": "filter",
        "sourceName": "favorites",
        "trackCount": 150,
        "outputPath": "/playlists/favorites.m3u8",
        "relativePaths": false,
        "createdAt": "2024-01-10T08:00:00.000Z",
        "updatedAt": "2024-01-15T10:30:00.000Z"
      }
    ]
  }
}
```

**playlist show:**

```json
{
  "command": "playlist show",
  "result": {
    "name": "My Favorites",
    "sourceType": "filter",
    "sourceName": "favorites",
    "trackCount": 150,
    "outputPath": "/playlists/favorites.m3u8",
    "relativePaths": false,
    "createdAt": "2024-01-10T08:00:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z",
    "history": [
      {
        "generatedAt": "2024-01-15T10:30:00.000Z",
        "trackCount": 150
      },
      {
        "generatedAt": "2024-01-12T09:00:00.000Z",
        "trackCount": 148
      }
    ]
  }
}
```

## Examples and Use Cases

### Creating a Portable Playlist for USB

Generate a playlist with relative paths for use on a USB drive or portable device:

```bash
# Create playlist with relative paths
rfmedia playlist create "Car Music" -o /mnt/usb/playlists/car.m3u8 \
  --filter favorites \
  --relative \
  --base-dir /mnt/usb

# Preview first
rfmedia playlist create "Car Music" -o /mnt/usb/playlists/car.m3u8 \
  --filter favorites \
  --relative \
  --dry-run
```

### Syncing with Plex Playlists

Export a Plex playlist to M3U format for use in other applications:

```bash
# Initial creation
rfmedia playlist create "Workout" -o /playlists/workout.m3u8 \
  --plex-playlist "Workout Mix"

# Update when Plex playlist changes
rfmedia playlist update "Workout"
```

### Batch Updating All Playlists

Keep all your playlists current with a single command:

```bash
# Update all playlists
rfmedia playlist update --all

# Preview what would be updated
rfmedia playlist update --all --json | jq '.result.playlists[].name'
```

### Creating Multiple Themed Playlists

Define multiple filters and create corresponding playlists:

```yaml
# .rfmedia.yaml
filters:
  workout:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 3.5
      - field: bpm
        operator: ">="
        value: 120
      - type: group
        match: any
        rules:
          - field: genre
            operator: contains
            value: Dance
          - field: genre
            operator: contains
            value: Electronic

  relaxation:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
      - field: bpm
        operator: "<="
        value: 90
      - type: group
        match: any
        rules:
          - field: genre
            operator: contains
            value: Classical
          - field: genre
            operator: contains
            value: Jazz
```

```bash
# Create themed playlists
rfmedia playlist create "Workout Mix" -o /playlists/workout.m3u8 --filter workout
rfmedia playlist create "Relaxation" -o /playlists/relax.m3u8 --filter relaxation

# Update both at once
rfmedia playlist update --all
```

### Scripting with JSON Output

Use JSON output for automation scripts:

```bash
#!/bin/bash

# Update all playlists and check for changes
result=$(rfmedia playlist update --all --json)

# Extract updated playlists
echo "$result" | jq -r '.result.playlists[] | "\(.name): \(.trackCount) tracks"'

# Check for failures
failures=$(echo "$result" | jq '.result.failed | length')
if [ "$failures" -gt 0 ]; then
  echo "Warning: $failures playlist(s) failed to update"
  exit 1
fi
```

## Error Handling

### Common Errors

| Error                           | Cause                                 | Solution                                   |
| ------------------------------- | ------------------------------------- | ------------------------------------------ |
| "Filter not found"              | Named filter does not exist in config | Check spelling, use `rfmedia filter list`  |
| "Plex playlist not found"       | Playlist name does not exist in Plex  | Use `rfmedia plex playlist list` to verify |
| "No library paths configured"   | Missing library root configuration    | Add `plex.allowedLibraryRoots` to config   |
| "Output file already exists"    | File exists without `--force`         | Add `--force` to overwrite                 |
| "Plex configuration is missing" | Missing Plex URL or token             | Configure `plex.url` and `plex.token`      |

A `Separation relaxed ...` warning is informational: the selected catalog could not satisfy every
configured artist or genre gap. The playlist is still complete and generated successfully.

### Missing Files from Plex

When creating playlists from Plex sources, tracks with missing files are automatically skipped. The CLI logs warnings for each missing file and continues with available tracks.

### Preview with Dry-Run

Always preview potentially large operations:

```bash
rfmedia playlist create "Large Playlist" -o /playlists/large.m3u8 \
  --filter all-music \
  --dry-run
```

Dry-run output shows:

- How many tracks would be included
- Preview of the first 10 tracks
- Any files that would be skipped

## Related Documentation

- [Smart Filters](../../packages/rfmedia-cli/docs/features/smart-filters.md) - Comprehensive guide to filter syntax and evaluation
- [Plex Playlist Export](plex-playlist-export.md) - Direct Plex playlist file export (alternative approach)
- [rfmedia CLI README](../../packages/rfmedia-cli/README.md) - Complete command reference
