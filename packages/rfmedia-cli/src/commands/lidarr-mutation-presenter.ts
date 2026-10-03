/**
 * Human and machine presentation helpers for Lidarr mutation plans and applies.
 *
 * Keeping these concerns outside the Commander definition leaves the command
 * module responsible for parsing and typed action delegation only.
 */

import { Table } from "console-table-printer";
import pc from "picocolors";

import { formatBytes } from "../lib/disk.js";
import { MissingRequiredArgumentError } from "../lib/errors.js";
import { truncate } from "../lib/format.js";
import { confirm, isInteractive } from "../lib/prompt.js";
import type {
  LidarrAlbumDeletePlanEntryV2,
  LidarrAlbumEditPlanEntryV2,
  LidarrAlbumMutationPlanV2,
  LidarrCascadeAnalysisEvidence,
  LidarrCascadeBudgetAssessment,
  LidarrCascadeMetric,
  LidarrCascadeRecommendationCode,
  LidarrCascadeWarning,
  LidarrArtistAddPlanEntryV2,
  LidarrArtistAddPlanGenerationResult,
  LidarrArtistAddPlanSelectionV2,
  LidarrArtistAddPlanV2,
  LidarrArtistDeleteEvidence,
  LidarrArtistDeletePlanEntry,
  LidarrMutationPlan,
  LidarrMutationPlanEntryV2,
  LidarrMutationPlanV2,
  LidarrPlanApplyEntryResult,
  LidarrPlanApplyResult,
  LidarrPlanGenerationResult,
  LidarrPlanGenerationResultV2,
  LidarrPlanGenerationResultV3,
  LidarrPlanObservedStateExtended,
  LidarrPlanV3,
  LidarrPlanSelectionV2Extended,
  LidarrTrackFileFilterPlanEntryV2,
  LidarrTrackFileFilterPlanV2,
} from "../types/lidarr-plan.js";

/** Every artist and album plan artifact accepted by the shared presenter surface. */
type AnyLidarrMutationPlan =
  | LidarrMutationPlan
  | LidarrArtistAddPlanV2
  | LidarrAlbumMutationPlanV2
  | LidarrTrackFileFilterPlanV2
  | LidarrPlanV3;

type AnyLidarrMutationPlanEntry = AnyLidarrMutationPlan["entries"][number];

function isTrackFileFilterEntry(
  entry: AnyLidarrMutationPlanEntry,
): entry is LidarrTrackFileFilterPlanEntryV2 {
  return "deletedTrackFileIds" in entry.after;
}

type AnyLidarrPlanGenerationResult =
  | LidarrPlanGenerationResult
  | LidarrPlanGenerationResultV2
  | LidarrPlanGenerationResultV3<LidarrPlanV3>
  | LidarrArtistAddPlanGenerationResult
  | {
      readonly planPath: string;
      readonly plan: LidarrAlbumMutationPlanV2 | LidarrTrackFileFilterPlanV2;
    };

export interface MutationApplyPresentationOptions {
  readonly verbose: boolean;
  readonly allowTagReplacement: boolean;
  readonly allowArtistDelete: boolean;
  readonly allowAlbumDelete: boolean;
  readonly allowFileDelete: boolean;
  readonly plexScan: boolean;
}

/** Maximum operation rows shown in the default human preview. */
const LIDARR_HUMAN_PREVIEW_ROWS = 20;
/** Maximum stable recommendations rendered for one cascade analysis. */
const LIDARR_HUMAN_CASCADE_RECOMMENDATIONS = 3;

function planCascadeEvidence(plan: AnyLidarrMutationPlan): LidarrCascadeAnalysisEvidence {
  return "cascadeAnalysis" in plan
    ? { status: "recorded", analysis: plan.cascadeAnalysis }
    : { status: "not-recorded" };
}

function formatCascadeMetric(metric: LidarrCascadeMetric): string {
  const value = metric.value === null ? "UNKNOWN" : String(metric.value);
  return `${value} ${metric.unit} (${metric.certainty.toUpperCase()}; ${metric.horizon.toUpperCase()}; basis=${metric.basis})`;
}

function formatCascadeBudget(assessment: LidarrCascadeBudgetAssessment): string {
  const state = assessment.status.replace("-", " ").toUpperCase();
  if (assessment.status === "not-configured") return state;
  const projected = assessment.projected === null ? "UNKNOWN" : String(assessment.projected);
  return `${state} (${projected} projected; ${assessment.limit ?? "UNKNOWN"} configured per plan)`;
}

function describeCascadeWarning(warning: LidarrCascadeWarning): string {
  switch (warning.code) {
    case "indexer-query-budget-exceeded":
      return `Configured per-plan indexer-query allowance exceeded by ${warning.overBy} (${warning.projected} projected; ${warning.limit} allowed).`;
    case "acquisition-budget-exceeded":
      return `Configured per-plan acquisition-candidate allowance exceeded by ${warning.overBy} (${warning.projected} projected; ${warning.limit} allowed).`;
    case "budget-assessment-incomplete":
      return `Configured per-plan ${warning.metric} allowance cannot be assessed because the projection is UNKNOWN.`;
  }
}

function describeCascadeRecommendation(code: LidarrCascadeRecommendationCode): string {
  switch (code) {
    case "reduce-scope":
      return "Reduce the selected IDs or filters and review a new plan.";
    case "split-into-batches":
      return "Split the scope into smaller independently reviewed plans.";
    case "delay-apply":
      return "Delay apply until the conditional workload is acceptable.";
  }
}

