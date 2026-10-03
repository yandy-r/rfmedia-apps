# Plugin System

This document describes the rfmedia-cli plugin system, which enables extending copy operations with custom processing, external tool integration, and metadata extraction.

## Overview

The plugin system intercepts the copy workflow at four hooks (`beforeCopy`, `afterCopy`, `processFile`, `afterBatch`) for custom file processing. Plugins are loaded from `~/.rfmedia/plugins/` using ESM dynamic imports, supporting both TypeScript plugins and external command wrappers for tools like beets or MusicBrainz Picard.

### Key Features

- **Four Hook Points**: Intercept copy operations at before/after file copy, during metadata scan, and after batch completion
- **Priority Ordering**: Plugins execute in priority order (lower numbers run first)
- **External Command Wrappers**: Integrate external tools via YAML configuration without writing code
- **Graceful Error Handling**: Plugin failures are logged but do not stop copy operations by default
- **AbortSignal Support**: Plugins receive abort signals for interruptible operations

### When to Use Plugins

**Use plugins when:**

- You need to process files after copying (e.g., run beets import)
- You want to extract custom metadata during scans
- You need to integrate external tools into the copy workflow
- You want to perform batch operations after all sources complete

**Use configuration options instead when:**

- You only need built-in filtering (use smart filters)
- You only need format conversion (use `--convert`)
- You only need Plex integration (use `--plex-scan`)

## Quick Start

### Creating Your First Plugin

1. Create the plugin directory:

```bash
mkdir -p ~/.rfmedia/plugins/my-plugin
```

2. Create the plugin file (`~/.rfmedia/plugins/my-plugin/index.js`):

```javascript
export default {
  name: "my-plugin",
  version: "1.0.0",
  description: "Logs file copy operations",
  hooks: [
    {
      type: "afterCopy",
      handler: async (context, result) => {
        console.log(`Copied: ${context.sourcePath} -> ${context.destPath}`);
        console.log(`Method: ${context.method}, Size: ${context.fileSize} bytes`);
      },
    },
  ],
};
```

3. Verify the plugin is installed:

```bash
rfmedia plugin list
```

4. Test with a dry-run:

```bash
rfmedia copy /music/Artist /dest --range=001-003 --dry-run --debug
```

### Plugin File Structure

Plugins are discovered from directories within the plugin search paths. Each plugin must have an `index.js` or `index.mjs` entry point:

```
~/.rfmedia/plugins/
  my-plugin/
    index.js       # Plugin entry point (required)
    lib/           # Optional supporting files
      utils.js
```

## Configuration

### Enable/Disable Plugin System

Configure the plugin system in `.rfmedia.yaml`:

```yaml
plugins:
  # Enable/disable the entire plugin system (default: true)
  enabled: true

  # Plugin search directory (default: ~/.rfmedia/plugins/)
  directory: ~/.rfmedia/plugins

  # Additional directories to search for plugins
  additionalDirectories:
    - /opt/rfmedia/plugins
    - ~/custom-plugins

  # Disable specific plugins by name
  disabled:
    - problematic-plugin
    - debugging-plugin
```

### Configuration Options Reference

| Option                  | Type     | Default              | Description                         |
| ----------------------- | -------- | -------------------- | ----------------------------------- |
| `enabled`               | boolean  | `true`               | Enable/disable plugin system        |
| `directory`             | string   | `~/.rfmedia/plugins` | Primary plugin search directory     |
| `additionalDirectories` | string[] | `[]`                 | Additional directories to search    |
| `disabled`              | string[] | `[]`                 | Plugin names to disable             |
| `commands`              | array    | `[]`                 | External command plugin definitions |

## External Command Plugins

External command plugins allow integrating CLI tools without writing JavaScript code. Configure them in `.rfmedia.yaml`:

```yaml
plugins:
  commands:
    # Run beets import after batch completes
    - name: beets-import
      command: beet
      args: ["import", "-q", "{destPath}"]
      timeout: 300000
      hooks:
        afterBatch: true

    # Run custom script after each file copy
    - name: post-copy-script
      command: /usr/local/bin/process-audio.sh
      args: ["{sourcePath}", "{destPath}"]
      timeout: 60000
      hooks:
        afterCopy: true
```

### Command Configuration Reference

| Field     | Type   | Required | Description                              |
| --------- | ------ | -------- | ---------------------------------------- |
| `name`    | string | Yes      | Unique name for this command plugin      |
| `command` | string | Yes      | Command to execute                       |
| `args`    | array  | No       | Arguments with optional placeholders     |
| `timeout` | number | No       | Timeout in milliseconds (default: 60000) |
| `hooks`   | object | Yes      | Which hooks to run this command on       |

