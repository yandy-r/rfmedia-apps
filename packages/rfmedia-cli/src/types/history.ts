/**
 * Type definitions for operation history tracking and undo functionality.
 *
 * The history system logs filesystem operations to JSONL files for later undo.
 * Each session represents a single command invocation with its operations.
 */

import type { ConvertFormat } from "./options.js";

/**
 * Operation types that can be undone.
 */
export type HistoryOperationType = "copy" | "hardlink" | "convert" | "mkdir" | "remove" | "trash";

/**
 * Session status for undo tracking.
 * - pending: Session has not been undone
 * - undone: Session was fully undone
 * - partial: Session was partially undone (some operations failed)
 */
export type SessionStatus = "pending" | "undone" | "partial";

/**
 * History entry for a file copy operation.
 */
export interface CopyHistoryEntry {
  op: "copy";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Source file path */
  src: string;
  /** Destination file path (created by this operation) */
  dest: string;
}

/**
 * History entry for a hardlink operation.
 */
export interface HardlinkHistoryEntry {
  op: "hardlink";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Source file path */
  src: string;
  /** Destination file path (link created by this operation) */
  dest: string;
}

/**
 * History entry for a file conversion operation.
 */
export interface ConvertHistoryEntry {
  op: "convert";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Source file path */
  src: string;
  /** Destination file path (converted file created by this operation) */
  dest: string;
  /** Audio format the file was converted to */
  fmt: ConvertFormat;
}

/**
 * History entry for a directory creation operation.
 */
export interface MkdirHistoryEntry {
  op: "mkdir";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Directory path that was created */
  dest: string;
  /** True if directory was actually created (didn't exist before) */
  created: boolean;
}

/**
 * History entry for a file/directory removal operation.
 */
export interface RemoveHistoryEntry {
  op: "remove";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Path that was removed */
  dest: string;
}

/**
 * History entry for a file/directory trash operation.
 */
export interface TrashHistoryEntry {
  op: "trash";
  /** ISO timestamp when operation occurred */
  at: string;
  /** Path that was moved to trash */
  dest: string;
}

/**
 * Discriminated union of all history entry types.
 */
export type HistoryEntry =
  | CopyHistoryEntry
  | HardlinkHistoryEntry
  | ConvertHistoryEntry
  | MkdirHistoryEntry
  | RemoveHistoryEntry
  | TrashHistoryEntry;

/**
 * Session header stored as the first line of a JSONL history file.
 * Contains metadata about the command session.
 */
export interface HistorySessionHeader {
  /** Marker to identify this as a header line */
  _header: true;
  /** History format version for compatibility */
  version: string;
  /** Command that was executed (e.g., "copy", "clean") */
  command: string;
  /** ISO timestamp when session started */
  startedAt: string;
  /** ISO timestamp when session ended (set on close) */
  endedAt?: string;
  /** Current status of the session */
  status: SessionStatus;
  /** Working directory when command was run */
  cwd: string;
  /** Total number of operations recorded (set on close) */
  operationCount?: number;
}

/**
 * Parsed history session with all entries loaded.
 * Supports both legacy (JSONL file) and database modes.
 */
export interface HistorySession {
  /** Session ID (derived from filename or database session_id) */
  id: string;
  /** Absolute path to the session file (legacy mode only) */
  filePath?: string;
  /** Session header with metadata */
  header: HistorySessionHeader;
  /** All recorded operations in order */
  entries: HistoryEntry[];
  /** Database session ID (database mode only) */
  dbSessionId?: number;
}

/**
 * Options for the undo command.
 */
export interface UndoOptions {
  /** Number of recent sessions to undo (default: 1) */
  last: number;
  /** Specific session ID to undo */
  session?: string;
  /** List available sessions without undoing */
  list: boolean;
  /** Preview undo without executing */
  dryRun: boolean;
  /** Skip confirmation prompt */
  force: boolean;
}

/**
 * Result of undoing a single operation.
 */
export interface UndoFailure {
  /** The entry that failed to undo */
  entry: HistoryEntry;
  /** Error message */
  error: string;
  /** Error code if available */
  code?: string;
}

/**
 * Result of undoing a single session.
 */
export interface UndoSessionResult {
  /** Session ID */
  sessionId: string;
  /** Overall status of the undo operation */
  status: "success" | "partial" | "failed" | "skipped";
  /** Number of operations successfully undone */
  undone: number;
  /** List of operations that failed to undo */
  failed: UndoFailure[];
}

/**
 * Overall result of the undo command.
 */
export interface UndoResult {
  /** Results for each session processed */
  sessions: UndoSessionResult[];
  /** Total operations undone across all sessions */
  totalUndone: number;
  /** Total operations that failed across all sessions */
  totalFailed: number;
  /** Total sessions skipped (already undone, etc.) */
  totalSkipped: number;
}

/**
 * Options for listing history sessions.
 */
export interface ListSessionsOptions {
  /** Maximum number of sessions to return */
  limit?: number;
  /** Filter by status */
  status?: SessionStatus;
  /** Filter by command name */
  command?: string;
}
