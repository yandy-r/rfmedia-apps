/**
 * Type definitions for the link-videos command.
 *
 * This module defines types for linking music videos to their corresponding
 * audio tracks in a music library, enabling Plex to associate videos with songs.
 */

/**
 * Supported video file extensions.
 */
export const VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "webm", "m4v", "mov"] as const;

/**
 * Type representing a valid video file extension.
 */
export type VideoExtension = (typeof VIDEO_EXTENSIONS)[number];

/**
 * Priority order for video formats when duplicates exist.
 * Higher index = higher priority.
 */
export const VIDEO_FORMAT_PRIORITY: VideoExtension[] = ["avi", "webm", "m4v", "mp4", "mov", "mkv"];

/**
 * Options for the link-videos command.
 */
export interface LinkVideosOptions {
  /** Path to the music videos source directory */
  videoSource: string;
  /** Path to the music library directory */
  musicLibrary: string;
  /** Minimum similarity score (0-100) for matching */
  minScore: number;
  /** Limit to a specific artist (optional) */
  artist?: string;
  /** Preferred video format when duplicates exist */
  preferredFormat: VideoExtension;
  /** Clear inventory and rescan all videos */
  resetInventory: boolean;
  /** Show progress bar */
  progress?: boolean;
  /** Dry-run mode (preview without making changes) */
  dryRun: boolean;
  /** Debug mode for verbose output */
  debug?: boolean;
}

/**
 * Represents a video file with extracted metadata.
 */
export interface VideoFile {
  /** Absolute path to the video file */
  path: string;
  /** Relative path from video source root */
  relativePath: string;
  /** Artist name (from parent directory) */
  artist: string;
  /** Extracted song title (without suffixes like "Official HD Video") */
  songTitle: string;
  /** File extension without leading dot */
  extension: VideoExtension;
}

/**
 * Represents an audio track with extracted metadata.
 */
export interface AudioTrack {
  /** Absolute path to the audio file */
  path: string;
  /** Relative path from music library root */
  relativePath: string;
  /** Artist name (extracted from filename or directory) */
  artist: string;
  /** Album name */
  album: string;
  /** Track title (extracted from filename) */
  trackTitle: string;
  /** File extension without leading dot */
  extension: string;
}

/**
 * Represents a match between a video and an audio track.
 */
export interface VideoMatch {
  /** The video file */
  video: VideoFile;
  /** The matched audio track */
  matchedTrack: AudioTrack;
  /** Similarity score (0-1) */
  score: number;
  /** Destination path for the hardlink */
  destPath: string;
}

/**
 * Entry in the video link inventory (JSONL format).
 */
export interface VideoLinkEntry {
  /** Relative path to the video file from video source */
  videoPath: string;
  /** Relative path to the matched audio track from music library */
  trackPath: string;
  /** Destination path where the hardlink was created */
  destPath: string;
  /** Match similarity score */
  score: number;
  /** Timestamp when the link was created */
  linkedAt: number;
}

/**
 * Header record for the video inventory file.
 */
export interface VideoInventoryHeader {
  /** Marks this as a header record */
  _header: true;
  /** Video source directory */
  videoSource: string;
  /** Music library directory */
  musicLibrary: string;
  /** Minimum score used for matching */
  minScore: number;
  /** Timestamp when the inventory was created */
  createdAt: string;
}

/**
 * Loaded video inventory as a map of video paths to entries.
 */
export type LoadedVideoInventory = Map<string, VideoLinkEntry>;

/**
 * Result of the link-videos command.
 */
export interface LinkVideosResult {
  /** Number of videos scanned */
  videosScanned: number;
  /** Number of audio tracks scanned */
  tracksScanned: number;
  /** Number of successful matches */
  matchesFound: number;
  /** Number of hardlinks created */
  linksCreated: number;
  /** Number of videos skipped (already in inventory) */
  skipped: number;
  /** Number of videos with no match found */
  noMatch: number;
  /** Failed operations */
  failed: LinkVideosFailedOperation[];
}

/**
 * Failed operation during link-videos execution.
 */
export interface LinkVideosFailedOperation {
  /** Video path that failed */
  videoPath: string;
  /** Destination path (if applicable) */
  destPath?: string;
  /** Error message */
  message: string;
  /** Error code (if applicable) */
  code?: string;
}
