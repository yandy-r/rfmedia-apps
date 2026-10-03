/**
 * Production-readiness lint types for rfapps CLI
 *
 * Used for statically evaluating resolved Docker Compose configuration against
 * declarative production-readiness rules.
 */

/**
 * Severity level for a lint rule or finding
 */
export type LintSeverity = "error" | "warn" | "info";

/**
 * Exit-code threshold for lint findings
 */
export type LintFailOn = LintSeverity | "none";

/**
 * Lint analysis mode
 */
export type LintMode = "static" | "runtime";

/**
 * Identifiers for built-in production-readiness lint rules
 */
/** Runtime drift categories mapped to dedicated lint rule ids */
export type RuntimeDriftRuleId =
  | "runtime-drift-image"
  | "runtime-drift-environment"
  | "runtime-drift-ports"
  | "runtime-drift-volumes"
  | "runtime-drift-networks";

export type LintRuleId =
  | "privileged-enabled"
  | "restart-policy-missing"
  | "healthcheck-missing"
  | "log-rotation-missing"
  | "resource-limits-missing"
  | "no-new-privileges-missing"
  | "cap-drop-missing"
  | "read-only-rootfs"
  | RuntimeDriftRuleId;

/**
 * Declarative lint rule definition
 */
export interface LintRule {
  /** Unique rule identifier */
  id: LintRuleId;
  /** Default severity when the rule fires */
  severity: LintSeverity;
  /** Short human-readable title */
  title: string;
  /** Why this rule exists */
  rationale: string;
  /** How to fix the finding in compose configuration */
  remediation: string;
}

/**
 * Advisory grouping for lint findings (presentation only; exit codes use severity)
 */
export type LintFindingGroup = "recommended" | "review_first";

/**
 * A single lint finding for one service
 */
export interface LintFinding {
  /** Rule that produced this finding */
  ruleId: LintRuleId;
  /** Service name from compose configuration */
  service: string;
  /** Severity of this finding */
  severity: LintSeverity;
  /** Human-readable finding message */
  message: string;
  /** Remediation hint for the operator */
  remediation: string;
  /** Advisory group for text output and machine formats */
  group: LintFindingGroup;
  /** Optional workload context when a compose heuristic matches */
  contextNote?: string;
}

/**
 * Aggregated counts of lint findings by severity
 */
export interface LintSummary {
  /** Number of error-level findings */
  error: number;
  /** Number of warn-level findings */
  warn: number;
  /** Number of info-level findings */
  info: number;
  /** Total number of findings */
  total: number;
}

/**
 * Full lint analysis result
 */
export interface LintResult {
  /** ISO 8601 timestamp of analysis */
  timestamp: string;
  /** Lint findings sorted by service then rule id */
  findings: LintFinding[];
  /** Aggregated finding counts */
  summary: LintSummary;
  /** Whether analysis was static-only or included runtime inspection */
  mode: LintMode;
}

/**
 * Options for running lint analysis
 */
export interface LintOptions {
  /** Path to compose file */
  composePath: string;
  /** Target services (undefined means all) */
  services?: string[];
  /** Compose profiles to use */
  profiles?: string[];
  /** Minimum severity that causes a non-zero exit code */
  failOn: LintFailOn;
  /** Whether to include runtime container inspection */
  runtime: boolean;
  /** Per-rule or per-service suppressions */
  ignore?: LintIgnoreEntry[];
}

/**
 * Suppression entry for lint findings
 */
export interface LintIgnoreEntry {
  /** Rule to suppress, or "*" for all rules */
  rule: LintRuleId | "*";
  /** Optional service scope (omit to suppress globally for the rule) */
  service?: string;
}

/**
 * Resource limits from deploy.resources.limits
 */
export interface LintComposeResourceLimits {
  /** Memory limit (e.g. "512M") */
  memory?: string;
  /** CPU limit (e.g. "0.5") */
  cpus?: string | number;
}

/**
 * Deploy resources block from compose configuration
 */
export interface LintComposeDeployResources {
  /** Resource limits for the service */
  limits?: LintComposeResourceLimits;
}

/**
 * Deploy restart policy from compose configuration
 */
export interface LintComposeRestartPolicy {
  /** Restart policy condition */
  condition?: string;
}

/**
 * Deploy block from compose configuration
 */
export interface LintComposeDeploy {
  /** Deploy-level resource configuration */
  resources?: LintComposeDeployResources;
  /** Deploy-level restart policy */
  restart_policy?: LintComposeRestartPolicy;
}

/**
 * Healthcheck block from compose configuration
 */
export interface LintComposeHealthcheck {
  /** Health check command */
  test?: string | string[];
  /** Interval between checks */
  interval?: string;
  /** Timeout per check */
  timeout?: string;
  /** Number of retries */
  retries?: number;
  /** Start period before counting failures */
  start_period?: string;
}

/**
 * Logging block from compose configuration
 */
export interface LintComposeLogging {
  /** Logging driver */
  driver?: string;
  /** Driver-specific options (e.g. max-size, max-file) */
  options?: Record<string, string>;
}

/**
 * Long-form volume mount entry from compose configuration
 */
export interface LintComposeVolumeMount {
  /** Mount path inside the container */
  target?: string;
  /** Whether the mount is read-only */
  read_only?: boolean;
  /** Bind mount options */
  bind?: {
    create_host_path?: boolean;
  };
}

/**
 * Compose service fields inspected by production-readiness lint rules.
 *
 * Richer than {@link ComposeServiceConfig} in docker.ts, which omits security,
 * deploy, healthcheck, and logging fields needed for static analysis.
 */
export interface LintComposeService {
  /** Container image reference */
  image?: string;
  /** Restart policy (e.g. "unless-stopped") */
  restart?: string;
  /** Deploy configuration */
  deploy?: LintComposeDeploy;
  /** Container health check */
  healthcheck?: LintComposeHealthcheck | null;
  /** Log driver configuration */
  logging?: LintComposeLogging;
  /** Security options (e.g. "no-new-privileges:true") */
  security_opt?: string[];
  /** Capabilities to add */
  cap_add?: string[];
  /** Capabilities to drop */
  cap_drop?: string[];
  /** Device mappings */
  devices?: string[];
  /** Volume mounts (short or long syntax) */
  volumes?: Array<string | LintComposeVolumeMount>;
  /** Read-only root filesystem */
  read_only?: boolean;
  /** User to run as */
  user?: string;
  /** Privileged mode */
  privileged?: boolean;
}

/**
 * Resolved compose configuration shape for lint evaluation
 */
export interface LintComposeConfig {
  /** Services keyed by service name */
  services: Record<string, LintComposeService>;
}
