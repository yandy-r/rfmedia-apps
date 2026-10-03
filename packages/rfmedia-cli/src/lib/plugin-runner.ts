/**
 * Plugin hook execution engine for rfmedia CLI.
 *
 * Provides functions to run plugin hooks with priority ordering,
 * error handling, and timing. Supports AbortSignal for graceful
 * interruption of long-running plugin operations.
 */

import { logDebug } from "./logger.js";
import {
  isBeforeCopyHook,
  isAfterCopyHook,
  isProcessFileHook,
  isAfterBatchHook,
  PluginExecutionError,
} from "../types/plugins.js";
import type {
  RfmediaPlugin,
  BeforeCopyContext,
  AfterCopyContext,
  ProcessFileContext,
  AfterBatchContext,
} from "../types/plugins.js";
import type { CopyResult } from "../types/results.js";

/**
 * Options for running plugin hooks.
 */
export interface RunHooksOptions {
  /** Abort signal for cancellation support */
  signal?: AbortSignal;
  /** Continue running hooks after an error (default: true) */
  continueOnError?: boolean;
}

/**
 * Result from running a single plugin hook.
 */
export interface HookResult {
  /** Name of the plugin that ran */
  pluginName: string;
  /** Whether the hook executed successfully */
  success: boolean;
  /** Error that occurred (if any) */
  error?: Error;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Summary of hook execution results.
 */
export interface HookResultSummary {
  /** Total number of hooks executed */
  total: number;
  /** Number of successful hooks */
  successful: number;
  /** Number of failed hooks */
  failed: number;
  /** Errors from failed hooks */
  errors: PluginExecutionError[];
}

/**
 * Sorts plugins by priority (lower numbers run first).
 * Plugins without a priority default to 50.
 *
 * @param plugins - Array of plugins to sort
 * @returns New array sorted by priority
 */
function sortByPriority(plugins: RfmediaPlugin[]): RfmediaPlugin[] {
  return [...plugins].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
}

/**
 * Runs beforeCopy hooks for all plugins in priority order.
 *
 * Called before each file copy/convert operation. Plugins can use this
 * for pre-processing, validation, or logging.
 *
 * @param plugins - Array of plugins to run hooks for
 * @param context - Context with source/dest paths and file info
 * @param options - Run options (signal, continueOnError)
 * @returns Array of results from each plugin hook
 *
 * @example
 * const results = await runBeforeCopyHooks(plugins, {
 *   sourcePath: '/music/track.flac',
 *   destPath: '/dest/track.flac',
 *   isAudioFile: true,
 * });
 */
export async function runBeforeCopyHooks(
  plugins: RfmediaPlugin[],
  context: BeforeCopyContext,
  options: RunHooksOptions = {},
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  const sortedPlugins = sortByPriority(plugins);
  const continueOnError = options.continueOnError ?? true;

  for (const plugin of sortedPlugins) {
    if (options.signal?.aborted) {
      logDebug(`beforeCopy hooks aborted, skipping remaining plugins`);
      break;
    }

    const hook = plugin.hooks?.find(isBeforeCopyHook);
    if (!hook) continue;

    logDebug(`Running beforeCopy hook for plugin: ${plugin.name}`);
    const start = performance.now();

    try {
      await hook.handler(context);
      const durationMs = performance.now() - start;
      results.push({ pluginName: plugin.name, success: true, durationMs });
      logDebug(`beforeCopy hook ${plugin.name} completed in ${durationMs.toFixed(1)}ms`);
    } catch (err) {
      const durationMs = performance.now() - start;
      const error = new PluginExecutionError(plugin.name, "beforeCopy", err as Error);
      results.push({ pluginName: plugin.name, success: false, error, durationMs });
      logDebug(`beforeCopy hook ${plugin.name} failed: ${error.message}`);

      if (!continueOnError) {
        throw error;
      }
    }
  }

  return results;
}

/**
 * Runs afterCopy hooks for all plugins in priority order.
 *
 * Called after each file copy/convert operation completes. Plugins can use
 * this for post-processing, external tool integration, or logging.
 *
 * @param plugins - Array of plugins to run hooks for
 * @param context - Context with source/dest paths and copy method
 * @param result - Result from the copy operation
 * @param options - Run options (signal, continueOnError)
 * @returns Array of results from each plugin hook
 *
 * @example
 * const results = await runAfterCopyHooks(plugins, {
 *   sourcePath: '/music/track.flac',
 *   destPath: '/dest/track.flac',
 *   method: 'copy',
 *   fileSize: 50000000,
 * }, copyResult);
 */
export async function runAfterCopyHooks(
  plugins: RfmediaPlugin[],
  context: AfterCopyContext,
  result: CopyResult,
  options: RunHooksOptions = {},
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  const sortedPlugins = sortByPriority(plugins);
  const continueOnError = options.continueOnError ?? true;

  for (const plugin of sortedPlugins) {
    if (options.signal?.aborted) {
      logDebug(`afterCopy hooks aborted, skipping remaining plugins`);
      break;
    }

    const hook = plugin.hooks?.find(isAfterCopyHook);
    if (!hook) continue;

    logDebug(`Running afterCopy hook for plugin: ${plugin.name}`);
    const start = performance.now();

    try {
      await hook.handler(context, result);
      const durationMs = performance.now() - start;
      results.push({ pluginName: plugin.name, success: true, durationMs });
      logDebug(`afterCopy hook ${plugin.name} completed in ${durationMs.toFixed(1)}ms`);
    } catch (err) {
      const durationMs = performance.now() - start;
      const error = new PluginExecutionError(plugin.name, "afterCopy", err as Error);
      results.push({ pluginName: plugin.name, success: false, error, durationMs });
      logDebug(`afterCopy hook ${plugin.name} failed: ${error.message}`);

      if (!continueOnError) {
        throw error;
      }
    }
  }

  return results;
}

/**
 * Runs processFile hooks for all plugins in priority order.
 *
 * Called during filter mode metadata scanning. Plugins can use this
 * for metadata extraction, rating sync, or analysis.
 *
 * @param plugins - Array of plugins to run hooks for
 * @param context - Context with file path and metadata
 * @param options - Run options (signal, continueOnError)
 * @returns Array of results from each plugin hook
 *
 * @example
 * const results = await runProcessFileHooks(plugins, {
 *   filePath: '/music/track.flac',
 *   metadata: extendedMetadata,
 * });
 */
export async function runProcessFileHooks(
  plugins: RfmediaPlugin[],
  context: ProcessFileContext,
  options: RunHooksOptions = {},
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  const sortedPlugins = sortByPriority(plugins);
  const continueOnError = options.continueOnError ?? true;

  for (const plugin of sortedPlugins) {
    if (options.signal?.aborted) {
      logDebug(`processFile hooks aborted, skipping remaining plugins`);
      break;
    }

    const hook = plugin.hooks?.find(isProcessFileHook);
    if (!hook) continue;

    logDebug(`Running processFile hook for plugin: ${plugin.name}`);
    const start = performance.now();

    try {
      await hook.handler(context);
      const durationMs = performance.now() - start;
      results.push({ pluginName: plugin.name, success: true, durationMs });
      logDebug(`processFile hook ${plugin.name} completed in ${durationMs.toFixed(1)}ms`);
    } catch (err) {
      const durationMs = performance.now() - start;
      const error = new PluginExecutionError(plugin.name, "processFile", err as Error);
      results.push({ pluginName: plugin.name, success: false, error, durationMs });
      logDebug(`processFile hook ${plugin.name} failed: ${error.message}`);

      if (!continueOnError) {
        throw error;
      }
    }
  }

  return results;
}

/**
 * Runs afterBatch hooks for all plugins in priority order.
 *
 * Called after all sources in a batch are processed. Plugins can use this
 * for batch notifications, external imports, or summary reporting.
 *
 * @param plugins - Array of plugins to run hooks for
 * @param context - Context with results, sources, and optional history ID
 * @param options - Run options (signal, continueOnError)
 * @returns Array of results from each plugin hook
 *
 * @example
 * const results = await runAfterBatchHooks(plugins, {
 *   results: [copyResult1, copyResult2],
 *   sources: ['/music/Artist1', '/music/Artist2'],
 *   historyId: 'session-123',
 * });
 */
export async function runAfterBatchHooks(
  plugins: RfmediaPlugin[],
  context: AfterBatchContext,
  options: RunHooksOptions = {},
): Promise<HookResult[]> {
  const results: HookResult[] = [];
  const sortedPlugins = sortByPriority(plugins);
  const continueOnError = options.continueOnError ?? true;

  for (const plugin of sortedPlugins) {
    if (options.signal?.aborted) {
      logDebug(`afterBatch hooks aborted, skipping remaining plugins`);
      break;
    }

    const hook = plugin.hooks?.find(isAfterBatchHook);
    if (!hook) continue;

    logDebug(`Running afterBatch hook for plugin: ${plugin.name}`);
    const start = performance.now();

    try {
      await hook.handler(context);
      const durationMs = performance.now() - start;
      results.push({ pluginName: plugin.name, success: true, durationMs });
      logDebug(`afterBatch hook ${plugin.name} completed in ${durationMs.toFixed(1)}ms`);
    } catch (err) {
      const durationMs = performance.now() - start;
      const error = new PluginExecutionError(plugin.name, "afterBatch", err as Error);
      results.push({ pluginName: plugin.name, success: false, error, durationMs });
      logDebug(`afterBatch hook ${plugin.name} failed: ${error.message}`);

      if (!continueOnError) {
        throw error;
      }
    }
  }

  return results;
}

/**
 * Aggregates hook results into a summary for reporting.
 *
 * @param results - Array of hook results to summarize
 * @returns Summary with total, successful, failed counts and error list
 *
 * @example
 * const summary = summarizeHookResults(results);
 * if (summary.failed > 0) {
 *   logWarn(`${summary.failed} plugin(s) failed during hook execution`);
 * }
 */
export function summarizeHookResults(results: HookResult[]): HookResultSummary {
  const errors: PluginExecutionError[] = [];
  let successful = 0;
  let failed = 0;

  for (const result of results) {
    if (result.success) {
      successful++;
    } else {
      failed++;
      if (result.error instanceof PluginExecutionError) {
        errors.push(result.error);
      } else if (result.error) {
        // Wrap non-PluginExecutionError errors
        errors.push(new PluginExecutionError(result.pluginName, "unknown", result.error));
      }
    }
  }

  return {
    total: results.length,
    successful,
    failed,
    errors,
  };
}
