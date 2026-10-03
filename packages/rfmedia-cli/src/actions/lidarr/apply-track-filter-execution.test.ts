import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import { LidarrPlanAlreadyRunningError, LidarrPlanStaleError } from "../../lib/errors.js";
import { LidarrUnreachableError } from "../../lib/lidarr/errors.js";
import { acquireLidarrPlanClaim, readLidarrPlanHistory } from "../../lib/lidarr/plan-engine.js";
import { buildLidarrTrackFilterPlanV2 } from "../../lib/lidarr/plan-track-filter-operations.js";
import type { LidarrTrackFile } from "../../types/lidarr.js";

const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { operation: string; run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: task.operation,
      operation: task.operation,
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
}));

import { executeLidarrTrackFilterApply } from "./apply-track-filter-execution.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makePlan() {
  return buildLidarrTrackFilterPlanV2(
    {
      origin: "https://lidarr.example.test",
      albumId: 11,
      operation: { kind: "track-file-filter", explicitKeepTrackIds: [1] },
      maxBatch: 100,
      entry: {
        id: "album:11:track-file-filter",
        albumId: 11,
        albumTitle: "Album",
        artistId: 7,
        artistName: "Artist",
        before: {
          deleteCandidates: [
            {
              trackId: 2,
              trackTitle: "Second",
              trackFileId: 102,
              path: "/music/album/02.flac",
              size: 2_000,
              mediumNumber: 1,
              absoluteTrackNumber: 2,
            },
          ],
        },
        after: { deletedTrackFileIds: [102] },
        keptTrackIds: [1],
        warnings: [],
      },
    },
    { randomUUID: () => "21621621-6216-4216-8216-216216216216" },
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-track-filter-apply-"));
  roots.push(root);
  return {
    root,
    plan: makePlan(),
    planPath: join(root, "plan.json"),
    historyPath: join(root, "history.jsonl"),
    claimDirectory: join(root, "claims"),
  };
}

function target(overrides: Partial<LidarrTrackFile> = {}): LidarrTrackFile {
  return {
    id: 102,
    artistId: 7,
    albumId: 11,
    path: "/music/album/02.flac",
    size: 2_000,
    ...overrides,
  };
}

describe("executeLidarrTrackFilterApply", () => {
  it("checks exact before-state without mutation or history in dry-run mode", async () => {
    const files = await fixture();
    const client = createLidarrClientMock({ listTrackFiles: async () => [target()] });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: true,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.status).toBe("checked");
    expect(result.entries).toMatchObject([{ outcome: "would-apply", albumId: 11 }]);
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual([]);
  });

  it("blocks stale path, size, or parent evidence before dispatch", async () => {
    const files = await fixture();
    const client = createLidarrClientMock({
      listTrackFiles: async () => [target({ path: "/music/moved.flac" })],
    });

    await expect(
      executeLidarrTrackFilterApply({
        plan: files.plan,
        planPath: files.planPath,
        client,
        options: {
          dryRun: false,
          historyPath: files.historyPath,
          claimDirectory: files.claimDirectory,
        },
      }),
    ).rejects.toBeInstanceOf(LidarrPlanStaleError);
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
  });

  it("does not read or delete targets when another executor holds the plan claim", async () => {
    const files = await fixture();
    const claim = await acquireLidarrPlanClaim(files.plan.id, {
      claimDirectory: files.claimDirectory,
    });
    const client = createLidarrClientMock({ listTrackFiles: async () => [target()] });

    try {
      await expect(
        executeLidarrTrackFilterApply({
          plan: files.plan,
          planPath: files.planPath,
          client,
          options: {
            dryRun: false,
            historyPath: files.historyPath,
            claimDirectory: files.claimDirectory,
          },
        }),
      ).rejects.toBeInstanceOf(LidarrPlanAlreadyRunningError);
      expect(client.listTrackFiles).not.toHaveBeenCalled();
      expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
    } finally {
      await claim.release();
    }
  });

  it("dispatches one exact bulk delete and durably verifies absence", async () => {
    const files = await fixture();
    const present = [target()];
    const client = createLidarrClientMock({
      listTrackFiles: async () => [...present],
      bulkDeleteTrackFiles: async (ids) => {
        expect(ids).toEqual([102]);
        present.length = 0;
      },
    });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: false,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.status).toBe("completed");
    expect(result.entries).toMatchObject([{ outcome: "succeeded" }]);
    expect(client.bulkDeleteTrackFiles).toHaveBeenCalledOnce();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ outcome: "succeeded", albumId: 11 }]);
  });

  it("does not retry or defer when verification remains inconclusive", async () => {
    const files = await fixture();
    const listTrackFiles = vi
      .fn()
      .mockResolvedValueOnce([target()])
      .mockRejectedValue(new LidarrUnreachableError("verification"));
    const client = createLidarrClientMock({
      listTrackFiles,
      bulkDeleteTrackFiles: async () => undefined,
    });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: false,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.status).toBe("failed");
    expect(result.entries).toMatchObject([
      { outcome: "uncertain", errorCode: "verification-inconclusive" },
    ]);
    expect(client.bulkDeleteTrackFiles).toHaveBeenCalledOnce();
    expect(listTrackFiles).toHaveBeenCalledTimes(4);
  });

  it("reconciles a failed delete response when fresh reads prove absence", async () => {
    const files = await fixture();
    const present = [target()];
    const client = createLidarrClientMock({
      listTrackFiles: async () => [...present],
      bulkDeleteTrackFiles: async () => {
        present.length = 0;
        throw new LidarrUnreachableError("delete response");
      },
    });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: false,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.entries).toMatchObject([
      {
        outcome: "succeeded",
        message: "Delete response failed, but fresh reads verified every target absent",
      },
    ]);
    expect(client.bulkDeleteTrackFiles).toHaveBeenCalledOnce();
  });

  it("returns uncertain when verified remote success cannot be journaled", async () => {
    const files = await fixture();
    const present = [target()];
    const client = createLidarrClientMock({
      listTrackFiles: async () => [...present],
      bulkDeleteTrackFiles: async () => {
        present.length = 0;
        await mkdir(files.historyPath);
      },
    });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: false,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.entries).toMatchObject([
      { outcome: "uncertain", errorCode: "history-write-failed" },
    ]);
    expect(client.bulkDeleteTrackFiles).toHaveBeenCalledOnce();
  });

  it("honors cancellation before admission without dispatch", async () => {
    const files = await fixture();
    const client = createLidarrClientMock({ listTrackFiles: async () => [target()] });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      executeLidarrTrackFilterApply({
        plan: files.plan,
        planPath: files.planPath,
        client,
        options: {
          dryRun: false,
          historyPath: files.historyPath,
          claimDirectory: files.claimDirectory,
          signal: controller.signal,
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(client.listTrackFiles).not.toHaveBeenCalled();
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
  });

  it("attributes complete absence on explicit resume without redispatch", async () => {
    const files = await fixture();
    const client = createLidarrClientMock({ listTrackFiles: async () => [] });

    const result = await executeLidarrTrackFilterApply({
      plan: files.plan,
      planPath: files.planPath,
      client,
      options: {
        dryRun: false,
        resume: true,
        historyPath: files.historyPath,
        claimDirectory: files.claimDirectory,
      },
    });

    expect(result.entries).toMatchObject([{ outcome: "satisfied" }]);
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ outcome: "satisfied" }]);
  });
});
