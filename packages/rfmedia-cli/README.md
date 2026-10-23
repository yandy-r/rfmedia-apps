# rfmedia

A TypeScript CLI tool for music library management. This tool replaces the legacy bash scripts `cp-music.sh` and `del-empty.sh` with a modern, type-safe implementation.

## Features

- **Multiple Sources**: Process multiple source paths in a single command with per-path range support
- **YAML-Based Paths**: Define destination, defaults, and sources in YAML with selective processing by index or name
- **Album Mode**: Copy entire albums with numbered suffixes (e.g., `Album-001`, `Album-002`)
- **Filter Mode**: Copy individual tracks based on star ratings
- **Smart Filters**: Complex filtering with nested boolean logic (AND/OR groups), supporting genre, year, BPM, and metadata criteria
- **Sync Mode**: Incrementally sync sources, detecting new files and rating changes
- **Watch Mode**: Monitor directories and automatically copy new files as they appear
- **Link Videos**: Create hardlinks from music videos to matching audio tracks (Plex video association)
- **Audio Conversion**: Convert audio files to ALAC, MP3, AAC, or Opus formats during copy
- **Parallel Processing**: Process multiple files concurrently for faster operations
- **Empty Folder Cleanup**: Remove empty album and artist directories
- **Hardlink Support**: Save disk space by using hardlinks instead of copies
- **Plex Integration**: Automatic library scanning after copy operations
- **Lidarr Integration**: Read-only status, listing, search, Last.fm similar-artist discovery, import
  validation, health, and Plex-Lidarr reconciliation; a read-only library health audit with an
  opt-in CI gate; a consumption-driven policy engine that turns Plex play and rating signals into
  explainable proposed Lidarr actions without mutating anything; and sealed plan/apply workflows for
  writes and exact trackfile filtering
- **Smart Playlists**: Generate M3U playlist files from smart filters or Plex playlists with update support
- **Undo/Rollback**: Reverse recent copy and clean operations with SQLite-backed history
- **Operation Tracking**: SQLite-based tracking for resumable operations with automatic legacy migration
- **Metadata Reconciliation**: Three-plane reporting across file tags, SQLite inventory, and the
  media server, with preview-first rating and inventory-stat repair
- **Table-Based Output**: Clean tables for previews, summaries, stats, and history
- **Graceful Interruption**: Safe cancellation of long-running operations with proper cleanup and state preservation
- **Shell Completion**: Tab completion scripts for bash, zsh, and fish shells
- **Plugin System**: Extend copy operations with custom processing via four hooks (beforeCopy, afterCopy, processFile, afterBatch), supporting both ESM plugins and external command wrappers
- **Dry-Run Mode**: Preview operations without making changes
- **Multiple Output Formats**: Machine-readable output (JSON, YAML, CSV) and human-readable (table, text) for scripting and automation

## Installation

### Prerequisites

- Node.js 22.23.4 or later
- npm or another package manager
- ffmpeg (required for audio conversion with `--convert`)

### Install from Source

```bash
cd rfmedia-cli
npm install
npm run build
```

### Development Mode

For development, use `tsx` to run TypeScript directly without building:

```bash
npm run dev -- <command> [options]

# Example
npm run dev -- copy /source /dest --range=001-005 --dry-run
```

### After Building

```bash
# Run the built CLI
npm start -- <command> [options]

# Or use the binary directly
./dist/cli.js <command> [options]
```

## Command Reference

### Global Options

These options are available for all commands:

| Option              | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `--debug`           | Enable verbose debug output                                 |
| `--json`            | Output results in JSON format (shorthand for --output json) |
| `--output <format>` | Output format: json, yaml, csv, table, text                 |
| `-V, --version`     | Display version number                                      |
| `-h, --help`        | Display help information                                    |

`--dry-run` is not a global option. Each subcommand that supports previewing (e.g. `copy`,
`clean`, `verify`) declares its own `--dry-run`, so the flag must be placed after the
subcommand: `rfmedia copy ... --dry-run` works, `rfmedia --dry-run copy ...` is rejected
with `unknown option`.

### MCP Server (`rfmedia mcp`)

Run rfmedia as an MCP stdio JSON-RPC server:

```bash
rfmedia mcp
```

Supported protocol methods:

- `initialize`
- `tools/list`
- `tools/call`

Available tools:

- `rfmedia.filter.list`
- `rfmedia.filter.show`
- `rfmedia.copy.album`
- `rfmedia.copy.filter`
- `rfmedia.sync`
- `rfmedia.plex.query`

Argument conventions:

- Tool arguments are JSON objects with strict schemas (unknown fields are rejected)
- `sources` is an array of path entries (instead of CLI positional parsing)
- Copy/sync tools are non-interactive; `conflictStrategy: "ask"` is rejected in MCP mode
- `copy.filter` supports either `filterName`, `smartFilter`, or rating thresholds

Success envelope (`tools/call`):

```json
{
  "isError": false,
  "structuredContent": { "ok": true, "result": {} }
}
```

Failure envelope (`tools/call`):

```json
{
  "isError": true,
  "structuredContent": {
    "ok": false,
    "error": {
      "code": "MCP_VALIDATION_ERROR",
      "message": "...",
      "suggestions": []
    }
  }
}
```

MCP runtime prerequisites:

- The server still runs through normal rfmedia bootstrap + preAction lifecycle
- Config/secrets must be available before startup (`--use-dotenvx` or `--use-op` supported)
- Tools execute against the loaded config state (`setLoadedConfig`) used by CLI commands

### Structured Error Output

Fail-fast validation errors are rendered through the shared formatter pipeline with corrective suggestions.

```bash
# Invalid global output format
rfmedia --output xml copy /music/Artist /dest --range=001-003

Error: Unknown output format: xml

Suggestions:
  • Valid formats: json, yaml, csv, table, text
  • Use --json as shorthand for --output json
  • Run with --debug for more details
```

```bash
# Unknown filter in YAML/config lookup
rfmedia copy --paths paths.yml

Error: Unknown filter: 'rock-clasics'

Suggestions:
  • Did you mean 'rock-classics'?
  • Available filters: liked, rock-classics
  • Context: source path: /music/Artist
  • Run with --debug for more details
```

```bash
# Source selection typo
rfmedia copy --paths paths.yml --source-name briteny

Error: Invalid source selection: No sources matched the selection criteria.

Suggestions:
  • Selection: --source-name=briteny
  • Did you mean 'Britney Spears'?
  • Available sources:
      1: groups: pop-divas, artist: Britney Spears
      2: groups: pop-divas, artist: Mariah Carey
  • Run with --debug for more details
```

### `rfmedia reconcile`

Compare embedded file tags, operation-scoped SQLite inventory, and a current media-server track
snapshot by exact normalized absolute path.

```bash
# Read-only scan
rfmedia reconcile scan /mnt/media/music --library Music

# Preview a rating strategy (no writes)
rfmedia reconcile apply /mnt/media/music --server-wins --library Music

# Execute with the default-No interactive approval
rfmedia reconcile apply /mnt/media/music --server-wins --library Music --execute

# Explicit non-interactive execution and machine output
rfmedia --output json reconcile apply /mnt/media/music \
  --server-wins \
  --library Music \
  --execute \
  --yes
```

Scan observes normalized rating, primary artist, first genre, and year. V1 apply writes only rating
to supported targets and refreshes changed stat evidence for one uniquely selected inventory row;
artist, genre, and year remain observation-only. Exactly one of `--file-wins`, `--db-wins`, or
`--server-wins` is required for apply. The winner chooses rating authority but does not authorize a
write: without `--execute`, apply is always a preview; `--yes` or a machine format alone performs no
mutation. Reconciliation local file mutation is Linux MP3-only; FLAC and every other local format
remain observable but unsupported write targets in this workflow.

Findings distinguish missing values or planes, conflicts, stale inventory, ambiguous database or
server evidence, unsupported targets, and in-sync records. Metadata read or parse failures abort
acquisition and return an invocation-level error envelope rather than a per-file finding.

| Invocation                                    | Can mutate?                        |
| --------------------------------------------- | ---------------------------------- |
| `reconcile scan`                              | Never                              |
| `reconcile apply` without `--execute`         | Never                              |
| Winner flag, `--yes`, or machine output alone | Never                              |
| `reconcile apply --execute` with approval     | Supported rating/stat targets only |

The media library resolves from `--library`, then `plex.libraryName`. The tracking database resolves
from `--tracking-database`, `undo.database`, `tracking.database`, an existing
`~/.config/rfmedia/tracking.db`, then an existing legacy `~/.rfmedia/tracking.db`. Read-only scan
and preview require that selected database to exist.

See the
[Metadata Reconciliation guide](docs/features/metadata-reconciliation.md)
for exact-path identity, operation ambiguity, blockers and `--allow-partial`, output schemas, exit
behavior, limitations, and recovery.

### `rfmedia init`

Generate a configuration file template with all available options.

```bash
rfmedia init [options]
```

**Options:**

| Option              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `-p, --path <path>` | Custom path for the config file                         |
| `-g, --global`      | Write to global config (`~/.rfmedia.yaml`)              |
| `--force`           | Overwrite existing config file                          |
| `--no-merge`        | Generate fresh template without merging existing config |

**Merge Behavior:**

By default, `init` merges new template properties with your existing configuration, preserving your custom values while adding any new options from the template.

During merge:

- Existing `filters` and `plexFilters` sections are preserved as-is (not overwritten).
- Existing custom or future top-level config keys are preserved.
- For YAML configs, a commented filter example block is appended for reference.

Use `--no-merge` with `--force` to completely replace your config.

**Examples:**

```bash
# Create .rfmedia.yaml in current directory
rfmedia init

# Create global config
rfmedia init --global

# Create at custom path
rfmedia init --path=/path/to/config.yaml

# Update existing config with new template properties (merge)
rfmedia init --force

# Replace existing config with fresh template (no merge)
rfmedia init --force --no-merge
```

### `rfmedia copy`

Copy music albums or filter tracks by rating. Operates in two mutually exclusive modes.

#### Album Mode

Copies entire albums with numbered suffixes. Requires `--range`.

```bash
rfmedia copy <source> <destination> --range=<START-END> [options]
```

**Options:**

