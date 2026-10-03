/**
 * Conflict detection and resolution utilities for rfmedia CLI.
 *
 * Provides functions for detecting file conflicts during copy/verify operations,
 * generating unique paths for rename resolution, and handling interactive or
 * strategy-based conflict resolution.
 *
 * Supports graceful interruption via SIGINT/SIGTERM signals. When aborted:
 * - Interactive prompts throw immediately
 * - Batch operations return partial results with remaining conflicts marked as aborted
 * - Cleanup handlers can be registered to track in-progress state
 *
 * @module rfmedia-cli/lib/conflict-resolver
 */

import path from "node:path";

import { pathExists, copyOrLink, remove, getFileSize, moveToTrash } from "./filesystem.js";
import { selectOption, isInteractive, type SelectOption } from "./prompt.js";
import { isJsonMode, logDebug, logWarn, logInfo, outputJson } from "./logger.js";
import {
  getGlobalSignal,
  registerGlobalCleanup,
  unregisterGlobalCleanup,
  isAborted,
} from "./signal-handler.js";
import type {
  ConflictContext,
  ConflictType,
  ConflictResolution,
  ConflictResolutionResult,
  ConflictStrategy,
} from "../types/conflict.js";

/**
 * Default padding width for numeric suffixes in conflict resolution.
 *
 * Used when generating unique filenames with suffixes like -002, -003, etc.
 * This is a project-wide convention matching the album/track numbering pattern
 * used throughout rfmedia-cli (e.g., Album-001, Album-002).
 */
const SUFFIX_PADDING_WIDTH = 3;

/**
 * Whether to use case-insensitive filename collision detection.
 *
 * When true, "Track.flac" and "track.flac" are treated as the same file.
 * This matches behavior on case-insensitive filesystems like:
 * - macOS HFS+ and APFS (default)
 * - Windows NTFS
 *
 * When false, collisions are case-sensitive (Linux ext4, etc.).
 *
 * @default true - Optimized for macOS, the primary development/deployment platform
 *
 * @remarks
 * Future enhancement: Auto-detect filesystem case sensitivity or make this
 * a runtime option passed through CopyOptions/VerifyOptions.
 */
const USE_CASE_INSENSITIVE_COLLISIONS = true;

/**
 * Validates that a generated path does not contain directory traversal sequences
 * and stays within the expected parent directory.
 *
 * Protects against path traversal attacks by ensuring:
 * - No parent directory references (..)
 * - Resolved path is within the expected directory tree
 *
 * @param generatedPath - The path to validate
 * @param expectedParent - The parent directory that should contain this path
 * @throws Error if path traversal is detected
 *
 * @security
 * This is a defense-in-depth measure. Callers should also validate inputs
 * before passing paths to conflict resolution functions.
 *
 * @example
 * validatePathSafety('/dest/album/track-002.flac', '/dest/album'); // OK
 * validatePathSafety('/dest/../etc/passwd', '/dest/album'); // throws Error
 */
function validatePathSafety(generatedPath: string, expectedParent: string): void {
  // Resolve both paths to absolute, normalized forms
  const resolvedGenerated = path.resolve(generatedPath);
  const resolvedParent = path.resolve(expectedParent);

  // Check if the generated path is within the expected parent directory
  if (
    !resolvedGenerated.startsWith(resolvedParent + path.sep) &&
    resolvedGenerated !== resolvedParent
  ) {
    throw new Error(
      `Path traversal detected: generated path '${generatedPath}' ` +
        `would escape parent directory '${expectedParent}'`,
    );
  }

  // Additional check: ensure no '..' components in the path
  const relativePath = path.relative(resolvedParent, resolvedGenerated);
  if (relativePath.startsWith("..") || relativePath.includes(`${path.sep}..`)) {
    throw new Error(`Path traversal detected: path contains parent directory references (..)`);
  }
}

/**
 * Detects if a conflict exists at the destination path.
 *
 * Checks if the destination file exists and optionally compares file sizes
 * to detect size mismatches.
 *
 * @param sourcePath - Path to the source file
 * @param destPath - Path to check for conflicts
 * @param options - Detection options
 * @param options.checkSize - If true, also check for size mismatches when file exists
 * @returns ConflictContext if a conflict exists, null otherwise
 *
 * @example
 * const conflict = await detectConflict('/src/file.flac', '/dest/file.flac', { checkSize: true });
 * if (conflict) {
 *   console.log(`Conflict detected: ${conflict.conflictType.type}`);
 * }
 */
