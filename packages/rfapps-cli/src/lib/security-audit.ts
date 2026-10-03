/**
 * Compose security audit rule catalog and pure evaluation engine.
 *
 * Evaluates resolved Docker Compose configuration from `docker compose config`
 * without daemon inspection, filesystem writes, or container mutation.
 */

import { InvalidArgumentError } from "./errors.js";
import type {
  AuditComposeConfig,
  AuditComposeService,
  AuditComposeVolumeMount,
  AuditFailOn,
  AuditFinding,
  AuditResult,
  AuditRule,
  AuditRuleId,
  AuditSeverity,
  AuditSummary,
} from "../types/audit.js";

const VALID_FAIL_ON: readonly AuditFailOn[] = ["none", "info", "warn", "error", "critical"];
const SEVERITY_RANK: Record<AuditSeverity, number> = {
  critical: 4,
  error: 3,
  warn: 2,
  info: 1,
};

const ROOT_USER_EVIDENCE = "user omitted or root-equivalent";
const DOCKER_SOCKET = "/var/run/docker.sock";

export const AUDIT_RULES: readonly AuditRule[] = [
  {
    id: "privileged-container",
    category: "privileges",
    severity: "critical",
    title: "Privileged mode enabled",
    rationale:
      "Privileged containers bypass many isolation boundaries and can access host devices and kernel capabilities.",
    remediation:
      "Remove `privileged: true` and grant only the specific devices, mounts, or capabilities the service requires.",
  },
  {
    id: "docker-socket-mounted",
    category: "host-access",
    severity: "critical",
    title: "Docker socket mounted",
    rationale:
      "A container with Docker socket access can usually control the Docker daemon and the host workloads it manages.",
    remediation:
      "Avoid mounting `/var/run/docker.sock`; use a scoped proxy or a purpose-built integration with limited permissions.",
  },
  {
    id: "host-networking",
    category: "host-access",
    severity: "error",
    title: "Host networking enabled",
    rationale:
      "Host networking removes network namespace isolation and exposes the container directly on the host network stack.",
    remediation:
      "Use bridge networking and publish only required ports unless host networking is strictly required.",
  },
  {
    id: "root-user",
    category: "identity",
    severity: "warn",
    title: "Root-equivalent container user",
    rationale:
      "Running as root increases impact if a process escapes application-level controls or writes to mounted paths.",
    remediation:
      "Set `user` to a non-root UID:GID or image-supported user, and verify mounted path ownership.",
  },
  {
    id: "capability-added",
    category: "privileges",
    severity: "warn",
    title: "Linux capabilities added",
    rationale:
      "Added Linux capabilities increase the operations available to a compromised process inside the container.",
    remediation:
      "Remove unnecessary `cap_add` entries and prefer the narrowest capability set the workload supports.",
  },
  {
    id: "cap-drop-missing",
    category: "privileges",
    severity: "info",
    title: "Capability drop not configured",
    rationale:
      "Dropping default capabilities reduces the kernel attack surface available to container processes.",
    remediation: 'Set `cap_drop: ["ALL"]` and add back only capabilities that are required.',
  },
  {
    id: "service-networking",
    category: "host-access",
    severity: "info",
    title: "Shares another service network namespace",
    rationale:
      "Sharing a service network namespace can be intentional for sidecars, but it couples network isolation boundaries.",
    remediation:
      "Confirm `network_mode: service:*` is intentional and the paired service is trusted for the same network boundary.",
  },
  {
    id: "memory-limit-missing",
    category: "resources",
    severity: "info",
    title: "Memory limit missing",
    rationale:
      "Without memory limits, one compromised or faulty service can consume host memory and affect neighboring workloads.",
    remediation: "Set `deploy.resources.limits.memory` to an appropriate workload-specific value.",
  },
  {
    id: "cpu-limit-missing",
    category: "resources",
    severity: "info",
    title: "CPU limit missing",
    rationale:
      "Without CPU limits, one compromised or faulty service can monopolize host CPU resources.",
    remediation: "Set `deploy.resources.limits.cpus` to an appropriate workload-specific value.",
  },
];

