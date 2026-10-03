/**
 * Video link inventory management for rfmedia CLI.
 *
 * Provides JSONL-based inventory tracking for the link-videos command.
 * The inventory tracks which videos have been linked to audio tracks,
 * enabling incremental operation that skips already-processed videos.
 */

import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import readline from "node:readline";
import { appendFile, writeFile, unlink } from "node:fs/promises";

import { logDebug, logWarn } from "./logger.js";
import { pathExists } from "./filesystem.js";
import type {
  VideoLinkEntry,
  VideoInventoryHeader,
  LoadedVideoInventory,
} from "../types/link-videos.js";

/**
 * Generates a short hash from source paths for inventory filename.
 *
 * @param videoSource - Video source directory path
 * @param musicLibrary - Music library directory path
 * @returns 8-character hex hash
 */
function generateInventoryHash(videoSource: string, musicLibrary: string): string {
  const input = `${videoSource}:${musicLibrary}`;
  const hash = crypto.createHash("sha256").update(input).digest("hex");
  return hash.slice(0, 8);
}

/**
 * Resolves the inventory file path for a video source and music library.
 *
 * The inventory file is stored next to the music library with the pattern:
 * `.video-links.{hash}.jsonl`
 *
 * @param videoSource - Video source directory path
 * @param musicLibrary - Music library directory path
 * @returns Absolute path to the inventory file
 */
export function resolveVideoInventoryPath(videoSource: string, musicLibrary: string): string {
  const hash = generateInventoryHash(videoSource, musicLibrary);
  const filename = `.video-links.${hash}.jsonl`;
  return path.join(path.dirname(musicLibrary), filename);
}

/**
 * Generates the header record for a new inventory file.
 *
 * @param videoSource - Video source directory path
 * @param musicLibrary - Music library directory path
 * @param minScore - Minimum match score used
 * @returns JSON string for the header record
 */
function generateVideoInventoryHeader(
  videoSource: string,
  musicLibrary: string,
  minScore: number,
): string {
  const header: VideoInventoryHeader = {
    _header: true,
    videoSource,
    musicLibrary,
    minScore,
    createdAt: new Date().toISOString(),
  };
  return JSON.stringify(header);
}

/**
 * Loads the video link inventory from a JSONL file.
 *
 * @param inventoryPath - Path to the inventory JSONL file
 * @returns Map of video paths to their link entries
 */
export async function loadVideoInventory(inventoryPath: string): Promise<LoadedVideoInventory> {
  const inventory: LoadedVideoInventory = new Map();

  if (!(await pathExists(inventoryPath))) {
    logDebug(`Video inventory not found, starting fresh: ${inventoryPath}`);
    return inventory;
  }

  try {
    const fileStream = createReadStream(inventoryPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;

      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }

      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;

        // Skip header records
        if (record["_header"]) {
          continue;
        }

        // Parse as video link entry
        if (
          typeof record["videoPath"] === "string" &&
          typeof record["trackPath"] === "string" &&
          typeof record["destPath"] === "string"
        ) {
          const entry: VideoLinkEntry = {
            videoPath: record["videoPath"],
            trackPath: record["trackPath"],
            destPath: record["destPath"],
            score: typeof record["score"] === "number" ? record["score"] : 0,
            linkedAt: typeof record["linkedAt"] === "number" ? record["linkedAt"] : 0,
          };
          inventory.set(entry.videoPath, entry);
        }
      } catch (parseError) {
        logDebug(`Invalid JSON at line ${lineNumber}: ${trimmed}`);
      }
    }

    logDebug(`Loaded video inventory: ${inventory.size} entries from ${inventoryPath}`);
    return inventory;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to load video inventory: ${msg}`);
    logWarn("Starting with empty inventory");
    return new Map();
  }
}

/**
 * Initializes a new video inventory file with a header.
 *
 * @param inventoryPath - Path to the inventory file
 * @param videoSource - Video source directory path
 * @param musicLibrary - Music library directory path
 * @param minScore - Minimum match score used
 */
export async function initializeVideoInventory(
  inventoryPath: string,
  videoSource: string,
  musicLibrary: string,
  minScore: number,
): Promise<void> {
  const header = generateVideoInventoryHeader(videoSource, musicLibrary, minScore);
  await writeFile(inventoryPath, header + "\n", "utf-8");
  logDebug(`Created video inventory: ${inventoryPath}`);
}

/**
 * Appends a video link record to the inventory file.
 *
 * @param inventoryPath - Path to the inventory file
 * @param entry - Video link entry to append
 */
export async function appendVideoLinkRecord(
  inventoryPath: string,
  entry: VideoLinkEntry,
): Promise<void> {
  const record = JSON.stringify(entry);
  await appendFile(inventoryPath, record + "\n", "utf-8");
}

/**
 * Resets (deletes) a video inventory file if it exists.
 *
 * @param inventoryPath - Path to the inventory file to reset
 */
export async function resetVideoInventory(inventoryPath: string): Promise<void> {
  if (await pathExists(inventoryPath)) {
    await unlink(inventoryPath);
    logDebug(`Deleted video inventory: ${inventoryPath}`);
  }
}

/**
 * Checks if a video has already been processed (exists in inventory).
 *
 * @param inventory - Loaded inventory map
 * @param videoRelativePath - Relative path of the video from source
 * @returns true if the video is in the inventory
 */
export function isVideoInInventory(
  inventory: LoadedVideoInventory,
  videoRelativePath: string,
): boolean {
  return inventory.has(videoRelativePath);
}
