# Multiple Source Arguments

This document describes the multiple source arguments feature for the copy command, which allows processing multiple source paths in a single command invocation.

## Overview

The copy command now supports variadic source arguments, enabling users to specify multiple source paths directly on the command line. Each source path can optionally include its own range suffix, providing fine-grained control over album numbering sequences.

## User Interface

### Command Line Syntax

```bash
# Single source (unchanged)
rfmedia copy <source> <destination> --range=001-005

# Multiple sources (new)
rfmedia copy <source1> <source2> ... <sourceN> <destination>

# Multiple sources with per-path ranges
rfmedia copy <path1>,<range1> <path2>,<range2> ... <destination>
```

### Basic Examples

```bash
# Copy three artists with the same range
rfmedia copy /music/Artist1 /music/Artist2 /music/Artist3 /dest --range=001-005

# Copy with per-path ranges
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
  --range=005-008
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Copy Command                              │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse <paths...> variadic argument                          │
│  2. Detect mode: --file (destination only) vs multi-source      │
│  3. Extract destination (last path, must not have range suffix) │
│  4. Parse each source for optional range suffix                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Path Parsing (copy.ts)                       │
├─────────────────────────────────────────────────────────────────┤
│  parsePathWithRange(pathString):                                │
│  1. Find last comma in path                                     │
│  2. Check if suffix after comma is valid range (NNN-NNN)        │
│  3. Return PathEntry { path, range? }                           │
│                                                                 │
│  hasRangeSuffix(pathString):                                    │
│  - Validates destination doesn't have range suffix              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Mode Detection                               │
├─────────────────────────────────────────────────────────────────┤
│  Album mode triggers when ANY of:                               │
│  - CLI --range option provided                                  │
│  - CLI --count option provided                                  │
│  - config.copy.range is set                                     │
│  - --file option provided                                       │
│  - CLI source entries provided (may have per-path ranges)       │
│                                                                 │
│  Filter mode triggers when:                                     │
│  - --min-stars or --min-rating provided                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│               Action Handler (copy-album.ts / copy-filter.ts)   │
├─────────────────────────────────────────────────────────────────┤
│  Source Resolution Priority:                                    │
│  1. options.cliSourceEntries (CLI multi-source)                 │
│  2. options.file (file-based input)                             │
│  3. source argument (single source)                             │
│                                                                 │
│  Range Resolution Priority (per source):                        │
│  1. CLI --range (overrides all)                                 │
│  2. CLI --count (auto-detects per source)                       │
│  3. Per-path range (from path suffix)                           │
│  4. config.copy.range (fallback)                                │
│                                                                 │
│  Auto-Range Detection (when --count is used):                   │
│  1. Scan destination artist directory for existing suffixes     │
│  2. Detect highest suffix number and pad width                  │
│  3. Build range: (highest + 1) to (highest + count)             │
└─────────────────────────────────────────────────────────────────┘
```

## Range Precedence

Ranges are resolved with the following priority (highest to lowest):

| Priority | Source              | Description                                                |
| -------- | ------------------- | ---------------------------------------------------------- |
| 1        | CLI `--range`       | Overrides all per-path, `--count`, and config ranges       |
| 2        | CLI `--count`       | Auto-detects next range per source (independent detection) |
| 3        | Per-path range      | Range suffix in path (e.g., `/path,001-003`)               |
| 4        | Config `copy.range` | Default range from `.rfmedia.json`                         |

### Precedence Examples

```bash
# Example 1: CLI range overrides everything
rfmedia copy "/music/Artist,001-003" /dest --range=010-015
# Result: Artist uses range 010-015 (CLI wins)

# Example 2: Per-path range used when no CLI range
rfmedia copy "/music/Artist,001-003" /dest
# Result: Artist uses range 001-003 (per-path range)

# Example 3: Mixed sources
rfmedia copy "/music/Artist1,001-003" "/music/Artist2" /dest --range=005-008
# Result: Artist1 uses 005-008 (CLI wins), Artist2 uses 005-008 (CLI wins)

# Example 4: Config fallback (no CLI range)
# Assuming .rfmedia.json has copy.range: "001-005"
rfmedia copy "/music/Artist1,010-012" "/music/Artist2" /dest
# Result: Artist1 uses 010-012 (per-path), Artist2 uses 001-005 (config)
```

## Auto-Range with --count

The `--count` option enables automatic range detection for each source independently. This is particularly useful when different artists may have different existing suffix numbers in the destination.

### How --count Works

When `--count=N` is specified:

1. For each source path, the CLI scans the destination artist directory
2. Detects the highest existing suffix number (e.g., if `Album-005` exists, highest is 5)
3. Builds a range starting from highest + 1 with N copies
4. Uses detected pad width from existing suffixes (defaults to 3 if none exist)

### Per-Source Auto-Detection

Each source gets independent auto-detection:

```bash
# Scenario: /dest/Artist1 has Album-003, /dest/Artist2 has Album-010
rfmedia copy "/music/Artist1" "/music/Artist2" /dest --count=3

# Result:
# - Artist1: auto-detects highest=003, creates 004-006
# - Artist2: auto-detects highest=010, creates 011-013
```

### --count with File-Based Input

When using `--file` with `--count`, the CLI-level count overrides any per-path ranges in the input file:

