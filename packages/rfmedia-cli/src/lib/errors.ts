/**
 * Custom error classes for rfmedia CLI validation and lookup failures.
 *
 * These errors carry structured context for formatter-driven CLI output.
 */

import type { PlanStalenessFinding } from "../types/plan.js";
import type { LidarrPlanStalenessFinding } from "../types/lidarr-plan.js";

/**
 * Thrown when a numeric CLI argument cannot be parsed or fails bounds checks.
 */
export class InvalidNumericArgumentError extends Error {
  readonly argument: string;
  readonly value: string | number;
  readonly reason: string;
  readonly min?: number;
  readonly max?: number;

  constructor(
    argument: string,
    value: string | number,
    reason: string,
    min?: number,
    max?: number,
  ) {
    super(`Invalid value '${String(value)}' for ${argument}: ${reason}`);
    this.name = "InvalidNumericArgumentError";
    this.argument = argument;
    this.value = value;
    this.reason = reason;
    this.min = min;
    this.max = max;
  }
}

/**
 * Thrown when two options are mutually exclusive or otherwise incompatible.
 */
export class OptionConflictError extends Error {
  readonly option: string;
  readonly conflictingOption: string;
  readonly details?: string;

  constructor(option: string, conflictingOption: string, details?: string) {
    const detailPart = details ? `: ${details}` : "";
    super(`Cannot use ${option} with ${conflictingOption}${detailPart}`);
    this.name = "OptionConflictError";
    this.option = option;
    this.conflictingOption = conflictingOption;
    this.details = details;
  }
}

/** Thrown for plan artifact IO/safety failures (symlink, oversize, malformed, tamper). */
export class PlanArtifactError extends Error {
  readonly code:
    | "PLAN_UNSAFE_PATH"
    | "PLAN_TOO_LARGE"
    | "PLAN_MALFORMED"
    | "PLAN_CHECKSUM_MISMATCH"
    | "PLAN_EXISTS"
    | "PLAN_IO"
    | "PLAN_EMPTY";
  readonly planPath?: string;

  constructor(
    code: PlanArtifactError["code"],
    message: string,
    planPath?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PlanArtifactError";
    this.code = code;
    this.planPath = planPath;
  }
}

/** Thrown when a plan fails the assertCopyPlanV1 allowlist validation. */
export class PlanValidationError extends Error {
  readonly detail: string;
  readonly planPath?: string;

  constructor(detail: string, planPath?: string) {
    super(`Invalid copy plan: ${detail}`);
    this.name = "PlanValidationError";
    this.detail = detail;
    this.planPath = planPath;
  }
}

/** Thrown when staleness errors block apply (world drifted since planning). */
export class PlanStaleError extends Error {
  readonly findings: PlanStalenessFinding[];
  readonly planPath: string;

  constructor(findings: PlanStalenessFinding[], planPath: string) {
    super(`Plan is stale: ${findings.length} blocking finding(s)`);
    this.name = "PlanStaleError";
    this.findings = findings;
    this.planPath = planPath;
  }
}

/** Thrown for Lidarr plan artifact IO, safety, and tamper failures. */
export class LidarrPlanArtifactError extends Error {
  readonly code:
    | "LIDARR_PLAN_UNSAFE_PATH"
    | "LIDARR_PLAN_TOO_LARGE"
    | "LIDARR_PLAN_MALFORMED"
    | "LIDARR_PLAN_CHECKSUM_MISMATCH"
    | "LIDARR_PLAN_EXISTS"
    | "LIDARR_PLAN_IO"
    | "LIDARR_PLAN_EMPTY";
  readonly planPath?: string;

  constructor(
    code: LidarrPlanArtifactError["code"],
    message: string,
    planPath?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LidarrPlanArtifactError";
    this.code = code;
    this.planPath = planPath;
  }
}

/** Thrown when an untrusted Lidarr plan fails exact-schema validation. */
export class LidarrPlanValidationError extends Error {
  readonly detail: string;
  readonly planPath?: string;

  constructor(detail: string, planPath?: string) {
    super(`Invalid Lidarr plan: ${detail}`);
    this.name = "LidarrPlanValidationError";
    this.detail = detail;
    this.planPath = planPath;
  }
}

/** Thrown when remote Lidarr state drift blocks a plan apply. */
export class LidarrPlanStaleError extends Error {
  readonly findings: readonly LidarrPlanStalenessFinding[];
  readonly planPath: string;

  constructor(findings: readonly LidarrPlanStalenessFinding[], planPath: string) {
    super(`Lidarr plan is stale: ${findings.length} blocking finding(s)`);
    this.name = "LidarrPlanStaleError";
    this.findings = findings;
    this.planPath = planPath;
  }
}

/** Thrown when another process owns the exclusive claim for a Lidarr plan. */
export class LidarrPlanAlreadyRunningError extends Error {
  readonly planId: string;
  readonly claimPath: string;

  constructor(planId: string, claimPath: string) {
    super(`Lidarr plan ${planId} is already being applied`);
    this.name = "LidarrPlanAlreadyRunningError";
    this.planId = planId;
    this.claimPath = claimPath;
  }
}

/**
 * Thrown when a required argument/option/input is missing.
 */
export class MissingRequiredArgumentError extends Error {
  readonly requirement: string;
  readonly context?: string;

  constructor(requirement: string, context?: string) {
    const contextPart = context ? `${context}: ` : "";
    super(`${contextPart}${requirement}`);
    this.name = "MissingRequiredArgumentError";
    this.requirement = requirement;
    this.context = context;
  }
}

/**
 * Thrown when a named lookup value does not exist.
 */
export class LookupNotFoundError extends Error {
  readonly lookupType: string;
  readonly value: string;
  readonly availableValues: string[];
  readonly suggestion?: string;
  readonly context?: string;
  readonly suggestions: string[];

  constructor(
    lookupType: string,
    value: string,
    availableValues: string[],
    suggestion?: string,
    context?: string,
    suggestions: string[] = [],
  ) {
    const contextPart = context ? ` (${context})` : "";
    super(`Unknown ${lookupType}: '${value}'${contextPart}`);
    this.name = "LookupNotFoundError";
    this.lookupType = lookupType;
    this.value = value;
    this.availableValues = availableValues;
    this.suggestion = suggestion;
    this.context = context;
    this.suggestions = suggestions;
  }
}

/**
 * Thrown when global output format is not recognized.
 */
export class InvalidOutputFormatError extends Error {
  readonly outputFormat: string;
  readonly validFormats: readonly string[];

  constructor(outputFormat: string, validFormats: readonly string[]) {
    super(`Unknown output format: ${outputFormat}`);
    this.name = "InvalidOutputFormatError";
    this.outputFormat = outputFormat;
    this.validFormats = validFormats;
  }
}
