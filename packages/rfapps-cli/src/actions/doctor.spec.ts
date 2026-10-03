import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import { executeDoctor } from "./doctor.js";
import type { DoctorCheckerResult } from "../lib/doctor/index.js";
import type { RfappsConfig } from "../types/config.js";

vi.mock("../lib/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/index.js")>();
  return {
    ...actual,
    applyCliOverrides: vi.fn(),
    loadConfig: vi.fn(),
    resolveServicesWithInteractive: vi.fn(),
    runDoctorChecks: vi.fn(),
  };
});

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return {
    ...actual,
    formatOutput: vi.fn().mockResolvedValue(undefined),
  };
});

const config: RfappsConfig = {
  composePath: "compose.yml",
  envFile: ".env",
  profiles: {
    defaultProfile: "all",
    validProfiles: ["all", "media"],
    mapping: { plex: "media" },
  },
  sidecars: { enabled: true, mapping: {} },
  groups: { media: ["plex"] },
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
  lint: { ignore: [] },
};

const cleanResult: DoctorCheckerResult = {
  checks: [
    { id: "config-lint", category: "config", status: "run" },
    { id: "image-updates", category: "updates", status: "skipped", message: "requires flag" },
  ],
  findings: [],
  warnings: [],
};

describe("executeDoctor", () => {
  let originalExitCode: typeof process.exitCode;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.mocked(lib.loadConfig).mockResolvedValue(config);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(config);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.runDoctorChecks).mockResolvedValue(cleanResult);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("runs doctor checks and renders text output to stderr", async () => {
    await executeDoctor({ service: "plex" }, { yes: true });

    expect(lib.runDoctorChecks).toHaveBeenCalledWith(
      expect.objectContaining({
        composePath: "compose.yml",
        services: ["plex"],
        profiles: ["media"],
        checkUpdates: false,
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Doctor Summary"));
    expect(formatOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("emits JSON through formatOutput and honors update opt-in", async () => {
    await executeDoctor({ checkUpdates: true }, { yes: true, output: "json" });

    expect(lib.runDoctorChecks).toHaveBeenCalledWith(
      expect.objectContaining({ checkUpdates: true }),
    );
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        schemaVersion: "doctor.v1",
        scope: expect.objectContaining({ checkUpdates: true }),
      }),
    );
  });

  it("returns without checks when service resolution is cancelled", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);

    await executeDoctor({}, { yes: true });

    expect(lib.runDoctorChecks).not.toHaveBeenCalled();
  });

  it("sets exit code when findings meet threshold", async () => {
    vi.mocked(lib.runDoctorChecks).mockResolvedValue({
      checks: [{ id: "runtime-status", category: "runtime", status: "run" }],
      findings: [
        {
          id: "runtime.unhealthy",
          severity: "error",
          category: "runtime",
          service: "plex",
          message: "Container is unhealthy",
          evidence: ["health=unhealthy"],
        },
      ],
      warnings: [],
    });

    await executeDoctor({ failOn: "warn" }, { yes: true });

    expect(process.exitCode).toBe(1);
  });

  it("keeps default threshold critical-only", async () => {
    vi.mocked(lib.runDoctorChecks).mockResolvedValue({
      checks: [{ id: "runtime-status", category: "runtime", status: "run" }],
      findings: [
        {
          id: "runtime.unhealthy",
          severity: "error",
          category: "runtime",
          service: "plex",
          message: "Container is unhealthy",
          evidence: ["health=unhealthy"],
        },
      ],
      warnings: [],
    });

    await executeDoctor({}, { yes: true });

    expect(process.exitCode).toBeUndefined();
  });

  it("throws for invalid fail-on values", async () => {
    await expect(executeDoctor({ failOn: "bad" }, { yes: true })).rejects.toThrow(
      "Invalid fail-on severity",
    );
  });
});
