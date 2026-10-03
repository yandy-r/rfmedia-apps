/**
 * Undo command for rfmedia CLI.
 *
 * Provides functionality to reverse recent copy/clean operations
 * by reading history files and undoing filesystem changes.
 */

import { Command } from "commander";

import { isMachineFormat } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import type { UndoOptions } from "../types/index.js";

/**
 * Undo command definition.
 *
 * Usage:
 *   rfmedia undo                    # Undo last session
 *   rfmedia undo --last=3           # Undo last 3 sessions
 *   rfmedia undo --session=<id>     # Undo specific session
 *   rfmedia undo --list             # List available sessions
 */
export const undoCommand = new Command("undo")
  .description("Undo recent copy/clean operations")
  .option("-l, --last <N>", "Number of recent sessions to undo", "1")
  .option("-s, --session <id>", "Undo specific session by ID")
  .option("--list", "List undoable sessions without undoing")
  .option("-f, --force", "Skip confirmation prompt")
  .action(async (opts, command) => {
    // Get global options from parent command
    const globalOpts = command.optsWithGlobals() as { dryRun?: boolean; output?: OutputFormat };

    // Parse options
    const options: UndoOptions = {
      last: parseInt(opts["last"] as string, 10) || 1,
      session: opts["session"] as string | undefined,
      list: (opts["list"] as boolean) ?? false,
      dryRun: globalOpts.dryRun ?? false,
      force: (opts["force"] as boolean) ?? false,
    };

    // Validate options
    if (options.session && options.last !== 1) {
      console.error("Error: Cannot use --session with --last");
      process.exit(1);
    }

    // Lazy load action handler and dependencies
    const { executeUndo, listUndoableSessions } = await import("../actions/undo.js");
    const { logError, logSuccess } = await import("../lib/logger.js");
    const { loadConfig } = await import("../lib/config.js");
    const { shouldUseUndoLegacyMode, resolveUndoDatabasePath } = await import("../lib/config.js");
    const { initializeDatabase, closeDatabase } = await import("../lib/db.js");

    try {
      // Initialize database for undo (if not using legacy mode)
      const config = await loadConfig();
      const useLegacy = shouldUseUndoLegacyMode(config.config);
      let db: Awaited<ReturnType<typeof initializeDatabase>> | undefined;

      if (!useLegacy) {
        const dbPath = resolveUndoDatabasePath(config.config);
        db = await initializeDatabase(dbPath);
      }

      if (options.list) {
        // List mode - show available sessions
        const sessions = await listUndoableSessions(db);

        const format = globalOpts?.output ?? "text";
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(format, {
            success: true,
            sessions: sessions.map((s) => ({
              id: s.id,
              command: s.header.command,
              startedAt: s.header.startedAt,
              operationCount: s.header.operationCount,
              status: s.header.status,
            })),
          });
        } else if (sessions.length === 0) {
          logSuccess("No undoable sessions found");
        }

        if (db) {
          closeDatabase(db);
        }

        return;
      }

      // Execute undo
      const result = await executeUndo(options, db);

      if (db) {
        closeDatabase(db);
      }

      const resultFormat = globalOpts?.output ?? "text";
      if (isMachineFormat(resultFormat)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(resultFormat, {
          success: result.totalFailed === 0,
          ...result,
        });
      }

      // Exit with error if any failures
      if (result.totalFailed > 0) {
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(message);

      const errorFormat = globalOpts?.output ?? "text";
      if (isMachineFormat(errorFormat)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(errorFormat, {
          success: false,
          error: message,
        });
      }

      process.exit(1);
    }
  });
