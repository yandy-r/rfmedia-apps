import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
  createLidarrProfileFixture,
  createLidarrTagFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockResolveRequiredLidarrOrigin = vi.hoisted(() =>
  vi.fn(() => "https://lidarr.example.test"),
);
const mockMetadataPreflight = vi.hoisted(() => vi.fn(async () => undefined));
const mockScanTrigger = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, message: "Scan triggered" })),
);
const mockResolveOptionalScanAdapter = vi.hoisted(() =>
  vi.fn(() => ({
    adapter: {
      capabilities: { scan: true },
      scan: { trigger: mockScanTrigger },
    },
  })),
);
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (
      tier: unknown,
      task: {
        operation?: string;
        run: (context: { attempt: number; signal?: AbortSignal }) => Promise<unknown>;
      },
      options?: {
        preflight?: (input: { lane: unknown; signal?: AbortSignal }) => Promise<void>;
        signal?: AbortSignal;
      },
    ) => {
      await options?.preflight?.({ lane: tier, signal: options.signal });
      return {
        value: await task.run({ attempt: 1, signal: options?.signal }),
        execution: {
          taskId: "apply",
          operation: task.operation ?? "lidarr apply",
          lane: tier,
          outcome: "succeeded",
          attempts: 1,
        },
      };
    },
  ),
);
const mockSignalHandler = vi.hoisted(() => {
  let controller = new AbortController();
  const handlers = new Map<
    string,
    { readonly name: string; readonly cleanup: () => Promise<void> | void }
  >();
  return {
    getGlobalSignal: vi.fn(() => controller.signal),
    registerGlobalCleanup: vi.fn(
      (handler: { readonly name: string; readonly cleanup: () => Promise<void> | void }) => {
        handlers.set(handler.name, handler);
      },
    ),
    unregisterGlobalCleanup: vi.fn((name: string) => {
      handlers.delete(name);
    }),
    reset: () => {
      controller = new AbortController();
      handlers.clear();
    },
  };
});

vi.mock("../../lib/lidarr/index.js", () => ({
  LIDARR_ALBUM_IDS_CHUNK_SIZE: 100,
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: () => mockClient.current,
  resolveRequiredLidarrExecutionContext: () => ({
    client: mockClient.current,
    preflight: mockMetadataPreflight,
  }),
  resolveRequiredLidarrOrigin: mockResolveRequiredLidarrOrigin,
}));

vi.mock("../../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
}));

vi.mock("../../lib/signal-handler.js", () => ({
  getGlobalSignal: mockSignalHandler.getGlobalSignal,
  registerGlobalCleanup: mockSignalHandler.registerGlobalCleanup,
  unregisterGlobalCleanup: mockSignalHandler.unregisterGlobalCleanup,
}));

import { closeDatabase, initializeDatabase } from "../../lib/db.js";
import { LidarrPlanStaleError, LidarrPlanValidationError } from "../../lib/errors.js";
import { listDeferredIntents } from "../../lib/lidarr/deferred-queue.js";
import {
  classifyLidarrStatus,
  LidarrError,
  LidarrNotFoundError,
  LidarrUnreachableError,
  LidarrValidationError,
} from "../../lib/lidarr/errors.js";
import { buildLidarrAlbumMutationPlanV2 } from "../../lib/lidarr/plan-album-operations.js";
import {
  buildLidarrTrackFilterPlanV2,
  buildLidarrTrackFilterPlanV3,
} from "../../lib/lidarr/plan-track-filter-operations.js";
import {
  buildLidarrMutationPlan,
  buildLidarrMutationPlanV2,
  buildLidarrMutationPlanV3,
  buildLidarrArtistAddPlanV2,
  buildLidarrArtistAddPlanV3,
  appendLidarrPlanHistory,
  readLidarrPlanHistory,
  type LidarrStoredMutationPlan,
  writeLidarrPlanArtifact,
} from "../../lib/lidarr/plan-engine.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import type { LidarrCascadePolicy, LidarrPlanSelectionV2 } from "../../types/lidarr-plan.js";
import {
  LIDARR_APPLY_RECONCILIATION_ATTEMPTS,
  LIDARR_APPLY_RECONCILIATION_DELAY_MS,
  executeLidarrApply,
} from "./apply.js";

const roots: string[] = [];
const CASCADE_POLICY: LidarrCascadePolicy = {
  assumptions: {
    albumsPerArtist: 2,
    indexerQueriesPerCandidate: 3,
  },
  budgets: {
    indexerQueries: 5,
    acquisitionCandidates: 1,
  },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  mockSignalHandler.reset();
  vi.clearAllMocks();
});

async function writeFixture<TPlan extends LidarrStoredMutationPlan>(plan: TPlan) {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-apply-action-"));
  roots.push(root);
  const planPath = join(root, "plan.json");
  const historyPath = join(root, "history.jsonl");
  await writeLidarrPlanArtifact(planPath, plan);
  return { root, plan, planPath, historyPath };
}

async function artistAddFixture() {
  return writeFixture(
    buildLidarrArtistAddPlanV2(
      {
        origin: "https://lidarr.example.test",
        operation: {
          kind: "artist-add",
          rootFolder: { id: 3, path: "/music" },
          qualityProfile: { id: 5, name: "Lossless" },
          metadataProfile: { id: 7, name: "Standard" },
          monitored: false,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
        },
        entry: {
          artistName: "Exact Artist",
          foreignArtistId: "11111111-1111-4111-8111-111111111111",
          provenance: {
            source: "lastfm",
            method: "artist.getSimilar",
            seedArtist: "Seed Artist",
            similarity: 0.94,
            candidateUrl: "https://www.last.fm/music/Exact+Artist",
            discoveredAt: "2026-07-25T11:59:00.000Z",
          },
        },
      },
      { randomUUID: () => "66666666-6666-4666-8666-666666666666" },
    ),
  );
}

async function artistAddV3Fixture() {
  return writeFixture(
    buildLidarrArtistAddPlanV3(
      {
        origin: "https://lidarr.example.test",
        operation: {
          kind: "artist-add",
          rootFolder: { id: 3, path: "/music" },
          qualityProfile: { id: 5, name: "Lossless" },
          metadataProfile: { id: 7, name: "Standard" },
          monitored: false,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
        },
        entry: {
          artistName: "Exact Artist",
          foreignArtistId: "11111111-1111-4111-8111-111111111111",
          provenance: {
            source: "lastfm",
            method: "artist.getSimilar",
            seedArtist: "Seed Artist",
            similarity: 0.94,
            candidateUrl: "https://www.last.fm/music/Exact+Artist",
            discoveredAt: "2026-07-25T11:59:00.000Z",
          },
        },
        cascadePolicy: CASCADE_POLICY,
      },
      { randomUUID: () => "99999999-9999-4999-8999-999999999999" },
    ),
  );
}

async function multiArtistAddFixture(
  includeThird = false,
  postAddUnmonitorSelectors?: readonly string[],
) {
  return writeFixture(
    buildLidarrArtistAddPlanV2(
      {
        origin: "https://lidarr.example.test",
        operation: {
          kind: "artist-add",
          rootFolder: { id: 3, path: "/music" },
          qualityProfile: { id: 5, name: "Lossless" },
          metadataProfile: { id: 7, name: "Standard" },
          monitored: false,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
          ...(postAddUnmonitorSelectors === undefined ? {} : { postAddUnmonitorSelectors }),
        },
        entries: [
          {
            artistName: "Exact Artist",
            foreignArtistId: "11111111-1111-4111-8111-111111111111",
            provenance: {
              source: "lastfm",
              method: "artist.getSimilar",
              seedArtist: "Seed Artist",
              similarity: 0.94,
              candidateUrl: "https://www.last.fm/music/Exact+Artist",
              discoveredAt: "2026-07-25T11:59:00.000Z",
              selectedRank: 1,
              parentArtist: "Seed Artist",
              depth: 1,
              providerRank: 1,
              firstSeenSequence: 1,
              firstPath: ["Seed Artist", "Exact Artist"],
              adjustedScore: 0.94,
              exposureCount: 1,
            },
          },
          {
            artistName: "Second Artist",
            foreignArtistId: "22222222-2222-4222-8222-222222222222",
            provenance: {
              source: "lastfm",
              method: "artist.getSimilar",
              seedArtist: "Seed Artist",
              similarity: 0.89,
              candidateUrl: "https://www.last.fm/music/Second+Artist",
              discoveredAt: "2026-07-25T11:59:00.000Z",
              selectedRank: 2,
              parentArtist: "Seed Artist",
              depth: 1,
              providerRank: 2,
              firstSeenSequence: 2,
              firstPath: ["Seed Artist", "Second Artist"],
              adjustedScore: 0.89,
              exposureCount: 1,
            },
          },
          ...(includeThird
            ? [
                {
                  artistName: "Third Artist",
                  foreignArtistId: "33333333-3333-4333-8333-333333333333",
                  provenance: {
                    source: "lastfm" as const,
                    method: "artist.getSimilar" as const,
                    seedArtist: "Seed Artist",
                    similarity: 0.84,
                    candidateUrl: "https://www.last.fm/music/Third+Artist",
                    discoveredAt: "2026-07-25T11:59:00.000Z",
                    selectedRank: 3,
                    parentArtist: "Seed Artist",
                    depth: 1,
                    providerRank: 3,
                    firstSeenSequence: 3,
                    firstPath: ["Seed Artist", "Third Artist"],
                    adjustedScore: 0.84,
                    exposureCount: 1,
                  },
                },
              ]
            : []),
        ],
      },
      { randomUUID: () => "77777777-7777-4777-8777-777777777777" },
    ),
  );
}

async function monitoringFixture(
  additionalEntries: readonly {
    readonly artistId: number;
    readonly artistName: string;
    readonly monitored: boolean;
  }[] = [],
) {
  return writeFixture(
    buildLidarrMutationPlan(
      {
        origin: "https://lidarr.example.test",
        operation: { kind: "artist-monitoring", desiredMonitored: false },
        maxBatch: 25,
        entries: [{ artistId: 3, artistName: "Three", monitored: true }, ...additionalEntries],
      },
      { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    ),
  );
}

async function monitoringV3Fixture() {
  return writeFixture(
    buildLidarrMutationPlanV3(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "ids", artistIds: [3] },
        operation: { kind: "artist-monitoring", desiredMonitored: true },
        maxBatch: 25,
        entries: [
          {
            kind: "artist-monitoring",
            artistId: 3,
            artistName: "Three",
            monitored: false,
          },
        ],
        cascadePolicy: CASCADE_POLICY,
      },
      { randomUUID: () => "88888888-8888-4888-8888-888888888888" },
    ),
  );
}

async function profileFixture(selection: LidarrPlanSelectionV2 = { kind: "ids", artistIds: [3] }) {
  return writeFixture(
    buildLidarrMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection,
        operation: {
          kind: "artist-profile-assignment",
          qualityProfile: { id: 5, name: "Lossless" },
          metadataProfile: { id: 7, name: "Extended" },
        },
        maxBatch: 25,
        entries: [
          {
            kind: "artist-profile-assignment",
            artistId: 3,
            artistName: "Three",
            qualityProfile: { id: 1, name: "Standard" },
            metadataProfile: { id: 2, name: "Default" },
          },
        ],
      },
      { randomUUID: () => "22222222-2222-4222-8222-222222222222" },
    ),
  );
}

async function tagFixture(mode: "add" | "remove" | "set" | "clear" = "add") {
  const requested = mode === "clear" ? [] : [{ id: 8, label: "Managed" }];
  return writeFixture(
    buildLidarrMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "ids", artistIds: [3] },
        operation: { kind: "artist-tag-mutation", mode, tags: requested },
        maxBatch: 25,
        entries: [
          {
            kind: "artist-tag-mutation",
            artistId: 3,
            artistName: "Three",
            tags: [{ id: 4, label: "Keep" }],
          },
        ],
      },
      { randomUUID: () => "33333333-3333-4333-8333-333333333333" },
    ),
  );
}

async function artistDeleteFixture(
  deleteFiles: boolean,
  entries: readonly {
    readonly artistId: number;
    readonly artistName: string;
    readonly path: string;
    readonly albumCount: number;
    readonly trackFileCount: number;
    readonly sizeOnDisk: number;
  }[] = [
    {
      artistId: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    },
  ],
) {
  return writeFixture(
    buildLidarrMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "ids", artistIds: entries.map((entry) => entry.artistId) },
        operation: { kind: "artist-delete", deleteFiles },
        maxBatch: 25,
        entries: entries.map((entry) => ({ kind: "artist-delete" as const, ...entry })),
      },
      { randomUUID: () => "55555555-5555-4555-8555-555555555555" },
    ),
  );
}

