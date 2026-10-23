# @rfmedia/common

Shared utilities for rfmedia CLI tools (rfapps-cli and rfmedia-cli).

This package provides common functionality used across the rfmedia CLI applications, including
logging, user prompts, and progress display utilities.

## Overview

The `@rfmedia/common` package consolidates shared utilities to ensure consistent behavior across CLI
tools:

- **Logger** - Colored console output with log levels and JSON mode support
- **Progress** - Task lists and spinners using listr2
- **Prompt** - Interactive user confirmation and input

All utilities are designed to work together:

- Log output goes to stderr to keep stdout clean for data
- Progress displays are automatically suppressed in JSON mode
- Prompts use stderr for display text

```mermaid
graph TD
    A[rfapps-cli] --> C[@rfmedia/common]
    B[rfmedia-cli] --> C
    C --> D[Logger]
    C --> E[Progress]
    C --> F[Prompt]
    D --> G[picocolors]
    E --> H[listr2]
```

## Installation

This package is designed for use within the rfmedia-apps monorepo. It is automatically linked via
npm workspaces.

### As a Workspace Dependency

Add to your package's `package.json`:

```json
{
  "dependencies": {
    "@rfmedia/common": "*"
  }
}
```

Then run from the monorepo root:

```bash
npm install
```

### Building

```bash
# Build the package
npm run build

# Type checking only
npm run typecheck

# Clean build artifacts
npm run clean
```

## API Reference

### Logger

The logger module provides colored console output with multiple log levels. All log output goes to
stderr to keep stdout clean for JSON data output.

#### Initialization

```typescript
import { initLogger, setDebugMode, setJsonMode } from "@rfmedia/common";

// Initialize with tool-specific configuration
initLogger({
  debugEnvVar: "RFAPPS_DEBUG", // Environment variable for debug mode
  debugMode: false, // Initial debug state
  jsonMode: false, // Initial JSON mode state
});
```

#### Log Functions

```typescript
import { logInfo, logSuccess, logWarn, logError, logDebug } from "@rfmedia/common";

logInfo("Starting operation..."); // Blue [INFO] prefix
logSuccess("Operation completed"); // Green [SUCCESS] prefix
logWarn("Disk space is low"); // Yellow [WARN] prefix
logError("Operation failed"); // Red [ERROR] prefix
logDebug("Debug: config loaded"); // Yellow [DEBUG] (only when debug enabled)
```

#### JSON Output

```typescript
import { outputJson } from "@rfmedia/common";

// Only outputs when JSON mode is enabled
outputJson({
  status: "success",
  files: 42,
});
```

#### Mode Control

```typescript
import { setDebugMode, isDebugMode, setJsonMode, isJsonMode } from "@rfmedia/common";

// Enable/disable debug mode
setDebugMode(true);
if (isDebugMode()) {
  // Additional debug operations
}

// Enable/disable JSON mode
setJsonMode(true);
if (isJsonMode()) {
  // JSON mode suppresses all log functions
}
```

#### Utility Functions

```typescript
import { formatDryRun, colors } from "@rfmedia/common";

// Format a dry-run message
const message = formatDryRun("delete 5 files");
// Returns: "[DRY-RUN] Would delete 5 files"

// Access color functions directly
console.error(colors.blue("Custom blue text"));
console.error(colors.bold(colors.green("Bold green")));
```

#### Available Colors

```typescript
colors.blue; // Informational text
colors.green; // Success text
colors.yellow; // Warning text
colors.red; // Error text
colors.cyan; // Accent color
colors.magenta; // Accent color
colors.gray; // Subdued text
colors.bold; // Bold modifier
colors.dim; // Dimmed modifier
```

### Progress

The progress module wraps listr2 to provide consistent task list and spinner functionality with
automatic JSON mode suppression.

#### Running Task Lists

```typescript
import { runTasks } from "@rfmedia/common";
import type { ListrTask } from "listr2";

interface MyContext {
  files: string[];
  processed: number;
}

const tasks: ListrTask<MyContext>[] = [
  {
    title: "Scanning files",
    task: async (ctx) => {
      ctx.files = await scanDirectory("/path");
    },
  },
  {
    title: "Processing files",
    task: async (ctx, task) => {
      for (const file of ctx.files) {
        await processFile(file);
        ctx.processed++;
        task.title = `Processing files (${ctx.processed}/${ctx.files.length})`;
      }
    },
  },
];

await runTasks(tasks, {
  concurrent: false, // Run sequentially (default)
  exitOnError: true, // Stop on first error (default)
  ctx: { files: [], processed: 0 },
});
```

#### Task Factory Functions

**Scan Task** - Simple task with spinner:

```typescript
import { createScanTask, runTasks } from "@rfmedia/common";

interface ScanContext {
  files: string[];
}

const scanTask = createScanTask<ScanContext, void>("Scanning directory", async (ctx) => {
  ctx.files = await findFiles("/source");
});

await runTasks([scanTask], { ctx: { files: [] } });
```

