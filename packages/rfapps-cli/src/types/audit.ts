/**
 * Compose security audit contracts for rfapps CLI.
 *
 * Used for statically evaluating resolved Docker Compose configuration against
 * container security posture rules. The audit surface is read-only and advisory.
 */

import type { OutputFormat } from "@rfmedia/common";
import type { GlobalOptions, ServiceTargetOptions, ComposeOptions } from "./options.js";

export const AUDIT_SCHEMA_VERSION = "audit.v1" as const;

export type AuditSeverity = "critical" | "error" | "warn" | "info";
export type AuditFailOn = AuditSeverity | "none";
export type AuditCategory = "identity" | "privileges" | "host-access" | "resources";

export type AuditRuleId =
  | "root-user"
  | "privileged-container"
  | "capability-added"
  | "cap-drop-missing"
  | "docker-socket-mounted"
  | "host-networking"
  | "service-networking"
  | "memory-limit-missing"
  | "cpu-limit-missing";

export interface AuditRule {
  id: AuditRuleId;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  rationale: string;
  remediation: string;
}

export interface AuditFinding {
  ruleId: AuditRuleId;
  category: AuditCategory;
  severity: AuditSeverity;
  service: string;
  message: string;
  evidence: string[];
  remediation: string;
}

export interface AuditSummary {
  critical: number;
  error: number;
  warn: number;
  info: number;
  total: number;
}

export interface AuditScope {
  services: string[];
  profiles: string[];
  composePath: string;
}

export interface AuditResult {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION;
  timestamp: string;
  scope: AuditScope;
  summary: AuditSummary;
  findings: AuditFinding[];
}

export interface AuditOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  failOn: AuditFailOn;
  output?: OutputFormat;
}

export interface AuditComposeResourceLimits {
  memory?: string;
  cpus?: string | number;
  pids?: number;
}

export interface AuditComposeDeployResources {
  limits?: AuditComposeResourceLimits;
}

export interface AuditComposeDeploy {
  resources?: AuditComposeDeployResources;
}

export interface AuditComposeVolumeMount {
  type?: string;
  source?: string;
  target?: string;
  read_only?: boolean;
}

export interface AuditComposeService {
  deploy?: AuditComposeDeploy;
  user?: string;
  privileged?: boolean;
  cap_add?: string[];
  cap_drop?: string[];
  network_mode?: string;
  volumes?: Array<string | AuditComposeVolumeMount>;
}

export interface AuditComposeConfig {
  services: Record<string, AuditComposeService>;
}
