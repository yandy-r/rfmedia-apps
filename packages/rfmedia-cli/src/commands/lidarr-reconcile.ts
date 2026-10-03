/**
 * Lazy `rfmedia lidarr reconcile` command and report presenters.
 *
 * Provider acquisition remains behind the action import. Option validation is
 * performed inside the shared failure boundary before that import, machine
 * output is stdout-only, and human output is stderr-only.
 */

import { Command, Option } from "commander";
import pc from "picocolors";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import { MissingRequiredArgumentError, OptionConflictError } from "../lib/errors.js";
import { truncateDisplay } from "../lib/format.js";
import type {
  LidarrReconcileActionOptions,
  LidarrReconcileActionResult,
} from "../actions/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationDuplicate,
  ReconciliationItem,
  ReconciliationSuggestion,
} from "../types/bridge.js";

const COMMAND_ID = "lidarr-reconcile";
const HUMAN_DETAIL_ROWS = 20;

interface LidarrReconcileActions {
  readonly executeLidarrReconcile: (
    options: LidarrReconcileActionOptions,
  ) => Promise<LidarrReconcileActionResult>;
}

/** Parent-private helpers injected without importing the Lidarr parent. */
export interface LidarrReconcileCommandDeps {
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
  /** Test/embedding seam; production keeps the action module lazy. */
  readonly loadActions?: () => Promise<LidarrReconcileActions>;
}

/** JSON/YAML result: report fields are top-level, with live execution appended. */
export type LidarrReconcileMachineResult = PlexLidarrReconciliationResultV1 & {
  readonly execution?: LidarrExecutionSuccessMetadata;
};

/** Stable JSON/YAML success envelope. */
export interface LidarrReconcileMachineOutput {
  readonly command: typeof COMMAND_ID;
  readonly result: LidarrReconcileMachineResult;
}

/** Fixed flat CSV schema shared by every reconciliation row type. */
export const LIDARR_RECONCILE_CSV_COLUMNS = [
  "command",
  "rowType",
  "schema",
  "scope.plexOrigin",
  "scope.plexInstanceId",
  "scope.plexLibraryId",
  "scope.lidarrOrigin",
  "scope.entityKind",
  "provenance.source",
  "provenance.mode",
  "provenance.freshness",
  "provenance.ageSeconds",
  "capturedAt",
  "verifiedAt",
  "completeness.sourceComplete",
  "completeness.targetComplete",
  "completeness.resolutionsComplete",
  "completeness.complete",
  "completeness.sourceArtistCount",
  "completeness.targetArtistCount",
  "completeness.resolutionCount",
  "summary.sourceArtistCount",
  "summary.targetArtistCount",
  "summary.primaryOutcomeCount",
  "summary.matchedExactCount",
  "summary.reviewSuggestedCount",
  "summary.reviewAmbiguousCount",
  "summary.plexOnlyCount",
  "summary.lidarrOnlyCount",
  "summary.conflictCount",
  "summary.unavailableCount",
  "summary.duplicatesIncluded",
  "summary.duplicateFindingCount",
  "summary.suggestionCount",
  "execution.taskId",
  "execution.operation",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "item.category",
  "item.reason",
  "item.method",
  "item.source.plexId",
  "item.source.title",
  "item.source.artistMbid",
  "item.target.lidarrId",
  "item.target.title",
  "item.target.artistMbid",
  "item.score",
  "item.runnerUpMargin",
  "item.candidates",
  "item.plexOnly",
  "item.lidarrOnly",
  "duplicate.code",
  "duplicate.artistMbid",
  "duplicate.normalizedTitle",
  "duplicate.members",
  "suggestion.code",
  "suggestion.source.plexId",
  "suggestion.source.title",
  "suggestion.source.artistMbid",
  "suggestion.target.lidarrId",
  "suggestion.target.title",
  "suggestion.target.artistMbid",
  "suggestion.argv",
] as const;

function assertValidSelectors(options: Record<string, unknown>): void {
  const offline = options["offline"] === true;
  const plexLibrary = options["plexLibrary"] as string | undefined;
  const plexLibraryId = options["plexLibraryId"] as string | undefined;

  if (offline) {
    if (plexLibrary !== undefined) {
      throw new OptionConflictError("--offline", "--plex-library");
    }
    if (options["plexToken"] !== undefined) {
      throw new OptionConflictError("--offline", "--plex-token");
    }
    if (options["lidarrApiKey"] !== undefined) {
      throw new OptionConflictError("--offline", "--lidarr-api-key");
    }
    if (plexLibraryId !== undefined && plexLibraryId.trim() === "") {
      throw new MissingRequiredArgumentError(
        "--plex-library-id requires a non-empty value",
        "lidarr reconcile",
      );
    }
    return;
  }

  if (plexLibraryId !== undefined) {
    throw new OptionConflictError("--plex-library-id", "live mode", "use --offline");
  }
  if (plexLibrary === undefined || plexLibrary.trim() === "") {
    throw new MissingRequiredArgumentError(
      "--plex-library requires a non-empty value for live reconciliation",
      "lidarr reconcile",
    );
  }
}

