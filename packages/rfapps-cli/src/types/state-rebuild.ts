/**
 * Public, secret-safe contracts for the `rfapps state` command group
 * (`state export` and `state rebuild`).
 *
 * Strict, no `any`, secret-free by construction: these envelopes carry service
 * names, image identity, counts, dispositions and paths — never environment
 * values.
 */

import type { OutputFormat } from "@rfmedia/common";

/** Schema discriminators for the state-group result envelopes. */
export const STATE_REBUILD_SCHEMA_VERSION = "state-rebuild.v1" as const;
export const STATE_EXPORT_SCHEMA_VERSION = "state-export.v1" as const;

/** Reconstruction strategy for the replacement database. */
export type StateRebuildMode = "salvage" | "runtime-only";

/** Whether the invocation only reported or actually replaced the database. */
export type StateRebuildPhase = "report" | "rewrite";

/**
 * Disposition of one service in a rebuild sweep.
 *
 * - `reconstructed`: a baseline row was (or would be) written from observed runtime.
 * - `carried`:       readable history exists and its latest generation matches runtime.
 * - `stale`:         readable history exists but its latest generation image id differs
 *                    from runtime (or is null). Reported only — never rewritten.
 * - `orphaned`:      has state rows but is neither declared in compose nor observed.
 * - `absent`:        declared but no container was observed.
 * - `uninspectable`: observed but inspection failed; ZERO rows are written for it.
 */
export type StateRebuildDisposition =
  | "reconstructed"
  | "carried"
  | "stale"
  | "orphaned"
  | "absent"
  | "uninspectable";

/** Readability of the pre-existing state database. */
export type StateDatabaseStatus = "missing" | "readable" | "unreadable";

/** How the mandatory backup artifact was produced. */
export type StateBackupMethod = "sqlite-backup" | "raw-copy";

/** Why an authorized rewrite was refused before any side effect. */
export type StateRebuildRefusalReason = "empty-plan";

/**
 * Why an authorized rewrite failed after side effects had begun.
 *
 * - `carry-over-failed`: salvage carried NOTHING from a source the probe reports
 *   as readable with deployments, so the replacement would have held only fresh
 *   baselines. The replacement was discarded and the target left untouched.
 */
export type StateRebuildFailureReason = "carry-over-failed";

/** 0 ok, 1 failed (DB unchanged), 2 invalid/cancelled/refused, 3 partial. */
export type StateRebuildExitCode = 0 | 1 | 2 | 3;

/** 0 written or dry-run, 1 failed, 2 invalid usage. */
export type StateExportExitCode = 0 | 1 | 2;

/** Raw options Commander parses for `rfapps state rebuild`. */
export interface RawStateRebuildOptions {
  mode?: StateRebuildMode;
  rewrite?: boolean;
  confirmProject?: string;
  runningOnly?: boolean;
  backupDir?: string;
  showUnchanged?: boolean;
  compose?: string;
  envFile?: string;
  profile?: string;
}

/** Raw options Commander parses for `rfapps state export`. */
export interface RawStateExportOptions {
  out?: string;
}

/** Global options forwarded from the root program. */
export interface StateCommandGlobalOptions {
  dryRun?: boolean;
  debug?: boolean;
  json?: boolean;
  output?: OutputFormat;
  verbose?: boolean;
  yes?: boolean;
  useDotenvx?: string;
  useOp?: string;
}

/** Read-only diagnosis of the pre-existing database. Never throws to produce this. */
export interface StateDatabaseProbe {
  /** Absolute resolved path (getStateDbPath). */
  path: string;
  status: StateDatabaseStatus;
  /** False when config/env redirected the path away from getDefaultDatabasePath(). */
  isDefaultPath: boolean;
  /** Stored metadata.schema_version, when readable. */
  schemaVersion?: number;
  /** Result of PRAGMA integrity_check, when readable. */
  integrity?: "ok" | "failed";
  deployments?: number;
  generations?: number;
  /** SELECT DISTINCT service FROM deployments, sorted. */
  trackedServices?: string[];
  oldestTimestamp?: string;
  newestTimestamp?: string;
  /** Sanitized diagnostic for `unreadable`. */
  reason?: string;
}

