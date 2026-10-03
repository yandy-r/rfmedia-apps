import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import { createLidarrArtistFixture } from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "plan",
      operation: "lidarr plan artist monitoring",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: () => mockClient.current,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { setLoadedConfig } from "../../lib/loaded-config.js";
import { readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import { LIDARR_PLAN_VERSION_V3 } from "../../types/lidarr-plan.js";
import { executeLidarrPlan } from "./plan.js";

const roots: string[] = [];

afterEach(async () => {
  setLoadedConfig({});
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
  setLoadedConfig({
    lidarr: {
      cascadeAnalysis: {
        assumptions: {
          albumsPerArtist: 4,
          indexerQueriesPerCandidate: 2,
        },
        budgets: {
          indexerQueries: 8,
          acquisitionCandidates: 4,
        },
      },
    },
  });
  mockClient.current = createLidarrClientMock({
    listArtists: async () => [
      createLidarrArtistFixture({ id: 3, artistName: "Three", monitored: true }),
      createLidarrArtistFixture({ id: 8, artistName: "Eight", monitored: false }),
    ],
  });
});

describe("executeLidarrPlan", () => {
  it("writes a sealed plan for exact artist IDs without mutating Lidarr", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfmedia-plan-action-"));
    roots.push(root);
    const output = join(root, "plan.json");

    const client = mockClient.current as ReturnType<typeof createLidarrClientMock>;
    const result = await executeLidarrPlan({
      artistIds: [8, 3],
      monitored: false,
      output,
    });

    expect(result.planPath).toBe(output);
    expect(result.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(result.plan.selection).toEqual({ kind: "ids", artistIds: [3, 8] });
    expect(result.plan.operation).toEqual({
      kind: "artist-monitoring",
      desiredMonitored: false,
    });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([3, 8]);
    expect(result.plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(result.plan.summary).toEqual({
      kind: "artist-monitoring",
      monitoredBefore: 1,
      monitoredAfter: 0,
    });
    expect(result.plan.risk).toEqual({
      level: "low",
      destructive: false,
      cascade: [
        "Existing files remain unchanged.",
        "Existing download-queue items are not cancelled.",
        "No artist or album search is triggered.",
      ],
    });
    expect(result.plan.cascadeAnalysis.assumptions).toEqual({
      albumsPerArtist: 4,
      indexerQueriesPerCandidate: 2,
    });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      basis: "operation-removes-acquisition-scope",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toMatchObject({
      value: 0,
      certainty: "exact",
    });
    expect(result.plan.cascadeAnalysis.metrics.newlyMonitored.value).toBe(0);
    await expect(readLidarrPlanArtifact(output)).resolves.toEqual(result.plan);
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
    expect(client.setArtistProfiles).not.toHaveBeenCalled();
    expect(client.updateArtistTags).not.toHaveBeenCalled();
  });

  it("models only changed artists monitored by the plan and preserves written-plan parity", async () => {
    const root = await mkdtemp(join(tmpdir(), "rfmedia-plan-action-"));
    roots.push(root);
    const output = join(root, "monitored-plan.json");

    const result = await executeLidarrPlan({
      artistIds: [8, 3],
      monitored: true,
      output,
    });

    expect(result.plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(result.plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(result.plan.cascadeAnalysis.metrics.newlyMonitored).toMatchObject({
      value: 1,
      certainty: "exact",
      unit: "artists",
    });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 4,
      certainty: "modelled",
      horizon: "conditional",
      basis: "configured-albums-per-artist",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toMatchObject({
      value: 8,
      certainty: "modelled",
      horizon: "conditional",
    });
    expect(result.plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "within", limit: 8, projected: 8 },
      acquisitionCandidates: { status: "within", limit: 4, projected: 4 },
    });
    expect(await readLidarrPlanArtifact(output)).toEqual(result.plan);
  });

  it("fails closed when an exact artist ID does not exist", async () => {
    await expect(executeLidarrPlan({ artistIds: [3, 99], monitored: true })).rejects.toBeInstanceOf(
      LidarrPlanValidationError,
    );
  });
});
