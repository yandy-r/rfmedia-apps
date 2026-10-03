/**
 * Plugin discovery and loading utilities for rfmedia-cli.
 *
 * Handles plugin discovery from configured directories, loading via ESM
 * dynamic imports, validation of plugin structure, and creation of
 * external command plugins from configuration.
 *
 * @module plugin-loader
 */

import { homedir } from "node:os";
import { join } from "node:path";
import fg from "fast-glob";

import { pathExists } from "./filesystem.js";
import { executeExternalCommand, interpolateArgs } from "./external-command.js";
import type { PluginsConfigOptions, ExternalCommandPluginConfig } from "../types/config.js";
import type {
  RfmediaPlugin,
  AfterCopyContext,
  AfterBatchContext,
  AfterCopyHook,
  AfterBatchHook,
} from "../types/plugins.js";
import { PluginLoadError } from "../types/plugins.js";

/**
 * Default plugin directory location.
 */
const DEFAULT_PLUGIN_DIR = join(homedir(), ".rfmedia", "plugins");

/**
 * Default timeout for external command plugins in milliseconds.
 */
const DEFAULT_COMMAND_TIMEOUT = 60000;

/**
 * Get plugin search paths from configuration.
 *
 * Returns the list of directories to search for plugins. If no custom
 * directory is configured, uses the default ~/.rfmedia/plugins/ path.
 *
 * @param config - Plugin configuration options
 * @returns Array of absolute paths to search for plugins
 *
 * @example
 * ```typescript
 * const paths = getPluginSearchPaths({ directory: '/custom/plugins' });
 * // Returns: ['/custom/plugins']
 *
 * const defaultPaths = getPluginSearchPaths(undefined);
 * // Returns: ['/home/user/.rfmedia/plugins']
 * ```
 */
export function getPluginSearchPaths(config: PluginsConfigOptions | undefined): string[] {
  const paths: string[] = [];

  if (config?.directory) {
    paths.push(config.directory);
  } else {
    paths.push(DEFAULT_PLUGIN_DIR);
  }

  if (config?.additionalDirectories) {
    paths.push(...config.additionalDirectories);
  }

  return paths;
}

/**
 * Discover plugins in the given search paths.
 *
 * Searches for plugin entry points matching the pattern `*\/index.{js,mjs}`
 * in each search path. Only existing directories are searched.
 *
 * @param searchPaths - Array of directory paths to search
 * @returns Array of absolute paths to plugin entry points
 *
 * @example
 * ```typescript
 * const pluginPaths = await discoverPlugins(['/home/user/.rfmedia/plugins']);
 * // Returns: ['/home/user/.rfmedia/plugins/my-plugin/index.js', ...]
 * ```
 */
export async function discoverPlugins(searchPaths: string[]): Promise<string[]> {
  const pluginPaths: string[] = [];

  for (const searchPath of searchPaths) {
    if (await pathExists(searchPath)) {
      const found = await fg("*/index.{js,mjs}", {
        cwd: searchPath,
        absolute: true,
      });
      pluginPaths.push(...found);
    }
  }

  return pluginPaths;
}

/**
 * Load and validate a plugin from a file path.
 *
 * Uses ESM dynamic import to load the plugin module. The module must
 * export a default object with `name` and `version` string properties.
 *
 * @param pluginPath - Absolute path to the plugin entry point
 * @returns Validated RfmediaPlugin instance
 * @throws PluginLoadError if the plugin cannot be loaded or is invalid
 *
 * @example
 * ```typescript
 * const plugin = await loadPlugin('/home/user/.rfmedia/plugins/my-plugin/index.js');
 * console.log(`Loaded ${plugin.name} v${plugin.version}`);
 * ```
 */
