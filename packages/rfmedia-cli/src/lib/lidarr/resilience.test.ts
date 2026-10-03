import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mockLogger = vi.hoisted(() => ({
  logWarn: vi.fn<(message: string) => void>(),
}));

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return { ...actual, logWarn: mockLogger.logWarn };
});

import {
  LIDARR_IN_PLACE_RETRY_ALLOWLIST,
  RETRY_BASE_DELAY_MS,
  TIMEOUT_RETRY_BASE_DELAY_MS,
  createLidarrResilienceContext,
  createResilientLidarrClient,
  resolveResiliencePolicy,
} from "./resilience.js";
import type { ResilienceDependencies, ResolvedResiliencePolicy } from "./resilience.js";
import { createSqliteCircuitStore } from "./circuit-breaker.js";
import {
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  MetadataProviderUnavailableError,
  RateLimitedError,
  classifyLidarrStatus,
} from "./errors.js";
import { readLidarrCache, writeLidarrCache } from "./metadata-cache.js";
import type { CacheHit, LidarrCacheCategory, MetadataFallbackSource } from "./metadata-cache.js";
import { initializeDatabase } from "../db.js";
import type { DbConnection } from "../../types/db.js";
import type { LidarrCacheStatus } from "../../types/lidarr-resilience.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../../actions/test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
  HEALTHY_STATUS,
} from "../../actions/test-helpers/lidarr-fixtures.js";
import { createLidarrSearchDiscriminator } from "./search.js";

const ORIGIN = "http://localhost:8686";
const API_KEY = "secret-api-key";
const NOW_ISO = "2026-07-22T12:00:00.000Z";

/** Resolved defaults with per-test overrides. */
function policyWith(overrides: Partial<ResolvedResiliencePolicy> = {}): ResolvedResiliencePolicy {
  return { ...resolveResiliencePolicy(), ...overrides };
}

/** Deterministic seams: pinned clock, resolved delay, zero jitter. */
function createSeams(overrides: ResilienceDependencies = {}): {
  readonly deps: ResilienceDependencies;
  readonly delayMock: Mock<(ms: number, signal?: AbortSignal) => Promise<void>>;
  readonly openDbMock: Mock<() => Promise<DbConnection>>;
} {
  const delayMock = vi
    .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined);
  const openDbMock = vi
    .fn<() => Promise<DbConnection>>()
    .mockRejectedValue(new Error("openDb seam not configured for this test"));
  return {
    deps: {
      now: () => new Date(NOW_ISO),
      delay: delayMock,
      random: () => 0,
      openDb: openDbMock,
      ...overrides,
    },
    delayMock,
    openDbMock,
  };
}

/** Fallback-source stub recording consultation order. */
function fakeSource(
  id: string,
  hit: CacheHit<unknown> | undefined,
  order?: string[],
): MetadataFallbackSource {
  return {
    id,
    lookup<T>(
      _origin: string,
      _category: LidarrCacheCategory,
      _discriminator: string,
    ): Promise<CacheHit<T> | undefined> {
      order?.push(id);
      return Promise.resolve(hit as CacheHit<T> | undefined);
    },
  };
}

/** A stale (past-TTL) cache hit aged `ageSeconds` before the pinned clock. */
function staleHit<T>(value: T, ageSeconds = 720): CacheHit<T> {
  return {
    value,
    fetchedAt: new Date(Date.parse(NOW_ISO) - ageSeconds * 1000).toISOString(),
    ageSeconds,
    fresh: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveResiliencePolicy", () => {
  it("applies every design §5 default when config is absent", () => {
    expect(resolveResiliencePolicy()).toEqual({
      failureThreshold: 3,
      failureWindowSeconds: 300,
      cooldownSeconds: 60,
      retryAttempts: 1,
      retryBackoffCapMs: 15_000,
      cacheTtlSeconds: 900,
      cacheStaleMaxAgeSeconds: 86_400,
      deferredMaxAttempts: 5,
    });
    expect(resolveResiliencePolicy({})).toEqual(resolveResiliencePolicy());
  });

  it("honors configured knobs and defaults the rest", () => {
    const policy = resolveResiliencePolicy({ retryAttempts: 0, cacheTtlSeconds: 0 });
    expect(policy.retryAttempts).toBe(0);
    expect(policy.cacheTtlSeconds).toBe(0);
    expect(policy.failureThreshold).toBe(3);
    expect(policy.cacheStaleMaxAgeSeconds).toBe(86_400);
  });

  it("returns a frozen policy", () => {
    expect(Object.isFrozen(resolveResiliencePolicy())).toBe(true);
  });
});

