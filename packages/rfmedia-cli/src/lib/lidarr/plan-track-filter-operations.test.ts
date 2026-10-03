import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LidarrPlanValidationError } from "../errors.js";
import {
  computeLidarrPlanChecksum,
  readLidarrPlanArtifact,
  writeLidarrPlanArtifact,
} from "./plan-engine.js";
import {
  buildLidarrTrackFilterPlanV2,
  buildLidarrTrackFilterPlanV3,
  type BuildLidarrTrackFilterPlanInput,
} from "./plan-track-filter-operations.js";
import { analyzeLidarrCascade, resolveLidarrCascadePolicy } from "./cascade-analysis.js";

const roots: string[] = [];
const BUILD_DEPENDENCIES = {
  randomUUID: () => "21621621-6216-4216-8216-216216216216",
  now: () => new Date("2026-07-25T12:00:00.000Z"),
  hostname: () => "test-host",
  username: () => "test-user",
  cwd: () => "/test/cwd",
  cliVersion: "0.5.0-test",
};
const CASCADE_POLICY = resolveLidarrCascadePolicy({
  assumptions: { indexerQueriesPerCandidate: 2 },
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function buildInput(maxBatch = 2): BuildLidarrTrackFilterPlanInput {
  return {
    origin: "https://lidarr.example.test",
    albumId: 11,
    operation: {
      kind: "track-file-filter",
      explicitKeepTrackIds: [1],
      minStars: 3,
    },
    maxBatch,
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
            rating: 0.2,
          },
          {
            trackId: 3,
            trackTitle: "Third",
            trackFileId: 103,
            path: "/music/album/03.flac",
            size: 3_000,
            mediumNumber: 1,
            absoluteTrackNumber: 3,
            rating: 0.4,
          },
        ],
      },
      after: { deletedTrackFileIds: [102, 103] },
      keptTrackIds: [1],
      warnings: [],
    },
  };
}

function buildPlan(maxBatch = 2) {
  return buildLidarrTrackFilterPlanV2(buildInput(maxBatch), BUILD_DEPENDENCIES);
}

function buildPlanV3(albumMonitored: boolean) {
  return buildLidarrTrackFilterPlanV3(
    {
      ...buildInput(),
      albumMonitored,
      cascadePolicy: CASCADE_POLICY,
    },
    BUILD_DEPENDENCIES,
  );
}

describe("track-file-filter plan contract", () => {
  it("canonicalizes and seals exact candidates with candidate-count batching", () => {
    const plan = buildPlan();

    expect(plan.target.origin).toBe("https://lidarr.example.test");
    expect(plan.version).toBe("rfmedia.lidarr-plan.v2");
    expect(plan.review).toEqual({ requested: 2, changed: 2, unchanged: 0 });
    expect(plan.summary).toEqual({
      kind: "track-file-filter",
      tracks: 3,
      kept: 1,
      deleteCandidates: 2,
      warnings: 0,
      totalDeleteBytes: 5_000,
    });
    expect(plan.payloadChecksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(plan.entries[0].idempotencyKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() => buildPlan(1)).toThrow("delete candidates exceed maxBatch");
  });

  it.each([
    {
      albumMonitored: true,
      expectedCandidates: 1,
      expectedQueries: 2,
      expectedBasis: "monitored-album-file-removal",
    },
    {
      albumMonitored: false,
      expectedCandidates: 0,
      expectedQueries: 0,
      expectedBasis: "unmonitored-album-file-removal",
    },
  ] as const)(
    "seals albumMonitored=$albumMonitored with deterministic v3 cascade evidence",
    ({ albumMonitored, expectedCandidates, expectedQueries, expectedBasis }) => {
      const plan = buildPlanV3(albumMonitored);

      expect(plan.version).toBe("rfmedia.lidarr-plan.v3");
      expect(plan.entries[0].before.albumMonitored).toBe(albumMonitored);
      expect(plan.entries[0].before.deleteCandidates).toHaveLength(2);
      expect(plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
        value: expectedCandidates,
        basis: expectedBasis,
      });
      expect(plan.cascadeAnalysis.metrics.conditionalIndexerQueries.value).toBe(expectedQueries);
      expect(plan.payloadChecksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
    },
  );

  it("reports zero reacquisition exposure when a monitored album has no removals", () => {
    const analysis = analyzeLidarrCascade(
      {
        operation: { kind: "track-file-filter" },
        entries: [
          {
            before: {
              albumMonitored: true,
              deleteCandidates: [],
            },
          },
        ],
      },
      CASCADE_POLICY,
    );

    expect(analysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      basis: "monitored-album-file-removal",
    });
    expect(analysis.metrics.conditionalIndexerQueries.value).toBe(0);
  });

  it("round-trips through the shared artifact reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfmedia-track-filter-plan-"));
    roots.push(root);
    const path = join(root, "plan.json");
    const plan = buildPlan();

    await writeLidarrPlanArtifact(path, plan);

    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);
  });

  it("rejects resealed candidate drift and unsupported fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfmedia-track-filter-tamper-"));
    roots.push(root);
    const path = join(root, "plan.json");
    const original = buildPlan();
    const changed = structuredClone(original);
    const entries = changed.entries as unknown as Array<Record<string, unknown>>;
    const before = entries[0]?.["before"] as Record<string, unknown>;
    const candidates = before["deleteCandidates"] as Array<Record<string, unknown>>;
    candidates[0]!["extra"] = "not allowed";
    const resealed = {
      ...changed,
      payloadChecksum: computeLidarrPlanChecksum(changed),
    };
    await writeFile(path, `${JSON.stringify(resealed, null, 2)}\n`, "utf8");

    await expect(readLidarrPlanArtifact(path)).rejects.toBeInstanceOf(LidarrPlanValidationError);
  });
});
