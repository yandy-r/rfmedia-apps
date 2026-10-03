import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LidarrExecutionContext } from "../../lib/lidarr/index.js";
import { createLidarrScheduler, resolveLidarrSchedulerPolicy } from "../../lib/lidarr/scheduler.js";
import {
  LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
  type SimilarArtistRecommendation,
} from "../../types/discovery.js";
import type { LidarrConfigOptions } from "../../types/config.js";
import type { LidarrMetadataProfile } from "../../types/lidarr.js";
import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrArtistFixture,
  createLidarrProfileFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockClient = vi.hoisted(() => ({ current: undefined as unknown }));
const mockPreflight = vi.hoisted(() => vi.fn(async () => undefined));
const mockResolveContext = vi.hoisted(() =>
  vi.fn(
    () =>
      ({
        client: mockClient.current,
        preflight: mockPreflight,
        writeLookupCache: vi.fn(),
        tryServeStale: vi.fn(),
      }) as LidarrExecutionContext,
  ),
);
const mockResolveOrigin = vi.hoisted(() => vi.fn(() => "https://lidarr.example.test"));
const mockResolveScheduler = vi.hoisted(() => vi.fn());
const mockLoadedLidarrConfigState = vi.hoisted(() => ({
  current: {
    cascadeAnalysis: {
      budgets: {
        indexerQueries: 50,
        acquisitionCandidates: 25,
      },
      assumptions: {
        indexerQueriesPerCandidate: 2,
      },
    },
  } as LidarrConfigOptions,
}));
const mockGetLoadedLidarrConfig = vi.hoisted(() =>
  vi.fn(() => mockLoadedLidarrConfigState.current),
);

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: mockResolveScheduler,
  resolveRequiredLidarrExecutionContext: mockResolveContext,
  resolveRequiredLidarrOrigin: mockResolveOrigin,
}));

vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedLidarrConfig: mockGetLoadedLidarrConfig,
}));

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { LidarrUnreachableError } from "../../lib/lidarr/errors.js";
import { readLidarrPlanArtifact } from "../../lib/lidarr/plan-engine.js";
import {
  executeLidarrArtistAddPlan,
  type LidarrArtistAddPlanActionOptions,
} from "./plan-artist-add.js";

const FOREIGN_ARTIST_ID_1 = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ARTIST_ID_2 = "22222222-2222-4222-8222-222222222222";
const FOREIGN_ARTIST_ID_3 = "33333333-3333-4333-8333-333333333333";
const roots: string[] = [];

function makeRecommendation(
  rank: number,
  musicBrainzId: string | undefined,
  overrides: Partial<SimilarArtistRecommendation> = {},
): SimilarArtistRecommendation {
  const name = `Recommendation ${rank}`;
  const similarity = Number((0.95 - rank / 100).toFixed(2));
  const adjustedScore = Number((0.96 - rank / 100).toFixed(2));
  return {
    rank,
    name,
    similarity,
    musicBrainzId,
    sourceUrl: `https://www.last.fm/music/${rank}`,
    addEligibility: musicBrainzId === undefined ? "requires-resolution" : "exact-id",
    status: "approved",
    reason: "selected",
    rawSimilarity: similarity,
    adjustedScore,
    exposureCount: 1,
    provenance: {
      seedArtist: "Seed Artist",
      parentArtist: "Seed Artist",
      depth: 1,
      providerRank: rank,
      firstSeenSequence: rank,
      firstPath: ["Seed Artist", name],
      discoveredAt: "2026-07-25T11:59:00.000Z",
    },
    ...overrides,
  };
}

const recommendation1 = makeRecommendation(1, FOREIGN_ARTIST_ID_1);
const recommendation2 = makeRecommendation(2, FOREIGN_ARTIST_ID_2);
const recommendation3 = makeRecommendation(3, FOREIGN_ARTIST_ID_3);

function currentClient(): ReturnType<typeof createLidarrClientMock> {
  return mockClient.current as ReturnType<typeof createLidarrClientMock>;
}

function foreignArtistIdFromLookupTerm(term: string): string {
  return term.slice("lidarr:".length);
}

