/**
 * Central plugin registry for rfmedia-cli.
 *
 * Provides a singleton PluginManager that handles plugin initialization,
 * registration, and lifecycle management. Follows the SignalManager pattern
 * from signal-handler.ts with cleanup handler registration.
 *
 * @module plugin-manager
 */

import { registerGlobalCleanup, unregisterGlobalCleanup } from "./signal-handler.js";
import {
  getPluginSearchPaths,
  discoverPlugins,
  loadPlugin,
  createExternalCommandPlugins,
} from "./plugin-loader.js";
import { logDebug, logWarn } from "./logger.js";
import type { PluginsConfigOptions } from "../types/config.js";
import type { RfmediaPlugin } from "../types/plugins.js";

/**
 * Singleton class for managing plugin lifecycle and registry.
 *
 * The PluginManager handles:
 * - Plugin discovery from configured directories
 * - Plugin loading and validation via ESM dynamic imports
 * - External command plugin creation from configuration
 * - Cleanup handler registration for graceful shutdown
 *
 * @example
 * ```typescript
 * // Get the singleton instance
 * const manager = PluginManager.getInstance();
 *
 * // Initialize with config
 * await manager.initialize(config.plugins);
 *
 * // Access loaded plugins
 * const plugins = manager.getPlugins();
 * ```
 */
export class PluginManager {
  private static instance: PluginManager | null = null;
  private plugins: RfmediaPlugin[] = [];
  private initialized = false;
  private cleanupRegistered = false;

  private constructor() {}

  /**
   * Get the singleton instance of PluginManager.
   *
   * @returns The PluginManager singleton instance
   */
  static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager();
    }
    return PluginManager.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   *
   * Cleans up the current instance and sets it to null, allowing
   * a fresh instance to be created on the next getInstance() call.
   */
  static resetInstance(): void {
    if (PluginManager.instance) {
      PluginManager.instance.cleanup();
      PluginManager.instance = null;
    }
  }

  /**
   * Initialize the plugin manager with configuration.
   *
   * Discovers and loads plugins from configured directories, creates
   * external command plugins from config, and registers cleanup handlers.
   * Does nothing if already initialized or if plugins are disabled.
   *
   * @param config - Plugin configuration options
   *
   * @example
   * ```typescript
   * await manager.initialize({
   *   enabled: true,
   *   directory: '~/.rfmedia/plugins',
   *   disabled: ['problematic-plugin'],
   *   commands: [{ name: 'beets', command: 'beet', hooks: { afterBatch: true } }]
   * });
   * ```
   */
  async initialize(config: PluginsConfigOptions | undefined): Promise<void> {
    if (this.initialized) return;
    if (config?.enabled === false) return;

    // Register cleanup handler with priority 30
    // (after abort handlers at 10-15, before history recorder at 50)
    if (!this.cleanupRegistered) {
      registerGlobalCleanup({
        priority: 30,
        name: "plugin-manager",
        cleanup: () => this.cleanup(),
      });
      this.cleanupRegistered = true;
    }

    // Load plugins from directories
    const searchPaths = getPluginSearchPaths(config);
    const pluginPaths = await discoverPlugins(searchPaths);

    for (const pluginPath of pluginPaths) {
      try {
        const plugin = await loadPlugin(pluginPath);
        if (!config?.disabled?.includes(plugin.name)) {
          this.plugins.push(plugin);
          logDebug(`Loaded plugin: ${plugin.name} v${plugin.version}`);
        } else {
          logDebug(`Skipped disabled plugin: ${plugin.name}`);
        }
      } catch (err) {
        logWarn(`Failed to load plugin from ${pluginPath}: ${err}`);
      }
    }

    // Add external command plugins from config
    const commandPlugins = createExternalCommandPlugins(config);
    this.plugins.push(...commandPlugins);

    if (commandPlugins.length > 0) {
      logDebug(`Created ${commandPlugins.length} external command plugin(s)`);
    }

    this.initialized = true;
    logDebug(`Plugin manager initialized with ${this.plugins.length} plugin(s)`);
  }

  /**
   * Get all loaded plugins.
   *
   * @returns Readonly array of loaded plugins
   */
  getPlugins(): readonly RfmediaPlugin[] {
    return this.plugins;
  }

  /**
   * Get a plugin by name.
   *
   * @param name - The plugin name to search for
   * @returns The plugin if found, undefined otherwise
   */
  getPluginByName(name: string): RfmediaPlugin | undefined {
    return this.plugins.find((p) => p.name === name);
  }

  /**
   * Check if the plugin manager has been initialized.
   *
   * @returns true if initialized, false otherwise
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Clean up the plugin manager state.
   *
   * Clears the plugin registry and resets initialization state.
   * Unregisters the cleanup handler to prevent duplicate registration
   * when resetInstance() is used (e.g., in tests).
   * Called automatically during graceful shutdown via cleanup handler.
   */
  private cleanup(): void {
    unregisterGlobalCleanup("plugin-manager");
    this.cleanupRegistered = false;
    this.plugins = [];
    this.initialized = false;
  }
}

/**
 * Convenience function to get the PluginManager singleton instance.
 *
 * @returns The PluginManager singleton instance
 *
 * @example
 * ```typescript
 * const manager = getPluginManager();
 * const plugins = manager.getPlugins();
 * ```
 */
export function getPluginManager(): PluginManager {
  return PluginManager.getInstance();
}
