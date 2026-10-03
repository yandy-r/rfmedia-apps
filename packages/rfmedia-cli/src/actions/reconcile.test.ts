import type { Stats } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import type {
  DbConnection,
  DbReconciliationInventoryCandidate,
  ReconciliationDatabaseAuthorityLease,
} from "../types/db.js";
import type { MediaServerAdapter, MediaTrack } from "../types/media-server.js";
import {
  closeDatabase,
  createOperation,
  getReconciliationInventoryCandidates,
  getReconciliationInventoryCandidatesAtPath,
  initializeDatabase,
  openReconciliationDatabaseAuthorityLease,
  openReconciliationDatabaseReadOnly,
  recordInventoryFile,
  updateReconciliationInventory,
  withReconciliationDatabaseWritable,
} from "../lib/db.js";
import { MAX_RECONCILIATION_PROJECTED_TEXT_BYTES } from "../lib/reconciliation-limits.js";
import { projectRatingWrite } from "../lib/tag-writer.js";
import {
  executeReconciliation,
  MAX_RECONCILIATION_FILE_CANDIDATES,
  type ReconciliationActionDependencies,
  type ReconciliationApplyActionOptions,
} from "./reconcile.js";

const SOURCE_ROOT = "/music";
const TRACK_PATH = `${SOURCE_ROOT}/song.mp3`;
const ACTIONABLE_PATH = `${SOURCE_ROOT}/actionable.mp3`;
const DATABASE_PATH = "/state/rfmedia.db";

type FixtureScenario =
  | "baseline"
  | "success"
  | "two-success"
  | "partial"
  | "drift"
  | "server-failure";

interface FixtureRecord {
  readonly path: string;
  readonly rowId: number;
  readonly fileRating: number;
  readonly databaseRating: number | null;
  readonly serverRating: number;
  readonly staleStat?: boolean;
}

interface FixtureOptions {
  readonly path?: string;
  readonly fileRating?: number;
  readonly databaseRating?: number;
  readonly serverRating?: number;
}