describe("createResilientLidarrClient delegation contract", () => {
  it("passes local-only calls straight through exactly once with result identity", async () => {
    const artists = Object.freeze([createLidarrArtistFixture()]);
    const inner = createLidarrClientMock();
    inner.listArtists.mockResolvedValue(artists);
    const { deps, openDbMock } = createSeams();

    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );

    const result = await wrapped.listArtists();

    expect(result).toBe(artists);
    expect(Object.isFrozen(result)).toBe(true);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(inner.getHealth).not.toHaveBeenCalled();
    expect(inner.getSystemStatus).not.toHaveBeenCalled();
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("forwards abort signals and the wanted query untouched", async () => {
    const inner = createLidarrClientMock();
    const { deps } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );
    const controller = new AbortController();
    const query = { page: 2, pageSize: 10, signal: controller.signal };

    await wrapped.getHealth(controller.signal);
    await wrapped.getSystemStatus(controller.signal);
    await wrapped.getWantedMissing(query);

    expect(inner.getHealth).toHaveBeenCalledWith(controller.signal);
    expect(inner.getSystemStatus).toHaveBeenCalledWith(controller.signal);
    expect(inner.getWantedMissing).toHaveBeenCalledWith(query);
  });

  it("passes album calls straight through with query and argument identity", async () => {
    const albums = Object.freeze([createLidarrAlbumFixture()]);
    const inner = createLidarrClientMock();
    inner.listAlbums.mockResolvedValue(albums);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );
    const controller = new AbortController();
    const query = { artistId: 7, signal: controller.signal };

    await expect(wrapped.listAlbums(query)).resolves.toBe(albums);
    await wrapped.setAlbumsMonitored([100], false, controller.signal);

    expect(inner.listAlbums).toHaveBeenCalledTimes(1);
    expect(inner.listAlbums).toHaveBeenCalledWith(query);
    expect(inner.setAlbumsMonitored).toHaveBeenCalledTimes(1);
    expect(inner.setAlbumsMonitored).toHaveBeenCalledWith([100], false, controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("routes the album mutation primitives through the decorator with argument identity", async () => {
    const inner = createLidarrClientMock();
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );
    const controller = new AbortController();
    const deleteOptions = { deleteFiles: true, addImportListExclusion: false } as const;

    await wrapped.deleteAlbum(11, deleteOptions, controller.signal);
    await wrapped.setAlbumAnyReleaseOk(12, true, controller.signal);

    expect(inner.deleteAlbum).toHaveBeenCalledOnce();
    expect(inner.deleteAlbum).toHaveBeenCalledWith(11, deleteOptions, controller.signal);
    expect(inner.setAlbumAnyReleaseOk).toHaveBeenCalledOnce();
    expect(inner.setAlbumAnyReleaseOk).toHaveBeenCalledWith(12, true, controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("forwards fresh mutation-authorizing reads without cache access", async () => {
    const artist = createLidarrArtistFixture();
    const qualityProfiles = Object.freeze([{ id: 1, name: "Lossless" }]);
    const metadataProfiles = Object.freeze([{ id: 2, name: "Standard" }]);
    const metadataProfileDetails = Object.freeze([
      Object.freeze({
        id: 2,
        name: "Standard",
        primaryAlbumTypes: Object.freeze([Object.freeze({ id: 1, name: "Album", allowed: true })]),
        secondaryAlbumTypes: Object.freeze([]),
      }),
    ]);
    const tags = Object.freeze([{ id: 3, label: "favorite" }]);
    const inner = createLidarrClientMock();
    inner.getArtist.mockResolvedValue(artist);
    inner.listQualityProfiles.mockResolvedValue(qualityProfiles);
    inner.listMetadataProfiles.mockResolvedValue(metadataProfiles);
    inner.listMetadataProfileDetails.mockResolvedValue(metadataProfileDetails);
    inner.listTags.mockResolvedValue(tags);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);
    const controller = new AbortController();

    await expect(wrapped.getArtist(artist.id, controller.signal)).resolves.toBe(artist);
    await expect(wrapped.listQualityProfiles(controller.signal)).resolves.toBe(qualityProfiles);
    await expect(wrapped.listMetadataProfiles(controller.signal)).resolves.toBe(metadataProfiles);
    await expect(wrapped.listMetadataProfileDetails(controller.signal)).resolves.toBe(
      metadataProfileDetails,
    );
    await expect(wrapped.listTags(controller.signal)).resolves.toBe(tags);

    expect(inner.getArtist).toHaveBeenCalledWith(artist.id, controller.signal);
    expect(inner.listQualityProfiles).toHaveBeenCalledWith(controller.signal);
    expect(inner.listMetadataProfiles).toHaveBeenCalledWith(controller.signal);
    expect(inner.listMetadataProfileDetails).toHaveBeenCalledWith(controller.signal);
    expect(inner.listTags).toHaveBeenCalledWith(controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("forwards artist-add reads and the non-retried create without cache access", async () => {
    const artist = createLidarrArtistFixture({
      foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
    });
    const rootFolders = Object.freeze([
      Object.freeze({ id: 1, path: "/music", accessible: true, freeSpace: 100 }),
    ]);
    const addInput = {
      artistName: artist.artistName,
      foreignArtistId: artist.foreignArtistId,
      rootFolderPath: "/music",
      qualityProfileId: 1,
      metadataProfileId: 2,
      monitored: false,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
    } as const;
    const inner = createLidarrClientMock();
    inner.getArtistByForeignId.mockResolvedValue(artist);
    inner.listRootFolders.mockResolvedValue(rootFolders);
    inner.prepareArtistAdd.mockResolvedValue(addInput);
    inner.addArtist.mockResolvedValue(artist);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);
    const controller = new AbortController();

    await expect(
      wrapped.getArtistByForeignId(artist.foreignArtistId, controller.signal),
    ).resolves.toBe(artist);
    await expect(wrapped.listRootFolders(controller.signal)).resolves.toBe(rootFolders);
    const prepared = await wrapped.prepareArtistAdd(addInput, controller.signal);
    await expect(wrapped.addArtist(prepared, controller.signal)).resolves.toBe(artist);

    expect(inner.getArtistByForeignId).toHaveBeenCalledWith(
      artist.foreignArtistId,
      controller.signal,
    );
    expect(inner.listRootFolders).toHaveBeenCalledWith(controller.signal);
    expect(inner.prepareArtistAdd).toHaveBeenCalledWith(addInput, controller.signal);
    expect(inner.addArtist).toHaveBeenCalledWith(addInput, controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("forwards every rich preset method with input and signal identity", async () => {
    const inner = createLidarrClientMock();
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );
    const controller = new AbortController();
    const customFormat = {
      name: "Lossless",
      includeCustomFormatWhenRenaming: false,
      specifications: [],
    } as const;
    const qualityProfile = {
      name: "Music",
      upgradeAllowed: false,
      cutoff: 1,
      items: [],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: [],
    } as const;
    const naming = {
      id: 1,
      renameTracks: false,
      replaceIllegalCharacters: false,
      colonReplacementFormat: 0,
      standardTrackFormat: "",
      multiDiscTrackFormat: "",
      artistFolderFormat: "",
    } as const;

    await wrapped.listCustomFormats(controller.signal);
    await wrapped.getCustomFormat(7, controller.signal);
    await wrapped.getCustomFormatSchema(controller.signal);
    await wrapped.createCustomFormat(customFormat, controller.signal);
    await wrapped.updateCustomFormat({ ...customFormat, id: 7 }, controller.signal);
    await wrapped.listQualityProfileDefinitions(controller.signal);
    await wrapped.getQualityProfileDefinition(8, controller.signal);
    await wrapped.getQualityProfileSchema(controller.signal);
    await wrapped.createQualityProfile(qualityProfile, controller.signal);
    await wrapped.updateQualityProfile({ ...qualityProfile, id: 8 }, controller.signal);
    await wrapped.getNamingConfig(controller.signal);
    await wrapped.getNamingExamples(naming, controller.signal);
    await wrapped.updateNamingConfig(naming, controller.signal);

    expect(inner.listCustomFormats).toHaveBeenCalledWith(controller.signal);
    expect(inner.getCustomFormat).toHaveBeenCalledWith(7, controller.signal);
    expect(inner.getCustomFormatSchema).toHaveBeenCalledWith(controller.signal);
    expect(inner.createCustomFormat).toHaveBeenCalledWith(customFormat, controller.signal);
    expect(inner.updateCustomFormat).toHaveBeenCalledWith(
      { ...customFormat, id: 7 },
      controller.signal,
    );
    expect(inner.listQualityProfileDefinitions).toHaveBeenCalledWith(controller.signal);
    expect(inner.getQualityProfileDefinition).toHaveBeenCalledWith(8, controller.signal);
    expect(inner.getQualityProfileSchema).toHaveBeenCalledWith(controller.signal);
    expect(inner.createQualityProfile).toHaveBeenCalledWith(qualityProfile, controller.signal);
    expect(inner.updateQualityProfile).toHaveBeenCalledWith(
      { ...qualityProfile, id: 8 },
      controller.signal,
    );
    expect(inner.getNamingConfig).toHaveBeenCalledWith(controller.signal);
    expect(inner.getNamingExamples).toHaveBeenCalledWith(naming, controller.signal);
    expect(inner.updateNamingConfig).toHaveBeenCalledWith(naming, controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("retries a rich GET once but never hot-retries any preset write", async () => {
    const readResult = Object.freeze([]);
    const inner = createLidarrClientMock();
    inner.listCustomFormats
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr list custom formats"))
      .mockResolvedValueOnce(readResult);
    const writeError = new LidarrUnreachableError("lidarr preset write");
    inner.createCustomFormat.mockRejectedValue(writeError);
    inner.updateCustomFormat.mockRejectedValue(writeError);
    inner.createQualityProfile.mockRejectedValue(writeError);
    inner.updateQualityProfile.mockRejectedValue(writeError);
    inner.updateNamingConfig.mockRejectedValue(writeError);
    const { deps, delayMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
      {},
      deps,
    );
    const input = {
      name: "Lossless",
      includeCustomFormatWhenRenaming: false,
      specifications: [],
    } as const;
    const qualityProfile = {
      name: "Music",
      upgradeAllowed: false,
      cutoff: 1,
      items: [],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: [],
    } as const;
    const naming = {
      id: 1,
      renameTracks: false,
      replaceIllegalCharacters: false,
      colonReplacementFormat: 0,
      standardTrackFormat: "",
      multiDiscTrackFormat: "",
      artistFolderFormat: "",
    } as const;

    await expect(wrapped.listCustomFormats()).resolves.toBe(readResult);
    await expect(wrapped.createCustomFormat(input)).rejects.toBe(writeError);
    await expect(wrapped.updateCustomFormat({ ...input, id: 7 })).rejects.toBe(writeError);
    await expect(wrapped.createQualityProfile(qualityProfile)).rejects.toBe(writeError);
    await expect(wrapped.updateQualityProfile({ ...qualityProfile, id: 8 })).rejects.toBe(
      writeError,
    );
    await expect(wrapped.updateNamingConfig(naming)).rejects.toBe(writeError);

    expect(inner.listCustomFormats).toHaveBeenCalledTimes(2);
    expect(inner.createCustomFormat).toHaveBeenCalledTimes(1);
    expect(inner.updateCustomFormat).toHaveBeenCalledTimes(1);
    expect(inner.createQualityProfile).toHaveBeenCalledTimes(1);
    expect(inner.updateQualityProfile).toHaveBeenCalledTimes(1);
    expect(inner.updateNamingConfig).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenCalledTimes(1);
  });

  it("forwards mutations exactly once without cache writes and preserves client isolation", async () => {
    const firstInner = createLidarrClientMock();
    const secondInner = createLidarrClientMock();
    const firstSeams = createSeams();
    const secondSeams = createSeams();
    const first = createResilientLidarrClient(
      firstInner,
      ORIGIN,
      policyWith(),
      {},
      firstSeams.deps,
    );
    const second = createResilientLidarrClient(
      secondInner,
      "http://lidarr-secondary:8686",
      policyWith(),
      {},
      secondSeams.deps,
    );
    const controller = new AbortController();
    const assignment = { qualityProfileId: 4, metadataProfileId: 5 } as const;
    const mutation = { mode: "add", tagIds: [6, 7] } as const;

    await first.setArtistProfiles(11, assignment, controller.signal);
    await second.updateArtistTags(12, mutation, controller.signal);

    expect(firstInner.setArtistProfiles).toHaveBeenCalledOnce();
    expect(firstInner.setArtistProfiles).toHaveBeenCalledWith(11, assignment, controller.signal);
    expect(firstInner.updateArtistTags).not.toHaveBeenCalled();
    expect(secondInner.updateArtistTags).toHaveBeenCalledOnce();
    expect(secondInner.updateArtistTags).toHaveBeenCalledWith(12, mutation, controller.signal);
    expect(secondInner.setArtistProfiles).not.toHaveBeenCalled();
    expect(firstSeams.openDbMock).not.toHaveBeenCalled();
    expect(secondSeams.openDbMock).not.toHaveBeenCalled();
  });

  it("forwards artist deletion exactly once with mode and signal identity", async () => {
    const inner = createLidarrClientMock();
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);
    const controller = new AbortController();

    await wrapped.deleteArtist(11, true, controller.signal);

    expect(inner.deleteArtist).toHaveBeenCalledOnce();
    expect(inner.deleteArtist).toHaveBeenCalledWith(11, true, controller.signal);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("never retries artist creation", async () => {
    const error = new LidarrUnreachableError("lidarr add artist");
    const inner = createLidarrClientMock();
    inner.addArtist.mockRejectedValue(error);
    const { deps, delayMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
      {},
      deps,
    );
    const input = {
      artistName: "Radiohead",
      foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
      rootFolderPath: "/music",
      qualityProfileId: 1,
      metadataProfileId: 2,
      monitored: false,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
    } as const;

    await expect(wrapped.addArtist(input)).rejects.toBe(error);

    expect(inner.addArtist).toHaveBeenCalledOnce();
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("preserves cancellation identity for a mutation", async () => {
    const reason = new DOMException("caller cancelled", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);
    const inner = createLidarrClientMock();
    inner.setArtistProfiles.mockRejectedValue(reason);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);

    await expect(
      wrapped.setArtistProfiles(11, { qualityProfileId: 4 }, controller.signal),
    ).rejects.toBe(reason);
    expect(inner.setArtistProfiles).toHaveBeenCalledOnce();
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("returns a frozen client that serializes to {}", () => {
    const inner = createLidarrClientMock();
    const { deps } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);

    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(JSON.stringify(wrapped)).toBe("{}");
  });

  it("pins the in-place retry allowlist to the read methods (default-deny beyond)", () => {
    expect([...LIDARR_IN_PLACE_RETRY_ALLOWLIST].sort()).toEqual([
      "getArtist",
      "getArtistByForeignId",
      "getCustomFormat",
      "getCustomFormatSchema",
      "getHealth",
      "getNamingConfig",
      "getNamingExamples",
      "getQualityProfileDefinition",
      "getQualityProfileSchema",
      "getSystemStatus",
      "getWantedMissing",
      "listAlbums",
      "listArtists",
      "listCustomFormats",
      "listMetadataProfileDetails",
      "listMetadataProfiles",
      "listQualityProfileDefinitions",
      "listQualityProfiles",
      "listRootFolders",
      "listTags",
      "listTrackFiles",
      "listTracks",
      "lookupAlbums",
      "lookupArtists",
      "probeManualImport",
      "search",
    ]);
    // Mutations stay defer-only; any future facade method is denied until classified.
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("setArtistsMonitored")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("setAlbumsMonitored")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("addArtist")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("postCommand")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("setArtistProfiles")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("updateArtistTags")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("deleteAlbum")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("setAlbumAnyReleaseOk")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("deleteArtist")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("createCustomFormat")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("updateCustomFormat")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("createQualityProfile")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("updateQualityProfile")).toBe(false);
    expect(LIDARR_IN_PLACE_RETRY_ALLOWLIST.has("updateNamingConfig")).toBe(false);
  });
});

describe("createLidarrResilienceContext", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-context-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const validateStrings = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? Object.freeze([...value])
      : undefined;

  it("shares one lazily-created breaker pair without opening the database at construction", async () => {
    const inner = createLidarrClientMock();
    const openDb = vi.fn(async () => db);
    const context = createLidarrResilienceContext(inner, ORIGIN, policyWith(), {}, { openDb });

    expect(openDb).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([context.getBreakers(), context.getBreakers()]);

    expect(second).toBe(first);
    expect(second.lidarr).toBe(first.lidarr);
    expect(second.metadata).toBe(first.metadata);
    expect(openDb).toHaveBeenCalledOnce();
  });

  it("leaves scheduled lookup gating, retries, and stale serving to the scheduler", async () => {
    const error = new LidarrTimeoutError("lidarr search");
    const inner = createLidarrClientMock();
    inner.search.mockRejectedValue(error);
    const fallbackOrder: string[] = [];
    const { deps, delayMock } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("must-not-run", staleHit(["cached"]), fallbackOrder)],
    });
    const context = createLidarrResilienceContext(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 3 }),
      { tier: "metadata-dependent", allowStale: true },
      deps,
    );
    const query = { mode: "search", term: "radiohead" } as const;

    await expect(context.client.search(query)).rejects.toBe(error);

    expect(inner.search).toHaveBeenCalledOnce();
    expect(inner.search).toHaveBeenCalledWith(query);
    expect(inner.getHealth).not.toHaveBeenCalled();
    expect(inner.getSystemStatus).not.toHaveBeenCalled();
    expect(delayMock).not.toHaveBeenCalled();
    expect(fallbackOrder).toEqual([]);
  });

  it("closes the shared persisted breakers after a failed scheduled attempt succeeds", async () => {
    const inner = createLidarrClientMock();
    const failure = new LidarrUnreachableError("lidarr search");
    inner.search.mockRejectedValueOnce(failure).mockResolvedValueOnce(Object.freeze([]));
    const context = createLidarrResilienceContext(
      inner,
      ORIGIN,
      policyWith({ failureThreshold: 1 }),
      { tier: "metadata-dependent" },
      { openDb: async () => db, now: () => new Date(NOW_ISO) },
    );
    const breakers = await context.getBreakers();
    breakers.metadata.recordFailure(new MetadataProviderUnavailableError("lidarr search"));
    const query = { mode: "search", term: "radiohead" } as const;

    await expect(context.client.search(query)).rejects.toBe(failure);
    expect(breakers.lidarr.getState().state).toBe("open");
    expect(breakers.metadata.getState().state).toBe("open");

    await expect(context.client.search(query)).resolves.toEqual([]);
    expect(breakers.lidarr.getState()).toEqual({ state: "closed", recentFailures: [] });
    expect(breakers.metadata.getState()).toEqual({ state: "closed", recentFailures: [] });
    expect(inner.search).toHaveBeenCalledTimes(2);
    await expect(context.getBreakers()).resolves.toBe(breakers);
  });

  it("preserves a scheduled live result without automatic cache access", async () => {
    const live = Object.freeze(["live"]);
    const inner = createLidarrClientMock();
    inner.lookupArtists.mockResolvedValue(live as never);
    const openDb = vi.fn<() => Promise<DbConnection>>().mockRejectedValue(new Error("disk full"));
    const context = createLidarrResilienceContext(
      inner,
      ORIGIN,
      policyWith(),
      { tier: "metadata-dependent", allowStale: true },
      { openDb },
    );

    await expect(context.client.lookupArtists({ mode: "artist", term: "radiohead" })).resolves.toBe(
      live,
    );
    expect(openDb).toHaveBeenCalledOnce();
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist Lidarr circuit state"),
    );
    expect(mockLogger.logWarn).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to write Lidarr metadata cache"),
    );
  });

  it("writes complete lookup projections including empty arrays under exact discriminators", async () => {
    const openDb = vi.fn(async () => db);
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      {},
      { openDb, now: () => new Date(NOW_ISO) },
    );
    const emptySearch = createLidarrSearchDiscriminator("search", "Radiohead");
    const artistLookup = createLidarrSearchDiscriminator("artist", "Radiohead");
    const otherTerm = createLidarrSearchDiscriminator("search", "Portishead");
    const ranked = Object.freeze([
      Object.freeze({
        kind: "artist" as const,
        foreignId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
        name: "Radiohead",
        rank: 1,
      }),
    ]);

    await context.writeLookupCache(emptySearch, Object.freeze([]));
    await context.writeLookupCache(artistLookup, ranked);

    const now = (): Date => new Date(NOW_ISO);
    expect(
      readLidarrCache(db, ORIGIN, "lookup", emptySearch, 900_000, 86_400_000, now)?.value,
    ).toEqual([]);
    expect(
      readLidarrCache(db, ORIGIN, "lookup", artistLookup, 900_000, 86_400_000, now)?.value,
    ).toEqual(ranked);
    expect(
      readLidarrCache(db, ORIGIN, "lookup", otherTerm, 900_000, 86_400_000, now),
    ).toBeUndefined();
    expect(
      readLidarrCache(
        db,
        "http://other.example:8686",
        "lookup",
        emptySearch,
        900_000,
        86_400_000,
        now,
      ),
    ).toBeUndefined();
    expect(
      readLidarrCache(db, ORIGIN, "lookup", `v2:${emptySearch.slice(3)}`, 900_000, 86_400_000, now),
    ).toBeUndefined();
    expect(emptySearch).toMatch(/^v1:search:[a-f0-9]{64}$/u);
    expect(artistLookup).toMatch(/^v1:artist:[a-f0-9]{64}$/u);
    expect(openDb).toHaveBeenCalledOnce();
  });

  it("keeps lookup cache writes non-throwing", async () => {
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      {},
      { openDb: () => Promise.reject(new Error("disk full")) },
    );

    await expect(context.writeLookupCache("v1:search:digest", [])).resolves.toBeUndefined();
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write Lidarr metadata cache (lookup)"),
    );
  });

  it("requires explicit stale consent before consulting a source", async () => {
    const order: string[] = [];
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      {},
      { fallbackSources: [fakeSource("must-not-run", staleHit(["cached"]), order)] },
    );

    await expect(
      context.tryServeStale({
        category: "lookup",
        discriminator: "v1:search:digest",
        error: new LidarrUnreachableError("lidarr search"),
        validate: validateStrings,
      }),
    ).resolves.toEqual({ served: false });
    expect(order).toEqual([]);
  });

  it.each([
    ["metadata provider", new MetadataProviderUnavailableError("lidarr search")],
    ["Lidarr unreachable", new LidarrUnreachableError("lidarr search")],
    ["timeout", new LidarrTimeoutError("lidarr search")],
  ])("serves validated terminal stale data for an eligible %s failure", async (_label, error) => {
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      { allowStale: true },
      { fallbackSources: [fakeSource("sqlite-cache", staleHit(["cached"]))] },
    );

    const result = await context.tryServeStale({
      category: "lookup",
      discriminator: "v1:search:digest",
      error,
      validate: validateStrings,
    });

    expect(result).toEqual({ served: true, value: ["cached"] });
    expect(result.served && Object.isFrozen(result.value)).toBe(true);
  });

  it.each([
    ["rate limit", new RateLimitedError("lidarr search", 5)],
    ["authentication", classifyLidarrStatus(401, "lidarr search")],
    [
      "invalid response",
      new LidarrValidationError("lidarr search", "malformed", "invalid-response"),
    ],
    ["caller cancellation", new DOMException("cancelled", "AbortError")],
  ])("does not serve stale for %s", async (_label, error) => {
    const order: string[] = [];
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      { allowStale: true },
      { fallbackSources: [fakeSource("must-not-run", staleHit(["cached"]), order)] },
    );

    await expect(
      context.tryServeStale({
        category: "lookup",
        discriminator: "v1:search:digest",
        error,
        validate: validateStrings,
      }),
    ).resolves.toEqual({ served: false });
    expect(order).toEqual([]);
  });

  it("treats an invalid cached projection as a miss without warning or callback", async () => {
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      { allowStale: true, onStaleServe },
      { fallbackSources: [fakeSource("sqlite-cache", staleHit({ malformed: true }))] },
    );

    await expect(
      context.tryServeStale({
        category: "lookup",
        discriminator: "v1:search:digest",
        error: new LidarrUnreachableError("lidarr search"),
        validate: validateStrings,
      }),
    ).resolves.toEqual({ served: false });
    expect(onStaleServe).not.toHaveBeenCalled();
    expect(mockLogger.logWarn).not.toHaveBeenCalled();
  });

  it("emits the stale warning and callback exactly once after validation succeeds", async () => {
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const order: string[] = [];
    const hit = staleHit(["cached"], 720);
    const context = createLidarrResilienceContext(
      createLidarrClientMock(),
      ORIGIN,
      policyWith(),
      { allowStale: true, onStaleServe },
      {
        fallbackSources: [
          fakeSource("first-miss", undefined, order),
          fakeSource("sqlite-cache", hit, order),
          fakeSource("never-reached", staleHit(["wrong"]), order),
        ],
      },
    );

    await expect(
      context.tryServeStale({
        category: "lookup",
        discriminator: "v1:album:digest",
        error: new LidarrUnreachableError("lidarr lookup albums"),
        validate: validateStrings,
      }),
    ).resolves.toEqual({ served: true, value: ["cached"] });
    expect(order).toEqual(["first-miss", "sqlite-cache"]);
    expect(onStaleServe).toHaveBeenCalledOnce();
    expect(onStaleServe).toHaveBeenCalledWith({
      source: "stale-cache",
      fetchedAt: hit.fetchedAt,
      ageSeconds: 720,
    });
    expect(mockLogger.logWarn).toHaveBeenCalledOnce();
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Lidarr unreachable — serving cached data from 12m ago (--allow-stale).",
    );
  });
});