function renderCascadeAnalysis(
  evidence: LidarrCascadeAnalysisEvidence,
  label: "Cascade analysis" | "Plan-time cascade analysis",
): void {
  console.error("");
  if (evidence.status === "not-recorded") {
    console.error(`  ${label}: NOT RECORDED (legacy plan)`);
    return;
  }
  const analysis = evidence.analysis;
  console.error(`  ${label}`);
  console.error(
    `    Immediate indexer queries: ${formatCascadeMetric(analysis.metrics.immediateIndexerQueries)}`,
  );
  console.error(`    Files affected: ${formatCascadeMetric(analysis.metrics.filesAffected)}`);
  console.error(`    Bytes affected: ${formatCascadeMetric(analysis.metrics.bytesAffected)}`);
  console.error(
    `    Acquisition candidates: ${formatCascadeMetric(analysis.metrics.acquisitionCandidates)}`,
  );
  console.error(
    `    Conditional indexer queries: ${formatCascadeMetric(analysis.metrics.conditionalIndexerQueries)}`,
  );
  console.error(`    Newly monitored: ${formatCascadeMetric(analysis.metrics.newlyMonitored)}`);
  console.error(
    `    Indexer-query budget: ${formatCascadeBudget(analysis.budgets.indexerQueries)}`,
  );
  console.error(
    `    Acquisition-candidate budget: ${formatCascadeBudget(analysis.budgets.acquisitionCandidates)}`,
  );
  for (const warning of analysis.warnings) {
    console.error(`    [WARNING ${warning.code}] ${describeCascadeWarning(warning)}`);
  }
  const recommendations = analysis.recommendations.slice(0, LIDARR_HUMAN_CASCADE_RECOMMENDATIONS);
  if (recommendations.length > 0) {
    console.error("    Recommended:");
    for (const code of recommendations) {
      console.error(`      - [${code}] ${describeCascadeRecommendation(code)}`);
    }
  }
}

function projectCascadeAnalysisCsv(
  evidence: LidarrCascadeAnalysisEvidence,
): Record<string, unknown> {
  const empty = {
    "result.cascade.modelVersion": "",
    "result.cascade.immediateIndexerQueries": "",
    "result.cascade.acquisitionCandidates": "",
    "result.cascade.conditionalIndexerQueries": "",
    "result.cascade.newlyMonitored": "",
    "result.cascade.filesAffected": "",
    "result.cascade.bytesAffected": "",
    "result.cascade.indexerQueriesBudgetStatus": "",
    "result.cascade.indexerQueriesBudgetLimit": "",
    "result.cascade.indexerQueriesBudgetProjected": "",
    "result.cascade.acquisitionCandidatesBudgetStatus": "",
    "result.cascade.acquisitionCandidatesBudgetLimit": "",
    "result.cascade.acquisitionCandidatesBudgetProjected": "",
    "result.cascade.highestWarningSeverity": "",
    "result.cascade.highestWarningCode": "",
    "result.cascade.warnings": "",
    "result.cascade.recommendations": "",
  };
  if (evidence.status === "not-recorded") {
    return { "result.cascade.status": "not-recorded", ...empty };
  }
  const analysis = evidence.analysis;
  const highestWarning = analysis.warnings[0];
  return {
    "result.cascade.status": "recorded",
    "result.cascade.modelVersion": analysis.modelVersion,
    "result.cascade.immediateIndexerQueries": analysis.metrics.immediateIndexerQueries.value,
    "result.cascade.acquisitionCandidates": analysis.metrics.acquisitionCandidates.value,
    "result.cascade.conditionalIndexerQueries": analysis.metrics.conditionalIndexerQueries.value,
    "result.cascade.newlyMonitored": analysis.metrics.newlyMonitored.value,
    "result.cascade.filesAffected": analysis.metrics.filesAffected.value,
    "result.cascade.bytesAffected": analysis.metrics.bytesAffected.value,
    "result.cascade.indexerQueriesBudgetStatus": analysis.budgets.indexerQueries.status,
    "result.cascade.indexerQueriesBudgetLimit": analysis.budgets.indexerQueries.limit,
    "result.cascade.indexerQueriesBudgetProjected": analysis.budgets.indexerQueries.projected,
    "result.cascade.acquisitionCandidatesBudgetStatus":
      analysis.budgets.acquisitionCandidates.status,
    "result.cascade.acquisitionCandidatesBudgetLimit": analysis.budgets.acquisitionCandidates.limit,
    "result.cascade.acquisitionCandidatesBudgetProjected":
      analysis.budgets.acquisitionCandidates.projected,
    "result.cascade.highestWarningSeverity": highestWarning === undefined ? "none" : "warning",
    "result.cascade.highestWarningCode": highestWarning?.code ?? "",
    "result.cascade.warnings": JSON.stringify(analysis.warnings),
    "result.cascade.recommendations": JSON.stringify(analysis.recommendations),
  };
}

