/**
 * Secrets injection utilities for config file template processing.
 *
 * This module provides template-based secrets injection for configuration files
 * using `{{ VAR_NAME }}` syntax. Environment variables are resolved at config
 * load time, enabling secure secrets management through dotenvx or 1Password CLI.
 *
 * ## Design Notes
 *
 * **Circular References**: This implementation does not handle circular template
 * references because environment variable values are always string literals from
 * `process.env`. Unlike template engines that support variable interpolation
 * within values, our templates resolve directly to environment values which
 * cannot themselves contain template syntax that would be processed.
 *
 * @module @rfmedia/common/secrets
 */

import { logDebug, logWarn } from "./logger.js";

/**
 * Maximum allowed config file size in bytes (1 MB).
 * Prevents performance issues with very large files.
 */
export const MAX_CONFIG_SIZE_BYTES = 1024 * 1024;

/**
 * Options for the injectSecrets function.
 */
export interface InjectSecretsOptions {
  /** Environment object to use for variable resolution. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Path to the config file being processed (for better error messages). */
  configPath?: string;
}

/**
 * Template pattern for matching `{{ VAR_NAME }}` with optional whitespace.
 * Matches: `{{ FOO }}`, `{{FOO}}`, `{{  FOO  }}`
 */
const TEMPLATE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Performs template substitution on raw file content, replacing `{{ VAR_NAME }}`
 * placeholders with environment variable values.
 *
 * This function operates on raw string content BEFORE YAML/JSON parsing to
 * preserve type information. Templates in YAML like `port: "{{ PORT }}"` will
 * resolve to the actual value, allowing YAML parsing to handle type coercion.
 *
 * @param content - Raw file content containing template placeholders
 * @param options - Configuration options for injection
 * @returns Content with all templates resolved to environment variable values
 * @throws {SecretsInjectionError} If any template variable is not found in environment
 *
 * @example
 * ```typescript
 * const content = `
 * plex:
 *   token: "{{ PLEX_TOKEN }}"
 *   port: {{ PLEX_PORT }}
 * `;
 *
 * // With PLEX_TOKEN=abc123 and PLEX_PORT=32400 in environment:
 * const processed = injectSecrets(content, { configPath: '.rfmedia.yaml' });
 * // Result:
 * // plex:
 * //   token: "abc123"
 * //   port: 32400
 * ```
 */
export function injectSecrets(content: string, options: InjectSecretsOptions = {}): string {
  const { env = process.env, configPath } = options;

  return content.replace(TEMPLATE_PATTERN, (match, varName: string) => {
    const value = env[varName];
    if (value === undefined) {
      throw new SecretsInjectionError(varName, configPath);
    }
    // Log variable name only, never the value (security)
    logDebug(`Resolved template variable: ${varName}`);
    return value;
  });
}

/**
 * Custom error class for secrets injection failures.
 *
 * Thrown when a template variable references an environment variable
 * that is not set in the current environment.
 *
 * @example
 * ```typescript
 * try {
 *   const content = injectSecrets(configContent, { configPath: '.rfmedia.yaml' });
 * } catch (error) {
 *   if (error instanceof SecretsInjectionError) {
 *     console.error(`Missing env var: ${error.variableName}`);
 *     console.error(`Config file: ${error.configPath}`);
 *   }
 * }
 * ```
 */
export class SecretsInjectionError extends Error {
  /** The name of the unresolved environment variable */
  readonly variableName: string;
  /** Path to the config file being processed (if provided) */
  readonly configPath?: string;

  /**
   * Creates a new SecretsInjectionError.
   *
   * @param variableName - The name of the missing environment variable
   * @param configPath - Optional path to the config file being processed
   */
  constructor(variableName: string, configPath?: string) {
    const pathInfo = configPath ? ` in ${configPath}` : "";
    super(
      `Environment variable '${variableName}' is not set (required by config template${pathInfo})`,
    );
    this.name = "SecretsInjectionError";
    this.variableName = variableName;
    this.configPath = configPath;
  }
}

