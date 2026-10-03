import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import * as lib from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import { executeAudit } from "./audit.js";
import type { RfappsConfig } from "../types/config.js";

vi.mock("../lib/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/index.js")>();
  return {
    ...actual,
    applyCliOverrides: vi.fn(),
    getComposeConfig: vi.fn(),
    isValidProfile: vi.fn(),
    loadConfig: vi.fn(),
    resolveServicesWithInteractive: vi.fn(),
  };
});

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return {
    ...actual,
    formatOutput: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    formatError: vi.fn(),
    logDebug: vi.fn(),
    outputFormattedError: vi.fn(),
  };
});

const config: RfappsConfig = {
  composePath: "compose.yml",
  envFile: ".env",
  profiles: {
    defaultProfile: "all",
    validProfiles: ["all", "core"],
    mapping: { traefik: "core" },
  },
  sidecars: { enabled: true, mapping: {} },
  groups: { core: ["traefik"] },
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
  lint: { ignore: [] },
};

const composeConfig = {
  services: {
    traefik: {
      user: "0",
      privileged: true,
      volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
    },
  },
};

describe("executeAudit", () => {
  let originalExitCode: typeof process.exitCode;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.mocked(lib.loadConfig).mockResolvedValue(config);
    vi.mocked(lib.applyCliOverrides).mockReturnValue(config);
    vi.mocked(lib.isValidProfile).mockReturnValue(true);
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({
      services: ["traefik"],
      profiles: ["core"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.getComposeConfig).mockResolvedValue(composeConfig as any);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("runs resolved compose audit and renders text to stderr", async () => {
    await executeAudit({ service: "traefik", failOn: "none" }, { yes: true });

    expect(lib.resolveServicesWithInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ service: "traefik", yes: true }),
      config,
      "compose.yml",
      process.cwd(),
      { envTool: undefined },
    );
    expect(lib.getComposeConfig).toHaveBeenCalledWith("compose.yml", {
      profiles: ["core"],
      envFile: ".env",
      envTool: undefined,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Security Audit Summary"));
    expect(formatOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("emits stable JSON output through formatOutput", async () => {
    await executeAudit({ json: true, failOn: "none" }, { yes: true });

    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        schemaVersion: "audit.v1",
        scope: expect.objectContaining({ services: ["traefik"], profiles: ["core"] }),
        findings: expect.arrayContaining([
          expect.objectContaining({
            ruleId: "privileged-container",
            service: "traefik",
            severity: "critical",
          }),
        ]),
      }),
    );
  });

  it("uses global output precedence over local json", async () => {
    await executeAudit({ json: true, failOn: "none" }, { yes: true, output: "yaml" });

    expect(formatOutput).toHaveBeenCalledWith(
      "yaml",
      expect.objectContaining({ schemaVersion: "audit.v1" }),
    );
  });

  it("returns without compose resolution when service selection is cancelled", async () => {
    vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue(null);

    await executeAudit({}, { yes: true });

    expect(lib.getComposeConfig).not.toHaveBeenCalled();
  });

  it("throws for invalid fail-on values before audit evaluation", async () => {
    await expect(executeAudit({ failOn: "bad" }, { yes: true })).rejects.toThrow(
      "Invalid fail-on severity",
    );
    expect(lib.loadConfig).not.toHaveBeenCalled();
  });

  it("throws for invalid profiles", async () => {
    vi.mocked(lib.isValidProfile).mockReturnValue(false);

    await expect(executeAudit({ profile: "missing" }, { yes: true })).rejects.toThrow(
      "Invalid profile",
    );
    expect(lib.getComposeConfig).not.toHaveBeenCalled();
  });

  it("formats compose config failures and sets an operational exit code", async () => {
    vi.mocked(lib.getComposeConfig).mockResolvedValue(undefined);

    await executeAudit({}, { yes: true });

    expect(common.outputFormattedError).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets exit code only when findings meet the threshold", async () => {
    await executeAudit({ failOn: "critical" }, { yes: true });

    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await executeAudit({ failOn: "none" }, { yes: true });

    expect(process.exitCode).toBeUndefined();
  });
});
