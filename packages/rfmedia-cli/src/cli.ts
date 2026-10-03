/**
 * rfmedia CLI - Main CLI module.
 *
 * Media file management CLI for music library operations.
 *
 * Note: This is no longer the entry point - see bootstrap.ts for the actual entry.
 * The bootstrap handles secrets re-execution before importing this module.
 *
 * Features:
 * - Album copying with numbered suffixes (Artist-001, Artist-002, etc.)
 * - Rating-based track filtering (smart filters with nested boolean logic)
 * - Audio format conversion via FFmpeg (ALAC, MP3, AAC, Opus)
 * - Incremental sync with database-backed tracking
 * - Directory watching with file system events
 * - Empty directory cleanup
 * - Undo support with operation history
 * - Plex Media Server library scanning integration
 * - Queue management for batch operations
 *
 * Configuration:
 * - .rfmedia.yaml in current or parent directory
 * - ~/.rfmedia/tracking.db for operation tracking
 * - ~/.rfmedia/history/ for undo history (legacy mode)
 *
 * @see packages/rfmedia-cli/README.md for usage documentation
 * @see docs/features/smart-filters.md for filter syntax
 * @module rfmedia-cli/cli
 */

import { Command, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { setDebugMode, setJsonMode, isDebugMode, logDebug } from "./lib/logger.js";
import { setOutputFormat, logWarn, OUTPUT_FORMATS, isValidOutputFormat } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";
import { loadConfig } from "./lib/config.js";
import { InvalidOutputFormatError } from "./lib/errors.js";
import { registerRfmediaErrorFormatters } from "./lib/error-formatters.js";
import { setLoadedConfig } from "./lib/loaded-config.js";
import { getPluginManager } from "./lib/plugin-manager.js";
import { cleanCommand } from "./commands/clean.js";
import { completionCommand } from "./commands/completion.js";
import { copyCommand } from "./commands/copy.js";
import { deleteCommand } from "./commands/delete.js";
import { filterCommand } from "./commands/filter.js";
import { historyCommand } from "./commands/history.js";
import { initCommand } from "./commands/init.js";
import { lidarrCommand } from "./commands/lidarr.js";
import { linkVideosCommand } from "./commands/link-videos.js";
import { migrateCommand } from "./commands/migrate.js";
import { playlistCommand } from "./commands/playlist.js";
import { plexCommand } from "./commands/plex.js";
import { pluginCommand } from "./commands/plugin.js";
import { queueCommand } from "./commands/queue.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { statsCommand } from "./commands/stats.js";
import { syncCommand } from "./commands/sync.js";
import { undoCommand } from "./commands/undo.js";
import { verifyCommand } from "./commands/verify.js";
import { watchCommand } from "./commands/watch.js";

// Register rfmedia-specific error formatters early, before any errors can occur
registerRfmediaErrorFormatters();

// Re-export getLoadedConfig for backwards compatibility
export { getLoadedConfig } from "./lib/loaded-config.js";

/**
 * Main CLI program instance
 * Exported for testing purposes
 */
export const program = new Command();

program
  .name("rfmedia")
  .description("Media file management CLI for copying albums and cleaning empty directories")
  .version(pkg.version);

// Global options available to all subcommands
// Note: --dry-run is NOT a global option - each subcommand defines its own
// to ensure proper option parsing at the subcommand level
program
  .option("--debug", "Enable debug output")
  .option("--json", "Output in JSON format")
  .option("--use-dotenvx <file>", "Use dotenvx for secrets injection")
  .option("--use-op <file>", "Use 1Password CLI for secrets injection")
  .addOption(
    new Option("--output <format>", "Output format (json, yaml, csv, table, text)")
      .argParser(parseOutputFormatArg)
      .default("text"),
  );

/**
 * Parse and validate the global --output argument.
 * Throws typed error so formatter/suggestion pipeline remains consistent.
 */
export function parseOutputFormatArg(value: string): OutputFormat {
  if (!isValidOutputFormat(value)) {
    throw new InvalidOutputFormatError(value, OUTPUT_FORMATS);
  }
  return value;
}

/**
 * Walk up to the root command (program) so we can check global option source.
 * Global --output is only on the root; subcommands like playlist create use --output for path.
 */
function getRootCommand(cmd: Command): Command {
  let root: Command = cmd;
  while (root.parent) {
    root = root.parent;
  }
  return root;
}

/** Offline reconciliation loads origins while deliberately preserving secret templates. */
export function isCredentialFreeOfflineReconcile(actionCommand: Command): boolean {
  return (
    actionCommand.name() === "reconcile" &&
    actionCommand.parent?.name() === "lidarr" &&
    actionCommand.opts()["offline"] === true
  );
}

/** Policy commands whose durable suppressions require authoritative config loading. */
export function isStrictPolicyConfigCommand(actionCommand: Command): boolean {
  const parent = actionCommand.parent;
  const lidarr = parent?.name() === "policy" ? parent.parent : parent;
  const root = lidarr?.parent;
  const exactRoot = root?.name() === "rfmedia" && root.parent == null;

  if (!exactRoot || lidarr?.name() !== "lidarr") {
    return false;
  }
  if (parent?.name() === "policy") {
    return actionCommand.name() === "evaluate" || actionCommand.name() === "plan";
  }
  return actionCommand.name() === "sync-ratings";
}

// Hook to load config and set global modes before command execution
program.hook("preAction", async (thisCommand, actionCommand) => {
  // Commands that don't require config loading
  const configOptionalCommands = ["completion", "init"];

  // Check if this is a subcommand that doesn't need config
  // For subcommands, check the child command name; for root, check args
  let commandName = thisCommand.name();

  // If this is the root command, check which subcommand is being invoked
  if (commandName === "rfmedia") {
    const args = thisCommand.args || [];
    if (args.length > 0 && typeof args[0] === "string") {
      commandName = args[0];
    }
  }

  const shouldLoadConfig = !configOptionalCommands.includes(commandName);
  const credentialFreeOffline = isCredentialFreeOfflineReconcile(actionCommand);
  const strictPolicyConfig = isStrictPolicyConfigCommand(actionCommand);

  // Load config once at top-level command (skip for config-optional commands)
  if (shouldLoadConfig && (!thisCommand.parent || thisCommand.parent === program)) {
    const result = await loadConfig({
      resolveSecrets: !credentialFreeOffline,
      failOnInvalid: strictPolicyConfig,
    });
    setLoadedConfig(result.config);

    // Apply global.debug from config if not overridden by CLI
    if (result.config.global?.debug) {
      setDebugMode(true);
    }

    // Initialize plugin manager (lazy - doesn't block if plugins disabled)
    if (!credentialFreeOffline) {
      try {
        await getPluginManager().initialize(result.config.plugins);
      } catch (err) {
        // Log but don't fail CLI startup for plugin errors
        if (isDebugMode()) {
          logDebug(`Plugin initialization warning: ${err}`);
        }
      }
    }
  }

  // Apply CLI options (these override config)
  const opts = thisCommand.opts();
  if (opts["debug"]) {
    setDebugMode(true);
  }
  if (opts["json"]) {
    setJsonMode(true);
  }

  // Reconcile --json and global --output format flags.
  // Only consider --output as the format when it was provided on the root command;
  // subcommands (e.g. playlist create) use -o/--output for other purposes (file path).
  const jsonFlag = opts["json"] as boolean | undefined;
  const root = getRootCommand(thisCommand);
  const globalOutputFromCli = root.getOptionValueSource("output") === "cli";
  const outputFlagFromRoot = globalOutputFromCli
    ? (root.opts()["output"] as OutputFormat | undefined)
    : undefined;

  let resolvedOutput: OutputFormat;

  if (jsonFlag && globalOutputFromCli && outputFlagFromRoot !== undefined) {
    // Both --json and global --output passed: --output takes precedence
    if (outputFlagFromRoot !== "json") {
      logWarn("Both --json and --output specified; --output takes precedence");
    }
    resolvedOutput = outputFlagFromRoot;
  } else if (jsonFlag) {
    // Only --json passed: set output to "json"
    resolvedOutput = "json";
  } else if (globalOutputFromCli && outputFlagFromRoot) {
    // Only global --output passed: use the specified format
    resolvedOutput = outputFlagFromRoot;
  } else {
    resolvedOutput = "text";
  }

  if (!isValidOutputFormat(resolvedOutput)) {
    throw new InvalidOutputFormatError(resolvedOutput, OUTPUT_FORMATS);
  }

  opts["output"] = resolvedOutput;
  setOutputFormat(resolvedOutput);
});

// Register subcommands
program.addCommand(cleanCommand);
program.addCommand(completionCommand);
program.addCommand(copyCommand);
program.addCommand(deleteCommand);
program.addCommand(filterCommand);
program.addCommand(historyCommand);
program.addCommand(initCommand);
program.addCommand(lidarrCommand);
program.addCommand(linkVideosCommand);
program.addCommand(migrateCommand);
program.addCommand(playlistCommand);
program.addCommand(plexCommand);
program.addCommand(pluginCommand);
program.addCommand(queueCommand);
program.addCommand(reconcileCommand);
program.addCommand(statsCommand);
program.addCommand(syncCommand);
program.addCommand(undoCommand);
program.addCommand(verifyCommand);
program.addCommand(watchCommand);
program
  .command("mcp")
  .description("Run the rfmedia MCP server over stdio")
  .action(async () => {
    const { runRfmediaMcpServer } = await import("./mcp/server.js");
    runRfmediaMcpServer();
  });

// Note: Secrets re-execution is now handled in bootstrap.ts before this module loads.
// This ensures environment variables are injected before any module initialization.

// Only parse if this module is run directly (e.g., in tests)
// In production, bootstrap.ts imports this module and calls program.parseAsync()
if (import.meta.url === `file://${process.argv[1]}`) {
  await program.parseAsync(process.argv);
}
