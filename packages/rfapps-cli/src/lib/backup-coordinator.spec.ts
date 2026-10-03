import { describe, expect, it, vi } from "vitest";

import type { BackupPlan, BackupResult, BackupSource } from "../types/backup.js";
import type { ComposeContainerObservation } from "./docker.js";
import type { BackupPlannerInput } from "./backup-planner.js";
import {
  runBackup,
  type BackupCoordinatorDependencies,
  type RunBackupInput,
} from "./backup-coordinator.js";
import { BackupStorageError } from "./backup-storage.js";

const CONTAINER_A = "a".repeat(64);
const CONTAINER_B = "b".repeat(64);

function plan(): BackupPlan {
  return {
    requestedServices: ["app"],
    resolvedServices: ["app", "database"],
    quiescedServices: ["app", "database"],
    recoveryLayers: [["database"], ["app"]],
    mounts: [
      {
        id: "mount-0001",
        artifactPath: "artifacts/mount-0001.tar.gz",
        source: { kind: "bind", path: "/srv/app" },
        consumers: [{ service: "app", target: "/data", readOnly: false }],
        writerServices: ["app"],
        restore: {
          kind: "bind-tar",
          destinationPath: "/srv/app",
          precondition: "writers-stopped",
        },
      },
      {
        id: "mount-0002",
        artifactPath: "artifacts/mount-0002.tar.gz",
        source: { kind: "volume", name: "media_db", driver: "local", external: false },
        consumers: [{ service: "database", target: "/db", readOnly: false }],
        writerServices: ["database"],
        restore: {
          kind: "volume-tar",
          volumeName: "media_db",
          driver: "local",
          external: false,
          precondition: "writers-stopped",
        },
      },
    ],
    skipped: [],
    warnings: [{ code: "LIMIT", message: "Filesystem-level backup." }],
    resolvedConfigSha256: "a".repeat(64),
    dockerAuthorityFingerprint: "b".repeat(64),
    bindTopologyFingerprint: "e".repeat(64),
    canonicalDestination: "/backup",
  };
}

function plannerInput(): BackupPlannerInput {
  return {
    composeEvidence: {
      resolvedConfigFingerprint: "a".repeat(64),
      config: { name: "media", services: {}, volumes: {}, networks: {} },
    },
    requestedServices: ["app"],
    canonicalDestination: "/backup",
    dockerAuthorityFingerprint: "b".repeat(64),
    localDockerAuthority: true,
  };
}

function observation(containerId: string, serviceName: string): ComposeContainerObservation {
  return {
    containerId,
    containerName: `${serviceName}-1`,
    serviceName,
    state: "running",
    health: "healthy",
  };
}

function input(dryRun = false): RunBackupInput {
  return {
    dryRun,
    destinationPath: "/backup",
    bundleName: "rfapps-backup-media-20260729",
    composePath: "/project/compose.yml",
    projectDir: "/project",
    ...(dryRun
      ? {}
      : {
          reviewedHelper: {
            reference:
              "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1" as const,
            resolvedImageId: `sha256:${"c".repeat(64)}`,
          },
        }),
    plannerInput: plannerInput(),
    loadRevalidationInput: async () => plannerInput(),
  };
}

