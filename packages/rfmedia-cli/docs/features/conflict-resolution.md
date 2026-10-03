# Conflict Resolution

This document describes the conflict resolution feature in rfmedia-cli, which provides granular control over file conflicts during copy and verify operations.

## Overview

When copying or verifying files, conflicts can occur when destination files already exist, have incorrect sizes, or when extra files are found that should not be present. The conflict resolution system intercepts these conflicts and provides:

- **Interactive prompts** for user-controlled resolution
- **Non-interactive strategies** for CI/automation workflows
- **"Apply to All"** batch processing for repetitive decisions
- **Conflict tracking** in operation results for auditing

### When Conflicts Are Triggered

| Operation      | Trigger                          | Default Behavior       |
| -------------- | -------------------------------- | ---------------------- |
| `copy` command | Destination file already exists  | Skip (without --force) |
| `verify --fix` | Size mismatch detected           | Requires --force       |
| `verify --fix` | Extra files found in destination | Prompt for removal     |
| `sync` command | File changed since last sync     | Overwrite              |

The `--conflict-strategy` option provides explicit control over conflict handling, replacing the implicit behavior with user-specified actions.

## CLI Option

### `--conflict-strategy <strategy>`

Specifies how to handle file conflicts without prompting.

**Available strategies:**

| Strategy    | Description                                                |
| ----------- | ---------------------------------------------------------- |
| `skip`      | Do not overwrite; keep existing files                      |
| `overwrite` | Replace existing files with source files                   |
| `rename`    | Create new files with unique suffixes (e.g., file-002.ext) |
| `ask`       | Prompt interactively for each conflict (default)           |

**Commands supporting this option:**

- `rfmedia copy`
- `rfmedia verify` (with `--fix`)

### Usage Examples

```bash
# Copy with automatic skip of existing files
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=skip

# Copy with automatic overwrite
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=overwrite

# Copy with automatic rename (creates file-002.ext, file-003.ext suffixes)
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=rename

# Verify with fix and overwrite size mismatches
rfmedia verify /music/Artist /dest --fix --conflict-strategy=overwrite

# Interactive mode (default) - prompts for each conflict
rfmedia copy /music/Artist /dest --range=001-005
```

## Interactive Mode

When `--conflict-strategy` is not specified (or set to `ask`), the system prompts for each conflict.

### Prompt Format

For file existence and size mismatch conflicts:

```
File already exists: track01.flac
  Source: /music/Artist/Album/track01.flac
  Dest: /dest/Artist/Album-001/track01.flac
  Dest size: 25.3 MB

? Select action:
  [s] Skip
  [o] Overwrite
  [r] Rename (add suffix)
  [a] Apply to All (same type)
```

For extra file conflicts (during verify --fix):

```
Extra file in destination: unwanted.mp3
  Path: /dest/Artist/Album-001/unwanted.mp3
  Size: 4.2 MB

? Select action:
  [s] Skip (keep file)
  [r] Remove file
  [a] Apply to All (same type)
```

### Shortcut Keys

| Key | Action                                            |
| --- | ------------------------------------------------- |
| `s` | Skip this conflict                                |
| `o` | Overwrite (exists/size-mismatch only)             |
| `r` | Rename with suffix / Remove (depends on conflict) |
| `a` | Apply chosen resolution to all similar conflicts  |

### "Apply to All" Feature

When processing multiple files with similar conflicts, you can choose "Apply to All" to automatically apply the same resolution to all subsequent conflicts of the same type.

**How it works:**

1. When a conflict occurs, select `[a] Apply to All`
2. A secondary prompt asks for the resolution to apply
3. All future conflicts of the same type use this resolution automatically
4. "Apply to All" is scoped by conflict type (exists, size-mismatch, extra)

**Example session:**

```
File already exists: track01.flac
? Select action: [a] Apply to All (same type)
? Select resolution to apply to all: [o] Overwrite

# All subsequent "exists" conflicts auto-resolve with overwrite
Overwritten: track02.flac
Overwritten: track03.flac
...
```

## Non-Interactive Mode

For CI/CD pipelines, scripted operations, and piped commands where interactive prompts are not possible, use explicit conflict strategies.

### Detecting Non-Interactive Context

The system detects non-interactive contexts when:

- `stdout` is not a TTY (e.g., piped output)
- `stdin` is not a TTY (e.g., input redirection)
- `--json` flag is used (JSON output mode)

