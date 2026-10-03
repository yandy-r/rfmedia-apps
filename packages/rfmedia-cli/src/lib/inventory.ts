/**
 * Inventory management for rfmedia CLI sync command.
 *
 * Provides JSONL-based inventory tracking for incremental sync operations.
 * The inventory tracks which files have been copied and their metadata
 * at the time of copy, enabling detection of new and changed files.
 */

import path from "node:path";
import { readFile, writeFile, appendFile, unlink, stat } from "node:fs/promises";
import readline from "node:readline";
import { createReadStream } from "node:fs";

import { logDebug, logWarn } from "./logger.js";
import { pathExists, normalizePath } from "./filesystem.js";
import { formatSuffix } from "./range.js";
import { findAudioFiles } from "./audio.js";
import { readRating, meetsThreshold } from "./ratings.js";
import { readExtendedMetadata } from "./metadata.js";
import type { CopyOptions, RatingFilter } from "../types/options.js";
import type {
  FileInventoryEntry,
  SourceInventory,
  SyncDiff,
  LoadedInventory,
  InventoryOptionsHash,
  InventoryRecord,
  InventorySourceRecord,
  InventoryFileRecord,
  DowngradedFileInfo,
  InventoryContext,
} from "../types/inventory.js";
import type { DbConnection } from "../types/db.js";
import { getInventory, getInventoryForSource, recordInventoryFile } from "./db.js";

/**
 * Builds an options hash from copy options for inventory file naming.
 *
 * The hash format is human-readable and deterministic:
 * - Album mode: `album-{range}` or `album` (no range)
 * - Filter mode: `filter-{rating}-{range?}-{convert?}`
 *
 * @param options - Copy options to build hash from
 * @returns Options hash object
 */
export function buildInventoryOptionsHash(options: CopyOptions): InventoryOptionsHash {
  const hash: InventoryOptionsHash = {
    mode: options.mode.type,
  };

  if (options.mode.type === "album") {
    const range = options.mode.range;
    hash.rangeKey = `${formatSuffix(range.start, range.padWidth)}-${formatSuffix(range.end, range.padWidth)}`;
  } else {
    // Filter mode
    const rating = options.mode.rating;

    // Rating key
    if (rating.minStars !== undefined) {
      hash.ratingKey = `s${rating.minStars}`;
    } else if (rating.minRating !== undefined) {
      hash.ratingKey = `r${rating.minRating}`;
    }

    // Range key (filter mode can also have range)
    if (rating.range) {
      hash.rangeKey = `${formatSuffix(rating.range.start, rating.range.padWidth)}-${formatSuffix(rating.range.end, rating.range.padWidth)}`;
    }
  }

  // Conversion format
  if (options.convertFormat) {
    hash.convertKey = options.convertFormat;
  }

  return hash;
}

/**
 * Formats an options hash into a filename-safe string.
 *
 * @param hash - Options hash to format
 * @returns Formatted string for use in filename
 *
 * @example
 * // Album mode with range
 * formatInventoryOptionsHash({ mode: 'album', rangeKey: '001-010' })
 * // Returns: 'album-001-010'
 *
 * @example
 * // Filter mode with rating and conversion
 * formatInventoryOptionsHash({ mode: 'filter', ratingKey: 'r80', convertKey: 'mp3' })
 * // Returns: 'filter-r80-mp3'
 */
export function formatInventoryOptionsHash(hash: InventoryOptionsHash): string {
  const parts: string[] = [hash.mode];

  if (hash.ratingKey) {
    parts.push(hash.ratingKey);
  }

  if (hash.rangeKey) {
    parts.push(hash.rangeKey);
  }

  if (hash.convertKey) {
    parts.push(hash.convertKey);
  }

  return parts.join("-");
}

/**
 * Resolves the inventory file path.
 *
 * Default location is next to the input file with the pattern:
 * `{inputBasename}.inventory.{optionsHash}.jsonl`
 *
 * @param inputFile - Path to the input file containing source paths
 * @param options - Copy options for building the options hash
 * @returns Absolute path to the inventory file
 */
export function resolveInventoryPath(inputFile: string, options: CopyOptions): string {
  const inputDir = path.dirname(inputFile);
  const inputBasename = path.basename(inputFile, path.extname(inputFile));
  const hash = buildInventoryOptionsHash(options);
  const hashStr = formatInventoryOptionsHash(hash);

  return path.join(inputDir, `${inputBasename}.inventory.${hashStr}.jsonl`);
}

/**
 * Generates the file header for an inventory file.
 *
 * @param inputFile - Original input file path
 * @param options - Copy options
 * @returns Header string (as JSONL comment line)
 */
