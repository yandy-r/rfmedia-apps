/**
 * Migrate-tracking action for rfmedia CLI.
 *
 * Provides functionality to discover and migrate legacy tracking and history files
 * to the SQLite database, with optional cleanup of legacy files.
 */

import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import fg from "fast-glob";
import pc from "picocolors";

import { initializeDatabase, closeDatabase } from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveUndoDatabasePath } from "../lib/config.js";
import { getHistoryDir, migrateLegacyHistory } from "../lib/history.js";
import { migrateLegacyTracking } from "../lib/completed-tracker.js";
import { pathExists } from "../lib/filesystem.js";
import { formatDryRun, logDebug, logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { confirm } from "../lib/prompt.js";
import type { MigrateOptions } from "../types/options.js";
import type {
  MigrateResult,
  TrackingMigrationResult,
  HistoryMigrationResult,
  LegacyTrackingFileInfo,
  LegacyHistoryFileInfo,
  DeletionResult,
  FailedOperation,
} from "../types/results.js";
import type { HistorySessionHeader } from "../types/history.js";

interface LegacyCleanupSource {
  path: string;
  root: string;
}

interface TrackingMigrationExecution {
  result: TrackingMigrationResult;
  deletionCandidates: DeletionCandidate[];
  errors: FailedOperation[];
}

interface HistoryMigrationExecution {
  result: HistoryMigrationResult;
  deletionCandidates: DeletionCandidate[];
  errors: FailedOperation[];
}

interface DeletionCandidate {
  path: string;
  rootPath: string;
  resolvedRoot: string;
  resolvedPath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  parentHandle: FileHandle;
  anchoredPath: string;
}

// ============================================================================
// TIER 1: ENTRY FUNCTION
// ============================================================================

/**
 * Executes the migrate-tracking command.
 *
 * Discovers and migrates legacy tracking and history files to SQLite database,
 * with optional cleanup of legacy files after successful migration.
 *
 * @param options - Migration options from CLI
 * @returns Migration result with statistics and errors
 */
export async function executeMigrate(options: MigrateOptions): Promise<MigrateResult> {
  const errors: FailedOperation[] = [];
  let trackingResult: TrackingMigrationResult = {
    operations: 0,
    sources: 0,
    legacyFiles: [],
  };
  let historyResult: HistoryMigrationResult = {
    sessions: 0,
    operations: 0,
    legacyFiles: [],
  };

  if (options.dryRun) {
    logInfo(pc.yellow("DRY-RUN MODE: No actual changes will be made"));
  }

  let db: DbConnection | undefined;
  let filesDeleted = 0;
  const deletionCandidates: DeletionCandidate[] = [];

  try {
    if (!options.dryRun) {
      const config = getLoadedConfig();
      const dbPath = resolveUndoDatabasePath(config);
      db = await initializeDatabase(dbPath);
      logDebug(`Database initialized: ${dbPath}`);
    }

    // Migrate tracking files (unless --history-only). The captured root is part of both operation
    // identity and later cleanup authorization because a legacy filename cannot recover the
    // original input-file extension.
    if (!options.historyOnly) {
      logInfo("Discovering legacy tracking files...");
      const trackingExecution = await migrateTrackingFiles(db, options, resolve(process.cwd()));
      trackingResult = trackingExecution.result;
      deletionCandidates.push(...trackingExecution.deletionCandidates);
      errors.push(...trackingExecution.errors);

      if (trackingResult.legacyFiles.length === 0) {
        logInfo("No legacy tracking files found");
      } else {
        logSuccess(`Discovered ${trackingResult.legacyFiles.length} legacy tracking file(s)`);
      }
    }

    // Resolve the history root once so discovery, import proof, and cleanup share one boundary.
    if (!options.trackingOnly) {
      logInfo("Discovering legacy history files...");
      const historyRoot = resolve(options.historyPath ?? getHistoryDir());
      const historyExecution = await migrateHistoryFiles(db, options, historyRoot);
      historyResult = historyExecution.result;
      deletionCandidates.push(...historyExecution.deletionCandidates);
      errors.push(...historyExecution.errors);

      if (historyResult.legacyFiles.length === 0) {
        logInfo("No legacy history files found");
      } else {
        logSuccess(`Discovered ${historyResult.legacyFiles.length} legacy history file(s)`);
      }
    }

    if (options.deleteOld && !options.dryRun) {
      if (deletionCandidates.length > 0) {
        let shouldDelete = options.force;
        if (!shouldDelete) {
          shouldDelete = await confirm(`Delete ${deletionCandidates.length} legacy file(s)?`);
        }

        if (shouldDelete) {
          logInfo(`Deleting ${deletionCandidates.length} legacy file(s)...`);
          const deleteResult = await deleteLegacyFiles(deletionCandidates);
          filesDeleted = deleteResult.deleted;
          errors.push(...deleteResult.errors);

          if (filesDeleted > 0) {
            logSuccess(`Deleted ${filesDeleted} legacy file(s)`);
          }
        } else {
          logInfo("Skipping file deletion");
        }
      }
    } else if (options.deleteOld && options.dryRun) {
      const discoveredCount = trackingResult.legacyFiles.length + historyResult.legacyFiles.length;
      if (discoveredCount > 0) {
        logInfo(
          formatDryRun(`Would evaluate ${discoveredCount} legacy file(s) for proof-gated deletion`),
        );
      }
    }

    logSummary(trackingResult, historyResult, filesDeleted, errors);
    return {
      tracking: trackingResult,
      history: historyResult,
      filesDeleted,
      errors,
    };
  } finally {
    await Promise.allSettled(
      deletionCandidates.map(async (candidate) => candidate.parentHandle.close()),
    );
    if (db) {
      closeDatabase(db);
    }
  }
}

// ============================================================================
// TIER 2: CORE FUNCTIONS
// ============================================================================

/**
 * Migrates legacy tracking files to database.
 *
 * @param db - Database connection (undefined in dry-run mode)
 * @param options - Migration options
 * @returns Tracking migration statistics
 */
async function migrateTrackingFiles(
  db: DbConnection | undefined,
  options: MigrateOptions,
  trackingRoot: string,
): Promise<TrackingMigrationExecution> {
  const result: TrackingMigrationResult = {
    operations: 0,
    sources: 0,
    legacyFiles: [],
  };
  const deletionCandidates: DeletionCandidate[] = [];
  const errors: FailedOperation[] = [];

  // Discover legacy tracking files
  const legacyFiles = await discoverLegacyTrackingFiles(trackingRoot);
  result.legacyFiles = legacyFiles;

  if (legacyFiles.length === 0) {
    return { result, deletionCandidates, errors };
  }

  // Group by operation (completed + failed pairs)
  const operationGroups = groupTrackingFilesByOperation(legacyFiles);

  logInfo(`Found ${operationGroups.length} operation(s) with legacy tracking`);

  // Migrate each operation group
  for (const group of operationGroups) {
    if (options.dryRun) {
      logInfo(
        formatDryRun(
          `Would migrate operation with hash ${group.hash} (${group.completedCount + group.failedCount} sources)`,
        ),
      );
      result.operations++;
      result.sources += group.completedCount + group.failedCount;
    } else if (db) {
      logDebug(`Migrating tracking files for ${group.inputFile} with hash: ${group.hash}`);
      const groupPaths = new Set(
        [group.completedFile?.path, group.failedFile?.path].filter(
          (path): path is string => path !== undefined,
        ),
      );
      const captured = options.deleteOld
        ? await prepareDeletionCandidates(
            Array.from(groupPaths, (path) => ({ path, root: trackingRoot })),
          )
        : { candidates: [], errors: [] };
      errors.push(...captured.errors);
      const capturedByPath = new Map(
        captured.candidates.map((candidate) => [candidate.path, candidate] as const),
      );
      const importPathByOriginal = new Map(
        Array.from(
          groupPaths,
          (path) => [path, capturedByPath.get(path)?.anchoredPath ?? path] as const,
        ),
      );
      const originalByImportPath = new Map(
        Array.from(
          importPathByOriginal,
          ([originalPath, importPath]) => [importPath, originalPath] as const,
        ),
      );
      const retained = new Set<string>();

      try {
        const migrationResult = await migrateLegacyTracking(db, {
          inputFile: group.inputFile,
          optionsHash: group.hash,
          mode: group.mode,
          ...(group.completedFile
            ? { completedPath: importPathByOriginal.get(group.completedFile.path) }
            : {}),
          ...(group.failedFile
            ? { failedPath: importPathByOriginal.get(group.failedFile.path) }
            : {}),
        });

        const proofPaths = [
          ...migrationResult.importedFiles,
          ...migrationResult.alreadyEquivalentFiles,
        ];
        for (const proofPath of proofPaths) {
          const originalPath = originalByImportPath.get(proofPath);
          if (!originalPath) {
            throw new Error(
              `Tracking importer returned proof for an undiscovered file: ${proofPath}`,
            );
          }
          const candidate = capturedByPath.get(originalPath);
          if (candidate) {
            try {
              await assertDeletionCandidateUnchanged(candidate);
              deletionCandidates.push(candidate);
              retained.add(candidate.path);
            } catch (error) {
              errors.push(failedOperation(originalPath, error));
            }
          }
        }

        result.operations++;
        result.sources += migrationResult.completed + migrationResult.failed;
      } catch (error) {
        for (const path of groupPaths) {
          errors.push(failedOperation(path, error));
        }
      } finally {
        await Promise.allSettled(
          captured.candidates
            .filter((candidate) => !retained.has(candidate.path))
            .map(async (candidate) => candidate.parentHandle.close()),
        );
      }
    }
  }

  return { result, deletionCandidates, errors };
}

/**
 * Migrates legacy history files to database.
 *
 * @param db - Database connection (undefined in dry-run mode)
 * @param options - Migration options
 * @returns History migration statistics
 */
async function migrateHistoryFiles(
  db: DbConnection | undefined,
  options: MigrateOptions,
  historyRoot: string,
): Promise<HistoryMigrationExecution> {
  const result: HistoryMigrationResult = {
    sessions: 0,
    operations: 0,
    legacyFiles: [],
  };
  const deletionCandidates: DeletionCandidate[] = [];
  const errors: FailedOperation[] = [];

  // Discover legacy history files
  const legacyFiles = await discoverLegacyHistoryFiles(historyRoot);
  result.legacyFiles = legacyFiles;

  if (legacyFiles.length === 0 && options.dryRun) {
    return { result, deletionCandidates, errors };
  }

  if (legacyFiles.length > 0) {
    logInfo(`Found ${legacyFiles.length} legacy history session(s)`);
  }

  // Migrate history files using existing function
  if (options.dryRun) {
    // Calculate totals for dry-run
    for (const file of legacyFiles) {
      result.sessions++;
      result.operations += file.operationCount;
    }
    logInfo(
      formatDryRun(
        `Would migrate ${result.sessions} session(s) with ${result.operations} operation(s)`,
      ),
    );
  } else if (db) {
    const discoveredPaths = new Set(legacyFiles.map((file) => file.path));
    const captured = options.deleteOld
      ? await prepareDeletionCandidates(
          Array.from(discoveredPaths, (path) => ({ path, root: historyRoot })),
        )
      : { candidates: [], errors: [] };
    errors.push(...captured.errors);
    const capturedByPath = new Map(
      captured.candidates.map((candidate) => [candidate.path, candidate] as const),
    );
    const anchoredImportRoot = captured.candidates[0]
      ? dirname(captured.candidates[0].anchoredPath)
      : historyRoot;
    const originalByImportPath = new Map(
      Array.from(
        discoveredPaths,
        (path) =>
          [
            anchoredImportRoot === historyRoot ? path : join(anchoredImportRoot, basename(path)),
            path,
          ] as const,
      ),
    );
    const retained = new Set<string>();

    try {
      const migrationResult = await migrateLegacyHistory(db, anchoredImportRoot);
      result.sessions = migrationResult.sessions;
      result.operations = migrationResult.operations;

      for (const proofPath of [
        ...migrationResult.importedFiles,
        ...migrationResult.alreadyEquivalentFiles,
      ]) {
        const originalPath = originalByImportPath.get(proofPath);
        if (!originalPath) {
          errors.push({
            path: proofPath,
            message: "History importer returned proof for an undiscovered file",
          });
          continue;
        }
        const candidate = capturedByPath.get(originalPath);
        if (candidate) {
          try {
            await assertDeletionCandidateUnchanged(candidate);
            deletionCandidates.push(candidate);
            retained.add(candidate.path);
          } catch (error) {
            errors.push(failedOperation(originalPath, error));
          }
        }
      }
      for (const failure of migrationResult.failedFiles) {
        errors.push({
          path: originalByImportPath.get(failure.filePath) ?? failure.filePath,
          message: failure.error,
        });
      }

      logSuccess(`Migrated ${result.sessions} session(s) with ${result.operations} operation(s)`);
    } finally {
      await Promise.allSettled(
        captured.candidates
          .filter((candidate) => !retained.has(candidate.path))
          .map(async (candidate) => candidate.parentHandle.close()),
      );
    }
  }

  return { result, deletionCandidates, errors };
}

// ============================================================================
// TIER 3: HELPER FUNCTIONS
// ============================================================================

/**
 * Discovers legacy tracking files in the current directory and subdirectories.
 *
 * Searches for .completed.*.txt and .failed.*.txt files using fast-glob.
 *
 * @param basePath - Base path to search (defaults to current directory)
 * @returns Array of legacy tracking file info objects
 */
async function discoverLegacyTrackingFiles(basePath?: string): Promise<LegacyTrackingFileInfo[]> {
  const searchPath = resolve(basePath ?? process.cwd());
  const files: LegacyTrackingFileInfo[] = [];

  // Use fast-glob to find tracking files
  const pattern = "**/{*.completed.*.txt,*.failed.*.txt}";
  const matches = await fg(pattern, {
    cwd: searchPath,
    absolute: true,
    dot: false,
    followSymbolicLinks: false,
  });

  logDebug(`Found ${matches.length} potential tracking file(s)`);

  // Parse each file
  for (const matchedPath of matches) {
    const filePath = isAbsolute(matchedPath)
      ? resolve(matchedPath)
      : resolve(searchPath, matchedPath);
    const filename = basename(filePath);
    const info = parseTrackingFilename(filename);

    if (info) {
      // Count entries in file
      const entryCount = await countTrackingFileEntries(filePath);

      files.push({
        path: filePath,
        type: info.type,
        hash: info.hash,
        entryCount,
        inputFile: resolve(dirname(filePath), info.inputFile),
      });

      logDebug(`  ${filename}: ${entryCount} entries, hash=${info.hash}`);
    }
  }

  return files;
}

/**
 * Discovers legacy history files in the specified directory.
 *
 * Scans for *.jsonl files and reads their headers to extract metadata.
 *
 * @param historyDir - History directory path
 * @returns Array of legacy history file info objects
 */
async function discoverLegacyHistoryFiles(historyDir: string): Promise<LegacyHistoryFileInfo[]> {
  const files: LegacyHistoryFileInfo[] = [];

  // Check if history directory exists
  if (!(await pathExists(historyDir))) {
    logDebug(`History directory does not exist: ${historyDir}`);
    return files;
  }

  // Read directory entries
  const entries = await readdir(historyDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);

  logDebug(`Found ${sessionFiles.length} potential history file(s)`);

  // Parse each file
  for (const filename of sessionFiles) {
    const filePath = join(historyDir, filename);

    try {
      // Read first line (header)
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() !== "");

      if (lines.length === 0) continue;

      const firstLine = lines[0];
      if (!firstLine) continue;

      const header = JSON.parse(firstLine) as HistorySessionHeader;

      // Skip if not a valid header
      if (!header._header) continue;

      // Extract session ID from filename
      const sessionId = filename.replace(".jsonl", "");

      // Count operation lines (excluding header)
      const operationCount = lines.length - 1;

      files.push({
        path: filePath,
        sessionId,
        operationCount,
        command: header.command,
        startedAt: header.startedAt,
      });

      logDebug(`  ${filename}: ${operationCount} operations, command=${header.command}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logWarn(`Failed to parse history file ${filename}: ${msg}`);
    }
  }

  return files;
}

/**
 * Parses a tracking filename to extract metadata.
 *
 * Expected format: {basename}.{type}.{hash}.txt
 * where type is "completed" or "failed"
 *
 * @param filename - Tracking filename
 * @returns Parsed info or undefined if invalid format
 */
function parseTrackingFilename(filename: string):
  | {
      type: "completed" | "failed";
      hash: string;
      inputFile: string;
    }
  | undefined {
  // Pattern: anything.completed.hash.txt or anything.failed.hash.txt
  const completedMatch = filename.match(/^(.+)\.completed\.([^.]+)\.txt$/);
  if (completedMatch) {
    const inputFile = completedMatch[1];
    const hash = completedMatch[2];
    if (!inputFile || !hash) return undefined;
    return {
      type: "completed",
      hash,
      inputFile,
    };
  }

  const failedMatch = filename.match(/^(.+)\.failed\.([^.]+)\.txt$/);
  if (failedMatch) {
    const inputFile = failedMatch[1];
    const hash = failedMatch[2];
    if (!inputFile || !hash) return undefined;
    return {
      type: "failed",
      hash,
      inputFile,
    };
  }

  return undefined;
}

/**
 * Counts the number of entries in a tracking file.
 *
 * Skips empty lines and lines starting with # (comments/headers).
 *
 * @param filePath - Path to tracking file
 * @returns Number of entries
 */
async function countTrackingFileEntries(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Groups tracking files by captured input identity and options hash.
 *
 * Each operation has one .completed file and optionally one .failed file.
 *
 * @param files - Array of legacy tracking files
 * @returns Array of grouped operations
 */
function groupTrackingFilesByOperation(files: LegacyTrackingFileInfo[]): Array<{
  inputFile: string;
  hash: string;
  mode: "album" | "filter";
  completedFile?: LegacyTrackingFileInfo;
  failedFile?: LegacyTrackingFileInfo;
  completedCount: number;
  failedCount: number;
}> {
  const groups = new Map<
    string,
    {
      inputFile: string;
      hash: string;
      mode: "album" | "filter";
      completedFile?: LegacyTrackingFileInfo;
      failedFile?: LegacyTrackingFileInfo;
      completedCount: number;
      failedCount: number;
    }
  >();

  for (const file of files) {
    if (!file.inputFile) {
      throw new Error(`Legacy tracking file has no input identity: ${file.path}`);
    }
    const mode = inferTrackingMode(file.hash);
    const key = `${file.inputFile}\0${file.hash}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        inputFile: file.inputFile,
        hash: file.hash,
        mode,
        completedCount: 0,
        failedCount: 0,
      };
      groups.set(key, group);
    }

    if (file.type === "completed") {
      if (group.completedFile) {
        throw new Error(
          `Duplicate completed tracking file for ${file.inputFile} (${file.hash}): ${file.path}`,
        );
      }
      group.completedFile = file;
      group.completedCount = file.entryCount;
    } else {
      if (group.failedFile) {
        throw new Error(
          `Duplicate failed tracking file for ${file.inputFile} (${file.hash}): ${file.path}`,
        );
      }
      group.failedFile = file;
      group.failedCount = file.entryCount;
    }
  }

  return Array.from(groups.values());
}