async function artistDeleteV3Fixture(
  deleteFiles: boolean,
  entries: readonly {
    readonly artistId: number;
    readonly artistName: string;
    readonly path: string;
    readonly albumCount: number;
    readonly trackFileCount: number;
    readonly sizeOnDisk: number;
  }[] = [
    {
      artistId: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    },
  ],
) {
  return writeFixture(
    buildLidarrMutationPlanV3(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "ids", artistIds: entries.map((entry) => entry.artistId) },
        operation: { kind: "artist-delete", deleteFiles },
        maxBatch: 25,
        entries: entries.map((entry) => ({ kind: "artist-delete" as const, ...entry })),
        cascadePolicy: CASCADE_POLICY,
      },
      { randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ),
  );
}

function deletionArtist(input: {
  readonly id: number;
  readonly artistName: string;
  readonly path: string;
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly sizeOnDisk: number;
}): LidarrArtist {
  return createLidarrArtistFixture({
    id: input.id,
    artistName: input.artistName,
    path: input.path,
    statistics: {
      albumCount: input.albumCount,
      trackCount: input.trackFileCount,
      trackFileCount: input.trackFileCount,
      sizeOnDisk: input.sizeOnDisk,
    },
  });
}

async function selectorOnlyFixture(
  selection: Extract<LidarrPlanSelectionV2, { readonly kind: "filters" }>,
) {
  return writeFixture(
    buildLidarrMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection,
        operation: { kind: "artist-monitoring", desiredMonitored: false },
        maxBatch: 25,
        entries: [
          {
            kind: "artist-monitoring",
            artistId: 3,
            artistName: "Three",
            monitored: true,
          },
        ],
      },
      { randomUUID: () => "44444444-4444-4444-8444-444444444444" },
    ),
  );
}

function createStatefulClient(
  initialArtists: readonly LidarrArtist[],
  resources: {
    readonly qualityProfiles?: readonly ReturnType<typeof createLidarrProfileFixture>[];
    readonly metadataProfiles?: readonly ReturnType<typeof createLidarrProfileFixture>[];
    readonly tags?: readonly ReturnType<typeof createLidarrTagFixture>[];
  } = {},
) {
  const artists = new Map(initialArtists.map((artist) => [artist.id, artist]));
  const client = createLidarrClientMock({
    listArtists: async () => [...artists.values()],
    getArtist: async (artistId) => {
      const artist = artists.get(artistId);
      if (artist === undefined) {
        throw new LidarrValidationError(
          "lidarr get artist",
          "Artist not found",
          "invalid-response",
        );
      }
      return artist;
    },
    listQualityProfiles: async () => resources.qualityProfiles ?? [],
    listMetadataProfiles: async () => resources.metadataProfiles ?? [],
    listTags: async () => resources.tags ?? [],
    setArtistsMonitored: async ([artistId], monitored) => {
      const artist = artists.get(artistId ?? -1);
      if (artist !== undefined) artists.set(artist.id, { ...artist, monitored });
    },
    setArtistProfiles: async (artistId, assignment) => {
      const artist = artists.get(artistId);
      if (artist !== undefined) {
        artists.set(artistId, {
          ...artist,
          ...(assignment.qualityProfileId === undefined
            ? {}
            : { qualityProfileId: assignment.qualityProfileId }),
          ...(assignment.metadataProfileId === undefined
            ? {}
            : { metadataProfileId: assignment.metadataProfileId }),
        });
      }
    },
    updateArtistTags: async (artistId, mutation) => {
      const artist = artists.get(artistId);
      if (artist === undefined) return;
      const current = new Set(artist.tags);
      if (mutation.mode === "add") mutation.tagIds.forEach((id) => current.add(id));
      if (mutation.mode === "remove") mutation.tagIds.forEach((id) => current.delete(id));
      const tags =
        mutation.mode === "set" || mutation.mode === "clear"
          ? [...mutation.tagIds]
          : [...current].sort((left, right) => left - right);
      artists.set(artistId, { ...artist, tags });
    },
  });
  return { client, artists };
}

function applyOptions(files: {
  readonly root: string;
  readonly planPath: string;
  readonly historyPath: string;
}) {
  return {
    planPath: files.planPath,
    historyPath: files.historyPath,
    claimDirectory: join(files.root, "claims"),
    databasePath: join(files.root, "tracking.db"),
    dryRun: false,
    approved: true,
  } as const;
}

function artistAddResources() {
  return {
    listRootFolders: async () => [
      { id: 3, path: "/music", accessible: true, freeSpace: 1_000_000 },
    ],
    listQualityProfiles: async () => [createLidarrProfileFixture({ id: 5, name: "Lossless" })],
    listMetadataProfiles: async () => [createLidarrProfileFixture({ id: 7, name: "Standard" })],
  };
}

function desiredAddedArtist(
  input: {
    readonly id?: number;
    readonly artistName?: string;
    readonly foreignArtistId?: string;
  } = {},
) {
  return createLidarrArtistFixture({
    id: input.id ?? 42,
    artistName: input.artistName ?? "Exact Artist",
    foreignArtistId: input.foreignArtistId ?? "11111111-1111-4111-8111-111111111111",
    monitored: false,
    monitorNewItems: "none",
    qualityProfileId: 5,
    metadataProfileId: 7,
    path: `/music/${input.artistName ?? "Exact Artist"}`,
  });
}

