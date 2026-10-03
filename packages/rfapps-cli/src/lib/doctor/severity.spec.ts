import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "../errors.js";
import {
  buildDoctorSummary,
  createSkippedCheck,
  parseDoctorFailOn,
  shouldFailDoctor,
  sortDoctorFindings,
} from "./severity.js";
import type { DoctorFinding, DoctorResult } from "../../types/doctor.js";

function resultWith(findings: DoctorFinding[]): DoctorResult {
  return {
    schemaVersion: "doctor.v1",
    timestamp: "2026-06-10T00:00:00.000Z",
    scope: { services: [], profiles: ["all"], composePath: "compose.yml", checkUpdates: false },
    summary: buildDoctorSummary(findings),
    checks: [],
    findings,
  };
}

describe("doctor severity helpers", () => {
  it("defaults fail threshold to critical and validates values", () => {
    expect(parseDoctorFailOn(undefined)).toBe("critical");
    expect(parseDoctorFailOn(" WARN ")).toBe("warn");
    expect(() => parseDoctorFailOn("bad")).toThrow(InvalidArgumentError);
  });

  it("decides failure by threshold", () => {
    const findings: DoctorFinding[] = [
      {
        id: "runtime.unhealthy",
        severity: "error",
        category: "runtime",
        service: "plex",
        message: "unhealthy",
        evidence: ["health=unhealthy"],
      },
    ];

    expect(shouldFailDoctor(resultWith(findings), "critical")).toBe(false);
    expect(shouldFailDoctor(resultWith(findings), "error")).toBe(true);
    expect(shouldFailDoctor(resultWith(findings), "none")).toBe(false);
  });

  it("sorts findings by severity, category, service, then id", () => {
    const findings: DoctorFinding[] = [
      { id: "b", severity: "warn", category: "runtime", service: "z", message: "", evidence: [] },
      {
        id: "c",
        severity: "critical",
        category: "security",
        service: "a",
        message: "",
        evidence: [],
      },
      { id: "a", severity: "warn", category: "config", service: "a", message: "", evidence: [] },
    ];

    expect(sortDoctorFindings(findings).map((finding) => finding.id)).toEqual(["c", "a", "b"]);
  });

  it("builds summary counts and skipped checks", () => {
    const findings: DoctorFinding[] = [
      { id: "critical", severity: "critical", category: "security", message: "", evidence: [] },
      { id: "warn", severity: "warn", category: "config", message: "", evidence: [] },
      { id: "info", severity: "info", category: "state", message: "", evidence: [] },
    ];

    expect(buildDoctorSummary(findings)).toEqual({
      critical: 1,
      error: 0,
      warn: 1,
      info: 1,
      total: 3,
    });
    expect(createSkippedCheck("updates", "updates", "disabled")).toEqual({
      id: "updates",
      category: "updates",
      status: "skipped",
      message: "disabled",
    });
  });
});
