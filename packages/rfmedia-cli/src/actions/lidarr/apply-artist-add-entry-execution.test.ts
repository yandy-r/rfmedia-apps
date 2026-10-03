import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildLidarrArtistAddPlanV2 } from "../../lib/lidarr/plan-engine.js";
import type { LidarrScheduledTask, LidarrTier } from "../../lib/lidarr/index.js";
import { LIDARR_PLAN_MAX_ENTRIES } from "../../types/lidarr-plan.js";
import type {
  LidarrArtistAddNormalizationPendingHistoryRecord,
  LidarrArtistAddNormalizationVerificationPendingHistoryRecord,
  LidarrArtistAddPlanEntryV2,
  LidarrArtistAddPlanV2,
  LidarrPlanHistoryRecord,
} from "../../types/lidarr-plan.js";
import { createLidarrClientMock } from "../test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
} from "../test-helpers/lidarr-fixtures.js";

const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async <T>(
      lane: LidarrTier,
      task: LidarrScheduledTask<T>,
      options?: {
        readonly signal?: AbortSignal;
        readonly preflight?: (input: {
          readonly lane: LidarrTier;
          readonly signal?: AbortSignal;
        }) => Promise<void>;
      },
    ) => {
      await options?.preflight?.({ lane, signal: options.signal });
      return {
        value: await task.run({ attempt: 1, signal: options?.signal }),
        execution: {
          taskId: task.id,
          operation: task.operation,
          lane,
          outcome: "succeeded" as const,
          attempts: 1,
        },
      };
    },
  ),
);

vi.mock("../../lib/lidarr/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/lidarr/index.js")>();
  return {
    ...actual,
    resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  };
});

import {
  classifyLidarrArtistAddTargetState,
  executeLidarrArtistAddApplyEntry,
} from "./apply-artist-add-entry-execution.js";

const FOREIGN_ARTIST_ID = "11111111-1111-4111-8111-111111111111";

function makePlan() {
  return buildLidarrArtistAddPlanV2(
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
        foreignArtistId: FOREIGN_ARTIST_ID,
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
    { randomUUID: () => "22222222-2222-4222-8222-222222222222" },
  );
}

function makeExtendedPlan(selectors: readonly string[] = ["singles"]) {
  return buildLidarrArtistAddPlanV2(
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
        postAddUnmonitorSelectors: selectors,
      },
      entry: {
        artistName: "Exact Artist",
        foreignArtistId: FOREIGN_ARTIST_ID,
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
    { randomUUID: () => "22222222-2222-4222-8222-222222222222" },
  );
}

function desiredArtist(overrides = {}) {
  return createLidarrArtistFixture({
    id: 42,
    artistName: "Exact Artist",
    foreignArtistId: FOREIGN_ARTIST_ID,
    monitored: false,
    monitorNewItems: "none",
    qualityProfileId: 5,
    metadataProfileId: 7,
    path: "/music/Exact Artist",
    ...overrides,
  });
}

function normalizationPendingHistory(
  plan: LidarrArtistAddPlanV2,
  lidarrId = 42,
): LidarrArtistAddNormalizationPendingHistoryRecord {
  const entry = plan.entries[0];
  return {
    planId: plan.id,
    planChecksum: plan.payloadChecksum,
    entryId: entry.id,
    foreignArtistId: entry.foreignArtistId,
    lidarrId,
    recordedAt: "2026-07-25T12:00:00.000Z",
    outcome: "creation-verified-normalization-pending",
    idempotencyKey: entry.idempotencyKey,
  };
}

function normalizationVerificationHistory(
  plan: LidarrArtistAddPlanV2,
  lidarrId = 42,
): LidarrArtistAddNormalizationVerificationPendingHistoryRecord {
  const pending = normalizationPendingHistory(plan, lidarrId);
  return {
    ...pending,
    outcome: "normalization-verification-pending",
    albumIds: [10],
  };
}

