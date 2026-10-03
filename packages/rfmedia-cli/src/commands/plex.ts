/**
 * Plex command definition for rfmedia CLI.
 *
 * This module defines the plex command for Plex Media Server operations.
 * Currently supports querying Plex libraries with various filters.
 *
 * Subcommands:
 * - `plex query run` - Query Plex library with filters for ratings, genres, years, and play counts
 * - `plex query list` - List saved Plex queries from the database
 */

import { Command, Option, InvalidArgumentError } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { logError, logInfo, logWarn, logSuccess } from "../lib/logger.js";
import { ratingToStars, formatDuration, truncate } from "../lib/format.js";
import {
  getTerminalWidth,
  calculateColumnWidths,
  truncateToWidth,
  type ColumnDef,
} from "../lib/terminal-table.js";
import { parseRange } from "../lib/range.js";
import { plexAuthCommand } from "./plex-auth.js";
import type { PlexQueryActionResult } from "../actions/plex-query.js";
import { mediaTypeFromMetadataTypeCode } from "../types/plex.js";
import type { GlobalOptions } from "../types/options.js";
import type {
  PlexQueryResult,
  PlexAlbumQueryResult,
  PlexArtistQueryResult,
  MetadataSyncResult,
  SyncDirection,
  PlexCollection,
  PlexMediaType,
} from "../types/plex.js";
import type { DbPlexQuery, PlexQueryListOptions } from "../types/db.js";

/**
 * Parses and validates a star rating argument.
 * Ensures the rating is between 1 and 5 (inclusive).
 *
 * @param value - The raw string value from the CLI
 * @returns The parsed rating as a number
 * @throws InvalidArgumentError if the rating is out of range
 */
function parseStarRating(value: string): number {
  const rating = parseFloat(value);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    throw new InvalidArgumentError("Rating must be between 1 and 5");
  }
  return rating;
}

/**
 * Parses and validates a float argument.
 * Used for star ratings in collection commands.
 *
 * @param value - The raw string value from the CLI
 * @param optionName - Name of the option for error messages
 * @returns The parsed float as a number
 * @throws InvalidArgumentError if the value is not a valid number
 */
function parseFloatArg(value: string, optionName: string = "value"): number {
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new InvalidArgumentError(`${optionName} must be a valid number`);
  }
  return parsed;
}

/**
 * Parses and validates a positive integer argument.
 * Ensures the value is a positive integer greater than 0.
 *
 * @param value - The raw string value from the CLI
 * @returns The parsed integer as a number
 * @throws InvalidArgumentError if the value is not a positive integer
 */
function parsePositiveInt(value: string): number {
  // Ensure the value is composed only of digits (no signs, spaces, or decimals)
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return parsed;
}

/** Result of parsing --year for playlist create/add (exact year or range). */
interface YearFilterParsed {
  year?: number;
  minYear?: number;
  maxYear?: number;
}

/**
 * Parses --year value into Plex query fields.
 * Supports: exact year (2020), >=year (>=2020), <year (<2000), range (2020-2023).
 *
 * @param value - Raw string from CLI
 * @returns Object with year, minYear, and/or maxYear for queryOptions
 */
function parseYearFilter(value: string): YearFilterParsed {
  const s = value.trim();
  const gte = /^>=\s*(\d{4})$/.exec(s);
  if (gte) return { minYear: Number(gte[1]) };
  const lt = /^<\s*(\d{4})$/.exec(s);
  if (lt) return { maxYear: Number(lt[1]) - 1 };
  const range = /^(\d{4})\s*-\s*(\d{4})$/.exec(s);
  if (range) return { minYear: Number(range[1]), maxYear: Number(range[2]) };
  const exact = /^\d{4}$/.exec(s);
  if (exact) return { year: Number(exact[0]) };
  throw new InvalidArgumentError(
    "Year must be exact (2020), >=year (>=2020), <year (<2000), or range (2020-2023)",
  );
}

/**
 * Maps parsed --year (or legacy number) into queryOptions year/minYear/maxYear.
 */
function yearFilterToQueryOptions(yearOpt: unknown): YearFilterParsed {
  if (yearOpt === undefined || yearOpt === null) return {};
  if (typeof yearOpt === "object" && "year" in (yearOpt as YearFilterParsed)) {
    return yearOpt as YearFilterParsed;
  }
  if (typeof yearOpt === "number" && !isNaN(yearOpt)) return { year: yearOpt };
  return {};
}

function resolveCollectionCreateType(
  cmdOptions: Record<string, unknown>,
): PlexMediaType | undefined {
  const type = cmdOptions["type"] as PlexMediaType | undefined;
  const mode = cmdOptions["mode"] as PlexMediaType | undefined;
  const aliasModes: PlexMediaType[] = [];

  if (cmdOptions["addTrack"] === true) {
    aliasModes.push("track");
  }
  if (cmdOptions["addAlbum"] === true) {
    aliasModes.push("album");
  }
  if (cmdOptions["addArtist"] === true) {
    aliasModes.push("artist");
  }

  if (aliasModes.length > 1) {
    throw new Error(
      "Use only one add mode alias: choose one of --add-track, --add-album, or --add-artist.",
    );
  }

  const aliasMode = aliasModes[0];
  if (mode && aliasMode && mode !== aliasMode) {
    throw new Error(
      `Conflicting create mode options: --mode ${mode} conflicts with --add-${aliasMode}. Use one mode selector.`,
    );
  }
  if (type && mode && type !== mode) {
    throw new Error(
      `Conflicting collection type options: --type ${type} conflicts with --mode ${mode}. Use one mode selector.`,
    );
  }
  if (type && aliasMode && type !== aliasMode) {
    throw new Error(
      `Conflicting collection type options: --type ${type} conflicts with --add-${aliasMode}. Use one mode selector.`,
    );
  }

  return type ?? mode ?? aliasMode;
}

function resolveCollectionAddMode(cmdOptions: Record<string, unknown>): PlexMediaType | undefined {
  const mode = cmdOptions["mode"] as PlexMediaType | undefined;
  const aliasModes: PlexMediaType[] = [];

  if (cmdOptions["addTrack"] === true) {
    aliasModes.push("track");
  }
  if (cmdOptions["addAlbum"] === true) {
    aliasModes.push("album");
  }
  if (cmdOptions["addArtist"] === true) {
    aliasModes.push("artist");
  }

  if (aliasModes.length > 1) {
    throw new Error(
      "Use only one add mode alias: choose one of --add-track, --add-album, or --add-artist.",
    );
  }

  const aliasMode = aliasModes[0];
  if (mode && aliasMode && mode !== aliasMode) {
    throw new Error(
      `Conflicting add mode options: --mode ${mode} conflicts with --add-${aliasMode}. Use one mode selector.`,
    );
  }

  return mode ?? aliasMode;
}

/**
 * Plex command - parent for subcommands.
 *
 * Provides Plex Media Server operations including library queries.
 */
export const plexCommand = new Command("plex").description("Plex Media Server operations");

/**
 * JSON output structure for plex query command.
 */
interface PlexQueryJsonOutput {
  command: "plex-query";
  result: PlexQueryActionResult;
}

/**
 * Type guard to check if result contains tracks.
 */
function isTrackResult(result: PlexQueryActionResult): result is PlexQueryResult {
  return "tracks" in result;
}

/**
 * Type guard to check if result contains albums.
 */
function isAlbumResult(result: PlexQueryActionResult): result is PlexAlbumQueryResult {
  return "albums" in result;
}

/**
 * Type guard to check if result contains artists.
 */
function isArtistResult(result: PlexQueryActionResult): result is PlexArtistQueryResult {
  return "artists" in result;
}

/**
 * Format track results as a console table.
 *
 * @param result - Track query result
 */
function formatTrackResults(result: PlexQueryResult): void {
  console.error("");
  console.error(pc.bold(`Tracks (${result.tracks.length} of ${result.totalSize})`));
  console.error("");

  if (result.tracks.length === 0) {
    console.error(pc.yellow("  No tracks found matching the criteria"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "title", title: "Title", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "album", title: "Album", alignment: "left" },
      { name: "rating", title: "Rating", alignment: "center" },
      { name: "plays", title: "Plays", alignment: "right" },
      { name: "duration", title: "Duration", alignment: "right" },
    ],
  });

  for (const track of result.tracks) {
    table.addRow({
      title: truncate(track.title, 40),
      artist: truncate(track.artist, 25),
      album: truncate(track.album, 30),
      rating: ratingToStars(track.userRating),
      plays: track.viewCount.toString(),
      duration: formatDuration(track.duration),
    });
  }

  console.error(table.render());

  if (result.hasMore) {
    console.error("");
    console.error(pc.dim(`  ... and ${result.totalSize - result.tracks.length} more tracks`));
  }
  console.error("");
}

/**
 * Format album results as a console table.
 *
 * Note: The Plex API batch endpoint doesn't return userRating or leafCount (track count)
 * for albums. These fields would require individual metadata lookups per album.
 *
 * @param result - Album query result
 */
