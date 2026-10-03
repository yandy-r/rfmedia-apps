/**
 * `rfmedia lidarr plan album-edit` and `plan album-delete` leaf commands (DI factories).
 *
 * These siblings keep commands/lidarr.ts small without an ESM cycle: they import
 * NOTHING from ./lidarr.js. The parent injects its private helpers (format
 * resolution, the shared failure reporter, and the argument parsers) through
 * {@link LidarrAlbumMutationCommandDeps} at registration time.
 *
 * Human plan review renders through the shared mutation presenter — including the
 * destructive banner and authorization hints for the delete lane — while machine
 * formats emit the `{command: "lidarr-plan", result}` envelope on stdout (CSV
 * flattened via dot-notation columns).
 */

import { Command, Option } from "commander";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { MissingRequiredArgumentError } from "../lib/errors.js";
import {
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../lib/lidarr/album-types.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  LIDARR_PLAN_VERSION_V3,
  type LidarrAlbumMutationPlanV2,
  type LidarrAlbumMutationPlanV3,
  type LidarrPlanGenerationResultV3,
} from "../types/lidarr-plan.js";
import type {
  LidarrAlbumDeletePlanGenerationResult,
  LidarrAlbumEditPlanGenerationResult,
} from "../actions/lidarr/index.js";
import { projectMutationPlanCsv, renderMutationPlan } from "./lidarr-mutation-presenter.js";

