/**
 * Critical tests for the `rfapps state rebuild` action.
 *
 * Covers only the four behaviours that make the command safe: the report phase
 * (and --dry-run) never touch the database, the mandatory backup really does
 * gate every write, an authorized rewrite writes masked baselines and refuses to
 * re-baseline drifted services, and the two structural gates that make an
 * accidental total wipe and a "successful" empty rebuild unreachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RfappsConfig } from "../types/index.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  applyCliOverrides: vi.fn(),
  isValidProfile: vi.fn(),
  formatOutput: vi.fn(),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  recordDeployments: vi.fn(),
  getGenerations: vi.fn(),
  getStateDbPath: vi.fn(),
  probeStateDatabase: vi.fn(),
  openReadOnlyStateDatabase: vi.fn(),
  readLatestRecordedImageIds: vi.fn(),
  backupStateDatabase: vi.fn(),
  defaultBackupPath: vi.fn(),
  buildReplacementDatabasePath: vi.fn(),
  carryOverState: vi.fn(),
  swapStateDatabase: vi.fn(),
  resolveComposeProjectIdentity: vi.fn(),
  getComposeConfig: vi.fn(),
  getComposeContainerObservations: vi.fn(),
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

// `captureRuntimeBaseline` and `toBaselineEntry` are deliberately NOT mocked:
// test 7 pins the secret masking that runs inside them, and mocking them would
// assert against a stub. Only the Docker boundary is replaced.
vi.mock("../lib/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/index.js")>()),
  loadConfig: mocks.loadConfig,
  applyCliOverrides: mocks.applyCliOverrides,
  isValidProfile: mocks.isValidProfile,
  formatOutput: mocks.formatOutput,
  initializeDatabase: mocks.initializeDatabase,
  closeDatabase: mocks.closeDatabase,
  recordDeployments: mocks.recordDeployments,
  getGenerations: mocks.getGenerations,
  getStateDbPath: mocks.getStateDbPath,
  probeStateDatabase: mocks.probeStateDatabase,
  openReadOnlyStateDatabase: mocks.openReadOnlyStateDatabase,
  readLatestRecordedImageIds: mocks.readLatestRecordedImageIds,
  backupStateDatabase: mocks.backupStateDatabase,
  defaultBackupPath: mocks.defaultBackupPath,
  buildReplacementDatabasePath: mocks.buildReplacementDatabasePath,
  carryOverState: mocks.carryOverState,
  swapStateDatabase: mocks.swapStateDatabase,
  resolveComposeProjectIdentity: mocks.resolveComposeProjectIdentity,
}));

vi.mock("../lib/identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/identity.js")>()),
  resolveComposeProjectIdentity: mocks.resolveComposeProjectIdentity,
}));

vi.mock("../lib/docker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docker.js")>()),
  getComposeConfig: mocks.getComposeConfig,
  getComposeContainerObservations: mocks.getComposeContainerObservations,
  inspectContainers: mocks.inspectContainers,
  inspectContainerIdentity: mocks.inspectContainerIdentity,
}));

import { executeStateRebuild } from "./state-rebuild.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { StateDatabaseProbe, StateRebuildResult } from "../types/state-rebuild.js";

const ORIGINAL_BYTES = "not-a-real-sqlite-file";

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

function makeObservation(service: string, state = "running") {
  return {
    containerId: `${service}-cid`,
    containerName: `${service}-1`,
    serviceName: service,
    state,
    health: "healthy",
  };
}

/** Returns the StateRebuildResult passed to the mocked machine-format renderer. */
function machineResult(): StateRebuildResult {
  expect(mocks.formatOutput).toHaveBeenCalledTimes(1);
  return mocks.formatOutput.mock.calls[0]?.[1] as StateRebuildResult;
}

