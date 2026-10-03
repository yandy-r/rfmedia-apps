/**
 * Production-readiness lint rule catalog and pure evaluation engine.
 *
 * Evaluates resolved Docker Compose configuration (post-anchor/extension merge)
 * against declarative rules. No daemon or filesystem access.
 */

import { buildContextNote, classifyFindingGroup } from "./lint-context.js";
import { InvalidArgumentError } from "./errors.js";
import type {
  LintComposeConfig,
  LintComposeService,
  LintFinding,
  LintIgnoreEntry,
  LintResult,
  LintRule,
  LintRuleId,
  LintSummary,
} from "../types/lint.js";

/** Lint rule with synchronous service predicate */
type EvaluableLintRule = LintRule & {
  evaluate: (service: LintComposeService) => boolean;
};

/** Normalized ignore entry after validation */
interface NormalizedIgnoreEntry {
  rule: LintRuleId | "*";
  service?: string;
}

const NO_NEW_PRIVILEGES_OPT = "no-new-privileges:true";

function hasRestartPolicy(service: LintComposeService): boolean {
  if (service.restart !== undefined && service.restart !== "") {
    return true;
  }
  return service.deploy?.restart_policy !== undefined;
}

function hasHealthcheck(service: LintComposeService): boolean {
  return service.healthcheck !== undefined && service.healthcheck !== null;
}

function hasLogRotation(service: LintComposeService): boolean {
  const maxSize = service.logging?.options?.["max-size"];
  return maxSize !== undefined && maxSize !== "";
}

function hasMemoryLimit(service: LintComposeService): boolean {
  const memory = service.deploy?.resources?.limits?.memory;
  return memory !== undefined && memory !== "";
}

function hasNoNewPrivileges(service: LintComposeService): boolean {
  return service.security_opt?.includes(NO_NEW_PRIVILEGES_OPT) === true;
}

function hasCapDrop(service: LintComposeService): boolean {
  return service.cap_drop !== undefined && service.cap_drop.length > 0;
}

/** Declarative catalog of production-readiness lint rules */
export const LINT_RULES: EvaluableLintRule[] = [
  {
    id: "privileged-enabled",
    severity: "error",
    title: "Privileged mode enabled",
    rationale:
      "Privileged containers have full host capabilities and bypass most isolation, increasing blast radius on compromise.",
    remediation:
      "Remove `privileged: true` or replace with the minimal `cap_add`, `devices`, and `security_opt` your service actually needs.",
    evaluate: (service) => service.privileged === true,
  },
  {
    id: "restart-policy-missing",
    severity: "warn",
    title: "Restart policy missing",
    rationale:
      "Without a restart policy, containers stay stopped after host reboot or unexpected exit.",
    remediation:
      "Set top-level `restart` (e.g. `unless-stopped`) or `deploy.restart_policy` so the service recovers automatically.",
    evaluate: (service) => !hasRestartPolicy(service),
  },
  {
    id: "healthcheck-missing",
    severity: "warn",
    title: "Health check missing",
    rationale:
      "Health checks let orchestrators detect unhealthy containers and replace or alert on them.",
    remediation:
      "Add a `healthcheck` block with an appropriate `test`, `interval`, `timeout`, and `retries`.",
    evaluate: (service) => !hasHealthcheck(service),
  },
  {
    id: "log-rotation-missing",
    severity: "warn",
    title: "Log rotation not configured",
    rationale: "Unbounded container logs can fill disk and cause outages across the host.",
    remediation:
      "Configure `logging.options.max-size` (and typically `max-file`) on the json-file driver or an equivalent rotation-capable driver.",
    evaluate: (service) => !hasLogRotation(service),
  },
  {
    id: "resource-limits-missing",
    severity: "info",
    title: "Memory limit missing",
    rationale:
      "Without memory limits, a single container can consume host RAM and destabilize co-located services.",
    remediation:
      "Set `deploy.resources.limits.memory` (for example `512M` or `1G`) appropriate for the workload.",
    evaluate: (service) => !hasMemoryLimit(service),
  },
  {
    id: "no-new-privileges-missing",
    severity: "info",
    title: "no-new-privileges not set",
    rationale:
      "The no-new-privileges flag prevents processes from gaining additional privileges via setuid/setgid binaries.",
    remediation:
      'Add `security_opt: ["no-new-privileges:true"]` unless the service requires privilege escalation.',
    evaluate: (service) => !hasNoNewPrivileges(service),
  },
  {
    id: "cap-drop-missing",
    severity: "info",
    title: "Capability drop not configured",
    rationale:
      "Dropping unneeded Linux capabilities reduces the attack surface if the container is compromised.",
    remediation: 'Set `cap_drop: ["ALL"]` and add back only required capabilities with `cap_add`.',
    evaluate: (service) => !hasCapDrop(service),
  },
  {
    id: "read-only-rootfs",
    severity: "info",
    title: "Read-only root filesystem not enabled",
    rationale:
      "A writable root filesystem allows attackers to persist changes or modify binaries inside the container.",
    remediation:
      "Set `read_only: true` and mount writable paths explicitly with `tmpfs` or volume mounts where needed.",
    evaluate: (service) => service.read_only !== true,
  },
];

