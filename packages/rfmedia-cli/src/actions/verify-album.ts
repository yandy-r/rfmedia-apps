/**
 * Album mode verification logic for rfmedia CLI.
 *
 * Implements range-based album verification with numbered suffixes.
 * Verifies album copies exist and optionally match file sizes.
 */

import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  pathExists,
  normalizePathResolved,
  copyOrLink,
  replaceFileWithValidatedStage,
  remove,
  moveToTrash,
  ensureDir,
  getFileSize,
  createOpenFileVerificationTarget,
} from "../lib/filesystem.js";
import { readSourcePaths } from "../lib/input-file.js";
import { isJsonMode, logDebug, logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { processInParallel } from "../lib/parallel.js";
import { withSpinner } from "../lib/progress.js";
import { formatSuffix } from "../lib/range.js";
import { getExpectedDestFilename, findExtraFiles } from "../lib/verify.js";
import { convertFileWithValidation, shouldConvert } from "../lib/convert.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import {
  resolveConflictInteractive,
  chooseResolutionsByStrategy,
  generateUniquePath,
  shouldReportConflictsAsJson,
  reportConflictsAsJsonAndExit,
} from "../lib/conflict-resolver.js";
import type {
  VerifyOptions,
  CopyRange,
  VerifyCommandResult,
  VerifiedFile,
  PathEntry,
  FixResult,
  ConflictContext,
  ConflictResolutionResult,
  ConflictResolution,
} from "../types/index.js";
import type { DbConnection, DbInventoryFingerprint } from "../types/db.js";
import {
  closeDatabase,
  getInventoryFingerprintCandidates,
  openDatabaseReadOnly,
} from "../lib/db.js";
import { calculateHash } from "../lib/integrity.js";
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

/**
 * Result of verifying a single album copy.
 */
type AlbumVerifyResult = VerifyCommandResult;

interface VerificationEvidenceContext {
  candidates: readonly DbInventoryFingerprint[];
  sourceRoot: string;
}

interface LoadedVerificationEvidence {
  candidates: readonly DbInventoryFingerprint[];
  db?: DbConnection;
}

function loadVerificationEvidence(
  sourceRoots: readonly string[],
  options: VerifyOptions,
): LoadedVerificationEvidence {
  if (options.tier === "quick") {
    return { candidates: [] };
  }
  if (!options.trackingDatabase) {
    throw new Error(`The ${options.tier} verification tier requires a tracking database.`);
  }

  const db = openDatabaseReadOnly(options.trackingDatabase);
  try {
    return {
      db,
      candidates: getInventoryFingerprintCandidates(
        db,
        sourceRoots.map((sourceRoot) => path.resolve(sourceRoot)),
      ),
    };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

/**
 * Helper to create a VerifyOptions with a specific range.
 */
function withRange(options: VerifyOptions, range: CopyRange): VerifyOptions {
  return {
    ...options,
    mode: {
      type: "album",
      range,
    },
  };
}

/**
 * Finds all album subdirectories in an artist folder.
 *
 * @param artistPath - Path to the artist directory
 * @returns Array of album directory paths
 */
async function findAlbums(artistPath: string): Promise<string[]> {
  const scanOperation = async (): Promise<string[]> => {
    const entries = await readdir(artistPath, { withFileTypes: true });

    const albums: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        albums.push(path.join(artistPath, entry.name));
      }
    }

    // Sort albums alphabetically for consistent ordering
    return albums.sort();
  };

  // Use spinner for scanning unless in JSON mode
  if (isJsonMode()) {
    return scanOperation();
  }

  return withSpinner(`Scanning albums in ${path.basename(artistPath)}`, scanOperation);
}

/**
 * Verifies a single album copy against source.
 *
 * Checks:
 * 1. All expected files exist in destination
 * 2. Optionally, file sizes match source
 * 3. Reports extra files in destination
 *
 * @param albumSource - Path to the source album directory
 * @param albumDest - Path to the destination album copy
 * @param options - Verify options including verifySize and convertFormat
 * @returns Verification result with counts and issues
 */