function describeSelection(
  selection: LidarrPlanSelectionV2Extended | LidarrArtistAddPlanSelectionV2 | undefined,
): string {
  if (selection === undefined) return "exact artist IDs";
  switch (selection.kind) {
    case "ids":
      return `IDs: ${selection.artistIds.join(", ")}`;
    case "all":
      return "all artists";
    case "filters": {
      const filters = [
        selection.monitored === undefined
          ? undefined
          : selection.monitored
            ? "monitored"
            : "unmonitored",
        selection.qualityProfile === undefined
          ? undefined
          : `quality=${selection.qualityProfile.name} (${selection.qualityProfile.id})`,
        selection.metadataProfile === undefined
          ? undefined
          : `metadata=${selection.metadataProfile.name} (${selection.metadataProfile.id})`,
        ...(selection.tags ?? []).map((tag) => `tag=${tag.label} (${tag.id})`),
      ].filter((value): value is string => value !== undefined);
      return filters.join(" AND ");
    }
    case "album-ids":
      return `Album IDs: ${selection.albumIds.join(", ")}`;
    case "album-filters": {
      const filters = [
        selection.artistIds === undefined ? undefined : `artists=${selection.artistIds.join(", ")}`,
        selection.selectors.length === 0 ? undefined : `types=${selection.selectors.join(", ")}`,
        selection.includeMonitored === undefined
          ? undefined
          : selection.includeMonitored
            ? "include-monitored"
            : "exclude-monitored",
      ].filter((value): value is string => value !== undefined);
      return filters.join(" AND ");
    }
    case "album-track-filter":
      return `Album ID: ${selection.albumId}`;
    case "foreign-artist-id":
      return `MusicBrainz ID: ${selection.foreignArtistId}`;
    case "foreign-artist-ids":
      return `MusicBrainz IDs: ${selection.foreignArtistIds.join(", ")}`;
  }
}

function describePlanOperation(plan: AnyLidarrMutationPlan): string {
  switch (plan.operation.kind) {
    case "artist-monitoring":
      return "Artist Monitoring";
    case "album-monitoring":
      return "Album Monitoring";
    case "artist-profile-assignment":
      return "Artist Profile Assignment";
    case "artist-tag-mutation":
      return `Artist Tag ${plan.operation.mode[0]?.toUpperCase()}${plan.operation.mode.slice(1)}`;
    case "album-edit":
      return "Album Release Policy (any-release-ok)";
    case "album-delete":
      return "Album Deletion";
    case "track-file-filter":
      return "Trackfile Retention Filter";
    case "artist-delete":
      return "Artist Delete";
    case "artist-add":
      return "Artist Add";
  }
}

function formatReference(
  reference: { readonly id: number; readonly name?: string; readonly label?: string } | undefined,
): string {
  if (reference === undefined) return "unmanaged";
  return `${reference.name ?? reference.label ?? "Unknown"} (${reference.id})`;
}

/** Formats the album release policy with the exact CLI flag vocabulary. */
function formatAnyReleaseOk(anyReleaseOk: boolean): string {
  return anyReleaseOk ? "any-release-ok" : "no-any-release-ok";
}

