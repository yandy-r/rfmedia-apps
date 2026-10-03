/**
 * Undo action for rfmedia CLI.
 *
 * Implements the logic to reverse filesystem operations recorded
 * in history files. Operations are undone in LIFO (reverse) order.
 */

import { readdir, rmdir, unlink } from "node:fs/promises";
import pc from "picocolors";

import {
  listSessions,
  loadSession,
  updateSessionStatus,
  autoMigrateHistoryIfNeeded,
} from "../lib/history.js";
import { formatDryRun, logDebug, logError, logInfo, logSuccess, logWarn } from "../lib/logger.js";
import { pathExists } from "../lib/filesystem.js";
import { confirm } from "../lib/prompt.js";
import type { DbConnection } from "../types/db.js";
import type {
  HistoryEntry,
  HistorySession,
  UndoFailure,
  UndoOptions,
  UndoResult,
  UndoSessionResult,
} from "../types/index.js";

/**
 * Lists undoable sessions (status = 'pending').
 *
 * @param db - Optional database connection (enables database mode)
 * @returns Array of sessions that can be undone
 */
export async function listUndoableSessions(db?: DbConnection): Promise<HistorySession[]> {
  const sessions = await listSessions({ status: "pending" }, db);

  // Display sessions if not in JSON mode
  if (sessions.length > 0) {
    logInfo("Undoable sessions:");
    console.error("");

    for (const session of sessions) {
      const date = new Date(session.header.startedAt);
      const dateStr = date.toLocaleString();
      const ops = session.header.operationCount ?? "?";

      console.error(`  ${pc.cyan(session.id)}`);
      console.error(
        `    Command: ${session.header.command} | Operations: ${ops} | Date: ${dateStr}`,
      );
    }
  }

  return sessions;
}

/**
 * Undoes a single history entry.
 *
 * Undo logic by operation type:
 * - copy/hardlink/convert: Remove the destination file
 * - mkdir: Remove directory if empty and was actually created
 * - remove/trash: Cannot restore - warn and skip
 *
 * @param entry - History entry to undo
 * @param dryRun - If true, preview without executing
 * @throws Error if undo fails
 */
async function undoEntry(entry: HistoryEntry, dryRun: boolean): Promise<void> {
  switch (entry.op) {
    case "copy":
    case "hardlink":
    case "convert": {
      const destPath = entry.dest;

      if (!(await pathExists(destPath))) {
        logDebug(`Already removed: ${destPath}`);
        return;
      }

      if (dryRun) {
        logInfo(formatDryRun(`remove: ${destPath}`));
        return;
      }

      await unlink(destPath);
      logDebug(`Removed: ${destPath}`);
      break;
    }

    case "mkdir": {
      const dirPath = entry.dest;

      // Only remove if we actually created it
      if (!entry.created) {
        logDebug(`Directory existed before, not removing: ${dirPath}`);
        return;
      }

      if (!(await pathExists(dirPath))) {
        logDebug(`Directory already removed: ${dirPath}`);
        return;
      }

      // Only remove if empty
      const contents = await readdir(dirPath);
      if (contents.length > 0) {
        logDebug(`Directory not empty, skipping: ${dirPath}`);
        return;
      }

      if (dryRun) {
        logInfo(formatDryRun(`rmdir: ${dirPath}`));
        return;
      }

      await rmdir(dirPath);
      logDebug(`Removed directory: ${dirPath}`);
      break;
    }

    case "remove":
    case "trash": {
      // Cannot restore permanently deleted files
      logWarn(`Cannot restore ${entry.op}ed file: ${entry.dest}`);
      break;
    }
  }
}

/**
 * Undoes all operations in a session in reverse order.
 *
 * @param session - Session to undo
 * @param dryRun - If true, preview without executing
 * @param db - Optional database connection (enables database mode)
 * @returns Result with counts and failures
 */
