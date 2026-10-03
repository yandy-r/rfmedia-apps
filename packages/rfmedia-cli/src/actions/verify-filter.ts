/**
 * Filter mode verification logic for rfmedia CLI.
 *
 * Implements rating-based track verification where individual tracks
 * that meet a rating threshold are expected in the output folder.
 */

import path from "node:path";
import type {
  VerifyOptions,
  VerifyCommandResult,
  VerifiedFile,
  FailedOperation,
  FixResult,
  RatingFilter,
  PathEntry,
  CopyRange,
  ConflictContext,
  ConflictResolutionResult,
  ConflictResolution,
} from "../types/index.js";
import type { DbInventoryFingerprint } from "../types/db.js";
import {
  readRating,
  meetsThreshold,
  meetsPlayCountThreshold,
  readRatingAndFormat,
  meetsMetadataFilters,
  hasMetadataFilters,
} from "../lib/ratings.js";
import { findAudioFiles } from "../lib/audio.js";
import {
  pathExists,
  copyOrLink,
  remove,
  moveToTrash,
  ensureDir,
  getFileSize,
  replaceFileWithValidatedStage,
  createOpenFileVerificationTarget,
} from "../lib/filesystem.js";
import { readSourcePaths } from "../lib/input-file.js";
import { isJsonMode, logDebug, logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { processInParallel } from "../lib/parallel.js";
import { withSpinner } from "../lib/progress.js";
import {
  allocateUniqueDestinationPaths,
  getExpectedDestFilename,
  findExtraFiles,
} from "../lib/verify.js";
import { formatSuffix } from "../lib/range.js";
import { convertFileWithValidation, shouldConvert } from "../lib/convert.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import {
  resolveConflictInteractive,
  chooseResolutionsByStrategy,
  generateUniquePath,
} from "../lib/conflict-resolver.js";
import {
  addExtraFile,
  addVerifyFailure,
  addVerifyOutcome,
  applyVerifyFileOutcome,
  createVerifyResult,
  hasUnresolvedVerificationProblems,
  mergeVerifyResults,
  resolveFingerprintCandidate,
  sortVerifyResult,
  verifyFileByTier,
} from "../lib/tiered-verification.js";
import {
  closeDatabase,
  getInventoryFingerprintCandidates,
  openDatabaseReadOnly,
} from "../lib/db.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveUndoDatabasePath } from "../lib/config.js";

/**
 * Generates a unique filename path by tracking duplicates.
 *
 * For the first occurrence of a filename, returns the original name.
 * For subsequent occurrences, adds suffixes: -002, -003, etc.
 *
 * @param destDir - Destination directory path
 * @param filename - Original filename to make unique
 * @param usedNames - Map tracking next suffix number per base filename
 * @returns Unique absolute path for the file
 */
interface FilterVerificationTask {
  sourcePath: string;
  sourceRoot: string;
  destinationPath: string;
  displayPath: string;
  converted: boolean;
}

interface FilterVerificationEvidence {
  candidates: readonly DbInventoryFingerprint[];
}

function createDestinationTasks(
  source: string,
  destinationRoot: string,
  likedFiles: readonly string[],
  filter: RatingFilter,
  options: VerifyOptions,
): FilterVerificationTask[] {
  const desired: Array<
    Omit<FilterVerificationTask, "destinationPath" | "displayPath"> & {
      desiredPath: string;
    }
  > = [];
  const copies = filter.range
    ? Array.from(
        { length: filter.range.end - filter.range.start + 1 },
        (_, index) => filter.range!.start + index,
      )
    : [null];

  for (const sourcePath of likedFiles) {
    const converted = Boolean(
      options.convertFormat && shouldConvert(sourcePath, options.convertFormat),
    );
    const expectedFilename = getExpectedDestFilename(sourcePath, options.convertFormat);
    const extension = path.extname(expectedFilename);
    const basename = path.basename(expectedFilename, extension);
    const albumName = extractAlbumName(sourcePath, source);
    const artifactDir =
      filter.preserveStructure && albumName
        ? path.join(destinationRoot, albumName)
        : destinationRoot;

    for (const copy of copies) {
      const filename =
        copy === null
          ? expectedFilename
          : `${basename}-${formatSuffix(copy, filter.range!.padWidth)}${extension}`;
      desired.push({
        sourcePath,
        sourceRoot: source,
        converted,
        desiredPath: path.join(artifactDir, filename),
      });
    }
  }

  const allocated = allocateUniqueDestinationPaths(desired.map((task) => task.desiredPath));
  return desired.map((task, index) => {
    const destinationPath = allocated[index]!;
    return {
      sourcePath: task.sourcePath,
      sourceRoot: task.sourceRoot,
      destinationPath,
      displayPath: path.relative(destinationRoot, destinationPath),
      converted: task.converted,
    };
  });
}

async function verifyTask(
  task: FilterVerificationTask,
  options: VerifyOptions,
  evidence: FilterVerificationEvidence,
  signal?: AbortSignal,
) {
  if (!(await pathExists(task.destinationPath))) {
    return {
      path: task.displayPath,
      sourcePath: task.sourcePath,
      status: "missing" as const,
    };
  }

  const resolution =
    options.tier === "quick"
      ? { status: "missing" as const }
      : resolveFingerprintCandidate(evidence.candidates, {
          sourcePath: task.sourceRoot,
          relativePath: path.relative(task.sourceRoot, task.sourcePath),
          destinationPath: task.destinationPath,
          convertKey: options.convertFormat ?? null,
        });
  const outcome = await verifyFileByTier({
    tier: options.tier,
    sourcePath: task.sourcePath,
    destinationPath: task.destinationPath,
    converted: task.converted,
    fingerprint: resolution.status === "found" ? resolution.fingerprint : undefined,
    fingerprintReason:
      resolution.status === "ambiguous"
        ? "fingerprint-ambiguous"
        : resolution.status === "missing" && options.tier !== "quick"
          ? "fingerprint-missing"
          : undefined,
    verifySize: options.verifySize,
    signal,
  });
  return { path: task.displayPath, sourcePath: task.sourcePath, outcome };
}

