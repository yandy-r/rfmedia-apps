/**
 * Image vulnerability scan engine.
 *
 * Pure core plus a single injected exec boundary (`SecurityScanDependencies`).
 * `runSecurityScan` never throws and never touches `process.exitCode`: every
 * failure becomes an `ImageScan` arm so the gate can reason about it.
 */

import { checkExternalTool } from "@rfmedia/common";

import { execWithEnv } from "./env-tools.js";
import { SCANNER_BACKENDS } from "./security-scan-backends.js";
import { SCAN_SEVERITY_RANK, SEVERITY_ORDER } from "./security-scan-settings.js";
import { SCAN_SCHEMA_VERSION } from "../types/security-scan.js";
import type {
  ImageScan,
  ResolvedScanSettings,
  ScanComposeConfig,
  ScanFailOn,
  ScanFailureCode,
  ScanGate,
  ScannerBackend,
  ScannerIdentity,
  ScanReport,
  ScanScope,
  ScanSeverityCounts,
  ScanSummary,
  ScanSuppression,
  ScanTarget,
  ScanVulnerability,
  SecurityScanDependencies,
} from "../types/security-scan.js";

export { resolveScannerBackend, SCANNER_BACKENDS, SCANNER_IDS } from "./security-scan-backends.js";
export {
  normalizeScanSuppressions,
  parseScanFailOn,
  resolveScanSettings,
  SCAN_SEVERITY_RANK,
} from "./security-scan-settings.js";
export { formatScanText } from "./security-scan-format.js";

/** Scanner reports are unbounded external input; cap capture and retention. */
const MAX_SCAN_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_STDERR_BYTES = 256 * 1024;
const MAX_RETAINED_PER_TARGET = 200;
const MAX_DETAIL_CHARS = 400;

// Matched exactly. These are the literals execWithEnv produces at
// lib/env-tools.ts:365-370 and nothing else distinguishes truncation or a
// timeout from a scanner crash. Known limitation: execWithEnv SIGTERMs only the
// direct child and never escalates to SIGKILL; scanners are single-process and
// short-lived, so that is acceptable here.
const TIMEOUT_SENTINEL = "Command timed out";
const OUTPUT_LIMIT_SENTINEL = "Command output exceeded capture limit";

function truncateDetail(detail: string): string {
  const collapsed = detail.trim();
  return collapsed.length > MAX_DETAIL_CHARS ? collapsed.slice(0, MAX_DETAIL_CHARS) : collapsed;
}

function lastNonBlankLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "" : (lines[lines.length - 1] ?? "");
}

const DEFAULT_DEPENDENCIES: SecurityScanDependencies = {
  probeScanner: (backend) =>
    checkExternalTool(backend.binary, backend.versionFlag, backend.installHint),
  runScanner: (backend, args, settings) =>
    execWithEnv(backend.binary, [...args], {
      // A vulnerability scanner is never handed decrypted application secrets,
      // and `none` removes the dotenvx/op banner JSON-corruption hazard.
      tool: "none",
      cwd: settings.cwd,
      timeout: settings.timeoutMs,
      maxStdoutBytes: MAX_SCAN_STDOUT_BYTES,
      maxStderrBytes: MAX_SCAN_STDERR_BYTES,
    }),
  now: () => new Date(),
  elapsedMs: () => performance.now(),
};

/** Resolved compose config -> targets, with build-only / no-image / cap / dedupe classification. */
export function resolveScanTargets(
  config: ScanComposeConfig,
  services: readonly string[],
  maxTargets: number,
): { readonly targets: readonly ScanTarget[]; readonly skipped: readonly ImageScan[] } {
  const names = (services.length > 0 ? [...services] : Object.keys(config.services)).sort();
  const targets: ScanTarget[] = [];
  const skipped: ImageScan[] = [];
  const claimedBy = new Map<string, string>();

  for (const name of names) {
    const service = config.services[name];
    if (service === undefined) continue;
    // 1. `build:` — compose.yml gives lidarr one; an unbuilt local image makes
    //    the scanner error, which the gate would turn into `inconclusive`.
    if (service.build !== undefined) {
      skipped.push({ status: "skipped", service: name, image: "", reason: "build-only" });
      continue;
    }
    const image = service.image?.trim() ?? "";
    if (image === "") {
      skipped.push({ status: "skipped", service: name, image: "", reason: "no-image" });
      continue;
    }
    const owner = claimedBy.get(image);
    if (owner !== undefined) {
      skipped.push({
        status: "skipped",
        service: name,
        image,
        reason: "duplicate-image",
        scannedBy: owner,
      });
      continue;
    }
    if (targets.length >= maxTargets) {
      skipped.push({ status: "skipped", service: name, image, reason: "target-cap" });
      continue;
    }
    claimedBy.set(image, name);
    targets.push({ service: name, image });
  }

  return { targets, skipped };
}

