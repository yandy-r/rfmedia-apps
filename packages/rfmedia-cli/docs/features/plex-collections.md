# Plex Collections

This document provides comprehensive guidance for using the Plex collection management commands in rfmedia-cli. The `plex collection` command group enables creating and managing Plex music collections with filter-based item selection or folder-based matching.

## Overview

### What Are Plex Collections?

Plex collections are curated groupings of media items that appear in your library's collection view. Unlike playlists (which are for playback), collections provide visual organization and can be featured on your library home screen. Key characteristics include:

- **Visual Grouping**: Collections appear as distinct items in the library view with custom artwork
- **Metadata-Driven**: Collections are part of library metadata, not playback queues
- **Library-Specific**: Each collection belongs to a single library (e.g., Music, Movies)
- **Server-Side**: Collections live on the Plex server and are visible to all users

### Smart vs Static Collections

| Collection Type | Description                    | Use Case                                  |
| --------------- | ------------------------------ | ----------------------------------------- |
| **Static**      | Manually curated list of items | Hand-picked favorites, themed collections |
| **Smart**       | Filter-based, auto-updating    | "All 5-star Rock albums", "2020s Music"   |

**Note:** Both static and smart collections are supported. Use the `--smart` flag when creating a collection to create a filter-based smart collection.

### Collection Media Types

Collections are now explicitly typed by item mode:

| Media Type | Plex Metadata Type Code | Notes                         |
| ---------- | ----------------------- | ----------------------------- |
| `artist`   | `8`                     | Artist entities in music libs |
| `album`    | `9`                     | Album entities in music libs  |
| `track`    | `10`                    | Track entities (default mode) |

`list` and `show` output now display both collection state (`Smart`/`Static`) and media type independently.

### Collections vs Playlists

| Feature  | Collections               | Playlists                   |
| -------- | ------------------------- | --------------------------- |
| Purpose  | Visual organization       | Playback queues             |
| Location | Library collection view   | Playlists section           |
| Artwork  | Custom posters            | Auto-generated              |
| Playback | Browse and select items   | Sequential/shuffle playback |
| Ordering | Library sort order        | Custom track order          |
| Use case | "Jazz Albums", "70s Rock" | "Workout Mix", "Road Trip"  |

**When to use collections:**

- Organizing albums by genre, era, or theme
- Creating visual groupings in your library
- Featuring content on library home screen

**When to use playlists:**

- Creating playback queues
- Mixing tracks across albums
- Sharing specific track sequences

## CLI Usage

### Command Structure

```
rfmedia plex collection
  create <collection-name>   # Create a new collection
  add <collection-name>      # Add items to existing collection
  list                       # List collections in library
  show <collection-name>     # Show collection details
  delete <collection-name>   # Delete a collection
```

### Create Collection

Create a new collection with optional filter-based item population:

```bash
# Create empty track collection (default type: track)
rfmedia plex collection create "Jazz Favorites" --library Music

# Create artist collection
rfmedia plex collection create "Jazz Icons" --library Music --type artist --genre Jazz

# Create album collection with filters
rfmedia plex collection create "Modern Jazz Albums" \
  --library Music \
  --type album \
  --genre Jazz \
  --min-year 2010

# Create smart track collection
rfmedia plex collection create "Top Rated Tracks" \
  --library Music \
  --type track \
  --min-track-stars 4 \
  --smart
```

**Basic Options:**

| Option                          | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `--library <name>`              | Library name (required)                          |
| `--type <track\|album\|artist>` | Collection media type (default: `track`)         |
| `--genre <genre>`               | Filter by genre                                  |
| `--year <year>`                 | Filter by year (`>=2020`, `<2000`, `2020-2023`)  |
| `--min-stars <N>`               | Minimum star rating (1.0-5.0, track-compat shim) |
| `-l, --limit <N>`               | Maximum number of items to add                   |
| `--smart`                       | Create smart collection (track mode only)        |
| `--plex-url <url>`              | Override Plex server URL                         |
| `--plex-token <token>`          | Override Plex token                              |

**Advanced Filter Options:**

