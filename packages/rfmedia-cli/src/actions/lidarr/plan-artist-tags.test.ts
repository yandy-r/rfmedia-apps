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
const mockRunSingle = vi.hoisted(() =>
  vi.fn(async (_tier: unknown, task: { run: () => Promise<unknown> }) => ({
    value: await task.run(),
    execution: {
      taskId: "tag-plan",
      operation: "lidarr plan artist tags",
      lane: "local-only",
      outcome: "succeeded",
      attempts: 1,
    },
  })),
);
const mockGetLoadedLidarrConfig = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveClient,
  resolveRequiredLidarrOrigin: () => "https://lidarr.example.test",
}));
vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: mockGetLoadedLidarrConfig,
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { computeLidarrPlanChecksum, readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import type { LidarrArtistTagMutationPlanEntry } from "../../types/lidarr-plan.js";
import {
  executeLidarrArtistTagPlan,
  type LidarrArtistTagPlanActionOptions,
} from "./plan-artist-tags.js";

const roots: string[] = [];

const tags = [
  createLidarrTagFixture({ id: 1, label: "Rock" }),
  createLidarrTagFixture({ id: 2, label: "Live" }),
  createLidarrTagFixture({ id: 3, label: "Classic" }),
];
const artists = [
  createLidarrArtistFixture({
    id: 9,
    artistName: "Nine",
    monitored: true,
    qualityProfileId: 5,
    metadataProfileId: 2,
    tags: [1, 3],
  }),
  createLidarrArtistFixture({
    id: 2,
    artistName: "Two",
    monitored: false,
    qualityProfileId: 6,
    metadataProfileId: 2,
    tags: [3],
  }),
  createLidarrArtistFixture({
    id: 5,
    artistName: "Five",
    monitored: true,
    qualityProfileId: 5,
    metadataProfileId: 4,
    tags: [],
  }),
];

function currentClient() {
  return mockClient.current as ReturnType<typeof createLidarrClientMock>;
}

async function outputPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-tag-plan-"));
  roots.push(root);
  return join(root, "plan.json");
}

