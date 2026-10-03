/**
 * Critical tests for the `rfapps import` action.
 *
 * Covers the behaviours unique to import: classification of running-but-untracked
 * services, report-first (preview never writes), the exact --adopt state-write
 * shape with masked secrets, the --dry-run veto, uninspectable-container safety
 * (zero rows, partial exit 3), idempotency, and the machine-format guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RfappsConfig } from "../types/index.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveServicesWithInteractive: vi.fn(),
  formatOutput: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  recordDeployments: vi.fn(),
  getDeploymentCount: vi.fn(),
  getComposeConfig: vi.fn(),
  getRunningServiceContainerMap: vi.fn(),
  inspectContainers: vi.fn(),
  inspectContainerIdentity: vi.fn(),
  confirm: vi.fn(),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  outputFormattedError: vi.fn(),
}));

vi.mock("@rfmedia/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rfmedia/common")>()),
  confirm: mocks.confirm,
  logInfo: mocks.logInfo,
  logSuccess: mocks.logSuccess,
  logWarn: mocks.logWarn,
  logDebug: mocks.logDebug,
  outputFormattedError: mocks.outputFormattedError,
}));

vi.mock("../lib/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/index.js")>()),
  loadConfig: mocks.loadConfig,
  resolveServicesWithInteractive: mocks.resolveServicesWithInteractive,
  formatOutput: mocks.formatOutput,
  initializeDatabase: mocks.initializeDatabase,
  closeDatabase: mocks.closeDatabase,
  recordDeployments: mocks.recordDeployments,
  getDeploymentCount: mocks.getDeploymentCount,
}));

vi.mock("../lib/docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docker.js")>()),
  getComposeConfig: mocks.getComposeConfig,
  getRunningServiceContainerMap: mocks.getRunningServiceContainerMap,
  inspectContainers: mocks.inspectContainers,
  inspectContainerIdentity: mocks.inspectContainerIdentity,
}));

import { executeImport } from "./import.js";
import { buildConfigSnapshotFromInspect } from "../lib/runtime-baseline.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { ImportResult } from "../types/import.js";

const mockConfig: RfappsConfig = {
  composePath: "compose.yml",
  envFile: ".env",
  profiles: {
    defaultProfile: "all",
    validProfiles: ["all", "media", "arr-stack"],
    mapping: { plex: "media", sonarr: "arr-stack", radarr: "arr-stack" },
  },
  sidecars: { enabled: false, mapping: {} },
  groups: {},
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
};

function makeIdentity(overrides: Record<string, unknown> = {}) {
  return {
    localImageId: "sha256:img",
    configuredImage: "plexinc/pms:1.2",
    repositoryDigest: "sha256:dig",
    platform: "linux/amd64",
    containerId: "cid",
    state: "running",
    exitCode: 0,
    health: "healthy",
    ...overrides,
  };
}

function makeInspect(env: string[] = ["TZ=UTC"]) {
  return {
    Id: "cid",
    Name: "/plex-1",
    Image: "sha256:img",
    Config: {
      Image: "plexinc/pms:1.2",
      Env: env,
      Labels: { "com.docker.compose.project": "testproj" },
    },
    HostConfig: {
      Binds: ["/data:/data"],
      PortBindings: { "32400/tcp": [{ HostIp: "", HostPort: "32400" }] },
      NetworkMode: "bridge",
    },
    NetworkSettings: { Networks: { apps: {} } },
    State: { Running: true, ExitCode: 0 },
  };
}

/** Returns the ImportResult passed to the mocked machine-format renderer. */
function machineResult(): ImportResult {
  expect(mocks.formatOutput).toHaveBeenCalledTimes(1);
  return mocks.formatOutput.mock.calls[0]?.[1] as ImportResult;
}

