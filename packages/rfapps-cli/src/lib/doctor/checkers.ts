import Database from "better-sqlite3";
import { existsSync } from "node:fs";

import { getStateDbPath } from "../config.js";
import { closeDatabase } from "../db.js";
import { getComposeConfig } from "../docker.js";
import { waitForDependencyReadiness } from "../health.js";
import { evaluateLint } from "../lint.js";
import { generatePlan } from "../plan-generator.js";
import { evaluateSecurityAudit } from "../security-audit.js";
import { getServiceStatusMap } from "../service-status.js";
import { getDeploymentCount, getDeploymentHistory } from "../state-queries.js";
import { createSkippedCheck, sortDoctorFindings } from "./severity.js";
import type {
  DoctorCategory,
  DoctorCheckContext,
  DoctorCheckResult,
  DoctorFinding,
} from "../../types/doctor.js";
import type { AuditComposeConfig, AuditFinding } from "../../types/audit.js";
import type { LintComposeConfig, LintFinding, LintIgnoreEntry } from "../../types/lint.js";
import type { StateEntry } from "../../types/state.js";

export interface DoctorCheckerResult {
  checks: DoctorCheckResult[];
  findings: DoctorFinding[];
  warnings?: string[];
}

type DoctorChecker = (context: DoctorCheckContext) => Promise<DoctorCheckerResult>;

interface DoctorCheckerFallback {
  id: string;
  category: DoctorCategory;
}

function lintSuggestedCommand(service?: string): string {
  return service === undefined ? "rfapps lint" : `rfapps lint -s ${service}`;
}

function auditSuggestedCommand(service?: string): string {
  return service === undefined ? "rfapps audit" : `rfapps audit -s ${service}`;
}