describe("executeLidarrApply", () => {
  it("records an exact existing artist-add target as satisfied without POST", async () => {
    const files = await artistAddFixture();
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async () => desiredAddedArtist(),
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.cascadeAnalysis).toEqual({ status: "not-recorded" });
    expect(result.entries).toMatchObject([
      {
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
        lidarrId: 42,
        outcome: "satisfied",
      },
    ]);
    expect(client.addArtist).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([
      {
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
        outcome: "satisfied",
      },
    ]);
  });

  it("copies sealed v3 analysis through the specialized artist-add result", async () => {
    const files = await artistAddV3Fixture();
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async () => desiredAddedArtist(),
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.cascadeAnalysis).toEqual({
      status: "recorded",
      analysis: files.plan.cascadeAnalysis,
    });
    expect(result).toMatchObject({
      status: "completed",
      entries: [{ outcome: "satisfied" }],
    });
    expect(client.addArtist).not.toHaveBeenCalled();
  });

  it("blocks artist-add resource drift before claim or POST", async () => {
    const files = await artistAddFixture();
    const client = createLidarrClientMock({
      ...artistAddResources(),
      listRootFolders: async () => [
        { id: 3, path: "/renamed-music", accessible: true, freeSpace: 1_000_000 },
      ],
    });
    mockClient.current = client;

    await expect(executeLidarrApply(applyOptions(files))).rejects.toThrow(
      /artist-add plan is stale.*root-folder/iu,
    );
    expect(client.getArtistByForeignId).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
    await expect(access(join(files.root, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a lost artist-create response and leaves no deferred work", async () => {
    const files = await artistAddFixture();
    const client = createLidarrClientMock({
      ...artistAddResources(),
    });
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredAddedArtist());
    client.addArtist.mockRejectedValueOnce(new Error("connection closed after request"));
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([{ outcome: "succeeded", lidarrId: 42 }]);
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(mockMetadataPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "metadata-dependent" }),
    );
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([
      {
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
        outcome: "succeeded",
      },
    ]);
    const database = await initializeDatabase(join(files.root, "tracking.db"));
    expect(listDeferredIntents(database)).toEqual([]);
    closeDatabase(database);
  });

  it("keeps absent ambiguous artist creation uncertain and never resends on resume", async () => {
    const files = await artistAddFixture();
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async () => undefined,
    });
    mockClient.current = client;

    const first = await executeLidarrApply(applyOptions(files));
    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
    });

    expect(first.entries).toMatchObject([
      { outcome: "uncertain", errorCode: "verification-inconclusive" },
    ]);
    expect(resumed.entries).toMatchObject([
      { outcome: "uncertain", errorCode: "verification-inconclusive" },
    ]);
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it.each([
    ["v2", artistAddFixture],
    ["v3", artistAddV3Fixture],
  ] as const)(
    "reconciles possible %s artist-add dispatch before stale resource admission",
    async (_version, fixture) => {
      const files = await fixture();
      const entry = files.plan.entries[0];
      await appendLidarrPlanHistory(
        {
          planId: files.plan.id,
          planChecksum: files.plan.payloadChecksum,
          entryId: entry.id,
          foreignArtistId: entry.foreignArtistId,
          recordedAt: "2026-07-26T01:00:00.000Z",
          outcome: "possibly-dispatched",
          idempotencyKey: entry.idempotencyKey,
        },
        files.historyPath,
      );
      const client = createLidarrClientMock({
        ...artistAddResources(),
        listRootFolders: async () => [
          { id: 3, path: "/renamed-music", accessible: false, freeSpace: 0 },
        ],
        getArtistByForeignId: async () => desiredAddedArtist(),
      });
      mockClient.current = client;

      const result = await executeLidarrApply({
        ...applyOptions(files),
        resume: true,
      });

      expect(result.entries).toMatchObject([{ outcome: "satisfied", lidarrId: 42 }]);
      expect(client.listRootFolders).not.toHaveBeenCalled();
      expect(client.addArtist).not.toHaveBeenCalled();
    },
  );

  it("keeps an unreadable possible-dispatch resume durable and uncertain", async () => {
    const files = await artistAddFixture();
    const entry = files.plan.entries[0];
    await appendLidarrPlanHistory(
      {
        planId: files.plan.id,
        planChecksum: files.plan.payloadChecksum,
        entryId: entry.id,
        foreignArtistId: entry.foreignArtistId,
        recordedAt: "2026-07-26T01:00:00.000Z",
        outcome: "possibly-dispatched",
        idempotencyKey: entry.idempotencyKey,
      },
      files.historyPath,
    );
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async () => {
        throw new Error("exact read unavailable");
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
    });

    expect(result.entries).toMatchObject([
      {
        outcome: "uncertain",
        errorCode: "verification-inconclusive",
        failure: { stage: "resume", dispatchState: "dispatch-unknown" },
      },
    ]);
    expect(client.listRootFolders).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
  });

  it("applies two artist-add entries successfully in sealed order", async () => {
    const files = await multiArtistAddFixture();
    const artists = new Map<string, LidarrArtist>();
    let nextId = 41;
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async (foreignArtistId) => artists.get(foreignArtistId),
      addArtist: async (input) => {
        const artist = desiredAddedArtist({
          id: ++nextId,
          artistName: input.artistName,
          foreignArtistId: input.foreignArtistId,
        });
        artists.set(input.foreignArtistId, artist);
        return artist;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([
      {
        foreignArtistId: "11111111-1111-4111-8111-111111111111",
        outcome: "succeeded",
      },
      {
        foreignArtistId: "22222222-2222-4222-8222-222222222222",
        outcome: "succeeded",
      },
    ]);
    expect(client.addArtist).toHaveBeenCalledTimes(2);
    expect(client.addArtist.mock.calls.map(([input]) => input.foreignArtistId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(client.listRootFolders).toHaveBeenCalledOnce();
    expect(client.listQualityProfiles).toHaveBeenCalledOnce();
    expect(client.listMetadataProfiles).toHaveBeenCalledOnce();
  });

  it("records a satisfied artist-add entry before applying the next addable entry", async () => {
    const files = await multiArtistAddFixture();
    const first = desiredAddedArtist();
    const artists = new Map<string, LidarrArtist>([[first.foreignArtistId, first]]);
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async (foreignArtistId) => artists.get(foreignArtistId),
      addArtist: async (input) => {
        const artist = desiredAddedArtist({
          id: 43,
          artistName: input.artistName,
          foreignArtistId: input.foreignArtistId,
        });
        artists.set(input.foreignArtistId, artist);
        return artist;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([
      { foreignArtistId: first.foreignArtistId, outcome: "satisfied", lidarrId: 42 },
      {
        foreignArtistId: "22222222-2222-4222-8222-222222222222",
        outcome: "succeeded",
        lidarrId: 43,
      },
    ]);
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(client.addArtist).toHaveBeenCalledWith(
      expect.objectContaining({
        foreignArtistId: "22222222-2222-4222-8222-222222222222",
      }),
    );
  });

  it("renders partial artist-add resume in sealed order without mutating during dry-run", async () => {
    const files = await multiArtistAddFixture();
    const [first, second] = files.plan.entries;
    if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
    await appendLidarrPlanHistory(
      {
        planId: files.plan.id,
        planChecksum: files.plan.payloadChecksum,
        entryId: first.id,
        foreignArtistId: first.foreignArtistId,
        recordedAt: "2026-07-26T02:00:00.000Z",
        outcome: "succeeded",
      },
      files.historyPath,
    );
    const artists = new Map<string, LidarrArtist>();
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async (foreignArtistId) => artists.get(foreignArtistId),
      addArtist: async (input) => {
        const artist = desiredAddedArtist({
          id: 43,
          artistName: input.artistName,
          foreignArtistId: input.foreignArtistId,
        });
        artists.set(input.foreignArtistId, artist);
        return artist;
      },
    });
    mockClient.current = client;
    const historyBefore = await readLidarrPlanHistory(
      files.plan.id,
      files.plan.payloadChecksum,
      files.historyPath,
    );

    const checked = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
      dryRun: true,
      approved: false,
    });

    expect(checked.entries).toMatchObject([
      { entryId: first.id, outcome: "skipped-resume" },
      { entryId: second.id, outcome: "would-apply" },
    ]);
    expect(client.addArtist).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual(historyBefore);

    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
    });

    expect(resumed.entries).toMatchObject([
      { entryId: first.id, outcome: "skipped-resume" },
      { entryId: second.id, outcome: "succeeded" },
    ]);
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it.each([
    ["live apply", false, "succeeded", "verification-inconclusive", 1],
    ["dry-run", true, "would-apply", "possible-dispatch-pending", 0],
  ] as const)(
    "does not let a later uncertain artist-add suppress an earlier fresh entry during %s",
    async (_label, dryRun, firstOutcome, secondErrorCode, expectedAddCalls) => {
      const files = await multiArtistAddFixture();
      const [first, second] = files.plan.entries;
      if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
      await appendLidarrPlanHistory(
        {
          planId: files.plan.id,
          planChecksum: files.plan.payloadChecksum,
          entryId: second.id,
          foreignArtistId: second.foreignArtistId,
          recordedAt: "2026-07-26T02:30:00.000Z",
          outcome: "possibly-dispatched",
          idempotencyKey: second.idempotencyKey,
        },
        files.historyPath,
      );
      const artists = new Map<string, LidarrArtist>();
      const reads: string[] = [];
      const client = createLidarrClientMock({
        ...artistAddResources(),
        getArtistByForeignId: async (foreignArtistId) => {
          reads.push(foreignArtistId);
          return artists.get(foreignArtistId);
        },
        addArtist: async (input) => {
          const artist = desiredAddedArtist({
            artistName: input.artistName,
            foreignArtistId: input.foreignArtistId,
          });
          artists.set(input.foreignArtistId, artist);
          return artist;
        },
      });
      mockClient.current = client;

      const result = await executeLidarrApply({
        ...applyOptions(files),
        resume: true,
        dryRun,
        approved: !dryRun,
      });

      expect(result.entries).toMatchObject([
        { entryId: first.id, outcome: firstOutcome },
        {
          entryId: second.id,
          outcome: "uncertain",
          errorCode: secondErrorCode,
        },
      ]);
      expect(reads.indexOf(first.foreignArtistId)).toBeLessThan(
        reads.indexOf(second.foreignArtistId),
      );
      expect(client.addArtist).toHaveBeenCalledTimes(expectedAddCalls);
      if (!dryRun) {
        expect(client.addArtist).toHaveBeenCalledWith(
          expect.objectContaining({ foreignArtistId: first.foreignArtistId }),
        );
      }
    },
  );

  it.each([
    ["live apply", false, "succeeded", "verification-inconclusive", 1],
    ["dry-run", true, "would-apply", "possible-dispatch-pending", 0],
  ] as const)(
    "does not preflight a stale fresh suffix across a possible-dispatch barrier during %s",
    async (_label, dryRun, firstOutcome, middleErrorCode, expectedAddCalls) => {
      const files = await multiArtistAddFixture(true);
      const [first, middle, later] = files.plan.entries;
      if (middle === undefined || later === undefined) {
        throw new Error("three-entry fixture requires middle and later entries");
      }
      await appendLidarrPlanHistory(
        {
          planId: files.plan.id,
          planChecksum: files.plan.payloadChecksum,
          entryId: middle.id,
          foreignArtistId: middle.foreignArtistId,
          recordedAt: "2026-07-26T02:35:00.000Z",
          outcome: "possibly-dispatched",
          idempotencyKey: middle.idempotencyKey,
        },
        files.historyPath,
      );
      const artists = new Map<string, LidarrArtist>([
        [
          later.foreignArtistId,
          createLidarrArtistFixture({
            id: 99,
            artistName: later.artistName,
            foreignArtistId: later.foreignArtistId,
            monitored: true,
            monitorNewItems: "none",
            qualityProfileId: 5,
            metadataProfileId: 7,
            path: `/music/${later.artistName}`,
          }),
        ],
      ]);
      const reads: string[] = [];
      const client = createLidarrClientMock({
        ...artistAddResources(),
        getArtistByForeignId: async (foreignArtistId) => {
          reads.push(foreignArtistId);
          return artists.get(foreignArtistId);
        },
        addArtist: async (input) => {
          const artist = desiredAddedArtist({
            id: 43,
            artistName: input.artistName,
            foreignArtistId: input.foreignArtistId,
          });
          artists.set(input.foreignArtistId, artist);
          return artist;
        },
      });
      mockClient.current = client;

      const result = await executeLidarrApply({
        ...applyOptions(files),
        resume: true,
        dryRun,
        approved: !dryRun,
      });

      expect(result.entries).toMatchObject([
        { entryId: first.id, outcome: firstOutcome },
        {
          entryId: middle.id,
          outcome: "uncertain",
          errorCode: middleErrorCode,
        },
        {
          entryId: later.id,
          outcome: "not-attempted",
          errorCode: "admission-stopped",
        },
      ]);
      expect(reads).toContain(first.foreignArtistId);
      expect(reads).toContain(middle.foreignArtistId);
      expect(reads).not.toContain(later.foreignArtistId);
      expect(reads.indexOf(first.foreignArtistId)).toBeLessThan(
        reads.indexOf(middle.foreignArtistId),
      );
      expect(client.addArtist).toHaveBeenCalledTimes(expectedAddCalls);
      expect(client.listRootFolders).toHaveBeenCalledOnce();
      expect(client.listQualityProfiles).toHaveBeenCalledOnce();
      expect(client.listMetadataProfiles).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["live apply", false, "completed"],
    ["dry-run", true, "checked"],
  ] as const)(
    "returns successful no-op execution metadata for an all-terminal artist-add %s resume",
    async (_label, dryRun, expectedStatus) => {
      const files = await multiArtistAddFixture();
      const [first, second] = files.plan.entries;
      if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
      for (const [index, entry] of files.plan.entries.entries()) {
        await appendLidarrPlanHistory(
          {
            planId: files.plan.id,
            planChecksum: files.plan.payloadChecksum,
            entryId: entry.id,
            foreignArtistId: entry.foreignArtistId,
            recordedAt: `2026-07-26T02:4${index}:00.000Z`,
            outcome: "succeeded",
          },
          files.historyPath,
        );
      }
      const client = createLidarrClientMock(artistAddResources());
      mockClient.current = client;

      const result = await executeLidarrApply({
        ...applyOptions(files),
        resume: true,
        dryRun,
        approved: !dryRun,
      });

      expect(result).toMatchObject({
        status: expectedStatus,
        resumed: true,
        entries: [
          { entryId: first.id, outcome: "skipped-resume" },
          { entryId: second.id, outcome: "skipped-resume" },
        ],
        execution: {
          lane: "local-only",
          outcome: "succeeded",
          attempts: 0,
        },
      });
      expect(result.execution).not.toHaveProperty("failureType");
      expect(client.listRootFolders).not.toHaveBeenCalled();
      expect(client.getArtistByForeignId).not.toHaveBeenCalled();
      expect(client.addArtist).not.toHaveBeenCalled();
      expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
    },
  );

  it("reconciles multi-entry possible dispatch before admitting a fresh artist add", async () => {
    const files = await multiArtistAddFixture();
    const [first] = files.plan.entries;
    await appendLidarrPlanHistory(
      {
        planId: files.plan.id,
        planChecksum: files.plan.payloadChecksum,
        entryId: first.id,
        foreignArtistId: first.foreignArtistId,
        recordedAt: "2026-07-26T03:00:00.000Z",
        outcome: "possibly-dispatched",
        idempotencyKey: first.idempotencyKey,
      },
      files.historyPath,
    );
    const artists = new Map<string, LidarrArtist>([[first.foreignArtistId, desiredAddedArtist()]]);
    const events: string[] = [];
    const client = createLidarrClientMock({
      ...artistAddResources(),
      listRootFolders: async () => {
        events.push("resources");
        return [{ id: 3, path: "/music", accessible: true, freeSpace: 1_000_000 }];
      },
      getArtistByForeignId: async (foreignArtistId) => {
        events.push(`read:${foreignArtistId}`);
        return artists.get(foreignArtistId);
      },
      addArtist: async (input) => {
        const artist = desiredAddedArtist({
          id: 43,
          artistName: input.artistName,
          foreignArtistId: input.foreignArtistId,
        });
        artists.set(input.foreignArtistId, artist);
        return artist;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
    });

    expect(result.entries).toMatchObject([
      { entryId: first.id, outcome: "satisfied", lidarrId: 42 },
      {
        foreignArtistId: "22222222-2222-4222-8222-222222222222",
        outcome: "succeeded",
        lidarrId: 43,
      },
    ]);
    expect(events.slice(0, 2)).toEqual([`read:${first.foreignArtistId}`, "resources"]);
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it("stops after partial normalization and resumes the known artist without a second create", async () => {
    const files = await multiArtistAddFixture(false, ["singles"]);
    const [first, second] = files.plan.entries;
    if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
    const artists = new Map<string, LidarrArtist>();
    let nextId = 41;
    let firstAlbumRead = true;
    let firstSingleMonitored = true;
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async (foreignArtistId) => artists.get(foreignArtistId),
      addArtist: async (input) => {
        const artist = desiredAddedArtist({
          id: ++nextId,
          artistName: input.artistName,
          foreignArtistId: input.foreignArtistId,
        });
        artists.set(input.foreignArtistId, artist);
        return artist;
      },
      listAlbums: async ({ artistId }) => {
        if (artistId === 42) {
          if (firstAlbumRead) {
            firstAlbumRead = false;
            return [];
          }
          return [
            createLidarrAlbumFixture({
              id: 10,
              artistId,
              albumType: "Single",
              monitored: firstSingleMonitored,
            }),
          ];
        }
        return [
          createLidarrAlbumFixture({
            id: 20,
            artistId,
            albumType: "Album",
            monitored: true,
          }),
        ];
      },
      setAlbumsMonitored: async () => {
        firstSingleMonitored = false;
      },
    });
    mockClient.current = client;

    const firstApply = await executeLidarrApply(applyOptions(files));

    expect(firstApply).toMatchObject({
      status: "partial",
      summary: { uncertain: 1, notAttempted: 1, succeeded: 0 },
      entries: [
        {
          entryId: first.id,
          outcome: "uncertain",
          stage: "creation-verified-normalization-pending",
          lidarrId: 42,
          failure: { safeNextAction: "resume-plan" },
        },
        {
          entryId: second.id,
          outcome: "not-attempted",
          stage: "create-pending",
        },
      ],
    });
    expect(client.addArtist).toHaveBeenCalledOnce();

    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
    });

    expect(resumed).toMatchObject({
      status: "completed",
      entries: [
        { entryId: first.id, outcome: "satisfied", stage: "completed", lidarrId: 42 },
        { entryId: second.id, outcome: "succeeded", stage: "completed", lidarrId: 43 },
      ],
    });
    expect(client.addArtist.mock.calls.map(([input]) => input.foreignArtistId)).toEqual([
      first.foreignArtistId,
      second.foreignArtistId,
    ]);
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([10], false, expect.any(AbortSignal));
  });

  it("keeps normalization-pending resume partial during dry-run and performs no mutation", async () => {
    const files = await multiArtistAddFixture(false, ["singles"]);
    const [first, second] = files.plan.entries;
    if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
    await appendLidarrPlanHistory(
      {
        planId: files.plan.id,
        planChecksum: files.plan.payloadChecksum,
        entryId: first.id,
        foreignArtistId: first.foreignArtistId,
        lidarrId: 42,
        recordedAt: "2026-07-27T01:00:00.000Z",
        outcome: "creation-verified-normalization-pending",
        idempotencyKey: first.idempotencyKey,
      },
      files.historyPath,
    );
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async (foreignArtistId) =>
        foreignArtistId === first.foreignArtistId ? desiredAddedArtist() : undefined,
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      resume: true,
      dryRun: true,
      approved: false,
    });

    expect(result).toMatchObject({
      status: "checked",
      summary: { uncertain: 1, notAttempted: 1, satisfied: 0 },
      entries: [
        {
          entryId: first.id,
          outcome: "uncertain",
          stage: "creation-verified-normalization-pending",
          lidarrId: 42,
          failure: {
            dispatchState: "dispatched",
            verificationState: "inconclusive",
            safeNextAction: "resume-plan",
          },
        },
        {
          entryId: second.id,
          outcome: "not-attempted",
          stage: "create-pending",
        },
      ],
    });
    expect(client.listRootFolders).not.toHaveBeenCalled();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("stops multi-entry artist-add after uncertainty and marks later entries not attempted", async () => {
    const files = await multiArtistAddFixture();
    const [first, second] = files.plan.entries;
    if (second === undefined) throw new Error("multi-entry fixture requires a second entry");
    const client = createLidarrClientMock({
      ...artistAddResources(),
      getArtistByForeignId: async () => undefined,
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([
      {
        entryId: first.id,
        outcome: "uncertain",
        errorCode: "verification-inconclusive",
      },
      {
        entryId: second.id,
        outcome: "not-attempted",
        errorCode: "admission-stopped",
        failure: { safeNextAction: "resume-plan" },
      },
    ]);
    expect(client.addArtist).toHaveBeenCalledOnce();
    const history = await readLidarrPlanHistory(
      files.plan.id,
      files.plan.payloadChecksum,
      files.historyPath,
    );
    expect(new Set(history.map((record) => record.entryId))).toEqual(new Set([first.id]));
  });

  it("requires cumulative deletion authority independently of approval and exempts dry-run", async () => {
    const files = await artistDeleteFixture(true);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    const client = createLidarrClientMock({
      listArtists: async () => [artist],
      getArtist: async () => artist,
    });
    mockClient.current = client;

    await expect(executeLidarrApply(applyOptions(files))).rejects.toThrow(/allow-artist-delete/iu);
    await expect(
      executeLidarrApply({ ...applyOptions(files), allowArtistDelete: true }),
    ).rejects.toThrow(/allow-file-delete/iu);
    await expect(
      executeLidarrApply({
        ...applyOptions(files),
        dryRun: true,
        approved: false,
        plexScan: true,
      }),
    ).resolves.toMatchObject({
      status: "checked",
      scan: { attempted: false, status: "skipped" },
    });
    expect(client.deleteArtist).not.toHaveBeenCalled();
    expect(mockResolveOptionalScanAdapter).not.toHaveBeenCalled();
  });

  it("blocks deletion evidence drift during whole-plan preflight before any dispatch", async () => {
    const files = await artistDeleteFixture(false);
    const drifted = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 13,
      sizeOnDisk: 1_024,
    });
    const client = createLidarrClientMock({ listArtists: async () => [drifted] });
    mockClient.current = client;

    await expect(
      executeLidarrApply({
        ...applyOptions(files),
        allowArtistDelete: true,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanStaleError);
    expect(client.deleteArtist).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["v2", artistDeleteFixture],
    ["v3", artistDeleteV3Fixture],
  ] as const)(
    "satisfies an absent resume target only with matching possible-dispatch evidence for %s",
    async (_version, fixture) => {
      const files = await fixture(false);
      const entry = files.plan.entries[0]!;
      const client = createLidarrClientMock({
        listArtists: async () => [],
        getArtist: async () => {
          const error = new LidarrValidationError("lidarr get artist", "Artist not found");
          Object.defineProperty(error, "code", { value: "not-found" });
          throw error;
        },
      });
      mockClient.current = client;
      await expect(
        executeLidarrApply({
          ...applyOptions(files),
          allowArtistDelete: true,
        }),
      ).rejects.toBeInstanceOf(LidarrPlanStaleError);

      await appendLidarrPlanHistory(
        {
          planId: files.plan.id,
          planChecksum: files.plan.payloadChecksum,
          entryId: entry.id,
          artistId: entry.artistId,
          recordedAt: "2026-07-24T12:00:00.000Z",
          outcome: "possibly-dispatched",
          idempotencyKey: entry.idempotencyKey,
        },
        files.historyPath,
      );

      const result = await executeLidarrApply({
        ...applyOptions(files),
        allowArtistDelete: true,
        resume: true,
        plexScan: true,
      });

      expect(result.entries).toMatchObject([{ artistId: 3, outcome: "satisfied" }]);
      expect(result.scan).toMatchObject({ attempted: false, status: "skipped" });
      expect(client.deleteArtist).not.toHaveBeenCalled();
      expect(mockScanTrigger).not.toHaveBeenCalled();
      await expect(
        readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
      ).resolves.toMatchObject([{ entryId: entry.id, outcome: "satisfied" }]);
    },
  );

  it("dispatches deletes sequentially and triggers one scan only for new nonzero file success", async () => {
    const planned = [
      {
        artistId: 3,
        artistName: "Three",
        path: "/music/Three",
        albumCount: 2,
        trackFileCount: 12,
        sizeOnDisk: 1_024,
      },
      {
        artistId: 4,
        artistName: "Four",
        path: "/music/Four",
        albumCount: 1,
        trackFileCount: 8,
        sizeOnDisk: 512,
      },
    ] as const;
    const files = await artistDeleteFixture(true, planned);
    const artists = new Map<number, LidarrArtist>(
      planned.map((entry) => [entry.artistId, deletionArtist({ id: entry.artistId, ...entry })]),
    );
    const events: string[] = [];
    const client = createLidarrClientMock({
      listArtists: async () => [...artists.values()],
      getArtist: async (artistId) => {
        const artist = artists.get(artistId);
        if (artist === undefined) {
          const error = new LidarrValidationError("lidarr get artist", "Artist not found");
          Object.defineProperty(error, "code", { value: "not-found" });
          throw error;
        }
        events.push(`read:${artistId}`);
        return artist;
      },
      deleteArtist: async (artistId) => {
        events.push(`delete:${artistId}`);
        artists.delete(artistId);
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
      allowFileDelete: true,
      plexScan: true,
    });

    expect(result.entries.map((entry) => entry.outcome)).toEqual(["succeeded", "succeeded"]);
    expect(events).toEqual(["read:3", "delete:3", "read:4", "delete:4"]);
    expect(mockScanTrigger).toHaveBeenCalledTimes(1);
    expect(result.scan).toMatchObject({ attempted: true, status: "succeeded" });
  });

  it("does not retry or defer an uncertain deletion and stops later admission", async () => {
    const planned = [
      {
        artistId: 3,
        artistName: "Three",
        path: "/music/Three",
        albumCount: 2,
        trackFileCount: 12,
        sizeOnDisk: 1_024,
      },
      {
        artistId: 4,
        artistName: "Four",
        path: "/music/Four",
        albumCount: 1,
        trackFileCount: 8,
        sizeOnDisk: 512,
      },
    ] as const;
    const files = await artistDeleteFixture(false, planned);
    const artists = planned.map((entry) => deletionArtist({ id: entry.artistId, ...entry }));
    const client = createLidarrClientMock({
      listArtists: async () => artists,
      getArtist: async (artistId) => artists.find((artist) => artist.id === artistId)!,
      deleteArtist: async () => {
        throw new LidarrUnreachableError("lidarr delete artist", "Connection reset");
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });

    expect(result.entries.map((entry) => entry.outcome)).toEqual(["uncertain", "not-attempted"]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
    await expect(access(join(files.root, "tracking.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops later deletion admission after a rejected dispatch fails verification", async () => {
    const planned = [
      {
        artistId: 3,
        artistName: "Three",
        path: "/music/Three",
        albumCount: 2,
        trackFileCount: 12,
        sizeOnDisk: 1_024,
      },
      {
        artistId: 4,
        artistName: "Four",
        path: "/music/Four",
        albumCount: 1,
        trackFileCount: 8,
        sizeOnDisk: 512,
      },
    ] as const;
    const files = await artistDeleteFixture(false, planned);
    const artists = planned.map((entry) => deletionArtist({ id: entry.artistId, ...entry }));
    const client = createLidarrClientMock({
      listArtists: async () => artists,
      getArtist: async (artistId) => artists.find((artist) => artist.id === artistId)!,
      deleteArtist: async () => {
        throw new LidarrValidationError(
          "lidarr delete artist",
          "Lidarr rejected the deletion",
          "validation",
        );
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "failed",
        failure: {
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        },
      },
      { artistId: 4, outcome: "not-attempted" },
    ]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
  });

  it("attributes an absent artist on a second invocation without resending its uncertain delete", async () => {
    const files = await artistDeleteFixture(false);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    let present = true;
    const client = createLidarrClientMock({
      listArtists: async () => (present ? [artist] : []),
      getArtist: async () => {
        if (present) return artist;
        const error = new LidarrValidationError("lidarr get artist", "Artist not found");
        Object.defineProperty(error, "code", { value: "not-found" });
        throw error;
      },
      deleteArtist: async () => {
        throw new LidarrUnreachableError("lidarr delete artist", "Connection reset");
      },
    });
    mockClient.current = client;

    const first = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });
    expect(first.entries).toMatchObject([{ artistId: 3, outcome: "uncertain" }]);

    present = false;
    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
      resume: true,
    });

    expect(resumed.entries).toMatchObject([{ artistId: 3, outcome: "satisfied" }]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
  });

  it("blocks a second uncertain delete invocation while the artist remains present", async () => {
    const files = await artistDeleteFixture(false);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    const client = createLidarrClientMock({
      listArtists: async () => [artist],
      getArtist: async () => artist,
      deleteArtist: async () => {
        throw new LidarrUnreachableError("lidarr delete artist", "Connection reset");
      },
    });
    mockClient.current = client;

    const first = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });
    expect(first.entries).toMatchObject([{ artistId: 3, outcome: "uncertain" }]);

    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
      resume: true,
    });

    expect(resumed.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "uncertain",
        errorCode: "possible-dispatch-pending",
        failure: {
          dispatchState: "dispatch-unknown",
          verificationState: "inconclusive",
          safeNextAction: "resume-plan",
        },
      },
    ]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
  });

  it("reports a present possible-dispatch resume as blocked during dry-run", async () => {
    const files = await artistDeleteFixture(false);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    const client = createLidarrClientMock({
      listArtists: async () => [artist],
      getArtist: async () => artist,
      deleteArtist: async () => {
        throw new LidarrUnreachableError("lidarr delete artist", "Connection reset");
      },
    });
    mockClient.current = client;

    const first = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });
    expect(first.entries).toMatchObject([{ artistId: 3, outcome: "uncertain" }]);
    const historyBefore = await readLidarrPlanHistory(
      files.plan.id,
      files.plan.payloadChecksum,
      files.historyPath,
    );
    const dryRunClaimDirectory = join(files.root, "dry-run-claims");

    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      claimDirectory: dryRunClaimDirectory,
      allowArtistDelete: true,
      resume: true,
      dryRun: true,
      approved: false,
    });

    expect(resumed.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "uncertain",
        errorCode: "possible-dispatch-pending",
        failure: {
          stage: "admission",
          dispatchState: "dispatch-unknown",
          verificationState: "inconclusive",
          retryable: true,
          safeNextAction: "resume-plan",
        },
      },
    ]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual(historyBefore);
    await expect(access(dryRunClaimDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mockSignalHandler.registerGlobalCleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps a 401-rejected delete failed when verification observes a concurrent 404", async () => {
    const files = await artistDeleteFixture(false);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    const getArtist = vi
      .fn()
      .mockResolvedValueOnce(artist)
      .mockRejectedValueOnce(new LidarrNotFoundError("lidarr get artist"));
    const client = createLidarrClientMock({
      listArtists: async () => [artist],
      getArtist,
      deleteArtist: async () => {
        throw classifyLidarrStatus(401, "lidarr delete artist");
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "failed",
        errorCode: "configuration",
        observed: { kind: "artist-delete", exists: false },
        failure: {
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        },
      },
    ]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(1);
    expect(getArtist).toHaveBeenCalledTimes(2);
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "artist:3", outcome: "failed" }]);
  });

  it("retries a definitively rejected delete once after credentials are corrected", async () => {
    const files = await artistDeleteFixture(false);
    const artist = deletionArtist({
      id: 3,
      artistName: "Three",
      path: "/music/Three",
      albumCount: 2,
      trackFileCount: 12,
      sizeOnDisk: 1_024,
    });
    let present = true;
    let credentialsValid = false;
    const client = createLidarrClientMock({
      listArtists: async () => (present ? [artist] : []),
      getArtist: async () => {
        if (present) return artist;
        const error = new LidarrValidationError("lidarr get artist", "Artist not found");
        Object.defineProperty(error, "code", { value: "not-found" });
        throw error;
      },
      deleteArtist: async () => {
        if (!credentialsValid) {
          throw new LidarrValidationError(
            "lidarr delete artist",
            "Lidarr authentication failed",
            "configuration",
          );
        }
        present = false;
      },
    });
    mockClient.current = client;

    const rejected = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
    });

    expect(rejected.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "failed",
        errorCode: "configuration",
        failure: {
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        },
      },
    ]);
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "artist:3", outcome: "failed" }]);

    credentialsValid = true;
    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      allowArtistDelete: true,
      resume: true,
    });

    expect(resumed.entries).toMatchObject([{ artistId: 3, outcome: "succeeded" }]);
    expect(client.deleteArtist).toHaveBeenCalledTimes(2);
  });

  it("keeps dry-run claim-, history-, deferred-, and mutation-free with complete evidence", async () => {
    const files = await monitoringFixture();
    const { client } = createStatefulClient([
      createLidarrArtistFixture({ id: 3, artistName: "Three Live", monitored: true }),
    ]);
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result).toMatchObject({
      status: "checked",
      cascadeAnalysis: { status: "not-recorded" },
      entries: [
        {
          artistId: 3,
          artistName: "Three Live",
          outcome: "would-apply",
          before: { kind: "artist-monitoring", monitored: true },
          after: { kind: "artist-monitoring", monitored: false },
          observed: { kind: "artist-monitoring", monitored: true },
        },
      ],
    });
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
    await expect(access(join(files.root, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual([]);
  });

  it("copies exceeded sealed v3 evidence without enforcing it during real apply", async () => {
    const files = await monitoringV3Fixture();
    const { client } = createStatefulClient([
      createLidarrArtistFixture({ id: 3, artistName: "Three", monitored: false }),
    ]);
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.cascadeAnalysis).toEqual({
      status: "recorded",
      analysis: files.plan.cascadeAnalysis,
    });
    expect(files.plan.cascadeAnalysis.warnings.map((warning) => warning.code)).toEqual([
      "indexer-query-budget-exceeded",
      "acquisition-budget-exceeded",
    ]);
    expect(result).toMatchObject({
      status: "completed",
      summary: { succeeded: 1, notAttempted: 0 },
      entries: [{ artistId: 3, outcome: "succeeded" }],
    });
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
  });

  it("reports every initial missing resource and artist before any write", async () => {
    const files = await profileFixture();
    const client = createLidarrClientMock({
      listArtists: async () => [],
      listQualityProfiles: async () => [],
      listMetadataProfiles: async () => [],
    });
    mockClient.current = client;

    const error = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(LidarrPlanStaleError);
    expect((error as LidarrPlanStaleError).findings.map((finding) => finding.code)).toEqual([
      "resource-missing",
      "resource-missing",
      "artist-missing",
    ]);
    expect(client.setArtistProfiles).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it("binds resources by ID, warns on rename, and updates display context", async () => {
    const files = await profileFixture();
    const { client } = createStatefulClient(
      [createLidarrArtistFixture({ id: 3, qualityProfileId: 1, metadataProfileId: 2 })],
      {
        qualityProfiles: [
          createLidarrProfileFixture({ id: 1, name: "Standard" }),
          createLidarrProfileFixture({ id: 5, name: "FLAC renamed" }),
        ],
        metadataProfiles: [
          createLidarrProfileFixture({ id: 2, name: "Default" }),
          createLidarrProfileFixture({ id: 7, name: "Extended" }),
        ],
      },
    );
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result.entries[0]).toMatchObject({
      after: {
        kind: "artist-profile-assignment",
        qualityProfile: { id: 5, name: "FLAC renamed" },
      },
    });
    expect(result.entries[0]?.message).toMatch(/renamed from Lossless to FLAC renamed/u);
  });

  it("deduplicates a resource referenced by both selection and operation", async () => {
    const files = await profileFixture({
      kind: "filters",
      qualityProfile: { id: 5, name: "Lossless" },
    });
    const { client } = createStatefulClient(
      [createLidarrArtistFixture({ id: 3, qualityProfileId: 1, metadataProfileId: 2 })],
      {
        qualityProfiles: [
          createLidarrProfileFixture({ id: 1, name: "Standard" }),
          createLidarrProfileFixture({ id: 5, name: "Lossless renamed" }),
        ],
        metadataProfiles: [
          createLidarrProfileFixture({ id: 2, name: "Default" }),
          createLidarrProfileFixture({ id: 7, name: "Extended" }),
        ],
      },
    );
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result.entries[0]?.message?.match(/quality-profile 5 was renamed/gu)).toHaveLength(1);
    expect(client.listQualityProfiles).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "quality-profile",
      { kind: "filters", qualityProfile: { id: 5, name: "Lossless" } },
      "quality-profile 5 (Lossless)",
      "listQualityProfiles",
    ],
    [
      "metadata-profile",
      { kind: "filters", metadataProfile: { id: 7, name: "Extended" } },
      "metadata-profile 7 (Extended)",
      "listMetadataProfiles",
    ],
    [
      "tag",
      { kind: "filters", tags: [{ id: 8, label: "Managed" }] },
      "tag 8 (Managed)",
      "listTags",
    ],
  ] as const)(
    "blocks a deleted selector-only %s before any write",
    async (_kind, selection, expectedMessage, listMethod) => {
      const files = await selectorOnlyFixture(selection);
      const { client } = createStatefulClient([
        createLidarrArtistFixture({ id: 3, monitored: true }),
      ]);
      mockClient.current = client;

      const error = await executeLidarrApply(applyOptions(files)).catch(
        (failure: unknown) => failure,
      );

      expect(error).toBeInstanceOf(LidarrPlanStaleError);
      expect((error as LidarrPlanStaleError).findings).toMatchObject([
        { code: "resource-missing", message: expect.stringContaining(expectedMessage) },
      ]);
      expect(client[listMethod]).toHaveBeenCalledOnce();
      expect(client.setArtistsMonitored).not.toHaveBeenCalled();
      expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "quality-profile",
      { kind: "filters", qualityProfile: { id: 5, name: "Lossless" } },
      {
        qualityProfiles: [createLidarrProfileFixture({ id: 5, name: "Lossless renamed" })],
      },
      "renamed from Lossless to Lossless renamed",
      "listQualityProfiles",
    ],
    [
      "metadata-profile",
      { kind: "filters", metadataProfile: { id: 7, name: "Extended" } },
      {
        metadataProfiles: [createLidarrProfileFixture({ id: 7, name: "Extended renamed" })],
      },
      "renamed from Extended to Extended renamed",
      "listMetadataProfiles",
    ],
    [
      "tag",
      { kind: "filters", tags: [{ id: 8, label: "Managed" }] },
      { tags: [createLidarrTagFixture({ id: 8, label: "Managed renamed" })] },
      "renamed from Managed to Managed renamed",
      "listTags",
    ],
  ] as const)(
    "warns when a selector-only %s was renamed while binding by ID",
    async (_kind, selection, resources, expectedMessage, listMethod) => {
      const files = await selectorOnlyFixture(selection);
      const { client } = createStatefulClient(
        [createLidarrArtistFixture({ id: 3, monitored: true })],
        resources,
      );
      mockClient.current = client;

      const result = await executeLidarrApply({
        ...applyOptions(files),
        dryRun: true,
        approved: false,
      });

      expect(result.entries[0]).toMatchObject({ outcome: "would-apply" });
      expect(result.entries[0]?.message).toContain(expectedMessage);
      expect(client[listMethod]).toHaveBeenCalledOnce();
      expect(client.setArtistsMonitored).not.toHaveBeenCalled();
    },
  );

  it("preserves v1 apply and resume semantics with targeted verification", async () => {
    const files = await monitoringFixture();
    const { client } = createStatefulClient([
      createLidarrArtistFixture({ id: 3, monitored: true }),
    ]);
    mockClient.current = client;

    const first = await executeLidarrApply(applyOptions(files));
    expect(first).toMatchObject({
      status: "completed",
      entries: [{ artistId: 3, outcome: "succeeded" }],
    });
    expect(client.setArtistsMonitored).toHaveBeenCalledWith([3], false, expect.any(AbortSignal));
    expect(client.getArtist).toHaveBeenCalledTimes(2);

    const resumed = await executeLidarrApply({ ...applyOptions(files), resume: true });
    expect(resumed.entries).toMatchObject([{ artistId: 3, outcome: "skipped-resume" }]);
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
  });

  it("accepts partial independent profile convergence and writes one exact artist", async () => {
    const files = await profileFixture();
    const { client } = createStatefulClient(
      [createLidarrArtistFixture({ id: 3, qualityProfileId: 5, metadataProfileId: 2 })],
      {
        qualityProfiles: [
          createLidarrProfileFixture({ id: 1, name: "Standard" }),
          createLidarrProfileFixture({ id: 5, name: "Lossless" }),
        ],
        metadataProfiles: [
          createLidarrProfileFixture({ id: 2, name: "Default" }),
          createLidarrProfileFixture({ id: 7, name: "Extended" }),
        ],
      },
    );
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.status).toBe("completed");
    expect(client.setArtistProfiles).toHaveBeenCalledWith(
      3,
      { qualityProfileId: 5, metadataProfileId: 7 },
      expect.any(AbortSignal),
    );
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
    expect(client.updateArtistTags).not.toHaveBeenCalled();
  });

  it("tolerates unrelated tag drift for delta operations", async () => {
    const files = await tagFixture("add");
    const { client } = createStatefulClient([createLidarrArtistFixture({ id: 3, tags: [4, 9] })], {
      tags: [
        createLidarrTagFixture({ id: 4, label: "Keep" }),
        createLidarrTagFixture({ id: 8, label: "Managed" }),
        createLidarrTagFixture({ id: 9, label: "Unrelated" }),
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.status).toBe("completed");
    expect(client.updateArtistTags).toHaveBeenCalledWith(
      3,
      { mode: "add", tagIds: [8] },
      expect.any(AbortSignal),
    );
    const entry = result.entries[0];
    expect(entry !== undefined && "observed" in entry ? entry.observed : undefined).toMatchObject({
      kind: "artist-tag-mutation",
      tags: [
        { id: 4, label: "Keep" },
        { id: 8, label: "Managed" },
        { id: 9, label: "Unrelated" },
      ],
    });
  });

  it("blocks replacement drift before any write", async () => {
    const files = await tagFixture("set");
    const { client } = createStatefulClient([createLidarrArtistFixture({ id: 3, tags: [4, 9] })], {
      tags: [
        createLidarrTagFixture({ id: 4, label: "Keep" }),
        createLidarrTagFixture({ id: 8, label: "Managed" }),
        createLidarrTagFixture({ id: 9, label: "Unrelated" }),
      ],
    });
    mockClient.current = client;

    await expect(
      executeLidarrApply({ ...applyOptions(files), allowTagReplacement: true }),
    ).rejects.toBeInstanceOf(LidarrPlanStaleError);
    expect(client.updateArtistTags).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it.each(["set", "clear"] as const)(
    "rejects unauthorized tag %s before claims, history, reads, or writes",
    async (mode) => {
      const files = await tagFixture(mode);
      const { client } = createStatefulClient([createLidarrArtistFixture({ id: 3, tags: [4] })]);
      mockClient.current = client;

      await expect(executeLidarrApply(applyOptions(files))).rejects.toThrow(
        /tag replacement apply requires explicit authorization/u,
      );

      expect(mockResolveRequiredLidarrOrigin).not.toHaveBeenCalled();
      expect(client.listArtists).not.toHaveBeenCalled();
      expect(client.updateArtistTags).not.toHaveBeenCalled();
      expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
      await expect(access(join(files.root, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
      ).resolves.toEqual([]);
    },
  );

  it("allows tag replacement dry-run without destructive authorization", async () => {
    const files = await tagFixture("set");
    const { client } = createStatefulClient([createLidarrArtistFixture({ id: 3, tags: [4] })], {
      tags: [
        createLidarrTagFixture({ id: 4, label: "Keep" }),
        createLidarrTagFixture({ id: 8, label: "Managed" }),
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result.entries[0]?.outcome).toBe("would-apply");
    expect(client.updateArtistTags).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it("executes an explicitly authorized tag replacement", async () => {
    const files = await tagFixture("set");
    const { client } = createStatefulClient([createLidarrArtistFixture({ id: 3, tags: [4] })], {
      tags: [
        createLidarrTagFixture({ id: 4, label: "Keep" }),
        createLidarrTagFixture({ id: 8, label: "Managed" }),
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowTagReplacement: true,
    });

    expect(result.status).toBe("completed");
    expect(client.updateArtistTags).toHaveBeenCalledWith(
      3,
      { mode: "set", tagIds: [8] },
      expect.any(AbortSignal),
    );
  });

  it("reconciles delayed visibility without retrying the editor", async () => {
    const files = await monitoringFixture();
    const before = createLidarrArtistFixture({ id: 3, monitored: true });
    const after = createLidarrArtistFixture({ id: 3, monitored: false });
    const client = createLidarrClientMock({
      listArtists: async () => [before],
      getArtist: vi
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries[0]?.outcome).toBe("succeeded");
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
    expect(client.getArtist).toHaveBeenCalledTimes(3);
    expect(LIDARR_APPLY_RECONCILIATION_ATTEMPTS).toBe(3);
    expect(LIDARR_APPLY_RECONCILIATION_DELAY_MS).toBe(100);
  });

  it("stops after a definite verification failure and exposes structured evidence", async () => {
    const files = await profileFixture();
    if (files.plan.operation.kind !== "artist-profile-assignment") {
      throw new Error("Profile fixture returned an incompatible operation");
    }
    const secondPlan = buildLidarrMutationPlanV2({
      origin: files.plan.target.origin,
      selection: { kind: "ids", artistIds: [3, 4] },
      operation: files.plan.operation,
      maxBatch: 25,
      entries: [
        {
          kind: "artist-profile-assignment",
          artistId: 3,
          artistName: "Three",
          qualityProfile: { id: 1, name: "Standard" },
          metadataProfile: { id: 2, name: "Default" },
        },
        {
          kind: "artist-profile-assignment",
          artistId: 4,
          artistName: "Four",
          qualityProfile: { id: 1, name: "Standard" },
          metadataProfile: { id: 2, name: "Default" },
        },
      ],
    });
    const expanded = await writeFixture(secondPlan);
    const { client, artists } = createStatefulClient(
      [
        createLidarrArtistFixture({ id: 3, qualityProfileId: 1, metadataProfileId: 2 }),
        createLidarrArtistFixture({ id: 4, qualityProfileId: 1, metadataProfileId: 2 }),
      ],
      {
        qualityProfiles: [
          createLidarrProfileFixture({ id: 1, name: "Standard" }),
          createLidarrProfileFixture({ id: 5, name: "Lossless" }),
        ],
        metadataProfiles: [
          createLidarrProfileFixture({ id: 2, name: "Default" }),
          createLidarrProfileFixture({ id: 7, name: "Extended" }),
        ],
      },
    );
    client.setArtistProfiles.mockImplementationOnce(async (artistId) => {
      const artist = artists.get(artistId);
      if (artist !== undefined) artists.set(artistId, { ...artist, qualityProfileId: 9 });
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(expanded));

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "failed",
        errorCode: "verification-failed",
        failure: {
          code: "verification-failed",
          stage: "verification",
          operation: "artist-profile-assignment",
          planId: expanded.plan.id,
          planChecksum: expanded.plan.payloadChecksum,
          targetIds: [3],
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        },
      },
      { artistId: 4, outcome: "not-attempted" },
    ]);
    expect(client.setArtistProfiles).toHaveBeenCalledOnce();
  });

  it("records uncertain and stops when a post-dispatch timeout cannot be reconciled", async () => {
    const files = await monitoringFixture([{ artistId: 4, artistName: "Four", monitored: true }]);
    const artists = [
      createLidarrArtistFixture({ id: 3, monitored: true }),
      createLidarrArtistFixture({ id: 4, monitored: true }),
    ];
    const client = createLidarrClientMock({
      listArtists: async () => artists,
      getArtist: async (artistId) => artists.find((artist) => artist.id === artistId)!,
      setArtistsMonitored: async () => {
        throw new LidarrUnreachableError("lidarr update artist monitoring");
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "uncertain",
        errorCode: "verification-inconclusive",
        failure: {
          stage: "verification",
          dispatchState: "dispatch-unknown",
          verificationState: "inconclusive",
          retryable: true,
          safeNextAction: "resume-plan",
        },
      },
      { artistId: 4, outcome: "not-attempted" },
    ]);
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
    expect(client.getArtist).toHaveBeenCalledTimes(1 + LIDARR_APPLY_RECONCILIATION_ATTEMPTS);
  });

  it("records post-dispatch cancellation as uncertain without admitting later targets", async () => {
    const files = await monitoringFixture([{ artistId: 4, artistName: "Four", monitored: true }]);
    const controller = new AbortController();
    const abortReason = new DOMException("cancelled by test", "AbortError");
    const artists = [
      createLidarrArtistFixture({ id: 3, monitored: true }),
      createLidarrArtistFixture({ id: 4, monitored: true }),
    ];
    const client = createLidarrClientMock({
      listArtists: async () => artists,
      getArtist: async (artistId) => artists.find((artist) => artist.id === artistId)!,
      setArtistsMonitored: async () => {
        controller.abort(abortReason);
        throw abortReason;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      signal: controller.signal,
    });

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "uncertain",
        errorCode: "post-dispatch-cancelled",
        failure: { dispatchState: "dispatch-unknown", safeNextAction: "resume-plan" },
      },
      { artistId: 4, outcome: "not-attempted" },
    ]);
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
  });

  it("defers only a confirmed retryable pre-write read and replays it exactly on resume", async () => {
    const files = await monitoringFixture();
    const before = createLidarrArtistFixture({ id: 3, monitored: true });
    const after = createLidarrArtistFixture({ id: 3, monitored: false });
    const client = createLidarrClientMock({
      listArtists: async () => [before],
      getArtist: vi
        .fn()
        .mockRejectedValueOnce(new LidarrUnreachableError("lidarr get artist"))
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });
    mockClient.current = client;

    const first = await executeLidarrApply(applyOptions(files));
    expect(first.entries).toMatchObject([
      {
        outcome: "deferred",
        failure: {
          stage: "admission",
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          retryable: true,
          safeNextAction: "resume-plan",
        },
      },
    ]);
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();

    const resumed = await executeLidarrApply({ ...applyOptions(files), resume: true });
    expect(resumed.entries[0]?.outcome).toBe("succeeded");
    expect(client.setArtistsMonitored).toHaveBeenCalledWith([3], false, expect.any(AbortSignal));
  });

  it("restores a deferred claim when plan ownership is lost before replay dispatch", async () => {
    const files = await monitoringFixture();
    const options = applyOptions(files);
    const before = createLidarrArtistFixture({ id: 3, monitored: true });
    const after = createLidarrArtistFixture({ id: 3, monitored: false });
    const client = createLidarrClientMock({
      listArtists: async () => [before],
      getArtist: vi
        .fn()
        .mockRejectedValueOnce(new LidarrUnreachableError("lidarr get artist"))
        .mockImplementationOnce(async () => {
          await rm(join(options.claimDirectory, `${files.plan.id}.lock`));
          return before;
        })
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(after),
    });
    mockClient.current = client;

    await expect(executeLidarrApply(options)).resolves.toMatchObject({
      entries: [{ outcome: "deferred" }],
    });
    await expect(executeLidarrApply({ ...options, resume: true })).rejects.toThrow(
      /already being applied/u,
    );
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();

    const database = await initializeDatabase(options.databasePath);
    try {
      expect(
        listDeferredIntents(database, {
          origin: "https://lidarr.example.test",
        }),
      ).toMatchObject([{ status: "pending", attempts: 0 }]);
    } finally {
      closeDatabase(database);
    }

    await expect(executeLidarrApply({ ...options, resume: true })).resolves.toMatchObject({
      entries: [{ outcome: "succeeded" }],
    });
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
  });

  it("rejects deferred replay when operation payload or idempotency no longer exactly matches", async () => {
    const files = await monitoringFixture();
    const before = createLidarrArtistFixture({ id: 3, monitored: true });
    const client = createLidarrClientMock({
      listArtists: async () => [before],
      getArtist: vi
        .fn()
        .mockRejectedValueOnce(new LidarrUnreachableError("lidarr get artist"))
        .mockResolvedValue(before),
    });
    mockClient.current = client;
    await executeLidarrApply(applyOptions(files));

    const database = await initializeDatabase(join(files.root, "tracking.db"));
    try {
      database
        .prepare("UPDATE lidarr_deferred_intents SET payload_json = ?")
        .run('{"artistId":3,"monitored":false,"extra":true}');
    } finally {
      closeDatabase(database);
    }

    await expect(executeLidarrApply({ ...applyOptions(files), resume: true })).rejects.toThrow(
      /does not exactly match its plan entry/u,
    );
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
  });

  it("records a satisfied no-op without sending an editor request", async () => {
    const files = await monitoringFixture();
    const { client } = createStatefulClient([
      createLidarrArtistFixture({ id: 3, monitored: false }),
    ]);
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries[0]).toMatchObject({
      artistId: 3,
      outcome: "satisfied",
      observed: { kind: "artist-monitoring", monitored: false },
    });
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
  });

  it("detects claim loss immediately before dispatch", async () => {
    const files = await monitoringFixture();
    const claimDirectory = join(files.root, "claims");
    const artist = createLidarrArtistFixture({ id: 3, monitored: true });
    const client = createLidarrClientMock({
      listArtists: async () => [artist],
      getArtist: async () => {
        await rm(join(claimDirectory, `${files.plan.id}.lock`));
        return artist;
      },
    });
    mockClient.current = client;

    await expect(executeLidarrApply({ ...applyOptions(files), claimDirectory })).rejects.toThrow(
      /already being applied/u,
    );
    expect(client.setArtistsMonitored).not.toHaveBeenCalled();
  });

  it("stops uncertain when verified remote success cannot be persisted", async () => {
    const files = await monitoringFixture([{ artistId: 4, artistName: "Four", monitored: true }]);
    const { client } = createStatefulClient([
      createLidarrArtistFixture({ id: 3, monitored: true }),
      createLidarrArtistFixture({ id: 4, monitored: true }),
    ]);
    client.setArtistsMonitored.mockImplementationOnce(async ([artistId], monitored) => {
      const artist = createLidarrArtistFixture({ id: artistId, monitored });
      client.getArtist.mockResolvedValueOnce(artist);
      await mkdir(files.historyPath);
    });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.entries).toMatchObject([
      {
        artistId: 3,
        outcome: "uncertain",
        errorCode: "history-write-failed",
        failure: {
          stage: "history",
          dispatchState: "dispatched",
          verificationState: "verified",
          safeNextAction: "resume-plan",
        },
      },
      { artistId: 4, outcome: "not-attempted" },
    ]);
    expect(client.setArtistsMonitored).toHaveBeenCalledOnce();
  });

  it("rejects approval and reviewed identity mismatches before remote resolution", async () => {
    const files = await monitoringFixture();
    mockClient.current = createLidarrClientMock();

    await expect(
      executeLidarrApply({ ...applyOptions(files), approved: false }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(
      executeLidarrApply({
        ...applyOptions(files),
        dryRun: true,
        approved: false,
        expectedPlanChecksum: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toThrow(/plan checksum mismatch/u);
    expect(mockResolveRequiredLidarrOrigin).not.toHaveBeenCalled();
  });
});

async function albumFixture(
  monitored = true,
  additionalEntries: readonly {
    readonly albumId: number;
    readonly albumTitle: string;
    readonly artistId: number;
    readonly artistName: string;
    readonly monitored: boolean;
  }[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-apply-album-action-"));
  roots.push(root);
  const plan = buildLidarrMutationPlan(
    {
      origin: "https://lidarr.example.test",
      operation: { kind: "album-monitoring", desiredMonitored: false, selectors: ["singles"] },
      maxBatch: 25,
      entries: [
        { albumId: 30, albumTitle: "Thirty", artistId: 3, artistName: "Three", monitored },
        ...additionalEntries,
      ],
    },
    { randomUUID: () => "33333333-3333-4333-8333-333333333333" },
  );
  const planPath = join(root, "plan.json");
  const historyPath = join(root, "history.jsonl");
  await writeLidarrPlanArtifact(planPath, plan);
  return { root, plan, planPath, historyPath };
}

describe("executeLidarrApply (album-monitoring)", () => {
  it("is a no-write live check for album plans in dry-run mode", async () => {
    const files = await albumFixture(true, [
      { albumId: 40, albumTitle: "Forty", artistId: 3, artistName: "Three", monitored: false },
    ]);
    const client = createLidarrClientMock({
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true }),
        createLidarrAlbumFixture({ id: 40, artistId: 3, monitored: false }),
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      dryRun: true,
      approved: false,
    });

    expect(result.status).toBe("checked");
    expect(result.entries).toMatchObject([
      { entryId: "album:30", albumId: 30, outcome: "would-apply" },
      { entryId: "album:40", albumId: 40, outcome: "satisfied" },
    ]);
    expect(result.summary).toMatchObject({ total: 2, wouldApply: 1, satisfied: 1 });
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual([]);
  });

  it("applies album entries one call at a time with durable album history", async () => {
    const files = await albumFixture();
    const client = createLidarrClientMock({
      listAlbums: async () => [createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true })],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      dryRun: false,
      approved: true,
    });

    expect(result.status).toBe("completed");
    expect(result.cascadeAnalysis).toEqual({ status: "not-recorded" });
    expect(result.entries).toMatchObject([
      { entryId: "album:30", albumId: 30, outcome: "succeeded" },
    ]);
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([30], false, expect.any(AbortSignal));
    const history = await readLidarrPlanHistory(
      files.plan.id,
      files.plan.payloadChecksum,
      files.historyPath,
    );
    expect(history).toMatchObject([{ entryId: "album:30", albumId: 30, outcome: "succeeded" }]);
    const scheduled = mockRunSingle.mock.calls.map((call) => {
      const task = call[1] as unknown as { readonly id: string; readonly operation: string };
      return [task.id, task.operation];
    });
    expect(scheduled).toEqual([
      [`lidarr-apply-read-${files.plan.id}`, "lidarr apply preflight"],
      [`lidarr-apply-read-${files.plan.id}-album:30`, "lidarr apply target check"],
      [`lidarr-apply-${files.plan.id}-album:30`, "lidarr apply album monitoring"],
    ]);
  });

  it("blocks album state drift before any mutation", async () => {
    const files = await albumFixture(false);
    const client = createLidarrClientMock({
      listAlbums: async () => [createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true })],
    });
    mockClient.current = client;

    const error: unknown = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      dryRun: false,
      approved: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LidarrPlanStaleError);
    expect((error as LidarrPlanStaleError).findings).toMatchObject([
      { code: "album-state-drift", entryId: "album:30", albumId: 30 },
    ]);
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("blocks a deleted album with album-missing", async () => {
    const files = await albumFixture();
    const client = createLidarrClientMock({ listAlbums: async () => [] });
    mockClient.current = client;

    const error: unknown = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      dryRun: false,
      approved: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LidarrPlanStaleError);
    expect((error as LidarrPlanStaleError).findings).toMatchObject([
      { code: "album-missing", entryId: "album:30", albumId: 30 },
    ]);
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("queues a retryable album mutation and replays it only through explicit resume", async () => {
    const files = await albumFixture();
    const databasePath = join(files.root, "tracking.db");
    const client = createLidarrClientMock({
      listAlbums: async () => [createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true })],
      setAlbumsMonitored: async () => {
        throw new LidarrUnreachableError("lidarr update album monitoring");
      },
    });
    mockClient.current = client;

    const first = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      databasePath,
      dryRun: false,
      approved: true,
    });
    expect(first.status).toBe("failed");
    expect(first.entries[0]?.outcome).toBe("deferred");
    const database = await initializeDatabase(databasePath);
    try {
      const row = database
        .prepare("SELECT operation FROM lidarr_deferred_intents LIMIT 1")
        .get() as { readonly operation: string };
      expect(row.operation).toBe("lidarr.album-monitoring");
    } finally {
      closeDatabase(database);
    }

    client.setAlbumsMonitored.mockResolvedValue(undefined);
    const resumed = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      databasePath,
      dryRun: false,
      approved: true,
      resume: true,
    });
    expect(resumed.status).toBe("completed");
    expect(resumed.entries[0]?.outcome).toBe("succeeded");
    expect(client.setAlbumsMonitored).toHaveBeenCalledTimes(2);
  });

  it("persists a retryable album target-read failure after queuing deferred work", async () => {
    const files = await albumFixture();
    const databasePath = join(files.root, "tracking.db");
    const album = createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true });
    const listAlbums = vi
      .fn()
      .mockResolvedValueOnce([album])
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr apply target check"));
    const client = createLidarrClientMock({ listAlbums });
    mockClient.current = client;

    const result = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      databasePath,
      dryRun: false,
      approved: true,
    });

    expect(result.status).toBe("failed");
    expect(result.entries).toMatchObject([
      {
        entryId: "album:30",
        albumId: 30,
        outcome: "deferred",
        errorCode: "lidarr-unreachable",
      },
    ]);
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([
      {
        entryId: "album:30",
        albumId: 30,
        outcome: "deferred",
        errorCode: "lidarr-unreachable",
      },
    ]);
    const database = await initializeDatabase(databasePath);
    try {
      const row = database
        .prepare("SELECT operation FROM lidarr_deferred_intents LIMIT 1")
        .get() as { readonly operation: string };
      expect(row.operation).toBe("lidarr.album-monitoring");
    } finally {
      closeDatabase(database);
    }
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("returns uncertain on a history-write failure and reclassifies satisfied on resume", async () => {
    const files = await albumFixture();
    const databasePath = join(files.root, "tracking.db");
    const client = createLidarrClientMock({
      listAlbums: async () => [createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true })],
      setAlbumsMonitored: async () => {
        await mkdir(files.historyPath);
      },
    });
    mockClient.current = client;

    const first = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      dryRun: false,
      approved: true,
    });
    expect(first.status).toBe("failed");
    expect(first.entries[0]).toMatchObject({
      outcome: "uncertain",
      errorCode: "history-write-failed",
    });

    await rm(files.historyPath, { recursive: true, force: true });
    client.listAlbums.mockResolvedValue([
      createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: false }),
    ]);
    const resumed = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      databasePath,
      dryRun: false,
      approved: true,
      resume: true,
    });
    expect(resumed.entries[0]?.outcome).toBe("satisfied");
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
  });

  it("orders album results by albumId, not artistId", async () => {
    const files = await albumFixture(true, [
      { albumId: 40, albumTitle: "Forty", artistId: 1, artistName: "One", monitored: true },
    ]);
    const client = createLidarrClientMock({
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 30, artistId: 3, monitored: true }),
        createLidarrAlbumFixture({ id: 40, artistId: 1, monitored: true }),
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      planPath: files.planPath,
      historyPath: files.historyPath,
      claimDirectory: join(files.root, "claims"),
      dryRun: false,
      approved: true,
    });

    expect(result.status).toBe("completed");
    expect(result.entries.map((entry) => ("albumId" in entry ? entry.albumId : undefined))).toEqual(
      [30, 40],
    );
    expect(client.setAlbumsMonitored).toHaveBeenCalledTimes(2);
  });
});