describe("executeStateRebuild", () => {
  let tempDir: string;
  let dbPath: string;
  let probe: StateDatabaseProbe;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.exitCode = undefined;

    tempDir = await mkdtemp(join(tmpdir(), "rfapps-state-rebuild-"));
    dbPath = join(tempDir, "state.db");
    probe = {
      path: dbPath,
      status: "readable",
      isDefaultPath: true,
      integrity: "ok",
      schemaVersion: 3,
      deployments: 4,
      generations: 4,
      trackedServices: ["sonarr"],
    };

    mocks.loadConfig.mockResolvedValue(mockConfig);
    mocks.applyCliOverrides.mockImplementation((config: RfappsConfig) => config);
    mocks.isValidProfile.mockReturnValue(true);
    mocks.resolveComposeProjectIdentity.mockResolvedValue({
      composePath: "/proj/compose.yml",
      projectDir: "/proj",
      projectName: "testproj",
    });
    mocks.getComposeConfig.mockResolvedValue({
      name: "testproj",
      services: { plex: {}, sonarr: {} },
    });
    mocks.getComposeContainerObservations.mockResolvedValue([
      makeObservation("plex"),
      makeObservation("sonarr"),
    ]);
    mocks.inspectContainerIdentity.mockResolvedValue(makeIdentity());
    mocks.inspectContainers.mockResolvedValue([makeInspect()]);

    mocks.getStateDbPath.mockReturnValue(dbPath);
    mocks.probeStateDatabase.mockImplementation(() => Promise.resolve(probe));
    mocks.openReadOnlyStateDatabase.mockReturnValue({ close: vi.fn() });
    mocks.readLatestRecordedImageIds.mockReturnValue(new Map<string, string | undefined>());
    mocks.defaultBackupPath.mockReturnValue(join(tempDir, "backups", "state-stamp.db"));
    mocks.buildReplacementDatabasePath.mockReturnValue(join(tempDir, ".state.db.rebuild.tmp"));
    mocks.backupStateDatabase.mockResolvedValue({
      path: join(tempDir, "backups", "state-stamp.db"),
      method: "sqlite-backup",
      bytes: 4096,
      sidecars: [],
    });
    mocks.carryOverState.mockReturnValue({
      deploymentsCarried: 4,
      deploymentsDiscarded: 0,
      generationsCarried: 4,
      generationsDiscarded: 0,
      generationsDerived: 0,
    });
    mocks.swapStateDatabase.mockResolvedValue(undefined);
    mocks.initializeDatabase.mockResolvedValue({});
    mocks.recordDeployments.mockImplementation((_db: unknown, entries: unknown[]) =>
      entries.map((_entry, index) => index + 100),
    );
    mocks.getGenerations.mockReturnValue([{ generation: 7 }]);
    mocks.confirm.mockResolvedValue(true);
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("never touches the database in the report phase or under --dry-run", async () => {
    await writeFile(dbPath, ORIGINAL_BYTES);

    await executeStateRebuild({}, { json: true });

    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.backupStateDatabase).not.toHaveBeenCalled();
    expect(mocks.swapStateDatabase).not.toHaveBeenCalled();
    expect(machineResult().phase).toBe("report");
    expect(await readFile(dbPath, "utf8")).toBe(ORIGINAL_BYTES);
    expect(process.exitCode ?? 0).toBe(0);

    // --dry-run vetoes --rewrite and degrades to the same read-only report.
    await executeStateRebuild({ rewrite: true }, { json: true, dryRun: true });

    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.backupStateDatabase).not.toHaveBeenCalled();
    expect(mocks.swapStateDatabase).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("--dry-run overrides --rewrite"),
    );
    expect(await readFile(dbPath, "utf8")).toBe(ORIGINAL_BYTES);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("aborts before creating a replacement when the mandatory backup fails", async () => {
    await writeFile(dbPath, ORIGINAL_BYTES);
    mocks.backupStateDatabase.mockRejectedValue(new Error("no space left on device"));

    await executeStateRebuild({ rewrite: true }, { yes: true });

    expect(mocks.backupStateDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.swapStateDatabase).not.toHaveBeenCalled();
    expect(mocks.outputFormattedError).toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("The state database was not modified."),
    );
    expect(await readFile(dbPath, "utf8")).toBe(ORIGINAL_BYTES);
    expect(process.exitCode).toBe(1);
  });

  it("writes one masked baseline per reconstructed service and never rewrites a stale one", async () => {
    probe.trackedServices = ["sonarr"];
    mocks.getComposeConfig.mockResolvedValue({
      name: "testproj",
      services: { plex: {}, radarr: {}, sonarr: {} },
    });
    mocks.getComposeContainerObservations.mockResolvedValue([
      makeObservation("plex"),
      makeObservation("radarr"),
      makeObservation("sonarr"),
    ]);
    // sonarr has history whose recorded image id no longer matches runtime.
    mocks.readLatestRecordedImageIds.mockReturnValue(
      new Map<string, string | undefined>([["sonarr", "sha256:old"]]),
    );
    mocks.inspectContainerIdentity.mockImplementation((container: string) =>
      Promise.resolve(
        container === "sonarr-1" ? makeIdentity({ localImageId: "sha256:new" }) : makeIdentity(),
      ),
    );
    mocks.inspectContainers.mockResolvedValue([makeInspect(["TZ=UTC", "PLEX_TOKEN=supersecret"])]);

    await executeStateRebuild({ rewrite: true }, { json: true, yes: true });

    expect(mocks.recordDeployments).toHaveBeenCalledTimes(1);
    const entries = mocks.recordDeployments.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry["service"])).toEqual(["plex", "radarr"]);
    // One shared ISO timestamp for the whole batch.
    expect(entries[0]?.["timestamp"]).toBe(entries[1]?.["timestamp"]);
    expect(entries[0]?.["timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(entries[0]).toMatchObject({
      service: "plex",
      action: "import",
      status: "success",
      imageTag: "plexinc/pms:1.2",
      imageId: "sha256:img",
      imageDigest: "sha256:dig",
    });
    const snapshot = JSON.parse(entries[0]?.["configSnapshot"] as string) as {
      environment: Record<string, string>;
    };
    expect(snapshot.environment).toEqual({ TZ: "UTC", PLEX_TOKEN: "***MASKED***" });

    const result = machineResult();
    const sonarr = result.services.find((service) => service.service === "sonarr");
    expect(sonarr?.disposition).toBe("stale");
    expect(sonarr?.reason).toBe("recorded image id differs from runtime");
    expect(sonarr?.written).toBe(false);
    // Generation numbers are read back, never assumed.
    expect(result.services.find((service) => service.service === "plex")?.generation).toBe(7);
    expect(result.summary.droppedServices).toEqual([]);
    expect(result.phase).toBe("rewrite");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("gates runtime-only on --confirm-project and refuses an empty plan", async () => {
    // (a) Discarding history requires the project token, and --yes cannot defeat it.
    await expect(
      executeStateRebuild({ rewrite: true, mode: "runtime-only" }, { json: true, yes: true }),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      executeStateRebuild(
        { rewrite: true, mode: "runtime-only", confirmProject: "otherproj" },
        { json: true, yes: true },
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(mocks.backupStateDatabase).not.toHaveBeenCalled();
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();

    // (b) Nothing to carry and nothing observed is a refusal, never a success.
    probe = { path: dbPath, status: "missing", isDefaultPath: true };
    mocks.getComposeContainerObservations.mockResolvedValue([]);

    await executeStateRebuild({ rewrite: true }, { json: true, yes: true });

    expect(machineResult().refusal?.reason).toBe("empty-plan");
    expect(mocks.backupStateDatabase).not.toHaveBeenCalled();
    expect(mocks.initializeDatabase).not.toHaveBeenCalled();
    expect(mocks.swapStateDatabase).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("abandons the replacement when salvage carries none of a readable source's history", async () => {
    await writeFile(dbPath, ORIGINAL_BYTES);
    // carryOverState never throws: a wholesale rollback looks exactly like an
    // empty source unless the counts are reconciled against the probe.
    mocks.carryOverState.mockReturnValue({
      deploymentsCarried: 0,
      deploymentsDiscarded: 0,
      generationsCarried: 0,
      generationsDiscarded: 0,
      generationsDerived: 0,
    });

    await executeStateRebuild({ rewrite: true }, { json: true, yes: true });

    expect(mocks.carryOverState).toHaveBeenCalledTimes(1);
    expect(mocks.recordDeployments).not.toHaveBeenCalled();
    expect(mocks.swapStateDatabase).not.toHaveBeenCalled();
    expect(await readFile(dbPath, "utf8")).toBe(ORIGINAL_BYTES);

    const result = machineResult();
    expect(result.failure?.reason).toBe("carry-over-failed");
    expect(result.phase).toBe("report");
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("The state database was not modified."),
    );
    expect(process.exitCode).toBe(1);
  });
});