function formatAlbumResults(result: PlexAlbumQueryResult): void {
  console.error("");
  console.error(pc.bold(`Albums (${result.albums.length} of ${result.totalSize})`));
  console.error("");

  if (result.albums.length === 0) {
    console.error(pc.yellow("  No albums found matching the criteria"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "title", title: "Album", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "rating", title: "Rating", alignment: "center" },
      { name: "tracks", title: "Tracks", alignment: "right" },
      { name: "year", title: "Year", alignment: "right" },
    ],
  });

  for (const album of result.albums) {
    table.addRow({
      title: truncate(album.title, 45),
      artist: truncate(album.artist, 30),
      rating: ratingToStars(album.userRating),
      tracks: album.trackCount.toString(),
      year: album.year?.toString() ?? "-",
    });
  }

  console.error(table.render());

  if (result.hasMore) {
    console.error("");
    console.error(pc.dim(`  ... and ${result.totalSize - result.albums.length} more albums`));
  }
  console.error("");
}

/**
 * Format artist results as a console table.
 *
 * Note: The Plex API batch endpoint doesn't return userRating or childCount (album count)
 * for artists. These fields would require individual metadata lookups per artist.
 *
 * @param result - Artist query result
 */
function formatArtistResults(result: PlexArtistQueryResult): void {
  console.error("");
  console.error(pc.bold(`Artists (${result.artists.length} of ${result.totalSize})`));
  console.error("");

  if (result.artists.length === 0) {
    console.error(pc.yellow("  No artists found matching the criteria"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "name", title: "Artist", alignment: "left" },
      { name: "rating", title: "Rating", alignment: "center" },
      { name: "albums", title: "Albums", alignment: "right" },
    ],
  });

  for (const artist of result.artists) {
    table.addRow({
      name: truncate(artist.title, 50),
      rating: ratingToStars(artist.userRating),
      albums: artist.albumCount.toString(),
    });
  }

  console.error(table.render());

  if (result.hasMore) {
    console.error("");
    console.error(pc.dim(`  ... and ${result.totalSize - result.artists.length} more artists`));
  }
  console.error("");
}

/**
 * Format query results for console output based on query type.
 *
 * @param result - Query result from Plex
 */
function formatQueryResults(result: PlexQueryActionResult): void {
  if (isTrackResult(result)) {
    formatTrackResults(result);
  } else if (isAlbumResult(result)) {
    formatAlbumResults(result);
  } else if (isArtistResult(result)) {
    formatArtistResults(result);
  }
}

/**
 * plex query - Parent command for Plex query operations.
 *
 * Subcommands:
 * - `run` - Execute a query against Plex library with filters
 * - `list` - List saved queries from the database
 */
const queryCommand = new Command("query").description("Plex library query operations");

/**
 * plex query run - Execute a Plex library query with filters.
 *
 * Supports filtering by ratings, genres, years, and play counts.
 * Results can be tracks, albums, or artists based on the --type option.
 */
const queryRunCommand = new Command("run")
  .description("Query Plex library with filters")
  .option("-l, --library <name>", "Plex library name to query (can be set in filter defaults)")
  .addOption(
    new Option(
      "-t, --type <type>",
      "Media type to query (defaults to filter type or 'track')",
    ).choices(["track", "album", "artist"]),
  )
  // Hierarchical rating filters
  .addOption(
    new Option(
      "--min-artist-stars <rating>",
      "Min artist rating (1-5, works on all types)",
    ).argParser(parseStarRating),
  )
  .addOption(
    new Option(
      "--max-artist-stars <rating>",
      "Max artist rating (1-5, works on all types)",
    ).argParser(parseStarRating),
  )
  .addOption(
    new Option(
      "--min-album-stars <rating>",
      "Min album rating (1-5, works on albums/tracks)",
    ).argParser(parseStarRating),
  )
  .addOption(
    new Option(
      "--max-album-stars <rating>",
      "Max album rating (1-5, works on albums/tracks)",
    ).argParser(parseStarRating),
  )
  .addOption(
    new Option(
      "--min-track-stars <rating>",
      "Min track rating (1-5, works on tracks only)",
    ).argParser(parseStarRating),
  )
  .addOption(
    new Option(
      "--max-track-stars <rating>",
      "Max track rating (1-5, works on tracks only)",
    ).argParser(parseStarRating),
  )
  // Other filters
  .option("--genre <genre>", "Filter by genre")
  .option("--style <style>", "Filter by style tag (e.g., 'Jazz', 'Fusion') - artists/albums only")
  .option("--mood <mood>", "Filter by mood tag (e.g., 'Relaxing', 'Energetic')")
  .option("--year <year>", "Filter by year", parseInt)
  .option("--min-year <year>", "Minimum year", parseInt)
  .option("--max-year <year>", "Maximum year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  .option("--artist <pattern>", "Filter by artist name (substring match)")
  .option("--title <pattern>", "Filter by title (substring match)")
  .option("--album <pattern>", "Filter by album name (substring match, tracks only)")
  .option("--limit <count>", "Maximum results to return", parsePositiveInt)
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .option("-n, --name <name>", "Name for saved query (queries are saved by default)")
  .option("--no-save", "Do not save query to database")
  .option(
    "-F, --filter <name>",
    "Apply named filter from plexFilters config (can provide library/type defaults)",
  )
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Lazy load action handler for faster CLI startup
    const { executePlexQuery } = await import("../actions/plex-query.js");

    const result = await executePlexQuery({
      library: cmdOptions["library"] as string | undefined,
      type: cmdOptions["type"] as "track" | "album" | "artist" | undefined,
      // Hierarchical rating filters
      minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
      maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
      minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
      maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
      minTrackRating: cmdOptions["minTrackStars"] as number | undefined,
      maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
      // Other filters
      genre: cmdOptions["genre"] as string | undefined,
      style: cmdOptions["style"] as string | undefined,
      mood: cmdOptions["mood"] as string | undefined,
      year: cmdOptions["year"] as number | undefined,
      minYear: cmdOptions["minYear"] as number | undefined,
      maxYear: cmdOptions["maxYear"] as number | undefined,
      minPlays: cmdOptions["minPlays"] as number | undefined,
      artist: cmdOptions["artist"] as string | undefined,
      title: cmdOptions["title"] as string | undefined,
      album: cmdOptions["album"] as string | undefined,
      limit: cmdOptions["limit"] as number | undefined,
      plexUrl: cmdOptions["plexUrl"] as string | undefined,
      plexToken: cmdOptions["plexToken"] as string | undefined,
      name: cmdOptions["name"] as string | undefined,
      noSave: !cmdOptions["save"],
      filter: cmdOptions["filter"] as string | undefined,
    });

    // Get global options from root command (consistent with other commands)
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    // Format output
    const format = globalOpts?.output ?? "text";
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      const jsonOutput: PlexQueryJsonOutput = {
        command: "plex-query",
        result,
      };
      await formatOutput(format, jsonOutput);
    } else {
      formatQueryResults(result);
    }
  });

/**
 * JSON output structure for plex query list command.
 */
interface PlexQueryListJsonOutput {
  command: "plex-query-list";
  result: {
    queries: DbPlexQuery[];
    total: number;
  };
}

/**
 * plex query list - List saved Plex queries from the database.
 *
 * Shows a summary of all saved queries including library, type, filters, and result counts.
 */
