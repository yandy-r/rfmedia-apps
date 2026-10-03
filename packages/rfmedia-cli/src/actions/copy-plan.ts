/**
 * Plan generation and apply actions for `rfmedia copy --plan` / `--apply`.
 *
 * Generation runs the normal copy dispatch in dry-run mode with a
 * `capturePreview` hook, freezes the execution layer, snapshots the advisory
 * review, fingerprints the top-level source dirs, and writes a checksum-sealed
 * plan artifact. Apply reads and verifies a plan (hard corruption errors throw
 * and are never overridable), runs the world-drift staleness matrix, gates on
 * confirmation, replays the frozen options through the same entry points, and
 * records every outcome in the append-only audit ledger.
 */

import { hostname } from "node:os";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathExists } from "../lib/filesystem.js";
import { colors, logInfo, logWarn } from "../lib/logger.js";
import { confirm } from "../lib/prompt.js";
import { formatBytes, getActionSymbol } from "../lib/preview.js";
import { readSourcePaths } from "../lib/input-file.js";
import { requireFfmpeg } from "../lib/convert.js";
import { buildOptionsHash, formatOptionsHash } from "../lib/completed-tracker.js";
import {
  MissingRequiredArgumentError,
  PlanArtifactError,
  PlanStaleError,
  PlanValidationError,
} from "../lib/errors.js";
import {
  appendPlanAudit,
  buildCopyPlan,
  checkStaleness,
  findPlanApplications,
  fingerprintSourceDir,
  getDefaultPlanDir,
  planToCopyOptions,
  prunePlans,
  readPlanArtifact,
  toPlanExecutionOptions,
  writePlanArtifact,
} from "../lib/plan.js";
import {
  COPY_PLAN_MAX_ENTRIES,
  type CopyPlanV1,
  type PlanApplicationRecord,
  type PlanApplyStatus,
  type PlanEntryKind,
  type PlanFingerprints,
  type PlanPreviewCapture,
  type PlanRangeExpansion,
  type PlanReviewEntry,
  type PlanReviewSection,
  type PlanReviewSummary,
  type PlanStalenessReport,
  type PlanSourceFingerprint,
} from "../types/plan.js";
import type { CopyOptions, CopyResult } from "../types/index.js";
import pkg from "../../package.json" with { type: "json" };

const ADVISORY_NOTE =
  "Snapshot of the dry-run preview at plan time. Apply replays the frozen options above; " +
  "conflict decisions are recomputed against the current filesystem.";

/** Arguments for {@link executePlanGeneration}. */
export interface PlanGenerationArgs {
  destination: string;
  /**
   * Fully built by buildCopyOptions in the command layer (which has ALREADY
   * stripped a non-explicit conflictStrategy — resolution 5 / Task D2).
   */
  copyOptions: CopyOptions;
  /** Explicit --plan-output path. */
  planOutput?: string;
}

/** Result of {@link executePlanGeneration}. */
export interface PlanGenerationResult {
  planPath: string;
  plan: CopyPlanV1;
}

/** Arguments for {@link executePlanApply}. */
export interface PlanApplyArgs {
  planPath: string;
  /** --apply --dry-run = check mode, zero mutation. */
  dryRun: boolean;
  yes: boolean;
  forceStale: boolean;
  /** Computed by the command layer via isMachineFormat. */
  machineOutput: boolean;
  /** Allowlisted runtime override. */
  progress?: boolean;
  /** Allowlisted runtime override. */
  verbose?: boolean;
}

function zeroResult(source: string): CopyResult {
  return { source, created: 0, skipped: 0, filtered: 0, failed: [] };
}

function entryKindFor(options: CopyOptions): PlanEntryKind {
  return options.convertFormat ? "convert" : options.hardlink ? "hardlink" : "copy";
}

function hasErrnoCode(error: unknown, ...codes: string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && codes.includes(code);
}

/** Names offending sources in error messages, capped at 10 with a "+N more" tail. */
function nameSources(paths: string[]): string {
  const shown = paths.slice(0, 10);
  const extra = paths.length - shown.length;
  return extra > 0 ? `${shown.join(", ")} (+${extra} more)` : shown.join(", ");
}

