import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executePull } from "./pull.js";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";

vi.mock("../lib/index.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Pull Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: {
      defaultProfile: "core",
      validProfiles: ["core", "all"],
      mapping: {},
    },
    sidecars: {
      enabled: true,
      mapping: {},
    },
    groups: {},
    healthCheck: {
      timeout: 60,
      interval: 1,
      retries: 2,
      waitForReady: true,
    },
    envTool: {
      tool: "none",
    },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: {
      enabled: false,
      workers: 4,
    },
  };

  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.pullImages).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
    vi.mocked(common.withSpinner).mockImplementation(async (_message, task) => task());
    vi.mocked(common.formatDryRun).mockImplementation((message) => `[dry-run] ${message}`);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
    vi.mocked(common.confirm).mockResolvedValue(true);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("pulls resolved services with profiles and env tool settings", async () => {
    await executePull({ service: "plex" }, { yes: true, verbose: true });

    expect(lib.resolveServicesWithInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ service: "plex", yes: true }),
      mockConfig,
      "compose.yml",
      process.cwd(),
      { envTool: undefined },
    );
    expect(lib.pullImages).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      envTool: undefined,
    });
    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("outputs dry-run payloads for machine formats without pulling", async () => {
    await executePull(
      { services: "plex, sonarr", profile: "core" },
      { dryRun: true, output: "json" },
    );

    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith("json", {
      dryRun: true,
      services: ["plex"],
      profiles: ["media"],
      composePath: "compose.yml",
    });
  });

  it("returns when interactive resolution is cancelled", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);

    await executePull({ service: "plex" }, { yes: true });

    expect(lib.pullImages).not.toHaveBeenCalled();
  });

  it("prompts in text mode when yes is not supplied and respects cancellation", async () => {
    vi.mocked(common.confirm).mockResolvedValue(false);

    await executePull({ service: "plex" }, {});

    expect(common.confirm).toHaveBeenCalledWith("Pull images for plex?");
    expect(lib.pullImages).not.toHaveBeenCalled();
  });

  it("formats pull command failures and emits machine-readable results", async () => {
    vi.mocked(lib.pullImages).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "registry unavailable",
      code: 1,
    });

    await executePull({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        failed: [{ name: "pull", error: "registry unavailable" }],
        pulled: 0,
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("formats unexpected pull errors", async () => {
    vi.mocked(lib.pullImages).mockRejectedValue(new Error("docker exploded"));

    await executePull({ service: "plex" }, { yes: true });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
