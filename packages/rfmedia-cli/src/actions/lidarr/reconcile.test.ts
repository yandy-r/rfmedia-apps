import { describe, expect, it, vi } from "vitest";

import { createMediaServerAdapterMock } from "../test-helpers/media-server-adapter-mocks.js";
import { createLidarrArtistFixture } from "../test-helpers/lidarr-fixtures.js";
import { resolveArtistIdentities } from "../../lib/bridge/mapping.js";
import { reconcilePlexLidarrSnapshot } from "../../lib/bridge/reconcile.js";
import {
  BridgeIdentityCacheError,
  type BridgeArtistIdentitySnapshot,
  type BridgeIdentityCompatibleScopeResult,
} from "../../types/bridge.js";
import { createLidarrScheduler, resolveLidarrSchedulerPolicy } from "../../lib/lidarr/scheduler.js";
import { executeLidarrReconcile, type LidarrReconcileDependencies } from "./reconcile.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { DbConnection } from "../../types/db.js";
import type { MediaArtistIdentity } from "../../types/media-server.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const SCOPE = Object.freeze({
  plexOrigin: "https://plex.example.test",
  plexInstanceId: "machine-1",
  plexLibraryId: "7",
  lidarrOrigin: "https://lidarr.example.test",
  entityKind: "artist" as const,
});
const SOURCE: MediaArtistIdentity = Object.freeze({
  id: "plex-1",
  kind: "artist",
  title: "Artist",
  externalIds: Object.freeze([
    { namespace: "musicbrainz" as const, kind: "artist" as const, value: MBID },
  ]),
});
const TARGET = createLidarrArtistFixture({
  id: 1,
  artistName: "Artist",
  foreignArtistId: MBID,
});

function snapshot(provenance: "live" | "offline" = "offline"): BridgeArtistIdentitySnapshot {
  const live = resolveArtistIdentities({
    scope: SCOPE,
    sourceArtists: [SOURCE],
    targetArtists: [TARGET],
    sourceComplete: true,
    targetComplete: true,
    capturedAt: NOW.toISOString(),
    verifiedAt: NOW.toISOString(),
  });
  if (provenance === "live") return live;
  return Object.freeze({
    ...live,
    provenance: Object.freeze({
      source: "sqlite-cache" as const,
      mode: "offline" as const,
      freshness: "stale" as const,
      ageSeconds: 0,
    }),
  });
}

const COMPATIBLE_SCOPE: BridgeIdentityCompatibleScopeResult = Object.freeze({
  scope: SCOPE,
  capturedAt: NOW.toISOString(),
  verifiedAt: NOW.toISOString(),
  ageSeconds: 0,
});

interface Harness {
  readonly dependencies: LidarrReconcileDependencies;
  readonly adapter: ReturnType<typeof createMediaServerAdapterMock>;
  readonly listLidarrArtists: ReturnType<typeof vi.fn>;
  readonly database: DbConnection;
  readonly requireAdapter: ReturnType<typeof vi.fn>;
  readonly resolveClient: ReturnType<typeof vi.fn>;
  readonly resolveScheduler: ReturnType<typeof vi.fn>;
  readonly initializeDatabase: ReturnType<typeof vi.fn>;
  readonly openDatabaseReadOnly: ReturnType<typeof vi.fn>;
  readonly closeDatabase: ReturnType<typeof vi.fn>;
  readonly findCompatibleScopes: ReturnType<typeof vi.fn>;
  readonly readSnapshot: ReturnType<typeof vi.fn>;
  readonly replaceSnapshot: ReturnType<typeof vi.fn>;
}