const queryListCommand = new Command("list")
  .description("List saved Plex queries")
  .option("-l, --library <name>", "Filter by library name")
  .addOption(
    new Option("-t, --type <type>", "Filter by media type").choices(["track", "album", "artist"]),
  )
  .addOption(
    new Option("--status <status>", "Filter by query status").choices([
      "pending",
      "completed",
      "failed",
    ]),
  )
  .option("--name <name>", "Filter by query name (partial match)")
  .option("--limit <count>", "Maximum queries to show", parsePositiveInt, 20)
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from root command (consistent with other commands)
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load database module
      const { initializeDatabase, listPlexQueries, closeDatabase } = await import("../lib/db.js");

      // Initialize database connection
      const db = await initializeDatabase();

      try {
        // Build list options from command options
        const listOptions: PlexQueryListOptions = {
          libraryName: cmdOptions["library"] as string | undefined,
          mediaType: cmdOptions["type"] as "track" | "album" | "artist" | undefined,
          status: cmdOptions["status"] as "pending" | "completed" | "failed" | undefined,
          name: cmdOptions["name"] as string | undefined,
          limit: cmdOptions["limit"] as number | undefined,
        };

        // Query the database
        const queries = listPlexQueries(db, listOptions);

        // Format output
        const format = globalOpts?.output ?? "text";
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          const jsonOutput: PlexQueryListJsonOutput = {
            command: "plex-query-list",
            result: {
              queries,
              total: queries.length,
            },
          };
          await formatOutput(format, jsonOutput);
        } else {
          formatQueryListResults(queries);
        }
      } finally {
        closeDatabase(db);
      }
    } catch (error) {
      logError(`Failed to list queries: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

/**
 * Format a summary of filters from JSON for display.
 *
 * @param filtersJson - JSON string of filter options
 * @returns Formatted summary string
 */
function formatFiltersSummary(filtersJson: string): string {
  try {
    const filters = JSON.parse(filtersJson) as Record<string, unknown>;
    const parts: string[] = [];

    // Hierarchical rating filters
    if (filters["minArtistRating"] !== undefined) {
      parts.push(`artist★>=${filters["minArtistRating"]}`);
    }
    if (filters["maxArtistRating"] !== undefined) {
      parts.push(`artist★<=${filters["maxArtistRating"]}`);
    }
    if (filters["minAlbumRating"] !== undefined) {
      parts.push(`album★>=${filters["minAlbumRating"]}`);
    }
    if (filters["maxAlbumRating"] !== undefined) {
      parts.push(`album★<=${filters["maxAlbumRating"]}`);
    }
    if (filters["minTrackRating"] !== undefined) {
      parts.push(`track★>=${filters["minTrackRating"]}`);
    }
    if (filters["maxTrackRating"] !== undefined) {
      parts.push(`track★<=${filters["maxTrackRating"]}`);
    }

    // Other filters
    if (filters["genre"] !== undefined) {
      parts.push(`genre: ${filters["genre"]}`);
    }
    if (filters["year"] !== undefined) {
      parts.push(`year: ${filters["year"]}`);
    }
    if (filters["minYear"] !== undefined) {
      parts.push(`minYear: ${filters["minYear"]}`);
    }
    if (filters["maxYear"] !== undefined) {
      parts.push(`maxYear: ${filters["maxYear"]}`);
    }
    if (filters["minPlays"] !== undefined) {
      parts.push(`minPlays: ${filters["minPlays"]}`);
    }
    if (filters["artist"] !== undefined) {
      parts.push(`artist: ${filters["artist"]}`);
    }
    if (filters["title"] !== undefined) {
      parts.push(`title: ${filters["title"]}`);
    }
    if (filters["album"] !== undefined) {
      parts.push(`album: ${filters["album"]}`);
    }

    return parts.length > 0 ? parts.join(", ") : "none";
  } catch {
    return "invalid";
  }
}

/**
 * Format timestamp as a short display string for tables.
 *
 * @param isoTimestamp - ISO timestamp string
 * @returns Short formatted date string
 */
function formatDateShort(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return date.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Format query list results for console output.
 *
 * @param queries - Array of query records from database
 */
function formatQueryListResults(queries: DbPlexQuery[]): void {
  console.error("");
  console.error(pc.bold("Saved Plex Queries"));
  console.error("");

  if (queries.length === 0) {
    console.error(pc.yellow("  No saved queries found"));
    console.error("");
    console.error(pc.dim("  Use `rfmedia plex query run -l <library>` to execute a query"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "id", title: "ID", alignment: "right" },
      { name: "library", title: "Library", alignment: "left" },
      { name: "type", title: "Type", alignment: "left" },
      { name: "filters", title: "Filters", alignment: "left" },
      { name: "results", title: "Results", alignment: "right" },
      { name: "status", title: "Status", alignment: "left" },
      { name: "date", title: "Date", alignment: "left" },
    ],
  });

  for (const query of queries) {
    const statusColor =
      query.status === "completed" ? "green" : query.status === "failed" ? "red" : "yellow";

    table.addRow(
      {
        id: query.id,
        library: truncate(query.name ?? query.library_name, 20),
        type: query.media_type,
        filters: truncate(formatFiltersSummary(query.filters_json), 30),
        results: `${query.result_count}/${query.total_count}`,
        status: query.status,
        date: formatDateShort(query.created_at),
      },
      { color: statusColor },
    );
  }

  console.error(table.render());
  console.error("");
}

// Register subcommands to query parent
queryCommand.addCommand(queryRunCommand);
queryCommand.addCommand(queryListCommand);

/**
 * plex copy - Copy files based on Plex query results.
 *
 * Supports two modes:
 * 1. query-results: Copy from saved query ID
 * 2. query: Execute new query and copy results
 */
const copyCommand = new Command("copy").description("Copy files based on Plex query results");

/**
 * JSON output structure for plex copy command.
 */
interface PlexCopyJsonOutput {
  command: "plex-copy";
  result: {
    created: number;
    skipped: number;
    failed: number;
    totalSize: number;
  };
}

/**
 * plex copy query-results - Copy files from saved query results.
 *
 * Loads results from a previously saved query and copies the files
 * to the specified destination directory.
 */
const copyQueryResultsCommand = new Command("query-results")
  .description("Copy files from saved query results")
  .argument("<destination>", "Destination directory for copied files")
  .requiredOption("--query-id <id>", "Query ID to copy from", parsePositiveInt)
  .option("--hardlink", "Use hardlinks instead of copies")
  .addOption(
    new Option("--convert <format>", "Convert to audio format").choices([
      "mp3",
      "aac",
      "opus",
      "alac",
    ]),
  )
  .option("--preserve-structure", "Preserve artist/album folder hierarchy")
  .option("--album-mode", "Create album folders with suffixes (Album-001, Album-002)")
  .option("-o, --output-folder <name>", "Output folder name for tracks (default: plex-liked)")
  .option("--workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview without copying")
  .option("--no-plex-scan", "Disable Plex library scan after copy")
  .option("--fail-fast", "Stop immediately on first error")
  .option("--sync-ratings", "Write Plex ratings to copied files")
  .option("--no-sync-ratings", "Disable rating sync (override config)")
  .option("--popm-email <email>", "POPM email identifier for MP3 rating writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis scale: normalized|stars|percent").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(parsePositiveInt)
      .conflicts("range"),
  )
  .action(async (destination: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executePlexCopy } = await import("../actions/plex-copy.js");

      const result = await executePlexCopy({
        mode: "query-results",
        queryId: cmdOptions["queryId"] as number,
        destination,
        hardlink: cmdOptions["hardlink"] as boolean | undefined,
        convertFormat: cmdOptions["convert"] as "mp3" | "aac" | "opus" | "alac" | undefined,
        preserveStructure: cmdOptions["preserveStructure"] as boolean | undefined,
        albumMode: cmdOptions["albumMode"] as boolean | undefined,
        outputFolder: cmdOptions["outputFolder"] as string | undefined,
        workers: cmdOptions["workers"] as number | undefined,
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        progress: !isMachineFormat(globalOpts?.output), // Disable progress in machine formats
        plexScan: cmdOptions["plexScan"] as boolean | undefined,
        range: cmdOptions["range"] as import("../types/options.js").CopyRange | undefined,
        count: cmdOptions["count"] as number | undefined,
        failFast: cmdOptions["failFast"] as boolean | undefined,
        syncRatings: cmdOptions["syncRatings"] as boolean | undefined,
        popmEmail: cmdOptions["popmEmail"] as string | undefined,
        vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCopyJsonOutput = {
          command: "plex-copy",
          result: {
            created: result.created,
            skipped: result.skipped,
            failed: result.failed.length,
            totalSize: result.totalSize,
          },
        };
        await formatOutput(format, jsonOutput);
      }

      // Set exit code if any operations failed
      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Copy failed: ${message}`);
      process.exit(1);
    }
  });

/**
 * plex copy query - Execute query and copy results.
 *
 * Executes a Plex query with filters and copies the resulting files
 * to the specified destination directory.
 */
