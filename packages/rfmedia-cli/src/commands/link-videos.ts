/**
 * Link-videos command definition for rfmedia CLI.
 *
 * This command creates hardlinks from music videos to their corresponding
 * audio tracks in a music library, enabling Plex to associate videos with songs.
 */

import { Command, Option } from "commander";

import { logDebug, logError } from "../lib/logger.js";
import { isMachineFormat } from "@rfmedia/common";
import { getLoadedConfig } from "../cli.js";
import type { LinkVideosOptions, LinkVideosResult, VideoExtension } from "../types/index.js";
import { VIDEO_EXTENSIONS } from "../types/index.js";

/**
 * JSON output structure for link-videos command.
 */
interface LinkVideosJsonOutput {
  command: "link-videos";
  videoSource: string;
  musicLibrary: string;
  result: {
    videosScanned: number;
    tracksScanned: number;
    matchesFound: number;
    linksCreated: number;
    skipped: number;
    noMatch: number;
    failedCount: number;
    failed: Array<{ videoPath: string; destPath?: string; message: string; code?: string }>;
  };
}

/**
 * Default minimum similarity score (0-100 scale).
 */
const DEFAULT_MIN_SCORE = 70;

/**
 * Default preferred video format.
 */
const DEFAULT_PREFERRED_FORMAT: VideoExtension = "mkv";

/**
 * Valid video format choices for CLI option.
 */
const VIDEO_FORMAT_CHOICES = [...VIDEO_EXTENSIONS] as string[];

/**
 * Parses a string to an integer.
 */
function parseIntArg(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

/**
 * Validates and normalizes the min-score value.
 * Accepts 0-100 scale from CLI, converts to 0-1 internally.
 */
function normalizeMinScore(value: number): number {
  if (value < 0 || value > 100) {
    throw new Error(`Min score must be between 0 and 100, got: ${value}`);
  }
  return value / 100;
}

/**
 * Raw options as parsed by Commander.js before transformation.
 */
interface RawLinkVideosOptions {
  minScore?: number;
  artist?: string;
  preferredFormat?: string;
  resetInventory?: boolean;
  progress?: boolean;
}

/**
 * Builds LinkVideosOptions from raw CLI options.
 *
 * @param videoSource - Video source directory path
 * @param musicLibrary - Music library directory path
 * @param rawOptions - Raw options from Commander.js
 * @param globalDryRun - Dry-run flag from global options
 * @param globalDebug - Debug flag from global options
 * @returns Fully constructed LinkVideosOptions
 */
function buildLinkVideosOptions(
  videoSource: string,
  musicLibrary: string,
  rawOptions: RawLinkVideosOptions,
  globalDryRun: boolean,
  globalDebug: boolean,
): LinkVideosOptions {
  const linkVideosConfig = getLoadedConfig().linkVideos ?? {};

  // Get min score from CLI ?? config ?? default, then normalize
  const rawMinScore = rawOptions.minScore ?? linkVideosConfig.minScore ?? DEFAULT_MIN_SCORE;
  const minScore = normalizeMinScore(rawMinScore);

  // Get preferred format
  const rawPreferredFormat =
    rawOptions.preferredFormat ?? linkVideosConfig.preferredFormat ?? DEFAULT_PREFERRED_FORMAT;
  if (!VIDEO_EXTENSIONS.includes(rawPreferredFormat as VideoExtension)) {
    throw new Error(
      `Invalid preferred format: ${rawPreferredFormat}. Valid formats: ${VIDEO_EXTENSIONS.join(", ")}`,
    );
  }
  const preferredFormat = rawPreferredFormat as VideoExtension;

  logDebug(`Min score: ${rawMinScore}% (normalized: ${minScore.toFixed(2)})`);
  logDebug(`Preferred format: ${preferredFormat}`);

  return {
    videoSource,
    musicLibrary,
    minScore,
    artist: rawOptions.artist,
    preferredFormat,
    resetInventory: rawOptions.resetInventory ?? false,
    progress: rawOptions.progress ?? linkVideosConfig.progress,
    dryRun: globalDryRun,
    debug: globalDebug,
  };
}

/**
 * Link-videos command for creating video hardlinks to audio tracks.
 */
export const linkVideosCommand = new Command("link-videos")
  .description("Create hardlinks from music videos to their matching audio tracks")
  .argument("<video-source>", "Path to music videos directory")
  .argument("<music-library>", "Path to music library directory")
  .addOption(
    new Option("--min-score <N>", "Minimum similarity score 0-100 (default: 70)").argParser(
      parseIntArg,
    ),
  )
  .addOption(new Option("--artist <name>", "Limit to specific artist"))
  .addOption(
    new Option("--preferred-format <ext>", "Preferred video format when duplicates exist")
      .choices(VIDEO_FORMAT_CHOICES)
      .default(DEFAULT_PREFERRED_FORMAT),
  )
  .addOption(new Option("--reset-inventory", "Clear inventory and rescan all videos"))
  .addOption(new Option("--progress", "Show visual progress bar"))
  .addOption(new Option("--no-progress", "Disable progress bar"))
  .action(
    async (
      videoSource: string,
      musicLibrary: string,
      options: RawLinkVideosOptions,
      command: Command,
    ) => {
      // Get global options from parent command
      const globalOpts = command.parent?.opts() ?? {};
      const globalDryRun = Boolean(globalOpts["dryRun"]);
      const globalDebug = Boolean(globalOpts["debug"]);

      // Build options
      let linkVideosOptions: LinkVideosOptions;
      try {
        linkVideosOptions = buildLinkVideosOptions(
          videoSource,
          musicLibrary,
          options,
          globalDryRun,
          globalDebug,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logError(msg);
        process.exitCode = 1;
        return;
      }

      // Lazy load action handler
      const { executeLinkVideos } = await import("../actions/link-videos.js");

      let result: LinkVideosResult;
      try {
        result = await executeLinkVideos(linkVideosOptions);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logError(msg);
        process.exitCode = 1;
        return;
      }

      // Build JSON output
      const jsonOutput: LinkVideosJsonOutput = {
        command: "link-videos",
        videoSource,
        musicLibrary,
        result: {
          videosScanned: result.videosScanned,
          tracksScanned: result.tracksScanned,
          matchesFound: result.matchesFound,
          linksCreated: result.linksCreated,
          skipped: result.skipped,
          noMatch: result.noMatch,
          failedCount: result.failed.length,
          failed: result.failed,
        },
      };

      const format = globalOpts?.["output"] ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, jsonOutput);
      }

      // Exit with error code if any operations failed
      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    },
  );