function formatObservedState(state: LidarrPlanObservedStateExtended | undefined): string {
  if (state === undefined) return "-";
  switch (state.kind) {
    case "artist-monitoring":
      return state.monitored ? "monitored" : "unmonitored";
    case "artist-profile-assignment":
      return [
        state.qualityProfile === undefined
          ? undefined
          : `quality: ${formatReference(state.qualityProfile)}`,
        state.metadataProfile === undefined
          ? undefined
          : `metadata: ${formatReference(state.metadataProfile)}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join("; ");
    case "artist-tag-mutation":
      return state.tags.length === 0 ? "no tags" : state.tags.map(formatReference).join(", ");
    case "album-edit":
      return formatAnyReleaseOk(state.anyReleaseOk);
    case "album-delete":
      return state.present ? "present" : "deleted";
    case "artist-delete":
      return state.exists ? formatDeleteEvidence(state.evidence) : "absent";
  }
}

function formatDeleteEvidence(evidence: LidarrArtistDeleteEvidence): string {
  return `${evidence.path}; ${evidence.albumCount} album(s); ${evidence.trackFileCount} track file(s); ${evidence.sizeOnDisk} bytes (${formatBytes(evidence.sizeOnDisk)})`;
}

function isArtistDeleteEntry(
  entry: LidarrMutationPlan["entries"][number] | LidarrMutationPlanEntryV2,
): entry is LidarrArtistDeletePlanEntry {
  return "exists" in entry.after;
}

type LidarrArtistDeletePlan = Extract<
  LidarrMutationPlanV2,
  { readonly operation: { readonly kind: "artist-delete" } }
>;

function isArtistDeletePlan(plan: AnyLidarrMutationPlan): plan is LidarrArtistDeletePlan {
  return plan.operation.kind === "artist-delete";
}

function isArtistAddPlan(plan: AnyLidarrMutationPlan): plan is LidarrArtistAddPlanV2 {
  return plan.operation.kind === "artist-add";
}

function formatPlanEntryState(
  entry: LidarrMutationPlan["entries"][number] | LidarrMutationPlanEntryV2,
  side: "before" | "after",
): string {
  const state = entry[side];
  if ("monitored" in state) return state.monitored ? "monitored" : "unmonitored";
  if ("tags" in state) {
    return state.tags.length === 0 ? "no tags" : state.tags.map(formatReference).join(", ");
  }
  if ("exists" in state) return "absent";
  if ("path" in state) return formatDeleteEvidence(state);
  return [
    state.qualityProfile === undefined
      ? undefined
      : `quality: ${formatReference(state.qualityProfile)}`,
    state.metadataProfile === undefined
      ? undefined
      : `metadata: ${formatReference(state.metadataProfile)}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join("; ");
}

function formatPlanEntryDetail(
  entry: LidarrMutationPlan["entries"][number] | LidarrMutationPlanEntryV2,
): string {
  if (isArtistDeleteEntry(entry)) return "IRREVERSIBLE DELETE";
  if (!("removed" in entry)) {
    return formatPlanEntryState(entry, "before") === formatPlanEntryState(entry, "after")
      ? "NO-OP"
      : "CHANGE";
  }
  if (entry.removed.length === 0) {
    return formatPlanEntryState(entry, "before") === formatPlanEntryState(entry, "after")
      ? "NO-OP"
      : "CHANGE";
  }
  return `REMOVE ${entry.removed.map(formatReference).join(", ")}`;
}

/** Narrows a plan entry to the album-edit shape (`anyReleaseOk` before-state). */
function isAlbumEditPlanEntry(
  entry: AnyLidarrMutationPlanEntry,
): entry is LidarrAlbumEditPlanEntryV2 {
  return "albumId" in entry && "anyReleaseOk" in entry.before;
}

/** Narrows a plan entry to the album-delete shape (`deleted` after-state). */
function isAlbumDeletePlanEntry(
  entry: AnyLidarrMutationPlanEntry,
): entry is LidarrAlbumDeletePlanEntryV2 {
  return "albumId" in entry && "deleted" in entry.after;
}

function renderAlbumEditPlanTable(entries: readonly AnyLidarrMutationPlanEntry[]): void {
  const table = new Table({
    columns: [
      { name: "id", title: "Album ID", alignment: "right" },
      { name: "album", title: "Album", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "type", title: "Type", alignment: "left" },
      { name: "before", title: "Before", alignment: "left" },
      { name: "after", title: "After", alignment: "left" },
    ],
  });
  for (const entry of entries) {
    if (!isAlbumEditPlanEntry(entry)) continue;
    table.addRow({
      id: entry.albumId,
      album: truncate(entry.albumTitle, 36),
      artist: truncate(entry.artistName, 24),
      type: entry.albumType ?? "-",
      before: formatAnyReleaseOk(entry.before.anyReleaseOk),
      after: formatAnyReleaseOk(entry.after.anyReleaseOk),
    });
  }
  console.error(table.render());
}

function renderAlbumDeletePlanTable(entries: readonly AnyLidarrMutationPlanEntry[]): void {
  const table = new Table({
    columns: [
      { name: "id", title: "Album ID", alignment: "right" },
      { name: "album", title: "Album", alignment: "left" },
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "files", title: "Files", alignment: "right" },
      { name: "size", title: "Size", alignment: "right" },
      { name: "monitored", title: "Monitored", alignment: "left" },
    ],
  });
  for (const entry of entries) {
    if (!isAlbumDeletePlanEntry(entry)) continue;
    table.addRow({
      id: entry.albumId,
      album: truncate(entry.albumTitle, 36),
      artist: truncate(entry.artistName, 24),
      files: entry.before.trackFileCount,
      size: formatBytes(entry.before.sizeOnDisk),
      monitored: entry.before.monitored ? "monitored" : "unmonitored",
    });
  }
  console.error(table.render());
}

function renderArtistAddPlanTable(entries: readonly LidarrArtistAddPlanEntryV2[]): void {
  const table = new Table({
    columns: [
      { name: "artist", title: "Artist", alignment: "left" },
      { name: "mbid", title: "MusicBrainz ID", alignment: "left" },
      { name: "root", title: "Root Folder", alignment: "left" },
      { name: "quality", title: "Quality Profile", alignment: "left" },
      { name: "metadata", title: "Metadata Profile", alignment: "left" },
    ],
  });
  for (const entry of entries) {
    table.addRow({
      artist: truncate(entry.artistName, 40),
      mbid: entry.foreignArtistId,
      root: truncate(entry.after.rootFolder.path, 48),
      quality: formatReference(entry.after.qualityProfile),
      metadata: formatReference(entry.after.metadataProfile),
    });
  }
  console.error(table.render());
}

/**
 * Renders a reviewed Lidarr mutation plan to the human-output stream.
 *
 * @param result - Generated plan and artifact path.
 * @param verbose - Whether every plan entry should be shown.
 */
export function renderMutationPlan(result: AnyLidarrPlanGenerationResult, verbose: boolean): void {
  console.error("");
  console.error(pc.bold(`Lidarr ${describePlanOperation(result.plan)} Plan`));
  if (result.plan.operation.kind === "album-delete") {
    console.error(
      pc.red(pc.bold("  DESTRUCTIVE: this plan deletes albums from the Lidarr library.")),
    );
  }
  if (result.plan.operation.kind === "track-file-filter") {
    console.error(
      pc.red(
        pc.bold("  DESTRUCTIVE: Lidarr will permanently delete the reviewed managed trackfiles."),
      ),
    );
  }
  console.error("");
  console.error(`  Plan: ${result.plan.id}`);
  console.error(`  Checksum: ${result.plan.payloadChecksum}`);
  console.error(`  File: ${result.planPath}`);
  console.error(`  Target: ${result.plan.target.origin}`);
  console.error(
    `  Selection: ${describeSelection("selection" in result.plan ? result.plan.selection : undefined)}`,
  );
  console.error(
    `  Review: ${result.plan.review.changed} change(s), ${result.plan.review.unchanged} no-op(s), cap ${result.plan.maxBatch}`,
  );
  console.error(
    `  Risk: ${result.plan.risk.level} (${result.plan.risk.destructive ? "destructive" : "non-destructive"})`,
  );
  if ("summary" in result.plan) {
    switch (result.plan.summary.kind) {
      case "artist-monitoring":
        console.error(
          `  Monitoring: ${result.plan.summary.monitoredBefore} before, ${result.plan.summary.monitoredAfter} after`,
        );
        break;
      case "artist-profile-assignment":
        console.error(
          `  Profiles: ${result.plan.summary.qualityProfileChanged} quality, ${result.plan.summary.metadataProfileChanged} metadata change(s)`,
        );
        break;
      case "artist-tag-mutation":
        console.error(
          `  Tags: ${result.plan.summary.added} added, ${result.plan.summary.retained} retained, ${result.plan.summary.removed} removed`,
        );
        break;
      case "album-edit":
        console.error(
          `  Release policy: ${result.plan.summary.changedToTrue} set to any-release-ok, ${result.plan.summary.changedToFalse} set to no-any-release-ok`,
        );
        break;
      case "album-delete":
        console.error(
          result.plan.summary.deleteFiles
            ? pc.red(
                `  Mode: PERMANENTLY DELETES ${result.plan.summary.totalTrackFiles} track files, ${formatBytes(result.plan.summary.totalSizeOnDisk)} on disk`,
              )
            : `  Mode: removes ${result.plan.summary.albums} albums from the library`,
        );
        break;
      case "track-file-filter":
        console.error(
          `  Retention: ${result.plan.summary.kept} kept, ` +
            `${result.plan.summary.deleteCandidates} delete candidate(s), ` +
            `${result.plan.summary.warnings} warning(s), ` +
            `${formatBytes(result.plan.summary.totalDeleteBytes)}`,
        );
        break;
      case "artist-delete":
        if (!isArtistDeletePlan(result.plan)) {
          throw new Error("artist-delete summary requires an artist-delete plan");
        }
        console.error(
          `  File mode: ${result.plan.operation.deleteFiles ? "delete-files" : "keep-files"}`,
        );
        console.error(
          `  Totals: ${result.plan.summary.artists} artist(s), ${result.plan.summary.albums} album(s), ${result.plan.summary.trackFiles} track file(s), ${result.plan.summary.sizeOnDisk} bytes (${formatBytes(result.plan.summary.sizeOnDisk)})`,
        );
        console.error("  Irreversible: artist and album records will be permanently deleted.");
        break;
      case "artist-add":
        if (!isArtistAddPlan(result.plan)) {
          throw new Error("artist-add summary requires an artist-add plan");
        }
        console.error(
          `  Policy: unmonitored · monitor new items none · search for missing albums disabled`,
        );
        console.error(
          `  Resources: root ${result.plan.operation.rootFolder.path}; quality ${formatReference(result.plan.operation.qualityProfile)}; metadata ${formatReference(result.plan.operation.metadataProfile)}`,
        );
        break;
    }
  }
  for (const item of result.plan.risk.cascade) console.error(pc.dim(`  - ${item}`));
  renderCascadeAnalysis(planCascadeEvidence(result.plan), "Cascade analysis");
  if (result.plan.review.changed === 0) {
    const noun =
      result.plan.operation.kind === "album-edit" || result.plan.operation.kind === "album-delete"
        ? "albums"
        : "artists";
    console.error(pc.green(`  All selected ${noun} are already converged (auditable no-op plan).`));
  }
  console.error("");

  const visibleEntries =
    verbose || isArtistAddPlan(result.plan)
      ? result.plan.entries
      : result.plan.entries.slice(0, LIDARR_HUMAN_PREVIEW_ROWS);
  const operationKind = result.plan.operation.kind;
  if (isArtistAddPlan(result.plan)) {
    renderArtistAddPlanTable(result.plan.entries);
  } else if (operationKind === "album-edit") {
    renderAlbumEditPlanTable(visibleEntries);
  } else if (operationKind === "album-delete") {
    renderAlbumDeletePlanTable(visibleEntries);
  } else if (operationKind === "track-file-filter") {
    const entry = visibleEntries[0] as LidarrTrackFileFilterPlanEntryV2 | undefined;
    const table = new Table({
      columns: [
        { name: "track", title: "Track ID", alignment: "right" },
        { name: "title", title: "Track", alignment: "left" },
        { name: "file", title: "Trackfile ID", alignment: "right" },
        { name: "path", title: "Path", alignment: "left" },
        { name: "size", title: "Size", alignment: "right" },
      ],
    });
    for (const candidate of entry?.before.deleteCandidates ?? []) {
      table.addRow({
        track: candidate.trackId,
        title: truncate(candidate.trackTitle, 32),
        file: candidate.trackFileId,
        path: truncate(candidate.path, 56),
        size: formatBytes(candidate.size),
      });
    }
    console.error(table.render());
  } else {
    const deleteMode = isArtistDeletePlan(result.plan)
      ? result.plan.operation.deleteFiles
        ? "delete-files"
        : "keep-files"
      : undefined;
    const table = new Table({
      columns:
        deleteMode === undefined
          ? [
              { name: "id", title: "Artist ID", alignment: "right" },
              { name: "artist", title: "Artist", alignment: "left" },
              { name: "before", title: "Before", alignment: "left" },
              { name: "after", title: "After", alignment: "left" },
              { name: "detail", title: "Review", alignment: "left" },
            ]
          : [
              { name: "id", title: "Artist ID", alignment: "right" },
              { name: "artist", title: "Artist", alignment: "left" },
              { name: "mode", title: "File Mode", alignment: "left" },
              { name: "path", title: "Path", alignment: "left" },
              { name: "albums", title: "Albums", alignment: "right" },
              { name: "files", title: "Track Files", alignment: "right" },
              { name: "size", title: "Size", alignment: "right" },
            ],
    });
    for (const entry of visibleEntries) {
      if (isAlbumEditPlanEntry(entry) || isAlbumDeletePlanEntry(entry)) continue;
      if (isTrackFileFilterEntry(entry)) continue;
      if ("foreignArtistId" in entry) continue;
      if (deleteMode !== undefined && isArtistDeleteEntry(entry)) {
        table.addRow({
          id: entry.artistId,
          artist: truncate(entry.artistName, 40),
          mode: deleteMode,
          path: entry.before.path,
          albums: entry.before.albumCount,
          files: entry.before.trackFileCount,
          size: `${entry.before.sizeOnDisk} bytes (${formatBytes(entry.before.sizeOnDisk)})`,
        });
      } else {
        table.addRow({
          id: entry.artistId,
          artist: truncate(entry.artistName, 40),
          before: truncate(formatPlanEntryState(entry, "before"), 64),
          after: truncate(formatPlanEntryState(entry, "after"), 64),
          detail: truncate(formatPlanEntryDetail(entry), 64),
        });
      }
    }
    console.error(table.render());
  }
  if (visibleEntries.length < result.plan.entries.length) {
    console.error(
      pc.dim(
        `  Showing ${visibleEntries.length} of ${result.plan.entries.length}; rerun with --verbose to show all.`,
      ),
    );
  }
  if (result.plan.operation.kind === "album-delete") {
    console.error(
      pc.yellow(
        `  Authorization: a real apply requires ${
          result.plan.operation.deleteFiles
            ? "--allow-album-delete --allow-file-delete"
            : "--allow-album-delete"
        }.`,
      ),
    );
  }
  if (result.plan.operation.kind === "track-file-filter") {
    console.error(
      pc.yellow(
        "  Authorization: a real apply requires --allow-file-delete; no trash/recovery is available.",
      ),
    );
  }
  console.error("");
}

/**
 * Projects a Lidarr mutation plan into the repository's stable one-row CSV shape.
 *
 * @param result - Generated plan and artifact path.
 * @returns Flat CSV projection.
 */
export function projectMutationPlanCsv(
  result: AnyLidarrPlanGenerationResult,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    command: "lidarr-plan",
    "result.planPath": result.planPath,
    "result.planId": result.plan.id,
    "result.origin": result.plan.target.origin,
    "result.risk": result.plan.risk.level,
    "result.maxBatch": result.plan.maxBatch,
    "result.changed": result.plan.review.changed,
    "result.unchanged": result.plan.review.unchanged,
    "result.operation": result.plan.operation.kind,
    "result.selection":
      "selection" in result.plan ? JSON.stringify(result.plan.selection) : "exact-ids",
    "result.summary": "summary" in result.plan ? JSON.stringify(result.plan.summary) : "",
    "result.entries": JSON.stringify(result.plan.entries),
    ...projectCascadeAnalysisCsv(planCascadeEvidence(result.plan)),
  };
  if (isArtistDeletePlan(result.plan)) {
    output["result.delete.mode"] = result.plan.operation.deleteFiles
      ? "delete-files"
      : "keep-files";
    output["result.delete.artists"] = result.plan.summary.artists;
    output["result.delete.albums"] = result.plan.summary.albums;
    output["result.delete.trackFiles"] = result.plan.summary.trackFiles;
    output["result.delete.sizeOnDisk"] = result.plan.summary.sizeOnDisk;
  }
  return output;
}