describe("in-place retry", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function wrappedWith(
    inner: LidarrClientMock,
    policy: ResolvedResiliencePolicy,
    depsOverrides: ResilienceDependencies = {},
  ): {
    readonly wrapped: ReturnType<typeof createResilientLidarrClient>;
    readonly delayMock: Mock<(ms: number, signal?: AbortSignal) => Promise<void>>;
  } {
    const { deps, delayMock } = createSeams({ openDb: async () => db, ...depsOverrides });
    return { wrapped: createResilientLidarrClient(inner, ORIGIN, policy, {}, deps), delayMock };
  }

  it("retries an unreachable read once at the 500 ms base and succeeds", async () => {
    const artists = [createLidarrArtistFixture()];
    const inner = createLidarrClientMock();
    inner.listArtists
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr list artists"))
      .mockResolvedValueOnce(artists);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }));

    await expect(wrapped.listArtists()).resolves.toBe(artists);
    expect(inner.listArtists).toHaveBeenCalledTimes(2);
    expect(delayMock).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenCalledWith(RETRY_BASE_DELAY_MS, undefined);
  });

  it("adds full jitter on top of the exponential base", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr list artists"))
      .mockResolvedValueOnce([]);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }), {
      random: () => 1,
    });

    await wrapped.listArtists();
    expect(delayMock).toHaveBeenCalledWith(RETRY_BASE_DELAY_MS * 2, undefined);
  });

  it("caps backoff at retryBackoffCapMs", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr list artists"))
      .mockResolvedValueOnce([]);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryBackoffCapMs: 300 }),
    );

    await wrapped.listArtists();
    expect(delayMock).toHaveBeenCalledWith(300, undefined);
  });

  it("retries an unreachable listAlbums in place (allowlisted read)", async () => {
    const albums = [createLidarrAlbumFixture()];
    const inner = createLidarrClientMock();
    inner.listAlbums
      .mockRejectedValueOnce(new LidarrUnreachableError("lidarr list albums"))
      .mockResolvedValueOnce(albums);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }));

    await expect(wrapped.listAlbums({ artistId: 1 })).resolves.toBe(albums);
    expect(inner.listAlbums).toHaveBeenCalledTimes(2);
    expect(delayMock).toHaveBeenCalledTimes(1);
    expect(delayMock).toHaveBeenCalledWith(RETRY_BASE_DELAY_MS, undefined);
  });

  it("never retries setAlbumsMonitored in place (defer-only mutation)", async () => {
    const error = new LidarrUnreachableError("lidarr update album monitoring");
    const inner = createLidarrClientMock();
    inner.setAlbumsMonitored.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
    );

    await expect(wrapped.setAlbumsMonitored([100], false)).rejects.toBe(error);
    expect(inner.setAlbumsMonitored).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("never retries deleteAlbum or setAlbumAnyReleaseOk in place (defer-only mutations)", async () => {
    const deleteError = new LidarrUnreachableError("lidarr delete album");
    const editError = new LidarrUnreachableError("lidarr set album release policy");
    const inner = createLidarrClientMock();
    inner.deleteAlbum.mockRejectedValue(deleteError);
    inner.setAlbumAnyReleaseOk.mockRejectedValue(editError);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
    );

    await expect(
      wrapped.deleteAlbum(11, { deleteFiles: false, addImportListExclusion: false }),
    ).rejects.toBe(deleteError);
    await expect(wrapped.setAlbumAnyReleaseOk(11, true)).rejects.toBe(editError);
    expect(inner.deleteAlbum).toHaveBeenCalledTimes(1);
    expect(inner.setAlbumAnyReleaseOk).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("never retries artist deletion in place", async () => {
    const error = new LidarrUnreachableError("lidarr delete artist");
    const inner = createLidarrClientMock();
    inner.deleteArtist.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
    );
    const controller = new AbortController();

    await expect(wrapped.deleteArtist(11, false, controller.signal)).rejects.toBe(error);
    expect(inner.deleteArtist).toHaveBeenCalledOnce();
    expect(inner.deleteArtist).toHaveBeenCalledWith(11, false, controller.signal);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("uses the 2000 ms timeout-specific base for timeout failures", async () => {
    const inner = createLidarrClientMock();
    inner.getSystemStatus
      .mockRejectedValueOnce(new LidarrTimeoutError("lidarr system status"))
      .mockResolvedValueOnce(HEALTHY_STATUS);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }));

    await expect(wrapped.getSystemStatus()).resolves.toBe(HEALTHY_STATUS);
    expect(delayMock).toHaveBeenCalledWith(TIMEOUT_RETRY_BASE_DELAY_MS, undefined);
  });

  it("waits exactly Retry-After for a rate-limited read (no jitter)", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists
      .mockRejectedValueOnce(new RateLimitedError("lidarr list artists", 3))
      .mockResolvedValueOnce([]);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }), {
      random: () => 1,
    });

    await wrapped.listArtists();
    expect(delayMock).toHaveBeenCalledWith(3_000, undefined);
  });

  it("fails through immediately when Retry-After exceeds the backoff cap", async () => {
    const error = new RateLimitedError("lidarr list artists", 20);
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryBackoffCapMs: 15_000 }),
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("falls back to the generic backoff for rate-limited without a Retry-After hint", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists
      .mockRejectedValueOnce(new RateLimitedError("lidarr list artists"))
      .mockResolvedValueOnce([]);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }));

    await wrapped.listArtists();
    expect(delayMock).toHaveBeenCalledWith(RETRY_BASE_DELAY_MS, undefined);
  });

  it("exhausts retryAttempts on the doubling schedule and rethrows the last error", async () => {
    const error = new LidarrUnreachableError("lidarr list artists");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 2 }),
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(inner.listArtists).toHaveBeenCalledTimes(3);
    expect(delayMock.mock.calls.map(([ms]) => ms)).toEqual([
      RETRY_BASE_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2,
    ]);
    expect(inspect(error)).not.toContain(API_KEY);
  });

  it("performs no retry when retryAttempts is 0", async () => {
    const error = new LidarrUnreachableError("lidarr list artists");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(
      inner,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 0 }),
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("honors a per-call retry override when the scheduler owns retries", async () => {
    const error = new LidarrUnreachableError("lidarr list artists");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { deps, delayMock } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 3 }),
      { retryAttemptsOverride: 0 },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("never retries or serves stale for profile and tag mutations but still feeds the breaker", async () => {
    const profileError = new LidarrUnreachableError("lidarr set artist profiles");
    const tagError = new LidarrUnreachableError("lidarr update artist tags");
    const inner = createLidarrClientMock();
    inner.setArtistProfiles.mockRejectedValue(profileError);
    inner.updateArtistTags.mockRejectedValue(tagError);
    const fallbackOrder: string[] = [];
    const { deps, delayMock } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("must-not-run", staleHit(undefined), fallbackOrder)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 3 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.setArtistProfiles(11, { qualityProfileId: 4 })).rejects.toBe(profileError);
    await expect(wrapped.updateArtistTags(12, { mode: "remove", tagIds: [6] })).rejects.toBe(
      tagError,
    );

    expect(profileError.operation).toBe("lidarr set artist profiles");
    expect(tagError.operation).toBe("lidarr update artist tags");
    expect(inner.setArtistProfiles).toHaveBeenCalledOnce();
    expect(inner.updateArtistTags).toHaveBeenCalledOnce();
    expect(delayMock).not.toHaveBeenCalled();
    expect(fallbackOrder).toEqual([]);
    expect(createSqliteCircuitStore(db).load(ORIGIN, "lidarr")).toEqual({
      state: "closed",
      recentFailures: [NOW_ISO, NOW_ISO],
    });
  });

  it.each([
    ["validation", new LidarrValidationError("lidarr list artists", "bad request")],
    [
      "metadata-provider-unavailable (never retried in place)",
      new MetadataProviderUnavailableError("lidarr list artists"),
    ],
    ["non-Lidarr", new Error("boom")],
  ])("bypasses retry for a %s failure with zero extra calls", async (_label, error) => {
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { wrapped, delayMock } = wrappedWith(inner, policyWith({ cacheTtlSeconds: 0 }));

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(delayMock).not.toHaveBeenCalled();
  });

  it("aborts the default retry wait via the caller signal", async () => {
    const reason = new Error("caller cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(new LidarrUnreachableError("lidarr list artists"));
    // No injected delay: exercises the production defaultDelay abort path.
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      { now: () => new Date(NOW_ISO), random: () => 0, openDb: async () => db },
    );

    await expect(wrapped.listArtists(controller.signal)).rejects.toBe(reason);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
  });
});

