import type { HardenResult } from "../types/hardening.js";
import type { LintResult, LintSeverity } from "../types/lint.js";
import type { ReconcileMode, ReconcileStatus } from "../types/reconcile.js";
import type { DeployResult } from "../types/results.js";
import type { ScanReport } from "../types/security-scan.js";
import type { StateRebuildResult, StateExportResult } from "../types/state-rebuild.js";

export const ExitCode = {
  Success: 0,
  OperationalError: 1,
  UsageError: 2,
  PartialSuccess: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

const RECONCILE_EXIT_CODE_BY_MODE = {
  report: {
    reported: ExitCode.Success,
    planned: ExitCode.UsageError,
    converged: ExitCode.UsageError,
    partial: ExitCode.UsageError,
    failed: ExitCode.OperationalError,
    cancelled: ExitCode.UsageError,
  },
  "auto-apply": {
    reported: ExitCode.UsageError,
    planned: ExitCode.Success,
    converged: ExitCode.Success,
    partial: ExitCode.PartialSuccess,
    failed: ExitCode.OperationalError,
    cancelled: ExitCode.UsageError,
  },
} as const satisfies Record<ReconcileMode, Record<ReconcileStatus, ExitCodeValue>>;

export function setExitCode(code: ExitCodeValue): void {
  process.exitCode = code;
}

/** Derive the process exit category from a terminal reconciliation mode and status. */
export function resolveReconcileExitCode(result: {
  mode: ReconcileMode;
  status: ReconcileStatus;
}): ExitCodeValue {
  return RECONCILE_EXIT_CODE_BY_MODE[result.mode][result.status];
}

export function resolveDeployExitCode(result: DeployResult, allowPartial: boolean): ExitCodeValue {
  const hasFailure = result.failed.length > 0 || result.unhealthy.length > 0;

  if (!hasFailure) {
    return ExitCode.Success;
  }

  if (allowPartial && hasDeploySuccess(result)) {
    return ExitCode.PartialSuccess;
  }

  return ExitCode.OperationalError;
}

export function setDeployExitCode(result: DeployResult, allowPartial: boolean): void {
  setExitCode(resolveDeployExitCode(result, allowPartial));
}

const LINT_SEVERITY_RANK: Record<LintSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
};

export function resolveLintExitCode(
  result: LintResult,
  failOn: LintSeverity | "none",
): ExitCodeValue {
  if (failOn === "none" || !hasLintFindingAtOrAbove(result, failOn)) {
    return ExitCode.Success;
  }

  return ExitCode.OperationalError;
}

export function setLintExitCode(result: LintResult, failOn: LintSeverity | "none"): void {
  setExitCode(resolveLintExitCode(result, failOn));
}

/** Derive the process exit category for a completed state-rebuild result. */
export function resolveStateRebuildExitCode(
  result: Omit<StateRebuildResult, "exitCode" | "success">,
): ExitCodeValue {
  if (result.refusal !== undefined) {
    return ExitCode.UsageError;
  }
  if (result.phase === "report") {
    return ExitCode.Success;
  }
  if (
    result.summary.uninspectable > 0 ||
    result.summary.discardedDeployments > 0 ||
    result.summary.discardedGenerations > 0
  ) {
    return ExitCode.PartialSuccess;
  }
  return ExitCode.Success;
}

/** Derive the process exit category for a completed state-export result. */
export function resolveStateExportExitCode(
  result: Omit<StateExportResult, "exitCode" | "success">,
): ExitCodeValue {
  if (result.dryRun || result.backup !== undefined) {
    return ExitCode.Success;
  }
  return ExitCode.OperationalError;
}

/**
 * Derive the process exit category from an image vulnerability scan report.
 *
 * `gate.blocking` is the single authoritative blocking decision, computed once
 * by `evaluateScanGate`; plan's gate, deploy's gate, and the dry-run
 * `would block` line all read it and none re-derives it. A blocked or
 * inconclusive gate is an operational refusal, never a usage error.
 */
export function resolveScanExitCode(report: Pick<ScanReport, "gate">): ExitCodeValue {
  return report.gate.blocking ? ExitCode.OperationalError : ExitCode.Success;
}

/** Apply {@link resolveScanExitCode} to `process.exitCode`. */
export function setScanExitCode(report: Pick<ScanReport, "gate">): void {
  setExitCode(resolveScanExitCode(report));
}

/**
 * Derive the process exit category for a completed `rfapps harden` run.
 *
 * Harden is never a findings gate and has no `--fail-on`: proposals and
 * refusals alone exit 0, because refusing an unsafe edit is correct behaviour.
 * Only a partially-completed write — `--apply` wrote some patches and refused
 * others — reports `PartialSuccess`.
 */
export function resolveHardenExitCode(
  result: Pick<HardenResult, "write" | "refusals">,
): ExitCodeValue {
  if (
    result.write.mode === "apply" &&
    result.write.patchesWritten > 0 &&
    result.refusals.length > 0
  ) {
    return ExitCode.PartialSuccess;
  }
  return ExitCode.Success;
}

/** Apply {@link resolveHardenExitCode} to `process.exitCode`. */
export function setHardenExitCode(result: Pick<HardenResult, "write" | "refusals">): void {
  setExitCode(resolveHardenExitCode(result));
}

function hasLintFindingAtOrAbove(result: LintResult, failOn: LintSeverity): boolean {
  const threshold = LINT_SEVERITY_RANK[failOn];

  return result.findings.some((finding) => LINT_SEVERITY_RANK[finding.severity] >= threshold);
}

function hasDeploySuccess(result: DeployResult): boolean {
  return result.healthy.length > 0;
}