/**
 * Quotes one argument for literal reuse in a POSIX shell command.
 *
 * Single quotes suppress substitution, glob expansion, and whitespace
 * splitting. Embedded single quotes are represented by ending the quoted
 * segment, adding a double-quoted quote, and reopening the segment.
 */
function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function recoveryCommand(
  result: LidarrPlanApplyResult,
  options: MutationApplyPresentationOptions,
): string {
  const authorizationFlags = [
    options.allowTagReplacement ? "--allow-tag-replacement" : undefined,
    options.allowArtistDelete ? "--allow-artist-delete" : undefined,
    options.allowAlbumDelete ? "--allow-album-delete" : undefined,
    options.allowFileDelete ? "--allow-file-delete" : undefined,
    options.plexScan ? "--plex-scan" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  const authorization = authorizationFlags.map((flag) => ` ${flag}`).join("");
  return `rfmedia lidarr apply ${quotePosixShellArgument(result.planPath)} --resume${authorization} --expected-plan-id ${result.planId} --expected-plan-checksum ${result.planChecksum}`;
}

function formatApplyEntryDetail(entry: LidarrPlanApplyEntryResult): string {
  const parts = [
    "foreignArtistId" in entry && "stage" in entry ? `stage=${entry.stage}` : undefined,
    entry.message,
    entry.failure === undefined
      ? undefined
      : `${entry.failure.code}/${entry.failure.stage}; dispatch=${entry.failure.dispatchState}; verification=${entry.failure.verificationState}; next=${entry.failure.safeNextAction}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? "-" : parts.join("; ");
}

/**
 * Renders a Lidarr apply review or result to the human-output stream.
 *
 * @param result - Apply review/result to render.
 * @param options - Preview verbosity and authorization recovery context.
 */
export function renderMutationApply(
  result: LidarrPlanApplyResult,
  options: MutationApplyPresentationOptions,
): void {
  console.error("");
  console.error(pc.bold(result.dryRun ? "Lidarr Apply Check" : "Lidarr Apply Result"));
  console.error("");
  console.error(`  Plan: ${result.planId}`);
  console.error(`  Checksum: ${result.planChecksum}`);
  console.error(`  Status: ${result.status}`);
  console.error(
    `  Risk: ${result.risk.level}${result.risk.destructive ? " · destructive" : " · non-destructive"}`,
  );
  for (const fact of result.risk.cascade) console.error(`    - ${fact}`);
  renderCascadeAnalysis(result.cascadeAnalysis, "Plan-time cascade analysis");
  console.error(
    `  Outcomes: ${result.summary.succeeded} succeeded, ${result.summary.satisfied} satisfied, ${result.summary.deferred} deferred, ${result.summary.uncertain} uncertain, ${result.summary.blockedStale} stale, ${result.summary.failed} failed, ${result.summary.notAttempted} not attempted, ${result.summary.skippedResume} skipped`,
  );
  console.error("");
  const hasArtistAddEntries = result.entries.some((entry) => "foreignArtistId" in entry);
  const visibleEntries =
    options.verbose || hasArtistAddEntries
      ? result.entries
      : result.entries.slice(0, LIDARR_HUMAN_PREVIEW_ROWS);
  const hasAlbumEntries = visibleEntries.some((entry) => "albumId" in entry);
  const table = new Table({
    columns: hasAlbumEntries
      ? [
          { name: "id", title: "Album ID", alignment: "right" },
          { name: "album", title: "Album", alignment: "left" },
          { name: "artist", title: "Artist", alignment: "left" },
          { name: "outcome", title: "Outcome", alignment: "left" },
          { name: "message", title: "Detail", alignment: "left" },
        ]
      : hasArtistAddEntries
        ? [
            { name: "mbid", title: "MusicBrainz ID", alignment: "left" },
            { name: "artist", title: "Artist", alignment: "left" },
            { name: "lidarrId", title: "Lidarr ID", alignment: "right" },
            { name: "outcome", title: "Outcome", alignment: "left" },
            { name: "stage", title: "Stage", alignment: "left" },
            { name: "message", title: "Detail", alignment: "left" },
          ]
        : [
            { name: "id", title: "Artist ID", alignment: "right" },
            { name: "artist", title: "Artist", alignment: "left" },
            { name: "outcome", title: "Outcome", alignment: "left" },
            { name: "before", title: "Before", alignment: "left" },
            { name: "after", title: "After / Observed", alignment: "left" },
            { name: "message", title: "Detail", alignment: "left" },
          ],
  });
  for (const entry of visibleEntries) {
    if ("albumId" in entry) {
      table.addRow({
        id: entry.albumId,
        album: truncate(entry.albumTitle, 36),
        artist: truncate(entry.artistName, 24),
        outcome: entry.outcome,
        message: truncate(formatApplyEntryDetail(entry), 72),
      });
      continue;
    }
    if ("foreignArtistId" in entry) {
      table.addRow({
        mbid: entry.foreignArtistId,
        artist: truncate(entry.artistName, 36),
        lidarrId: entry.lidarrId ?? "-",
        outcome: entry.outcome,
        stage: "stage" in entry ? entry.stage : "-",
        message: truncate(formatApplyEntryDetail(entry), 72),
      });
      continue;
    }
    table.addRow({
      id: entry.artistId,
      artist: truncate(entry.artistName, 36),
      outcome: entry.outcome,
      before: truncate(formatObservedState(entry.before), 56),
      after: truncate(formatObservedState(entry.observed ?? entry.after), 56),
      message: truncate(formatApplyEntryDetail(entry), 72),
    });
  }
  console.error(table.render());
  for (const entry of result.entries) {
    if ("albumId" in entry || entry.failure === undefined) continue;
    if ("foreignArtistId" in entry) {
      console.error(
        `  Failure artist ${entry.foreignArtistId}: ${entry.failure.code}/${entry.failure.stage}; dispatch=${entry.failure.dispatchState}; verification=${entry.failure.verificationState}; retryable=${String(entry.failure.retryable)}; next=${entry.failure.safeNextAction}`,
      );
      continue;
    }
    console.error(
      `  Failure artist ${entry.artistId}: ${entry.failure.code}/${entry.failure.stage}; dispatch=${entry.failure.dispatchState}; verification=${entry.failure.verificationState}; retryable=${String(entry.failure.retryable)}; next=${entry.failure.safeNextAction}`,
    );
  }
  if (visibleEntries.length < result.entries.length) {
    console.error(
      pc.dim(
        `  Showing ${visibleEntries.length} of ${result.entries.length}; rerun with --verbose to show all.`,
      ),
    );
  }
  if (
    result.summary.deferred > 0 ||
    result.summary.uncertain > 0 ||
    result.summary.blockedStale > 0 ||
    result.summary.failed > 0 ||
    result.summary.notAttempted > 0
  ) {
    console.error("");
    console.error(pc.yellow(`  Safe next step: ${recoveryCommand(result, options)}`));
  }
  if (result.scan !== undefined) {
    console.error("");
    console.error(
      `  Media-server scan: ${result.scan.status} (requested=${String(result.scan.requested)}, attempted=${String(result.scan.attempted)})`,
    );
    if (result.scan.message !== undefined) console.error(`    ${result.scan.message}`);
  }
  console.error("");
}

/**
 * Projects a Lidarr apply result into the repository's stable one-row CSV shape.
 *
 * @param result - Apply result to project.
 * @returns Flat CSV projection.
 */
export function projectMutationApplyCsv(result: LidarrPlanApplyResult): Record<string, unknown> {
  const output: Record<string, unknown> = {
    command: "lidarr-apply",
    "result.planId": result.planId,
    "result.planPath": result.planPath,
    "result.status": result.status,
    "result.dryRun": result.dryRun,
    "result.resumed": result.resumed,
    "result.risk": JSON.stringify(result.risk),
    "result.summary": JSON.stringify(result.summary),
    "result.entries": JSON.stringify(result.entries),
    "result.execution.lane": result.execution?.lane ?? "local-only",
    "result.execution.outcome": result.execution?.outcome ?? "succeeded",
    "result.execution.attempts": result.execution?.attempts ?? 0,
    ...projectCascadeAnalysisCsv(result.cascadeAnalysis),
  };
  if (result.scan !== undefined) {
    output["result.scan.requested"] = result.scan.requested;
    output["result.scan.attempted"] = result.scan.attempted;
    output["result.scan.status"] = result.scan.status;
    output["result.scan.message"] = result.scan.message ?? "";
  }
  return output;
}

/**
 * Determines whether an apply requires explicit destructive tag authorization.
 *
 * @param plan - Reviewed mutation plan.
 * @returns Whether the plan replaces or clears the complete tag set.
 */
export function requiresTagReplacementAuthorization(plan: AnyLidarrMutationPlan): boolean {
  return (
    plan.operation.kind === "artist-tag-mutation" &&
    (plan.operation.mode === "set" || plan.operation.mode === "clear")
  );
}

/** Returns whether a reviewed plan removes artists from Lidarr. */
export function requiresArtistDeleteAuthorization(plan: AnyLidarrMutationPlan): boolean {
  return plan.operation.kind === "artist-delete";
}

/** Returns whether a reviewed delete plan also removes managed files on disk. */
export function requiresFileDeleteAuthorization(plan: AnyLidarrMutationPlan): boolean {
  if (plan.operation.kind === "track-file-filter") return true;
  return (
    (plan.operation.kind === "artist-delete" || plan.operation.kind === "album-delete") &&
    plan.operation.deleteFiles === true
  );
}

/**
 * Determines whether an apply requires explicit album-deletion authorization.
 *
 * @param plan - Reviewed mutation plan.
 * @returns Whether the plan removes albums from the Lidarr library.
 */
export function requiresAlbumDeleteAuthorization(plan: AnyLidarrMutationPlan): boolean {
  return plan.operation.kind === "album-delete";
}

/**
 * Rejects an implicit approval flow when no terminal prompt can be shown.
 *
 * @param machineOutput - Whether output is being rendered for a machine consumer.
 */
export function assertInteractiveApplyApproval(machineOutput: boolean): void {
  if (machineOutput || !isInteractive()) {
    throw new MissingRequiredArgumentError(
      "--yes is required for non-interactive or machine-output apply",
    );
  }
}

/** Builds the destructive-consequence phrase shown in the interactive confirm prompt. */
function describeDestructiveApply(plan: AnyLidarrMutationPlan | undefined): string {
  if (plan === undefined) return "";
  if (requiresTagReplacementAuthorization(plan)) return "destructive tag-replacement ";
  if ("summary" in plan && plan.summary.kind === "album-delete") {
    return `destructive album-deletion (${plan.summary.albums} albums, ${plan.summary.totalTrackFiles} files, ${formatBytes(plan.summary.totalSizeOnDisk)}) `;
  }
  if ("summary" in plan && plan.summary.kind === "track-file-filter") {
    return `destructive trackfile deletion (${plan.summary.deleteCandidates} files, ${formatBytes(plan.summary.totalDeleteBytes)}) `;
  }
  return "";
}

/**
 * Renders the dry-run review and asks the operator to approve the real apply.
 *
 * @param planFile - Reviewed plan path displayed in the prompt.
 * @param review - Dry-run apply result to render before prompting.
 * @param reviewedPlan - Parsed artifact used to label destructive consequences.
 * @param options - Human output and destructive-authorization context.
 * @returns Whether the operator approved the mutation.
 */
export async function confirmMutationApply(
  planFile: string,
  review: LidarrPlanApplyResult,
  reviewedPlan: AnyLidarrMutationPlan | undefined,
  options: MutationApplyPresentationOptions,
): Promise<boolean> {
  renderMutationApply(review, options);
  let prompt = `Apply ${describeDestructiveApply(reviewedPlan)}Lidarr mutation plan ${planFile}?`;
  if (reviewedPlan !== undefined && isArtistDeletePlan(reviewedPlan)) {
    const mode = reviewedPlan.operation.deleteFiles ? "delete-files" : "keep-files";
    prompt = `IRREVERSIBLE: apply ${mode} Lidarr artist deletion plan ${planFile} for ${reviewedPlan.summary.artists} artist(s), ${reviewedPlan.summary.albums} album(s), ${reviewedPlan.summary.trackFiles} track file(s), ${reviewedPlan.summary.sizeOnDisk} bytes (${formatBytes(reviewedPlan.summary.sizeOnDisk)})?`;
  }
  const approved = await confirm(prompt);
  if (!approved) {
    console.error(pc.yellow("Lidarr apply cancelled; no changes were made."));
  }
  return approved;
}