describe("failure-path circuit-breaker feed", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("records an exhausted unreachable failure on the lidarr scope only", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(new LidarrUnreachableError("lidarr list artists"));
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 0 }),
      {},
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);

    const store = createSqliteCircuitStore(db);
    expect(store.load(ORIGIN, "lidarr")).toEqual({
      state: "closed",
      recentFailures: [NOW_ISO],
    });
    expect(store.load(ORIGIN, "metadata")).toEqual({ state: "closed", recentFailures: [] });
  });

  it("trips the circuit open at the failure threshold", async () => {
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(new LidarrUnreachableError("lidarr list artists"));
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 0, failureThreshold: 3 }),
      {},
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);

    expect(createSqliteCircuitStore(db).load(ORIGIN, "lidarr")).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    // Local-only calls are never blocked: the fourth call still dispatches.
    inner.listArtists.mockResolvedValueOnce([]);
    await expect(wrapped.listArtists()).resolves.toEqual([]);
  });

  it("touches no database for failures that feed no circuit scope", async () => {
    const error = new LidarrValidationError("lidarr list artists", "bad request");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 0 }),
      {},
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("warns and rethrows the original error when breaker persistence fails", async () => {
    const error = new LidarrUnreachableError("lidarr list artists");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { deps } = createSeams({ openDb: () => Promise.reject(new Error("db exploded")) });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0, retryAttempts: 0 }),
      {},
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist Lidarr circuit state"),
    );
  });
});

