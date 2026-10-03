/**
 * Interactive selection UI for rfmedia copy command.
 *
 * Provides a multi-step selection flow using ink + @inkjs/ui:
 * 1. Select which sources to process
 * 2. For each source, optionally refine album/track selection
 *
 * @module rfmedia-cli/lib/interactive
 */

import path from "node:path";
import React from "react";
import { render } from "ink";
import { confirm, confirmWithDefault } from "@rfmedia/common";

import { findAudioFiles } from "./audio.js";
import { readRating } from "./ratings.js";
import { extractPathInfo, detectLibraryRoot } from "./path-info.js";
import { isInteractive } from "./prompt.js";
import { isJsonMode, logDebug, logWarn, output } from "./logger.js";
import { mapInParallel } from "./parallel.js";
import {
  SourceSelector,
  AlbumSelector,
  TrackSelector,
  STDIN_CLEANUP_DELAY_MS,
} from "./interactive/index.js";
import type { PathEntry, CopySelection, SourceSelection, SelectionLevel } from "../types/index.js";
import type { InteractiveConfig } from "../types/config.js";
import type {
  SourceDisplayInfo,
  AlbumDisplayInfo,
  TrackDisplayInfo,
} from "../types/interactive.js";

/**
 * Album metadata for display in interactive selector.
 */
interface AlbumInfo {
  name: string;
  trackCount: number;
  totalBytes: number;
  ratedCount: number;
  avgStars: number | null; // null if no rated tracks
}

/**
 * Track metadata for display in interactive selector.
 */
interface TrackInfo {
  relativePath: string;
  filename: string;
  albumName: string;
  rating: number | null; // 0.0-1.0 normalized, null if unrated
  stars: number | null; // 1-5 scale for display
}

/**
 * Display formatted numbered list of selected items.
 */
function displaySelectionSummary<T>(
  label: string,
  items: ReadonlyArray<T>,
  formatter: (item: T, index: number) => string = (item) => String(item),
): void {
  if (items.length === 0) return;

  output(""); // Empty line before
  output(`${label}:`);
  items.forEach((item, index) => {
    output(`  ${index + 1}. ${formatter(item, index)}`);
  });
  output(""); // Empty line after for spacing
}

/**
 * Guards for interactive mode availability.
 */
export function requireInteractiveMode(): void {
  if (!isInteractive()) {
    throw new Error(
      "Interactive mode requires a TTY terminal. Cannot use --interactive in piped input, CI, or non-interactive environments.",
    );
  }
  if (isJsonMode()) {
    throw new Error(
      "Interactive mode cannot be used with --json output. Remove --json or --interactive.",
    );
  }
}

/**
 * Perform stdin cleanup after ink component exits.
 *
 * After Ink exits raw mode, any buffered input (like the Enter keypress that
 * confirmed selection) needs time to be discarded before subsequent readline
 * prompts can safely use stdin. This is critical to prevent the "confirmation
 * prompt closing early" bug.
 */
async function cleanupStdin(): Promise<void> {
  try {
    if (process.stdin.isTTY) {
      // Exit raw mode first
      process.stdin.setRawMode(false);

      // Force buffer clear by temporarily entering flowing mode
      // This drains any pending input (like the Enter keypress)
      const discardHandler = (): void => {
        // Intentionally discard any data
      };
      process.stdin.on("data", discardHandler);
      process.stdin.resume();

      // Wait for any buffered data to flow through and be discarded
      await new Promise((resolve) => setTimeout(resolve, STDIN_CLEANUP_DELAY_MS));

      // Clean up and pause stdin for readline to take over
      process.stdin.removeListener("data", discardHandler);
      process.stdin.pause();
    }
  } catch (stdinError) {
    // Stdin cleanup failed, but we can still return results
    // This can happen in edge cases with terminal state
    logDebug(
      `Stdin cleanup warning: ${stdinError instanceof Error ? stdinError.message : String(stdinError)}`,
    );
  }
}

/**
 * Render an ink selector component and wait for result.
 *
 * This function handles the render lifecycle including stdin cleanup
 * to prevent buffered input from interfering with subsequent prompts.
 *
 * @param element - React element to render
 * @returns Promise resolving to selected values or null if cancelled
 */
async function renderSelector<T>(
  element: React.ReactElement,
  resultRef: { current: T | null },
): Promise<T | null> {
  const { unmount, waitUntilExit } = render(element);

  await waitUntilExit();
  unmount();

  // Critical stdin cleanup to prevent buffered Enter from closing next prompt
  await cleanupStdin();

  return resultRef.current;
}