| Option                   | Description                       |
| ------------------------ | --------------------------------- |
| `-F, --filter <name>`    | Use a named filter from config    |
| `--min-artist-stars <N>` | Minimum artist rating (1-5)       |
| `--max-artist-stars <N>` | Maximum artist rating (1-5)       |
| `--min-album-stars <N>`  | Minimum album rating (1-5)        |
| `--max-album-stars <N>`  | Maximum album rating (1-5)        |
| `--min-track-stars <N>`  | Minimum track rating (1-5)        |
| `--max-track-stars <N>`  | Maximum track rating (1-5)        |
| `--style <style>`        | Filter by style (comma-separated) |
| `--mood <mood>`          | Filter by mood (comma-separated)  |
| `--artist <name>`        | Filter by artist name (contains)  |
| `--title <name>`         | Filter by track title (contains)  |
| `--album <name>`         | Filter by album title (contains)  |
| `--min-year <year>`      | Minimum release year              |
| `--max-year <year>`      | Maximum release year              |
| `--min-plays <count>`    | Minimum play count                |

If `--type` is `artist` or `album`, `--smart` is rejected and the command fails before any mutation call.

### Add to Collection

Add items to an existing collection using filters or from a local folder:

```bash
# Add tracks matching filter criteria (default mode: track)
rfmedia plex collection add "Jazz Favorites" \
  --library Music \
  --genre "Bebop"

# Add artists to an artist collection
rfmedia plex collection add "Jazz Icons" \
  --library Music \
  --mode artist \
  --genre "Jazz"

# Add albums to an album collection
rfmedia plex collection add "Modern Jazz Albums" \
  --library Music \
  --mode album \
  --min-year 2010

# Add tracks from local folder (track mode only)
rfmedia plex collection add "Imported Jazz" \
  --library Music \
  --mode track \
  --from-folder /mnt/music/imports/jazz
```

**Basic Options:**

| Option                          | Description                              |
| ------------------------------- | ---------------------------------------- |
| `--library <name>`              | Library name                             |
| `--mode <track\|album\|artist>` | Add mode (defaults to track)             |
| `--add-track`                   | Alias for `--mode track`                 |
| `--add-album`                   | Alias for `--mode album`                 |
| `--add-artist`                  | Alias for `--mode artist`                |
| `--from-folder <path>`          | Add items from local folder (track only) |
| `--genre <genre>`               | Filter by genre                          |
| `--year <year>`                 | Filter by year                           |
| `--min-stars <N>`               | Minimum star rating (1-5)                |
| `-l, --limit <N>`               | Maximum number of items                  |

**Advanced Filter Options:**

| Option                   | Description                       |
| ------------------------ | --------------------------------- |
| `-F, --filter <name>`    | Use a named filter from config    |
| `--min-artist-stars <N>` | Minimum artist rating (1-5)       |
| `--max-artist-stars <N>` | Maximum artist rating (1-5)       |
| `--min-album-stars <N>`  | Minimum album rating (1-5)        |
| `--max-album-stars <N>`  | Maximum album rating (1-5)        |
| `--min-track-stars <N>`  | Minimum track rating (1-5)        |
| `--max-track-stars <N>`  | Maximum track rating (1-5)        |
| `--style <style>`        | Filter by style (comma-separated) |
| `--mood <mood>`          | Filter by mood (comma-separated)  |
| `--artist <name>`        | Filter by artist name (contains)  |
| `--title <name>`         | Filter by track title (contains)  |
| `--album <name>`         | Filter by album title (contains)  |
| `--min-year <year>`      | Minimum release year              |
| `--max-year <year>`      | Maximum release year              |
| `--min-plays <count>`    | Minimum play count                |

### Mode and Safety Rules

- Add mode must match the target collection media type.
- Type mismatch is rejected before `addItems` API mutation.
- `--from-folder` is supported only in track mode.
- Use `rfmedia plex collection show <name> --library <name>` to verify media type before add operations.

### List Collections

View all collections in a library:

```bash
# List collections
rfmedia plex collection list --library Music

# JSON output for scripting
rfmedia plex collection list --library Music --json
```

**Output example:**

```
Collections in Music:

Collection         Items   Media Type  Collection  Added
---------------------------------------------------------
Jazz Favorites     45      Track       Static      2026-01-15
Jazz Icons         32      Artist      Static      2026-01-10
Top Rated Tracks   89      Track       Smart       2026-01-08
```

### Show Collection

Display collection details and contents:

```bash
rfmedia plex collection show "Jazz Favorites" --library Music
```

Example fields include:

- `Media Type: Track`
- `Collection: Smart` or `Collection: Static`

### Delete Collection

Remove a collection (items remain in library):

```bash
# Delete with confirmation prompt
rfmedia plex collection delete "Old Collection" --library Music

# Skip confirmation
rfmedia plex collection delete "Old Collection" --library Music --yes
```