function createDefaultClient() {
  return createLidarrClientMock({
    lookupArtists: async ({ term }) => {
      const foreignArtistId = foreignArtistIdFromLookupTerm(term);
      return [
        {
          kind: "artist",
          foreignId: foreignArtistId,
          name: `Authoritative ${foreignArtistId.slice(0, 8)}`,
        },
      ];
    },
    getArtistByForeignId: async () => undefined,
    listRootFolders: async () => [
      {
        id: 3,
        path: "/music",
        defaultMetadataProfileId: 7,
        accessible: true,
        freeSpace: 1_000_000,
      },
    ],
    listQualityProfiles: async () => [createLidarrProfileFixture({ id: 5, name: "Lossless" })],
    listMetadataProfileDetails: async () => [
      createMetadataProfile({ id: 7, name: "Standard Metadata" }),
    ],
  });
}

function createMetadataProfile(
  overrides: Partial<LidarrMetadataProfile> = {},
): LidarrMetadataProfile {
  return Object.freeze({
    id: 7,
    name: "Standard Metadata",
    primaryAlbumTypes: Object.freeze([
      Object.freeze({ id: 1, name: "Album", allowed: true }),
      Object.freeze({ id: 2, name: "Single", allowed: false }),
    ]),
    secondaryAlbumTypes: Object.freeze([Object.freeze({ id: 10, name: "Live", allowed: false })]),
    ...overrides,
  });
}

async function makeOutput(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-artist-add-action-"));
  roots.push(root);
  return join(root, "plan.json");
}

type ExecuteOverrides = Partial<
  Omit<LidarrArtistAddPlanActionOptions, "recommendation" | "recommendations">
> & {
  readonly recommendations?: readonly [
    SimilarArtistRecommendation,
    ...SimilarArtistRecommendation[],
  ];
};