/** The mandatory pre-rewrite (or explicit export) backup artifact. */
export interface StateBackupResult {
  path: string;
  method: StateBackupMethod;
  bytes: number;
  /** Sidecar files copied alongside the database in raw-copy mode. */
  sidecars: string[];
}

/** Row-level accounting for salvage carry-over. Always present for `rewrite`. */
export interface CarryOverCounts {
  deploymentsCarried: number;
  deploymentsDiscarded: number;
  generationsCarried: number;
  generationsDiscarded: number;
  /** Generations re-derived from carried deployments (source had none). */
  generationsDerived: number;
}

/** Per-service outcome (secret-free; env values are never surfaced here). */
export interface StateRebuildServiceResult {
  service: string;
  disposition: StateRebuildDisposition;
  /** Container name from `docker compose ps --all`. */
  container?: string;
  /** Observed container state (e.g. "running", "exited"). */
  containerState?: string;
  imageTag?: string;
  imageId?: string;
  imageDigest?: string;
  /** image_id of the latest carried generation, used for stale detection. */
  recordedImageId?: string;
  /** True only when a baseline row was written for this service. */
  written: boolean;
  deploymentId?: number;
  /** Actual generation number assigned by createGeneration (never assumed). */
  generation?: number;
  reason?: string;
}

/** Aggregate counts across the sweep. */
export interface StateRebuildSummary {
  declared: number;
  observed: number;
  reconstructed: number;
  carried: number;
  stale: number;
  orphaned: number;
  absent: number;
  uninspectable: number;
  /** Services with history in the source that have no row in the replacement. */
  droppedServices: string[];
  /** Always 0 for a clean salvage; the machine-checkable safety invariant. */
  discardedDeployments: number;
  discardedGenerations: number;
}

/** Structured refusal emitted instead of throwing, so machine consumers see it. */
export interface StateRebuildRefusal {
  reason: StateRebuildRefusalReason;
  message: string;
}

/**
 * Structured operational failure emitted instead of throwing.
 *
 * Distinct from `refusal`: a refusal is a usage-level veto taken before any side
 * effect (exit 2), whereas a failure means the rebuild ran, could not be trusted
 * and was abandoned with the target byte-identical to its backup (exit 1).
 */
export interface StateRebuildFailure {
  reason: StateRebuildFailureReason;
  message: string;
}

/** Full rebuild result for machine (`--json`/`--output`) consumers. */
export interface StateRebuildResult {
  schemaVersion: typeof STATE_REBUILD_SCHEMA_VERSION;
  operation: "state-rebuild";
  phase: StateRebuildPhase;
  mode: StateRebuildMode;
  project: string;
  composePath: string;
  database: StateDatabaseProbe;
  /**
   * Present only when an existing database was backed up; absent when the target
   * did not exist. This is NOT a "was it replaced" signal — a backup is also
   * present when the rebuild was abandoned after it. Use `phase === "rewrite"`
   * to tell whether the database was actually replaced.
   */
  backup?: StateBackupResult;
  /** Present for `rewrite`, and for a `carry-over-failed` failure. */
  carryOver?: CarryOverCounts;
  services: StateRebuildServiceResult[];
  summary: StateRebuildSummary;
  refusal?: StateRebuildRefusal;
  /** Present only when an authorized rewrite was abandoned mid-flight. */
  failure?: StateRebuildFailure;
  success: boolean;
  exitCode: StateRebuildExitCode;
}

/** Full export result for machine consumers. */
export interface StateExportResult {
  schemaVersion: typeof STATE_EXPORT_SCHEMA_VERSION;
  operation: "state-export";
  database: StateDatabaseProbe;
  destination: string;
  /** Absent when `dryRun` is true. */
  backup?: StateBackupResult;
  dryRun: boolean;
  success: boolean;
  exitCode: StateExportExitCode;
}