/**
 * Check if content contains any unresolved template patterns.
 *
 * This is a safety check to catch edge cases like:
 * - `{{ }}` (empty variable name)
 * - `{{ FOO BAR }}` (space in variable name - invalid but suspicious)
 *
 * The main `injectSecrets()` function handles valid templates with `\w+` pattern.
 * This function uses a broader pattern to catch any remaining `{{ ... }}` syntax
 * that might indicate malformed or unprocessed templates.
 *
 * @param content - The content to check for unresolved templates
 * @returns True if any template-like patterns remain unresolved
 *
 * @example
 * ```typescript
 * const processed = injectSecrets(content, { configPath: '.rfmedia.yaml' });
 * if (hasUnresolvedTemplates(processed)) {
 *   console.warn('Warning: Content contains unresolved template patterns');
 * }
 * ```
 */
export function hasUnresolvedTemplates(content: string): boolean {
  // Use a fresh regex without 'g' flag to avoid lastIndex state issues
  return /\{\{[^}]*\}\}/.test(content);
}

/**
 * Find all unresolved template patterns in content.
 *
 * Returns an array of all template-like patterns that remain in the content
 * after secrets injection. Useful for logging detailed warnings about
 * malformed or unprocessed templates.
 *
 * @param content - The content to search for unresolved templates
 * @returns Array of unresolved template strings (e.g., `['{{ FOO BAR }}', '{{ }}']`)
 *
 * @example
 * ```typescript
 * const processed = injectSecrets(content, { configPath: '.rfmedia.yaml' });
 * const unresolved = findUnresolvedTemplates(processed);
 * if (unresolved.length > 0) {
 *   console.warn(`Unresolved templates: ${unresolved.join(', ')}`);
 * }
 * ```
 */
export function findUnresolvedTemplates(content: string): string[] {
  // Reset lastIndex to ensure consistent behavior
  const pattern = /\{\{[^}]*\}\}/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    matches.push(match[0]);
  }

  return matches;
}

/**
 * Custom error class for config file size validation failures.
 *
 * Thrown when a config file exceeds the maximum allowed size.
 */
export class ConfigSizeError extends Error {
  /** The actual size of the config file in bytes */
  readonly actualSize: number;
  /** The maximum allowed size in bytes */
  readonly maxSize: number;
  /** Path to the config file (if provided) */
  readonly configPath?: string;

  constructor(actualSize: number, maxSize: number, configPath?: string) {
    const pathInfo = configPath ? ` (${configPath})` : "";
    const actualKb = Math.round(actualSize / 1024);
    const maxKb = Math.round(maxSize / 1024);
    super(`Config file${pathInfo} exceeds maximum size: ${actualKb}KB > ${maxKb}KB limit`);
    this.name = "ConfigSizeError";
    this.actualSize = actualSize;
    this.maxSize = maxSize;
    this.configPath = configPath;
  }
}

/**
 * Validate that config content does not exceed the maximum allowed size.
 *
 * @param content - The raw config file content
 * @param configPath - Optional path to the config file (for error messages)
 * @throws {ConfigSizeError} If content exceeds MAX_CONFIG_SIZE_BYTES
 *
 * @example
 * ```typescript
 * const content = await readFile(configPath, 'utf-8');
 * validateConfigSize(content, configPath); // Throws if too large
 * const processed = injectSecrets(content, { configPath });
 * ```
 */
export function validateConfigSize(content: string, configPath?: string): void {
  const size = Buffer.byteLength(content, "utf-8");
  if (size > MAX_CONFIG_SIZE_BYTES) {
    throw new ConfigSizeError(size, MAX_CONFIG_SIZE_BYTES, configPath);
  }
}

/**
 * Log warnings for any unresolved template patterns found after injection.
 *
 * This is a convenience function that combines `findUnresolvedTemplates()`
 * with warning output. Call this after `injectSecrets()` to catch malformed
 * templates that weren't processed.
 *
 * @param content - The processed content to check
 * @param configPath - Optional path to the config file (for context in warnings)
 *
 * @example
 * ```typescript
 * const processed = injectSecrets(content, { configPath });
 * warnUnresolvedTemplates(processed, configPath);
 * ```
 */
export function warnUnresolvedTemplates(content: string, configPath?: string): void {
  const unresolved = findUnresolvedTemplates(content);
  if (unresolved.length > 0) {
    const pathInfo = configPath ? ` in ${configPath}` : "";
    logWarn(
      `Found ${unresolved.length} unresolved template pattern(s)${pathInfo}: ${unresolved.join(", ")}`,
    );
    logWarn(
      "These may indicate malformed templates (invalid variable names, spaces, or special characters)",
    );
  }
}
