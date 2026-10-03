/**
 * Public, secret-safe contracts for `rfapps import` (adopt external runtime state).
 *
 * `rfapps import` discovers running Compose services that were created outside
 * rfapps-cli and are absent from the SQLite state DB, then records a baseline
 * deployment + generation snapshot so they become manageable by
 * history / rollback / reconcile / update. It never modifies compose.yml and
 * never mutates containers.
 */

/** Schema discriminator for import results. */
export const IMPORT_SCHEMA_VERSION = "import.v1" as const;

/** Whether the invocation only previewed or actually wrote baselines. */
export type ImportMode = "preview" | "adopt";

/**
 * Disposition of a declared service during an import sweep.
 *
 * - `candidate`: running under the project and absent from the state DB — will be adopted.
 * - `tracked`: already has rfapps deployment history — skipped (already managed).
 * - `absent`: declared but not currently running — nothing live to baseline.
 * - `uninspectable`: running but its container could not be safely inspected —
 *   skipped with ZERO state rows written, so it remains importable on retry.
 */
export type ImportClassification = "candidate" | "tracked" | "absent" | "uninspectable";

/** Import exit codes: 0 ok/nothing/all-adopted, 1 failed, 2 invalid/cancelled, 3 partial. */
export type ImportExitCode = 0 | 1 | 2 | 3;

/** Per-service import outcome (secret-free; env values are never surfaced here). */
export interface ImportServiceResult {
  service: string;
  classification: ImportClassification;
  /** Resolved container name for running services. */
  container?: string;
  /** Reviewed image reference captured from the running container. */
  imageTag?: string;
  /** Immutable daemon-local image ID captured from the running container. */
  imageId?: string;
  /** Canonical repository digest, when the running image has one. */
  imageDigest?: string;
  /** True only when a baseline row was written for this service. */
  imported: boolean;
  /** Deployment record id created when adopted. */
  deploymentId?: number;
  /** Baseline generation number created when adopted. */
  generation?: number;
  /** Safe diagnostic for uninspectable services. */
  reason?: string;
}

/** Aggregate counts across the swept services. */
export interface ImportSummary {
  total: number;
  candidates: number;
  imported: number;
  tracked: number;
  absent: number;
  uninspectable: number;
}

/** Full import result for machine (`--json`/`--output`) consumers. */
export interface ImportResult {
  schemaVersion: typeof IMPORT_SCHEMA_VERSION;
  operation: "import";
  mode: ImportMode;
  project: string;
  composePath: string;
  services: ImportServiceResult[];
  summary: ImportSummary;
  success: boolean;
  exitCode: ImportExitCode;
}