export function generateInventoryHeader(inputFile: string, options: CopyOptions): string {
  const hash = buildInventoryOptionsHash(options);
  const timestamp = new Date().toISOString();

  // Use a special header record format
  const header = {
    _header: true,
    inputFile: path.basename(inputFile),
    createdAt: timestamp,
    mode: hash.mode,
    ratingKey: hash.ratingKey,
    rangeKey: hash.rangeKey,
    convertKey: hash.convertKey,
  };

  return JSON.stringify(header);
}

/**
 * Loads inventory from the database into Map structure.
 *
 * @param db - Database connection
 * @param operationId - Operation ID to load inventory from
 * @returns Loaded inventory map (source -> SourceInventory)
 */
function loadInventoryFromDb(db: DbConnection, operationId: number): LoadedInventory {
  const inventory: LoadedInventory = new Map();

  // Get all inventory entries for this operation
  const entries = getInventory(db, operationId);

  for (const entry of entries) {
    const source = normalizePath(entry.source_path);

    // Ensure source inventory exists
    if (!inventory.has(source)) {
      inventory.set(source, {
        source,
        lastScan: entry.copied_at, // Use copied_at as lastScan approximation
        files: new Map(),
      });
    }

    const sourceInventory = inventory.get(source)!;

    // Add file entry with extended metadata
    const fileEntry: FileInventoryEntry = {
      relativePath: entry.relative_path,
      mtime: entry.mtime,
      size: entry.size,
      rating: entry.rating,
      // Extended metadata - only include if not null for cleaner objects
      ...(entry.genre !== null && { genre: entry.genre }),
      ...(entry.year !== null && { year: entry.year }),
      ...(entry.bpm !== null && { bpm: entry.bpm }),
      ...(entry.artist !== null && { artist: entry.artist }),
      destPath: entry.dest_path,
      copiedAt: entry.copied_at,
      ...(entry.content_hash !== null && { contentHash: entry.content_hash }),
    };

    sourceInventory.files.set(entry.relative_path, fileEntry);

    // Update lastScan to the most recent copied_at
    if (entry.copied_at > sourceInventory.lastScan) {
      sourceInventory.lastScan = entry.copied_at;
    }
  }

  logDebug(
    `Loaded inventory from database: ${inventory.size} source(s) for operation ${operationId}`,
  );
  let totalFiles = 0;
  for (const sourceInv of inventory.values()) {
    totalFiles += sourceInv.files.size;
  }
  logDebug(`Total tracked files: ${totalFiles}`);

  return inventory;
}

/**
 * Appends a file entry to the database inventory with extended metadata.
 *
 * Extended metadata fields (genre, year, bpm, artist) are included when
 * present in the entry, supporting smart filter evaluation.
 *
 * @param db - Database connection
 * @param operationId - Operation ID
 * @param source - Source directory path
 * @param entry - File inventory entry with optional extended metadata
 */
function appendFileRecordToDb(
  db: DbConnection,
  operationId: number,
  source: string,
  entry: FileInventoryEntry,
): void {
  recordInventoryFile(db, operationId, {
    sourcePath: normalizePath(source),
    relativePath: entry.relativePath,
    mtime: entry.mtime,
    size: entry.size,
    rating: entry.rating,
    // Extended metadata - pass through from entry (may be undefined)
    genre: entry.genre ?? null,
    year: entry.year ?? null,
    bpm: entry.bpm ?? null,
    artist: entry.artist ?? null,
    destPath: entry.destPath,
    contentHash: entry.contentHash ?? null,
  });
}

/**
 * Loads inventory from database or JSONL file based on context.
 *
 * Routes to database or file-based inventory based on context configuration.
 *
 * @param context - Inventory context with path and optional database connection
 * @returns Loaded inventory map (source -> SourceInventory)
 */
