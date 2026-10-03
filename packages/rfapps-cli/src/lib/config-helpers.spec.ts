import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCliOverrides,
  generateSampleConfig,
  getDefaultConfigPath,
  getStateDbPath,
  validateConfig,
} from "./config.js";
import type { RfappsConfig } from "../types/index.js";

function makeConfig(overrides: Partial<RfappsConfig> = {}): RfappsConfig {
  return {
    composePath: "/repo/compose.yml",
    envFile: "/repo/.env",
    sidecars: { enabled: true, mapping: { plex: "plex-ts" } },
    groups: { media: ["plex"] },
    profiles: {
      mapping: { plex: "media" },
      defaultProfile: "all",
      validProfiles: ["all", "media"],
    },
    healthCheck: { timeout: 60, interval: 5, retries: 12, waitForReady: true },
    envTool: { tool: "dotenvx" },
    docker: { sshRetry: { maxRetries: 3, delayMs: 2000 } },
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: { enabled: false, workers: 4 },
    ...overrides,
  };
}

describe("config helper exports", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies CLI overrides without mutating the original config", () => {
    const base = makeConfig();

    const result = applyCliOverrides(
      base,
      {
        composePath: "custom-compose.yml",
        envFile: ".env.prod",
        profile: "media",
        noSidecars: true,
      },
      "/tmp/project",
    );

    expect(result).toMatchObject({
      composePath: "/tmp/project/custom-compose.yml",
      envFile: "/tmp/project/.env.prod",
      profiles: expect.objectContaining({ defaultProfile: "media" }),
      sidecars: expect.objectContaining({ enabled: false }),
    });
    expect(base.sidecars.enabled).toBe(true);
    expect(base.profiles.defaultProfile).toBe("all");
  });

  it("validates basic configuration constraints", () => {
    expect(validateConfig(makeConfig())).toEqual({ valid: true, errors: [] });

    expect(
      validateConfig(
        makeConfig({
          composePath: "",
          envTool: { tool: "bad" as never },
          healthCheck: { timeout: 0, interval: -1, retries: 0, waitForReady: "yes" as never },
        }),
      ),
    ).toEqual({
      valid: false,
      errors: [
        "composePath is required",
        "Invalid envTool: bad. Must be one of: dotenvx, op, none",
        "healthCheck.timeout must be positive",
        "healthCheck.interval must be positive",
        "healthCheck.retries must be positive",
        "healthCheck.waitForReady must be a boolean",
      ],
    });
  });

  it("generates sample config in yaml and json formats", () => {
    expect(generateSampleConfig("json")).toContain('"composePath": "compose.yml"');
    expect(generateSampleConfig("yaml")).toContain("composePath: compose.yml");
  });

  it("resolves default config and state database paths", () => {
    expect(getDefaultConfigPath(true)).toMatch(/\/\.rfapps\.yaml$/);
    expect(getDefaultConfigPath(false)).toBe(`${process.cwd()}/.rfapps.yaml`);

    expect(getStateDbPath(makeConfig({ state: { enabled: true, dbPath: "~/custom.db" } }))).toMatch(
      /\/custom\.db$/,
    );
    expect(getStateDbPath(makeConfig({ state: { enabled: true, dbPath: "relative.db" } }))).toBe(
      `${process.cwd()}/relative.db`,
    );

    vi.stubEnv("RFAPPS_STATE_DB_PATH", "~/env.db");
    expect(getStateDbPath(makeConfig())).toMatch(/\/env\.db$/);
  });
});