async function undoSession(
  session: HistorySession,
  dryRun: boolean,
  db?: DbConnection,
): Promise<UndoSessionResult> {
  const failures: UndoFailure[] = [];
  let undoneCount = 0;

  logInfo(`Undoing session: ${session.id} (${session.entries.length} operations)`);

  // Process entries in reverse order (LIFO)
  const reversedEntries = [...session.entries].reverse();

  for (const entry of reversedEntries) {
    try {
      await undoEntry(entry, dryRun);
      undoneCount++;
    } catch (err) {
      const error = err as Error & { code?: string };
      failures.push({
        entry,
        error: error.message,
        code: error.code,
      });
      logWarn(`Failed to undo ${entry.op}: ${error.message}`);
    }
  }

  // Update session status (unless dry-run)
  if (!dryRun) {
    const status =
      failures.length === 0
        ? "undone"
        : failures.length === reversedEntries.length
          ? "pending" // All failed - keep as pending
          : "partial";

    await updateSessionStatus(session.id, status, db);
  }

  // Determine overall status
  let status: "success" | "partial" | "failed" | "skipped";
  if (failures.length === 0) {
    status = "success";
    logSuccess(`  Undone: ${undoneCount} operations`);
  } else if (failures.length === reversedEntries.length) {
    status = "failed";
    logError(`  Failed: all ${failures.length} operations`);
  } else {
    status = "partial";
    logWarn(`  Partial: ${undoneCount} undone, ${failures.length} failed`);
  }

  return {
    sessionId: session.id,
    status,
    undone: undoneCount,
    failed: failures,
  };
}

/**
 * Formats a session for display in confirmation prompt.
 *
 * @param session - Session to format
 * @returns Formatted string
 */
function formatSessionForConfirmation(session: HistorySession): string {
  const date = new Date(session.header.startedAt);
  const ops = session.header.operationCount ?? session.entries.length;
  return `  ${pc.cyan(session.id)}: ${session.header.command} (${ops} ops) - ${date.toLocaleString()}`;
}

/**
 * Executes the undo operation.
 *
 * @param options - Undo options
 * @param db - Optional database connection (enables database mode)
 * @returns Overall result with all session results
 */
export async function executeUndo(options: UndoOptions, db?: DbConnection): Promise<UndoResult> {
  const { last, session: sessionId, dryRun, force } = options;

  // Auto-migrate legacy history files if using database
  if (db) {
    await autoMigrateHistoryIfNeeded(db);
  }

  // Get sessions to undo
  let sessionsToUndo: HistorySession[];

  if (sessionId) {
    // Load specific session
    const session = await loadSession(sessionId, db);

    if (session.header.status !== "pending") {
      logWarn(`Session ${sessionId} has already been undone (status: ${session.header.status})`);
      return {
        sessions: [{ sessionId, status: "skipped", undone: 0, failed: [] }],
        totalUndone: 0,
        totalFailed: 0,
        totalSkipped: 1,
      };
    }

    sessionsToUndo = [session];
  } else {
    // Get last N pending sessions
    const pendingSessions = await listSessions({ status: "pending", limit: last }, db);

    if (pendingSessions.length === 0) {
      logInfo("No undoable sessions found");
      return {
        sessions: [],
        totalUndone: 0,
        totalFailed: 0,
        totalSkipped: 0,
      };
    }

    // Load full sessions with entries
    sessionsToUndo = [];
    for (const sessionInfo of pendingSessions) {
      const fullSession = await loadSession(sessionInfo.id, db);
      sessionsToUndo.push(fullSession);
    }
  }

  // Show what will be undone
  logInfo(`Found ${sessionsToUndo.length} session(s) to undo:`);
  console.error("");
  for (const session of sessionsToUndo) {
    console.error(formatSessionForConfirmation(session));
  }
  console.error("");

  // Confirm unless --force or --dry-run
  if (!force && !dryRun) {
    const confirmed = await confirm("Proceed with undo?");
    if (!confirmed) {
      logInfo("Undo cancelled");
      return {
        sessions: sessionsToUndo.map((s) => ({
          sessionId: s.id,
          status: "skipped",
          undone: 0,
          failed: [],
        })),
        totalUndone: 0,
        totalFailed: 0,
        totalSkipped: sessionsToUndo.length,
      };
    }
  }

  if (dryRun) {
    logWarn("[DRY-RUN] Previewing undo operations...");
    console.error("");
  }

  // Process each session
  const results: UndoSessionResult[] = [];
  let totalUndone = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const session of sessionsToUndo) {
    console.error(""); // Spacing between sessions
    const result = await undoSession(session, dryRun, db);
    results.push(result);

    totalUndone += result.undone;
    totalFailed += result.failed.length;
    if (result.status === "skipped") {
      totalSkipped++;
    }
  }

  // Log summary
  console.error("");
  logInfo("=== Undo Summary ===");
  logInfo(`Sessions: ${sessionsToUndo.length} processed`);
  logInfo(`Operations: ${totalUndone} undone, ${totalFailed} failed`);

  if (dryRun) {
    logWarn("[DRY-RUN] No actual changes were made");
  }

  return {
    sessions: results,
    totalUndone,
    totalFailed,
    totalSkipped,
  };
}
