import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrScheduler, resolveLidarrSchedulerPolicy } from "../../lib/lidarr/scheduler.js";
import type {
  LastFmClient,
  LastFmSimilarArtist,
  LastFmSimilarArtistResult,
} from "../../types/discovery.js";

const mocks = vi.hoisted(() => ({
  createLastFmClient: vi.fn(),
  getLoadedConfig: vi.fn(),
  resolveLidarrScheduler: vi.fn(),
  resolveRequiredLidarrClient: vi.fn(),
  resolveRequiredLidarrExecutionContext: vi.fn(),
  executeLidarrArtistAddPlan: vi.fn(),
}));

vi.mock("../../lib/discovery/lastfm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/discovery/lastfm.js")>();
  return {
    ...actual,
    createLastFmClient: mocks.createLastFmClient,
  };
});

vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedConfig: mocks.getLoadedConfig,
}));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: mocks.resolveLidarrScheduler,
  resolveRequiredLidarrClient: mocks.resolveRequiredLidarrClient,
  resolveRequiredLidarrExecutionContext: mocks.resolveRequiredLidarrExecutionContext,
}));

vi.mock("./plan-artist-add.js", () => ({
  executeLidarrArtistAddPlan: mocks.executeLidarrArtistAddPlan,
}));

import { LastFmProviderError } from "../../lib/discovery/lastfm.js";
import { TIER, executeLidarrDiscover } from "./discover.js";

const ROOT_FETCHED_AT = "2026-07-26T12:00:00.000Z";
const HANDOFF_RESOURCES = Object.freeze({
  rootFolder: "/music",
  qualityProfile: "Lossless",
  metadataProfile: "Standard",
  planFile: "/tmp/add.json",
});

function mbid(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}

function recommendation(
  name: string,
  similarity: number,
  musicBrainzId?: string,
): LastFmSimilarArtist {
  return Object.freeze({
    name,
    similarity,
    ...(musicBrainzId === undefined ? {} : { musicBrainzId }),
    sourceUrl: `https://www.last.fm/music/${encodeURIComponent(name)}`,
  });
}

function providerResult(
  requestedName: string,
  recommendations: readonly LastFmSimilarArtist[],
  options: {
    readonly resolvedName?: string;
    readonly fetchedAt?: string;
  } = {},
): LastFmSimilarArtistResult {
  const resolvedName = options.resolvedName ?? requestedName;
  return Object.freeze({
    requestedName,
    resolvedName,
    autocorrected: resolvedName !== requestedName,
    recommendations: Object.freeze(recommendations),
    source: Object.freeze({
      provider: "lastfm" as const,
      method: "artist.getSimilar" as const,
      attribution: "Recommendations provided by Last.fm" as const,
      url: "https://www.last.fm/" as const,
      fetchedAt: options.fetchedAt ?? ROOT_FETCHED_AT,
    }),
  });
}

let getSimilarArtists: ReturnType<typeof vi.fn<LastFmClient["getSimilarArtists"]>>;

beforeEach(() => {
  vi.clearAllMocks();
  getSimilarArtists = vi.fn<LastFmClient["getSimilarArtists"]>();
  mocks.createLastFmClient.mockReturnValue(
    Object.freeze({ getSimilarArtists }) satisfies LastFmClient,
  );
  mocks.getLoadedConfig.mockReturnValue({
    discovery: { lastfm: { apiKey: "test-key", timeoutMs: 5_000 } },
  });
  mocks.resolveLidarrScheduler.mockReturnValue(
    createLidarrScheduler(
      resolveLidarrSchedulerPolicy({ lanes: { discovery: { retryAttempts: 0 } } }),
    ),
  );
});