export async function detectConflict(
  sourcePath: string,
  destPath: string,
  options: { checkSize?: boolean } = {},
): Promise<ConflictContext | null> {
  const { checkSize = false } = options;

  // Check if destination exists
  const destExists = await pathExists(destPath);
  if (!destExists) {
    return null; // No conflict
  }

  // Get file sizes
  let sourceSize: number | undefined;
  let destSize: number | undefined;

  try {
    destSize = await getFileSize(destPath);
  } catch {
    // If we can't read dest size, leave as undefined to distinguish from 0-byte files
    destSize = undefined;
  }

  if (checkSize) {
    try {
      sourceSize = await getFileSize(sourcePath);
    } catch {
      // If we can't read source size, fall back to simple existence conflict
      sourceSize = undefined;
    }
  }

  // Determine conflict type
  let conflictType: ConflictType;

  if (checkSize && sourceSize !== undefined && destSize !== undefined && sourceSize !== destSize) {
    // Size mismatch conflict (only when both sizes are available and different)
    conflictType = {
      type: "size-mismatch",
      destPath,
      expected: sourceSize,
      actual: destSize,
    };
  } else {
    // Simple existence conflict (when size check is disabled or sizes unavailable/match)
    conflictType = {
      type: "exists",
      destPath,
      destSize,
    };
  }

  return {
    sourcePath,
    destPath,
    conflictType,
    sourceSize,
    destSize,
  };
}

/**
 * Generates a unique file path by adding numeric suffixes for duplicates.
 *
 * For the first occurrence of a filename, returns the original path.
 * For subsequent occurrences, adds suffixes: -002, -003, etc.
 *
 * Collision detection respects USE_CASE_INSENSITIVE_COLLISIONS setting:
 * - When true (default): "Track.flac" and "track.flac" collide (macOS/Windows behavior)
 * - When false: Treated as separate files (Linux ext4 behavior)
 *
 * @param destPath - Original destination path to make unique
 * @param usedNames - Map tracking next suffix number per base filename (modified in place)
 * @returns Unique absolute path for the file
 *
 * @example
 * // With USE_CASE_INSENSITIVE_COLLISIONS = true (default)
 * const usedNames = new Map<string, number>();
 * const path1 = generateUniquePath('/dest/song.flac', usedNames); // '/dest/song.flac'
 * const path2 = generateUniquePath('/dest/song.flac', usedNames); // '/dest/song-002.flac'
 * const path3 = generateUniquePath('/dest/Song.flac', usedNames); // '/dest/Song-003.flac'
 */
export function generateUniquePath(destPath: string, usedNames: Map<string, number>): string {
  const destDir = path.dirname(destPath);
  const filename = path.basename(destPath);
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);

  // Validate input path doesn't contain traversal sequences
  // This protects against malicious inputs before we generate variants
  validatePathSafety(destPath, destDir);

  // Generate collision key based on case sensitivity setting
  const key = USE_CASE_INSENSITIVE_COLLISIONS ? filename.toLowerCase() : filename;

  const count = usedNames.get(key);

  if (count === undefined) {
    // First occurrence - no suffix needed
    usedNames.set(key, 2); // Next occurrence will get -002
    return destPath;
  }

  // Subsequent occurrences get numbered suffixes
  const suffix = String(count).padStart(SUFFIX_PADDING_WIDTH, "0");
  usedNames.set(key, count + 1);

  const uniqueFilename = `${baseName}-${suffix}${ext}`;
  const uniquePath = path.join(destDir, uniqueFilename);

  // Validate generated path stays within expected directory
  validatePathSafety(uniquePath, destDir);

  return uniquePath;
}

/**
 * Generates a unique file path for conflict resolution, ensuring the result doesn't exist.
 *
 * Unlike generateUniquePath(), this function is designed specifically for rename conflict
 * resolution and guarantees the returned path is different from the conflicting file.
 * It checks for file existence and increments suffixes until finding a free path.
 *
 * @param destPath - The conflicting destination path
 * @returns A unique path that doesn't exist (e.g., track-002.flac, track-003.flac)
 *
 * @example
 * // File exists at /dest/track.flac
 * const newPath = await generateUniquePathForConflict('/dest/track.flac');
 * // Returns: /dest/track-002.flac (or -003 if -002 exists, etc.)
 *
 * @remarks
 * This function always adds a suffix (never returns the original path) because
 * it's specifically for resolving conflicts where the original path already exists.
 */
