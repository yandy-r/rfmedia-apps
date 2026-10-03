/** `rfmedia lidarr plan track-filter` command factory. */

import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { MissingRequiredArgumentError } from "../lib/errors.js";
import {
  LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH,
  type LidarrTrackFilterPlanGenerationResult,
} from "../actions/lidarr/plan-track-filter.js";
import { projectMutationPlanCsv, renderMutationPlan } from "./lidarr-mutation-presenter.js";

export interface LidarrTrackFilterCommandDeps {
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
  readonly parseIdList: (label: string, value: string) => number[];
  readonly parseMaxBatch: (value: string) => number;
  readonly assertSafePlanFileArgument: (value: string) => void;
}

const PREVIEW_PATH = "preview only (no artifact written)";

function parseAlbumId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError("Album ID must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError("Album ID must be a positive safe integer");
  }
  return parsed;
}

function parseMinStars(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 5 || !Number.isInteger(parsed * 2)) {
    throw new InvalidArgumentError("--min-stars must be a half-star from 0.5 to 5");
  }
  return parsed;
}

function toReviewablePlan(
  result: Extract<LidarrTrackFilterPlanGenerationResult, { status: "planned" | "previewed" }>,
) {
  return {
    planPath: result.status === "planned" ? result.planPath : PREVIEW_PATH,
    plan: result.plan,
  };
}

function projectTrackFilterCsv(
  result: LidarrTrackFilterPlanGenerationResult,
): Record<string, unknown> {
  if (result.status === "no-change") {
    return {
      command: "lidarr-plan",
      "result.status": "no-change",
      "result.selection": JSON.stringify(result.selection),
    };
  }
  const projected = projectMutationPlanCsv(toReviewablePlan(result));
  if (result.status === "planned") {
    return { ...projected, "result.status": "planned" };
  }
  const { ["result.planPath"]: _omitted, ...preview } = projected;
  return { ...preview, "result.status": "previewed" };
}

function renderTrackFilterPlan(result: LidarrTrackFilterPlanGenerationResult): void {
  if (result.status === "no-change") {
    console.error("");
    console.error(pc.yellow("  No trackfiles matched the deletion criteria."));
    console.error(
      pc.dim(`  ${result.selection.kept} kept; ${result.selection.warnings.length} warning(s).`),
    );
    console.error("");
    return;
  }
  renderMutationPlan(toReviewablePlan(result), true);
}

/** Builds the exact-album, preview-by-default trackfile-filter plan command. */
export function createLidarrPlanTrackFilterCommand(deps: LidarrTrackFilterCommandDeps): Command {
  return new Command("track-filter")
    .description("Preview or seal exact trackfile deletions for one Lidarr album")
    .requiredOption("--album-id <id>", "Exact Lidarr album ID", parseAlbumId)
    .addOption(
      new Option("--keep-track-ids <ids>", "Comma-separated track IDs to retain").argParser(
        (value: string) => deps.parseIdList("Track", value),
      ),
    )
    .addOption(
      new Option("--min-stars <stars>", "Retain files at or above this embedded rating").argParser(
        parseMinStars,
      ),
    )
    .addOption(
      new Option("--max-batch <n>", "Maximum trackfile deletions allowed in the plan")
        .argParser(deps.parseMaxBatch)
        .default(LIDARR_TRACK_FILTER_DEFAULT_MAX_BATCH),
    )
    .option("--out <file>", "Write the sealed plan artifact to this path")
    .option("--lidarr-url <url>", "Lidarr base URL (overrides config)")
    .option("--lidarr-api-key <key>", "Lidarr API key (overrides config)")
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        if (cmdOptions["keepTrackIds"] === undefined && cmdOptions["minStars"] === undefined) {
          throw new MissingRequiredArgumentError("Pass --keep-track-ids and/or --min-stars");
        }
        const output = cmdOptions["out"] as string | undefined;
        if (output !== undefined) {
          deps.assertSafePlanFileArgument(output);
        }
        const { executeLidarrTrackFilterPlan } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrTrackFilterPlan({
          albumId: cmdOptions["albumId"] as number,
          keepTrackIds: cmdOptions["keepTrackIds"] as number[] | undefined,
          minStars: cmdOptions["minStars"] as number | undefined,
          maxBatch: cmdOptions["maxBatch"] as number,
          dryRun: output === undefined,
          output,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        });
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(
            format,
            format === "csv" ? projectTrackFilterCsv(result) : { command: "lidarr-plan", result },
          );
        } else {
          renderTrackFilterPlan(result);
        }
      } catch (error) {
        await deps.reportLidarrFailure("plan-track-filter", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}
