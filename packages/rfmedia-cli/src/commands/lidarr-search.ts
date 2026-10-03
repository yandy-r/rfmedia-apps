/**
 * Lidarr search and typed-lookup command factory.
 *
 * This sibling imports nothing from `./lidarr.js`: the parent injects its
 * output, failure, and execution-summary helpers to avoid an ESM cycle.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { truncateDisplay } from "../lib/format.js";
import {
  LIDARR_SEARCH_DEFAULT_LIMIT,
  LIDARR_SEARCH_MAX_LIMIT,
  normalizeLidarrSearchTerm,
} from "../lib/lidarr/search.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  LidarrSearchActionResult,
  LidarrSearchCandidate,
  LidarrSearchMode,
} from "../types/lidarr.js";

type LidarrSearchCommandId = "lidarr-search" | "lidarr-lookup-artist" | "lidarr-lookup-album";

interface LidarrSearchLeafDefinition {
  readonly name: string;
  readonly description: string;
  readonly mode: LidarrSearchMode;
  readonly commandId: LidarrSearchCommandId;
  readonly failureId: "search" | "lookup-artist" | "lookup-album";
}

/** Parent-private helpers injected without importing the parent command. */
export interface LidarrSearchCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
}

/** Search command tree returned to the Lidarr parent. */
export interface LidarrSearchCommands {
  readonly searchCommand: Command;
  readonly lookupCommand: Command;
}

/** Stable CSV schema: one summary row is always followed by candidate rows. */
export const LIDARR_SEARCH_CSV_COLUMNS = [
  "command",
  "rowType",
  "query.mode",
  "query.term",
  "page.total",
  "page.limit",
  "page.offset",
  "page.returned",
  "page.hasMore",
  "provider.requested",
  "provider.used",
  "provider.degraded",
  "provider.fallbackReason",
  "cache.source",
  "cache.fetchedAt",
  "cache.ageSeconds",
  "execution.taskId",
  "execution.operation",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "candidate.rank",
  "candidate.kind",
  "candidate.name",
  "candidate.foreignId",
  "candidate.lidarrId",
  "candidate.artistName",
  "candidate.artistForeignId",
  "candidate.artistType",
  "candidate.albumType",
  "candidate.disambiguation",
  "candidate.releaseDate",
] as const;

