import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { LidarrExecutionContext } from "../../lib/lidarr/index.js";
import {
  createLidarrScheduler,
  readLidarrExecutionMetadata,
  resolveLidarrSchedulerPolicy,
  type LidarrSchedulerPreflight,
} from "../../lib/lidarr/scheduler.js";
import { LidarrTimeoutError, MetadataProviderUnavailableError } from "../../lib/lidarr/errors.js";
import type {
  LidarrResilienceCallOptions,
  LidarrStaleServeResult,
  LidarrTryServeStaleOptions,
} from "../../lib/lidarr/resilience.js";
import { createLidarrSearchDiscriminator } from "../../lib/lidarr/search.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import type {
  LidarrSearchCandidate,
  LidarrSearchCandidateInput,
  LidarrSearchMode,
} from "../../types/lidarr.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";

const mockResolveExecutionContext = vi.hoisted(() => vi.fn());
const mockResolveScheduler = vi.hoisted(() => vi.fn());

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: mockResolveScheduler,
  resolveRequiredLidarrExecutionContext: mockResolveExecutionContext,
}));

import { TIER, executeLidarrSearch } from "./search.js";

const ARTIST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ARTIST_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "33333333-3333-4333-8333-333333333333";
const CACHE_STATUS: LidarrCacheStatus = Object.freeze({
  source: "stale-cache",
  fetchedAt: "2026-07-23T12:00:00.000Z",
  ageSeconds: 90,
});

type SearchProjection = readonly LidarrSearchCandidate[];
type StaleOptions = LidarrTryServeStaleOptions<SearchProjection>;
type StaleMock = (options: StaleOptions) => Promise<LidarrStaleServeResult<SearchProjection>>;

let clientMock: LidarrClientMock;
let preflightMock: Mock<LidarrSchedulerPreflight>;
let writeLookupCacheMock: Mock<(discriminator: string, value: unknown) => Promise<void>>;
let tryServeStaleMock: Mock<StaleMock>;
let resilienceOptions: LidarrResilienceCallOptions | undefined;

function artist(foreignId = ARTIST_ID, name = "Radiohead"): LidarrSearchCandidateInput {
  return Object.freeze({ kind: "artist", foreignId, name });
}

function album(foreignId = ALBUM_ID, name = "In Rainbows"): LidarrSearchCandidateInput {
  return Object.freeze({
    kind: "album",
    foreignId,
    name,
    artistName: "Radiohead",
    artistForeignId: ARTIST_ID,
  });
}

function rankedArtist(overrides: Partial<LidarrSearchCandidate> = {}): LidarrSearchCandidate {
  return Object.freeze({
    kind: "artist",
    foreignId: ARTIST_ID,
    name: "Radiohead",
    rank: 1,
    ...overrides,
  }) as LidarrSearchCandidate;
}

function installScheduler(
  retryAttempts = 0,
  delay: (ms: number, signal?: AbortSignal) => Promise<void> = async () => undefined,
): void {
  const scheduler = createLidarrScheduler(
    resolveLidarrSchedulerPolicy({
      lanes: { "metadata-dependent": { retryAttempts } },
    }),
    { delay, random: () => 0 },
  );
  mockResolveScheduler.mockReturnValue(scheduler);
}

function installContext(): void {
  mockResolveExecutionContext.mockImplementation(
    (_overrides: unknown, options: LidarrResilienceCallOptions) => {
      resilienceOptions = options;
      const context: LidarrExecutionContext = {
        client: clientMock,
        preflight: preflightMock,
        writeLookupCache: writeLookupCacheMock,
        tryServeStale: async <T>(staleOptions: LidarrTryServeStaleOptions<T>) =>
          (await tryServeStaleMock(
            staleOptions as unknown as StaleOptions,
          )) as LidarrStaleServeResult<T>,
      };
      return context;
    },
  );
}