function createHarness(): Harness {
  const adapter = createMediaServerAdapterMock({
    identity: {
      getInstanceId: async () => "machine-1",
      listArtists: async ({ offset = 0 }) =>
        Object.freeze({
          libraryId: "7",
          items: Object.freeze(offset === 0 ? [SOURCE] : []),
          total: 1,
          offset,
          returned: offset === 0 ? 1 : 0,
          hasMore: false,
        }),
    },
  });
  const listLidarrArtists = vi.fn(async () => Object.freeze([TARGET]));
  const client = { listArtists: listLidarrArtists } as unknown as LidarrClientApi;
  const scheduler = createLidarrScheduler(resolveLidarrSchedulerPolicy());
  const database = { close: vi.fn() } as unknown as DbConnection;
  const requireAdapter = vi.fn(() => adapter.adapter);
  const resolveClient = vi.fn(() => client);
  const resolveScheduler = vi.fn(() => scheduler);
  const initializeDatabase = vi.fn(async () => database);
  const openDatabaseReadOnly = vi.fn(() => database);
  const closeDatabase = vi.fn();
  const findCompatibleScopes = vi.fn(() => Object.freeze([COMPATIBLE_SCOPE]));
  const readSnapshot = vi.fn(() => snapshot());
  const replaceSnapshot = vi.fn();

  const dependencies = {
    requireMediaServerAdapter: requireAdapter,
    resolvePlexOrigin: vi.fn(() => SCOPE.plexOrigin),
    resolveLidarrOrigin: vi.fn(() => SCOPE.lidarrOrigin),
    resolveLidarrOriginWithoutCredentials: vi.fn(() => SCOPE.lidarrOrigin),
    resolveLidarrClient: resolveClient,
    resolveScheduler,
    initializeDatabase,
    openDatabaseReadOnly,
    closeDatabase,
    defaultDatabasePath: vi.fn(() => "/tracking.db"),
    findCompatibleScopes,
    readSnapshot,
    replaceSnapshot,
    resolveIdentities: resolveArtistIdentities,
    reconcileSnapshot: reconcilePlexLidarrSnapshot,
    now: () => NOW,
  } satisfies LidarrReconcileDependencies;

  return {
    dependencies,
    adapter,
    listLidarrArtists,
    database,
    requireAdapter,
    resolveClient,
    resolveScheduler,
    initializeDatabase,
    openDatabaseReadOnly,
    closeDatabase,
    findCompatibleScopes,
    readSnapshot,
    replaceSnapshot,
  };
}

const LIVE_OPTIONS = Object.freeze({
  plexLibrary: "Music",
  plexUrl: SCOPE.plexOrigin,
  plexToken: "secret-plex-token",
  lidarrUrl: SCOPE.lidarrOrigin,
  lidarrApiKey: "secret-lidarr-key",
  databasePath: "/tracking.db",
});

