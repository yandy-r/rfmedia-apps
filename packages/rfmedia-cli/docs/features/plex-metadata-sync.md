# Plex Metadata Sync

Bidirectional rating synchronization between embedded file tags and Plex Media Server.

## Overview

The `plex sync` command family synchronizes audio ratings between your local files and Plex. It supports three modes:

- **Push**: Copy ratings from files to Plex
- **Pull**: Copy ratings from Plex to files
- **Both**: Bidirectional sync with conflict resolution

This remains a direct, two-plane rating workflow. To compare file tags, the rfmedia inventory, and
the current media-server snapshot—including artist, genre, year, stale inventory, and ambiguous
evidence—use [Metadata Reconciliation](metadata-reconciliation.md).

### What It Does

- Reads ratings from file tags (POPM for MP3, Vorbis RATING for FLAC)
- Reads ratings from Plex user ratings
- Compares and synchronizes based on the selected direction
- Handles format-specific tag writing automatically

### Rating and Adapter Boundary

Metadata sync now uses the shared, provider-neutral media-server adapter. Tracks cross the action
boundary with opaque IDs and ratings represented as `number | null` on a normalized `0..1` scale.
The sync action compares and writes that normalized value; it does not construct Plex endpoints or
handle Plex-native rating values.

The private Plex adapter converts incoming Plex `0..10` ratings to the normalized scale and converts
normalized updates back to Plex's integer `0..10` scale. The adapter also reports the native scale
step so push operations can skip values that already map to the same Plex rating. File-tag readers
and writers continue handling POPM and Vorbis representations at their own boundary.

This is an internal ownership change only. The `rfmedia plex sync` commands, options, configuration,
star-based explanations, and JSON result fields are unchanged; no user migration is required. See
the [media-server adapter reference](media-server-adapter.md) for the completed capability boundary.

### When to Use Each Mode

| Mode   | Use Case                                                |
| ------ | ------------------------------------------------------- |
| `push` | You rate files locally and want Plex to reflect them    |
| `pull` | You rate in Plex and want files updated for portability |
| `both` | You rate on both sides and need reconciliation          |

## Commands

### Push (File to Plex)

Reads ratings from file tags and updates Plex:

```bash
rfmedia plex sync push /path/to/music --library Music
```

Only tracks with ratings in file tags are updated. Tracks already in sync are skipped.

### Pull (Plex to File)

Reads ratings from Plex and writes them to file tags:

```bash
rfmedia plex sync pull /path/to/music --library Music
```

This modifies your audio files to embed ratings. MP3 files get POPM frames, FLAC files get Vorbis RATING comments.

### Bidirectional

Syncs both directions with conflict resolution:

```bash
rfmedia plex sync both /path/to/music --library Music --prefer plex
```

The `--prefer` option is required for bidirectional sync and determines which source wins when ratings differ.

## Options Reference

### Common Options (All Modes)

| Option                 | Description                               |
| ---------------------- | ----------------------------------------- |
| `-l, --library <name>` | Plex library name (default: "Music")      |
| `--only-rated`         | Only sync tracks that have ratings        |
| `-w, --workers <n>`    | Number of parallel workers (default: 4)   |
| `--dry-run`            | Preview operations without making changes |
| `--no-progress`        | Disable progress bar                      |
| `--plex-scan`          | Trigger Plex library scan after sync      |

### Pull and Both Mode Options

| Option                   | Description                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `--popm-email <email>`   | POPM email for MP3. Uses `plex.syncDefaults.popmEmail` when unset, else `no@email`. |
| `--vorbis-scale <scale>` | Vorbis: `normalized`, `stars`, `percent`. Config when unset, else `normalized`.     |

### Both Mode Only

| Option              | Description                                      |
| ------------------- | ------------------------------------------------ |
| `--prefer <source>` | Conflict resolution: `plex` or `file` (required) |

## Rating Scale Conversion

The sync command handles conversion between different rating scales automatically. Its internal
comparison scale is normalized `0..1`; Plex-native and star values are converted only at the
provider or presentation boundary.

### Scale Mappings

