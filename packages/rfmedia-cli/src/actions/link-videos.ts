/**
 * Link-videos action implementation for rfmedia CLI.
 *
 * This module implements the core logic for linking music videos to their
 * corresponding audio tracks in a music library. It uses fuzzy string
 * matching to find the best match for each video.
 */

import path from "node:path";
import { link } from "node:fs/promises";

import fg from "fast-glob";

import type {
  LinkVideosOptions,
  LinkVideosResult,
  LinkVideosFailedOperation,
  VideoFile,
  AudioTrack,
  VideoMatch,
  VideoLinkEntry,
  LoadedVideoInventory,
} from "../types/link-videos.js";
import { VIDEO_FORMAT_PRIORITY, type VideoExtension } from "../types/link-videos.js";
import { AUDIO_EXTENSIONS } from "../lib/audio.js";
import { scanVideoFiles } from "../lib/video.js";
import { findBestMatch, artistsMatch } from "../lib/fuzzy-match.js";
import {
  resolveVideoInventoryPath,
  loadVideoInventory,
  initializeVideoInventory,
  resetVideoInventory,
  appendVideoLinkRecord,
  isVideoInInventory,
} from "../lib/video-inventory.js";
import { pathExists, ensureDir, canHardlink } from "../lib/filesystem.js";
import {
  formatDryRun,
  isJsonMode,
  logDebug,
  logError,
  logInfo,
  logSuccess,
  logWarn,
} from "../lib/logger.js";

/**
 * Filename pattern for music library tracks.
 * Format: {Artist}_{Album}_{TrackNum}_{Title}.{ext}
 *
 * Example: "Britney Spears_...Baby One More Time_01_...Baby One More Time.flac"
 */
const TRACK_FILENAME_PATTERN = /^(.+?)_(.+?)_(\d+)_(.+)$/;

/**
 * Extracts track title from a music library filename.
 *
 * @param filename - The filename to parse (without extension)
 * @returns The track title, or null if pattern doesn't match
 *
 * @example
 * extractTrackTitle("Britney Spears_...Baby One More Time_01_...Baby One More Time")
 * // Returns: "...Baby One More Time"
 */
function extractTrackTitle(filename: string): string | null {
  const match = filename.match(TRACK_FILENAME_PATTERN);
  if (!match) {
    return null;
  }
  return match[4] ?? null;
}

/**
 * Extracts metadata from a music library filename.
 *
 * @param filename - The filename to parse (without extension)
 * @returns Object with artist, album, trackNum, and title, or null if pattern doesn't match
 */
function parseTrackFilename(filename: string): {
  artist: string;
  album: string;
  trackNum: string;
  title: string;
} | null {
  const match = filename.match(TRACK_FILENAME_PATTERN);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4]) {
    return null;
  }
  return {
    artist: match[1],
    album: match[2],
    trackNum: match[3],
    title: match[4],
  };
}

/**
 * Scans the music library for audio tracks and extracts metadata.
 *
 * @param musicLibrary - Root directory of the music library
 * @param artistFilter - Optional artist name to filter by
 * @returns Array of AudioTrack objects
 */
async function scanAudioTracks(musicLibrary: string, artistFilter?: string): Promise<AudioTrack[]> {
  // Build glob patterns for all audio extensions
  const patterns = AUDIO_EXTENSIONS.map((ext) => {
    if (artistFilter) {
      return `${artistFilter}*/**/*.${ext}`;
    }
    return `**/*.${ext}`;
  });

  const files = await fg(patterns, {
    cwd: musicLibrary,
    absolute: true,
    caseSensitiveMatch: false,
    onlyFiles: true,
    followSymbolicLinks: true,
  });

  const tracks: AudioTrack[] = [];

  for (const filePath of files) {
    const relativePath = path.relative(musicLibrary, filePath);
    const pathParts = relativePath.split(path.sep);

    // Expected structure: Artist/Album/filename.ext
    if (pathParts.length < 3) {
      logDebug(`Skipping track with unexpected structure: ${relativePath}`);
      continue;
    }

    const artistDir = pathParts[0]!;
    const albumDir = pathParts[1]!;
    const filename = path.basename(filePath);
    const ext = path.extname(filename);
    const basename = filename.slice(0, -ext.length);

    // Parse the structured filename
    const parsed = parseTrackFilename(basename);
    if (!parsed) {
      logDebug(`Skipping track with non-standard filename: ${filename}`);
      continue;
    }

    tracks.push({
      path: filePath,
      relativePath,
      artist: artistDir,
      album: albumDir,
      trackTitle: parsed.title,
      extension: ext.slice(1).toLowerCase(),
    });
  }

  logDebug(`Scanned ${tracks.length} audio tracks from music library`);
  return tracks;
}