**Process Task** - Task with progress counter (x of y):

```typescript
import { createProcessTask, runTasks } from "@rfmedia/common";

interface ProcessContext {
  files: string[];
  results: ProcessResult[];
}

const processTask = createProcessTask<ProcessContext, string>(
  "Processing files",
  (ctx) => ctx.files,
  async (file, index, ctx, updateTitle) => {
    updateTitle(file); // Shows: "Processing files (1/10): filename.txt"
    const result = await processFile(file);
    ctx.results.push(result);
  },
);

await runTasks([processTask], {
  ctx: { files: ["a.txt", "b.txt"], results: [] },
});
```

**Batch Task** - Task with subtasks for each item:

```typescript
import { createBatchTask, runTasks } from "@rfmedia/common";

interface BatchContext {
  services: string[];
}

const batchTask = createBatchTask<BatchContext, string>(
  "Starting services",
  (ctx) => ctx.services,
  (service) => `Start ${service}`,
  async (service, ctx) => {
    await startService(service);
  },
  { concurrent: true }, // Run subtasks in parallel
);

await runTasks([batchTask], {
  ctx: { services: ["redis", "postgres", "api"] },
});
```

#### Convenience Wrappers

**withSpinner** - Wrap a single operation with a spinner:

```typescript
import { withSpinner } from "@rfmedia/common";

const config = await withSpinner("Loading configuration", async () => {
  const data = await readFile("config.json", "utf8");
  return JSON.parse(data);
});
```

**withProgress** - Wrap item processing with progress display:

```typescript
import { withProgress } from "@rfmedia/common";

const results = await withProgress("Processing images", images, async (image, index, updateTitle) => {
  updateTitle(image.name); // Shows: "Processing images (1/10): photo.jpg"
  return await resizeImage(image);
});
```

### Prompt

The prompt module provides interactive user prompts using Node.js readline. All prompts output to
stderr to keep stdout clean.

#### Confirmation Prompts

```typescript
import { confirm, confirmWithDefault } from "@rfmedia/common";

// Default to No (user must type 'y' or 'yes')
const shouldDelete = await confirm("Delete all files?");
// Displays: "Delete all files? [y/N] "

// Default to Yes (user must type 'n' or 'no' to reject)
const shouldContinue = await confirmWithDefault("Continue?");
// Displays: "Continue? [Y/n] "

if (!shouldDelete) {
  console.error("Cancelled");
  process.exit(0);
}
```

#### Text Input

```typescript
import { prompt } from "@rfmedia/common";

// Simple prompt
const name = await prompt("Enter your name:");
// Displays: "Enter your name: "

// Prompt with default value
const port = await prompt("Enter port:", "3000");
// Displays: "Enter port: [3000] "
// Returns '3000' if user presses Enter
```

## TypeScript Types

### ProgressContext

Default context type for progress tracking:

```typescript
interface ProgressContext {
  /** Total items to process */
  total: number;
  /** Current item index (0-based) */
  current: number;
  /** Optional message to display */
  message?: string;
}
```

### TaskListOptions

Options for creating task lists:

```typescript
interface TaskListOptions<T = ProgressContext> {
  /** Whether to run tasks concurrently (default: false) */
  concurrent?: boolean;
  /** Whether to exit on error (default: true) */
  exitOnError?: boolean;
  /** Initial context object to pass to tasks */
  ctx?: T;
}
```

## Usage Examples

### CLI Tool Initialization

```typescript
#!/usr/bin/env node

import { Command } from "commander";
import { initLogger, setDebugMode, setJsonMode } from "@rfmedia/common";

// Initialize logger with tool-specific debug env var
initLogger({ debugEnvVar: "MY_CLI_DEBUG" });

const program = new Command();

program
  .option("--debug", "Enable debug output")
  .option("--json", "Output in JSON format")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.debug) setDebugMode(true);
    if (opts.json) setJsonMode(true);
  });

program.parse();
```

### Multi-Phase Operation

```typescript
import {
  logInfo,
  logSuccess,
  logError,
  formatDryRun,
  confirm,
  withSpinner,
  runTasks,
  createScanTask,
  createProcessTask,
} from "@rfmedia/common";

interface DeployContext {
  services: string[];
  deployed: string[];
}

async function deploy(dryRun: boolean) {
  // Confirmation
  if (!dryRun) {
    const confirmed = await confirm("Deploy all services?");
    if (!confirmed) {
      logInfo("Cancelled");
      return;
    }
  }

  if (dryRun) {
    logInfo(formatDryRun("deploy all services"));
    return;
  }

  // Phase 1: Pull images
  await withSpinner("Pulling Docker images", async () => {
    await pullImages();
  });

  // Phase 2: Deploy with progress
  await runTasks<DeployContext>(
    [
      createScanTask("Discovering services", async (ctx) => {
        ctx.services = await discoverServices();
      }),
      createProcessTask(
        "Deploying services",
        (ctx) => ctx.services,
        async (service, _index, ctx, updateTitle) => {
          updateTitle(service);
          await deployService(service);
          ctx.deployed.push(service);
        },
      ),
    ],
    {
      ctx: { services: [], deployed: [] },
    },
  );

  logSuccess("Deployment complete");
}
```

