/**
 * Scan severity ordering and CLI → config → default settings resolution.
 */

import { InvalidArgumentError } from "./errors.js";
import { resolveScannerBackend, SCANNER_IDS } from "./security-scan-backends.js";
import type {
  ResolvedScanSettings,
  ScanConfig,
  ScanFailOn,
  ScanSeverity,
  ScannerId,
  ScanSuppression,
} from "../types/security-scan.js";

/** Ascending severity rank. The gate blocks at or above the threshold's rank. */
export const SCAN_SEVERITY_RANK: Readonly<Record<ScanSeverity, number>> = {
  unknown: 0,
  negligible: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/** Highest severity first. Drives counting and the renderer's section order. */
export const SEVERITY_ORDER: readonly ScanSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "negligible",
  "unknown",
];

const VALID_FAIL_ON: readonly ScanFailOn[] = [
  "none",
  "unknown",
  "negligible",
  "low",
  "medium",
  "high",
  "critical",
];

const DEFAULT_SCANNER: ScannerId = "trivy";
const DEFAULT_FAIL_ON: ScanFailOn = "none";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TARGETS = 64;
const DEFAULT_CONCURRENCY = 2;

/**
 * Parse the `--scan-fail-on` flag.
 *
 * Returns undefined when the flag was absent, so config can win.
 *
 * @throws {InvalidArgumentError} on an unrecognized threshold.
 */
export function parseScanFailOn(value: string | undefined): ScanFailOn | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase().trim();
  if (VALID_FAIL_ON.includes(normalized as ScanFailOn)) return normalized as ScanFailOn;
  throw new InvalidArgumentError("--scan-fail-on", value, "Invalid scan severity threshold", [
    ...VALID_FAIL_ON,
  ]);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  key: string,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArgumentError(
      key,
      String(value),
      `expected an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

/**
 * Trim and validate configured suppressions.
 *
 * @throws {InvalidArgumentError} on a blank id or reason, or an unparsable `until`.
 */
export function normalizeScanSuppressions(
  entries: readonly ScanSuppression[],
): readonly ScanSuppression[] {
  return entries.map((entry, index) => {
    const id = entry.id.trim();
    if (id === "") {
      throw new InvalidArgumentError(`scan.ignore[${index}].id`, entry.id, "id must not be blank");
    }
    const reason = entry.reason?.trim() ?? "";
    if (reason === "") {
      throw new InvalidArgumentError(
        `scan.ignore[${index}].reason`,
        String(entry.reason ?? ""),
        "a suppression must document why the finding is accepted",
      );
    }
    if (entry.until !== undefined && Number.isNaN(Date.parse(entry.until))) {
      throw new InvalidArgumentError(
        `scan.ignore[${index}].until`,
        entry.until,
        "expected an ISO-8601 date",
      );
    }
    const service = entry.service?.trim();
    return {
      id,
      reason,
      ...(service === undefined || service === "" ? {} : { service }),
      ...(entry.until === undefined ? {} : { until: entry.until }),
    };
  });
}

/**
 * Merge scan settings as CLI → config → hard default.
 *
 * @throws {InvalidArgumentError} on any invalid flag or configured value.
 */
export function resolveScanSettings(
  raw: { readonly scanFailOn?: string; readonly scanner?: string },
  configured: ScanConfig | undefined,
  cwd: string,
): ResolvedScanSettings {
  let scanner: ScannerId = DEFAULT_SCANNER;
  if (raw.scanner !== undefined) {
    scanner = resolveScannerBackend(raw.scanner).id;
  } else if (configured?.scanner !== undefined) {
    // rfapps.config.yaml is not schema-validated, so the declared ScannerId can
    // be any string at runtime; refuse it rather than crash in the runner.
    if (!SCANNER_IDS.includes(configured.scanner)) {
      throw new InvalidArgumentError(
        "scan.scanner",
        String(configured.scanner),
        "Unknown scanner backend",
        [...SCANNER_IDS],
      );
    }
    scanner = configured.scanner;
  }
  let failOn = parseScanFailOn(raw.scanFailOn);
  if (failOn === undefined && configured?.failOn !== undefined) {
    // Same reason as scan.scanner above. An unrecognized threshold makes
    // SCAN_SEVERITY_RANK[failOn] undefined in evaluateScanGate, so every
    // comparison is false and the gate passes on any finding.
    if (!VALID_FAIL_ON.includes(configured.failOn)) {
      throw new InvalidArgumentError(
        "scan.failOn",
        String(configured.failOn),
        "Invalid scan severity threshold",
        [...VALID_FAIL_ON],
      );
    }
    failOn = configured.failOn;
  }
  return {
    scanner,
    failOn: failOn ?? DEFAULT_FAIL_ON,
    ignore: normalizeScanSuppressions(configured?.ignore ?? []),
    timeoutMs: positiveInteger(
      configured?.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "scan.timeoutMs",
      3_600_000,
    ),
    maxTargets: positiveInteger(
      configured?.maxTargets,
      DEFAULT_MAX_TARGETS,
      "scan.maxTargets",
      1000,
    ),
    concurrency: positiveInteger(
      configured?.concurrency,
      DEFAULT_CONCURRENCY,
      "scan.concurrency",
      16,
    ),
    cwd,
  };
}