/** LidarrError with the `not-found` code the client emits for a delete 404. */
class LidarrTestNotFoundError extends LidarrError {
  readonly code = "not-found" as const;

  constructor() {
    super("Lidarr album not found (HTTP 404)", {
      operation: "lidarr delete album",
      statusCode: 404,
      retryable: false,
    });
  }
}

async function albumDeleteFixture(
  options: {
    readonly deleteFiles?: boolean;
  } = {},
) {
  return writeFixture(
    buildLidarrAlbumMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "album-ids", albumIds: [50] },
        operation: {
          kind: "album-delete",
          deleteFiles: options.deleteFiles ?? false,
          addImportListExclusion: false,
          includeMonitored: false,
          selectors: [],
        },
        maxBatch: 25,
        entries: [
          {
            kind: "album-delete",
            albumId: 50,
            albumTitle: "Fifty",
            artistId: 3,
            artistName: "Three",
            foreignAlbumId: "mbid-album-50",
            monitored: false,
            trackFileCount: 2,
            sizeOnDisk: 2_048,
          },
        ],
      },
      { randomUUID: () => "55555555-5555-4555-8555-555555555555" },
    ),
  );
}

async function albumEditFixture() {
  return writeFixture(
    buildLidarrAlbumMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "album-filters", artistIds: [3], selectors: ["albums"] },
        operation: { kind: "album-edit", desiredAnyReleaseOk: true, selectors: ["albums"] },
        maxBatch: 25,
        entries: [
          {
            kind: "album-edit",
            albumId: 60,
            albumTitle: "Sixty",
            artistId: 3,
            artistName: "Three",
            albumType: "Album",
            anyReleaseOk: false,
          },
        ],
      },
      { randomUUID: () => "66666666-6666-4666-8666-666666666666" },
    ),
  );
}