function serveValidatedCache(value: unknown): void {
  tryServeStaleMock.mockImplementation(async (options) => {
    const validated = options.validate(value);
    if (validated === undefined) {
      return { served: false };
    }
    resilienceOptions?.onStaleServe?.(CACHE_STATUS);
    return { served: true, value: validated };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resilienceOptions = undefined;
  clientMock = createLidarrClientMock();
  preflightMock = vi.fn<LidarrSchedulerPreflight>().mockResolvedValue(undefined);
  writeLookupCacheMock = vi
    .fn<(discriminator: string, value: unknown) => Promise<void>>()
    .mockResolvedValue(undefined);
  tryServeStaleMock = vi.fn<StaleMock>().mockResolvedValue({ served: false });
  installScheduler();
  installContext();
});

describe("executeLidarrSearch", () => {
  it("declares the metadata-dependent tier", () => {
    expect(TIER).toBe("metadata-dependent");
  });

  it.each([
    ["empty term", { mode: "search", term: "  " }],
    ["unsafe limit", { mode: "search", term: "Radiohead", limit: 0 }],
    ["unsafe offset", { mode: "search", term: "Radiohead", offset: -1 }],
    ["unknown mode", { mode: "track", term: "Radiohead" }],
  ])("rejects %s before resolving any I/O dependency", async (_label, options) => {
    await expect(
      executeLidarrSearch(options as Parameters<typeof executeLidarrSearch>[0]),
    ).rejects.toMatchObject({ code: "validation" });

    expect(mockResolveExecutionContext).not.toHaveBeenCalled();
    expect(mockResolveScheduler).not.toHaveBeenCalled();
  });

  it.each<{
    mode: LidarrSearchMode;
    method: "search" | "lookupArtists" | "lookupAlbums";
    id: string;
    operation: string;
    input: readonly LidarrSearchCandidateInput[];
  }>([
    {
      mode: "search",
      method: "search",
      id: "lidarr-search",
      operation: "lidarr search",
      input: [artist(), artist(), album()],
    },
    {
      mode: "artist",
      method: "lookupArtists",
      id: "lidarr-lookup-artist",
      operation: "lidarr lookup artist",
      input: [artist(), artist(), artist(SECOND_ARTIST_ID, "Thom Yorke")],
    },
    {
      mode: "album",
      method: "lookupAlbums",
      id: "lidarr-lookup-album",
      operation: "lidarr lookup album",
      input: [album(), album()],
    },
  ])(
    "uses only the $method facade method and preserves $id execution identity",
    async ({ mode, method, id, operation, input }) => {
      clientMock[method].mockResolvedValue(input);
      const controller = new AbortController();

      const result = await executeLidarrSearch({
        mode,
        term: "  Cafe\u0301  ",
        limit: 1,
        signal: controller.signal,
      });

      expect(clientMock[method]).toHaveBeenCalledOnce();
      expect(clientMock[method]).toHaveBeenCalledWith({
        mode,
        term: "Café",
        signal: controller.signal,
      });
      for (const other of ["search", "lookupArtists", "lookupAlbums"] as const) {
        expect(clientMock[other]).toHaveBeenCalledTimes(other === method ? 1 : 0);
      }
      expect(preflightMock).toHaveBeenCalledWith({
        lane: "metadata-dependent",
        signal: controller.signal,
      });

      const cachedProjection = writeLookupCacheMock.mock.calls[0]?.[1] as SearchProjection;
      expect(writeLookupCacheMock).toHaveBeenCalledWith(
        createLidarrSearchDiscriminator(mode, "Café"),
        cachedProjection,
      );
      expect(cachedProjection).toHaveLength(mode === "album" ? 1 : 2);
      expect(cachedProjection.map(({ rank }) => rank)).toEqual(mode === "album" ? [1] : [1, 2]);
      expect(result.results).toEqual(cachedProjection.slice(0, 1));
      expect(result).toMatchObject({
        query: { mode, term: "Café" },
        total: cachedProjection.length,
        limit: 1,
        offset: 0,
        returned: 1,
        hasMore: cachedProjection.length > 1,
        provider: { requested: "lidarr", used: "lidarr", degraded: false },
        execution: {
          taskId: id,
          operation,
          lane: "metadata-dependent",
          outcome: "succeeded",
          attempts: 1,
        },
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.provider)).toBe(true);
      expect(Object.isFrozen(result.execution)).toBe(true);
      expect(tryServeStaleMock).not.toHaveBeenCalled();
    },
  );

  it("caches and returns an empty live projection as a successful result", async () => {
    const result = await executeLidarrSearch({ mode: "search", term: "No matches" });

    expect(writeLookupCacheMock).toHaveBeenCalledWith(
      createLidarrSearchDiscriminator("search", "No matches"),
      [],
    );
    expect(result).toMatchObject({
      results: [],
      total: 0,
      returned: 0,
      hasMore: false,
      provider: { used: "lidarr", degraded: false },
      execution: { attempts: 1, outcome: "succeeded" },
    });
  });

  it("serves one validated stale fallback after a failed preflight with zero attempts", async () => {
    const preflightError = new MetadataProviderUnavailableError("lidarr search preflight");
    preflightMock.mockRejectedValue(preflightError);
    serveValidatedCache([rankedArtist()]);

    const result = await executeLidarrSearch({
      mode: "search",
      term: "Radiohead",
      limit: 1,
      allowStale: true,
    });

    expect(clientMock.search).not.toHaveBeenCalled();
    expect(writeLookupCacheMock).not.toHaveBeenCalled();
    expect(tryServeStaleMock).toHaveBeenCalledOnce();
    expect(tryServeStaleMock.mock.calls[0]?.[0]).toMatchObject({
      category: "lookup",
      discriminator: createLidarrSearchDiscriminator("search", "Radiohead"),
      error: preflightError,
    });
    expect(result).toMatchObject({
      results: [rankedArtist()],
      provider: {
        requested: "lidarr",
        used: "sqlite-cache",
        degraded: true,
        fallbackReason: "metadata-provider-unavailable",
      },
      cacheStatus: CACHE_STATUS,
      execution: {
        taskId: "lidarr-search",
        operation: "lidarr search",
        lane: "metadata-dependent",
        outcome: "succeeded",
        attempts: 0,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.provider)).toBe(true);
    expect(Object.isFrozen(result.cacheStatus)).toBe(true);
    expect(Object.isFrozen(result.execution)).toBe(true);
  });

  it.each([
    ["miss", undefined],
    ["bad rank", [rankedArtist({ rank: 2 })]],
    ["mode mismatch", [Object.freeze({ ...album(), rank: 1 })]],
    ["unexpected field", [Object.freeze({ ...rankedArtist(), token: "secret" })]],
    ["duplicate identity", [rankedArtist(), rankedArtist({ rank: 2 })]],
  ])("preserves the original preflight error on a strict cache %s", async (_label, cached) => {
    const preflightError = new MetadataProviderUnavailableError("lidarr artist preflight");
    preflightMock.mockRejectedValue(preflightError);
    if (cached !== undefined) {
      serveValidatedCache(cached);
    }

    const promise = executeLidarrSearch({
      mode: "artist",
      term: "Radiohead",
      allowStale: true,
    });

    await expect(promise).rejects.toBe(preflightError);
    expect(tryServeStaleMock).toHaveBeenCalledOnce();
    expect(readLidarrExecutionMetadata(preflightError)).toEqual({
      taskId: "lidarr-lookup-artist",
      operation: "lidarr lookup artist",
      lane: "metadata-dependent",
      outcome: "failed",
      attempts: 0,
      failureType: "metadata-provider-unavailable",
      retryable: true,
    });
  });

  it("exhausts retryable live attempts before invoking terminal fallback once", async () => {
    const order: string[] = [];
    const timeout = new LidarrTimeoutError("lidarr search");
    clientMock.search.mockImplementation(async () => {
      order.push("live");
      throw timeout;
    });
    installScheduler(1, async () => {
      order.push("delay");
    });
    tryServeStaleMock.mockImplementation(async (options) => {
      order.push("fallback");
      const value = options.validate([rankedArtist()]);
      expect(value).toBeDefined();
      resilienceOptions?.onStaleServe?.(CACHE_STATUS);
      return { served: true, value: value as SearchProjection };
    });

    const result = await executeLidarrSearch({
      mode: "search",
      term: "Radiohead",
      allowStale: true,
    });

    expect(order).toEqual(["live", "delay", "live", "fallback"]);
    expect(clientMock.search).toHaveBeenCalledTimes(2);
    expect(tryServeStaleMock).toHaveBeenCalledOnce();
    expect(writeLookupCacheMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: {
        used: "sqlite-cache",
        degraded: true,
        fallbackReason: "timeout",
      },
      execution: { outcome: "succeeded", attempts: 2 },
    });
  });

  it("never attempts terminal fallback for cancellation", async () => {
    const cancellation = new DOMException("cancelled", "AbortError");
    clientMock.search.mockRejectedValue(cancellation);

    const promise = executeLidarrSearch({ mode: "search", term: "Radiohead" });

    await expect(promise).rejects.toBe(cancellation);
    expect(tryServeStaleMock).not.toHaveBeenCalled();
    expect(writeLookupCacheMock).not.toHaveBeenCalled();
    expect(readLidarrExecutionMetadata(cancellation)).toMatchObject({
      outcome: "skipped",
      attempts: 1,
      failureType: "aborted",
    });
  });
});