| Source or Boundary     | Scale | Conversion                                 |
| ---------------------- | ----- | ------------------------------------------ |
| Plex                   | 0-10  | 2 = 1 star, 4 = 2 stars, ..., 10 = 5 stars |
| rfmedia action/adapter | 0-1   | Normalized value or `null`                 |
| POPM (MP3)             | 0-255 | 1-255 scaled to 0.0-1.0 normalized         |
| Vorbis (FLAC)          | 0-1   | Direct (auto-detects 0-5 or 0-100 scales)  |

### Star to Plex Scale

| Stars | Plex Rating | Normalized |
| ----- | ----------- | ---------- |
| 1     | 2           | 0.2        |
| 2     | 4           | 0.4        |
| 3     | 6           | 0.6        |
| 4     | 8           | 0.8        |
| 5     | 10          | 1.0        |

## Configuration

Add sync defaults to your `.rfmedia.yaml`:

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
  syncDefaults:
    prefer: plex
    onlyRated: false
    popmEmail: "no@email"
    vorbisScale: normalized
```

### Configuration Options

| Option        | Type    | Default      | Description                                                                     |
| ------------- | ------- | ------------ | ------------------------------------------------------------------------------- |
| `prefer`      | string  | -            | Default conflict resolution: `plex` or `file`                                   |
| `onlyRated`   | boolean | `false`      | Only sync tracks with ratings                                                   |
| `popmEmail`   | string  | `"no@email"` | POPM for MP3 writes; used when `--popm-email` is not set                        |
| `vorbisScale` | string  | `normalized` | Vorbis: `normalized`, `stars`, `percent`; used when `--vorbis-scale` is not set |

## Conflict Resolution

When using bidirectional sync (`both` mode), conflicts occur when both the file and Plex have different ratings for the same track.

### Resolution Behavior

| Scenario                   | `--prefer plex`        | `--prefer file`        |
| -------------------------- | ---------------------- | ---------------------- |
| File=4 stars, Plex=3 stars | File becomes 3 stars   | Plex becomes 4 stars   |
| File only has rating       | Push rating to Plex    | Push rating to Plex    |
| Plex only has rating       | Pull rating to file    | Pull rating to file    |
| Both unrated               | Skip (no action)       | Skip (no action)       |
| Ratings match              | Skip (already in sync) | Skip (already in sync) |

### Conflict Counting

The sync result includes a `conflicts` count showing how many tracks had differing ratings that required resolution. This helps you understand how many tracks were reconciled versus simply synced.

## Usage Examples

### Basic Push Sync

Push all file ratings to Plex:

```bash
rfmedia plex sync push /mnt/music --library Music
```

### Push Only Rated Files

Skip files without ratings:

```bash
rfmedia plex sync push /mnt/music --library Music --only-rated
```

### Preview Changes

See what would change without modifying anything:

```bash
rfmedia plex sync push /mnt/music --library Music --dry-run
```

### Pull Ratings to Files

Update local files with Plex ratings:

```bash
rfmedia plex sync pull /mnt/music --library Music
```

### Pull with Custom POPM Email

Use a specific email identifier for MP3 POPM frames:

```bash
rfmedia plex sync pull /mnt/music --popm-email "MusicBee@example.com"
```

### Bidirectional Sync (Prefer Plex)

Sync both ways, preferring Plex ratings when they differ:

```bash
rfmedia plex sync both /mnt/music --library Music --prefer plex
```

### Bidirectional Sync (Prefer File)

Sync both ways, preferring file ratings when they differ:

```bash
rfmedia plex sync both /mnt/music --library Music --prefer file
```

### Fast Parallel Sync

Use 8 workers for faster processing:

```bash
rfmedia plex sync push /mnt/music --library Music --workers 8
```

### JSON Output for Scripting

Get structured output for automation:

```bash
rfmedia plex sync push /mnt/music --library Music --json
```

Example JSON output:

```json
{
  "command": "plex-sync-push",
  "result": {
    "totalTracks": 1500,
    "synced": 450,
    "skipped": 1040,
    "conflicts": 0,
    "failedCount": 10,
    "failed": [{ "path": "/mnt/music/track.mp3", "message": "Connection refused" }]
  }
}
```

## Limitations

### M4A/AAC Files

iTunes and Apple Music store ratings in a separate database, not in file metadata. The sync command can read Plex ratings for M4A files, but cannot write ratings back to the files. Pull operations will fail for M4A files with a descriptive message.

### OGG/Opus Files

Tag writing for OGG and Opus files is not yet implemented. Push operations work (reading ratings), but pull operations will fail for these formats.

### Large Libraries

For libraries with many thousands of tracks, consider:

- Using `--only-rated` to limit scope
- Running sync in batches by directory
- Using lower worker counts if Plex rate limiting occurs

### Network Latency

The Plex API has built-in rate limiting (100ms between requests). With many parallel workers and high latency connections, you may see rate limit warnings. Reduce worker count if this occurs.

## Troubleshooting

### No Tracks Found

If sync reports 0 tracks, verify:

1. The source path matches files in your Plex library
2. The library name is correct (case-sensitive)
3. Plex can access the same file paths as rfmedia

### Authentication Errors

If you see "Authentication failed (401)":

1. Verify your Plex token is valid
2. Check the Plex server URL is correct
3. Ensure the token has access to the specified library

### File Path Mismatches

Plex stores absolute file paths. If your files are accessed via different paths (symlinks, NFS mounts), the sync may not match tracks correctly. Ensure the source path used with the sync command matches how Plex sees the files.

### Rating Precision Loss

Due to different rating scales, some precision may be lost when converting between formats. For
example, a 4.5 star rating in one format may become 4 or 5 stars in another. rfmedia compares push
values at the Plex-native step before writing, which avoids repeatedly updating values that would
round to the same native rating.

## Sync-on-Copy

The `plex copy` and `plex playlist export` commands support automatic rating sync during copy operations.

### Enabling Sync-on-Copy

```bash
# Enable via CLI flag
rfmedia plex copy query-results --sync-ratings