describe("circuit-open gating (metadata-dependent tier)", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function seedOpenLidarrCircuit(openedAtIso: string): void {
    createSqliteCircuitStore(db).save(ORIGIN, "lidarr", {
      state: "open",
      openedAt: openedAtIso,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
  }

  it("throws the scope-mapped taxonomy error with zero network I/O while open", async () => {
    seedOpenLidarrCircuit(NOW_ISO);
    const inner = createLidarrClientMock();
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith(),
      { tier: "metadata-dependent" },
      deps,
    );

    const error = await wrapped.listArtists().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(LidarrUnreachableError);
    expect((error as LidarrUnreachableError).retryAfterSeconds).toBe(60);
    expect(inner.listArtists).not.toHaveBeenCalled();
    expect(inner.getHealth).not.toHaveBeenCalled();
    expect(inner.getSystemStatus).not.toHaveBeenCalled();
    expect(inner.getWantedMissing).not.toHaveBeenCalled();
    expect(inspect(error)).not.toContain(API_KEY);
  });

  it("never blocks local-only calls while the circuit is open", async () => {
    seedOpenLidarrCircuit(NOW_ISO);
    const inner = createLidarrClientMock();
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      {},
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toEqual([]);
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("runs the elapsed-cooldown call as the probe and closes the circuit on success", async () => {
    seedOpenLidarrCircuit(new Date(Date.parse(NOW_ISO) - 120_000).toISOString());
    const inner = createLidarrClientMock();
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ cacheTtlSeconds: 0 }),
      { tier: "metadata-dependent" },
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toEqual([]);

    expect(inner.getHealth).toHaveBeenCalledTimes(1); // fresh gate probe
    expect(inner.listArtists).toHaveBeenCalledTimes(1);
    expect(createSqliteCircuitStore(db).load(ORIGIN, "lidarr")).toEqual({
      state: "closed",
      recentFailures: [],
    });
  });

  it("trips the circuit from repeated gate-probe failures while Lidarr is down", async () => {
    const inner = createLidarrClientMock();
    inner.getHealth.mockRejectedValue(new LidarrUnreachableError("lidarr health"));
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith(),
      { tier: "metadata-dependent" },
      deps,
    );
    const store = createSqliteCircuitStore(db);

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    // Exactly one window entry per failed probe — the probe outcome feeds
    // the breaker; the gate rejection path never does.
    expect(store.load(ORIGIN, "lidarr")).toEqual({
      state: "closed",
      recentFailures: [NOW_ISO],
    });

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);

    expect(store.load(ORIGIN, "lidarr")).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
    expect(inner.getHealth).toHaveBeenCalledTimes(3);
    expect(inner.listArtists).not.toHaveBeenCalled();

    // While open: fail-fast rejection with no probe and no extra failure.
    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    expect(inner.getHealth).toHaveBeenCalledTimes(3);
    expect(store.load(ORIGIN, "lidarr")).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
  });

  it("re-opens with a fresh openedAt when the post-cooldown probe fails (not wedged half-open)", async () => {
    seedOpenLidarrCircuit(new Date(Date.parse(NOW_ISO) - 120_000).toISOString());
    const inner = createLidarrClientMock();
    inner.getHealth.mockRejectedValue(new LidarrUnreachableError("lidarr health"));
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith(),
      { tier: "metadata-dependent" },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);

    expect(inner.getHealth).toHaveBeenCalledTimes(1); // this call was the probe
    expect(inner.listArtists).not.toHaveBeenCalled();
    expect(createSqliteCircuitStore(db).load(ORIGIN, "lidarr")).toEqual({
      state: "open",
      openedAt: NOW_ISO,
      cooldownMs: 60_000,
      reason: "lidarr-unreachable",
    });
  });

  it("serves stale under --allow-stale instead of the circuit-open error", async () => {
    seedOpenLidarrCircuit(NOW_ISO);
    const artists = [createLidarrArtistFixture()];
    const inner = createLidarrClientMock();
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const hit = staleHit<unknown>(artists);
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", hit)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith(),
      { tier: "metadata-dependent", allowStale: true, onStaleServe },
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toBe(artists);
    expect(inner.listArtists).not.toHaveBeenCalled();
    expect(onStaleServe).toHaveBeenCalledWith({
      source: "stale-cache",
      fetchedAt: hit.fetchedAt,
      ageSeconds: hit.ageSeconds,
    });
  });
});