/**
 * Groups tracks by artist (using fuzzy matching for artist directories).
 *
 * @param tracks - Array of audio tracks
 * @returns Map of normalized artist name to tracks
 */
function groupTracksByArtist(tracks: AudioTrack[]): Map<string, AudioTrack[]> {
  const grouped = new Map<string, AudioTrack[]>();

  for (const track of tracks) {
    // Use the artist directory name as key
    const artistKey = track.artist.toLowerCase();
    const existing = grouped.get(artistKey) ?? [];
    existing.push(track);
    grouped.set(artistKey, existing);
  }

  return grouped;
}

/**
 * Finds artist tracks that match the video artist (with fuzzy matching).
 *
 * @param videoArtist - Artist name from video directory
 * @param tracksByArtist - Map of artist name to tracks
 * @returns Array of matching tracks
 */
function findMatchingArtistTracks(
  videoArtist: string,
  tracksByArtist: Map<string, AudioTrack[]>,
): AudioTrack[] {
  const matchingTracks: AudioTrack[] = [];

  for (const [artistKey, tracks] of tracksByArtist) {
    // Get the actual artist name from first track
    const firstTrack = tracks[0];
    if (!firstTrack) continue;

    if (artistsMatch(videoArtist, firstTrack.artist)) {
      matchingTracks.push(...tracks);
    }
  }

  return matchingTracks;
}

/**
 * Builds the destination path for a video hardlink.
 * Uses the audio track's base filename with the video's extension.
 *
 * @param track - The matched audio track
 * @param videoExtension - The video file extension
 * @returns Absolute path for the video hardlink
 */
function buildVideoDestPath(track: AudioTrack, videoExtension: VideoExtension): string {
  const trackDir = path.dirname(track.path);
  const trackBasename = path.basename(track.path, path.extname(track.path));
  return path.join(trackDir, `${trackBasename}.${videoExtension}`);
}

/**
 * Selects the preferred video when multiple videos match the same track.
 * Prefers higher quality formats (mkv > mp4 > m4v > webm > avi).
 *
 * @param matches - Array of matches for the same track
 * @param preferredFormat - Preferred format to use
 * @returns The preferred match
 */
function selectPreferredVideo(matches: VideoMatch[], preferredFormat: VideoExtension): VideoMatch {
  if (matches.length === 1) {
    return matches[0]!;
  }

  // Sort by:
  // 1. Preferred format first
  // 2. Format priority (higher = better)
  // 3. Higher match score
  matches.sort((a, b) => {
    // Preferred format takes precedence
    const aIsPreferred = a.video.extension === preferredFormat;
    const bIsPreferred = b.video.extension === preferredFormat;
    if (aIsPreferred && !bIsPreferred) return -1;
    if (bIsPreferred && !aIsPreferred) return 1;

    // Then by format priority
    const aPriority = VIDEO_FORMAT_PRIORITY.indexOf(a.video.extension);
    const bPriority = VIDEO_FORMAT_PRIORITY.indexOf(b.video.extension);
    if (aPriority !== bPriority) return bPriority - aPriority;

    // Then by score
    return b.score - a.score;
  });

  return matches[0]!;
}

/**
 * Matches videos to audio tracks using fuzzy string matching.
 *
 * @param videos - Array of video files
 * @param tracks - Array of audio tracks
 * @param minScore - Minimum similarity score (0-1)
 * @param preferredFormat - Preferred video format for duplicates
 * @returns Array of video matches
 */
