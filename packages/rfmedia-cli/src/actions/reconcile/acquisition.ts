import type { Stats } from "node:fs";
import { extname, isAbsolute, normalize, resolve } from "node:path";

import { AudioFileCandidateLimitError } from "../../lib/audio.js";
import {
  buildReconciliationReport,
  normalizeReconciliationPath,
  type ReconciliationEngineReport,
  type ReconciliationFileInput,
} from "../../lib/reconciliation.js";
import {
  accountReconciliationServerSnapshotBytes,
  isSafeReconciliationMp3RatingFileSize,
  validateReconciliationDatabaseProjection,
  validateReconciliationLocalProjection,
  validateReconciliationServerTrack,
} from "../../lib/reconciliation-limits.js";
import { getDefaultWorkers, validateWorkers } from "../../lib/parallel.js";
import type {
  DbConnection,
  DbReconciliationInventoryCandidate,
  ReconciliationDatabaseGeneration,
} from "../../types/db.js";
import type {
  MediaLibraryContentVersion,
  MediaServerAdapter,
  MediaTrack,
} from "../../types/media-server.js";
import type { ReconciliationFailureCode } from "../../types/reconciliation.js";
import type {
  ReconciliationActionBaseOptions,
  ReconciliationActionDependencies,
  ReconciliationActionOptions,
} from "./contracts.js";

const SERVER_PAGE_SIZE = 100;
export const MAX_RECONCILIATION_FILE_CANDIDATES = 100_000;
const MAX_SERVER_TRACKS = 100_000;

export interface FileFingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface ReconciliationAcquisition {
  readonly databasePath: string;
  readonly databaseGeneration: ReconciliationDatabaseGeneration;
  readonly library: string;
  readonly serverContentVersion: MediaLibraryContentVersion;
  readonly serverTracks: readonly MediaTrack[];
  readonly report: ReconciliationEngineReport;
  readonly fingerprints: ReadonlyMap<string, FileFingerprint>;
}

/** Typed acquisition failure preserved by command-level nonzero error handling. */
export class ReconciliationAcquisitionError extends Error {
  readonly code: ReconciliationFailureCode;

  constructor(code: ReconciliationFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReconciliationAcquisitionError";
    this.code = code;
  }
}

