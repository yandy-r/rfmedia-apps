/**
 * Public similar-artist discovery command and optional add-plan handoff.
 *
 * The parent injects output/failure helpers to keep this factory independent
 * from the Lidarr command module and avoid an ESM cycle.
 */

import { Command, InvalidArgumentError, Option } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { MissingRequiredArgumentError } from "../lib/errors.js";
import { truncateDisplay } from "../lib/format.js";
import {
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../lib/lidarr/album-types.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  LidarrDiscoverHandoff,
  LidarrDiscoverResult,
  SimilarArtistRecommendation,
} from "../types/discovery.js";
import {
  LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST,
  LIDARR_DISCOVER_DEFAULT_LIMIT,
  LIDARR_DISCOVER_DEFAULT_MAX_ADD,
  LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED,
  LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY,
  LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING,
  LIDARR_DISCOVER_MAX_ADD,
  LIDARR_DISCOVER_MAX_LIMIT,
  LIDARR_DISCOVER_MAX_PER_SEED,
  LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
  LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
} from "../types/discovery.js";

/** Parent-private helpers injected without importing the parent command. */
export interface LidarrDiscoverCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly parseResourceReference: (value: string) => string;
  readonly parsePlanFile: (value: string) => string;
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

/** Stable CSV schema with one mandatory summary followed by recommendation rows. */
export const LIDARR_DISCOVER_CSV_COLUMNS = [
  "command",
  "rowType",
  "seed.requestedName",
  "seed.resolvedName",
  "seed.autocorrected",
  "request.limit",
  "request.autocorrect",
  "policy.minSimilarity",
  "policy.maxPerSeed",
  "policy.deep",
  "policy.cascade",
  "policy.maxDepth",
  "policy.diversityBoost",
  "policy.popularityDampening",
  "policy.maxAdd",
  "hardBounds.providerLimit",
  "hardBounds.maxMinSimilarity",
  "hardBounds.maxPerSeed",
  "hardBounds.maxDepth",
  "hardBounds.maxRequests",
  "hardBounds.maxVisitedSeeds",
  "hardBounds.maxVisibleCandidates",
  "hardBounds.maxScoreWeight",
  "hardBounds.maxAdd",
  "traversal.seedsRequested",
  "traversal.requestsMade",
  "traversal.maximumDepthReached",
  "traversal.visited",
  "traversal.visible",
  "traversal.filtered",
  "traversal.duplicatePaths",
  "returned",
  "source.provider",
  "source.method",
  "source.attribution",
  "source.url",
  "source.fetchedAt",
  "execution.taskId",
  "execution.operation",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "handoff.status",
  "handoff.selectedRank",
  "handoff.selectedRanks",
  "handoff.musicBrainzId",
  "handoff.planId",
  "handoff.planChecksum",
  "handoff.planPath",
  "handoff.nextCommand",
  "handoff.lidarrId",
  "handoff.code",
  "handoff.message",
  "handoff.retryable",
  "handoff.counts.approved",
  "handoff.counts.alreadyPresent",
  "handoff.counts.planned",
  "handoff.counts.failed",
  "handoff.approvals",
  "recommendation.rank",
  "recommendation.name",
  "recommendation.similarity",
  "recommendation.rawSimilarity",
  "recommendation.adjustedScore",
  "recommendation.musicBrainzId",
  "recommendation.sourceUrl",
  "recommendation.addEligibility",
  "recommendation.status",
  "recommendation.reason",
  "recommendation.exposureCount",
  "recommendation.popularityEvidence",
  "recommendation.provenance.seedArtist",
  "recommendation.provenance.parentArtist",
  "recommendation.provenance.depth",
  "recommendation.provenance.providerRank",
  "recommendation.provenance.firstSeenSequence",
  "recommendation.provenance.firstPath",
  "recommendation.provenance.discoveredAt",
] as const;