function fakeDependencies(events: string[]): BackupCoordinatorDependencies {
  let now = 0;
  return {
    validateDestination: vi.fn(async () => {
      events.push("validate-destination");
      return { path: "/backup", device: 1, inode: 2 };
    }),
    plan: vi.fn(async () => {
      events.push("plan");
      return plan();
    }),
    reserveBundle: vi.fn(async () => {
      events.push("reserve");
      return {
        destinationPath: "/backup",
        bundlePath: "/backup/bundle",
        artifactsPath: "/backup/bundle/artifacts",
        manifestPath: "/backup/bundle/manifest.json",
        destinationDevice: 1,
        destinationInode: 2,
        device: 1,
        inode: 3,
        artifactsDevice: 1,
        artifactsInode: 4,
      };
    }),
    prepareHelper: vi.fn(async () => {
      events.push("prepare-helper");
      return {
        reference:
          "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1" as const,
        resolvedImageId: `sha256:${"c".repeat(64)}`,
      };
    }),
    inspectHelper: vi.fn(async () => {
      events.push("inspect-helper");
      return {
        reference:
          "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1" as const,
        resolvedImageId: `sha256:${"c".repeat(64)}`,
      };
    }),
    acquireLock: vi.fn(async () => {
      events.push("lock");
      return {
        path: "/lock",
        owner: {
          pid: 1,
          startedAt: "2026-07-29T00:00:00.000Z",
          projectPath: "/project",
          dockerContext: "b".repeat(64),
        },
        release: async () => {
          events.push("unlock");
        },
      };
    }),
    observeRunning: vi.fn(async () => {
      events.push("observe");
      return [];
    }),
    stopWriters: vi.fn(async () => {
      events.push("stop");
    }),
    archiveSource: vi.fn(async (source: BackupSource) => {
      events.push(`archive:${source.kind}`);
      return { compressedBytes: source.kind === "bind" ? 10 : 20, sha256: "d".repeat(64) };
    }),
    startContainer: vi.fn(async (containerId: string) => {
      events.push(`start:${containerId.slice(0, 1)}`);
    }),
    publishManifest: vi.fn(async () => {
      events.push("publish");
      return "/backup/bundle/manifest.json";
    }),
    removeIncompleteBundle: vi.fn(async () => {
      events.push("remove");
    }),
    retainIncompleteBundle: vi.fn(async () => {
      events.push("retain");
      return "/backup/bundle";
    }),
    now: () => new Date(Date.UTC(2026, 6, 29, 0, 0, now++)),
    randomId: () => "backup-id",
    getInterruption: () => undefined,
  };
}

function expectFailure(
  result: BackupResult,
): asserts result is Extract<BackupResult, { success: false }> {
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Expected a failed backup result");
}

