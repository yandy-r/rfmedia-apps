import { getLoadedPlexConfig } from "../loaded-config.js";
import {
  extractMediaFilePaths,
  type MediaFilePathSource,
  type MediaFilePathsOptions,
  type MediaFilePathsResult,
} from "../media-file-paths.js";
import { createOptionalMediaServerAdapter, requireMediaServerAdapter } from "./index.js";
import type { MediaServerAdapter } from "../../types/media-server.js";
import type { MediaServerAdapterOverrides } from "./index.js";

export interface OptionalScanAdapterResolution {
  adapter: MediaServerAdapter | undefined;
  scanPerSource: boolean;
  libraryName?: string;
}

/**
 * Resolves optional scan adapter state for copy/delete/watch/sync-style actions.
 */
export function resolveOptionalScanAdapter(
  overrides: MediaServerAdapterOverrides,
): OptionalScanAdapterResolution {
  const loadedPlexConfig = getLoadedPlexConfig();
  const scanPerSource = overrides.plexPerSource ?? loadedPlexConfig.scanPerSource ?? false;
  const libraryName = overrides.plexLibrary ?? loadedPlexConfig.libraryName;

  return {
    adapter: createOptionalMediaServerAdapter(overrides),
    scanPerSource,
    libraryName,
  };
}

/**
 * Resolves required adapter state for query/CRUD actions.
 */
export function resolveRequiredMediaServerAdapter(
  overrides: MediaServerAdapterOverrides,
): MediaServerAdapter {
  return requireMediaServerAdapter(overrides);
}

/**
 * Extracts and validates file paths from saved result rows or generic tracks.
 *
 * This keeps local filesystem work outside the media server capability while
 * preserving the existing action-facing function name.
 */
export async function extractTrackFilePaths(
  tracks: readonly MediaFilePathSource[],
  options: MediaFilePathsOptions = {},
): Promise<MediaFilePathsResult> {
  return extractMediaFilePaths(tracks, options);
}