/**
 * Prepare sources for display in the interactive selector.
 *
 * Transforms PathEntry array into SourceDisplayInfo array with
 * formatted labels including album and track counts.
 */
function prepareSourcesForDisplay(sourceEntries: readonly PathEntry[]): SourceDisplayInfo[] {
  return sourceEntries.map((entry) => {
    const artistName = path.basename(entry.path);
    // We don't have counts at this stage without scanning
    // Label will just show the artist name
    return {
      path: entry.path,
      label: artistName,
      albumCount: 0, // Unknown at selection time
      trackCount: 0, // Unknown at selection time
    };
  });
}

/**
 * Prepare albums for display in the interactive selector.
 *
 * Transforms AlbumInfo array into AlbumDisplayInfo array with
 * formatted labels including track count and rating.
 */
function prepareAlbumsForDisplay(
  albums: readonly AlbumInfo[],
  sourcePath: string,
): AlbumDisplayInfo[] {
  const artistName = path.basename(sourcePath);
  return albums.map((album) => ({
    path: path.join(sourcePath, album.name),
    label: formatAlbumLabel(album),
    albumName: album.name,
    artistName,
    rating: album.avgStars !== null ? album.avgStars / 5 : undefined,
    trackCount: album.trackCount,
  }));
}

/**
 * Format album label for display.
 */
function formatAlbumLabel(album: AlbumInfo): string {
  const ratingStr = album.avgStars !== null ? `[${album.avgStars.toFixed(1)}★]` : "";
  const trackText =
    album.trackCount === 1 ? `${album.trackCount} track` : `${album.trackCount} tracks`;
  const ratedText = album.ratedCount > 0 ? `, ${album.ratedCount} rated` : "";

  if (ratingStr) {
    return `${album.name} ${ratingStr} (${trackText}${ratedText})`;
  }
  return `${album.name} (${trackText}${ratedText})`;
}

/**
 * Prepare tracks for display in the interactive selector.
 *
 * Transforms TrackInfo array grouped by album into TrackDisplayInfo array.
 */
function prepareTracksForDisplay(
  albumsMap: Map<string, TrackInfo[]>,
  sourcePath: string,
): TrackDisplayInfo[] {
  const artistName = path.basename(sourcePath);
  const tracks: TrackDisplayInfo[] = [];

  for (const [albumName, albumTracks] of albumsMap) {
    for (const track of albumTracks) {
      tracks.push({
        path: path.join(sourcePath, track.relativePath),
        label: formatTrackLabel(track),
        trackName: track.filename,
        albumName,
        artistName,
        trackNumber: undefined, // Could extract from metadata if needed
      });
    }
  }

  return tracks;
}

/**
 * Format track label for display.
 */
function formatTrackLabel(track: TrackInfo): string {
  const ratingStr = track.stars !== null ? ` [${track.stars}★]` : "";
  return `${track.filename}${ratingStr}`;
}

/**
 * Main entry: run interactive selection flow.
 * Returns null if the user cancels the selection.
 *
 * @param sourceEntries - Source paths to select from
 * @param config - Interactive configuration with page sizes
 * @param signal - Optional abort signal for cancellation
 */
export async function runInteractiveSelection(
  sourceEntries: readonly PathEntry[],
  config: InteractiveConfig,
  allowTrackSelection: boolean,
  signal?: AbortSignal,
): Promise<CopySelection | null> {
  requireInteractiveMode();

  // Step 1: Select sources
  const selectedSources = await selectSources(sourceEntries, config.artistPageSize);
  if (selectedSources === null) {
    return null;
  }

  // Step 2: Per-source refinement
  const sourceSelections = new Map<string, SourceSelection>();

  for (const sourcePath of selectedSources) {
    // Check for cancellation
    if (signal?.aborted) {
      return null;
    }

    const wantRefine = await confirm(`Refine selection for ${path.basename(sourcePath)}?`);

    if (!wantRefine) {
      // If not refined, source is not in map = use all albums/tracks
      continue;
    }

    // Pass config and allowTrackSelection to refineSource
    const selection = await refineSource(sourcePath, config, allowTrackSelection, signal);
    if (selection === null) {
      return null;
    }
    sourceSelections.set(sourcePath, selection);
  }

  return { selectedSources, sourceSelections };
}

/**
 * Step 1: Multi-select from available sources.
 * Returns null if user cancels.
 */
