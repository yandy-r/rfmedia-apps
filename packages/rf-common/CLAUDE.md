# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

`@rfmedia/common` is a shared utilities package for rfmedia CLI tools (rfapps-cli and rfmedia-cli).
It provides consistent logging, progress display, user prompts, secrets injection, and error
handling across CLI applications.

## Tech Stack

- **Language**: TypeScript with ES2023 target
- **Module System**: ESM with NodeNext resolution (`.js` extensions required in imports)
- **Runtime**: Node.js 22+
- **Key Dependencies**:
  - `listr2` - Task list rendering with spinners
  - `picocolors` - Terminal colors (fast, lightweight)

## Project Structure

```
rf-common/
├── src/
│   ├── index.ts        # Main entry, re-exports all modules
│   ├── logger.ts       # Colored logging with debug/JSON modes
│   ├── progress.ts     # Task lists and spinners using listr2
│   ├── prompt.ts       # Interactive user prompts (confirm, prompt)
│   ├── interactive.ts  # TTY detection and cancellation handling
│   ├── secrets.ts      # Template-based secrets injection ({{ VAR }})
│   ├── errors.ts       # Centralized error formatting and handling
│   └── env-tools.ts    # CLI tool availability checking (dotenvx, op)
├── dist/               # Compiled output
├── package.json        # Includes subpath exports
└── README.md           # API documentation
```

## Development Commands

```bash
# Build to dist/
npm run build

# Type checking only
npm run typecheck

# Clean build artifacts
npm run clean

# Run tests
npm test              # Watch mode
npm run test:run      # Single run
```

## Architecture Patterns

### Logger Module

All log output goes to stderr to keep stdout clean for JSON data output.

```typescript
// Initialize with tool-specific debug env var
initLogger({ debugEnvVar: "RFAPPS_DEBUG" });

// Log functions (suppressed in JSON mode)
logInfo("message"); // Blue [INFO] prefix
logSuccess("message"); // Green [SUCCESS] prefix
logWarn("message"); // Yellow [WARN] prefix
logError("message"); // Red [ERROR] prefix
logDebug("message"); // Only when debug mode enabled

// JSON output (only in JSON mode, goes to stdout)
outputJson({ data: "value" });
```

**Key Patterns**:

- `setJsonMode(true)` suppresses all log functions
- `setDebugMode(true)` enables `logDebug()` output
- `outputJson()` only outputs when JSON mode is enabled
- `output()` and `outputSuccess()` for clean user-facing messages

### Progress Module

Wraps listr2 with automatic JSON mode suppression.

```typescript
// Task factory functions
const scanTask = createScanTask<Context, void>("Scanning", async (ctx) => {
  ctx.files = await findFiles();
});

const processTask = createProcessTask<Context, File>(
  "Processing",
  (ctx) => ctx.files,
  async (file, index, ctx, updateTitle) => {
    updateTitle(file.name); // Shows: "Processing (1/10): filename.txt"
    await process(file);
  },
);

await runTasks([scanTask, processTask], { ctx: initialContext });

// Convenience wrappers
const result = await withSpinner("Loading", async () => loadData());
const results = await withProgress("Processing", items, async (item, i, updateTitle) => {
  updateTitle(item.name);
  return await processItem(item);
});
```

**Key Patterns**:

- `runTasks()` uses silent renderer when JSON mode is enabled
- Task factories (`createScanTask`, `createProcessTask`, `createBatchTask`) provide consistent
  patterns
- `withSpinner()` for single operations, `withProgress()` for item iteration

### Prompt Module

Interactive prompts using raw keypress detection with TTY handling.

```typescript
// Default No (user must type 'y')
const confirmed = await confirm("Delete files?"); // [y/N]

// Default Yes (Enter confirms)
const proceed = await confirmWithDefault("Continue?"); // [Y/n]

// Text input with optional default
const name = await prompt("Enter name:", "default");
```

**Key Patterns**:

- Uses raw mode keypress detection to avoid buffered input issues
- Includes stdin drain and cooling period to handle stale input from Ink UI
- Non-TTY environments return sensible defaults (false for confirm, true for confirmWithDefault)
- All prompt output goes to stderr

### Secrets Module

Template-based secrets injection for config files.

```typescript
// Replace {{ VAR_NAME }} with environment variable values
const processed = injectSecrets(configContent, { configPath: ".rfmedia.yaml" });

// Validate config size before processing
validateConfigSize(content, configPath); // Throws ConfigSizeError if > 1MB

// Check for unresolved templates after injection
warnUnresolvedTemplates(processed, configPath);

// Custom errors
try {
  injectSecrets(content, options);
} catch (error) {
  if (error instanceof SecretsInjectionError) {
    console.error(`Missing: ${error.variableName}`);
  }
}
```

**Key Patterns**:

- Process raw content BEFORE YAML/JSON parsing to preserve types
- Throws `SecretsInjectionError` for missing environment variables
- Variable names are logged for debugging; values are never logged (security)
- Use `hasUnresolvedTemplates()` / `findUnresolvedTemplates()` for validation

### Error Handling Module

Centralized error formatting with extensible formatters.

