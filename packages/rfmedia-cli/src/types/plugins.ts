/**
 * Type definitions for the rfmedia plugin system.
 *
 * The plugin system enables extending copy operations with custom processing,
 * external tool integration, and metadata extraction. Plugins hook into the
 * copy workflow at four points: beforeCopy, afterCopy, processFile, and afterBatch.
 *
 * Uses discriminated unions with `type` field discriminator for type-safe hook
 * handling, following the SmartFilterRule pattern in filters.ts.
 */

import type { ExtendedMetadata } from "../lib/metadata.js";
import type { CopyResult } from "./results.js";

// ============================================================================
// Context Types
// ============================================================================

/**
 * Context provided to beforeCopy hooks before a file operation begins.
 *
 * @example
 * const hook: BeforeCopyHook = {
 *   type: 'beforeCopy',
 *   handler: async (ctx) => {
 *     console.log(`About to copy: ${ctx.sourcePath} -> ${ctx.destPath}`);
 *   }
 * };
 */
export interface BeforeCopyContext {
  /** Absolute path to the source file */
  sourcePath: string;
  /** Absolute path to the destination directory */
  destPath: string;
  /** Whether the file is an audio file */
  isAudioFile: boolean;
  /** Target format for conversion (if converting) */
  convertFormat?: string;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
}

/**
 * Context provided to afterCopy hooks after a file operation completes.
 *
 * @example
 * const hook: AfterCopyHook = {
 *   type: 'afterCopy',
 *   handler: async (ctx, result) => {
 *     console.log(`Copied via ${ctx.method}: ${ctx.sourcePath} (${ctx.fileSize} bytes)`);
 *   }
 * };
 */
export interface AfterCopyContext {
  /** Absolute path to the source file */
  sourcePath: string;
  /** Absolute path to the destination file */
  destPath: string;
  /** Method used to create the file */
  method: "copy" | "hardlink" | "converted";
  /** Size of the file in bytes */
  fileSize: number;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
}

/**
 * Context provided to processFile hooks during metadata scanning.
 *
 * @example
 * const hook: ProcessFileHook = {
 *   type: 'processFile',
 *   handler: async (ctx) => {
 *     console.log(`Processing: ${ctx.filePath}, rating: ${ctx.metadata.rating?.value}`);
 *   }
 * };
 */
export interface ProcessFileContext {
  /** Absolute path to the file being processed */
  filePath: string;
  /** Extended metadata read from the file */
  metadata: ExtendedMetadata;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
}

/**
 * Context provided to afterBatch hooks after all sources are processed.
 *
 * @example
 * const hook: AfterBatchHook = {
 *   type: 'afterBatch',
 *   handler: async (ctx) => {
 *     const totalCreated = ctx.results.reduce((sum, r) => sum + r.created, 0);
 *     console.log(`Batch complete: ${totalCreated} files created`);
 *   }
 * };
 */
export interface AfterBatchContext {
  /** Results from all copy operations */
  results: CopyResult[];
  /** Source paths that were processed */
  sources: string[];
  /** History session ID for undo tracking (if enabled) */
  historyId?: string;
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
}

// ============================================================================
// Hook Types (Discriminated Union)
// ============================================================================

/**
 * Hook that runs before each file copy/convert operation.
 * Use for pre-processing, validation, or logging.
 */
export interface BeforeCopyHook {
  /** Discriminator for beforeCopy hooks */
  type: "beforeCopy";
  /** Handler function called before each file operation */
  handler: (ctx: BeforeCopyContext) => Promise<void>;
}

/**
 * Hook that runs after each file copy/convert operation completes.
 * Use for post-processing, external tool integration, or logging.
 */
export interface AfterCopyHook {
  /** Discriminator for afterCopy hooks */
  type: "afterCopy";
  /** Handler function called after each file operation */
  handler: (ctx: AfterCopyContext, result: CopyResult) => Promise<void>;
}

/**
 * Hook that runs during filter mode metadata scanning.
 * Use for metadata extraction, rating sync, or analysis.
 */
export interface ProcessFileHook {
  /** Discriminator for processFile hooks */
  type: "processFile";
  /** Handler function called for each file with metadata */
  handler: (ctx: ProcessFileContext) => Promise<void>;
}

/**
 * Hook that runs after all sources in a batch are processed.
 * Use for batch notifications, external imports, or summary reporting.
 */
export interface AfterBatchHook {
  /** Discriminator for afterBatch hooks */
  type: "afterBatch";
  /** Handler function called after all sources complete */
  handler: (ctx: AfterBatchContext) => Promise<void>;
}

/**
 * Discriminated union of all plugin hook types.
 *
 * Use the `type` field to discriminate between hook types.
 *
 * @example
 * function getHookType(hook: PluginHook): string {
 *   switch (hook.type) {
 *     case 'beforeCopy':
 *       return 'Before copy hook';
 *     case 'afterCopy':
 *       return 'After copy hook';
 *     case 'processFile':
 *       return 'Process file hook';
 *     case 'afterBatch':
 *       return 'After batch hook';
 *   }
 * }
 */
export type PluginHook = BeforeCopyHook | AfterCopyHook | ProcessFileHook | AfterBatchHook;

/**
 * String literal union of valid hook type values.
 */
export type PluginHookType = PluginHook["type"];

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a PluginHook is a BeforeCopyHook.
 *
 * @param hook - The hook to check
 * @returns true if the hook is a BeforeCopyHook
 */
export function isBeforeCopyHook(hook: PluginHook): hook is BeforeCopyHook {
  return hook.type === "beforeCopy";
}