async function selectSources(
  sourceEntries: readonly PathEntry[],
  pageSize: number,
): Promise<readonly string[] | null> {
  if (sourceEntries.length === 1) {
    // Single source: skip selection, use it
    const firstEntry = sourceEntries[0];
    if (!firstEntry) {
      throw new Error("No source entries provided");
    }
    return [firstEntry.path];
  }

  const sources = prepareSourcesForDisplay(sourceEntries);

  // Retry loop for empty selection
  while (true) {
    // Result ref to capture selection
    const resultRef: { current: readonly string[] | null } = { current: null };

    const element = React.createElement(SourceSelector, {
      sources,
      pageSize,
      onSelect: (selected: readonly string[]) => {
        resultRef.current = selected;
      },
      onCancel: () => {
        resultRef.current = null;
      },
    });

    const selected = await renderSelector(element, resultRef);

    // User cancelled with Escape
    if (selected === null) {
      return null;
    }

    // User selected items - proceed
    if (selected.length > 0) {
      displaySelectionSummary("Selected sources", selected, (sourcePath) =>
        path.basename(sourcePath),
      );
      return selected;
    }

    // Empty selection - show friendly message and retry
    logWarn("\nNo items selected. Use Space to toggle items, then Enter to confirm.\n");
  }
}

/**
 * Step 2: Refine a single source (album or track selection).
 * Returns null if user cancels.
 */
async function refineSource(
  sourcePath: string,
  config: InteractiveConfig,
  allowTrackSelection: boolean,
  signal?: AbortSignal,
): Promise<SourceSelection | null> {
  // Scan source for albums/tracks
  const audioFiles = await findAudioFiles(sourcePath);
  if (audioFiles.length === 0) {
    throw new Error(`No audio files found in: ${sourcePath}`);
  }

  const artistName = path.basename(sourcePath);
  const isLibraryRoot = detectLibraryRoot(sourcePath, audioFiles);

  // Parallel rating read with concurrency limit
  const RATING_WORKERS = 4; // Conservative limit to avoid filesystem pressure

  // Build track info with parallel rating reads
  let trackInfos: TrackInfo[];
  try {
    trackInfos = await mapInParallel(
      audioFiles,
      async (filePath, _index, abortSignal) => {
        // Check for cancellation
        if (signal?.aborted || abortSignal?.aborted) {
          throw new Error("Cancelled");
        }

        const { albumName } = extractPathInfo(filePath, sourcePath, artistName, isLibraryRoot);
        const relativePath = path.relative(sourcePath, filePath);
        const filename = path.basename(filePath);

        let rating: number | null = null;
        let stars: number | null = null;
        try {
          const r = await readRating(filePath);
          if (r) {
            rating = r.value;
            stars = Math.round(r.value * 5 * 2) / 2; // Half-star precision
          }
        } catch {
          /* ignore rating errors */
        }

        return { relativePath, filename, albumName, rating, stars };
      },
      RATING_WORKERS,
      signal,
    );
  } catch (error) {
    // User cancelled during metadata loading
    if (signal?.aborted) {
      return null;
    }
    throw error;
  }

  // Group tracks by album
  const albumsMap = new Map<string, TrackInfo[]>();
  for (const track of trackInfos) {
    const albumTracks = albumsMap.get(track.albumName);
    if (albumTracks) {
      albumTracks.push(track);
    } else {
      albumsMap.set(track.albumName, [track]);
    }
  }

  // Build album info for display
  const albums: AlbumInfo[] = [];
  for (const [name, tracks] of albumsMap) {
    const ratedTracks = tracks.filter((t) => t.rating !== null);
    const avgStars =
      ratedTracks.length > 0
        ? ratedTracks.reduce((sum, t) => sum + (t.stars ?? 0), 0) / ratedTracks.length
        : null;

    albums.push({
      name,
      trackCount: tracks.length,
      totalBytes: 0, // Could scan but expensive; omit for speed
      ratedCount: ratedTracks.length,
      avgStars,
    });
  }
  albums.sort((a, b) => a.name.localeCompare(b.name));

  // Determine selection level
  let level: SelectionLevel;

  if (!allowTrackSelection) {
    // Album mode: track selections are ignored, always use album-level
    level = "album";
    logDebug("Track-level selection disabled (album mode) - using album-level only");
  } else {
    // Filter mode: ask user to choose level
    // confirmWithDefault() defaults to Yes (album-level)
    // Enter/Y = album-level (true), N = track-level (false)
    const useAlbumLevel = await confirmWithDefault(
      "Use album-level selection? (No = track-level, select individual tracks)",
    );
    level = useAlbumLevel ? "album" : "track";
  }

  if (level === "album") {
    return selectAlbums(sourcePath, albums, config.albumPageSize);
  } else {
    return selectTracks(sourcePath, albumsMap, config.trackPageSize);
  }
}

/**
 * Album-level selection.
 * Returns null if user cancels.
 */