function createFixture(scenario: FixtureScenario = "baseline", options: FixtureOptions = {}) {
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as Stats;
  const database = {} as DbConnection;
  const databaseIdentity = { device: 10, inode: 20 };
  const databaseGeneration = {
    ...databaseIdentity,
    size: 4_096,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
  };
  const records: readonly FixtureRecord[] =
    scenario === "partial"
      ? [
          {
            path: TRACK_PATH,
            rowId: 1,
            fileRating: 0.8,
            databaseRating: null,
            serverRating: 0.2,
          },
          {
            path: ACTIONABLE_PATH,
            rowId: 2,
            fileRating: 0.2,
            databaseRating: 0.8,
            serverRating: 0.4,
          },
        ]
      : scenario === "two-success"
        ? [
            {
              path: TRACK_PATH,
              rowId: 1,
              fileRating: 0.2,
              databaseRating: 0.8,
              serverRating: 0.4,
              staleStat: true,
            },
            {
              path: ACTIONABLE_PATH,
              rowId: 2,
              fileRating: 0.2,
              databaseRating: 0.8,
              serverRating: 0.4,
              staleStat: true,
            },
          ]
        : [
            scenario === "success" || scenario === "server-failure"
              ? {
                  path: options.path ?? TRACK_PATH,
                  rowId: 1,
                  fileRating: options.fileRating ?? 0.2,
                  databaseRating: options.databaseRating ?? 0.8,
                  serverRating: options.serverRating ?? 0.4,
                  staleStat: true,
                }
              : {
                  path: TRACK_PATH,
                  rowId: 1,
                  fileRating: 0.8,
                  databaseRating: null,
                  serverRating: 0.2,
                },
          ];
  const fileRatings = new Map(records.map((record) => [record.path, record.fileRating]));
  const serverRatings = new Map(records.map((record) => [record.path, record.serverRating]));
  const extraServerTracks: MediaTrack[] = [];
  const stats = new Map(
    records.map((record) => [
      record.path,
      {
        dev: 1,
        ino: record.rowId + 1,
        nlink: 1,
        size: 1_024 + record.rowId,
        mtimeMs: 1_700_000_000_000 + record.rowId,
        ctimeMs: 1_700_000_000_000 + record.rowId,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as Stats,
    ]),
  );
  const databaseRows: DbReconciliationInventoryCandidate[] = records.map((record) => {
    const fileStats = stats.get(record.path)!;
    return {
      id: record.rowId,
      operation_id: 10,
      source_path: `/imports/${record.rowId}.flac`,
      relative_path: record.path.slice(SOURCE_ROOT.length + 1),
      mtime: Math.trunc(fileStats.mtimeMs) - (record.staleStat ? 1 : 0),
      size: fileStats.size - (record.staleStat ? 1 : 0),
      rating: record.databaseRating,
      genre: "Rock",
      year: 2024,
      bpm: null,
      artist: "Artist",
      dest_path: record.path,
      content_hash: null,
      copied_at: 1_700_000_000,
    };
  });
  const events: string[] = [];

  const confirm = vi.fn<ReconciliationActionDependencies["confirm"]>(async () => true);
  const assertDatabaseGenerationCurrent =
    vi.fn<ReconciliationActionDependencies["assertReconciliationDatabaseGenerationCurrent"]>();
  const withDatabaseWritable = vi.fn();
  const runWithDatabaseWritable: ReconciliationActionDependencies["withReconciliationDatabaseWritable"] =
    (path, generation, operation) => {
      withDatabaseWritable(path, generation, operation);
      return { value: operation(database), generation: databaseGeneration };
    };
  const authorityLeases: ReconciliationDatabaseAuthorityLease[] = [];
  const openAuthorityLease = vi.fn<
    ReconciliationActionDependencies["openReconciliationDatabaseAuthorityLease"]
  >(() => {
    let active = true;
    const lease: ReconciliationDatabaseAuthorityLease = {
      connection: database,
      commit: vi.fn(() => {
        if (!active) throw new Error("Reconciliation database authority lease is closed.");
        active = false;
        return databaseGeneration;
      }),
      rollback: vi.fn(() => {
        active = false;
      }),
      close: vi.fn(() => {
        active = false;
      }),
    };
    authorityLeases.push(lease);
    return lease;
  });
  const writeRating = vi.fn<ReconciliationActionDependencies["writeRating"]>(
    async (path, rating) => {
      events.push("file");
      const projected = projectRatingWrite(path, rating);
      fileRatings.set(path, projected.normalized ?? rating);
      return { success: true, message: "updated" };
    },
  );
  const updateTrackRating = vi.fn<MediaServerAdapter["metadata"]["updateTrackRating"]>(
    async (trackId, rating) => {
      events.push("server");
      if (scenario === "server-failure") {
        return { success: false, message: "failed" };
      }
      const record = records.find((candidate) => `track-${candidate.rowId}` === trackId)!;
      serverRatings.set(record.path, rating ?? 0);
      return { success: true, message: "updated" };
    },
  );
  const updateInventory = vi.fn<ReconciliationActionDependencies["updateReconciliationInventory"]>(
    (_connection, update) => {
      events.push("database");
      const row = databaseRows.find((candidate) => candidate.id === update.expected.rowId)!;
      if (update.rating !== undefined) row.rating = update.rating;
      if (update.stat !== undefined) {
        row.mtime = update.stat.mtime;
        row.size = update.stat.size;
      }
      return { status: "updated", rowId: row.id };
    },
  );
  const queryTracks = vi.fn<MediaServerAdapter["query"]["tracks"]>(async () => {
    const items = [
      ...records.map(
        (record): MediaTrack => ({
          id: `track-${record.rowId}`,
          kind: "track",
          title: `Song ${record.rowId}`,
          artist: "Artist",
          album: "Album",
          rating: serverRatings.get(record.path)!,
          year: 2024,
          genres: ["Rock"],
          playCount: 0,
          durationMs: 180_000,
          filePath: record.path,
        }),
      ),
      ...extraServerTracks,
    ];
    return {
      items,
      total: items.length,
      offset: 0,
      returned: items.length,
      hasMore: false,
    };
  });
  const queryLibraryContentVersion = vi.fn<MediaServerAdapter["query"]["libraryContentVersion"]>(
    async () => ({
      libraryId: "library-1",
      value: "content-version-1",
    }),
  );
  const queryTrackById = vi.fn<MediaServerAdapter["query"]["trackById"]>(async (trackId) => {
    const record = records.find((candidate) => `track-${candidate.rowId}` === trackId);
    if (record === undefined) throw new Error("track not found");
    return {
      id: trackId,
      kind: "track",
      title: `Song ${record.rowId}`,
      artist: "Artist",
      album: "Album",
      rating: serverRatings.get(record.path)!,
      year: 2024,
      genres: ["Rock"],
      playCount: 0,
      durationMs: 180_000,
      filePath: record.path,
    };
  });

  const adapter: MediaServerAdapter = {
    type: "test",
    capabilities: {
      query: true,
      library: false,
      scan: false,
      playlist: false,
      collection: false,
      metadata: true,
    },
    features: {
      ratings: {
        readable: true,
        writable: true,
        normalized: true,
        nativeScale: { min: 0, max: 10, step: 1 },
      },
      smartPlaylists: false,
      smartCollections: false,
      pathScopedScans: false,
      filterPushdown: { supported: false, fields: [], operators: [] },
      sonicAnalysis: "unavailable",
    },
    query: {
      libraryContentVersion: queryLibraryContentVersion,
      trackById: queryTrackById,
      tracks: queryTracks,
      albums: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        returned: 0,
        hasMore: false,
      })),
      artists: vi.fn(async () => ({
        items: [],
        total: 0,
        offset: 0,
        returned: 0,
        hasMore: false,
      })),
      albumTracks: vi.fn(async () => []),
    },
    library: {
      list: vi.fn(async () => []),
      byName: async (name) => ({ id: "library-1", title: name, kind: "track" }),
    },
    scan: {
      trigger: vi.fn(async () => ({ success: true, message: "unused" })),
      triggerPath: vi.fn(async () => ({ success: true, message: "unused" })),
      triggerSource: vi.fn(async () => ({ success: true, message: "unused" })),
    },
    playlist: {
      list: vi.fn(async () => []),
      byName: vi.fn(async (name) => ({
        id: "playlist-1",
        title: name,
        smart: false,
        itemCount: 0,
        durationMs: 0,
      })),
      delete: vi.fn(async () => undefined),
      tracks: vi.fn(async () => []),
      create: vi.fn(async (name) => ({
        id: "playlist-1",
        title: name,
        smart: false,
        itemCount: 0,
        durationMs: 0,
      })),
      addTracks: vi.fn(async () => undefined),
    },
    collection: {
      list: vi.fn(async () => []),
      get: async (id) => ({
        id,
        title: "Collection",
        kind: "track" as const,
        itemCount: 0,
        smart: false,
      }),
      byName: async (_libraryId, name) => ({
        id: "collection-1",
        title: name,
        kind: "track" as const,
        itemCount: 0,
        smart: false,
      }),
      items: vi.fn(async () => []),
      create: vi.fn(async (_libraryId, input) => ({
        id: "collection-1",
        title: input.title,
        kind: input.kind,
        itemCount: 0,
        smart: false,
      })),
      addItems: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    },
    metadata: { updateTrackRating },
  };

  const freshAdapters: MediaServerAdapter[] = [];
  const createAdapter = vi.fn((): MediaServerAdapter => {
    const fresh = {
      ...adapter,
      query: { ...adapter.query },
      metadata: { updateTrackRating },
    };
    freshAdapters.push(fresh);
    return fresh;
  });
  const testLstat = vi.fn(
    async (path: Parameters<ReconciliationActionDependencies["lstat"]>[0]) => {
      if (path === SOURCE_ROOT) return directoryStats;
      const fileStats = stats.get(String(path))!;
      if (scenario !== "drift" || createAdapter.mock.calls.length < 2) return fileStats;
      return {
        ...fileStats,
        mtimeMs: fileStats.mtimeMs + 1,
        ctimeMs: fileStats.ctimeMs + 1,
      } as Stats;
    },
  ) as unknown as ReconciliationActionDependencies["lstat"];
  const readReconciliationMetadata = vi.fn<
    ReconciliationActionDependencies["readReconciliationMetadata"]
  >(async (path) => ({
    ok: true,
    metadata: { rating: fileRatings.get(path)!, artist: "Artist", genre: "Rock", year: 2024 },
  }));
  const getLoadedConfig = vi.fn<ReconciliationActionDependencies["getLoadedConfig"]>(() => ({
    plex: { libraryName: "Music" },
  }));

  const dependencies: Partial<ReconciliationActionDependencies> = {
    findAudioFilesNoFollow: vi.fn(async () => records.map((record) => record.path)),
    lstat: testLstat,
    readReconciliationMetadata,
    getLoadedConfig,
    openReconciliationDatabaseReadOnly: vi.fn(() => ({
      database,
      identity: databaseIdentity,
      generation: databaseGeneration,
    })),
    openReconciliationDatabaseAuthorityLease: openAuthorityLease,
    assertReconciliationDatabaseGenerationCurrent: assertDatabaseGenerationCurrent,
    closeDatabase: vi.fn(),
    getReconciliationInventoryCandidates: vi.fn(() => databaseRows),
    getReconciliationInventoryCandidatesAtPath: vi.fn((_connection, path, operationId) =>
      databaseRows
        .filter(
          (row) =>
            row.dest_path === path &&
            (operationId === undefined || row.operation_id === operationId),
        )
        .slice(0, 2),
    ),
    withReconciliationDatabaseWritable: runWithDatabaseWritable,
    updateReconciliationInventory: updateInventory,
    createAdapter,
    advancePaginationOffset: vi.fn((page) => page.offset + page.returned),
    writeRating,
    confirm,
    isInteractive: vi.fn(() => true),
  };

  return {
    dependencies,
    authorityLeases,
    databaseRows,
    events,
    extraServerTracks,
    freshAdapters,
    createAdapter,
    getLoadedConfig,
    queryTrackById,
    queryLibraryContentVersion,
    queryTracks,
    guards: { assertDatabaseGenerationCurrent },
    writes: {
      confirm,
      openAuthorityLease,
      withDatabaseWritable,
      writeRating,
      updateTrackRating,
      updateInventory,
    },
  };
}