const copyQueryCommand = new Command("query")
  .description("Execute query and copy results")
  .argument("<destination>", "Destination directory for copied files")
  .option("-l, --library <name>", "Plex library name to query")
  .addOption(
    new Option(
      "-t, --type <type>",
      "Media type to query (defaults to filter type or 'track')",
    ).choices(["track", "album", "artist"]),
  )
  // Hierarchical rating filters
  .addOption(
    new Option("--min-artist-stars <rating>", "Min artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-artist-stars <rating>", "Max artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-album-stars <rating>", "Min album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-album-stars <rating>", "Max album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-track-stars <rating>", "Min track rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-track-stars <rating>", "Max track rating (1-5)").argParser(parseStarRating),
  )
  // Other filters
  .option("--genre <genre>", "Filter by genre")
  .option("--style <style>", "Filter by style tag (e.g., 'Jazz', 'Fusion') - artists/albums only")
  .option("--mood <mood>", "Filter by mood tag (e.g., 'Relaxing', 'Energetic')")
  .option("--year <year>", "Filter by year", parseInt)
  .option("--min-year <year>", "Minimum year", parseInt)
  .option("--max-year <year>", "Maximum year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  .option("--artist <pattern>", "Filter by artist name")
  .option("--title <pattern>", "Filter by title")
  .option("--album <pattern>", "Filter by album name")
  .option("--limit <count>", "Maximum results", parsePositiveInt)
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  // Copy options
  .option("--hardlink", "Use hardlinks instead of copies")
  .addOption(
    new Option("--convert <format>", "Convert to audio format").choices([
      "mp3",
      "aac",
      "opus",
      "alac",
    ]),
  )
  .option("--preserve-structure", "Preserve artist/album folder hierarchy")
  .option("--album-mode", "Create album folders with suffixes (Album-001, Album-002)")
  .option("-o, --output-folder <name>", "Output folder name for tracks (default: plex-liked)")
  .option("--workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview without copying")
  .option("--no-plex-scan", "Disable Plex library scan after copy")
  .option("--fail-fast", "Stop immediately on first error")
  .option("--sync-ratings", "Write Plex ratings to copied files")
  .option("--no-sync-ratings", "Disable rating sync (override config)")
  .option("--popm-email <email>", "POPM email identifier for MP3 rating writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis scale: normalized|stars|percent").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(parsePositiveInt)
      .conflicts("range"),
  )
  .option("-F, --filter <name>", "Apply named filter from plexFilters config")
  .action(async (destination: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executePlexCopy } = await import("../actions/plex-copy.js");

      const result = await executePlexCopy({
        mode: "query",
        // Query options
        library: (cmdOptions["library"] as string | undefined) || "Music",
        type: (cmdOptions["type"] as "track" | "album" | "artist" | undefined) || "track",
        // Hierarchical rating filters
        minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
        maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
        minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
        maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
        minTrackRating: cmdOptions["minTrackStars"] as number | undefined,
        maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
        // Other filters
        genre: cmdOptions["genre"] as string | undefined,
        style: cmdOptions["style"] as string | undefined,
        mood: cmdOptions["mood"] as string | undefined,
        year: cmdOptions["year"] as number | undefined,
        minYear: cmdOptions["minYear"] as number | undefined,
        maxYear: cmdOptions["maxYear"] as number | undefined,
        minPlays: cmdOptions["minPlays"] as number | undefined,
        artist: cmdOptions["artist"] as string | undefined,
        title: cmdOptions["title"] as string | undefined,
        album: cmdOptions["album"] as string | undefined,
        limit: cmdOptions["limit"] as number | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
        filter: cmdOptions["filter"] as string | undefined,
        // Copy options
        destination,
        hardlink: cmdOptions["hardlink"] as boolean | undefined,
        convertFormat: cmdOptions["convert"] as "mp3" | "aac" | "opus" | "alac" | undefined,
        preserveStructure: cmdOptions["preserveStructure"] as boolean | undefined,
        albumMode: cmdOptions["albumMode"] as boolean | undefined,
        outputFolder: cmdOptions["outputFolder"] as string | undefined,
        workers: cmdOptions["workers"] as number | undefined,
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        progress: !isMachineFormat(globalOpts?.output), // Disable progress in machine formats
        plexScan: cmdOptions["plexScan"] as boolean | undefined,
        range: cmdOptions["range"] as import("../types/options.js").CopyRange | undefined,
        count: cmdOptions["count"] as number | undefined,
        failFast: cmdOptions["failFast"] as boolean | undefined,
        syncRatings: cmdOptions["syncRatings"] as boolean | undefined,
        popmEmail: cmdOptions["popmEmail"] as string | undefined,
        vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCopyJsonOutput = {
          command: "plex-copy",
          result: {
            created: result.created,
            skipped: result.skipped,
            failed: result.failed.length,
            totalSize: result.totalSize,
          },
        };
        await formatOutput(format, jsonOutput);
      }

      // Set exit code if any operations failed
      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Copy failed: ${message}`);
      process.exit(1);
    }
  });

// Register subcommands to copy parent
copyCommand.addCommand(copyQueryResultsCommand);
copyCommand.addCommand(copyQueryCommand);

/**
 * JSON output structure for plex playlist export/sync commands.
 */
interface PlexPlaylistExportJsonOutput {
  command: "plex-playlist-export" | "plex-playlist-sync";
  result: {
    playlistName: string;
    totalTracks: number;
    created: number;
    skipped: number;
    removed?: number;
    failed: number;
    totalSize: number;
  };
}

/**
 * JSON output structure for plex playlist list command.
 */
interface PlexPlaylistListJsonOutput {
  command: "plex-playlist-list";
  result: {
    playlists: Array<{
      title: string;
      trackCount: number;
      smart: boolean;
      duration: number;
    }>;
    total: number;
  };
}

/**
 * plex playlist - Parent command for Plex playlist operations.
 *
 * Subcommands:
 * - `export` - Export playlist tracks to destination folder
 * - `sync` - Sync destination to match current playlist state
 * - `list` - List available Plex playlists
 */
const playlistCommand = new Command("playlist").description("Manage and export Plex playlists");

/**
 * plex playlist export - Export playlist tracks to destination folder.
 *
 * Copies all tracks from a Plex playlist to a destination directory.
 */
const playlistExportCommand = new Command("export")
  .description("Export playlist tracks to destination folder")
  .argument("<playlist-name>", "Name of the Plex playlist to export")
  .argument("<destination>", "Destination directory for exported tracks")
  .option("--hardlink", "Use hardlinks instead of copies")
  .addOption(
    new Option("--convert <format>", "Convert to audio format").choices([
      "mp3",
      "aac",
      "opus",
      "alac",
    ]),
  )
  .option("-w, --workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview without copying")
  .option("--no-progress", "Disable progress bar")
  .option("--plex-scan", "Trigger Plex scan after export")
  .option("--preserve-structure", "Keep artist/album folder structure")
  .option("--flat", "Output directly to destination (no playlist subfolder)")
  .option("--folder <name>", "Custom folder name (overrides playlist name)")
  .option("--sync-ratings", "Write Plex ratings to copied files")
  .option("--no-sync-ratings", "Disable rating sync (override config)")
  .option("--popm-email <email>", "POPM email identifier for MP3 rating writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis scale: normalized|stars|percent").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(parsePositiveInt)
      .conflicts("range"),
  )
  .action(
    async (playlistName: string, destination: string, cmdOptions: Record<string, unknown>) => {
      // Get global options from root command
      const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

      try {
        // Lazy load action handler
        const { executePlaylistExport } = await import("../actions/plex-playlist.js");

        const result = await executePlaylistExport({
          playlistName,
          destination,
          hardlink: cmdOptions["hardlink"] as boolean | undefined,
          convertFormat: cmdOptions["convert"] as "mp3" | "aac" | "opus" | "alac" | undefined,
          workers: cmdOptions["workers"] as number | undefined,
          dryRun: cmdOptions["dryRun"] as boolean | undefined,
          progress: cmdOptions["progress"] !== false && !isMachineFormat(globalOpts?.output),
          plexScan: cmdOptions["plexScan"] as boolean | undefined,
          preserveStructure: cmdOptions["preserveStructure"] as boolean | undefined,
          flat: cmdOptions["flat"] as boolean | undefined,
          folder: cmdOptions["folder"] as string | undefined,
          range: cmdOptions["range"] as import("../types/options.js").CopyRange | undefined,
          count: cmdOptions["count"] as number | undefined,
          syncRatings: cmdOptions["syncRatings"] as boolean | undefined,
          popmEmail: cmdOptions["popmEmail"] as string | undefined,
          vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
        });

        // Format output
        const format = globalOpts?.output ?? "text";
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          const jsonOutput: PlexPlaylistExportJsonOutput = {
            command: "plex-playlist-export",
            result: {
              playlistName: result.playlistName,
              totalTracks: result.totalTracks,
              created: result.created,
              skipped: result.skipped,
              failed: result.failed.length,
              totalSize: result.totalSize,
            },
          };
          await formatOutput(format, jsonOutput);
        }

        // Set exit code if any operations failed
        if (result.failed.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Playlist export failed: ${message}`);
        process.exitCode = 1;
      }
    },
  );

/**
 * plex playlist sync - Sync destination to match current playlist state.
 *
 * Updates destination directory to match the current playlist state,
 * adding new tracks and optionally removing tracks no longer in the playlist.
 */
const playlistSyncCommand = new Command("sync")
  .description("Sync destination to match current playlist state")
  .argument("<playlist-name>", "Name of the Plex playlist to sync")
  .argument("<destination>", "Destination directory to sync")
  .option("--delete-removed", "Remove tracks no longer in playlist")
  .option("--hardlink", "Use hardlinks instead of copies")
  .addOption(
    new Option("--convert <format>", "Convert to audio format").choices([
      "mp3",
      "aac",
      "opus",
      "alac",
    ]),
  )
  .option("-w, --workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview without syncing")
  .option("--no-progress", "Disable progress bar")
  .option("--plex-scan", "Trigger Plex scan after sync")
  .option("--preserve-structure", "Keep artist/album folder structure")
  .option("--flat", "Output directly to destination (no playlist subfolder)")
  .option("--folder <name>", "Custom folder name (overrides playlist name)")
  .option("--sync-ratings", "Write Plex ratings to copied files")
  .option("--no-sync-ratings", "Disable rating sync (override config)")
  .option("--popm-email <email>", "POPM email identifier for MP3 rating writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis scale: normalized|stars|percent").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .addOption(
    new Option("-r, --range <START-END>", "Range of suffixes to create (e.g., 001-010)").argParser(
      parseRange,
    ),
  )
  .addOption(
    new Option("--count <N>", "Number of copies to create (auto-detects next range)")
      .argParser(parsePositiveInt)
      .conflicts("range"),
  )
  .action(
    async (playlistName: string, destination: string, cmdOptions: Record<string, unknown>) => {
      // Get global options from root command
      const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

      try {
        // Lazy load action handler
        const { executePlaylistSync } = await import("../actions/plex-playlist.js");

        const result = await executePlaylistSync({
          playlistName,
          destination,
          deleteRemoved: cmdOptions["deleteRemoved"] as boolean | undefined,
          hardlink: cmdOptions["hardlink"] as boolean | undefined,
          convertFormat: cmdOptions["convert"] as "mp3" | "aac" | "opus" | "alac" | undefined,
          workers: cmdOptions["workers"] as number | undefined,
          dryRun: cmdOptions["dryRun"] as boolean | undefined,
          progress: cmdOptions["progress"] !== false && !isMachineFormat(globalOpts?.output),
          plexScan: cmdOptions["plexScan"] as boolean | undefined,
          preserveStructure: cmdOptions["preserveStructure"] as boolean | undefined,
          flat: cmdOptions["flat"] as boolean | undefined,
          folder: cmdOptions["folder"] as string | undefined,
          range: cmdOptions["range"] as import("../types/options.js").CopyRange | undefined,
          count: cmdOptions["count"] as number | undefined,
          syncRatings: cmdOptions["syncRatings"] as boolean | undefined,
          popmEmail: cmdOptions["popmEmail"] as string | undefined,
          vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
        });

        // Format output
        const format = globalOpts?.output ?? "text";
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          const jsonOutput: PlexPlaylistExportJsonOutput = {
            command: "plex-playlist-sync",
            result: {
              playlistName: result.playlistName,
              totalTracks: result.totalTracks,
              created: result.created,
              skipped: result.skipped,
              removed: result.removed,
              failed: result.failed.length,
              totalSize: result.totalSize,
            },
          };
          await formatOutput(format, jsonOutput);
        }

        // Set exit code if any operations failed
        if (result.failed.length > 0) {
          process.exitCode = 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError(`Playlist sync failed: ${message}`);
        process.exitCode = 1;
      }
    },
  );

