import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeDelete } from "./delete.js";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";

vi.mock("../lib/index.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Delete Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env",
    profiles: { defaultProfile: "core", validProfiles: ["core", "all"], mapping: {} },
    sidecars: { enabled: true, mapping: {} },
    groups: {},
    healthCheck: { timeout: 60, interval: 1, retries: 2, waitForReady: true },
    envTool: { tool: "none" },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: { enabled: false, workers: 4 },
  };

  const ok = { success: true, stdout: "", stderr: "", code: 0 };
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
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.removeServices).mockResolvedValue(ok);
    vi.mocked(lib.downServices).mockResolvedValue(ok);
    vi.mocked(lib.pruneImages).mockResolvedValue(ok);
    vi.mocked(lib.initializeDatabase).mockResolvedValue({} as any);
    vi.mocked(lib.recordDeployments).mockReturnValue([1] as any);
    vi.mocked(lib.closeDatabase).mockReturnValue(undefined);
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

  it("stops, removes, optionally cleans extras, and records deletion state", async () => {
    await executeDelete(
      { service: "plex", volumes: true, images: true },
      { yes: true, output: "json" },
    );

    expect(lib.stopServices).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      envTool: undefined,
    });
    expect(lib.removeServices).toHaveBeenCalledWith("compose.yml", ["plex"], {
      streamOutput: true,
      profiles: ["media"],
      force: true,
      envTool: undefined,
    });
    expect(lib.downServices).toHaveBeenCalledWith("compose.yml", {
      volumes: true,
      removeOrphans: true,
      streamOutput: true,
      envTool: undefined,
    });
    expect(lib.pruneImages).toHaveBeenCalledWith({ streamOutput: true, envTool: undefined });
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({
        service: "plex",
        action: "delete",
        status: "success",
        configSnapshot: JSON.stringify({ volumes: true, images: true }),
      }),
    ]);
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["plex"],
        deleted: 1,
        volumesRemoved: 1,
        imagesRemoved: 1,
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("outputs dry-run payloads without executing destructive operations", async () => {
    await executeDelete({ service: "plex", volumes: true }, { dryRun: true, output: "json" });

    expect(lib.stopServices).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith("json", {
      dryRun: true,
      services: ["plex"],
      profiles: ["media"],
      volumes: true,
      images: false,
      composePath: "compose.yml",
    });
  });

  it("returns when resolution is cancelled or confirmation is denied", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);
    await executeDelete({ service: "plex" }, { yes: true });
    expect(lib.stopServices).not.toHaveBeenCalled();

    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(common.confirm).mockResolvedValue(false);
    await executeDelete({ service: "plex" }, {});
    expect(lib.stopServices).not.toHaveBeenCalled();
  });

  it("formats stop and remove failures before later phases", async () => {
    vi.mocked(lib.stopServices).mockResolvedValueOnce({
      success: false,
      stdout: "",
      stderr: "stop failed",
      code: 2,
    });

    await executeDelete({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.removeServices).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(lib.loadConfig).mockResolvedValue(mockConfig as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(mockConfig as any);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.removeServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "remove failed",
      code: 3,
    });

    await executeDelete({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("records failed deletion state on unexpected errors", async () => {
    vi.mocked(lib.removeServices).mockRejectedValue(new Error("docker unavailable"));

    await executeDelete({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({ service: "plex", action: "delete", status: "failed" }),
    ]);
    expect(process.exitCode).toBe(1);
  });
});