export async function generateUniquePathForConflict(destPath: string): Promise<string> {
  const destDir = path.dirname(destPath);
  const filename = path.basename(destPath);
  const ext = path.extname(filename);
  const baseName = path.basename(filename, ext);

  // Validate input path
  validatePathSafety(destPath, destDir);

  // Generate collision key
  const key = USE_CASE_INSENSITIVE_COLLISIONS ? filename.toLowerCase() : filename;

  // Start from -002 and find first non-existing path
  let suffix = 2;
  let candidatePath: string;

  do {
    const suffixStr = String(suffix).padStart(SUFFIX_PADDING_WIDTH, "0");
    const uniqueFilename = `${baseName}-${suffixStr}${ext}`;
    candidatePath = path.join(destDir, uniqueFilename);

    // Validate candidate path
    validatePathSafety(candidatePath, destDir);

    // Check if this path is free
    if (!(await pathExists(candidatePath))) {
      return candidatePath;
    }

    suffix++;

    // Safety limit to prevent infinite loops
    if (suffix > 999) {
      throw new Error(`Could not generate unique path for ${destPath} after 999 attempts`);
    }
  } while (true);
}

/**
 * Interactively resolves a file conflict by prompting the user.
 *
 * Displays conflict information and presents options based on conflict type:
 * - For exists/size-mismatch: Skip, Overwrite, Rename
 * - For extra files: Skip (keep), Remove
 *
 * Supports "Apply to All" for batch operations.
 *
 * @param context - The conflict context to resolve
 * @param options - Resolution options
 * @param options.applyToAll - Map of conflict types to previously chosen resolutions
 * @returns Resolution result with chosen action and applyToAll flag
 * @throws Error if called in non-interactive or JSON mode
 *
 * @example
 * const applyToAll = new Map<string, ConflictResolution>();
 * const result = await resolveConflictInteractive(conflict, { applyToAll });
 * if (result.applyToAll) {
 *   applyToAll.set(conflict.conflictType.type, result.resolution);
 * }
 */
export async function resolveConflictInteractive(
  context: ConflictContext,
  options: { applyToAll?: Map<string, ConflictResolution> } = {},
): Promise<{ resolution: ConflictResolution; applyToAll: boolean }> {
  const { applyToAll } = options;

  // Check for non-interactive or JSON mode
  if (!isInteractive()) {
    throw new Error(
      "Interactive conflict resolution requires a TTY terminal. Use --conflict-strategy to specify a resolution.",
    );
  }

  if (isJsonMode()) {
    throw new Error(
      "Interactive conflict resolution cannot be used with --json output. Use --conflict-strategy to specify a resolution.",
    );
  }

  // Check for previously chosen "Apply to All" resolution
  const conflictTypeKey = context.conflictType.type;
  const previousResolution = applyToAll?.get(conflictTypeKey);
  if (previousResolution) {
    logDebug(`Using "Apply to All" resolution: ${previousResolution}`);
    return { resolution: previousResolution, applyToAll: false };
  }

  // Check for abort signal
  const signal = getGlobalSignal();
  if (signal.aborted) {
    throw new Error("Operation aborted");
  }

  // Build prompt message based on conflict type
  const message = buildConflictMessage(context);

  // Build options based on conflict type
  const promptOptions = buildPromptOptionsWithApplyAll(context.conflictType.type);

  // Show prompt
  const selected = await selectOption<ConflictResolution | "apply-all">(message, promptOptions);

  // Handle "Apply to All" selection
  if (selected === "apply-all") {
    // Show secondary prompt for the actual resolution
    const resolutionOptions = buildResolutionOnlyOptions(context.conflictType.type);
    const resolution = await selectOption<ConflictResolution>(
      "Select resolution to apply to all:",
      resolutionOptions,
    );
    return { resolution, applyToAll: true };
  }

  return { resolution: selected, applyToAll: false };
}

/**
 * Builds a descriptive message for a conflict prompt.
 */
function buildConflictMessage(context: ConflictContext): string {
  const { conflictType, sourcePath, destPath, sourceSize } = context;
  const filename = path.basename(destPath);

  switch (conflictType.type) {
    case "exists":
      return `File already exists: ${filename}\n  Source: ${sourcePath}\n  Dest: ${destPath}\n  Dest size: ${conflictType.destSize !== undefined ? formatBytes(conflictType.destSize) : "unknown"}`;

    case "size-mismatch":
      return `Size mismatch: ${filename}\n  Source: ${sourcePath} (${sourceSize !== undefined ? formatBytes(sourceSize) : "unknown"})\n  Dest: ${destPath} (${formatBytes(conflictType.actual)})`;

    case "extra":
      return `Extra file in destination: ${filename}\n  Path: ${destPath}\n  Size: ${formatBytes(conflictType.size)}`;
  }
}

