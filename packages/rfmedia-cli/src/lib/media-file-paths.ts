/**
 * Provider-neutral helpers for extracting local paths from media results.
 *
 * Remote adapters expose media metadata. Local filesystem validation belongs
 * to actions and action helpers so it can be shared by every provider.
 */

import { pathExists } from "./filesystem.js";
import type { MediaTrack } from "../types/media-server.js";

/** The persistence fields required to recover a saved media file path. */
export interface SavedMediaFilePathRow {
  readonly file_path: string | null;
}

/** A live generic track or the narrow projection of a saved result row. */
export type MediaFilePathSource = MediaTrack | SavedMediaFilePathRow;

/** Options for local media path extraction. */
export interface MediaFilePathsOptions {
  /** Partition extracted paths by their current filesystem existence. */
  readonly validateExistence?: boolean;
}

/** Extracted local paths, partitioned when existence validation is enabled. */
export interface MediaFilePathsResult {
  readonly valid: string[];
  readonly missing: string[];
}

function getFilePath(source: MediaFilePathSource): string | null {
  return "filePath" in source ? source.filePath : source.file_path;
}

/**
 * Extracts local file paths from live tracks or saved result rows.
 *
 * Null and empty paths are ignored. Input order and duplicates are preserved.
 * Without existence validation every extracted path is returned as valid.
 */
export async function extractMediaFilePaths(
  sources: readonly MediaFilePathSource[],
  options: MediaFilePathsOptions = {},
): Promise<MediaFilePathsResult> {
  const paths = sources
    .map(getFilePath)
    .filter((filePath): filePath is string => Boolean(filePath));

  if (options.validateExistence !== true) {
    return { valid: paths, missing: [] };
  }

  const valid: string[] = [];
  const missing: string[] = [];

  for (const filePath of paths) {
    if (await pathExists(filePath)) {
      valid.push(filePath);
    } else {
      missing.push(filePath);
    }
  }

  return { valid, missing };
}