function parseLimit(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError(
      `Value must be an integer from 1 to ${LIDARR_DISCOVER_MAX_LIMIT}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > LIDARR_DISCOVER_MAX_LIMIT) {
    throw new InvalidArgumentError(
      `Value must be an integer from 1 to ${LIDARR_DISCOVER_MAX_LIMIT}`,
    );
  }
  return parsed;
}

function parseBoundedCount(value: string, maximum: number): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError(`Value must be an integer from 1 to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new InvalidArgumentError(`Value must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function parseMaxPerSeed(value: string): number {
  return parseBoundedCount(value, LIDARR_DISCOVER_MAX_PER_SEED);
}

function parseMaxAdd(value: string): number {
  return parseBoundedCount(value, LIDARR_DISCOVER_MAX_ADD);
}

function parseBoundedDecimal(value: string): number {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(value)) {
    throw new InvalidArgumentError(
      `Value must be a finite decimal from 0 to ${LIDARR_DISCOVER_MAX_SCORE_WEIGHT}`,
    );
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > LIDARR_DISCOVER_MAX_SCORE_WEIGHT) {
    throw new InvalidArgumentError(
      `Value must be a finite decimal from 0 to ${LIDARR_DISCOVER_MAX_SCORE_WEIGHT}`,
    );
  }
  return parsed;
}

function parseSelectedRanks(value: string): number[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !/^[1-9]\d*$/u.test(part))) {
    throw new InvalidArgumentError("Ranks must be comma-separated positive integers");
  }
  const ranks = parts.map(Number);
  if (
    ranks.some(
      (rank) => !Number.isSafeInteger(rank) || rank > LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
    )
  ) {
    throw new InvalidArgumentError(
      `Ranks must be integers from 1 to ${LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES}`,
    );
  }
  if (new Set(ranks).size !== ranks.length) {
    throw new InvalidArgumentError("Ranks must be unique");
  }
  return ranks.sort((left, right) => left - right);
}

function handoffCsvFields(handoff: LidarrDiscoverHandoff): Record<string, unknown> {
  const output: Record<string, unknown> = {
    "handoff.status": handoff.status,
    "handoff.counts.approved": handoff.counts.approved,
    "handoff.counts.alreadyPresent": handoff.counts.alreadyPresent,
    "handoff.counts.planned": handoff.counts.planned,
    "handoff.counts.failed": handoff.counts.failed,
    "handoff.approvals": JSON.stringify(handoff.approvals),
  };
  if (handoff.status === "not-requested") return output;

  output["handoff.selectedRank"] = handoff.selectedRank;
  output["handoff.selectedRanks"] = handoff.selectedRanks.join(",");
  if (handoff.status === "failed") {
    output["handoff.code"] = handoff.code;
    output["handoff.message"] = handoff.message;
    output["handoff.retryable"] = handoff.retryable;
    return output;
  }

  output["handoff.musicBrainzId"] = handoff.musicBrainzId;
  if (handoff.status === "already-present") {
    output["handoff.lidarrId"] = handoff.lidarrId;
    return output;
  }
  output["handoff.planId"] = handoff.planId;
  output["handoff.planChecksum"] = handoff.planChecksum;
  output["handoff.planPath"] = handoff.planPath;
  output["handoff.nextCommand"] = handoff.nextCommand;
  return output;
}

function recommendationCsvFields(
  recommendation: SimilarArtistRecommendation,
): Record<string, unknown> {
  return {
    "recommendation.rank": recommendation.rank,
    "recommendation.name": recommendation.name,
    "recommendation.similarity": recommendation.similarity,
    "recommendation.rawSimilarity": recommendation.rawSimilarity,
    "recommendation.adjustedScore": recommendation.adjustedScore,
    "recommendation.musicBrainzId": recommendation.musicBrainzId,
    "recommendation.sourceUrl": recommendation.sourceUrl,
    "recommendation.addEligibility": recommendation.addEligibility,
    "recommendation.status": recommendation.status,
    "recommendation.reason": recommendation.reason,
    "recommendation.exposureCount": recommendation.exposureCount,
    "recommendation.popularityEvidence": recommendation.popularityEvidence,
    "recommendation.provenance.seedArtist": recommendation.provenance.seedArtist,
    "recommendation.provenance.parentArtist": recommendation.provenance.parentArtist,
    "recommendation.provenance.depth": recommendation.provenance.depth,
    "recommendation.provenance.providerRank": recommendation.provenance.providerRank,
    "recommendation.provenance.firstSeenSequence": recommendation.provenance.firstSeenSequence,
    "recommendation.provenance.firstPath": recommendation.provenance.firstPath.join(" > "),
    "recommendation.provenance.discoveredAt": recommendation.provenance.discoveredAt,
  };
}

function projectDiscoverCsv(result: LidarrDiscoverResult): readonly Record<string, unknown>[] {
  return [
    {
      command: "lidarr-discover",
      rowType: "summary",
      "seed.requestedName": result.seed.requestedName,
      "seed.resolvedName": result.seed.resolvedName,
      "seed.autocorrected": result.seed.autocorrected,
      "request.limit": result.request.limit,
      "request.autocorrect": result.request.autocorrect,
      "policy.minSimilarity": result.policy.minSimilarity,
      "policy.maxPerSeed": result.policy.maxPerSeed,
      "policy.deep": result.policy.deep,
      "policy.cascade": result.policy.cascade,
      "policy.maxDepth": result.policy.maxDepth,
      "policy.diversityBoost": result.policy.diversityBoost,
      "policy.popularityDampening": result.policy.popularityDampening,
      "policy.maxAdd": result.policy.maxAdd,
      "hardBounds.providerLimit": result.hardBounds.providerLimit,
      "hardBounds.maxMinSimilarity": result.hardBounds.maxMinSimilarity,
      "hardBounds.maxPerSeed": result.hardBounds.maxPerSeed,
      "hardBounds.maxDepth": result.hardBounds.maxDepth,
      "hardBounds.maxRequests": result.hardBounds.maxRequests,
      "hardBounds.maxVisitedSeeds": result.hardBounds.maxVisitedSeeds,
      "hardBounds.maxVisibleCandidates": result.hardBounds.maxVisibleCandidates,
      "hardBounds.maxScoreWeight": result.hardBounds.maxScoreWeight,
      "hardBounds.maxAdd": result.hardBounds.maxAdd,
      "traversal.seedsRequested": result.traversal.seedsRequested,
      "traversal.requestsMade": result.traversal.requestsMade,
      "traversal.maximumDepthReached": result.traversal.maximumDepthReached,
      "traversal.visited": result.traversal.visited,
      "traversal.visible": result.traversal.visible,
      "traversal.filtered": result.traversal.filtered,
      "traversal.duplicatePaths": result.traversal.duplicatePaths,
      returned: result.returned,
      "source.provider": result.source.provider,
      "source.method": result.source.method,
      "source.attribution": result.source.attribution,
      "source.url": result.source.url,
      "source.fetchedAt": result.source.fetchedAt,
      "execution.taskId": result.execution.taskId,
      "execution.operation": result.execution.operation,
      "execution.lane": result.execution.lane,
      "execution.outcome": result.execution.outcome,
      "execution.attempts": result.execution.attempts,
      ...handoffCsvFields(result.handoff),
    },
    ...result.recommendations.map((recommendation) => ({
      command: "lidarr-discover",
      rowType: "recommendation",
      ...recommendationCsvFields(recommendation),
    })),
  ];
}

function renderDiscover(
  result: LidarrDiscoverResult,
  renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void,
): void {
  console.error("");
  console.error(pc.bold(`Similar artists for ${truncateDisplay(result.seed.resolvedName, 72)}`));
  if (result.seed.autocorrected) {
    console.error(`  Requested seed: ${truncateDisplay(result.seed.requestedName, 72)}`);
  }
  console.error("");

  if (result.recommendations.length === 0) {
    console.error("  No recommendations.");
  } else {
    const table = new Table({
      columns: [
        { name: "rank", title: "#", alignment: "right" },
        { name: "artist", title: "Artist", alignment: "left" },
        { name: "raw", title: "Raw", alignment: "right" },
        { name: "adjusted", title: "Adjusted", alignment: "right" },
        { name: "status", title: "Status", alignment: "left" },
        { name: "reason", title: "Reason", alignment: "left" },
        { name: "exposure", title: "Exposure", alignment: "right" },
        { name: "provenance", title: "Provenance", alignment: "left" },
        { name: "mbid", title: "MusicBrainz ID", alignment: "left" },
        { name: "eligibility", title: "Add eligibility", alignment: "left" },
      ],
    });
    for (const recommendation of result.recommendations) {
      table.addRow({
        rank: recommendation.rank,
        artist: truncateDisplay(recommendation.name, 40),
        raw: recommendation.rawSimilarity.toFixed(4),
        adjusted: recommendation.adjustedScore.toFixed(4),
        status: recommendation.status,
        reason: recommendation.reason,
        exposure: recommendation.exposureCount,
        provenance: truncateDisplay(
          `${recommendation.provenance.parentArtist} · depth ${recommendation.provenance.depth} · provider #${recommendation.provenance.providerRank} · ${recommendation.provenance.firstPath.join(" > ")}`,
          72,
        ),
        mbid: recommendation.musicBrainzId ?? "-",
        eligibility: recommendation.addEligibility,
      });
    }
    console.error(table.render());
  }

  console.error(
    `  Policy: min similarity ${result.policy.minSimilarity}; max per seed ${result.policy.maxPerSeed}; depth ${result.policy.maxDepth}; cascade ${String(result.policy.cascade)}; diversity boost ${result.policy.diversityBoost}; popularity dampening ${result.policy.popularityDampening} (${result.policy.popularityDampening === 0 ? "disabled" : "graph-exposure"}); max add ${result.policy.maxAdd}`,
  );
  console.error(
    `  Hard bounds: provider ${result.hardBounds.providerLimit}; per seed ${result.hardBounds.maxPerSeed}; depth ${result.hardBounds.maxDepth}; requests ${result.hardBounds.maxRequests}; visited seeds ${result.hardBounds.maxVisitedSeeds}; visible ${result.hardBounds.maxVisibleCandidates}; max add ${result.hardBounds.maxAdd}`,
  );
  console.error(
    `  Traversal: ${result.traversal.seedsRequested} seed(s); ${result.traversal.requestsMade} request(s); depth ${result.traversal.maximumDepthReached}; ${result.traversal.visited} visited; ${result.traversal.visible} visible; ${result.traversal.filtered} filtered; ${result.traversal.duplicatePaths} duplicate path(s)`,
  );
  console.error(`  Results: ${result.returned}`);
  console.error(
    `  Source: ${result.source.attribution} · ${result.source.method} · ${result.source.url}`,
  );
  console.error(`  Fetched: ${result.source.fetchedAt}`);
  switch (result.handoff.status) {
    case "not-requested":
      console.error("  Handoff: not requested; no artists were added.");
      break;
    case "plan-created":
      console.error(`  Handoff: plan created for ranks ${result.handoff.selectedRanks.join(", ")}`);
      console.error(`  Plan: ${result.handoff.planId}`);
      console.error(`  Checksum: ${result.handoff.planChecksum}`);
      console.error(`  File: ${result.handoff.planPath}`);
      console.error(`  Next: ${result.handoff.nextCommand}`);
      break;
    case "already-present":
      console.error(
        `  Handoff: selected ranks ${result.handoff.selectedRanks.join(", ")} are already present; first Lidarr artist ${result.handoff.lidarrId}.`,
      );
      break;
    case "failed":
      console.error(
        pc.red(
          `  Handoff failed (${result.handoff.code}): ${result.handoff.message}` +
            (result.handoff.retryable ? " · retryable" : ""),
        ),
      );
      break;
  }
  console.error(
    `  Handoff counts: ${result.handoff.counts.approved} approved; ${result.handoff.counts.alreadyPresent} already present; ${result.handoff.counts.planned} planned; ${result.handoff.counts.failed} failed`,
  );
  for (const approval of result.handoff.approvals) {
    console.error(
      `    Rank ${approval.selectedRank}: ${approval.status}` +
        ("musicBrainzId" in approval ? ` · ${approval.musicBrainzId}` : "") +
        (approval.status === "already-present" ? ` · Lidarr ${approval.lidarrId}` : "") +
        (approval.status === "failed" ? ` · ${approval.code}: ${approval.message}` : ""),
    );
  }
  renderExecutionSummary(result.execution);
}

function readStringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function validateHandoffGrammar(options: Record<string, unknown>): void {
  if (options["deep"] === true && options["cascade"] === false) {
    throw new MissingRequiredArgumentError("--deep conflicts with --no-cascade");
  }
  const selectedRanks = options["add"];
  const maxAdd = options["maxAdd"];
  if (Array.isArray(selectedRanks) && typeof maxAdd === "number" && selectedRanks.length > maxAdd) {
    throw new MissingRequiredArgumentError(
      `--add selects ${selectedRanks.length} ranks but --max-add allows at most ${maxAdd}`,
    );
  }
  const addOnlyKeys = [
    "rootFolder",
    "qualityProfile",
    "metadataProfile",
    "monitored",
    "unmonitorTypes",
    "planFile",
    "lidarrUrl",
    "lidarrApiKey",
  ] as const;
  if (selectedRanks === undefined) {
    const unexpected = addOnlyKeys.find((key) => options[key] !== undefined);
    if (unexpected !== undefined) {
      throw new MissingRequiredArgumentError(
        `--${unexpected.replace(/[A-Z]/g, "-$&").toLowerCase()} requires --add`,
      );
    }
    return;
  }
  const requiredAddKeys = ["rootFolder", "qualityProfile", "planFile"] as const;
  const missing = requiredAddKeys.find((key) => readStringOption(options, key) === undefined);
  if (missing !== undefined) {
    throw new MissingRequiredArgumentError(
      `--add requires --${missing.replace(/[A-Z]/g, "-$&").toLowerCase()}`,
    );
  }
}