describe("stale fallback (--allow-stale)", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function failingInner(): LidarrClientMock {
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(new LidarrUnreachableError("lidarr list artists"));
    return inner;
  }

  it("is never consulted without the flag", async () => {
    const inner = failingInner();
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const order: string[] = [];
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", staleHit([]), order)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { onStaleServe },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    expect(order).toEqual([]);
    expect(onStaleServe).not.toHaveBeenCalled();
  });

  it("serves the hit, fires onStaleServe, and emits the sole stderr warning", async () => {
    const artists = [createLidarrArtistFixture()];
    const inner = failingInner();
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const hit = staleHit<unknown>(artists, 720);
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", hit)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true, onStaleServe },
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toBe(artists);
    expect(onStaleServe).toHaveBeenCalledTimes(1);
    expect(onStaleServe).toHaveBeenCalledWith({
      source: "stale-cache",
      fetchedAt: hit.fetchedAt,
      ageSeconds: 720,
    });
    expect(mockLogger.logWarn).toHaveBeenCalledTimes(1);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Lidarr unreachable — serving cached data from 12m ago (--allow-stale).",
    );
  });

  it("consults sources left-to-right and stops at the first hit", async () => {
    const inner = failingInner();
    const order: string[] = [];
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [
        fakeSource("first-miss", undefined, order),
        fakeSource("second-hit", staleHit(["cached"]), order),
        fakeSource("never-reached", staleHit(["wrong"]), order),
      ],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toEqual(["cached"]);
    expect(order).toEqual(["first-miss", "second-hit"]);
  });

  it("warns and falls through to the next source when a lookup throws", async () => {
    const inner = failingInner();
    const order: string[] = [];
    const throwing: MetadataFallbackSource = {
      id: "broken-source",
      lookup<T>(): Promise<CacheHit<T> | undefined> {
        order.push("broken-source");
        return Promise.reject(new Error("corrupt row"));
      },
    };
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [throwing, fakeSource("second-hit", staleHit(["cached"]), order)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.listArtists()).resolves.toEqual(["cached"]);
    expect(order).toEqual(["broken-source", "second-hit"]);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("stale-cache source 'broken-source' failed"),
    );
  });

  it("rethrows the original error when every source misses", async () => {
    const error = new LidarrUnreachableError("lidarr list artists");
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("first-miss", undefined), fakeSource("second-miss", undefined)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
  });

  it("never serves stale for a rate-limited failure (service is up)", async () => {
    const error = new RateLimitedError("lidarr list artists", 20);
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(error);
    const order: string[] = [];
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", staleHit([]), order)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBe(error);
    expect(order).toEqual([]);
  });

  it("never serves stale for uncached operations", async () => {
    const error = new LidarrUnreachableError("lidarr wanted missing");
    const inner = createLidarrClientMock();
    inner.getWantedMissing.mockRejectedValue(error);
    const order: string[] = [];
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", staleHit([]), order)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.getWantedMissing()).rejects.toBe(error);
    expect(order).toEqual([]);
  });

  it("is disabled entirely when cacheTtlSeconds is 0", async () => {
    const inner = failingInner();
    const order: string[] = [];
    const { deps } = createSeams({
      openDb: async () => db,
      fallbackSources: [fakeSource("sqlite-cache", staleHit([]), order)],
    });
    const wrapped = createResilientLidarrClient(
      inner,
      ORIGIN,
      policyWith({ retryAttempts: 0, cacheTtlSeconds: 0 }),
      { allowStale: true },
      deps,
    );

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
    expect(order).toEqual([]);
  });
});