/** Aggregate per-target outcomes into report-wide totals. */
export function buildScanSummary(images: readonly ImageScan[]): ScanSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  let suppressed = 0;
  let targetsScanned = 0;
  let targetsSkipped = 0;
  let targetsFailed = 0;

  for (const image of images) {
    if (image.status === "scanned") {
      targetsScanned += 1;
      suppressed += image.suppressed;
      for (const severity of SEVERITY_ORDER) counts[severity] += image.counts[severity];
    } else if (image.status === "skipped") {
      targetsSkipped += 1;
    } else {
      targetsFailed += 1;
    }
  }

  return {
    ...counts,
    total: SEVERITY_ORDER.reduce((sum, severity) => sum + counts[severity], 0),
    suppressed,
    targetsScanned,
    targetsSkipped,
    targetsFailed,
  };
}

/** The single authoritative blocking decision. No caller re-derives it. */
export function evaluateScanGate(images: readonly ImageScan[], failOn: ScanFailOn): ScanGate {
  if (failOn === "none") {
    return { failOn, status: "passed", blocking: false, blockedBy: [] };
  }
  const threshold = SCAN_SEVERITY_RANK[failOn];
  const blockedBy: string[] = [];
  let breached = false;
  let degraded = false;

  for (const scan of images) {
    if (scan.status === "failed") {
      degraded = true;
      blockedBy.push(`${scan.service}: scan did not complete (${scan.reason})`);
      continue;
    }
    if (scan.status !== "scanned") continue;
    for (const vuln of scan.vulnerabilities) {
      if (SCAN_SEVERITY_RANK[vuln.severity] >= threshold) {
        breached = true;
        blockedBy.push(
          `${scan.service}: ${vuln.id} (${vuln.severity}) in ${vuln.packageName}@${vuln.installedVersion}`,
        );
      }
    }
  }

  if (breached) return { failOn, status: "blocked", blocking: true, blockedBy };
  if (degraded) return { failOn, status: "inconclusive", blocking: true, blockedBy };
  return { failOn, status: "passed", blocking: false, blockedBy: [] };
}

function isExpired(entry: ScanSuppression, now: Date): boolean {
  if (entry.until === undefined) return false;
  const until = Date.parse(entry.until);
  return !Number.isNaN(until) && until < now.getTime();
}

function suppresses(entry: ScanSuppression, service: string, id: string): boolean {
  if (entry.service !== undefined && entry.service !== service) return false;
  return entry.id === "*" || entry.id === id;
}

/** Total order: severity desc, then packageName asc, then id asc. */
function compareVulnerabilities(left: ScanVulnerability, right: ScanVulnerability): number {
  const bySeverity = SCAN_SEVERITY_RANK[right.severity] - SCAN_SEVERITY_RANK[left.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.packageName !== right.packageName) return left.packageName < right.packageName ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function countBySeverity(vulnerabilities: readonly ScanVulnerability[]): ScanSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const vulnerability of vulnerabilities) counts[vulnerability.severity] += 1;
  return counts;
}