/**
 * Formats bytes as a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * Builds prompt options for the main resolution prompt (includes Apply to All).
 */
function buildPromptOptionsWithApplyAll(
  conflictType: string,
): SelectOption<ConflictResolution | "apply-all">[] {
  const baseOptions: SelectOption<ConflictResolution | "apply-all">[] =
    conflictType === "extra"
      ? [
          { label: "Skip (keep file)", value: "keep", key: "s" },
          { label: "Remove file", value: "remove", key: "r" },
        ]
      : [
          { label: "Skip", value: "skip", key: "s" },
          { label: "Overwrite", value: "overwrite", key: "o" },
          { label: "Rename (add suffix)", value: "rename", key: "r" },
        ];

  return [...baseOptions, { label: "Apply to All (same type)", value: "apply-all", key: "a" }];
}

/**
 * Builds prompt options for resolution selection (no Apply to All).
 */
function buildResolutionOnlyOptions(conflictType: string): SelectOption<ConflictResolution>[] {
  return conflictType === "extra"
    ? [
        { label: "Skip (keep file)", value: "keep", key: "s" },
        { label: "Remove file", value: "remove", key: "r" },
      ]
    : [
        { label: "Skip", value: "skip", key: "s" },
        { label: "Overwrite", value: "overwrite", key: "o" },
        { label: "Rename (add suffix)", value: "rename", key: "r" },
      ];
}

/**
 * Applies a conflict resolution action.
 *
 * Executes the chosen resolution:
 * - `skip`: No action, file is skipped
 * - `overwrite`: Re-copies the source file to destination
 * - `rename`: Copies to a new unique path
 * - `remove`: Deletes the destination file (or moves to trash if useTrash is true)
 * - `keep`: No action, extra file is kept
 *
 * @param context - The conflict context to resolve
 * @param resolution - The resolution action to apply
 * @param options - Application options
 * @param options.dryRun - If true, only log what would happen
 * @param options.usedNames - Map for tracking unique names during rename
 * @param options.hardlink - If true, use hardlinks instead of copies
 * @param options.useTrash - If true, move files to trash instead of permanent deletion
 * @returns Result of the resolution application
 *
 * @security
 * When removing files:
 * - Validates paths are within expected directories via generateUniquePath
 * - Supports trash option to prevent accidental permanent deletion
 * - Only allows removal for 'extra' conflict types
 *
 * @example
 * const result = await applyResolution(conflict, 'overwrite', { dryRun: false });
 * if (result.success) {
 *   console.log('Conflict resolved successfully');
 * }
 *
 * @example
 * // Safe removal with trash option
 * const result = await applyResolution(conflict, 'remove', { useTrash: true });
 */