function presentDeleteTarget(overrides: Parameters<typeof createLidarrAlbumFixture>[0] = {}) {
  return createLidarrAlbumFixture({
    id: 50,
    artistId: 3,
    monitored: false,
    foreignAlbumId: "mbid-album-50",
    ...overrides,
  });
}

describe("executeLidarrApply (album mutations)", () => {
  it("rejects a real album-delete apply without --allow-album-delete even when approved", async () => {
    const files = await albumDeleteFixture();
    const client = createLidarrClientMock();
    mockClient.current = client;

    await expect(executeLidarrApply(applyOptions(files))).rejects.toThrow(
      /album deletion apply requires explicit authorization/u,
    );

    expect(mockResolveRequiredLidarrOrigin).not.toHaveBeenCalled();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.deleteAlbum).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
    await expect(access(join(files.root, "claims"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toEqual([]);
  });

  it("additionally requires --allow-file-delete when the sealed plan deletes files", async () => {
    const files = await albumDeleteFixture({ deleteFiles: true });
    const client = createLidarrClientMock();
    mockClient.current = client;

    await expect(
      executeLidarrApply({ ...applyOptions(files), allowAlbumDelete: true }),
    ).rejects.toThrow(/file deletion apply requires explicit authorization/u);
    expect(mockResolveRequiredLidarrOrigin).not.toHaveBeenCalled();
    expect(client.deleteAlbum).not.toHaveBeenCalled();
  });

  it("allows an album-delete dry-run without any destructive authorization", async () => {
    const files = await albumDeleteFixture({ deleteFiles: true });
    const client = createLidarrClientMock({
      listAlbums: async () => [presentDeleteTarget()],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result.status).toBe("checked");
    expect(result.entries).toMatchObject([
      { entryId: "album:50", albumId: 50, outcome: "would-apply" },
    ]);
    expect(client.deleteAlbum).not.toHaveBeenCalled();
    expect(mockSignalHandler.registerGlobalCleanup).not.toHaveBeenCalled();
  });

  it("executes a fully authorized album-delete with bounded absence verification", async () => {
    const files = await albumDeleteFixture({ deleteFiles: true });
    const albums = [presentDeleteTarget()];
    const client = createLidarrClientMock({
      listAlbums: async () => [...albums],
      deleteAlbum: async () => {
        albums.length = 0;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowAlbumDelete: true,
      allowFileDelete: true,
    });

    expect(result.status).toBe("completed");
    expect(result.entries).toMatchObject([
      { entryId: "album:50", albumId: 50, outcome: "succeeded" },
    ]);
    expect(client.deleteAlbum).toHaveBeenCalledWith(
      50,
      { deleteFiles: true, addImportListExclusion: false },
      expect.any(AbortSignal),
    );
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "album:50", albumId: 50, outcome: "succeeded" }]);
  });

  it("classifies a missing delete target satisfied at preflight, admission, and resume", async () => {
    const files = await albumDeleteFixture();
    const client = createLidarrClientMock({ listAlbums: async () => [] });
    mockClient.current = client;

    const first = await executeLidarrApply({ ...applyOptions(files), allowAlbumDelete: true });

    expect(first.status).toBe("completed");
    expect(first.entries).toMatchObject([{ entryId: "album:50", outcome: "satisfied" }]);
    expect(client.deleteAlbum).not.toHaveBeenCalled();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "album:50", albumId: 50, outcome: "satisfied" }]);

    const resumed = await executeLidarrApply({
      ...applyOptions(files),
      allowAlbumDelete: true,
      resume: true,
    });
    expect(resumed.entries).toMatchObject([{ entryId: "album:50", outcome: "skipped-resume" }]);
    expect(client.deleteAlbum).not.toHaveBeenCalled();
  });

  it("treats a dispatch not-found as satisfied for album deletion", async () => {
    const files = await albumDeleteFixture();
    const client = createLidarrClientMock({
      listAlbums: async () => [presentDeleteTarget()],
      deleteAlbum: async () => {
        throw new LidarrTestNotFoundError();
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({ ...applyOptions(files), allowAlbumDelete: true });

    expect(result.status).toBe("completed");
    expect(result.entries).toMatchObject([
      { entryId: "album:50", outcome: "satisfied", errorCode: "not-found" },
    ]);
    expect(client.deleteAlbum).toHaveBeenCalledOnce();
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "album:50", outcome: "satisfied" }]);
  });

  it("defers a retryable delete dispatch with the exact payload and idempotency key", async () => {
    const files = await albumDeleteFixture();
    const options = applyOptions(files);
    const client = createLidarrClientMock({
      listAlbums: async () => [presentDeleteTarget()],
      deleteAlbum: async () => {
        throw new LidarrUnreachableError("lidarr delete album");
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({ ...options, allowAlbumDelete: true });

    expect(result.status).toBe("failed");
    expect(result.entries).toMatchObject([
      {
        entryId: "album:50",
        outcome: "deferred",
        errorCode: "lidarr-unreachable",
        failure: {
          stage: "dispatch",
          operation: "album-delete",
          targetIds: [50],
          retryable: true,
          safeNextAction: "resume-plan",
        },
      },
    ]);
    expect(client.deleteAlbum).toHaveBeenCalledOnce();
    const database = await initializeDatabase(options.databasePath);
    try {
      expect(
        listDeferredIntents(database, { origin: "https://lidarr.example.test" }),
      ).toMatchObject([
        {
          operation: "lidarr.album-delete",
          idempotencyKey: files.plan.entries[0]!.idempotencyKey,
          payload: { albumId: 50, deleteFiles: false, addImportListExclusion: false },
          status: "pending",
        },
      ]);
    } finally {
      closeDatabase(database);
    }
  });

  it("replays a deferred delete and records satisfied when the target is already gone", async () => {
    const files = await albumDeleteFixture();
    const options = applyOptions(files);
    const listAlbums = vi
      .fn()
      .mockResolvedValueOnce([presentDeleteTarget()])
      .mockResolvedValueOnce([presentDeleteTarget()]);
    const deleteAlbum = vi
      .fn()
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr delete album"));
    const client = createLidarrClientMock({ listAlbums, deleteAlbum });
    mockClient.current = client;

    const first = await executeLidarrApply({ ...options, allowAlbumDelete: true });
    expect(first.entries[0]?.outcome).toBe("deferred");

    listAlbums
      .mockResolvedValueOnce([presentDeleteTarget()])
      .mockResolvedValueOnce([presentDeleteTarget()])
      .mockResolvedValueOnce([]);
    deleteAlbum.mockRejectedValueOnce(new LidarrTestNotFoundError());

    const resumed = await executeLidarrApply({
      ...options,
      allowAlbumDelete: true,
      resume: true,
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.entries).toMatchObject([
      { entryId: "album:50", outcome: "satisfied", errorCode: "not-found" },
    ]);
    expect(deleteAlbum).toHaveBeenCalledTimes(2);
    const database = await initializeDatabase(options.databasePath);
    try {
      expect(
        listDeferredIntents(database, { origin: "https://lidarr.example.test" }),
      ).toMatchObject([{ status: "succeeded" }]);
    } finally {
      closeDatabase(database);
    }
  });

  it.each([
    ["monitored drift", { monitored: true }],
    ["foreign-album drift", { foreignAlbumId: "mbid-album-other" }],
  ] as const)(
    "blocks a drifted delete target (%s) before any destructive dispatch",
    async (_label, drift) => {
      const files = await albumDeleteFixture();
      const client = createLidarrClientMock({
        listAlbums: async () => [presentDeleteTarget(drift)],
      });
      mockClient.current = client;

      const error: unknown = await executeLidarrApply({
        ...applyOptions(files),
        allowAlbumDelete: true,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(LidarrPlanStaleError);
      expect((error as LidarrPlanStaleError).findings).toMatchObject([
        { code: "album-state-drift", entryId: "album:50", albumId: 50 },
      ]);
      expect(client.deleteAlbum).not.toHaveBeenCalled();
    },
  );

  it("fails with verification-stage evidence when the album survives delete dispatch", async () => {
    const files = await albumDeleteFixture();
    const client = createLidarrClientMock({
      listAlbums: async () => [presentDeleteTarget()],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({ ...applyOptions(files), allowAlbumDelete: true });

    expect(result.status).toBe("failed");
    expect(result.entries).toMatchObject([
      {
        entryId: "album:50",
        outcome: "failed",
        errorCode: "verification-failed",
        failure: {
          code: "verification-failed",
          stage: "verification",
          operation: "album-delete",
          planId: files.plan.id,
          planChecksum: files.plan.payloadChecksum,
          targetIds: [50],
          dispatchState: "dispatched",
          verificationState: "failed",
          retryable: false,
          safeNextAction: "review-failure-and-resume",
        },
      },
    ]);
    expect(client.deleteAlbum).toHaveBeenCalledOnce();
    expect(client.listAlbums).toHaveBeenCalledTimes(2 + LIDARR_APPLY_RECONCILIATION_ATTEMPTS);
  });

  it("records uncertain when delete verification reads stay unavailable", async () => {
    const files = await albumDeleteFixture();
    const listAlbums = vi
      .fn()
      .mockResolvedValueOnce([presentDeleteTarget()])
      .mockResolvedValueOnce([presentDeleteTarget()])
      .mockRejectedValue(new LidarrUnreachableError("lidarr apply targeted verification"));
    const client = createLidarrClientMock({ listAlbums });
    mockClient.current = client;

    const result = await executeLidarrApply({ ...applyOptions(files), allowAlbumDelete: true });

    expect(result.entries).toMatchObject([
      {
        entryId: "album:50",
        outcome: "uncertain",
        errorCode: "verification-inconclusive",
        failure: {
          stage: "verification",
          verificationState: "inconclusive",
          retryable: true,
          safeNextAction: "resume-plan",
        },
      },
    ]);
    expect(client.deleteAlbum).toHaveBeenCalledOnce();
  });

  it("verifies the new anyReleaseOk after an album-edit dispatch", async () => {
    const files = await albumEditFixture();
    const listAlbums = vi
      .fn()
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 60, artistId: 3, anyReleaseOk: false }),
      ])
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 60, artistId: 3, anyReleaseOk: false }),
      ])
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 60, artistId: 3, anyReleaseOk: true }),
      ]);
    const client = createLidarrClientMock({ listAlbums });
    mockClient.current = client;

    const result = await executeLidarrApply(applyOptions(files));

    expect(result.status).toBe("completed");
    expect(result.entries).toMatchObject([
      { entryId: "album:60", albumId: 60, outcome: "succeeded" },
    ]);
    expect(client.setAlbumAnyReleaseOk).toHaveBeenCalledWith(60, true, expect.any(AbortSignal));
    await expect(
      readLidarrPlanHistory(files.plan.id, files.plan.payloadChecksum, files.historyPath),
    ).resolves.toMatchObject([{ entryId: "album:60", albumId: 60, outcome: "succeeded" }]);
  });
});