function renderSuffixList(start: number, end: number, padWidth: number): string {
  const suffixes: string[] = [];
  const shown = Math.min(end, start + 4);
  for (let index = start; index <= shown; index++) {
    suffixes.push(`-${String(index).padStart(padWidth, "0")}`);
  }
  if (end > shown) suffixes.push("…");
  return suffixes.join(", ");
}

/** Builds the advisory review section from the dry-run preview captures. */
async function buildReviewSection(
  captures: PlanPreviewCapture[],
  options: CopyOptions,
): Promise<PlanReviewSection> {
  const kind = entryKindFor(options);
  const summary: PlanReviewSummary = {
    create: 0,
    skip: 0,
    overwrite: 0,
    incomplete: 0,
    filtered: 0,
    files: 0,
    bytes: 0,
  };
  const entries: PlanReviewEntry[] = [];
  const isAlbum = options.mode.type === "album";

  for (const capture of captures) {
    if (capture.mode === "album") {
      const { preview } = capture;
      for (const album of preview.albums) {
        for (const suffix of album.suffixes) {
          entries.push({
            op: suffix.action,
            kind,
            sourcePath: album.sourcePath,
            destPath: suffix.destPath,
            bytes: suffix.totalBytes,
            fileCount: suffix.fileCount,
            ...(suffix.reason !== undefined && { reason: suffix.reason }),
          });
        }
      }
      summary.create += preview.totals.creates;
      summary.skip += preview.totals.skips;
      summary.overwrite += preview.totals.overwrites;
      summary.incomplete += preview.totals.recreates;
      summary.files += preview.totals.files;
      summary.bytes += preview.totals.bytes;
    } else {
      const { preview } = capture;
      for (const track of preview.likedTracks) {
        entries.push({
          op: track.action,
          kind,
          sourcePath: track.sourcePath,
          destPath: track.destPath,
          bytes: track.bytes,
          ...(track.reason !== undefined && { reason: track.reason }),
        });
        // Count ops individually — willCopy merges create+overwrite.
        summary[track.action] += 1;
        if (track.action !== "skip") summary.bytes += track.bytes;
      }
      summary.filtered += preview.filteredCount;
    }
  }
  if (!isAlbum) {
    summary.files = summary.create + summary.overwrite;
  }

  const truncated = entries.length > COPY_PLAN_MAX_ENTRIES;
  const kept = truncated ? entries.slice(0, COPY_PLAN_MAX_ENTRIES) : entries;

  if (options.mode.type === "filter") {
    // Per-entry stat pass (resolution 20: persisted mtimes are truncated).
    for (const entry of kept) {
      try {
        const entryStat = await stat(entry.sourcePath);
        entry.sourceSize = entryStat.size;
        entry.sourceMtimeMs = Math.trunc(entryStat.mtimeMs);
      } catch (error) {
        // A file that vanished between preview and stat stays un-stamped;
        // the apply-side entry-drift check treats the missing file as drift.
        if (!hasErrnoCode(error, "ENOENT", "ENOTDIR")) throw error;
      }
    }
  }

  let rangeExpansion: PlanRangeExpansion | undefined;
  if (options.mode.type === "filter" && options.mode.rating.range) {
    const { start, end, padWidth } = options.mode.rating.range;
    rangeExpansion = {
      start,
      end,
      padWidth,
      copiesPerEntry: end - start + 1,
      note:
        "destPath shows the base path; execution creates one suffixed copy per range index " +
        `(${renderSuffixList(start, end, padWidth)}).`,
    };
  }

  return {
    advisory: true,
    note: ADVISORY_NOTE,
    granularity: isAlbum ? "suffix" : "track",
    truncated,
    ...(rangeExpansion !== undefined && { rangeExpansion }),
    entries: kept,
    summary,
  };
}

/** Fingerprints every distinct frozen top-level source plus the destination. */
async function buildFingerprints(
  sourcePaths: string[],
  destination: string,
): Promise<PlanFingerprints> {
  const distinctPaths = [...new Set(sourcePaths)];
  const sources: PlanSourceFingerprint[] = [];
  for (const sourcePath of distinctPaths) {
    sources.push(await fingerprintSourceDir(sourcePath));
  }
  return {
    sources,
    destination: { path: destination, exists: await pathExists(destination) },
  };
}

