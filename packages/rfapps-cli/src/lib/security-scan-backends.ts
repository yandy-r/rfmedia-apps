/**
 * Scanner backend registry and untrusted-report normalization.
 *
 * Every field is narrowed from `unknown` with `typeof` guards; neither parser
 * ever throws and neither is handed the scanner's own gate flag
 * (`trivy --exit-code` / `grype --fail-on`) — rfapps owns the threshold, so a
 * non-zero exit unambiguously means *error*, never *findings*.
 */

import { filterToolOutput } from "./docker.js";
import { InvalidArgumentError } from "./errors.js";
import type {
  ScannerBackend,
  ScannerId,
  ScannerParseResult,
  ScanSeverity,
  ScanVulnerability,
} from "../types/security-scan.js";

/** Every scanner backend id the CLI accepts. */
export const SCANNER_IDS: readonly ScannerId[] = ["trivy", "grype"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const TRIVY_SEVERITIES: Readonly<Record<string, ScanSeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "unknown",
};

const GRYPE_SEVERITIES: Readonly<Record<string, ScanSeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NEGLIGIBLE: "negligible",
  UNKNOWN: "unknown",
};

function mapSeverity(map: Readonly<Record<string, ScanSeverity>>, raw: string): ScanSeverity {
  return map[raw.trim().toUpperCase()] ?? "unknown";
}

function buildVulnerability(fields: {
  id: string;
  severity: ScanSeverity;
  rawSeverity: string;
  packageName: string;
  installedVersion: string;
  fixedVersion?: string;
  reference?: string;
}): ScanVulnerability {
  return {
    id: fields.id,
    severity: fields.severity,
    rawSeverity: fields.rawSeverity,
    packageName: fields.packageName,
    installedVersion: fields.installedVersion,
    ...(fields.fixedVersion === undefined ? {} : { fixedVersion: fields.fixedVersion }),
    ...(fields.reference === undefined ? {} : { reference: fields.reference }),
  };
}

function parseScannerJson(
  stdout: string,
  scanner: ScannerId,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  const cleaned = filterToolOutput(stdout.split("\n")).join("\n").trim();
  if (cleaned === "") {
    return { ok: false, detail: `${scanner} produced no report output` };
  }
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${scanner} report was not valid JSON: ${reason}` };
  }
}

function parseTrivyReport(stdout: string): ScannerParseResult {
  const parsed = parseScannerJson(stdout, "trivy");
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  if (!isRecord(parsed.value)) {
    return { ok: false, detail: "unexpected trivy report shape: top level is not an object" };
  }
  const results = parsed.value["Results"];
  if (results === undefined || results === null) return { ok: true, vulnerabilities: [] };
  if (!Array.isArray(results)) {
    return { ok: false, detail: "unexpected trivy report shape: Results is not an array" };
  }

  const vulnerabilities: ScanVulnerability[] = [];
  for (const result of results) {
    if (!isRecord(result)) continue;
    const entries = result["Vulnerabilities"];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = readString(entry, "VulnerabilityID");
      const packageName = readString(entry, "PkgName");
      const installedVersion = readString(entry, "InstalledVersion");
      if (id === undefined || packageName === undefined || installedVersion === undefined) continue;
      const rawSeverity = readString(entry, "Severity") ?? "";
      vulnerabilities.push(
        buildVulnerability({
          id,
          severity: mapSeverity(TRIVY_SEVERITIES, rawSeverity),
          rawSeverity,
          packageName,
          installedVersion,
          fixedVersion: readString(entry, "FixedVersion"),
          reference: readString(entry, "PrimaryURL"),
        }),
      );
    }
  }
  return { ok: true, vulnerabilities };
}

function parseGrypeReport(stdout: string): ScannerParseResult {
  const parsed = parseScannerJson(stdout, "grype");
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  if (!isRecord(parsed.value)) {
    return { ok: false, detail: "unexpected grype report shape: top level is not an object" };
  }
  const matches = parsed.value["matches"];
  if (matches === undefined || matches === null) return { ok: true, vulnerabilities: [] };
  if (!Array.isArray(matches)) {
    return { ok: false, detail: "unexpected grype report shape: matches is not an array" };
  }

  const vulnerabilities: ScanVulnerability[] = [];
  for (const match of matches) {
    if (!isRecord(match)) continue;
    const vulnerability = match["vulnerability"];
    const artifact = match["artifact"];
    if (!isRecord(vulnerability) || !isRecord(artifact)) continue;
    const id = readString(vulnerability, "id");
    const packageName = readString(artifact, "name");
    const installedVersion = readString(artifact, "version");
    if (id === undefined || packageName === undefined || installedVersion === undefined) continue;
    const rawSeverity = readString(vulnerability, "severity") ?? "";
    const fix = vulnerability["fix"];
    let fixedVersion: string | undefined;
    if (isRecord(fix) && Array.isArray(fix["versions"])) {
      const first: unknown = fix["versions"][0];
      fixedVersion = typeof first === "string" && first.trim() !== "" ? first : undefined;
    }
    vulnerabilities.push(
      buildVulnerability({
        id,
        severity: mapSeverity(GRYPE_SEVERITIES, rawSeverity),
        rawSeverity,
        packageName,
        installedVersion,
        fixedVersion,
        reference: readString(vulnerability, "dataSource"),
      }),
    );
  }
  return { ok: true, vulnerabilities };
}

const trivyBackend: ScannerBackend = {
  id: "trivy",
  binary: "trivy",
  versionFlag: "--version",
  installHint:
    "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
  buildArgs: (target, settings) => [
    "image",
    "--quiet",
    "--no-progress",
    "--scanners",
    "vuln",
    "--format",
    "json",
    "--timeout",
    `${Math.max(1, Math.ceil(settings.timeoutMs / 1000))}s`,
    target.image,
  ],
  parseReport: parseTrivyReport,
};

const grypeBackend: ScannerBackend = {
  id: "grype",
  binary: "grype",
  versionFlag: "version",
  installHint:
    "grype not found in PATH. Install from https://github.com/anchore/grype#installation",
  buildArgs: (target) => [target.image, "-o", "json", "-q"],
  parseReport: parseGrypeReport,
};

/** Every supported backend, keyed by id. */
export const SCANNER_BACKENDS = {
  trivy: trivyBackend,
  grype: grypeBackend,
} as const satisfies Record<ScannerId, ScannerBackend>;

/**
 * Resolve a user-supplied scanner name to its backend.
 *
 * @throws {InvalidArgumentError} on an unknown id.
 */
export function resolveScannerBackend(id: string): ScannerBackend {
  const normalized = id.toLowerCase().trim();
  const backend = SCANNER_IDS.includes(normalized as ScannerId)
    ? SCANNER_BACKENDS[normalized as ScannerId]
    : undefined;
  if (backend === undefined) {
    throw new InvalidArgumentError("--scanner", id, "Unknown scanner backend", [...SCANNER_IDS]);
  }
  return backend;
}