### Required Strategy for Non-Interactive Use

In non-interactive contexts without a strategy, the system throws an error:

```
Error: Interactive conflict resolution requires a TTY terminal.
Use --conflict-strategy to specify a resolution.
```

**Solution:** Always specify `--conflict-strategy` in scripts:

```bash
# CI/CD pipeline example
rfmedia copy /source /dest --range=001-005 --conflict-strategy=skip

# Piped command
cat sources.txt | xargs -I{} rfmedia copy {} /dest --conflict-strategy=overwrite
```

### JSON Mode Compatibility

When using `--json` for machine-readable output, interactive prompts are disabled. Conflicts are reported in the JSON output:

```bash
rfmedia copy /music /dest --range=001 --conflict-strategy=overwrite --json
```

Output includes conflict resolutions:

```json
{
  "command": "copy",
  "mode": "album",
  "result": {
    "created": 45,
    "skipped": 5,
    "conflictResolutions": [
      {
        "sourcePath": "/music/Artist/Album/track.flac",
        "destPath": "/dest/Artist/Album-001/track.flac",
        "conflictType": "exists",
        "resolution": "overwrite",
        "success": true
      }
    ]
  }
}
```

## Conflict Types

### `exists` - File Already Exists

**When triggered:** Destination file exists during copy operation.

**Available resolutions:**

| Resolution  | Action                                         |
| ----------- | ---------------------------------------------- |
| `skip`      | Keep existing file, do not copy                |
| `overwrite` | Delete existing file, copy from source         |
| `rename`    | Copy to new path with suffix (e.g., track-002) |

**Information provided:**

- Source file path
- Destination file path
- Destination file size

### `size-mismatch` - File Size Differs

**When triggered:** Destination file exists but has different size than expected (during verify --fix).

**Available resolutions:**

| Resolution  | Action                               |
| ----------- | ------------------------------------ |
| `skip`      | Keep existing file with wrong size   |
| `overwrite` | Re-copy from source to fix size      |
| `rename`    | Copy correct version with new suffix |

**Information provided:**

- Source file path and size
- Destination file path and size
- Expected vs actual size comparison

**Common causes of size mismatches:**

- Incomplete/interrupted copy operations
- Corrupted downloads
- Different conversion settings
- Manual file modifications

### `extra` - Unexpected File in Destination

**When triggered:** File exists in destination with no corresponding source file (during verify --fix).

**Available resolutions:**

| Resolution | Action                        |
| ---------- | ----------------------------- |
| `keep`     | Leave the extra file in place |
| `remove`   | Delete the extra file         |

**Information provided:**

- Extra file path
- File size

**Note:** The `overwrite` and `rename` strategies are not applicable to extra files and default to `keep` when specified.

## Examples

### Common Usage Scenarios

**Fresh copy with conflict protection:**

```bash
# Skip any existing files (safe incremental copy)
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=skip
```

**Force overwrite for recovery:**

```bash
# Overwrite potentially corrupted copies
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=overwrite
```

**Create unique copies without conflicts:**

```bash
# All files get unique names if they conflict
rfmedia copy /music/Artist /dest --range=001-005 --conflict-strategy=rename
```

**Verify and fix with automatic overwrite:**

```bash
# Re-copy any size-mismatched files
rfmedia verify /source /dest --fix --conflict-strategy=overwrite
```

**CI/CD pipeline integration:**

```bash
#!/bin/bash
set -e

# Copy with explicit strategy (required for non-interactive)
rfmedia copy /source /dest \
  --range=001-010 \
  --conflict-strategy=skip \
  --json > copy-results.json

# Check for conflicts
jq '.result.conflictResolutions' copy-results.json
```

**Interactive session with batch decisions:**

```bash
# First conflict prompts for decision, use "Apply to All" to automate rest
rfmedia copy /music/Artist /dest --range=001-020
# Choose [a] Apply to All -> [o] Overwrite at first conflict
# Remaining 19 conflicts auto-resolve with overwrite
```

### Combining with Other Options

**With format conversion:**

```bash
# Convert to MP3, skip existing converted files
rfmedia copy /music /dest --convert=mp3 --conflict-strategy=skip
```

**With rating filters:**

```bash
# Copy liked tracks, overwrite existing
rfmedia copy /music /dest --min-stars=4 --conflict-strategy=overwrite
```

**With dry-run preview:**