/** `YYYYMMDDTHHmmss` — filesystem-safe compaction of an ISO timestamp. */
function compactTimestamp(createdAt: string): string {
  return createdAt.replace(/[-:]/gu, "").slice(0, 15);
}

/**
 * Generates a copy plan: replays the normal dispatch in dry-run mode with a
 * capturePreview hook, then freezes options + review + fingerprints into a
 * checksum-sealed artifact.
 *
 * @param args - Destination, fully built copy options, optional output path.
 * @returns The written plan path and the sealed plan.
 * @throws PlanArtifactError `PLAN_EMPTY` when no preview data was captured
 *   (nothing is written), or any hardened-IO error from the artifact write.
 * @throws PlanValidationError when the dry-run dispatch reports failed sources
 *   or a frozen source produced no preview capture (nothing is written) — a
 *   plan must never freeze sources its review and fingerprints cannot see.
 */
export async function executePlanGeneration(
  args: PlanGenerationArgs,
): Promise<PlanGenerationResult> {
  // --file freezing (resolution 21): resolve sources ONCE and freeze them so
  // generation and apply see identical entries; `file` stays as tracking id.
  let baseOptions = args.copyOptions;
  if (baseOptions.file && !baseOptions.cliSourceEntries?.length) {
    const entries = await readSourcePaths(baseOptions.file);
    if (entries.length === 0) {
      throw new PlanArtifactError(
        "PLAN_EMPTY",
        `No source paths found in file: ${baseOptions.file}`,
      );
    }
    baseOptions = { ...baseOptions, cliSourceEntries: entries };
  }

  // Absolute-path freezing: frozen source entries and the destination are
  // resolved at plan time so the artifact replays identically from any
  // apply-time cwd (fingerprints already resolve internally).
  const destination = resolve(args.destination);
  if (baseOptions.cliSourceEntries?.length) {
    baseOptions = {
      ...baseOptions,
      cliSourceEntries: baseOptions.cliSourceEntries.map((entry) => ({
        ...entry,
        path: resolve(entry.path),
      })),
    };
  }
  const frozenSourcePaths = (baseOptions.cliSourceEntries ?? []).map((entry) => entry.path);

  const captures: PlanPreviewCapture[] = [];
  const genOptions: CopyOptions = {
    ...baseOptions,
    dryRun: true,
    capturePreview: (capture) => captures.push(capture),
  };

  let dryRunResult: CopyResult;
  if (baseOptions.mode.type === "album") {
    const { executeAlbumCopyWithFileInput } = await import("./copy-album.js");
    dryRunResult = await executeAlbumCopyWithFileInput(undefined, destination, genOptions);
  } else {
    const { executeFilterCopyWithFileInput } = await import("./copy-filter.js");
    dryRunResult = await executeFilterCopyWithFileInput(undefined, destination, genOptions);
  }

  if (dryRunResult.failed.length > 0) {
    const failedPaths = dryRunResult.failed.map((failure) => failure.path);
    throw new PlanValidationError(
      `dry-run preview failed for ${failedPaths.length} source(s): ` +
        `${nameSources(failedPaths)}; the plan was not written`,
    );
  }

  if (captures.length === 0) {
    throw new PlanArtifactError(
      "PLAN_EMPTY",
      "Plan generation captured no preview data; nothing was written",
    );
  }

  const capturedSources = new Set(captures.map((capture) => resolve(capture.source)));
  const uncapturedSources = frozenSourcePaths.filter((path) => !capturedSources.has(path));
  if (uncapturedSources.length > 0) {
    throw new PlanValidationError(
      `${uncapturedSources.length} frozen source(s) produced no dry-run preview ` +
        `(missing or empty): ${nameSources(uncapturedSources)}; the plan was not written`,
    );
  }

  const review = await buildReviewSection(captures, baseOptions);
  const fingerprints = await buildFingerprints(
    [...frozenSourcePaths, ...capturedSources],
    destination,
  );
  const execution = toPlanExecutionOptions(baseOptions);
  const optionsKey = formatOptionsHash(buildOptionsHash(baseOptions));
  const plan = buildCopyPlan({
    destination,
    execution,
    optionsKey,
    review,
    fingerprints,
  });

  const planPath =
    args.planOutput ??
    join(
      getDefaultPlanDir(),
      `plan-${compactTimestamp(plan.createdAt)}-${plan.id.slice(0, 8)}.json`,
    );
  const writtenPath = await writePlanArtifact(planPath, plan);
  if (!args.planOutput) {
    await prunePlans();
  }

  logInfo(`Plan saved: ${writtenPath}`);
  logInfo(`To apply this plan, run: rfmedia copy --apply ${writtenPath}`);
  return { planPath: writtenPath, plan };
}