export async function loadPlugin(pluginPath: string): Promise<RfmediaPlugin> {
  try {
    const module = await import(pluginPath);
    const plugin = module.default ?? module;

    // Validate plugin has required fields
    if (!plugin.name || typeof plugin.name !== "string") {
      throw new PluginLoadError("unknown", pluginPath, "Plugin must export 'name' string");
    }
    if (!plugin.version || typeof plugin.version !== "string") {
      throw new PluginLoadError(plugin.name, pluginPath, "Plugin must export 'version' string");
    }

    return plugin as RfmediaPlugin;
  } catch (err) {
    if (err instanceof PluginLoadError) throw err;
    throw new PluginLoadError(
      "unknown",
      pluginPath,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Create RfmediaPlugin instances from external command configurations.
 *
 * Converts ExternalCommandPluginConfig entries from the configuration
 * into RfmediaPlugin instances with hook handlers that execute external
 * commands with interpolated arguments.
 *
 * @param config - Plugin configuration options containing command definitions
 * @returns Array of RfmediaPlugin instances for external commands
 *
 * @example
 * ```typescript
 * const plugins = createExternalCommandPlugins({
 *   commands: [{
 *     name: 'beets-import',
 *     command: 'beet',
 *     args: ['import', '-q', '{destPath}'],
 *     timeout: 300000,
 *     hooks: { afterBatch: true }
 *   }]
 * });
 * ```
 */
export function createExternalCommandPlugins(
  config: PluginsConfigOptions | undefined,
): RfmediaPlugin[] {
  if (!config?.commands || config.commands.length === 0) {
    return [];
  }

  return config.commands.map((cmdConfig) => createExternalCommandPlugin(cmdConfig));
}

/**
 * Create a single RfmediaPlugin from an external command configuration.
 *
 * @param cmdConfig - External command plugin configuration
 * @returns RfmediaPlugin instance with hook handlers
 */
function createExternalCommandPlugin(cmdConfig: ExternalCommandPluginConfig): RfmediaPlugin {
  const hooks: (AfterCopyHook | AfterBatchHook)[] = [];
  const timeout = cmdConfig.timeout ?? DEFAULT_COMMAND_TIMEOUT;

  // Create afterCopy hook if configured
  if (cmdConfig.hooks.afterCopy) {
    const afterCopyHook: AfterCopyHook = {
      type: "afterCopy",
      handler: async (ctx: AfterCopyContext) => {
        const args = getCommandArgs(cmdConfig, "afterCopy", {
          sourcePath: ctx.sourcePath,
          destPath: ctx.destPath,
          method: ctx.method,
          fileSize: String(ctx.fileSize),
        });

        await executeExternalCommand(cmdConfig.command, args, {
          timeout,
          signal: ctx.signal,
        });
      },
    };
    hooks.push(afterCopyHook);
  }

  // Create afterBatch hook if configured
  if (cmdConfig.hooks.afterBatch) {
    const afterBatchHook: AfterBatchHook = {
      type: "afterBatch",
      handler: async (ctx: AfterBatchContext) => {
        // For afterBatch, we pass aggregated context
        const args = getCommandArgs(cmdConfig, "afterBatch", {
          sources: ctx.sources.join(","),
          historyId: ctx.historyId ?? "",
          resultCount: String(ctx.results.length),
        });

        await executeExternalCommand(cmdConfig.command, args, {
          timeout,
          signal: ctx.signal,
        });
      },
    };
    hooks.push(afterBatchHook);
  }

  return {
    name: cmdConfig.name,
    version: "1.0.0", // External command plugins are always 1.0.0
    description: `External command plugin: ${cmdConfig.command}`,
    priority: 50, // Default priority
    enabled: true,
    hooks,
  };
}

/**
 * Get command arguments for a specific hook, handling custom args.
 *
 * @param cmdConfig - External command plugin configuration
 * @param hookType - The hook type being executed
 * @param context - Context variables for interpolation
 * @returns Interpolated argument array
 */
function getCommandArgs(
  cmdConfig: ExternalCommandPluginConfig,
  hookType: "afterCopy" | "afterBatch",
  context: Record<string, string | undefined>,
): string[] {
  const hookValue = cmdConfig.hooks[hookType];

  // If hook value is a string, use it as custom args
  if (typeof hookValue === "string") {
    // Split custom args string into array and interpolate
    const customArgs = hookValue.split(/\s+/).filter((arg) => arg.length > 0);
    return interpolateArgs(customArgs, context);
  }

  // Otherwise use configured args or empty array
  const baseArgs = cmdConfig.args ?? [];
  return interpolateArgs(baseArgs, context);
}
