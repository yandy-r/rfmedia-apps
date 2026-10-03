/**
 * Playlist command definition for rfmedia CLI.
 *
 * This module defines the playlist command for managing M3U playlist generation
 * from filters and Plex playlists.
 *
 * Subcommands:
 * - `playlist create` - Create a new M3U playlist from a filter or Plex playlist
 * - `playlist update` - Update existing playlist(s) by re-evaluating source
 * - `playlist list` - List all saved smart playlists
 * - `playlist show` - Show details and history for a smart playlist
 * - `playlist delete` - Delete a saved smart playlist
 */

import { Command, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat } from "@rfmedia/common";

import { logError } from "../lib/logger.js";
import type { DbSmartPlaylist } from "../types/db.js";
import type { GlobalOptions } from "../types/options.js";
import type { PlaylistShowResult } from "../types/playlist.js";

/**
 * Playlist command - parent for subcommands.
 *
 * Provides M3U playlist generation from filters and Plex playlists.
 */
export const playlistCommand = new Command("playlist").description(
  "Manage M3U playlist generation from filters and Plex playlists",
);

/**
 * playlist create <name> - Create a new M3U playlist.
 *
 * Creates a playlist from either a named filter (evaluated against local audio metadata)
 * or an existing Plex playlist (fetched via API).
 *
 * Exactly one of --filter or --plex-playlist must be provided.
 */
playlistCommand
  .command("create <name>")
  .description("Create a new M3U playlist")
  .requiredOption("-o, --output <path>", "Output file path for M3U playlist")
  .addOption(
    new Option("-f, --filter <name>", "Named filter from config").conflicts("plex-playlist"),
  )
  .addOption(new Option("-p, --plex-playlist <name>", "Plex playlist name").conflicts("filter"))
  .option("-r, --relative", "Use relative paths in playlist", false)
  .option("--base-dir <path>", "Base directory for relative paths")
  .option("--force", "Overwrite existing playlist file", false)
  .option("--dry-run", "Preview without writing files", false)
  .option("--json", "Output in JSON format", false)
  .action(async (name: string, options: Record<string, unknown>) => {
    // Validate that exactly one of --filter or --plex-playlist is provided
    const hasFilter = options["filter"] !== undefined;
    const hasPlexPlaylist = options["plexPlaylist"] !== undefined;

    if (!hasFilter && !hasPlexPlaylist) {
      console.error("Error: One of --filter or --plex-playlist is required");
      process.exitCode = 1;
      return;
    }

    const { executePlaylistCreate } = await import("../actions/playlist.js");
    await executePlaylistCreate({
      name,
      output: options["output"] as string,
      filter: options["filter"] as string | undefined,
      plexPlaylist: options["plexPlaylist"] as string | undefined,
      relative: options["relative"] as boolean,
      baseDir: options["baseDir"] as string | undefined,
      force: options["force"] as boolean,
      dryRun: options["dryRun"] as boolean,
      json: options["json"] as boolean,
    });
  });

/**
 * playlist update [name] - Update existing playlist(s).
 *
 * Re-evaluates the source (filter or Plex playlist) and regenerates the M3U file.
 * Can update a specific playlist by name or all playlists with --all.
 */
playlistCommand
  .command("update [name]")
  .description("Update existing playlist(s) by re-evaluating source")
  .option("-a, --all", "Update all saved playlists", false)
  .option("--json", "Output in JSON format", false)
  .action(async (name: string | undefined, options: Record<string, unknown>) => {
    const { executePlaylistUpdate } = await import("../actions/playlist.js");
    await executePlaylistUpdate({
      name,
      all: options["all"] as boolean,
      json: options["json"] as boolean,
    });
  });

/**
 * playlist list - List all saved smart playlists.
 *
 * Shows a summary of all saved playlists including source type, track count,
 * and last update time.
 */