const RULE_BY_ID = new Map<AuditRuleId, AuditRule>(AUDIT_RULES.map((rule) => [rule.id, rule]));

function rule(ruleId: AuditRuleId): AuditRule {
  const entry = RULE_BY_ID.get(ruleId);
  if (entry === undefined) {
    throw new Error(`Unknown audit rule: ${ruleId}`);
  }
  return entry;
}

function buildFinding(
  ruleId: AuditRuleId,
  service: string,
  evidence: string[],
  message?: string,
): AuditFinding {
  const entry = rule(ruleId);
  return {
    ruleId: entry.id,
    category: entry.category,
    severity: entry.severity,
    service,
    message: message ?? entry.title,
    evidence,
    remediation: entry.remediation,
  };
}

function isRootEquivalentUser(user: string | undefined): boolean {
  if (user === undefined) {
    return true;
  }

  const normalized = user.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "root" ||
    normalized === "0" ||
    normalized === "0:0" ||
    normalized.startsWith("0:") ||
    normalized.startsWith("root:")
  );
}

function hasCapDropAll(service: AuditComposeService): boolean {
  return service.cap_drop?.some((capability) => capability.toUpperCase() === "ALL") === true;
}

function hasMemoryLimit(service: AuditComposeService): boolean {
  const memory = service.deploy?.resources?.limits?.memory;
  return memory !== undefined && String(memory).trim() !== "";
}

function hasCpuLimit(service: AuditComposeService): boolean {
  const cpus = service.deploy?.resources?.limits?.cpus;
  return cpus !== undefined && String(cpus).trim() !== "";
}

function boundedUserEvidence(user: string | undefined): string {
  if (user === undefined) {
    return "user=<omitted>";
  }

  const value = user.trim();
  return value === "" ? "user=<empty>" : `user=${value}`;
}

function volumeTarget(volume: string | AuditComposeVolumeMount): string | undefined {
  if (typeof volume !== "string") {
    return volume.target;
  }

  const parts = volume.split(":");
  return parts.length >= 2 ? parts[1] : parts[0];
}

function volumeSource(volume: string | AuditComposeVolumeMount): string | undefined {
  if (typeof volume !== "string") {
    return volume.source;
  }

  return volume.split(":")[0];
}

function isDockerSocketMount(volume: string | AuditComposeVolumeMount): boolean {
  return volumeSource(volume) === DOCKER_SOCKET || volumeTarget(volume) === DOCKER_SOCKET;
}

function evaluateService(serviceName: string, service: AuditComposeService): AuditFinding[] {
  const findings: AuditFinding[] = [];

  if (service.privileged === true) {
    findings.push(buildFinding("privileged-container", serviceName, ["privileged=true"]));
  }

  if (service.volumes?.some(isDockerSocketMount) === true) {
    findings.push(
      buildFinding("docker-socket-mounted", serviceName, [
        `volume source or target=${DOCKER_SOCKET}`,
      ]),
    );
  }

  if (service.network_mode === "host") {
    findings.push(buildFinding("host-networking", serviceName, ["network_mode=host"]));
  } else if (service.network_mode?.startsWith("service:") === true) {
    findings.push(
      buildFinding("service-networking", serviceName, [`network_mode=${service.network_mode}`]),
    );
  }

  if (isRootEquivalentUser(service.user)) {
    findings.push(
      buildFinding("root-user", serviceName, [
        boundedUserEvidence(service.user),
        ROOT_USER_EVIDENCE,
      ]),
    );
  }

  if (service.cap_add !== undefined && service.cap_add.length > 0) {
    for (const capability of service.cap_add.slice().sort()) {
      findings.push(
        buildFinding("capability-added", serviceName, [`cap_add=${capability.toUpperCase()}`]),
      );
    }
  }

  if (!hasCapDropAll(service)) {
    findings.push(
      buildFinding("cap-drop-missing", serviceName, [
        service.cap_drop === undefined
          ? "cap_drop=<omitted>"
          : `cap_drop=${service.cap_drop.join(",")}`,
      ]),
    );
  }

  if (!hasMemoryLimit(service)) {
    findings.push(
      buildFinding("memory-limit-missing", serviceName, [
        "deploy.resources.limits.memory=<omitted>",
      ]),
    );
  }

  if (!hasCpuLimit(service)) {
    findings.push(
      buildFinding("cpu-limit-missing", serviceName, ["deploy.resources.limits.cpus=<omitted>"]),
    );
  }

  return findings;
}