/**
 * Type guard to check if a PluginHook is an AfterCopyHook.
 *
 * @param hook - The hook to check
 * @returns true if the hook is an AfterCopyHook
 */
export function isAfterCopyHook(hook: PluginHook): hook is AfterCopyHook {
  return hook.type === "afterCopy";
}

/**
 * Type guard to check if a PluginHook is a ProcessFileHook.
 *
 * @param hook - The hook to check
 * @returns true if the hook is a ProcessFileHook
 */
export function isProcessFileHook(hook: PluginHook): hook is ProcessFileHook {
  return hook.type === "processFile";
}

/**
 * Type guard to check if a PluginHook is an AfterBatchHook.
 *
 * @param hook - The hook to check
 * @returns true if the hook is an AfterBatchHook
 */
export function isAfterBatchHook(hook: PluginHook): hook is AfterBatchHook {
  return hook.type === "afterBatch";
}

// ============================================================================
// Plugin Interface
// ============================================================================

/**
 * Main plugin interface for rfmedia-cli extensions.
 *
 * Plugins are loaded from `~/.rfmedia/plugins/` as ESM modules that export
 * a default object implementing this interface.
 *
 * @example
 * // ~/.rfmedia/plugins/my-plugin/index.js
 * export default {
 *   name: 'my-plugin',
 *   version: '1.0.0',
 *   description: 'Logs all copy operations',
 *   priority: 50,
 *   enabled: true,
 *   hooks: [
 *     {
 *       type: 'afterCopy',
 *       handler: async (ctx) => {
 *         console.log(`Copied: ${ctx.sourcePath}`);
 *       }
 *     }
 *   ]
 * };
 */
export interface RfmediaPlugin {
  /** Unique plugin name for identification */
  name: string;
  /** Semantic version string (e.g., '1.0.0') */
  version: string;
  /** Human-readable description of the plugin */
  description?: string;
  /**
   * Execution priority (lower numbers run first).
   * Default is 50. Range: 0-100 recommended.
   */
  priority?: number;
  /** Whether the plugin is enabled. Default is true. */
  enabled?: boolean;
  /** Array of hooks this plugin provides */
  hooks?: PluginHook[];
}

// ============================================================================
// External Command Plugin
// ============================================================================

/**
 * Hook configuration for external command plugins.
 * Maps hook types to enabled state or custom arguments.
 */
export interface ExternalCommandHooksConfig {
  /** Run after each file copy. True to enable, or custom args string. */
  afterCopy?: boolean | string;
  /** Run after all sources complete. True to enable, or custom args string. */
  afterBatch?: boolean | string;
}

/**
 * External command plugin interface for YAML-configured command wrappers.
 *
 * Enables integration with external tools (beets, MusicBrainz Picard, etc.)
 * without writing code. Configured in `.rfmedia.yaml`.
 *
 * @example
 * // In .rfmedia.yaml:
 * plugins:
 *   commands:
 *     - name: beets-import
 *       command: beet
 *       args: ['import', '-q', '{destPath}']
 *       timeout: 300000
 *       hooks:
 *         afterBatch: true
 */
export interface ExternalCommandPlugin {
  /** Unique name for this command plugin */
  name: string;
  /** Command to execute (must be in PATH) */
  command: string;
  /**
   * Command arguments. Supports placeholders:
   * - {sourcePath}: Source file path
   * - {destPath}: Destination file/directory path
   * - {metadata}: JSON-encoded metadata (for processFile hooks)
   */
  args?: string[];
  /** Timeout in milliseconds. Default is 60000 (1 minute). */
  timeout?: number;
  /** Which hooks to run this command on */
  hooks: ExternalCommandHooksConfig;
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Error thrown when a plugin fails to load.
 *
 * Common causes:
 * - Plugin file not found or not accessible
 * - Syntax error in plugin code
 * - Missing required exports (name, version)
 * - Invalid hook configuration
 */
export class PluginLoadError extends Error {
  /**
   * Create a new PluginLoadError.
   *
   * @param pluginName - Name of the plugin that failed to load
   * @param pluginPath - Path to the plugin file
   * @param reason - Description of why loading failed
   */
  constructor(
    public readonly pluginName: string,
    public readonly pluginPath: string,
    public readonly reason: string,
  ) {
    super(`Failed to load plugin '${pluginName}' from ${pluginPath}: ${reason}`);
    this.name = "PluginLoadError";
  }
}

/**
 * Error thrown when a plugin hook fails during execution.
 *
 * Contains the original error as the cause for debugging.
 */
export class PluginExecutionError extends Error {
  /**
   * Create a new PluginExecutionError.
   *
   * @param pluginName - Name of the plugin that failed
   * @param hookType - Type of hook that failed (beforeCopy, afterCopy, etc.)
   * @param cause - The original error that caused the failure
   */
  constructor(
    public readonly pluginName: string,
    public readonly hookType: string,
    public override readonly cause: Error,
  ) {
    super(`Plugin '${pluginName}' failed during ${hookType}: ${cause.message}`);
    this.name = "PluginExecutionError";
  }
}

/**
 * Error thrown when an external command plugin fails.
 *
 * Contains stderr output and exit code for debugging.
 */
export class ExternalCommandError extends Error {
  /**
   * Create a new ExternalCommandError.
   *
   * @param command - The command that failed
   * @param stderr - Standard error output from the command
   * @param exitCode - Exit code from the command (undefined if process was killed)
   */
  constructor(
    public readonly command: string,
    public readonly stderr: string,
    public readonly exitCode?: number,
  ) {
    super(
      `External command '${command}' failed${exitCode !== undefined ? ` (exit ${exitCode})` : ""}: ${stderr}`,
    );
    this.name = "ExternalCommandError";
  }
}