```bash
# Preview what conflicts would occur
rfmedia copy /music /dest --range=001 --dry-run
# Shows conflicts without applying any resolution
```

### Relation to `--force` Flag

The `--force` flag in verify operations is equivalent to `--conflict-strategy=overwrite` for size-mismatch conflicts:

```bash
# These are equivalent for verify --fix:
rfmedia verify /source /dest --fix --force
rfmedia verify /source /dest --fix --conflict-strategy=overwrite
```

The `--conflict-strategy` option provides more granular control (skip, rename) that `--force` does not offer.

## Troubleshooting

### TTY Detection Issues

**Problem:** Interactive prompts fail with "requires a TTY terminal" error.

**Causes:**

1. Running in a non-TTY environment (CI, cron, systemd)
2. Output piped to another command
3. Running with input redirection

**Solutions:**

```bash
# Specify explicit strategy
rfmedia copy /source /dest --conflict-strategy=skip

# For scripts that might run in either context
if [ -t 0 ]; then
  rfmedia copy /source /dest  # Interactive
else
  rfmedia copy /source /dest --conflict-strategy=skip
fi
```

### JSON Mode Compatibility

**Problem:** "Cannot use interactive conflict resolution with --json output."

**Solution:** Always use `--conflict-strategy` with `--json`:

```bash
# Correct
rfmedia copy /source /dest --json --conflict-strategy=skip

# Error (prompts not possible in JSON mode)
rfmedia copy /source /dest --json
```

### Unexpected "Apply to All" Behavior

**Problem:** "Apply to All" applied to wrong conflicts.

**Explanation:** "Apply to All" is scoped by conflict type:

- `exists` conflicts have separate "Apply to All" state
- `size-mismatch` conflicts have separate "Apply to All" state
- `extra` conflicts have separate "Apply to All" state

Choosing "Apply to All" for `exists` conflicts does not affect `size-mismatch` handling.

### Rename Suffix Collisions

**Problem:** Multiple renamed files with same base name.

**Behavior:** The rename strategy generates unique suffixes:

- First file: `track.flac` (no suffix if no conflict)
- Second file: `track-002.flac`
- Third file: `track-003.flac`
- ...and so on

Suffix detection is case-insensitive to handle filesystem differences (e.g., macOS HFS+).

### Size Mismatch Without Source

**Problem:** Size mismatch detected but source file unavailable.

**Explanation:** For converted files (e.g., .flac to .m4a), the original source path is tracked in `VerifiedFile.sourcePath`. If the source was moved or deleted, re-copy fails.

**Solution:** Ensure source files remain available until verification completes.

## Implementation Details

### Conflict Resolution Flow

```
Copy/Verify Operation
        │
        ├─► Detect Conflict
        │       │
        │       ├─► File exists? ──────────► ConflictType: 'exists'
        │       ├─► Size mismatch? ────────► ConflictType: 'size-mismatch'
        │       └─► Extra file? ───────────► ConflictType: 'extra'
        │
        ├─► Determine Strategy
        │       │
        │       ├─► --conflict-strategy set? ──► Use specified strategy
        │       ├─► "Apply to All" active? ────► Use stored resolution
        │       └─► Interactive? ──────────────► Prompt user
        │
        └─► Apply Resolution
                │
                ├─► skip/keep ─────► No action
                ├─► overwrite ─────► Delete + Copy
                ├─► rename ────────► Copy to unique path
                └─► remove ────────► Delete file
```

### Key Files

| File                           | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| `src/types/conflict.ts`        | Type definitions for conflicts and resolutions |
| `src/lib/conflict-resolver.ts` | Core conflict detection and resolution logic   |
| `src/commands/copy.ts`         | CLI option definition for copy command         |
| `src/commands/verify.ts`       | CLI option definition for verify command       |
| `src/actions/copy-album.ts`    | Conflict integration in album copy             |
| `src/actions/copy-filter.ts`   | Conflict integration in filter copy            |
| `src/actions/verify-album.ts`  | Conflict integration in album verify fix       |
| `src/actions/verify-filter.ts` | Conflict integration in filter verify fix      |

## Related Documentation

- [verify-auto-fix.doc.md](verify-auto-fix.doc.md) - Base verify auto-fix documentation
- [graceful-interruption.md](graceful-interruption.md) - Signal handling during conflict prompts
- [CLAUDE.md](../../CLAUDE.md) - Verify Auto-Fix Mode section for implementation details
