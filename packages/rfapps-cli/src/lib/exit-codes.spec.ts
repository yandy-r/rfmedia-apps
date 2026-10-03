import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ExitCode,
  resolveDeployExitCode,
  resolveLintExitCode,
  resolveReconcileExitCode,
  setExitCode,
} from "./exit-codes.js";
import type { LintFailOn, LintFinding, LintResult, LintSeverity } from "../types/lint.js";
import type { ReconcileMode, ReconcileStatus } from "../types/reconcile.js";
import type { DeployResult } from "../types/results.js";

function deployResult(overrides: Partial<DeployResult> = {}): DeployResult {
  return {
    services: [],
    failed: [],
    healthy: [],
    unhealthy: [],
    started: 0,
    ...overrides,
  };
}

function lintFinding(severity: LintSeverity): LintFinding {
  return {
    ruleId: "privileged-enabled",
    service: "plex",
    severity,
    message: "test finding",
    remediation: "fix it",
    group: severity === "info" ? "review_first" : "recommended",
  };
}

function lintResult(overrides: Partial<LintResult> = {}): LintResult {
  const findings = overrides.findings ?? [];

  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    findings,
    summary: {
      error: findings.filter((finding) => finding.severity === "error").length,
      warn: findings.filter((finding) => finding.severity === "warn").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      total: findings.length,
    },
    mode: "static",
    ...overrides,
  };
}

describe("exit code helpers", () => {
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  describe("ExitCode", () => {
    it("defines the expected numeric constants", () => {
      expect(ExitCode.Success).toBe(0);
      expect(ExitCode.OperationalError).toBe(1);
      expect(ExitCode.UsageError).toBe(2);
      expect(ExitCode.PartialSuccess).toBe(3);
    });
  });

  describe("setExitCode", () => {
    it("sets process.exitCode", () => {
      setExitCode(ExitCode.UsageError);

      expect(process.exitCode).toBe(ExitCode.UsageError);
    });
  });

  describe("resolveDeployExitCode", () => {
    it("returns Success when every service succeeds", () => {
      const result = deployResult({
        services: ["plex", "sonarr"],
        healthy: ["plex", "sonarr"],
        started: 2,
      });

      expect(resolveDeployExitCode(result, false)).toBe(ExitCode.Success);
      expect(resolveDeployExitCode(result, true)).toBe(ExitCode.Success);
    });

    it("returns OperationalError when every service fails", () => {
      const result = deployResult({
        services: ["plex", "sonarr"],
        failed: [
          { name: "plex", error: "failed to start" },
          { name: "sonarr", error: "failed to start" },
        ],
      });

      expect(resolveDeployExitCode(result, false)).toBe(ExitCode.OperationalError);
      expect(resolveDeployExitCode(result, true)).toBe(ExitCode.OperationalError);
    });

    it("returns OperationalError for mixed results when partial success is not allowed", () => {
      const result = deployResult({
        services: ["plex"],
        failed: [{ name: "sonarr", error: "failed to start" }],
        healthy: ["plex"],
        started: 1,
      });

      expect(resolveDeployExitCode(result, false)).toBe(ExitCode.OperationalError);
    });

    it("returns PartialSuccess for mixed results when partial success is allowed", () => {
      const result = deployResult({
        services: ["plex"],
        failed: [{ name: "sonarr", error: "failed to start" }],
        healthy: ["plex"],
        started: 1,
      });

      expect(resolveDeployExitCode(result, true)).toBe(ExitCode.PartialSuccess);
    });

    it("treats unhealthy services as failures for mixed deploy results", () => {
      const result = deployResult({
        services: ["plex", "sonarr"],
        healthy: ["plex"],
        unhealthy: ["sonarr"],
        started: 2,
      });

      expect(resolveDeployExitCode(result, false)).toBe(ExitCode.OperationalError);
      expect(resolveDeployExitCode(result, true)).toBe(ExitCode.PartialSuccess);
    });

    it("returns OperationalError when services started but none are healthy", () => {
      const result = deployResult({
        services: ["plex", "sonarr"],
        unhealthy: ["plex", "sonarr"],
        started: 2,
      });

      expect(resolveDeployExitCode(result, false)).toBe(ExitCode.OperationalError);
      expect(resolveDeployExitCode(result, true)).toBe(ExitCode.OperationalError);
    });
  });

  describe("resolveLintExitCode", () => {
    it("returns Success for empty findings at every threshold", () => {
      for (const failOn of ["none", "info", "warn", "error"] satisfies LintFailOn[]) {
        expect(resolveLintExitCode(lintResult(), failOn)).toBe(ExitCode.Success);
      }
    });

    it("returns Success for every finding severity when failure is disabled", () => {
      for (const severity of ["info", "warn", "error"] satisfies LintSeverity[]) {
        const result = lintResult({ findings: [lintFinding(severity)] });

        expect(resolveLintExitCode(result, "none")).toBe(ExitCode.Success);
      }
    });

    it("returns Success when failOn is error with only warn findings", () => {
      const result = lintResult({ findings: [lintFinding("warn")] });

      expect(resolveLintExitCode(result, "error")).toBe(ExitCode.Success);
    });

    it("returns OperationalError when failOn is error with an error finding", () => {
      const result = lintResult({ findings: [lintFinding("error")] });

      expect(resolveLintExitCode(result, "error")).toBe(ExitCode.OperationalError);
    });

    it("returns OperationalError when failOn is warn with a warn finding", () => {
      const result = lintResult({ findings: [lintFinding("warn")] });

      expect(resolveLintExitCode(result, "warn")).toBe(ExitCode.OperationalError);
    });

    it("returns OperationalError for every finding severity at the info threshold", () => {
      for (const severity of ["info", "warn", "error"] satisfies LintSeverity[]) {
        const result = lintResult({ findings: [lintFinding(severity)] });

        expect(resolveLintExitCode(result, "info")).toBe(ExitCode.OperationalError);
      }
    });
  });

  describe("resolveReconcileExitCode", () => {
    it("maps the complete mode and status matrix", () => {
      const cases: Array<{
        mode: ReconcileMode;
        status: ReconcileStatus;
        expected: (typeof ExitCode)[keyof typeof ExitCode];
      }> = [
        { mode: "report", status: "reported", expected: ExitCode.Success },
        { mode: "report", status: "planned", expected: ExitCode.UsageError },
        { mode: "report", status: "converged", expected: ExitCode.UsageError },
        { mode: "report", status: "partial", expected: ExitCode.UsageError },
        { mode: "report", status: "failed", expected: ExitCode.OperationalError },
        { mode: "report", status: "cancelled", expected: ExitCode.UsageError },
        { mode: "auto-apply", status: "reported", expected: ExitCode.UsageError },
        { mode: "auto-apply", status: "planned", expected: ExitCode.Success },
        { mode: "auto-apply", status: "converged", expected: ExitCode.Success },
        { mode: "auto-apply", status: "partial", expected: ExitCode.PartialSuccess },
        { mode: "auto-apply", status: "failed", expected: ExitCode.OperationalError },
        { mode: "auto-apply", status: "cancelled", expected: ExitCode.UsageError },
      ];
      for (const { mode, status, expected } of cases) {
        expect(resolveReconcileExitCode({ mode, status }), `${mode}/${status}`).toBe(expected);
      }
    });
  });
});
