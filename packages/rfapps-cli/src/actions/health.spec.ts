import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import { executeHealth } from "./health.js";
import * as lib from "../lib/index.js";

vi.mock("../lib/index.js");
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@rfmedia/common");

describe("Health Action", () => {
  const mockConfig = {
    composePath: "compose.yml",
    envFile: ".env.local",
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
      services: ["app"],
      profiles: ["core"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(common.formatError).mockReturnValue({
      message: "error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    vi.mocked(common.isMachineFormat).mockReturnValue(false);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("returns success when readiness is healthy", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: true,
      timedOut: false,
      totalDependencies: 1,
      readyDependencies: ["db"],
      pendingDependencies: [],
      failedDependencies: [],
      elapsedMs: 1000,
      attempts: 1,
      signalAvailability: {
        available: true,
        unavailableSignals: [],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "ready",
              probes: [],
            },
          ],
        },
      ],
    });

    await executeHealth({ service: "app" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when readiness waits and times out", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: false,
      timedOut: true,
      totalDependencies: 1,
      readyDependencies: [],
      pendingDependencies: ["db"],
      failedDependencies: [],
      elapsedMs: 60_000,
      attempts: 2,
      signalAvailability: {
        available: true,
        unavailableSignals: [],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "pending",
              probes: [],
            },
          ],
        },
      ],
    });

    await executeHealth({ service: "app" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("does not fail when readiness telemetry is unavailable", async () => {
    vi.mocked(lib.waitForDependencyReadiness).mockResolvedValue({
      ready: false,
      timedOut: true,
      totalDependencies: 1,
      readyDependencies: [],
      pendingDependencies: ["db"],
      failedDependencies: [],
      elapsedMs: 60_000,
      attempts: 2,
      signalAvailability: {
        available: false,
        unavailableSignals: ["service-container-map"],
      },
      services: [
        {
          service: "app",
          dependencies: [
            {
              dependency: "db",
              status: "pending",
              probes: [],
            },
          ],
        },
      ],
      warnings: ["Unable to retrieve running service/container map during readiness checks"],
    });

    await executeHealth({ service: "app" }, { yes: true, output: "json" });

    expect(common.outputFormattedError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("falls back to config waitForReady when CLI option is unset", async () => {
    vi.mocked(lib.loadConfig).mockResolvedValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);

    await executeHealth({ service: "app" }, { yes: true, output: "json" });

    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ waitForReady: false }),
    );
  });

  it("respects explicit --wait-for-ready override when config disables waiting", async () => {
    vi.mocked(lib.loadConfig).mockResolvedValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);
    vi.mocked(lib.applyCliOverrides).mockReturnValue({
      ...mockConfig,
      healthCheck: {
        ...mockConfig.healthCheck,
        waitForReady: false,
      },
    } as any);

    await executeHealth({ service: "app", waitForReady: true }, { yes: true, output: "json" });

    expect(lib.waitForDependencyReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ waitForReady: true }),
    );
  });
});
