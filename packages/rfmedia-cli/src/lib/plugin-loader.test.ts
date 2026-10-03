/**
 * Unit tests for plugin-loader.ts.
 *
 * Tests cover plugin search paths, discovery, loading, and external command
 * plugin creation from configuration.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock dependencies with vi.hoisted() - must be defined before vi.mock() calls
const mockFilesystem = vi.hoisted(() => ({
  pathExists: vi.fn(),
}));

const mockExternalCommand = vi.hoisted(() => ({
  executeExternalCommand: vi.fn().mockResolvedValue({
    success: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
  }),
  interpolateArgs: vi.fn((args: string[], _context: Record<string, string | undefined>) => args),
}));

// Apply mocks BEFORE importing the module under test
vi.mock("./filesystem.js", () => mockFilesystem);
vi.mock("./external-command.js", () => mockExternalCommand);

// Import after mocks
import {
  getPluginSearchPaths,
  discoverPlugins,
  loadPlugin,
  createExternalCommandPlugins,
} from "./plugin-loader.js";
import { PluginLoadError } from "../types/plugins.js";
import type { PluginsConfigOptions, ExternalCommandPluginConfig } from "../types/config.js";

describe("getPluginSearchPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return default plugin directory when config is undefined", () => {
    const paths = getPluginSearchPaths(undefined);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(".rfmedia");
    expect(paths[0]).toContain("plugins");
  });

  it("should return default plugin directory when config has no directory set", () => {
    const config: PluginsConfigOptions = {};
    const paths = getPluginSearchPaths(config);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(".rfmedia");
    expect(paths[0]).toContain("plugins");
  });

  it("should return custom directory when configured", () => {
    const config: PluginsConfigOptions = {
      directory: "/custom/plugins",
    };
    const paths = getPluginSearchPaths(config);

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/custom/plugins");
  });

  it("should include additional directories", () => {
    const config: PluginsConfigOptions = {
      additionalDirectories: ["/extra/plugins1", "/extra/plugins2"],
    };
    const paths = getPluginSearchPaths(config);

    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("plugins"); // default
    expect(paths[1]).toBe("/extra/plugins1");
    expect(paths[2]).toBe("/extra/plugins2");
  });

  it("should use custom directory with additional directories", () => {
    const config: PluginsConfigOptions = {
      directory: "/custom/plugins",
      additionalDirectories: ["/extra/plugins"],
    };
    const paths = getPluginSearchPaths(config);

    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("/custom/plugins");
    expect(paths[1]).toBe("/extra/plugins");
  });

  it("should return empty additional directories when array is empty", () => {
    const config: PluginsConfigOptions = {
      additionalDirectories: [],
    };
    const paths = getPluginSearchPaths(config);

    expect(paths).toHaveLength(1);
  });
});

describe("discoverPlugins", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdir(join(tmpdir(), `rfmedia-plugin-test-${Date.now()}`), { recursive: true })
      .then(() => join(tmpdir(), `rfmedia-plugin-test-${Date.now()}`))
      .catch(() => join(tmpdir(), `rfmedia-plugin-test-${Date.now()}`));

    // Create a fresh temp directory
    tempDir = join(
      tmpdir(),
      `rfmedia-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });

    // Configure pathExists to use real filesystem for test directories
    mockFilesystem.pathExists.mockImplementation(async (path: string) => {
      const { access } = await import("node:fs/promises");
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty array when no plugin directories exist", async () => {
    mockFilesystem.pathExists.mockResolvedValue(false);

    const plugins = await discoverPlugins(["/nonexistent/path"]);

    expect(plugins).toEqual([]);
  });

  it("should discover plugins with index.js", async () => {
    // Create plugin directory structure
    const pluginDir = join(tempDir, "my-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "index.js"), "export default { name: 'test' };");

    const plugins = await discoverPlugins([tempDir]);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toContain("my-plugin");
    expect(plugins[0]).toContain("index.js");
  });

  it("should discover plugins with index.mjs", async () => {
    const pluginDir = join(tempDir, "esm-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "index.mjs"), "export default { name: 'esm' };");

    const plugins = await discoverPlugins([tempDir]);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toContain("esm-plugin");
    expect(plugins[0]).toContain("index.mjs");
  });

  it("should discover multiple plugins in same directory", async () => {
    // Create multiple plugin directories
    const plugin1 = join(tempDir, "plugin1");
    const plugin2 = join(tempDir, "plugin2");
    await mkdir(plugin1, { recursive: true });
    await mkdir(plugin2, { recursive: true });
    await writeFile(join(plugin1, "index.js"), "export default { name: 'p1' };");
    await writeFile(join(plugin2, "index.js"), "export default { name: 'p2' };");

    const plugins = await discoverPlugins([tempDir]);

    expect(plugins).toHaveLength(2);
  });

  it("should search multiple directories", async () => {
    const dir1 = join(tempDir, "dir1");
    const dir2 = join(tempDir, "dir2");
    await mkdir(join(dir1, "plugin-a"), { recursive: true });
    await mkdir(join(dir2, "plugin-b"), { recursive: true });
    await writeFile(join(dir1, "plugin-a", "index.js"), "export default {};");
    await writeFile(join(dir2, "plugin-b", "index.js"), "export default {};");

    const plugins = await discoverPlugins([dir1, dir2]);

    expect(plugins).toHaveLength(2);
  });

  it("should skip non-existent directories in search path", async () => {
    const existingDir = join(tempDir, "existing");
    await mkdir(join(existingDir, "plugin"), { recursive: true });
    await writeFile(join(existingDir, "plugin", "index.js"), "export default {};");

    const plugins = await discoverPlugins(["/nonexistent", existingDir]);

    expect(plugins).toHaveLength(1);
  });

  it("should not match non-plugin files", async () => {
    // Create a file that is not a plugin entry point
    await writeFile(join(tempDir, "random.js"), "console.log('not a plugin');");

    const plugins = await discoverPlugins([tempDir]);

    expect(plugins).toEqual([]);
  });
});

describe("loadPlugin", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = join(
      tmpdir(),
      `rfmedia-plugin-load-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should load a valid plugin with name and version", async () => {
    const pluginPath = join(tempDir, "valid-plugin.mjs");
    await writeFile(
      pluginPath,
      `export default {
        name: 'valid-plugin',
        version: '1.0.0',
        description: 'A valid test plugin'
      };`,
    );

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.name).toBe("valid-plugin");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.description).toBe("A valid test plugin");
  });

  it("should load a plugin with hooks", async () => {
    const pluginPath = join(tempDir, "hooks-plugin.mjs");
    await writeFile(
      pluginPath,
      `export default {
        name: 'hooks-plugin',
        version: '2.0.0',
        hooks: [
          { type: 'beforeCopy', handler: async () => {} },
          { type: 'afterCopy', handler: async () => {} }
        ]
      };`,
    );

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.name).toBe("hooks-plugin");
    expect(plugin.hooks).toHaveLength(2);
    expect(plugin.hooks?.[0]?.type).toBe("beforeCopy");
    expect(plugin.hooks?.[1]?.type).toBe("afterCopy");
  });

  it("should throw PluginLoadError for missing name", async () => {
    const pluginPath = join(tempDir, "no-name.mjs");
    await writeFile(
      pluginPath,
      `export default {
        version: '1.0.0'
      };`,
    );

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
    await expect(loadPlugin(pluginPath)).rejects.toThrow("Plugin must export 'name' string");
  });

  it("should throw PluginLoadError for missing version", async () => {
    const pluginPath = join(tempDir, "no-version.mjs");
    await writeFile(
      pluginPath,
      `export default {
        name: 'no-version'
      };`,
    );

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
    await expect(loadPlugin(pluginPath)).rejects.toThrow("Plugin must export 'version' string");
  });

  it("should throw PluginLoadError for non-string name", async () => {
    const pluginPath = join(tempDir, "bad-name.mjs");
    await writeFile(
      pluginPath,
      `export default {
        name: 123,
        version: '1.0.0'
      };`,
    );

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
    await expect(loadPlugin(pluginPath)).rejects.toThrow("Plugin must export 'name' string");
  });

  it("should throw PluginLoadError for non-string version", async () => {
    const pluginPath = join(tempDir, "bad-version.mjs");
    await writeFile(
      pluginPath,
      `export default {
        name: 'bad-version',
        version: 100
      };`,
    );

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
    await expect(loadPlugin(pluginPath)).rejects.toThrow("Plugin must export 'version' string");
  });

  it("should throw PluginLoadError for syntax error in plugin", async () => {
    const pluginPath = join(tempDir, "syntax-error.mjs");
    await writeFile(pluginPath, `export default { invalid syntax here`);

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
  });

  it("should throw PluginLoadError for nonexistent file", async () => {
    const pluginPath = join(tempDir, "nonexistent.mjs");

    await expect(loadPlugin(pluginPath)).rejects.toThrow(PluginLoadError);
  });

  it("should handle plugin that uses module.exports pattern via default", async () => {
    const pluginPath = join(tempDir, "module-export.mjs");
    // ESM modules can only use export, but we test that default is preferred
    await writeFile(
      pluginPath,
      `const plugin = { name: 'module-export', version: '1.0.0' };
       export default plugin;`,
    );

    const plugin = await loadPlugin(pluginPath);

    expect(plugin.name).toBe("module-export");
  });
});

describe("createExternalCommandPlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return empty array when config is undefined", () => {
    const plugins = createExternalCommandPlugins(undefined);

    expect(plugins).toEqual([]);
  });

  it("should return empty array when commands is undefined", () => {
    const config: PluginsConfigOptions = {};
    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toEqual([]);
  });

  it("should return empty array when commands array is empty", () => {
    const config: PluginsConfigOptions = {
      commands: [],
    };
    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toEqual([]);
  });

  it("should create plugin from afterCopy command config", () => {
    const cmdConfig: ExternalCommandPluginConfig = {
      name: "test-aftercopy",
      command: "echo",
      args: ["copied", "{destPath}"],
      hooks: {
        afterCopy: true,
      },
    };
    const config: PluginsConfigOptions = {
      commands: [cmdConfig],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("test-aftercopy");
    expect(plugins[0]?.version).toBe("1.0.0");
    expect(plugins[0]?.hooks).toHaveLength(1);
    expect(plugins[0]?.hooks?.[0]?.type).toBe("afterCopy");
  });

  it("should create plugin from afterBatch command config", () => {
    const cmdConfig: ExternalCommandPluginConfig = {
      name: "test-afterbatch",
      command: "beet",
      args: ["import", "-q"],
      hooks: {
        afterBatch: true,
      },
    };
    const config: PluginsConfigOptions = {
      commands: [cmdConfig],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.name).toBe("test-afterbatch");
    expect(plugins[0]?.hooks).toHaveLength(1);
    expect(plugins[0]?.hooks?.[0]?.type).toBe("afterBatch");
  });

  it("should create plugin with both hooks enabled", () => {
    const cmdConfig: ExternalCommandPluginConfig = {
      name: "dual-hook",
      command: "custom-tool",
      hooks: {
        afterCopy: true,
        afterBatch: true,
      },
    };
    const config: PluginsConfigOptions = {
      commands: [cmdConfig],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.hooks).toHaveLength(2);

    const hookTypes = plugins[0]?.hooks?.map((h) => h.type);
    expect(hookTypes).toContain("afterCopy");
    expect(hookTypes).toContain("afterBatch");
  });

  it("should create multiple plugins from multiple command configs", () => {
    const config: PluginsConfigOptions = {
      commands: [
        {
          name: "plugin1",
          command: "cmd1",
          hooks: { afterCopy: true },
        },
        {
          name: "plugin2",
          command: "cmd2",
          hooks: { afterBatch: true },
        },
      ],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toHaveLength(2);
    expect(plugins[0]?.name).toBe("plugin1");
    expect(plugins[1]?.name).toBe("plugin2");
  });

  it("should set default priority of 50", () => {
    const config: PluginsConfigOptions = {
      commands: [
        {
          name: "default-priority",
          command: "test",
          hooks: { afterCopy: true },
        },
      ],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins[0]?.priority).toBe(50);
  });

  it("should set enabled to true", () => {
    const config: PluginsConfigOptions = {
      commands: [
        {
          name: "enabled-test",
          command: "test",
          hooks: { afterCopy: true },
        },
      ],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins[0]?.enabled).toBe(true);
  });

  it("should include description with command name", () => {
    const config: PluginsConfigOptions = {
      commands: [
        {
          name: "desc-test",
          command: "my-tool",
          hooks: { afterCopy: true },
        },
      ],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins[0]?.description).toContain("my-tool");
  });

  it("should handle custom args string for hook", () => {
    const config: PluginsConfigOptions = {
      commands: [
        {
          name: "custom-args",
          command: "tool",
          hooks: {
            afterCopy: "custom arg1 arg2",
          },
        },
      ],
    };

    const plugins = createExternalCommandPlugins(config);

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.hooks?.[0]?.type).toBe("afterCopy");
  });
});