function machineResult(result: LidarrReconcileActionResult): LidarrReconcileMachineResult {
  return result.execution === undefined
    ? result.report
    : Object.freeze({ ...result.report, execution: result.execution });
}

function reportCsvFields(result: LidarrReconcileActionResult): Record<string, unknown> {
  const { execution, report } = result;
  return {
    command: COMMAND_ID,
    schema: report.schema,
    "scope.plexOrigin": report.scope.plexOrigin,
    "scope.plexInstanceId": report.scope.plexInstanceId,
    "scope.plexLibraryId": report.scope.plexLibraryId,
    "scope.lidarrOrigin": report.scope.lidarrOrigin,
    "scope.entityKind": report.scope.entityKind,
    "provenance.source": report.provenance.source,
    "provenance.mode": report.provenance.mode,
    "provenance.freshness": report.provenance.freshness,
    "provenance.ageSeconds": report.provenance.ageSeconds,
    capturedAt: report.capturedAt,
    verifiedAt: report.verifiedAt,
    "completeness.sourceComplete": report.completeness.sourceComplete,
    "completeness.targetComplete": report.completeness.targetComplete,
    "completeness.resolutionsComplete": report.completeness.resolutionsComplete,
    "completeness.complete": report.completeness.complete,
    "completeness.sourceArtistCount": report.completeness.sourceArtistCount,
    "completeness.targetArtistCount": report.completeness.targetArtistCount,
    "completeness.resolutionCount": report.completeness.resolutionCount,
    "summary.sourceArtistCount": report.summary.sourceArtistCount,
    "summary.targetArtistCount": report.summary.targetArtistCount,
    "summary.primaryOutcomeCount": report.summary.primaryOutcomeCount,
    "summary.matchedExactCount": report.summary.matchedExactCount,
    "summary.reviewSuggestedCount": report.summary.reviewSuggestedCount,
    "summary.reviewAmbiguousCount": report.summary.reviewAmbiguousCount,
    "summary.plexOnlyCount": report.summary.plexOnlyCount,
    "summary.lidarrOnlyCount": report.summary.lidarrOnlyCount,
    "summary.conflictCount": report.summary.conflictCount,
    "summary.unavailableCount": report.summary.unavailableCount,
    "summary.duplicatesIncluded": report.summary.duplicatesIncluded,
    "summary.duplicateFindingCount": report.summary.duplicateFindingCount,
    "summary.suggestionCount": report.summary.suggestionCount,
    "execution.taskId": execution?.taskId,
    "execution.operation": execution?.operation,
    "execution.lane": execution?.lane,
    "execution.outcome": execution?.outcome,
    "execution.attempts": execution?.attempts,
  };
}

function itemCsvFields(item: ReconciliationItem): Record<string, unknown> {
  return {
    "item.category": item.category,
    "item.reason": item.reason,
    "item.method": item.method,
    "item.source.plexId": item.source?.plexId,
    "item.source.title": item.source?.title,
    "item.source.artistMbid": item.source?.artistMbid,
    "item.target.lidarrId": item.target?.lidarrId,
    "item.target.title": item.target?.title,
    "item.target.artistMbid": item.target?.artistMbid,
    "item.score": item.score,
    "item.runnerUpMargin": item.runnerUpMargin,
    "item.candidates": JSON.stringify(item.candidates),
    "item.plexOnly": item.source !== null && item.category !== "authoritative",
    "item.lidarrOnly":
      item.source === null &&
      item.target !== null &&
      item.reason === "no-authoritative-source-match",
  };
}

function duplicateCsvFields(duplicate: ReconciliationDuplicate): Record<string, unknown> {
  return {
    "duplicate.code": duplicate.code,
    "duplicate.artistMbid": duplicate.artistMbid,
    "duplicate.normalizedTitle": duplicate.normalizedTitle,
    "duplicate.members": JSON.stringify(duplicate.members),
  };
}

function suggestionCsvFields(suggestion: ReconciliationSuggestion): Record<string, unknown> {
  return {
    "suggestion.code": suggestion.code,
    "suggestion.source.plexId": suggestion.source?.plexId,
    "suggestion.source.title": suggestion.source?.title,
    "suggestion.source.artistMbid": suggestion.source?.artistMbid,
    "suggestion.target.lidarrId": suggestion.target?.lidarrId,
    "suggestion.target.title": suggestion.target?.title,
    "suggestion.target.artistMbid": suggestion.target?.artistMbid,
    "suggestion.argv": JSON.stringify(suggestion.argv),
  };
}