export function compareAuditSeverity(left: AuditSeverity, right: AuditSeverity): number {
  return SEVERITY_RANK[right] - SEVERITY_RANK[left];
}

export function sortAuditFindings(findings: AuditFinding[]): AuditFinding[] {
  return findings.slice().sort((left, right) => {
    const severityCompare = compareAuditSeverity(left.severity, right.severity);
    if (severityCompare !== 0) {
      return severityCompare;
    }

    const categoryCompare = left.category.localeCompare(right.category);
    if (categoryCompare !== 0) {
      return categoryCompare;
    }

    const ruleCompare = left.ruleId.localeCompare(right.ruleId);
    if (ruleCompare !== 0) {
      return ruleCompare;
    }

    return left.service.localeCompare(right.service);
  });
}

export function buildAuditSummary(findings: AuditFinding[]): AuditSummary {
  const summary: AuditSummary = {
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

export function parseAuditFailOn(value: string | undefined): AuditFailOn {
  if (value === undefined) {
    return "critical";
  }

  const normalized = value.toLowerCase().trim();
  if (VALID_FAIL_ON.includes(normalized as AuditFailOn)) {
    return normalized as AuditFailOn;
  }

  throw new InvalidArgumentError("--fail-on", value, "Invalid fail-on severity", [
    ...VALID_FAIL_ON,
  ]);
}

export function shouldFailAudit(
  result: Pick<AuditResult, "findings">,
  failOn: AuditFailOn,
): boolean {
  if (failOn === "none") {
    return false;
  }

  const threshold = SEVERITY_RANK[failOn];
  return result.findings.some((finding) => SEVERITY_RANK[finding.severity] >= threshold);
}

export function evaluateSecurityAudit(
  config: AuditComposeConfig,
  targets: string[] | undefined,
): Pick<AuditResult, "timestamp" | "findings" | "summary"> {
  const serviceNames = (targets ?? Object.keys(config.services)).slice().sort();

  if (targets !== undefined) {
    const missing = targets.filter((name) => config.services[name] === undefined);
    if (missing.length > 0) {
      throw new InvalidArgumentError(
        "services",
        missing.join(","),
        "unknown service target(s)",
        Object.keys(config.services).sort(),
      );
    }
  }

  const findings = sortAuditFindings(
    serviceNames.flatMap((serviceName) => {
      const service = config.services[serviceName];
      return service === undefined ? [] : evaluateService(serviceName, service);
    }),
  );

  return {
    timestamp: new Date().toISOString(),
    findings,
    summary: buildAuditSummary(findings),
  };
}

function severityLabel(severity: AuditSeverity): string {
  return severity.toUpperCase();
}

export function formatAuditText(result: AuditResult): string[] {
  const lines: string[] = [
    "Security Audit Summary",
    `Scope: ${result.scope.services.length > 0 ? result.scope.services.join(", ") : "all services"} (${result.scope.composePath})`,
    `Findings: ${result.summary.total} total, ${result.summary.critical} critical, ${result.summary.error} error, ${result.summary.warn} warn, ${result.summary.info} info`,
  ];

  if (result.findings.length === 0) {
    lines.push("", "No audit findings.");
    return lines;
  }

  let currentSeverity: AuditSeverity | undefined;
  let currentService: string | undefined;

  for (const finding of result.findings) {
    if (finding.severity !== currentSeverity) {
      currentSeverity = finding.severity;
      currentService = undefined;
      lines.push("", severityLabel(finding.severity));
    }

    if (finding.service !== currentService) {
      currentService = finding.service;
      lines.push(`  ${finding.service}`);
    }

    lines.push(
      `    - ${finding.message} (${finding.ruleId})`,
      `      Evidence: ${finding.evidence.join("; ")}`,
      `      Remediation: ${finding.remediation}`,
    );
  }

  return lines;
}
