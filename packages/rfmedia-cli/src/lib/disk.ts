/**
 * Disk space checking utilities for rfmedia CLI.
 *
 * Provides pre-copy disk space validation to warn or abort when the
 * destination has insufficient space for the planned copy operation.
 */

import checkDiskSpaceDefault from "check-disk-space";

// The module exports the function as the default export
const checkDiskSpace = checkDiskSpaceDefault.default ?? checkDiskSpaceDefault;
import { logDebug, logWarn } from "./logger.js";
import type { ConvertFormat } from "../types/options.js";

/**
 * Result of a disk space check operation.
 */
export interface DiskSpaceCheckResult {
  /** Whether there is sufficient space for the operation */
  hasSufficientSpace: boolean;
  /** Available bytes on the destination disk */
  availableBytes: number;
  /** Required bytes including safety margin */
  requiredBytes: number;
  /** Deficit bytes if space is insufficient (0 if sufficient) */
  deficitBytes: number;
  /** Path to the disk/mount point being checked */
  diskPath: string;
  /** Human-readable message describing the result */
  message: string;
}

/**
 * Options for disk space checking.
 */
export interface DiskSpaceCheckOptions {
  /** Safety margin as decimal (0-0.5). Default: 0.05 (5%) */
  margin?: number;
  /** If true, throw error on insufficient space. Default: false (warn only) */
  requireSpace?: boolean;
}

/**
 * Error thrown when disk space is insufficient and requireSpace is true.
 */
export class InsufficientSpaceError extends Error {
  /** Available bytes on the destination disk */
  readonly availableBytes: number;
  /** Required bytes including safety margin */
  readonly requiredBytes: number;
  /** Path to the disk/mount point */
  readonly diskPath: string;

  constructor(result: DiskSpaceCheckResult) {
    super(result.message);
    this.name = "InsufficientSpaceError";
    this.availableBytes = result.availableBytes;
    this.requiredBytes = result.requiredBytes;
    this.diskPath = result.diskPath;
  }
}

/**
 * Formats a byte count into a human-readable string.
 *
 * @param bytes - Number of bytes
 * @returns Formatted string with appropriate unit (B, KB, MB, GB, TB)
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * Estimates the size of converted audio files based on format.
 *
 * Lossy formats compress significantly compared to lossless sources.
 * Uses conservative estimates to avoid underestimating space needs.
 *
 * @param sourceBytes - Size of source files in bytes
 * @param convertFormat - Target conversion format (undefined for no conversion)
 * @returns Estimated size in bytes
 */
export function estimateConvertedSize(sourceBytes: number, convertFormat?: ConvertFormat): number {
  if (!convertFormat) return sourceBytes;

  // Compression ratios relative to lossless source
  // These are conservative estimates to avoid underestimating
  const ratios: Record<ConvertFormat, number> = {
    alac: 1.0, // Lossless - same size as FLAC
    mp3: 0.25, // ~320kbps vs FLAC
    aac: 0.2, // ~256kbps
    opus: 0.15, // ~128kbps
  };

  return Math.ceil(sourceBytes * (ratios[convertFormat] ?? 1.0));
}

/**
 * Checks if there is sufficient disk space at the destination.
 *
 * @param destinationPath - Path to the destination directory (or parent if doesn't exist)
 * @param requiredBytes - Number of bytes needed for the operation
 * @param options - Check options including margin and requireSpace
 * @returns DiskSpaceCheckResult with space availability info
 */
export async function checkSufficientSpace(
  destinationPath: string,
  requiredBytes: number,
  options: DiskSpaceCheckOptions = {},
): Promise<DiskSpaceCheckResult> {
  const margin = options.margin ?? 0.05;
  const requiredWithMargin = Math.ceil(requiredBytes * (1 + margin));

  const diskInfo = await checkDiskSpace(destinationPath);
  const hasSufficientSpace = diskInfo.free >= requiredWithMargin;
  const deficitBytes = hasSufficientSpace ? 0 : requiredWithMargin - diskInfo.free;

  const marginPercent = Math.round(margin * 100);
  let message: string;

  if (hasSufficientSpace) {
    message = `Disk space OK: ${formatBytes(diskInfo.free)} available, ${formatBytes(requiredWithMargin)} required on ${diskInfo.diskPath}`;
  } else {
    message = [
      `Insufficient disk space on ${diskInfo.diskPath}`,
      `  Available: ${formatBytes(diskInfo.free)}`,
      `  Required:  ${formatBytes(requiredWithMargin)} (including ${marginPercent}% margin)`,
      `  Deficit:   ${formatBytes(deficitBytes)}`,
    ].join("\n");
  }

  return {
    hasSufficientSpace,
    availableBytes: diskInfo.free,
    requiredBytes: requiredWithMargin,
    deficitBytes,
    diskPath: diskInfo.diskPath,
    message,
  };
}

/**
 * Performs a disk space check and handles the result based on options.
 *
 * @param destinationPath - Path to the destination directory
 * @param requiredBytes - Number of bytes needed for the operation
 * @param options - Check options including margin and requireSpace behavior
 * @returns The DiskSpaceCheckResult
 * @throws InsufficientSpaceError if requireSpace is true and space is insufficient
 */
export async function validateDiskSpace(
  destinationPath: string,
  requiredBytes: number,
  options: DiskSpaceCheckOptions = {},
): Promise<DiskSpaceCheckResult> {
  const spaceCheck = await checkSufficientSpace(destinationPath, requiredBytes, options);

  if (!spaceCheck.hasSufficientSpace) {
    logWarn(spaceCheck.message);
    if (options.requireSpace) {
      throw new InsufficientSpaceError(spaceCheck);
    }
    logWarn("Continuing anyway... (use --require-space to abort)");
  } else {
    logDebug(spaceCheck.message);
  }

  return spaceCheck;
}