| Option                    | Description                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `-r, --range <START-END>` | Range of suffixes to create (e.g., `001-010`)                                          |
| `--count <N>`             | Number of copies to create (auto-detects next range)                                   |
| `--album-only`            | Treat source as single album (not artist folder)                                       |
| `--hardlink`              | Use hardlinks instead of file copies                                                   |
| `--force`                 | Overwrite existing copies even if complete                                             |
| `--file <path>`           | Read source paths from file                                                            |
| `--paths <path>`          | Read destination, sources, and options from YAML file                                  |
| `--source-idx <indices>`  | Select sources by index (1-based, e.g., `"1,3"` or `"2-5"`) - requires `--paths`       |
| `--source-name <names>`   | Unified search: matches groups, artist, or basename - requires `--paths`               |
| `--artist <names>`        | Select sources by artist (case-insensitive) - requires `--paths`                       |
| `--group <names>`         | Select sources by group (case-insensitive) - requires `--paths`                        |
| `-i, --interactive`       | Interactively select sources and albums/tracks (requires TTY)                          |
| `-c, --convert <format>`  | Convert audio to format: `alac`, `mp3`, `aac`, `opus`                                  |
| `-w, --workers <N>`       | Number of parallel workers (default: half of CPU cores)                                |
| `--plex-scan`             | Trigger Plex library scan after copy                                                   |
| `--no-plex-scan`          | Disable Plex library scan                                                              |
| `--plex-url <url>`        | Plex server URL (e.g., `http://localhost:32400`)                                       |
| `--plex-token <token>`    | Plex authentication token                                                              |
| `--plex-library <name>`   | Plex library name to scan (e.g., `Music`)                                              |
| `--require-space`         | Abort if insufficient disk space                                                       |
| `--no-require-space`      | Skip disk space check                                                                  |
| `-v, --verbose`           | Show file-level details in dry-run preview                                             |
| `--plan`                  | Write a reviewable plan manifest instead of copying (see [Plan / Apply](#plan--apply)) |
| `--plan-output <path>`    | Custom output path for the plan manifest (with `--plan`)                               |
| `--apply <planPath>`      | Execute a previously saved plan manifest                                               |
| `-y, --yes`               | Skip the apply confirmation prompt (with `--apply`)                                    |
| `--force-stale`           | Apply despite overridable staleness errors (with `--apply`)                            |

**Note:** `--range` and `--count` are mutually exclusive. Use `--range` to specify exact suffixes, or `--count` for automatic range detection.

**Examples:**

```bash
# Create Album-001 through Album-005 (skips any that exist)
rfmedia copy "/music/Artist" /dest --range=001-005

# Add copies 006-010 to existing set
rfmedia copy "/music/Artist" /dest --range=006-010

# Recreate specific range even if they exist
rfmedia copy "/music/Artist" /dest --range=001-003 --force

# Copy a single album (not an artist folder)
rfmedia copy "/music/Artist/Album" /dest --range=001-003 --album-only

# Use hardlinks to save disk space
rfmedia copy "/music/Artist" /dest --range=001-010 --hardlink

# Preview what would happen
rfmedia copy "/music/Artist" /dest --range=001-005 --dry-run

# Process multiple artists from a file
rfmedia copy --file=artists.txt /dest --range=001-005

# Interactive selection: choose sources and albums interactively
rfmedia copy --paths=sources.yml --interactive --min-stars=3
```

**Interactive Mode:**

The `--interactive` flag provides a multi-step selection flow for choosing which sources and albums/tracks to process:

1. **Source Selection**: Multi-select from available sources with keyboard navigation
   - Use `space` to toggle selection
   - Press `enter` to confirm

2. **Per-Source Refinement**: For each selected source, optionally drill down:
   - **Album mode**: Select specific albums to copy
   - **Filter mode**: Choose album-level or track-level selection
   - Display shows track count, rated count, and average rating per album

**Interactive Mode Examples:**

```bash
# Interactive album mode: select sources and albums
rfmedia copy --paths=sources.yml --range=001-005 --interactive

# Interactive filter mode: select sources, then albums or tracks
rfmedia copy --paths=sources.yml --min-stars=3.5 --interactive

# Interactive with multiple positional sources
rfmedia copy "/music/Artist1" "/music/Artist2" /dest --range=001-003 --interactive
```

**Interactive Mode Notes:**

- Requires a TTY terminal (won't work in CI or piped input)
- Cannot be combined with `--json` output
- Single source skips source selection, goes directly to album/track refinement
- If you skip refinement for a source, all albums/tracks are included (filtered by rating threshold if applicable)

**Dry-Run Preview Output:**

Dry-run output uses table formatting by default. Use `--verbose` to append file-level details after the summary table.

##### Auto-Range Detection with --count

The `--count` option automatically detects the highest existing suffix in the destination and creates N additional numbered copies starting from the next available number. This is useful when you want to add more copies without manually tracking what already exists.

**How it works:**

1. Scans the destination directory for existing numbered directories (e.g., `Album-001`, `Album-002`)
2. Detects the highest suffix number and padding width
3. Creates the specified number of copies starting from the next available suffix

**Examples:**

```bash
# Empty destination: creates Album-001, Album-002, Album-003
rfmedia copy "/music/Artist" /dest --count=3

# Existing 001-002: creates Album-003, Album-004, Album-005
rfmedia copy "/music/Artist" /dest --count=3

# With filter mode: creates numbered copies of liked tracks
rfmedia copy "/music/Artist" /dest --min-stars=4 --count=3

# Process multiple artists from file with auto-range
rfmedia copy --file=artists.txt /dest --count=5

# Preview auto-detected ranges
rfmedia copy "/music/Artist" /dest --count=3 --dry-run
```

**Validation:**

- `--count` must be at least 1
- Cannot be used together with `--range` (mutually exclusive)
- Preserves padding width from existing suffixes (e.g., if `Album-001` exists, continues with 3-digit padding)
- Defaults to 3-digit padding (001, 002, ...) for empty destinations

##### Multiple Sources

Process multiple sources in a single command:

```bash
# Multiple sources with different ranges
rfmedia copy \
  "/music/Artist1,001-003" \
  "/music/Artist2,004-006" \
  "/music/Artist3,007-010" \
  /dest

# Mix sources with and without explicit ranges
rfmedia copy \
  "/music/Artist1,001-003" \
  "/music/Artist2" \
  /dest \
  --range=001-005
```

**Range Precedence:**

Ranges are resolved in the following priority order (highest to lowest):

1. **CLI `--range`** - Applies to ALL sources, overrides everything
2. **CLI `--count`** - Auto-detects and generates range per-source (mutually exclusive with `--range`)
3. **Per-path ranges** - `/path,001-003` format in file input
4. **Config `copy.range`** - Fallback for sources without explicit ranges

In the mixed example above:

- `Artist1` uses `001-003` (explicit per-path range)
- `Artist2` uses `001-005` (from `--range`)

If `--range=001-010` were added to the mixed example, both artists would use `001-010`.

**With `--count`:**

When using `--count`, ranges are auto-detected individually for each source path. This means different sources can end up with different ranges based on what already exists in their respective destination directories.

##### YAML-Based Paths

The `--paths` option provides a YAML-based alternative for specifying sources and destination. It supports defaults, per-source options, and selective source processing.

**Basic YAML Structure:**

```yaml
destination: /data/media/music-manual

# Optional defaults that apply to all sources
defaults:
  filter: liked
  count: 5
  outputFolder: liked-songs

sources:
  - path: /music/Artist1 # Uses all defaults

  - path: /music/Artist2
    count: 10 # Override specific options
    filter: rock-classics
```

**Usage:**

```bash
# Process all sources from YAML
rfmedia copy --paths paths.yml

# Select specific sources by index (1-based)
rfmedia copy --paths paths.yml --source-idx 2
rfmedia copy --paths paths.yml --source-idx 1,3-5

# Select sources by group
rfmedia copy --paths paths.yml --group pop-divas

# Select sources by artist
rfmedia copy --paths paths.yml --artist britney
rfmedia copy --paths paths.yml --artist "britney,shakira"

# Unified search (matches groups, artist, or basename)
rfmedia copy --paths paths.yml --source-name divas

# Preview before running
rfmedia copy --paths paths.yml --dry-run
```

**Named Sources for Selection:**

```yaml
sources:
  - name: pop-divas
    artist: Britney Spears
    path: /music/Britney Spears (uuid)

  - name: pop-divas
    artist: Christina Aguilera
    path: /music/Christina Aguilera (uuid)

  - artist: Mariah Carey # Falls back to artist for name
    path: /music/Mariah Carey (uuid)
```

```bash
# Process all pop-divas sources
rfmedia copy --paths paths.yml --group pop-divas
```

**Available YAML Options:**

- **defaults section**: `filter`, `count`, `range`, `outputFolder`, `convert`
- **per-source**: `name`, `count`, `range`, `filter`, `outputFolder`, `convert`, `artist`, `type`, `media`

**Precedence**: Per-source > YAML defaults > CLI options > Config file

See [YAML-Based Paths Documentation](./docs/features/paths-yaml.md) for complete details.

#### Filter Mode

Copies individual tracks meeting a rating threshold. Requires `--min-stars` or `--min-rating`.

```bash
rfmedia copy <source> <destination> --min-stars=<N> [options]
rfmedia copy <source> <destination> --min-rating=<N> [options]
```

**Options:**

| Option                    | Description                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `--min-stars <1.0-5.0>`   | Minimum star rating (1.0-5.0, supports half-stars like 3.5)                            |
| `--min-rating <0-100>`    | Minimum rating on 0-100 scale                                                          |
| `-r, --range <START-END>` | Range of suffixes to create (e.g., `001-010`) for track names                          |
| `--output-folder <name>`  | Folder name for filtered tracks (default: `liked-songs`)                               |
| `--preserve-structure`    | Keep album subfolders in output                                                        |
| `--hardlink`              | Use hardlinks instead of file copies                                                   |
| `--force`                 | Overwrite existing files                                                               |
| `--file <path>`           | Read source paths from file                                                            |
| `--paths <path>`          | Read destination, sources, and options from YAML file                                  |
| `--source-idx <indices>`  | Select sources by index (1-based, e.g., `"1,3"` or `"2-5"`) - requires `--paths`       |
| `--source-name <names>`   | Unified search: matches groups, artist, or basename - requires `--paths`               |
| `--artist <names>`        | Select sources by artist (case-insensitive) - requires `--paths`                       |
| `--group <names>`         | Select sources by group (case-insensitive) - requires `--paths`                        |
| `-c, --convert <format>`  | Convert audio to format: `alac`, `mp3`, `aac`, `opus`                                  |
| `-w, --workers <N>`       | Number of parallel workers (default: half of CPU cores)                                |
| `--plex-scan`             | Trigger Plex library scan after copy                                                   |
| `--no-plex-scan`          | Disable Plex library scan                                                              |
| `--plex-url <url>`        | Plex server URL (e.g., `http://localhost:32400`)                                       |
| `--plex-token <token>`    | Plex authentication token                                                              |
| `--plex-library <name>`   | Plex library name to scan (e.g., `Music`)                                              |
| `--require-space`         | Abort if insufficient disk space                                                       |
| `--no-require-space`      | Skip disk space check                                                                  |
| `--plan`                  | Write a reviewable plan manifest instead of copying (see [Plan / Apply](#plan--apply)) |
| `--plan-output <path>`    | Custom output path for the plan manifest (with `--plan`)                               |
| `--apply <planPath>`      | Execute a previously saved plan manifest                                               |
| `-y, --yes`               | Skip the apply confirmation prompt (with `--apply`)                                    |
| `--force-stale`           | Apply despite overridable staleness errors (with `--apply`)                            |

**Metadata Filtering Options:**

In addition to rating-based filtering, you can filter tracks by audio metadata:

| Option                   | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `--min-duration <MM:SS>` | Minimum track duration (e.g., `1:30` for 1 minute 30 seconds) |
| `--max-duration <MM:SS>` | Maximum track duration (e.g., `10:00` for 10 minutes)         |
| `--min-bitrate <kbps>`   | Minimum bitrate in kbps (e.g., `320`)                         |
| `--codec <format>`       | Required codec, case-insensitive (e.g., `FLAC`, `MP3`)        |
| `--min-plays <N>`        | Minimum play count from POPM counter (MP3 only)               |

These options allow you to refine your filtered collection beyond just ratings:

- **Duration filtering**: Skip intros, interludes, or overly long live recordings
- **Bitrate filtering**: Ensure only high-quality encodes are included
- **Codec filtering**: Limit to specific audio formats (e.g., lossless only)
- **Play count filtering**: Include only frequently played tracks (MP3 only)

**Examples:**

```bash
# Copy only 4+ star tracks into Artist/liked-songs/
rfmedia copy "/music/Artist" /dest --min-stars=4

# Copy tracks rated 3.5+ stars (supports half-stars)
rfmedia copy "/music/Artist" /dest --min-stars=3.5

# Copy tracks rated 80+ (on 0-100 scale) with custom folder
rfmedia copy "/music/Artist" /dest --min-rating=80 --output-folder=favorites

# Keep album structure: Artist/liked-songs/Album1/track.flac
rfmedia copy "/music/Artist" /dest --min-stars=3 --preserve-structure

# Process multiple artists from file
rfmedia copy --file=artists.txt /dest --min-stars=4

# Skip tracks under 1 minute (exclude intros/interludes)
rfmedia copy /music /dest --min-rating=50 --min-duration=1:00

# Skip tracks over 10 minutes (exclude long live recordings)
rfmedia copy /music /dest --min-rating=50 --max-duration=10:00

# Only high-quality 320kbps+ files
rfmedia copy /music /dest --min-rating=50 --min-bitrate=320

# Only FLAC files (lossless)
rfmedia copy /music /dest --min-rating=50 --codec=FLAC

# Combined: high-quality full songs (2-8 min, 256kbps+)
rfmedia copy /music /dest --min-rating=80 --min-duration=2:00 --max-duration=8:00 --min-bitrate=256

# Only tracks played at least 5 times (MP3 with POPM counter)
rfmedia copy /music /dest --min-rating=50 --min-plays=5
```

**Output Structure:**

Default (flat) - tracks with duplicate names get suffixes:

```
Artist/
└── liked-songs/
    ├── My Song.flac           # First occurrence
    ├── My Song-002.flac       # Same song from different album
    ├── Another Track.mp3
    └── Third Song.m4a
```

With `--preserve-structure` - keeps album context:

```
Artist/
└── liked-songs/
    ├── Original Album/
    │   └── My Song.flac
    └── Greatest Hits/
        └── My Song.flac       # Same song, different source album
```

#### Smart Filters with Nested Boolean Logic

Smart filters enable complex filtering criteria with nested AND/OR groups, similar to iTunes Smart Playlists. Instead of specifying filter criteria on the command line, you define named filters in your configuration file and reference them by name.

**Configuration:**

Define filters in `.rfmedia.yaml` (default) or `.rfmedia.json` (legacy):

```yaml
# .rfmedia.yaml
filters:
  high-quality-rock:
    match: all # AND logic - all rules must match
    rules:
      - field: rating
        operator: ">="
        value: 4.0 # 4+ stars
      - match: any # OR logic - any rule in this group matches
        rules:
          - field: genre
            operator: contains
            value: Rock
          - field: genre
            operator: contains
            value: Alternative

  female-pop-artists:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 3.5 # 3.5+ stars
      - match: any
        rules:
          - field: artist
            operator: contains
            value: "Britney Spears"
          - field: artist
            operator: contains
            value: "Shakira"
          - field: artist
            operator: contains
            value: "Lady Gaga"

  recent-favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.5 # 4.5+ stars
      - field: date_added
        operator: within
        value: 30d # Added within last 30 days
```

**CLI Usage:**

```bash
# Copy tracks matching the high-quality-rock filter
rfmedia copy --filter high-quality-rock /source /dest

# List available filters
rfmedia copy --filter list /source /dest

# Show filter definition
rfmedia copy --filter show:high-quality-rock /source /dest

# Combine with other options
rfmedia copy --filter recent-favorites /source /dest --range=001-005 --convert=mp3
```

**Operator Reference:**

| Operator   | Description                        | Compatible Fields                |
| ---------- | ---------------------------------- | -------------------------------- |
| `>=`       | Greater than or equal              | rating, year, bpm                |
| `<=`       | Less than or equal                 | rating, year, bpm                |
| `==`       | Exact match                        | rating, year, bpm, genre, artist |
| `contains` | Substring match (case-insensitive) | genre, artist                    |
| `within`   | Within time period                 | date_added                       |

**Field Reference:**

| Field        | Type     | Description                         | Example Values                                      |
| ------------ | -------- | ----------------------------------- | --------------------------------------------------- |
| `rating`     | number   | Star rating 1.0-5.0                 | `4.0` (4 stars), `3.0` (3 stars), `4.5` (4.5 stars) |
| `genre`      | string   | Audio genre tag (array in metadata) | `"Rock"`, `"Pop"`, `"Electronic"`                   |
| `artist`     | string   | Artist name                         | `"Artist Name"`                                     |
| `year`       | number   | Release year                        | `2024`, `1990`                                      |
| `bpm`        | number   | Beats per minute                    | `120`, `140.5`                                      |
| `date_added` | duration | Time since file was added           | `30d`, `7d`, `90d`                                  |

**YAML Syntax Notes:**

- Use **2 spaces** for indentation (not tabs)
- Operators with special characters must be quoted: `">="`, `"<="`, `"=="`
- String values with spaces should be quoted: `"Britney Spears"`
- The `match` field accepts `all` (AND) or `any` (OR)
- Rules can be field conditions or nested groups (recursive nesting supported)

**Rating Values:**

Enter star ratings directly using the 1.0-5.0 scale (supports half-stars):

| Stars     | Value |
| --------- | ----- |
| 5 stars   | 5.0   |
| 4.5 stars | 4.5   |
| 4 stars   | 4.0   |
| 3.5 stars | 3.5   |
| 3 stars   | 3.0   |
| 2.5 stars | 2.5   |
| 2 stars   | 2.0   |
| 1.5 stars | 1.5   |
| 1 star    | 1.0   |

**Note:** The internal metadata may store ratings as normalized values (0.0-1.0), but the filter configuration accepts the familiar star scale (1.0-5.0) for convenience.

**Performance:**

Smart filters maintain the single-pass optimization of the existing filter system:

- Metadata is read once per file during the scan phase
- Filter evaluation uses efficient recursive algorithm
- Nested groups add negligible overhead (less than 1% for typical filters)
- Large libraries (100k+ files) process efficiently

**Troubleshooting:**

| Issue                    | Cause                          | Solution                                      |
| ------------------------ | ------------------------------ | --------------------------------------------- |
| Filter not found         | Filter name not in config      | Check spelling and config file location       |
| YAML syntax error        | Invalid indentation or quoting | Use 2-space indentation, quote operators      |
| No matches               | Filter too restrictive         | Test with `--dry-run` to see what would match |
| Missing metadata         | Audio file lacks required tags | Some fields may be null; use `==` carefully   |
| Wrong date_added results | date_added based on file mtime | Ensure file modification times are accurate   |

**Example Filter Files:**

See the `examples/` directory for complete filter examples:

- `examples/filters-basic.yaml` - Simple rating and genre filters
- `examples/filters-advanced.yaml` - Complex nested boolean conditions

#### Adding Filters to Your Configuration

YAML is now the default and recommended format for all configurations. It is more readable for nested boolean logic and supports comments.

**Option A: Use Default YAML Format (Recommended)**

If you are starting fresh, run `rfmedia init` to create a `.rfmedia.yaml` file with example filters.

```yaml
# .rfmedia.yaml
filters:
  high-rated:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0

  rock-favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 3.5
      - match: any # Nested group
        rules:
          - field: genre
            operator: contains
            value: Rock
          - field: genre
            operator: contains
            value: Metal
```

**Option B: Add Filters to Legacy JSON File**

If you have an existing `.rfmedia.json` and don't want to convert yet, you can add a `filters` section directly to it:

```yaml
# .rfmedia.yaml - YAML takes priority over JSON in the same directory
copy:
  outputFolder: liked-songs
  workers: 4

plex:
  url: http://localhost:32400
  token: YOUR_TOKEN

filters:
  high-rated:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0

  rock-favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 3.5
      - match: any # Nested group - no "type" needed in YAML
        rules:
          - field: genre
            operator: contains
            value: Rock
          - field: genre
            operator: contains
            value: Metal
```

**Pros:**

- Cleaner syntax for nested structures
- Comments supported
- Implicit type inference (no `"type": "rule"` needed for leaf rules)
- Takes priority over `.rfmedia.json` in the same location

**Cons:**

- Requires converting existing JSON config
- Whitespace-sensitive (use 2-space indentation)

**Option C: Use Multiple Config Locations (For Shared vs Project-Specific Filters)**

The configuration system searches multiple locations in priority order. YAML files take precedence over JSON files in each location:

| Priority    | Location                        | Use Case                               |
| ----------- | ------------------------------- | -------------------------------------- |
| 1 (Highest) | `./.rfmedia.yaml`               | Project-specific YAML config (default) |
| 2           | `./.rfmedia.yml`                | Alternative YAML extension             |
| 3           | `./.rfmedia.json`               | Project-specific JSON config (legacy)  |
| 4           | `~/.config/rfmedia/config.yaml` | User-wide YAML config                  |
| 5           | `~/.config/rfmedia/config.yml`  | Alternative YAML extension             |
| 6           | `~/.config/rfmedia/config.json` | User-wide JSON config                  |
| 7           | `~/.rfmedia/config.yaml`        | User-wide config (app directory)       |
| 8           | `~/.rfmedia/config.yml`         | Alternative YAML extension             |
| 9           | `~/.rfmedia/config.json`        | User-wide JSON config                  |
| 10          | `~/.rfmedia.yaml`               | Legacy home YAML dotfile               |
| 11          | `~/.rfmedia.yml`                | Alternative YAML extension             |
| 12 (Lowest) | `~/.rfmedia.json`               | Legacy home JSON dotfile               |

**Example Setup:**

Global config with shared filters (`~/.config/rfmedia/config.yaml`):

```yaml
# Shared settings and common filters
plex:
  url: http://192.168.1.100:32400
  token: YOUR_TOKEN

filters:
  all-favorites:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
```

Project-specific config (`./.rfmedia.yaml`):

```yaml
# Project-specific settings - takes priority over global
copy:
  outputFolder: project-favorites
  workers: 8

filters:
  project-filter:
    match: all
    rules:
      - field: year
        operator: ">="
        value: 2020
```

**Important:** The system uses the **first valid config file found**. It does NOT merge configs from multiple locations. If you need project-specific overrides, include all required settings in the project config.

**JSON vs YAML Filter Syntax Comparison:**

| Feature             | JSON                        | YAML                                       |
| ------------------- | --------------------------- | ------------------------------------------ |
| Rule discriminator  | Required: `"type": "rule"`  | Optional (inferred from `field` presence)  |
| Group discriminator | Required: `"type": "group"` | Optional (inferred from `match` + `rules`) |
| Comments            | Not supported               | Supported with `#`                         |
| Operator quoting    | Required: `">="`            | Required: `">="`                           |
| String values       | Required: `"Rock"`          | Optional: `Rock` or `"Rock"`               |
| Nesting             | Verbose with brackets       | Clean with indentation                     |

**Migration Tips:**

1. **Validate before switching:** Use `--dry-run` with a test filter to verify syntax
2. **Keep backup:** Rename `.rfmedia.json` to `.rfmedia.json.bak` before creating `.rfmedia.yaml`
3. **Watch priority:** YAML takes precedence, so your JSON file will be ignored if YAML exists
4. **Check file location:** Run `rfmedia copy --debug ...` to see which config file is loaded

**Quick Reference - Minimal Filter Addition to JSON:**

```json
{
  "existing": "config",
  "filters": {
    "my-filter": {
      "match": "all",
      "rules": [{ "type": "rule", "field": "rating", "operator": ">=", "value": 4.0 }]
    }
  }
}
```

**Quick Reference - Minimal Filter Addition to YAML:**

```yaml
existing: config

filters:
  my-filter:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
```

#### Plan / Apply

Generate a reviewable plan manifest from a dry-run preview, inspect it, then execute exactly the options that were reviewed. Works in both album mode (`--range`/`--count`) and filter mode (`--min-stars`/`--min-rating`). `--plan` cannot be combined with the filter-mode `--album-mode` flag or with `--interactive` — plans freeze a fixed set of operations, and both of those paths require decisions at execution time.

**Options:**

| Option                 | Description                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `--plan`               | Write a plan manifest from the dry-run preview; nothing is copied                        |
| `--plan-output <path>` | Custom output path for the plan manifest (default: managed plans directory)              |
| `--apply <planPath>`   | Execute a previously saved plan manifest                                                 |
| `--dry-run`            | With `--apply`: check mode — validate the plan and run staleness checks, execute nothing |
| `-y, --yes`            | Skip the apply confirmation prompt (required for non-interactive apply)                  |
| `--force-stale`        | Apply despite overridable staleness errors (never overrides corruption)                  |

**Workflow:**

```bash
# 1. Generate a plan (runs the normal dry-run preview and saves a manifest)
rfmedia copy "/music/Artist" /dest --min-stars=4 --plan

# Custom output location instead of the managed plans directory
rfmedia copy "/music/Artist" /dest --range=001-005 --plan --plan-output=./album.plan.json

# 2. Check a plan without executing (exit 0 = valid and fresh, exit 1 = stale or invalid)
rfmedia copy --apply ~/.config/rfmedia/plans/plan-20260719T120000-abcd1234.json --dry-run

# 3. Apply the plan (prompts for confirmation on a TTY; use --yes for scripts)
rfmedia copy --apply ~/.config/rfmedia/plans/plan-20260719T120000-abcd1234.json --yes

# Apply after reviewing and accepting world-drift errors
rfmedia copy --apply ./album.plan.json --yes --force-stale
```

Managed plans are written to `~/.config/rfmedia/plans/` (newest 50 kept; explicit `--plan-output` paths are never pruned). Set the `RFMEDIA_PLAN_DIR` environment variable to relocate the plans directory (also moves the audit ledger).

**Staleness checks at apply time:**

Every apply re-checks the world against the fingerprints captured at plan time. Errors block the apply unless `--force-stale` is passed; warnings are printed and the apply proceeds.

| Finding             | Severity | Meaning                                                                                | `--force-stale` |
| ------------------- | -------- | -------------------------------------------------------------------------------------- | --------------- |
| `source-missing`    | error    | A fingerprinted source directory no longer exists                                      | overrides       |
| `source-drift`      | error    | Source file count, total bytes, or newest mtime changed since planning                 | overrides       |
| `entry-drift`       | error    | A reviewed track changed size/mtime or went missing (filter plans)                     | overrides       |
| `plan-age`          | warning  | Plan is older than 24 hours                                                            | n/a             |
| `host-mismatch`     | warning  | Plan was created on a different host                                                   | n/a             |
| `cli-version`       | warning  | Plan was created by a different rfmedia version                                        | n/a             |
| `dest-drift`        | warning  | Destination state no longer matches the reviewed operations                            | n/a             |
| `filter-resolution` | warning  | Frozen sources reference named filters that resolve from the current config            | n/a             |
| `review-truncated`  | warning  | Review entries were capped at plan time; per-entry checks degrade to source-dir checks | n/a             |

Hard failures — checksum mismatch, malformed/oversized/symlinked plan files, schema validation errors, unsupported plan versions — are never overridable. Regenerate the plan.

**The review section is advisory.** A plan's `review` entries are a snapshot of the dry-run preview at plan time. Apply replays the frozen options, not the entry list: per-file create/skip/overwrite decisions are recomputed against the current filesystem. The staleness checks above exist to flag drift before execution, not to guarantee byte-identical replay.

**Conflict strategy freezing:** `--conflict-strategy` is frozen into a plan only when it was explicitly passed at plan time. When unset, apply replays queue semantics — conflicts degrade to skip. A plan frozen with `ask` prompts per conflict on a TTY and refuses to run non-interactively; regenerate with an explicit strategy (e.g., `skip` or `overwrite`) for scripted applies.

**Audit ledger:** apply outcomes are appended to `~/.config/rfmedia/plans/audit.jsonl` with plan id, checksum, host, status, override codes, and result counts. Recorded: stale aborts, user declines at the confirmation prompt, and every execution outcome (completed, partial, failed — including a crash mid-execution). Not recorded: corrupt-artifact failures (checksum/validation errors exit before the ledger), pre-flight gating failures (non-interactive apply without `--yes`, a frozen `ask` conflict strategy, missing ffmpeg), and check mode (`--dry-run`), which never writes.

```bash
# All apply records for one plan
jq -r 'select(.planId=="<plan-id>")' ~/.config/rfmedia/plans/audit.jsonl

# Compact apply history: when, status, files created
jq -r '[.appliedAt,.status,.counts.created]|@tsv' ~/.config/rfmedia/plans/audit.jsonl
```

**`--dry-run` placement fix:** `--dry-run` is now declared directly on the copy command, so `rfmedia copy <source> <dest> --range=001-005 --dry-run` works with the flag after the subcommand. Previously the flag was documented for copy but never registered on it, so it failed with `unknown option` in every position. There is still no global pre-subcommand `--dry-run`: `rfmedia --dry-run copy ...` is rejected — always place the flag after the subcommand.

### `rfmedia filter`

Manage smart filter definitions for rating-based file filtering. This command provides subcommands for listing, inspecting, and creating filter definitions stored in your configuration file.

#### Subcommands

| Subcommand | Description                                                 |
| ---------- | ----------------------------------------------------------- |
| `list`     | List all defined smart filters with names and rule counts   |
| `show`     | Display detailed filter definition in a formatted tree view |
| `create`   | Interactive filter creation wizard                          |

#### `filter list`

Lists all smart filters defined in your configuration file.

```bash
rfmedia filter list
```

**Output:**

```
Smart Filters:
────────────────────────────────────────────────────────────
Filter Name                        Match     Rules
────────────────────────────────────────────────────────────
high-quality-rock                    AND         3
ambient-chill                         OR         2
recent-favorites                     AND         4
────────────────────────────────────────────────────────────
Total: 3 filter(s)
```

#### `filter show`

Displays the complete definition of a specific filter in a formatted tree view.

```bash
rfmedia filter show <name>
```

**Arguments:**

| Argument | Description                   |
| -------- | ----------------------------- |
| `name`   | Name of the filter to display |

**Example:**

```bash
rfmedia filter show high-quality-rock
```

**Output:**

```
Filter: high-quality-rock
────────────────────────────────────────────────────────────
AND
  ├─ rating >= 4.0
  ├─ genre contains "Rock"
  └─ OR
       ├─ artist contains "Led Zeppelin"
       └─ artist contains "Pink Floyd"
────────────────────────────────────────────────────────────
```

#### `filter create`

Interactively create a new smart filter through a guided wizard. The wizard prompts for filter name, match logic (AND/OR), and individual rules.

```bash
rfmedia filter create [options]
```

**Options:**

| Option                | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `-n, --name <name>`   | Filter name (will prompt if not provided)                                              |
| `-c, --config <path>` | Path to config file to save filter (default: searches for .rfmedia.json/.rfmedia.yaml) |

**Interactive Mode:**

When run without options, the wizard guides you through:

1. **Filter name** - Enter a unique name for your filter
2. **Match logic** - Choose `all` (AND) or `any` (OR) for top-level matching
3. **Add rules** - Define conditions using:
   - Field: `rating`, `genre`, `artist`, `year`, `bpm`, `date_added`
   - Operator: `>=`, `<=`, `==`, `contains`, `within`
   - Value: Appropriate value for the field type
4. **Nested groups** - Optionally add nested boolean groups
5. **Save** - Filter is saved to your config file

**Examples:**

```bash
# List all available filters
rfmedia filter list

# Show specific filter definition
rfmedia filter show high-quality-rock

# Create new filter interactively (prompts for name)
rfmedia filter create

# Create filter with pre-specified name
rfmedia filter create -n my-filter

# Create filter and save to specific config file
rfmedia filter create -n my-filter -c ./custom-config.yaml

# JSON output for scripting
rfmedia filter list --json
rfmedia filter show high-quality-rock --json
```

#### Filter Definition Format

Filters are stored in the config file under the `filters` key:

**JSON format (`.rfmedia.json`):**

```json
{
  "filters": {
    "high-quality-rock": {
      "match": "all",
      "rules": [
        { "field": "rating", "operator": ">=", "value": 4.0 },
        { "field": "genre", "operator": "contains", "value": "Rock" }
      ]
    }
  }
}
```

**YAML format (`.rfmedia.yaml`):**

```yaml
filters:
  high-quality-rock:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
      - field: genre
        operator: contains
        value: Rock
```

#### Notes

- Filters are stored in the config file under the `filters` key
- The `create` command requires an interactive terminal (TTY)
- Use `--filter <name>` with the `copy` command to apply defined filters
- Nested boolean groups allow complex logic like "(rating >= 4) AND (genre contains Rock OR genre contains Blues)"
- The `show` command displays nested groups with indentation for clarity

### `rfmedia delete`

Delete previously copied albums or filtered tracks from the destination. This mirrors `copy` modes and supports album-mode deletes (numbered album folders) and filter-mode deletes (liked-songs or album-mode filtered copies).

```bash
rfmedia delete <source> <destination> --range=<START-END> [options]
rfmedia delete <source> <destination> --min-stars=<N> [options]
rfmedia delete --paths=<yaml-file> [options]
```

**Options:**

| Option                    | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| `-r, --range <START-END>` | Range of suffixes to delete (e.g., `008-010`)                            |
| `--count <N>`             | Number of copies to delete (highest suffixes first)                      |
| `--album-only`            | Treat source as single album (not artist folder)                         |
| `--file <path>`           | Read source paths from file                                              |
| `--paths <path>`          | Read destination, sources, and options from YAML file                    |
| `--min-stars <N>`         | Delete filter-mode copies created with this star rating                  |
| `--min-rating <N>`        | Delete filter-mode copies created with this rating                       |
| `--output-folder <name>`  | Output folder name used for filtered tracks (default: `liked-songs`)     |
| `--album-mode`            | Match album-mode filtered copies (Album-001, Album-002)                  |
| `--trash`                 | Move to trash instead of permanent delete                                |
| `--keep-tracking`         | Keep tracking entries (prevents re-copy to same paths)                   |
| `--filter <name>`         | Match copies created with named smart filter                             |
| `--source-idx <indices>`  | Select sources by index (1-based, requires `--paths`)                    |
| `--source-name <names>`   | Unified search: matches groups, artist, or basename (requires `--paths`) |
| `--artist <names>`        | Select sources by artist (case-insensitive, requires `--paths`)          |
| `--group <names>`         | Select sources by group (case-insensitive, requires `--paths`)           |
| `-i, --interactive`       | Interactively select which copies to delete (requires TTY)               |
| `-y, --yes`               | Skip confirmation prompt                                                 |

**Examples:**

```bash
# Delete a specific suffix range
rfmedia delete "/music/Artist" /dest --range=008-010

# Delete the 3 highest suffixes
rfmedia delete "/music/Artist" /dest --count=3

# Delete filtered copies created with a rating threshold
rfmedia delete "/music/Artist" /dest --min-stars=4

# Interactive delete from YAML sources
rfmedia delete --paths=sources.yml --source-name "divas" --interactive
```

**Interactive Mode Notes:**

- Requires a TTY terminal (won't work in CI or piped input)
- Cannot be combined with `--json` output
- Shows existing suffixed copies in the destination for selection
- Selection overrides `--range` and `--count`

### `rfmedia sync`

Incrementally sync previously copied sources, detecting new files and rating changes. Database mode
uses SQLite inventory rows whose content-hash shape was introduced in schema version 9; legacy mode
uses JSONL inventory files. Only changed files are synchronized.

The sync command operates in the same two modes as copy:

- **Album Mode**: Syncs entire albums with numbered suffixes (--range)
- **Filter Mode**: Syncs tracks meeting a rating threshold (--min-stars/--min-rating)

```bash
rfmedia sync <destination> --file=<path> --min-rating=<N> [options]
rfmedia sync <destination> --file=<path> --range=<START-END> [options]
rfmedia sync --paths=<yaml-file> [options]
```

**Options:**

| Option                    | Description                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `--file <path>`           | File containing source paths to sync (mutually exclusive with `--paths`)                 |
| `--paths <path>`          | Read destination, sources, and options from YAML file (mutually exclusive with `--file`) |
| `--source-idx <indices>`  | Select sources by index (1-based, e.g., `"1,3"` or `"2-5"`) - requires `--paths`         |
| `--source-name <names>`   | Unified search: matches groups, artist, or basename - requires `--paths`                 |
| `--artist <names>`        | Select sources by artist (case-insensitive) - requires `--paths`                         |
| `--group <names>`         | Select sources by group (case-insensitive) - requires `--paths`                          |
| `-r, --range <START-END>` | Range of suffixes for album mode (e.g., `001-010`)                                       |
| `--min-stars <1.0-5.0>`   | Minimum star rating (1.0-5.0, supports half-stars like 3.5)                              |
| `--min-rating <0-100>`    | Minimum rating on 0-100 scale for filter mode                                            |
| `--output-folder <name>`  | Folder name for filtered tracks (default: `liked-songs`)                                 |
| `--preserve-structure`    | Keep album subfolders in output                                                          |
| `--album-mode`            | Preserve album folders with only liked tracks                                            |
| `--reset-inventory`       | Clear inventory and rescan all sources                                                   |
| `--delete-downgraded`     | Delete files when rating falls below threshold (default)                                 |
| `--no-delete-downgraded`  | Skip deletion of downgraded files                                                        |
| `--force`                 | Force re-copy even if file appears unchanged                                             |
| `--hardlink`              | Use hardlinks instead of file copies                                                     |
| `-c, --convert <format>`  | Convert audio to format: `alac`, `mp3`, `aac`, `opus`                                    |
| `-w, --workers <N>`       | Number of parallel workers                                                               |
| `--progress`              | Show visual progress bar                                                                 |
| `--plex-scan`             | Trigger Plex library scan after sync                                                     |

**Examples:**

```bash
# Initial copy creates inventory automatically
rfmedia copy --file=paths.txt /dest --min-rating=50

# Sync: detect and copy only new/updated files
rfmedia sync /dest --file=paths.txt --min-rating=50

# Preview what would be synced
rfmedia sync /dest --file=paths.txt --min-rating=50 --dry-run

# Force resync everything (reset inventory)
rfmedia sync /dest --file=paths.txt --min-rating=50 --reset-inventory

# Album mode sync
rfmedia sync /dest --file=paths.txt --range=001-005

# With Plex scan after sync
rfmedia sync /dest --file=paths.txt --min-rating=50 --plex-scan

# Using YAML-based paths (destination comes from YAML)
rfmedia sync --paths paths.yml

# Select specific sources from YAML
rfmedia sync --paths paths.yml --source-idx 1-5
rfmedia sync --paths paths.yml --group pop-divas
rfmedia sync --paths paths.yml --artist britney

# YAML with auto-detected filter mode
rfmedia sync --paths paths.yml --dry-run
```

**How Sync Works:**

1. **Inventory Tracking**: Database mode creates or reuses inventory rows for the existing operation.
   Legacy mode creates or reuses `.inventory.{hash}.jsonl` next to the input file. Inventory tracks:
   - File paths, modification times, and sizes
   - Rating at time of copy
   - Destination paths
   - A lowercase SHA-256 fingerprint of successful final destination bytes when available

2. **Change Detection**:
   - **New Files**: Files not in inventory that meet the rating threshold
   - **Rating Upgrades**: Files whose ratings increased above the threshold since last copy
   - **Rating Downgrades**: Files whose ratings dropped below the threshold (deleted from destination)
   - **Missing Destinations**: Previously copied files whose destinations were deleted

3. **Incremental Updates**: Only files that need syncing are processed, making repeated operations fast.

4. **Downgrade Deletion**: By default, sync deletes destination files when their source rating falls below the threshold. This keeps your filtered collection in sync with your ratings. Use `--no-delete-downgraded` to disable this behavior.

For ranged output, sync preserves its existing one-row-per-source-file inventory model. The row
represents one destination; content fingerprinting does not create an artifact row for every suffix.

**Output Example:**

```
Scanning 5 sources for changes...

/music/Artist1
  New files: 3
  Rating changes: 1
  Unchanged: 45
  Rating downgrades (to delete): 2

=== Sync Summary ===
Sources scanned: 5
New files copied: 8
Updated files copied: 2
Downgraded files deleted: 2
Unchanged files: 156
```

### `rfmedia clean`

Delete empty album folders and cascade to empty artist folders.

```bash
rfmedia clean <directory> [options]
```

**Options:**

| Option                 | Description                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `--force`              | Skip confirmation prompt                                                                            |
| `--min-files <N>`      | Delete albums with fewer than N audio files                                                         |
| `--older-than <days>`  | Only delete albums not modified in the past N days                                                  |
| `--depth <number>`     | Maximum directory depth to scan. Default: 2 (Artist/Album). Use 0 for unlimited recursive scanning. |
| `--exclude <patterns>` | Glob patterns to exclude from deletion (comma-separated)                                            |
| `--protect <file>`     | File containing glob patterns to never delete                                                       |
| `--trash`              | Move to trash instead of permanent delete                                                           |

**Pattern Matching:**

The `--exclude` and `--protect` options support glob patterns:

- `*` - Match any characters except `/`
- `**` - Match any characters including `/`
- `?` - Match single character
- `[abc]` - Match character class

Patterns are matched against:

1. Relative path from music directory (e.g., `Artist Name/Album Name`)
2. Album name only (e.g., `Album Name`)

**Protection File Format:**

```
# Comments start with #
**/Holiday*
**/*Christmas*
Various Artists/**
**/*- Deluxe Edition
```

**Examples:**

```bash
# Clean empty folders with confirmation
rfmedia clean /music

# Skip confirmation prompt
rfmedia clean /music --force

# Preview what would be deleted
rfmedia clean /music --dry-run

# Delete albums with fewer than 3 audio files
rfmedia clean /music --min-files=3

# Exclude specific patterns (glob supported)
rfmedia clean /music --exclude="*Holiday*,*Greatest*"

# Protect albums using patterns from a file
rfmedia clean /music --protect=/path/to/protect.txt

# Combine exclude and protect options
rfmedia clean /music --exclude="Various*" --protect=/path/to/protect.txt

# Move to trash instead of permanent delete
rfmedia clean /music --trash

# Protect albums modified in the last 30 days
rfmedia clean /music --older-than=30

# Scan 3 levels deep (Genre/Artist/Album)
rfmedia clean /music --depth 3 --dry-run

# Scan unlimited depth
rfmedia clean /music --depth 0

# Default behavior (2 levels, Artist/Album)
rfmedia clean /music
```

### `rfmedia watch`

Monitor directories for new files and automatically copy them based on mode settings. This is useful for continuously processing new music as it arrives.

```bash
rfmedia watch <source> <destination> --mode=<album|filter> [options]
```

**Options:**

| Option                    | Description                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `-m, --mode <mode>`       | **Required.** Watch mode: `album` or `filter`               |
| `-r, --range <START-END>` | Range of suffixes (album mode) or track names (filter mode) |
| `--album-only`            | Treat source as single album (not artist folder)            |
| `--min-stars <1.0-5.0>`   | Minimum star rating (1.0-5.0, supports half-stars like 3.5) |
| `--min-rating <0-100>`    | Minimum rating on 0-100 scale for filter mode               |
| `--output-folder <name>`  | Folder name for filtered tracks (default: `liked-songs`)    |
| `--preserve-structure`    | Keep album subfolders in output (filter mode)               |
| `--hardlink`              | Use hardlinks instead of file copies                        |
| `--debounce <ms>`         | Debounce delay in milliseconds (default: 5000)              |

**Examples:**

```bash
# Watch for new albums and create numbered copies
rfmedia watch "/music/incoming" /dest --mode=album --range=001-010

# Watch and filter by rating
rfmedia watch "/music/incoming" /dest --mode=filter --min-stars=4

# Watch for tracks rated 3.5+ stars (supports half-stars)
rfmedia watch "/music/incoming" /dest --mode=filter --min-stars=3.5

# Custom debounce delay (wait 10 seconds before processing)
rfmedia watch "/music/incoming" /dest --mode=album --range=001-005 --debounce=10000

# Watch with hardlinks to save space
rfmedia watch "/music/incoming" /dest --mode=filter --min-stars=3 --hardlink
```

**Behavior:**

- Uses chokidar to monitor the source directory for file changes
- Debounces file events to avoid processing incomplete uploads
- Gracefully shuts down on SIGINT (Ctrl+C) or SIGTERM
- Continues running until interrupted

**Notes:**

- The watch command runs continuously until stopped
- Press Ctrl+C to gracefully stop watching
- Files are processed using the same logic as the `copy` command
- The `--mode` option is required and must be either `album` or `filter`

### `rfmedia link-videos`

Create hardlinks from music videos to their matching audio tracks in your music library. This enables Plex Media Server to associate music videos with songs.

```bash
rfmedia link-videos <video-source> <music-library> [options]
```

**Arguments:**

| Argument        | Description                                           |
| --------------- | ----------------------------------------------------- |
| `video-source`  | Directory containing music videos organized by artist |
| `music-library` | Directory containing your music library               |

**Options:**

| Option                     | Description                                                   |
| -------------------------- | ------------------------------------------------------------- |
| `--min-score <N>`          | Minimum similarity score 0-100 (default: 70)                  |
| `--artist <name>`          | Limit to specific artist                                      |
| `--preferred-format <ext>` | Preferred video format when duplicates exist (default: `mkv`) |
| `--reset-inventory`        | Clear inventory and rescan all videos                         |
| `--progress`               | Show visual progress bar                                      |
| `--no-progress`            | Disable progress bar                                          |

**Examples:**

```bash
# Link all videos to matching tracks
rfmedia link-videos /music-videos /music

# Preview matches without creating links
rfmedia link-videos /music-videos /music --dry-run

# Link only for a specific artist
rfmedia link-videos /music-videos /music --artist="Britney Spears"

# Use stricter matching (90% similarity required)
rfmedia link-videos /music-videos /music --min-score=90

# Prefer MP4 format when duplicate videos exist
rfmedia link-videos /music-videos /music --preferred-format=mp4

# Reset inventory and rescan all
rfmedia link-videos /music-videos /music --reset-inventory
```

**Expected Directory Structure:**

Video source (e.g., `/music-videos/`):

```
Artist Name/
├── Song Title (Official HD Video)-video.mkv
├── Another Song (Official Video)-video.mkv
└── Third Song-video.mp4
```

Music library (e.g., `/music/`):

```
Artist Name (uuid)/
└── Album Name/
    ├── Artist Name_Album Name_01_Song Title.flac
    ├── Artist Name_Album Name_02_Another Song.flac
    └── Artist Name_Album Name_03_Third Song.flac
```

**How It Works:**

1. **Scans videos**: Finds all video files in the source, extracts song titles by stripping common suffixes like "(Official HD Video)-video"
2. **Scans tracks**: Finds all audio tracks in the library, extracts song titles from the structured filename format (`Artist_Album_TrackNum_Title.ext`)
3. **Matches by artist**: Groups videos and tracks by artist, using fuzzy matching to handle UUID suffixes in library folder names
4. **Fuzzy matches songs**: Uses Levenshtein distance to find the best matching track for each video, handling Unicode differences (e.g., `…` vs `...`)
5. **Creates hardlinks**: Links each video file next to its matching audio track with the track's base filename

**Output:**

```
Britney Spears/Toxic (Official HD Video)-video.mkv
  -> Britney Spears_In the Zone_06_Toxic.mkv (100%)
```

**Inventory Tracking:**

The command maintains a JSONL inventory file (`.video-links.{hash}.jsonl`) to track which videos have been processed. This enables incremental operation - running the command multiple times will only process new videos.

**Requirements:**

- Video source and music library must be on the same filesystem (for hardlinks)
- Video files should be organized in artist subdirectories
- Music library should use the `Artist_Album_TrackNum_Title.ext` filename format

**Supported Video Formats:**

`mkv`, `mp4`, `avi`, `webm`, `m4v`, `mov`

**Format Priority (when duplicates exist):**

`mkv` > `mov` > `mp4` > `m4v` > `webm` > `avi`

### `rfmedia completion`

Generate shell completion scripts for bash, zsh, and fish shells. Shell completion enables tab completion for commands, options, and arguments.

```bash
rfmedia completion <shell> [options]
rfmedia completion --shell=<shell> [options]
```

**Arguments:**

| Argument | Description                            |
| -------- | -------------------------------------- |
| `shell`  | Target shell: `bash`, `zsh`, or `fish` |

**Options:**

| Option        | Description                                       |
| ------------- | ------------------------------------------------- |
| `-s, --shell` | Target shell (alternative to positional argument) |
| `--install`   | Install completion script to shell configuration  |
| `--force`     | Overwrite existing installation without prompting |

**Examples:**

```bash
# Print bash completion script to stdout
rfmedia completion bash

# Print zsh completion script to stdout
rfmedia completion zsh

# Print fish completion script to stdout
rfmedia completion fish

# Install bash completion to ~/.bashrc
rfmedia completion bash --install

# Install zsh completion to ~/.zfunc/_rfmedia
rfmedia completion zsh --install

# Install fish completion to ~/.config/fish/completions/rfmedia.fish
rfmedia completion fish --install

# Force reinstall (overwrite existing)
rfmedia completion bash --install --force

# Preview installation without modifying files
rfmedia completion bash --install --dry-run

# Use --shell option instead of positional argument
rfmedia completion --shell=zsh --install
```

**Installation Paths:**

| Shell | Installation Path                         | Config File Updated |
| ----- | ----------------------------------------- | ------------------- |
| bash  | Script appended to `~/.bashrc`            | `~/.bashrc`         |
| zsh   | `~/.zfunc/_rfmedia`                       | `~/.zshrc`          |
| fish  | `~/.config/fish/completions/rfmedia.fish` | None (auto-loaded)  |

**Shell-Specific Instructions:**

**Bash:**

```bash
# Install completion
rfmedia completion bash --install

# Reload your shell configuration
source ~/.bashrc
```

**Zsh:**

```bash
# Install completion (creates ~/.zfunc and updates ~/.zshrc)
rfmedia completion zsh --install

# Reload your shell configuration
source ~/.zshrc
```

The installer automatically adds the following to your `~/.zshrc` if not present:

```bash
fpath=(~/.zfunc $fpath)
autoload -Uz compinit && compinit
```

**Fish:**

```bash
# Install completion
rfmedia completion fish --install

# Completions are loaded automatically in fish
# No need to restart or source any files
```

**Regenerating Completions:**

After updating rfmedia to a new version, regenerate your completion scripts to include any new commands or options:

```bash
# Regenerate and reinstall completions
rfmedia completion bash --install --force
rfmedia completion zsh --install --force
rfmedia completion fish --install --force
```

**Manual Installation:**

If you prefer to manage completions manually, you can pipe the output to a file:

```bash
# Bash: save to a custom location
rfmedia completion bash > /etc/bash_completion.d/rfmedia

# Zsh: save to a custom fpath location
rfmedia completion zsh > /usr/local/share/zsh/site-functions/_rfmedia

# Fish: save to a custom completions directory
rfmedia completion fish > ~/.config/fish/completions/rfmedia.fish
```

### `rfmedia plugin`

Manage installed plugins for extending copy operations with custom processing.

```bash
rfmedia plugin <subcommand> [options]
```

#### Subcommands

| Subcommand | Description                               |
| ---------- | ----------------------------------------- |
| `list`     | List all installed plugins                |
| `info`     | Show detailed information about a plugin  |
| `dir`      | Show configured plugin search directories |

#### `plugin list`

Lists all installed plugins with their versions and registered hooks.

```bash
rfmedia plugin list [options]
```

**Options:**

| Option   | Description                       |
| -------- | --------------------------------- |
| `--json` | Output plugin list in JSON format |

**Example Output:**

```
Installed plugins (2):
  my-plugin v1.0.0 - hooks: afterCopy
  beets-import v1.0.0 - hooks: afterBatch
```

#### `plugin info`

Displays detailed information about a specific plugin including version, description, priority, and registered hooks.

```bash
rfmedia plugin info <name> [options]
```

**Arguments:**

| Argument | Description                   |
| -------- | ----------------------------- |
| `name`   | Name of the plugin to inspect |

**Options:**

| Option   | Description                          |
| -------- | ------------------------------------ |
| `--json` | Output plugin details in JSON format |

**Example:**

```bash
rfmedia plugin info my-plugin
```

**Example Output:**

```
Plugin: my-plugin
Version: 1.0.0
Description: Logs file copy operations
Priority: 50
Hooks: afterCopy
```

#### `plugin dir`

Shows the configured plugin search directories where rfmedia looks for installed plugins.

```bash
rfmedia plugin dir
```

**Example Output:**

```
/home/user/.rfmedia/plugins
/opt/rfmedia/plugins
```

#### Examples

```bash
# List all installed plugins
rfmedia plugin list

# List plugins with JSON output for scripting
rfmedia plugin list --json

# Show details for a specific plugin
rfmedia plugin info my-plugin

# Get plugin info as JSON
rfmedia plugin info beets-import --json

# Show where plugins are searched for
rfmedia plugin dir
```

For detailed documentation on creating plugins, configuring external command wrappers, and available hooks, see [Plugin System Documentation](./docs/features/plugins.md).

### `rfmedia undo`

Undo recent copy and clean operations by reversing the recorded filesystem changes.

```bash
rfmedia undo [options]
```

**Options:**

| Option               | Description                                    |
| -------------------- | ---------------------------------------------- |
| `-l, --last <N>`     | Number of recent sessions to undo (default: 1) |
| `-s, --session <id>` | Undo specific session by ID                    |
| `--list`             | List undoable sessions without undoing         |
| `-f, --force`        | Skip confirmation prompt                       |

**Examples:**

```bash
# List recent undoable sessions
rfmedia undo --list

# Undo the most recent operation
rfmedia undo

# Undo the last 3 operations
rfmedia undo --last=3

# Undo a specific session by ID
rfmedia undo --session=2026-01-16T15-30-45Z-copy-12345

# Preview what would be undone
rfmedia undo --dry-run

# Skip confirmation prompt
rfmedia undo --force
```

**How It Works:**

1. **Operation Logging**: Every copy and clean operation is logged to the SQLite database (`~/.rfmedia/tracking.db`)
2. **Session Tracking**: Each command execution creates a session in the `history_sessions` table with all filesystem operations recorded in `history_operations`
3. **Reverse Operations**: Undo reverses operations in LIFO (Last In, First Out) order:
   - Copy/hardlink/convert -> Removes the destination file
   - Mkdir -> Removes the directory if empty and was created by the operation
   - Remove/trash -> Cannot be restored (warning displayed)

**Storage Modes:**

The undo/history system supports two storage backends:

| Mode                   | Storage                      | Description                                                             |
| ---------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| **Database** (default) | `~/.rfmedia/tracking.db`     | SQLite database with `history_sessions` and `history_operations` tables |
| **Legacy**             | `~/.rfmedia/history/*.jsonl` | JSONL files (for backward compatibility)                                |

**Session List Output:**

```
Undoable Sessions:
  2026-01-16T15:30:45Z  copy     378 operations  pending
  2026-01-16T14:22:10Z  clean     12 operations  pending
  2026-01-16T13:15:00Z  copy     156 operations  undone
```

**Configuration:**

Undo behavior can be configured in your config file:

```json
{
  "undo": {
    "enabled": true,
    "retentionDays": 30,
    "maxSizeMB": 100,
    "useLegacy": false,
    "database": null
  }
}
```

| Option          | Type    | Default | Description                                              |
| --------------- | ------- | ------- | -------------------------------------------------------- |
| `enabled`       | boolean | `true`  | Enable operation history logging                         |
| `retentionDays` | number  | `30`    | Days to retain history before cleanup                    |
| `maxSizeMB`     | number  | `100`   | Maximum history size in MB                               |
| `useLegacy`     | boolean | `false` | Use legacy JSONL files instead of SQLite database        |
| `database`      | string  | -       | Custom database path (default: `~/.rfmedia/tracking.db`) |

**Database Schema:**

History is stored in two tables:

**`history_sessions`** - Session metadata:

| Column            | Type    | Description                                               |
| ----------------- | ------- | --------------------------------------------------------- |
| `id`              | INTEGER | Primary key                                               |
| `session_id`      | TEXT    | Unique session identifier (`{timestamp}-{command}-{pid}`) |
| `version`         | TEXT    | Format version                                            |
| `command`         | TEXT    | Command type (`copy`, `clean`, etc.)                      |
| `started_at`      | TEXT    | ISO timestamp                                             |
| `ended_at`        | TEXT    | ISO timestamp (nullable)                                  |
| `status`          | TEXT    | `pending`, `undone`, `partial`                            |
| `cwd`             | TEXT    | Working directory                                         |
| `operation_count` | INTEGER | Total operations                                          |

**`history_operations`** - Individual filesystem operations:

| Column           | Type    | Description                                               |
| ---------------- | ------- | --------------------------------------------------------- |
| `id`             | INTEGER | Primary key                                               |
| `session_id`     | INTEGER | FK to `history_sessions.id`                               |
| `operation_type` | TEXT    | `copy`, `hardlink`, `convert`, `mkdir`, `remove`, `trash` |
| `occurred_at`    | TEXT    | ISO timestamp                                             |
| `source_path`    | TEXT    | Source file (nullable for mkdir/remove/trash)             |
| `dest_path`      | TEXT    | Destination file/directory                                |
| `created_dir`    | INTEGER | Boolean: 1 if mkdir created directory                     |
| `convert_format` | TEXT    | Target format for convert operations                      |

**Querying History Directly:**

```bash
# List recent sessions
sqlite3 ~/.rfmedia/tracking.db "SELECT session_id, command, status, operation_count FROM history_sessions ORDER BY started_at DESC LIMIT 10;"

# View operations for a specific session
sqlite3 ~/.rfmedia/tracking.db "SELECT operation_type, dest_path FROM history_operations WHERE session_id = 1;"

# Count operations by type
sqlite3 ~/.rfmedia/tracking.db "SELECT operation_type, COUNT(*) FROM history_operations GROUP BY operation_type;"
```

## Operation Tracking

rfmedia tracks copy and sync operations to enable resumable processing. If an operation is interrupted, you can resume from where it left off instead of starting over.

### Tracking Modes

The tracking system supports two modes:

| Mode                   | Storage                            | Description                                                 |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------- |
| **Database** (default) | `~/.rfmedia/tracking.db`           | SQLite database for efficient queries and atomic operations |
| **Legacy**             | `.completed.*` / `.failed.*` files | File-based tracking (for backward compatibility)            |

### Tracking is Enabled by Default

Tracking is automatically enabled for all copy and sync operations, regardless of input method:

```bash
# Tracking works with direct source paths
rfmedia copy /music/Artist1 /music/Artist2 /dest --range=001-005

# Tracking works with file-based input
rfmedia copy --file=artists.txt /dest --range=001-005

# Tracking works with filter mode
rfmedia copy /music/Artist /dest --min-stars=4
```

### Inventory Content Fingerprints

The current schema-version-11 database retains the `inventory.content_hash` field introduced in
schema version 9. Database-tracked album copy, filter copy, and sync operations populate that table.
Queue and MCP copy routes inherit this behavior when they delegate to those actions. This does not
extend general copy inventory to Plex query copy, playlist export/sync, repair, `link-videos`, or
untracked watch operations.

Each new successful database inventory row stores `content_hash`, a lowercase SHA-256 fingerprint of
the final destination bytes at write time:

- regular copies finalize the digest from the destination copy pipeline;
- conversions hash the converted destination, not the source encoding;
- hardlinks are hashed after link creation, so the value is a snapshot of the shared inode;
- existing and legacy rows may be `NULL` or omit the portable `contentHash` field, and are not
  automatically backfilled.

The required order is destination write, link, or conversion; hash finalization; inventory
persistence; then suffix/source completion. A copy, hash, or database failure cannot be recorded as a
new successful completion with an unknown hash.

The fingerprint is not immediate destination read-back proof and does not replace
`rfmedia copy --verify`. It is the baseline consumed later by the default and deep tiers of
`rfmedia verify`. Dry-run performs no destination write, hash read, schema migration, inventory
write, or completion write. Disabling completed tracking or selecting legacy tracking does not
initialize a hidden SQLite lifecycle solely for fingerprints.

### Tracking Identifier Logic

The tracking system uses a unique identifier to associate operations:

| Input Method        | Tracking Identifier                              |
| ------------------- | ------------------------------------------------ |
| `--file=path.txt`   | Input file path (e.g., `/home/user/artists.txt`) |
| Direct source paths | Destination path (e.g., `/dest`)                 |

This means:

- When using `--file`, resuming works if you run the same command with the same input file
- When using direct paths, resuming works if you run commands with the same destination

### Granular Album-Suffix Tracking

In database mode (default), the tracking system supports granular per-album-suffix tracking. This enables **range expansion** - when you expand a range on a subsequent run, only the new suffixes are processed.

**How It Works:**

- Each album-suffix combination (e.g., `Album1-001`, `Album1-002`) is tracked individually
- When you run with an expanded range, already completed suffixes are skipped
- Per-path ranges automatically activate granular tracking

**Range Expansion Example:**

```bash
# First run - creates Album-001 and Album-002
rfmedia copy /music/Artist /dest --range=001-002
# Output:
#   Created: Album1-001
#   Created: Album1-002
#   Created: Album2-001
#   Created: Album2-002

# Expand range to 001-020 - only new suffixes are processed
rfmedia copy /music/Artist /dest --range=001-020
# Output:
#   Source has completed suffixes but processing for range expansion: /music/Artist
#   Skipped 2 already tracked suffix(es)
#   Created: Album1-003
#   Created: Album1-004
#   ...
#   Created: Album1-020
```

**Per-Path Ranges:**

When using per-path ranges in input files, granular tracking activates automatically:

```bash
# Input file with per-path ranges
cat albums.txt
/music/Artist1/Album1,001-005
/music/Artist2/Album2,006-010

# First run
rfmedia copy --file=albums.txt /dest
# Album1 gets 001-005, Album2 gets 006-010

# Expand Album1's range - only new suffixes processed
# Update albums.txt:
/music/Artist1/Album1,001-020
/music/Artist2/Album2,006-010

rfmedia copy --file=albums.txt /dest
# Album1 processes 006-020 (skips 001-005)
# Album2 is fully skipped (006-010 already complete)
```

**Output Indicators:**

When granular tracking is active, you'll see these messages:

| Message                                                            | Meaning                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `Found N previously completed album copies (granular tracking)`    | Loaded tracking state from database                             |
| `Skipping N already tracked suffix(es)`                            | Suffixes that were completed in a previous run                  |
| `Source has completed suffixes but processing for range expansion` | Source was previously completed but has new suffixes to process |
| `Tracking: Database (operation #N)`                                | Using database mode with operation ID                           |

**Note:** Granular tracking is only available in database mode. Legacy file-based tracking uses source-level tracking only.

### Configuration

Configure tracking behavior in `.rfmedia.yaml`:

```json
{
  "tracking": {
    "database": "~/.rfmedia/tracking.db",
    "useLegacy": false
  }
}
```

| Option      | Type    | Default                  | Description                    |
| ----------- | ------- | ------------------------ | ------------------------------ |
| `database`  | string  | `~/.rfmedia/tracking.db` | Custom path to SQLite database |
| `useLegacy` | boolean | `false`                  | Use legacy file-based tracking |

### Resume Capability

When you run the same operation again, completed sources are automatically skipped:

```bash
# First run - processes 100 artists, interrupted at 50
rfmedia copy --file=artists.txt /dest --range=001-005
# Output: Processed 50/100 sources

# Resume - skips completed sources, continues from 51
rfmedia copy --file=artists.txt /dest --range=001-005
# Output: Skipped 50 already completed, processing 50 remaining
```

### Automatic Legacy Migration

When running with database mode (default), existing legacy tracking files are automatically migrated:

1. The system detects `.completed.*` and `.failed.*` files
2. Data is imported into the SQLite database
3. Legacy files are preserved (not deleted)
4. Future operations use the database

This migration happens transparently on first run with no user action required.

### Database Mode Examples

```bash
# Standard copy with database tracking (default)
rfmedia copy /music/Artist /dest --range=001-005

# Specify custom database location
# In .rfmedia.yaml:
# tracking:
#   database: "/custom/tracking.db"

# Reset tracking and start fresh
rfmedia copy --file=artists.txt /dest --range=001-005 --reset-completed

# View tracking status (stored in ~/.rfmedia/tracking.db)
sqlite3 ~/.rfmedia/tracking.db "SELECT * FROM operations ORDER BY created_at DESC LIMIT 5;"

# View granular album copy tracking
sqlite3 ~/.rfmedia/tracking.db "SELECT source_path, album_name, suffix FROM completed_album_copies WHERE operation_id = 1;"
```

### Legacy Mode Examples

To use file-based tracking (for compatibility or preference):

```yaml
tracking:
  useLegacy: true
```

Or in JSON:

```json
{
  "tracking": {
    "useLegacy": true
  }
}
```

```bash
# With legacy mode enabled, creates sidecar files next to input:
# /path/to/artists.txt
# /path/to/.completed.artists.album-001-005.txt
# /path/to/.failed.artists.album-001-005.txt

rfmedia copy --file=/path/to/artists.txt /dest --range=001-005
```

**Note:** Legacy mode does not support granular album-suffix tracking. Range expansion will reprocess entire sources.

### Tracking with Direct Source Paths

When using direct source paths (without `--file`), tracking uses the destination path as identifier:

```bash
# First run - processes Artist1 and Artist2
rfmedia copy /music/Artist1 /music/Artist2 /dest --range=001-005
# Tracking identifier: /dest
# Completed: Artist1, Artist2

# Adding a third artist - Artist1 and Artist2 are skipped
rfmedia copy /music/Artist1 /music/Artist2 /music/Artist3 /dest --range=001-005
# Skipped: Artist1, Artist2 (already completed for this destination)
# Processed: Artist3
```

### Tracking Summary Output

After operations complete, a tracking summary is displayed:

```
=== Overall Summary ===
Sources: 100 total | 95 processed | 5 skipped (completed) | 0 failed
Files: 450 created | 50 skipped | 0 failed
Time: 12m 34s (7.5 sources/min)
Tracking: Database (operation #42)
```

The summary shows:

- **Sources**: How many source directories were processed
- **Files**: How many individual album copies were created/skipped
- **Time**: Elapsed time and processing rate
- **Tracking**: The tracking mode and operation ID (database) or file path (legacy)

## Graceful Interruption

Long-running copy, verify, and sync operations can be safely cancelled using Ctrl+C (or by sending SIGTERM). The CLI handles interruption gracefully to prevent data corruption and preserve progress.

### What Happens on Ctrl+C

When you press Ctrl+C during an operation:

1. **New operations are prevented** - Ongoing file operations complete, but no new files are started
2. **Partial files are cleaned up** - Any incomplete destination files are removed automatically to prevent corrupted data
3. **History session is closed** - The undo/history recorder saves its current state
4. **Database connections are closed** - SQLite connections are properly closed to prevent corruption
5. **Progress is preserved** - Completed sources are tracked, so you can resume where you left off

### Resuming After Interruption

Since operation tracking records progress continuously, you can simply re-run the same command to resume:

```bash
# Original command (interrupted with Ctrl+C)
rfmedia copy --file=artists.txt /dest --range=001-020

# Re-run the same command to resume
rfmedia copy --file=artists.txt /dest --range=001-020
# Output:
#   Skipping 15 already completed source(s)...
#   Processing remaining 35 sources...
```

The same resume behavior works for sync and verify commands.

### Forced Exit

If cleanup is taking too long, pressing Ctrl+C a second time will force an immediate exit. Use this as a last resort, as it may leave partial files behind.

### Supported Commands

Graceful interruption is implemented for all major file operations:

| Command          | Modes            | Notes                                   |
| ---------------- | ---------------- | --------------------------------------- |
| `rfmedia copy`   | Album and Filter | Full support with partial file cleanup  |
| `rfmedia verify` | Album and Filter | Safely stops verification mid-operation |
| `rfmedia sync`   | Album and Filter | Preserves sync state on interruption    |

For detailed architecture documentation, see `docs/features/graceful-interruption.md`.

## Plugin System

The plugin system enables extending copy operations with custom processing, external tool integration, and metadata extraction. Plugins intercept the copy workflow at four hooks for custom file processing.

### Overview

- **Four Hook Points**: `beforeCopy`, `afterCopy`, `processFile`, `afterBatch`
- **Priority Ordering**: Plugins execute in priority order (lower numbers run first)
- **External Command Wrappers**: Integrate external tools like beets or MusicBrainz Picard via YAML configuration without writing code
- **Graceful Error Handling**: Plugin failures are logged but do not stop copy operations by default

### Quick Start

1. Create a plugin directory:

```bash
mkdir -p ~/.rfmedia/plugins/my-plugin
```

2. Create `~/.rfmedia/plugins/my-plugin/index.js`:

```javascript
export default {
  name: "my-plugin",
  version: "1.0.0",
  description: "Logs file copy operations",
  hooks: [
    {
      type: "afterCopy",
      handler: async (context) => {
        console.log(`Copied: ${context.sourcePath} -> ${context.destPath}`);
      },
    },
  ],
};
```

3. Verify the plugin is installed:

```bash
rfmedia plugin list
```

### External Command Plugins

Configure external tools in `.rfmedia.yaml` without writing code:

```yaml
plugins:
  commands:
    - name: beets-import
      command: beet
      args: ["import", "-q", "{destPath}"]
      timeout: 300000
      hooks:
        afterBatch: true
```

### Configuration

```yaml
plugins:
  enabled: true
  directory: ~/.rfmedia/plugins
  additionalDirectories:
    - /opt/rfmedia/plugins
  disabled:
    - problematic-plugin
```

For complete documentation on creating plugins, hook types, context objects, and best practices, see [Plugin System Documentation](./docs/features/plugins.md).

## Troubleshooting

This section covers common issues with the SQLite tracking system and their solutions.

### Database Not Being Populated

**Symptom**: Running copy operations but `~/.rfmedia/tracking.db` has no data in tables.

**Possible Causes and Solutions**:

| Cause                       | Solution                                        |
| --------------------------- | ----------------------------------------------- |
| Tracking disabled in config | Set `"trackCompleted": true` in `.rfmedia.yaml` |
| CLI flag override           | Remove `--no-track-completed` from command      |
| Permission issues           | Ensure write access to `~/.rfmedia/` directory  |
| Wrong database location     | Check `tracking.database` path in config        |

**Check your configuration**:

```json
{
  "copy": {
    "trackCompleted": true
  }
}
```

**Verify database is writable**:

```bash
# Check if directory exists
ls -la ~/.rfmedia/

# Check database file permissions
ls -la ~/.rfmedia/tracking.db

# Test database access
sqlite3 ~/.rfmedia/tracking.db "SELECT COUNT(*) FROM operations;"
```

**Look for error messages in output** - a destination write, fingerprint, or inventory persistence
failure marks the affected file or source as failed and prevents a new completion marker.

### Inventory Table Empty

**Symptom**: The `inventory` table has no records after running copy operations.

**Explanation**: Album copy, filter copy, and sync populate inventory when SQLite tracking is active.
An empty table after one of those operations usually means the run was a dry-run, completed tracking
was disabled, legacy tracking was selected, no file reached successful inventory persistence, or a
different database path was used.

| Table                    | Used By                 | Purpose                                                        |
| ------------------------ | ----------------------- | -------------------------------------------------------------- |
| `operations`             | album/filter copy, sync | Tracks operation metadata and status                           |
| `completed_sources`      | album/filter copy, sync | Records successfully processed source paths                    |
| `failed_sources`         | album/filter copy, sync | Records sources that failed with error messages                |
| `completed_album_copies` | album/filter range copy | Tracks individual album-suffix completions for range expansion |
| `inventory`              | album/filter copy, sync | Tracks source snapshots, represented destinations, and hashes  |

**To inspect inventory fingerprints**:

```bash
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT source_path, relative_path, dest_path, content_hash FROM inventory LIMIT 20;"
```

Historical rows may show `NULL`: schema version 9 deliberately does not read destination files to
backfill hashes for older databases or legacy inventories.

### Range Expansion Not Working

**Symptom**: Running with an expanded range (e.g., 001-020 after 001-002) reprocesses all suffixes instead of only the new ones.

**Possible Causes and Solutions**:

| Cause                  | Solution                                                                   |
| ---------------------- | -------------------------------------------------------------------------- |
| Legacy mode enabled    | Set `tracking.useLegacy: false` (granular tracking requires database mode) |
| Tracking disabled      | Enable tracking with `copy.trackCompleted: true`                           |
| Different operation ID | Check that input file path and options match the original operation        |
| Database empty         | Verify `completed_album_copies` table has records                          |

**Check granular tracking records**:

```bash
# View completed album copies for an operation
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT source_path, album_name, suffix FROM completed_album_copies WHERE operation_id = 1;"

# Check if suffixes were recorded for your source
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT album_name, GROUP_CONCAT(suffix) as suffixes FROM completed_album_copies WHERE source_path = '/music/Artist' GROUP BY album_name;"
```

**Verify you see these messages in output**:

- `Found N previously completed album copies (granular tracking)` - indicates granular tracking loaded
- `Skipping N already tracked suffix(es)` - indicates suffixes being skipped

If you don't see these messages, granular tracking is not active. Check that:

1. Database mode is enabled (not legacy mode)
2. The operation ID matches (same input file and options)
3. The source path matches exactly (paths are case-sensitive)

### Tracking Not Resuming

**Symptom**: Re-running the same operation does not skip completed sources.

**Possible Causes**:

1. **Different options create different operations** - The tracking system uses an options hash that includes mode, range, rating, and convert format. Any change creates a new operation.

2. **Reset flag was used** - The `--reset-completed` flag clears tracking and starts fresh.

3. **No matching operation found** - Verify the database has records for your operation.

**Check for existing records**:

```bash
# View all operations
sqlite3 ~/.rfmedia/tracking.db "SELECT id, command, options_hash, completed_count FROM operations ORDER BY created_at DESC LIMIT 10;"

# View completed sources for a specific operation
sqlite3 ~/.rfmedia/tracking.db "SELECT source_path FROM completed_sources WHERE operation_id = 1;"
```

**Options that affect operation identity**:

| Option                         | Impact                                               |
| ------------------------------ | ---------------------------------------------------- |
| `--range`                      | Different ranges create different operations         |
| `--min-stars` / `--min-rating` | Different thresholds create different operations     |
| `--convert`                    | Different output formats create different operations |
| Input file path                | Different input files create different operations    |

**Example**: These commands track separately:

```bash
# Operation 1: album-001-005
rfmedia copy --file=sources.txt /dest --range=001-005

# Operation 2: album-001-010 (different range)
rfmedia copy --file=sources.txt /dest --range=001-010

# Operation 3: filter-r80 (different mode)
rfmedia copy --file=sources.txt /dest --min-rating=80
```

### Legacy Mode vs Database Mode

**Symptom**: Seeing `.completed.*` and `.failed.*` files instead of database entries.

**Explanation**: Legacy mode is enabled when `tracking.useLegacy` is `true` in your configuration.

**Check your configuration**:

```json
{
  "tracking": {
    "useLegacy": false,
    "database": "~/.rfmedia/tracking.db"
  }
}
```

| Setting              | Behavior                              |
| -------------------- | ------------------------------------- |
| `"useLegacy": false` | Uses SQLite database (default)        |
| `"useLegacy": true`  | Uses sidecar files next to input file |

**To migrate from legacy to database mode**:

1. Set `"useLegacy": false` in your config
2. Run your next operation - legacy files are automatically imported
3. Legacy files are preserved (manual cleanup optional)

### Database Location Issues

**Symptom**: Cannot find tracking database or multiple databases exist.

**Check configured location**:

```json
{
  "tracking": {
    "database": "~/.rfmedia/tracking.db"
  }
}
```

**Find all tracking databases on your system**:

```bash
find ~ -name "tracking.db" 2>/dev/null
```

**Common locations**:

| Path                            | Description                           |
| ------------------------------- | ------------------------------------- |
| `~/.rfmedia/tracking.db`        | Default location                      |
| `~/.config/rfmedia/tracking.db` | Alternative XDG location              |
| Custom path                     | Set via `tracking.database` in config |

**Verify which config file is being used**:

```bash
# Check for config files in order of priority
ls -la .rfmedia.json 2>/dev/null
ls -la ~/.config/rfmedia/config.json 2>/dev/null
ls -la ~/.rfmedia.json 2>/dev/null
```

### Database Corruption or Migration Issues

**Symptom**: Errors when accessing the tracking database.

**Solutions**:

**Reset the database** (loses tracking history):

```bash
rm ~/.rfmedia/tracking.db
# Next operation will create a fresh database
```

**Check database integrity**:

```bash
sqlite3 ~/.rfmedia/tracking.db "PRAGMA integrity_check;"
```

**View database schema**:

```bash
sqlite3 ~/.rfmedia/tracking.db ".schema"
```

### Debugging Tracking Issues

**Enable debug mode** for verbose output:

```bash
rfmedia copy --file=sources.txt /dest --range=001-005 --debug
```

**Dry-run to preview tracking behavior**:

```bash
rfmedia copy --file=sources.txt /dest --range=001-005 --dry-run
```

**Query the database directly**:

```bash
# Show recent operations with status
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT id, command, options_hash, status, completed_count, failed_count
   FROM operations ORDER BY created_at DESC LIMIT 5;"

# Show completed sources for most recent operation
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT source_path, completed_at FROM completed_sources
   WHERE operation_id = (SELECT MAX(id) FROM operations);"

# Show failed sources with error messages
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT source_path, error_message FROM failed_sources
   WHERE operation_id = (SELECT MAX(id) FROM operations);"
```

### Undo/History Troubleshooting

This section covers common issues with the undo/history system.

#### History Sessions Not Recording

**Symptom**: Running copy operations but `rfmedia undo --list` shows no sessions.

**Possible Causes and Solutions**:

| Cause                              | Solution                                       |
| ---------------------------------- | ---------------------------------------------- |
| Undo disabled in config            | Set `undo.enabled: true` in `.rfmedia.json`    |
| Dry-run mode                       | History is not recorded in dry-run mode        |
| Permission issues                  | Ensure write access to `~/.rfmedia/` directory |
| Legacy mode with missing directory | Create `~/.rfmedia/history/` directory         |

**Check if undo is enabled**:

```bash
# Check config
cat .rfmedia.json | jq '.undo.enabled'

# Should output: true (or null, which defaults to true)
```

**Verify database has sessions**:

```bash
sqlite3 ~/.rfmedia/tracking.db "SELECT COUNT(*) FROM history_sessions;"
```

#### Viewing History Sessions in Database

**Query recent sessions**:

```bash
# List recent sessions with details
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT session_id, command, status, operation_count, started_at
   FROM history_sessions ORDER BY started_at DESC LIMIT 10;"
```

**View operations for a specific session**:

```bash
# Get session ID first
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT id, session_id FROM history_sessions ORDER BY started_at DESC LIMIT 5;"

# Then view operations (replace 1 with actual session.id)
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT operation_type, source_path, dest_path
   FROM history_operations WHERE session_id = 1 LIMIT 20;"
```

**Count operations by type for a session**:

```bash
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT operation_type, COUNT(*) as count
   FROM history_operations WHERE session_id = 1
   GROUP BY operation_type;"
```

#### Undo Not Working

**Symptom**: `rfmedia undo` shows sessions but fails to undo operations.

**Possible Causes**:

| Cause                  | Solution                                               |
| ---------------------- | ------------------------------------------------------ |
| Files already deleted  | Cannot undo if destination files were manually deleted |
| Session already undone | Check session status with `--list`                     |
| Permission denied      | Ensure write access to destination directories         |

**Check session status**:

```bash
rfmedia undo --list

# Or query database directly
sqlite3 -header -column ~/.rfmedia/tracking.db \
  "SELECT session_id, status, operation_count
   FROM history_sessions WHERE status = 'pending'
   ORDER BY started_at DESC;"
```

#### Legacy vs Database Mode Issues

**Symptom**: Sessions appearing in one mode but not the other.

**Check which mode is active**:

```bash
# Check config
cat .rfmedia.json | jq '.undo.useLegacy'

# null or false = database mode (default)
# true = legacy mode (JSONL files)
```

**List legacy JSONL files**:

```bash
ls -la ~/.rfmedia/history/*.jsonl 2>/dev/null
```

**List database sessions**:

```bash
sqlite3 ~/.rfmedia/tracking.db "SELECT session_id, command FROM history_sessions LIMIT 10;"
```

**Migrate legacy history to database**:

When switching from legacy to database mode, existing JSONL files are automatically migrated on first run. To verify migration:

```bash
# Check if database has migrated sessions
sqlite3 ~/.rfmedia/tracking.db \
  "SELECT COUNT(*) as sessions,
          (SELECT COUNT(*) FROM history_operations) as operations
   FROM history_sessions;"
```

#### Clearing History

**Clear all history sessions** (use with caution):

```bash
# Delete all history data from database
sqlite3 ~/.rfmedia/tracking.db "DELETE FROM history_operations; DELETE FROM history_sessions;"

# Or reset the entire database (also clears tracking data)
rm ~/.rfmedia/tracking.db
# Next operation will create a fresh database
```

**Clear legacy JSONL files**:

```bash
rm -rf ~/.rfmedia/history/*.jsonl
```

### `rfmedia verify`

Verify music copies using stored destination SHA-256 by default, quick metadata when requested, or
stored SHA-256 plus an applicable source/destination byte comparison in deep mode. Artifact
selection uses the same two modes as `copy`:

- **Album Mode**: Verifies numbered album copies (--range)
- **Filter Mode**: Verifies rating-filtered tracks (--min-stars/--min-rating)

```bash
rfmedia verify <source1> [source2 ...] <destination> --range=<START-END> [options]
rfmedia verify <source1> [source2 ...] <destination> --min-stars=<N> [options]
rfmedia verify --file=<sources.txt> <destination> [selection options]
```

**Options:**

| Option                           | Description                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `-r, --range <START-END>`        | Range of suffixes to verify (e.g., `001-010`)                              |
| `--album-only`                   | Treat source as a single album                                             |
| `--file <path>`                  | Read source paths and optional per-source ranges from a file               |
| `--min-stars <1.0-5.0>`          | Minimum star rating for filter mode; half-stars are supported              |
| `--min-rating <0-100>`           | Minimum rating on the 0-100 scale for filter mode                          |
| `--output-folder <name>`         | Folder name for filtered tracks (default: `liked-songs`)                   |
| `--preserve-structure`           | Expect album subfolders in filter output                                   |
| `--album-mode`                   | Verify numbered album folders containing only selected tracks              |
| `--min-duration <MM:SS>`         | Minimum track duration in filter mode                                      |
| `--max-duration <MM:SS>`         | Maximum track duration in filter mode                                      |
| `--min-bitrate <kbps>`           | Minimum bitrate in filter mode                                             |
| `--codec <format>`               | Required codec in filter mode                                              |
| `--min-plays <N>`                | Minimum POPM play count in filter mode                                     |
| `-w, --workers <N>`              | Parallel workers (default: auto)                                           |
| `-c, --convert <format>`         | Expected destination conversion: `alac`, `mp3`, `aac`, or `opus`           |
| `--quick`                        | Metadata-only verification with no database or content reads               |
| `--deep`                         | Stored SHA-256 plus applicable source/destination byte comparison          |
| `--tracking-database <path>`     | Existing SQLite database for default/deep fingerprint evidence             |
| `--verify-size`                  | Add a source/destination size precheck for non-converted content           |
| `--no-verify-size`               | Skip the optional size precheck                                            |
| `--fix`                          | Apply authorized repairs and re-run the selected tier                      |
| `--force`                        | Select overwrite/removal without prompting during `--fix`                  |
| `--trash`                        | Move authorized extra files to trash during `--fix`                        |
| `--conflict-strategy <strategy>` | Use `skip`, `overwrite`, `rename`, or `ask` during repair (default: `ask`) |
| `--progress`                     | Show a visual progress bar                                                 |
| `--no-progress`                  | Disable the progress bar                                                   |

#### Verification Tiers

| Selection    | Required evidence                                                                                         | Content reads                                                            | Database                              |
| ------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `--quick`    | Current source/destination size and integer-millisecond modification time                                 | None                                                                     | Not resolved or opened                |
| No tier flag | Destination SHA-256 equals the exact stored final-artifact fingerprint                                    | One full destination hash read                                           | Existing schema version 11, read-only |
| `--deep`     | Default evidence, then bounded-memory source/destination byte comparison when byte identity is meaningful | Destination hash plus applicable source and destination comparison reads | Existing schema version 11, read-only |

`--quick` and `--deep` conflict. The no-flag behavior is the `default` tier, not an
existence-only check. `--verify-size` is additive and never replaces the evidence required by the
selected tier.

Default and deep verification use an exact fingerprint identity: normalized source root,
source-relative path, exact derived destination path, and conversion identity. A missing, legacy
`NULL`, malformed, or ambiguous fingerprint is `unverifiable`; evidence is never borrowed from a
different operation, destination, conversion, or historically unrepresented ranged output.

`--tracking-database` takes precedence over configured database paths. The resolved database must
already exist at schema version 11. Verification opens it read-only and never creates, migrates,
refreshes, or backfills it. Quick mode bypasses database resolution.

Converted outputs can pass default verification against the stored hash of their final converted
bytes. In deep mode their source/destination byte comparison is `not-applicable`. The same applies
to redundant same-inode comparison for hardlinks after stored-hash evidence passes.

Verification is an integrity check against local evidence, not proof of authenticity or provenance.

#### Auto-Fix Mode

The `--fix` option applies only authorized repairs, verifies staged content with the selected tier,
atomically commits successful replacements, and rechecks the requested destination set. A copy or
conversion does not count as repaired until the required evidence passes.

**Fix Actions:**

- **Missing or mismatched expected files**: staged, verified, and replaced only when the selected
  conflict policy authorizes the action
- **Unavailable fingerprint evidence**: refused in default/deep mode; repair never adopts current
  bytes as a new baseline
- **Unstable files**: left unresolved until concurrent writers have stopped
- **Extra files**: removed only when authorized, optionally through trash

**Examples:**

```bash
# Fix missing files and remove extras (with confirmation)
rfmedia verify "/music/Artist" /dest --range=001-010 --fix

# Unattended deep repair with recoverable extra-file removal
rfmedia verify "/music/Artist" /dest --range=001-010 --deep --fix --force --trash

# Use an explicit existing database and overwrite policy
rfmedia verify "/music/Artist" /dest --range=001-010 --fix \
  --tracking-database=/state/rfmedia.db --conflict-strategy=overwrite

# Preview discrepancies without staging, replacing, or removing files
rfmedia verify "/music/Artist" /dest --range=001-010 --fix --dry-run

# Fix filtered tracks
rfmedia verify "/music/Artist" /dest --min-stars=3 --fix
```

After attempted repairs, the summary reflects the full final recheck rather than treating every
filesystem copy as fixed. Remaining mismatches, unavailable evidence, extras, failed or refused
repairs, and operational failures keep the result incomplete.

**JSON Output with Fix Results:**

```json
{
  "command": "verify",
  "mode": "album",
  "tier": "default",
  "status": "complete",
  "source": "/music/Artist",
  "destination": "/dest",
  "result": {
    "verified": 50,
    "missing": 0,
    "sizeMismatch": 0,
    "metadataMismatch": 0,
    "hashMismatch": 0,
    "contentMismatch": 0,
    "unverifiable": 0,
    "notApplicable": 0,
    "unstable": 0,
    "extra": 0,
    "expectedTotal": 50,
    "issues": [],
    "failed": [],
    "fixResults": {
      "copiedFiles": 5,
      "removedFiles": 2,
      "failedFixes": 0,
      "repairedFiles": 5,
      "reverifiedFiles": 5,
      "refusedFiles": 0,
      "remainingIssues": 0
    }
  }
}
```

**Safety Features:**

- Pre-existing destinations remain in place until a staged artifact passes selected-tier evidence.
- Confirmation and conflict strategies govern replacement and extra-file removal.
- `--trash` makes authorized extra-file removal recoverable.
- `--force` is the unattended shorthand for overwrite/removal.
- `--dry-run` reports discrepancies without running the repair phase.

#### Album Mode Verification

Verifies every expected entry in numbered album copies created by `rfmedia copy --range`, using the
selected tier for each file and reporting unexpected entries.

**Examples:**

```bash
# Verify Album-001 through Album-005 exist with all files
rfmedia verify "/music/Artist" /dest --range=001-005

# Verify a single album's numbered copies
rfmedia verify "/music/Artist/Album" /dest --range=001-003 --album-only

# Verify file sizes match (detect incomplete copies)
rfmedia verify "/music/Artist" /dest --range=001-010 --verify-size

# Verify multiple sources with different ranges
rfmedia verify \
  "/music/Artist1,001-003" \
  "/music/Artist2,004-006" \
  /dest

# Preview verification (no filesystem changes regardless)
rfmedia verify "/music/Artist" /dest --range=001-005 --dry-run
```

**Expected Directory Structure (Album Mode):**

For an artist folder `/music/Artist` with albums `Album1` and `Album2`:

```
/dest/
└── Artist/
    ├── Album1-001/
    │   ├── track1.flac
    │   ├── track2.flac
    │   └── cover.jpg
    ├── Album1-002/
    │   ├── track1.flac
    │   ├── track2.flac
    │   └── cover.jpg
    ├── Album2-001/
    │   ├── track1.flac
    │   └── track2.flac
    └── Album2-002/
        ├── track1.flac
        └── track2.flac
```

#### Filter Mode Verification

Verifies destination artifacts for tracks meeting the rating threshold using the selected tier.

**Examples:**

```bash
# Verify all 4+ star tracks are in liked-songs folder
rfmedia verify "/music/Artist" /dest --min-stars=4

# Verify tracks rated 3.5+ stars (supports half-stars)
rfmedia verify "/music/Artist" /dest --min-stars=3.5

# Verify with custom output folder
rfmedia verify "/music/Artist" /dest --min-rating=80 --output-folder=favorites

# Verify with album structure preserved
rfmedia verify "/music/Artist" /dest --min-stars=3 --preserve-structure
```

#### Filter Mode with Album Mode and Range

When using `--album-mode` with `--min-rating` (or `--min-stars`) and `--range`, the verify command checks for numbered album copies that contain only the liked tracks. This verifies the output created by `rfmedia copy --min-rating --album-mode --range`.

**How It Works:**

1. Scans source for all audio files and reads their ratings
2. Groups tracks by album, keeping only those meeting the rating threshold
3. For each album with liked tracks, selects numbered copies (for example, `Album-001/`)
4. Applies the selected verification tier to each expected track
5. Reports mismatches, unavailable or inapplicable evidence, unstable reads, failures, and extras

**Examples:**

```bash
# Verify 3 copies of filtered albums (liked tracks only)
rfmedia verify "/music/Artist" /dest --min-rating=80 --album-mode --range=001-003

# Verify with size checking
rfmedia verify "/music/Artist" /dest --min-stars=4 --album-mode --range=001-005 --verify-size

# Verify from file with per-path ranges
rfmedia verify --file=artists.txt /dest --min-rating=80 --album-mode
```

**Expected Directory Structure (Filter + Album Mode + Range):**

For an artist with `Album1` (10 tracks, 3 liked) and `Album2` (8 tracks, 2 liked):

```
/dest/
└── Artist/
    ├── Album1-001/
    │   ├── liked_track1.flac     # Only tracks meeting threshold
    │   ├── liked_track5.flac
    │   └── liked_track8.flac
    ├── Album1-002/
    │   ├── liked_track1.flac     # Same liked tracks, different copy
    │   ├── liked_track5.flac
    │   └── liked_track8.flac
    ├── Album2-001/
    │   ├── liked_track2.flac
    │   └── liked_track6.flac
    └── Album2-002/
        ├── liked_track2.flac
        └── liked_track6.flac
```

#### Coverage Terms and Machine Output

Only a file that satisfies all required and applicable evidence increments `verified`.

| Status              | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `present`           | Required and applicable checks passed                            |
| `missing`           | Expected destination artifact does not exist                     |
| `size-mismatch`     | Required or requested size comparison failed                     |
| `metadata-mismatch` | Quick modification-time comparison failed                        |
| `hash-mismatch`     | Destination SHA-256 differs from the stored fingerprint          |
| `content-mismatch`  | Deep source/destination byte comparison differs                  |
| `unverifiable`      | Required evidence is missing, invalid, ambiguous, or unavailable |
| `not-applicable`    | An additional check is not meaningful for this artifact          |
| `unstable`          | A file changed while content evidence was read                   |

Missing and extra detection applies in every tier. `not-applicable` is a successful coverage note
when all required evidence passed; it is not independently counted as verified evidence.

JSON and YAML use the nested envelope shown in the repair example. Its stable fields are:

- top-level `command`, `mode`, `tier`, `status`, `source`, and `destination`;
- result counters `verified`, `missing`, `sizeMismatch`, `metadataMismatch`, `hashMismatch`,
  `contentMismatch`, `unverifiable`, `notApplicable`, `unstable`, `extra`, and `expectedTotal`;
- `issues` entries with `path`, optional `sourcePath`, `status`, optional `reason`, `evidence`, and
  optional `expectedSize`/`actualSize`;
- `failed` entries with `path`, `message`, and optional `code`; and
- optional `fixResults` with `copiedFiles`, `removedFiles`, `failedFixes`, `repairedFiles`,
  `reverifiedFiles`, `refusedFiles`, and `remainingIssues`.

Table and CSV formats expose a flat projection of the same counters. Routine machine output never
includes expected or actual digest values.

**Exit Codes:**

- `0`: Every required and applicable check passed and no unresolved repair state remains.
- `1`: Any missing file, mismatch, unverifiable or unstable artifact, extra file, operational
  failure, refused or failed repair, or post-repair issue remains.

A `notApplicable` coverage note alone does not cause exit code `1`.

**Detailed Documentation:**

- [Verify Command](docs/features/verify-command.doc.md)
- [Verify Auto-Fix](docs/features/verify-auto-fix.doc.md)
- [Content Hashing During Copy Operations](docs/features/content-hashing-during-copy-operations.md)
- [Centralized Tracking Database](docs/features/centralized-tracking-db.doc.md)
- [File Integrity Verification](../../docs/features/file-integrity-verification.md)

### `rfmedia migrate-tracking`

Migrate legacy tracking and history files to the SQLite database. This command provides manual
control over migration from file-based tracking to modern SQLite storage.

```bash
rfmedia migrate-tracking [options]
rfmedia migrate [options]
```

**Alias:** `migrate`

**Options:**

| Option                  | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `--delete-old`          | Remove only files whose durable database equivalent is proven              |
| `-f, --force`           | Skip the cleanup confirmation; does not bypass migration proof             |
| `--tracking-only`       | Only migrate tracking files (skip history)                                 |
| `--history-only`        | Only migrate history files (skip tracking)                                 |
| `--history-path <path>` | Use one history discovery/import directory (default: `~/.rfmedia/history`) |

**What Gets Migrated:**

The command migrates two types of legacy files:

1. **Tracking Files** - Located next to your input files:
   - `{input-basename}.completed.{options-hash}.txt` - Successfully processed sources
   - `{input-basename}.failed.{options-hash}.txt` - Sources that failed during processing

2. **History Files** - Located in `~/.rfmedia/history/` or the supplied `--history-path`:
   - `*.jsonl` - Session-based operation history for undo functionality

**Durability and Cleanup Safety:**

- Migration success requires committed database rows that read back as equivalent. A legacy file
  that already has an exact database equivalent is also considered proven.
- `legacyFiles` in command output describes discovered files; it is not an authorization list for
  deletion.
- `--delete-old` removes each proven file independently. Malformed, conflicting, unproven, changed,
  or unsafe files are retained and reported, while safe siblings can still be removed.
- `--force` only bypasses the cleanup confirmation. It never bypasses durable proof, root
  containment, regular-file checks, or symlink protection.
- A custom history directory is resolved once and used for both discovery and import.
- `--dry-run` performs discovery and counting only. It does not open the database, prompt, or
  delete files.

**Examples:**

```bash
# Preview migration (dry-run)
rfmedia migrate --dry-run

# Basic migration (migrates both tracking and history)
rfmedia migrate

# Migrate and delete only legacy files with durable proof
rfmedia migrate --delete-old

# Skip cleanup confirmation without weakening migration proof
rfmedia migrate --delete-old --force

# Migrate only tracking files (skip history)
rfmedia migrate --tracking-only

# Migrate only history files (skip tracking)
rfmedia migrate --history-only

# Migrate history from a custom directory
rfmedia migrate --history-path=/path/to/custom/history

# JSON output for scripting
rfmedia migrate --json
```

**Migration Output:**

```
=== Migration Summary ===

Tracking Files:
  Operations: 3
  Completed sources: 156
  Legacy files found: 6
    - /music/artists.completed.album-001-005.txt (45 entries)
    - /music/artists.failed.album-001-005.txt (2 entries)
    - /music/artists.completed.filter-r80.txt (89 entries)
    - ...

History Files:
  Sessions: 12
  Operations: 1,234
  Legacy files found: 12
    - ~/.rfmedia/history/2026-01-15T10-30-00Z-copy-12345.jsonl (copy, 89 ops)
    - ~/.rfmedia/history/2026-01-16T14-22-10Z-clean-67890.jsonl (clean, 12 ops)
    - ...

Status: Migration complete
```

**When to Use This Command:**

- **After upgrading** from an older version of rfmedia that used file-based tracking
- **To consolidate** tracking data from multiple directories into a single database
- **Before cleaning up** legacy files that are no longer needed
- **When switching** from legacy mode (`tracking.useLegacy: true`) to database mode

**Automatic Migration:**

Rfmedia also performs automatic tracking migration when copy or sync runs in database mode. That
path preserves legacy files. Use this command when you want explicit migration control or
proof-gated cleanup.

**JSON Output:**

```json
{
  "command": "migrate-tracking",
  "result": {
    "tracking": {
      "operations": 3,
      "sources": 156,
      "legacyFiles": [
        {
          "path": "/music/artists.completed.album-001-005.txt",
          "type": "completed",
          "hash": "album-001-005",
          "entryCount": 45,
          "inputFile": "/music/artists"
        }
      ]
    },
    "history": {
      "sessions": 12,
      "operations": 1234,
      "legacyFiles": [
        {
          "path": "~/.rfmedia/history/2026-01-15T10-30-00Z-copy-12345.jsonl",
          "sessionId": "2026-01-15T10-30-00Z-copy-12345",
          "operationCount": 89,
          "command": "copy",
          "startedAt": "2026-01-15T10:30:00Z"
        }
      ]
    },
    "filesDeleted": 0,
    "errors": []
  }
}
```

Legacy filenames preserve the input basename but not its original extension. The `inputFile`
identity therefore combines the sidecar directory with that captured basename so equal option
hashes from different input lists remain separate.

**Exit Codes:**

- `0`: Migration completed successfully (or no files to migrate)
- `1`: Migration encountered errors (partial migration may have occurred)

### `rfmedia stats`

Display operation statistics and storage usage from the tracking database. This command provides insights into your copy/sync operations, success rates, and storage distribution by rating.

```bash
rfmedia stats [options]
```

**Options:**

| Option                       | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `--tracking-database <path>` | Path to SQLite tracking database (default: `~/.rfmedia/tracking.db`) |

**What It Shows:**

The stats command queries the tracking database to display:

1. **Operation Statistics** - Breakdown by command type (copy, sync, delete):
   - Total operations
   - Completed, failed, and partial counts
   - Success rate as percentage

2. **Success Rate by Mode** - Separate success rates for album mode vs filter mode operations

3. **Total Storage** - Aggregate file count and storage size from the inventory table

4. **Storage by Rating** - Files grouped by rating ranges (internal database uses normalized 0.0-1.0 scale):
   - 4-5 stars (internal: rating >= 0.8)
   - 3-4 stars (internal: rating >= 0.6)
   - 2-3 stars (internal: rating >= 0.4)
   - 1-2 stars (internal: rating >= 0.2)
   - Unrated (internal: rating < 0.2 or NULL)

**Examples:**

```bash
# View statistics from default database
rfmedia stats

# Use a custom database location
rfmedia stats --tracking-database=/custom/path/tracking.db

# JSON output for scripting
rfmedia stats --json
```

**Console Output:**

```
Operation Statistics

┌─────────┬───────┬──────────┬────────┬─────────┬─────────┐
│ Command │ Total │ Complete │ Failed │ Partial │ Success │
├─────────┼───────┼──────────┼────────┼─────────┼─────────┤
│ copy    │    15 │       14 │      0 │       1 │   93.3% │
│ sync    │     8 │        8 │      0 │       0 │  100.0% │
│ delete  │     4 │        4 │      0 │       0 │  100.0% │
└─────────┴───────┴──────────┴────────┴─────────┴─────────┘

Success Rate by Mode

┌────────┬──────────────┐
│ Mode   │ Success Rate │
├────────┼──────────────┤
│ album  │        93.3% │
│ filter │        90.9% │
└────────┴──────────────┘

Total Storage
  Files: 12,456
  Size:  48.2 GB

Storage by Rating

┌────────────┬───────┬─────────┐
│ Rating     │ Files │ Size    │
├────────────┼───────┼─────────┤
│ 4-5 stars  │ 3,245 │ 12.8 GB │
│ 3-4 stars  │ 4,892 │ 19.1 GB │
│ 2-3 stars  │ 2,156 │  8.4 GB │
│ 1-2 stars  │   856 │  3.3 GB │
│ Unrated    │ 1,307 │  4.6 GB │
└────────────┴───────┴─────────┘
```

**JSON Output:**

```json
{
  "command": "stats",
  "result": {
    "operations": [
      {
        "command": "copy",
        "total": 15,
        "completed": 14,
        "failed": 0,
        "partial": 1,
        "successRate": 93.33
      },
      {
        "command": "copy",
        "total": 22,
        "completed": 20,
        "failed": 1,
        "partial": 1,
        "successRate": 90.91
      }
    ],
    "totalFiles": 12456,
    "totalSize": 51781427200,
    "storageByRating": [
      { "range": "4-5 stars", "fileCount": 3245, "totalSize": 13743895552 },
      { "range": "3-4 stars", "fileCount": 4892, "totalSize": 20509409280 },
      { "range": "2-3 stars", "fileCount": 2156, "totalSize": 9021071360 },
      { "range": "1-2 stars", "fileCount": 856, "totalSize": 3543348224 },
      { "range": "Unrated", "fileCount": 1307, "totalSize": 4939702784 }
    ],
    "successRateByMode": {
      "album": 93.33,
      "filter": 90.91
    }
  }
}
```

**Notes:**

- The inventory table is populated by database-tracked album copy, filter copy, and sync operations.
  Dry-run, disabled completed tracking, and legacy tracking do not populate SQLite inventory.
- Statistics are read directly from the database - no files are scanned.
- Success rate is calculated as (completed / total) \* 100.

### `rfmedia history`

Query operation history with filtering and duplicate detection. This command provides a detailed view of past operations stored in the tracking database.

```bash
rfmedia history [options]
```

**Options:**

| Option                       | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `--from <date>`              | Start date (ISO format or relative like "7 days ago")            |
| `--to <date>`                | End date (ISO format or relative)                                |
| `--mode <type>`              | Filter by copy mode: `album` or `filter`                         |
| `--status <status>`          | Filter by status: `pending`, `completed`, `failed`, or `partial` |
| `--command <command>`        | Filter by command: `copy`, `sync`, or `delete`                   |
| `-l, --limit <number>`       | Maximum results to display (default: 50)                         |
| `--show-duplicates`          | Highlight duplicate operations and sources                       |
| `--tracking-database <path>` | Path to SQLite tracking database                                 |

**Date Format:**

The `--from` and `--to` options accept two formats:

1. **ISO format**: `2026-01-15` or `2026-01-15T10:30:00`
2. **Relative format**: `7 days ago`, `2 weeks ago`, `1 month ago`

**Examples:**

```bash
# View recent operations (default: last 50)
rfmedia history

# View operations from the last week
rfmedia history --from="7 days ago"

# View operations in a date range
rfmedia history --from="2026-01-01" --to="2026-01-15"

# Filter by mode
rfmedia history --mode=album

# Filter by status (find failed operations)
rfmedia history --status=failed

# Filter by command type
rfmedia history --command=sync

# Combine filters
rfmedia history --from="30 days ago" --mode=filter --status=completed

# Limit results
rfmedia history --limit=10

# Show duplicate detection
rfmedia history --show-duplicates

# JSON output for scripting
rfmedia history --json

# Use custom database
rfmedia history --tracking-database=/custom/path/tracking.db
```

**Console Output:**

```
Operation History

Found 25 operation(s)

┌────┬──────────┬─────────┬────────┬───────────┬──────────┬────────┬──────────┐
│ ID │ Time     │ Command │ Mode   │ Status    │ Progress │ Failed │ Duration │
├────┼──────────┼─────────┼────────┼───────────┼──────────┼────────┼──────────┤
│ 42 │ 10:30 AM │ copy    │ album  │ ✓ done    │    45/45 │      0 │ 12m 34s  │
│ 41 │ yesterday│ copy    │ filter │ ⚠ partial │    38/40 │      2 │  8m 15s  │
│ 40 │ 3d ago   │ sync    │ filter │ ✓ done    │  156/156 │      0 │ 25m 42s  │
└────┴──────────┴─────────┴────────┴───────────┴──────────┴────────┴──────────┘
```

**Duplicate Detection Output (with `--show-duplicates`):**

When duplicate operations are detected, additional sections are displayed:

```
Duplicate Operations (2 groups)

┌──────────────────┬───────┬───────────────┐
│ Options Hash     │ Count │ Operation IDs │
├──────────────────┼───────┼───────────────┤
│ album-001-005    │     3 │ 15, 28, 42    │
│ filter-r80       │     2 │ 22, 35        │
└──────────────────┴───────┴───────────────┘

Duplicate Sources (5 paths)

┌───────────────────────────┬────────────────┐
│ Source Path               │ Times Processed│
├───────────────────────────┼────────────────┤
│ /music/Artist1/Album1      │              3 │
│ /music/Artist2/Album2      │              2 │
│ /music/Artist3/Album3      │              2 │
└───────────────────────────┴────────────────┘
  ... and 2 more
```

**JSON Output:**

```json
{
  "command": "history",
  "result": {
    "entries": [
      {
        "id": 42,
        "createdAt": "2026-01-18T10:30:45.000Z",
        "command": "copy",
        "mode": "album",
        "inputFile": "/home/user/artists.txt",
        "optionsHash": "album-001-010",
        "status": "completed",
        "totalSources": 45,
        "completedCount": 45,
        "failedCount": 0,
        "startedAt": "2026-01-18T10:30:45.000Z",
        "endedAt": "2026-01-18T10:43:19.000Z"
      }
    ],
    "totalCount": 25,
    "duplicates": [
      {
        "optionsHash": "album-001-005",
        "count": 3,
        "operationIds": [15, 28, 42]
      }
    ],
    "duplicateSources": [
      {
        "sourcePath": "/music/Artist1/Album1",
        "operationCount": 3
      }
    ]
  }
}
```

**Understanding Duplicate Detection:**

The `--show-duplicates` option helps identify:

1. **Duplicate Operations** - Operations with the same options hash, which may indicate:
   - Repeated runs of the same command
   - Accidental re-processing
   - Tracking issues

2. **Duplicate Sources** - Source paths processed in multiple operations, which may indicate:
   - Sources appearing in multiple input files
   - Overlapping processing runs
   - Intentional reprocessing with different options

**Use Cases:**

- **Audit trail**: Review what operations have been performed
- **Debugging**: Find failed operations and investigate errors
- **Optimization**: Identify duplicate processing to improve efficiency
- **Verification**: Confirm operations completed successfully

**Exit Codes:**

- `0`: Query completed successfully
- `1`: Error occurred (database not found, invalid date format, etc.)

### `rfmedia playlist`

Generate and manage M3U/M3U8 playlist files from smart filters or Plex playlists. Unlike `rfmedia plex playlist export` which copies audio files, this command generates standard M3U playlist files that reference your existing music library.

**Use Cases:**

- Create portable playlists for media players that support M3U format
- Generate playlists from your smart filter definitions
- Export Plex playlists as M3U files for offline/external use
- Maintain playlist definitions with automatic update support

#### Subcommands

| Subcommand | Description                                                |
| ---------- | ---------------------------------------------------------- |
| `create`   | Create a new M3U playlist from a filter or Plex playlist   |
| `update`   | Update existing playlist(s) by re-evaluating their sources |
| `list`     | List all saved smart playlists                             |
| `show`     | Show details and generation history for a playlist         |
| `delete`   | Delete a saved smart playlist                              |

#### Source Types

Smart playlists can be created from two different sources:

| Source Type   | Option            | Description                                   |
| ------------- | ----------------- | --------------------------------------------- |
| Smart Filter  | `--filter <name>` | Evaluates a named filter from `.rfmedia.yaml` |
| Plex Playlist | `--plex-playlist` | Fetches tracks from an existing Plex playlist |

Exactly one source must be specified when creating a playlist.

#### Creating Playlists

```bash
rfmedia playlist create <name> -o <output-path> [source-options] [options]
```

**Required:**

| Argument       | Description                            |
| -------------- | -------------------------------------- |
| `<name>`       | Display name for the playlist          |
| `-o, --output` | Output file path for the M3U/M3U8 file |

**Source Options (one required):**

| Option                       | Description                         |
| ---------------------------- | ----------------------------------- |
| `-f, --filter <name>`        | Named filter from config            |
| `-p, --plex-playlist <name>` | Plex playlist name to use as source |

**Additional Options:**

| Option              | Description                                 |
| ------------------- | ------------------------------------------- |
| `-r, --relative`    | Use relative paths in the playlist          |
| `--base-dir <path>` | Base directory for computing relative paths |
| `--force`           | Overwrite existing playlist file            |
| `--dry-run`         | Preview without writing files               |
| `--json`            | Output in JSON format                       |

**Examples:**

```bash
# Create playlist from a smart filter
rfmedia playlist create "My Favorites" -o /playlists/favorites.m3u8 --filter high-rated

# Create playlist from a Plex playlist
rfmedia playlist create "Road Trip" -o /playlists/roadtrip.m3u8 --plex-playlist "Road Trip Mix"

# Create with relative paths (for portable devices)
rfmedia playlist create "Portable Mix" -o /usb/music/playlist.m3u8 --filter favorites --relative

# Preview what would be created
rfmedia playlist create "Test" -o /tmp/test.m3u8 --filter rock-favorites --dry-run
```

#### Updating Playlists

Re-generate existing playlists by re-evaluating their source (filter or Plex playlist):

```bash
rfmedia playlist update [name] [options]
```

**Options:**

| Option      | Description                      |
| ----------- | -------------------------------- |
| `<name>`    | Specific playlist name to update |
| `-a, --all` | Update all saved playlists       |
| `--json`    | Output in JSON format            |

**Examples:**

```bash
# Update a specific playlist
rfmedia playlist update "My Favorites"

# Update all saved playlists
rfmedia playlist update --all

# JSON output for scripting
rfmedia playlist update --all --json
```

#### Listing Playlists

```bash
rfmedia playlist list [options]
```

**Options:**

| Option   | Description           |
| -------- | --------------------- |
| `--json` | Output in JSON format |

**Example Output:**

```
Found 3 playlist(s):

NAME              TYPE           SOURCE          TRACKS  UPDATED
My Favorites      filter         high-rated         150  2026-01-18 10:30:00
Road Trip         plex-playlist  Road Trip Mix       75  2026-01-15 14:22:00
Workout Mix       filter         high-energy         45  2026-01-10 09:15:00
```

#### Showing Playlist Details

```bash
rfmedia playlist show <name> [options]
```

**Options:**

| Option   | Description           |
| -------- | --------------------- |
| `--json` | Output in JSON format |

**Example Output:**

```
Playlist: My Favorites
  Source Type: filter
  Source Name: high-rated
  Track Count: 150
  Output Path: /playlists/favorites.m3u8
  Relative Paths: No
  Created At: 2026-01-10 09:00:00
  Updated At: 2026-01-18 10:30:00

Generation History (last 10):
  2026-01-18 10:30:00 - 150 tracks
  2026-01-15 08:45:00 - 148 tracks
  2026-01-10 09:00:00 - 145 tracks
```

#### Deleting Playlists

```bash
rfmedia playlist delete <name> [options]
```

**Options:**

| Option          | Description                        |
| --------------- | ---------------------------------- |
| `-f, --force`   | Skip confirmation prompt           |
| `--delete-file` | Also delete the M3U file from disk |

**Examples:**

```bash
# Delete playlist definition (keeps M3U file)
rfmedia playlist delete "Old Playlist"

# Delete playlist and its M3U file
rfmedia playlist delete "Old Playlist" --delete-file

# Skip confirmation
rfmedia playlist delete "Old Playlist" --delete-file --force
```

#### M3U File Format

Generated playlists use the M3U8 format (UTF-8 encoded) with extended info:

```m3u
#EXTM3U
#EXTINF:245,Artist Name - Song Title
/path/to/music/Artist/Album/01 Song Title.flac
#EXTINF:198,Another Artist - Another Song
/path/to/music/Another Artist/Album/02 Another Song.mp3
```

**File Extension:**

- `.m3u8` - UTF-8 encoded (recommended)
- `.m3u` - Also supported, but uses UTF-8 encoding

#### Database Storage

Smart playlist definitions are stored in the SQLite tracking database (`~/.rfmedia/tracking.db`) for persistence and update support. This includes:

- Playlist name and configuration
- Source type and source name (filter or Plex playlist)
- Output path and relative paths setting
- Generation history with track counts

#### Comparison with Plex Playlist Export

| Feature          | `rfmedia playlist create` | `rfmedia plex playlist export` |
| ---------------- | ------------------------- | ------------------------------ |
| Output           | M3U playlist file         | Copied audio files             |
| Source           | Filter OR Plex playlist   | Plex playlist only             |
| Disk space usage | Minimal (text file only)  | Full file copies               |
| Portability      | Requires original files   | Self-contained                 |
| Update support   | Yes (`playlist update`)   | Manual re-export               |
| History tracking | Yes (in database)         | No                             |

For complete feature documentation, see `docs/features/smart-playlists.md`.

## Album Mode vs Filter Mode

The `copy` command operates in two mutually exclusive modes:

### Album Mode (`--range`)

- Copies entire album directories with all their contents
- Creates numbered copies: `Album-001`, `Album-002`, etc.
- Useful for creating multiple copies of the same album for different purposes
- Preserves the complete album structure including non-audio files (artwork, etc.)

### Filter Mode (`--min-stars` / `--min-rating`)

- Extracts individual audio tracks based on their rating
- Creates a single output folder per artist (default: `liked-songs`)
- Useful for creating "best of" collections from large libraries
- Only copies audio files that meet the rating threshold

**Note:** When using `--range` in filter mode, suffixes are applied to individual track filenames rather than creating album copies.

## Hardlink Considerations

When using `--hardlink`, the tool creates hardlinks instead of copying files. This has several benefits and caveats:

### Benefits

- **Disk Space**: Hardlinked files share the same disk blocks, saving significant space
- **Speed**: Creating a hardlink is nearly instantaneous compared to copying
- **Data Integrity**: Changes to one hardlinked file affect all links

For database-inventoried album/filter copy and sync writes, rfmedia hashes the destination after the
hardlink is created. The stored SHA-256 is a write-time snapshot of the shared inode, not a promise
that later changes through another link will be detected automatically.

### Requirements

- Source and destination must be on the same filesystem
- The filesystem must support hardlinks (most Linux/macOS filesystems do)

### Plex Media Server Caveat

Some applications, including Plex Media Server, may not recognize hardlinked files as separate entries in the library. Plex uses inode numbers to identify unique files, and hardlinks share the same inode. This means:

- Multiple hardlinked copies of the same album may appear as a single entry in Plex
- This is expected behavior, not a bug
- If you need Plex to see them as separate albums, use regular copies instead of hardlinks

## Plex Integration

rfmedia can automatically trigger Plex Media Server library scans after copy operations complete. This keeps your Plex library updated without manual intervention. Supports both batch scanning and per-source scanning with path-based efficiency.

Plex integration is implemented through the completed, capability-oriented
`MediaServerAdapter`. Actions query and mutate provider-neutral media entities, filters, opaque IDs,
and normalized ratings; the private Plex implementation owns HTTP endpoints, native field mapping,
rating conversion, caching, and authentication. See the
[Media Server Adapter reference](docs/features/media-server-adapter.md) for the architecture and
[Plex Filters](docs/features/plex-filters.md) for pushdown and residual-filter semantics.

This internal refactor does not change the `plex` configuration key, command names or options,
shell completions, MCP tool/schema, JSON/YAML/CSV fields, or Plex/star rating presentation. Existing
configuration and automation require no migration.

Credentials can come from a static token (`plex.token` or `--plex-token`) or from an enrolled
device (`rfmedia plex auth login`). Enrollment is opt-in and additive: with no credential store on
disk, credential resolution is identical to previous releases.

### Configuration

Add Plex settings to your configuration file:

```json
{
  "plex": {
    "url": "http://localhost:32400",
    "token": "YOUR_PLEX_TOKEN",
    "pageSize": 100,
    "scanAfterCopy": true,
    "libraryName": "Music",
    "scanPerSource": false,
    "syncRatingsOnCopy": false,
    "syncOnCopyDefaults": {
      "popmEmail": "no@email",
      "vorbisScale": "normalized"
    },
    "libraries": [
      { "path": "/mnt/media/music", "library": "Music" },
      { "path": "/mnt/media/playlists", "library": "Playlists" }
    ]
  }
}
```

| Option                           | Type    | Default        | Description                                     |
| -------------------------------- | ------- | -------------- | ----------------------------------------------- |
| `pageSize`                       | number  | `100`          | Plex API page size; integer from 1 through 1000 |
| `syncRatingsOnCopy`              | boolean | `false`        | Write Plex ratings during copy and export       |
| `syncOnCopyDefaults.popmEmail`   | string  | `"no@email"`   | POPM email identifier for MP3 rating writes     |
| `syncOnCopyDefaults.vorbisScale` | string  | `"normalized"` | `normalized`, `stars`, or `percent`             |

Starting with the fix for #289, these existing settings are validated and take effect when loaded.
If a configuration already sets `syncRatingsOnCopy: true`, upgrading activates rating metadata
writes. In hardlink mode the destination and source share the same inode, so a rating write also
modifies the original file.

### Getting a Plex Credential

There are two ways to give rfmedia a credential.

**Option A — enroll this device (recommended).** No token is copied by hand, and nothing
credential-shaped is written to your configuration file:

```bash
rfmedia plex auth login
```

See [Plex Account Enrollment](#plex-account-enrollment) below.

**Option B — find your Plex token:**

1. Sign in to Plex Web App
2. Browse to any media item
3. Click the three dots menu → "Get Info" → "View XML"
4. Find `X-Plex-Token` in the URL

Or see: [Finding an authentication token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/)

### Plex Account Enrollment

`rfmedia plex auth` enrolls this device with your Plex account, keeps the resulting credential
fresh, and destroys it on request.

```bash
rfmedia plex auth login    # enroll this device (prints an authorization link to stderr)
rfmedia plex auth status   # report enrollment and credential state; makes no network call
rfmedia plex auth refresh  # rotate the stored credential
rfmedia plex auth logout   # destroy local enrollment material
```

| Command   | Flags                                                                          |
| --------- | ------------------------------------------------------------------------------ |
| `login`   | `--plex-url <url>`, `--device-name <name>`, `--timeout <seconds>`, `-y, --yes` |
| `status`  | `--plex-url <url>`                                                             |
| `refresh` | `--plex-url <url>`, `--timeout <seconds>`, `--force`                           |
| `logout`  | `--plex-url <url>`, `-y, --yes`                                                |

- **No flag here takes a secret value** — every one is a URL, a label, or a number of seconds, so
  nothing sensitive reaches `ps` output or shell history.
- `--force` on `refresh` overrides the local freshness check only; it cannot bypass a Plex rate
  limit.
- `login` requires a **reachable** Plex server: the freshly minted credential is probed against it
  and discarded if the server rejects it, so nothing is persisted on failure.
- `logout` destroys **local** material only. Plex documents no client-callable revocation endpoint,
  so finish revocation by removing the device from your Plex Authorized Devices page.

The credential store lives at `~/.config/rfmedia/plex-auth/store.json` (mode `0600`, in a `0700`
directory). Override its location with the `RFMEDIA_PLEX_AUTH_DIR` environment variable — which
names a directory, mirroring `RFMEDIA_PLAN_DIR` — or with `plex.auth.storePath`. The store must be
on a **local filesystem**; NFS/SMB mounts do not provide the atomic-rename and lock semantics it
relies on.

Machine output uses `--output json` (or `--json`). Both are root options, and Commander recognizes
root options on either side of a subcommand, so either position works:

```bash
rfmedia --output json plex auth status   # JSON
rfmedia plex auth status --output json   # JSON, identical
```

Full precedence, migration, rollback, and error-code tables:
[Plex Configuration Guide](docs/features/plex-configuration.md).

### CLI Options

Override configuration per-operation:

| Option                  | Description                                  |
| ----------------------- | -------------------------------------------- |
| `--plex-scan`           | Force Plex library scan for this operation   |
| `--no-plex-scan`        | Disable Plex library scan for this operation |
| `--plex-url <url>`      | Override Plex server URL                     |
| `--plex-token <token>`  | Override Plex authentication token           |
| `--plex-library <name>` | Override library name to scan                |
| `--plex-per-source`     | Scan after each source (not at end of batch) |

`--plex-token` wins over every other credential source, including an enrollment. It is also the
only way to point `--plex-url` at a different origin: a URL override that changes origin always
requires an explicit paired token, and an enrollment does not unlock it.

### Examples

```bash
# Use configuration file settings (auto-scan if enabled)
rfmedia copy "/music/Artist" /dest --range=001-005

# Force Plex scan for this operation
rfmedia copy "/music/Artist" /dest --min-stars=4 --plex-scan

# Disable Plex scan for this operation
rfmedia copy "/music/Artist" /dest --range=001-005 --no-plex-scan

# Override library name
rfmedia copy "/music/Artist" /dest --range=001-005 --plex-library="My Music"

# Connect to remote Plex server
rfmedia copy "/music/Artist" /dest --range=001-005 \
  --plex-url=http://192.168.1.100:32400 \
  --plex-token=abc123

# Per-source scanning (scan after each source completes)
rfmedia copy /dest --file=sources.txt --range=001-005 --plex-per-source
```

### Per-Source Scanning

When processing multiple sources via `--file` or multiple CLI arguments, per-source scanning triggers a Plex scan after each source completes instead of waiting until the end:

```bash
# Traditional batch scan (default): waits for all sources before scanning
rfmedia copy /dest --file=sources.txt --range=001-005 --plex-scan

# Per-source scan: scans after each source completes
rfmedia copy /dest --file=sources.txt --range=001-005 --plex-per-source
```

Benefits:

- New content appears in Plex immediately after each source
- No need to wait for all sources to complete
- Uses path-based scanning for efficiency (only scans affected directories)

### Library Path Mappings

Configure `libraries` to automatically detect which Plex library to scan based on the destination path:

```json
{
  "plex": {
    "libraries": [
      { "path": "/mnt/media/music", "library": "Music" },
      { "path": "/mnt/media/audiobooks", "library": "Audiobooks" }
    ]
  }
}
```

When copying to `/mnt/media/music/Artist/Album`, rfmedia automatically:

1. Matches the destination to the "Music" library
2. Triggers a path-based scan for just that directory (not the entire library)

### Error Handling

Plex scan failures are logged as warnings but do not fail the copy operation:

- **Network errors**: Connection refused, host not found, timeout
- **Authentication errors (401)**: Invalid or expired token
- **Library not found**: Displays available library names
- **Path matching failure**: Falls back to full library scan

### Supported Plex API Operations

- Scan all libraries: `GET /library/sections/all/refresh`
- Scan specific library: `GET /library/sections/{id}/refresh`
- Scan specific path: `GET /library/sections/{id}/refresh?path={path}`
- Library lookup by name (automatic section ID resolution)

### Plex Playlist Operations

rfmedia provides commands to list, export, and sync Plex playlists to local directories. This enables offline access to your curated playlists and integration with external devices or backup workflows.

#### Plex Playlist Commands Overview

| Command                                                      | Description                               |
| ------------------------------------------------------------ | ----------------------------------------- |
| `rfmedia plex playlist list`                                 | List all available Plex playlists         |
| `rfmedia plex playlist export <playlist-name> <destination>` | Export playlist tracks to local directory |
| `rfmedia plex playlist sync <playlist-name> <destination>`   | Sync playlist with destination directory  |

#### Listing Playlists

View all audio playlists available on your Plex server:

```bash
# List all playlists
rfmedia plex playlist list

# List only exportable playlists
rfmedia plex playlist list --exportable

# Override Plex server settings
rfmedia plex playlist list --plex-url=http://192.168.1.100:32400 --plex-token=abc123

# JSON output for scripting
rfmedia plex playlist list --json
```

Example output:

```
Plex Playlists

| Playlist          | Tracks | Smart | Duration |
| ----------------- | ------ | ----- | -------- |
| My Favorites      | 150    | No    | 8:45:30  |
| Party Mix         | 75     | No    | 4:12:15  |
| Recently Added    | 50     | Yes   | 2:30:00  |
```

#### Exporting a Playlist

Export all tracks from a Plex playlist to a local directory:

```bash
# Basic export
rfmedia plex playlist export "My Favorites" /music/exports

# Use hardlinks to save disk space (same filesystem only)
rfmedia plex playlist export "My Favorites" /music/exports --hardlink

# Convert to a different audio format
rfmedia plex playlist export "My Favorites" /music/exports --convert=mp3

# Preserve artist/album folder structure
rfmedia plex playlist export "My Favorites" /music/exports --preserve-structure

# Export directly to destination (no playlist subfolder)
rfmedia plex playlist export "My Favorites" /music/exports --flat

# Use custom folder name instead of playlist name
rfmedia plex playlist export "My Favorites" /music/exports --folder="favorites"

# Preview export without copying files
rfmedia plex playlist export "My Favorites" /music/exports --dry-run

# Trigger Plex library scan after export
rfmedia plex playlist export "My Favorites" /music/exports --plex-scan
```

**Output Structure:**

Default structure (creates playlist subfolder):

```
/music/exports/
└── My Favorites/
    ├── Track 1.flac
    ├── Track 2.mp3
    └── Track 3.m4a
```

With `--flat` (no subfolder):

```
/music/exports/
├── Track 1.flac
├── Track 2.mp3
└── Track 3.m4a
```

With `--preserve-structure` (maintains artist/album hierarchy):

```
/music/exports/
└── My Favorites/
    ├── Artist 1/
    │   └── Album 1/
    │       └── Track 1.flac
    └── Artist 2/
        └── Album 2/
            └── Track 2.mp3
```

#### Creating Multiple Copies

Create multiple numbered copies of playlist tracks for devices that benefit from shuffled access to duplicated content (e.g., car stereos, shuffle-mode players):

**Using --range (explicit range):**

```bash
# Create copies with suffixes 001, 002, 003, 004, 005
rfmedia plex playlist export "Party Mix" /music/car --range=001-005

# Result: Track-001.flac, Track-002.flac, Track-003.flac, ...
```

**Using --count (auto-detect next range):**

```bash
# Auto-detect existing copies and add 3 more
rfmedia plex playlist export "Party Mix" /music/car --count=3

# If 001-002 exist, creates 003, 004, 005
# If empty, creates 001, 002, 003
```

**How range/count works:**

1. **First copy**: Actual file copy (or conversion if `--convert` specified)
2. **Subsequent copies**: Hardlinks to the first copy (saves disk space)
3. **Suffix format**: Zero-padded numbers appended to filename (e.g., `Song-001.flac`)

**Examples:**

```bash
# Create 10 copies for enhanced shuffle on car stereo
rfmedia plex playlist export "Road Trip" /usb/music --range=001-010

# Add 5 more copies to existing set
rfmedia plex playlist export "Road Trip" /usb/music --count=5

# Preview what would be created
rfmedia plex playlist export "Road Trip" /usb/music --range=001-003 --dry-run
```

#### Syncing a Playlist

Keep a local directory synchronized with the current state of a Plex playlist. Sync adds new tracks and optionally removes tracks no longer in the playlist:

```bash
# Basic sync - add new tracks only
rfmedia plex playlist sync "My Favorites" /music/synced

# Sync with cleanup - remove tracks no longer in playlist
rfmedia plex playlist sync "My Favorites" /music/synced --delete-removed

# Incremental sync with count (add new copies based on existing)
rfmedia plex playlist sync "Party Mix" /music/car --count=5

# Full sync with all options
rfmedia plex playlist sync "My Favorites" /music/synced \
  --delete-removed \
  --convert=mp3 \
  --preserve-structure \
  --plex-scan

# Preview sync changes
rfmedia plex playlist sync "My Favorites" /music/synced --delete-removed --dry-run
```

**Sync Behavior:**

- **New tracks**: Added to destination
- **Existing tracks**: Skipped (already present)
- **Removed tracks**: Only deleted when `--delete-removed` is specified
- **Modified tracks**: Not re-copied (based on filename, not content)

#### CLI Options Reference

**Options for `plex playlist export` and `plex playlist sync`:**

| Option                    | Description                                              |
| ------------------------- | -------------------------------------------------------- |
| `--hardlink`              | Use hardlinks instead of copies (same filesystem only)   |
| `--convert <format>`      | Convert audio to format: `mp3`, `aac`, `opus`, `alac`    |
| `-w, --workers <N>`       | Number of parallel workers (default: 4)                  |
| `--dry-run`               | Preview without copying files                            |
| `--no-progress`           | Disable progress bar                                     |
| `--plex-scan`             | Trigger Plex library scan after operation                |
| `--preserve-structure`    | Keep artist/album folder hierarchy                       |
| `--flat`                  | Output directly to destination (no playlist subfolder)   |
| `--folder <name>`         | Custom folder name (overrides playlist name)             |
| `-r, --range <START-END>` | Range of suffixes to create (e.g., `001-005`)            |
| `--count <N>`             | Number of copies (auto-detects next range from existing) |

**Additional option for `plex playlist sync`:**

| Option             | Description                         |
| ------------------ | ----------------------------------- |
| `--delete-removed` | Remove tracks no longer in playlist |

**Options for `plex playlist list`:**

| Option                 | Description                                  |
| ---------------------- | -------------------------------------------- |
| `--exportable`         | Show only playlists that can be exported     |
| `--plex-url <url>`     | Plex server URL (overrides config)           |
| `--plex-token <token>` | Plex authentication token (overrides config) |

**Notes:**

- `--range` and `--count` are mutually exclusive
- `--flat` and `--folder` affect output directory structure
- `--preserve-structure` creates artist/album hierarchy within the output folder
- Export and sync operations use the same Plex configuration as other commands

### Plex Collection Operations

rfmedia supports typed Plex music collections for `track`, `album`, and `artist` workflows.

#### Collection Commands Overview

| Command                                      | Description                                 |
| -------------------------------------------- | ------------------------------------------- |
| `rfmedia plex collection create <name>`      | Create a typed collection                   |
| `rfmedia plex collection add <name>`         | Add typed items to an existing collection   |
| `rfmedia plex collection list --library ...` | List collections with media and smart state |
| `rfmedia plex collection show <name>`        | Show collection metadata and media type     |
| `rfmedia plex collection delete <name>`      | Delete a collection                         |

#### Create Examples

```bash
# Track collection (default)
rfmedia plex collection create "Top Rated Tracks" \
  --library Music \
  --min-track-stars 4

# Artist collection
rfmedia plex collection create "Jazz Icons" \
  --library Music \
  --type artist \
  --genre Jazz

# Album collection
rfmedia plex collection create "Modern Jazz Albums" \
  --library Music \
  --type album \
  --min-year 2010
```

#### Add Examples

```bash
# Add tracks (default mode)
rfmedia plex collection add "Top Rated Tracks" \
  --library Music \
  --genre Jazz

# Add artists
rfmedia plex collection add "Jazz Icons" \
  --library Music \
  --mode artist \
  --genre Jazz

# Add albums
rfmedia plex collection add "Modern Jazz Albums" \
  --library Music \
  --mode album \
  --min-year 2010
```

#### Collection Safety Rules

- Use matching type/mode pairs: artist collections require `--mode artist`, album collections require `--mode album`, track collections require track mode.
- `--from-folder` is track-only.
- `--smart` creation is track-only.

### Plex Rating Sync

rfmedia provides bidirectional rating synchronization between embedded file tags and Plex Media Server. This enables you to maintain consistent ratings across your local library and Plex.

Sync compares ratings internally on a normalized `0..1` scale through the generic adapter. The
private Plex adapter converts to and from Plex's native integer `0..10` scale, while CLI star values
and existing JSON result fields remain unchanged. See
[Plex Metadata Sync](docs/features/plex-metadata-sync.md) for conversion and precision details.

#### Plex Sync Commands Overview

| Command                                         | Description                                 |
| ----------------------------------------------- | ------------------------------------------- |
| `rfmedia plex sync push <source-path>`          | Push file ratings to Plex                   |
| `rfmedia plex sync pull <source-path>`          | Pull Plex ratings to file tags              |
| `rfmedia plex sync both <source-path> --prefer` | Bidirectional sync with conflict resolution |

#### Push Mode (File to Plex)

Push ratings from file tags (POPM for MP3, Vorbis RATING for FLAC) to Plex:

```bash
# Push all file ratings to Plex
rfmedia plex sync push /mnt/music --library Music

# Only sync files that have ratings
rfmedia plex sync push /mnt/music --library Music --only-rated

# Preview changes without modifying Plex
rfmedia plex sync push /mnt/music --library Music --dry-run
```

#### Pull Mode (Plex to File)

Pull ratings from Plex and write them to file tags:

```bash
# Pull Plex ratings to file tags
rfmedia plex sync pull /mnt/music --library Music

# Use custom POPM email for MP3 compatibility
rfmedia plex sync pull /mnt/music --popm-email "MusicBee@example.com"

# Use stars scale for Vorbis comments (0-5 instead of 0-1)
rfmedia plex sync pull /mnt/music --vorbis-scale stars
```

#### Bidirectional Mode

Sync ratings in both directions with conflict resolution:

```bash
# Prefer Plex ratings when they differ
rfmedia plex sync both /mnt/music --library Music --prefer plex

# Prefer file ratings when they differ
rfmedia plex sync both /mnt/music --library Music --prefer file
```

#### CLI Options Reference

**Options for all sync commands:**

| Option                 | Description                             |
| ---------------------- | --------------------------------------- |
| `-l, --library <name>` | Plex library name (default: "Music")    |
| `--only-rated`         | Only sync tracks that have ratings      |
| `-w, --workers <n>`    | Number of parallel workers (default: 4) |
| `--dry-run`            | Preview operations without executing    |
| `--no-progress`        | Disable progress bar                    |
| `--plex-scan`          | Trigger Plex library scan after sync    |

**Additional options for `plex sync pull` and `plex sync both`:**

| Option                   | Description                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `--popm-email <email>`   | POPM email for MP3. Uses `plex.syncDefaults` when unset, else `no@email`.            |
| `--vorbis-scale <scale>` | Vorbis: `normalized`, `stars`, `percent`. Uses config when unset, else `normalized`. |

**Required option for `plex sync both`:**

| Option              | Description                           |
| ------------------- | ------------------------------------- |
| `--prefer <source>` | Conflict resolution: `plex` or `file` |

**Notes:**

- Push mode reads from file tags and updates Plex user ratings
- Pull mode reads from Plex and writes to file tags (MP3 POPM, FLAC Vorbis RATING)
- Bidirectional mode syncs both ways, using `--prefer` to resolve conflicts
- M4A/AAC files cannot have ratings written (iTunes stores ratings in database)
- See `docs/features/plex-metadata-sync.md` for detailed documentation

## Audio Conversion

The `--convert` option allows you to convert audio files to a different format during the copy operation. This requires ffmpeg to be installed on your system.

### Supported Formats

| Format | Extension | Quality  | Use Case                           |
| ------ | --------- | -------- | ---------------------------------- |
| `alac` | `.m4a`    | Lossless | Apple ecosystem, preserves quality |
| `mp3`  | `.mp3`    | 320 kbps | Universal compatibility            |
| `aac`  | `.m4a`    | 256 kbps | Good quality, smaller files        |
| `opus` | `.opus`   | 128 kbps | Best compression, modern players   |

### Examples

```bash
# Convert FLAC albums to ALAC for Apple devices
rfmedia copy "/music/Artist" /dest --range=001-005 --convert=alac

# Create MP3 copies for portable devices
rfmedia copy "/music/Artist" /dest --range=001-003 --convert=mp3

# Convert liked songs to Opus for streaming
rfmedia copy "/music/Artist" /dest --min-stars=4 --convert=opus

# Use with parallel processing for faster conversion
rfmedia copy "/music/Artist" /dest --range=001-010 --convert=mp3 --workers=4
```

### Notes

- Original files are never modified
- Conversion is performed during copy, not as a separate step
- Database inventory fingerprints are calculated from the final converted destination bytes
- Conversion itself creates new bytes; ranged copies may reuse the first converted output
- ffmpeg must be in your system PATH

Converted files are built in a private stage and published atomically only after supported metadata
passes a semantic audit. Canonical tags and the primary cover are preserved; target-specific
custom-tag, rating, or additional-artwork limitations are reported as safe warnings. The verified
ID3/FLAC/MP4/tagless compatibility matrix, exact bounds, and failure guarantees are documented in
[Audio Conversion](docs/features/audio-conversion.doc.md).

For Plex copy and playlist export, conversion preserves source metadata first. A requested positive
Plex rating is applied only afterward; if that later write fails, the preserved source rating
remains. See [Plex Metadata Sync](docs/features/plex-metadata-sync.md#conversion-and-plex-rating-order).

## Disk Space Checking

rfmedia can check if there is sufficient disk space at the destination before starting a copy operation. This prevents failed copies due to running out of space mid-operation.

### Behavior

By default, rfmedia checks available disk space and issues a **warning** if space is insufficient, but continues with the operation. This allows for edge cases like multi-partition destinations where the initial check may not reflect actual available space.

| Mode                 | Behavior                                    |
| -------------------- | ------------------------------------------- |
| Default (no flag)    | Warn if insufficient space, continue anyway |
| `--require-space`    | Abort with error if insufficient space      |
| `--no-require-space` | Skip disk space check entirely              |

### Configuration

Add disk space settings to your configuration file:

```json
{
  "copy": {
    "diskSpaceMargin": 5,
    "requireDiskSpace": false
  }
}
```

| Option             | Type    | Default | Description                                                                          |
| ------------------ | ------- | ------- | ------------------------------------------------------------------------------------ |
| `diskSpaceMargin`  | number  | `5`     | Safety margin as percentage (0-50). Adds extra buffer to required space calculation. |
| `requireDiskSpace` | boolean | `false` | If true, abort when insufficient space. If false, warn and continue.                 |

### Examples

```bash
# Check space and warn (default behavior)
rfmedia copy "/music/Artist" /dest --range=001-010

# Require sufficient space (abort if insufficient)
rfmedia copy "/music/Artist" /dest --range=001-010 --require-space

# Skip disk space check entirely
rfmedia copy "/music/Artist" /dest --range=001-010 --no-require-space

# Preview operation without disk space check (dry-run)
rfmedia copy "/music/Artist" /dest --range=001-010 --dry-run
```

### Special Cases

- **Hardlink mode**: Disk space check is skipped when using `--hardlink` since hardlinks don't consume additional disk space
- **Dry-run mode**: Disk space is not checked during dry-run as no actual copying occurs
- **Conversion**: When using `--convert`, the estimated output size is calculated based on the target format's typical compression ratio

### Output Example

```
[WARN] Insufficient disk space on /dev/sda1
  Available: 5.2 GB
  Required:  12.8 GB (including 5% margin)
  Deficit:   7.6 GB
[WARN] Continuing anyway... (use --require-space to abort)
```

## Parallel Processing

The `--workers` option enables parallel file processing for faster operations on multi-core systems.

### Configuration

| Setting | Description                                        |
| ------- | -------------------------------------------------- |
| Default | Half of available CPU cores (minimum 1, maximum 8) |
| Minimum | 1 (sequential processing)                          |
| Maximum | 8 workers                                          |

### Examples

```bash
# Use 4 parallel workers
rfmedia copy "/music/Artist" /dest --range=001-010 --workers=4

# Maximum parallelism for large operations
rfmedia copy "/music/Artist" /dest --min-stars=3 --workers=8

# Single-threaded for debugging
rfmedia copy "/music/Artist" /dest --range=001-005 --workers=1
```

### Performance Considerations

- More workers = faster processing, but higher memory and CPU usage
- For SSD storage, higher worker counts are beneficial
- For spinning disks (HDD), 2-4 workers may be optimal due to seek times
- Audio conversion benefits significantly from parallelism
- Simple file copies are I/O bound and may not scale linearly with workers

## Rating Format Compatibility

The filter mode reads ratings from audio file metadata. Support varies by format:

**Half-Star Precision:**

Star ratings support half-star precision (e.g., 3.5 stars). Actual precision depends on the audio format:

- **MP3 (POPM)**: ~0.02 stars precision (255 discrete levels, 0-255 scale)
- **FLAC (Vorbis)**: Arbitrary precision (float values stored directly)
- **M4A (iTunes)**: Ratings stored in database, not file metadata

### MP3 (POPM Tags)

- Fully supported
- Reads POPM (Popularimeter) frames from ID3v2.3 and ID3v2.4 tags
- Recognizes ratings from Windows Media Player, MediaMonkey, MusicBee, and other common applications
- POPM value of 0 means unrated (not 0 stars)

### FLAC (Vorbis Comments)

- Fully supported
- Reads the RATING field from Vorbis comments
- Automatically detects scale: 0-1, 0-5 (stars), or 0-100 (percentage)
- Normalizes all scales to a common 0-1 range internally

### OGG/Opus (Vorbis Comments)

- Supported via the same Vorbis Comment RATING field
- Same scale detection as FLAC

### M4A/AAC (iTunes)

- Limited support
- iTunes stores ratings in its database, not in file metadata
- Files rated only in iTunes will appear as unrated
- Ratings stored by third-party tools in MP4 atom metadata may be detected

### Supported Audio Formats

The following audio formats are recognized:

`flac`, `wav`, `mp3`, `ogg`, `opus`, `m4a`, `aac`, `wma`, `aiff`, `ape`, `wv`, `alac`

## File Input Format

When using `--file` to read source paths from a file:

- One path per line
- Empty lines are skipped
- Lines starting with `#` are treated as comments
- Paths may be quoted (quotes are stripped)
- Leading and trailing whitespace is trimmed

Example file:

```
# Artists to process
/music/Artist One
/music/Artist Two

# This artist has spaces in the name
'/music/Artist With Spaces'
```

### Per-Path Range and Count Support

Each path in the input file can optionally include a suffix to specify copy behavior. The suffix format is automatically detected:

- **Range format** (with hyphen): Creates specific numbered copies (e.g., `001-003`)
- **Count format** (pure digits): Auto-detects the next N copies to create (e.g., `5`)

**Format:**

```
# Range format: explicit items
path,START-END

# Count format: auto-detect next N items
path,COUNT
```

**Example file with mixed formats:**

```
# Explicit range: creates Album1-001 through Album1-005
/music/Artist1/Album1,001-005

# Auto-count: if Album2-001 through Album2-003 exist, creates Album2-004 through Album2-008
/music/Artist2/Album2,5

# No suffix: uses default (from CLI or config)
/music/Artist3/Album3

# Comments and empty lines are ignored
```

**Detection Logic:**

| Suffix                | Detected As  | Example                          |
| --------------------- | ------------ | -------------------------------- |
| Contains hyphen (`-`) | Range        | `001-003` → copies 001, 002, 003 |
| Pure digits only      | Count        | `5` → auto-detects next 5 copies |
| Invalid format        | Part of path | `abc` → treated as `/path,abc`   |

**Range Precedence (highest to lowest):**

1. **CLI `--range` option** - Overrides ALL paths (ignores per-path ranges/counts)
2. **CLI `--count` option** - Auto-detects range for each source independently
3. **Per-path count** - Count suffix in input file (e.g., `path,5`)
4. **Per-path range** - Range suffix in input file (e.g., `path,001-003`)
5. **Config file `copy.range`** - Default from configuration

**Examples:**

```bash
# Use per-path ranges/counts from file
rfmedia copy --file=albums.txt /dest

# Override all per-path ranges/counts with CLI option
rfmedia copy --file=albums.txt /dest --range=001-003

# Override with auto-count (applies to all sources)
rfmedia copy --file=albums.txt /dest --count=5

# Per-path ranges/counts with config fallback for paths without suffix
rfmedia copy --file=albums.txt /dest
# (paths without suffix use copy.range from .rfmedia.json)
```

**Input file (albums.txt):**

```
# This album gets explicit copies 001-005
/music/Artist1/Popular Album,001-005

# This album auto-detects next 3 copies (e.g., if 001-002 exist, creates 003-005)
/music/Artist2/Greatest Hits,3

# This album gets explicit copies 001-010 (more popular)
/music/Artist3/Best Of,001-010

# This album uses config default (copy.range) or fails if no default
/music/Artist4/New Album
```

**Behavior Notes:**

- Paths without per-path ranges/counts require either a CLI `--range`/`--count` option or `copy.range` in the config file
- If no range is available for a path, the operation will fail with an error
- The comma separator is only recognized at the last comma in the line (paths with commas are supported)
- Range format must match `NNN-NNN` (e.g., `001-005`, `010-020`)
- Count format must be pure digits (e.g., `5`, `10`, `42`)
- Count values less than 1 are rejected with an error
- Values like `1-5` are treated as range (not count), even without leading zeros

## JSON Output

When using `--json`, the tool outputs structured JSON for scripting:

### Copy Command Output

```json
{
  "command": "copy",
  "mode": "album",
  "source": "/music/Artist",
  "destination": "/dest",
  "result": {
    "created": 5,
    "skipped": 2,
    "failed": []
  }
}
```

For filter mode, an additional `filtered` field shows tracks below threshold:

```json
{
  "command": "copy",
  "mode": "filter",
  "source": "/music/Artist",
  "destination": "/dest",
  "result": {
    "created": 42,
    "skipped": 3,
    "filtered": 128,
    "failed": []
  }
}
```

### Clean Command Output

```json
{
  "command": "clean",
  "directory": "/music",
  "result": {
    "albumsDeleted": 15,
    "artistsDeleted": 3,
    "errors": []
  }
}
```

## Exit Codes

- `0`: Success
- `1`: Error (operation failed or some files could not be processed)

## Configuration File

rfmedia supports configuration files to set default options. CLI options always take precedence over config file values. YAML is the default and recommended format, though JSON is still supported for backward compatibility.

### Config File Locations

Configuration is loaded from the first file found (in order of priority). YAML files take precedence over JSON files in each location:

1. `.rfmedia.yaml` / `.rfmedia.yml` / `.rfmedia.json` in the current working directory
2. `~/.config/rfmedia/config.yaml` / `.yml` / `.json`
3. `~/.rfmedia/config.yaml` / `.yml` / `.json`
4. `~/.rfmedia.yaml` / `.rfmedia.yml` / `.rfmedia.json`

### Creating a Config File

Use the `init` command to generate a template in the default YAML format:

```bash
# Create .rfmedia.yaml in current directory
rfmedia init

# Create global config at ~/.rfmedia.yaml
rfmedia init --global
```

### Config File Format (YAML)

```yaml
copy:
  range: "001-003"
  outputFolder: "liked-songs"
  hardlink: false
  force: false
  workers: 4
  progress: true
  albumOnly: false
  preserveStructure: false
  albumMode: false
  trackCompleted: true
  deleteDowngraded: true
  minDuration: 60
  maxDuration: 600
  minBitrate: 256
  codec: "FLAC"
clean:
  force: false
  useTrash: false
  depth: 2
watch:
  outputFolder: "liked-songs"
  hardlink: false
  debounceMs: 5000
  albumOnly: false
  preserveStructure: false
global:
  debug: false
plex:
  url: "http://localhost:32400"
  token: "YOUR_PLEX_TOKEN"
  scanAfterCopy: false
  libraryName: "Music"
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
    timeoutMs: 15000
undo:
  enabled: true
  retentionDays: 30
  maxSizeMB: 100
  useLegacy: false
  database: null
tracking:
  database: null
  useLegacy: false
filters:
  high-rated:
    match: all
    rules:
      - field: rating
        operator: ">="
        value: 4.0
```

### Configuration Options

#### Copy Options (`copy`)

| Option              | Type    | Default         | Description                                                                                               |
| ------------------- | ------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `range`             | string  | -               | Default range for album mode (e.g., `001-003`). Used when no CLI `--range` or per-path range is provided. |
| `outputFolder`      | string  | `"liked-songs"` | Folder name for filtered tracks                                                                           |
| `hardlink`          | boolean | `false`         | Use hardlinks instead of copies                                                                           |
| `force`             | boolean | `false`         | Overwrite existing files                                                                                  |
| `convertFormat`     | string  | -               | Audio conversion format (`alac`, `mp3`, `aac`, `opus`)                                                    |
| `workers`           | number  | auto            | Number of parallel workers                                                                                |
| `progress`          | boolean | `true`          | Show visual progress bar                                                                                  |
| `albumOnly`         | boolean | `false`         | Treat source as single album                                                                              |
| `preserveStructure` | boolean | `false`         | Keep album subfolders in output                                                                           |
| `albumMode`         | boolean | `false`         | Preserve album folders with liked tracks                                                                  |
| `trackCompleted`    | boolean | `true`          | Track completed sources for resume (enabled by default)                                                   |
| `minStars`          | number  | -               | Minimum star rating (1.0-5.0, supports half-stars) for filter mode                                        |
| `minRating`         | number  | -               | Minimum rating (0-100) for filter mode                                                                    |
| `deleteDowngraded`  | boolean | `true`          | Delete files when rating falls below threshold (sync)                                                     |
| `minDuration`       | number  | -               | Minimum track duration in seconds (CLI accepts `MM:SS`)                                                   |
| `maxDuration`       | number  | -               | Maximum track duration in seconds (CLI accepts `MM:SS`)                                                   |
| `minBitrate`        | number  | -               | Minimum bitrate in kbps (e.g., `256`, `320`)                                                              |
| `codec`             | string  | -               | Required codec, case-insensitive (e.g., `FLAC`, `MP3`)                                                    |
| `minPlays`          | number  | -               | Minimum play count from POPM counter (MP3 only)                                                           |
| `diskSpaceMargin`   | number  | `5`             | Safety margin for disk space checks (0-50%)                                                               |
| `requireDiskSpace`  | boolean | `false`         | Abort if insufficient disk space (false = warn only)                                                      |

#### Clean Options (`clean`)

| Option      | Type     | Default | Description                                                              |
| ----------- | -------- | ------- | ------------------------------------------------------------------------ |
| `force`     | boolean  | `false` | Skip confirmation prompt                                                 |
| `minFiles`  | number   | -       | Delete albums with fewer than N files                                    |
| `exclude`   | string[] | -       | Glob patterns to exclude from deletion                                   |
| `protect`   | string   | -       | Path to file containing patterns to never delete                         |
| `useTrash`  | boolean  | `false` | Move to trash instead of delete                                          |
| `olderThan` | number   | -       | Only delete albums not modified in the past N days                       |
| `depth`     | number   | `2`     | Maximum directory depth to scan. Use 0 for unlimited recursive scanning. |

#### Watch Options (`watch`)

| Option              | Type    | Default         | Description                      |
| ------------------- | ------- | --------------- | -------------------------------- |
| `outputFolder`      | string  | `"liked-songs"` | Folder name for filtered tracks  |
| `hardlink`          | boolean | `false`         | Use hardlinks instead of copies  |
| `debounceMs`        | number  | `5000`          | Debounce delay before processing |
| `albumOnly`         | boolean | `false`         | Treat folders as single albums   |
| `preserveStructure` | boolean | `false`         | Keep album subfolders in output  |

#### Global Options (`global`)

| Option  | Type    | Default | Description                 |
| ------- | ------- | ------- | --------------------------- |
| `debug` | boolean | `false` | Enable verbose debug output |

#### Plex Options (`plex`)

| Option          | Type    | Default | Description                                                            |
| --------------- | ------- | ------- | ---------------------------------------------------------------------- |
| `url`           | string  | -       | Plex Media Server URL (e.g., `http://localhost:32400`)                 |
| `token`         | string  | -       | Plex authentication token (X-Plex-Token). Not needed when enrolled.    |
| `auth`          | object  | -       | Credential-source policy (see below)                                   |
| `scanAfterCopy` | boolean | `false` | Trigger library scan after copy operations                             |
| `libraryName`   | string  | -       | Library name to scan (e.g., `Music`). If not set, scans all libraries. |
| `scanPerSource` | boolean | `false` | Scan after each source instead of at end of batch                      |
| `libraries`     | array   | -       | Path-to-library mappings for auto-detection (see below)                |

**Credential Policy Format (`plex.auth`):**

| Option                 | Type   | Default                                  | Description                                                   |
| ---------------------- | ------ | ---------------------------------------- | ------------------------------------------------------------- |
| `mode`                 | string | `static`                                 | `static` uses `plex.token`; `jwt` requires an enrolled device |
| `storePath`            | string | `~/.config/rfmedia/plex-auth/store.json` | Credential-store path. Tilde-expanded. A path, never a secret |
| `deviceName`           | string | system host name                         | Device label shown in your Plex account. Non-secret           |
| `refreshMarginSeconds` | number | `300`                                    | Proactive refresh window in seconds (min 60, max 86400)       |

```yaml
plex:
  url: "http://localhost:32400"
  auth:
    mode: jwt
```

An absent `auth` block behaves exactly like `mode: static`. `mode: jwt` together with `plex.token`
is reported as an error rather than resolved. Enroll with `rfmedia plex auth login`; see
[Plex Account Enrollment](#plex-account-enrollment).

**Library Mappings Format:**

```json
{
  "libraries": [
    { "path": "/mnt/media/music", "library": "Music" },
    { "path": "/mnt/media/playlists", "library": "Playlists" }
  ]
}
```

Each mapping has:

- `path` (string): Local filesystem path prefix
- `library` (string): Plex library name to scan for destinations under this path

#### Discovery Options (`discovery.lastfm`)

| Option      | Type   | Default | Description                                        |
| ----------- | ------ | ------- | -------------------------------------------------- |
| `apiKey`    | string | -       | Last.fm application API key; required by discovery |
| `timeoutMs` | number | `15000` | Request timeout in milliseconds, from 1–300,000    |

Prefer `apiKey: "{{ LASTFM_API_KEY }}"` to keep the credential out of the file. Template expansion
is eager for the complete loaded configuration: when this placeholder is present,
`LASTFM_API_KEY` is required even for an unrelated command. Omit the complete `discovery` section
when that behavior is not appropriate.

#### Link Videos Options (`linkVideos`)

| Option            | Type    | Default | Description                                   |
| ----------------- | ------- | ------- | --------------------------------------------- |
| `minScore`        | number  | `70`    | Minimum similarity score (0-100) for matching |
| `preferredFormat` | string  | `"mkv"` | Preferred video format when duplicates exist  |
| `progress`        | boolean | -       | Show visual progress bar                      |

#### Undo Options (`undo`)

| Option          | Type    | Default | Description                                              |
| --------------- | ------- | ------- | -------------------------------------------------------- |
| `enabled`       | boolean | `true`  | Enable operation history logging                         |
| `retentionDays` | number  | `30`    | Days to retain history before automatic cleanup          |
| `maxSizeMB`     | number  | `100`   | Maximum history size in MB                               |
| `useLegacy`     | boolean | `false` | Use legacy JSONL files instead of SQLite database        |
| `database`      | string  | -       | Custom database path (default: `~/.rfmedia/tracking.db`) |

See [rfmedia undo](#rfmedia-undo) for detailed documentation on the undo/history system.

#### Tracking Options (`tracking`)

| Option      | Type    | Default                  | Description                                      |
| ----------- | ------- | ------------------------ | ------------------------------------------------ |
| `database`  | string  | `~/.rfmedia/tracking.db` | Path to SQLite tracking database                 |
| `useLegacy` | boolean | `false`                  | Use legacy file-based tracking instead of SQLite |

See [Operation Tracking](#operation-tracking) for detailed documentation.

#### Filters Options (`filters`)

| Option   | Type   | Default | Description                                                 |
| -------- | ------ | ------- | ----------------------------------------------------------- |
| `<name>` | object | -       | Named filter definition with `match` and `rules` properties |
| `match`  | string | -       | Boolean logic: `"all"` (AND) or `"any"` (OR)                |
| `rules`  | array  | -       | Array of filter rules or nested groups                      |

The `filters` section defines reusable smart filter definitions that can be referenced by name with `--filter <name>`. Each filter supports nested boolean logic with AND/OR groups.

See [Smart Filters with Nested Boolean Logic](#smart-filters-with-nested-boolean-logic) for complete filter syntax, operators, and field reference.

### Example Usage

Create a project-specific config for a music library workflow:

```json
{
  "copy": {
    "hardlink": true,
    "workers": 8,
    "progress": true,
    "trackCompleted": true
  },
  "global": {
    "debug": false
  }
}
```

Then run commands without specifying these options:

```bash
# These options are now defaults from config
rfmedia copy "/music/Artist" /dest --range=001-010

# CLI options still override config
rfmedia copy "/music/Artist" /dest --range=001-010 --workers=2
```

## Development

### Lidarr Similar-Artist Discovery

Discover ranked, attributed recommendations directly from Last.fm:

```bash
# One-hop preview: one Last.fm request and zero Lidarr calls
rfmedia lidarr discover --artist "Radiohead"

# Bounded deep traversal: fixed at depth two, with explicit admission controls
rfmedia lidarr discover \
  --artist "Radiohead" \
  --deep \
  --min-similarity 0.35 \
  --max-per-seed 8

# Text, JSON, YAML, and CSV are supported
rfmedia --output json lidarr discover --artist "Radiohead"
```

The default limit is 15 and the accepted range is 1–100. One-hop preview is the safe default;
`--deep` opts into deterministic breadth-first traversal that never exceeds depth two, 25 provider
requests or visited seeds, or 100 visible candidates. Results distinguish the requested and
Last.fm-resolved seed, preserve the raw 0–1 Last.fm similarity value, assign contiguous visible
ranks, and include an optional MusicBrainz artist ID. Similarity is not confidence or add
eligibility. Every success, including an empty result, retains
`Recommendations provided by Last.fm`, Last.fm links, fetch time, and execution metadata. There is
no provider cache or `--allow-stale`.

Configure the credential in `.rfmedia.yaml`; there is no `--lastfm-api-key`:

```yaml
discovery:
  lastfm:
    apiKey: "{{ LASTFM_API_KEY }}"
    timeoutMs: 15000
```

Template expansion is eager for the whole configuration. If the placeholder is present,
`LASTFM_API_KEY` must exist whenever the file is loaded, including for unrelated commands. Omit the
complete section when the variable should not be required.

An optional handoff can select multiple current visible ranks and writes at most one sealed plan:

```bash
rfmedia lidarr discover \
  --artist "Radiohead" \
  --deep \
  --max-add 3 \
  --add 1,4,7 \
  --root-folder "/music" \
  --quality-profile "Lossless" \
  --plan-file ./radiohead-similar-artist.json

# Explicitly add as monitored and unmonitor selected album types after creation
rfmedia lidarr discover \
  --artist "Radiohead" \
  --add 1 \
  --root-folder "/music" \
  --quality-profile "Lossless" \
  --metadata-profile "Standard" \
  --monitored \
  --unmonitor-types singles,eps \
  --plan-file ./radiohead-monitored-artist.json

# Revalidate and review without mutation
rfmedia lidarr apply ./radiohead-similar-artist.json --dry-run

# Separately approve mutation, interactively or non-interactively
rfmedia lidarr apply ./radiohead-similar-artist.json
rfmedia lidarr apply ./radiohead-similar-artist.json --yes

# Continue verified creation or normalization after an interrupted/uncertain apply
rfmedia lidarr apply ./radiohead-monitored-artist.json --resume
```

Every selected recommendation must have an MBID, and the complete selection is validated before
any plan is written. Add planning proves expected absence from fresh Lidarr state and seals
`monitorNewItems: "none"` and `searchForMissingAlbums: false`. Omission seals `monitored: false`;
`--monitored` is the positive override. When `--metadata-profile` is omitted, planning accepts the
selected root folder's default only if structural primary/secondary album-type evidence proves it
is albums-only; otherwise exactly one structurally eligible profile must exist or planning fails
closed.

Discovery never creates an artist. Apply dispatches each admitted create at most once, persists
possible-dispatch evidence first, never retries or defers artist creation, and reconciles an
ambiguous response through exact-MBID read-back. `--unmonitor-types` seals canonical album-type
selectors for a separate post-create stage: apply reads only the created artist's albums, updates
sorted matching IDs in batches of at most 200, and verifies with a fresh artist-scoped read. Empty
album data or an ambiguous batch remains partial and requires explicit `--resume`; resume uses
durable creation/normalization evidence and never sends a second artist create.

Provider federation, caching, and enrichment are not part of this command. Last.fm API attribution
and terms were checked on 2026-07-25; operators must recheck them for their use and before release.

See [Lidarr Similar-Artist Discovery](docs/features/lidarr-discovery.md) for the complete
configuration, command, output, plan, apply, recovery, attribution, and scope contracts.

### Lidarr Search and Lookup

Lidarr search is read-only: it resolves artist and album identities without adding, editing,
monitoring, refreshing, downloading, or deleting anything.

```bash
# Search artists and albums together
rfmedia lidarr search "Björk"

# Restrict ambiguous results to one type
rfmedia lidarr lookup artist "Björk"
rfmedia lidarr lookup album "Debut"

# Resolve an exact MusicBrainz UUID
rfmedia lidarr lookup artist "mbid:87e748f1-300e-46e4-9524-a4a65d68ae24"
```

All three commands accept `--limit <n>` (default 50, range 1–200), `--offset <n>` (default 0),
`--allow-stale`, `--lidarr-url`, and `--lidarr-api-key`. Paging is deterministic over the complete
ranked result set. Exact `lidarr:`, `lidarrid:`, and `mbid:` terms are validated locally before a
request.

Use the global output flags before `lidarr` for automation:

```bash
rfmedia --json lidarr search "Björk"
rfmedia --output yaml lidarr lookup album "Debut"
rfmedia --output csv lidarr search "Björk" --limit 25 --offset 25
```

JSON and YAML use the standard command/result envelope. CSV emits a summary row before candidate
rows, so empty pages retain query, paging, provider, and execution details. Human output goes to
stderr; machine output goes to stdout.

Live Lidarr is always attempted first. `--allow-stale` permits an exact cached result only for
eligible availability failures; fallback output is explicitly marked degraded and includes cache
age. Without that flag, failures remain failures.

See [Lidarr Search and Lookup](docs/features/lidarr-search-lookup.md) for the complete input, result,
fallback, and output contracts.

### Lidarr Albums

`lidarr albums` is a read-only listing leaf: it filters installed albums by type, monitored state,
and file presence without adding, editing, monitoring, or deleting anything. Exactly one selection
scope is required — `--artist-ids`, `--album-ids`, or an explicit `--all` whole-library scan:

```bash
# List an artist's singles and EPs that are unmonitored
rfmedia lidarr albums --artist-ids 12 --types singles,eps --unmonitored

# Whole-library scan for unmonitored, file-less albums (paged JSON)
rfmedia lidarr albums --all --unmonitored --no-files --limit 100 --offset 200 --output json

# Look up exact albums as CSV
rfmedia lidarr albums --album-ids 55,102 --output csv
```

Filters combine with AND semantics; `--types` selectors OR within the list. `--monitored`/
`--unmonitored` and `--has-files`/`--no-files` are mutually exclusive pairs, and an album with no
`statistics` counts as zero files. Results use a fixed deterministic sort (artist ID, then album ID)
so `--limit` (default 50) and `--offset` (default 0) windows are stable across runs. There is no
`--allow-stale`: album listings are deliberately uncached. Human output is a table on stderr; machine
output is the `{command: "lidarr-albums", result}` envelope on stdout, with CSV emitting a summary
row followed by one row per album.

See [Lidarr Albums](docs/features/lidarr-albums.md) for the complete option, filter, paging, and
output contracts.

### Lidarr Library Health Audit

`lidarr audit` is a strictly read-only diagnostic: it reports library drift, retry backlog, and
media-server reachability without editing monitoring, assigning profiles, deleting anything, or
writing a plan artifact. Eight checks are declared in one frozen registry, and each check's declared
data requirements drive what is retrieved — so a narrow selection is genuinely cheaper:

```bash
# Full audit, human tables on stderr
rfmedia lidarr audit

# Circuit and deferred-intent backlog only — zero Lidarr requests
rfmedia lidarr audit --check retry-backlog

# Album-level checks for two artists (1 + N requests)
rfmedia lidarr audit --deep --artist-ids 12,34

# CI gate: exit 1 when any finding reaches warning
rfmedia lidarr audit --output json --fail-on warning
```

`--check` is validated locally, before any client, database, or adapter is constructed: an unknown
id is rejected, and so is a value carrying no id at all (`--check ""`, the shape an unset CI
variable expands to), so a blank selection fails loudly instead of auditing nothing and passing the
gate.

Findings carry a stable kebab `code`, an `info`/`warning`/`critical` severity, capped subjects with a
true `affected` count, and a remediation whose `command` is always non-mutating — a read command or a
`rfmedia lidarr plan …` artifact command. Every registered check appears in `report.checks` exactly
once with a machine-readable `skipReason`, including the reserved `plex-alignment` slot, which always
skips and directs operators to `rfmedia lidarr reconcile`.

The command is diagnostic by default: even a critical finding leaves the exit code at 0. `--fail-on
<none|info|warning|critical>` is the opt-in CI gate, and it also trips on a `degraded` report so an
incomplete audit never reads green. `--deep` is fail-closed — a partial scan fails the command rather
than producing a wrong report — with `--artist-ids` and the
`lidarr.scheduler.lanes.local-only.operationBudget` config override as the two escape hatches. There
is no `--allow-stale`: no audit cache exists, and a cached audit is misleading.

See [Lidarr Library Health Audit](docs/features/lidarr-audit.md) for the check catalog, the finding
code contract, request costs, the JSON and CSV schemas, and the exit-code table.

### Plex-Lidarr Reconciliation

`lidarr reconcile` is a report-only comparison of one complete Plex music library and one complete
Lidarr artist catalog. A unique one-to-one artist MBID is the only authoritative match.
Normalized-name and fuzzy-name candidates remain review-only, and suggested pairs remain in both
directional gap sets until resolved elsewhere.

```bash
# Read both providers and refresh the complete snapshot-v2 cache
rfmedia lidarr reconcile --plex-library Music

# Replay exactly one compatible cached scope without provider I/O
rfmedia lidarr reconcile --offline --plex-library-id 3

# Add bridge-owned duplicate identity evidence
rfmedia lidarr reconcile --plex-library Music --duplicates
```

Offline mode requires exactly one compatible full scope selected by canonical provider origins and
an optional stable Plex library ID. It reports cache age and stale provenance, never guesses the
newest row, and rejects credentials. A snapshot-v1 cache requires one successful live refresh.

The command emits human output on stderr and JSON, YAML, or fixed-schema CSV on stdout. Gaps,
review suggestions, ambiguity, conflicts, and duplicates are successful report data; invalid or
incomplete evidence is an operational failure. A live run may atomically persist its complete
observational snapshot, but neither mode mutates Plex or Lidarr, changes files, creates a plan, or
offers `--apply`. Mutation policy lives elsewhere: `lidarr policy evaluate` reports consumption-driven
proposals, and `lidarr sync-ratings` seals and applies the rating-driven ones.

See [Plex-Lidarr Reconciliation](docs/features/plex-lidarr-reconciliation.md) for the exact flags,
evidence and overlap rules, output schemas, cache selection, exit behavior, and troubleshooting.

### Lidarr Consumption Policy

`lidarr policy evaluate` joins Plex consumption signals onto the reconciled identity bridge and
reports explainable proposed Lidarr actions. It is **strictly read-only**: it writes nothing to
Plex, nothing to Lidarr, and no plan artifact. `lidarr policy plan` runs that same evaluation and
accounts for every selected proposal, projecting supported proposals into producer cohorts and
unsupported proposals into explicit refusals. Its default is also write-free; only explicit
`--mode plan` may seal artifacts, and it never applies them. Three rules ship, all disabled by
default — `rating-quality-upgrade`, `stale-monitoring-cleanup`, and `discovery-seed`.

Durable `policy.overrides` records can suppress one reviewed proposal without changing its rule or
desired state. Exact key-and-evidence matches render as `ACTIVE SUPPRESSION`; evidence drift or a
missing/changed outcome renders as `STALE — REVIEW REQUIRED`; and an unrun rule renders as
`NOT EVALUATED`. Active and stale proposals are withheld centrally before policy-plan or
ratings-sync cohorts are built. There is no force/allow action or automatic refresh.

```bash
# Zero-config first run: prints every rule, its purpose, and the key that enables it
rfmedia lidarr policy evaluate

# Narrow which rules EVALUATE. This does not reduce the Plex track drain
rfmedia lidarr policy evaluate --rule rating-quality-upgrade

# Inspect one decision's full causal chain. Proposal keys have three segments and
# print on every proposal row; skip keys carry the skip code as a fourth segment
# and print under --verbose
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233
rfmedia lidarr policy evaluate --explain stale-monitoring-cleanup:artist:233:rating-protected

# Machine output, and the opt-in CI gate
rfmedia --output json lidarr policy evaluate --fail-on proposals

# REVIEW ONLY: evaluate and show typed producer cohorts or refusals
rfmedia lidarr policy plan

# Seal only after the entire selected scope passes projection preflight
rfmedia lidarr policy plan --rule rating-quality-upgrade --mode plan
```

The `lidarr policy` parent has two leaves: `evaluate` and `plan`. Evaluate options:

| Option                   | Description                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--plex-library <name>`  | Plex music library to read consumption from; overrides `policy.plexLibrary`                                                                                 |
| `--rule <ids>`           | Run only these rules; repeatable and comma-separated. Default: every **registered** rule                                                                    |
| `--max-proposals <n>`    | One global per-rule proposal cap override, 1-100. There is no `rule=N` syntax                                                                               |
| `--explain <key>`        | Print one decision's identity evidence, observations, threshold checks, and handoff. Human output only — `--output json\|yaml\|csv` emits the full envelope |
| `--fail-on <level>`      | `none` (default) or `proposals`                                                                                                                             |
| `-v, --verbose`          | Show every row instead of the first 20, and every refusal instead of the code rollup                                                                        |
| `--plex-url <url>`       | Override the canonical Plex origin                                                                                                                          |
| `--plex-token <token>`   | Override the Plex token                                                                                                                                     |
| `--lidarr-url <url>`     | Override the canonical Lidarr origin                                                                                                                        |
| `--lidarr-api-key <key>` | Override the Lidarr API key                                                                                                                                 |

Plan options:

| Option                   | Description                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--plex-library <name>`  | Plex music library to read; overrides `policy.plexLibrary`                                              |
| `--rule <ids>`           | Run only these rules; repeatable and comma-separated. Default: every registered rule                    |
| `--max-proposals <n>`    | Per-rule proposal cap override, 1-100                                                                   |
| `--mode <mode>`          | `recommend` (default, no artifacts) or `plan` (seal after a clean global preflight)                     |
| `--explain <key>`        | Append one decision explanation after the full human report; machine formats retain the complete result |
| `-v, --verbose`          | Show every cohort and refusal row instead of the first 20                                               |
| `--plex-url <url>`       | Override the canonical Plex origin                                                                      |
| `--plex-token <token>`   | Override the Plex token                                                                                 |
| `--lidarr-url <url>`     | Override the canonical Lidarr origin                                                                    |
| `--lidarr-api-key <key>` | Override the Lidarr API key                                                                             |

Global `--json` and `--output <json|yaml|csv|table|text>` behave normally. There is no `--apply`,
`--yes`, `--dry-run`, or `--offline`: evaluation is always dry, and the bridge snapshot carries zero
consumption evidence, so an offline run could only emit skips. `degraded` is a report status, not a
`--fail-on` level — a degraded report trips any non-`none` level so an incomplete run never reads
green.

The plan leaf likewise has no `--apply`, `--yes`, `--dry-run`, `--fail-on`, `--plan-file`, output
path, threshold override, or offline mode. Recommend is the dry rung; apply remains a separate
command; and one policy run can produce two independent artifacts, so a single output path would be
ambiguous.

Omitting `--rule` selects **every registered rule**, not only the enabled ones; a rule disabled in
config then reports an explicit `disabled` skip with the key that would enable it, which is why
disabled rules still appear as rows. And **`--rule` is not a cost lever**: every registered rule
either requires `plexTrackPlays` or enriches with it, and the gather plan is the union of `requires`
and `enriches`, so no selection avoids the full-library Plex track drain. `plex.cache.enabled: true`
is the only setting that reduces that cost.

Configuration lives under `policy:` in `.rfmedia.yaml`. It is documented here and in the feature doc
because the generated config template feeds `yaml.dump` and cannot carry comments. Every key is
optional except the three required fields inside each configured override. Unknown keys — including
an unknown rule id — are rejected with an exact property path, and no default is injected by the
validator:

| Key                                                            | Bounds                   | Default               |
| -------------------------------------------------------------- | ------------------------ | --------------------- |
| `policy.plexLibrary`                                           | string                   | `Music`               |
| `policy.rules.rating-quality-upgrade.enabled`                  | boolean                  | `false`               |
| `policy.rules.rating-quality-upgrade.minRating`                | 1.0-5.0 stars            | `4`                   |
| `policy.rules.rating-quality-upgrade.targetQualityProfile`     | profile name or id       | required when enabled |
| `policy.rules.rating-quality-upgrade.maxProposals`             | 1-100                    | `25`                  |
| `policy.rules.stale-monitoring-cleanup.enabled`                | boolean                  | `false`               |
| `policy.rules.stale-monitoring-cleanup.maxPlays`               | 0-1000000                | `0`                   |
| `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` | 1..36,500 whole days     | unset (`null`)        |
| `policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove` | 1.0-5.0 stars, always on | `4`                   |
| `policy.rules.stale-monitoring-cleanup.requireTrackCoverage`   | boolean                  | `true`                |
| `policy.rules.stale-monitoring-cleanup.minTrackFileCount`      | 0-1000000                | `1`                   |
| `policy.rules.stale-monitoring-cleanup.maxProposals`           | 1-100                    | `25`                  |
| `policy.rules.discovery-seed.enabled`                          | boolean                  | `false`               |
| `policy.rules.discovery-seed.minRating`                        | 1.0-5.0 stars            | `5`                   |
| `policy.rules.discovery-seed.minPlays`                         | 0-1000000                | unset                 |
| `policy.rules.discovery-seed.maxSeeds`                         | 1-100                    | `10`                  |
| `policy.overrides."<proposal-key>".action`                     | exactly `suppress`       | required              |
| `policy.overrides."<proposal-key>".evidenceFingerprint`        | full lowercase SHA-256   | required              |
| `policy.overrides."<proposal-key>".reason`                     | 1-512 UTF-8 bytes        | required              |

Recency is opt-in and conjunctive with the lifetime-play ceiling. For example:

```yaml
policy:
  rules:
    stale-monitoring-cleanup:
      enabled: true
      maxPlays: 5
      minDaysSinceLastViewed: 90
```

This admits only artists with at most five lifetime plays **and** no trustworthy view in the last
90 days, measured as 86,400 seconds each. The `maxPlays: 0` default cannot admit a previously
viewed artist, however old its latest view is, so raise it deliberately. Omit
`minDaysSinceLastViewed` for legacy absolute-play-only behavior.

Copy the stable proposal key and full fingerprint from `--explain`, record why the decision is
being suppressed, then rerun the original command and verify its lifecycle state:

```yaml
policy:
  overrides:
    "stale-monitoring-cleanup:artist:233":
      action: suppress
      evidenceFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      reason: "Compilation listening is intentionally excluded from this decision"
```

Only three-segment proposal keys are accepted; a refusal/skip cannot be overridden. The reason must
be trimmed and terminal-safe. For `evidence-changed`, review the full current evidence and either
replace the fingerprint or remove the record. For `outcome-changed`, retain the real skip and update
only if a proposal returns. For `decision-absent`, investigate identity/convergence and remove only
if obsolete because there is no current hash. `NOT EVALUATED` requires an enabled, selected rerun
before changing the record.

`lidarr policy evaluate`, `lidarr policy plan`, and `lidarr sync-ratings` load the
highest-precedence config strictly. A read, unresolved/malformed template, parse, or validation
failure aborts before evidence gathering, producer calls, prompts, sealing, or apply; these commands
never fall through to a lower-priority or empty config that could erase a suppression.

The rating veto `protectRatingAtOrAbove` is **always active** — the schema admits a finite `1.0`-`5.0`
value and nothing else, so there is no disabling value; `5` is the narrowest setting. Writing `null`
there fails validation and aborts an override-sensitive policy or ratings command on that
authoritative config.

**Three behaviors and limits must be understood before enabling
`stale-monitoring-cleanup`.** Plex play counts and `lastViewedAt` timestamps belong to the single
account behind the resolved token or enrolled credential, so the wrong account can expose zeros,
missing timestamps, or stale timestamps that look correct. Recency is opt-in: with
`minDaysSinceLastViewed` unset, `stale` retains legacy low-absolute-play behavior; when set, the age
threshold is an additional conjunct after `maxPlays`. Consumption evidence is bucketed under the
**album** artist (`grandparentTitle`) through the weak `normalized-name` join, so compilation-only
listening does not reach a performer's own bucket. The engine refuses the whole rule when the
library-wide play total is zero and prints `totalPlaysObserved` on every run, but only the operator
can catch a partially wrong account.

With recency enabled, an artist whose joined tracks all omit `lastViewedAt` is refused with
`no-recency-coverage`; a played joined row without a timestamp yields
`partial-recency-coverage`, even if another row carries one. Never-viewed artists are therefore
refused rather than treated as ancient. `--explain` shows the raw timestamp observation, its
`normalized-name` join, and a stable ISO `older-than-days` check with the exact config path. The
fingerprint stores the raw timestamp and configured bound, not computed age, so time passage alone
does not stale an override. A new view or threshold change yields `evidence-changed` if the subject
still proposes, or `outcome-changed` if recency now refuses it.

The policy-plan handoff is total and fail-closed. `artist-profile-assignment` proposals route to the
existing profile producer, and `artist-monitoring` proposals route to the existing monitoring
producer. `discovery` remains an inert refusal and is never converted to `artist-add`. In plan mode,
a selected rule skipped as `signal-unavailable`, `consumption-signal-empty`, or `rule-error` fails
through the redacted projection-failure envelope before any producer runs; only `not-selected` and
intentionally `disabled` outcomes are safe to ignore for sealing. A discovery proposal, a
conflicting same-artist intent, or any other refusal also blocks **all** writes; no proposal is
silently omitted to create a smaller artifact. No proposals is a successful `no-changes` result and
creates no empty artifact. Recommend mode retains rule-level skips and degraded evaluation status
in its complete write-free review.

The workflow keeps review, sealing, and apply separate:

```bash
# 1. Review a fresh evaluation and total projection. Writes no plan artifact.
rfmedia lidarr policy plan --rule stale-monitoring-cleanup

# 2. Re-evaluate and explicitly seal through the existing fresh-state producer.
rfmedia lidarr policy plan --rule stale-monitoring-cleanup --mode plan

# 3. Apply one artifact separately with the identity and checksum just printed.
rfmedia lidarr apply ~/.config/rfmedia/plans/lidarr-<stamp>-<id8>.json \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <sha256-checksum>
```

The suggested apply command intentionally omits `--yes`; sealing is not apply consent. Each
producer re-reads live Lidarr state and writes an unchanged strict `rfmedia.lidarr-plan.v3`
artifact. The profile producer re-reads artists and quality profiles; the monitoring producer
re-reads artists. Policy keys, thresholds, and rationale stay in the
`rfmedia.lidarr-policy-plan.v1` result beside the artifact path, ID, and checksum — never in the
artifact's exact-key schema. Retain `rfmedia --output json lidarr policy plan --mode plan` output
when that provenance matters.

Policy-plan status is one of `reviewed`, `no-changes`, `refused`, `sealed`, `partial`, or `failed`.
Human output spells those states as `REVIEW ONLY`, `NO CHANGES`, `REFUSED`, `SEALED`, `PARTIAL`, and
`FAILED`. Recommend reviews and plan-mode `no-changes`/`sealed` results exit 0; plan-mode `refused`,
`partial`, and `failed` results exit 1 after rendering. A projection invariant instead uses the
standard redacted failure envelope. JSON/YAML emit the full versioned result, while CSV emits fixed
`summary`, `rule`, `cohort`, `proposal`, `skip`, `refusal`, and `artifact` rows.

The embedded evaluation is `rfmedia.lidarr-consumption-policy.v3` with engine version 3, full
proposal fingerprints, explicit override results, and actionable-only proposal counts. The outer
policy-plan result remains `rfmedia.lidarr-policy-plan.v1`; sealed producer artifacts remain the
unchanged `rfmedia.lidarr-plan.v3` contract. CSV also includes fixed `override` rows with full
expected/current hashes and formula-guarded rationale cells.

Artifacts seal sequentially in producer order and are not transactional. If a later producer fails,
the result is `partial`, retains the earlier artifact metadata, exits nonzero after rendering, and
never deletes the valid inert artifact as rollback. The command does not apply or auto-apply,
execute `handoff.argv`, add plan operations or schemas, execute discovery, persist recency history, or
edit/refresh override config. Overrides affect new evaluations and same-run projections only; they
do not revoke or rewrite an artifact that was already sealed. The original #209 guarantee remains
intact: `policy evaluate` itself is unchanged and write-free.

See [Lidarr Consumption Policy](docs/features/lidarr-consumption-policy.md) for the decision- and
skip-code catalogues, the per-rule threshold tables and safety gates, the commented `policy:` YAML,
the normalized-name join hazards, the JSON and CSV schemas, and troubleshooting.

### Lidarr Ratings Sync

`lidarr sync-ratings` turns Plex ratings and consumption signals into Lidarr monitoring and quality-profile
changes. It invents no decision of its own: it runs the shipped `rating-quality-upgrade` and
`stale-monitoring-cleanup` rules through the same evaluation `lidarr policy evaluate` performs,
embeds that report verbatim, and projects it onto the two shipped producers. `discovery-seed` is
structurally unreachable here — its descriptor names no producer. Ratings are never written back to
Plex under any flag combination.

The safety ladder is one value-taking `--mode`, never a boolean `--apply`: `--apply` already means a
_plan file_ elsewhere in this CLI (`copy --apply <plan-file>`), and one flag name may not carry two
incompatible types.

| Invocation                        | Reads Plex + Lidarr | Seals plan artifacts | Mutates Lidarr |
| --------------------------------- | ------------------- | -------------------- | -------------- |
| `sync-ratings` (default)          | yes                 | no                   | no             |
| `sync-ratings --mode plan`        | yes                 | yes (0-2)            | no             |
| `sync-ratings --mode apply --yes` | yes                 | yes (0-2)            | yes            |

```bash
# Default rung: report only. No producer runs and nothing is sealed
rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless

# Seal one reviewable v3 artifact per non-empty cohort. Still zero mutations
rfmedia lidarr sync-ratings --min-stars 4.5 --quality-profile Lossless --mode plan

# Seal, then apply each artifact through the existing apply lifecycle
rfmedia lidarr sync-ratings --decision monitoring --max-plays 0 --mode apply --yes

# Inspect one decision's full causal chain; keys are the shipped policy keys
rfmedia lidarr sync-ratings --explain stale-monitoring-cleanup:artist:233
```

Options:

| Option                    | Description                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--plex-library <name>`   | Plex music library the ratings and plays drain scopes to; overrides `policy.plexLibrary`                                           |
| `--decision <kinds>`      | Consider only these decisions; repeatable and comma-separated. Values: `quality-profile`, `monitoring`. Default: both              |
| `--min-stars <n>`         | Plex star floor for a quality upgrade, 1-5 inclusive, decimals allowed. Overrides only `rating-quality-upgrade.minRating`          |
| `--max-plays <n>`         | Inclusive lifetime-play ceiling for unmonitoring, 0-1000000; remains conjunctive with configured recency                           |
| `--quality-profile <ref>` | Target Lidarr quality profile, by name or numeric id. **Numeric ids resolve first**                                                |
| `--max-proposals <n>`     | Per-rule proposal cap, 1-100. Not a run total; it replaces each rule's own cap (`rating` 25, `stale` 25, `seed` 10)                |
| `--mode <mode>`           | Safety rung: `recommend` (default), `plan`, or `apply`                                                                             |
| `--yes`                   | Approve each apply without an interactive prompt. Required whenever output is a machine format or stdout is not an interactive TTY |
| `--explain <key>`         | Print one decision's full causal chain. Human output only — `--output json\|yaml\|csv` emits the full envelope                     |
| `-v, --verbose`           | Show every row instead of the first 20                                                                                             |
| `--plex-url <url>`        | Override the canonical Plex origin                                                                                                 |
| `--plex-token <token>`    | Override the Plex token                                                                                                            |
| `--lidarr-url <url>`      | Override the canonical Lidarr origin                                                                                               |
| `--lidarr-api-key <key>`  | Override the Lidarr API key                                                                                                        |

Four threshold semantics are easy to misread. `--quality-profile` is resolved by the engine against
the **live** profile list with `Number()` tried before any name match, so a profile literally named
`"320"` or `"3.0"` resolves to whichever profile carries that **id** — the report echoes the resolved
id and name together, so check that pair before `--mode apply`. `--max-plays` is always an
**absolute lifetime** ceiling. Config-only `minDaysSinceLastViewed` optionally adds recency, but does
not replace that ceiling; raise `--max-plays` above `0` if viewed old artists should qualify.
`--max-proposals` caps each rule separately, so `--max-proposals 10` permits up to 10 profile
changes **and** 10 monitoring changes.

No command-specific threshold key exists. Every threshold falls back to the same `policy:` block
the consumption policy documents, and the command also consumes its shared `policy.overrides`
mapping. Each cohort's proposals carry the rule's own gates unchanged:

| Key                                                            | Bounds                   | Default | Flag override       |
| -------------------------------------------------------------- | ------------------------ | ------- | ------------------- |
| `policy.plexLibrary`                                           | string                   | `Music` | `--plex-library`    |
| `policy.rules.rating-quality-upgrade.enabled`                  | boolean                  | unset   | none (tri-state)    |
| `policy.rules.rating-quality-upgrade.minRating`                | 1.0-5.0 stars            | `4`     | `--min-stars`       |
| `policy.rules.rating-quality-upgrade.targetQualityProfile`     | profile name or id       | unset   | `--quality-profile` |
| `policy.rules.rating-quality-upgrade.maxProposals`             | 1-100                    | `25`    | `--max-proposals`   |
| `policy.rules.stale-monitoring-cleanup.enabled`                | boolean                  | unset   | none (tri-state)    |
| `policy.rules.stale-monitoring-cleanup.maxPlays`               | 0-1000000                | `0`     | `--max-plays`       |
| `policy.rules.stale-monitoring-cleanup.minDaysSinceLastViewed` | 1..36,500 whole days     | unset   | none                |
| `policy.rules.stale-monitoring-cleanup.protectRatingAtOrAbove` | 1.0-5.0 stars, always on | `4`     | none                |
| `policy.rules.stale-monitoring-cleanup.requireTrackCoverage`   | boolean                  | `true`  | none                |
| `policy.rules.stale-monitoring-cleanup.minTrackFileCount`      | 0-1000000                | `1`     | none                |
| `policy.rules.stale-monitoring-cleanup.maxProposals`           | 1-100                    | `25`    | `--max-proposals`   |

`enabled` is read as a **tri-state**, from the raw config rather than from the evaluation report.
Never configured means this command enables the rule for the run — a ratings sync you asked for
should not require enabling a rule first. An explicit `false` is honoured as a refusal
(`decision-disabled`), and no flag overrides it. `true` behaves exactly as it does under
`policy evaluate`. Selecting the `quality-profile` decision with neither `--quality-profile` nor
`policy.rules.rating-quality-upgrade.targetQualityProfile` set is refused locally, before any Plex
read.

Withheld changes are data, never omissions: `decision-disabled`, `rule-not-evaluated`, and
`cross-decision-conflict` each name the cause and the exact key or flag that clears it. An artist
proposed by both decisions is withheld from both, because the two artifacts apply independently with
no ordering guarantee. Exit code is `0` on success and `1` when a run fails or when an applied
artifact reports `failed` or `partial`, always after rendering.

The human report always includes override state. Its outer machine envelope remains
`rfmedia.lidarr-ratings-sync.v1`, while `result.evaluation` is the full policy v3 report; CSV reuses
the policy projection, including override rows and full hashes. Active and stale records never enter
new sync cohorts, and capped cohorts are not refilled after withholding. Previously sealed v3
artifacts are unaffected and retain their independent checksum/drift/apply gates.

See [Lidarr Ratings Sync](docs/features/lidarr-ratings-sync.md) for the decision catalogue, the
per-rung write-safety envelope, the refusal and threshold-provenance schemas, the JSON and CSV
output shapes, and troubleshooting.

### Lidarr Quality Presets

`lidarr presets` manages additive desired-state packs for custom formats, quality profiles, and
naming. It ships immutable `balanced@1`, `lossless@1`, and `space-saver@1` policies and accepts
strict self-contained packs from `lidarr.profilePresets`.

```bash
# Offline discovery
rfmedia lidarr presets list
rfmedia lidarr presets show builtin:balanced

# Fresh read-only review and zero-write apply preview
rfmedia lidarr presets diff builtin:balanced
rfmedia lidarr presets apply builtin:balanced --dry-run

# Interactive or explicitly approved non-interactive apply
rfmedia lidarr presets apply builtin:balanced
rfmedia lidarr presets apply config:vinyl-archive --yes

# Stable machine results
rfmedia --output json lidarr presets diff builtin:lossless
```

Real apply repeats the complete review while holding a local canonical-origin lock, writes custom
formats before refreshed complete quality profiles and naming, journals every dispatch boundary,
and verifies fresh state after each write. It never prunes resources, reassigns artists, searches,
downloads, or renames existing files.

See [Lidarr Quality Presets](docs/features/lidarr-quality-presets.md) for exact built-in
versions/digests and tradeoffs, configured-pack schema, ownership, capability checks, output and
exit contracts, locking, journals, and partial/uncertain recovery.

### Lidarr Import Validation and Track Filtering

Validate how Lidarr would match a local album folder without importing it:

```bash
rfmedia lidarr validate-import /incoming/Artist/Album --artist-id 42
rfmedia --output json lidarr validate-import /incoming/Artist/Album --fail-on ambiguous
```

The complete report classifies each candidate as `ready`, `unmatched`, `ambiguous`, or `rejected`.
The optional `--fail-on` gate runs only after output is rendered.

Post-acquisition filtering is exact-album and preview-first. Explicit track IDs and the local
embedded-rating threshold are unioned; uncertain files are always retained with warnings:

```bash
# Preview only
rfmedia lidarr plan track-filter \
  --album-id 4501 \
  --keep-track-ids 101,102 \
  --min-stars 3

# Seal and apply the exact reviewed trackfile candidates
rfmedia lidarr plan track-filter \
  --album-id 4501 \
  --keep-track-ids 101,102 \
  --min-stars 3 \
  --out ./track-filter.json

rfmedia lidarr apply ./track-filter.json --dry-run
rfmedia lidarr apply ./track-filter.json --allow-file-delete --yes
```

The default maximum is 100 deletion candidates. Apply revalidates exact Lidarr ID, album, artist,
path, size, and presence, uses Lidarr's managed trackfile deletion endpoint, and verifies absence.
There is no automatic mutation retry, deferred intent, direct filesystem deletion, or trash
guarantee.

See [Lidarr Import Validation and Track Filtering](docs/features/lidarr-import-validation-track-filtering.md)
for classifications, retention rules, safety behavior, output formats, and recovery.

### Lidarr Mutation Plan/Apply

Lidarr writes use a sealed review artifact and a separate apply gate. New mutation plans use
`rfmedia.lidarr-plan.v3` and checksum-seal a static cascade analysis beside the reviewed operation.
It reports immediate and conditional effects, whether values are exact, modelled, or unknown, and
advisory comparisons with optional operator-chosen per-plan allowances.

Configure only the policy values that are meaningful for the deployment:

```yaml
lidarr:
  cascadeAnalysis:
    budgets:
      indexerQueries: 240
      acquisitionCandidates: 80
    assumptions:
      albumsPerArtist: 12
      indexerQueriesPerCandidate: 3
```

These numbers are examples, not defaults. Each field is optional and must be a positive integer no
greater than 1,000,000. Omitted allowances are `not-configured`; omitted assumptions make dependent
values `unknown`. A known zero is always shown as `0`, never as unknown.

This analysis is static, conditional plan-time evidence. It does not read live Prowlarr usage,
measure provider or download-client capacity, predict elapsed time, replace scheduler lane
`operationBudget`, or enforce apply. `within`, `exceeded`, and `unknown` allowance states produce
review evidence and stable warning/recommendation codes; they do not authorize, block, reorder, or
truncate mutations. Apply displays the analysis sealed in the artifact and does not reinterpret it
from current configuration. Legacy v1/v2 artifacts remain readable and display
`Cascade analysis: NOT RECORDED (legacy plan)`.

Human plan/apply output writes a compact cascade block to stderr. JSON and YAML retain the complete
structured analysis in the normal envelope; CSV emits bounded aggregate
`result.cascade.*` fields, including status, metric values, allowance assessments, warnings, and
recommendations. See
[Lidarr Mutation Plan/Apply](docs/features/lidarr-plan-apply.md#sealed-cascade-analysis) for metric,
certainty, horizon, basis, code, and output contracts.

Create a profile assignment plan with a quality profile, a metadata profile, or both:

```bash
rfmedia lidarr plan artist-profiles \
  --ids 12,34 \
  --quality-profile 3 \
  --metadata-profile "name:Standard" \
  --plan-file ./lidarr-profiles.json
```

Artist deletion uses the same gate. Exactly one artist selection mode is required: `--ids`,
AND-combined `--select-*` filters, or explicit `--all`. Omit `--delete-files` to keep
Lidarr-managed files; add it only when the reviewed plan should ask Lidarr to delete them:

```bash
# Preview the complete keep-files plan without writing an artifact
rfmedia lidarr plan artist-delete --ids 12,34 --dry-run

# Seal a keep-files plan
rfmedia lidarr plan artist-delete --ids 12,34 \
  --plan-file ./lidarr-artist-delete.json

# Seal a delete-files plan selected by AND-combined filters
rfmedia lidarr plan artist-delete \
  --select-unmonitored \
  --select-tag Archive \
  --delete-files \
  --plan-file ./lidarr-artist-delete-files.json
```

Each selected artist must have complete Lidarr-reported evidence: artist name and ID, path, album
count, track-file count, and exact bytes. The preview and artifact retain every row plus aggregate
totals. This is Lidarr's view of managed impact, not a promise about reclaimed disk blocks;
`rfmedia` never walks, stats, or deletes local media paths itself.

The `album-monitoring` operation plans album-type or exact-ID album monitoring changes (the bulk
unmonitor lane). Iterate with `--dry-run` first — it prints the selection count summaries and
writes nothing — then drop the flag to seal the reviewed plan:

```bash
# Iterate on selectors safely — prints counts, writes nothing
rfmedia lidarr plan album-monitoring --unmonitored --types singles,eps,compilations --dry-run

# Seal the reviewed plan (scope selectors with --artist-ids when needed)
rfmedia lidarr plan album-monitoring --unmonitored --types singles,eps --artist-ids 12,34 --max-batch 300

# Execute through the unchanged apply gate
rfmedia lidarr apply ~/.config/rfmedia/plans/<lidarr-plan>.json --yes

# Precise undo: re-monitor exactly what a previous plan changed
rfmedia lidarr plan album-monitoring --monitored \
  --album-ids "$(jq -r '[.entries[].albumId]|join(",")' <old-plan>.json)"
```

Album-type selectors are a closed, case-insensitive vocabulary; singular aliases (`single`,
`ep`, …) are accepted and canonicalized:

| Selector group       | Canonical tokens                                                      |
| -------------------- | --------------------------------------------------------------------- |
| Primary album type   | `albums`, `eps`, `singles`, `broadcasts`, `others`                    |
| Secondary album type | `compilations`, `live`, `remixes`, `soundtracks`, `demos`, `mixtapes` |

Keep `--max-batch` at or below 400 per plan for predictable apply-time lane budgets. Known
limitation: an unscoped selector scan of a very large library (roughly 1000+ artists) exhausts
the local-only lane budget and fails closed rather than producing a partial plan — narrow the
scan with `--artist-ids` across successive plans.

Tag add and remove plans preserve unrelated tags:

```bash
rfmedia lidarr plan artist-tags \
  --select-unmonitored \
  --add-tag Favorites \
  --plan-file ./lidarr-tags-add.json

rfmedia lidarr plan artist-tags \
  --select-tag "Needs Review" \
  --remove-tag "name:Needs Review" \
  --plan-file ./lidarr-tags-remove.json
```

Tag set and clear replace the complete tag set and are treated as destructive:

```bash
rfmedia lidarr plan artist-tags --ids 12,34 \
  --set-tag Favorites --set-tag 14 \
  --plan-file ./lidarr-tags-set.json

rfmedia lidarr plan artist-tags --ids 12,34 \
  --clear-tags \
  --plan-file ./lidarr-tags-clear.json
```

Positive decimal references select resource IDs. Other references use case-insensitive exact names;
`name:<value>` forces name lookup. Plans can select exact IDs, an explicit `--all`, or AND-combined
`--select-*` filters. Review the artifact before applying it:

```bash
# Validate current state without mutation or history writes
rfmedia lidarr apply ./lidarr-profiles.json --dry-run

# Validate the reviewed artist-delete evidence without authorization or mutation
rfmedia lidarr apply ./lidarr-artist-delete-files.json --dry-run

# Apply after review; --yes is required for non-interactive use
rfmedia lidarr apply ./lidarr-profiles.json --yes

# Tag set/clear requires separate replacement authorization
rfmedia lidarr apply ./lidarr-tags-set.json --yes --allow-tag-replacement

# Apply a keep-files artist deletion after interactive confirmation
rfmedia lidarr apply ./lidarr-artist-delete.json --allow-artist-delete

# Apply a file-deleting plan non-interactively and request an eligible Plex scan
rfmedia lidarr apply ./lidarr-artist-delete-files.json \
  --allow-artist-delete \
  --allow-file-delete \
  --plex-scan \
  --yes

# Resume only the reviewed file-deleting plan after an incomplete or uncertain apply
rfmedia lidarr apply ./lidarr-artist-delete-files.json \
  --resume \
  --allow-artist-delete \
  --allow-file-delete \
  --expected-plan-id <plan-id> \
  --expected-plan-checksum <checksum> \
  --yes
```

Planning `--dry-run` builds the complete preview but writes no plan. Apply `--dry-run` validates the
artifact and classifies current Lidarr state without a claim, history write, deletion, or Plex
scan. Real artist deletion always needs `--allow-artist-delete`; delete-files plans also need
`--allow-file-delete`. These authorization flags do not imply `--yes`, which only bypasses the
default-no prompt.

Apply checks the whole cohort for path/count/byte drift before the first mutation and rereads each
artist immediately before its single-ID delete. A newly dispatched deletion is `succeeded` only
after targeted verification proves the artist absent. On explicit resume, absence is `satisfied`
only when matching durable possible-dispatch evidence exists; an unexplained initial absence is
stale. Inconclusive state is `uncertain`, stops later admissions, and requires the pinned resume
command. Artist deletes have no automatic mutation retry, deferred replay, or batch editor call.

`--plex-scan` is an apply-time request, not sealed plan intent. One best-effort scan is eligible
after a newly verified delete-files success with non-zero reviewed track-file or byte impact,
including during a partial apply. Ineligible and dry-run scans are skipped; unavailable or failed
scans are reported separately and never change or replay a Lidarr deletion result.

Exact-ID monitoring plans remain available through
`rfmedia lidarr plan artist-monitoring --ids 12,34 --unmonitored`.

Album release-policy edits and album deletion ride the same sealed plan/apply boundary. Edit plans
flip only `anyReleaseOk` for matched albums; deletion is the first file-destructive Lidarr lane, so
its destruction mode is decided and sealed at plan time and gated by dedicated apply-time
authorization flags:

```bash
# Preview a delete plan without writing an artifact
rfmedia lidarr plan album-delete --artist-ids 12 --types demos,mixtapes --dry-run

# Seal a library-removal plan for exact albums, deleting files on disk
rfmedia lidarr plan album-delete --album-ids 4501,4502 --delete-files --plan-file plans/del.json

# Apply it: destructive album deletion needs both authorization flags in addition to --yes
rfmedia lidarr apply plans/del.json --yes --allow-album-deletion --allow-file-deletion

# Plan a release-policy edit (require the monitored release) for an artist's albums
rfmedia lidarr plan album-edit --artist-ids 42 --types albums --no-any-release-ok --plan-file edit.json
```

Album deletion has no `--all` scope: a selector-mode plan requires an explicit `--artist-ids`
(optionally narrowed by `--types`), and monitored albums are excluded by default unless
`--include-monitored` is passed. `--delete-files` and `--add-import-list-exclusion` are sealed into
the checksummed artifact and cannot be escalated at apply time.

Authorization flags are distinct from the `--yes` approval and are never satisfied by it. `--yes`
only confirms the mutation for non-interactive use; a real apply still fails closed without the
matching authorization flag. Dry-run applies need none of them.

| Apply flag                | Required when                                       | Purpose                                              |
| ------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `--allow-tag-replacement` | The plan is an artist tag set or clear              | Authorize destructive replacement of the tag set     |
| `--allow-album-deletion`  | The plan is `album-delete` (any real apply)         | Authorize removing albums from the Lidarr library    |
| `--allow-file-deletion`   | The sealed `album-delete` plan has `--delete-files` | Additionally authorize permanent track-file deletion |

Album-edit applies are non-destructive and need no authorization flag — they keep the standard
review, confirm, and `--yes` flow.

See [Lidarr Mutation Plan/Apply](docs/features/lidarr-plan-apply.md) for artifact security,
selection and reference semantics, confirmation rules, live-state drift checks, durable history,
targeted write verification, recovery, and output formats.

### Lidarr Execution Lanes

Every Lidarr action is scheduled in one of four isolated lanes: `local-only`,
`metadata-dependent`, `discovery`, or `destructive`. Each lane has its own concurrency limit,
per-batch operation budget, retry allowance, and retry-delay cap. A plan's reviewed risk
classification remains separate from its scheduler lane. Plan/apply uses its own cap, exclusive
claim, per-artist ordering, durable history, and recovery contract. Artist-add target and
verification reads use `local-only`; planning and each create or post-add normalization dispatch use
the required `metadata-dependent` health/circuit preflight. Non-idempotent writes have zero
automatic retries.

Artist creation and post-add normalization are non-deferable. Their durable
`create-pending`, `creation-verified-normalization-pending`,
`normalization-verification-pending`, and `completed` stages belong to plan history, not the generic
deferred-intent queue. Generic deferred replay never sends an artist create or normalization batch.

Successful human and machine output includes additive execution metadata. Classified failures also
include the lane, attempt count, failure type, HTTP status, retryability, and `Retry-After` when
available. These controls are configuration-only; no scheduler flags or subcommands were added.

See [Lidarr Execution Lanes](docs/features/lidarr-execution-lanes.md) for defaults, validation
bounds, configuration, retry behavior, output examples, and mutation boundaries.

### Lidarr Client Generation

The private Lidarr SDK is generated from a committed, immutable OpenAPI snapshot. Generated files
are committed and replace-only; do not edit files under `src/lib/lidarr/generated/` manually. See
[Lidarr Generated Client](docs/features/lidarr-generated-client.md) for the architecture, provenance,
security controls, review procedure, and rollback runbook.

Run these maintainer commands from the repository root:

```bash
# Offline regeneration from the checked-in snapshot
npm run codegen:lidarr --workspace packages/rfmedia-cli

# Offline, non-mutating full-tree drift check
npm run codegen:lidarr:check --workspace packages/rfmedia-cli

# Offline generator and mocked-refresh tooling tests
npm run test:codegen:lidarr --workspace packages/rfmedia-cli

# Explicit network refresh from one immutable upstream commit
npm run openapi:lidarr:refresh --workspace packages/rfmedia-cli -- <40-hex-commit>
```

Only the explicit refresh command contacts the upstream GitHub endpoints. Ordinary install, build,
typecheck, tests, runtime use, and CI never refresh from GitHub or contact Lidarr. An install may use
the configured npm registry for dependencies; it does not fetch the upstream schema.

### Testing

The project uses [Vitest](https://vitest.dev/) as its testing framework with comprehensive test coverage across core modules.

#### Test Commands

```bash
# Run tests in watch mode (development)
npm test

# Run tests once (CI/pre-commit)
npm run test:run

# Run tests with coverage report
npm run test:coverage

# Run a specific test file
npm run test:run -- src/lib/inventory.test.ts

# Run tests matching a pattern
npm run test:run -- --grep "granular tracking"
```

#### Test Files

| File                                | Tests | Description                                                                    |
| ----------------------------------- | ----- | ------------------------------------------------------------------------------ |
| `src/lib/inventory.test.ts`         | 42    | Sync diff detection, database and legacy inventory routing                     |
| `src/lib/completed-tracker.test.ts` | 40    | Granular tracking, range expansion, options hash generation                    |
| `src/lib/ratings.test.ts`           | 45+   | Smart filter evaluation: leaf rules, groups, nested logic, edge cases          |
| `src/actions/copy-filter.test.ts`   | 16    | Smart filter integration: end-to-end workflow, backward compatibility, dry-run |

#### Testing Patterns

The test suite follows these patterns:

- **Real databases**: Tests use actual SQLite databases created in temporary directories, not mocks
- **Temporary directories**: Each test suite creates isolated temp directories via `mkdtemp()` and cleans up in `afterEach()`
- **No mocking for unit tests**: File system and database operations use real implementations to catch integration issues
- **Comprehensive edge cases**: Tests cover range expansion, empty states, error conditions, and boundary values
- **Integration tests use controlled mocks**: Action-level tests mock external dependencies (audio discovery, metadata reading, filesystem operations) for deterministic behavior

#### Mock Lifecycle Best Practices

When writing integration tests that use mocks, follow these guidelines to avoid test interference:

**Use `vi.clearAllMocks()` instead of `vi.resetAllMocks()` in `afterEach` hooks:**

```typescript
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  vi.clearAllMocks(); // Clears call history, preserves mock implementations
});
```

- `vi.clearAllMocks()` - Clears mock call history while preserving mock implementations
- `vi.resetAllMocks()` - Resets mock implementations to `undefined`, breaking subsequent tests

**Initialize mock implementations in `beforeEach`:**

```typescript
beforeEach(async () => {
  // ... setup temp directories ...
  vi.clearAllMocks();

  // Re-apply default mock implementations
  mockGetFileSize.mockResolvedValue(10485760);
  mockCopyOrLink.mockResolvedValue(undefined);
});
```

**Mock config loading to prevent tracking system interference:**

```typescript
vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    copy: { trackCompleted: false },
    tracking: { useLegacy: false, database: undefined },
    undo: { enabled: false },
  }),
}));
```

**Disable tracking in test options:**

```typescript
const options = createFilterCopyOptions(filter, {
  trackCompleted: false, // Prevents database initialization in tests
});
```

#### Running Smart Filter Integration Tests

```bash
# Run all smart filter tests
npm run test:run -- src/actions/copy-filter.test.ts
npm run test:run -- src/lib/ratings.test.ts

# Run specific test suites
npm run test:run -- --grep "Smart Filter"
npm run test:run -- --grep "evaluateSmartFilterRule"

# Run with verbose output
npm run test:run -- src/actions/copy-filter.test.ts --reporter=verbose
```

#### Known Test Limitations

Current test coverage has these known limitations:

1. **Smart filter integration tests**: 9/16 tests passing. Some tests require additional mock configuration for complex album mode scenarios
2. **Album mode with smart filters**: Tests for `albumMode: true` with range suffixes need enhanced mock setup for hardlink operations
3. **Parallel worker tests**: Tests use `workers: 1` to ensure deterministic execution order

#### Coverage Targets

Current coverage levels:

- `inventory.ts`: ~75% line coverage
- `completed-tracker.ts`: ~64% line coverage

Run `npm run test:coverage` to generate a detailed coverage report.

#### Example Test Structure

```typescript
describe("Database granular tracking", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-test-"));
    dbPath = join(tempDir, "tracking.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should record and retrieve completed album copies", async () => {
    // Test implementation using real database
  });
});
```

### Type Checking

```bash
npm run typecheck
```

### Building

```bash
npm run build
```

### Cleaning

```bash
npm run clean
```

## License

rfmedia is MIT licensed. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for vendored and generated
materials.