function matchVideosToTracks(
  videos: VideoFile[],
  tracks: AudioTrack[],
  minScore: number,
  preferredFormat: VideoExtension,
): VideoMatch[] {
  const tracksByArtist = groupTracksByArtist(tracks);
  const allMatches: VideoMatch[] = [];

  // Map to track matches per track (for deduplication)
  const matchesByTrack = new Map<string, VideoMatch[]>();

  for (const video of videos) {
    // Find tracks from the same artist
    const artistTracks = findMatchingArtistTracks(video.artist, tracksByArtist);

    if (artistTracks.length === 0) {
      logDebug(`No tracks found for artist: ${video.artist}`);
      continue;
    }

    logDebug(
      `Matching video "${video.songTitle}" against ${artistTracks.length} tracks from "${video.artist}"`,
    );

    // Find best matching track
    const result = findBestMatch(
      video.songTitle,
      artistTracks,
      (track) => track.trackTitle,
      minScore,
    );

    if (!result) {
      logDebug(`No match found for: ${video.songTitle} (below threshold ${minScore * 100}%)`);
      continue;
    }

    const destPath = buildVideoDestPath(result.item, video.extension);

    const match: VideoMatch = {
      video,
      matchedTrack: result.item,
      score: result.score,
      destPath,
    };

    // Group by track path for deduplication
    const trackKey = result.item.path;
    const existing = matchesByTrack.get(trackKey) ?? [];
    existing.push(match);
    matchesByTrack.set(trackKey, existing);

    logDebug(
      `Match found: "${video.songTitle}" -> "${result.item.trackTitle}" (${(result.score * 100).toFixed(1)}%)`,
    );
  }

  // Deduplicate: one video per track (prefer higher quality format)
  for (const [, matches] of matchesByTrack) {
    const selected = selectPreferredVideo(matches, preferredFormat);
    allMatches.push(selected);

    if (matches.length > 1) {
      logDebug(
        `Selected ${selected.video.extension} from ${matches.length} candidates for: ${selected.matchedTrack.trackTitle}`,
      );
    }
  }

  return allMatches;
}

/**
 * Creates a hardlink for a video file.
 *
 * @param video - Video file to link
 * @param destPath - Destination path for the hardlink
 * @param dryRun - Whether this is a dry run
 * @returns Success status and any error
 */
async function createVideoHardlink(
  video: VideoFile,
  destPath: string,
  dryRun: boolean,
): Promise<{ success: boolean; error?: LinkVideosFailedOperation }> {
  try {
    // Check if destination already exists
    if (await pathExists(destPath)) {
      logDebug(`Destination already exists, skipping: ${destPath}`);
      return { success: true };
    }

    if (dryRun) {
      logInfo(formatDryRun(`link video: ${video.relativePath} -> ${path.basename(destPath)}`));
      return { success: true };
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destPath);
    await ensureDir(destDir);

    // Check if hardlink is possible (same filesystem)
    const canLink = await canHardlink(video.path, destDir);
    if (!canLink) {
      throw new Error("Cannot hardlink: video and music library are on different filesystems");
    }

    // Create the hardlink
    await link(video.path, destPath);
    logDebug(`Created hardlink: ${video.path} -> ${destPath}`);

    return { success: true };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: {
        videoPath: video.path,
        destPath,
        message: error.message,
        code: (error as NodeJS.ErrnoException).code,
      },
    };
  }
}

/**
 * Executes the link-videos command.
 *
 * Core algorithm:
 * 1. Scan videos: Find all video files in source, extract song titles
 * 2. Scan tracks: Find all audio tracks in library, extract song titles
 * 3. Group by artist: Match videos to tracks from same artist
 * 4. Fuzzy match songs: For each video, find best matching track
 * 5. Filter by score: Only keep matches above threshold
 * 6. Deduplicate: One video per song (prefer higher quality format)
 * 7. Check inventory: Skip already-linked videos
 * 8. Create hardlinks: Link video to track directory
 * 9. Update inventory: Record linked videos
 *
 * @param options - Link videos options
 * @returns Result with counts and any failures
 */