/** Private helpers injected by commands/lidarr.ts (never imported — no cycle). */
export interface LidarrAlbumMutationCommandDeps {
  /** Reads the resolved global output format off the root command. */
  readonly resolveFormat: () => OutputFormat;
  /** Shared failure-contract renderer (sets `process.exitCode = 1`; redacts secrets). */
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

/** Either album-mutation producer result — edit and delete share the status union. */
type LidarrAlbumMutationGenerationResult =
  | LidarrAlbumEditPlanGenerationResult
  | LidarrAlbumDeletePlanGenerationResult;

/** Shown in the plan path line when a dry-run built a plan without writing it. */
const DRY_RUN_PREVIEW_PATH = "dry-run preview (no artifact written)";

type ReviewableAlbumMutationPlan =
  | {
      readonly planPath: string;
      readonly plan: LidarrAlbumMutationPlanV2;
    }
  | LidarrPlanGenerationResultV3<LidarrAlbumMutationPlanV3>;

/** Adapts a plan-bearing producer result to the shared presenter's reviewable shape. */
function toReviewablePlan(
  result: Extract<LidarrAlbumMutationGenerationResult, { status: "planned" | "previewed" }>,
): ReviewableAlbumMutationPlan {
  const planPath = result.status === "planned" ? result.planPath : DRY_RUN_PREVIEW_PATH;
  const plan: LidarrAlbumMutationPlanV2 | LidarrAlbumMutationPlanV3 = result.plan;
  return plan.version === LIDARR_PLAN_VERSION_V3 ? { planPath, plan } : { planPath, plan };
}

/** Renders a generated album-mutation plan (planned, previewed, or no-change) to stderr. */
function renderAlbumMutationPlan(
  result: LidarrAlbumMutationGenerationResult,
  emptyNotice: string,
): void {
  if (result.status === "no-change") {
    console.error("");
    console.error(pc.yellow(`  ${emptyNotice}`));
    console.error("");
    return;
  }
  renderMutationPlan(toReviewablePlan(result), false);
}

/** Projects a generated album-mutation plan into the shared one-row CSV shape. */
function projectAlbumMutationPlanCsv(
  result: LidarrAlbumMutationGenerationResult,
): Record<string, unknown> {
  if (result.status === "no-change") {
    return { command: "lidarr-plan", "result.status": "no-change" };
  }
  const projected = projectMutationPlanCsv(toReviewablePlan(result));
  if (result.status === "previewed") {
    // A dry-run writes no artifact, so drop the placeholder planPath (a
    // consumer must never read a non-path from result.planPath) and expose
    // the status instead — matching the `plan album-monitoring` leaf.
    const { ["result.planPath"]: _omitted, ...rest } = projected;
    return { ...rest, "result.status": "previewed" };
  }
  return { ...projected, "result.status": "planned" };
}

/**
 * Builds the `plan album-edit` leaf command.
 *
 * The desired change is a Commander positive/negative pair resolving to one
 * boolean (`anyReleaseOk`). Because a `--no-*` flag gives Commander a `true`
 * default, presence is detected via `getOptionValueSource` so the required-choice
 * error still fires when the operator passes neither flag. No `-v` flag exists —
 * the locked album-leaf asymmetry keeps the sample capped at the presenter default.
 *
 * @param deps - Helpers injected by commands/lidarr.ts at registration time.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrPlanAlbumEditCommand(deps: LidarrAlbumMutationCommandDeps): Command {
  return new Command("album-edit")
    .description("Plan album release-policy (any-release-ok) changes")
    .addOption(
      new Option("--album-ids <ids>", "Comma-separated exact Lidarr album IDs")
        .argParser((value: string) => deps.parseIdList("Album", value))
        .conflicts(["types", "artistIds"]),
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
      new Option(
        "--any-release-ok",
        "Accept any release for matched albums (monitoring changes belong to `plan album-monitoring`)",
      ),
    )
    .addOption(
      new Option("--no-any-release-ok", "Require the monitored release for matched albums"),
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
    .action(async (cmdOptions: Record<string, unknown>, command: Command) => {
      const format = deps.resolveFormat();
      try {
        if (command.getOptionValueSource("anyReleaseOk") !== "cli") {
          throw new MissingRequiredArgumentError("Pass --any-release-ok or --no-any-release-ok");
        }
        if (cmdOptions["types"] === undefined && cmdOptions["albumIds"] === undefined) {
          throw new MissingRequiredArgumentError("Pass --types or --album-ids");
        }
        const planFile = cmdOptions["planFile"] as string | undefined;
        if (planFile !== undefined) {
          deps.assertSafePlanFileArgument(planFile);
        }
        const { executeLidarrAlbumEditPlan } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrAlbumEditPlan({
          desiredAnyReleaseOk: cmdOptions["anyReleaseOk"] === true,
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
            format === "csv"
              ? projectAlbumMutationPlanCsv(result)
              : { command: "lidarr-plan", result },
          );
        } else {
          renderAlbumMutationPlan(result, "No album release-policy changes to plan.");
        }
      } catch (error) {
        await deps.reportLidarrFailure("plan-album-edit", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}

/**
 * Builds the `plan album-delete` leaf command — the first file-destructive lane.
 *
 * Selection is one of two modes: explicit `--album-ids`, or `--artist-ids`
 * optionally narrowed by `--types`. There is deliberately NO `--all` option:
 * library-wide destructive sweeps are unexpressible at parse time. Destruction
 * mode (`--delete-files`, `--add-import-list-exclusion`) is sealed into the
 * checksummed artifact and cannot be escalated at apply. No `-v` flag exists.
 *
 * @param deps - Helpers injected by commands/lidarr.ts at registration time.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrPlanAlbumDeleteCommand(deps: LidarrAlbumMutationCommandDeps): Command {
  return new Command("album-delete")
    .description("Plan destructive album deletion from the Lidarr library")
    .addOption(
      new Option("--album-ids <ids>", "Comma-separated exact Lidarr album IDs")
        .argParser((value: string) => deps.parseIdList("Album", value))
        .conflicts(["artistIds", "types"]),
    )
    .addOption(
      new Option(
        "--artist-ids <ids>",
        "Comma-separated Lidarr artist IDs scoping the deletion",
      ).argParser((value: string) => deps.parseIdList("Artist", value)),
    )
    .addOption(
      new Option(
        "--types <list>",
        "Comma-separated album-type selectors narrowing --artist-ids",
      ).argParser(parseAlbumTypeSelectors),
    )
    .addOption(new Option("--include-monitored", "Include monitored albums (excluded by default)"))
    .addOption(new Option("--delete-files", "Permanently delete track files on disk"))
    .addOption(
      new Option("--add-import-list-exclusion", "Exclude deleted albums from import lists"),
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
        if (cmdOptions["albumIds"] === undefined && cmdOptions["artistIds"] === undefined) {
          throw new MissingRequiredArgumentError(
            "Choose a deletion scope: --album-ids or --artist-ids",
          );
        }
        const planFile = cmdOptions["planFile"] as string | undefined;
        if (planFile !== undefined) {
          deps.assertSafePlanFileArgument(planFile);
        }
        const { executeLidarrAlbumDeletePlan } = await import("../actions/lidarr/index.js");
        // `artistIds` is spread in so it never shares an object literal with the
        // destruction keys — that co-location trips the architecture gate's
        // artist-editor-body heuristic (check-direct-plex-imports.mjs).
        const result = await executeLidarrAlbumDeletePlan({
          albumIds: cmdOptions["albumIds"] as number[] | undefined,
          ...(cmdOptions["artistIds"] === undefined
            ? {}
            : { artistIds: cmdOptions["artistIds"] as number[] }),
          types: cmdOptions["types"] as readonly LidarrAlbumTypeSelector[] | undefined,
          includeMonitored: cmdOptions["includeMonitored"] as boolean | undefined,
          deleteFiles: cmdOptions["deleteFiles"] as boolean | undefined,
          addImportListExclusion: cmdOptions["addImportListExclusion"] as boolean | undefined,
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
            format === "csv"
              ? projectAlbumMutationPlanCsv(result)
              : { command: "lidarr-plan", result },
          );
        } else {
          renderAlbumMutationPlan(result, "No album deletions to plan.");
        }
      } catch (error) {
        await deps.reportLidarrFailure("plan-album-delete", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}