/** Metadata for runtime drift findings (not evaluated statically) */
export const RUNTIME_DRIFT_RULES: LintRule[] = [
  {
    id: "runtime-drift-image",
    severity: "warn",
    title: "Runtime drift in image",
    rationale: "Running container image differs from compose configuration.",
    remediation: "Run `rfapps drift detect` for details, then reconcile or redeploy.",
  },
  {
    id: "runtime-drift-environment",
    severity: "warn",
    title: "Runtime drift in environment",
    rationale: "Running container environment differs from compose configuration.",
    remediation: "Run `rfapps drift detect` for details, then reconcile or redeploy.",
  },
  {
    id: "runtime-drift-ports",
    severity: "warn",
    title: "Runtime drift in ports",
    rationale: "Running container ports differ from compose configuration.",
    remediation: "Run `rfapps drift detect` for details, then reconcile or redeploy.",
  },
  {
    id: "runtime-drift-volumes",
    severity: "warn",
    title: "Runtime drift in volumes",
    rationale: "Running container volumes differ from compose configuration.",
    remediation: "Run `rfapps drift detect` for details, then reconcile or redeploy.",
  },
  {
    id: "runtime-drift-networks",
    severity: "warn",
    title: "Runtime drift in networks",
    rationale: "Running container networks differ from compose configuration.",
    remediation: "Run `rfapps drift detect` for details, then reconcile or redeploy.",
  },
];

const VALID_RULE_IDS: LintRuleId[] = [
  ...LINT_RULES.map((rule) => rule.id),
  ...RUNTIME_DRIFT_RULES.map((rule) => rule.id),
];

/**
 * Normalize and validate lint ignore entries.
 *
 * @throws {InvalidArgumentError} When an ignore entry references an unknown rule id
 */
function normalizeIgnoreEntries(ignore: LintIgnoreEntry[]): NormalizedIgnoreEntry[] {
  return ignore.map((entry) => {
    const normalizedRule = entry.rule === "*" ? "*" : entry.rule.toLowerCase().trim();

    if (normalizedRule !== "*" && !VALID_RULE_IDS.includes(normalizedRule as LintRuleId)) {
      throw new InvalidArgumentError("lint.ignore[].rule", entry.rule, "unknown lint rule id", [
        ...VALID_RULE_IDS,
        "*",
      ]);
    }

    const normalizedService =
      entry.service !== undefined ? entry.service.toLowerCase().trim() : undefined;

    return {
      rule: normalizedRule as LintRuleId | "*",
      service: normalizedService,
    };
  });
}

/**
 * Whether a rule finding is suppressed for the given service.
 */
function isRuleSuppressed(
  ruleId: LintRuleId,
  serviceName: string,
  ignore: NormalizedIgnoreEntry[],
): boolean {
  const normalizedService = serviceName.toLowerCase().trim();

  return ignore.some((entry) => {
    const ruleMatches = entry.rule === "*" || entry.rule === ruleId;
    const serviceMatches = entry.service === undefined || entry.service === normalizedService;
    return ruleMatches && serviceMatches;
  });
}

/**
 * Remove findings suppressed by lint ignore entries.
 */
export function filterFindingsByIgnore(
  findings: LintFinding[],
  ignore: LintIgnoreEntry[],
): LintFinding[] {
  const normalizedIgnore = normalizeIgnoreEntries(ignore);
  return findings.filter(
    (finding) => !isRuleSuppressed(finding.ruleId, finding.service, normalizedIgnore),
  );
}

/**
 * Compute aggregated finding counts by severity.
 */
function buildSummary(findings: LintFinding[]): LintSummary {
  const summary: LintSummary = { error: 0, warn: 0, info: 0, total: findings.length };

  for (const finding of findings) {
    summary[finding.severity] += 1;
  }

  return summary;
}

/**
 * Evaluate resolved compose configuration against production-readiness lint rules.
 *
 * @param config - Resolved compose configuration from `docker compose config`
 * @param targets - Service names to lint (undefined evaluates all services)
 * @param ignore - Per-rule or per-service suppressions
 * @returns Lint findings sorted by service then rule id, with summary counts
 */
export function evaluateLint(
  config: LintComposeConfig,
  targets: string[] | undefined,
  ignore: LintIgnoreEntry[],
): LintResult {
  const normalizedIgnore = normalizeIgnoreEntries(ignore);
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

  const findings: LintFinding[] = [];

  for (const serviceName of serviceNames) {
    const service = config.services[serviceName];
    if (service === undefined) {
      continue;
    }

    for (const rule of LINT_RULES) {
      if (isRuleSuppressed(rule.id, serviceName, normalizedIgnore)) {
        continue;
      }

      if (!rule.evaluate(service)) {
        continue;
      }

      findings.push({
        ruleId: rule.id,
        service: serviceName,
        severity: rule.severity,
        message: rule.title,
        remediation: rule.remediation,
        group: classifyFindingGroup(rule),
        contextNote: buildContextNote(rule.id, service),
      });
    }
  }

  findings.sort((left, right) => {
    const serviceCompare = left.service.localeCompare(right.service);
    if (serviceCompare !== 0) {
      return serviceCompare;
    }
    return left.ruleId.localeCompare(right.ruleId);
  });

  return {
    timestamp: new Date().toISOString(),
    findings,
    summary: buildSummary(findings),
    mode: "static",
  };
}