playlistCommand
  .command("list")
  .description("List all saved smart playlists")
  .option("--json", "Output in JSON format", false)
  .action(async (options: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = playlistCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { listSmartPlaylists } = await import("../actions/playlist.js");
      const playlists = await listSmartPlaylists({
        json: options["json"] as boolean,
      });

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, {
          command: "playlist list",
          result: {
            count: playlists.length,
            playlists: playlists.map((p) => ({
              name: p.name,
              sourceType: p.source_type,
              sourceName: p.source_name,
              trackCount: p.track_count,
              outputPath: p.output_path,
              relativePaths: p.relative_paths === 1,
              createdAt: p.created_at,
              updatedAt: p.updated_at,
            })),
          },
        });
      } else {
        formatPlaylistListOutput(playlists);
      }
    } catch (error) {
      logError(`Playlist list failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * playlist show <name> - Show details for a smart playlist.
 *
 * Displays the playlist configuration and generation history.
 */
playlistCommand
  .command("show <name>")
  .description("Show details and history for a smart playlist")
  .option("--json", "Output in JSON format", false)
  .action(async (name: string, options: Record<string, unknown>) => {
    // Get global options from parent command
    const globalOpts = playlistCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { showSmartPlaylist } = await import("../actions/playlist.js");
      const result = await showSmartPlaylist(name, {
        json: options["json"] as boolean,
      });

      // Format console output if not in machine format
      const format = globalOpts?.output ?? "text";
      if (!isMachineFormat(format)) {
        formatPlaylistShowOutput(result);
      }
    } catch (error) {
      logError(`Playlist show failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * playlist delete <name> - Delete a saved smart playlist.
 *
 * Removes the playlist definition from the database. Optionally also
 * deletes the M3U file from disk.
 */
playlistCommand
  .command("delete <name>")
  .description("Delete a saved smart playlist")
  .option("-f, --force", "Skip confirmation prompt", false)
  .option("--delete-file", "Also delete the M3U file", false)
  .action(async (name: string, options: Record<string, unknown>) => {
    const { deleteSmartPlaylist } = await import("../actions/playlist.js");
    await deleteSmartPlaylist(name, {
      force: options["force"] as boolean,
      deleteFile: options["deleteFile"] as boolean,
    });
  });

// ============================================================================
// Console Formatting Helpers
// ============================================================================

/**
 * Maximum display widths for table columns.
 */
const MAX_NAME_WIDTH = 30;
const MAX_SOURCE_WIDTH = 25;

/**
 * Formats playlist list result for console output using tables.
 *
 * @param playlists - Array of playlist records from database
 */
function formatPlaylistListOutput(playlists: DbSmartPlaylist[]): void {
  console.error("");
  console.error(pc.bold("Smart Playlists"));
  console.error(pc.dim("─".repeat(60)));

  if (playlists.length === 0) {
    console.error("");
    console.error(pc.yellow("No smart playlists found"));
    console.error("");
    return;
  }

  console.error("");

  const table = new Table({
    columns: [
      { name: "name", title: "Name", alignment: "left" },
      { name: "type", title: "Type", alignment: "left" },
      { name: "source", title: "Source", alignment: "left" },
      { name: "tracks", title: "Tracks", alignment: "right" },
      { name: "updated", title: "Updated", alignment: "left" },
    ],
  });

  for (const playlist of playlists) {
    table.addRow({
      name: truncateString(playlist.name, MAX_NAME_WIDTH),
      type: playlist.source_type,
      source: truncateString(playlist.source_name, MAX_SOURCE_WIDTH),
      tracks: playlist.track_count,
      updated: formatRelativeTime(playlist.updated_at),
    });
  }

  console.error(table.render());
  console.error("");
}

/**
 * Truncates a string to a maximum length with ellipsis.
 *
 * @param str - String to truncate
 * @param maxLength - Maximum length
 * @returns Truncated string
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Formats an ISO timestamp as a relative time string.
 *
 * Examples:
 * - "just now" for < 1 minute
 * - "5m ago" for minutes
 * - "2h ago" for hours
 * - "yesterday" for 1 day ago
 * - "3d ago" for days < 7
 * - "Jan 15" for older dates
 *
 * @param isoTimestamp - ISO timestamp string
 * @returns Relative time string
 */
function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  } else if (diffHours < 24) {
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return "yesterday";
  } else if (diffDays < 7) {
    return `${diffDays}d ago`;
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

/**
 * Formats a timestamp for display in history table.
 *
 * Shows "today HH:MM" for same-day entries, otherwise "Mon DD HH:MM".
 *
 * @param isoTimestamp - ISO timestamp string
 * @returns Formatted date/time string
 */
function formatHistoryTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const now = new Date();

  // Check if same day
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  if (isToday) {
    return `today ${time}`;
  }

  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${dateStr} ${time}`;
}

/**
 * Formats playlist show result for styled console output.
 *
 * Displays:
 * - Styled header with playlist name
 * - Key-value pairs for playlist properties
 * - Table for generation history
 *
 * @param result - Playlist show result from action
 */
function formatPlaylistShowOutput(result: PlaylistShowResult): void {
  const { playlist, history } = result;

  // Styled header
  console.error("");
  console.error(pc.bold(`Playlist: ${pc.cyan(playlist.name)}`));
  console.error("");

  // Key-value pairs with consistent alignment
  const labelWidth = 14;
  const formatRow = (label: string, value: string): void => {
    console.error(`  ${label.padEnd(labelWidth)}${value}`);
  };

  formatRow("Source Type:", playlist.source_type);
  formatRow("Source Name:", playlist.source_name);
  formatRow("Track Count:", String(playlist.track_count));
  formatRow("Output Path:", playlist.output_path);
  formatRow("Relative:", playlist.relative_paths === 1 ? "Yes" : "No");
  formatRow("Created:", formatRelativeTime(playlist.created_at));
  formatRow("Updated:", formatRelativeTime(playlist.updated_at));

  // Generation history section
  console.error("");
  console.error(pc.bold("Generation History"));
  console.error(pc.dim("─".repeat(30)));

  if (history.length === 0) {
    console.error("");
    console.error(pc.dim("No generation history"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "date", title: "Date", alignment: "left" },
      { name: "tracks", title: "Tracks", alignment: "right" },
    ],
  });

  for (const entry of history) {
    table.addRow({
      date: formatHistoryTimestamp(entry.generatedAt),
      tracks: entry.trackCount,
    });
  }

  console.error(table.render());
  console.error("");
}