function inferTrackingMode(hash: string): "album" | "filter" {
  if (hash === "album" || hash.startsWith("album-")) return "album";
  if (hash === "filter" || hash.startsWith("filter-")) return "filter";
  throw new Error(`Unsupported legacy tracking options hash: ${hash}`);
}

function isContainedFile(rootPath: string, filePath: string): boolean {
  const pathFromRoot = relative(rootPath, filePath);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function failedOperation(path: string, error: unknown): FailedOperation {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  return code === "" ? { path, message } : { path, message, code };
}

async function captureDeletionCandidate(file: LegacyCleanupSource): Promise<DeletionCandidate> {
  const requestedPath = resolve(file.path);
  const rootPath = resolve(file.root);
  const resolvedRoot = await realpath(rootPath);
  const resolvedPath = await realpath(requestedPath);
  const stats = await lstat(requestedPath);

  if (!isContainedFile(resolvedRoot, resolvedPath)) {
    throw new Error(`Legacy cleanup path is outside its captured root: ${requestedPath}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Legacy cleanup path is not a regular file: ${requestedPath}`);
  }

  const resolvedParent = dirname(resolvedPath);
  const parentStats = await lstat(resolvedParent);
  const parentHandle = await open(
    resolvedParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );

  try {
    const openedParentStats = await parentHandle.stat();
    if (
      !parentStats.isDirectory() ||
      !openedParentStats.isDirectory() ||
      openedParentStats.dev !== parentStats.dev ||
      openedParentStats.ino !== parentStats.ino
    ) {
      throw new Error(`Legacy cleanup parent changed during capture: ${resolvedParent}`);
    }

    // Linux procfs resolves this leaf relative to the already-open directory descriptor. This
    // prevents a later rename or symlink swap of any pathname parent from redirecting unlink.
    const anchoredPath = `/proc/self/fd/${parentHandle.fd}/${basename(resolvedPath)}`;
    const anchoredResolvedPath = await realpath(anchoredPath);
    const anchoredStats = await lstat(anchoredPath);
    if (
      anchoredResolvedPath !== resolvedPath ||
      anchoredStats.isSymbolicLink() ||
      !anchoredStats.isFile() ||
      anchoredStats.dev !== stats.dev ||
      anchoredStats.ino !== stats.ino ||
      anchoredStats.size !== stats.size ||
      anchoredStats.mtimeMs !== stats.mtimeMs
    ) {
      throw new Error(`Legacy cleanup file changed during capture: ${requestedPath}`);
    }

    return {
      path: requestedPath,
      rootPath,
      resolvedRoot,
      resolvedPath,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      parentHandle,
      anchoredPath,
    };
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
}

async function prepareDeletionCandidates(files: LegacyCleanupSource[]): Promise<{
  candidates: DeletionCandidate[];
  errors: FailedOperation[];
}> {
  const candidates: DeletionCandidate[] = [];
  const errors: FailedOperation[] = [];
  const deduplicated = new Map<string, LegacyCleanupSource>();

  for (const file of files) {
    const path = resolve(file.path);
    const root = resolve(file.root);
    const existing = deduplicated.get(path);
    if (existing && resolve(existing.root) !== root) {
      errors.push(
        failedOperation(path, new Error(`Legacy file was discovered under conflicting roots`)),
      );
      continue;
    }
    deduplicated.set(path, { path, root });
  }

  for (const file of deduplicated.values()) {
    try {
      candidates.push(await captureDeletionCandidate(file));
    } catch (error) {
      errors.push(failedOperation(file.path, error));
    }
  }
  return { candidates, errors };
}

async function assertDeletionCandidateUnchanged(candidate: DeletionCandidate): Promise<void> {
  const [resolvedRoot, resolvedPath, stats] = await Promise.all([
    realpath(candidate.rootPath),
    realpath(candidate.anchoredPath),
    lstat(candidate.anchoredPath),
  ]);

  if (
    resolvedRoot !== candidate.resolvedRoot ||
    resolvedPath !== candidate.resolvedPath ||
    !isContainedFile(resolvedRoot, resolvedPath) ||
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.dev !== candidate.dev ||
    stats.ino !== candidate.ino ||
    stats.size !== candidate.size ||
    stats.mtimeMs !== candidate.mtimeMs
  ) {
    throw new Error(`Legacy cleanup file changed after migration proof: ${candidate.path}`);
  }
}

/** Deletes only identity-bound, regular-file leaves and contains sibling failures. */
async function deleteLegacyFiles(files: DeletionCandidate[]): Promise<DeletionResult> {
  const result: DeletionResult = {
    deleted: 0,
    errors: [],
  };

  for (const candidate of files) {
    try {
      await assertDeletionCandidateUnchanged(candidate);
      await unlink(candidate.anchoredPath);
      result.deleted++;
      logDebug(`Deleted: ${candidate.path}`);
    } catch (error) {
      const failure = failedOperation(candidate.path, error);
      result.errors.push(failure);
      logWarn(`Failed to delete ${candidate.path}: ${failure.message}`);
    }
  }

  return result;
}

/**
 * Logs a summary of the migration results.
 *
 * @param trackingResult - Tracking migration statistics
 * @param historyResult - History migration statistics
 * @param filesDeleted - Number of files deleted
 * @param errors - Array of errors encountered
 */
function logSummary(
  trackingResult: TrackingMigrationResult,
  historyResult: HistoryMigrationResult,
  filesDeleted: number,
  errors: FailedOperation[],
): void {
  logInfo("");
  logInfo(pc.bold("Migration Summary:"));
  logInfo("─".repeat(60));

  // Tracking summary
  if (trackingResult.legacyFiles.length > 0) {
    logInfo(
      `Tracking: ${trackingResult.operations} operation(s), ${trackingResult.sources} source(s)`,
    );
  }

  // History summary
  if (historyResult.legacyFiles.length > 0) {
    logInfo(
      `History:  ${historyResult.sessions} session(s), ${historyResult.operations} operation(s)`,
    );
  }

  // Deletion summary
  if (filesDeleted > 0) {
    logInfo(`Deleted:  ${filesDeleted} legacy file(s)`);
  }

  // Errors
  if (errors.length > 0) {
    logInfo("");
    logError(`Errors:   ${errors.length} error(s) encountered`);
  }

  logInfo("─".repeat(60));
}