export function fingerprint(stats: Stats): FileFingerprint {
  return {
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

export function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function checkedRegularFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink();
}

export function throwIfCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function mapInBoundedParallel<T, R>(
  items: readonly T[],
  workers: number,
  processor: (item: T, index: number, signal?: AbortSignal) => Promise<R>,
  options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (completed: number, total: number) => void;
  },
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.min(validateWorkers(workers), Math.max(items.length, 1));
  let nextIndex = 0;
  let completed = 0;
  let firstFailure: Error | undefined;

  const runWorker = async (): Promise<void> => {
    while (firstFailure === undefined) {
      throwIfCancelled(options.signal);
      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;

      try {
        results[index] = await processor(items[index]!, index, options.signal);
        completed += 1;
        options.onProgress?.(completed, items.length);
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (firstFailure !== undefined) throw firstFailure;
  return results;
}

function resolveDatabasePath(
  options: ReconciliationActionBaseOptions,
  dependencies: ReconciliationActionDependencies,
): string {
  return resolve(
    options.trackingDatabase ??
      dependencies.resolveUndoDatabasePath(dependencies.getLoadedConfig()),
  );
}

function resolveLibrary(
  options: ReconciliationActionBaseOptions,
  dependencies: ReconciliationActionDependencies,
): string {
  const library =
    options.library?.trim() || dependencies.getLoadedConfig()?.plex?.libraryName?.trim();
  if (!library) {
    throw new Error(
      "Reconciliation requires a non-empty media library from --library or plex.libraryName.",
    );
  }
  return library;
}

async function validateSourceRoot(
  sourcePath: string,
  dependencies: ReconciliationActionDependencies,
): Promise<string> {
  if (!isAbsolute(sourcePath)) {
    throw new Error("Reconciliation source path must be absolute.");
  }
  const sourceRoot = normalize(resolve(sourcePath));
  const stats = await dependencies.lstat(sourceRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Reconciliation source path must be a non-symbolic-link directory.");
  }
  return sourceRoot;
}

async function acquireFiles(
  sourceRoot: string,
  workers: number,
  progress: boolean,
  dependencies: ReconciliationActionDependencies,
  signal?: AbortSignal,
): Promise<{
  readonly files: readonly ReconciliationFileInput[];
  readonly fingerprints: ReadonlyMap<string, FileFingerprint>;
}> {
  throwIfCancelled(signal);
  let candidates: readonly string[];
  try {
    candidates = await dependencies.findAudioFilesNoFollow(
      sourceRoot,
      MAX_RECONCILIATION_FILE_CANDIDATES,
    );
  } catch (error) {
    if (error instanceof AudioFileCandidateLimitError) {
      throw new ReconciliationAcquisitionError(
        "file-acquisition-failed",
        `Reconciliation exceeds the ${MAX_RECONCILIATION_FILE_CANDIDATES}-file candidate limit.`,
        { cause: error },
      );
    }
    throw error;
  }
  if (candidates.length > MAX_RECONCILIATION_FILE_CANDIDATES) {
    throw new ReconciliationAcquisitionError(
      "file-acquisition-failed",
      `Reconciliation exceeds the ${MAX_RECONCILIATION_FILE_CANDIDATES}-file candidate limit.`,
    );
  }

  let retainedLocalBytes = 0;
  const results = await mapInBoundedParallel(
    candidates,
    workers,
    async (candidate, _index, workerSignal) => {
      throwIfCancelled(workerSignal);
      const path = normalizeReconciliationPath(sourceRoot, candidate);
      if (path === null) {
        throw new ReconciliationAcquisitionError(
          "file-acquisition-failed",
          "Audio discovery returned a path outside the source root.",
        );
      }
      const before = await dependencies.lstat(path);
      if (!checkedRegularFile(before)) {
        throw new ReconciliationAcquisitionError(
          "file-acquisition-failed",
          `Reconciliation candidate is not a regular non-symbolic-link file: ${path}`,
        );
      }
      const beforeFingerprint = fingerprint(before);
      const read = await dependencies.readReconciliationMetadata(path);
      if (!read.ok) {
        throw new ReconciliationAcquisitionError(
          "read-failed",
          `read-failed: unable to read reconciliation metadata for ${path}`,
        );
      }
      const projection = validateReconciliationLocalProjection(path, read.metadata);
      if (!projection.ok) {
        throw new ReconciliationAcquisitionError(
          "file-acquisition-failed",
          "Reconciliation file metadata exceeds a safety limit.",
        );
      }
      const after = await dependencies.lstat(path);
      if (!checkedRegularFile(after) || !sameFingerprint(beforeFingerprint, fingerprint(after))) {
        throw new ReconciliationAcquisitionError(
          "file-acquisition-failed",
          `Reconciliation candidate changed while metadata was read: ${path}`,
        );
      }
      const accounted = dependencies.accountReconciliationLocalSnapshotBytes(
        retainedLocalBytes,
        projection.bytes,
      );
      if (!accounted.ok) {
        throw new ReconciliationAcquisitionError(
          "file-acquisition-failed",
          "Reconciliation local snapshot exceeds the aggregate byte limit.",
        );
      }
      retainedLocalBytes = accounted.bytes;
      return {
        file: {
          path,
          metadata: { state: "present" as const, ...read.metadata },
          stat: { mtime: Math.trunc(beforeFingerprint.mtimeMs), size: beforeFingerprint.size },
          ratingWriteProjection:
            beforeFingerprint.nlink !== 1
              ? ({ encoding: "unsupported" } as const)
              : extname(path).toLowerCase() === ".mp3"
                ? isSafeReconciliationMp3RatingFileSize(beforeFingerprint.size)
                  ? ({ encoding: "mp3-popm" } as const)
                  : ({ encoding: "unsupported" } as const)
                : ({ encoding: "unsupported" } as const),
        },
        fingerprint: beforeFingerprint,
      };
    },
    { signal, ...(progress ? { onProgress: dependencies.reportProgress } : {}) },
  );

  throwIfCancelled(signal);
  const files: ReconciliationFileInput[] = [];
  const fingerprints = new Map<string, FileFingerprint>();
  for (const result of results) {
    files.push(result.file);
    fingerprints.set(result.file.path, result.fingerprint);
  }
  return { files, fingerprints };
}

async function acquireServerTracks(
  adapter: MediaServerAdapter,
  library: string,
  advance: ReconciliationActionDependencies["advancePaginationOffset"],
  signal?: AbortSignal,
): Promise<readonly MediaTrack[]> {
  const tracks: MediaTrack[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;
  let snapshotBytes = 0;

  for (;;) {
    throwIfCancelled(signal);
    const page = await adapter.query.tracks({
      kind: "track",
      library,
      limit: SERVER_PAGE_SIZE,
      offset,
      signal,
    });
    if (page.offset !== offset || page.returned < page.items.length) {
      throw new Error("Media server returned inconsistent pagination metadata.");
    }
    if (expectedTotal === undefined) expectedTotal = page.total;
    else if (page.total !== expectedTotal) {
      throw new Error("Media server total changed during reconciliation acquisition.");
    }
    if (tracks.length + page.items.length > MAX_SERVER_TRACKS || page.total > MAX_SERVER_TRACKS) {
      throw new Error(`Media server reconciliation exceeds the ${MAX_SERVER_TRACKS}-track limit.`);
    }
    for (const track of page.items) {
      const validated = validateReconciliationServerTrack(track);
      if (!validated.ok) {
        throw new ReconciliationAcquisitionError(
          "server-acquisition-failed",
          "Media server reconciliation projection exceeds a safety limit.",
        );
      }
      const accounted = accountReconciliationServerSnapshotBytes(snapshotBytes, validated.bytes);
      if (!accounted.ok) {
        throw new ReconciliationAcquisitionError(
          "server-acquisition-failed",
          "Media server reconciliation snapshot exceeds the aggregate byte limit.",
        );
      }
      snapshotBytes = accounted.bytes;
      tracks.push(track);
    }
    const nextOffset = advance(page, `library ${library}`);
    if (!page.hasMore) break;
    if (nextOffset <= offset) throw new Error("Media server pagination did not advance.");
    offset = nextOffset;
  }

  if (expectedTotal !== undefined && tracks.length !== expectedTotal) {
    throw new Error("Media server pagination did not produce the reported complete snapshot.");
  }
  return tracks;
}

export function sameServerContentVersion(
  left: MediaLibraryContentVersion,
  right: MediaLibraryContentVersion,
): boolean {
  return left.libraryId === right.libraryId && left.value === right.value;
}

export async function acquireServerSnapshot(
  adapter: MediaServerAdapter,
  library: string,
  advance: ReconciliationActionDependencies["advancePaginationOffset"],
  signal?: AbortSignal,
): Promise<{
  readonly tracks: readonly MediaTrack[];
  readonly contentVersion: MediaLibraryContentVersion;
}> {
  const before = await adapter.query.libraryContentVersion(library, { signal });
  const tracks = await acquireServerTracks(adapter, library, advance, signal);
  const after = await adapter.query.libraryContentVersion(library, { signal });
  if (!sameServerContentVersion(before, after)) {
    throw new ReconciliationAcquisitionError(
      "server-acquisition-failed",
      "Media server content changed during reconciliation acquisition.",
    );
  }
  return { tracks, contentVersion: after };
}

export async function acquireReconciliation(
  options: ReconciliationActionOptions,
  dependencies: ReconciliationActionDependencies,
): Promise<ReconciliationAcquisition> {
  const sourceRoot = await validateSourceRoot(options.sourcePath, dependencies);
  const databasePath = resolveDatabasePath(options, dependencies);
  const library = resolveLibrary(options, dependencies);
  const adapter = dependencies.createAdapter();
  const [{ files, fingerprints }, serverSnapshot] = await Promise.all([
    acquireFiles(
      sourceRoot,
      validateWorkers(options.workers ?? getDefaultWorkers()),
      options.progress === true,
      dependencies,
      options.signal,
    ),
    acquireServerSnapshot(adapter, library, dependencies.advancePaginationOffset, options.signal),
  ]);

  let database: DbConnection | undefined;
  let databaseGeneration: ReconciliationDatabaseGeneration | undefined;
  let databaseRows: readonly DbReconciliationInventoryCandidate[];
  try {
    const snapshot = dependencies.openReconciliationDatabaseReadOnly(databasePath);
    database = snapshot.database;
    databaseGeneration = snapshot.generation;
    databaseRows = dependencies.getReconciliationInventoryCandidates(
      database,
      sourceRoot,
      options.operationId,
    );
    if (databaseRows.some((row) => !validateReconciliationDatabaseProjection(row).ok)) {
      throw new ReconciliationAcquisitionError(
        "database-acquisition-failed",
        "Reconciliation database projection exceeds a safety limit.",
      );
    }
  } finally {
    if (database !== undefined) dependencies.closeDatabase(database);
  }

  if (databaseGeneration === undefined) {
    throw new Error("Reconciliation database snapshot did not provide a generation.");
  }

  return {
    databasePath,
    databaseGeneration,
    library,
    serverContentVersion: serverSnapshot.contentVersion,
    serverTracks: serverSnapshot.tracks,
    fingerprints,
    report: buildReconciliationReport({
      sourceRoot,
      files,
      databaseRows,
      serverTracks: serverSnapshot.tracks,
      serverNativeRatingScale: adapter.features.ratings.nativeScale,
      serverRatingWritable: adapter.features.ratings.writable,
    }),
  };
}