async function execute(
  overrides: ExecuteOverrides = {},
): ReturnType<typeof executeLidarrArtistAddPlan> {
  return executeLidarrArtistAddPlan({
    recommendations: [recommendation1],
    seedArtist: "Seed Artist",
    discoveredAt: "2026-07-25T11:59:00.000Z",
    rootFolder: "/music",
    qualityProfile: "Lossless",
    metadataProfile: "7",
    output: await makeOutput(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadedLidarrConfigState.current = {
    cascadeAnalysis: {
      budgets: {
        indexerQueries: 50,
        acquisitionCandidates: 25,
      },
      assumptions: {
        indexerQueriesPerCandidate: 2,
      },
    },
  };
  mockClient.current = createDefaultClient();
  mockResolveScheduler.mockReturnValue(
    createLidarrScheduler(
      resolveLidarrSchedulerPolicy({
        lanes: { "metadata-dependent": { retryAttempts: 0 } },
      }),
    ),
  );
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executeLidarrArtistAddPlan", () => {
  it.each([
    {
      label: "an invalid visible rank",
      recommendations: [makeRecommendation(101, FOREIGN_ARTIST_ID_1)],
    },
    {
      label: "a non-lowercase MBID",
      recommendations: [makeRecommendation(1, "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")],
    },
    {
      label: "a missing MBID",
      recommendations: [makeRecommendation(1, undefined)],
    },
    {
      label: "duplicate visible ranks",
      recommendations: [recommendation1, makeRecommendation(1, FOREIGN_ARTIST_ID_2)],
    },
    {
      label: "duplicate MBIDs",
      recommendations: [recommendation1, makeRecommendation(2, FOREIGN_ARTIST_ID_1)],
    },
    {
      label: "more than 25 candidates",
      recommendations: Array.from({ length: 26 }, (_, index) =>
        makeRecommendation(
          index + 1,
          `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        ),
      ),
    },
  ])("rejects $label before origin, scheduler, or Lidarr I/O", async ({ recommendations }) => {
    const output = await makeOutput();

    await expect(
      executeLidarrArtistAddPlan({
        recommendations: recommendations as [
          SimilarArtistRecommendation,
          ...SimilarArtistRecommendation[],
        ],
        seedArtist: "Seed Artist",
        discoveredAt: "2026-07-25T11:59:00.000Z",
        rootFolder: "/music",
        qualityProfile: "Lossless",
        metadataProfile: "7",
        output,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    expect(mockResolveOrigin).not.toHaveBeenCalled();
    expect(mockResolveScheduler).not.toHaveBeenCalled();
    expect(mockResolveContext).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    { label: "an empty root-folder reference", overrides: { rootFolder: "  " } },
    {
      label: "a terminal-unsafe profile reference",
      overrides: { qualityProfile: "Lossless\u001b[2J" },
    },
    {
      label: "an oversized metadata-profile reference",
      overrides: { metadataProfile: "m".repeat(2_049) },
    },
    {
      label: "a terminal-unsafe plan path",
      overrides: { output: "plan\nunsafe.json" },
    },
    {
      label: "an oversized plan path",
      overrides: { output: "p".repeat(4_097) },
    },
    {
      label: "an unknown post-add selector",
      overrides: { postAddUnmonitorSelectors: ["bootlegs"] },
    },
  ])("rejects $label before origin, scheduler, or Lidarr I/O", async ({ overrides }) => {
    await expect(execute(overrides)).rejects.toBeInstanceOf(LidarrPlanValidationError);
    expect(mockResolveOrigin).not.toHaveBeenCalled();
    expect(mockResolveScheduler).not.toHaveBeenCalled();
    expect(mockResolveContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "out-of-bound exposure evidence",
      recommendation: makeRecommendation(1, FOREIGN_ARTIST_ID_1, {
        exposureCount: LIDARR_DISCOVER_MAX_EXPOSURE_COUNT + 1,
      }),
    },
    {
      label: "a first path that contradicts the candidate",
      recommendation: makeRecommendation(1, FOREIGN_ARTIST_ID_1, {
        provenance: {
          ...recommendation1.provenance,
          firstPath: ["Seed Artist", "Different Artist"],
        },
      }),
    },
  ])("rejects $label before resolving Lidarr dependencies", async ({ recommendation }) => {
    await expect(execute({ recommendations: [recommendation] })).rejects.toBeInstanceOf(
      LidarrPlanValidationError,
    );

    expect(mockResolveOrigin).not.toHaveBeenCalled();
    expect(mockResolveScheduler).not.toHaveBeenCalled();
    expect(mockResolveContext).not.toHaveBeenCalled();
    expect(currentClient().lookupArtists).not.toHaveBeenCalled();
    expect(currentClient().listRootFolders).not.toHaveBeenCalled();
  });

  it("limits all planning reads to the metadata lane concurrency", async () => {
    const recommendations = Array.from({ length: 25 }, (_, index) =>
      makeRecommendation(
        index + 1,
        `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      ),
    ) as [SimilarArtistRecommendation, ...SimilarArtistRecommendation[]];
    let active = 0;
    let maximumActive = 0;
    let releaseReads: (() => void) | undefined;
    const readsMayComplete = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const boundedRead = async <T>(value: T): Promise<T> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await readsMayComplete;
        return value;
      } finally {
        active -= 1;
      }
    };
    mockClient.current = createLidarrClientMock({
      lookupArtists: async ({ term }) => {
        const foreignArtistId = foreignArtistIdFromLookupTerm(term);
        return boundedRead([
          {
            kind: "artist" as const,
            foreignId: foreignArtistId,
            name: `Authoritative ${foreignArtistId.slice(-12)}`,
          },
        ]);
      },
      getArtistByForeignId: async () => boundedRead(undefined),
      listRootFolders: async () =>
        boundedRead([{ id: 3, path: "/music", accessible: true, freeSpace: 1_000_000 }]),
      listQualityProfiles: async () =>
        boundedRead([createLidarrProfileFixture({ id: 5, name: "Lossless" })]),
      listMetadataProfileDetails: async () =>
        boundedRead([createMetadataProfile({ id: 7, name: "Standard Metadata" })]),
    });

    const pending = execute({ recommendations });
    await vi.waitFor(() => expect(active).toBe(2));
    expect(maximumActive).toBe(2);
    releaseReads?.();
    await pending;

    expect(maximumActive).toBe(2);
    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(25);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(25);
  });

  it("propagates cancellation to in-flight reads and admits no queued reads", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("cancel planning", "AbortError");
    const receivedSignals: AbortSignal[] = [];
    const waitForCancellation = (signal: AbortSignal | undefined): Promise<never> =>
      new Promise((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("planning read did not receive a cancellation signal"));
          return;
        }
        receivedSignals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    mockClient.current = createLidarrClientMock({
      listRootFolders: waitForCancellation,
      lookupArtists: ({ signal }) => waitForCancellation(signal),
    });

    const pending = execute({
      recommendations: [recommendation1, recommendation2, recommendation3],
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(receivedSignals).toHaveLength(2));
    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(receivedSignals).toHaveLength(2);
    expect(
      receivedSignals.every((signal) => signal.aborted && signal.reason === cancellation),
    ).toBe(true);
    expect(currentClient().listQualityProfiles).not.toHaveBeenCalled();
    expect(currentClient().getArtistByForeignId).not.toHaveBeenCalled();
  });

  it("stops queued maximum-selection reads after the first terminal task failure", async () => {
    const recommendations = Array.from({ length: 25 }, (_, index) =>
      makeRecommendation(
        index + 1,
        `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      ),
    ) as [SimilarArtistRecommendation, ...SimilarArtistRecommendation[]];
    const terminalFailure = new Error("first candidate read failed");
    let markSharedReadStarted: (() => void) | undefined;
    const sharedReadStarted = new Promise<void>((resolve) => {
      markSharedReadStarted = resolve;
    });
    let releaseSharedRead: (() => void) | undefined;
    const sharedReadMayComplete = new Promise<void>((resolve) => {
      releaseSharedRead = resolve;
    });
    let markTerminalFailure: (() => void) | undefined;
    const terminalFailureObserved = new Promise<void>((resolve) => {
      markTerminalFailure = resolve;
    });
    const holdSharedRead = async (signal?: AbortSignal) => {
      markSharedReadStarted?.();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        void sharedReadMayComplete.then(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return [{ id: 3, path: "/music", accessible: true, freeSpace: 1_000_000 }];
    };
    mockClient.current = createLidarrClientMock({
      listRootFolders: holdSharedRead,
      lookupArtists: async ({ term }) => {
        const foreignArtistId = foreignArtistIdFromLookupTerm(term);
        if (foreignArtistId === recommendations[0].musicBrainzId) {
          await sharedReadStarted;
          markTerminalFailure?.();
          throw terminalFailure;
        }
        return [{ kind: "artist", foreignId: foreignArtistId, name: "Queued Candidate" }];
      },
      getArtistByForeignId: async () => undefined,
    });
    const output = await makeOutput();
    const settled = execute({ recommendations, output }).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );

    await terminalFailureObserved;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(currentClient().lookupArtists).toHaveBeenCalledTimes(1);
      expect(currentClient().getArtistByForeignId).not.toHaveBeenCalled();
    } finally {
      releaseSharedRead?.();
    }

    await expect(settled).resolves.toEqual({ error: terminalFailure });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without writing when the scheduler cannot admit every read task", async () => {
    mockResolveScheduler.mockReturnValue(
      createLidarrScheduler(
        resolveLidarrSchedulerPolicy({
          lanes: {
            "metadata-dependent": { operationBudget: 1, retryAttempts: 0 },
          },
        }),
      ),
    );
    const output = await makeOutput();

    await expect(execute({ output })).rejects.toThrow(/budget-exhausted/u);

    expect(currentClient().listRootFolders).toHaveBeenCalledOnce();
    expect(currentClient().lookupArtists).not.toHaveBeenCalled();
    expect(currentClient().getArtistByForeignId).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves shared resources once and writes one ordered plan after every fresh read", async () => {
    currentClient().getArtistByForeignId.mockImplementation(async (foreignArtistId) =>
      foreignArtistId === FOREIGN_ARTIST_ID_2
        ? createLidarrArtistFixture({ id: 19, foreignArtistId })
        : undefined,
    );
    const output = await makeOutput();

    const result = await execute({
      recommendations: [recommendation1, recommendation2, recommendation3],
      output,
    });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.planned).toEqual([
      { selectedRank: 1, foreignArtistId: FOREIGN_ARTIST_ID_1 },
      { selectedRank: 3, foreignArtistId: FOREIGN_ARTIST_ID_3 },
    ]);
    expect(result.alreadyPresent).toEqual([
      { selectedRank: 2, foreignArtistId: FOREIGN_ARTIST_ID_2, lidarrId: 19 },
    ]);
    expect(result.plan.version).toBe("rfmedia.lidarr-plan.v3");
    expect(result.plan.maxBatch).toBe(2);
    expect(result.plan.selection).toEqual({
      kind: "foreign-artist-ids",
      foreignArtistIds: [FOREIGN_ARTIST_ID_1, FOREIGN_ARTIST_ID_3],
    });
    expect(result.plan.entries).toMatchObject([
      {
        artistName: "Recommendation 1",
        foreignArtistId: FOREIGN_ARTIST_ID_1,
        provenance: {
          selectedRank: 1,
          parentArtist: "Seed Artist",
          depth: 1,
          providerRank: 1,
          firstSeenSequence: 1,
          firstPath: ["Seed Artist", "Recommendation 1"],
          adjustedScore: 0.95,
          exposureCount: 1,
        },
      },
      {
        artistName: "Recommendation 3",
        foreignArtistId: FOREIGN_ARTIST_ID_3,
        provenance: {
          selectedRank: 3,
          providerRank: 3,
          adjustedScore: 0.93,
        },
      },
    ]);
    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(3);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(3);
    expect(currentClient().listRootFolders).toHaveBeenCalledTimes(1);
    expect(currentClient().listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(currentClient().listMetadataProfileDetails).toHaveBeenCalledTimes(1);
    expect(currentClient().listArtists).not.toHaveBeenCalled();
    expect(currentClient().addArtist).not.toHaveBeenCalled();
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      horizon: "none",
      basis: "operation-removes-acquisition-scope",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries.value).toBe(0);
    const persisted = await readLidarrPlanArtifact(result.planPath);
    expect(persisted).toEqual(result.plan);
    expect(persisted.version).toBe("rfmedia.lidarr-plan.v3");
    if (persisted.version !== "rfmedia.lidarr-plan.v3") {
      throw new Error("expected a version 3 artist-add plan");
    }
    expect(persisted.cascadeAnalysis).toEqual(result.plan.cascadeAnalysis);
    expect(mockGetLoadedLidarrConfig).toHaveBeenCalledTimes(1);
  });

  it("seals safe omitted defaults and canonical post-add selectors", async () => {
    const result = await execute({
      metadataProfile: undefined,
      postAddUnmonitorSelectors: ["Single", "albums"],
    });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.operation).toMatchObject({
      metadataProfile: { id: 7, name: "Standard Metadata" },
      monitored: false,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
      postAddUnmonitorSelectors: ["albums", "singles"],
    });
    expect(result.plan.entries[0]?.after).toMatchObject({
      monitored: false,
      postAddUnmonitorSelectors: ["albums", "singles"],
    });
  });

  it("seals an explicit monitored override without enabling search or new-item monitoring", async () => {
    mockLoadedLidarrConfigState.current = {
      cascadeAnalysis: {
        budgets: {
          indexerQueries: 50,
          acquisitionCandidates: 25,
        },
        assumptions: {
          albumsPerArtist: 4,
          indexerQueriesPerCandidate: 2,
        },
      },
    };
    const result = await execute({ monitored: true });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.operation).toMatchObject({
      monitored: true,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
      postAddUnmonitorSelectors: [],
    });
    expect(result.plan.entries[0]?.after).toMatchObject({
      monitored: true,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
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
      basis: "configured-indexer-queries-per-candidate",
    });
  });

  it("keeps monitored artist-add exposure unknown without albums-per-artist evidence", async () => {
    const result = await execute({ monitored: true });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.operation.searchForMissingAlbums).toBe(false);
    expect(result.plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "acquisition-candidates-unknown",
    });
    expect(result.plan.cascadeAnalysis.metrics.conditionalIndexerQueries).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "acquisition-candidates-unknown",
    });
  });

  it("prefers a structurally albums-only root-folder default when multiple candidates exist", async () => {
    currentClient().listRootFolders.mockResolvedValue([
      {
        id: 3,
        path: "/music",
        defaultMetadataProfileId: 8,
        accessible: true,
        freeSpace: 1_000_000,
      },
    ]);
    currentClient().listMetadataProfileDetails.mockResolvedValue([
      createMetadataProfile({ id: 7, name: "Albums A" }),
      createMetadataProfile({ id: 8, name: "Albums B" }),
    ]);

    const result = await execute({ metadataProfile: undefined });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.operation.metadataProfile).toEqual({ id: 8, name: "Albums B" });
  });

  it("uses the unique albums-only profile when the root-folder default is structurally unsafe", async () => {
    currentClient().listMetadataProfileDetails.mockResolvedValue([
      createMetadataProfile({
        id: 7,
        name: "Mixed",
        secondaryAlbumTypes: Object.freeze([
          Object.freeze({ id: 10, name: "Live", allowed: true }),
        ]),
      }),
      createMetadataProfile({ id: 8, name: "Albums Only" }),
    ]);

    const result = await execute({ metadataProfile: undefined });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.operation.metadataProfile).toEqual({ id: 8, name: "Albums Only" });
  });

  it.each([
    {
      label: "no albums-only profile exists",
      profiles: [
        createMetadataProfile({
          primaryAlbumTypes: Object.freeze([
            Object.freeze({ id: 2, name: "Single", allowed: true }),
          ]),
        }),
      ],
      message: "no structurally albums-only profile",
    },
    {
      label: "multiple albums-only profiles exist without a matching root default",
      profiles: [
        createMetadataProfile({ id: 7, name: "Albums A" }),
        createMetadataProfile({ id: 8, name: "Albums B" }),
      ],
      message: "multiple structurally albums-only profiles",
    },
  ])("fails closed without writing when $label", async ({ profiles, message }) => {
    currentClient().listRootFolders.mockResolvedValue([
      {
        id: 3,
        path: "/music",
        defaultMetadataProfileId: 99,
        accessible: true,
        freeSpace: 1_000_000,
      },
    ]);
    currentClient().listMetadataProfileDetails.mockResolvedValue(profiles);
    const output = await makeOutput();

    await expect(execute({ metadataProfile: undefined, output })).rejects.toThrow(message);

    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(currentClient().addArtist).not.toHaveBeenCalled();
  });

  it("seals the provider name while exact lookup validates a differently spelled identity", async () => {
    const recommendation = makeRecommendation(1, FOREIGN_ARTIST_ID_1, {
      name: "Beyoncé",
      provenance: {
        ...recommendation1.provenance,
        firstPath: ["Seed Artist", "Beyoncé"],
      },
    });
    currentClient().lookupArtists.mockResolvedValue([
      {
        kind: "artist",
        foreignId: FOREIGN_ARTIST_ID_1,
        name: "Beyonce Knowles",
      },
    ]);

    const result = await execute({ recommendations: [recommendation] });

    expect(result.status).toBe("plan-created");
    if (result.status !== "plan-created") throw new Error("expected an artist-add plan");
    expect(result.plan.entries[0]).toMatchObject({
      artistName: "Beyoncé",
      foreignArtistId: FOREIGN_ARTIST_ID_1,
      provenance: { firstPath: ["Seed Artist", "Beyoncé"] },
    });
    expect(currentClient().lookupArtists).toHaveBeenCalledWith({
      mode: "artist",
      term: `lidarr:${FOREIGN_ARTIST_ID_1}`,
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the former single recommendation input and result aliases compatible", async () => {
    currentClient().getArtistByForeignId.mockResolvedValue(
      createLidarrArtistFixture({ id: 19, foreignArtistId: FOREIGN_ARTIST_ID_1 }),
    );
    const output = await makeOutput();

    const result = await executeLidarrArtistAddPlan({
      recommendation: recommendation1,
      seedArtist: "Seed Artist",
      discoveredAt: "2026-07-25T11:59:00.000Z",
      rootFolder: "/music",
      qualityProfile: "Lossless",
      metadataProfile: "7",
      output,
    });

    expect(result).toEqual({
      status: "already-present",
      planned: [],
      alreadyPresent: [{ selectedRank: 1, foreignArtistId: FOREIGN_ARTIST_ID_1, lidarrId: 19 }],
      foreignArtistId: FOREIGN_ARTIST_ID_1,
      lidarrId: 19,
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes nothing when every selected candidate is already present", async () => {
    currentClient().getArtistByForeignId.mockImplementation(async (foreignArtistId) =>
      createLidarrArtistFixture({
        id: foreignArtistId === FOREIGN_ARTIST_ID_1 ? 19 : 20,
        foreignArtistId,
      }),
    );
    const output = await makeOutput();

    const result = await execute({
      recommendations: [recommendation1, recommendation2],
      output,
    });

    expect(result.status).toBe("already-present");
    expect(result.planned).toEqual([]);
    expect(result.alreadyPresent).toEqual([
      { selectedRank: 1, foreignArtistId: FOREIGN_ARTIST_ID_1, lidarrId: 19 },
      { selectedRank: 2, foreignArtistId: FOREIGN_ARTIST_ID_2, lidarrId: 20 },
    ]);
    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(2);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(2);
    expect(currentClient().listRootFolders).toHaveBeenCalledTimes(1);
    expect(currentClient().listQualityProfiles).toHaveBeenCalledTimes(1);
    expect(currentClient().listMetadataProfileDetails).toHaveBeenCalledTimes(1);
    expect(currentClient().addArtist).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no partial plan when a later exact lookup is ambiguous", async () => {
    currentClient().lookupArtists.mockImplementation(async ({ term }) => {
      const foreignArtistId = foreignArtistIdFromLookupTerm(term);
      const candidate = {
        kind: "artist" as const,
        foreignId: foreignArtistId,
        name: `Authoritative ${foreignArtistId.slice(0, 8)}`,
      };
      return foreignArtistId === FOREIGN_ARTIST_ID_2
        ? [candidate, { ...candidate, name: "Duplicate" }]
        : [candidate];
    });
    const output = await makeOutput();

    await expect(
      execute({
        recommendations: [recommendation1, recommendation2],
        output,
      }),
    ).rejects.toThrow(
      `Lidarr exact artist lookup for ${FOREIGN_ARTIST_ID_2} was missing or ambiguous`,
    );
    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(2);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(2);
    expect(currentClient().addArtist).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes no partial plan when any candidate read fails", async () => {
    currentClient().getArtistByForeignId.mockImplementation(async (foreignArtistId) => {
      if (foreignArtistId === FOREIGN_ARTIST_ID_2) {
        throw new Error("targeted read failed");
      }
      return undefined;
    });
    const output = await makeOutput();

    await expect(
      execute({
        recommendations: [recommendation1, recommendation2],
        output,
      }),
    ).rejects.toThrow("targeted read failed");
    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(2);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(2);
    expect(currentClient().addArtist).not.toHaveBeenCalled();
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries only the failed candidate task before considering it terminal", async () => {
    mockResolveScheduler.mockReturnValue(
      createLidarrScheduler(
        resolveLidarrSchedulerPolicy({
          lanes: { "metadata-dependent": { retryAttempts: 1 } },
        }),
        { delay: async () => undefined, random: () => 0 },
      ),
    );
    currentClient().lookupArtists.mockImplementationOnce(async () => {
      throw new LidarrUnreachableError("lidarr plan artist-add candidate");
    });

    await execute({ recommendations: [recommendation1, recommendation2] });

    expect(currentClient().lookupArtists).toHaveBeenCalledTimes(3);
    expect(currentClient().getArtistByForeignId).toHaveBeenCalledTimes(2);
    expect(currentClient().listRootFolders).toHaveBeenCalledOnce();
    expect(currentClient().listQualityProfiles).toHaveBeenCalledOnce();
    expect(currentClient().listMetadataProfileDetails).toHaveBeenCalledOnce();
  });

  it("runs one metadata preflight before the complete read set", async () => {
    const order: string[] = [];
    mockPreflight.mockImplementation(async () => {
      order.push("preflight");
    });
    currentClient().lookupArtists.mockImplementation(async ({ term }) => {
      order.push(`lookup:${foreignArtistIdFromLookupTerm(term)}`);
      const foreignArtistId = foreignArtistIdFromLookupTerm(term);
      return [{ kind: "artist", foreignId: foreignArtistId, name: "Authoritative Name" }];
    });

    await execute({ recommendations: [recommendation1, recommendation2] });

    expect(mockPreflight).toHaveBeenCalledOnce();
    expect(order[0]).toBe("preflight");
    expect(mockResolveContext).toHaveBeenCalledWith(
      { lidarrUrl: undefined, lidarrApiKey: undefined },
      { tier: "metadata-dependent", retryAttemptsOverride: 0 },
    );
  });
});