function renderStalenessReport(report: PlanStalenessReport): void {
  if (report.findings.length === 0) return;
  const overridden = new Set(report.overridden);
  for (const finding of report.findings) {
    const isOverridden = overridden.has(finding);
    const paint = finding.severity === "error" && !isOverridden ? colors.red : colors.yellow;
    const label = isOverridden ? " (overridden by --force-stale)" : "";
    logWarn(paint(`[${finding.code}] ${finding.message}${label}`));
    for (const path of (finding.paths ?? []).slice(0, 10)) {
      logWarn(paint(`  - ${path}`));
    }
  }
}

function formatPlanAge(createdAt: string): string {
  const ageMs = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) return createdAt;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function renderReviewSummary(plan: CopyPlanV1): void {
  const { summary } = plan.review;
  logInfo(colors.bold(`Plan ${plan.id} (${plan.optionsKey})`));
  logInfo(`  ${getActionSymbol("create")} create: ${summary.create}`);
  logInfo(`  ${getActionSymbol("skip")} skip: ${summary.skip}`);
  logInfo(`  ${getActionSymbol("overwrite")} overwrite: ${summary.overwrite}`);
  logInfo(`  ${getActionSymbol("incomplete")} incomplete: ${summary.incomplete}`);
  logInfo(`  files: ${summary.files} (${formatBytes(summary.bytes)})`);
  logInfo(`  created ${formatPlanAge(plan.createdAt)} on ${plan.createdBy.host}`);
}

function buildAuditRecord(
  plan: CopyPlanV1,
  resolvedPlanPath: string,
  args: PlanApplyArgs,
  report: PlanStalenessReport,
  status: PlanApplyStatus,
  counts: PlanApplicationRecord["counts"],
  historySessionId?: string,
): PlanApplicationRecord {
  return {
    planId: plan.id,
    planPath: resolvedPlanPath,
    planChecksum: plan.payloadChecksum,
    appliedAt: new Date().toISOString(),
    host: hostname(),
    cliVersion: pkg.version,
    status,
    forcedStale: args.forceStale,
    stalenessErrorsOverridden:
      status === "aborted-stale" ? [] : report.overridden.map((finding) => finding.code),
    stalenessWarnings: report.warnings.length,
    counts,
    ...(historySessionId !== undefined && { historySessionId }),
  };
}

/**
 * Applies (or, with dryRun, checks) a previously saved plan.
 *
 * Hard corruption errors (checksum/validator/unsafe path) throw from
 * {@link readPlanArtifact} and are never overridable. Staleness errors block
 * unless downgraded by --force-stale. Every non-check outcome is appended to
 * the audit ledger.
 *
 * @param args - Plan path plus apply gates and runtime overrides.
 * @returns The CopyResult from the replayed dispatch (zeros in check mode or
 *   on user decline).
 * @throws PlanArtifactError / PlanValidationError for corruption,
 *   PlanStaleError for blocking staleness, MissingRequiredArgumentError for
 *   non-interactive gating failures.
 */
