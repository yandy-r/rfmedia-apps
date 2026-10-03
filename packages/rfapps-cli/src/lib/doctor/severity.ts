import { InvalidArgumentError } from "../errors.js";
import type {
  DoctorCategory,
  DoctorCheckResult,
  DoctorFailOn,
  DoctorFinding,
  DoctorResult,
  DoctorSeverity,
  DoctorSummary,
} from "../../types/doctor.js";

const VALID_FAIL_ON: readonly DoctorFailOn[] = ["none", "info", "warn", "error", "critical"];
const SEVERITY_RANK: Record<DoctorSeverity, number> = {
  critical: 4,
  error: 3,
  warn: 2,
  info: 1,
};

export function parseDoctorFailOn(value: string | undefined): DoctorFailOn {
  if (value === undefined) {
    return "critical";
  }

  const normalized = value.toLowerCase().trim();
  if (VALID_FAIL_ON.includes(normalized as DoctorFailOn)) {
    return normalized as DoctorFailOn;
  }

  throw new InvalidArgumentError("--fail-on", value, "Invalid fail-on severity", [
    ...VALID_FAIL_ON,
  ]);
}

export function compareDoctorSeverity(left: DoctorSeverity, right: DoctorSeverity): number {
  return SEVERITY_RANK[right] - SEVERITY_RANK[left];
}

export function shouldFailDoctor(result: DoctorResult, failOn: DoctorFailOn): boolean {
  if (failOn === "none") {
    return false;
  }

  const threshold = SEVERITY_RANK[failOn];
  return result.findings.some((finding) => SEVERITY_RANK[finding.severity] >= threshold);
}

export function sortDoctorFindings(findings: DoctorFinding[]): DoctorFinding[] {
  return findings.slice().sort((left, right) => {
    const severityCompare = compareDoctorSeverity(left.severity, right.severity);
    if (severityCompare !== 0) {
      return severityCompare;
    }

    const categoryCompare = left.category.localeCompare(right.category);
    if (categoryCompare !== 0) {
      return categoryCompare;
    }

    const serviceCompare = (left.service ?? "").localeCompare(right.service ?? "");
    if (serviceCompare !== 0) {
      return serviceCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

export function buildDoctorSummary(findings: DoctorFinding[]): DoctorSummary {
  const summary: DoctorSummary = {
    critical: 0,
    error: 0,
    warn: 0,
    info: 0,
    total: findings.length,
  };

  for (const finding of findings) {
    summary[finding.severity] += 1;
  }

  return summary;
}

export function createSkippedCheck(
  id: string,
  category: DoctorCategory,
  reason: string,
): DoctorCheckResult {
  return {
    id,
    category,
    status: "skipped",
    message: reason,
  };
}