describe("default sqlite fallback source (end-to-end)", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function decorator(
    policy: ResolvedResiliencePolicy,
    onStaleServe?: Mock<(status: LidarrCacheStatus) => void>,
  ): ReturnType<typeof createResilientLidarrClient> {
    const inner = createLidarrClientMock();
    inner.listArtists.mockRejectedValue(new LidarrUnreachableError("lidarr list artists"));
    // No fallbackSources override: exercises the default [sqliteCacheSource].
    return createResilientLidarrClient(
      inner,
      ORIGIN,
      policy,
      { allowStale: true, ...(onStaleServe === undefined ? {} : { onStaleServe }) },
      { delay: async () => {}, random: () => 0, openDb: async () => db },
    );
  }

  it("serves a cached row within cacheStaleMaxAgeSeconds", async () => {
    const artists = [createLidarrArtistFixture()];
    const thirtyMinutesAgo = new Date(Date.now() - 1_800_000);
    writeLidarrCache(db, ORIGIN, "artists", "", artists, undefined, () => thirtyMinutesAgo);
    const onStaleServe = vi.fn<(status: LidarrCacheStatus) => void>();
    const wrapped = decorator(
      policyWith({ retryAttempts: 0, cacheStaleMaxAgeSeconds: 3_600 }),
      onStaleServe,
    );

    await expect(wrapped.listArtists()).resolves.toEqual(artists);
    expect(onStaleServe).toHaveBeenCalledTimes(1);
    const status = onStaleServe.mock.calls[0]?.[0];
    expect(status?.source).toBe("stale-cache");
    expect(status?.ageSeconds ?? -1).toBeGreaterThanOrEqual(1_800);
    expect(status?.ageSeconds ?? -1).toBeLessThan(1_805);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      "Lidarr unreachable — serving cached data from 30m ago (--allow-stale).",
    );
  });

  it("misses a row beyond cacheStaleMaxAgeSeconds and rethrows", async () => {
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    writeLidarrCache(db, ORIGIN, "artists", "", [], undefined, () => twoHoursAgo);
    const wrapped = decorator(policyWith({ retryAttempts: 0, cacheStaleMaxAgeSeconds: 3_600 }));

    await expect(wrapped.listArtists()).rejects.toBeInstanceOf(LidarrUnreachableError);
  });
});