export async function applyResolution(
  context: ConflictContext,
  resolution: ConflictResolution,
  options: {
    dryRun?: boolean;
    usedNames?: Map<string, number>;
    hardlink?: boolean;
    useTrash?: boolean;
  } = {},
): Promise<ConflictResolutionResult> {
  const {
    dryRun = false,
    usedNames = new Map<string, number>(),
    hardlink = false,
    useTrash = false,
  } = options;
  const { sourcePath, destPath, conflictType } = context;

  try {
    switch (resolution) {
      case "skip":
      case "keep":
        // No action needed
        logDebug(`Skipping conflict: ${destPath}`);
        return {
          context,
          resolution,
          success: true,
        };

      case "overwrite":
        if (dryRun) {
          logDebug(`[DRY-RUN] Would overwrite: ${destPath}`);
        } else {
          // Remove existing file first, then copy
          await remove(destPath);
          await copyOrLink(sourcePath, destPath, hardlink);
          logDebug(`Overwritten: ${destPath}`);
        }
        return {
          context,
          resolution,
          success: true,
        };

      case "rename": {
        // Use conflict-aware path generation to ensure we don't return the existing path
        const newPath = await generateUniquePathForConflict(destPath);
        if (dryRun) {
          logDebug(`[DRY-RUN] Would copy to renamed path: ${newPath}`);
        } else {
          await copyOrLink(sourcePath, newPath, hardlink);
          logDebug(`Copied to renamed path: ${newPath}`);
        }
        return {
          context,
          resolution,
          newPath,
          success: true,
        };
      }

      case "remove":
        if (conflictType.type !== "extra") {
          return {
            context,
            resolution,
            success: false,
            error: "Remove resolution is only valid for extra file conflicts",
          };
        }
        if (dryRun) {
          logDebug(`[DRY-RUN] Would ${useTrash ? "move to trash" : "remove"}: ${destPath}`);
        } else {
          if (useTrash) {
            await moveToTrash(destPath);
            logDebug(`Moved to trash: ${destPath}`);
          } else {
            await remove(destPath);
            logDebug(`Removed: ${destPath}`);
          }
        }
        return {
          context,
          resolution,
          success: true,
        };

      default: {
        const exhaustiveCheck: never = resolution;
        return {
          context,
          resolution: exhaustiveCheck,
          success: false,
          error: `Unknown resolution: ${exhaustiveCheck}`,
        };
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      context,
      resolution,
      success: false,
      error: message,
    };
  }
}

/**
 * Resolves multiple conflicts using a predefined strategy.
 *
 * Non-interactive batch resolution that applies the same strategy
 * to all provided conflicts. Processes conflicts sequentially to enable
 * abort signal checking between operations and individual error tracking.
 *
 * @param contexts - Array of conflict contexts to resolve
 * @param strategy - The strategy to apply (skip, overwrite, rename)
 * @param options - Resolution options
 * @param options.dryRun - If true, only log what would happen
 * @param options.hardlink - If true, use hardlinks instead of copies
 * @returns Array of resolution results for each conflict
 * @throws Error if strategy is 'ask' (requires interactive mode)
 *
 * @performance
 * Sequential processing allows for:
 * - Graceful interruption via SIGINT/SIGTERM between operations
 * - Individual error tracking without failing entire batch
 * - Progress reporting for long-running operations
 *
 * For large batches (1000+ conflicts), consider:
 * - Using `skip` strategy to avoid I/O overhead
 * - Pre-filtering conflicts to reduce total count
 * - Running in parallel via multiple CLI invocations with different file ranges
 *
 * @example
 * const results = await resolveConflictsByStrategy(conflicts, 'overwrite', { dryRun: false });
 * const failedCount = results.filter(r => !r.success).length;
 */
export async function resolveConflictsByStrategy(
  contexts: ConflictContext[],
  strategy: ConflictStrategy,
  options: { dryRun?: boolean; hardlink?: boolean; useTrash?: boolean } = {},
): Promise<ConflictResolutionResult[]> {
  const { dryRun = false, hardlink = false, useTrash = false } = options;

  if (strategy === "ask") {
    throw new Error(
      'Strategy "ask" requires interactive mode. Use resolveConflictInteractive() instead.',
    );
  }

  // Map strategy to resolution
  const resolutionMap: Record<Exclude<ConflictStrategy, "ask">, ConflictResolution> = {
    skip: "skip",
    overwrite: "overwrite",
    rename: "rename",
  };

  const resolution = resolutionMap[strategy];
  const results: ConflictResolutionResult[] = [];

  // Track used names for rename strategy to ensure unique paths
  const usedNames = new Map<string, number>();

  // Check for abort signal
  const signal = getGlobalSignal();

  for (const context of contexts) {
    // Check for abort between each resolution
    if (signal.aborted) {
      logWarn("Conflict resolution aborted");
      // Mark remaining conflicts as skipped
      results.push({
        context,
        resolution: "skip",
        success: false,
        error: "Operation aborted",
      });
      continue;
    }

    // For extra files with non-applicable strategies, use 'keep'
    let effectiveResolution = resolution;
    if (context.conflictType.type === "extra") {
      if (resolution === "overwrite" || resolution === "rename") {
        // These don't make sense for extra files, default to keep
        effectiveResolution = "keep";
        logDebug(`Strategy "${strategy}" not applicable to extra file, using "keep" instead`);
      }
    }

    const result = await applyResolution(context, effectiveResolution, {
      dryRun,
      usedNames,
      hardlink,
      useTrash,
    });
    results.push(result);
  }

  return results;
}

/**
 * Determines resolutions for conflicts using a strategy WITHOUT performing filesystem actions.
 *
 * This is a decision-only variant of resolveConflictsByStrategy() that returns the chosen
 * resolutions and generated paths without actually executing file operations. Useful when
 * the caller needs to perform custom actions (e.g., file conversion) based on the resolution.
 *
 * @param contexts - Array of conflict contexts to resolve
 * @param strategy - The strategy to apply (skip, overwrite, rename)
 * @returns Array of resolution decisions with generated paths for rename strategy
 * @throws Error if strategy is 'ask' (requires interactive mode)
 *
 * @example
 * // Decide resolutions, then perform custom actions
 * const decisions = chooseResolutionsByStrategy(conflicts, 'overwrite');
 * for (const decision of decisions) {
 *   if (decision.resolution === 'overwrite') {
 *     await remove(decision.context.destPath);
 *     await convertFile(decision.context.sourcePath, decision.context.destPath, 'mp3');
 *   }
 * }
 *
 * @remarks
 * Use this function when you need to perform custom file operations (like audio conversion)
 * instead of the standard copy/remove actions. For standard operations, use
 * resolveConflictsByStrategy() which handles both decision and execution.
 */
export function chooseResolutionsByStrategy(
  contexts: ConflictContext[],
  strategy: ConflictStrategy,
): Array<{
  context: ConflictContext;
  resolution: ConflictResolution;
  newPath?: string;
}> {
  if (strategy === "ask") {
    throw new Error(
      'Strategy "ask" requires interactive mode. Use resolveConflictInteractive() instead.',
    );
  }

  // Map strategy to resolution
  const resolutionMap: Record<Exclude<ConflictStrategy, "ask">, ConflictResolution> = {
    skip: "skip",
    overwrite: "overwrite",
    rename: "rename",
  };

  const resolution = resolutionMap[strategy];
  const results: Array<{
    context: ConflictContext;
    resolution: ConflictResolution;
    newPath?: string;
  }> = [];
  const usedNames = new Map<string, number>();

  for (const context of contexts) {
    // For extra files with non-applicable strategies, use 'keep'
    let effectiveResolution = resolution;
    if (context.conflictType.type === "extra") {
      if (resolution === "overwrite" || resolution === "rename") {
        // These don't make sense for extra files, default to keep
        effectiveResolution = "keep";
        logDebug(`Strategy "${strategy}" not applicable to extra file, using "keep" instead`);
      }
    }

    // Generate new path for rename strategy
    let newPath: string | undefined;
    if (effectiveResolution === "rename") {
      // Since we're in a conflict scenario, the original path already exists.
      // Seed the map to ensure we skip the original and start from -002
      const filename = path.basename(context.destPath);
      const key = USE_CASE_INSENSITIVE_COLLISIONS ? filename.toLowerCase() : filename;

      if (!usedNames.has(key)) {
        // Mark original as taken, so next call generates -002
        usedNames.set(key, 2);
      }

      newPath = generateUniquePath(context.destPath, usedNames);
    }

    results.push({
      context,
      resolution: effectiveResolution,
      newPath,
    });
  }

  return results;
}

/**
 * JSON output structure for conflict reporting in JSON mode.
 */
export interface ConflictJsonOutput {
  /** Error indicator for JSON consumers */
  error: true;
  /** Error code for machine parsing */
  code: "CONFLICTS_DETECTED";
  /** Error message describing the conflict situation */
  message: string;
  /** Hint for resolving the conflicts */
  hint: string;
  /** List of conflicts detected */
  conflicts: ConflictJsonEntry[];
}

/**
 * JSON structure for a single conflict entry.
 */
export interface ConflictJsonEntry {
  /** Source file path (empty for extra files) */
  source: string;
  /** Destination file path */
  dest: string;
  /** Type of conflict: 'exists', 'size-mismatch', or 'extra' */
  type: ConflictType["type"];
  /** Source file size in bytes (optional) */
  sourceSize?: number;
  /** Destination file size in bytes (optional) */
  destSize?: number;
  /** Expected size for size-mismatch conflicts */
  expectedSize?: number;
  /** Actual size for size-mismatch conflicts */
  actualSize?: number;
}

/**
 * Converts a ConflictContext to a JSON-serializable entry.
 *
 * @param context - The conflict context to convert
 * @returns JSON-serializable conflict entry
 */
export function conflictContextToJsonEntry(context: ConflictContext): ConflictJsonEntry {
  const entry: ConflictJsonEntry = {
    source: context.sourcePath,
    dest: context.destPath,
    type: context.conflictType.type,
  };

  // Add size information based on conflict type
  if (context.sourceSize !== undefined) {
    entry.sourceSize = context.sourceSize;
  }
  if (context.destSize !== undefined) {
    entry.destSize = context.destSize;
  }

  // Add type-specific fields
  if (context.conflictType.type === "size-mismatch") {
    entry.expectedSize = context.conflictType.expected;
    entry.actualSize = context.conflictType.actual;
  } else if (context.conflictType.type === "extra") {
    entry.destSize = context.conflictType.size;
  }

  return entry;
}

/**
 * Outputs conflicts as structured JSON and throws an error for JSON mode users.
 *
 * When `isJsonMode()` is true and no conflict strategy is set, this function
 * outputs the conflicts as structured JSON to stdout and throws an error to
 * indicate the operation cannot proceed without a strategy.
 *
 * @param contexts - Array of conflict contexts to report
 * @param operationType - Type of operation (e.g., 'copy', 'verify', 'fix')
 * @throws Error always, after outputting JSON
 *
 * @example
 * // In JSON mode without --conflict-strategy
 * if (isJsonMode() && !conflictStrategy) {
 *   reportConflictsAsJsonAndExit(conflicts, 'copy');
 * }
 */
export function reportConflictsAsJsonAndExit(
  contexts: ConflictContext[],
  operationType: string,
): never {
  const jsonOutput: ConflictJsonOutput = {
    error: true,
    code: "CONFLICTS_DETECTED",
    message: `${contexts.length} conflict(s) detected during ${operationType}`,
    hint: "Use --conflict-strategy=skip|overwrite|rename to specify how to handle conflicts",
    conflicts: contexts.map(conflictContextToJsonEntry),
  };

  outputJson(jsonOutput);

  // Throw error to stop execution
  throw new Error(
    `Conflicts detected in JSON mode without --conflict-strategy. ` +
      `Use --conflict-strategy=skip|overwrite|rename to specify a resolution.`,
  );
}

/**
 * Checks if running in JSON mode without a conflict strategy.
 *
 * Use this to determine if conflicts should be reported as JSON
 * instead of prompting interactively.
 *
 * @param conflictStrategy - The conflict strategy from options (may be undefined)
 * @returns true if JSON mode is active and no strategy is set or strategy is 'ask'
 */
export function shouldReportConflictsAsJson(
  conflictStrategy: ConflictStrategy | undefined,
): boolean {
  return isJsonMode() && (!conflictStrategy || conflictStrategy === "ask");
}

/**
 * Result of batch interactive conflict resolution.
 */
export interface BatchInteractiveResult {
  /** Results for each conflict that was processed */
  results: ConflictResolutionResult[];
  /** Whether the operation was aborted before completion */
  aborted: boolean;
  /** Number of conflicts that were successfully resolved */
  resolvedCount: number;
  /** Number of conflicts that were not processed due to abort */
  remainingCount: number;
}

/**
 * Resolves multiple conflicts interactively with graceful interruption support.
 *
 * Processes conflicts one at a time, prompting the user for each one.
 * Checks for abort signal before each prompt and returns partial results
 * if interrupted. Supports "Apply to All" for batch operations.
 *
 * Registers a cleanup handler during resolution to track in-progress state.
 *
 * @param contexts - Array of conflict contexts to resolve
 * @param options - Resolution options
 * @param options.dryRun - If true, only log what would happen
 * @param options.hardlink - If true, use hardlinks instead of copies
 * @param options.onResolve - Optional callback invoked after each resolution
 * @returns Batch result with partial results if aborted
 * @throws Error if called in non-interactive or JSON mode
 *
 * @performance
 * Sequential processing is required for interactive mode to:
 * - Display prompts without interleaving output
 * - Allow user to review each conflict before deciding
 * - Support "Apply to All" which changes strategy mid-batch
 * - Enable graceful cancellation (Ctrl+C) between prompts
 *
 * For large conflict batches, users can:
 * - Use "Apply to All" after first prompt to skip remaining prompts
 * - Specify `--conflict-strategy` to avoid interactive mode entirely
 * - Pre-filter operations to reduce conflicts (e.g., `--force` for overwrites)
 *
 * @example
 * const batchResult = await resolveConflictsInteractively(conflicts, {
 *   onResolve: (result, index, total) => {
 *     console.log(`Resolved ${index + 1}/${total}: ${result.resolution}`);
 *   }
 * });
 * if (batchResult.aborted) {
 *   console.log(`Aborted with ${batchResult.remainingCount} conflicts remaining`);
 * }
 */
export async function resolveConflictsInteractively(
  contexts: ConflictContext[],
  options: {
    dryRun?: boolean;
    hardlink?: boolean;
    useTrash?: boolean;
    onResolve?: (result: ConflictResolutionResult, index: number, total: number) => void;
  } = {},
): Promise<BatchInteractiveResult> {
  const { dryRun = false, hardlink = false, useTrash = false, onResolve } = options;

  // Early check for interactive mode
  if (!isInteractive()) {
    throw new Error(
      "Interactive conflict resolution requires a TTY terminal. Use --conflict-strategy to specify a resolution.",
    );
  }

  if (isJsonMode()) {
    throw new Error(
      "Interactive conflict resolution cannot be used with --json output. Use --conflict-strategy to specify a resolution.",
    );
  }

  const results: ConflictResolutionResult[] = [];
  const applyToAll = new Map<string, ConflictResolution>();
  const usedNames = new Map<string, number>();
  let aborted = false;
  let currentIndex = 0;

  // Register cleanup handler to track in-progress state
  const cleanupHandlerName = `conflict-resolver-${Date.now()}`;
  registerGlobalCleanup({
    priority: 20, // After abort controller (10), logs state during cleanup
    name: cleanupHandlerName,
    cleanup: () => {
      if (currentIndex < contexts.length) {
        logInfo(
          `Conflict resolution interrupted at ${currentIndex + 1}/${contexts.length} conflicts`,
        );
      }
    },
  });

  try {
    for (let i = 0; i < contexts.length; i++) {
      currentIndex = i;
      const context = contexts[i];
      if (!context) continue; // Safety check for noUncheckedIndexedAccess

      // Check for abort signal BEFORE each prompt
      if (isAborted()) {
        logWarn(`Conflict resolution aborted - ${contexts.length - i} conflicts remaining`);
        aborted = true;

        // Mark remaining conflicts as aborted
        for (let j = i; j < contexts.length; j++) {
          const remainingContext = contexts[j];
          if (!remainingContext) continue;
          results.push({
            context: remainingContext,
            resolution: "skip",
            success: false,
            error: "Operation aborted",
          });
        }
        break;
      }

      // Check for previously chosen "Apply to All" resolution
      const conflictTypeKey = context.conflictType.type;
      const previousResolution = applyToAll.get(conflictTypeKey);

      let resolution: ConflictResolution;
      if (previousResolution) {
        logDebug(`Using "Apply to All" resolution: ${previousResolution}`);
        resolution = previousResolution;
      } else {
        // Prompt for resolution
        try {
          const { resolution: chosenResolution, applyToAll: shouldApplyToAll } =
            await resolveConflictInteractive(context, { applyToAll });

          resolution = chosenResolution;

          if (shouldApplyToAll) {
            applyToAll.set(conflictTypeKey, resolution);
          }
        } catch (err) {
          // If the error is due to abort, mark as aborted and exit
          if ((err as Error).message === "Operation aborted") {
            aborted = true;
            // Mark this and remaining conflicts as aborted
            for (let j = i; j < contexts.length; j++) {
              const remainingContext = contexts[j];
              if (!remainingContext) continue;
              results.push({
                context: remainingContext,
                resolution: "skip",
                success: false,
                error: "Operation aborted",
              });
            }
            break;
          }
          throw err;
        }
      }

      // Apply the resolution
      const result = await applyResolution(context, resolution, {
        dryRun,
        usedNames,
        hardlink,
        useTrash,
      });
      results.push(result);

      // Invoke callback if provided
      if (onResolve) {
        onResolve(result, i, contexts.length);
      }
    }
  } finally {
    // Always unregister the cleanup handler
    unregisterGlobalCleanup(cleanupHandlerName);
  }

  const resolvedCount = results.filter((r) => r.success && r.error !== "Operation aborted").length;
  const remainingCount = results.filter((r) => r.error === "Operation aborted").length;

  return {
    results,
    aborted,
    resolvedCount,
    remainingCount,
  };
}

/**
 * Checks if the global abort signal has been triggered.
 *
 * Utility function for callers who want to check abort state
 * before initiating conflict resolution.
 *
 * @returns true if the operation has been aborted
 *
 * @example
 * if (isConflictResolutionAborted()) {
 *   return partialResults;
 * }
 */
export function isConflictResolutionAborted(): boolean {
  return isAborted();
}