async function selectAlbums(
  sourcePath: string,
  albums: AlbumInfo[],
  pageSize: number,
): Promise<SourceSelection | null> {
  const albumDisplayInfos = prepareAlbumsForDisplay(albums, sourcePath);

  // Retry loop for empty selection
  while (true) {
    // Result ref to capture selection
    const resultRef: { current: readonly string[] | null } = { current: null };

    const element = React.createElement(AlbumSelector, {
      albums: albumDisplayInfos,
      sourcePath,
      pageSize,
      onSelect: (selected: readonly string[]) => {
        resultRef.current = selected;
      },
      onCancel: () => {
        resultRef.current = null;
      },
    });

    const selectedPaths = await renderSelector(element, resultRef);

    // User cancelled with Escape
    if (selectedPaths === null) {
      return null;
    }

    // User selected items - proceed
    if (selectedPaths.length > 0) {
      // Convert paths back to album names
      const selectedAlbums = selectedPaths.map((p) => path.basename(p));

      displaySelectionSummary("Selected albums", selectedAlbums);

      logDebug(`Selected ${selectedAlbums.length} of ${albums.length} albums`);

      return {
        sourcePath,
        level: "album",
        selectedAlbums,
      };
    }

    // Empty selection - show friendly message and retry
    logWarn("\nNo items selected. Use Space to toggle items, then Enter to confirm.\n");
  }
}

/**
 * Track-level selection.
 * Returns null if user cancels.
 */
async function selectTracks(
  sourcePath: string,
  albumsMap: Map<string, TrackInfo[]>,
  pageSize: number,
): Promise<SourceSelection | null> {
  const trackDisplayInfos = prepareTracksForDisplay(albumsMap, sourcePath);
  let totalTracks = 0;
  for (const tracks of albumsMap.values()) {
    totalTracks += tracks.length;
  }

  // Retry loop for empty selection
  while (true) {
    // Result ref to capture selection
    const resultRef: { current: readonly string[] | null } = { current: null };

    const element = React.createElement(TrackSelector, {
      tracks: trackDisplayInfos,
      sourcePath,
      pageSize,
      onSelect: (selected: readonly string[]) => {
        resultRef.current = selected;
      },
      onCancel: () => {
        resultRef.current = null;
      },
    });

    const selectedPaths = await renderSelector(element, resultRef);

    // User cancelled with Escape
    if (selectedPaths === null) {
      return null;
    }

    // User selected items - proceed
    if (selectedPaths.length > 0) {
      // Convert paths back to relative paths
      const selectedTracks = selectedPaths.map((p) => path.relative(sourcePath, p));

      displaySelectionSummary("Selected tracks", selectedTracks, (relativePath) =>
        path.basename(relativePath),
      );

      logDebug(`Selected ${selectedTracks.length} tracks`);

      return {
        sourcePath,
        level: "track",
        selectedTracks,
      };
    }

    // Empty selection - show friendly message and retry
    logWarn("\nNo items selected. Use Space to toggle items, then Enter to confirm.\n");
  }
}

/**
 * Apply interactive selection filter to audio files.
 *
 * Filters audio files based on user's interactive selection (album or track level).
 * Used in copy-filter action to apply selections made through runInteractiveSelection.
 *
 * @param audioFiles - List of all audio file paths to filter
 * @param source - Source directory path
 * @param selection - Interactive selection data (may be undefined if no selection made)
 * @param fallbackArtistName - Artist name to use for non-library-root sources
 * @param isLibraryRoot - Whether source is a library root containing multiple artists
 * @returns Filtered list of audio file paths
 */
export function applyInteractiveSelectionFilter(
  audioFiles: string[],
  source: string,
  selection: CopySelection | undefined,
  fallbackArtistName: string,
  isLibraryRoot: boolean,
): string[] {
  if (!selection) return audioFiles;

  const sourceSelection = selection.sourceSelections.get(source);
  if (!sourceSelection) return audioFiles;

  if (sourceSelection.level === "album" && sourceSelection.selectedAlbums) {
    // Filter to tracks in selected albums
    const selectedAlbums = new Set(sourceSelection.selectedAlbums);
    return audioFiles.filter((filePath) => {
      const { albumName } = extractPathInfo(filePath, source, fallbackArtistName, isLibraryRoot);
      return selectedAlbums.has(albumName);
    });
  }

  if (sourceSelection.level === "track" && sourceSelection.selectedTracks) {
    // Filter to selected track paths only
    const selectedTracks = new Set(sourceSelection.selectedTracks);
    return audioFiles.filter((filePath) => {
      const relativePath = path.relative(source, filePath);
      return selectedTracks.has(relativePath);
    });
  }

  return audioFiles;
}