## Example Workflows

### Creating a Genre-Based Collection

```bash
# Create collection for jazz albums
rfmedia plex collection create "Jazz Collection" \
  --library Music \
  --genre Jazz

# Add bebop subgenre
rfmedia plex collection add "Jazz Collection" \
  --library Music \
  --genre "Bebop"

# Add modal jazz
rfmedia plex collection add "Jazz Collection" \
  --library Music \
  --genre "Modal Jazz"
```

### Creating a High-Rated Collection

```bash
# Create collection of 4+ star tracks
rfmedia plex collection create "Best of Library" \
  --library Music \
  --min-stars 4
```

### Adding Imported Music to Collection

After importing new music to your library:

```bash
# Wait for Plex to scan the new files, then:
rfmedia plex collection add "Recent Imports" \
  --from-folder /mnt/music/imports/2026-01
```

### Managing Year-Based Collections

```bash
# Create decade collections
rfmedia plex collection create "1980s Music" --library Music --year "1980-1989"
rfmedia plex collection create "1990s Music" --library Music --year "1990-1999"
rfmedia plex collection create "2000s Music" --library Music --year "2000-2009"
```

## Advanced Filtering

The collection commands support sophisticated filtering using named filters from your configuration file. This enables complex criteria with nested boolean logic (AND/OR groups), hierarchical ratings, and text-based filters.

For detailed filter syntax documentation, see [plex-filters.md](plex-filters.md).

### Using Named Filters

Named filters are defined in your `.rfmedia.yaml` configuration under the `plexFilters` section:

```yaml
# .rfmedia.yaml
plexFilters:
  jazz-high-rated:
    match: all
    library: Music
    type: track
    rules:
      - type: rule
        field: genre
        operator: contains
        value: Jazz
      - type: rule
        field: artistRating
        operator: ">="
        value: 4

  weekend-vibes:
    match: any
    library: Music
    type: track
    rules:
      - type: rule
        field: mood
        operator: contains
        value: Chill
      - type: rule
        field: mood
        operator: contains
        value: Relaxed
```

Use the `--filter` (or `-F`) option to reference a named filter:

```bash
# Create collection using a named filter
rfmedia plex collection create "Jazz Favorites" --filter jazz-high-rated

# Add to collection using a named filter
rfmedia plex collection add "Weekend Mix" --filter weekend-vibes
```

### Combining Filters with CLI Overrides

CLI options can override or extend named filter defaults. The precedence order is:

1. **CLI options** (highest priority)
2. **Named filter defaults**
3. **Config defaults** (lowest priority)

```bash
# Use named filter but override minimum plays requirement
rfmedia plex collection add "Weekend Mix" --filter weekend-vibes --min-plays 5

# Use named filter but limit results
rfmedia plex collection create "Top Jazz" --filter jazz-high-rated --limit 100

# Use named filter with additional artist filter
rfmedia plex collection create "Jazz Greats" --filter jazz-high-rated --artist "Miles Davis"
```

### Hierarchical Rating Filters

Filter by artist, album, or track ratings independently:

```bash
# Tracks from 4+ star artists
rfmedia plex collection create "From Top Artists" \
  --library Music \
  --min-artist-stars 4

# Tracks from high-rated artists AND albums
rfmedia plex collection create "Quality Tracks" \
  --library Music \
  --min-artist-stars 3 \
  --min-album-stars 3

# Highly rated tracks specifically
rfmedia plex collection create "5-Star Tracks" \
  --library Music \
  --min-track-stars 5
```

### Text and Metadata Filters

Filter by style, mood, artist name, album name, or track title:

```bash
# Filter by style
rfmedia plex collection create "Smooth Jazz" \
  --library Music \
  --style "Smooth Jazz"

# Filter by mood (comma-separated for OR logic)
rfmedia plex collection create "Chill Vibes" \
  --library Music \
  --mood "Chill,Relaxed,Mellow"

# Filter by artist name (substring match)
rfmedia plex collection create "Beatles Collection" \
  --library Music \
  --artist "Beatles"

# Combine multiple text filters
rfmedia plex collection create "Jazz Piano" \
  --library Music \
  --genre Jazz \
  --title "Piano"
```

### Year and Play Count Filters