export async function executeLinkVideos(options: LinkVideosOptions): Promise<LinkVideosResult> {
  const {
    videoSource,
    musicLibrary,
    minScore,
    artist,
    preferredFormat,
    resetInventory: shouldReset,
    dryRun,
  } = options;

  const result: LinkVideosResult = {
    videosScanned: 0,
    tracksScanned: 0,
    matchesFound: 0,
    linksCreated: 0,
    skipped: 0,
    noMatch: 0,
    failed: [],
  };

  // Validate paths exist
  if (!(await pathExists(videoSource))) {
    throw new Error(`Video source directory does not exist: ${videoSource}`);
  }
  if (!(await pathExists(musicLibrary))) {
    throw new Error(`Music library directory does not exist: ${musicLibrary}`);
  }

  // Resolve and manage inventory
  const inventoryPath = resolveVideoInventoryPath(videoSource, musicLibrary);
  logDebug(`Video inventory path: ${inventoryPath}`);

  if (shouldReset && !dryRun) {
    logInfo("Resetting video inventory...");
    await resetVideoInventory(inventoryPath);
  }

  // Load or initialize inventory
  let inventory: LoadedVideoInventory;
  if (await pathExists(inventoryPath)) {
    inventory = await loadVideoInventory(inventoryPath);
  } else {
    inventory = new Map();
    if (!dryRun) {
      await initializeVideoInventory(inventoryPath, videoSource, musicLibrary, minScore);
    }
  }

  logInfo(`Loaded inventory with ${inventory.size} existing entries`);

  // Scan video files
  logInfo(`Scanning video source: ${videoSource}${artist ? ` (artist: ${artist})` : ""}...`);
  const videos = await scanVideoFiles(videoSource, artist);
  result.videosScanned = videos.length;
  logInfo(`Found ${videos.length} video files`);

  if (videos.length === 0) {
    logWarn("No video files found");
    return result;
  }

  // Filter out already-processed videos
  const newVideos = videos.filter((v) => !isVideoInInventory(inventory, v.relativePath));
  const alreadyProcessed = videos.length - newVideos.length;
  if (alreadyProcessed > 0) {
    logInfo(`Skipping ${alreadyProcessed} already-processed videos`);
    result.skipped = alreadyProcessed;
  }

  if (newVideos.length === 0) {
    logInfo("No new videos to process");
    return result;
  }

  // Scan audio tracks
  logInfo(`Scanning music library: ${musicLibrary}${artist ? ` (artist: ${artist})` : ""}...`);
  const tracks = await scanAudioTracks(musicLibrary, artist);
  result.tracksScanned = tracks.length;
  logInfo(`Found ${tracks.length} audio tracks`);

  if (tracks.length === 0) {
    logWarn("No audio tracks found");
    result.noMatch = newVideos.length;
    return result;
  }

  // Match videos to tracks
  logInfo(`Matching videos to tracks (min score: ${(minScore * 100).toFixed(0)}%)...`);
  const matches = matchVideosToTracks(newVideos, tracks, minScore, preferredFormat);
  result.matchesFound = matches.length;
  result.noMatch = newVideos.length - matches.length;

  if (!isJsonMode()) {
    logInfo(`Found ${matches.length} matches, ${result.noMatch} videos with no match`);
  }

  if (matches.length === 0) {
    return result;
  }

  // Create hardlinks
  logInfo("");
  logInfo(dryRun ? "[DRY-RUN] Would create the following links:" : "Creating video hardlinks...");

  for (const match of matches) {
    const { video, matchedTrack, score, destPath } = match;

    if (!isJsonMode()) {
      const scorePercent = (score * 100).toFixed(0);
      logInfo(
        `  ${video.artist}/${video.songTitle} -> ${path.basename(destPath)} (${scorePercent}%)`,
      );
    }

    const linkResult = await createVideoHardlink(video, destPath, dryRun);

    if (linkResult.success) {
      result.linksCreated++;

      // Record in inventory (only if not dry run)
      if (!dryRun) {
        const entry: VideoLinkEntry = {
          videoPath: video.relativePath,
          trackPath: matchedTrack.relativePath,
          destPath,
          score,
          linkedAt: Date.now(),
        };
        await appendVideoLinkRecord(inventoryPath, entry);
      }
    } else if (linkResult.error) {
      result.failed.push(linkResult.error);
      logWarn(`Failed: ${linkResult.error.message}`);
    }
  }

  // Log summary
  logInfo("");
  logInfo("=== Link Videos Summary ===");
  logInfo(`Videos scanned: ${result.videosScanned}`);
  logInfo(`Tracks scanned: ${result.tracksScanned}`);
  if (dryRun) {
    logInfo(`[DRY-RUN] Would link: ${result.linksCreated}`);
  } else {
    logSuccess(`Links created: ${result.linksCreated}`);
  }
  logInfo(`Already processed: ${result.skipped}`);
  logInfo(`No match found: ${result.noMatch}`);
  if (result.failed.length > 0) {
    logWarn(`Failed: ${result.failed.length}`);
  }

  return result;
}
