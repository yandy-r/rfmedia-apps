/**
 * @rfmedia/common - Shared utilities for rfmedia CLI tools.
 *
 * This package provides common functionality used across rfmedia and rfapps CLIs.
 *
 * **Logger utilities** - Colored console output with debug/JSON modes
 * - `logInfo`, `logSuccess`, `logWarn`, `logError`, `logDebug`
 * - `output`, `outputSuccess`, `outputJson`
 * - `setDebugMode`, `setJsonMode`, `initLogger`
 *
 * **Progress utilities** - Visual task lists using listr2
 * - `runTasks`, `withSpinner`, `withProgress`
 * - `createScanTask`, `createProcessTask`, `createBatchTask`
 *
 * **Prompt utilities** - Interactive user prompts
 * - `confirm`, `confirmWithDefault`, `prompt`
 *
 * @example
 * ```typescript
 * import { logInfo, confirm, withSpinner } from '@rfmedia/common';
 *
 * logInfo('Starting operation...');
 * if (await confirm('Continue?')) {
 *   await withSpinner('Processing', async () => {
 *     // Long-running operation
 *   });
 * }
 * ```
 *
 * @module @rfmedia/common
 */

// Logger utilities
export {
  initLogger,
  setDebugMode,
  isDebugMode,
  setJsonMode,
  isJsonMode,
  formatDryRun,
  logInfo,
  logSuccess,
  logWarn,
  logError,
  logDebug,
  outputJson,
  output,
  outputSuccess,
  outputInlineSuccess,
  colors,
} from "./logger.js";

// Output format utilities
export {
  OUTPUT_FORMATS,
  setOutputFormat,
  getOutputFormat,
  isMachineFormat,
  isValidOutputFormat,
} from "./output.js";

export type { OutputFormat, Formatter } from "./output.js";

// Formatter serializers
export { formatMachineOutput } from "./formatters/index.js";

export type { CsvOptions } from "./formatters/index.js";

// Progress utilities
export {
  runTasks,
  createScanTask,
  createProcessTask,
  createBatchTask,
  withSpinner,
  withProgress,
} from "./progress.js";

export type { ProgressContext, TaskListOptions } from "./progress.js";

// Prompt utilities
export { confirm, confirmWithDefault, prompt } from "./prompt.js";

// Interactive utilities
export { isInteractiveEnvironment } from "./interactive.js";

// Secrets injection utilities
export {
  injectSecrets,
  SecretsInjectionError,
  hasUnresolvedTemplates,
  findUnresolvedTemplates,
  validateConfigSize,
  warnUnresolvedTemplates,
  ConfigSizeError,
  MAX_CONFIG_SIZE_BYTES,
} from "./secrets.js";

export type { InjectSecretsOptions } from "./secrets.js";

// Error handling utilities
export {
  handleCliError,
  formatError,
  registerErrorFormatter,
  outputFormattedError,
  PromptInterruptedError,
} from "./errors.js";

export type { ErrorFormatter, FormattedError } from "./errors.js";

// Environment tool utilities
export { checkDotenvx, checkExternalTool, checkOp, envFileExists } from "./env-tools.js";

export type { EnvTool, ToolCheckResult } from "./env-tools.js";

// MCP shared utilities
export {
  createMcpToolRegistry,
  createMcpSuccess,
  createMcpFailure,
  toMcpEnvelope,
  McpDuplicateToolError,
  McpToolNotFoundError,
} from "./mcp/core.js";

export {
  mcpSchema,
  schemaString,
  schemaNumber,
  schemaBoolean,
  schemaNull,
  schemaEnum,
  schemaArray,
  schemaUnknown,
  schemaRecord,
  schemaObject,
  schemaOptional,
  schemaUnion,
  validateSchema,
  McpSchemaValidationError,
} from "./mcp/schema.js";

export { normalizeMcpError, toMcpFailure } from "./mcp/errors.js";

export type { McpJsonSchema, McpSchema, McpSchemaValidationIssue } from "./mcp/schema.js";

export type {
  JsonPrimitive,
  JsonValue,
  JsonObject,
  JsonArray,
  McpErrorEnvelope,
  McpSuccessEnvelope,
  McpFailureEnvelope,
  McpToolEnvelope,
  McpToolContext,
  McpToolDefinition,
  McpAnyToolDefinition,
  McpToolMetadata,
  McpToolCall,
} from "./mcp/types.js";