describe("cache write-through", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-resilience-test-"));
    db = await initializeDatabase(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes listArtists and getSystemStatus through without credentials in rows", async () => {
    const artists = [createLidarrArtistFixture()];
    const inner = createLidarrClientMock();
    inner.listArtists.mockResolvedValue(artists);
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);

    await expect(wrapped.listArtists()).resolves.toBe(artists);
    await wrapped.getSystemStatus();
    await wrapped.listAlbums({ artistId: 1 });

    const nowSeam = (): Date => new Date(NOW_ISO);
    const artistsHit = readLidarrCache(db, ORIGIN, "artists", "", 900_000, 86_400_000, nowSeam);
    expect(artistsHit?.value).toEqual(artists);
    expect(artistsHit?.fresh).toBe(true);
    const statusHit = readLidarrCache(
      db,
      ORIGIN,
      "system-status",
      "",
      900_000,
      86_400_000,
      nowSeam,
    );
    expect(statusHit?.value).toEqual(HEALTHY_STATUS);

    const rows = db
      .prepare("SELECT origin, category, payload_json FROM lidarr_metadata_cache")
      .all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
  });

  it("skips write-through for uncached operations", async () => {
    const inner = createLidarrClientMock();
    inner.listAlbums.mockResolvedValue([createLidarrAlbumFixture()]);
    const { deps, openDbMock } = createSeams();
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);

    await wrapped.getHealth();
    await wrapped.getWantedMissing();
    await wrapped.listAlbums({ artistId: 1 });

    expect(openDbMock).not.toHaveBeenCalled();
  });

  it("never reads from nor writes to the cache for listAlbums under a real TTL", async () => {
    const albums = Object.freeze([createLidarrAlbumFixture()]);
    const inner = createLidarrClientMock();
    inner.listAlbums.mockResolvedValue(albums);
    const { deps } = createSeams({ openDb: async () => db });
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);
    const query = { artistId: 7 };

    await expect(wrapped.listAlbums(query)).resolves.toBe(albums);
    await expect(wrapped.listAlbums(query)).resolves.toBe(albums);

    expect(inner.listAlbums).toHaveBeenCalledTimes(2);
    expect(inner.listAlbums).toHaveBeenNthCalledWith(1, query);
    expect(inner.listAlbums).toHaveBeenNthCalledWith(2, query);
    const rows = db.prepare("SELECT category FROM lidarr_metadata_cache").all();
    expect(rows).toHaveLength(0);
  });

  it("warns and preserves the result when the cache write fails", async () => {
    const artists = [createLidarrArtistFixture()];
    const inner = createLidarrClientMock();
    inner.listArtists.mockResolvedValue(artists);
    const { deps } = createSeams({ openDb: () => Promise.reject(new Error("disk full")) });
    const wrapped = createResilientLidarrClient(inner, ORIGIN, policyWith(), {}, deps);

    await expect(wrapped.listArtists()).resolves.toBe(artists);
    expect(mockLogger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write Lidarr metadata cache (artists)"),
    );
  });
});
