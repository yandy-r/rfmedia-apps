import { colors } from "@rfmedia/common";
import type {
  DoctorCategory,
  DoctorFinding,
  DoctorResult,
  DoctorSeverity,
} from "../../types/doctor.js";

const SEVERITIES: readonly DoctorSeverity[] = ["critical", "error", "warn", "info"];
const CATEGORIES: readonly DoctorCategory[] = ["config", "security", "runtime", "updates", "state"];

function severityColor(severity: DoctorSeverity): (value: string) => string {
  switch (severity) {
    case "critical":
      return colors.red;
    case "error":
      return colors.red;
    case "warn":
      return colors.yellow;
    case "info":
      return colors.gray;
    default: {
      const exhaustive: never = severity;
      return exhaustive;
    }
  }
}

function groupFindings(
  findings: DoctorFinding[],
): Map<DoctorSeverity, Map<DoctorCategory, Map<string, DoctorFinding[]>>> {
  const groups = new Map<DoctorSeverity, Map<DoctorCategory, Map<string, DoctorFinding[]>>>();

  for (const finding of findings) {
    const categoryMap =
      groups.get(finding.severity) ?? new Map<DoctorCategory, Map<string, DoctorFinding[]>>();
    const serviceMap = categoryMap.get(finding.category) ?? new Map<string, DoctorFinding[]>();
    const service = finding.service ?? "global";
    const serviceFindings = serviceMap.get(service) ?? [];

    serviceFindings.push(finding);
    serviceMap.set(service, serviceFindings);
    categoryMap.set(finding.category, serviceMap);
    groups.set(finding.severity, categoryMap);
  }

  return groups;
}

export function formatDoctorText(result: DoctorResult): string[] {
  const lines: string[] = [];
  const skipped = result.checks.filter((check) => check.status === "skipped").length;
  const failed = result.checks.filter((check) => check.status === "failed").length;
  const run = result.checks.filter((check) => check.status === "run").length;
  const scope =
    result.scope.services.length > 0 ? result.scope.services.join(", ") : "all services";

  lines.push(colors.bold("Doctor Summary"));
  lines.push(
    `  Scope: ${scope} | Checks: ${run} run, ${skipped} skipped, ${failed} failed | Findings: critical ${result.summary.critical}, error ${result.summary.error}, warn ${result.summary.warn}, info ${result.summary.info}`,
  );

  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(`  ${colors.yellow("warning")} ${warning}`);
    }
  }

  const skippedChecks = result.checks.filter((check) => check.status === "skipped");
  if (skippedChecks.length > 0) {
    lines.push("");
    lines.push(`  ${colors.gray("Skipped checks")}`);
    for (const check of skippedChecks) {
      lines.push(`    ${check.id}: ${check.message ?? "skipped"}`);
    }
  }

  if (result.findings.length === 0) {
    lines.push("");
    lines.push(colors.green("  No findings"));
    return lines;
  }

  const groups = groupFindings(result.findings);
  for (const severity of SEVERITIES) {
    const categoryMap = groups.get(severity);
    if (categoryMap === undefined) {
      continue;
    }

    const color = severityColor(severity);
    for (const category of CATEGORIES) {
      const serviceMap = categoryMap.get(category);
      if (serviceMap === undefined) {
        continue;
      }

      for (const [service, findings] of [...serviceMap.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        lines.push("");
        lines.push(`  ${color(severity.padEnd(8))} ${category.padEnd(8)} ${colors.bold(service)}`);
        for (const finding of findings) {
          lines.push(`    ${finding.message}`);
          for (const evidence of finding.evidence) {
            lines.push(`    ${colors.gray(`evidence: ${evidence}`)}`);
          }
          if (finding.suggestedCommand !== undefined) {
            lines.push(`    ${colors.cyan(`next: ${finding.suggestedCommand}`)}`);
          }
        }
      }
    }
  }

  return lines;
}