```bash
# sources.txt contains:
# /music/Artist1,001-003
# /music/Artist2,004-006
# /music/Artist3

rfmedia copy --file sources.txt /dest --count=5

# Result:
# - Artist1: ignores "001-003", auto-detects next range for 5 copies
# - Artist2: ignores "004-006", auto-detects next range for 5 copies
# - Artist3: auto-detects next range for 5 copies
```

### --count vs --range

The `--count` and `--range` options are mutually exclusive:

```bash
# Valid: specify count only
rfmedia copy /music/Artist /dest --count=3

# Valid: specify range only
rfmedia copy /music/Artist /dest --range=001-005

# Invalid: cannot specify both
rfmedia copy /music/Artist /dest --count=3 --range=001-005
# Error: option '--count <N>' cannot be used with option '-r, --range <START-END>'
```

### --count with Multiple Sources

```bash
# Each source detected independently
rfmedia copy \
  "/music/Artist1" \
  "/music/Artist2" \
  "/music/Artist3" \
  /dest \
  --count=3

# Output shows detected ranges:
# Auto-detected range for /music/Artist1: 001-003
# Auto-detected range for /music/Artist2: 011-013
# Auto-detected range for /music/Artist3: 001-003
```

## Implementation Files

| File                         | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `src/commands/copy.ts`       | CLI argument parsing, path parsing helpers, mode detection               |
| `src/actions/copy-album.ts`  | Album mode integration with cliSourceEntries and --count                 |
| `src/actions/copy-filter.ts` | Filter mode integration with cliSourceEntries and --count                |
| `src/types/options.ts`       | CopyOptions.cliSourceEntries and count field definitions                 |
| `src/lib/range.ts`           | isValidRange(), tryParseRange(), detectHighestSuffix(), buildAutoRange() |

## Key Functions

### copy.ts

- `parsePathWithRange(pathString)`: Parses a path string for optional range suffix
- `hasRangeSuffix(pathString)`: Checks if path has a valid range suffix (used to validate destination)
- `hasAlbumModeOptions(options, hasCliSourceEntries)`: Updated mode detection including CLI sources and --count
- `buildCopyOptions(rawOptions, globalDryRun, hasCliSourceEntries)`: Builds typed options with CLI source awareness

### range.ts

- `detectHighestSuffix(artistDir)`: Scans destination directory for existing numbered suffixes, returns highest suffix and detected pad width
- `buildAutoRange(count, highestSuffix, padWidth)`: Constructs a CopyRange starting from highestSuffix + 1 for count copies
- `formatRange(range)`: Formats a CopyRange as a human-readable string (e.g., "001-003")

### PathEntry Interface

```typescript
interface PathEntry {
  path: string; // The source path
  range?: CopyRange; // Optional per-path range
}
```

### CopyOptions Addition

```typescript
interface CopyOptions {
  // ... existing fields ...
  cliSourceEntries?: PathEntry[]; // Source entries from CLI arguments
  cliRange?: CopyRange; // CLI --range (highest priority)
  configRange?: CopyRange; // Config default range (fallback)
  count?: number; // Auto-range mode: number of copies to create
}
```

## Design Decisions

### Why --count Auto-Detects Per Source?

When processing multiple sources with `--count`, each source gets independent auto-detection because:

1. **Different artists may have different existing copies** - Artist1 might have 3 existing copies while Artist2 has 10
2. **Prevents suffix collisions** - Auto-detection ensures new copies don't overwrite existing ones
3. **Maintains consistency** - Each artist's destination directory has sequential numbering starting from its current highest
4. **Simplifies batch operations** - Users don't need to track existing suffixes manually for each artist

### Why --count Overrides Per-Path Ranges?

When `--count` is specified at the CLI level, it takes precedence over per-path ranges in input files because:

1. **Explicit CLI intent** - The user explicitly requested auto-detection for all sources
2. **Consistency** - All sources should be processed the same way when using --count
3. **Safety** - Auto-detection prevents accidental overwrites from outdated per-path ranges

### Why Comma Delimiter?

The comma delimiter (`/path,001-003`) was chosen to match the existing file-based input format in `src/lib/input-file.ts`. This provides consistency between CLI and file-based source specification.

### Why Last Path is Destination?

Following Unix conventions (like `cp`, `mv`), the last path argument is the destination. This enables natural command-line construction without special flags.

### Destination Validation

The destination path cannot have a range suffix. If detected, the CLI throws an error with a helpful message suggesting the range may have been misplaced on a source path.

### Backward Compatibility

The feature maintains full backward compatibility:

- Single source + destination: Works as before
- `--file` option: Works as before (sources from file)
- `--range` option: Works as before (applies to all sources)

## Error Handling

### Invalid Destination

```bash
rfmedia copy /music/Artist "/dest,001-003"
# Error: Destination path cannot have a range suffix
```

### Insufficient Arguments

```bash
rfmedia copy /music/Artist
# Error: Without --file option, provide at least <source> and <destination> paths
```

### Missing Range

```bash
rfmedia copy /music/Artist /dest
# Error: Album mode requires a range (no CLI range, no config range, no per-path range)
```

## Related Documentation

- README.md - Copy command usage examples
- CLAUDE.md - Per-path range support section
- TODO.md - Recently completed section