async function trackFilterFixture() {
  return writeFixture(
    buildLidarrTrackFilterPlanV2(
      {
        origin: "https://lidarr.example.test",
        albumId: 70,
        operation: { kind: "track-file-filter", explicitKeepTrackIds: [701] },
        maxBatch: 100,
        entry: {
          id: "album:70:track-file-filter",
          albumId: 70,
          albumTitle: "Seventy",
          artistId: 7,
          artistName: "Seven",
          before: {
            deleteCandidates: [
              {
                trackId: 702,
                trackTitle: "Delete",
                trackFileId: 7002,
                path: "/music/seventy/02.flac",
                size: 2_000,
                mediumNumber: 1,
                absoluteTrackNumber: 2,
              },
            ],
          },
          after: { deletedTrackFileIds: [7002] },
          keptTrackIds: [701],
          warnings: [],
        },
      },
      { randomUUID: () => "70707070-7070-4070-8070-707070707070" },
    ),
  );
}

async function trackFilterV3Fixture() {
  return writeFixture(
    buildLidarrTrackFilterPlanV3(
      {
        origin: "https://lidarr.example.test",
        albumId: 70,
        albumMonitored: true,
        operation: { kind: "track-file-filter", explicitKeepTrackIds: [701] },
        maxBatch: 100,
        entry: {
          id: "album:70:track-file-filter",
          albumId: 70,
          albumTitle: "Seventy",
          artistId: 7,
          artistName: "Seven",
          before: {
            deleteCandidates: [
              {
                trackId: 702,
                trackTitle: "Delete",
                trackFileId: 7002,
                path: "/music/seventy/02.flac",
                size: 2_000,
                mediumNumber: 1,
                absoluteTrackNumber: 2,
              },
            ],
          },
          after: { deletedTrackFileIds: [7002] },
          keptTrackIds: [701],
          warnings: [],
        },
        cascadePolicy: CASCADE_POLICY,
      },
      { randomUUID: () => "71717171-7171-4171-8171-717171717171" },
    ),
  );
}