describe("executeLidarrReconcile lifecycle", () => {
  it.each([
    {
      name: "cancellation before start performs no work",
      run: async () => {
        const harness = createHarness();
        const controller = new AbortController();
        controller.abort();
        await expect(
          executeLidarrReconcile(
            { ...LIVE_OPTIONS, signal: controller.signal },
            harness.dependencies,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(harness.requireAdapter).not.toHaveBeenCalled();
        expect(harness.openDatabaseReadOnly).not.toHaveBeenCalled();
      },
    },
    {
      name: "cancellation during Plex paging reaches the page and retains cache",
      run: async () => {
        const harness = createHarness();
        const controller = new AbortController();
        harness.adapter.identity!.listArtists.mockImplementationOnce(async ({ signal }) => {
          controller.abort();
          signal?.throwIfAborted();
          throw new Error("unreachable");
        });
        await expect(
          executeLidarrReconcile(
            { ...LIVE_OPTIONS, signal: controller.signal },
            harness.dependencies,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(harness.adapter.identity!.listArtists).toHaveBeenCalledWith(
          expect.objectContaining({ signal: controller.signal }),
        );
        expect(harness.replaceSnapshot).not.toHaveBeenCalled();
      },
    },
    {
      name: "cancellation during Lidarr acquisition reaches the facade and retains cache",
      run: async () => {
        const harness = createHarness();
        const controller = new AbortController();
        harness.listLidarrArtists.mockImplementationOnce(async (signal: AbortSignal) => {
          controller.abort();
          signal.throwIfAborted();
          return [];
        });
        await expect(
          executeLidarrReconcile(
            { ...LIVE_OPTIONS, signal: controller.signal },
            harness.dependencies,
          ),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(harness.listLidarrArtists).toHaveBeenCalledWith(controller.signal);
        expect(harness.replaceSnapshot).not.toHaveBeenCalled();
      },
    },
    {
      name: "cancellation before replacement retains the previous generation",
      run: async () => {
        const harness = createHarness();
        const controller = new AbortController();
        const dependencies: LidarrReconcileDependencies = {
          ...harness.dependencies,
          resolveIdentities: (input) => {
            const resolved = resolveArtistIdentities(input);
            controller.abort();
            return resolved;
          },
        };
        await expect(
          executeLidarrReconcile({ ...LIVE_OPTIONS, signal: controller.signal }, dependencies),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(harness.initializeDatabase).not.toHaveBeenCalled();
        expect(harness.replaceSnapshot).not.toHaveBeenCalled();
      },
    },
    {
      name: "missing provider-neutral identity capability fails before reads",
      run: async () => {
        const harness = createHarness();
        harness.requireAdapter.mockReturnValue(createMediaServerAdapterMock().adapter);
        await expect(
          executeLidarrReconcile(LIVE_OPTIONS, harness.dependencies),
        ).rejects.toMatchObject({
          code: "configuration",
          message: expect.stringContaining("identity capability"),
        });
        expect(harness.listLidarrArtists).not.toHaveBeenCalled();
      },
    },
    {
      name: "stalled Plex paging fails closed without replacing cache",
      run: async () => {
        const harness = createHarness();
        harness.adapter.identity!.listArtists.mockResolvedValueOnce(
          Object.freeze({
            libraryId: "7",
            items: Object.freeze([]),
            total: 1,
            offset: 0,
            returned: 0,
            hasMore: true,
          }),
        );
        await expect(
          executeLidarrReconcile(LIVE_OPTIONS, harness.dependencies),
        ).rejects.toMatchObject({
          code: "invalid-response",
          message: expect.stringContaining("forward progress"),
        });
        expect(harness.replaceSnapshot).not.toHaveBeenCalled();
      },
    },
    {
      name: "live replacement failure propagates and closes the database exactly once",
      run: async () => {
        const harness = createHarness();
        const failure = new BridgeIdentityCacheError("Snapshot replacement failed.", {
          code: "database",
          operation: "replace",
        });
        harness.replaceSnapshot.mockImplementation(() => {
          throw failure;
        });
        let result: Awaited<ReturnType<typeof executeLidarrReconcile>> | undefined;
        await expect(
          executeLidarrReconcile(LIVE_OPTIONS, harness.dependencies).then((value) => {
            result = value;
            return value;
          }),
        ).rejects.toBe(failure);
        expect(result).toBeUndefined();
        expect(harness.closeDatabase).toHaveBeenCalledTimes(1);
        expect(harness.closeDatabase).toHaveBeenCalledWith(harness.database);
      },
    },
    {
      name: "missing offline scope fails closed and closes the database",
      run: async () => {
        const harness = createHarness();
        harness.findCompatibleScopes.mockReturnValue([]);
        await expect(
          executeLidarrReconcile({ offline: true }, harness.dependencies),
        ).rejects.toThrow("missing-compatible-snapshot");
        expect(harness.closeDatabase).toHaveBeenCalledWith(harness.database);
      },
    },
    {
      name: "ambiguous offline scope is never guessed",
      run: async () => {
        const harness = createHarness();
        harness.findCompatibleScopes.mockReturnValue([
          COMPATIBLE_SCOPE,
          {
            ...COMPATIBLE_SCOPE,
            scope: { ...SCOPE, plexInstanceId: "machine-2", plexLibraryId: "8" },
          },
        ]);
        await expect(
          executeLidarrReconcile({ offline: true }, harness.dependencies),
        ).rejects.toThrow("ambiguous-snapshot-scope");
        expect(harness.readSnapshot).not.toHaveBeenCalled();
      },
    },
    ...(["corrupt-payload", "incompatible-version"] as const).map((code) => ({
      name: `${code} offline cache failure remains typed and closes the database`,
      run: async () => {
        const harness = createHarness();
        harness.readSnapshot.mockImplementation(() => {
          throw new BridgeIdentityCacheError("Cached bridge snapshot is unusable.", {
            code,
            operation: "read",
          });
        });
        await expect(
          executeLidarrReconcile({ offline: true }, harness.dependencies),
        ).rejects.toMatchObject({ code, operation: "read" });
        expect(harness.closeDatabase).toHaveBeenCalledWith(harness.database);
      },
    })),
    {
      name: "database closure runs in finally when scope discovery fails",
      run: async () => {
        const harness = createHarness();
        harness.findCompatibleScopes.mockImplementation(() => {
          throw new Error("read failed");
        });
        await expect(
          executeLidarrReconcile({ offline: true }, harness.dependencies),
        ).rejects.toThrow("read failed");
        expect(harness.closeDatabase).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "offline exact read performs zero provider, scheduler, migration, or write work",
      run: async () => {
        const harness = createHarness();
        const result = await executeLidarrReconcile(
          { offline: true, plexLibraryId: "7", duplicates: true },
          harness.dependencies,
        );
        expect(result.report.provenance).toMatchObject({
          mode: "offline",
          freshness: "stale",
        });
        expect(harness.findCompatibleScopes).toHaveBeenCalledWith(
          harness.database,
          expect.objectContaining({ plexLibraryId: "7" }),
          harness.dependencies.now,
        );
        expect(harness.readSnapshot).toHaveBeenCalledWith(
          harness.database,
          SCOPE,
          harness.dependencies.now,
        );
        expect(harness.requireAdapter).not.toHaveBeenCalled();
        expect(harness.resolveClient).not.toHaveBeenCalled();
        expect(harness.resolveScheduler).not.toHaveBeenCalled();
        expect(harness.initializeDatabase).not.toHaveBeenCalled();
        expect(harness.replaceSnapshot).not.toHaveBeenCalled();
      },
    },
    {
      name: "live and offline classification are equivalent from the same snapshot",
      run: async () => {
        const harness = createHarness();
        let stored: BridgeArtistIdentitySnapshot | undefined;
        harness.replaceSnapshot.mockImplementation((_database, value) => {
          stored = value;
        });
        const live = await executeLidarrReconcile(LIVE_OPTIONS, harness.dependencies);
        expect(stored).toBeDefined();
        harness.readSnapshot.mockImplementation(() =>
          Object.freeze({
            ...stored!,
            provenance: Object.freeze({
              source: "sqlite-cache" as const,
              mode: "offline" as const,
              freshness: "stale" as const,
              ageSeconds: 0,
            }),
          }),
        );
        const offline = await executeLidarrReconcile(
          { offline: true, databasePath: "/tracking.db" },
          harness.dependencies,
        );
        expect(offline.report.summary).toEqual(live.report.summary);
        expect(offline.report.matchedExact).toEqual(live.report.matchedExact);
        expect(offline.report.plexOnly).toEqual(live.report.plexOnly);
        expect(offline.report.lidarrOnly).toEqual(live.report.lidarrOnly);
        expect(live.execution).toMatchObject({ lane: "local-only", outcome: "succeeded" });
        expect(offline.execution).toBeUndefined();
      },
    },
  ])("$name", async ({ run }) => {
    await run();
  });
});
