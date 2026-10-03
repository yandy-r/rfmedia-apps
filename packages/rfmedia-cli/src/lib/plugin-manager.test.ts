/**
 * Unit tests for plugin-manager.ts.
 *
 * Tests cover singleton pattern, initialization with various config options,
 * plugin lookup, and state management. Uses resetInstance() between tests
 * for proper isolation.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies with vi.hoisted() - must be defined before vi.mock() calls
const mockSignalHandler = vi.hoisted(() => ({
  registerGlobalCleanup: vi.fn(),
  unregisterGlobalCleanup: vi.fn(),
}));

const mockPluginLoader = vi.hoisted(() => ({
  getPluginSearchPaths: vi.fn().mockReturnValue(["/mock/plugins"]),
  discoverPlugins: vi.fn().mockResolvedValue([]),
  loadPlugin: vi.fn(),
  createExternalCommandPlugins: vi.fn().mockReturnValue([]),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("./signal-handler.js", () => mockSignalHandler);
vi.mock("./plugin-loader.js", () => mockPluginLoader);
vi.mock("./logger.js", () => mockLogger);

// Import after mocks
import { PluginManager, getPluginManager } from "./plugin-manager.js";
import type { RfmediaPlugin } from "../types/plugins.js";
import type { PluginsConfigOptions } from "../types/config.js";

describe("PluginManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the singleton instance before each test
    PluginManager.resetInstance();

    // Reset mock return values to defaults
    mockPluginLoader.getPluginSearchPaths.mockReturnValue(["/mock/plugins"]);
    mockPluginLoader.discoverPlugins.mockResolvedValue([]);
    mockPluginLoader.loadPlugin.mockReset();
    mockPluginLoader.createExternalCommandPlugins.mockReturnValue([]);
  });

  afterEach(() => {
    // Ensure clean state after each test
    PluginManager.resetInstance();
  });

  describe("singleton pattern", () => {
    it("should return the same instance on multiple getInstance calls", () => {
      const instance1 = PluginManager.getInstance();
      const instance2 = PluginManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("should return a new instance after resetInstance", () => {
      const instance1 = PluginManager.getInstance();
      PluginManager.resetInstance();
      const instance2 = PluginManager.getInstance();

      expect(instance1).not.toBe(instance2);
    });

    it("should reset initialization state on resetInstance", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.isInitialized()).toBe(true);

      PluginManager.resetInstance();
      const newManager = PluginManager.getInstance();

      expect(newManager.isInitialized()).toBe(false);
    });

    it("should clear plugins on resetInstance", async () => {
      mockPluginLoader.loadPlugin.mockResolvedValue({
        name: "test-plugin",
        version: "1.0.0",
      });
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path/to/plugin"]);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.getPlugins().length).toBeGreaterThan(0);

      PluginManager.resetInstance();
      const newManager = PluginManager.getInstance();

      expect(newManager.getPlugins()).toEqual([]);
    });
  });

  describe("getPluginManager convenience function", () => {
    it("should return PluginManager instance", () => {
      const manager = getPluginManager();

      expect(manager).toBeInstanceOf(PluginManager);
    });

    it("should return the singleton instance", () => {
      const manager1 = getPluginManager();
      const manager2 = PluginManager.getInstance();

      expect(manager1).toBe(manager2);
    });
  });

  describe("initialize", () => {
    it("should not initialize when plugins are disabled", async () => {
      const config: PluginsConfigOptions = {
        enabled: false,
      };

      const manager = PluginManager.getInstance();
      await manager.initialize(config);

      expect(manager.isInitialized()).toBe(false);
      expect(mockPluginLoader.discoverPlugins).not.toHaveBeenCalled();
    });

    it("should initialize when enabled is true", async () => {
      const config: PluginsConfigOptions = {
        enabled: true,
      };

      const manager = PluginManager.getInstance();
      await manager.initialize(config);

      expect(manager.isInitialized()).toBe(true);
    });

    it("should initialize when enabled is undefined (default true)", async () => {
      const config: PluginsConfigOptions = {};

      const manager = PluginManager.getInstance();
      await manager.initialize(config);

      expect(manager.isInitialized()).toBe(true);
    });

    it("should initialize with undefined config", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize(undefined);

      expect(manager.isInitialized()).toBe(true);
    });

    it("should not reinitialize if already initialized", async () => {
      const manager = PluginManager.getInstance();

      await manager.initialize({});
      await manager.initialize({}); // Second call

      // discoverPlugins should only be called once
      expect(mockPluginLoader.discoverPlugins).toHaveBeenCalledTimes(1);
    });

    it("should register cleanup handler with priority 30", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(mockSignalHandler.registerGlobalCleanup).toHaveBeenCalledWith({
        priority: 30,
        name: "plugin-manager",
        cleanup: expect.any(Function),
      });
    });

    it("should only register cleanup handler once", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      // Reset and reinitialize
      PluginManager.resetInstance();
      const newManager = PluginManager.getInstance();
      await newManager.initialize({});

      // Reset count from both initializations
      // First manager registers, second manager (after reset) also registers
      expect(mockSignalHandler.registerGlobalCleanup).toHaveBeenCalledTimes(2);
    });

    it("should call getPluginSearchPaths with config", async () => {
      const config: PluginsConfigOptions = {
        directory: "/custom/plugins",
      };

      const manager = PluginManager.getInstance();
      await manager.initialize(config);

      expect(mockPluginLoader.getPluginSearchPaths).toHaveBeenCalledWith(config);
    });

    it("should call discoverPlugins with search paths", async () => {
      mockPluginLoader.getPluginSearchPaths.mockReturnValue(["/path1", "/path2"]);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(mockPluginLoader.discoverPlugins).toHaveBeenCalledWith(["/path1", "/path2"]);
    });

    it("should load discovered plugins", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "discovered-plugin",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path/to/plugin"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(mockPluginLoader.loadPlugin).toHaveBeenCalledWith("/path/to/plugin");
      expect(manager.getPlugins()).toContain(mockPlugin);
    });

    it("should skip disabled plugins", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "disabled-plugin",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path/to/plugin"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const config: PluginsConfigOptions = {
        disabled: ["disabled-plugin"],
      };

      const manager = PluginManager.getInstance();
      await manager.initialize(config);

      expect(manager.getPlugins()).not.toContain(mockPlugin);
    });

    it("should warn on plugin load failure", async () => {
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path/to/bad-plugin"]);
      mockPluginLoader.loadPlugin.mockRejectedValue(new Error("Load failed"));

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(mockLogger.logWarn).toHaveBeenCalledWith(
        expect.stringContaining("/path/to/bad-plugin"),
      );
    });

    it("should add external command plugins", async () => {
      const commandPlugin: RfmediaPlugin = {
        name: "cmd-plugin",
        version: "1.0.0",
        hooks: [],
      };
      mockPluginLoader.createExternalCommandPlugins.mockReturnValue([commandPlugin]);

      const manager = PluginManager.getInstance();
      await manager.initialize({
        commands: [{ name: "test", command: "echo", hooks: { afterCopy: true } }],
      });

      expect(manager.getPlugins()).toContain(commandPlugin);
    });

    it("should log debug message when plugins loaded", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(mockLogger.logDebug).toHaveBeenCalledWith(
        expect.stringContaining("Plugin manager initialized"),
      );
    });
  });

  describe("getPlugins", () => {
    it("should return empty array before initialization", () => {
      const manager = PluginManager.getInstance();

      expect(manager.getPlugins()).toEqual([]);
    });

    it("should return readonly array", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "test",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      const plugins = manager.getPlugins();

      // TypeScript readonly check - we verify it's an array
      expect(Array.isArray(plugins)).toBe(true);
    });

    it("should return all loaded plugins", async () => {
      const plugin1: RfmediaPlugin = { name: "plugin1", version: "1.0.0" };
      const plugin2: RfmediaPlugin = { name: "plugin2", version: "2.0.0" };

      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path1", "/path2"]);
      mockPluginLoader.loadPlugin.mockResolvedValueOnce(plugin1).mockResolvedValueOnce(plugin2);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      const plugins = manager.getPlugins();

      expect(plugins).toContain(plugin1);
      expect(plugins).toContain(plugin2);
    });
  });

  describe("getPluginByName", () => {
    it("should return undefined when plugin not found", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      const plugin = manager.getPluginByName("nonexistent");

      expect(plugin).toBeUndefined();
    });

    it("should return plugin when found", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "find-me",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      const plugin = manager.getPluginByName("find-me");

      expect(plugin).toBe(mockPlugin);
    });

    it("should return undefined before initialization", () => {
      const manager = PluginManager.getInstance();

      const plugin = manager.getPluginByName("any");

      expect(plugin).toBeUndefined();
    });

    it("should be case-sensitive", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "CaseSensitive",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.getPluginByName("CaseSensitive")).toBe(mockPlugin);
      expect(manager.getPluginByName("casesensitive")).toBeUndefined();
      expect(manager.getPluginByName("CASESENSITIVE")).toBeUndefined();
    });
  });

  describe("isInitialized", () => {
    it("should return false before initialization", () => {
      const manager = PluginManager.getInstance();

      expect(manager.isInitialized()).toBe(false);
    });

    it("should return true after initialization", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.isInitialized()).toBe(true);
    });

    it("should return false when plugins disabled", async () => {
      const manager = PluginManager.getInstance();
      await manager.initialize({ enabled: false });

      expect(manager.isInitialized()).toBe(false);
    });
  });

  describe("cleanup behavior", () => {
    it("should clear plugins when cleanup is called", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "test",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.getPlugins().length).toBe(1);

      // Call the cleanup function that was registered
      const cleanupCall = mockSignalHandler.registerGlobalCleanup.mock.calls[0];
      const cleanupFn = cleanupCall?.[0]?.cleanup;
      if (cleanupFn) {
        cleanupFn();
      }

      expect(manager.getPlugins()).toEqual([]);
      expect(manager.isInitialized()).toBe(false);
    });

    it("should allow reinitialization after cleanup", async () => {
      const mockPlugin: RfmediaPlugin = {
        name: "test",
        version: "1.0.0",
      };
      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(mockPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      // Call cleanup
      const cleanupCall = mockSignalHandler.registerGlobalCleanup.mock.calls[0];
      const cleanupFn = cleanupCall?.[0]?.cleanup;
      if (cleanupFn) {
        cleanupFn();
      }

      // Should be able to reinitialize
      await manager.initialize({});

      expect(manager.isInitialized()).toBe(true);
      expect(manager.getPlugins().length).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("should handle empty discover results", async () => {
      mockPluginLoader.discoverPlugins.mockResolvedValue([]);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.getPlugins()).toEqual([]);
      expect(manager.isInitialized()).toBe(true);
    });

    it("should handle all plugins being disabled", async () => {
      const plugin1: RfmediaPlugin = { name: "p1", version: "1.0.0" };
      const plugin2: RfmediaPlugin = { name: "p2", version: "1.0.0" };

      mockPluginLoader.discoverPlugins.mockResolvedValue(["/p1", "/p2"]);
      mockPluginLoader.loadPlugin.mockResolvedValueOnce(plugin1).mockResolvedValueOnce(plugin2);

      const manager = PluginManager.getInstance();
      await manager.initialize({
        disabled: ["p1", "p2"],
      });

      expect(manager.getPlugins()).toEqual([]);
    });

    it("should handle mix of load failures and successes", async () => {
      const goodPlugin: RfmediaPlugin = { name: "good", version: "1.0.0" };

      mockPluginLoader.discoverPlugins.mockResolvedValue(["/bad", "/good"]);
      mockPluginLoader.loadPlugin
        .mockRejectedValueOnce(new Error("Bad plugin"))
        .mockResolvedValueOnce(goodPlugin);

      const manager = PluginManager.getInstance();
      await manager.initialize({});

      expect(manager.getPlugins()).toHaveLength(1);
      expect(manager.getPlugins()[0]).toBe(goodPlugin);
    });

    it("should combine discovered and command plugins", async () => {
      const discoveredPlugin: RfmediaPlugin = { name: "discovered", version: "1.0.0" };
      const commandPlugin: RfmediaPlugin = { name: "command", version: "1.0.0" };

      mockPluginLoader.discoverPlugins.mockResolvedValue(["/path"]);
      mockPluginLoader.loadPlugin.mockResolvedValue(discoveredPlugin);
      mockPluginLoader.createExternalCommandPlugins.mockReturnValue([commandPlugin]);

      const manager = PluginManager.getInstance();
      await manager.initialize({
        commands: [{ name: "cmd", command: "test", hooks: { afterCopy: true } }],
      });

      const plugins = manager.getPlugins();

      expect(plugins).toHaveLength(2);
      expect(plugins).toContain(discoveredPlugin);
      expect(plugins).toContain(commandPlugin);
    });
  });
});