describe("executeLidarrApply (track-file-filter)", () => {
  it("requires file-delete authorization before resolving the remote client", async () => {
    const files = await trackFilterFixture();
    const client = createLidarrClientMock();
    mockClient.current = client;

    await expect(executeLidarrApply(applyOptions(files))).rejects.toThrow(
      /trackfile deletion requires explicit --allow-file-delete authorization/u,
    );
    expect(mockResolveRequiredLidarrOrigin).not.toHaveBeenCalled();
    expect(client.listTrackFiles).not.toHaveBeenCalled();
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
  });

  it("routes an authorized plan through exact bulk deletion and absence verification", async () => {
    const files = await trackFilterFixture();
    const present = [
      {
        id: 7002,
        artistId: 7,
        albumId: 70,
        path: "/music/seventy/02.flac",
        size: 2_000,
      },
    ];
    const client = createLidarrClientMock({
      listTrackFiles: async () => [...present],
      bulkDeleteTrackFiles: async () => {
        present.length = 0;
      },
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      allowFileDelete: true,
    });

    expect(result.status).toBe("completed");
    expect(result.cascadeAnalysis).toEqual({ status: "not-recorded" });
    expect(result.entries).toMatchObject([
      { entryId: "album:70:track-file-filter", outcome: "succeeded" },
    ]);
    expect(client.bulkDeleteTrackFiles).toHaveBeenCalledWith([7002], expect.any(AbortSignal));
  });

  it("copies sealed v3 analysis through the specialized track-filter result", async () => {
    const files = await trackFilterV3Fixture();
    const client = createLidarrClientMock({
      listTrackFiles: async () => [
        {
          id: 7002,
          artistId: 7,
          albumId: 70,
          path: "/music/seventy/02.flac",
          size: 2_000,
        },
      ],
    });
    mockClient.current = client;

    const result = await executeLidarrApply({
      ...applyOptions(files),
      dryRun: true,
      approved: false,
    });

    expect(result.cascadeAnalysis).toEqual({
      status: "recorded",
      analysis: files.plan.cascadeAnalysis,
    });
    expect(result).toMatchObject({
      status: "checked",
      entries: [{ outcome: "would-apply" }],
    });
    expect(client.bulkDeleteTrackFiles).not.toHaveBeenCalled();
  });
});