describe("runBackup", () => {
  it("returns a complete dry-run plan with no persistent or lifecycle mutation", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);

    const result = await runBackup(input(true), dependencies);

    expect(result).toMatchObject({
      status: "planned",
      success: true,
      dryRun: true,
      stagingDisposition: "none",
    });
    expect(result.artifacts).toHaveLength(2);
    expect(events).toEqual(["validate-destination", "plan"]);
  });

  it("reports unsafe destination validation as usage failure before reservation", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.validateDestination).mockRejectedValueOnce(
      Object.assign(new Error("unsafe"), { code: "BACKUP_DESTINATION_UNSAFE" }),
    );

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.exitCode).toBe(2);
    expect(result.primaryFailure.stage).toBe("validate");
    expect(dependencies.reserveBundle).not.toHaveBeenCalled();
  });

  it("reports a trusted retained path when reservation fails after bundle creation", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const bundlePath = "/backup/retained-reservation";
    const secret = "storage-provider-secret";
    vi.mocked(dependencies.reserveBundle).mockRejectedValueOnce(
      new BackupStorageError(
        "BACKUP_STORAGE_IO",
        "Backup bundle could not be reserved",
        bundlePath,
        { cause: new Error(secret) },
        { bundlePath, stagingDisposition: "retained-incomplete" },
      ),
    );

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result).toMatchObject({
      primaryFailure: {
        stage: "reserve",
        code: "BACKUP_STORAGE_IO",
      },
      stagingDisposition: "retained-incomplete",
      bundlePath,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(dependencies.removeIncompleteBundle).not.toHaveBeenCalled();
    expect(dependencies.retainIncompleteBundle).not.toHaveBeenCalled();
  });

  it("archives every source once, recovers exact IDs in dependency order, then publishes", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([
        observation(CONTAINER_A, "app"),
        observation(CONTAINER_B, "database"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([observation(CONTAINER_A, "app"), observation(CONTAINER_B, "database")]);

    const result = await runBackup(input(), dependencies);

    expect(result).toMatchObject({
      status: "succeeded",
      success: true,
      stagingDisposition: "published",
    });
    expect(dependencies.archiveSource).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:b", "start:a"]);
    expect(events.slice(0, 7)).toEqual([
      "validate-destination",
      "plan",
      "reserve",
      "prepare-helper",
      "lock",
      "inspect-helper",
      "plan",
    ]);
    expect(events.indexOf("start:a")).toBeLessThan(events.indexOf("publish"));
    expect(events.at(-1)).toBe("unlock");
  });

  it("never widens an empty writer scope into a Compose-wide stop", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.plan).mockResolvedValue({
      ...plan(),
      quiescedServices: [],
      recoveryLayers: [],
      mounts: [
        {
          ...plan().mounts[0]!,
          consumers: [{ service: "app", target: "/data", readOnly: true }],
          writerServices: [],
        },
      ],
    });

    const result = await runBackup(input(), dependencies);

    expect(result.success).toBe(true);
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
    expect(dependencies.observeRunning).not.toHaveBeenCalled();
  });

  it("recovers after a partial stop failure and removes ordinary incomplete staging", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([
        observation(CONTAINER_A, "app"),
        observation(CONTAINER_B, "database"),
      ])
      .mockResolvedValueOnce([observation(CONTAINER_A, "app")])
      .mockResolvedValue([observation(CONTAINER_A, "app"), observation(CONTAINER_B, "database")]);
    vi.mocked(dependencies.stopWriters).mockRejectedValueOnce(new Error("partial stop"));

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure.stage).toBe("stop");
    expect(dependencies.startContainer).toHaveBeenCalledOnce();
    expect(dependencies.startContainer).toHaveBeenCalledWith(CONTAINER_B);
    expect(result.recoveryFailures).toEqual([]);
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
    expect(dependencies.removeIncompleteBundle).toHaveBeenCalledOnce();
    expect(result.stagingDisposition).toBe("removed");
  });

  it("retains manifest-less staging when a started exact container exits before verification", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([observation(CONTAINER_A, "app")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          ...observation(CONTAINER_A, "app"),
          state: "exited",
        },
      ]);

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.recoveryFailures).toEqual([
      expect.objectContaining({
        containerId: CONTAINER_A,
        code: "RECOVERED_CONTAINER_INACTIVE",
      }),
    ]);
    expect(result.stagingDisposition).toBe("retained-incomplete");
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });

  it("retains manifest-less staging when an exact container is missing after recovery", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([observation(CONTAINER_A, "app")])
      .mockResolvedValue([]);

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.recoveryFailures).toEqual([
      expect.objectContaining({
        containerId: CONTAINER_A,
        code: "RECOVERED_CONTAINER_MISSING",
      }),
    ]);
    expect(result.stagingDisposition).toBe("retained-incomplete");
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });

  it("retains manifest-less staging when final recovery observation fails", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([observation(CONTAINER_A, "app")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("observation failed"));

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.recoveryFailures).toEqual([
      expect.objectContaining({
        containerId: CONTAINER_A,
        code: "RECOVERY_OBSERVATION_FAILED",
      }),
    ]);
    expect(result.stagingDisposition).toBe("retained-incomplete");
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });

  it("retains manifest-less staging and reports every exact-container recovery failure", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([
        observation(CONTAINER_A, "app"),
        observation(CONTAINER_B, "database"),
      ])
      .mockResolvedValue([]);
    vi.mocked(dependencies.archiveSource).mockRejectedValueOnce(new Error("archive failed"));
    vi.mocked(dependencies.startContainer).mockRejectedValue(new Error("restart failed"));

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure.stage).toBe("archive");
    expect(result.recoveryFailures).toHaveLength(2);
    expect(result.stagingDisposition).toBe("retained-incomplete");
    expect(dependencies.retainIncompleteBundle).toHaveBeenCalledOnce();
    expect(dependencies.removeIncompleteBundle).not.toHaveBeenCalled();
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });

  it("truthfully retains staging with its exact path and cleanup failure evidence", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.archiveSource).mockRejectedValueOnce(new Error("archive failed"));
    vi.mocked(dependencies.removeIncompleteBundle).mockRejectedValueOnce(
      Object.assign(new Error("remove failed"), { code: "BACKUP_STORAGE_IO" }),
    );

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result).toMatchObject({
      stagingDisposition: "retained-incomplete",
      bundlePath: "/backup/bundle",
      recoveryFailures: [],
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "cleanup", code: "BACKUP_STORAGE_IO" }),
      ]),
    );
    expect(dependencies.retainIncompleteBundle).toHaveBeenCalledOnce();
  });

  it("does not stop or publish when locked revalidation changes the plan", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.plan)
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce({ ...plan(), resolvedConfigSha256: "f".repeat(64) });

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure.stage).toBe("revalidate");
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
    expect(dependencies.removeIncompleteBundle).toHaveBeenCalledOnce();
  });

  it("does not stop or publish when locked bind topology changes", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.plan)
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce({ ...plan(), bindTopologyFingerprint: "f".repeat(64) });

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure.stage).toBe("revalidate");
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
    expect(dependencies.removeIncompleteBundle).toHaveBeenCalledOnce();
  });

  it("does not stop or publish when the locked helper identity changes", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.inspectHelper).mockResolvedValue({
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
      resolvedImageId: `sha256:${"d".repeat(64)}`,
    });

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure.stage).toBe("revalidate");
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
    expect(dependencies.removeIncompleteBundle).toHaveBeenCalledOnce();
  });

  it("removes staging and preserves post-confirm helper identity drift evidence", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    vi.mocked(dependencies.prepareHelper).mockResolvedValue({
      reference:
        "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1",
      resolvedImageId: `sha256:${"d".repeat(64)}`,
    });

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.primaryFailure).toMatchObject({
      stage: "prepare-helper",
      code: "HELPER_IDENTITY_DRIFT",
    });
    expect(dependencies.removeIncompleteBundle).toHaveBeenCalledOnce();
    expect(dependencies.acquireLock).not.toHaveBeenCalled();
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
  });

  it("does not reserve or stop when a real run has no user-reviewed helper identity", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const runInput = { ...input(), reviewedHelper: undefined };

    const result = await runBackup(runInput, dependencies);

    expectFailure(result);
    expect(result.primaryFailure).toMatchObject({
      stage: "prepare-helper",
      code: "HELPER_IDENTITY_UNREVIEWED",
    });
    expect(dependencies.reserveBundle).not.toHaveBeenCalled();
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
  });

  it("normalizes a revalidation read failure without exposing its payload", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    const secret = "ssh://token@example.test";
    const runInput = {
      ...input(),
      loadRevalidationInput: async (): Promise<BackupPlannerInput> => {
        throw new Error(secret);
      },
    };

    const result = await runBackup(runInput, dependencies);

    expectFailure(result);
    expect(result.primaryFailure).toMatchObject({
      stage: "revalidate",
      code: "REVALIDATION_FAILED",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(dependencies.stopWriters).not.toHaveBeenCalled();
  });

  it("turns interruption into a terminal result only after exact recovery and cleanup", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    let interrupted = false;
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([observation(CONTAINER_A, "app")])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([observation(CONTAINER_A, "app")]);
    vi.mocked(dependencies.archiveSource).mockImplementationOnce(async () => {
      events.push("archive:bind");
      interrupted = true;
      return { compressedBytes: 10, sha256: "d".repeat(64) };
    });
    dependencies.getInterruption = () => (interrupted ? "SIGINT" : undefined);

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result.status).toBe("cancelled");
    expect(events.indexOf("start:a")).toBeLessThan(events.indexOf("remove"));
    expect(events.indexOf("remove")).toBeLessThan(events.indexOf("unlock"));
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });

  it("finishes exact recovery and cleanup when interruption arrives during recovery", async () => {
    const events: string[] = [];
    const dependencies = fakeDependencies(events);
    let interrupted = false;
    vi.mocked(dependencies.observeRunning)
      .mockResolvedValueOnce([
        observation(CONTAINER_A, "app"),
        observation(CONTAINER_B, "database"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([observation(CONTAINER_A, "app"), observation(CONTAINER_B, "database")]);
    vi.mocked(dependencies.startContainer).mockImplementation(async (containerId) => {
      events.push(`start:${containerId.slice(0, 1)}`);
      interrupted = true;
    });
    dependencies.getInterruption = () => (interrupted ? "SIGTERM" : undefined);

    const result = await runBackup(input(), dependencies);

    expectFailure(result);
    expect(result).toMatchObject({
      status: "cancelled",
      exitCode: 2,
      stagingDisposition: "removed",
    });
    expect(dependencies.startContainer).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:b", "start:a"]);
    expect(events.indexOf("start:a")).toBeLessThan(events.indexOf("remove"));
    expect(events.indexOf("remove")).toBeLessThan(events.indexOf("unlock"));
    expect(dependencies.publishManifest).not.toHaveBeenCalled();
  });
});
