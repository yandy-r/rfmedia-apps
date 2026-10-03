import * as fs from "node:fs/promises";

import * as common from "@rfmedia/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeConfig } from "../lib/docker.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { formatOutput } from "../lib/formatters/index.js";
import * as lib from "../lib/index.js";
import type { RfappsConfig } from "../types/config.js";
import type { HardenResult } from "../types/hardening.js";
import { executeHarden } from "./harden.js";

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
  return { ...actual, formatOutput: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    confirm: vi.fn(),
    formatError: vi.fn(),
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    outputFormattedError: vi.fn(),
  };
});

vi.mock("node:fs/promises");

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

// Round-trips byte-identically under { lineWidth: 0, flowCollectionPadding: false }
// so detectReformat -> wouldReformat: false and the --apply reformat guard never
// fires in these cases.
const composeSource = "services:\n  sonarr:\n    image: sonarr:latest\n";

const composeConfig = {
  services: {
    sonarr: {
      name: "sonarr",
      image: "sonarr:latest",
      restart: "unless-stopped",
      user: "1000:1000",
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      healthcheck: { test: ["CMD", "true"] },
      deploy: { resources: { limits: { memory: "1g", cpus: "1.0" } } },
      // no security_opt  -> harden-no-new-privileges (safe)
      // no cap_drop      -> harden-cap-drop-all      (review)
      // no read_only     -> harden-read-only-rootfs  (review)
    },
  },
};

describe("executeHarden", () => {
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
      services: ["sonarr"],
      profiles: ["core"],
      preSidecarCount: 1,
      sidecarsExpanded: false,
    });
    vi.mocked(lib.getComposeConfig).mockResolvedValue(composeConfig as unknown as ComposeConfig);
    vi.mocked(common.formatError).mockReturnValue({
      message: "formatted error",
      suggestions: [],
      exitCode: 1,
      originalError: new Error("formatted error"),
    });
    vi.mocked(common.outputFormattedError).mockReturnValue(undefined);
    vi.mocked(fs.readFile).mockResolvedValue(composeSource);
    vi.mocked(fs.writeFile).mockResolvedValue();
    vi.mocked(fs.copyFile).mockResolvedValue();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("propose mode writes nothing", async () => {
    await executeHarden({}, { yes: true, output: "json" });

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        schemaVersion: "harden.v1",
        mode: "propose",
        write: { mode: "propose" },
        summary: expect.objectContaining({ applied: 0 }),
      }),
    );
  });

  it("--apply cancelled at the prompt writes nothing", async () => {
    vi.mocked(common.confirm).mockResolvedValue(false);

    await executeHarden({ apply: true }, {});

    expect(common.confirm).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects --apply together with --out", async () => {
    await expect(
      executeHarden({ apply: true, out: "compose.harden.yaml" }, { yes: true }),
    ).rejects.toThrow(InvalidArgumentError);
    expect(lib.loadConfig).not.toHaveBeenCalled();
  });

  it("rejects --apply in csv output without --yes", async () => {
    // csv is a machine format, so the action skips the prompt; without this
    // guard the write would land with neither confirmation nor --yes.
    await expect(executeHarden({ apply: true }, { output: "csv" })).rejects.toThrow(
      InvalidArgumentError,
    );
    expect(common.confirm).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("keeps review proposals out of written output without --include-review", async () => {
    await executeHarden({}, { yes: true, output: "json" });

    const result = vi.mocked(formatOutput).mock.calls[0]?.[1] as HardenResult;

    expect(result.proposals).toContainEqual(
      expect.objectContaining({ ruleId: "harden-read-only-rootfs", confidence: "review" }),
    );
    expect(result.override).toContain("no-new-privileges");
    expect(result.override).not.toContain("read_only");
    expect(result.summary.applied).toBe(0);
  });
});