# Disable explicit (if config enables by default)
rfmedia plex copy query-results --no-sync-ratings

# Playlist export with sync
rfmedia plex playlist export "My Playlist" /dest --sync-ratings
```

### Configuration Defaults

```yaml
plex:
  syncRatingsOnCopy: false # Default off for backward compatibility
  syncOnCopyDefaults:
    popmEmail: "no@email"
    vorbisScale: "normalized"
```

### Edge Cases

| Case                         | Behavior                                              |
| ---------------------------- | ----------------------------------------------------- |
| Unrated Plex track           | Skipped (0 means unrated)                             |
| OGG/Opus/M4A rating override | Skipped with a format-specific result or warning      |
| Hardlink mode                | Warning displayed because writing can affect sources  |
| Conversion mode              | Source metadata is preserved before any Plex override |

### Conversion and Plex Rating Order

When sync-on-copy and conversion are both enabled, metadata preservation and Plex override are two
ordered operations:

1. The converter reads the source metadata, creates and audits a private stage, and atomically
   publishes the converted destination. Its target-specific rating behavior applies at this step:
   MP3 POPM and Opus ratings are preserved, while AAC/ALAC report that embedded ratings are
   unsupported.
2. Only when sync-on-copy was requested and the selected Plex track has a positive rating does the
   copy/export action call the rating sync helper against the published destination.

The second step intentionally overrides the preserved source rating. A missing, unrated, or
zero-rated Plex value does not erase the source rating. If the later Plex rating write is
unsupported or fails, the helper reports the failure without failing the completed copy; the
already-published destination retains the rating preserved from the source conversion.

This ordering applies to the first converted copy. Subsequent ranged copies reuse that published
file, so they inherit the result rather than causing another source transcode.

## Related Documentation

- [Metadata Reconciliation](metadata-reconciliation.md) - Three-plane drift reports and
  capability-bounded rating/stat repair
- [Plex Integration](../../README.md#plex-integration) - Plex configuration overview
- [Media Server Adapter](media-server-adapter.md) - Generic capabilities and private Plex conversion
- [Plex Playlist Operations](../../README.md#plex-playlist-operations) - Export and sync playlists
- [Plex Filters](plex-filters.md) - Complex query filtering

## Technical Notes

### Plex API Endpoint

The private Plex metadata capability owns rating updates through the Plex PUT endpoint:

```
PUT /:/rate?identifier=com.plexapp.plugins.library&key={ratingKey}&rating={value}
```

### Tag Writing Libraries

- **MP3**: Uses `node-id3` for POPM frame writing
- **FLAC**: Uses `flac-metadata` for Vorbis comment manipulation

### Atomic File Updates

FLAC file updates use atomic operations: write to temp file, then rename. This prevents corruption if the operation is interrupted.
