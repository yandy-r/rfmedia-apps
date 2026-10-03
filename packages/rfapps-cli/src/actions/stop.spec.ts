import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeStop } from "./stop.js";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";

vi.mock("../lib/index.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Stop Action", () => {
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
    vi.mocked(lib.stopServices).mockResolvedValue({
      success: true,
      stdout: "",
      stderr: "",
      code: 0,
    });
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

  it("stops resolved services using profile and env tool options", async () => {
    await executeStop({ service: "plex" }, { yes: true });

    expect(lib.stopServices).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("handles all-services stop when resolver returns no explicit services", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: [],
      profiles: ["all"],
      preSidecarCount: 0,
      sidecarsExpanded: false,
    });

    await executeStop({}, { yes: true, output: "json" });

    expect(lib.stopServices).toHaveBeenCalledWith("compose.yml", undefined, {
      streamOutput: true,
      profiles: ["all"],
      envTool: undefined,
    });
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({ services: ["all"], stopped: 1 }),
    );
  });

  it("outputs dry-run payloads for machine formats without stopping", async () => {
    await executeStop({ service: "plex" }, { dryRun: true, output: "yaml" });

    expect(lib.stopServices).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith("yaml", {
      dryRun: true,
      services: ["plex"],
      profiles: ["media"],
      composePath: "compose.yml",
    });
  });

  it("returns when interactive resolution is cancelled", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);

    await executeStop({ service: "plex" }, { yes: true });

    expect(lib.stopServices).not.toHaveBeenCalled();
  });

  it("prompts in text mode when yes is not supplied and respects cancellation", async () => {
    vi.mocked(common.confirm).mockResolvedValue(false);

    await executeStop({ service: "plex" }, {});

    expect(common.confirm).toHaveBeenCalledWith("Stop plex?");
    expect(lib.stopServices).not.toHaveBeenCalled();
  });

  it("formats stop command failures and emits machine-readable results", async () => {
    vi.mocked(lib.stopServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "compose stop failed\nlast line",
      code: 2,
    });

    await executeStop({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        failed: [{ name: "stop", error: "last line" }],
        stopped: 0,
      }),
    );
    expect(process.exitCode).toBe(1);
  });

  it("formats unexpected stop errors", async () => {
    vi.mocked(lib.stopServices).mockRejectedValue(new Error("docker exploded"));

    await executeStop({ service: "plex" }, { yes: true });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
