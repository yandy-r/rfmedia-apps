/**
 * rfmedia-specific error formatters.
 *
 * This module registers error formatters for rfmedia-specific error types,
 * providing user-friendly error messages and actionable suggestions.
 *
 * @module rfmedia-cli/lib/error-formatters
 */

import { registerErrorFormatter } from "@rfmedia/common";
import { PlexAuthError } from "./adapters/plex-adapter.js";
import { ConfigError } from "./config-validation.js";
import { FfmpegNotFoundError, ConversionError } from "./convert.js";
import { InsufficientSpaceError } from "./disk.js";
import { PathsYamlError, SourceSelectionError } from "./paths-yaml.js";
import {
  InvalidNumericArgumentError,
  OptionConflictError,
  MissingRequiredArgumentError,
  LookupNotFoundError,
  InvalidOutputFormatError,
  PlanArtifactError,
  PlanValidationError,
  PlanStaleError,
} from "./errors.js";
import { findClosestMatch } from "./fuzzy-match.js";
import { PluginLoadError, PluginExecutionError } from "../types/plugins.js";

let formattersRegistered = false;

/**
 * Registers all rfmedia-specific error formatters.
 *
 * This function should be called early in the CLI initialization
 * to ensure formatters are available before any errors occur.
 */
export function registerRfmediaErrorFormatters(): void {
  if (formattersRegistered) {
    return;
  }
  formattersRegistered = true;

  // InvalidNumericArgumentError - Invalid numeric CLI arguments
  registerErrorFormatter({
    canHandle: (error): error is InvalidNumericArgumentError =>
      error instanceof InvalidNumericArgumentError,
    formatMessage: (error) =>
      `Invalid value '${String(error.value)}' for ${error.argument}: ${error.reason}`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.min !== undefined && error.max !== undefined) {
        suggestions.push(`Expected a value between ${error.min} and ${error.max}`);
      } else if (error.min !== undefined) {
        suggestions.push(`Expected a value greater than or equal to ${error.min}`);
      } else if (error.max !== undefined) {
        suggestions.push(`Expected a value less than or equal to ${error.max}`);
      }

      suggestions.push("Check the command help for valid option values");
      suggestions.push("Run with --debug for more details");
      return suggestions;
    },
    exitCode: 1,
  });

  // OptionConflictError - Mutually exclusive option combinations
  registerErrorFormatter({
    canHandle: (error): error is OptionConflictError => error instanceof OptionConflictError,
    formatMessage: (error) => `Cannot use ${error.option} with ${error.conflictingOption}`,
    getSuggestions: (error) => [
      error.details ?? `Use either ${error.option} or ${error.conflictingOption}, not both`,
      "Check the command help for valid option combinations",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // PlanArtifactError - Plan artifact IO/safety failures (symlink, oversize, malformed, tamper)
  registerErrorFormatter({
    canHandle: (error): error is PlanArtifactError => error instanceof PlanArtifactError,
    formatMessage: (error) => error.message,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.code === "PLAN_CHECKSUM_MISMATCH") {
        suggestions.push("The plan file was modified after creation; this is never overridable");
      }

      suggestions.push("Regenerate the plan with: rfmedia copy ... --plan");
      suggestions.push("Run with --debug for more details");
      return suggestions;
    },
    exitCode: 1,
  });

  // PlanValidationError - Plan failed the assertCopyPlanV1 allowlist validation
  registerErrorFormatter({
    canHandle: (error): error is PlanValidationError => error instanceof PlanValidationError,
    formatMessage: (error) => error.message,
    getSuggestions: () => [
      "Plans are version-locked (rfmedia.copy-plan.v1); regenerate with the current CLI",
      "Regenerate the plan with: rfmedia copy ... --plan",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // PlanStaleError - Staleness errors block apply (world drifted since planning)
  registerErrorFormatter({
    canHandle: (error): error is PlanStaleError => error instanceof PlanStaleError,
    formatMessage: (error) => {
      const lines: string[] = [error.message];

      for (const finding of error.findings) {
        lines.push(`  [${finding.severity}] ${finding.code}: ${finding.message}`);

        const paths = finding.paths ?? [];
        for (const path of paths.slice(0, 10)) {
          lines.push(`    ${path}`);
        }
        if (paths.length > 10) {
          lines.push(`    +${paths.length - 10} more`);
        }
      }

      return lines.join("\n");
    },
    getSuggestions: () => [
      "Pass --force-stale to override world-drift errors (never overrides corruption)",
      "Regenerate the plan to re-review current state",
    ],
    exitCode: 1,
  });

  // MissingRequiredArgumentError - Missing required input or dependent option
  registerErrorFormatter({
    canHandle: (error): error is MissingRequiredArgumentError =>
      error instanceof MissingRequiredArgumentError,
    formatMessage: (error) => error.message,
    getSuggestions: () => [
      "Provide the required argument(s) and retry",
      "Check the command help for required inputs",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // PlexAuthError - Plex enrollment / JWT credential lifecycle failures (#251)
  //
  // Without this entry the frozen `remediation` literal — the one thing that
  // names the exact next command — is silently dropped in the default text
  // output mode, where it is needed most. `message` comes from a frozen local
  // table and `remediation` interpolates only locally constructed paths, so
  // nothing plex.tv supplied can reach the terminal through here.
  // `observedKeys` is deliberately NOT surfaced: it belongs to `--output json`
  // diagnostics and `--debug`, not to unconditional suggestions.
  registerErrorFormatter({
    canHandle: (error): error is PlexAuthError => error instanceof PlexAuthError,
    formatMessage: (error) => error.message,
    getSuggestions: (error) => {
      const suggestions: string[] = [error.remediation];

      if (error.retryAfterSeconds !== undefined) {
        suggestions.push(`Plex asked for a ${error.retryAfterSeconds}s wait before retrying`);
      }

      suggestions.push("Run with --debug for more details");
      return suggestions;
    },
    exitCode: 1,
  });

  // LookupNotFoundError - Unknown named lookup values (e.g. filters)
  registerErrorFormatter({
    canHandle: (error): error is LookupNotFoundError => error instanceof LookupNotFoundError,
    formatMessage: (error) => `Unknown ${error.lookupType}: '${error.value}'`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      const match = error.suggestion ?? findClosestMatch(error.value, error.availableValues);
      if (match) {
        suggestions.push(`Did you mean '${match}'?`);
      }

      if (error.availableValues.length > 0 && error.availableValues.length <= 12) {
        suggestions.push(
          `Available values for ${error.lookupType}: ${error.availableValues.join(", ")}`,
        );
      }

      if (error.context) {
        suggestions.push(`Context: ${error.context}`);
      }

      if (error.suggestions.length > 0) {
        suggestions.push(...error.suggestions);
      }

      suggestions.push("Run with --debug for more details");
      return suggestions;
    },
    exitCode: 1,
  });

  // InvalidOutputFormatError - Invalid global --output format
  registerErrorFormatter({
    canHandle: (error): error is InvalidOutputFormatError =>
      error instanceof InvalidOutputFormatError,
    formatMessage: (error) => `Unknown output format: ${error.outputFormat}`,
    getSuggestions: (error) => [
      `Valid formats: ${error.validFormats.join(", ")}`,
      "Use --json as shorthand for --output json",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // ConfigError - Configuration validation errors
  registerErrorFormatter({
    canHandle: (error): error is ConfigError => error instanceof ConfigError,
    formatMessage: (error) => {
      const propInfo = error.propertyPath ? ` at '${error.propertyPath}'` : "";
      return `Invalid configuration${propInfo}: ${error.message}`;
    },
    getSuggestions: (error) => [
      `Check the configuration in ${error.configPath}`,
      error.propertyPath
        ? `Verify the value of '${error.propertyPath}'`
        : "Verify all configuration values are correct",
      "Run rfmedia init to generate a valid configuration file",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // FfmpegNotFoundError - FFmpeg not installed
  registerErrorFormatter({
    canHandle: (error): error is FfmpegNotFoundError => error instanceof FfmpegNotFoundError,
    formatMessage: () => "FFmpeg is not installed or not found in PATH",
    getSuggestions: () => [
      "Install ffmpeg to use audio conversion features:",
      "  Ubuntu/Debian: sudo apt install ffmpeg",
      "  macOS: brew install ffmpeg",
      "  Windows: choco install ffmpeg",
      "Ensure ffmpeg is in your PATH after installation",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // ConversionError - Audio conversion failures
  registerErrorFormatter({
    canHandle: (error): error is ConversionError => error instanceof ConversionError,
    formatMessage: (error) => `Audio conversion failed for ${error.sourcePath}: ${error.reason}`,
    getSuggestions: (error) => [
      "Check that the source file is a valid audio file",
      "Verify ffmpeg is properly installed and up to date",
      "Check available disk space at the destination",
      `Target path: ${error.destPath}`,
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // InsufficientSpaceError - Not enough disk space
  registerErrorFormatter({
    canHandle: (error): error is InsufficientSpaceError => error instanceof InsufficientSpaceError,
    formatMessage: (error) => {
      const available = formatBytesSimple(error.availableBytes);
      const required = formatBytesSimple(error.requiredBytes);
      return `Insufficient disk space: ${available} available, ${required} required`;
    },
    getSuggestions: (error) => [
      `Free up space on ${error.diskPath}`,
      "Use --hardlink to avoid copying (requires same filesystem)",
      "Use --no-require-space to skip the disk space check (risky)",
      "Consider using audio conversion (--convert) to reduce file sizes",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // PathsYamlError - Invalid paths YAML file
  registerErrorFormatter({
    canHandle: (error): error is PathsYamlError => error instanceof PathsYamlError,
    formatMessage: (error) => `Invalid paths YAML file (${error.filePath}): ${error.message}`,
    getSuggestions: (error) => [
      `Check the YAML syntax in ${error.filePath}`,
      "Ensure all paths are properly quoted if they contain special characters",
      "Verify the file structure matches the expected format",
      "See docs for the correct paths YAML format",
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // SourceSelectionError - Invalid source selection
  registerErrorFormatter({
    canHandle: (error): error is SourceSelectionError => error instanceof SourceSelectionError,
    formatMessage: (error) => `Invalid source selection: ${error.message}`,
    getSuggestions: (error) => {
      const suggestions: string[] = [];

      if (error.selectionSummary) {
        suggestions.push(`Selection: ${error.selectionSummary}`);
      }

      if (error.suggestion) {
        suggestions.push(`Did you mean '${error.suggestion}'?`);
      }

      if (error.availableSources) {
        suggestions.push(`Available sources:\n${error.availableSources}`);
      }

      suggestions.push('Check that --source-idx uses valid indices (e.g., "1,3-5")');
      suggestions.push(
        "Use --source-name for unified search across groups, artists, and basenames",
      );
      suggestions.push("Run with --debug for more details");
      return suggestions;
    },
    exitCode: 1,
  });

  // PluginLoadError - Plugin failed to load
  registerErrorFormatter({
    canHandle: (error): error is PluginLoadError => error.name === "PluginLoadError",
    formatMessage: (error) => `Failed to load plugin '${error.pluginName}'`,
    getSuggestions: (error) => [
      `Check the plugin at ${error.pluginPath}`,
      `Ensure the plugin exports a valid RfmediaPlugin interface`,
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });

  // PluginExecutionError - Plugin hook failed during execution
  registerErrorFormatter({
    canHandle: (error): error is PluginExecutionError => error.name === "PluginExecutionError",
    formatMessage: (error) => `Plugin '${error.pluginName}' failed during ${error.hookType}`,
    getSuggestions: (error) => [
      `Check the plugin configuration`,
      `Disable the plugin with: plugins.disabled: ["${error.pluginName}"]`,
      "Run with --debug for more details",
    ],
    exitCode: 1,
  });
}

/**
 * Simple byte formatting helper (avoiding circular imports with disk.ts).
 */
function formatBytesSimple(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const unit = units[unitIndex];
  if (unit === undefined) {
    return `${bytes} B`;
  }

  return `${value.toFixed(1)} ${unit}`;
}