/** Private bounded worker pool. `forEachBounded` in plan-generator.ts is deliberately not extracted. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function failedScan(target: ScanTarget, reason: ScanFailureCode, detail: string): ImageScan {
  return {
    status: "failed",
    service: target.service,
    image: target.image,
    reason,
    detail: truncateDetail(detail),
  };
}

async function scanOneTarget(
  target: ScanTarget,
  backend: ScannerBackend,
  settings: ResolvedScanSettings,
  active: readonly ScanSuppression[],
  dependencies: SecurityScanDependencies,
): Promise<ImageScan> {
  const startedAt = dependencies.elapsedMs();
  const result = await dependencies.runScanner(
    backend,
    backend.buildArgs(target, settings),
    settings,
  );
  const durationMs = Math.max(0, Math.round(dependencies.elapsedMs() - startedAt));

  // Classification order is load-bearing; the two sentinels are matched exactly.
  if (result.stderr === TIMEOUT_SENTINEL) {
    return failedScan(target, "timeout", `scanner exceeded ${settings.timeoutMs}ms for this image`);
  }
  if (result.stderr === OUTPUT_LIMIT_SENTINEL) {
    return failedScan(target, "output-limit", OUTPUT_LIMIT_SENTINEL);
  }
  if (!result.success) {
    const detail = lastNonBlankLine(result.stderr);
    return failedScan(
      target,
      "scanner-error",
      detail === "" ? `${backend.binary} exited with code ${result.code}` : detail,
    );
  }

  const parsed = backend.parseReport(result.stdout);
  if (!parsed.ok) return failedScan(target, "invalid-report", parsed.detail);

  let suppressed = 0;
  const surviving: ScanVulnerability[] = [];
  for (const vulnerability of parsed.vulnerabilities) {
    if (active.some((entry) => suppresses(entry, target.service, vulnerability.id))) {
      suppressed += 1;
      continue;
    }
    surviving.push(vulnerability);
  }
  surviving.sort(compareVulnerabilities);

  return {
    status: "scanned",
    service: target.service,
    image: target.image,
    // counts covers EVERY surviving finding; only the retained list is capped,
    // so a truncated target can never hide an above-threshold entry.
    counts: countBySeverity(surviving),
    vulnerabilities: surviving.slice(0, MAX_RETAINED_PER_TARGET),
    suppressed,
    truncated: surviving.length > MAX_RETAINED_PER_TARGET,
    durationMs,
  };
}

function compareByService(left: ImageScan, right: ImageScan): number {
  if (left.service === right.service) return 0;
  return left.service < right.service ? -1 : 1;
}

/** Never throws. Every failure becomes an ImageScan arm. */
export async function runSecurityScan(
  targets: readonly ScanTarget[],
  preskipped: readonly ImageScan[],
  scope: ScanScope,
  settings: ResolvedScanSettings,
  dependencies: SecurityScanDependencies = DEFAULT_DEPENDENCIES,
): Promise<ScanReport> {
  const backend = SCANNER_BACKENDS[settings.scanner];
  const notes: string[] = [];
  const images: ImageScan[] = [...preskipped];

  const now = dependencies.now();
  // Expiry is evaluated once, before fan-out, so `notes` is deterministic.
  const active: ScanSuppression[] = [];
  for (const entry of settings.ignore) {
    if (isExpired(entry, now)) {
      notes.push(
        `suppression for ${entry.id}${entry.service === undefined ? "" : ` (${entry.service})`}` +
          ` expired on ${entry.until ?? "?"} and is no longer applied`,
      );
      continue;
    }
    active.push(entry);
  }

  let scanner: ScannerIdentity = { id: backend.id, binary: backend.binary, available: false };

  if (targets.length > 0) {
    // One probe, not N. An explicitly selected-and-absent scanner never falls
    // back to the other backend: silent substitution changes the finding set.
    const probe = await dependencies.probeScanner(backend);
    scanner = {
      id: backend.id,
      binary: backend.binary,
      available: probe.available,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    };

    if (!probe.available) {
      const detail = probe.error ?? backend.installHint;
      for (const target of targets) images.push(failedScan(target, "scanner-unavailable", detail));
    } else {
      const scanned = await mapBounded(targets, settings.concurrency, (target) =>
        scanOneTarget(target, backend, settings, active, dependencies),
      );
      images.push(...scanned);
    }
  } else {
    notes.push(
      `no scannable targets, so ${backend.binary} was not probed; "available: false" means "not checked" here`,
    );
  }

  images.sort(compareByService);

  for (const image of images) {
    if (image.status === "scanned" && image.truncated) {
      const total = SEVERITY_ORDER.reduce((sum, severity) => sum + image.counts[severity], 0);
      notes.push(
        `${image.service}: ${MAX_RETAINED_PER_TARGET} of ${total} findings shown; counts above are complete`,
      );
    }
  }

  const capped = images.filter(
    (image) => image.status === "skipped" && image.reason === "target-cap",
  ).length;
  if (capped > 0) {
    notes.push(
      `scan target cap of ${settings.maxTargets} distinct images reached; ${capped} service(s) were not scanned`,
    );
  }

  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    timestamp: now.toISOString(),
    scanner,
    scope,
    gate: evaluateScanGate(images, settings.failOn),
    summary: buildScanSummary(images),
    images,
    notes,
  };
}