/**
 * Returns each logical reconciliation item once, in the stable category order.
 *
 * `plexOnly` intentionally overlaps review/conflict/unavailable report arrays,
 * so only its unmatched primary rows are appended here.
 */
function orderedItems(report: PlexLidarrReconciliationResultV1): readonly ReconciliationItem[] {
  return [
    ...report.matchedExact,
    ...report.reviewSuggested.filter((item) => item.category === "review-normalized-name"),
    ...report.reviewSuggested.filter((item) => item.category === "review-fuzzy-name"),
    ...report.reviewAmbiguous,
    ...report.plexOnly.filter((item) => item.category === "unmatched"),
    ...report.lidarrOnly,
    ...report.conflicts,
    ...report.unavailable,
  ];
}

function projectCsv(result: LidarrReconcileActionResult): readonly Record<string, unknown>[] {
  const common = reportCsvFields(result);
  return Object.freeze([
    { ...common, rowType: "summary" },
    ...orderedItems(result.report).map((item) => ({
      ...common,
      rowType: "item",
      ...itemCsvFields(item),
    })),
    ...result.report.duplicates.map((duplicate) => ({
      ...common,
      rowType: "duplicate",
      ...duplicateCsvFields(duplicate),
    })),
    ...result.report.suggestions.map((suggestion) => ({
      ...common,
      rowType: "suggestion",
      ...suggestionCsvFields(suggestion),
    })),
  ]);
}

function formatIdentity(item: ReconciliationItem): string {
  const source =
    item.source === null
      ? "-"
      : `Plex ${item.source.plexId} ${truncateDisplay(item.source.title, 32)}`;
  const target =
    item.target === null
      ? "-"
      : `Lidarr ${item.target.lidarrId} ${truncateDisplay(item.target.title, 32)}`;
  const score = item.score === null ? "" : ` · score ${item.score}`;
  const margin = item.runnerUpMargin === null ? "" : ` · margin ${item.runnerUpMargin}`;
  return `${source} → ${target} · ${item.method}/${item.reason}${score}${margin}`;
}

function renderItemSection(
  title: string,
  items: readonly ReconciliationItem[],
  verbose: boolean,
): void {
  console.error(pc.bold(`  ${title} (${items.length})`));
  const visible = verbose ? items : items.slice(0, HUMAN_DETAIL_ROWS);
  if (visible.length === 0) {
    console.error("    None");
  } else {
    for (const item of visible) console.error(`    - ${formatIdentity(item)}`);
  }
  if (visible.length < items.length) {
    console.error(
      pc.dim(`    Showing ${visible.length} of ${items.length}; use --verbose to show all.`),
    );
  }
  console.error("");
}

function renderDuplicates(duplicates: readonly ReconciliationDuplicate[], verbose: boolean): void {
  console.error(pc.bold(`  Duplicate identity findings (${duplicates.length})`));
  const visible = verbose ? duplicates : duplicates.slice(0, HUMAN_DETAIL_ROWS);
  if (visible.length === 0) {
    console.error("    None");
  } else {
    for (const duplicate of visible) {
      console.error(
        `    - ${duplicate.code} · ${duplicate.members.length} member(s)` +
          (duplicate.artistMbid === null ? "" : ` · ${duplicate.artistMbid}`),
      );
    }
  }
  if (visible.length < duplicates.length) {
    console.error(
      pc.dim(`    Showing ${visible.length} of ${duplicates.length}; use --verbose to show all.`),
    );
  }
  console.error("");
}

function renderSuggestions(
  suggestions: readonly ReconciliationSuggestion[],
  verbose: boolean,
): void {
  console.error(pc.bold(`  Suggested follow-up (${suggestions.length})`));
  const visible = verbose ? suggestions : suggestions.slice(0, HUMAN_DETAIL_ROWS);
  if (visible.length === 0) {
    console.error("    None");
  } else {
    for (const suggestion of visible) {
      const argv = suggestion.argv.length === 0 ? "" : ` · argv=${JSON.stringify(suggestion.argv)}`;
      console.error(`    - [${suggestion.code}] review only${argv}`);
    }
  }
  if (visible.length < suggestions.length) {
    console.error(
      pc.dim(`    Showing ${visible.length} of ${suggestions.length}; use --verbose to show all.`),
    );
  }
  console.error("");
}