/**
 * plex playlist list - List available Plex playlists.
 *
 * Shows all audio playlists from the Plex server with track counts and durations.
 */
const playlistListCommand = new Command("list")
  .description("List available Plex playlists")
  .option("--exportable", "Show only playlists that can be exported")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { listPlaylists } = await import("../actions/plex-playlist.js");

      const playlists = await listPlaylists({
        exportable: cmdOptions["exportable"] as boolean | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexPlaylistListJsonOutput = {
          command: "plex-playlist-list",
          result: {
            playlists: playlists.map((p) => ({
              title: p.title,
              trackCount: p.leafCount,
              smart: p.smart,
              duration: p.duration,
            })),
            total: playlists.length,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        formatPlaylistListResults(playlists);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Failed to list playlists: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * Column definitions for the playlist list table.
 *
 * Fixed columns (Tracks, Smart, Duration) reserve a stable budget.
 * The Name column is flex and expands to fill remaining terminal width.
 */
const PLAYLIST_TABLE_COLUMNS: ColumnDef[] = [
  { name: "name", minWidth: 15, flex: true, alignment: "left" },
  { name: "tracks", minWidth: 8, flex: false, alignment: "right" },
  { name: "smart", minWidth: 7, flex: false, alignment: "center" },
  { name: "duration", minWidth: 10, flex: false, alignment: "right" },
];

/**
 * Format playlist list results for console output.
 *
 * Uses dynamic terminal width detection and Unicode-safe truncation
 * for the Name column. Fixed columns (Tracks, Smart, Duration) retain
 * stable minimum widths regardless of terminal size.
 *
 * @param playlists - Array of playlist objects from Plex
 */
function formatPlaylistListResults(
  playlists: Array<{
    title: string;
    leafCount: number;
    smart: boolean;
    duration: number;
  }>,
): void {
  console.error("");
  console.error(pc.bold("Plex Playlists"));
  console.error("");

  if (playlists.length === 0) {
    console.error(pc.yellow("  No playlists found"));
    console.error("");
    return;
  }

  // Use stderr width so column budget matches the stream used for table output (console.error)
  const terminalWidth = getTerminalWidth(process.stderr);
  const columnWidths = calculateColumnWidths(PLAYLIST_TABLE_COLUMNS, terminalWidth);
  const nameWidth = columnWidths.find((c) => c.name === "name")?.width ?? 15;

  const table = new Table({
    columns: [
      { name: "name", title: "Playlist", alignment: "left" },
      { name: "tracks", title: "Tracks", alignment: "right" },
      { name: "smart", title: "Smart", alignment: "center" },
      { name: "duration", title: "Duration", alignment: "right" },
    ],
  });

  for (const playlist of playlists) {
    table.addRow({
      name: truncateToWidth(playlist.title, nameWidth),
      tracks: playlist.leafCount.toString(),
      smart: playlist.smart ? "Yes" : "No",
      duration: formatDuration(playlist.duration),
    });
  }

  console.error(table.render());
  console.error("");
}

/**
 * JSON output structure for plex playlist create command.
 */
interface PlexPlaylistCreateJsonOutput {
  command: "plex-playlist-create";
  result: {
    playlistName: string;
    ratingKey: string;
    tracksAdded: number;
    action: "created" | "updated";
    smart: boolean;
  };
}

/**
 * plex playlist create - Create a new playlist from filtered tracks.
 *
 * Creates a new Plex playlist populated with tracks matching the specified filters.
 * Supports all standard Plex query filters including rating, genre, year, and text filters.
 */
const playlistCreateCommand = new Command("create")
  .description("Create a new playlist from filtered tracks")
  .argument("<name>", "Playlist name")
  .option("-l, --library <name>", "Library name")
  .option("--smart", "Create smart playlist")
  .option("--update-existing", "Update if playlist already exists")
  .option("-F, --filter <name>", "Use named filter from config")
  // Rating filters
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0)").argParser((val) =>
      parseFloatArg(val, "--min-stars"),
    ),
  )
  .addOption(
    new Option("--min-artist-stars <rating>", "Min artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-artist-stars <rating>", "Max artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-album-stars <rating>", "Min album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-album-stars <rating>", "Max album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-track-stars <rating>", "Min track rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-track-stars <rating>", "Max track rating (1-5)").argParser(parseStarRating),
  )
  // Text filter options
  .option("--genre <genre>", "Filter by genre")
  .option("--style <style>", "Filter by style (comma-separated for OR)")
  .option("--mood <mood>", "Filter by mood (comma-separated for OR)")
  .option("--artist <name>", "Filter by artist name (contains)")
  .option("--title <name>", "Filter by track title (contains)")
  .option("--album <name>", "Filter by album title (contains)")
  // Year/play options
  .option("--year <year>", "Filter by year (2020, >=2020, <2000, 2020-2023)", parseYearFilter)
  .option("--min-year <year>", "Minimum release year", parseInt)
  .option("--max-year <year>", "Maximum release year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  .option("--limit <N>", "Maximum number of tracks to add", parseInt)
  // Other options
  .option("--progress", "Show progress bar (reserved for future use)")
  .option("--dry-run", "Preview without creating")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (name: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executePlaylistCreate } = await import("../actions/plex-playlist.js");

      const result = await executePlaylistCreate({
        playlistName: name,
        libraryName: cmdOptions["library"] as string | undefined,
        smart: cmdOptions["smart"] as boolean | undefined,
        updateExisting: cmdOptions["updateExisting"] as boolean | undefined,
        filterName: cmdOptions["filter"] as string | undefined,
        maxTracks: cmdOptions["limit"] as number | undefined,
        queryOptions: {
          library: (cmdOptions["library"] as string) ?? "",
          type: "track",
          // Rating filters
          minTrackRating: (cmdOptions["minTrackStars"] ?? cmdOptions["minStars"]) as
            | number
            | undefined,
          minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
          maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
          minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
          maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
          maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
          // Text filter options
          genre: cmdOptions["genre"] as string | undefined,
          style: cmdOptions["style"] as string | undefined,
          mood: cmdOptions["mood"] as string | undefined,
          artist: cmdOptions["artist"] as string | undefined,
          title: cmdOptions["title"] as string | undefined,
          album: cmdOptions["album"] as string | undefined,
          // Year/play options (--year parsed by parseYearFilter; --min-year/--max-year override)
          ...yearFilterToQueryOptions(cmdOptions["year"]),
          minYear:
            (cmdOptions["minYear"] as number | undefined) ??
            yearFilterToQueryOptions(cmdOptions["year"]).minYear,
          maxYear:
            (cmdOptions["maxYear"] as number | undefined) ??
            yearFilterToQueryOptions(cmdOptions["year"]).maxYear,
          minPlays: cmdOptions["minPlays"] as number | undefined,
        },
        progress:
          (cmdOptions["progress"] as boolean | undefined) ?? !isMachineFormat(globalOpts?.output),
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        url: cmdOptions["plexUrl"] as string | undefined,
        token: cmdOptions["plexToken"] as string | undefined,
        json: isMachineFormat(globalOpts?.output),
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexPlaylistCreateJsonOutput = {
          command: "plex-playlist-create",
          result: {
            playlistName: result.playlistName,
            ratingKey: result.ratingKey,
            tracksAdded: result.tracksAdded,
            action: result.action,
            smart: result.smart,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        if (result.action === "created") {
          logSuccess(`Created playlist "${result.playlistName}" with ${result.tracksAdded} tracks`);
        } else {
          logSuccess(`Updated playlist "${result.playlistName}" with ${result.tracksAdded} tracks`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Playlist create failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * JSON output structure for plex playlist add command.
 */
interface PlexPlaylistAddJsonOutput {
  command: "plex-playlist-add";
  result: {
    playlistName: string;
    ratingKey: string;
    tracksAdded: number;
    totalTracks: number;
  };
}

/**
 * plex playlist add - Add tracks to an existing playlist.
 *
 * Adds tracks matching the specified filters to an existing Plex playlist.
 * The playlist must already exist. Supports all standard Plex query filters.
 */
const playlistAddCommand = new Command("add")
  .description("Add tracks to an existing playlist")
  .argument("<name>", "Playlist name")
  .option("-l, --library <name>", "Library name")
  .option("-F, --filter <name>", "Use named filter from config")
  // Rating filters
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0)").argParser((val) =>
      parseFloatArg(val, "--min-stars"),
    ),
  )
  .addOption(
    new Option("--min-artist-stars <rating>", "Min artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-artist-stars <rating>", "Max artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-album-stars <rating>", "Min album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-album-stars <rating>", "Max album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-track-stars <rating>", "Min track rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-track-stars <rating>", "Max track rating (1-5)").argParser(parseStarRating),
  )
  // Text filter options
  .option("--genre <genre>", "Filter by genre")
  .option("--style <style>", "Filter by style (comma-separated for OR)")
  .option("--mood <mood>", "Filter by mood (comma-separated for OR)")
  .option("--artist <name>", "Filter by artist name (contains)")
  .option("--title <name>", "Filter by track title (contains)")
  .option("--album <name>", "Filter by album title (contains)")
  // Year/play options
  .option("--year <year>", "Filter by year (2020, >=2020, <2000, 2020-2023)", parseYearFilter)
  .option("--min-year <year>", "Minimum release year", parseInt)
  .option("--max-year <year>", "Maximum release year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  .option("--limit <N>", "Maximum number of tracks to add", parseInt)
  // Other options
  .option("--progress", "Show progress bar (reserved for future use)")
  .option("--dry-run", "Preview without adding")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (name: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executePlaylistAdd } = await import("../actions/plex-playlist.js");

      const yearFilter = yearFilterToQueryOptions(cmdOptions["year"]);

      const result = await executePlaylistAdd({
        playlistName: name,
        libraryName: cmdOptions["library"] as string | undefined,
        filterName: cmdOptions["filter"] as string | undefined,
        maxTracks: cmdOptions["limit"] as number | undefined,
        queryOptions: {
          library: (cmdOptions["library"] as string) ?? "",
          type: "track",
          // Rating filters (--min-track-stars and --max-track-stars; --min-stars fallback)
          minTrackRating: (cmdOptions["minTrackStars"] ?? cmdOptions["minStars"]) as
            | number
            | undefined,
          minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
          maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
          minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
          maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
          maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
          // Text filter options
          genre: cmdOptions["genre"] as string | undefined,
          style: cmdOptions["style"] as string | undefined,
          mood: cmdOptions["mood"] as string | undefined,
          artist: cmdOptions["artist"] as string | undefined,
          title: cmdOptions["title"] as string | undefined,
          album: cmdOptions["album"] as string | undefined,
          // Year/play options (--year parsed by parseYearFilter; --min-year/--max-year override)
          ...yearFilter,
          minYear: (cmdOptions["minYear"] as number | undefined) ?? yearFilter.minYear,
          maxYear: (cmdOptions["maxYear"] as number | undefined) ?? yearFilter.maxYear,
          minPlays: cmdOptions["minPlays"] as number | undefined,
        },
        progress:
          (cmdOptions["progress"] as boolean | undefined) ?? !isMachineFormat(globalOpts?.output),
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        url: cmdOptions["plexUrl"] as string | undefined,
        token: cmdOptions["plexToken"] as string | undefined,
        json: isMachineFormat(globalOpts?.output),
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexPlaylistAddJsonOutput = {
          command: "plex-playlist-add",
          result: {
            playlistName: result.playlistName,
            ratingKey: result.ratingKey,
            tracksAdded: result.tracksAdded,
            totalTracks: result.totalTracks,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        logSuccess(
          `Added ${result.tracksAdded} tracks to playlist "${result.playlistName}" (total: ${result.totalTracks})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Playlist add failed: ${message}`);
      process.exitCode = 1;
    }
  });

// Register subcommands to playlist parent
playlistCommand.addCommand(playlistExportCommand);
playlistCommand.addCommand(playlistSyncCommand);
playlistCommand.addCommand(playlistListCommand);
playlistCommand.addCommand(playlistCreateCommand);
playlistCommand.addCommand(playlistAddCommand);

// ============================================================================
// Sync Commands
// ============================================================================

/**
 * Helper function to output sync results in structured or console format.
 *
 * @param mode - The sync mode used (push, pull, both)
 * @param result - The sync operation result
 * @param format - The output format to use
 */
async function outputSyncResult(
  mode: string,
  result: MetadataSyncResult,
  format: OutputFormat,
): Promise<void> {
  if (isMachineFormat(format)) {
    const { formatOutput } = await import("../lib/formatters/index.js");
    await formatOutput(format, {
      command: `plex-sync-${mode}`,
      result: {
        totalTracks: result.totalTracks,
        synced: result.synced,
        skipped: result.skipped,
        conflicts: result.conflicts,
        failedCount: result.failed.length,
        failed: result.failed,
      },
    });
    return;
  }

  logInfo(`\nSync complete:`);
  logInfo(`  Total:     ${result.totalTracks}`);
  logInfo(`  Synced:    ${result.synced}`);
  logInfo(`  Skipped:   ${result.skipped}`);
  if (result.conflicts > 0) {
    logInfo(`  Conflicts: ${result.conflicts}`);
  }
  if (result.failed.length > 0) {
    logWarn(`  Failed:    ${result.failed.length}`);
  }
}

/**
 * plex sync - Parent command for rating sync operations.
 *
 * Subcommands:
 * - `push` - Push file ratings to Plex
 * - `pull` - Pull Plex ratings to file tags
 * - `both` - Bidirectional sync with conflict resolution
 */
const syncCommand = new Command("sync").description(
  "Synchronize ratings between file tags and Plex",
);

/**
 * plex sync push - Push file ratings to Plex.
 *
 * Reads ratings from file tags (POPM for MP3, Vorbis RATING for FLAC)
 * and updates the corresponding tracks in Plex.
 */
syncCommand
  .command("push")
  .description("Push file ratings to Plex")
  .argument("<source-path>", "Directory containing audio files")
  .option("-l, --library <name>", "Plex library name", "Music")
  .option("--only-rated", "Only sync tracks that have ratings in files")
  .option("-w, --workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview operations without executing")
  .option("--no-progress", "Disable progress bar")
  .action(async (sourcePath: string, cmdOptions: Record<string, unknown>) => {
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { executeMetadataSync } = await import("../actions/plex-sync.js");

      const direction: SyncDirection = { type: "push" };

      const result = await executeMetadataSync({
        direction,
        library: cmdOptions["library"] as string,
        sourcePath,
        onlyRated: cmdOptions["onlyRated"] as boolean | undefined,
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        workers: cmdOptions["workers"] as number | undefined,
        progress: cmdOptions["progress"] !== false && !isMachineFormat(globalOpts?.output),
      });

      const format = globalOpts?.output ?? "text";
      await outputSyncResult("push", result, format);

      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Sync push failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex sync pull - Pull Plex ratings to file tags.
 *
 * Reads ratings from Plex and writes them to file tags
 * (POPM for MP3, Vorbis RATING for FLAC).
 */
syncCommand
  .command("pull")
  .description("Pull Plex ratings to file tags")
  .argument("<source-path>", "Directory containing audio files")
  .option("-l, --library <name>", "Plex library name", "Music")
  .option("--only-rated", "Only sync tracks that have ratings in Plex")
  .option("--popm-email <email>", "POPM email identifier for MP3 writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis rating scale").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .option("-w, --workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview operations without executing")
  .option("--no-progress", "Disable progress bar")
  .action(async (sourcePath: string, cmdOptions: Record<string, unknown>) => {
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { executeMetadataSync } = await import("../actions/plex-sync.js");

      const direction: SyncDirection = { type: "pull" };

      const result = await executeMetadataSync({
        direction,
        library: cmdOptions["library"] as string,
        sourcePath,
        onlyRated: cmdOptions["onlyRated"] as boolean | undefined,
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        workers: cmdOptions["workers"] as number | undefined,
        progress: cmdOptions["progress"] !== false && !isMachineFormat(globalOpts?.output),
        popmEmail: cmdOptions["popmEmail"] as string | undefined,
        vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
      });

      const format = globalOpts?.output ?? "text";
      await outputSyncResult("pull", result, format);

      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Sync pull failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex sync both - Bidirectional sync with conflict resolution.
 *
 * Syncs ratings in both directions. When both sources have different
 * ratings, uses the --prefer option to determine which takes precedence.
 */
syncCommand
  .command("both")
  .description("Bidirectional sync with conflict resolution")
  .argument("<source-path>", "Directory containing audio files")
  .option("-l, --library <name>", "Plex library name", "Music")
  .addOption(
    new Option("--prefer <source>", "Conflict resolution: prefer plex or file ratings")
      .choices(["plex", "file"])
      .makeOptionMandatory(),
  )
  .option("--only-rated", "Only sync tracks that have ratings on at least one side")
  .option("--popm-email <email>", "POPM email identifier for MP3 writes")
  .addOption(
    new Option("--vorbis-scale <scale>", "Vorbis rating scale").choices([
      "normalized",
      "stars",
      "percent",
    ]),
  )
  .option("-w, --workers <n>", "Number of parallel workers", parsePositiveInt, 4)
  .option("--dry-run", "Preview operations without executing")
  .option("--no-progress", "Disable progress bar")
  .action(async (sourcePath: string, cmdOptions: Record<string, unknown>) => {
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      const { executeMetadataSync } = await import("../actions/plex-sync.js");

      const prefer = cmdOptions["prefer"] as "plex" | "file";
      const direction: SyncDirection = { type: "both", prefer };

      const result = await executeMetadataSync({
        direction,
        library: cmdOptions["library"] as string,
        sourcePath,
        onlyRated: cmdOptions["onlyRated"] as boolean | undefined,
        dryRun: cmdOptions["dryRun"] as boolean | undefined,
        workers: cmdOptions["workers"] as number | undefined,
        progress: cmdOptions["progress"] !== false && !isMachineFormat(globalOpts?.output),
        popmEmail: cmdOptions["popmEmail"] as string | undefined,
        vorbisScale: cmdOptions["vorbisScale"] as "normalized" | "stars" | "percent" | undefined,
      });

      const format = globalOpts?.output ?? "text";
      await outputSyncResult("both", result, format);

      if (result.failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Sync both failed: ${message}`);
      process.exitCode = 1;
    }
  });

// ============================================================================
// Collection Command Group
// ============================================================================

/**
 * JSON output structure for plex collection create command.
 */
interface PlexCollectionCreateJsonOutput {
  command: "plex-collection-create";
  result: {
    collectionName: string;
    totalItems: number;
    itemsAdded: number;
    smart: boolean;
    mediaType: PlexMediaType | undefined;
    metadataType?: number;
  };
}

/**
 * JSON output structure for plex collection add command.
 */
interface PlexCollectionAddJsonOutput {
  command: "plex-collection-add";
  result: {
    collectionName: string;
    itemsAdded: number;
    totalItems: number;
    mediaType: PlexMediaType | undefined;
    metadataType?: number;
  };
}

/**
 * JSON output structure for plex collection list command.
 */
interface PlexCollectionListJsonOutput {
  command: "plex-collection-list";
  result: {
    collections: Array<{
      title: string;
      itemCount: number;
      smart: boolean;
      mediaType: PlexMediaType | undefined;
      metadataType?: number;
      addedAt: number;
    }>;
    total: number;
  };
}

/**
 * JSON output structure for plex collection show command.
 */
interface PlexCollectionShowJsonOutput {
  command: "plex-collection-show";
  result: {
    title: string;
    itemCount: number;
    smart: boolean;
    mediaType: PlexMediaType | undefined;
    metadataType?: number;
    summary?: string;
    addedAt: number;
    updatedAt: number;
  };
}

/**
 * JSON output structure for plex collection delete command.
 */
interface PlexCollectionDeleteJsonOutput {
  command: "plex-collection-delete";
  result: {
    collectionName: string;
    deleted: boolean;
  };
}

/**
 * plex collection - Parent command for Plex collection operations.
 *
 * Subcommands:
 * - `create` - Create a new collection
 * - `add` - Add items to existing collection
 * - `list` - List collections in library
 * - `show` - Show collection details
 * - `delete` - Delete a collection
 */
const collectionCommand = new Command("collection").description("Manage Plex collections");

/**
 * plex collection create - Create a new collection.
 *
 * Creates a new collection in a Plex library, optionally adding items
 * matching specified filters.
 */
const collectionCreateCommand = new Command("create")
  .description("Create a new collection")
  .argument("<collection-name>", "Name of the collection to create")
  .option("--library <name>", "Library name (required)")
  .addOption(
    new Option("--type <type>", "Collection item type").choices(["track", "album", "artist"]),
  )
  .addOption(new Option("--mode <mode>", "Item mode to add").choices(["track", "album", "artist"]))
  .option("--add-track", "Alias for --mode track")
  .option("--add-album", "Alias for --mode album")
  .option("--add-artist", "Alias for --mode artist")
  .option("--genre <genre>", "Filter by genre")
  .option("--year <year>", "Filter by year (>=2020, <2000, 2020-2023)")
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0)").argParser((val) =>
      parseFloatArg(val, "--min-stars"),
    ),
  )
  // Hierarchical rating filters
  .addOption(
    new Option("--min-artist-stars <rating>", "Min artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-artist-stars <rating>", "Max artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-album-stars <rating>", "Min album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-album-stars <rating>", "Max album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-track-stars <rating>", "Min track rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-track-stars <rating>", "Max track rating (1-5)").argParser(parseStarRating),
  )
  // Text filter options
  .option("--style <style>", "Filter by style (comma-separated for OR)")
  .option("--mood <mood>", "Filter by mood (comma-separated for OR)")
  .option("--artist <name>", "Filter by artist name (contains)")
  .option("--title <name>", "Filter by track title (contains)")
  .option("--album <name>", "Filter by album title (contains)")
  // Year/play options
  .option("--min-year <year>", "Minimum release year", parseInt)
  .option("--max-year <year>", "Maximum release year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  // Named filter option
  .option("-F, --filter <name>", "Use a named filter from config")
  .option("-l, --limit <N>", "Maximum number of items to add", parseInt)
  .option("--smart", "Create smart (filter-based) collection")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (collectionName: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executeCollectionCreate } = await import("../actions/plex-collection.js");
      const collectionType = resolveCollectionCreateType(cmdOptions);
      if (cmdOptions["smart"] === true && collectionType && collectionType !== "track") {
        throw new Error(
          `--smart is only supported with track collections. Use --type track or --mode track. Received ${collectionType}.`,
        );
      }

      const result = await executeCollectionCreate({
        collectionName,
        type: collectionType,
        library: cmdOptions["library"] as string | undefined,
        genre: cmdOptions["genre"] as string | undefined,
        year: cmdOptions["year"] as string | undefined,
        minStars: cmdOptions["minStars"] as number | undefined,
        // Hierarchical rating filters
        minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
        maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
        minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
        maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
        minTrackRating: cmdOptions["minTrackStars"] as number | undefined,
        maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
        // Text filter options
        style: cmdOptions["style"] as string | undefined,
        mood: cmdOptions["mood"] as string | undefined,
        artist: cmdOptions["artist"] as string | undefined,
        title: cmdOptions["title"] as string | undefined,
        album: cmdOptions["album"] as string | undefined,
        // Year/play options
        minYear: cmdOptions["minYear"] as number | undefined,
        maxYear: cmdOptions["maxYear"] as number | undefined,
        minPlays: cmdOptions["minPlays"] as number | undefined,
        // Named filter option
        filter: cmdOptions["filter"] as string | undefined,
        limit: cmdOptions["limit"] as number | undefined,
        smart: cmdOptions["smart"] as boolean | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCollectionCreateJsonOutput = {
          command: "plex-collection-create",
          result: {
            collectionName: result.collection.title,
            totalItems: result.totalItems,
            itemsAdded: result.itemsAdded ?? 0,
            smart: result.collection.smart,
            mediaType: resolveCollectionMediaType(result.collection),
            metadataType: result.collection.metadataType,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        logSuccess(
          `Created collection "${result.collection.title}" with ${result.totalItems} items`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Collection create failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex collection add - Add items to existing collection.
 *
 * Adds items to an existing collection, either by filters or from a local folder.
 */
const collectionAddCommand = new Command("add")
  .description("Add items to existing collection")
  .argument("<collection-name>", "Name of the collection")
  .option("--library <name>", "Library name")
  .addOption(new Option("--mode <mode>", "Item mode to add").choices(["track", "album", "artist"]))
  .option("--add-track", "Alias for --mode track")
  .option("--add-album", "Alias for --mode album")
  .option("--add-artist", "Alias for --mode artist")
  .option("--from-folder <path>", "Add items from local folder")
  .option("--genre <genre>", "Filter by genre")
  .option("--year <year>", "Filter by year")
  .addOption(
    new Option("--min-stars <N>", "Minimum star rating (1.0-5.0)").argParser((val) =>
      parseFloatArg(val, "--min-stars"),
    ),
  )
  // Hierarchical rating filters
  .addOption(
    new Option("--min-artist-stars <rating>", "Min artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-artist-stars <rating>", "Max artist rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-album-stars <rating>", "Min album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-album-stars <rating>", "Max album rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--min-track-stars <rating>", "Min track rating (1-5)").argParser(parseStarRating),
  )
  .addOption(
    new Option("--max-track-stars <rating>", "Max track rating (1-5)").argParser(parseStarRating),
  )
  // Text filter options
  .option("--style <style>", "Filter by style (comma-separated for OR)")
  .option("--mood <mood>", "Filter by mood (comma-separated for OR)")
  .option("--artist <name>", "Filter by artist name (contains)")
  .option("--title <name>", "Filter by track title (contains)")
  .option("--album <name>", "Filter by album title (contains)")
  // Year/play options
  .option("--min-year <year>", "Minimum release year", parseInt)
  .option("--max-year <year>", "Maximum release year", parseInt)
  .option("--min-plays <count>", "Minimum play count", parseInt)
  // Named filter option
  .option("-F, --filter <name>", "Use a named filter from config")
  .option("-l, --limit <N>", "Maximum number of items to add", parseInt)
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (collectionName: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executeCollectionAdd } = await import("../actions/plex-collection.js");
      const resolvedMode = resolveCollectionAddMode(cmdOptions);
      if (cmdOptions["fromFolder"] && resolvedMode && resolvedMode !== "track") {
        throw new Error(
          `--from-folder only supports track mode. Remove --mode ${resolvedMode} or use --mode track.`,
        );
      }

      const result = await executeCollectionAdd({
        collectionName,
        mode: resolvedMode,
        library: cmdOptions["library"] as string | undefined,
        fromFolder: cmdOptions["fromFolder"] as string | undefined,
        genre: cmdOptions["genre"] as string | undefined,
        year: cmdOptions["year"] as string | undefined,
        minStars: cmdOptions["minStars"] as number | undefined,
        // Hierarchical rating filters
        minArtistRating: cmdOptions["minArtistStars"] as number | undefined,
        maxArtistRating: cmdOptions["maxArtistStars"] as number | undefined,
        minAlbumRating: cmdOptions["minAlbumStars"] as number | undefined,
        maxAlbumRating: cmdOptions["maxAlbumStars"] as number | undefined,
        minTrackRating: cmdOptions["minTrackStars"] as number | undefined,
        maxTrackRating: cmdOptions["maxTrackStars"] as number | undefined,
        // Text filter options
        style: cmdOptions["style"] as string | undefined,
        mood: cmdOptions["mood"] as string | undefined,
        artist: cmdOptions["artist"] as string | undefined,
        title: cmdOptions["title"] as string | undefined,
        album: cmdOptions["album"] as string | undefined,
        // Year/play options
        minYear: cmdOptions["minYear"] as number | undefined,
        maxYear: cmdOptions["maxYear"] as number | undefined,
        minPlays: cmdOptions["minPlays"] as number | undefined,
        // Named filter option
        filter: cmdOptions["filter"] as string | undefined,
        limit: cmdOptions["limit"] as number | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCollectionAddJsonOutput = {
          command: "plex-collection-add",
          result: {
            collectionName: result.collection.title,
            itemsAdded: result.itemsAdded ?? 0,
            totalItems: result.totalItems,
            mediaType: resolveCollectionMediaType(result.collection),
            metadataType: result.collection.metadataType,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        logSuccess(
          `Added ${result.itemsAdded ?? 0} items to collection "${result.collection.title}" (total: ${result.totalItems})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Collection add failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex collection list - List collections in library.
 *
 * Lists all collections in the specified library.
 */
const collectionListCommand = new Command("list")
  .description("List collections in library")
  .option("--library <name>", "Library name (required)")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executeCollectionList } = await import("../actions/plex-collection.js");

      const collections = await executeCollectionList({
        library: cmdOptions["library"] as string | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCollectionListJsonOutput = {
          command: "plex-collection-list",
          result: {
            collections: collections.map((c: PlexCollection) => ({
              title: c.title,
              itemCount: c.childCount,
              smart: c.smart,
              mediaType: resolveCollectionMediaType(c),
              metadataType: c.metadataType,
              addedAt: c.addedAt,
            })),
            total: collections.length,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        formatCollectionListResults(collections);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Failed to list collections: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex collection show - Show collection details.
 *
 * Displays detailed information about a specific collection.
 */
const collectionShowCommand = new Command("show")
  .description("Show collection details")
  .argument("<collection-name>", "Name of the collection")
  .option("--library <name>", "Library name")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (collectionName: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executeCollectionShow } = await import("../actions/plex-collection.js");

      const collection = await executeCollectionShow({
        collectionName,
        library: cmdOptions["library"] as string | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCollectionShowJsonOutput = {
          command: "plex-collection-show",
          result: {
            title: collection.title,
            itemCount: collection.childCount,
            smart: collection.smart,
            mediaType: resolveCollectionMediaType(collection),
            metadataType: collection.metadataType,
            summary: collection.summary,
            addedAt: collection.addedAt,
            updatedAt: collection.updatedAt,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        formatCollectionShowResults(collection);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Failed to show collection: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * plex collection delete - Delete a collection.
 *
 * Permanently deletes a collection from the Plex library.
 */
const collectionDeleteCommand = new Command("delete")
  .description("Delete a collection")
  .argument("<collection-name>", "Name of the collection to delete")
  .option("--library <name>", "Library name")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--plex-url <url>", "Plex server URL (overrides config)")
  .option("--plex-token <token>", "Plex auth token (overrides config)")
  .action(async (collectionName: string, cmdOptions: Record<string, unknown>) => {
    // Get global options from root command
    const globalOpts = plexCommand.parent?.opts() as GlobalOptions | undefined;

    try {
      // Lazy load action handler
      const { executeCollectionDelete } = await import("../actions/plex-collection.js");

      await executeCollectionDelete({
        collectionName,
        library: cmdOptions["library"] as string | undefined,
        yes: cmdOptions["yes"] as boolean | undefined,
        plexUrl: cmdOptions["plexUrl"] as string | undefined,
        plexToken: cmdOptions["plexToken"] as string | undefined,
      });

      // Format output
      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const { formatOutput } = await import("../lib/formatters/index.js");
        const jsonOutput: PlexCollectionDeleteJsonOutput = {
          command: "plex-collection-delete",
          result: {
            collectionName,
            deleted: true,
          },
        };
        await formatOutput(format, jsonOutput);
      } else {
        logSuccess(`Deleted collection "${collectionName}"`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`Collection delete failed: ${message}`);
      process.exitCode = 1;
    }
  });

/**
 * Format collection list results for console output.
 *
 * @param collections - Array of collection objects from Plex
 */
function formatCollectionListResults(
  collections: Array<{
    title: string;
    childCount: number;
    smart: boolean;
    mediaType?: PlexMediaType;
    metadataType?: number;
    addedAt: number;
  }>,
): void {
  console.error("");
  console.error(pc.bold("Plex Collections"));
  console.error("");

  if (collections.length === 0) {
    console.error(pc.yellow("  No collections found"));
    console.error("");
    return;
  }

  const table = new Table({
    columns: [
      { name: "name", title: "Collection", alignment: "left" },
      { name: "items", title: "Items", alignment: "right" },
      { name: "mediaType", title: "Media Type", alignment: "center" },
      { name: "collectionType", title: "State", alignment: "center" },
      { name: "added", title: "Added", alignment: "right" },
    ],
  });

  for (const collection of collections) {
    const addedDate = new Date(collection.addedAt * 1000);
    table.addRow({
      name: truncate(collection.title, 50),
      items: collection.childCount.toString(),
      mediaType: formatCollectionMediaType(resolveCollectionMediaType(collection)),
      collectionType: collection.smart ? "Smart" : "Static",
      added: addedDate.toLocaleDateString(),
    });
  }

  console.error(table.render());
  console.error("");
}

/**
 * Format collection show results for console output.
 *
 * @param collection - Collection object from Plex
 */
function formatCollectionShowResults(collection: {
  title: string;
  childCount: number;
  smart: boolean;
  mediaType?: PlexMediaType;
  metadataType?: number;
  summary?: string;
  addedAt: number;
  updatedAt: number;
}): void {
  console.error("");
  console.error(pc.bold("Collection Details"));
  console.error("");
  console.error(`  ${pc.cyan("Title:")}     ${collection.title}`);
  console.error(`  ${pc.cyan("Items:")}     ${collection.childCount}`);
  console.error(
    `  ${pc.cyan("Media Type:")} ${formatCollectionMediaType(resolveCollectionMediaType(collection))}`,
  );
  console.error(`  ${pc.cyan("Collection:")} ${collection.smart ? "Smart" : "Static"}`);
  if (collection.summary) {
    console.error(`  ${pc.cyan("Summary:")}   ${collection.summary}`);
  }
  console.error(
    `  ${pc.cyan("Added:")}     ${new Date(collection.addedAt * 1000).toLocaleString()}`,
  );
  console.error(
    `  ${pc.cyan("Updated:")}   ${new Date(collection.updatedAt * 1000).toLocaleString()}`,
  );
  console.error("");
}

function resolveCollectionMediaType(collection: {
  mediaType?: PlexMediaType;
  metadataType?: number;
}): PlexMediaType | undefined {
  return collection.mediaType ?? mediaTypeFromMetadataTypeCode(collection.metadataType);
}

function formatCollectionMediaType(mediaType: PlexMediaType | undefined): string {
  return mediaType === undefined
    ? "Unknown"
    : mediaType.charAt(0).toUpperCase() + mediaType.slice(1);
}

// Register subcommands to collection parent
collectionCommand.addCommand(collectionCreateCommand);
collectionCommand.addCommand(collectionAddCommand);
collectionCommand.addCommand(collectionListCommand);
collectionCommand.addCommand(collectionShowCommand);
collectionCommand.addCommand(collectionDeleteCommand);

// Register commands to plex parent
plexCommand.addCommand(queryCommand);
plexCommand.addCommand(copyCommand);
plexCommand.addCommand(playlistCommand);
plexCommand.addCommand(collectionCommand);
plexCommand.addCommand(syncCommand);
plexCommand.addCommand(plexAuthCommand);
