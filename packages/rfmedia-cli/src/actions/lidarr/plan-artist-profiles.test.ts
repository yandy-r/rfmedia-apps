import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrArtistFixture,
  createLidarrProfileFixture,
  createLidarrTagFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockResolveClient = vi.hoisted(() => vi.fn(() => mockClient.current));
const mockLoadedLidarrConfig = vi.hoisted(() =>
  vi.fn(() => ({
    cascadeAnalysis: {
      budgets: {
        indexerQueries: 20,
        acquisitionCandidates: 10,
      },
      assumptions: {
        indexerQueriesPerCandidate: 2,
      },
    },
  })),
);
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "profile-plan",
      operation: "lidarr plan artist profiles",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveClient,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));

vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: mockLoadedLidarrConfig,
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import { executeLidarrArtistProfilePlan } from "./plan-artist-profiles.js";

const roots: string[] = [];

const qualityProfiles = [
  createLidarrProfileFixture({ id: 1, name: "Standard" }),
  createLidarrProfileFixture({ id: 5, name: "Lossless" }),
];
const metadataProfiles = [
  createLidarrProfileFixture({ id: 2, name: "Standard Metadata" }),
  createLidarrProfileFixture({ id: 7, name: "Complete Metadata" }),
];
const tags = [
  createLidarrTagFixture({ id: 4, label: "Favorite" }),
  createLidarrTagFixture({ id: 8, label: "Curated" }),
];
const artists = [
  createLidarrArtistFixture({
    id: 9,
    artistName: "Alpha",
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 2,
    tags: [4],
  }),
  createLidarrArtistFixture({
    id: 3,
    artistName: "Beta",
    monitored: false,
    qualityProfileId: 5,
    metadataProfileId: 7,
    tags: [4, 8],
  }),
  createLidarrArtistFixture({
    id: 12,
    artistName: "Gamma",
    monitored: true,
    qualityProfileId: 5,
    metadataProfileId: 2,
    tags: [4],
  }),
];

function createDefaultClient() {
  return createLidarrClientMock({
    listArtists: () => Promise.resolve(artists),
    listQualityProfiles: () => Promise.resolve(qualityProfiles),
    listMetadataProfiles: () => Promise.resolve(metadataProfiles),
    listTags: () => Promise.resolve(tags),
  });
}

async function makeOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-profile-plan-"));
  roots.push(root);
  return join(root, "plan.json");
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.current = createDefaultClient();
});