```bash
# Tracks from a specific year range
rfmedia plex collection create "Modern Jazz" \
  --library Music \
  --genre Jazz \
  --min-year 2010 \
  --max-year 2025

# Frequently played tracks
rfmedia plex collection create "Most Played" \
  --library Music \
  --min-plays 20

# Combine year and play count
rfmedia plex collection create "Modern Favorites" \
  --library Music \
  --min-year 2020 \
  --min-plays 10
```

### Complex Filter Examples

```bash
# High-rated modern rock
rfmedia plex collection create "Modern Rock Favorites" \
  --library Music \
  --genre Rock \
  --min-year 2010 \
  --min-artist-stars 3 \
  --min-album-stars 3

# Well-played jazz from top artists
rfmedia plex collection create "Jazz Essentials" \
  --library Music \
  --genre Jazz \
  --min-artist-stars 4 \
  --min-plays 5

# Chill electronic tracks from the 2020s
rfmedia plex collection create "2020s Chill Electronic" \
  --library Music \
  --genre Electronic \
  --mood "Chill,Ambient" \
  --min-year 2020
```

### Quick Reference

| Filter        | Syntax                     | Examples                                     |
| ------------- | -------------------------- | -------------------------------------------- |
| Genre         | `--genre <name>`           | `--genre Rock`, `--genre "Progressive Rock"` |
| Year          | `--year <expr>`            | `--year 2020`, `--year ">=2020"`             |
| Year range    | `--min-year`, `--max-year` | `--min-year 2010 --max-year 2019`            |
| Star rating   | `--min-stars <N>`          | `--min-stars 4` (4+ stars)                   |
| Artist rating | `--min-artist-stars <N>`   | `--min-artist-stars 3`                       |
| Album rating  | `--min-album-stars <N>`    | `--min-album-stars 4`                        |
| Track rating  | `--min-track-stars <N>`    | `--min-track-stars 5`                        |
| Play count    | `--min-plays <N>`          | `--min-plays 10`                             |
| Style         | `--style <style>`          | `--style "Smooth Jazz"`                      |
| Mood          | `--mood <mood>`            | `--mood "Chill,Relaxed"` (OR logic)          |
| Artist name   | `--artist <name>`          | `--artist "Miles Davis"`                     |
| Album name    | `--album <name>`           | `--album "Kind of Blue"`                     |
| Track title   | `--title <name>`           | `--title "Piano"`                            |
| Named filter  | `-F, --filter <name>`      | `--filter jazz-high-rated`                   |

### Operator Reference

When using named filters (via `-F, --filter`), the following operators are available for filter rules:

| Operator       | Description                             | Compatible Fields                        |
| -------------- | --------------------------------------- | ---------------------------------------- |
| `>=`           | Greater than or equal                   | Rating fields, year fields, minPlays     |
| `<=`           | Less than or equal                      | Rating fields, year fields, minPlays     |
| `==`           | Exact match (case-insensitive for text) | All fields                               |
| `!=`           | Not equal (case-insensitive for text)   | All fields                               |
| `contains`     | Substring match (case-insensitive)      | genre, style, mood, artist, album, title |
| `not_contains` | Substring exclusion (case-insensitive)  | genre, style, mood, artist, album, title |

**Note**: The `!=` and `not_contains` operators are now pushed to the Plex API server-side. The Plex API supports `!=` for both numeric fields (not equals) and string fields (does not contain).

## Path Matching for --from-folder

The `--from-folder` option matches local audio files to Plex library tracks. Understanding path matching is crucial for successful folder-based collection building.

### Three-Tier Matching Strategy

The matching algorithm uses a progressive strategy to handle path differences:

1. **Tier 1: Exact Path Match**
   - Compares full file paths directly
   - Works when local path matches Plex's stored path exactly
   - Example: `/mnt/music/Artist/Album/track.flac` matches `/mnt/music/Artist/Album/track.flac`

2. **Tier 2: Filename Match**
   - Falls back to matching by filename only
   - Handles different mount points between your system and Plex
   - Example: `/mnt/music/track.flac` matches `/media/music/track.flac`
   - **Warning:** Skipped if multiple Plex tracks have the same filename

3. **Tier 3: Case-Insensitive Match**
   - Further fallback with case-insensitive filename comparison
   - Handles Linux (case-sensitive) vs macOS/Windows (case-insensitive) differences
   - Example: `/mnt/music/Track.flac` matches `/media/music/track.flac`

### Common Path Issues

**Mount Point Differences**

Your local system and Plex server may see files at different paths:

