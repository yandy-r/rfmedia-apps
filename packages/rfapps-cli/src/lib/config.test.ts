/**
 * Integration tests for rfapps-cli config loading with secrets injection.
 *
 * Tests cover:
 * - Template resolution in configuration files
 * - Missing template variable error handling
 * - Config merge behavior with templates from multiple sources
 * - Optional `tags:` section layering (wholesale replacement, not deep merge)
 * - Config layer path discovery (`listConfigLayerPaths`)
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Mock dependencies with vi.hoisted() - must be defined before vi.mock() calls
const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    ...mockLogger,
  };
});

// Import after mocks
import { SecretsInjectionError } from "@rfmedia/common";

describe("config loading with secrets injection", () => {
  let testDir: string;
  let projectConfigPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `rfapps-config-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create a minimal project config (required by loadConfig)
    // This simulates rfapps.config.yaml in the project root
    projectConfigPath = join(testDir, "rfapps.config.yaml");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a minimal valid project config file.
   * This config contains required fields that loadConfig expects.
   */
  async function createProjectConfig(content: Record<string, unknown>): Promise<void> {
    const baseConfig = {
      composePath: "compose.yml",
      envFile: ".env.local",
      sidecars: {
        mapping: { plex: "plex-ts" },
        enabled: true,
      },
      groups: { media: ["plex"] },
      profiles: {
        mapping: { plex: ["media"] },
        defaultProfile: "all",
        validProfiles: ["all", "media"],
      },
      ...content,
    };
    await writeFile(projectConfigPath, YAML.stringify(baseConfig), "utf-8");
  }

  describe("template resolution in config", () => {
    it("should resolve a single template variable in config", async () => {
      vi.stubEnv("TEST_API_KEY", "secret-api-key-12345");

      await createProjectConfig({
        envTool: {
          tool: "none",
          opOptions: {
            apiKey: "{{ TEST_API_KEY }}",
          },
        },
      });

      // We need to mock getProjectConfigPath to return our test config
      // Since loadConfig uses internal paths, we'll test via loadConfigFromFile pattern
      // by creating a local config file in the test directory

      const localConfigPath = join(testDir, ".rfapps.yaml");
      await writeFile(
        localConfigPath,
        YAML.stringify({
          envTool: {
            opOptions: {
              path: "/usr/local/bin/op-{{ TEST_API_KEY }}",
            },
          },
        }),
        "utf-8",
      );

      const { loadConfig } = await import("../lib/config.js");
      const config = await loadConfig(testDir);

      // Verify actual template resolution - the template in opOptions.path should be resolved
      expect(config.envTool.opOptions?.path).toBe("/usr/local/bin/op-secret-api-key-12345");

      // Debug logging for template resolution is covered in @rfmedia/common tests
    });

    it("should resolve multiple template variables in same config", async () => {
      vi.stubEnv("DOCKER_HOST", "tcp://192.168.1.100:2375");
      vi.stubEnv("COMPOSE_FILE", "/custom/compose.yml");

      // Create a config file with multiple templates
      const configContent = `
composePath: "{{ COMPOSE_FILE }}"
docker:
  context: "{{ DOCKER_HOST }}"
sidecars:
  mapping:
    plex: plex-ts
  enabled: true
groups:
  media:
    - plex
profiles:
  mapping:
    plex:
      - media
  defaultProfile: all
  validProfiles:
    - all
    - media
`;
      await writeFile(projectConfigPath, configContent, "utf-8");

      // Since we can't easily hook into loadConfig's internal path resolution,
      // we verify the template syntax is valid and would be processed
      const { injectSecrets } = await import("@rfmedia/common");
      const result = injectSecrets(configContent, {
        env: { DOCKER_HOST: "tcp://192.168.1.100:2375", COMPOSE_FILE: "/custom/compose.yml" },
      });

      expect(result).toContain('composePath: "/custom/compose.yml"');
      expect(result).toContain('context: "tcp://192.168.1.100:2375"');
    });
  });

  describe("missing template variable error handling", () => {
    it("should throw SecretsInjectionError for missing template variable", async () => {
      // Create config with template referencing undefined variable
      const configContent = `
composePath: compose.yml
envTool:
  tool: none
  opOptions:
    apiKey: "{{ UNDEFINED_SECRET }}"
sidecars:
  mapping:
    plex: plex-ts
  enabled: true
groups:
  media:
    - plex
profiles:
  mapping:
    plex:
      - media
  defaultProfile: all
  validProfiles:
    - all
    - media
`;

      const { injectSecrets } = await import("@rfmedia/common");

      expect(() =>
        injectSecrets(configContent, {
          env: {}, // Empty env - UNDEFINED_SECRET not set
          configPath: "/path/to/.rfapps.yaml",
        }),
      ).toThrow(SecretsInjectionError);
    });

    it("should include variable name in error message", async () => {
      const configContent = 'apiKey: "{{ MY_MISSING_KEY }}"';
      const { injectSecrets } = await import("@rfmedia/common");

      try {
        injectSecrets(configContent, { env: {} });
        expect.fail("Expected SecretsInjectionError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretsInjectionError);
        expect((error as SecretsInjectionError).variableName).toBe("MY_MISSING_KEY");
      }
    });

    it("should include config path in error when provided", async () => {
      const configContent = 'token: "{{ SOME_TOKEN }}"';
      const { injectSecrets } = await import("@rfmedia/common");

      try {
        injectSecrets(configContent, {
          env: {},
          configPath: "/home/user/.rfapps.yaml",
        });
        expect.fail("Expected SecretsInjectionError to be thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SecretsInjectionError);
        expect((error as SecretsInjectionError).configPath).toBe("/home/user/.rfapps.yaml");
        expect((error as SecretsInjectionError).message).toContain("in /home/user/.rfapps.yaml");
      }
    });
  });

  describe("config merge with templates", () => {
    it("should resolve templates from multiple config sources", async () => {
      vi.stubEnv("BASE_COMPOSE_PATH", "base-compose.yml");
      vi.stubEnv("OVERRIDE_ENV_FILE", ".env.override");

      // Simulate base config with template
      const baseConfig = `
composePath: "{{ BASE_COMPOSE_PATH }}"
envFile: .env.local
`;

      // Simulate override config with different template
      const overrideConfig = `
envFile: "{{ OVERRIDE_ENV_FILE }}"
`;

      const { injectSecrets } = await import("@rfmedia/common");
      const env = {
        BASE_COMPOSE_PATH: "base-compose.yml",
        OVERRIDE_ENV_FILE: ".env.override",
      };

      // Both configs should resolve their templates independently
      const resolvedBase = injectSecrets(baseConfig, { env });
      const resolvedOverride = injectSecrets(overrideConfig, { env });

      expect(resolvedBase).toContain('composePath: "base-compose.yml"');
      expect(resolvedOverride).toContain('envFile: ".env.override"');
    });

    it("should handle templates in nested config structures", async () => {
      vi.stubEnv("SSH_MAX_RETRIES", "5");
      vi.stubEnv("SSH_DELAY_MS", "3000");

      const configContent = `
docker:
  sshRetry:
    maxRetries: {{ SSH_MAX_RETRIES }}
    delayMs: {{ SSH_DELAY_MS }}
`;

      const { injectSecrets } = await import("@rfmedia/common");
      const result = injectSecrets(configContent, {
        env: { SSH_MAX_RETRIES: "5", SSH_DELAY_MS: "3000" },
      });

      expect(result).toContain("maxRetries: 5");
      expect(result).toContain("delayMs: 3000");
    });

    it("should preserve YAML structure after template resolution", async () => {
      const configContent = `
sidecars:
  mapping:
    service1: "{{ SERVICE1_SIDECAR }}"
    service2: "{{ SERVICE2_SIDECAR }}"
  enabled: true
`;

      const { injectSecrets } = await import("@rfmedia/common");
      const result = injectSecrets(configContent, {
        env: {
          SERVICE1_SIDECAR: "service1-ts",
          SERVICE2_SIDECAR: "service2-ts",
        },
      });

      // Parse the result to verify YAML structure is preserved
      const parsed = YAML.parse(result) as {
        sidecars: { mapping: Record<string, string>; enabled: boolean };
      };

      expect(parsed.sidecars.mapping["service1"]).toBe("service1-ts");
      expect(parsed.sidecars.mapping["service2"]).toBe("service2-ts");
      expect(parsed.sidecars.enabled).toBe(true);
    });
  });

  describe("empty value handling", () => {
    it("should accept empty string as valid template value", async () => {
      const configContent = 'context: "{{ EMPTY_VALUE }}"';
      const { injectSecrets } = await import("@rfmedia/common");

      // Empty string should be treated as valid, not missing
      const result = injectSecrets(configContent, {
        env: { EMPTY_VALUE: "" },
      });

      expect(result).toBe('context: ""');
    });
  });

  describe("no templates in config", () => {
    it("should pass through config without templates unchanged", async () => {
      const configContent = `
composePath: compose.yml
envFile: .env.local
docker:
  context: default
`;

      const { injectSecrets } = await import("@rfmedia/common");
      const result = injectSecrets(configContent, { env: {} });

      // Content should be identical when no templates present
      expect(result).toBe(configContent);
    });
  });

  describe("tags section layering", () => {
    it("should let a higher layer replace the base tags mapping wholesale", async () => {
      // Base (lowest precedence) declares the fleet taxonomy.
      await createProjectConfig({
        tags: {
          mapping: {
            traefik: ["infrastructure/core/networking"],
            plex: ["media/streaming", "hardware/gpu"],
          },
        },
      });

      // Local override (highest precedence) declares a single personal tag.
      await writeFile(
        join(testDir, ".rfapps.yaml"),
        YAML.stringify({
          tags: {
            mapping: {
              sonarr: ["media/automation/tv"],
            },
          },
        }),
        "utf-8",
      );

      const { loadConfig } = await import("../lib/config.js");
      const config = await loadConfig(testDir);

      // Documented footgun: mergeConfig is one level deep, so the override does NOT
      // extend the base mapping - it discards it entirely.
      expect(config.tags?.mapping).toEqual({ sonarr: ["media/automation/tv"] });
      expect(config.tags?.mapping?.["traefik"]).toBeUndefined();
      expect(config.tags?.mapping?.["plex"]).toBeUndefined();
    });

    it("should default tags to an empty mapping when no layer declares the section", async () => {
      await createProjectConfig({});

      const { loadConfig } = await import("../lib/config.js");
      const config = await loadConfig(testDir);

      // Optional section: absence must not join the required-field throws.
      expect(config.tags?.mapping).toEqual({});
    });
  });

  describe("listConfigLayerPaths", () => {
    it("should report existing layers in precedence order, highest first", async () => {
      await createProjectConfig({});
      const localConfigPath = join(testDir, ".rfapps.yaml");
      await writeFile(localConfigPath, YAML.stringify({ envFile: ".env.override" }), "utf-8");

      const { listConfigLayerPaths } = await import("../lib/config.js");
      const layers = await listConfigLayerPaths(testDir);

      // Home and XDG layers belong to the host running the suite; only assert on ours.
      expect(layers.filter((path) => path.startsWith(testDir))).toEqual([
        localConfigPath,
        projectConfigPath,
      ]);
    });

    it("should omit layers that do not exist instead of throwing", async () => {
      await createProjectConfig({});

      const { listConfigLayerPaths } = await import("../lib/config.js");
      const layers = await listConfigLayerPaths(testDir);

      expect(layers.filter((path) => path.startsWith(testDir))).toEqual([projectConfigPath]);
      expect(layers).not.toContain(join(testDir, ".rfapps.yaml"));
    });
  });
});