function applyOptions(
  overrides: Partial<ReconciliationApplyActionOptions> = {},
): ReconciliationApplyActionOptions {
  return {
    mode: "apply",
    sourcePath: SOURCE_ROOT,
    library: "Music",
    trackingDatabase: DATABASE_PATH,
    fileWins: true,
    ...overrides,
  };
}

function compactLocalSnapshotAccountant(maximumRows: number) {
  return vi.fn<ReconciliationActionDependencies["accountReconciliationLocalSnapshotBytes"]>(
    (currentRows) =>
      currentRows < maximumRows
        ? { ok: true, bytes: currentRows + 1 }
        : { ok: false, reason: "snapshot-too-large" },
  );
}

function expectNoWrites(writes: ReturnType<typeof createFixture>["writes"]): void {
  expect(writes.confirm).not.toHaveBeenCalled();
  expect(writes.openAuthorityLease).not.toHaveBeenCalled();
  expect(writes.withDatabaseWritable).not.toHaveBeenCalled();
  expect(writes.writeRating).not.toHaveBeenCalled();
  expect(writes.updateTrackRating).not.toHaveBeenCalled();
  expect(writes.updateInventory).not.toHaveBeenCalled();
}

describe("executeReconciliation write gates", () => {
  it.each([
    [
      "scan",
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        library: "Music",
        trackingDatabase: DATABASE_PATH,
      } as const,
    ],
    ["preview", applyOptions({ execute: false })],
  ])(
    "propagates metadata read failures from %s as typed nonzero errors",
    async (_label, options) => {
      const fixture = createFixture();
      Object.assign(fixture.dependencies, {
        readReconciliationMetadata: vi.fn(async () => ({
          ok: false,
          error: { code: "read-failed" as const },
        })),
      });

      await expect(executeReconciliation(options, fixture.dependencies)).rejects.toMatchObject({
        name: "ReconciliationAcquisitionError",
        code: "read-failed",
      });
      expectNoWrites(fixture.writes);
    },
  );

  it("honors the worker bound and emits deterministic progress only when enabled", async () => {
    const fixture = createFixture("partial");
    const readMetadata = fixture.dependencies.readReconciliationMetadata!;
    const readImplementation = vi.mocked(readMetadata).getMockImplementation()!;
    const progress = vi.fn();
    let active = 0;
    let maximumActive = 0;
    vi.mocked(readMetadata).mockImplementation(async (path) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      const result = await readImplementation(path);
      active -= 1;
      return result;
    });
    Object.assign(fixture.dependencies, { reportProgress: progress });

    await executeReconciliation(
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        library: "Music",
        trackingDatabase: DATABASE_PATH,
        workers: 2,
        progress: true,
      },
      fixture.dependencies,
    );

    expect(maximumActive).toBe(2);
    expect(progress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);

    progress.mockClear();
    await executeReconciliation(
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        library: "Music",
        trackingDatabase: DATABASE_PATH,
        workers: 1,
        progress: false,
      },
      fixture.dependencies,
    );
    expect(progress).not.toHaveBeenCalled();
  });

  it("rejects candidate limit plus one before scheduling metadata reads", async () => {
    const fixture = createFixture();
    const findCandidates = vi.fn(async () =>
      Array.from(
        { length: MAX_RECONCILIATION_FILE_CANDIDATES + 1 },
        (_, index) => `${SOURCE_ROOT}/candidate-${index}.flac`,
      ),
    );
    Object.assign(fixture.dependencies, { findAudioFilesNoFollow: findCandidates });

    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          library: "Music",
          trackingDatabase: DATABASE_PATH,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      name: "ReconciliationAcquisitionError",
      code: "file-acquisition-failed",
      message: `Reconciliation exceeds the ${MAX_RECONCILIATION_FILE_CANDIDATES}-file candidate limit.`,
    });

    expect(findCandidates).toHaveBeenCalledWith(SOURCE_ROOT, MAX_RECONCILIATION_FILE_CANDIDATES);
    expect(fixture.dependencies.readReconciliationMetadata).not.toHaveBeenCalled();
  });

  it("accepts a local snapshot exactly at the aggregate limit", async () => {
    const fixture = createFixture("partial");
    const accountLocalSnapshot = compactLocalSnapshotAccountant(2);
    Object.assign(fixture.dependencies, {
      accountReconciliationLocalSnapshotBytes: accountLocalSnapshot,
    });

    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          library: "Music",
          trackingDatabase: DATABASE_PATH,
        },
        fixture.dependencies,
      ),
    ).resolves.toMatchObject({ status: "scanned" });
    expect(accountLocalSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rejects a local snapshot one row beyond the aggregate limit", async () => {
    const fixture = createFixture("partial");
    const accountLocalSnapshot = compactLocalSnapshotAccountant(1);
    Object.assign(fixture.dependencies, {
      accountReconciliationLocalSnapshotBytes: accountLocalSnapshot,
    });

    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          library: "Music",
          trackingDatabase: DATABASE_PATH,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      name: "ReconciliationAcquisitionError",
      code: "file-acquisition-failed",
      message: "Reconciliation local snapshot exceeds the aggregate byte limit.",
    });
    expect(accountLocalSnapshot).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized server projection before planning", async () => {
    const fixture = createFixture();
    const queryTracks = fixture.queryTracks.getMockImplementation()!;
    fixture.queryTracks.mockImplementation(async (...args) => {
      const page = await queryTracks(...args);
      return {
        ...page,
        items: page.items.map((track) => ({
          ...track,
          artist: "a".repeat(MAX_RECONCILIATION_PROJECTED_TEXT_BYTES + 1),
        })),
      };
    });

    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          library: "Music",
          trackingDatabase: DATABASE_PATH,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({
      name: "ReconciliationAcquisitionError",
      code: "server-acquisition-failed",
    });
    expectNoWrites(fixture.writes);
  });

  it("uses the trimmed configured Plex library when the option is omitted", async () => {
    const fixture = createFixture();
    fixture.getLoadedConfig.mockReturnValue({ plex: { libraryName: "  Configured Music  " } });

    const result = await executeReconciliation(
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        trackingDatabase: DATABASE_PATH,
      },
      fixture.dependencies,
    );

    expect(result.library).toBe("Configured Music");
    expect(fixture.queryTracks).toHaveBeenCalledWith(
      expect.objectContaining({ library: "Configured Music" }),
    );
  });

  it("rejects absent or blank library sources before adapter acquisition", async () => {
    const absent = createFixture();
    absent.getLoadedConfig.mockReturnValue({});
    const blank = createFixture();
    blank.getLoadedConfig.mockReturnValue({ plex: { libraryName: "   " } });

    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          trackingDatabase: DATABASE_PATH,
        },
        absent.dependencies,
      ),
    ).rejects.toThrow(
      "Reconciliation requires a non-empty media library from --library or plex.libraryName.",
    );
    await expect(
      executeReconciliation(
        {
          mode: "scan",
          sourcePath: SOURCE_ROOT,
          library: "   ",
          trackingDatabase: DATABASE_PATH,
        },
        blank.dependencies,
      ),
    ).rejects.toThrow(
      "Reconciliation requires a non-empty media library from --library or plex.libraryName.",
    );

    for (const fixture of [absent, blank]) {
      expect(fixture.createAdapter).not.toHaveBeenCalled();
      expect(fixture.queryTracks).not.toHaveBeenCalled();
    }
  });

  it("keeps scan mode read-only", async () => {
    const fixture = createFixture();

    const result = await executeReconciliation(
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        library: "Music",
        trackingDatabase: DATABASE_PATH,
      },
      fixture.dependencies,
    );

    expect(result.status).toBe("scanned");
    expectNoWrites(fixture.writes);
  });

  it("passes cancellation into an in-flight server page request", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    fixture.queryTracks.mockImplementation(
      (query) =>
        new Promise((_resolve, reject) => {
          expect(query.signal).toBe(controller.signal);
          markStarted();
          query.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("This operation was aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const execution = executeReconciliation(
      {
        mode: "scan",
        sourcePath: SOURCE_ROOT,
        library: "Music",
        trackingDatabase: DATABASE_PATH,
        signal: controller.signal,
      },
      fixture.dependencies,
    );
    await started;
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expectNoWrites(fixture.writes);
  });

  it("keeps apply without execute as a no-write preview", async () => {
    const fixture = createFixture();

    const result = await executeReconciliation(
      applyOptions({ execute: false }),
      fixture.dependencies,
    );

    expect(result.status).toBe("preview");
    expectNoWrites(fixture.writes);
  });

  it("does not let yes authorize writes without execute", async () => {
    const fixture = createFixture();

    const result = await executeReconciliation(applyOptions({ yes: true }), fixture.dependencies);

    expect(result.status).toBe("preview");
    expectNoWrites(fixture.writes);
  });

  it("returns a known requested blocker before confirmation or writable state", async () => {
    const fixture = createFixture();

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        allowPartial: false,
        fileWins: false,
        dbWins: true,
      }),
      fixture.dependencies,
    );

    expect(result.status).toBe("blocked");
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ operation: "rating", code: "missing-authority" }),
    );
    expectNoWrites(fixture.writes);
  });

  it("allows only an independent record through partial execution and reports the blocker", async () => {
    const fixture = createFixture("partial");

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        allowPartial: true,
        fileWins: false,
        dbWins: true,
      }),
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      status: "partial",
      success: false,
      exitCode: 1,
      executable: true,
      allowPartial: true,
    });
    expect(result.blockers).toContainEqual(expect.objectContaining({ path: TRACK_PATH }));
    expect(result.outcomes.filter((outcome) => outcome.path === ACTIONABLE_PATH)).toEqual([
      expect.objectContaining({ kind: "rating", target: "file", status: "applied" }),
      expect.objectContaining({ kind: "rating", target: "server", status: "applied" }),
    ]);
    expect(result.outcomes).not.toContainEqual(expect.objectContaining({ path: TRACK_PATH }));
  });

  it("orders file, server, and database-stat writes and verifies through fresh adapters", async () => {
    const fixture = createFixture("success");

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        fileWins: false,
        dbWins: true,
      }),
      fixture.dependencies,
    );

    expect(fixture.events).toEqual(["file", "server", "database"]);
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledOnce();
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledWith(DATABASE_PATH, {
      ctimeMs: 1_700_000_000_000,
      device: 10,
      inode: 20,
      mtimeMs: 1_700_000_000_000,
      size: 4_096,
    });
    expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
    expect(fixture.authorityLeases[0]!.commit).toHaveBeenCalledOnce();
    expect(fixture.createAdapter).toHaveBeenCalledTimes(4);
    expect(new Set(fixture.freshAdapters).size).toBe(4);
    expect(fixture.writes.updateInventory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stat: { mtime: 1_700_000_000_001, size: 1_025 },
      }),
    );
    expect(result).toMatchObject({
      status: "applied",
      success: true,
      exitCode: 0,
      postApply: {
        status: "verified",
        checkedPaths: 1,
        requestedRatingDrift: 0,
        pendingDatabaseStatRefreshes: 0,
      },
    });
    expect(result.outcomes).toHaveLength(3);
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "rating", target: "file", status: "applied" }),
        expect.objectContaining({ kind: "rating", target: "server", status: "applied" }),
        expect.objectContaining({ kind: "database-stat", status: "applied" }),
      ]),
    );
  });

  it("holds db-wins authority across external writes and defers a competing commit", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "rfmedia-reconcile-lease-"));
    const databasePath = join(tempDirectory, "tracking.db");
    let setupDatabase: DbConnection | undefined = await initializeDatabase(databasePath);
    let activeLease: ReconciliationDatabaseAuthorityLease | undefined;

    try {
      const operationId = createOperation(setupDatabase, {
        command: "copy-filter",
        mode: "filter",
        inputFile: null,
        optionsHash: "reconcile-lease",
        ratingKey: "r80",
        rangeKey: null,
        convertKey: "mp3",
      });
      recordInventoryFile(setupDatabase, operationId, {
        sourcePath: "/imports/1.flac",
        relativePath: "song.mp3",
        mtime: 1_700_000_000_000,
        size: 1_024,
        rating: 0.8,
        genre: "Rock",
        year: 2024,
        bpm: null,
        artist: "Artist",
        destPath: TRACK_PATH,
        contentHash: null,
      });
      setupDatabase.pragma("wal_checkpoint(TRUNCATE)");
      closeDatabase(setupDatabase);
      setupDatabase = undefined;

      const fixture = createFixture("success");
      const markers: string[] = [];
      const baseWriteRating = fixture.writes.writeRating.getMockImplementation()!;
      fixture.writes.writeRating.mockImplementation(async (...args) => {
        markers.push("file");
        expect(
          activeLease?.connection
            .prepare("SELECT rating FROM inventory WHERE dest_path = ?")
            .pluck()
            .get(TRACK_PATH),
        ).toBe(0.8);
        return baseWriteRating(...args);
      });
      const baseServerWrite = fixture.writes.updateTrackRating.getMockImplementation()!;
      fixture.writes.updateTrackRating.mockImplementation(async (...args) => {
        markers.push("server");
        expect(
          activeLease?.connection
            .prepare("SELECT rating FROM inventory WHERE dest_path = ?")
            .pluck()
            .get(TRACK_PATH),
        ).toBe(0.8);
        return baseServerWrite(...args);
      });

      const openAuthorityLease = vi.fn<
        ReconciliationActionDependencies["openReconciliationDatabaseAuthorityLease"]
      >((path, generation) => {
        const lease = openReconciliationDatabaseAuthorityLease(path, generation);
        activeLease = lease;
        markers.push("lease-open");

        const competingWriter = new Database(path, { fileMustExist: true, timeout: 0 });
        try {
          expect(() =>
            competingWriter.exec(
              "BEGIN IMMEDIATE; UPDATE inventory SET rating = 0.1 WHERE id = 1; COMMIT",
            ),
          ).toThrow(/database is locked/i);
          markers.push("competing-blocked");
        } finally {
          if (competingWriter.inTransaction) competingWriter.exec("ROLLBACK");
          competingWriter.close();
        }

        return {
          connection: lease.connection,
          commit: () => {
            markers.push("lease-commit");
            const committedGeneration = lease.commit();
            const deferredWriter = new Database(path, { fileMustExist: true, timeout: 0 });
            try {
              deferredWriter.prepare("UPDATE inventory SET rating = 0.1 WHERE id = 1").run();
            } finally {
              deferredWriter.close();
            }
            markers.push("competing-commit");
            return committedGeneration;
          },
          rollback: () => lease.rollback(),
          close: () => lease.close(),
        };
      });

      Object.assign(fixture.dependencies, {
        openReconciliationDatabaseReadOnly,
        openReconciliationDatabaseAuthorityLease: openAuthorityLease,
        closeDatabase,
        getReconciliationInventoryCandidates,
        getReconciliationInventoryCandidatesAtPath,
        updateReconciliationInventory: (
          connection: DbConnection,
          update: Parameters<typeof updateReconciliationInventory>[1],
        ) => {
          markers.push("database");
          return updateReconciliationInventory(connection, update);
        },
        withReconciliationDatabaseWritable,
      } satisfies Partial<ReconciliationActionDependencies>);

      const result = await executeReconciliation(
        applyOptions({
          execute: true,
          yes: true,
          fileWins: false,
          dbWins: true,
          trackingDatabase: databasePath,
        }),
        fixture.dependencies,
      );

      expect(markers).toEqual([
        "lease-open",
        "competing-blocked",
        "file",
        "server",
        "database",
        "lease-commit",
        "competing-commit",
      ]);
      const projectedFileRating = projectRatingWrite(TRACK_PATH, 0.8).normalized;
      expect(fixture.writes.writeRating).toHaveBeenCalledWith(
        TRACK_PATH,
        projectedFileRating,
        expect.any(Object),
      );
      expect(fixture.writes.updateTrackRating).toHaveBeenCalledWith("track-1", 0.8);
      expect(result.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: "file", status: "applied" }),
          expect.objectContaining({ target: "server", status: "applied" }),
          expect.objectContaining({ kind: "database-stat", status: "applied" }),
        ]),
      );

      const releasedWriter = new Database(databasePath, { fileMustExist: true, timeout: 0 });
      try {
        expect(() => releasedWriter.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
        expect(
          releasedWriter
            .prepare("SELECT rating FROM inventory WHERE dest_path = ?")
            .pluck()
            .get(TRACK_PATH),
        ).toBe(0.1);
      } finally {
        releasedWriter.close();
      }
    } finally {
      activeLease?.close();
      if (setupDatabase?.open) closeDatabase(setupDatabase);
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("uses only the generation assertion for a server-only record", async () => {
    const fixture = createFixture();
    fixture.databaseRows[0]!.rating = 0.8;

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true }),
      fixture.dependencies,
    );

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: "rating", target: "server", status: "applied" }),
    ]);
    expect(fixture.guards.assertDatabaseGenerationCurrent).toHaveBeenCalledOnce();
    expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
  });

  it("holds database authority through a db-wins file-only record", async () => {
    const fixture = createFixture("success", { serverRating: 0.8 });
    fixture.databaseRows[0]!.mtime += 1;
    fixture.databaseRows[0]!.size += 1;

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.outcomes).toEqual([
      expect.objectContaining({ kind: "rating", target: "file", status: "applied" }),
    ]);
    expect(fixture.guards.assertDatabaseGenerationCurrent).not.toHaveBeenCalled();
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledOnce();
    expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
    expect(fixture.authorityLeases[0]!.commit).toHaveBeenCalledOnce();
  });

  it("marks FLAC file-rating reconciliation unsupported before authorization", async () => {
    const path = `${SOURCE_ROOT}/unsupported.flac`;
    const fixture = createFixture("success", { path });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        path,
        operation: "rating",
        target: "file",
        code: "unsupported-target",
      }),
    );
    expect(result.executable).toBe(false);
    expectNoWrites(fixture.writes);
  });

  it("rejects a changed exact server identity or rating before the first write", async () => {
    const fixture = createFixture("success");
    const queryImplementation = fixture.queryTrackById.getMockImplementation()!;
    fixture.queryTrackById.mockImplementation(async (...args) => {
      const track = await queryImplementation(...args);
      return { ...track, id: `${track.id}-replaced`, rating: (track.rating ?? 0) + 0.1 };
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.failureCodes).toContain("stale-evidence");
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
    );
    expectNoWrites(fixture.writes);
  });

  it.each([
    ["a new same-path duplicate", TRACK_PATH],
    ["a new track at a previously empty path", `${SOURCE_ROOT}/new.flac`],
  ])(
    "rejects %s after fresh planning without a per-path full library scan",
    async (_label, path) => {
      const fixture = createFixture("success");
      fixture.queryLibraryContentVersion.mockImplementation(async () => {
        if (fixture.queryLibraryContentVersion.mock.calls.length === 5) {
          fixture.extraServerTracks.push({
            id: `new-track-${fixture.extraServerTracks.length + 1}`,
            kind: "track",
            title: "New Track",
            artist: "Artist",
            album: "Album",
            rating: 0.4,
            playCount: 0,
            durationMs: 180_000,
            filePath: path,
          });
        }
        return {
          libraryId: "library-1",
          value:
            fixture.queryLibraryContentVersion.mock.calls.length >= 5
              ? "content-version-2"
              : "content-version-1",
        };
      });

      const result = await executeReconciliation(
        applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
        fixture.dependencies,
      );

      expect(fixture.extraServerTracks).toHaveLength(1);
      expect(fixture.queryTracks).toHaveBeenCalledTimes(4);
      expect(fixture.queryLibraryContentVersion).toHaveBeenCalledTimes(9);
      expect(result.failureCodes).toContain("stale-evidence");
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
      );
      expect(fixture.writes.writeRating).not.toHaveBeenCalled();
      expect(fixture.writes.updateTrackRating).not.toHaveBeenCalled();
      expect(fixture.writes.updateInventory).not.toHaveBeenCalled();
    },
  );

  it("repeats the uncached exact server guard between actionable records", async () => {
    const fixture = createFixture("two-success");
    const queryImplementation = fixture.queryTrackById.getMockImplementation()!;
    fixture.queryTrackById.mockImplementation(async (...args) => {
      const track = await queryImplementation(...args);
      if (fixture.queryTrackById.mock.calls.length !== 2) return track;
      return { ...track, rating: 0.1 };
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.events).toEqual(["file", "server", "database"]);
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
    );
    expect(fixture.queryTracks).toHaveBeenCalledTimes(3);
    expect(fixture.queryTrackById).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.getReconciliationInventoryCandidatesAtPath).toHaveBeenCalledTimes(
      1,
    );
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledOnce();
  });

  it("reads the CURRENT exact row before each record and gives a drifted second path zero writes", async () => {
    const fixture = createFixture("two-success");
    const snapshots = new WeakMap<DbConnection, readonly DbReconciliationInventoryCandidate[]>();
    vi.mocked(fixture.dependencies.openReconciliationDatabaseReadOnly!).mockImplementation(() => {
      const connection = {} as DbConnection;
      snapshots.set(
        connection,
        fixture.databaseRows.map((row) => ({ ...row })),
      );
      return {
        database: connection,
        identity: { device: 10, inode: 20 },
        generation: {
          device: 10,
          inode: 20,
          size: 4_096,
          mtimeMs: 1_700_000_000_000,
          ctimeMs: 1_700_000_000_000,
        },
      };
    });
    vi.mocked(fixture.dependencies.getReconciliationInventoryCandidates!).mockImplementation(
      (connection, _sourceRoot, operationId) =>
        (snapshots.get(connection) ?? []).filter(
          (row) => operationId === undefined || row.operation_id === operationId,
        ),
    );
    vi.mocked(fixture.dependencies.getReconciliationInventoryCandidatesAtPath!).mockImplementation(
      (connection, path, operationId) =>
        (snapshots.get(connection) ?? fixture.databaseRows)
          .filter(
            (row) =>
              row.dest_path === path &&
              (operationId === undefined || row.operation_id === operationId),
          )
          .slice(0, 2),
    );
    const updateInventory = fixture.writes.updateInventory;
    const updateImplementation = updateInventory.getMockImplementation()!;
    updateInventory.mockImplementation((...args) => {
      const result = updateImplementation(...args);
      if (args[1].expected.rowId === 2) {
        fixture.databaseRows[0]!.rating = 0.7;
      }
      return result;
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.writes.writeRating).toHaveBeenCalledTimes(1);
    expect(fixture.writes.writeRating).toHaveBeenCalledWith(
      ACTIONABLE_PATH,
      expect.any(Number),
      expect.any(Object),
    );
    expect(fixture.writes.updateTrackRating).toHaveBeenCalledTimes(1);
    expect(fixture.writes.updateTrackRating).toHaveBeenCalledWith("track-2", expect.any(Number));
    expect(fixture.writes.updateInventory).toHaveBeenCalledTimes(1);
    expect(fixture.writes.updateInventory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expected: expect.objectContaining({ rowId: 2 }) }),
    );
    expect(result.failureCodes).toContain("stale-evidence");
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
    );
  });

  it("rebaselines a metadata-only server version change without masking membership drift", async () => {
    const fixture = createFixture("two-success");
    fixture.queryLibraryContentVersion.mockImplementation(async () => ({
      libraryId: "library-1",
      value:
        fixture.writes.updateTrackRating.mock.calls.length === 0
          ? "content-version-1"
          : "content-version-2",
    }));

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.events).toEqual(["file", "server", "database", "file", "server", "database"]);
    expect(fixture.writes.updateTrackRating).toHaveBeenCalledTimes(2);
    expect(fixture.queryTracks).toHaveBeenCalledTimes(4);
    expect(fixture.queryLibraryContentVersion).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({
      status: "applied",
      success: true,
      exitCode: 0,
      failureCodes: [],
    });
    expect(result.outcomes.every(({ status }) => status === "applied")).toBe(true);
  });

  it("uses an uncached adapter for every sequential server rebaseline", async () => {
    const fixture = createFixture("two-success");
    const createAdapter = fixture.createAdapter.getMockImplementation()!;
    fixture.createAdapter.mockImplementation(() => {
      const fresh = createAdapter();
      const queryTracks = fresh.query.tracks;
      let cachedPage: Awaited<ReturnType<typeof queryTracks>> | undefined;
      return {
        ...fresh,
        query: {
          ...fresh.query,
          tracks: async (...args) => {
            cachedPage ??= await queryTracks(...args);
            return cachedPage;
          },
        },
      };
    });
    fixture.queryLibraryContentVersion.mockImplementation(async () => {
      const callCount = fixture.queryLibraryContentVersion.mock.calls.length;
      if (callCount === 8) {
        fixture.extraServerTracks.push({
          id: "second-refresh-duplicate",
          kind: "track",
          title: "Second Refresh Duplicate",
          artist: "Artist",
          album: "Album",
          rating: 0.4,
          playCount: 0,
          durationMs: 180_000,
          filePath: TRACK_PATH,
        });
      }
      return {
        libraryId: "library-1",
        value:
          callCount >= 8
            ? "content-version-3"
            : callCount >= 5
              ? "content-version-2"
              : "content-version-1",
      };
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.extraServerTracks).toHaveLength(1);
    expect(result.failureCodes).toContain("stale-evidence");
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
    );
    expect(fixture.events).toEqual(["file", "server", "database"]);
  });

  it("keeps full snapshots constant while CURRENT exact-row checks scale per record", async () => {
    const fixture = createFixture("two-success");

    await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.queryTracks).toHaveBeenCalledTimes(3);
    expect(fixture.queryTrackById).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.getReconciliationInventoryCandidates).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.openReconciliationDatabaseReadOnly).toHaveBeenCalledTimes(3);
    expect(fixture.dependencies.getReconciliationInventoryCandidatesAtPath).toHaveBeenCalledTimes(
      2,
    );
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledTimes(2);
    expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
  });

  it("restores stable path, kind, and target order after two dynamic stat outcomes", async () => {
    const fixture = createFixture("two-success");
    for (const row of fixture.databaseRows) {
      row.mtime += 1;
      row.size += 1;
    }
    const baseLstat = vi.mocked(fixture.dependencies.lstat!).getMockImplementation()!;
    vi.mocked(fixture.dependencies.lstat!).mockImplementation(async (path) => {
      const result = await baseLstat(path);
      const pathWasWritten = fixture.writes.writeRating.mock.calls.some(
        ([writtenPath]) => writtenPath === path,
      );
      if (path === SOURCE_ROOT || !pathWasWritten) return result;
      return {
        ...result,
        size: Number(result.size) + 1,
        mtimeMs: Number(result.mtimeMs) + 1,
        ctimeMs: Number(result.ctimeMs) + 1,
      } as Stats;
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.outcomes.map(({ path, kind, target }) => [path, kind, target])).toEqual([
      [ACTIONABLE_PATH, "database-stat", "database"],
      [ACTIONABLE_PATH, "rating", "file"],
      [ACTIONABLE_PATH, "rating", "server"],
      [TRACK_PATH, "database-stat", "database"],
      [TRACK_PATH, "rating", "file"],
      [TRACK_PATH, "rating", "server"],
    ]);
    expect(result.outcomes.every(({ status }) => status === "applied")).toBe(true);
  });

  it.each([
    ["id", 101],
    ["operation_id", 11],
    ["source_path", "/imports/replaced.mp3"],
    ["relative_path", "replaced.mp3"],
    ["mtime", 123],
    ["size", 456],
    ["rating", 0.7],
    ["genre", "Jazz"],
    ["year", 1999],
    ["bpm", 120],
    ["artist", "Other Artist"],
    ["dest_path", `${SOURCE_ROOT}/replaced.mp3`],
    ["content_hash", "changed"],
    ["copied_at", 123],
  ] as const)(
    "rejects a selected database row with changed %s before the first write",
    async (column, changedValue) => {
      const fixture = createFixture("success");
      const getRows = vi.mocked(fixture.dependencies.getReconciliationInventoryCandidatesAtPath!);
      const rowsImplementation = getRows.getMockImplementation()!;
      getRows.mockImplementation((...args) => {
        const rows = rowsImplementation(...args);
        return rows.map((row) =>
          row.id === fixture.databaseRows[0]!.id ? { ...row, [column]: changedValue } : row,
        );
      });

      const result = await executeReconciliation(
        applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
        fixture.dependencies,
      );

      expect(result.failureCodes).toContain("stale-evidence");
      expect(fixture.writes.openAuthorityLease).toHaveBeenCalledOnce();
      expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
      expect(fixture.writes.writeRating).not.toHaveBeenCalled();
      expect(fixture.writes.updateTrackRating).not.toHaveBeenCalled();
      expect(fixture.writes.updateInventory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["db-wins", { fileWins: false, dbWins: true }],
    ["server-wins", { fileWins: false, serverWins: true }],
  ] as const)(
    "blocks %s before every mutation when the mandatory pre-write metadata reread fails",
    async (_label, strategy) => {
      const fixture = createFixture("success");
      const readMetadata = vi.mocked(fixture.dependencies.readReconciliationMetadata!);
      const readImplementation = readMetadata.getMockImplementation()!;
      readMetadata.mockImplementation(async (path) => {
        if (readMetadata.mock.calls.length === 3) {
          return { ok: false, error: { code: "read-failed" } };
        }
        return readImplementation(path);
      });

      const result = await executeReconciliation(
        applyOptions({ execute: true, yes: true, ...strategy }),
        fixture.dependencies,
      );

      expect(result.failureCodes).toContain("stale-evidence");
      expect(result.outcomes).toContainEqual(
        expect.objectContaining({ path: TRACK_PATH, status: "failed", code: "stale-evidence" }),
      );
      expect(fixture.queryTrackById).not.toHaveBeenCalled();
      expect(
        fixture.dependencies.getReconciliationInventoryCandidatesAtPath,
      ).not.toHaveBeenCalled();
      expectNoWrites(fixture.writes);
    },
  );

  it("tracks a successful file mutation even when immediate reread verification fails", async () => {
    const fixture = createFixture("success");
    const readMetadata = vi.mocked(fixture.dependencies.readReconciliationMetadata!);
    const readImplementation = readMetadata.getMockImplementation()!;
    readMetadata.mockImplementation(async (path) => {
      if (
        fixture.writes.writeRating.mock.calls.length > 0 &&
        readMetadata.mock.calls.length === 4
      ) {
        return { ok: false, error: { code: "read-failed" } };
      }
      return readImplementation(path);
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.writes.writeRating).toHaveBeenCalledOnce();
    expect(result.failureCodes).toContain("verification-failed");
    expect(result.postApply).toMatchObject({ checkedPaths: 1 });
  });

  it("verifies db-wins through MP3 POPM projection without retaining a false conflict", async () => {
    const path = `${SOURCE_ROOT}/projected.mp3`;
    const projectedRating = 85 / 254;
    const controller = new AbortController();
    const fixture = createFixture("success", {
      path,
      fileRating: 0.2,
      databaseRating: 0.333,
      serverRating: 0.2,
    });

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        fileWins: false,
        dbWins: true,
        signal: controller.signal,
      }),
      fixture.dependencies,
    );

    expect(fixture.writes.writeRating).toHaveBeenCalledWith(
      path,
      projectedRating,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(result).toMatchObject({
      status: "applied",
      success: true,
      exitCode: 0,
      failureCodes: [],
      postApply: {
        status: "verified",
        requestedRatingDrift: 0,
      },
    });
    expect(result.postApply?.findings).not.toContainEqual(
      expect.objectContaining({ path, field: "rating", code: "conflicting-value" }),
    );
  });

  it("suppresses an expected MP3 projection conflict without writing the file again", async () => {
    const path = `${SOURCE_ROOT}/already-projected.mp3`;
    const fixture = createFixture("success", {
      path,
      fileRating: 85 / 254,
      databaseRating: 0.333,
      serverRating: 0.2,
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(fixture.writes.writeRating).not.toHaveBeenCalled();
    expect(result.postApply).toMatchObject({
      status: "verified",
      requestedRatingDrift: 0,
    });
    expect(result.postApply?.findings).not.toContainEqual(
      expect.objectContaining({ path, field: "rating", code: "conflicting-value" }),
    );
  });

  it("keeps a db-wins conflict when a successful writer rereads outside its projection", async () => {
    const path = `${SOURCE_ROOT}/miswritten.mp3`;
    const fixture = createFixture("success", {
      path,
      fileRating: 0.2,
      databaseRating: 0.333,
      serverRating: 0.333,
    });
    const readMetadata = vi.mocked(fixture.dependencies.readReconciliationMetadata!);
    const readImplementation = readMetadata.getMockImplementation()!;
    readMetadata.mockImplementation(async (candidatePath) => {
      if (fixture.writes.writeRating.mock.calls.length > 0) {
        return {
          ok: true,
          metadata: { rating: 0.9, artist: "Artist", genre: "Rock", year: 2024 },
        };
      }
      return readImplementation(candidatePath);
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.failureCodes).toContain("verification-failed");
    expect(result.postApply).toMatchObject({
      status: "incomplete",
      findings: expect.arrayContaining([
        expect.objectContaining({
          path,
          field: "rating",
          code: "conflicting-value",
        }),
      ]),
    });
  });

  it("does not mutate a file when zero would be encoded as unrated", async () => {
    const fixture = createFixture("success");
    fixture.databaseRows[0]!.rating = 0;

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        operation: "rating",
        target: "file",
        code: "unsupported-target",
      }),
    );
    expect(result.executable).toBe(false);
    expect(fixture.writes.writeRating).not.toHaveBeenCalled();
  });

  it("does not plan a file mutation for a multiply linked candidate", async () => {
    const fixture = createFixture("success");
    const lstat = vi.mocked(fixture.dependencies.lstat!);
    const implementation = lstat.getMockImplementation()!;
    lstat.mockImplementation(async (path) => {
      const stats = await implementation(path);
      return path === TRACK_PATH ? ({ ...stats, nlink: 2 } as Stats) : stats;
    });

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true, fileWins: false, dbWins: true }),
      fixture.dependencies,
    );

    expect(result.blockers).toContainEqual(
      expect.objectContaining({
        operation: "rating",
        target: "file",
        code: "unsupported-target",
      }),
    );
    expect(result.executable).toBe(false);
    expectNoWrites(fixture.writes);
  });

  it("refuses mutation when the fresh fingerprint differs from reviewed evidence", async () => {
    const fixture = createFixture("drift");

    const result = await executeReconciliation(
      applyOptions({ execute: true, yes: true }),
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      status: "failed",
      success: false,
      exitCode: 1,
      failureCodes: ["stale-evidence"],
      postApply: { status: "failed", failureCodes: ["stale-evidence"] },
    });
    expect(result.outcomes).toContainEqual(
      expect.objectContaining({ status: "failed", code: "stale-evidence" }),
    );
    expect(fixture.createAdapter).toHaveBeenCalledTimes(2);
    expectNoWrites(fixture.writes);
  });

  it("stops later targets after a mid-record failure and reports a nonzero partial result", async () => {
    const fixture = createFixture("server-failure");

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        fileWins: false,
        dbWins: true,
      }),
      fixture.dependencies,
    );

    expect(fixture.events).toEqual(["file", "server"]);
    expect(fixture.writes.openAuthorityLease).toHaveBeenCalledOnce();
    expect(fixture.writes.withDatabaseWritable).not.toHaveBeenCalled();
    expect(fixture.authorityLeases[0]!.rollback).toHaveBeenCalledOnce();
    expect(fixture.writes.updateInventory).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "partial",
      success: false,
      exitCode: 1,
      postApply: {
        status: "incomplete",
        findings: expect.arrayContaining([
          expect.objectContaining({
            path: TRACK_PATH,
            field: "rating",
            code: "conflicting-value",
          }),
        ]),
      },
    });
    expect(result.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "rating", target: "file", status: "applied" }),
        expect.objectContaining({ kind: "rating", target: "server", status: "failed" }),
        expect.objectContaining({
          kind: "database-stat",
          status: "skipped",
          code: "prior-target-failed",
        }),
      ]),
    );
  });

  it("rejects a pre-aborted execution as cancellation without acquiring or mutating", async () => {
    const fixture = createFixture("success");
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeReconciliation(
        applyOptions({
          execute: true,
          yes: true,
          signal: controller.signal,
        }),
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fixture.createAdapter).not.toHaveBeenCalled();
    expectNoWrites(fixture.writes);
  });

  it("preserves final-path in-flight exact-track cancellation as structured exit 130", async () => {
    const fixture = createFixture("success");
    const controller = new AbortController();
    fixture.queryTrackById.mockImplementation(
      async (_trackId, options) =>
        new Promise<MediaTrack>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort());
        }),
    );

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        fileWins: false,
        dbWins: true,
        signal: controller.signal,
      }),
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      status: "cancelled",
      success: false,
      exitCode: 130,
      failureCodes: ["cancelled"],
      postApply: { status: "cancelled", checkedPaths: 0, failureCodes: ["cancelled"] },
    });
    expect(
      result.outcomes.every(({ status, code }) => status === "skipped" && code === "cancelled"),
    ).toBe(true);
    expect(fixture.createAdapter).toHaveBeenCalledTimes(3);
    expectNoWrites(fixture.writes);
  });

  it("preserves completed outcomes when post-acquisition is cancelled", async () => {
    const fixture = createFixture("success");
    const controller = new AbortController();
    fixture.queryLibraryContentVersion.mockImplementation(async () => {
      if (fixture.queryLibraryContentVersion.mock.calls.length === 6) {
        controller.abort();
        controller.signal.throwIfAborted();
      }
      return { libraryId: "library-1", value: "content-version-1" };
    });

    const result = await executeReconciliation(
      applyOptions({
        execute: true,
        yes: true,
        fileWins: false,
        dbWins: true,
        signal: controller.signal,
      }),
      fixture.dependencies,
    );

    expect(result).toMatchObject({
      status: "cancelled",
      success: false,
      exitCode: 130,
      failureCodes: ["cancelled"],
      postApply: { status: "cancelled", checkedPaths: 1, failureCodes: ["cancelled"] },
    });
    expect(result.outcomes.every(({ status }) => status === "applied")).toBe(true);
    expect(fixture.events).toEqual(["file", "server", "database"]);
  });
});
