/**
 * Result type definitions for rfmedia CLI command outputs.
 */

import type { ConflictResolutionResult } from "./conflict.js";
import type { VerificationTier } from "./options.js";

/**
 * Result from the copy command execution.
 */
export interface CopyResult {
  /** Source path that was processed */
  source: string;
  /** Number of new copies or tracks created */
  created: number;
  /** Number of existing items that were skipped */
  skipped: number;
  /** Number of tracks below rating threshold (filter mode only) */
  filtered: number;
  /** Paths that failed to copy with error details */
  failed: FailedOperation[];
  /** Conflict resolutions that occurred during the operation */
  conflictResolutions?: ConflictResolutionResult[];
}

/**
 * Result from the clean command execution.
 */
export interface CleanResult {
  /** Number of empty album folders deleted */
  albumsDeleted: number;
  /** Number of empty artist folders deleted (cascading cleanup) */
  artistsDeleted: number;
  /** Paths that failed to delete with error details */
  errors: FailedOperation[];
}

/**
 * Details about a failed operation for error reporting.
 */
export interface FailedOperation {
  /** Path of the file or directory that failed */
  path: string;
  /** Error message describing the failure */
  message: string;
  /** Error code if available (e.g., ENOENT, EACCES) */
  code?: string;
}

/**
 * Album completeness verification result.
 */
export type VerifyStatus = "complete" | "incomplete" | "missing";

/**
 * Result from album completeness verification.
 */
export interface VerifyResult {
  /** Overall status of the verification */
  status: VerifyStatus;
  /** Number of files expected in destination */
  expectedFiles: number;
  /** Number of files actually present */
  actualFiles: number;
  /** List of missing file names (if incomplete) */
  missingFiles: string[];
}

/**
 * File verification status for verify command.
 */
export type FileVerifyStatus =
  | "present"
  | "extra"
  | "missing"
  | "size-mismatch"
  | "metadata-mismatch"
  | "hash-mismatch"
  | "content-mismatch"
  | "unverifiable"
  | "not-applicable"
  | "unstable";

/**
 * Stable reason codes that qualify verification outcomes without exposing fingerprints.
 */
export type VerificationReason =
  | "mtime"
  | "fingerprint-missing"
  | "fingerprint-null"
  | "fingerprint-invalid"
  | "fingerprint-ambiguous"
  | "conversion-metadata-unavailable"
  | "conversion-byte-compare"
  | "same-inode-byte-compare"
  | "changed-during-read";

/**
 * Evidence gathered while evaluating a file at the selected verification tier.
 */
export type VerificationEvidence = "metadata" | "hash" | "bytes";

/**
 * Details about a verified file with its status.
 */
export interface VerifiedFile {
  /** File path relative to destination */
  path: string;
  /** Source file path (for re-copying when fixing, especially for converted files) */
  sourcePath?: string;
  /** Verification status */
  status: FileVerifyStatus;
  /** Stable explanation for mismatches, unavailable coverage, or inapplicable checks */
  reason?: VerificationReason;
  /** Evidence types gathered for this outcome; never includes raw fingerprint values */
  evidence?: readonly VerificationEvidence[];
  /** Expected file size in bytes (when verifySize enabled) */
  expectedSize?: number;
  /** Actual file size in bytes (when verifySize enabled and file exists) */
  actualSize?: number;
}

/**
 * Result from fix operations during verify command.
 */
export interface FixResult {
  /** Number of files re-copied from source */
  copiedFiles: number;
  /** Number of extra files removed */
  removedFiles: number;
  /** Operations that failed during fix with error details */
  failedFixes: FailedOperation[];
  /** Number of repaired files that passed the selected tier's post-repair verification */
  repairedFiles: number;
  /** Number of repaired files that were checked again at the selected tier */
  reverifiedFiles: number;
  /** Number of repair candidates safely refused because repair could not be proven */
  refusedFiles: number;
  /** Number of discrepancies still unresolved after repair and re-verification */
  remainingIssues: number;
  /** Conflict resolutions that occurred during the fix operation */
  conflictResolutions?: ConflictResolutionResult[];
}

/**
 * Result from the verify command execution.
 */
export interface VerifyCommandResult {
  /** Source path that was verified */
  source: string;
  /** Effective verification tier used for this result */
  tier: VerificationTier;
  /** Number of files verified as present and matching */
  verified: number;
  /** Number of files missing from destination */
  missing: number;
  /** Number of files with size mismatches */
  sizeMismatch: number;
  /** Number of files with modification-time metadata mismatches */
  metadataMismatch: number;
  /** Number of files whose destination hash differs from the stored fingerprint */
  hashMismatch: number;
  /** Number of files whose source and destination bytes differ */
  contentMismatch: number;
  /** Number of files lacking usable evidence for the selected tier */
  unverifiable: number;
  /** Number of requested checks that were not meaningful for the artifact */
  notApplicable: number;
  /** Number of files that changed while verification evidence was being read */
  unstable: number;
  /** Number of extra files not expected in destination */
  extra: number;
  /** Total number of files expected */
  expectedTotal: number;
  /** Files with issues (missing, size mismatch, or extra) */
  issues: VerifiedFile[];
  /** Paths that failed verification with error details */
  failed: FailedOperation[];
  /** Results from fix operations (only present when --fix is used) */
  fixResults?: FixResult;
  /** Conflict resolutions that occurred during the verification operation */
  conflictResolutions?: ConflictResolutionResult[];
}

/**
 * Represents the method used to create a file copy.
 */