async function verifyAlbumCopy(
  albumSource: string,
  albumDest: string,
  options: VerifyOptions,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
): Promise<AlbumVerifyResult> {
  const { verifySize, convertFormat, tier } = options;
  const result = createVerifyResult(albumSource, tier);

  // Normalize source path (resolves symlinks)
  const normalizedSourceDir = await normalizePathResolved(albumSource);

  logDebug("verifyAlbumCopy:");
  logDebug(`  source: ${normalizedSourceDir}`);
  logDebug(`  dest: ${albumDest}`);
  logDebug(`  verify_size: ${verifySize ?? false}`);
  logDebug(`  convert_format: ${convertFormat ?? "(none)"}`);

  let sourceEntries;
  try {
    sourceEntries = await readdir(normalizedSourceDir, { withFileTypes: true });
  } catch (err) {
    result.failed.push({
      path: albumSource,
      message: `Cannot read source directory: ${(err as Error).message}`,
      code: (err as NodeJS.ErrnoException).code,
    });
    return result;
  }

  const expectedFilenames = new Set<string>();
  const destinationExists = await pathExists(albumDest);

  for (const entry of sourceEntries) {
    if (entry.isDirectory()) {
      continue;
    }

    const sourceFile = path.join(normalizedSourceDir, entry.name);
    const expectedFilename = getExpectedDestFilename(entry.name, convertFormat);
    const destFile = path.join(albumDest, expectedFilename);
    const relativeIssuePath = path.join(path.basename(albumDest), expectedFilename);

    expectedFilenames.add(expectedFilename);

    if (!destinationExists || !(await pathExists(destFile))) {
      addVerifyOutcome(result, {
        path: relativeIssuePath,
        sourcePath: sourceFile,
        status: "missing",
      });
      logDebug(`  Missing: ${expectedFilename}`);
      continue;
    }

    try {
      const converted = Boolean(convertFormat && shouldConvert(entry.name, convertFormat));
      const resolution =
        tier === "quick"
          ? undefined
          : resolveFingerprintCandidate(evidence.candidates, {
              sourcePath: evidence.sourceRoot,
              relativePath: path.relative(evidence.sourceRoot, sourceFile),
              destinationPath: path.resolve(destFile),
              convertKey: convertFormat ?? null,
            });
      const outcome = await verifyFileByTier({
        tier,
        sourcePath: sourceFile,
        destinationPath: destFile,
        converted,
        fingerprint: resolution?.status === "found" ? resolution.fingerprint : undefined,
        fingerprintReason:
          resolution?.status === "ambiguous"
            ? "fingerprint-ambiguous"
            : resolution?.status === "missing"
              ? "fingerprint-missing"
              : undefined,
        verifySize,
        signal,
      });
      applyVerifyFileOutcome(result, relativeIssuePath, outcome, sourceFile);
    } catch (err) {
      result.expectedTotal++;
      addVerifyFailure(result, {
        path: destFile,
        message: (err as Error).message,
        code: (err as NodeJS.ErrnoException).code,
      });
    }
  }

  if (destinationExists) {
    try {
      const extraFiles = await findExtraFiles(expectedFilenames, albumDest);
      for (const extraFile of extraFiles) {
        addExtraFile(result, path.join(path.basename(albumDest), extraFile));
      }
    } catch (err) {
      logDebug(`  Cannot check for extra files: ${(err as Error).message}`);
    }
  }

  sortVerifyResult(result);
  logDebug(
    `  Result (${tier}): ${result.verified} verified, ${result.missing} missing, ${result.sizeMismatch} size, ${result.metadataMismatch} metadata, ${result.hashMismatch} hash, ${result.contentMismatch} content, ${result.unverifiable} unverifiable, ${result.extra} extra`,
  );

  return result;
}

