/**
 * Lazy `rfmedia lidarr validate-import` command factory.
 *
 * Machine output is stdout-only; human diagnostics are stderr-only. The
 * optional failure threshold is applied after the complete report is rendered.
 */

import { Command, Option } from "commander";

import { isMachineFormat, type OutputFormat } from "@rfmedia/common";

import type { LidarrValidateImportActionResult } from "../actions/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import {
  shouldFailLidarrImportValidation,
  type LidarrImportValidationFailOn,
} from "../types/lidarr-import-validation.js";

export interface LidarrImportValidationCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly parsePositiveInt: (value: string) => number;
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

export const LIDARR_IMPORT_VALIDATION_STATUSES = [
  "ready",
  "unmatched",
  "ambiguous",
  "rejected",
] as const;

export const LIDARR_IMPORT_VALIDATION_CSV_COLUMNS = [
  "command",
  "rowType",
  "checkedAt",
  "folder",
  "artistId",
  "filterExistingFiles",
  "replaceExistingFiles",
  "summary.total",
  "summary.ready",
  "summary.unmatched",
  "summary.ambiguous",
  "summary.rejected",
  "summary.highestStatus",
  "finding.path",
  "finding.name",
  "finding.size",
  "finding.status",
  "finding.reason",
  "finding.artistId",
  "finding.artistName",
  "finding.albumId",
  "finding.albumTitle",
  "finding.albumReleaseId",
  "finding.albumReleaseForeignId",
  "finding.trackIds",
  "finding.artistMbId",
  "finding.albumMbId",
  "finding.releaseMbId",
  "finding.recordingMbId",
  "finding.trackMbId",
  "finding.rejections",
] as const;

function projectCsv(result: LidarrValidateImportActionResult): readonly Record<string, unknown>[] {
  const base = {
    command: "lidarr-validate-import",
    checkedAt: result.report.checkedAt,
    folder: result.report.folder,
    artistId: result.report.artistId,
    filterExistingFiles: result.report.filterExistingFiles,
    replaceExistingFiles: result.report.replaceExistingFiles,
    "summary.total": result.report.summary.total,
    "summary.ready": result.report.summary.ready,
    "summary.unmatched": result.report.summary.unmatched,
    "summary.ambiguous": result.report.summary.ambiguous,
    "summary.rejected": result.report.summary.rejected,
    "summary.highestStatus": result.report.summary.highestStatus,
  };
  const rows: Record<string, unknown>[] = [{ ...base, rowType: "summary" }];
  for (const finding of result.report.findings) {
    rows.push({
      ...base,
      rowType: "finding",
      "finding.path": finding.path,
      "finding.name": finding.name,
      "finding.size": finding.size,
      "finding.status": finding.status,
      "finding.reason": finding.reason,
      "finding.artistId": finding.artist?.id,
      "finding.artistName": finding.artist?.name,
      "finding.albumId": finding.album?.id,
      "finding.albumTitle": finding.album?.title,
      "finding.albumReleaseId": finding.albumReleaseId,
      "finding.albumReleaseForeignId": finding.albumReleaseForeignId,
      "finding.trackIds": finding.tracks
        .map((track) => track.id)
        .filter((id) => id !== undefined)
        .join(","),
      "finding.artistMbId": finding.audioTags?.artistMbId,
      "finding.albumMbId": finding.audioTags?.albumMbId,
      "finding.releaseMbId": finding.audioTags?.releaseMbId,
      "finding.recordingMbId": finding.audioTags?.recordingMbId,
      "finding.trackMbId": finding.audioTags?.trackMbId,
      "finding.rejections": finding.rejections.map((rejection) => rejection.reason).join("; "),
    });
  }
  return Object.freeze(rows);
}

function renderHuman(result: LidarrValidateImportActionResult): void {
  const { report } = result;
  console.error(`Lidarr import validation: ${report.folder}`);
  console.error(
    `  ${report.summary.ready} ready, ${report.summary.unmatched} unmatched, ` +
      `${report.summary.ambiguous} ambiguous, ${report.summary.rejected} rejected`,
  );
  for (const finding of report.findings) {
    console.error(`  [${finding.status}] ${finding.path}`);
    console.error(`    ${finding.reason}`);
  }
  console.error("");
}

/** Builds the read-only import-validation leaf command. */
export function createLidarrImportValidationCommand(
  deps: LidarrImportValidationCommandDeps,
): Command {
  return new Command("validate-import")
    .description("Validate a local album folder with Lidarr's matching engine")
    .argument("<folder>", "Local album folder visible to Lidarr")
    .addOption(
      new Option("--artist-id <id>", "Constrain matching to one Lidarr artist")
        .argParser(deps.parsePositiveInt)
        .helpGroup("Selection:"),
    )
    .addOption(
      new Option("--filter-existing-files", "Suppress files Lidarr already knows about").helpGroup(
        "Probe:",
      ),
    )
    .addOption(
      new Option("--replace-existing-files", "Evaluate replacement candidates").helpGroup("Probe:"),
    )
    .addOption(
      new Option("--fail-on <status>", "Exit 1 at or above this validation status")
        .choices([...LIDARR_IMPORT_VALIDATION_STATUSES])
        .helpGroup("Safety:"),
    )
    .addOption(new Option("--lidarr-url <url>", "Lidarr server URL").helpGroup("Connection:"))
    .addOption(new Option("--lidarr-api-key <key>", "Lidarr API key").helpGroup("Connection:"))
    .action(async (folder: string, cmdOptions: Record<string, unknown>) => {
      const format = deps.resolveFormat();
      try {
        const { executeLidarrValidateImport } = await import("../actions/lidarr/index.js");
        const result = await executeLidarrValidateImport({
          folder,
          artistId: cmdOptions["artistId"] as number | undefined,
          filterExistingFiles: cmdOptions["filterExistingFiles"] === true,
          replaceExistingFiles: cmdOptions["replaceExistingFiles"] === true,
          lidarrUrl: cmdOptions["lidarrUrl"] as string | undefined,
          lidarrApiKey: cmdOptions["lidarrApiKey"] as string | undefined,
        });
        const failOn = cmdOptions["failOn"] as LidarrImportValidationFailOn | undefined;
        const gated = shouldFailLidarrImportValidation(result.report, failOn);
        if (isMachineFormat(format)) {
          const { formatOutput } = await import("../lib/formatters/index.js");
          await formatOutput(
            format,
            format === "csv" ? projectCsv(result) : { command: "lidarr-validate-import", result },
            format === "csv" ? { columns: [...LIDARR_IMPORT_VALIDATION_CSV_COLUMNS] } : undefined,
          );
        } else {
          renderHuman(result);
          if (failOn !== undefined) {
            console.error(`Validation gate --fail-on ${failOn}: ${gated ? "failed" : "passed"}`);
            console.error("");
          }
          deps.renderExecutionSummary(result.execution);
        }
        if (gated) process.exitCode = 1;
      } catch (error) {
        await deps.reportLidarrFailure("validate-import", error, {
          staleHint: false,
          format,
          sensitiveValues: [cmdOptions["lidarrApiKey"]],
        });
      }
    });
}