async function execute(overrides: Partial<LidarrArtistTagPlanActionOptions>) {
  return executeLidarrArtistTagPlan({
    all: true,
    addTags: ["Live"],
    output: await outputPath(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.current = createLidarrClientMock({
    listArtists: async () => [...artists],
    listTags: async () => [...tags],
    listQualityProfiles: async () => [
      createLidarrProfileFixture({ id: 5, name: "Lossless" }),
      createLidarrProfileFixture({ id: 6, name: "Any" }),
    ],
    listMetadataProfiles: async () => [
      createLidarrProfileFixture({ id: 2, name: "Standard" }),
      createLidarrProfileFixture({ id: 4, name: "Extended" }),
    ],
  });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeLidarrArtistTagPlan", () => {
  it.each([
    {
      label: "add",
      options: { addTags: ["Live"] },
      before: [1, 3],
      after: [1, 2, 3],
      added: [2],
      removed: [],
      retained: [1, 3],
      level: "low",
      destructive: false,
    },
    {
      label: "remove",
      options: { addTags: undefined, removeTags: ["Classic"] },
      before: [1, 3],
      after: [1],
      added: [],
      removed: [3],
      retained: [1],
      level: "low",
      destructive: false,
    },
    {
      label: "set",
      options: { addTags: undefined, setTags: ["Live"] },
      before: [1, 3],
      after: [2],
      added: [2],
      removed: [1, 3],
      retained: [],
      level: "high",
      destructive: true,
    },
    {
      label: "clear",
      options: { addTags: undefined, clearTags: true },
      before: [1, 3],
      after: [],
      added: [],
      removed: [1, 3],
      retained: [],
      level: "high",
      destructive: true,
    },
  ])(
    "seals normalized $label before/after state and exact deltas",
    async ({ options, before, after, added, removed, retained, level, destructive }) => {
      const result = await execute(options);
      const plan = result.plan;
      expect(plan.version).toBe("rfmedia.lidarr-plan.v3");
      expect(plan.operation.kind).toBe("artist-tag-mutation");
      expect(plan.risk).toMatchObject({ level, destructive });
      if (destructive) {
        expect(plan.risk.cascade).toContain(
          "Existing tag assignments not in the desired set are removed.",
        );
      }
      expect(plan.entries.map((entry) => entry.artistId)).toEqual([2, 5, 9]);
      const entry = plan.entries.find(
        (candidate) => candidate.artistId === 9,
      ) as LidarrArtistTagMutationPlanEntry;
      expect(entry.before.tags.map((tag) => tag.id)).toEqual(before);
      expect(entry.after.tags.map((tag) => tag.id)).toEqual(after);
      expect(entry.added.map((tag) => tag.id)).toEqual(added);
      expect(entry.removed.map((tag) => tag.id)).toEqual(removed);
      expect(entry.retained.map((tag) => tag.id)).toEqual(retained);
      expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
      await expect(readLidarrPlanArtifact(result.planPath)).resolves.toEqual(plan);
      expect(currentClient().updateArtistTags).not.toHaveBeenCalled();
      expect(currentClient().setArtistProfiles).not.toHaveBeenCalled();
      expect(currentClient().setArtistsMonitored).not.toHaveBeenCalled();
    },
  );

  it("seals unknown conditional cascade exposure from one resolved policy snapshot", async () => {
    const result = await execute({});

    expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(1);
    expect(result.plan.cascadeAnalysis.assumptions).toEqual({
      albumsPerArtist: null,
      indexerQueriesPerCandidate: null,
    });
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toEqual({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      unit: "acquisition-candidates",
      basis: "release-automation-evidence-unavailable",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toEqual({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      unit: "indexer-queries",
      basis: "acquisition-candidates-unknown",
    });
    await expect(readLidarrPlanArtifact(result.planPath)).resolves.toEqual(result.plan);
  });

  it("preserves an auditable all-no-op cohort", async () => {
    const result = await execute({
      all: undefined,
      artistIds: [9],
      addTags: ["Rock", "name:rock"],
    });

    expect(result.plan.selection).toEqual({ kind: "ids", artistIds: [9] });
    expect(result.plan.review).toEqual({ requested: 1, changed: 0, unchanged: 1 });
    expect(result.plan.summary).toEqual({
      kind: "artist-tag-mutation",
      added: 0,
      removed: 0,
      retained: 2,
    });
    expect(currentClient().updateArtistTags).not.toHaveBeenCalled();
  });

  it("selects by a tag from the planning snapshot before removing it", async () => {
    const result = await execute({
      all: undefined,
      selectTags: ["Classic"],
      addTags: undefined,
      removeTags: ["3"],
    });

    expect(result.plan.selection).toEqual({
      kind: "filters",
      tags: [{ id: 3, label: "Classic" }],
    });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([2, 9]);
    expect(
      result.plan.entries.every(
        (entry) => (entry as LidarrArtistTagMutationPlanEntry).removed[0]?.id === 3,
      ),
    ).toBe(true);
  });

  it("resolves profile and monitored filters from fresh bounded resources", async () => {
    const result = await execute({
      all: undefined,
      selectMonitored: true,
      selectQualityProfile: "Lossless",
      selectMetadataProfile: "2",
    });

    expect(result.plan.selection).toEqual({
      kind: "filters",
      monitored: true,
      qualityProfile: { id: 5, name: "Lossless" },
      metadataProfile: { id: 2, name: "Standard" },
    });
    expect(result.plan.entries.map((entry) => entry.artistId)).toEqual([9]);
    expect(currentClient().listArtists).toHaveBeenCalledTimes(1);
    expect(currentClient().listTags).toHaveBeenCalledTimes(1);
    expect(currentClient().listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(currentClient().listMetadataProfiles).toHaveBeenCalledTimes(1);
    expect(mockResolveClient).toHaveBeenCalledWith(
      { lidarrUrl: undefined, lidarrApiKey: undefined },
      { tier: "local-only", retryAttemptsOverride: 0 },
    );
  });

  it.each([
    {
      name: "unknown desired tag",
      options: { addTags: ["Missing"] },
      message: /Unknown tag reference/iu,
    },
    {
      name: "ambiguous desired tag",
      options: { addTags: ["Rock"] },
      message: /Ambiguous tag reference/iu,
      duplicateTag: true,
    },
    {
      name: "zero-match selection",
      options: { all: undefined, selectTags: ["Live"] },
      message: /matched zero artists/iu,
    },
    {
      name: "cap overflow",
      options: { maxBatch: 2 },
      message: /exceeding maxBatch 2/iu,
    },
  ])(
    "fails closed for $name without writing an artifact",
    async ({ options, message, duplicateTag }) => {
      if (duplicateTag === true) {
        currentClient().listTags.mockResolvedValue([
          ...tags,
          createLidarrTagFixture({ id: 8, label: "rock" }),
        ]);
      }
      const output = await outputPath();

      await expect(
        executeLidarrArtistTagPlan({
          all: true,
          addTags: ["Live"],
          output,
          ...options,
        }),
      ).rejects.toThrow(message);
      await expect(access(output)).rejects.toThrow();
      expect(currentClient().updateArtistTags).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "missing mode",
      options: { all: true },
      message: /exactly one tag mode/iu,
    },
    {
      name: "multiple modes",
      options: { all: true, addTags: ["Rock"], clearTags: true },
      message: /exactly one tag mode/iu,
    },
    {
      name: "empty add",
      options: { all: true, addTags: [] },
      message: /requires at least one tag/iu,
    },
  ])("rejects $name before reading Lidarr", async ({ options, message }) => {
    await expect(executeLidarrArtistTagPlan(options)).rejects.toThrow(message);
    expect(mockResolveClient).not.toHaveBeenCalled();
    expect(currentClient().listArtists).not.toHaveBeenCalled();
    expect(currentClient().listTags).not.toHaveBeenCalled();
  });

  it("fails closed when an artist references a tag absent from the fresh tag list", async () => {
    currentClient().listArtists.mockResolvedValue([
      createLidarrArtistFixture({ id: 9, artistName: "Nine", tags: [99] }),
    ]);

    await expect(execute({})).rejects.toBeInstanceOf(LidarrPlanValidationError);
    expect(currentClient().updateArtistTags).not.toHaveBeenCalled();
  });
});