async function repairContentArtifact(
  sourceFile: string,
  destinationFile: string,
  options: VerifyOptions,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
): Promise<void> {
  const converted = Boolean(
    options.convertFormat && shouldConvert(path.basename(sourceFile), options.convertFormat),
  );
  const resolution =
    options.tier === "quick"
      ? undefined
      : resolveFingerprintCandidate(evidence.candidates, {
          sourcePath: evidence.sourceRoot,
          relativePath: path.relative(evidence.sourceRoot, sourceFile),
          destinationPath: path.resolve(destinationFile),
          convertKey: options.convertFormat ?? null,
        });
  const fingerprint = resolution?.status === "found" ? resolution.fingerprint : undefined;
  const fingerprintReason =
    resolution?.status === "ambiguous"
      ? "fingerprint-ambiguous"
      : resolution?.status === "missing"
        ? "fingerprint-missing"
        : undefined;

  if (options.tier !== "quick" && !converted) {
    const expectedHash = fingerprint?.content_hash;
    if (!expectedHash || (await calculateHash(sourceFile, signal)) !== expectedHash) {
      throw new Error(`Repair refused: source does not reproduce the stored baseline.`);
    }
  }

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
      fingerprint,
      fingerprintReason,
      verifySize: options.verifySize,
      signal: stagedSignal,
    } as const;
    const stagedOutcome =
      verificationTarget === undefined
        ? await verifyFileByTier(verificationInput)
        : await verifyFileByTier(verificationInput, verificationTarget.dependencies);
    if (stagedOutcome.status !== "present") {
      throw new Error(`Repair refused: staged artifact failed ${options.tier} verification.`);
    }
  };

  if (converted && options.convertFormat) {
    await convertFileWithValidation(sourceFile, destinationFile, options.convertFormat, {
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
          throw new Error("Repair refused: authoritative staged file handle is unavailable.");
        }
        const verificationTarget = createOpenFileVerificationTarget(stagedHandle);
        await verifyStagedArtifact(verificationTarget.path, stagedSignal, verificationTarget);
      },
    });
  }

  const finalOutcome = await verifyFileByTier({
    tier: options.tier,
    sourcePath: sourceFile,
    destinationPath: destinationFile,
    converted,
    fingerprint,
    fingerprintReason,
    verifySize: options.verifySize,
    signal,
  });
  if (finalOutcome.status !== "present") {
    throw new Error(`Repair failed final ${options.tier} verification.`);
  }
}

/**
 * Fixes issues in a single album copy.
 *
 * Actions performed:
 * - Re-copies missing files from source
 * - Handles size-mismatched files using conflict resolution:
 *   - If conflictStrategy is set, uses resolveConflictsByStrategy()
 *   - If not set and interactive, uses resolveConflictInteractive()
 *   - Falls back to --force behavior for backwards compatibility
 * - Handles extra files using conflict resolution for skip/remove/keep
 *
 * @param albumSource - Path to the source album directory
 * @param albumDest - Path to the destination album copy
 * @param issues - Issues found by verification
 * @param options - Verify options including fix, force, trash, convertFormat, conflictStrategy
 * @param applyToAllMap - Optional map for "Apply to All" state across albums
 * @returns Fix result with counts of fixed/failed operations and conflict resolutions
 */