export async function loadInventory(context: InventoryContext): Promise<LoadedInventory> {
  // Route to database mode if available
  if (context.db && context.operationId !== undefined) {
    return loadInventoryFromDb(context.db, context.operationId);
  }

  // Legacy file-based inventory
  const inventory: LoadedInventory = new Map();

  if (!(await pathExists(context.inventoryPath))) {
    logDebug(`Inventory file not found, starting fresh: ${context.inventoryPath}`);
    return inventory;
  }

  try {
    const fileStream = createReadStream(context.inventoryPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    for await (const line of rl) {
      lineNumber++;

      // Skip empty lines
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

        // Parse as inventory record - need to check properties exist
        if (!("source" in record) || typeof record["source"] !== "string") {
          continue;
        }

        const source = normalizePath(record["source"]);

        if ("lastScan" in record && typeof record["lastScan"] === "number") {
          // Source metadata record
          const lastScan = record["lastScan"];

          if (!inventory.has(source)) {
            inventory.set(source, {
              source,
              lastScan,
              files: new Map(),
            });
          } else {
            // Update lastScan if more recent
            const existing = inventory.get(source)!;
            if (lastScan > existing.lastScan) {
              existing.lastScan = lastScan;
            }
          }
        } else if ("file" in record && record["file"] !== undefined && record["file"] !== null) {
          // File entry record
          const entry = record["file"] as FileInventoryEntry;

          // Ensure source inventory exists
          if (!inventory.has(source)) {
            inventory.set(source, {
              source,
              lastScan: 0,
              files: new Map(),
            });
          }

          const sourceInventory = inventory.get(source)!;
          sourceInventory.files.set(entry.relativePath, entry);
        }
      } catch (parseError) {
        // Log but continue on parse errors for individual lines
        logDebug(`Invalid JSON at line ${lineNumber}: ${trimmed}`);
      }
    }

    logDebug(`Loaded inventory: ${inventory.size} source(s) from ${context.inventoryPath}`);
    let totalFiles = 0;
    for (const sourceInv of inventory.values()) {
      totalFiles += sourceInv.files.size;
    }
    logDebug(`Total tracked files: ${totalFiles}`);

    return inventory;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logWarn(`Failed to load inventory file: ${msg}`);
    logWarn("Starting with empty inventory");
    return new Map();
  }
}

/**
 * Initializes an inventory file with a header (file-based mode only).
 *
 * In database mode, this is a no-op since the operation record handles initialization.
 *
 * @param context - Inventory context
 * @param inputFile - Input file path for header
 * @param options - Copy options for header
 */
export async function initializeInventory(
  context: InventoryContext,
  inputFile: string,
  options: CopyOptions,
): Promise<void> {
  // In database mode, initialization is handled by operation creation
  if (context.db && context.operationId !== undefined) {
    logDebug(`Inventory initialization handled by database operation ${context.operationId}`);
    return;
  }

  // Legacy file-based mode
  const header = generateInventoryHeader(inputFile, options);
  await writeFile(context.inventoryPath, header + "\n", "utf-8");
  logDebug(`Created inventory file: ${context.inventoryPath}`);
}

/**
 * Resets inventory (file-based mode only).
 *
 * In database mode, this is a no-op since creating a new operation handles reset.
 *
 * @param context - Inventory context
 */
export async function resetInventory(context: InventoryContext): Promise<void> {
  // In database mode, reset is handled by creating a new operation
  if (context.db && context.operationId !== undefined) {
    logDebug("Inventory reset handled by database operation creation");
    return;
  }

  // Legacy file-based mode
  if (await pathExists(context.inventoryPath)) {
    await unlink(context.inventoryPath);
    logDebug(`Deleted inventory file: ${context.inventoryPath}`);
  }
}

/**
 * Appends a source metadata record to the inventory file.
 *
 * In database mode, this is a no-op since source metadata is tracked via file entries.
 *
 * @param context - Inventory context
 * @param source - Source directory path
 * @param lastScan - Scan timestamp
 */