### Argument Placeholders

Arguments support placeholders that are replaced at runtime.

**Note:** External command plugins only support `afterCopy` and `afterBatch` hooks. Use JavaScript plugins for `beforeCopy` and `processFile` hooks.

**afterCopy Placeholders:**

| Placeholder    | Description                           |
| -------------- | ------------------------------------- |
| `{sourcePath}` | Source file path                      |
| `{destPath}`   | Destination file path                 |
| `{fileSize}`   | File size in bytes                    |
| `{method}`     | Copy method (copy/hardlink/converted) |

**afterBatch Placeholders:**

| Placeholder     | Description                          |
| --------------- | ------------------------------------ |
| `{sources}`     | Comma-separated list of source paths |
| `{historyId}`   | History session ID (if undo enabled) |
| `{resultCount}` | Number of results in the batch       |

### Example: Beets Integration

```yaml
plugins:
  commands:
    - name: beets-import
      command: beet
      args: ["import", "--quiet", "--noautotag", "{destPath}"]
      timeout: 300000 # 5 minutes
      hooks:
        afterBatch: true
```

### Example: MusicBrainz Picard

```yaml
plugins:
  commands:
    - name: picard-tag
      command: picard
      args: ["-e", "LOAD", "{destPath}"]
      timeout: 120000
      hooks:
        afterBatch: true
```

## Available Hooks

The plugin system provides four hooks that intercept different stages of the copy workflow:

| Hook          | When Called                      | Context Provided                   |
| ------------- | -------------------------------- | ---------------------------------- |
| `beforeCopy`  | Before each file copy/convert    | Source/dest paths, format, signal  |
| `afterCopy`   | After each file copy/convert     | Paths, method, file size           |
| `processFile` | During filter mode metadata scan | File path, extended metadata       |
| `afterBatch`  | After all sources are processed  | Results array, sources, history ID |

### Hook Execution Order

1. Plugins are sorted by priority (lower runs first, default: 50)
2. Hooks execute sequentially within each plugin
3. By default, execution continues even if a plugin fails
4. Hooks receive an `AbortSignal` for graceful interruption

### beforeCopy Hook

Called before each file is copied or converted. Use this for pre-processing validation.

```javascript
{
  type: "beforeCopy",
  handler: async (context) => {
    // context.sourcePath - Source file path
    // context.destPath - Destination path
    // context.isAudioFile - Whether file is audio
    // context.convertFormat - Target format (if converting)
    // context.signal - AbortSignal for cancellation
  }
}
```

### afterCopy Hook

Called after each file is successfully copied or converted. Use this for post-processing.

```javascript
{
  type: "afterCopy",
  handler: async (context, result) => {
    // context.sourcePath - Source file path
    // context.destPath - Destination file path
    // context.method - "copy" | "hardlink" | "converted"
    // context.fileSize - Size in bytes
  }
}
```

### processFile Hook

Called during filter mode when scanning files for ratings. Receives full metadata.

```javascript
{
  type: "processFile",
  handler: async (context) => {
    // context.filePath - File being scanned
    // context.metadata - ExtendedMetadata object with:
    //   - rating (normalized 0.0-1.0)
    //   - genre (array)
    //   - artist (array)
    //   - year
    //   - bpm
    //   - title, album, etc.
  }
}
```

### afterBatch Hook

Called after all sources have been processed. Use this for batch operations.

```javascript
{
  type: "afterBatch",
  handler: async (context) => {
    // context.results - Array of CopyResult objects
    // context.sources - Array of source paths processed
    // context.historyId - Undo history session ID (if available)
    // context.signal - AbortSignal for cancellation
  }
}
```

## Plugin Interface

### RfmediaPlugin Interface

Every plugin must export an object conforming to this interface:

```typescript
interface RfmediaPlugin {
  /** Unique plugin name */
  name: string;

  /** Semantic version string */
  version: string;

  /** Human-readable description */
  description?: string;

  /** Execution priority (lower runs first, default: 50) */
  priority?: number;

  /** Whether plugin is enabled (default: true) */
  enabled?: boolean;

  /** Array of hook definitions */
  hooks?: PluginHook[];
}
```

### Hook Type Definitions

Hooks use discriminated unions for type safety:

```typescript
type PluginHook = BeforeCopyHook | AfterCopyHook | ProcessFileHook | AfterBatchHook;

interface BeforeCopyHook {
  type: "beforeCopy";
  handler: (ctx: BeforeCopyContext) => Promise<void>;
}

interface AfterCopyHook {
  type: "afterCopy";
  handler: (ctx: AfterCopyContext, result: CopyResult) => Promise<void>;
}

interface ProcessFileHook {
  type: "processFile";
  handler: (ctx: ProcessFileContext) => Promise<void>;
}

interface AfterBatchHook {
  type: "afterBatch";
  handler: (ctx: AfterBatchContext) => Promise<void>;
}
```

### Context Types

```typescript
interface BeforeCopyContext {
  sourcePath: string;
  destPath: string;
  isAudioFile: boolean;
  convertFormat?: string;
  signal?: AbortSignal;
}

interface AfterCopyContext {
  sourcePath: string;
  destPath: string;
  method: "copy" | "hardlink" | "converted";
  fileSize: number;
}

interface ProcessFileContext {
  filePath: string;
  metadata: ExtendedMetadata;
}

interface AfterBatchContext {
  results: CopyResult[];
  sources: string[];
  historyId?: string;
  signal?: AbortSignal;
}
```

## CLI Commands

The `plugin` command provides tools for managing installed plugins.

### List Installed Plugins

```bash
# List all installed plugins
rfmedia plugin list
rfmedia plugin ls  # Alias

# Output as JSON for scripting
rfmedia plugin list --json
```

Example output:

```
Installed plugins (2):
  my-plugin v1.0.0 - hooks: afterCopy
  beets-import v1.0.0 - hooks: afterBatch
```

### Show Plugin Details

```bash
# Show detailed information about a plugin
rfmedia plugin info my-plugin

# JSON output
rfmedia plugin info my-plugin --json
```

Example output:

```
Plugin: my-plugin
Version: 1.0.0
Description: Logs file copy operations
Priority: 50
Hooks: afterCopy
```

### Show Plugin Directory

```bash
# Show configured plugin search paths
rfmedia plugin dir
```

Example output:

```
/home/user/.rfmedia/plugins
/opt/rfmedia/plugins
```

## Examples

### Logging Plugin

A simple plugin that logs all copy operations:

```javascript
// ~/.rfmedia/plugins/copy-logger/index.js
export default {
  name: "copy-logger",
  version: "1.0.0",
  description: "Logs all copy operations to a file",
  priority: 100, // Run after other plugins
  hooks: [
    {
      type: "afterCopy",
      handler: async (context) => {
        const fs = await import("node:fs/promises");
        const logLine = `${new Date().toISOString()} | ${context.method} | ${context.sourcePath} -> ${context.destPath}\n`;
        await fs.appendFile("/tmp/rfmedia-copy.log", logLine);
      },
    },
  ],
};
```

### Metadata Extraction Plugin

Extract and save metadata during scans:

```javascript
// ~/.rfmedia/plugins/metadata-export/index.js
const metadata = [];

export default {
  name: "metadata-export",
  version: "1.0.0",
  description: "Exports track metadata to JSON",
  hooks: [
    {
      type: "processFile",
      handler: async (context) => {
        metadata.push({
          path: context.filePath,
          title: context.metadata.title,
          artist: context.metadata.artist,
          album: context.metadata.album,
          rating: context.metadata.rating,
          genre: context.metadata.genre,
        });
      },
    },
    {
      type: "afterBatch",
      handler: async () => {
        const fs = await import("node:fs/promises");
        await fs.writeFile("/tmp/rfmedia-metadata.json", JSON.stringify(metadata, null, 2));
        console.log(`Exported ${metadata.length} tracks to /tmp/rfmedia-metadata.json`);
      },
    },
  ],
};
```

### File Validation Plugin

Validate files before copying:

```javascript
// ~/.rfmedia/plugins/validate-audio/index.js
export default {
  name: "validate-audio",
  version: "1.0.0",
  description: "Validates audio files before copying",
  priority: 10, // Run early
  hooks: [
    {
      type: "beforeCopy",
      handler: async (context) => {
        if (!context.isAudioFile) return;

        const { stat } = await import("node:fs/promises");
        const stats = await stat(context.sourcePath);

        // Skip files smaller than 100KB (likely corrupted)
        if (stats.size < 100 * 1024) {
          console.warn(`Skipping small file (possibly corrupted): ${context.sourcePath}`);
          throw new Error("File too small, possibly corrupted");
        }
      },
    },
  ],
};
```

