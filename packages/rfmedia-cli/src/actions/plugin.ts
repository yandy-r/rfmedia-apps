/**
 * Plugin management actions for rfmedia CLI.
 *
 * Provides functionality to list installed plugins, show plugin details,
 * and display plugin search directories.
 *
 * @module actions/plugin
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getOutputFormat, isMachineFormat } from "@rfmedia/common";

import { getPluginManager } from "../lib/plugin-manager.js";
import { getPluginSearchPaths } from "../lib/plugin-loader.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { logInfo } from "../lib/logger.js";

/**
 * Options for plugin list and info commands.
 */
export interface PluginListOptions {
  /** Output results as JSON */
  json?: boolean;
}

/**
 * Execute the plugin list command.
 *
 * Lists all installed plugins with their names, versions, and registered hooks.
 * Supports JSON output for machine-readable format.
 *
 * @param options - Plugin list options
 *
 * @example
 * ```typescript
 * // Console output
 * await executePluginList({});
 * // Output: Installed plugins (2):
 * //           my-plugin v1.0.0 - hooks: afterCopy, afterBatch
 * //           other-plugin v2.0.0 - hooks: beforeCopy
 *
 * // JSON output
 * await executePluginList({ json: true });
 * // Output: { "plugins": [...] }
 * ```
 */
export async function executePluginList(options: PluginListOptions): Promise<void> {
  const manager = getPluginManager();
  const plugins = manager.getPlugins();

  const format = getOutputFormat();
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, {
      plugins: plugins.map((p) => ({
        name: p.name,
        version: p.version,
        description: p.description,
        priority: p.priority ?? 50,
        hooks: p.hooks?.map((h) => h.type) ?? [],
      })),
    });
    return;
  }

  if (plugins.length === 0) {
    logInfo("No plugins installed");
    logInfo(`Plugin directory: ${join(homedir(), ".rfmedia", "plugins")}`);
    return;
  }

  logInfo(`Installed plugins (${plugins.length}):`);
  for (const plugin of plugins) {
    const hooks = plugin.hooks?.map((h) => h.type).join(", ") || "none";
    logInfo(`  ${plugin.name} v${plugin.version} - hooks: ${hooks}`);
  }
}

/**
 * Execute the plugin info command.
 *
 * Shows detailed information about a specific plugin including its name,
 * version, description, priority, and registered hooks.
 *
 * @param name - The plugin name to look up
 * @param options - Plugin info options
 * @throws Error if the plugin is not found
 *
 * @example
 * ```typescript
 * // Console output
 * await executePluginInfo('my-plugin', {});
 * // Output:
 * // Plugin: my-plugin
 * // Version: 1.0.0
 * // Description: My awesome plugin
 * // Priority: 50
 * // Hooks: afterCopy, afterBatch
 *
 * // JSON output
 * await executePluginInfo('my-plugin', { json: true });
 * // Output: { "plugin": { ... } }
 * ```
 */
export async function executePluginInfo(name: string, options: PluginListOptions): Promise<void> {
  const manager = getPluginManager();
  const plugin = manager.getPluginByName(name);

  if (!plugin) {
    throw new Error(`Plugin '${name}' not found`);
  }

  const format = getOutputFormat();
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, {
      plugin: {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        priority: plugin.priority ?? 50,
        enabled: plugin.enabled ?? true,
        hooks: plugin.hooks?.map((h) => h.type) ?? [],
      },
    });
    return;
  }

  logInfo(`Plugin: ${plugin.name}`);
  logInfo(`Version: ${plugin.version}`);
  logInfo(`Description: ${plugin.description ?? "N/A"}`);
  logInfo(`Priority: ${plugin.priority ?? 50}`);
  logInfo(`Hooks: ${plugin.hooks?.map((h) => h.type).join(", ") || "none"}`);
}

/**
 * Execute the plugin dir command.
 *
 * Displays all configured plugin search directories. This helps users
 * understand where to install plugins.
 *
 * @example
 * ```typescript
 * await executePluginDir();
 * // Output:
 * // /home/user/.rfmedia/plugins
 * // /custom/plugins/dir
 * ```
 */
export async function executePluginDir(): Promise<void> {
  const config = getLoadedConfig();
  const paths = getPluginSearchPaths(config.plugins);

  for (const path of paths) {
    logInfo(path);
  }
}
