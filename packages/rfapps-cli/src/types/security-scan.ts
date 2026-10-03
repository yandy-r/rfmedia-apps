/**
 * Image vulnerability scan contracts for rfapps CLI.
 *
 * Import-free except for `ToolCheckResult`, so `types/config.ts` can import
 * `ScanConfig` from here without a runtime cycle.
 */

import type { ToolCheckResult } from "@rfmedia/common";

/** Schema tag stamped onto every emitted `ScanReport`. */
export const SCAN_SCHEMA_VERSION = "security-scan.v1" as const;

/** Supported scanner backends. */
export type ScannerId = "trivy" | "grype";

/** Normalized severity vocabulary shared by every backend. */
export type ScanSeverity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";

/** Gate threshold: a severity, or `none` to report without blocking. */
export type ScanFailOn = ScanSeverity | "none";

/** A single service/image pair queued for scanning. */
export interface ScanTarget {
  readonly service: string;
  readonly image: string;
}

/** One normalized finding from a scanner report. */
export interface ScanVulnerability {
  readonly id: string;
  readonly severity: ScanSeverity;
  readonly rawSeverity: string;
  readonly packageName: string;
  readonly installedVersion: string;
  readonly fixedVersion?: string;
  readonly reference?: string;
}

/** Finding tally by normalized severity. */
export interface ScanSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly negligible: number;
  readonly unknown: number;
}

/** Why a service was never handed to the scanner. */
export type ScanSkipReason = "build-only" | "no-image" | "duplicate-image" | "target-cap";

/** Why a scan that was attempted did not produce findings. */
export type ScanFailureCode =
  | "scanner-unavailable"
  | "timeout"
  | "output-limit"
  | "scanner-error"
  | "invalid-report";

/** Per-target outcome. Every failure mode is an arm, never a thrown error. */
export type ImageScan =
  | {
      readonly status: "scanned";
      readonly service: string;
      readonly image: string;
      readonly counts: ScanSeverityCounts;
      readonly vulnerabilities: readonly ScanVulnerability[];
      readonly suppressed: number;
      readonly truncated: boolean;
      readonly durationMs: number;
    }
  | {
      readonly status: "skipped";
      readonly service: string;
      readonly image: string;
      readonly reason: ScanSkipReason;
      readonly scannedBy?: string;
    }
  | {
      readonly status: "failed";
      readonly service: string;
      readonly image: string;
      readonly reason: ScanFailureCode;
      readonly detail: string;
    };

/** Gate outcome. `inconclusive` means a scan could not complete, which is not a pass. */
export type ScanGateStatus = "passed" | "blocked" | "inconclusive";

/** The single authoritative blocking decision for a report. */
export interface ScanGate {
  readonly failOn: ScanFailOn;
  readonly status: ScanGateStatus;
  readonly blocking: boolean;
  readonly blockedBy: readonly string[];
}

/** Report-wide totals across every target. */
export interface ScanSummary extends ScanSeverityCounts {
  readonly total: number;
  readonly suppressed: number;
  readonly targetsScanned: number;
  readonly targetsSkipped: number;
  readonly targetsFailed: number;
}

/** What the scan covered, echoed back for auditability. */
export interface ScanScope {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
}

/** The backend that produced the report, and whether it was actually present. */
export interface ScannerIdentity {
  readonly id: ScannerId;
  readonly binary: string;
  readonly version?: string;
  readonly available: boolean;
}

/** Complete scan result, suitable for terminal rendering or `--json`. */
export interface ScanReport {
  readonly schemaVersion: typeof SCAN_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly scanner: ScannerIdentity;
  readonly scope: ScanScope;
  readonly gate: ScanGate;
  readonly summary: ScanSummary;
  readonly images: readonly ImageScan[];
  readonly notes: readonly string[];
}

/** A documented, optionally time-boxed acceptance of a finding. */
export interface ScanSuppression {
  readonly id: string;
  readonly service?: string;
  readonly reason: string;
  readonly until?: string;
}

/**
 * `scan:` block of `rfapps.config.yaml`.
 *
 * Deliberately has no `enabled`/`always` key: scanning is reachable only through
 * an explicit CLI flag, which is what keeps the MCP surface unchanged.
 */
export interface ScanConfig {
  readonly scanner?: ScannerId;
  readonly failOn?: ScanFailOn;
  readonly ignore?: readonly ScanSuppression[];
  readonly timeoutMs?: number;
  readonly maxTargets?: number;
  readonly concurrency?: number;
}

/** Fully resolved settings after CLI, config, and defaults are merged. */
export interface ResolvedScanSettings {
  readonly scanner: ScannerId;
  readonly failOn: ScanFailOn;
  readonly ignore: readonly ScanSuppression[];
  readonly timeoutMs: number;
  readonly maxTargets: number;
  readonly concurrency: number;
  readonly cwd: string;
}

/** Minimal compose service shape the scanner needs to classify a target. */
export interface ScanComposeService {
  readonly image?: string;
  readonly build?: unknown;
}

/** Minimal resolved compose shape the scanner needs. */
export interface ScanComposeConfig {
  readonly services: Readonly<Record<string, ScanComposeService>>;
}

/** Backend parse outcome. Parsers narrow untrusted input and never throw. */
export type ScannerParseResult =
  | { readonly ok: true; readonly vulnerabilities: readonly ScanVulnerability[] }
  | { readonly ok: false; readonly detail: string };

/** Everything the engine needs to invoke and interpret one scanner. */
export interface ScannerBackend {
  readonly id: ScannerId;
  readonly binary: string;
  readonly versionFlag: string;
  readonly installHint: string;
  buildArgs(target: ScanTarget, settings: ResolvedScanSettings): readonly string[];
  parseReport(stdout: string): ScannerParseResult;
}

/** The engine's only side-effecting boundary, injected for testability. */
export interface SecurityScanDependencies {
  readonly probeScanner: (backend: ScannerBackend) => Promise<ToolCheckResult>;
  readonly runScanner: (
    backend: ScannerBackend,
    args: readonly string[],
    settings: ResolvedScanSettings,
  ) => Promise<{ code: number; stdout: string; stderr: string; success: boolean }>;
  readonly now: () => Date;
  readonly elapsedMs: () => number;
}
