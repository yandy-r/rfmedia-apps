/**
 * Validate action for rfapps CLI
 *
 * Validates configuration against compose.yml to detect:
 * - Services in compose.yml missing from config profiles
 * - Services in config not found in compose.yml
 * - Orphaned sidecar mappings
 * - Invalid profile assignments
 */

import { logInfo, logSuccess, logWarn, formatError, outputFormattedError } from "@rfmedia/common";

import { formatOutput } from "../lib/formatters/index.js";
import { loadConfig } from "../lib/config.js";
import {
  validateConfigAgainstCompose,
  formatValidationWarnings,
  hasErrors,
} from "../lib/validation.js";
import { ConfigValidationError, ComposeFileParseError } from "../lib/errors.js";
import type { ComposeOptions, GlobalOptions } from "../types/index.js";

/**
 * Combined options for validate command
 */
export interface ValidateOptions extends GlobalOptions, ComposeOptions {}

/**
 * Execute the validate command
 */
export async function executeValidate(options: ValidateOptions): Promise<void> {
  // Capture composePath outside try/catch for error handling
  let composePath = "compose.yml"; // default fallback
  try {
    // Load configuration
    logInfo("Loading configuration...");
    const config = await loadConfig();

    // Determine compose file path
    composePath = options.composePath ?? config.composePath;
    logInfo(`Validating against ${composePath}...`);

    // Run validation
    const warnings = await validateConfigAgainstCompose(config, composePath);

    // Resolve output format
    const format = options.output ?? "text";

    // Handle structured output
    if (format !== "text") {
      await formatOutput(format, {
        valid: !hasErrors(warnings),
        warnings: warnings.map((w) => ({
          message: w.message,
          context: w.context,
          severity: w.severity,
        })),
      });
      process.exitCode = hasErrors(warnings) ? 1 : 0;
      return;
    }

    // Display results
    if (warnings.length === 0) {
      logSuccess("✓ Configuration is valid and in sync with compose.yml");
      return;
    }

    // Format and display warnings
    const formatted = formatValidationWarnings(warnings);
    const errorCount = warnings.filter((w) => w.severity === "error").length;
    const warningCount = warnings.filter((w) => w.severity === "warning").length;

    logWarn(`Found ${warnings.length} validation issue(s):`);
    for (const msg of formatted) {
      console.log(`  ${msg}`);
    }

    // Summary
    console.log();
    if (errorCount > 0) {
      const error = new ConfigValidationError(
        "config",
        composePath,
        `${errorCount} error(s), ${warningCount} warning(s)`,
      );
      const formattedErr = formatError(error);
      outputFormattedError(formattedErr);
      process.exitCode = 1;
    } else {
      logWarn(`${warningCount} warning(s) found`);
      logInfo("Warnings indicate potential issues but won't prevent operation");
    }
  } catch (err) {
    if (err instanceof ConfigValidationError || err instanceof ComposeFileParseError) {
      const formatted = formatError(err);
      outputFormattedError(formatted);
      process.exitCode = 1;
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error = new ConfigValidationError("config", composePath, message);
    const formatted = formatError(error);
    outputFormattedError(formatted);
    process.exitCode = 1;
  }
}
