/**
 * Type definitions for the copy plan/apply workflow (rfmedia.copy-plan.v1).
 *
 * A plan freezes the binding execution options and an advisory review snapshot
 * at generation time; apply replays the frozen options after staleness checks.
 *
 * Hard errors (checksum mismatch, validator failure, bad version/command,
 * symlink/oversize/malformed-JSON) are thrown typed errors, never
 * PlanStalenessFindings — the finding type covers only the world-drift matrix.
 */

import type { CopyMode, CopyRange, ConvertFormat, PathEntry } from "./options.js";
import type { ConflictStrategy } from "./conflict.js";
import type { PreviewAction, PreviewResult, FilterPreview } from "./preview.js";

export const COPY_PLAN_VERSION = "rfmedia.copy-plan.v1";
/** 10 MiB — rfmedia's own cap (rfapps uses 1 MiB; deliberate divergence). */
export const COPY_PLAN_MAX_BYTES = 10 * 1024 * 1024;
/** Review entries cap; beyond this, entries are truncated and per-entry staleness degrades. */
export const COPY_PLAN_MAX_ENTRIES = 20_000;

/**
 * Binding execution layer: allowlisted mirror of SerializableCopyOptions
 * PLUS verify + conflictStrategy, MINUS plexToken. Never contains selection,
 * dryRun, capturePreview, or onHistorySession.
 */
export interface PlanExecutionOptions {
  mode: CopyMode;
  albumOnly: boolean;
  hardlink: boolean;
  convertFormat?: ConvertFormat;
  force: boolean;
  /**
   * Only present when --conflict-strategy was EXPLICITLY passed at plan time
   * (resolution 5); undefined replays queue semantics (conflicts degrade to skip).
   */
  conflictStrategy?: ConflictStrategy;
  /** Restored (dropped by SerializableCopyOptions). */
  verify?: boolean;
  workers: number;
  file?: string;
  paths?: string;
  progress?: boolean;
  trackCompleted?: boolean;
  completedFile?: string;
  resetCompleted?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireDiskSpace?: boolean;
  cliRange?: CopyRange;
  configRange?: CopyRange;
  count?: number;
  cliSourceEntries?: PathEntry[];
  verbose?: boolean;
  sourceIdx?: string;
  sourceName?: string;
  sourceArtist?: string;
  sourceGroup?: string;
}

export type PlanEntryKind = "copy" | "convert" | "hardlink";

export interface PlanReviewEntry {
  /** "create" | "skip" | "overwrite" | "incomplete" — verbatim reuse of PreviewAction. */
  op: PreviewAction;
  kind: PlanEntryKind;
  sourcePath: string;
  destPath: string;
  bytes: number;
  /** Filter mode only (per-entry stat). */
  sourceSize?: number;
  /** Filter mode only; Math.trunc(stat.mtimeMs) — resolution 20. */
  sourceMtimeMs?: number;
  /** Album mode only (per-suffix). */
  fileCount?: number;
  reason?: string;
}

export interface PlanRangeExpansion {
  start: number;
  end: number;
  padWidth: number;
  copiesPerEntry: number;
  note: string;
}

export interface PlanReviewSummary {
  create: number;
  skip: number;
  overwrite: number;
  incomplete: number;
  filtered: number;
  files: number;
  bytes: number;
}

export interface PlanReviewSection {
  advisory: true;
  note: string;
  /** Filter mode = "track"; album mode = "suffix". */
  granularity: "track" | "suffix";
  truncated: boolean;
  rangeExpansion?: PlanRangeExpansion;
  entries: PlanReviewEntry[];
  summary: PlanReviewSummary;
}

export interface PlanSourceFingerprint {
  path: string;
  exists: boolean;
  fileCount: number;
  totalBytes: number;
  /** Math.trunc()-normalized — resolution 20. */
  maxMtimeMs: number;
}

export interface PlanFingerprints {
  sources: PlanSourceFingerprint[];
  destination: { path: string; exists: boolean };
}

export interface PlanCreatedBy {
  host: string;
  user: string;
  cliVersion: string;
  cwd: string;
}

export interface CopyPlanV1 {
  version: typeof COPY_PLAN_VERSION;
  /** randomUUID. */
  id: string;
  /** ISO 8601. */
  createdAt: string;
  createdBy: PlanCreatedBy;
  command: "copy";
  destination: string;
  execution: PlanExecutionOptions;
  /** formatOptionsHash(buildOptionsHash(...)). */
  optionsKey: string;
  review: PlanReviewSection;
  fingerprints: PlanFingerprints;
  /** "sha256:<hex>" over canonical JSON minus this field. */
  payloadChecksum: string;
}

export type PlanStalenessSeverity = "error" | "warning";

export type PlanStalenessCode =
  | "source-missing" // error, overridable
  | "source-drift" // error, overridable (fileCount/totalBytes/maxMtimeMs)
  | "entry-drift" // error, overridable (filter per-entry size/mtime/missing)
  | "plan-age" // warning (> 24h)
  | "host-mismatch" // warning
  | "cli-version" // warning
  | "dest-drift" // warning (review op vs current dest existence)
  | "filter-resolution" // warning (per-source filterName resolves from CURRENT config at apply)
  | "review-truncated"; // warning

export interface PlanStalenessFinding {
  severity: PlanStalenessSeverity;
  code: PlanStalenessCode;
  message: string;
  /** Affected paths, capped at 10 by the producer; message carries "+N more". */
  paths?: string[];
  /** True for all "error" codes above; warnings always proceed. */
  overridable: boolean;
}

export interface PlanStalenessReport {
  /** Everything, errors first. */
  findings: PlanStalenessFinding[];
  /** Blocking errors remaining AFTER --force-stale downgrade. */
  errors: PlanStalenessFinding[];
  /** Errors downgraded to warnings by --force-stale. */
  overridden: PlanStalenessFinding[];
  /** Native warnings + overridden. */
  warnings: PlanStalenessFinding[];
}

export type PlanApplyStatus = "completed" | "partial" | "failed" | "aborted-stale" | "aborted-user";

export interface PlanApplicationRecord {
  planId: string;
  planPath: string;
  planChecksum: string;
  /** ISO 8601. */
  appliedAt: string;
  host: string;
  cliVersion: string;
  status: PlanApplyStatus;
  forcedStale: boolean;
  /** PlanStalenessCode values (codes, not bool). */
  stalenessErrorsOverridden: string[];
  stalenessWarnings: number;
  counts: { created: number; skipped: number; failed: number; filtered: number };
  historySessionId?: string;
}

/**
 * Runtime capture handed to CopyOptions.capturePreview. Filter captures arrive
 * PER-SOURCE as FilterPreview (not FilterPreviewResult). Both arms carry the
 * source path so fingerprinting covers the TOP-LEVEL source dirs (an album
 * added under an artist dir after planning must drift the fingerprint).
 */
export type PlanPreviewCapture =
  | { mode: "album"; source: string; preview: PreviewResult }
  | { mode: "filter"; source: string; preview: FilterPreview };