```typescript
// Main entry point for CLI error handling
try {
  await program.parseAsync(process.argv);
} catch (error) {
  handleCliError(error); // Formats, outputs, and exits
}

// Register custom error formatters
registerErrorFormatter({
  canHandle: (error): error is MyError => error instanceof MyError,
  formatMessage: (error) => `Custom: ${error.field}`,
  getSuggestions: (error) => ["Try this", "Or that"],
  exitCode: 2,
});

// Manual formatting
const formatted = formatError(error);
// { message, suggestions, exitCode, originalError }
```

**Key Patterns**:

- Formatters are checked in registration order (register specific before generic)
- Debug mode shows error type, custom properties, and stack trace
- Built-in formatters for `SecretsInjectionError` and `ConfigSizeError`

### Environment Tools Module

CLI tool availability checking for secrets injection.

```typescript
// Check tool availability
const dotenvxResult = await checkDotenvx();
const opResult = await checkOp();

if (!dotenvxResult.available) {
  console.error(dotenvxResult.error);
  // "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx"
}

// Check env file accessibility
const exists = await envFileExists(".env");
```

### Export Patterns

Main entry re-exports everything; subpath exports for granular imports.

```typescript
// Main entry (recommended)
import { logInfo, runTasks, confirm, injectSecrets } from "@rfmedia/common";

// Subpath imports (for tree-shaking or explicit dependencies)
import { logInfo } from "@rfmedia/common/logger";
import { runTasks } from "@rfmedia/common/progress";
import { confirm } from "@rfmedia/common/prompt";
import { checkDotenvx } from "@rfmedia/common/env-tools";
```

## GitHub Contribution Templates

When creating GitHub issues or pull requests, all coding agents must follow repository templates
exactly.

### Issue Templates (Required)

- Always use GitHub issue forms from `.github/ISSUE_TEMPLATE/`; do not open blank issues.
- Choose the correct form:
  - Enhancement: `.github/ISSUE_TEMPLATE/enhancement.yml`
  - Bug: `.github/ISSUE_TEMPLATE/bug.yml`
  - Question: `.github/ISSUE_TEMPLATE/question.yml`
  - Documentation: `.github/ISSUE_TEMPLATE/docs.yml`
  - Chore: `.github/ISSUE_TEMPLATE/chore.yml`
  - Security hardening (public-safe only): `.github/ISSUE_TEMPLATE/security.yml`
- For exploitable vulnerabilities or sensitive security details, do not use public issues; use
  private reporting from `.github/ISSUE_TEMPLATE/config.yml` (`Private Security Report` link).

### Pull Request Template (Required)

- Always use `.github/pull_request_template.md` as the PR body baseline.
- Preserve required sections:
  - `## Summary`
  - `## Changes`
  - `## Testing`
  - `## Related Issues` (use `Closes #<issue-number>` when applicable)
  - `## Breaking Changes`
  - `## Risk and Rollback`
  - `## Checklist`
- Include exact verification commands and pass/fail outcomes in `## Testing`.

### Agent Markdown Mirrors

- For offline drafting, automation, or agent-generated artifacts, use markdown mirrors in
  `docs/templates/github/`.
- Mirror files are drafting aids only; GitHub issue forms and PR template remain the source of truth
  for final submissions.

## Code Quality Standards

### Type Safety

- **NEVER use `any` type** - Use proper types or `unknown` with type guards
- All exported functions must have explicit return types
- Use discriminated unions for mode/state variations
- Generic type parameters should have meaningful constraints

### Error Handling

- Throw specific error classes (`SecretsInjectionError`, `ConfigSizeError`)
- Include context in error messages (file paths, variable names)
- Never log sensitive values (secrets, tokens)

### Output Conventions

- All log output to stderr (keep stdout clean for JSON/data)
- Use `output()` / `outputSuccess()` for user-facing messages without prefixes
- JSON mode suppresses all human-readable output

## Common Tasks

### Adding New Utilities

1. Create a new module in `src/` (e.g., `src/newutil.ts`)
2. Export functions with JSDoc documentation
3. Re-export from `src/index.ts`:

   ```typescript
   export { functionName } from "./newutil.js";
   export type { TypeName } from "./newutil.js";
   ```

4. Add subpath export in `package.json` if needed:

   ```json
   "./newutil": {
     "types": "./dist/newutil.d.ts",
     "import": "./dist/newutil.js"
   }
   ```

5. Update README.md with API documentation

### Adding New Error Formatters

Register formatters in consuming packages (rfapps-cli, rfmedia-cli):

```typescript
import { registerErrorFormatter } from "@rfmedia/common";

registerErrorFormatter({
  canHandle: (error): error is MyAppError => error instanceof MyAppError,
  formatMessage: (error) => error.userMessage,
  getSuggestions: (error) => error.suggestions,
  exitCode: error.code,
});
```

### Extending Logger with Custom Levels

The logger is intentionally minimal. For custom log levels, use the `colors` export:

```typescript
import { colors } from "@rfmedia/common";

function logCustom(message: string): void {
  console.error(`${colors.magenta("[CUSTOM]")} ${message}`);
}
```
