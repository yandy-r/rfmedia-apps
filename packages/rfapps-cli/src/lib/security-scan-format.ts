/**
 * Pure `ScanReport -> string[]` renderer. The host action prints these to stderr.
 */

import { SEVERITY_ORDER } from "./security-scan-settings.js";
import type { ImageScan, ScanReport } from "../types/security-scan.js";

function skipDetail(image: ImageScan): string {
  if (image.status !== "skipped") return "";
  return image.reason === "duplicate-image"
    ? `${image.service}: duplicate-image of ${image.scannedBy ?? "?"}`
    : `${image.service}: ${image.reason}`;
}

/** Render a scan report for terminal output (stderr). */
export function formatScanText(report: ScanReport): string[] {
  const { scanner, scope, summary, gate } = report;
  const skipped = report.images.filter((image) => image.status === "skipped");
  const failed = report.images.filter((image) => image.status === "failed");

  const lines: string[] = [
    "Image Vulnerability Scan",
    `Scanner: ${scanner.binary}${
      scanner.available
        ? scanner.version === undefined
          ? ""
          : ` ${scanner.version}`
        : " (unavailable)"
    }`,
    `Scope: ${scope.services.length > 0 ? scope.services.join(", ") : "all services"} (${scope.composePath})`,
    `Targets: ${summary.targetsScanned} scanned, ${summary.targetsSkipped} skipped${
      skipped.length > 0 ? ` (${skipped.map(skipDetail).join("; ")})` : ""
    }, ${summary.targetsFailed} failed`,
    `Findings: ${summary.total} total - ${summary.critical} critical, ${summary.high} high, ` +
      `${summary.medium} medium, ${summary.low} low, ${summary.negligible} negligible, ` +
      `${summary.unknown} unknown (${summary.suppressed} suppressed)`,
    `Gate: --scan-fail-on ${gate.failOn} -> ${gate.status.toUpperCase()}`,
  ];

  for (const severity of SEVERITY_ORDER) {
    const withSeverity = report.images.filter(
      (image) => image.status === "scanned" && image.counts[severity] > 0,
    );
    if (withSeverity.length === 0) continue;
    lines.push("", severity.toUpperCase());
    for (const image of withSeverity) {
      if (image.status !== "scanned") continue;
      lines.push(`  ${image.service}  ${image.image}`);
      for (const vulnerability of image.vulnerabilities) {
        if (vulnerability.severity !== severity) continue;
        lines.push(
          `    - ${vulnerability.id}  ${vulnerability.packageName} ${vulnerability.installedVersion}` +
            (vulnerability.fixedVersion === undefined
              ? " (no fix available)"
              : ` -> fixed in ${vulnerability.fixedVersion}`),
        );
        if (vulnerability.reference !== undefined) lines.push(`      ${vulnerability.reference}`);
      }
    }
  }

  if (failed.length > 0) {
    lines.push("", "FAILED");
    for (const image of failed) {
      if (image.status !== "failed") continue;
      lines.push(`  ${image.service}  ${image.reason}: ${image.detail}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  if (gate.status === "blocked") {
    lines.push("", "Gate blocked by:");
    for (const entry of gate.blockedBy) lines.push(`  - ${entry}`);
    lines.push(
      "Re-run with --scan-fail-on none to report only, or accept a finding via scan.ignore.",
    );
  } else if (gate.status === "inconclusive") {
    lines.push(
      "",
      "A scan that cannot run does not pass. Install a scanner, or pass --scan-fail-on none",
      "to keep scanning advisory.",
    );
  }

  return lines;
}