### Structured JSON Output

```typescript
import { logInfo, logSuccess, outputJson, isJsonMode } from "@rfmedia/common";

interface OperationResult {
  success: boolean;
  files: number;
  errors: string[];
}

async function runOperation(): Promise<OperationResult> {
  const result: OperationResult = {
    success: true,
    files: 0,
    errors: [],
  };

  // Log messages are suppressed in JSON mode
  logInfo("Starting operation...");

  try {
    result.files = await processFiles();
    logSuccess(`Processed ${result.files} files`);
  } catch (error) {
    result.success = false;
    result.errors.push(error.message);
  }

  // Output JSON to stdout (only in JSON mode)
  outputJson(result);

  return result;
}
```

### Environment Tools

The environment tools module provides utilities for checking CLI tool availability and environment
file access. These utilities support secrets injection via dotenvx or 1Password CLI.

#### Checking Tool Availability

```typescript
import { checkDotenvx, checkOp } from "@rfmedia/common";

// Check if dotenvx is available
const dotenvxResult = await checkDotenvx();
if (dotenvxResult.available) {
  console.log(`dotenvx version: ${dotenvxResult.version}`);
} else {
  console.error(dotenvxResult.error);
  // "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx"
}

// Check if 1Password CLI is available
const opResult = await checkOp();
if (opResult.available) {
  console.log(`op version: ${opResult.version}`);
} else {
  console.error(opResult.error);
  // "1Password CLI (op) not found in PATH. Install from: https://1password.com/downloads/command-line/"
}
```

#### Probing an Arbitrary Tool

`checkExternalTool` is the generic counterpart for callers that carry their own binary name and
install instructions, such as pluggable vulnerability-scanner backends. It performs a `which` lookup
followed by a version read and never throws; when the binary is absent it returns the install hint
verbatim as `error`.

```typescript
import { checkExternalTool } from "@rfmedia/common";

const trivy = await checkExternalTool(
  "trivy",
  "--version",
  "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
);

if (trivy.available) {
  console.log(`trivy version: ${trivy.version}`);
} else {
  console.error(trivy.error);
  // "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/"
}
```

All three arguments are required and positional. The version flag is passed verbatim, so a tool whose
version subcommand is a bare word works too — for example `checkExternalTool("grype", "version", …)`.

#### Checking Environment Files

```typescript
import { envFileExists } from "@rfmedia/common";

const exists = await envFileExists(".env");
if (!exists) {
  console.error("Environment file not found: .env");
}
```

#### Types

```typescript
import type { EnvTool, ToolCheckResult } from "@rfmedia/common";

// EnvTool type
type EnvTool = "dotenvx" | "op" | "none";

// ToolCheckResult interface
interface ToolCheckResult {
  available: boolean;
  version?: string;
  error?: string;
}
```

## Subpath Exports

The package supports subpath exports for granular imports:

```typescript
// Import everything from main entry
import { logInfo, runTasks, confirm } from "@rfmedia/common";

// Import specific modules
import { logInfo, logError } from "@rfmedia/common/logger";
import { runTasks, withSpinner } from "@rfmedia/common/progress";
import { confirm, prompt } from "@rfmedia/common/prompt";
import { checkDotenvx, checkOp, envFileExists } from "@rfmedia/common/env-tools";
```

## Development

### Prerequisites

- Node.js >= 22.23.4
- npm 10+

### Scripts

| Script              | Description                   |
| ------------------- | ----------------------------- |
| `npm run build`     | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type check without emitting   |
| `npm run clean`     | Remove `dist/` directory      |

### Project Structure

```
rf-common/
├── src/
│   ├── index.ts     # Main entry, re-exports all utilities
│   ├── logger.ts    # Logging utilities
│   ├── progress.ts  # Task list and spinner utilities
│   └── prompt.ts    # User prompt utilities
├── dist/            # Compiled output
├── package.json
├── tsconfig.json
└── README.md
```

### TypeScript Configuration

The package uses strict TypeScript settings:

- `ES2023` target
- `NodeNext` module resolution
- `strict: true`
- `noUncheckedIndexedAccess: true`
- Declaration files generated for consumers

### Adding New Utilities

1. Create a new module in `src/` (e.g., `src/newutil.ts`)
2. Export functions with JSDoc documentation
3. Re-export from `src/index.ts`
4. Add subpath export in `package.json` if needed
5. Update this README with API documentation

## Dependencies

| Package      | Purpose                             |
| ------------ | ----------------------------------- |
| `listr2`     | Task list rendering with spinners   |
| `picocolors` | Terminal colors (fast, lightweight) |

## License

MIT
