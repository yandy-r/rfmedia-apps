/**
 * Inventory type definitions for rfmedia CLI sync command.
 *
 * The inventory system tracks files that have been copied to enable
 * incremental sync operations that detect new and updated files.
 */

import type { CopyOptions, ConvertFormat } from "./options.js";
import type { DbConnection } from "./db.js";

/**
 * Individual file entry in the inventory.
 * Tracks metadata at the time of copy for change detection.
 */
export interface FileInventoryEntry {
  /** Relative path from source root */
  relativePath: string;
  /** File modification time (epoch ms) */
  mtime: number;
  /** File size in bytes */
  size: number;
  /** Normalized rating at time of copy (0.0-1.0), null if unrated */
  rating: number | null;
  /** First genre from metadata (stores only first element from genre array) */
  genre?: string;
  /** Release year */
  year?: number;
  /** Beats per minute (floating point for precision) */
  bpm?: number;
  /** Primary artist */
  artist?: string;
  /** Absolute destination path */
  destPath: string;
  /** SHA-256 hash of the copied destination bytes */
  contentHash?: string | null;
  /** Timestamp when this entry was recorded */
  copiedAt: number;
}

/**
 * Inventory for a single source directory.
 * Contains all tracked files from that source.
 */
export interface SourceInventory {
  /** Source directory path */
  source: string;
  /** Last full scan timestamp */
  lastScan: number;
  /** Map of relativePath -> FileInventoryEntry */
  files: Map<string, FileInventoryEntry>;
}

/**
 * Information about a file with rating below threshold.
 */
export interface DowngradedFileInfo {
  /** Relative path from source root */
  relativePath: string;
  /** Absolute destination path where the file was copied */
  destPath: string;
  /** Rating at time of previous copy (normalized 0.0-1.0), null if was unrated */
  previousRating: number | null;
  /** Current rating (normalized 0.0-1.0), null if now unrated */
  currentRating: number | null;
}

/**
 * Result of comparing current files against inventory.
 * Used to determine what needs to be synced.
 */
export interface SyncDiff {
  /** Files not in inventory (new) */
  newFiles: string[];
  /** Files with changed mtime/size that now meet rating threshold */
  updatedFiles: string[];
  /** Files unchanged since last sync */
  unchangedFiles: string[];
  /** Files in inventory but no longer exist */
  removedFiles: string[];
  /** Files with rating below threshold that should be deleted from destination */
  downgradedFiles: DowngradedFileInfo[];
}

/**
 * Options specific to sync command.
 */
export interface SyncOptions {
  /** Base copy options (mode, rating, convert, etc.) */
  copyOptions: CopyOptions;
  /** Only show what would be synced, don't copy */
  dryRun: boolean;
  /** Force re-copy even if file appears unchanged */
  force: boolean;
  /** Reset inventory and start fresh */
  resetInventory: boolean;
  /** Delete files from destination when rating falls below threshold (default: true) */
  deleteDowngraded: boolean;
}

/**
 * Result from the sync command execution.
 */
export interface SyncResult {
  /** Source file (input file with paths) */
  inputFile: string;
  /** Number of sources scanned */
  sourcesScanned: number;
  /** Number of new files copied */
  newFilesCopied: number;
  /** Number of updated files copied (rating changes, etc.) */
  updatedFilesCopied: number;
  /** Number of unchanged files skipped */
  unchangedFilesSkipped: number;
  /** Number of files deleted due to rating downgrade */
  deletedFiles: number;
  /** Number of files that failed to copy */
  failedFiles: number;
  /** Detailed failure information */
  failed: SyncFailedOperation[];
}

/**
 * Details about a failed sync operation.
 */
export interface SyncFailedOperation {
  /** Source path that failed */
  sourcePath: string;
  /** Destination path (if known) */
  destPath?: string;
  /** Error message */
  message: string;
  /** Error code if available */
  code?: string;
}

/**
 * JSONL record types for inventory file format.
 * The inventory uses JSON Lines format for efficient streaming.
 */
export type InventoryRecord = InventorySourceRecord | InventoryFileRecord;

/**
 * Source metadata record in JSONL inventory.
 */
export interface InventorySourceRecord {
  /** Source directory path */
  source: string;
  /** Last scan timestamp */
  lastScan: number;
  /** Discriminator - file is undefined for source records */
  file?: never;
}

/**
 * File entry record in JSONL inventory.
 */
export interface InventoryFileRecord {
  /** Source directory this file belongs to */
  source: string;
  /** File entry data */
  file: FileInventoryEntry;
  /** Discriminator - lastScan is undefined for file records */
  lastScan?: never;
}

/**
 * Loaded inventory data from JSONL file.
 * Maps source paths to their inventories.
 */
export type LoadedInventory = Map<string, SourceInventory>;

/**
 * Context for inventory operations, supporting both database and file-based modes.
 * Used to route inventory operations to the appropriate backend.
 */
export interface InventoryContext {
  /** Path to the inventory file (for legacy file-based mode) */
  inventoryPath: string;
  /** Database connection (for database mode) */
  db?: DbConnection;
  /** Operation ID (for database mode) */
  operationId?: number;
}

/**
 * Options hash for inventory file naming.
 * Used to create unique inventory files per configuration.
 */
export interface InventoryOptionsHash {
  /** Copy mode: 'album' or 'filter' */
  mode: "album" | "filter";
  /** Rating key (e.g., 'r50' or 's3') */
  ratingKey?: string;
  /** Range key (e.g., '001-010') */
  rangeKey?: string;
  /** Conversion format key */
  convertKey?: ConvertFormat;
}