describe("executeImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mocks.loadConfig.mockResolvedValue(mockConfig);
    mocks.resolveServicesWithInteractive.mockResolvedValue({
      services: [],
      profiles: [],
      preSidecarCount: 0,
      sidecarsExpanded: false,
    });
    mocks.getComposeConfig.mockResolvedValue({
      name: "testproj",
      services: { plex: {}, sonarr: {} },
    });
    mocks.getRunningServiceContainerMap.mockResolvedValue(
      new Map([
        ["plex", "plex-1"],
        ["sonarr", "sonarr-1"],
      ]),
    );
    mocks.getDeploymentCount.mockReturnValue(0);
    mocks.inspectContainerIdentity.mockResolvedValue(makeIdentity());
    mocks.inspectContainers.mockResolvedValue([makeInspect()]);
    mocks.initializeDatabase.mockResolvedValue({});
    mocks.recordDeployments.mockImplementation((_db: unknown, entries: unknown[]) =>
      entries.map((_, index) => index + 1),
    );
    mocks.confirm.mockResolvedValue(true);
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("classifies candidate / tracked / absent and previews without writing", async () => {
    mocks.getComposeConfig.mockResolvedValue({
      name: "testproj",
      services: { plex: {}, sonarr: {}, radarr: {} },
    });
    // sonarr already has history (tracked); radarr is declared but not running (absent).
    mocks.getDeploymentCount.mockImplementation((_db: unknown, opts: { service?: string }) =>
      opts.service === "sonarr" ? 3 : 0,
    );

    await executeImport({}, { json: true });

    const result = machineResult();
    const byService = Object.fromEntries(result.services.map((s) => [s.service, s.classification]));
    expect(byService).toEqual({ plex: "candidate", sonarr: "tracked", radarr: "absent" });
    expect(result.mode).toBe("preview");
    expect(result.services.every((s) => s.imported === false)).toBe(true);
    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("records a masked baseline for each candidate when --adopt is authorized", async () => {
    mocks.getRunningServiceContainerMap.mockResolvedValue(new Map([["plex", "plex-1"]]));
    mocks.getComposeConfig.mockResolvedValue({ name: "testproj", services: { plex: {} } });
    mocks.inspectContainers.mockResolvedValue([makeInspect(["TZ=UTC", "PLEX_TOKEN=supersecret"])]);

    await executeImport({ adopt: true }, { yes: true });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.recordDeployments).toHaveBeenCalledTimes(1);
    const entries = mocks.recordDeployments.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      service: "plex",
      action: "import",
      status: "success",
      imageTag: "plexinc/pms:1.2",
      imageId: "sha256:img",
      imageDigest: "sha256:dig",
    });
    const snapshot = JSON.parse(entry["configSnapshot"] as string);
    expect(snapshot.environment).toEqual({ TZ: "UTC", PLEX_TOKEN: "***MASKED***" });
    expect(snapshot.ports).toEqual(["32400:32400/tcp"]);
    expect(snapshot.volumes).toEqual(["/data:/data"]);
    expect(snapshot.networks).toEqual(["apps"]);
    expect(snapshot.labels).toEqual({ "com.docker.compose.project": "testproj" });
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("treats global --dry-run as a veto over --adopt (preview, no write)", async () => {
    await executeImport({ adopt: true }, { dryRun: true, yes: true });

    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining("--dry-run"));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("skips uninspectable candidates with zero rows and reports partial (exit 3)", async () => {
    mocks.inspectContainerIdentity.mockImplementation((container: string) =>
      container === "sonarr-1"
        ? Promise.reject(new Error("inspect blew up"))
        : Promise.resolve(makeIdentity()),
    );

    await executeImport({ adopt: true }, { yes: true });

    expect(mocks.recordDeployments).toHaveBeenCalledTimes(1);
    const entries = mocks.recordDeployments.mock.calls[0]?.[1] as Array<{ service: string }>;
    expect(entries.map((e) => e.service)).toEqual(["plex"]);
    expect(process.exitCode).toBe(3);
  });

  it("writes nothing and reports partial (exit 3) when the only candidate is uninspectable", async () => {
    mocks.getRunningServiceContainerMap.mockResolvedValue(new Map([["plex", "plex-1"]]));
    mocks.getComposeConfig.mockResolvedValue({ name: "testproj", services: { plex: {} } });
    mocks.inspectContainers.mockResolvedValue(undefined);

    await executeImport({ adopt: true }, { yes: true });

    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it("surfaces an uninspectable container in a read-only preview but still exits 0", async () => {
    mocks.getRunningServiceContainerMap.mockResolvedValue(new Map([["plex", "plex-1"]]));
    mocks.getComposeConfig.mockResolvedValue({ name: "testproj", services: { plex: {} } });
    mocks.inspectContainers.mockResolvedValue(undefined);

    await executeImport({}, { json: true }); // preview: no --adopt

    const result = machineResult();
    expect(result.mode).toBe("preview");
    expect(result.services.find((s) => s.service === "plex")?.classification).toBe("uninspectable");
    expect(result.exitCode).toBe(0);
    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("is idempotent: already-tracked services are skipped on re-run", async () => {
    mocks.getRunningServiceContainerMap.mockResolvedValue(new Map([["plex", "plex-1"]]));
    mocks.getComposeConfig.mockResolvedValue({ name: "testproj", services: { plex: {} } });
    mocks.getDeploymentCount.mockReturnValue(1); // plex already has history

    await executeImport({ adopt: true }, { yes: true });

    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("rejects machine-format adoption without --yes", async () => {
    await expect(executeImport({ adopt: true }, { json: true })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    expect(mocks.recordDeployments).not.toHaveBeenCalled();
  });
});

describe("buildConfigSnapshotFromInspect", () => {
  it("captures live container state with secrets masked and ports serialized", () => {
    const snapshot = buildConfigSnapshotFromInspect(
      makeInspect(["TZ=UTC", "API_KEY=nope"]) as never,
    );
    expect(snapshot).toEqual({
      image: "plexinc/pms:1.2",
      environment: { TZ: "UTC", API_KEY: "***MASKED***" },
      volumes: ["/data:/data"],
      ports: ["32400:32400/tcp"],
      networks: ["apps"],
      labels: { "com.docker.compose.project": "testproj" },
    });
  });
});
