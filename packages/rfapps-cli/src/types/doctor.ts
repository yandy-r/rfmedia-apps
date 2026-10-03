/**
 * Unified doctor command contracts for rfapps CLI.
 */

import type { OutputFormat } from "@rfmedia/common";
import type { RfappsConfig } from "./config.js";
import type {
  EnvToolExecConfig,
  GlobalOptions,
  ServiceTargetOptions,
  ComposeOptions,
} from "./options.js";
import type { ReadinessSignalAvailability } from "./health.js";

export const DOCTOR_SCHEMA_VERSION = "doctor.v1" as const;

export type DoctorSeverity = "critical" | "error" | "warn" | "info";
export type DoctorFailOn = DoctorSeverity | "none";
export type DoctorCategory = "config" | "security" | "runtime" | "updates" | "state";
export type DoctorCheckStatus = "run" | "skipped" | "failed";

export interface DoctorScope {
  services: string[];
  profiles: string[];
  composePath: string;
  checkUpdates: boolean;
}

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  category: DoctorCategory;
  message: string;
  evidence: string[];
  service?: string;
  suggestedCommand?: string;
}

export interface DoctorCheckResult {
  id: string;
  category: DoctorCategory;
  status: DoctorCheckStatus;
  message?: string;
  signalAvailability?: ReadinessSignalAvailability;
}

export interface DoctorSummary {
  critical: number;
  error: number;
  warn: number;
  info: number;
  total: number;
}

export interface DoctorResult {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  timestamp: string;
  scope: DoctorScope;
  summary: DoctorSummary;
  checks: DoctorCheckResult[];
  findings: DoctorFinding[];
  warnings?: string[];
}

export interface DoctorOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  checkUpdates: boolean;
  failOn: DoctorFailOn;
  output?: OutputFormat;
}

export interface DoctorCheckContext {
  config: RfappsConfig;
  composePath: string;
  services: string[];
  profiles: string[];
  projectDir: string;
  checkUpdates: boolean;
  envTool?: EnvToolExecConfig;
}