async function fixAlbumCopy(
  albumSource: string,
  albumDest: string,
  issues: VerifiedFile[],
  options: VerifyOptions,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
  applyToAllMap?: Map<string, ConflictResolution>,
): Promise<FixResult> {
  const { force, trash, conflictStrategy } = options;

  const result: FixResult = {
    copiedFiles: 0,
    removedFiles: 0,
    failedFixes: [],
    repairedFiles: 0,
    reverifiedFiles: 0,
    refusedFiles: 0,
    remainingIssues: issues.length,
    conflictResolutions: [],
  };

  // Normalize source path
  const normalizedSourceDir = await normalizePathResolved(albumSource);

  // Initialize applyToAll map if not provided (for batch operations within this album)
  const applyToAll = applyToAllMap ?? new Map<string, ConflictResolution>();

  // Group issues by type
  const missingFiles = issues.filter((i) => i.status === "missing");
  const extraFiles = issues.filter((i) => i.status === "extra");
  const mismatchFiles = issues.filter((issue) =>
    ["size-mismatch", "metadata-mismatch", "hash-mismatch", "content-mismatch"].includes(
      issue.status,
    ),
  );
  result.refusedFiles += issues.filter((issue) =>
    ["unverifiable", "unstable", "not-applicable"].includes(issue.status),
  ).length;

  // Handle missing files: re-copy from source (no conflict resolution needed)
  if (missingFiles.length > 0) {
    logInfo(`Re-copying ${missingFiles.length} missing files...`);

    for (const issue of missingFiles) {
      const filename = path.basename(issue.path);
      const sourceFilename = issue.sourcePath ? path.basename(issue.sourcePath) : filename;
      const sourceFile = path.join(normalizedSourceDir, sourceFilename);
      const destFile = path.join(albumDest, filename);

      try {
        await repairContentArtifact(sourceFile, destFile, options, evidence, signal);

        result.copiedFiles++;
        result.reverifiedFiles++;
        result.repairedFiles++;
        logSuccess(`  ✓ Copied: ${filename}`);
      } catch (err) {
        if ((err as Error).message.startsWith("Repair refused:")) {
          result.refusedFiles++;
        }
        result.failedFixes.push({
          path: issue.path,
          message: `Failed to copy: ${(err as Error).message}`,
          code: (err as NodeJS.ErrnoException).code,
        });
        logError(`  ✗ Failed: ${filename}`);
      }
    }
  }

  // Handle size mismatches using conflict resolution
  if (mismatchFiles.length > 0) {
    logInfo(`Found ${mismatchFiles.length} repairable mismatches`);

    // Determine the effective strategy
    // --force implies 'overwrite' for backwards compatibility
    const effectiveStrategy = force ? "overwrite" : conflictStrategy;

    // JSON mode check: if no strategy and JSON mode, output conflicts as JSON and exit
    if (shouldReportConflictsAsJson(effectiveStrategy)) {
      const contexts = await buildSizeMismatchContexts(
        mismatchFiles,
        normalizedSourceDir,
        albumDest,
      );
      reportConflictsAsJsonAndExit(contexts, "verify fix");
    }

    if (effectiveStrategy && effectiveStrategy !== "ask") {
      // Use strategy-based resolution (decision-only, no filesystem actions yet)
      const contexts = await buildSizeMismatchContexts(
        mismatchFiles,
        normalizedSourceDir,
        albumDest,
      );

      // Get resolution decisions without performing actions
      const decisions = chooseResolutionsByStrategy(contexts, effectiveStrategy);

      // Track used names for rename operations across all files
      const usedNames = new Map<string, number>();

      // Now perform the actual file operations with conversion support
      for (const decision of decisions) {
        const { context, resolution, newPath } = decision;
        const filename = path.basename(context.destPath);

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
            if (!options.dryRun) {
              await repairContentArtifact(
                context.sourcePath,
                context.destPath,
                options,
                evidence,
                signal,
              );
              result.copiedFiles++;
              result.reverifiedFiles++;
              result.repairedFiles++;
              logSuccess(`  ✓ Re-copied: ${filename}`);
            } else {
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
          if ((err as Error).message.startsWith("Repair refused:")) {
            result.refusedFiles++;
          }
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
      for (const issue of mismatchFiles) {
        const filename = path.basename(issue.path);
        const sourceFilename = issue.sourcePath ? path.basename(issue.sourcePath) : filename;
        const sourceFile = path.join(normalizedSourceDir, sourceFilename);
        const destFile = path.join(albumDest, filename);

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
          const resolutionResult = await applyResolutionForSizeMismatch(
            context,
            resolution,
            options,
            sourceFile,
            destFile,
            evidence,
            signal,
          );

          result.conflictResolutions?.push(resolutionResult);

          if (resolutionResult.success) {
            if (resolution === "overwrite") {
              result.copiedFiles++;
              result.reverifiedFiles++;
              result.repairedFiles++;
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

    // JSON mode check: if no strategy and JSON mode, output conflicts as JSON and exit
    if (shouldReportConflictsAsJson(effectiveStrategy)) {
      const contexts = await buildExtraFileContexts(extraFiles, albumDest);
      reportConflictsAsJsonAndExit(contexts, "verify fix");
    }

    if (effectiveStrategy && effectiveStrategy !== "ask") {
      // Build conflict contexts for extra files
      const contexts = await buildExtraFileContexts(extraFiles, albumDest);

      // For extra files, 'overwrite' strategy means 'remove'
      // 'skip' strategy means 'keep'
      // 'rename' doesn't apply to extra files
      const results: ConflictResolutionResult[] = [];
      for (const context of contexts) {
        let resolution: ConflictResolution;
        if (effectiveStrategy === "overwrite") {
          resolution = "remove";
        } else if (effectiveStrategy === "skip" || effectiveStrategy === "rename") {
          resolution = "keep";
        } else {
          resolution = "keep";
        }

        const resolutionResult = await applyExtraFileResolution(
          context,
          resolution,
          options.dryRun ?? false,
          trash ?? false,
        );
        results.push(resolutionResult);
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
        const destFile = path.join(albumDest, filename);

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

          const resolutionResult = await applyExtraFileResolution(
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
          const filename = path.basename(issue.path);
          const destFile = path.join(albumDest, filename);

          try {
            if (trash) {
              await moveToTrash(destFile);
              logSuccess(`  ✓ Moved to trash: ${filename}`);
            } else {
              await remove(destFile);
              logSuccess(`  ✓ Removed: ${filename}`);
            }

            result.removedFiles++;
          } catch (err) {
            result.failedFixes.push({
              path: issue.path,
              message: `Failed to remove: ${(err as Error).message}`,
              code: (err as NodeJS.ErrnoException).code,
            });
            logError(`  ✗ Failed: ${filename}`);
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
 * Builds ConflictContext array for size-mismatch issues.
 */
async function buildSizeMismatchContexts(
  issues: VerifiedFile[],
  normalizedSourceDir: string,
  albumDest: string,
): Promise<ConflictContext[]> {
  const contexts: ConflictContext[] = [];

  for (const issue of issues) {
    const filename = path.basename(issue.path);
    const sourceFilename = issue.sourcePath ? path.basename(issue.sourcePath) : filename;
    const sourceFile = path.join(normalizedSourceDir, sourceFilename);
    const destFile = path.join(albumDest, filename);

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
 * Builds ConflictContext array for extra file issues.
 */
async function buildExtraFileContexts(
  issues: VerifiedFile[],
  albumDest: string,
): Promise<ConflictContext[]> {
  const contexts: ConflictContext[] = [];

  for (const issue of issues) {
    const filename = path.basename(issue.path);
    const destFile = path.join(albumDest, filename);

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
 * Applies resolution for a size-mismatch conflict.
 */
async function applyResolutionForSizeMismatch(
  context: ConflictContext,
  resolution: ConflictResolution,
  options: VerifyOptions,
  sourceFile: string,
  destFile: string,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
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

      await repairContentArtifact(sourceFile, destFile, options, evidence, signal);
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
 * Applies resolution for an extra file conflict.
 */
async function applyExtraFileResolution(
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
 * Verifies all numbered copies of an album in a range.
 *
 * @param albumSource - Path to the source album directory
 * @param artistDest - Path to the destination artist directory
 * @param range - Range of numbered suffixes to verify
 * @param options - Verify options
 * @returns Aggregated verification result
 */
async function processAlbumVerification(
  albumSource: string,
  artistDest: string,
  range: CopyRange,
  options: VerifyOptions,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
): Promise<AlbumVerifyResult> {
  const { workers } = options;
  const albumName = path.basename(albumSource);

  logInfo(`Verifying: ${albumName}`);

  const aggregated = createVerifyResult(albumSource, options.tier);

  // Build list of destination paths to verify
  const tasks: Array<{ suffix: string; destPath: string }> = [];
  for (let i = range.start; i <= range.end; i++) {
    const suffix = formatSuffix(i, range.padWidth);
    const destAlbumPath = path.join(artistDest, `${albumName}-${suffix}`);
    tasks.push({ suffix, destPath: destAlbumPath });
  }

  // Verify copies in parallel
  const results = await processInParallel(
    tasks,
    async (task, _index, workerSignal) => {
      return verifyAlbumCopy(albumSource, task.destPath, options, evidence, workerSignal);
    },
    {
      workers,
      signal,
      onProgress: (completed, total) => {
        logDebug(`Verification progress: ${completed}/${total}`);
      },
    },
  );

  // Aggregate results
  for (const result of results) {
    if (result.success && result.value) {
      mergeVerifyResults(aggregated, result.value);
    } else {
      const error = result.error ?? new Error("Unknown error");
      const task = tasks[result.index];
      if (task) {
        aggregated.failed.push({
          path: task.destPath,
          message: error.message,
          code: (error as NodeJS.ErrnoException).code,
        });
      }
    }
  }

  const repairCandidates = aggregated.issues.filter((issue) => issue.status !== "not-applicable");

  // Apply fixes if --fix is enabled and repairable or unresolved issues exist
  if (options.fix && repairCandidates.length > 0 && !options.dryRun) {
    logInfo("");
    logInfo("=== Applying Fixes ===");

    // Initialize aggregated fix results
    const aggregatedFixes: FixResult = {
      copiedFiles: 0,
      removedFiles: 0,
      failedFixes: [],
      repairedFiles: 0,
      reverifiedFiles: 0,
      refusedFiles: 0,
      remainingIssues: repairCandidates.length,
      conflictResolutions: [],
    };

    // Shared "Apply to All" map for batch operations across all albums
    const applyToAllMap = new Map<string, ConflictResolution>();

    // Group issues by album destination
    const issuesByAlbum = new Map<string, VerifiedFile[]>();
    for (const issue of repairCandidates) {
      // Extract album destination from issue path
      // issue.path is like "AlbumName-001/filename.flac"
      const albumDir = path.dirname(issue.path);
      const albumDest = path.join(artistDest, albumDir);

      if (!issuesByAlbum.has(albumDest)) {
        issuesByAlbum.set(albumDest, []);
      }
      issuesByAlbum.get(albumDest)!.push(issue);
    }

    // Fix each album, sharing the applyToAllMap across albums
    for (const [albumDest, issues] of issuesByAlbum) {
      logInfo(`Fixing: ${path.basename(albumDest)}`);
      const fixResult = await fixAlbumCopy(
        albumSource,
        albumDest,
        issues,
        options,
        evidence,
        signal,
        applyToAllMap,
      );

      // Aggregate fix results
      aggregatedFixes.copiedFiles += fixResult.copiedFiles;
      aggregatedFixes.removedFiles += fixResult.removedFiles;
      aggregatedFixes.failedFixes.push(...fixResult.failedFixes);
      aggregatedFixes.repairedFiles += fixResult.repairedFiles;
      aggregatedFixes.reverifiedFiles += fixResult.reverifiedFiles;
      aggregatedFixes.refusedFiles += fixResult.refusedFiles;

      // Aggregate conflict resolutions
      if (fixResult.conflictResolutions) {
        aggregatedFixes.conflictResolutions?.push(...fixResult.conflictResolutions);
      }

      // Log fix summary
      if (fixResult.copiedFiles > 0 || fixResult.removedFiles > 0) {
        logSuccess(
          `  Fixed: ${fixResult.copiedFiles} copied, ${fixResult.removedFiles} removed, ${fixResult.failedFixes.length} failed`,
        );
      }
    }

    const rechecked = createVerifyResult(albumSource, options.tier);
    const recheckResults = await processInParallel(
      tasks,
      async (task, _index, workerSignal) =>
        verifyAlbumCopy(albumSource, task.destPath, options, evidence, workerSignal),
      { workers, signal },
    );
    for (const result of recheckResults) {
      if (result.success && result.value) {
        mergeVerifyResults(rechecked, result.value);
      } else {
        const task = tasks[result.index];
        addVerifyFailure(rechecked, {
          path: task?.destPath ?? albumSource,
          message: result.error?.message ?? "Unknown post-repair verification error",
          code: (result.error as NodeJS.ErrnoException | undefined)?.code,
        });
      }
    }

    aggregatedFixes.remainingIssues =
      rechecked.missing +
      rechecked.sizeMismatch +
      rechecked.metadataMismatch +
      rechecked.hashMismatch +
      rechecked.contentMismatch +
      rechecked.unverifiable +
      rechecked.unstable +
      rechecked.extra;
    aggregated.verified = rechecked.verified;
    aggregated.missing = rechecked.missing;
    aggregated.sizeMismatch = rechecked.sizeMismatch;
    aggregated.metadataMismatch = rechecked.metadataMismatch;
    aggregated.hashMismatch = rechecked.hashMismatch;
    aggregated.contentMismatch = rechecked.contentMismatch;
    aggregated.unverifiable = rechecked.unverifiable;
    aggregated.notApplicable = rechecked.notApplicable;
    aggregated.unstable = rechecked.unstable;
    aggregated.extra = rechecked.extra;
    aggregated.expectedTotal = rechecked.expectedTotal;
    aggregated.issues = rechecked.issues;
    aggregated.failed = rechecked.failed;
    aggregated.conflictResolutions = aggregatedFixes.conflictResolutions;
    aggregated.fixResults = aggregatedFixes;
  }

  // Log summary
  if (!hasUnresolvedVerificationProblems(aggregated)) {
    logSuccess(`  Complete: All ${aggregated.verified} files verified`);
  } else {
    if (aggregated.missing > 0) {
      logWarn(`  Missing: ${aggregated.missing} files`);
    }
    if (aggregated.sizeMismatch > 0) {
      logWarn(`  Size mismatches: ${aggregated.sizeMismatch} files`);
    }
    if (aggregated.extra > 0) {
      logWarn(`  Extra files: ${aggregated.extra} files`);
    }
    if (aggregated.failed.length > 0) {
      logWarn(`  Failed: ${aggregated.failed.length} paths`);
    }
  }

  return aggregated;
}

/**
 * Executes album mode verification operation.
 *
 * In artist mode (default): treats source as an artist folder, verifying all
 * album subdirectories in the destination with numbered suffixes.
 *
 * In album-only mode (--album-only): treats source as a single album,
 * extracting artist name from parent directory.
 *
 * @param source - Source path (artist folder or album folder)
 * @param destination - Destination directory where artist folder exists
 * @param options - Verify options with mode, range, albumOnly
 * @param signal - Optional abort signal for cancellation support
 * @returns Result with verified/missing/failed counts
 * @throws Error if source does not exist or mode is not album mode
 */
async function executeAlbumVerifyWithEvidence(
  source: string,
  destination: string,
  options: VerifyOptions,
  evidence: VerificationEvidenceContext,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  // Validate options has album mode
  if (options.mode.type !== "album") {
    throw new Error("executeAlbumVerify requires album mode options");
  }

  const { range } = options.mode;
  const { albumOnly } = options;

  // Validate source directory exists
  if (!(await pathExists(source))) {
    throw new Error(`Source directory does not exist: ${source}`);
  }

  const aggregated = createVerifyResult(source, options.tier);

  if (albumOnly) {
    // Album-only mode: treat source as a single album
    const albumPath = source;
    const albumName = path.basename(albumPath);
    const artistName = path.basename(path.dirname(albumPath));
    const artistDest = path.join(destination, artistName);

    logInfo(`Album: ${albumName} (${artistName})`);
    logInfo(
      `Range: ${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`,
    );

    const result = await processAlbumVerification(
      albumPath,
      artistDest,
      range,
      options,
      evidence,
      signal,
    );

    mergeVerifyResults(aggregated, result);
  } else {
    // Artist mode: process all album subdirectories
    const artistPath = source;
    const artistName = path.basename(artistPath);
    const artistDest = path.join(destination, artistName);

    logInfo(`Artist: ${artistName}`);
    logInfo(
      `Range: ${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`,
    );

    const albums = await findAlbums(artistPath);

    if (albums.length === 0) {
      logWarn("No albums found in source directory");
      return aggregated;
    }

    logInfo(`Found ${albums.length} album(s)`);
    logInfo("");

    // Verify each album
    for (const albumPath of albums) {
      const result = await processAlbumVerification(
        albumPath,
        artistDest,
        range,
        options,
        evidence,
        signal,
      );
      mergeVerifyResults(aggregated, result);
    }
  }

  // Final summary
  logInfo("");
  logInfo("=== Verification Summary ===");
  logInfo(`Tier: ${aggregated.tier}`);
  logInfo(`✓ Verified: ${aggregated.verified} files`);
  if (aggregated.missing > 0) {
    logWarn(`✗ Missing: ${aggregated.missing} files`);
  }
  if (aggregated.sizeMismatch > 0) {
    logWarn(`⚠ Size mismatches: ${aggregated.sizeMismatch} files`);
  }
  if (aggregated.metadataMismatch > 0) {
    logWarn(`⚠ Metadata mismatches: ${aggregated.metadataMismatch} files`);
  }
  if (aggregated.hashMismatch > 0) {
    logWarn(`✗ Hash mismatches: ${aggregated.hashMismatch} files`);
  }
  if (aggregated.contentMismatch > 0) {
    logWarn(`✗ Content mismatches: ${aggregated.contentMismatch} files`);
  }
  if (aggregated.unverifiable > 0) {
    logWarn(`⚠ Unverifiable: ${aggregated.unverifiable} files`);
  }
  if (aggregated.notApplicable > 0) {
    logInfo(`Not applicable: ${aggregated.notApplicable} checks`);
  }
  if (aggregated.unstable > 0) {
    logWarn(`⚠ Unstable: ${aggregated.unstable} files`);
  }
  if (aggregated.extra > 0) {
    logWarn(`⚠ Extra files: ${aggregated.extra} files`);
  }
  logInfo(`Expected total: ${aggregated.expectedTotal} files`);

  if (aggregated.failed.length > 0) {
    logError(`Failed: ${aggregated.failed.length} paths`);
  }

  if (!hasUnresolvedVerificationProblems(aggregated)) {
    logSuccess("Status: COMPLETE");
  } else {
    logWarn("Status: INCOMPLETE");
  }

  // Log fix summary if fixes were applied
  if (aggregated.fixResults) {
    logInfo("");
    logInfo("=== Fix Summary ===");
    logInfo(`✓ Files copied: ${aggregated.fixResults.copiedFiles}`);
    logInfo(`✓ Files removed: ${aggregated.fixResults.removedFiles}`);
    if (aggregated.fixResults.failedFixes.length > 0) {
      logError(`✗ Failed fixes: ${aggregated.fixResults.failedFixes.length}`);
    }
  }

  return aggregated;
}

export async function executeAlbumVerify(
  source: string,
  destination: string,
  options: VerifyOptions,
  signal?: AbortSignal,
): Promise<VerifyCommandResult> {
  const loadedEvidence = loadVerificationEvidence([source], options);
  try {
    return await executeAlbumVerifyWithEvidence(
      source,
      destination,
      options,
      { candidates: loadedEvidence.candidates, sourceRoot: path.resolve(source) },
      signal,
    );
  } finally {
    if (loadedEvidence.db) {
      closeDatabase(loadedEvidence.db);
    }
  }
}

/**
 * Executes album verification with file-based or multiple source input.
 *
 * Handles three input modes:
 * 1. CLI source entries (from command arguments)
 * 2. File-based input (--file option)
 * 3. Single source argument
 *
 * Each source can have its own range (CLI > per-path > config precedence).
 *
 * @param source - Optional single source path
 * @param destination - Destination directory
 * @param options - Verify options including optional file path
 * @returns Aggregated result across all sources
 * @throws Error if file cannot be read or no sources are provided
 */
export async function executeAlbumVerifyWithFileInput(
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

    // Log paths with ranges for clarity
    for (const entry of sourceEntries) {
      if (entry.range) {
        logInfo(`  ${entry.path} (range: ${entry.range.start}-${entry.range.end})`);
      } else {
        logInfo(`  ${entry.path}`);
      }
    }
    logInfo(""); // Empty line for readability
  } else if (options.file) {
    // Read sources from file (returns PathEntry[] with optional ranges)
    logInfo(`Reading source paths from: ${options.file}`);
    sourceEntries = await readSourcePaths(options.file);

    if (sourceEntries.length === 0) {
      throw new Error(`No source paths found in file: ${options.file}`);
    }

    logInfo(`Found ${sourceEntries.length} source path(s)`);
    logInfo(""); // Empty line for readability
  } else if (source) {
    // Use single source argument (no per-path range)
    sourceEntries = [{ path: source }];
  } else {
    throw new Error("Either source argument, --file option, or multiple source paths are required");
  }

  const loadedEvidence = loadVerificationEvidence(
    sourceEntries.map((entry) => entry.path),
    options,
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
    name: "verify-album-abort",
    cleanup: () => {
      if (!localAbortController.signal.aborted) {
        localAbortController.abort();
      }
    },
  });

  // Aggregate results across all sources
  const aggregatedResult = createVerifyResult(options.file ?? source ?? "", options.tier);

  try {
    // Process each source entry
    for (const entry of sourceEntries) {
      const sourcePath = entry.path;

      // Determine effective range for this path:
      // CLI range > per-path range > config range
      const effectiveRange = options.cliRange ?? entry.range ?? options.configRange;

      if (!effectiveRange) {
        // No range specified for this source
        logError(`No range specified for: ${sourcePath}`);
        logError('  Provide --range, per-path range in file, or set "range" in config');
        aggregatedResult.failed.push({
          path: sourcePath,
          message: "No range specified",
        });
        continue;
      }

      // Log which range is being used (for debugging/clarity)
      if (options.cliRange) {
        logDebug(`Using CLI range for ${sourcePath}`);
      } else if (entry.range) {
        logDebug(`Using per-path range for ${sourcePath}: ${entry.range.start}-${entry.range.end}`);
      } else if (options.configRange) {
        logDebug(`Using config default range for ${sourcePath}`);
      }

      // Create options with the effective range for this path
      const pathOptions = withRange(options, effectiveRange);

      try {
        const result = await executeAlbumVerifyWithEvidence(
          sourcePath,
          destination,
          pathOptions,
          { candidates: loadedEvidence.candidates, sourceRoot: path.resolve(sourcePath) },
          localAbortController.signal,
        );

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
    unregisterGlobalCleanup("verify-album-abort");
    if (loadedEvidence.db) {
      closeDatabase(loadedEvidence.db);
    }
  }

  return aggregatedResult;
}