function makeArgs(
  client: ReturnType<typeof createLidarrClientMock>,
  overrides: {
    readonly plan?: LidarrArtistAddPlanV2;
    readonly resumePossibleDispatch?: boolean;
    readonly resumePossibleDispatchLidarrId?: number;
    readonly resumeNormalizationHistory?:
      | LidarrArtistAddNormalizationPendingHistoryRecord
      | LidarrArtistAddNormalizationVerificationPendingHistoryRecord;
    readonly appendHistory?: ReturnType<
      typeof vi.fn<(record: LidarrPlanHistoryRecord) => Promise<void>>
    >;
    readonly assertOwned?: ReturnType<typeof vi.fn<() => Promise<void>>>;
    readonly preflight?: ReturnType<
      typeof vi.fn<(input: { readonly lane: LidarrTier }) => Promise<void>>
    >;
    readonly signal?: AbortSignal;
  } = {},
) {
  const plan = overrides.plan ?? makePlan();
  return {
    plan,
    planPath: "/review/add.json",
    entry: plan.entries[0],
    client,
    preflight: overrides.preflight ?? vi.fn(async () => undefined),
    execution: {
      taskId: "preflight",
      operation: "lidarr apply artist-add preflight",
      lane: "local-only" as const,
      outcome: "succeeded" as const,
      attempts: 1,
    },
    historyPath: "/history/add.jsonl",
    signal: overrides.signal,
    assertOwned: overrides.assertOwned ?? vi.fn(async () => undefined),
    resumePossibleDispatch: overrides.resumePossibleDispatch ?? false,
    resumePossibleDispatchLidarrId: overrides.resumePossibleDispatchLidarrId,
    resumeNormalizationHistory: overrides.resumeNormalizationHistory,
    appendHistory: overrides.appendHistory ?? vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeLidarrArtistAddApplyEntry", () => {
  it("records exact desired presence as satisfied without dispatch", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
    });
    const args = makeArgs(client);

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      foreignArtistId: FOREIGN_ARTIST_ID,
      lidarrId: 42,
      outcome: "satisfied",
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory).toHaveBeenCalledOnce();
    expect(args.appendHistory.mock.calls[0]?.[0]).toMatchObject({ outcome: "satisfied" });
  });

  it("blocks conflicting policy as drift without dispatch or history", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist({ monitored: true }),
    });
    const args = makeArgs(client);

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "blocked-stale",
      errorCode: "artist-state-drift",
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory).not.toHaveBeenCalled();
  });

  it("blocks a conflicting new-item monitoring policy without dispatch or history", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist({ monitorNewItems: "all" }),
    });
    const args = makeArgs(client);

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "blocked-stale",
      errorCode: "artist-state-drift",
      message: expect.stringContaining("new-item monitoring policy"),
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory).not.toHaveBeenCalled();
  });

  it("prepares identity, persists possible dispatch, sends one POST, and reconciles", async () => {
    const client = createLidarrClientMock();
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    client.addArtist.mockRejectedValueOnce(new Error("connection closed after request"));
    const preflight = vi.fn(async () => undefined);
    const args = makeArgs(client, { preflight });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({ outcome: "succeeded", lidarrId: 42 });
    expect(args.appendHistory.mock.calls.map(([record]) => record.outcome)).toEqual([
      "possibly-dispatched",
      "succeeded",
    ]);
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(mockRunSingle).toHaveBeenCalledWith(
      "metadata-dependent",
      expect.objectContaining({ idempotent: false }),
      expect.objectContaining({ preflight }),
    );
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ lane: "metadata-dependent" }));
  });

  it("records uncertainty and stops when exact-MBID read-back stays absent", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
    });
    const args = makeArgs(client);

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      errorCode: "verification-inconclusive",
      failure: {
        dispatchState: "dispatch-unknown",
        verificationState: "inconclusive",
        safeNextAction: "resume-plan",
      },
    });
    expect(result.stopAdmissions).toBe(true);
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it("reconciles durable resume uncertainty without resending the POST", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
    });
    const args = makeArgs(client, { resumePossibleDispatch: true });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({ outcome: "satisfied", lidarrId: 42 });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory.mock.calls[0]?.[0]).toMatchObject({ outcome: "satisfied" });
  });

  it("persists an uncertain resume when exact-MBID reconciliation is unreadable", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => {
        throw new Error("read unavailable");
      },
    });
    const args = makeArgs(client, { resumePossibleDispatch: true });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      errorCode: "verification-inconclusive",
      failure: { stage: "resume", dispatchState: "dispatch-unknown" },
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory.mock.calls[0]?.[0]).toMatchObject({ outcome: "uncertain" });
  });

  it("stops before POST when claim-bound possible-dispatch history is not durable", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
    });
    const appendHistory = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const args = makeArgs(client, { appendHistory });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "failed",
      errorCode: "history-write-failed",
      failure: { dispatchState: "not-dispatched" },
    });
    expect(result.stopAdmissions).toBe(true);
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.assertOwned).toHaveBeenCalled();
  });

  it.each([
    ["/music/../outside/Artist", "/music"],
    ["/music-other/Artist", "/music"],
    ["C:\\music\\..\\outside\\Artist", "C:\\music"],
    ["C:\\music/Artist", "C:\\music"],
    ["D:\\music\\Artist", "C:\\music"],
  ])("rejects a path outside the normalized root: %s", (artistPath, rootFolderPath) => {
    const plan = makePlan();
    const original = plan.entries[0];
    const entry: LidarrArtistAddPlanEntryV2 =
      "postAddUnmonitorSelectors" in original.after
        ? {
            ...original,
            after: {
              ...original.after,
              rootFolder: { ...original.after.rootFolder, path: rootFolderPath },
            },
          }
        : {
            ...original,
            after: {
              ...original.after,
              rootFolder: { ...original.after.rootFolder, path: rootFolderPath },
            },
          };

    expect(
      classifyLidarrArtistAddTargetState(entry, desiredArtist({ path: artistPath })),
    ).toMatchObject({ state: "drifted" });
  });

  it("keeps health and lookup failures before possible-dispatch evidence", async () => {
    const healthFailureClient = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
    });
    const healthArgs = makeArgs(healthFailureClient, {
      preflight: vi.fn(async () => {
        throw new Error("health unavailable");
      }),
    });
    const healthResult = await executeLidarrArtistAddApplyEntry(healthArgs);

    expect(healthResult.result).toMatchObject({
      outcome: "failed",
      failure: { dispatchState: "not-dispatched" },
    });
    expect(healthArgs.appendHistory.mock.calls.map(([record]) => record.outcome)).toEqual([
      "failed",
    ]);
    expect(healthFailureClient.addArtist).not.toHaveBeenCalled();

    const lookupFailureClient = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
      prepareArtistAdd: async () => {
        throw new Error("lookup failed");
      },
    });
    const lookupArgs = makeArgs(lookupFailureClient);
    const lookupResult = await executeLidarrArtistAddApplyEntry(lookupArgs);

    expect(lookupResult.result).toMatchObject({
      outcome: "failed",
      failure: { dispatchState: "not-dispatched" },
    });
    expect(lookupArgs.appendHistory.mock.calls.map(([record]) => record.outcome)).toEqual([
      "failed",
    ]);
    expect(lookupFailureClient.addArtist).not.toHaveBeenCalled();
  });

  it("keeps claim loss before the marker and POST", async () => {
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
    });
    const args = makeArgs(client, {
      assertOwned: vi.fn(async () => {
        throw new Error("claim lost");
      }),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "failed",
      failure: { dispatchState: "not-dispatched" },
    });
    expect(args.appendHistory).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
  });

  it("initiates the POST if cancellation arrives while the durable marker is publishing", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
      prepareArtistAdd: async (input) => input,
      addArtist: async () => {
        events.push("posted");
        return desiredArtist();
      },
    });
    client.getArtistByForeignId.mockResolvedValueOnce(undefined);
    const args = makeArgs(client, {
      signal: controller.signal,
      appendHistory: vi.fn(async (record) => {
        if (record.outcome === "possibly-dispatched") {
          events.push("marked");
          controller.abort();
        }
      }),
    });

    await executeLidarrArtistAddApplyEntry(args);

    expect(events.slice(0, 2)).toEqual(["marked", "posted"]);
    expect(client.addArtist).toHaveBeenCalledWith(expect.any(Object));
    expect(args.assertOwned).toHaveBeenCalledTimes(2);
  });

  it("completes authoritative preparation before the durable marker and POST", async () => {
    const events: string[] = [];
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => undefined,
      prepareArtistAdd: async (input) => {
        events.push("prepared");
        return input;
      },
      addArtist: async () => {
        events.push("posted");
        return desiredArtist();
      },
    });
    const args = makeArgs(client, {
      appendHistory: vi.fn(async (record) => {
        if (record.outcome === "possibly-dispatched") events.push("marked");
      }),
    });

    await executeLidarrArtistAddApplyEntry(args);

    expect(events.slice(0, 3)).toEqual(["prepared", "marked", "posted"]);
  });

  it("persists both normalization stages, updates matching monitored albums, and verifies", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    client.listAlbums
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: true }),
        createLidarrAlbumFixture({ id: 11, artistId: 42, albumType: "Album", monitored: true }),
      ])
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: false }),
        createLidarrAlbumFixture({ id: 11, artistId: 42, albumType: "Album", monitored: true }),
      ]);
    const args = makeArgs(client, { plan });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "succeeded",
      stage: "completed",
      lidarrId: 42,
    });
    expect(args.appendHistory.mock.calls.map(([record]) => record.outcome)).toEqual([
      "possibly-dispatched",
      "possibly-dispatched",
      "creation-verified-normalization-pending",
      "normalization-verification-pending",
      "succeeded",
    ]);
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([10], false, undefined);
    expect(client.listAlbums).toHaveBeenNthCalledWith(1, { artistId: 42, signal: undefined });
    expect(client.listAlbums).toHaveBeenNthCalledWith(2, { artistId: 42, signal: undefined });
    expect(mockRunSingle).toHaveBeenCalledWith(
      "metadata-dependent",
      expect.objectContaining({
        operation: "lidarr apply artist-add album normalization",
        idempotent: false,
      }),
      expect.objectContaining({ preflight: args.preflight }),
    );
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it("blocks fresh normalization when exact-MBID reconciliation resolves to a replacement ID", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist({ id: 42 }));
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist({ id: 84 }));
    const args = makeArgs(client, { plan });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "create-pending",
      lidarrId: 42,
      errorCode: "artist-state-drift",
    });
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(args.appendHistory.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({ outcome: "possibly-dispatched" }),
      expect.objectContaining({ outcome: "possibly-dispatched", lidarrId: 42 }),
    ]);
  });

  it("stops before reconciliation when the returned create ID is not durable", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist({ id: 42 }));
    client.getArtistByForeignId.mockResolvedValueOnce(undefined);
    const appendHistory = vi.fn(async (record: LidarrPlanHistoryRecord) => {
      if (
        record.outcome === "possibly-dispatched" &&
        "lidarrId" in record &&
        record.lidarrId === 42
      ) {
        throw new Error("history unavailable");
      }
    });
    const args = makeArgs(client, { plan, appendHistory });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "create-pending",
      lidarrId: 42,
      errorCode: "history-write-failed",
    });
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(client.getArtistByForeignId).toHaveBeenCalledOnce();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("never normalizes from an unbound marker after create-identity history failed", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist({ id: 42 }));
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist({ id: 84 }));
    const appendHistory = vi.fn(async (record: LidarrPlanHistoryRecord) => {
      if (
        record.outcome === "possibly-dispatched" &&
        "lidarrId" in record &&
        record.lidarrId === 42
      ) {
        throw new Error("history unavailable");
      }
    });

    const first = await executeLidarrArtistAddApplyEntry(makeArgs(client, { plan, appendHistory }));
    const resumed = await executeLidarrArtistAddApplyEntry(
      makeArgs(client, {
        plan,
        resumePossibleDispatch: true,
        appendHistory,
      }),
    );

    expect(first.result).toMatchObject({
      outcome: "uncertain",
      errorCode: "history-write-failed",
      lidarrId: 42,
    });
    expect(resumed.result).toMatchObject({
      outcome: "uncertain",
      stage: "create-pending",
      errorCode: "verification-inconclusive",
      failure: {
        retryable: false,
        safeNextAction: "review-staleness-and-replan",
      },
    });
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("preserves the bound create ID on resume and never repeats POST for a replacement ID", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist({ id: 84 }),
    });
    const args = makeArgs(client, {
      plan,
      resumePossibleDispatch: true,
      resumePossibleDispatchLidarrId: 42,
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "create-pending",
      lidarrId: 42,
      errorCode: "artist-state-drift",
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(args.appendHistory).not.toHaveBeenCalled();
  });

  it.each([
    [
      "oversized",
      () =>
        Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) =>
          createLidarrAlbumFixture({
            id: index + 1,
            artistId: 42,
            albumType: "Single",
            monitored: true,
          }),
        ),
    ],
    [
      "duplicate-ID",
      () => [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 42,
          albumType: "Single",
          monitored: true,
        }),
        createLidarrAlbumFixture({
          id: 10,
          artistId: 42,
          albumType: "Album",
          monitored: true,
        }),
      ],
    ],
    [
      "wrong-artist",
      () => [
        createLidarrAlbumFixture({
          id: 10,
          artistId: 84,
          albumType: "Single",
          monitored: true,
        }),
      ],
    ],
  ])("rejects an %s album response before normalization mutation", async (_label, albums) => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    client.listAlbums.mockResolvedValueOnce(albums());
    const args = makeArgs(client, { plan });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
      errorCode: "verification-failed",
    });
    expect(client.listAlbums).toHaveBeenCalledOnce();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(args.appendHistory.mock.calls.at(-1)?.[0]).toMatchObject({
      outcome: "creation-verified-normalization-pending",
      lidarrId: 42,
    });
  });

  it("rejects a wrong-artist album response during post-mutation verification", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    client.listAlbums
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({
          id: 10,
          artistId: 42,
          albumType: "Single",
          monitored: true,
        }),
      ])
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({
          id: 10,
          artistId: 84,
          albumType: "Single",
          monitored: false,
        }),
      ]);
    const args = makeArgs(client, { plan });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "normalization-verification-pending",
      errorCode: "verification-failed",
    });
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
    expect(args.appendHistory.mock.calls.at(-1)?.[0]).toMatchObject({
      outcome: "normalization-verification-pending",
      lidarrId: 42,
    });
  });

  it("keeps empty requested artist-scoped album data resumable and non-terminal", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    const args = makeArgs(client, { plan });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
      errorCode: "verification-inconclusive",
    });
    expect(result.stopAdmissions).toBe(true);
    expect(args.appendHistory.mock.calls.map(([record]) => record.outcome)).toEqual([
      "possibly-dispatched",
      "possibly-dispatched",
      "creation-verified-normalization-pending",
    ]);
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
  });

  it("resumes normalization without POST and updates only remaining monitored matches", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
    });
    client.listAlbums
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: false }),
        createLidarrAlbumFixture({ id: 12, artistId: 42, albumType: "Single", monitored: true }),
      ])
      .mockResolvedValueOnce([
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: false }),
        createLidarrAlbumFixture({ id: 12, artistId: 42, albumType: "Single", monitored: false }),
      ]);
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({ outcome: "satisfied", stage: "completed" });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([12], false, undefined);
  });

  it("blocks normalization when exact-MBID resume resolves to a different durable artist ID", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist({ id: 84 }),
    });
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
      lidarrId: 42,
      errorCode: "artist-state-drift",
    });
    expect(client.listAlbums).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(args.appendHistory).not.toHaveBeenCalled();
  });

  it("freshly verifies a non-empty no-change normalization without PUT", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: false }),
      ],
    });
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({ outcome: "satisfied", stage: "completed" });
    expect(client.listAlbums).toHaveBeenCalledTimes(2);
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
  });

  it("keeps PUT failure verification-pending and a later resume never repeats POST", async () => {
    const plan = makeExtendedPlan();
    let monitored = true;
    const client = createLidarrClientMock({
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored }),
      ],
      setAlbumsMonitored: async () => {
        monitored = false;
        throw new Error("response lost");
      },
    });
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId.mockResolvedValueOnce(undefined).mockResolvedValue(desiredArtist());
    const firstArgs = makeArgs(client, { plan });

    const first = await executeLidarrArtistAddApplyEntry(firstArgs);
    const resumed = await executeLidarrArtistAddApplyEntry(
      makeArgs(client, {
        plan,
        resumeNormalizationHistory: normalizationVerificationHistory(plan),
      }),
    );

    expect(first.result).toMatchObject({
      outcome: "uncertain",
      stage: "normalization-verification-pending",
    });
    expect(resumed.result).toMatchObject({ outcome: "satisfied", stage: "completed" });
    expect(client.addArtist).toHaveBeenCalledOnce();
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
  });

  it("preserves normalization evidence across an absent resume and never repeats POST", async () => {
    const plan = makeExtendedPlan();
    const history: LidarrPlanHistoryRecord[] = [];
    const appendHistory = vi.fn(async (record: LidarrPlanHistoryRecord) => {
      history.push(record);
    });
    const unmonitoredSingle = createLidarrAlbumFixture({
      id: 10,
      artistId: 42,
      albumType: "Single",
      monitored: false,
    });
    const client = createLidarrClientMock();
    client.addArtist.mockResolvedValueOnce(desiredArtist());
    client.getArtistByForeignId
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist())
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(desiredArtist());
    client.listAlbums
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([unmonitoredSingle])
      .mockResolvedValueOnce([unmonitoredSingle]);

    const first = await executeLidarrArtistAddApplyEntry(makeArgs(client, { plan, appendHistory }));
    const durable = history.find(
      (record): record is LidarrArtistAddNormalizationPendingHistoryRecord =>
        record.outcome === "creation-verified-normalization-pending",
    );
    expect(durable).toBeDefined();
    if (durable === undefined) throw new Error("Expected durable normalization history");

    const firstResume = await executeLidarrArtistAddApplyEntry(
      makeArgs(client, {
        plan,
        resumeNormalizationHistory: durable,
        appendHistory,
      }),
    );
    expect(history.at(-1)).toBe(durable);

    const secondResume = await executeLidarrArtistAddApplyEntry(
      makeArgs(client, {
        plan,
        resumeNormalizationHistory: durable,
        appendHistory,
      }),
    );

    expect(first.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
    });
    expect(firstResume.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
      lidarrId: 42,
    });
    expect(secondResume.result).toMatchObject({
      outcome: "satisfied",
      stage: "completed",
      lidarrId: 42,
    });
    expect(client.addArtist).toHaveBeenCalledOnce();
  });

  it("reports a fresh verification mismatch without terminal history", async () => {
    const plan = makeExtendedPlan();
    const monitoredSingle = createLidarrAlbumFixture({
      id: 10,
      artistId: 42,
      albumType: "Single",
      monitored: true,
    });
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
      listAlbums: async () => [monitoredSingle],
    });
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "normalization-verification-pending",
      errorCode: "verification-failed",
    });
    expect(args.appendHistory.mock.calls.at(-1)?.[0]).toMatchObject({
      outcome: "normalization-verification-pending",
    });
  });

  it("makes cancellation after the album marker resumable without a second POST", async () => {
    const plan = makeExtendedPlan();
    const controller = new AbortController();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: true }),
      ],
      setAlbumsMonitored: async (_albumIds, _monitored, signal) => {
        signal?.throwIfAborted();
      },
    });
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
      signal: controller.signal,
      appendHistory: vi.fn(async (record: LidarrPlanHistoryRecord) => {
        if (record.outcome === "normalization-verification-pending") controller.abort();
      }),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "normalization-verification-pending",
      errorCode: "post-dispatch-cancelled",
    });
    expect(client.addArtist).not.toHaveBeenCalled();
    expect(client.setAlbumsMonitored).toHaveBeenCalledOnce();
  });

  it("does not mutate when normalization verification history is not durable", async () => {
    const plan = makeExtendedPlan();
    const client = createLidarrClientMock({
      getArtistByForeignId: async () => desiredArtist(),
      listAlbums: async () => [
        createLidarrAlbumFixture({ id: 10, artistId: 42, albumType: "Single", monitored: true }),
      ],
    });
    const args = makeArgs(client, {
      plan,
      resumeNormalizationHistory: normalizationPendingHistory(plan),
      appendHistory: vi.fn(async (record: LidarrPlanHistoryRecord) => {
        if (record.outcome === "normalization-verification-pending") {
          throw new Error("history unavailable");
        }
      }),
    });

    const result = await executeLidarrArtistAddApplyEntry(args);

    expect(result.result).toMatchObject({
      outcome: "uncertain",
      stage: "creation-verified-normalization-pending",
      errorCode: "history-write-failed",
    });
    expect(client.setAlbumsMonitored).not.toHaveBeenCalled();
    expect(client.addArtist).not.toHaveBeenCalled();
  });
});