/** Builds the public `lidarr discover` leaf. */
export function createLidarrDiscoverCommand(deps: LidarrDiscoverCommandDeps): Command {
  return new Command("discover")
    .description("Discover similar artists through Last.fm")
    .requiredOption("--artist <name>", "Seed artist name")
    .addOption(
      new Option("--limit <n>", "Maximum recommendations to return")
        .argParser(parseLimit)
        .default(LIDARR_DISCOVER_DEFAULT_LIMIT),
    )
    .option("--no-autocorrect", "Disable Last.fm artist-name autocorrection")
    .addOption(
      new Option("--min-similarity <score>", "Minimum raw similarity from 0 through 1")
        .argParser(parseBoundedDecimal)
        .default(LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY),
    )
    .addOption(
      new Option("--max-per-seed <count>", "Maximum admitted candidates per seed")
        .argParser(parseMaxPerSeed)
        .default(LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED),
    )
    .option("--deep", "Traverse similar artists breadth-first to fixed depth two")
    .option("--no-cascade", "Force one-hop traversal")
    .addOption(
      new Option("--diversity-boost <weight>", "Diversity adjustment weight from 0 through 1")
        .argParser(parseBoundedDecimal)
        .default(LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST),
    )
    .addOption(
      new Option(
        "--popularity-dampening <weight>",
        "Graph-exposure dampening weight from 0 through 1",
      )
        .argParser(parseBoundedDecimal)
        .default(LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING),
    )
    .addOption(
      new Option("--max-add <count>", "Maximum approved candidates")
        .argParser(parseMaxAdd)
        .default(LIDARR_DISCOVER_DEFAULT_MAX_ADD),
    )
    .addOption(
      new Option(
        "--add <ranks>",
        "Create one add plan for comma-separated visible ranks",
      ).argParser(parseSelectedRanks),
    )
    .addOption(
      new Option(
        "--root-folder <reference>",
        "Existing Lidarr root folder for the add plan",
      ).argParser(deps.parseResourceReference),
    )
    .addOption(
      new Option(
        "--quality-profile <reference>",
        "Existing Lidarr quality profile for the add plan",
      ).argParser(deps.parseResourceReference),
    )
    .addOption(
      new Option(
        "--metadata-profile <reference>",
        "Existing Lidarr metadata profile for the add plan",
      ).argParser(deps.parseResourceReference),
    )
    .addOption(new Option("--monitored", "Add artists as monitored"))
    .addOption(
      new Option(
        "--unmonitor-types <types>",
        "Unmonitor matching album types after adding",
      ).argParser(parseAlbumTypeSelectors),
    )
    .addOption(
      new Option("--plan-file <path>", "Write the sealed add plan to this path").argParser(
        deps.parsePlanFile,
      ),
    )
    .option("--lidarr-url <url>", "Lidarr base URL for add planning only")
    .option("--lidarr-api-key <key>", "Lidarr API key for add planning only")
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        validateHandoffGrammar(cmdOptions);
        const selectedRanks = cmdOptions["add"];
        const { executeLidarrDiscover } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrDiscover({
          artist: readStringOption(cmdOptions, "artist") ?? "",
          limit: cmdOptions["limit"] as number,
          autocorrect: cmdOptions["autocorrect"] !== false,
          minSimilarity: cmdOptions["minSimilarity"] as number,
          maxPerSeed: cmdOptions["maxPerSeed"] as number,
          deep: cmdOptions["deep"] === true,
          cascade: cmdOptions["cascade"] !== false,
          diversityBoost: cmdOptions["diversityBoost"] as number,
          popularityDampening: cmdOptions["popularityDampening"] as number,
          maxAdd: cmdOptions["maxAdd"] as number,
          ...(Array.isArray(selectedRanks)
            ? {
                handoff: {
                  selectedRanks: selectedRanks as number[],
                  rootFolder: readStringOption(cmdOptions, "rootFolder") ?? "",
                  qualityProfile: readStringOption(cmdOptions, "qualityProfile") ?? "",
                  planFile: readStringOption(cmdOptions, "planFile") ?? "",
                  lidarrUrl: readStringOption(cmdOptions, "lidarrUrl"),
                  lidarrApiKey: readStringOption(cmdOptions, "lidarrApiKey"),
                  ...(readStringOption(cmdOptions, "metadataProfile") === undefined
                    ? {}
                    : { metadataProfile: readStringOption(cmdOptions, "metadataProfile") }),
                  ...(cmdOptions["monitored"] === true ? { monitored: true } : {}),
                  ...(Array.isArray(cmdOptions["unmonitorTypes"])
                    ? {
                        postAddUnmonitorSelectors: cmdOptions[
                          "unmonitorTypes"
                        ] as readonly LidarrAlbumTypeSelector[],
                      }
                    : {}),
                },
              }
            : {}),
        });

        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          if (format === "csv") {
            await formatOutput(format, projectDiscoverCsv(result), {
              columns: [...LIDARR_DISCOVER_CSV_COLUMNS],
            });
          } else {
            await formatOutput(format, { command: "lidarr-discover", result });
          }
        } else {
          renderDiscover(result, deps.renderExecutionSummary);
        }
        if (result.handoff.status === "failed") {
          process.exitCode = 1;
        }
      } catch (error) {
        await deps.reportLidarrFailure("discover", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}