export type CopyMethod = "hardlink" | "copy";

/**
 * Result from a single file copy operation.
 */
export interface FileCopyResult {
  /** Source file path */
  source: string;
  /** Destination file path */
  destination: string;
  /** Method used to create the copy */
  method: CopyMethod;
  /** Whether the operation was skipped (file exists) */
  skipped: boolean;
}

/**
 * Information about a legacy tracking file discovered on disk.
 */
export interface LegacyTrackingFileInfo {
  /** Full file path */
  path: string;
  /** Type of tracking file */
  type: "completed" | "failed";
  /** Options hash extracted from filename */
  hash: string;
  /** Number of entries in the file */
  entryCount: number;
  /** Original input file path (if determinable from sidecar) */
  inputFile?: string;
}

/**
 * Information about a legacy history file discovered on disk.
 */
export interface LegacyHistoryFileInfo {
  /** Full file path */
  path: string;
  /** Session ID extracted from filename */
  sessionId: string;
  /** Number of operation entries in the file */
  operationCount: number;
  /** Command name from header */
  command: string;
  /** Start timestamp from header */
  startedAt: string;
}

/**
 * Result from tracking file migration.
 */
export interface TrackingMigrationResult {
  /** Number of operations migrated */
  operations: number;
  /** Number of source entries migrated */
  sources: number;
  /** Legacy files that were processed */
  legacyFiles: LegacyTrackingFileInfo[];
}

/**
 * Result from history file migration.
 */
export interface HistoryMigrationResult {
  /** Number of sessions migrated */
  sessions: number;
  /** Number of operation entries migrated */
  operations: number;
  /** Legacy files that were processed */
  legacyFiles: LegacyHistoryFileInfo[];
}

/**
 * Result from deleting legacy files.
 */
export interface DeletionResult {
  /** Number of files successfully deleted */
  deleted: number;
  /** Errors encountered during deletion */
  errors: FailedOperation[];
}

/**
 * Result from the migrate-tracking command execution.
 */
export interface MigrateResult {
  /** Tracking migration results */
  tracking: TrackingMigrationResult;
  /** History migration results */
  history: HistoryMigrationResult;
  /** Number of legacy files deleted */
  filesDeleted: number;
  /** Errors encountered during migration or deletion */
  errors: FailedOperation[];
}

/**
 * Operation statistics grouped by command type.
 */
export interface OperationStats {
  /** Command name (e.g., "copy-album", "copy-filter") */
  command: string;
  /** Total number of operations */
  total: number;
  /** Number of completed operations */
  completed: number;
  /** Number of failed operations */
  failed: number;
  /** Number of partial operations */
  partial: number;
  /** Success rate as percentage (0-100) */
  successRate: number;
}

/**
 * Storage statistics grouped by rating range.
 */
export interface StorageByRating {
  /** Rating range label (e.g., "4-5 stars", "Unrated") */
  range: string;
  /** Number of files in this rating range */
  fileCount: number;
  /** Total size in bytes for this rating range */
  totalSize: number;
}

/**
 * Result from the stats command execution.
 */
export interface StatsResult {
  /** Operation statistics grouped by command */
  operations: OperationStats[];
  /** Total number of files tracked in inventory */
  totalFiles: number;
  /** Total storage size in bytes */
  totalSize: number;
  /** Storage breakdown by rating ranges */
  storageByRating: StorageByRating[];
  /** Success rate breakdown by mode (album and/or filter) */
  successRateByMode: { album?: number; filter?: number };
}

/**
 * Group of duplicate operations sharing the same options_hash.
 */
export interface DuplicateGroup {
  /** Options hash that is duplicated */
  optionsHash: string;
  /** Number of operations with this hash */
  count: number;
  /** IDs of operations in this duplicate group */
  operationIds: number[];
}

/**
 * Source path that has been processed in multiple operations.
 */
export interface DuplicateSource {
  /** Source path that appears in multiple operations */
  sourcePath: string;
  /** Number of operations that processed this source */
  operationCount: number;
}

/**
 * A single operation entry from history.
 */
export interface HistoryEntry {
  /** Operation ID */
  id: number;
  /** When the operation was created */
  createdAt: string;
  /** Command type */
  command: string;
  /** Copy mode (album or filter) */
  mode: string;
  /** Input file path (null for CLI arguments) */
  inputFile: string | null;
  /** Options hash for deduplication */
  optionsHash: string;
  /** Operation status */
  status: string;
  /** Total number of sources */
  totalSources: number;
  /** Number of completed sources */
  completedCount: number;
  /** Number of failed sources */
  failedCount: number;
  /** When processing started */
  startedAt: string;
  /** When processing ended (null if still running) */
  endedAt: string | null;
}

/**
 * Result from the history command execution.
 */
export interface HistoryResult {
  /** List of matching operation entries */
  entries: HistoryEntry[];
  /** Total count before limit was applied */
  totalCount: number;
  /** Duplicate operations (only present when --show-duplicates is used) */
  duplicates?: DuplicateGroup[];
  /** Duplicate sources (only present when --show-duplicates is used) */
  duplicateSources?: DuplicateSource[];
}

/**
 * Result from the delete command execution.
 */
export interface DeleteResult {
  /** Source path that was processed */
  source: string;
  /** Number of items (albums/tracks) deleted */
  deleted: number;
  /** Number of items that were skipped (not found or already deleted) */
  skipped: number;
  /** Number of database tracking entries removed */
  trackingRemoved: number;
  /** Paths that failed to delete with error details */
  failed: FailedOperation[];
}