function renderHuman(
  result: LidarrReconcileActionResult,
  verbose: boolean,
  renderExecutionSummary: LidarrReconcileCommandDeps["renderExecutionSummary"],
): void {
  const { report } = result;
  const { summary } = report;
  console.error("");
  console.error(pc.bold("Plex-Lidarr Reconciliation"));
  console.error("");
  console.error(
    `  Mode: ${report.provenance.mode} · Evidence: ${report.provenance.source}/${report.provenance.freshness}`,
  );
  console.error(
    `  Scope: Plex ${report.scope.plexOrigin} (${report.scope.plexInstanceId}, library ${report.scope.plexLibraryId}) · Lidarr ${report.scope.lidarrOrigin}`,
  );
  console.error(`  Captured: ${report.capturedAt} · Verified: ${report.verifiedAt}`);
  if (report.provenance.mode === "offline") {
    console.error(`  Cache age: ${report.provenance.ageSeconds ?? 0}s`);
  }
  console.error("");
  console.error(
    `  Summary: ${summary.matchedExactCount} exact · ${summary.plexOnlyCount} Plex-only · ` +
      `${summary.lidarrOnlyCount} Lidarr-only · ${summary.reviewSuggestedCount} suggested · ` +
      `${summary.reviewAmbiguousCount} ambiguous · ${summary.conflictCount} conflict · ` +
      `${summary.unavailableCount} unavailable · ${summary.duplicateFindingCount} duplicate`,
  );
  console.error(
    pc.dim(
      "  Note: review suggestions remain in both directional gaps until an authoritative exact match exists.",
    ),
  );
  console.error("");

  renderItemSection("Exact matches", report.matchedExact, verbose);
  renderItemSection("Plex-only", report.plexOnly, verbose);
  renderItemSection("Lidarr-only", report.lidarrOnly, verbose);
  renderItemSection("Review suggestions", report.reviewSuggested, verbose);
  renderItemSection("Ambiguous", report.reviewAmbiguous, verbose);
  renderItemSection("Conflicts", report.conflicts, verbose);
  renderItemSection("Unavailable evidence", report.unavailable, verbose);
  if (summary.duplicatesIncluded) renderDuplicates(report.duplicates, verbose);
  renderSuggestions(report.suggestions, verbose);
  if (result.execution !== undefined) renderExecutionSummary(result.execution);
}

/** Builds the read-only reconciliation leaf for registration by `lidarr.ts`. */
export function createLidarrReconcileCommand(deps: LidarrReconcileCommandDeps): Command {
  const loadActions =
    deps.loadActions ??
    ((): Promise<LidarrReconcileActions> => import("../actions/lidarr/index.js"));
  return new Command("reconcile")
    .description("Compare Plex music artists with Lidarr using read-only identity evidence")
    .addOption(
      new Option("--plex-library <name>", "Plex music library for a live run").helpGroup(
        "Selection:",
      ),
    )
    .addOption(
      new Option("--plex-library-id <id>", "Cached Plex library ID for an offline run").helpGroup(
        "Selection:",
      ),
    )
    .addOption(
      new Option("--offline", "Use cached evidence only; perform no provider I/O").helpGroup(
        "Selection:",
      ),
    )
    .addOption(
      new Option("--duplicates", "Include bridge-owned duplicate identity findings").helpGroup(
        "Selection:",
      ),
    )
    .addOption(new Option("-v, --verbose", "Show all human detail rows").helpGroup("Output:"))
    .addOption(new Option("--plex-url <url>", "Plex server URL").helpGroup("Connection:"))
    .addOption(new Option("--plex-token <token>", "Plex API token").helpGroup("Connection:"))
    .addOption(new Option("--lidarr-url <url>", "Lidarr server URL").helpGroup("Connection:"))
    .addOption(new Option("--lidarr-api-key <key>", "Lidarr API key").helpGroup("Connection:"))
    .action(async (cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        assertValidSelectors(cmdOptions);
        const actionOptions: LidarrReconcileActionOptions = {
          plexLibrary: cmdOptions["plexLibrary"] as string | undefined,
          plexLibraryId: cmdOptions["plexLibraryId"] as string | undefined,
          offline: cmdOptions["offline"] === true,
          duplicates: cmdOptions["duplicates"] === true,
          plexUrl: cmdOptions["plexUrl"] as string | undefined,
          plexToken: cmdOptions["plexToken"] as string | undefined,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        };
        const { executeLidarrReconcile } = await loadActions();
        const result = await executeLidarrReconcile(actionOptions);

        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          if (format === "csv") {
            await formatOutput(format, projectCsv(result), {
              columns: [...LIDARR_RECONCILE_CSV_COLUMNS],
            });
          } else {
            const output: LidarrReconcileMachineOutput = {
              command: COMMAND_ID,
              result: machineResult(result),
            };
            await formatOutput(format, output);
          }
        } else {
          renderHuman(result, cmdOptions["verbose"] === true, deps.renderExecutionSummary);
        }
      } catch (error) {
        await deps.reportLidarrFailure("reconcile", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]],
        });
      }
    });
}