```
Local path:  /mnt/media/music/Artist/Album/track.flac
Plex path:   /music/Artist/Album/track.flac
```

The filename matching tier handles this automatically.

**Case Sensitivity**

Linux filesystems are case-sensitive, macOS/Windows are not:

```
Local (macOS): /Music/Artist/Track.FLAC
Plex (Linux):  /music/Artist/track.flac
```

The case-insensitive tier handles this.

**Symlinks**

Symbolic links may result in different paths:

```
Local (symlink): /home/user/music/track.flac -> /mnt/nas/music/track.flac
Plex path:       /mnt/nas/music/track.flac
```

Filename matching handles this by ignoring directory structure.

### Troubleshooting Unmatched Files

When files cannot be matched, the command reports:

```
Found 50 audio files in folder
Matched 45 files to Plex library
5 files could not be matched (use --verbose for details)
```

**Common causes of unmatched files:**

1. **File not in Plex library**: The file exists locally but Plex has not scanned it yet
2. **Different filename**: File was renamed after Plex scan
3. **Duplicate filenames**: Multiple files with same name prevent reliable matching
4. **Unsupported format**: File format not recognized by Plex

**Debugging steps:**

```bash
# Use verbose mode to see unmatched files
rfmedia plex collection add "My Collection" --from-folder /path/to/folder --verbose

# Verify file is in Plex
rfmedia plex query run --library Music --limit 10
```

## Configuration

For complete Plex configuration options, see [plex-configuration.md](plex-configuration.md).

### Relevant Configuration Options

```yaml
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
  libraryName: "Music" # Default library for commands
```

### CLI Overrides

Override configuration per-command:

```bash
rfmedia plex collection list \
  --plex-url http://192.168.1.100:32400 \
  --plex-token YOUR_TOKEN \
  --library "My Music Library"
```

## API Details

### Plex Collections API Endpoints

The collection commands interact with the following Plex API endpoints:

| Operation         | Method | Endpoint                             | Notes                                               |
| ----------------- | ------ | ------------------------------------ | --------------------------------------------------- |
| List collections  | GET    | `/library/sections/{id}/collections` | Returns all collections in library                  |
| Get collection    | GET    | `/library/collections/{id}`          | Single collection details                           |
| Get items         | GET    | `/library/collections/{id}/children` | Items in collection                                 |
| Create collection | POST   | `/library/collections`               | Body includes `title`, `sectionId`, `type=8\|9\|10` |
| Add items         | PUT    | `/library/collections/{id}/items`    | Query: `uri=server://...`                           |
| Delete collection | DELETE | `/library/collections/{id}`          | Permanent removal                                   |

### URI Format for Adding Items

Adding items to collections requires a specific URI format:

```
server://{machineIdentifier}/com.plexapp.plugins.library/library/metadata/{ratingKey}
```

Where:

- `machineIdentifier`: Unique server identifier (fetched from Plex root endpoint)
- `ratingKey`: Item's unique identifier in Plex

The CLI handles this format automatically - you only need to provide filter criteria or folder paths.

### Rate Limiting

All API requests include a 100ms delay to avoid overwhelming the Plex server. For large operations (adding hundreds of items), expect proportional time:

```
500 items * 100ms = 50 seconds minimum
```

## Limitations

### Current Scope

The current implementation has the following limitations:

1. **Music Collections Only**: The implementation focuses on music library collections. Video library collections may work but are not tested.

2. **In-Memory API Caching**: `getCollections` responses are cached with a configurable TTL to reduce redundant API calls. Write operations (`createCollection`, `addToCollection`, `deleteCollection`) automatically invalidate the cache. The cache is in-memory only and does not persist across CLI invocations. See [plex-configuration.md](plex-configuration.md) for cache configuration details.

3. **Single-Library Operations**: Each command operates on one library at a time. Cross-library collections are not supported.

4. **Smart Collections and Media Type**: `--smart` is currently supported only for track collections. Artist/album smart creation is rejected.

5. **Folder Mode Scope**: `--from-folder` matching is track-only and is not supported for artist/album add modes.

### Future Enhancements

Planned features for future releases:

- Video library support
- Batch operations with parallel requests
- Collection artwork customization

## Related Documentation

- [plex-filters.md](plex-filters.md) - Complete filter syntax documentation
- [plex-configuration.md](plex-configuration.md) - Plex configuration options
- [README.md](../../README.md) - Command reference and usage examples

---

_Last Updated: February 2026_