describe("executeLidarrArtistProfilePlan", () => {
  it("writes a sealed combined profile plan in deterministic artist order", async () => {
    const output = await makeOutput();
    const client = mockClient.current as ReturnType<typeof createLidarrClientMock>;

    const result = await executeLidarrArtistProfilePlan({
      all: true,
      qualityProfile: "Lossless",
      metadataProfile: "7",
      output,
    });

    expect(result.planPath).toBe(output);
    expect(result.plan.version).toBe("rfmedia.lidarr-plan.v3");
    expect(result.plan.operation).toEqual({
      kind: "artist-profile-assignment",
      qualityProfile: { id: 5, name: "Lossless" },
      metadataProfile: { id: 7, name: "Complete Metadata" },
    });
    if (result.plan.operation.kind !== "artist-profile-assignment") {
      throw new Error("expected an artist profile plan");
    }
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([3, 9, 12]);
    expect(result.plan.entries[0]).toMatchObject({
      artistId: 3,
      before: {
        qualityProfile: { id: 5, name: "Lossless" },
        metadataProfile: { id: 7, name: "Complete Metadata" },
      },
      after: {
        qualityProfile: { id: 5, name: "Lossless" },
        metadataProfile: { id: 7, name: "Complete Metadata" },
      },
    });
    expect(result.plan.review).toEqual({ requested: 3, changed: 2, unchanged: 1 });
    expect(result.plan.summary).toEqual({
      kind: "artist-profile-assignment",
      qualityProfileChanged: 1,
      metadataProfileChanged: 2,
    });
    expect(result.plan.risk).toMatchObject({ level: "medium", destructive: false });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "release-automation-evidence-unavailable",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "acquisition-candidates-unknown",
    });
    expect(result.plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "unknown", limit: 20, projected: null },
      acquisitionCandidates: { status: "unknown", limit: 10, projected: null },
    });
    const persisted = await readLidarrPlanArtifact(output);
    expect(persisted).toEqual(result.plan);
    expect(persisted.version).toBe("rfmedia.lidarr-plan.v3");
    if (persisted.version !== "rfmedia.lidarr-plan.v3") {
      throw new Error("expected a version 3 profile plan");
    }
    expect(persisted.cascadeAnalysis).toEqual(result.plan.cascadeAnalysis);
    expect(mockLoadedLidarrConfig).toHaveBeenCalledTimes(1);
    expect(client.listArtists).toHaveBeenCalledTimes(1);
    expect(client.listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(client.listMetadataProfiles).toHaveBeenCalledTimes(1);
    expect(client.listTags).not.toHaveBeenCalled();
    expect(client.setArtistProfiles).not.toHaveBeenCalled();
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
    expect(client.updateArtistTags).not.toHaveBeenCalled();
  });

  it("captures only the managed profile dimension and preserves partial no-op evidence", async () => {
    const output = await makeOutput();

    const result = await executeLidarrArtistProfilePlan({
      artistIds: [9, 3],
      qualityProfile: "5",
      output,
    });

    if (result.plan.operation.kind !== "artist-profile-assignment") {
      throw new Error("expected an artist profile plan");
    }
    expect(result.plan.selection).toEqual({ kind: "ids", artistIds: [3, 9] });
    expect(result.plan.entries).toHaveLength(2);
    expect(result.plan.entries[0]?.before).toEqual({
      qualityProfile: { id: 5, name: "Lossless" },
    });
    expect(result.plan.entries[0]?.after).toEqual({
      qualityProfile: { id: 5, name: "Lossless" },
    });
    expect(result.plan.entries[1]?.before).toEqual({
      qualityProfile: { id: 1, name: "Standard" },
    });
    expect(result.plan.entries[1]?.after).toEqual({
      qualityProfile: { id: 5, name: "Lossless" },
    });
    expect(result.plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(result.plan.summary).toEqual({
      kind: "artist-profile-assignment",
      qualityProfileChanged: 1,
      metadataProfileChanged: 0,
    });
  });

  it("writes an auditable non-empty all-no-op cohort", async () => {
    const output = await makeOutput();

    const result = await executeLidarrArtistProfilePlan({
      artistIds: [3],
      qualityProfile: "Lossless",
      metadataProfile: "Complete Metadata",
      output,
    });

    expect(result.plan.entries).toHaveLength(1);
    expect(result.plan.review).toEqual({ requested: 1, changed: 0, unchanged: 1 });
    await expect(readLidarrPlanArtifact(output)).resolves.toEqual(result.plan);
  });

  it("resolves AND/all-of selection references and records canonical filters", async () => {
    const output = await makeOutput();
    const client = mockClient.current as ReturnType<typeof createLidarrClientMock>;

    const result = await executeLidarrArtistProfilePlan({
      selectMonitored: true,
      selectQualityProfile: "lossless",
      selectTags: ["4", "name:Favorite"],
      metadataProfile: "Complete Metadata",
      output,
    });

    expect(result.plan.selection).toEqual({
      kind: "filters",
      monitored: true,
      qualityProfile: { id: 5, name: "Lossless" },
      tags: [{ id: 4, label: "Favorite" }],
    });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([12]);
    expect(client.listArtists).toHaveBeenCalledTimes(1);
    expect(client.listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(client.listMetadataProfiles).toHaveBeenCalledTimes(1);
    expect(client.listTags).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh no-retry local-only client and fetches only required resources", async () => {
    const output = await makeOutput();
    const client = mockClient.current as ReturnType<typeof createLidarrClientMock>;

    await executeLidarrArtistProfilePlan({
      all: true,
      qualityProfile: "5",
      output,
    });

    expect(mockRunSingle).toHaveBeenCalledWith(
      "local-only",
      expect.objectContaining({
        id: "lidarr-plan-artist-profiles",
        operation: "lidarr plan artist profiles",
        idempotent: true,
      }),
    );
    expect(mockResolveClient).toHaveBeenCalledWith(
      expect.objectContaining({ lidarrUrl: undefined, lidarrApiKey: undefined }),
      { tier: "local-only", retryAttemptsOverride: 0 },
    );
    expect(client.listArtists).toHaveBeenCalledTimes(1);
    expect(client.listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(client.listMetadataProfiles).not.toHaveBeenCalled();
    expect(client.listTags).not.toHaveBeenCalled();
  });

  it("rejects a missing desired profile before any network read or artifact write", async () => {
    const output = await makeOutput();
    const client = mockClient.current as ReturnType<typeof createLidarrClientMock>;

    await expect(executeLidarrArtistProfilePlan({ all: true, output })).rejects.toBeInstanceOf(
      LidarrPlanValidationError,
    );

    expect(client.listArtists).not.toHaveBeenCalled();
    expect(mockRunSingle).not.toHaveBeenCalled();
    await expectMissing(output);
  });

  it.each([
    {
      name: "duplicate artist IDs",
      options: { artistIds: [3, 3], qualityProfile: "5" } as const,
      message: /duplicate artist id/iu,
    },
    {
      name: "unknown artist IDs",
      options: { artistIds: [3, 99], qualityProfile: "5" } as const,
      message: /unknown artist ids/iu,
    },
    {
      name: "cap overflow",
      options: { all: true, maxBatch: 2, qualityProfile: "5" } as const,
      message: /exceeding maxbatch 2/iu,
    },
  ])("does not write an artifact for $name", async ({ options, message }) => {
    const output = await makeOutput();

    await expect(executeLidarrArtistProfilePlan({ ...options, output })).rejects.toThrow(message);

    await expectMissing(output);
  });

  it("does not write an artifact when filters match zero artists", async () => {
    const output = await makeOutput();

    await expect(
      executeLidarrArtistProfilePlan({
        selectQualityProfile: "Standard",
        selectUnmonitored: true,
        qualityProfile: "Lossless",
        output,
      }),
    ).rejects.toThrow(/matched zero artists/iu);

    await expectMissing(output);
  });

  it("does not write an artifact for unknown or ambiguous profile resources", async () => {
    const unknownOutput = await makeOutput();
    await expect(
      executeLidarrArtistProfilePlan({
        all: true,
        qualityProfile: "404",
        output: unknownOutput,
      }),
    ).rejects.toThrow(/unknown profile reference/iu);
    await expectMissing(unknownOutput);

    const ambiguousOutput = await makeOutput();
    mockClient.current = createLidarrClientMock({
      listArtists: () => Promise.resolve(artists),
      listQualityProfiles: () =>
        Promise.resolve([
          createLidarrProfileFixture({ id: 1, name: "Lossless" }),
          createLidarrProfileFixture({ id: 5, name: "lossless" }),
        ]),
    });
    await expect(
      executeLidarrArtistProfilePlan({
        all: true,
        qualityProfile: "Lossless",
        output: ambiguousOutput,
      }),
    ).rejects.toThrow(/ambiguous profile reference/iu);
    await expectMissing(ambiguousOutput);
  });

  it("fails before writing when a selected artist references an unknown current profile", async () => {
    const output = await makeOutput();
    mockClient.current = createLidarrClientMock({
      listArtists: () =>
        Promise.resolve([
          createLidarrArtistFixture({
            id: 21,
            artistName: "Orphaned",
            qualityProfileId: 999,
          }),
        ]),
      listQualityProfiles: () => Promise.resolve(qualityProfiles),
    });

    await expect(
      executeLidarrArtistProfilePlan({
        all: true,
        qualityProfile: "5",
        output,
      }),
    ).rejects.toThrow(/unknown profile reference "999"/iu);

    await expectMissing(output);
  });
});