export async function appendSourceRecord(
  context: InventoryContext,
  source: string,
  lastScan: number,
): Promise<void> {
  // In database mode, source metadata is tracked via file entries (lastScan derived from copied_at)
  if (context.db && context.operationId !== undefined) {
    // No-op in database mode
    return;
  }

  // Legacy file-based mode
  const record: InventorySourceRecord = {
    source: normalizePath(source),
    lastScan,
  };
  await appendFile(context.inventoryPath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Appends a file entry record to the inventory.
 *
 * Routes to database or file-based inventory based on context.
 *
 * @param context - Inventory context
 * @param source - Source directory path
 * @param entry - File inventory entry
 */
export async function appendFileRecord(
  context: InventoryContext,
  source: string,
  entry: FileInventoryEntry,
): Promise<void> {
  // Route to database mode
  if (context.db && context.operationId !== undefined) {
    appendFileRecordToDb(context.db, context.operationId, source, entry);
    return;
  }

  // Legacy file-based mode
  const record: InventoryFileRecord = {
    source: normalizePath(source),
    file: entry,
  };
  await appendFile(context.inventoryPath, JSON.stringify(record) + "\n", "utf-8");
}

/**
 * Basic file metadata result containing only filesystem stats.
 */
export interface BasicFileMetadata {
  mtime: number;
  size: number;
}

/**
 * Extended file metadata result including audio tag information.
 * Used when smart filters are active and require genre/year/bpm/artist filtering.
 */
export interface ExtendedFileMetadata extends BasicFileMetadata {
  rating: number | null;
  genre: string | null;
  year: number | null;
  bpm: number | null;
  artist: string | null;
}

/**
 * Gets file stats (mtime, size) for comparison.
 *
 * @param filePath - Path to the file
 * @returns Object with mtime (epoch ms) and size (bytes)
 */
export async function getFileMetadata(filePath: string): Promise<BasicFileMetadata> {
  const stats = await stat(filePath);
  return {
    mtime: stats.mtimeMs,
    size: Number(stats.size),
  };
}

/**
 * Gets extended file metadata including audio tag information.
 *
 * This function combines filesystem stats with audio metadata extraction
 * using readExtendedMetadata() for smart filter evaluation. It extracts:
 * - Rating (normalized 0.0-1.0)
 * - Genre (first element from array)
 * - Year (release year)
 * - BPM (beats per minute)
 * - Artist (primary artist)
 *
 * @param filePath - Path to the audio file
 * @returns Extended metadata object with all fields, null values for missing metadata
 */
export async function getExtendedFileMetadata(filePath: string): Promise<ExtendedFileMetadata> {
  const stats = await stat(filePath);
  const basicMeta: ExtendedFileMetadata = {
    mtime: stats.mtimeMs,
    size: Number(stats.size),
    rating: null,
    genre: null,
    year: null,
    bpm: null,
    artist: null,
  };

  // Read extended metadata from audio file
  const extMeta = await readExtendedMetadata(filePath);
  if (extMeta) {
    basicMeta.rating = extMeta.rating?.value ?? null;
    // Genre is array but we store only first element
    basicMeta.genre = extMeta.common.genre?.[0] ?? null;
    basicMeta.year = extMeta.common.year ?? null;
    basicMeta.bpm = extMeta.common.bpm ?? null;
    basicMeta.artist = extMeta.common.artist ?? null;
  }

  return basicMeta;
}

/**
 * Computes the sync diff for a source directory in filter mode.
 *
 * Compares current files against the inventory to determine:
 * - New files: not in inventory and meet rating threshold
 * - Updated files: changed (mtime/size) and now meet threshold
 * - Unchanged files: same metadata as inventory
 * - Removed files: in inventory but no longer exist
 *
 * @param source - Source directory path
 * @param inventory - Existing inventory for this source (or undefined)
 * @param filter - Rating filter for threshold checking
 * @param destination - Destination base path
 * @returns SyncDiff with categorized files
 */
export async function computeFilterSyncDiff(
  source: string,
  inventory: SourceInventory | undefined,
  filter: RatingFilter,
  destination: string,
): Promise<SyncDiff> {
  const diff: SyncDiff = {
    newFiles: [],
    updatedFiles: [],
    unchangedFiles: [],
    removedFiles: [],
    downgradedFiles: [],
  };

  // Find all current audio files in source
  const audioFiles = await findAudioFiles(source);

  // Track which inventory entries we've seen (for detecting removed files)
  const seenPaths = new Set<string>();

  for (const filePath of audioFiles) {
    const relativePath = path.relative(source, filePath);
    seenPaths.add(relativePath);

    // Get current file metadata
    let currentMeta: { mtime: number; size: number };
    try {
      currentMeta = await getFileMetadata(filePath);
    } catch {
      // Can't read file, skip it
      continue;
    }

    // Read current rating
    let currentRating: number | null = null;
    try {
      const rating = await readRating(filePath);
      currentRating = rating?.value ?? null;
    } catch {
      // Can't read rating, treat as unrated
    }

    const currentlyMeetsThreshold = currentRating !== null && meetsThreshold(currentRating, filter);

    // Check against inventory
    const existingEntry = inventory?.files.get(relativePath);

    if (!existingEntry) {
      // NEW: File not in inventory
      if (currentlyMeetsThreshold) {
        diff.newFiles.push(filePath);
        logDebug(`New file (meets threshold): ${relativePath}`);
      }
      // If doesn't meet threshold, it's simply not tracked
    } else {
      // File exists in inventory - check for changes
      const fileChanged =
        currentMeta.mtime > existingEntry.mtime || currentMeta.size !== existingEntry.size;

      const wasAboveThreshold = existingEntry.rating !== null && existingEntry.rating > 0;

      if (fileChanged) {
        // File has been modified
        if (currentlyMeetsThreshold && !wasAboveThreshold) {
          // Rating increased above threshold - needs to be copied
          diff.updatedFiles.push(filePath);
          logDebug(
            `Rating upgrade: ${relativePath} (was ${existingEntry.rating}, now ${currentRating})`,
          );
        } else if (currentlyMeetsThreshold && wasAboveThreshold) {
          // Was already copied, check if dest still exists
          const destExists = await pathExists(existingEntry.destPath);
          if (!destExists) {
            diff.updatedFiles.push(filePath);
            logDebug(`Dest missing, re-copy: ${relativePath}`);
          } else {
            diff.unchangedFiles.push(filePath);
          }
        } else if (!currentlyMeetsThreshold && wasAboveThreshold) {
          // Rating downgraded below threshold - file should be deleted from destination
          diff.downgradedFiles.push({
            relativePath,
            destPath: existingEntry.destPath,
            previousRating: existingEntry.rating,
            currentRating,
          });
          logDebug(
            `Rating downgrade: ${relativePath} (was ${existingEntry.rating}, now ${currentRating})`,
          );
        } else {
          // Doesn't meet threshold, skip
          diff.unchangedFiles.push(filePath);
        }
      } else {
        // File unchanged - but check if rating was downgraded without file modification
        // This can happen if only the rating metadata was changed
        if (wasAboveThreshold && !currentlyMeetsThreshold) {
          diff.downgradedFiles.push({
            relativePath,
            destPath: existingEntry.destPath,
            previousRating: existingEntry.rating,
            currentRating,
          });
          logDebug(
            `Rating downgrade (metadata only): ${relativePath} (was ${existingEntry.rating}, now ${currentRating})`,
          );
        } else {
          diff.unchangedFiles.push(filePath);
        }
      }
    }
  }

  // Find removed files (in inventory but no longer exist)
  if (inventory) {
    for (const relativePath of inventory.files.keys()) {
      if (!seenPaths.has(relativePath)) {
        diff.removedFiles.push(relativePath);
        logDebug(`Removed from source: ${relativePath}`);
      }
    }
  }

  return diff;
}

/**
 * Computes the sync diff for a source directory in album mode.
 *
 * Album mode is simpler than filter mode - no rating threshold checking.
 * Just detects new files and missing destination files.
 *
 * @param source - Source directory path
 * @param inventory - Existing inventory for this source (or undefined)
 * @param destination - Destination base path
 * @returns SyncDiff with categorized files
 */
export async function computeAlbumSyncDiff(
  source: string,
  inventory: SourceInventory | undefined,
  destination: string,
): Promise<SyncDiff> {
  const diff: SyncDiff = {
    newFiles: [],
    updatedFiles: [],
    unchangedFiles: [],
    removedFiles: [],
    downgradedFiles: [], // Not used in album mode, but required by interface
  };

  // Find all current audio files in source
  const audioFiles = await findAudioFiles(source);

  // Track which inventory entries we've seen
  const seenPaths = new Set<string>();

  for (const filePath of audioFiles) {
    const relativePath = path.relative(source, filePath);
    seenPaths.add(relativePath);

    const existingEntry = inventory?.files.get(relativePath);

    if (!existingEntry) {
      // NEW: File not in inventory
      diff.newFiles.push(filePath);
      logDebug(`New file: ${relativePath}`);
    } else {
      // Check if destination file exists
      const destExists = await pathExists(existingEntry.destPath);
      if (!destExists) {
        diff.updatedFiles.push(filePath);
        logDebug(`Dest missing, re-copy: ${relativePath}`);
      } else {
        diff.unchangedFiles.push(filePath);
      }
    }
  }

  // Find removed files
  if (inventory) {
    for (const relativePath of inventory.files.keys()) {
      if (!seenPaths.has(relativePath)) {
        diff.removedFiles.push(relativePath);
        logDebug(`Removed from source: ${relativePath}`);
      }
    }
  }

  return diff;
}

/**
 * Creates a file inventory entry for a copied file.
 *
 * @param source - Source directory path
 * @param filePath - Absolute path to the source file
 * @param destPath - Destination file path
 * @param rating - Normalized rating (or null if unrated)
 * @returns FileInventoryEntry
 */
export async function createFileInventoryEntry(
  source: string,
  filePath: string,
  destPath: string,
  rating: number | null,
  contentHash?: string | null,
): Promise<FileInventoryEntry> {
  const relativePath = path.relative(source, filePath);
  const meta = await getFileMetadata(filePath);

  return {
    relativePath,
    mtime: meta.mtime,
    size: meta.size,
    rating,
    destPath,
    contentHash: contentHash ?? null,
    copiedAt: Date.now(),
  };
}