### Batch Notification Plugin

Send notifications after batch operations:

```javascript
// ~/.rfmedia/plugins/notify/index.js
export default {
  name: "notify",
  version: "1.0.0",
  description: "Sends notification when batch completes",
  priority: 90,
  hooks: [
    {
      type: "afterBatch",
      handler: async (context) => {
        const totalFiles = context.results.reduce((sum, r) => sum + r.created, 0);
        const totalFailed = context.results.reduce((sum, r) => sum + r.failed.length, 0);

        // Use system notification (macOS example)
        const { exec } = await import("node:child_process");
        const message = `rfmedia: Copied ${totalFiles} files, ${totalFailed} failed`;
        exec(`osascript -e 'display notification "${message}" with title "rfmedia"'`);
      },
    },
  ],
};
```

## Error Handling

### Plugin Execution Errors

By default, plugin errors are logged but do not stop the copy operation:

```
[WARN] Plugin 'my-plugin' failed during afterCopy: Connection refused
```

To make plugin errors fatal, set `continueOnError: false` in the runner options (not available via configuration).

### External Command Errors

External command plugins report errors with:

- Exit code (if non-zero)
- stderr output (truncated to 10KB)
- Timeout indication (if command exceeded timeout)

```
[WARN] External command 'beet' failed (exit 1): Import failed: No matching release found
```

### Debugging Plugins

Use `--debug` to see detailed plugin execution:

```bash
rfmedia copy /music/Artist /dest --range=001-003 --debug
```

Debug output shows:

- Which plugins are loaded
- Hook execution timing
- Error details with stack traces

## Best Practices

### Plugin Development

1. **Start with afterCopy hook** - It is the simplest integration point with complete context
2. **Use async/await** - All hook handlers must be async functions
3. **Handle errors gracefully** - Catch and log errors rather than throwing
4. **Respect AbortSignal** - Check `signal.aborted` in long-running operations
5. **Use ESM exports** - Plugins must use `export default`, not `module.exports`

### Performance Considerations

1. **Keep hooks lightweight** - Heavy processing delays the copy workflow
2. **Use afterBatch for bulk operations** - Avoid per-file overhead when possible
3. **Set appropriate timeouts** - External commands should have reasonable timeouts
4. **Consider priority ordering** - Validation plugins should run early (low priority)

### Security

1. **Validate external commands** - Ensure commands exist before configuration
2. **Sanitize placeholders** - External commands receive user-controlled paths
3. **Limit timeout values** - Prevent runaway processes
4. **Review plugin code** - Only install plugins from trusted sources

## Troubleshooting

### Plugin Not Loading

**Issue**: Plugin does not appear in `rfmedia plugin list`

**Possible causes and solutions**:

| Cause                   | Solution                                             |
| ----------------------- | ---------------------------------------------------- |
| Missing `index.js`      | Create `index.js` or `index.mjs` in plugin directory |
| Invalid export          | Use `export default { ... }` not `module.exports`    |
| Missing `name` field    | Add required `name: "plugin-name"` to export         |
| Missing `version` field | Add required `version: "1.0.0"` to export            |
| Plugin disabled         | Check `plugins.disabled` in config                   |
| Wrong directory         | Verify plugin is in configured search path           |

### External Command Not Found

**Issue**: `External command 'xyz' failed: ENOENT`

**Solution**: Ensure the command is installed and in PATH:

```bash
which beet  # Should return path
beet --version  # Should work
```

### Hook Not Executing

**Issue**: Hook handler never runs

**Possible causes**:

1. Hook type misspelled (e.g., `aftercopy` instead of `afterCopy`)
2. Copy mode does not trigger hook (e.g., `processFile` only runs in filter mode)
3. Plugin priority causes it to be skipped after earlier failure
4. Plugin disabled in configuration

### Timeout Errors

**Issue**: `External command 'xyz' timed out after 60000ms`

**Solution**: Increase timeout in configuration:

```yaml
plugins:
  commands:
    - name: slow-command
      command: slow-tool
      timeout: 300000 # 5 minutes
      hooks:
        afterBatch: true
```

## Related Documentation

- [Smart Filters](smart-filters.md) - Filter configuration that works with processFile hook
- [Audio Conversion](audio-conversion.doc.md) - Conversion options affecting beforeCopy/afterCopy context
- [Graceful Interruption](graceful-interruption.md) - How AbortSignal works in plugins
- [Tracking System](tracking-system.md) - History IDs available in afterBatch context
