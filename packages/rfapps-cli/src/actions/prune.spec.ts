import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executePrune } from "./prune.js";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import { DockerCommandError } from "../lib/errors.js";

vi.mock("../lib/index.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Prune Action", () => {
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
    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: {
        plex: { image: "plex:latest" },
        sonarr: { image: "arr:latest" },
        radarr: { image: "arr:latest" },
      },
    } as any);
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.removeServices).mockResolvedValue(ok);
    vi.mocked(lib.removeImage).mockResolvedValue(ok);
    vi.mocked(lib.pruneVolumes).mockResolvedValue(ok);
    vi.mocked(lib.pruneImages).mockResolvedValue(ok);
    vi.mocked(lib.isImageInUse).mockResolvedValue(false);
    vi.mocked(lib.imageExists).mockResolvedValue(true);
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

  it("prunes a targeted service image, optional volumes/images, and records state", async () => {
    await executePrune(
      { service: "plex", volumes: true, images: true },
      { yes: true, output: "json" },
    );

    expect(lib.getComposeConfig).toHaveBeenCalledWith("compose.yml", {
      profiles: ["media"],
      envTool: undefined,
    });
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
    expect(lib.isImageInUse).toHaveBeenCalledWith("plex:latest", { envTool: undefined });
    expect(lib.imageExists).toHaveBeenCalledWith("plex:latest", { envTool: undefined });
    expect(lib.removeImage).toHaveBeenCalledWith("plex:latest", {
      force: true,
      envTool: undefined,
    });
    expect(lib.pruneVolumes).toHaveBeenCalledWith({ streamOutput: true, envTool: undefined });
    expect(lib.pruneImages).toHaveBeenCalledWith({ streamOutput: true, envTool: undefined });
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({
        service: "plex",
        action: "prune",
        imageTag: "plex:latest",
        status: "success",
      }),
    ]);
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["plex"],
        containers: 1,
        images: 1,
        volumes: 1,
        completedPhases: ["stop", "remove", "images", "volumes", "prune-images"],
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("skips shared images when pruning only one of multiple services using the image", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["sonarr"],
      profiles: ["arr-stack"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });

    await executePrune({ service: "sonarr" }, { yes: true, output: "json" });

    expect(lib.removeImage).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        services: ["sonarr"],
        images: 0,
        imagesSkipped: 1,
      }),
    );
  });

  it("skips image removal when an image is in use or missing locally", async () => {
    vi.mocked(lib.isImageInUse).mockResolvedValueOnce(true);
    await executePrune({ service: "plex" }, { yes: true, output: "json" });
    expect(lib.imageExists).not.toHaveBeenCalled();
    expect(lib.removeImage).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenLastCalledWith(
      "json",
      expect.objectContaining({ images: 0, imagesSkipped: 1 }),
    );

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
    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: { plex: { image: "plex:latest" } },
    } as any);
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.removeServices).mockResolvedValue(ok);
    vi.mocked(lib.isImageInUse).mockResolvedValue(false);
    vi.mocked(lib.imageExists).mockResolvedValue(false);

    await executePrune({ service: "plex" }, { yes: true, output: "json" });
    expect(lib.removeImage).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenLastCalledWith(
      "json",
      expect.objectContaining({ images: 0, imagesSkipped: 0 }),
    );
  });

  it("outputs dry-run payloads and respects cancellation", async () => {
    await executePrune({ service: "plex", volumes: true }, { dryRun: true, output: "json" });

    expect(lib.getComposeConfig).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith("json", {
      dryRun: true,
      services: ["plex"],
      profiles: ["media"],
      volumes: true,
      images: false,
      composePath: "compose.yml",
    });

    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);
    await executePrune({ service: "plex" }, { yes: true });
    expect(lib.getComposeConfig).not.toHaveBeenCalled();

    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["plex"],
      profiles: ["media"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(common.confirm).mockResolvedValue(false);
    await executePrune({ service: "plex" }, {});
    expect(lib.getComposeConfig).not.toHaveBeenCalled();
  });

  it("formats compose, stop, and remove failures before later phases", async () => {
    vi.mocked(lib.getComposeConfig).mockResolvedValueOnce(undefined);
    await executePrune({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
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
    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: { plex: { image: "plex:latest" } },
    } as any);
    vi.mocked(lib.stopServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "stop failed",
      code: 2,
    });
    await executePrune({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.removeServices).not.toHaveBeenCalled();

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
    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: { plex: { image: "plex:latest" } },
    } as any);
    vi.mocked(lib.stopServices).mockResolvedValue(ok);
    vi.mocked(lib.removeServices).mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "remove failed",
      code: 3,
    });
    await executePrune({ service: "plex" }, { yes: true, output: "json" });
    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("throws typed DockerCommandError but records unexpected prune failures", async () => {
    vi.mocked(lib.getComposeConfig).mockRejectedValueOnce(
      new DockerCommandError("config", "typed failure", 1, ["plex"], false),
    );

    await expect(executePrune({ service: "plex" }, { yes: true })).rejects.toBeInstanceOf(
      DockerCommandError,
    );

    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: { plex: { image: "plex:latest" } },
    } as any);
    vi.mocked(lib.stopServices).mockRejectedValue(new Error("docker unavailable"));

    await executePrune({ service: "plex" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(lib.recordDeployments).toHaveBeenCalledWith({}, [
      expect.objectContaining({ service: "plex", action: "prune", status: "failed" }),
    ]);
    expect(process.exitCode).toBe(1);
  });
});
