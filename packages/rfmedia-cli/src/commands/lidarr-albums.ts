/**
 * Album-scoped `rfmedia lidarr` leaf commands (DI factories).
 *
 * Hosts two sibling factories — {@link createLidarrPlanAlbumMonitoringCommand}
 * (`plan album-monitoring`) and {@link createLidarrAlbumsCommand} (the read-only
 * `albums` list leaf) — that keep commands/lidarr.ts under control without an
 * ESM cycle: both import NOTHING from ./lidarr.js. The parent injects its
 * private helpers through the exported Deps interfaces at registration time.
 *
 * Output contract matches every other Lidarr leaf: human tables render to
 * stderr only; machine formats emit exactly the `{command, result}` envelope
 * on stdout (the plan leaf flattens via dot-notation columns; the read leaf
 * uses the stable multi-row {@link LIDARR_ALBUMS_CSV_COLUMNS} schema).
 */

import { Command, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { truncate } from "../lib/format.js";
import { formatBytes } from "../lib/disk.js";
import { MissingRequiredArgumentError } from "../lib/errors.js";
import {
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../lib/lidarr/album-types.js";
import { LIDARR_PLAN_DEFAULT_MAX_BATCH } from "../types/lidarr-plan.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  LidarrAlbumPlanGenerationResult,
  LidarrAlbumsActionResult,
} from "../actions/lidarr/index.js";

/** Private helpers injected by commands/lidarr.ts (never imported — no cycle). */
export interface LidarrPlanAlbumMonitoringCommandDeps {
  /** Reads the resolved global output format off the root command. */
  readonly resolveFormat: () => OutputFormat;
  /**
   * Shared failure-contract renderer (sets `process.exitCode = 1`).
   * `sensitiveValues` is optional so existing plan callers stay source-compatible.
   */
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  /** Comma-separated unique positive-int ID parser (`label` names the kind). */
  readonly parseIdList: (label: string, value: string) => number[];
  /** Artifact blast-radius bound parser (caps at LIDARR_PLAN_MAX_BATCH). */
  readonly parseMaxBatch: (value: string) => number;
  /** Rejects plan path text that could alter a prompt or terminal diagnostic. */
  readonly assertSafePlanFileArgument: (value: string) => void;
}

/** Sample-table cap so huge plans stay reviewable on a terminal. */
const SAMPLE_ENTRY_LIMIT = 20;

function formatMonitored(monitored: boolean): string {
  return monitored ? "monitored" : "unmonitored";
}

/** Renders the scan/match accounting shared by every plan outcome. */
function renderAlbumSelectionSummary(result: LidarrAlbumPlanGenerationResult): void {
  const { selection } = result;
  console.error(
    `  Selection: ${selection.matched} matched, ${selection.alreadyInDesiredState} already in state, ` +
      `${selection.planned} planned (${selection.artistsScanned} artist(s) / ${selection.albumsScanned} album(s) scanned)`,
  );
  const selectorCounts = Object.entries(selection.bySelector);
  if (selectorCounts.length > 0) {
    const table = new Table({
      columns: [
        { name: "selector", title: "Selector", alignment: "left" },
        { name: "matched", title: "Matched", alignment: "right" },
      ],
    });
    for (const [selector, count] of selectorCounts) {
      table.addRow({ selector, matched: count });
    }
    console.error(table.render());
    console.error(
      pc.dim("  Selector counts overlap: an album matching several selectors counts in each."),
    );
  }
}

/** Renders the album plan (sealed, previewed, or no-change) to stderr. */
function renderAlbumPlan(result: LidarrAlbumPlanGenerationResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Album Monitoring Plan"));
  console.error("");

  if (result.status === "no-change") {
    renderAlbumSelectionSummary(result);
    console.error(pc.yellow("  No album monitoring changes to plan."));
    console.error("");
    return;
  }

  console.error(`  Plan: ${result.plan.id}`);
  if (result.status === "planned") {
    console.error(`  File: ${result.planPath}`);
  } else {
    console.error(pc.yellow("  Dry-run preview — no artifact was written."));
  }
  console.error(`  Target: ${result.plan.target.origin}`);
  console.error(
    `  Review: ${result.plan.review.changed} change(s), ${result.plan.review.unchanged} no-op(s), cap ${result.plan.maxBatch}`,
  );
  console.error(`  Risk: ${result.plan.risk.level} (non-destructive)`);
  for (const item of result.plan.risk.cascade) console.error(pc.dim(`  - ${item}`));
  renderAlbumSelectionSummary(result);
  console.error("");

  const table = new Table({
    columns: [
      { name: "id", title: "Album ID", alignment: "right" },
      { name: "album", title: "Album", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "type", title: "Type", alignment: "left" },
      { name: "before", title: "Before", alignment: "center" },
      { name: "after", title: "After", alignment: "center" },
    ],
  });
  for (const entry of result.plan.entries.slice(0, SAMPLE_ENTRY_LIMIT)) {
    if (!("albumId" in entry)) continue;
    table.addRow({
      id: entry.albumId,
      album: truncate(entry.albumTitle, 36),
      artist: truncate(entry.artistName, 24),
      type: entry.albumType ?? "-",
      before: formatMonitored(entry.before.monitored),
      after: formatMonitored(entry.after.monitored),
    });
  }
  console.error(table.render());
  if (result.plan.entries.length > SAMPLE_ENTRY_LIMIT) {
    console.error(
      pc.dim(`  … and ${result.plan.entries.length - SAMPLE_ENTRY_LIMIT} more entries`),
    );
  }
  console.error("");
}

/**
 * Projects the album plan result into one flat, CSV-safe record.
 *
 * Mirrors the artist projection: dot-notation column names preserve the
 * envelope paths without nested objects; compound values become JSON cells.
 */
function projectAlbumPlanCsv(result: LidarrAlbumPlanGenerationResult): Record<string, unknown> {
  const output: Record<string, unknown> = {
    command: "lidarr-plan",
    "result.status": result.status,
    "result.selection.artistsScanned": result.selection.artistsScanned,
    "result.selection.albumsScanned": result.selection.albumsScanned,
    "result.selection.matched": result.selection.matched,
    "result.selection.alreadyInDesiredState": result.selection.alreadyInDesiredState,
    "result.selection.planned": result.selection.planned,
    "result.selection.bySelector": JSON.stringify(result.selection.bySelector),
  };
  if (result.status !== "no-change") {
    output["result.planId"] = result.plan.id;
    output["result.origin"] = result.plan.target.origin;
    output["result.risk"] = result.plan.risk.level;
    output["result.maxBatch"] = result.plan.maxBatch;
    output["result.changed"] = result.plan.review.changed;
    output["result.unchanged"] = result.plan.review.unchanged;
    output["result.entries"] = JSON.stringify(result.plan.entries);
  }
  if (result.status === "planned") {
    output["result.planPath"] = result.planPath;
  }
  return output;
}

/**
 * Builds the `plan album-monitoring` leaf command.
 *
 * Note the deliberate asymmetry with the artist-monitoring leaf: this leaf
 * sanitizes `--plan-file` through {@link LidarrPlanAlbumMonitoringCommandDeps.assertSafePlanFileArgument}
 * (the artist leaf does not; only apply's positional is sanitized there).
 *
 * @param deps - Helpers injected by commands/lidarr.ts at registration time.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrPlanAlbumMonitoringCommand(
  deps: LidarrPlanAlbumMonitoringCommandDeps,
): Command {
  return new Command("album-monitoring")
    .description("Plan album-type or exact-ID album monitoring changes")
    .addOption(
      new Option("--monitored", "Set matched albums to monitored").conflicts("unmonitored"),
    )
    .addOption(
      new Option("--unmonitored", "Set matched albums to unmonitored").conflicts("monitored"),
    )
    .addOption(
      new Option(
        "--types <list>",
        "Comma-separated album-type selectors (e.g. singles,eps,compilations)",
      ).argParser(parseAlbumTypeSelectors),
    )
    .addOption(
      new Option(
        "--artist-ids <ids>",
        "Comma-separated Lidarr artist IDs scoping --types",
      ).argParser((value: string) => deps.parseIdList("Artist", value)),
    )
    .addOption(
      new Option("--album-ids <ids>", "Comma-separated exact Lidarr album IDs")
        .argParser((value: string) => deps.parseIdList("Album", value))
        .conflicts(["types", "artistIds"]),
    )
    .addOption(
      new Option("--dry-run", "Preview the selection without writing an artifact").conflicts(
        "planFile",
      ),
    )
    .addOption(
      new Option("--max-batch <n>", "Maximum targets allowed in the artifact")
        .argParser(deps.parseMaxBatch)
        .default(LIDARR_PLAN_DEFAULT_MAX_BATCH),
    )
    .option("--plan-file <path>", "Write the plan to this path")
    .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
    .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        if (cmdOptions["monitored"] !== true && cmdOptions["unmonitored"] !== true) {
          throw new MissingRequiredArgumentError("Pass --monitored or --unmonitored");
        }
        if (cmdOptions["types"] === undefined && cmdOptions["albumIds"] === undefined) {
          throw new MissingRequiredArgumentError("Pass --types or --album-ids");
        }
        const planFile = cmdOptions["planFile"] as string | undefined;
        if (planFile !== undefined) {
          deps.assertSafePlanFileArgument(planFile);
        }
        const { executeLidarrAlbumPlan } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrAlbumPlan({
          monitored: cmdOptions["monitored"] === true,
          types: cmdOptions["types"] as readonly LidarrAlbumTypeSelector[] | undefined,
          artistIds: cmdOptions["artistIds"] as number[] | undefined,
          albumIds: cmdOptions["albumIds"] as number[] | undefined,
          dryRun: cmdOptions["dryRun"] as boolean | undefined,
          maxBatch: cmdOptions["maxBatch"] as number,
          output: planFile,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        });
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(
            format,
            format === "csv" ? projectAlbumPlanCsv(result) : { command: "lidarr-plan", result },
          );
        } else {
          renderAlbumPlan(result);
        }
      } catch (error) {
        await deps.reportLidarrFailure("plan", error, { staleHint: false, format });
      }
    });
}

// ── albums (read leaf) ───────────────────────────────────────────────────────

/**
 * Read-leaf helpers injected by commands/lidarr.ts (never imported — no cycle):
 * the plan-monitoring deps plus the paging parsers and execution-summary renderer.
 */
export interface LidarrAlbumsCommandDeps extends LidarrPlanAlbumMonitoringCommandDeps {
  /** Positive-int parser for `--limit` (rejects 0 and non-integers). */
  readonly parsePositiveInt: (value: string) => number;
  /** Non-negative-int parser for `--offset`. */
  readonly parseNonNegativeInt: (value: string) => number;
  /** Renders successful execution-lane metadata beneath the human table. */
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
}

/**
 * Stable CSV schema: one summary row is always followed by album rows, the
 * `rowType` discriminator sharing one flat file (search-leaf precedent).
 */
export const LIDARR_ALBUMS_CSV_COLUMNS = [
  "command",
  "rowType",
  "page.total",
  "page.limit",
  "page.offset",
  "page.returned",
  "scan.artists",
  "scan.albums",
  "execution.taskId",
  "execution.operation",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "album.id",
  "album.title",
  "album.artistId",
  "album.artistName",
  "album.albumType",
  "album.monitored",
  "album.anyReleaseOk",
  "album.trackFileCount",
  "album.trackCount",
  "album.sizeOnDisk",
  "album.releaseDate",
  "album.foreignAlbumId",
] as const;

/**
 * Maps the Commander-negation `--has-files`/`--no-files` pair to a tri-state.
 *
 * Commander stores `--no-files` under `files` and defaults that key to `true`,
 * so only an explicit `false` means the flag was actually passed.
 */
function resolveHasFiles(cmdOptions: Record<string, unknown>): boolean | undefined {
  if (cmdOptions["hasFiles"] === true) return true;
  if (cmdOptions["files"] === false) return false;
  return undefined;
}

/** Maps `--monitored`/`--unmonitored` to a tri-state `monitored` value. */
function resolveMonitored(cmdOptions: Record<string, unknown>): boolean | undefined {
  if (cmdOptions["monitored"] === true) return true;
  if (cmdOptions["unmonitored"] === true) return false;
  return undefined;
}

/** Projects the album listing into the flat multi-row CSV records. */
function projectAlbumsCsv(result: LidarrAlbumsActionResult): readonly Record<string, unknown>[] {
  const summary: Record<string, unknown> = {
    command: "lidarr-albums",
    rowType: "summary",
    "page.total": result.total,
    "page.limit": result.pagination.limit,
    "page.offset": result.pagination.offset,
    "page.returned": result.pagination.returned,
    "scan.artists": result.scanned.artists,
    "scan.albums": result.scanned.albums,
    "execution.taskId": result.execution.taskId,
    "execution.operation": result.execution.operation,
    "execution.lane": result.execution.lane,
    "execution.outcome": result.execution.outcome,
    "execution.attempts": result.execution.attempts,
  };
  return [
    summary,
    ...result.albums.map((album) => ({
      command: "lidarr-albums",
      rowType: "album",
      "album.id": album.id,
      "album.title": album.title,
      "album.artistId": album.artistId,
      "album.artistName": album.artistName,
      "album.albumType": album.albumType,
      "album.monitored": album.monitored,
      "album.anyReleaseOk": album.anyReleaseOk,
      "album.trackFileCount": album.statistics?.trackFileCount,
      "album.trackCount": album.statistics?.trackCount,
      "album.sizeOnDisk": album.statistics?.sizeOnDisk,
      "album.releaseDate": album.releaseDate,
      "album.foreignAlbumId": album.foreignAlbumId,
    })),
  ];
}

/** Renders the album listing table plus the scan/window summary to stderr. */
function renderAlbums(result: LidarrAlbumsActionResult): void {
  console.error("");
  console.error(pc.bold("Lidarr Albums"));
  console.error("");

  if (result.albums.length === 0) {
    console.error(pc.yellow("  No albums match the criteria"));
  } else {
    const table = new Table({
      columns: [
        { name: "id", title: "Album ID", alignment: "right" },
        { name: "album", title: "Album", alignment: "left" },
        { name: "artist", title: "Artist", alignment: "left" },
        { name: "type", title: "Type", alignment: "left" },
        { name: "monitored", title: "Monitored", alignment: "center" },
        { name: "files", title: "Files", alignment: "right" },
        { name: "size", title: "Size", alignment: "right" },
        { name: "release", title: "Release", alignment: "left" },
      ],
    });
    for (const album of result.albums) {
      const trackFileCount = album.statistics?.trackFileCount ?? 0;
      const trackCount = album.statistics?.trackCount ?? 0;
      table.addRow({
        id: album.id,
        album: truncate(album.title, 36),
        artist: truncate(album.artistName, 24),
        type: album.albumType ?? "-",
        monitored: album.monitored ? "Yes" : "No",
        files: `${trackFileCount}/${trackCount}`,
        size: formatBytes(album.statistics?.sizeOnDisk ?? 0),
        release: album.releaseDate?.slice(0, 10) ?? "-",
      });
    }
    console.error(table.render());
  }

  console.error(
    pc.dim(
      `  Scanned ${result.scanned.artists} artist(s) / ${result.scanned.albums} album(s) · ` +
        `returned ${result.pagination.returned} of ${result.total} at offset ${result.pagination.offset}`,
    ),
  );
  console.error("");
}

/**
 * Builds the read-only `albums` leaf command.
 *
 * Exactly one selection scope is required and enforced in `.action()` BEFORE
 * the lazy action import, so malformed scope input never initializes the
 * client/scan path. There is deliberately no `--allow-stale` (no album
 * metadata-cache category; `staleHint:false`) and no `-v`.
 *
 * @param deps - Helpers injected by commands/lidarr.ts at registration time.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrAlbumsCommand(deps: LidarrAlbumsCommandDeps): Command {
  return new Command("albums")
    .description("List Lidarr albums with type, monitored-state, and file filtering")
    .addOption(
      new Option("--artist-ids <ids>", "Comma-separated Lidarr artist IDs to list")
        .argParser((value: string) => deps.parseIdList("Artist", value))
        .helpGroup("Selection:")
        .conflicts(["albumIds", "all"]),
    )
    .addOption(
      new Option("--album-ids <ids>", "Comma-separated exact Lidarr album IDs")
        .argParser((value: string) => deps.parseIdList("Album", value))
        .helpGroup("Selection:")
        .conflicts(["artistIds", "all", "types"]),
    )
    .addOption(
      new Option("--all", "Scan the whole library per-artist (explicit opt-in)")
        .helpGroup("Selection:")
        .conflicts(["artistIds", "albumIds"]),
    )
    .addOption(
      new Option(
        "--types <list>",
        "Comma-separated album-type selectors (e.g. singles,eps,compilations)",
      )
        .argParser(parseAlbumTypeSelectors)
        .conflicts("albumIds"),
    )
    .addOption(new Option("--monitored", "Only monitored albums").conflicts("unmonitored"))
    .addOption(new Option("--unmonitored", "Only unmonitored albums").conflicts("monitored"))
    .addOption(
      new Option("--has-files", "Only albums with at least one track file").conflicts("files"),
    )
    .addOption(
      new Option(
        "--no-files",
        "Only albums with no track files (absent statistics count as 0)",
      ).conflicts("hasFiles"),
    )
    .addOption(
      new Option("--limit <n>", "Maximum albums to return")
        .argParser(deps.parsePositiveInt)
        .default(50),
    )
    .addOption(
      new Option("--offset <n>", "Number of albums to skip")
        .argParser(deps.parseNonNegativeInt)
        .default(0),
    )
    .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
    .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        // Enforce exactly-one-scope BEFORE the lazy action import so malformed
        // scope input never initializes the client/scan path.
        const selectedScopes = [
          cmdOptions["artistIds"] !== undefined,
          cmdOptions["albumIds"] !== undefined,
          cmdOptions["all"] === true,
        ].filter((selected) => selected).length;
        if (selectedScopes !== 1) {
          throw new MissingRequiredArgumentError(
            "Choose exactly one selection scope: --artist-ids, --album-ids, or --all",
          );
        }
        const { executeLidarrAlbums } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrAlbums({
          artistIds: cmdOptions["artistIds"] as number[] | undefined,
          albumIds: cmdOptions["albumIds"] as number[] | undefined,
          all: cmdOptions["all"] as boolean | undefined,
          types: cmdOptions["types"] as readonly LidarrAlbumTypeSelector[] | undefined,
          monitored: resolveMonitored(cmdOptions),
          hasFiles: resolveHasFiles(cmdOptions),
          limit: cmdOptions["limit"] as number,
          offset: cmdOptions["offset"] as number,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        });
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          if (format === "csv") {
            await formatOutput(format, projectAlbumsCsv(result), {
              columns: [...LIDARR_ALBUMS_CSV_COLUMNS],
            });
          } else {
            await formatOutput(format, { command: "lidarr-albums", result });
          }
        } else {
          renderAlbums(result);
          deps.renderExecutionSummary(result.execution);
        }
      } catch (error) {
        await deps.reportLidarrFailure("albums", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}