describe("executeLidarrDiscover", () => {
  it("declares the discovery tier and rejects invalid policy before resolving dependencies", async () => {
    expect(TIER).toBe("discovery");

    await expect(
      executeLidarrDiscover({ artist: "Radiohead", minSimilarity: Number.NaN }),
    ).rejects.toMatchObject({ code: "validation" });

    expect(mocks.getLoadedConfig).not.toHaveBeenCalled();
    expect(mocks.createLastFmClient).not.toHaveBeenCalled();
    expect(mocks.resolveLidarrScheduler).not.toHaveBeenCalled();
  });

  it.each([
    ["empty ranks", { selectedRanks: [], ...HANDOFF_RESOURCES }, 2],
    ["non-integer rank", { selectedRanks: [1.5], ...HANDOFF_RESOURCES }, 2],
    ["rank above the visible bound", { selectedRanks: [101], ...HANDOFF_RESOURCES }, 2],
    ["duplicate ranks", { selectedRanks: [1, 1], ...HANDOFF_RESOURCES }, 2],
    ["selection above max-add", { selectedRanks: [1, 2], ...HANDOFF_RESOURCES }, 1],
    ["empty root folder", { selectedRanks: [1], ...HANDOFF_RESOURCES, rootFolder: " \t " }, 2],
    [
      "terminal-unsafe profile",
      { selectedRanks: [1], ...HANDOFF_RESOURCES, qualityProfile: "Lossless\u001b[2J" },
      2,
    ],
    [
      "oversized metadata profile",
      { selectedRanks: [1], ...HANDOFF_RESOURCES, metadataProfile: "m".repeat(2_049) },
      2,
    ],
    [
      "terminal-unsafe plan path",
      { selectedRanks: [1], ...HANDOFF_RESOURCES, planFile: "plan\nunsafe.json" },
      2,
    ],
    [
      "oversized plan path",
      { selectedRanks: [1], ...HANDOFF_RESOURCES, planFile: "p".repeat(4_097) },
      2,
    ],
  ] as const)(
    "rejects direct-call %s before resolving any dependency",
    async (_label, handoff, maxAdd) => {
      await expect(
        executeLidarrDiscover({
          artist: "Radiohead",
          maxAdd,
          handoff,
        } as Parameters<typeof executeLidarrDiscover>[0]),
      ).rejects.toMatchObject({ code: "validation" });

      expect(mocks.getLoadedConfig).not.toHaveBeenCalled();
      expect(mocks.createLastFmClient).not.toHaveBeenCalled();
      expect(mocks.resolveLidarrScheduler).not.toHaveBeenCalled();
      expect(getSimilarArtists).not.toHaveBeenCalled();
      expect(mocks.executeLidarrArtistAddPlan).not.toHaveBeenCalled();
    },
  );

  it("keeps the default to one attributed request and applies threshold-before-per-seed admission", async () => {
    getSimilarArtists.mockResolvedValue(
      providerResult(
        "Radiohead",
        Array.from({ length: 12 }, (_, index) =>
          recommendation(`Artist ${index + 1}`, 1 - index / 100, mbid(index + 1)),
        ),
      ),
    );

    const result = await executeLidarrDiscover({ artist: "  Radiohead  " });

    expect(getSimilarArtists).toHaveBeenCalledOnce();
    expect(getSimilarArtists).toHaveBeenCalledWith({
      artist: "Radiohead",
      limit: 15,
      autocorrect: true,
    });
    expect(result.policy).toEqual({
      minSimilarity: 0,
      maxPerSeed: 10,
      deep: false,
      cascade: true,
      maxDepth: 1,
      diversityBoost: 0,
      popularityDampening: 0,
      maxAdd: 1,
    });
    expect(result.traversal).toEqual({
      seedsRequested: 1,
      requestsMade: 1,
      maximumDepthReached: 1,
      visited: 1,
      visible: 10,
      filtered: 2,
      duplicatePaths: 0,
    });
    expect(result.recommendations.map(({ name }) => name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Artist ${index + 1}`),
    );
    expect(result.recommendations[0]).toMatchObject({
      rank: 1,
      similarity: 1,
      rawSimilarity: 1,
      adjustedScore: 1,
      exposureCount: 1,
      status: "quarantined",
      reason: "not-selected",
      provenance: {
        seedArtist: "Radiohead",
        parentArtist: "Radiohead",
        depth: 1,
        providerRank: 1,
        firstSeenSequence: 1,
        firstPath: ["Radiohead", "Artist 1"],
        discoveredAt: ROOT_FETCHED_AT,
      },
    });
    expect(result.source).toMatchObject({
      provider: "lastfm",
      attribution: "Recommendations provided by Last.fm",
    });
    expect(result.execution).toEqual({
      taskId: "lidarr-discover",
      operation: "lidarr discover",
      lane: "discovery",
      outcome: "succeeded",
      attempts: 1,
    });
    expect(result.handoff).toEqual({
      status: "not-requested",
      approvals: [],
      counts: { approved: 0, alreadyPresent: 0, planned: 0, failed: 0 },
    });
  });

  it("performs exactly two bounded breadth-first waves when deep traversal is enabled", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) => {
      switch (artist) {
        case "Radiohead":
          return providerResult(artist, [
            recommendation("A", 0.9, mbid(1)),
            recommendation("B", 0.8, mbid(2)),
            recommendation("C", 0.7, mbid(3)),
          ]);
        case "A":
          return providerResult(artist, [recommendation("A child", 0.6, mbid(4))]);
        case "B":
          return providerResult(artist, [recommendation("B child", 0.5, mbid(5))]);
        default:
          throw new Error(`unexpected seed ${artist}`);
      }
    });

    const result = await executeLidarrDiscover({
      artist: "Radiohead",
      deep: true,
      maxPerSeed: 2,
    });

    expect(getSimilarArtists).toHaveBeenCalledTimes(3);
    expect(getSimilarArtists.mock.calls.map(([query]) => query.artist)).toEqual([
      "Radiohead",
      "A",
      "B",
    ]);
    expect(result.recommendations.map(({ name }) => name)).toEqual([
      "A",
      "B",
      "A child",
      "B child",
    ]);
    expect(result.traversal).toEqual({
      seedsRequested: 3,
      requestsMade: 3,
      maximumDepthReached: 2,
      visited: 3,
      visible: 4,
      filtered: 1,
      duplicatePaths: 0,
    });
    expect(result.recommendations.filter(({ provenance }) => provenance.depth === 2)).toHaveLength(
      2,
    );
  });

  it("prevents cycles and duplicate scheduling while retaining duplicate-path exposure", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) => {
      switch (artist) {
        case "Radiohead":
          return providerResult(artist, [
            recommendation("A", 0.9, mbid(1)),
            recommendation("B", 0.8, mbid(2)),
          ]);
        case "A":
          return providerResult(artist, [
            recommendation("B alias", 0.95, mbid(2)),
            recommendation("radioHEAD", 0.9),
            recommendation("X", 0.7, mbid(3)),
          ]);
        case "B":
          return providerResult(artist, [
            recommendation("A alias", 0.99, mbid(1)),
            recommendation("X alias", 0.98, mbid(3)),
          ]);
        default:
          throw new Error(`unexpected seed ${artist}`);
      }
    });

    const result = await executeLidarrDiscover({ artist: "Radiohead", deep: true });

    expect(getSimilarArtists.mock.calls.map(([query]) => query.artist)).toEqual([
      "Radiohead",
      "A",
      "B",
    ]);
    expect(result.recommendations.map(({ name }) => name)).toEqual(["A", "B", "X"]);
    expect(result.recommendations.map(({ exposureCount }) => exposureCount)).toEqual([2, 2, 2]);
    expect(result.traversal).toMatchObject({
      visited: 3,
      visible: 3,
      duplicatePaths: 4,
    });
    expect(result.recommendations.find(({ name }) => name === "X")?.provenance).toMatchObject({
      parentArtist: "A",
      firstPath: ["Radiohead", "A", "X"],
      providerRank: 3,
    });
  });

  it("treats the requested and autocorrected initial seed names as one visited slot", async () => {
    getSimilarArtists.mockResolvedValue(
      providerResult("Beatles", [recommendation("THE BEATLES", 1, mbid(1))], {
        resolvedName: "The Beatles",
      }),
    );

    const result = await executeLidarrDiscover({ artist: "Beatles", deep: true });

    expect(getSimilarArtists).toHaveBeenCalledOnce();
    expect(result.seed).toMatchObject({
      requestedName: "Beatles",
      resolvedName: "The Beatles",
      autocorrected: true,
    });
    expect(result.recommendations).toHaveLength(0);
    expect(result.traversal).toMatchObject({
      seedsRequested: 1,
      requestsMade: 1,
      visited: 1,
      visible: 0,
      duplicatePaths: 1,
    });
  });

  it("schedules one request slot for mixed name-only and MBID observations", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) =>
      artist === "Radiohead"
        ? providerResult(artist, [recommendation("A", 0.9), recommendation("a", 0.8, mbid(1))])
        : providerResult(artist, []),
    );

    const result = await executeLidarrDiscover({ artist: "Radiohead", deep: true });

    expect(getSimilarArtists.mock.calls.map(([query]) => query.artist)).toEqual(["Radiohead", "A"]);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      name: "A",
      musicBrainzId: mbid(1),
      exposureCount: 2,
      addEligibility: "exact-id",
    });
    expect(result.traversal).toMatchObject({
      seedsRequested: 2,
      requestsMade: 2,
      visited: 2,
      visible: 1,
      duplicatePaths: 1,
    });
  });

  it("schedules one request slot when an exact-MBID alias is later observed without an MBID", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) =>
      artist === "Radiohead"
        ? providerResult(artist, [
            recommendation("Official Name", 0.9, mbid(1)),
            recommendation("Alias Name", 0.8, mbid(1)),
            recommendation("Alias Name", 0.7),
          ])
        : providerResult(artist, []),
    );

    const result = await executeLidarrDiscover({ artist: "Radiohead", deep: true });

    expect(getSimilarArtists.mock.calls.map(([query]) => query.artist)).toEqual([
      "Radiohead",
      "Official Name",
    ]);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      name: "Official Name",
      musicBrainzId: mbid(1),
      exposureCount: 3,
    });
    expect(result.traversal).toMatchObject({
      seedsRequested: 2,
      requestsMade: 2,
      visited: 2,
      visible: 1,
      duplicatePaths: 2,
    });
  });

  it("enforces invocation request and visited budgets before scheduling new seeds", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) =>
      artist === "Radiohead"
        ? providerResult(
            artist,
            Array.from({ length: 100 }, (_, index) =>
              recommendation(`Seed ${index + 1}`, 1 - index / 1_000, mbid(index + 1)),
            ),
          )
        : providerResult(artist, []),
    );

    const result = await executeLidarrDiscover({
      artist: "Radiohead",
      limit: 100,
      maxPerSeed: 100,
      deep: true,
    });

    expect(getSimilarArtists).toHaveBeenCalledTimes(25);
    expect(getSimilarArtists.mock.calls.slice(1).map(([query]) => query.artist)).toEqual(
      Array.from({ length: 24 }, (_, index) => `Seed ${index + 1}`),
    );
    expect(result.traversal).toMatchObject({
      seedsRequested: 25,
      requestsMade: 25,
      visited: 25,
      visible: 100,
      maximumDepthReached: 2,
    });
  });

  it("turns a structured child-wave failure back into a classified provider error", async () => {
    getSimilarArtists.mockImplementation(async ({ artist }) => {
      if (artist === "Radiohead") {
        return providerResult(artist, [
          recommendation("A", 0.9, mbid(1)),
          recommendation("B", 0.8, mbid(2)),
        ]);
      }
      if (artist === "A") return providerResult(artist, []);
      throw new LastFmProviderError(
        "discovery-provider-unavailable",
        "Last.fm is unavailable",
        true,
        { statusCode: 503 },
      );
    });

    const thrown = await executeLidarrDiscover({ artist: "Radiohead", deep: true }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(LastFmProviderError);
    expect(thrown).toMatchObject({
      code: "discovery-provider-unavailable",
      retryable: true,
      statusCode: 503,
    });
    expect(getSimilarArtists).toHaveBeenCalledTimes(3);
  });

  it("propagates caller cancellation and admits no later wave", async () => {
    const controller = new AbortController();
    const cancellation = new DOMException("cancelled by caller", "AbortError");
    getSimilarArtists.mockImplementation(async ({ artist, signal }) => {
      expect(signal).toBe(controller.signal);
      const result = providerResult(artist, [recommendation("A", 0.9, mbid(1))]);
      controller.abort(cancellation);
      return result;
    });

    await expect(
      executeLidarrDiscover({
        artist: "Radiohead",
        deep: true,
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(getSimilarArtists).toHaveBeenCalledOnce();
  });

  it("keeps first-seen evidence deterministic when child requests finish out of order", async () => {
    let resolveA: ((result: LastFmSimilarArtistResult) => void) | undefined;
    getSimilarArtists.mockImplementation(async ({ artist }) => {
      if (artist === "Radiohead") {
        return providerResult(artist, [
          recommendation("A", 0.9, mbid(1)),
          recommendation("B", 0.8, mbid(2)),
        ]);
      }
      if (artist === "A") {
        return await new Promise<LastFmSimilarArtistResult>((resolve) => {
          resolveA = resolve;
        });
      }
      if (resolveA === undefined) throw new Error("A request was not scheduled first");
      queueMicrotask(() => {
        resolveA?.(
          providerResult("A", [recommendation("X", 0.5, mbid(3))], {
            fetchedAt: "2026-07-26T12:01:00.000Z",
          }),
        );
      });
      return providerResult("B", [recommendation("Y", 0.5, mbid(4))], {
        fetchedAt: "2026-07-26T12:00:30.000Z",
      });
    });

    const result = await executeLidarrDiscover({ artist: "Radiohead", deep: true });

    expect(result.recommendations.map(({ name }) => name)).toEqual(["A", "B", "X", "Y"]);
    expect(
      result.recommendations.slice(2).map(({ provenance }) => ({
        firstSeenSequence: provenance.firstSeenSequence,
        firstPath: provenance.firstPath,
        discoveredAt: provenance.discoveredAt,
      })),
    ).toEqual([
      {
        firstSeenSequence: 3,
        firstPath: ["Radiohead", "A", "X"],
        discoveredAt: "2026-07-26T12:01:00.000Z",
      },
      {
        firstSeenSequence: 4,
        firstPath: ["Radiohead", "B", "Y"],
        discoveredAt: "2026-07-26T12:00:30.000Z",
      },
    ]);
  });

  it("keeps preview isolated from Lidarr resolution, plan production, and filesystem handoff", async () => {
    getSimilarArtists.mockResolvedValue(
      providerResult("Radiohead", [recommendation("A", 0.9, mbid(1))]),
    );

    const result = await executeLidarrDiscover({ artist: "Radiohead" });

    expect(result.handoff.status).toBe("not-requested");
    expect(mocks.resolveRequiredLidarrClient).not.toHaveBeenCalled();
    expect(mocks.resolveRequiredLidarrExecutionContext).not.toHaveBeenCalled();
    expect(mocks.executeLidarrArtistAddPlan).not.toHaveBeenCalled();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.traversal)).toBe(true);
    expect(Object.isFrozen(result.recommendations)).toBe(true);
    expect(result.recommendations.every(Object.isFrozen)).toBe(true);
  });

  it("approves multiple ranks in visible order and maps mixed aggregate plan evidence once", async () => {
    const controller = new AbortController();
    getSimilarArtists.mockResolvedValue(
      providerResult("Radiohead", [
        recommendation("A", 0.9, mbid(1)),
        recommendation("B", 0.8, mbid(2)),
        recommendation("C", 0.7, mbid(3)),
      ]),
    );
    mocks.executeLidarrArtistAddPlan.mockResolvedValue({
      status: "plan-created",
      planPath: "/tmp/add.json",
      plan: { id: "plan-1", payloadChecksum: "checksum-1" },
      planned: [{ selectedRank: 3, foreignArtistId: mbid(3) }],
      alreadyPresent: [{ selectedRank: 1, foreignArtistId: mbid(1), lidarrId: 101 }],
    });

    const result = await executeLidarrDiscover({
      artist: "Radiohead",
      maxAdd: 3,
      signal: controller.signal,
      handoff: {
        selectedRanks: [3, 1],
        ...HANDOFF_RESOURCES,
      },
    });

    expect(mocks.executeLidarrArtistAddPlan).toHaveBeenCalledOnce();
    expect(mocks.executeLidarrArtistAddPlan).toHaveBeenCalledWith({
      recommendations: [
        expect.objectContaining({ rank: 1, status: "approved", reason: "selected" }),
        expect.objectContaining({ rank: 3, status: "approved", reason: "selected" }),
      ],
      seedArtist: "Radiohead",
      discoveredAt: ROOT_FETCHED_AT,
      rootFolder: "/music",
      qualityProfile: "Lossless",
      metadataProfile: "Standard",
      output: "/tmp/add.json",
      lidarrUrl: undefined,
      lidarrApiKey: undefined,
      signal: controller.signal,
    });
    expect(result.recommendations.map(({ rank, status }) => ({ rank, status }))).toEqual([
      { rank: 1, status: "approved" },
      { rank: 2, status: "quarantined" },
      { rank: 3, status: "approved" },
    ]);
    expect(result.handoff).toEqual({
      status: "plan-created",
      selectedRank: 1,
      selectedRanks: [1, 3],
      musicBrainzId: mbid(1),
      approvals: [
        {
          status: "already-present",
          selectedRank: 1,
          musicBrainzId: mbid(1),
          lidarrId: 101,
        },
        { status: "planned", selectedRank: 3, musicBrainzId: mbid(3) },
      ],
      counts: { approved: 2, alreadyPresent: 1, planned: 1, failed: 0 },
      planId: "plan-1",
      planChecksum: "checksum-1",
      planPath: "/tmp/add.json",
      nextCommand: "rfmedia lidarr apply '/tmp/add.json'",
    });
    expect(mocks.resolveRequiredLidarrClient).not.toHaveBeenCalled();
    expect(mocks.resolveRequiredLidarrExecutionContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a valid first rank followed by an ineligible rank",
      selectedRanks: [1, 2],
      maxAdd: 2,
      code: "identity-required",
    },
    {
      label: "a valid first rank followed by a missing rank",
      selectedRanks: [1, 4],
      maxAdd: 2,
      code: "candidate-not-found",
    },
  ] as const)(
    "rejects $label atomically before invoking the plan producer",
    async ({ selectedRanks, maxAdd, code }) => {
      getSimilarArtists.mockResolvedValue(
        providerResult("Radiohead", [
          recommendation("A", 0.9, mbid(1)),
          recommendation("B", 0.8),
          recommendation("C", 0.7, mbid(3)),
        ]),
      );

      const result = await executeLidarrDiscover({
        artist: "Radiohead",
        maxAdd,
        handoff: {
          selectedRanks,
          ...HANDOFF_RESOURCES,
        },
      });

      expect(result.handoff).toMatchObject({
        status: "failed",
        selectedRank: 1,
        selectedRanks,
        code,
        retryable: false,
        approvals: [
          { status: "failed", selectedRank: 1, musicBrainzId: mbid(1), code },
          { status: "failed", selectedRank: selectedRanks[1], code },
        ],
        counts: { approved: 0, alreadyPresent: 0, planned: 0, failed: 2 },
      });
      expect(result.recommendations.every(({ status }) => status !== "approved")).toBe(true);
      expect(mocks.executeLidarrArtistAddPlan).not.toHaveBeenCalled();
    },
  );

  it("reports every approved candidate when the aggregate plan is already satisfied", async () => {
    getSimilarArtists.mockResolvedValue(
      providerResult("Radiohead", [
        recommendation("A", 0.9, mbid(1)),
        recommendation("B", 0.8, mbid(2)),
      ]),
    );
    mocks.executeLidarrArtistAddPlan.mockResolvedValue({
      status: "already-present",
      planned: [],
      alreadyPresent: [
        { selectedRank: 1, foreignArtistId: mbid(1), lidarrId: 101 },
        { selectedRank: 2, foreignArtistId: mbid(2), lidarrId: 202 },
      ],
      foreignArtistId: mbid(1),
      lidarrId: 101,
    });

    const result = await executeLidarrDiscover({
      artist: "Radiohead",
      maxAdd: 2,
      handoff: {
        selectedRanks: [2, 1],
        ...HANDOFF_RESOURCES,
      },
    });

    expect(mocks.executeLidarrArtistAddPlan).toHaveBeenCalledOnce();
    expect(result.handoff).toEqual({
      status: "already-present",
      selectedRank: 1,
      selectedRanks: [1, 2],
      musicBrainzId: mbid(1),
      lidarrId: 101,
      approvals: [
        {
          status: "already-present",
          selectedRank: 1,
          musicBrainzId: mbid(1),
          lidarrId: 101,
        },
        {
          status: "already-present",
          selectedRank: 2,
          musicBrainzId: mbid(2),
          lidarrId: 202,
        },
      ],
      counts: { approved: 2, alreadyPresent: 2, planned: 0, failed: 0 },
    });
  });

  it("preserves the approved attributed preview when aggregate planning fails", async () => {
    const lidarrKey = "lidarr-secret";
    getSimilarArtists.mockResolvedValue(
      providerResult("Radiohead", [
        recommendation("A", 0.9, mbid(1)),
        recommendation("B", 0.8, mbid(2)),
      ]),
    );
    mocks.executeLidarrArtistAddPlan.mockRejectedValue(
      Object.assign(new Error(`planning failed with ${lidarrKey}`), { retryable: true }),
    );

    const result = await executeLidarrDiscover({
      artist: "Radiohead",
      maxAdd: 2,
      handoff: {
        selectedRanks: [2, 1],
        ...HANDOFF_RESOURCES,
        lidarrApiKey: lidarrKey,
      },
    });

    expect(mocks.executeLidarrArtistAddPlan).toHaveBeenCalledOnce();
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations.every(({ status }) => status === "approved")).toBe(true);
    expect(result.source.attribution).toBe("Recommendations provided by Last.fm");
    expect(result.handoff).toMatchObject({
      status: "failed",
      selectedRank: 1,
      selectedRanks: [1, 2],
      code: "lidarr-plan-failed",
      retryable: true,
      approvals: [
        { status: "failed", selectedRank: 1, musicBrainzId: mbid(1) },
        { status: "failed", selectedRank: 2, musicBrainzId: mbid(2) },
      ],
      counts: { approved: 2, alreadyPresent: 0, planned: 0, failed: 2 },
    });
    if (result.handoff.status !== "failed") throw new Error("expected failed handoff");
    expect(result.handoff.message).toContain("[REDACTED]");
    expect(result.handoff.message).not.toContain(lidarrKey);
  });
});