async function verifyTaskBatch(
  source: string,
  displayRoot: string,
  tasks: readonly FilterVerificationTask[],
  options: VerifyOptions,
  evidence: FilterVerificationEvidence,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  const result = createVerifyResult(source, options.tier);
  const outcomes = await processInParallel(
    [...tasks],
    async (task) => await verifyTask(task, options, evidence, signal),
    { workers: options.workers, signal },
  );
  for (const outcome of outcomes) {
    if (outcome.success && outcome.value) {
      if ("outcome" in outcome.value && outcome.value.outcome) {
        applyVerifyFileOutcome(
          result,
          outcome.value.path,
          outcome.value.outcome,
          outcome.value.sourcePath,
        );
      } else {
        addVerifyOutcome(result, outcome.value);
      }
    } else {
      const error = outcome.error ?? new Error("Unknown error");
      const task = tasks[outcome.index];
      if (task) {
        addVerifyFailure(result, {
          path: task.displayPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
  }

  const tasksByDirectory = new Map<string, Set<string>>();
  for (const task of tasks) {
    const directory = path.dirname(task.destinationPath);
    const expected = tasksByDirectory.get(directory) ?? new Set<string>();
    expected.add(path.basename(task.destinationPath));
    tasksByDirectory.set(directory, expected);
  }
  for (const [directory, expected] of tasksByDirectory) {
    try {
      for (const extraFile of await findExtraFiles(expected, directory)) {
        addExtraFile(result, path.relative(displayRoot, path.join(directory, extraFile)));
      }
    } catch (err) {
      logDebug(`Cannot check for extra files in ${directory}: ${(err as Error).message}`);
    }
  }
  sortVerifyResult(result);
  return result;
}

/**
 * Result of pre-scanning audio files for rating threshold.
 */
interface PreScanResult {
  /** Files that meet the rating threshold */
  likedFiles: string[];
  /** Files that don't meet the threshold (filtered out) */
  filteredFiles: string[];
}

/**
 * Pre-scans audio files to determine which should meet the rating and metadata thresholds.
 *
 * This determines which files are expected to exist in the destination.
 *
 * @param audioFiles - Array of audio file paths to scan
 * @param filter - Rating filter configuration (includes metadata filters)
 * @returns Object with liked files and filtered files
 */
async function preScanForExpectedFiles(
  audioFiles: string[],
  filter: RatingFilter,
): Promise<PreScanResult> {
  const likedFiles: string[] = [];
  const filteredFiles: string[] = [];
  const checkMetadata = hasMetadataFilters(filter);

  for (const filePath of audioFiles) {
    try {
      if (checkMetadata) {
        // Use combined reader for efficiency when metadata filters are needed
        const result = await readRatingAndFormat(filePath);

        if (result === null) {
          // Error reading file
          filteredFiles.push(filePath);
          continue;
        }

        const { rating, format } = result;

        // Check rating threshold first
        if (rating === null || !meetsThreshold(rating.value, filter)) {
          filteredFiles.push(filePath);
          continue;
        }

        // Check play count threshold
        if (!meetsPlayCountThreshold(rating?.counter, filter.minPlays)) {
          logDebug(`Filtered by play count: ${rating?.counter ?? 0} < ${filter.minPlays}`);
          filteredFiles.push(filePath);
          continue;
        }

        // Check metadata filters (duration, bitrate, codec)
        const metaResult = meetsMetadataFilters(format, filter);
        if (!metaResult.passes) {
          logDebug(`Filtered ${path.basename(filePath)}: ${metaResult.reason}`);
          filteredFiles.push(filePath);
          continue;
        }

        // Passes all filters
        likedFiles.push(filePath);
      } else {
        // No metadata filters - use simpler rating-only check
        const rating = await readRating(filePath);

        if (rating === null) {
          // Unrated - filtered out
          filteredFiles.push(filePath);
        } else if (meetsThreshold(rating.value, filter)) {
          // Meets threshold
          likedFiles.push(filePath);
        } else {
          // Below threshold
          filteredFiles.push(filePath);
        }
      }
    } catch {
      // Error reading rating - treat as filtered
      filteredFiles.push(filePath);
    }
  }

  return { likedFiles, filteredFiles };
}

/**
 * Extract album name from a file path relative to source directory.
 *
 * @param filePath - Absolute path to the audio file
 * @param sourceDir - Base source directory path (artist folder)
 * @returns Album name or null if file is directly in source
 */
function extractAlbumName(filePath: string, sourceDir: string): string | null {
  const relative = path.relative(sourceDir, filePath);
  const parts = relative.split(path.sep);

  // If file is in a subdirectory, first part is album name
  // If file is directly in source, no album name
  return parts.length > 1 ? parts[0]! : null;
}

/**
 * Fixes issues in filtered track verification.
 *
 * Actions performed:
 * - Re-copies missing files from source (no conflict resolution needed)
 * - Handles size-mismatched files using conflict resolution:
 *   - If conflictStrategy is set, uses resolveConflictsByStrategy()
 *   - If not set and interactive, uses resolveConflictInteractive()
 *   - Falls back to --force behavior for backwards compatibility
 * - Handles extra files using conflict resolution for skip/remove/keep
 *
 * @param source - Source directory
 * @param destDir - Destination directory
 * @param issues - Issues found by verification
 * @param filter - Rating filter configuration
 * @param options - Verify options including fix, force, trash, convertFormat, conflictStrategy
 * @param applyToAllMap - Optional map for "Apply to All" state across fix operations
 * @returns Fix result with counts of fixed/failed operations and conflict resolutions
 */
async function fixFilteredTracks(
  source: string,
  destDir: string,
  issues: VerifiedFile[],
  filter: RatingFilter,
  options: VerifyOptions,
  evidence: FilterVerificationEvidence,
  signal?: AbortSignal,
  applyToAllMap?: Map<string, ConflictResolution>,
): Promise<FixResult> {
  const { force, trash, convertFormat, conflictStrategy } = options;

  const result: FixResult = {
    copiedFiles: 0,
    removedFiles: 0,
    failedFixes: [],
    repairedFiles: 0,
    reverifiedFiles: 0,
    refusedFiles: 0,
    remainingIssues: 0,
    conflictResolutions: [],
  };

  // Initialize applyToAll map if not provided (for batch operations)
  const applyToAll = applyToAllMap ?? new Map<string, ConflictResolution>();

  // Group issues by type
  const missingFiles = issues.filter((i) => i.status === "missing");
  const extraFiles = issues.filter((i) => i.status === "extra");
  const sizeMismatchFiles = issues.filter((issue) =>
    [
      "size-mismatch",
      "metadata-mismatch",
      "hash-mismatch",
      "content-mismatch",
      "unstable",
    ].includes(issue.status),
  );

  const stageRepair = async (sourceFile: string, destinationFile: string): Promise<void> => {
    signal?.throwIfAborted();
    const converted = Boolean(convertFormat && shouldConvert(sourceFile, convertFormat));
    const resolution =
      options.tier === "quick"
        ? { status: "missing" as const }
        : resolveFingerprintCandidate(evidence.candidates, {
            sourcePath: source,
            relativePath: path.relative(source, sourceFile),
            destinationPath: destinationFile,
            convertKey: convertFormat ?? null,
          });

    await ensureDir(path.dirname(destinationFile));
    const verifyStagedArtifact = async (
      stagedDestination: string,
      stagedSignal: AbortSignal,
      verificationTarget?: ReturnType<typeof createOpenFileVerificationTarget>,
    ): Promise<void> => {
      const verificationInput = {
        tier: options.tier,
        sourcePath: sourceFile,
        destinationPath: stagedDestination,
        converted,
        fingerprint: resolution.status === "found" ? resolution.fingerprint : undefined,
        fingerprintReason:
          resolution.status === "ambiguous"
            ? "fingerprint-ambiguous"
            : resolution.status === "missing" && options.tier !== "quick"
              ? "fingerprint-missing"
              : undefined,
        verifySize: options.verifySize,
        signal: stagedSignal,
      } as const;
      const outcome =
        verificationTarget === undefined
          ? await verifyFileByTier(verificationInput)
          : await verifyFileByTier(verificationInput, verificationTarget.dependencies);
      if (outcome.status !== "present") {
        throw new Error(
          `Staged repair did not pass ${options.tier} verification (${outcome.status})`,
        );
      }
    };

    if (converted && convertFormat) {
      await convertFileWithValidation(sourceFile, destinationFile, convertFormat, {
        signal,
        additionalValidator: async (_stagedPath, stagedSignal, stagedHandle) => {
          const verificationTarget = createOpenFileVerificationTarget(stagedHandle);
          await verifyStagedArtifact(verificationTarget.path, stagedSignal, verificationTarget);
        },
      });
    } else {
      await replaceFileWithValidatedStage(destinationFile, {
        signal,
        materialize: async (_stagedPath, stagedSignal, stagedHandle) => {
          await copyOrLink(sourceFile, stagedHandle, false, stagedSignal);
        },
        validate: async (_stagedPath, stagedSignal, stagedHandle) => {
          if (stagedHandle === undefined) {
            throw new Error("Staged repair did not receive its authoritative file handle");
          }
          const verificationTarget = createOpenFileVerificationTarget(stagedHandle);
          await verifyStagedArtifact(verificationTarget.path, stagedSignal, verificationTarget);
        },
      });
    }
  };

  // Handle missing files: re-copy from source (no conflict resolution needed)
  if (missingFiles.length > 0) {
    logInfo(`Re-copying ${missingFiles.length} missing files...`);

    for (const issue of missingFiles) {
      const sourceFile = issue.sourcePath;
      if (!sourceFile) {
        result.failedFixes.push({
          path: issue.path,
          message: "Source path not available for re-copying",
        });
        result.refusedFiles++;
        logError(`  ✗ Failed: ${issue.path} (no source path)`);
        continue;
      }

      const destFile = path.join(destDir, issue.path);

      try {
        await stageRepair(sourceFile, destFile);

        result.copiedFiles++;
        result.repairedFiles++;
        result.reverifiedFiles++;
        logSuccess(`  ✓ Copied: ${path.basename(issue.path)}`);
      } catch (err) {
        result.refusedFiles++;
        result.failedFixes.push({
          path: issue.path,
          message: `Failed to copy: ${(err as Error).message}`,
          code: (err as NodeJS.ErrnoException).code,
        });
        logError(`  ✗ Failed: ${path.basename(issue.path)}`);
      }
    }
  }

  // Handle size mismatches using conflict resolution
  if (sizeMismatchFiles.length > 0) {
    logInfo(`Found ${sizeMismatchFiles.length} size mismatches`);

    // Determine the effective strategy
    // --force implies 'overwrite' for backwards compatibility
    const effectiveStrategy = force ? "overwrite" : conflictStrategy;

    if (effectiveStrategy && effectiveStrategy !== "ask") {
      // Use strategy-based resolution (decision-only, no filesystem actions yet)
      const contexts = buildSizeMismatchContextsForFilter(sizeMismatchFiles, destDir);

      // Get resolution decisions without performing actions
      const decisions = chooseResolutionsByStrategy(contexts, effectiveStrategy);

      // Track used names for rename operations across all files
      const usedNames = new Map<string, number>();

      // Now perform the actual file operations with conversion support
      for (const decision of decisions) {
        const { context, resolution, newPath } = decision;
        const filename = path.basename(context.destPath);
        const sourceFile = context.sourcePath;

        // Build resolution result for tracking
        const resolutionResult: ConflictResolutionResult = {
          context,
          resolution,
          newPath,
          success: false, // Will be set to true if action succeeds
        };

        try {
          if (resolution === "skip") {
            logDebug(`  Skipped: ${filename}`);
            resolutionResult.success = true;
          } else if (resolution === "overwrite") {
            // Remove existing file, then copy/convert
            if (!options.dryRun && sourceFile) {
              await stageRepair(sourceFile, context.destPath);
              result.copiedFiles++;
              result.repairedFiles++;
              result.reverifiedFiles++;
              logSuccess(`  ✓ Re-copied: ${filename}`);
            } else if (options.dryRun) {
              logDebug(`[DRY-RUN] Would overwrite and re-copy: ${filename}`);
            }
            resolutionResult.success = true;
          } else if (resolution === "rename") {
            const targetPath = newPath ?? generateUniquePath(context.destPath, usedNames);
            result.refusedFiles++;
            result.remainingIssues++;
            logWarn(`  Refused rename repair for expected path: ${filename}`);
            resolutionResult.newPath = targetPath;
            resolutionResult.success = true;
          }
        } catch (err) {
          result.refusedFiles++;
          resolutionResult.error = (err as Error).message;
          result.failedFixes.push({
            path: context.destPath,
            message: `Failed to ${resolution}: ${(err as Error).message}`,
            code: (err as NodeJS.ErrnoException).code,
          });
          logError(`  ✗ Failed: ${filename}`);
        }

        result.conflictResolutions?.push(resolutionResult);
      }
    } else if (
      effectiveStrategy === "ask" ||
      (!effectiveStrategy && isInteractive() && !isJsonMode())
    ) {
      // Interactive resolution
      for (const issue of sizeMismatchFiles) {
        const sourceFile = issue.sourcePath;
        if (!sourceFile) {
          result.failedFixes.push({
            path: issue.path,
            message: "Source path not available for re-copying",
          });
          logError(`  ✗ Failed: ${issue.path} (no source path)`);
          continue;
        }

        const destFile = path.join(destDir, issue.path);
        const filename = path.basename(issue.path);

        // Build conflict context
        const context: ConflictContext = {
          sourcePath: sourceFile,
          destPath: destFile,
          conflictType: {
            type: "size-mismatch",
            destPath: destFile,
            expected: issue.expectedSize ?? 0,
            actual: issue.actualSize ?? 0,
          },
          sourceSize: issue.expectedSize,
          destSize: issue.actualSize,
        };

        try {
          const { resolution, applyToAll: shouldApplyToAll } = await resolveConflictInteractive(
            context,
            {
              applyToAll,
            },
          );

          if (shouldApplyToAll) {
            applyToAll.set("size-mismatch", resolution);
          }

          // Apply the resolution
          const resolutionResult = await applyResolutionForSizeMismatchFilter(
            context,
            resolution,
            options,
            sourceFile,
            destFile,
            stageRepair,
          );

          result.conflictResolutions?.push(resolutionResult);

          if (resolutionResult.success) {
            if (resolution === "overwrite") {
              result.copiedFiles++;
              result.repairedFiles++;
              result.reverifiedFiles++;
              logSuccess(`  ✓ Re-copied: ${filename}`);
            } else if (resolution === "rename") {
              result.refusedFiles++;
              result.remainingIssues++;
              logWarn(`  Refused rename repair for expected path: ${filename}`);
            } else {
              logDebug(`  Skipped: ${filename}`);
            }
          } else if (resolution === "rename") {
            result.refusedFiles++;
            result.remainingIssues++;
            logWarn(`  Refused rename repair for expected path: ${filename}`);
          } else {
            result.failedFixes.push({
              path: destFile,
              message: resolutionResult.error ?? "Unknown error",
            });
            logError(`  ✗ Failed: ${filename}`);
          }
        } catch (err) {
          result.failedFixes.push({
            path: destFile,
            message: `Failed to resolve conflict: ${(err as Error).message}`,
          });
          logError(`  ✗ Failed: ${filename}`);
        }
      }
    } else {
      // Non-interactive without strategy - show warning (backwards compatible)
      logWarn("Size mismatches require --force, --conflict-strategy, or interactive mode to fix");
      logWarn("Use --conflict-strategy=overwrite or --force to overwrite mismatched files");
    }
  }

  // Handle extra files using conflict resolution
  if (extraFiles.length > 0) {
    logWarn(`Found ${extraFiles.length} extra files`);

    // Determine effective strategy for extra files
    // --force implies removal for backwards compatibility
    const effectiveStrategy = force ? "overwrite" : conflictStrategy;

    if (effectiveStrategy && effectiveStrategy !== "ask") {
      // Build conflict contexts for extra files
      const contexts = await buildExtraFileContextsForFilter(extraFiles, destDir);

      // For extra files, 'overwrite' strategy means 'remove'
      // 'skip' strategy means 'keep'
      // 'rename' doesn't apply to extra files
      for (const context of contexts) {
        let resolution: ConflictResolution;
        if (effectiveStrategy === "overwrite") {
          resolution = "remove";
        } else if (effectiveStrategy === "skip" || effectiveStrategy === "rename") {
          resolution = "keep";
        } else {
          resolution = "keep";
        }

        const resolutionResult = await applyExtraFileResolutionFilter(
          context,
          resolution,
          options.dryRun ?? false,
          trash ?? false,
        );
        result.conflictResolutions?.push(resolutionResult);

        if (resolutionResult.success && resolution === "remove") {
          result.removedFiles++;
          logSuccess(
            `  ✓ ${trash ? "Moved to trash" : "Removed"}: ${path.basename(context.destPath)}`,
          );
        } else if (resolutionResult.success && resolution === "keep") {
          logDebug(`  Kept: ${path.basename(context.destPath)}`);
        } else if (!resolutionResult.success) {
          result.failedFixes.push({
            path: context.destPath,
            message: resolutionResult.error ?? "Unknown error",
          });
          logError(`  ✗ Failed: ${path.basename(context.destPath)}`);
        }
      }
    } else if (
      effectiveStrategy === "ask" ||
      (!effectiveStrategy && isInteractive() && !isJsonMode())
    ) {
      // Interactive resolution for extra files
      // Show what will be deleted first
      if (!isJsonMode()) {
        console.error("");
        console.error("The following extra files were found:");
        for (const issue of extraFiles) {
          console.error(`  - ${issue.path}`);
        }
        console.error("");
      }

      for (const issue of extraFiles) {
        const filename = path.basename(issue.path);
        const destFile = path.join(destDir, issue.path);

        // Get file size for context
        let fileSize = 0;
        try {
          fileSize = await getFileSize(destFile);
        } catch {
          // Ignore if we can't read size
        }

        const context: ConflictContext = {
          sourcePath: "", // No source for extra files
          destPath: destFile,
          conflictType: {
            type: "extra",
            destPath: destFile,
            size: fileSize,
          },
          destSize: fileSize,
        };

        try {
          const { resolution, applyToAll: shouldApplyToAll } = await resolveConflictInteractive(
            context,
            {
              applyToAll,
            },
          );

          if (shouldApplyToAll) {
            applyToAll.set("extra", resolution);
          }

          const resolutionResult = await applyExtraFileResolutionFilter(
            context,
            resolution,
            options.dryRun ?? false,
            trash ?? false,
          );

          result.conflictResolutions?.push(resolutionResult);

          if (resolutionResult.success && resolution === "remove") {
            result.removedFiles++;
            logSuccess(`  ✓ ${trash ? "Moved to trash" : "Removed"}: ${filename}`);
          } else if (resolutionResult.success && resolution === "keep") {
            logDebug(`  Kept: ${filename}`);
          } else if (!resolutionResult.success) {
            result.failedFixes.push({
              path: destFile,
              message: resolutionResult.error ?? "Unknown error",
            });
            logError(`  ✗ Failed: ${filename}`);
          }
        } catch (err) {
          result.failedFixes.push({
            path: destFile,
            message: `Failed to resolve conflict: ${(err as Error).message}`,
          });
          logError(`  ✗ Failed: ${filename}`);
        }
      }
    } else {
      // Non-interactive without strategy - use legacy confirm behavior
      let proceed = false;
      if (!isJsonMode()) {
        proceed = await confirm("Remove these extra files?");
      }

      if (proceed) {
        logInfo(`Removing ${extraFiles.length} extra files...`);

        for (const issue of extraFiles) {
          const destFile = path.join(destDir, issue.path);

          try {
            if (trash) {
              await moveToTrash(destFile);
              logSuccess(`  ✓ Moved to trash: ${path.basename(issue.path)}`);
            } else {
              await remove(destFile);
              logSuccess(`  ✓ Removed: ${path.basename(issue.path)}`);
            }

            result.removedFiles++;
          } catch (err) {
            result.failedFixes.push({
              path: issue.path,
              message: `Failed to remove: ${(err as Error).message}`,
              code: (err as NodeJS.ErrnoException).code,
            });
            logError(`  ✗ Failed: ${path.basename(issue.path)}`);
          }
        }
      } else {
        logInfo("Removal cancelled by user");
      }
    }
  }

  return result;
}

/**
 * Builds ConflictContext array for size-mismatch issues in filter mode.
 */
function buildSizeMismatchContextsForFilter(
  issues: VerifiedFile[],
  destDir: string,
): ConflictContext[] {
  const contexts: ConflictContext[] = [];

  for (const issue of issues) {
    const sourceFile = issue.sourcePath;
    if (!sourceFile) continue;

    const destFile = path.join(destDir, issue.path);

    contexts.push({
      sourcePath: sourceFile,
      destPath: destFile,
      conflictType: {
        type: "size-mismatch",
        destPath: destFile,
        expected: issue.expectedSize ?? 0,
        actual: issue.actualSize ?? 0,
      },
      sourceSize: issue.expectedSize,
      destSize: issue.actualSize,
    });
  }

  return contexts;
}

/**
 * Builds ConflictContext array for extra file issues in filter mode.
 */
async function buildExtraFileContextsForFilter(
  issues: VerifiedFile[],
  destDir: string,
): Promise<ConflictContext[]> {
  const contexts: ConflictContext[] = [];

  for (const issue of issues) {
    const destFile = path.join(destDir, issue.path);

    let fileSize = 0;
    try {
      fileSize = await getFileSize(destFile);
    } catch {
      // Ignore if we can't read size
    }

    contexts.push({
      sourcePath: "", // No source for extra files
      destPath: destFile,
      conflictType: {
        type: "extra",
        destPath: destFile,
        size: fileSize,
      },
      destSize: fileSize,
    });
  }

  return contexts;
}

/**
 * Applies resolution for a size-mismatch conflict in filter mode.
 */
async function applyResolutionForSizeMismatchFilter(
  context: ConflictContext,
  resolution: ConflictResolution,
  options: VerifyOptions,
  sourceFile: string,
  destFile: string,
  stageRepair: (sourceFile: string, destinationFile: string) => Promise<void>,
): Promise<ConflictResolutionResult> {
  const { dryRun } = options;

  try {
    if (resolution === "skip" || resolution === "keep") {
      return { context, resolution, success: true };
    }

    if (resolution === "overwrite") {
      if (dryRun) {
        logDebug(`[DRY-RUN] Would re-copy: ${path.basename(destFile)}`);
        return { context, resolution, success: true };
      }

      await stageRepair(sourceFile, destFile);
      return { context, resolution, success: true };
    }

    if (resolution === "rename") {
      // For rename, copy to a new unique path (append -002, -003, etc.)
      const usedNames = new Map<string, number>();
      const newPath = generateUniquePath(destFile, usedNames);

      if (dryRun) {
        logDebug(`[DRY-RUN] Would copy to renamed path: ${path.basename(newPath)}`);
        return { context, resolution, newPath, success: true };
      }

      return {
        context,
        resolution,
        newPath,
        success: false,
        error: "Rename repair cannot satisfy the expected destination path",
      };
    }

    return { context, resolution, success: false, error: `Unknown resolution: ${resolution}` };
  } catch (err) {
    return {
      context,
      resolution,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Applies resolution for an extra file conflict in filter mode.
 */
async function applyExtraFileResolutionFilter(
  context: ConflictContext,
  resolution: ConflictResolution,
  dryRun: boolean,
  useTrash: boolean,
): Promise<ConflictResolutionResult> {
  try {
    if (resolution === "keep" || resolution === "skip") {
      return { context, resolution, success: true };
    }

    if (resolution === "remove") {
      if (dryRun) {
        logDebug(`[DRY-RUN] Would remove: ${path.basename(context.destPath)}`);
        return { context, resolution, success: true };
      }

      if (useTrash) {
        await moveToTrash(context.destPath);
      } else {
        await remove(context.destPath);
      }
      return { context, resolution, success: true };
    }

    // 'overwrite' and 'rename' don't make sense for extra files
    return {
      context,
      resolution: "keep",
      success: true,
    };
  } catch (err) {
    return {
      context,
      resolution,
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Executes filter mode verification operation.
 *
 * Scans the source directory for audio files, determines which files should
 * meet the rating/metadata threshold, and verifies they exist in the destination.
 *
 * @param source - Source directory path
 * @param destination - Destination directory where filtered tracks exist
 * @param options - Verify options with filter mode configuration
 * @returns Result with verified/missing/failed counts
 * @throws Error if source does not exist or mode is not filter mode
 */
async function executeFilterVerifyWithEvidence(
  source: string,
  destination: string,
  options: VerifyOptions,
  evidence: FilterVerificationEvidence,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  // Validate options has filter mode
  if (options.mode.type !== "filter") {
    throw new Error("executeFilterVerify requires filter mode options");
  }

  const { rating: filter } = options.mode;
  const { workers, verifySize } = options;

  // Validate source directory exists
  if (!(await pathExists(source))) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  const artistName = path.basename(source);

  // Determine destination path based on mode
  let destDir: string;
  if (filter.albumMode && filter.range) {
    // Album mode with range: output to Artist/liked-songs-XXX
    const suffix = formatSuffix(filter.range.start, filter.range.padWidth);
    destDir = path.join(destination, artistName, `${filter.outputFolder}-${suffix}`);
  } else if (filter.albumMode) {
    // Album mode without range: output to Artist/liked-songs
    destDir = path.join(destination, artistName, filter.outputFolder);
  } else if (filter.preserveStructure) {
    // Preserve structure: use Artist/liked-songs
    destDir = path.join(destination, artistName, filter.outputFolder);
  } else {
    // Flat structure: use liked-songs directly
    destDir = path.join(destination, filter.outputFolder);
  }

  logInfo(`Source: ${source}`);
  logInfo(`Destination: ${destDir}`);
  if (verifySize) {
    logInfo("Size verification: enabled");
  }
  logInfo("");

  // Scan source for audio files
  const scanOperation = async () => await findAudioFiles(source);
  const audioFiles = isJsonMode()
    ? await scanOperation()
    : await withSpinner("Scanning source directory", scanOperation);

  logInfo(`Found ${audioFiles.length} audio files in source`);

  // Pre-scan to determine which files should be present
  const { likedFiles, filteredFiles } = await preScanForExpectedFiles(audioFiles, filter);

  logInfo(`Expected files: ${likedFiles.length} (${filteredFiles.length} filtered out)`);
  logInfo("");

  if (likedFiles.length === 0) {
    logWarn("No files meet the rating threshold");
    return createVerifyResult(source, options.tier);
  }

  const tasks = createDestinationTasks(source, destDir, likedFiles, filter, options);
  let aggregated = createVerifyResult(source, options.tier);

  const results = await processInParallel(
    tasks,
    async (task) => await verifyTask(task, options, evidence, signal),
    {
      workers,
      signal,
      onProgress: (completed, total) => {
        logDebug(`Verification progress: ${completed}/${total}`);
      },
    },
  );

  for (const result of results) {
    if (result.success && result.value) {
      if ("outcome" in result.value && result.value.outcome) {
        applyVerifyFileOutcome(
          aggregated,
          result.value.path,
          result.value.outcome,
          result.value.sourcePath,
        );
      } else {
        addVerifyOutcome(aggregated, result.value);
      }
    } else {
      const error = result.error ?? new Error("Unknown error");
      const task = tasks[result.index];
      if (task) {
        addVerifyFailure(aggregated, {
          path: task.displayPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
  }

  const tasksByDirectory = new Map<string, Set<string>>();
  for (const task of tasks) {
    const directory = path.dirname(task.destinationPath);
    const expected = tasksByDirectory.get(directory) ?? new Set<string>();
    expected.add(path.basename(task.destinationPath));
    tasksByDirectory.set(directory, expected);
  }
  for (const [directory, expected] of tasksByDirectory) {
    try {
      for (const extraFile of await findExtraFiles(expected, directory)) {
        addExtraFile(aggregated, path.relative(destDir, path.join(directory, extraFile)));
      }
    } catch (err) {
      logDebug(`Cannot check for extra files in ${directory}: ${(err as Error).message}`);
    }
  }

  // Apply fixes if --fix is enabled and issues exist
  if (options.fix && aggregated.issues.length > 0 && !options.dryRun) {
    logInfo("");
    logInfo("=== Applying Fixes ===");

    const fixResult = await fixFilteredTracks(
      source,
      destDir,
      aggregated.issues,
      filter,
      options,
      evidence,
      signal,
    );

    aggregated = await verifyTaskBatch(source, destDir, tasks, options, evidence, signal);
    aggregated.failed.push(...fixResult.failedFixes);
    aggregated.fixResults = fixResult;
    fixResult.remainingIssues =
      aggregated.missing +
      aggregated.sizeMismatch +
      aggregated.metadataMismatch +
      aggregated.hashMismatch +
      aggregated.contentMismatch +
      aggregated.unverifiable +
      aggregated.unstable +
      aggregated.extra;

    // Log fix summary
    if (fixResult.copiedFiles > 0 || fixResult.removedFiles > 0) {
      logSuccess(
        `Fixed: ${fixResult.copiedFiles} copied, ${fixResult.removedFiles} removed, ${fixResult.failedFixes.length} failed`,
      );
    }
  }

  sortVerifyResult(aggregated);
  return aggregated;
}

function loadFilterVerificationEvidence(
  options: VerifyOptions,
  sourcePaths: readonly string[],
): FilterVerificationEvidence {
  if (options.tier === "quick") {
    return { candidates: [] };
  }

  const databasePath = options.trackingDatabase ?? resolveUndoDatabasePath(getLoadedConfig());
  const database = openDatabaseReadOnly(databasePath);
  try {
    const canonicalSourcePaths = sourcePaths.map((sourcePath) => path.resolve(sourcePath));
    return { candidates: getInventoryFingerprintCandidates(database, canonicalSourcePaths) };
  } finally {
    closeDatabase(database);
  }
}

export async function executeFilterVerify(
  source: string,
  destination: string,
  options: VerifyOptions,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  const sourceRoot = path.resolve(source);
  const evidence = loadFilterVerificationEvidence(options, [sourceRoot]);
  return await executeFilterVerifyWithEvidence(sourceRoot, destination, options, evidence, signal);
}

/**
 * Verifies filter mode with album mode enabled.
 *
 * In album mode, tracks are grouped by album and only liked tracks should exist.
 * With a range, numbered album copies are verified (Album-001, Album-002, etc.).
 *
 * @param source - Source directory path
 * @param destination - Destination directory
 * @param artistName - Artist name (basename of source)
 * @param filter - Rating filter configuration
 * @param options - Verify options
 * @returns Verification result
 */
async function verifyAlbumMode(
  source: string,
  destination: string,
  artistName: string,
  filter: RatingFilter,
  options: VerifyOptions,
  evidence: FilterVerificationEvidence,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  const { workers } = options;

  // Scan source for audio files
  const scanOperation = async () => await findAudioFiles(source);
  const audioFiles = isJsonMode()
    ? await scanOperation()
    : await withSpinner("Scanning source directory", scanOperation);

  if (audioFiles.length === 0) {
    logWarn("No audio files found in source");
    return createVerifyResult(source, options.tier);
  }

  logInfo(`Found ${audioFiles.length} audio files in source`);

  // Phase 1: Scan and group liked tracks by album (parallel rating reads)
  const checkMetadata = hasMetadataFilters(filter);

  interface RatingResult {
    filePath: string;
    meetsThreshold: boolean;
    albumName: string;
  }

  const ratingResults = await processInParallel(
    audioFiles,
    async (filePath) => {
      const albumName = extractAlbumName(filePath, source);
      if (albumName === null) {
        return { filePath, meetsThreshold: false, albumName: "" };
      }

      if (checkMetadata) {
        const result = await readRatingAndFormat(filePath);
        if (result === null) {
          return { filePath, meetsThreshold: false, albumName };
        }

        const { rating, format } = result;
        const meetsRating = rating !== null && meetsThreshold(rating.value, filter);
        if (!meetsRating) {
          return { filePath, meetsThreshold: false, albumName };
        }

        const meetsPlayCount = meetsPlayCountThreshold(rating?.counter, filter.minPlays);
        if (!meetsPlayCount) {
          return { filePath, meetsThreshold: false, albumName };
        }

        const metaResult = meetsMetadataFilters(format, filter);
        return { filePath, meetsThreshold: metaResult.passes, albumName };
      } else {
        const rating = await readRating(filePath);
        const meetsRating = rating !== null && meetsThreshold(rating.value, filter);
        return { filePath, meetsThreshold: meetsRating, albumName };
      }
    },
    { workers, signal },
  );

  // Group liked tracks by album
  const likedTracksByAlbum = new Map<string, string[]>();
  let filteredCount = 0;

  for (const result of ratingResults) {
    if (!result.success || !result.value) continue;
    const { filePath, meetsThreshold: passes, albumName } = result.value;

    if (!passes || !albumName) {
      filteredCount++;
      continue;
    }

    if (!likedTracksByAlbum.has(albumName)) {
      likedTracksByAlbum.set(albumName, []);
    }
    likedTracksByAlbum.get(albumName)!.push(filePath);
  }

  logInfo(
    `Expected files: ${audioFiles.length - filteredCount} liked tracks (${filteredCount} filtered out)`,
  );
  logInfo(`Albums with liked tracks: ${likedTracksByAlbum.size}`);
  logInfo("");

  let aggregated = createVerifyResult(source, options.tier);
  const suffixes: Array<string | null> = filter.range
    ? Array.from({ length: filter.range.end - filter.range.start + 1 }, (_, i) =>
        formatSuffix(filter.range!.start + i, filter.range!.padWidth),
      )
    : [null];

  const desired: Array<
    Omit<FilterVerificationTask, "destinationPath" | "displayPath"> & {
      desiredPath: string;
    }
  > = [];
  for (const [albumName, likedTracks] of likedTracksByAlbum) {
    for (const suffix of suffixes) {
      const albumDest =
        suffix !== null
          ? path.join(destination, artistName, `${albumName}-${suffix}`)
          : path.join(destination, artistName, albumName);

      for (const trackPath of likedTracks) {
        desired.push({
          sourcePath: trackPath,
          sourceRoot: source,
          converted: Boolean(
            options.convertFormat && shouldConvert(trackPath, options.convertFormat),
          ),
          desiredPath: path.join(
            albumDest,
            getExpectedDestFilename(trackPath, options.convertFormat),
          ),
        });
      }
    }
  }

  const allocated = allocateUniqueDestinationPaths(desired.map((task) => task.desiredPath));
  const tasks: FilterVerificationTask[] = desired.map((task, index) => ({
    ...task,
    destinationPath: allocated[index]!,
    displayPath: path.relative(path.join(destination, artistName), allocated[index]!),
  }));
  const results = await processInParallel(
    tasks,
    async (task) => await verifyTask(task, options, evidence, signal),
    { workers, signal },
  );
  for (const result of results) {
    if (result.success && result.value) {
      if ("outcome" in result.value && result.value.outcome) {
        applyVerifyFileOutcome(
          aggregated,
          result.value.path,
          result.value.outcome,
          result.value.sourcePath,
        );
      } else {
        addVerifyOutcome(aggregated, result.value);
      }
    } else {
      const error = result.error ?? new Error("Unknown error");
      const task = tasks[result.index];
      if (task) {
        addVerifyFailure(aggregated, {
          path: task.displayPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
  }

  const tasksByDirectory = new Map<string, Set<string>>();
  for (const task of tasks) {
    const directory = path.dirname(task.destinationPath);
    const expected = tasksByDirectory.get(directory) ?? new Set<string>();
    expected.add(path.basename(task.destinationPath));
    tasksByDirectory.set(directory, expected);
  }
  for (const [directory, expected] of tasksByDirectory) {
    try {
      for (const extraFile of await findExtraFiles(expected, directory)) {
        addExtraFile(
          aggregated,
          path.relative(path.join(destination, artistName), path.join(directory, extraFile)),
        );
      }
    } catch (err) {
      logDebug(`Cannot check for extra files in ${directory}: ${(err as Error).message}`);
    }
  }

  if (options.fix && aggregated.issues.length > 0 && !options.dryRun) {
    const displayRoot = path.join(destination, artistName);
    const fixResult = await fixFilteredTracks(
      source,
      displayRoot,
      aggregated.issues,
      filter,
      options,
      evidence,
      signal,
    );
    aggregated = await verifyTaskBatch(source, displayRoot, tasks, options, evidence, signal);
    aggregated.failed.push(...fixResult.failedFixes);
    fixResult.remainingIssues =
      aggregated.missing +
      aggregated.sizeMismatch +
      aggregated.metadataMismatch +
      aggregated.hashMismatch +
      aggregated.contentMismatch +
      aggregated.unverifiable +
      aggregated.unstable +
      aggregated.extra;
    aggregated.fixResults = fixResult;
  }

  sortVerifyResult(aggregated);
  return aggregated;
}

/**
 * Executes filter verification with file-based or multiple source input.
 *
 * Handles three input modes:
 * 1. CLI source entries (from command arguments)
 * 2. File-based input (--file option)
 * 3. Single source argument
 *
 * @param source - Optional single source path
 * @param destination - Destination directory
 * @param options - Verify options including optional file path
 * @returns Aggregated result across all sources
 * @throws Error if file cannot be read or no sources are provided
 */
export async function executeFilterVerifyWithFileInput(
  source: string | undefined,
  destination: string,
  options: VerifyOptions,
): Promise<VerifyCommandResult> {
  // Determine source entries (paths with optional ranges)
  let sourceEntries: PathEntry[];

  if (options.cliSourceEntries && options.cliSourceEntries.length > 0) {
    // Use source entries from CLI arguments
    sourceEntries = options.cliSourceEntries;
    logInfo(`Processing ${sourceEntries.length} source path(s) from CLI`);

    // Log paths for clarity
    for (const entry of sourceEntries) {
      const rangeDesc = entry.range ? ` (range: ${entry.range.start}-${entry.range.end})` : "";
      logInfo(`  ${entry.path}${rangeDesc}`);
    }
    logInfo(""); // Empty line for readability
  } else if (options.file) {
    // Read sources from file
    logInfo(`Reading source paths from: ${options.file}`);
    sourceEntries = await readSourcePaths(options.file);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${options.file}`);
    }

    logInfo(`Found ${sourceEntries.length} source path(s)`);
    logInfo(""); // Empty line for readability
  } else if (source) {
    // Use single source argument
    sourceEntries = [{ path: source }];
  } else {
    throw new Error("Either source argument, --file option, or multiple source paths are required");
  }

  sourceEntries = sourceEntries.map((entry) => ({
    ...entry,
    path: path.resolve(entry.path),
  }));

  // Aggregate results across all sources
  const aggregatedResult = createVerifyResult(options.file ?? source ?? "", options.tier);
  const evidence = loadFilterVerificationEvidence(
    options,
    sourceEntries.map((entry) => entry.path),
  );

  // Setup graceful interruption
  const { getGlobalSignal, registerGlobalCleanup, unregisterGlobalCleanup } =
    await import("../lib/signal-handler.js");
  const localAbortController = new AbortController();
  const globalSignal = getGlobalSignal();

  // Link local controller to global signal
  if (globalSignal) {
    globalSignal.addEventListener("abort", () => {
      localAbortController.abort();
    });
  }

  // Register cleanup handler for abort
  registerGlobalCleanup({
    priority: 10,
    name: "verify-filter-abort",
    cleanup: () => {
      if (!localAbortController.signal.aborted) {
        localAbortController.abort();
      }
    },
  });

  try {
    // Process each source entry
    for (const entry of sourceEntries) {
      const sourcePath = entry.path;
      const artistName = path.basename(sourcePath);

      // Determine effective range for this path
      // Precedence: CLI --range > per-path range > config range
      const effectiveRange =
        options.cliRange ??
        entry.range ??
        options.configRange ??
        (options.mode.type === "filter" ? options.mode.rating.range : undefined);

      // Create options with effective range
      const effectiveOptions: VerifyOptions = {
        ...options,
        mode:
          options.mode.type === "filter"
            ? {
                type: "filter",
                rating: {
                  ...options.mode.rating,
                  range: effectiveRange,
                },
              }
            : options.mode,
      };

      try {
        let result: VerifyCommandResult;

        // Use album mode verification if enabled
        if (effectiveOptions.mode.type === "filter" && effectiveOptions.mode.rating.albumMode) {
          result = await verifyAlbumMode(
            sourcePath,
            destination,
            artistName,
            effectiveOptions.mode.rating,
            effectiveOptions,
            evidence,
            localAbortController.signal,
          );
        } else {
          result = await executeFilterVerifyWithEvidence(
            sourcePath,
            destination,
            effectiveOptions,
            evidence,
            localAbortController.signal,
          );
        }

        mergeVerifyResults(aggregatedResult, result);
      } catch (err) {
        const error = err as Error;
        logError(`Failed to verify ${sourcePath}: ${error.message}`);
        aggregatedResult.failed.push({
          path: sourcePath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
      }

      // Add spacing between sources
      if (sourceEntries.length > 1) {
        logInfo("");
      }
    }
  } finally {
    // Unregister cleanup handler
    unregisterGlobalCleanup("verify-filter-abort");
  }

  // Log summary
  logInfo("");
  logInfo("=== Verification Summary ===");
  logInfo(`✓ Verified: ${aggregatedResult.verified} files`);
  if (aggregatedResult.missing > 0) {
    logWarn(`✗ Missing: ${aggregatedResult.missing} files`);
  }
  if (aggregatedResult.sizeMismatch > 0) {
    logWarn(`⚠ Size mismatches: ${aggregatedResult.sizeMismatch} files`);
  }
  if (aggregatedResult.metadataMismatch > 0) {
    logWarn(`⚠ Metadata mismatches: ${aggregatedResult.metadataMismatch} files`);
  }
  if (aggregatedResult.hashMismatch > 0) {
    logWarn(`⚠ Hash mismatches: ${aggregatedResult.hashMismatch} files`);
  }
  if (aggregatedResult.contentMismatch > 0) {
    logWarn(`⚠ Content mismatches: ${aggregatedResult.contentMismatch} files`);
  }
  if (aggregatedResult.unverifiable > 0) {
    logWarn(`⚠ Unverifiable: ${aggregatedResult.unverifiable} files`);
  }
  if (aggregatedResult.notApplicable > 0) {
    logInfo(`Not applicable: ${aggregatedResult.notApplicable} checks`);
  }
  if (aggregatedResult.unstable > 0) {
    logWarn(`⚠ Unstable during read: ${aggregatedResult.unstable} files`);
  }
  if (aggregatedResult.extra > 0) {
    logWarn(`⚠ Extra files: ${aggregatedResult.extra} files`);
  }
  logInfo(`Expected total: ${aggregatedResult.expectedTotal} files`);

  if (aggregatedResult.failed.length > 0) {
    logError(`Failed: ${aggregatedResult.failed.length} paths`);
  }

  if (!hasUnresolvedVerificationProblems(aggregatedResult)) {
    logSuccess("Status: COMPLETE");
  } else {
    logWarn("Status: INCOMPLETE");
  }

  // Log fix summary if fixes were applied
  if (aggregatedResult.fixResults) {
    logInfo("");
    logInfo("=== Fix Summary ===");
    logInfo(`✓ Files copied: ${aggregatedResult.fixResults.copiedFiles}`);
    logInfo(`✓ Files removed: ${aggregatedResult.fixResults.removedFiles}`);
    if (aggregatedResult.fixResults.failedFixes.length > 0) {
      logError(`✗ Failed fixes: ${aggregatedResult.fixResults.failedFixes.length}`);
    }
  }

  return aggregatedResult;
}