export async function executePlanApply(args: PlanApplyArgs): Promise<CopyResult> {
  const resolvedPlanPath = resolve(args.planPath);
  const plan = await readPlanArtifact(args.planPath);
  const report = await checkStaleness(plan, { forceStale: args.forceStale });

  renderStalenessReport(report);

  if (report.errors.length > 0) {
    if (!args.dryRun) {
      await appendPlanAudit(
        buildAuditRecord(plan, resolvedPlanPath, args, report, "aborted-stale", {
          created: 0,
          skipped: 0,
          failed: 0,
          filtered: 0,
        }),
      );
    }
    throw new PlanStaleError(report.errors, args.planPath);
  }

  renderReviewSummary(plan);

  const prior = await findPlanApplications(plan.id);
  const last = prior[prior.length - 1];
  if (last !== undefined) {
    logWarn(
      `Plan ${plan.id} was already applied on ${last.appliedAt} ` +
        `(status: ${last.status}, session ${last.historySessionId ?? "n/a"})`,
    );
  }

  // Check mode: no dispatch, no audit, no confirmation.
  if (args.dryRun) {
    logInfo("Plan check passed: valid and fresh (warnings allowed). Nothing was executed.");
    return zeroResult(args.planPath);
  }

  // Frozen-"ask" pre-flight (resolution 5): only present when explicitly
  // passed at plan time; per-conflict prompting needs an interactive TTY.
  if (plan.execution.conflictStrategy === "ask" && (args.machineOutput || !process.stdin.isTTY)) {
    throw new MissingRequiredArgumentError(
      'this plan froze conflict-strategy "ask", which cannot prompt non-interactively; ' +
        "regenerate with an explicit --conflict-strategy (e.g. skip or overwrite)",
    );
  }

  // ffmpeg pre-flight: fail fast through the registered formatter instead of
  // per-file mid-run (which would leave partial copies and a "partial" audit).
  if (plan.execution.convertFormat) {
    await requireFfmpeg();
  }

  if (!args.yes) {
    if (!process.stdin.isTTY || args.machineOutput) {
      throw new MissingRequiredArgumentError(
        "--apply requires --yes when running non-interactively (non-TTY or machine output); " +
          "pass --yes to apply non-interactively",
      );
    }
    const ok = await confirm("Apply this plan?");
    if (!ok) {
      await appendPlanAudit(
        buildAuditRecord(plan, resolvedPlanPath, args, report, "aborted-user", {
          created: 0,
          skipped: 0,
          failed: 0,
          filtered: 0,
        }),
      );
      logInfo("Cancelled");
      return zeroResult(args.planPath);
    }
  }

  let historySessionId: string | undefined;
  const copyOptions: CopyOptions = {
    ...planToCopyOptions(plan, false),
    onHistorySession: (id: string) => {
      historySessionId = id;
    },
    ...(args.progress !== undefined && { progress: args.progress }),
    ...(args.verbose !== undefined && { verbose: args.verbose }),
  };

  let result: CopyResult;
  try {
    if (plan.execution.mode.type === "album") {
      const { executeAlbumCopyWithFileInput } = await import("./copy-album.js");
      result = await executeAlbumCopyWithFileInput(undefined, plan.destination, copyOptions);
    } else {
      const { executeFilterCopyWithFileInput } = await import("./copy-filter.js");
      result = await executeFilterCopyWithFileInput(undefined, plan.destination, copyOptions);
    }
  } catch (error) {
    // A throwing dispatch must still leave an audit trail (counts zeroed);
    // rethrow so the typed error surfaces through the registered formatters.
    await appendPlanAudit(
      buildAuditRecord(
        plan,
        resolvedPlanPath,
        args,
        report,
        "failed",
        { created: 0, skipped: 0, failed: 0, filtered: 0 },
        historySessionId,
      ),
    );
    throw error;
  }

  const status: PlanApplyStatus =
    result.failed.length === 0 ? "completed" : result.created > 0 ? "partial" : "failed";
  await appendPlanAudit(
    buildAuditRecord(
      plan,
      resolvedPlanPath,
      args,
      report,
      status,
      {
        created: result.created,
        skipped: result.skipped,
        failed: result.failed.length,
        filtered: result.filtered,
      },
      historySessionId,
    ),
  );
  logInfo(`Recorded apply of plan ${plan.id} (session ${historySessionId ?? "n/a"}) in audit log`);
  return result;
}