function mapAuditFinding(finding: AuditFinding): DoctorFinding {
  return {
    id: `security.${finding.ruleId}`,
    severity: finding.severity,
    category: "security",
    service: finding.service,
    message: finding.message,
    evidence: finding.evidence,
    suggestedCommand: auditSuggestedCommand(finding.service),
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedCheck(id: string, category: DoctorCategory, error: unknown): DoctorCheckerResult {
  const message = toErrorMessage(error);
  return {
    checks: [{ id, category, status: "failed", message }],
    findings: [
      {
        id: `${category}.check-failed`,
        severity: "error",
        category,
        message: `Doctor ${category} check failed`,
        evidence: [message],
      },
    ],
  };
}

export async function runConfigDoctorCheck(
  context: DoctorCheckContext,
): Promise<DoctorCheckerResult> {
  const composeConfig = await getComposeConfig(context.composePath, {
    profiles: context.profiles,
    envTool: context.envTool,
  });

  if (composeConfig === undefined) {
    return failedCheck("config-lint", "config", "Unable to resolve Docker Compose configuration");
  }

  const ignore = (context.config.lint?.ignore ?? []) as LintIgnoreEntry[];
  const targets = context.services.length > 0 ? context.services : undefined;
  const lintResult = evaluateLint(composeConfig as unknown as LintComposeConfig, targets, ignore);
  const auditResult = evaluateSecurityAudit(
    composeConfig as unknown as AuditComposeConfig,
    targets,
  );

  const lintFindings = lintResult.findings
    .filter((finding) => finding.ruleId !== "privileged-enabled")
    .map(
      (finding): DoctorFinding => ({
        id: `config.${finding.ruleId}`,
        severity: finding.severity,
        category: "config",
        service: finding.service,
        message: finding.message,
        evidence: [`lint rule ${finding.ruleId}`, `severity=${finding.severity}`],
        suggestedCommand: lintSuggestedCommand(finding.service),
      }),
    );
  const securityFindings = auditResult.findings.map(mapAuditFinding);

  return {
    checks: [
      { id: "config-lint", category: "config", status: "run" },
      { id: "security-audit", category: "security", status: "run" },
    ],
    findings: [...lintFindings, ...securityFindings],
  };
}

export async function runRuntimeDoctorCheck(
  context: DoctorCheckContext,
): Promise<DoctorCheckerResult> {
  const warnings: string[] = [];
  const findings: DoctorFinding[] = [];
  const statusMap = await getServiceStatusMap(context.composePath, context.projectDir, {
    envTool: context.envTool,
    cacheTtlMs: 0,
    forceRefresh: true,
    preloadedServices: context.services.length > 0 ? context.services : undefined,
  });

  const scopedEntries = [...statusMap.entries()].filter(([service]) =>
    context.services.length === 0 ? true : context.services.includes(service),
  );

  if (statusMap.size === 0) {
    warnings.push("Runtime service status unavailable");
  }

  for (const [service, status] of scopedEntries) {
    if (status.health === "unhealthy") {
      findings.push({
        id: "runtime.unhealthy",
        severity: "error",
        category: "runtime",
        service,
        message: "Container is unhealthy",
        evidence: [`state=${status.state}`, `health=${status.health}`],
        suggestedCommand: `rfapps health -s ${service} --no-wait-for-ready`,
      });
    }

    if (status.state === "dead" || status.state === "restarting") {
      findings.push({
        id: `runtime.${status.state}`,
        severity: "error",
        category: "runtime",
        service,
        message: `Container state is ${status.state}`,
        evidence: [`state=${status.state}`, `health=${status.health}`],
        suggestedCommand: `rfapps status -s ${service} --health`,
      });
    } else if (
      context.services.length > 0 &&
      (status.state === "exited" || status.state === "created")
    ) {
      findings.push({
        id: `runtime.${status.state}`,
        severity: "warn",
        category: "runtime",
        service,
        message: `Container is ${status.state}`,
        evidence: [`state=${status.state}`, `health=${status.health}`],
        suggestedCommand: `rfapps status -s ${service} --health`,
      });
    }
  }

  const readiness = await waitForDependencyReadiness({
    composePath: context.composePath,
    targetServices: context.services,
    projectDir: context.projectDir,
    profiles: context.profiles,
    envTool: context.envTool,
    waitForReady: false,
    poll: {
      timeoutSeconds: 0,
      intervalSeconds: 0,
      retries: 1,
    },
  });

  if (readiness.warnings !== undefined) {
    warnings.push(...readiness.warnings);
  }

  for (const detail of readiness.services) {
    for (const dependency of detail.dependencies) {
      if (dependency.status === "ready") {
        continue;
      }
      findings.push({
        id: `runtime.dependency-${dependency.status}`,
        severity: dependency.status === "failed" ? "error" : "warn",
        category: "runtime",
        service: detail.service,
        message: `Dependency ${dependency.dependency} is ${dependency.status}`,
        evidence: dependency.probes.map(
          (probe) =>
            `${probe.type}=${probe.status}${probe.message !== undefined ? ` (${probe.message})` : ""}`,
        ),
        suggestedCommand: `rfapps health -s ${detail.service} --no-wait-for-ready`,
      });
    }
  }

  return {
    checks: [
      {
        id: "runtime-status",
        category: "runtime",
        status: statusMap.size === 0 ? "skipped" : "run",
        message: statusMap.size === 0 ? "Runtime service status unavailable" : undefined,
        signalAvailability: readiness.signalAvailability,
      },
    ],
    findings,
    warnings,
  };
}

export async function runUpdateDoctorCheck(
  context: DoctorCheckContext,
): Promise<DoctorCheckerResult> {
  if (!context.checkUpdates) {
    return {
      checks: [
        createSkippedCheck(
          "image-updates",
          "updates",
          "registry update checks require --check-updates",
        ),
      ],
      findings: [],
    };
  }

  const plan = await generatePlan(
    {
      composePath: context.composePath,
      services: context.services.length > 0 ? context.services : undefined,
      profiles: context.profiles,
      checkUpdates: true,
    },
    context.envTool,
  );

  if (plan === undefined) {
    return failedCheck("image-updates", "updates", "Unable to generate update check plan");
  }

  const findings = plan.services
    .filter((service) => service.image.updateAvailable === true)
    .map(
      (service): DoctorFinding => ({
        id: "updates.image-available",
        severity: "warn",
        category: "updates",
        service: service.service,
        message: "Container image update is available",
        evidence: [
          `image=${service.image.desired ?? service.image.current ?? "unknown"}`,
          service.image.localDigest !== undefined
            ? `localDigest=${service.image.localDigest}`
            : "localDigest=unknown",
          service.image.remoteDigest !== undefined
            ? `remoteDigest=${service.image.remoteDigest}`
            : "remoteDigest=unknown",
        ],
        suggestedCommand: `rfapps plan -s ${service.service} --check-updates`,
      }),
    );

  return {
    checks: [{ id: "image-updates", category: "updates", status: "run" }],
    findings,
  };
}

function failedDeploymentFinding(entry: StateEntry): DoctorFinding {
  return {
    id: "state.recent-failed-deployment",
    severity: "warn",
    category: "state",
    service: entry.service,
    message: `Recent ${entry.action} deployment failed`,
    evidence: [
      `deployment=${entry.id}`,
      `timestamp=${entry.timestamp}`,
      entry.errorMessage !== undefined ? `error=${entry.errorMessage}` : "error=unknown",
    ],
    suggestedCommand: `rfapps history -s ${entry.service} --limit 5`,
  };
}

export async function runStateDoctorCheck(
  context: DoctorCheckContext,
): Promise<DoctorCheckerResult> {
  if (context.config.state.enabled === false) {
    return {
      checks: [createSkippedCheck("state-history", "state", "state persistence is disabled")],
      findings: [],
    };
  }

  const dbPath = getStateDbPath(context.config);
  if (!existsSync(dbPath)) {
    return {
      checks: [createSkippedCheck("state-history", "state", "state database not found")],
      findings: [],
    };
  }

  const findings: DoctorFinding[] = [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const targetedServices = context.services;
    if (targetedServices.length > 0) {
      for (const service of targetedServices) {
        if (getDeploymentCount(db, { service }) === 0) {
          findings.push({
            id: "state.empty-history",
            severity: "info",
            category: "state",
            service,
            message: "No deployment history recorded for targeted service",
            evidence: ["deploymentCount=0"],
            suggestedCommand: `rfapps history -s ${service}`,
          });
        }

        const recent = getDeploymentHistory(db, { service, limit: 10 });
        findings.push(
          ...recent.filter((entry) => entry.status === "failed").map(failedDeploymentFinding),
        );
      }
    } else {
      const recent = getDeploymentHistory(db, { limit: 20 });
      findings.push(
        ...recent.filter((entry) => entry.status === "failed").map(failedDeploymentFinding),
      );
    }
  } finally {
    closeDatabase(db);
  }

  return {
    checks: [{ id: "state-history", category: "state", status: "run" }],
    findings,
  };
}

export const DOCTOR_CHECKERS: readonly DoctorChecker[] = [
  runConfigDoctorCheck,
  runRuntimeDoctorCheck,
  runUpdateDoctorCheck,
  runStateDoctorCheck,
];

const DOCTOR_CHECKER_FALLBACKS = new Map<DoctorChecker, DoctorCheckerFallback>([
  [runConfigDoctorCheck, { id: "config-lint", category: "config" }],
  [runRuntimeDoctorCheck, { id: "runtime-status", category: "runtime" }],
  [runUpdateDoctorCheck, { id: "image-updates", category: "updates" }],
  [runStateDoctorCheck, { id: "state-history", category: "state" }],
]);

export async function runDoctorChecks(context: DoctorCheckContext): Promise<DoctorCheckerResult> {
  const checks: DoctorCheckResult[] = [];
  const findings: DoctorFinding[] = [];
  const warnings: string[] = [];

  for (const checker of DOCTOR_CHECKERS) {
    try {
      const result = await checker(context);
      checks.push(...result.checks);
      findings.push(...result.findings);
      warnings.push(...(result.warnings ?? []));
    } catch (error) {
      const fallback = DOCTOR_CHECKER_FALLBACKS.get(checker) ?? {
        id: "doctor-checker",
        category: "runtime",
      };
      const result = failedCheck(fallback.id, fallback.category, error);
      checks.push(...result.checks);
      findings.push(...result.findings);
      warnings.push(...(result.warnings ?? []));
    }
  }

  return {
    checks,
    findings: sortDoctorFindings(findings),
    warnings,
  };
}