function parseLimit(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(`Value must be an integer from 1 to ${LIDARR_SEARCH_MAX_LIMIT}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIDARR_SEARCH_MAX_LIMIT) {
    throw new InvalidArgumentError(`Value must be an integer from 1 to ${LIDARR_SEARCH_MAX_LIMIT}`);
  }
  return parsed;
}

function parseOffset(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError("Value must be a non-negative safe integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Value must be a non-negative safe integer");
  }
  return parsed;
}

function candidateCsvFields(candidate: LidarrSearchCandidate): Record<string, unknown> {
  const common: Record<string, unknown> = {
    "candidate.rank": candidate.rank,
    "candidate.kind": candidate.kind,
    "candidate.name": candidate.name,
    "candidate.foreignId": candidate.foreignId,
    "candidate.lidarrId": candidate.lidarrId,
  };
  if (candidate.kind === "artist") {
    return {
      ...common,
      "candidate.artistType": candidate.artistType,
      "candidate.disambiguation": candidate.disambiguation,
    };
  }
  return {
    ...common,
    "candidate.artistName": candidate.artistName,
    "candidate.artistForeignId": candidate.artistForeignId,
    "candidate.albumType": candidate.albumType,
    "candidate.releaseDate": candidate.releaseDate,
  };
}

function projectSearchCsv(
  command: LidarrSearchCommandId,
  result: LidarrSearchActionResult,
): readonly Record<string, unknown>[] {
  const summary: Record<string, unknown> = {
    command,
    rowType: "summary",
    "query.mode": result.query.mode,
    "query.term": result.query.term,
    "page.total": result.total,
    "page.limit": result.limit,
    "page.offset": result.offset,
    "page.returned": result.returned,
    "page.hasMore": result.hasMore,
    "provider.requested": result.provider.requested,
    "provider.used": result.provider.used,
    "provider.degraded": result.provider.degraded,
    "provider.fallbackReason": result.provider.fallbackReason,
    "cache.source": result.cacheStatus?.source,
    "cache.fetchedAt": result.cacheStatus?.fetchedAt,
    "cache.ageSeconds": result.cacheStatus?.ageSeconds,
    "execution.taskId": result.execution.taskId,
    "execution.operation": result.execution.operation,
    "execution.lane": result.execution.lane,
    "execution.outcome": result.execution.outcome,
    "execution.attempts": result.execution.attempts,
  };
  return [
    summary,
    ...result.results.map((candidate) => ({
      command,
      rowType: "candidate",
      ...candidateCsvFields(candidate),
    })),
  ];
}

function searchHeading(mode: LidarrSearchMode): string {
  if (mode === "artist") return "Lidarr Artist Lookup";
  if (mode === "album") return "Lidarr Album Lookup";
  return "Lidarr Search";
}

function renderSearchResults(
  result: LidarrSearchActionResult,
  renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void,
): void {
  console.error("");
  console.error(
    pc.bold(`${searchHeading(result.query.mode)}: ${truncateDisplay(result.query.term, 72)}`),
  );
  console.error("");

  if (result.results.length === 0) {
    console.error("  No results.");
  } else {
    const table = new Table({
      columns: [
        { name: "rank", title: "#", alignment: "right" },
        ...(result.query.mode === "search"
          ? [{ name: "kind", title: "Kind", alignment: "left" as const }]
          : []),
        { name: "name", title: "Name", alignment: "left" },
        { name: "artist", title: "Artist", alignment: "left" },
        { name: "type", title: "Type", alignment: "left" },
        { name: "details", title: "Details", alignment: "left" },
        { name: "lidarrId", title: "Lidarr ID", alignment: "right" },
        { name: "foreignId", title: "MusicBrainz ID", alignment: "left" },
      ],
    });
    for (const candidate of result.results) {
      const isArtist = candidate.kind === "artist";
      table.addRow({
        rank: candidate.rank,
        kind: candidate.kind,
        name: truncateDisplay(candidate.name, 36),
        artist: isArtist ? "-" : truncateDisplay(candidate.artistName ?? "-", 24),
        type: truncateDisplay((isArtist ? candidate.artistType : candidate.albumType) ?? "-", 16),
        details: truncateDisplay(
          (isArtist ? candidate.disambiguation : candidate.releaseDate) ?? "-",
          28,
        ),
        lidarrId: candidate.lidarrId ?? "-",
        foreignId: candidate.foreignId,
      });
    }
    console.error(table.render());
  }

  console.error(
    `  Results: ${result.returned} returned · offset ${result.offset} · total ${result.total}` +
      (result.hasMore ? " · more available" : ""),
  );
  let provider = `  Provider: ${result.provider.used}`;
  if (result.provider.degraded) {
    provider += ` (degraded: ${result.provider.fallbackReason ?? "fallback"})`;
  }
  if (result.cacheStatus !== undefined) {
    provider += ` · cached ${result.cacheStatus.ageSeconds}s ago`;
  }
  console.error(provider);
  renderExecutionSummary(result.execution);
}

function createSearchLeaf(
  definition: LidarrSearchLeafDefinition,
  deps: LidarrSearchCommandDeps,
): Command {
  return new Command(definition.name)
    .description(definition.description)
    .argument("<term>", "Search term or exact lidarr:<MusicBrainz UUID>")
    .addOption(
      new Option("--limit <n>", "Maximum results to return")
        .argParser(parseLimit)
        .default(LIDARR_SEARCH_DEFAULT_LIMIT),
    )
    .addOption(
      new Option("--offset <n>", "Number of ranked results to skip")
        .argParser(parseOffset)
        .default(0),
    )
    .option("--allow-stale", "Allow cached results when Lidarr is unavailable")
    .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
    .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
    .action(async (term: string, cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        // Validate before the action import so malformed input cannot initialize
        // the action/client/cache path.
        const normalizedTerm = normalizeLidarrSearchTerm(term);
        const { executeLidarrSearch } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrSearch({
          mode: definition.mode,
          term: normalizedTerm,
          limit: cmdOptions["limit"] as number,
          offset: cmdOptions["offset"] as number,
          allowStale: cmdOptions["allowStale"] as boolean | undefined,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        });

        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          if (format === "csv") {
            await formatOutput(format, projectSearchCsv(definition.commandId, result), {
              columns: [...LIDARR_SEARCH_CSV_COLUMNS],
            });
          } else {
            await formatOutput(format, { command: definition.commandId, result });
          }
        } else {
          renderSearchResults(result, deps.renderExecutionSummary);
        }
      } catch (error) {
        await deps.reportLidarrFailure(definition.failureId, error, {
          staleHint: cmdOptions["allowStale"] !== true,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}

/** Builds the `search` and `lookup artist|album` command tree. */
export function createLidarrSearchCommands(deps: LidarrSearchCommandDeps): LidarrSearchCommands {
  const searchCommand = createSearchLeaf(
    {
      name: "search",
      description: "Search Lidarr for artists and albums",
      mode: "search",
      commandId: "lidarr-search",
      failureId: "search",
    },
    deps,
  );
  const lookupCommand = new Command("lookup").description("Look up Lidarr artists or albums");
  lookupCommand.addCommand(
    createSearchLeaf(
      {
        name: "artist",
        description: "Look up Lidarr artists",
        mode: "artist",
        commandId: "lidarr-lookup-artist",
        failureId: "lookup-artist",
      },
      deps,
    ),
  );
  lookupCommand.addCommand(
    createSearchLeaf(
      {
        name: "album",
        description: "Look up Lidarr albums",
        mode: "album",
        commandId: "lidarr-lookup-album",
        failureId: "lookup-album",
      },
      deps,
    ),
  );
  return { searchCommand, lookupCommand };
}
