/**
 * Plan storage and validation for rfapps CLI
 *
 * Handles saving, loading, and validating deployment plans.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { logDebug, logWarn } from "@rfmedia/common";

import type { DeploymentPlan, PlanValidation } from "../types/plan.js";
import {
  MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
  MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
  type ManagedUpdateDriftEvidence,
  type ManagedUpdateCleanupFailure,
  type ManagedUpdateError,
  type ManagedUpdateObservedIdentity,
  type ManagedUpdatePlan,
  type ManagedUpdatePlanService,
  type ManagedUpdateResult,
  type ManagedUpdateRestoreEvidence,
  type ManagedUpdateServiceResult,
  type ManagedUpdateVerificationEvidence,
  type ManagedUpdateVerificationFailed,
  type ManagedUpdateVerificationPassed,
} from "../types/update.js";
import { aggregateManagedUpdateStatus } from "./managed-update.js";
import { redactManagedMessage } from "./managed-redaction.js";

/**
 * Default plan directory
 */
const DEFAULT_PLAN_DIR = ".rfapps/plans";

/**
 * Maximum number of plans to keep (older plans are deleted)
 */
const MAX_PLANS = 50;

/** Maximum encoded size accepted for a managed plan or report. */
export const MAX_MANAGED_ARTIFACT_BYTES = 1024 * 1024;

const MAX_PATH_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_VALUE_LENGTH = 4096;
const MAX_MESSAGE_LENGTH = 2048;
const MAX_MANAGED_SERVICES = 512;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type ManagedArtifactStorageErrorCode =
  | "MANAGED_ARTIFACT_INVALID"
  | "MANAGED_ARTIFACT_TOO_LARGE"
  | "MANAGED_ARTIFACT_PATH_UNSAFE"
  | "MANAGED_ARTIFACT_EXISTS"
  | "MANAGED_ARTIFACT_IO_ERROR";

/** Typed failure raised by the fail-closed managed artifact boundary. */
export class ManagedArtifactStorageError extends Error {
  override readonly name = "ManagedArtifactStorageError";

  constructor(
    message: string,
    readonly code: ManagedArtifactStorageErrorCode,
    readonly artifactPath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ManagedArtifactWriteOptions {
  /** Existing regular files are rejected unless overwrite is explicitly enabled. */
  readonly overwrite?: boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function invalidArtifact(message: string, artifactPath?: string): ManagedArtifactStorageError {
  return new ManagedArtifactStorageError(message, "MANAGED_ARTIFACT_INVALID", artifactPath);
}

function unsafeArtifactPath(
  message: string,
  artifactPath?: string,
  cause?: unknown,
): ManagedArtifactStorageError {
  return new ManagedArtifactStorageError(message, "MANAGED_ARTIFACT_PATH_UNSAFE", artifactPath, {
    cause,
  });
}

function artifactIoError(
  message: string,
  artifactPath: string,
  cause: unknown,
): ManagedArtifactStorageError {
  return new ManagedArtifactStorageError(message, "MANAGED_ARTIFACT_IO_ERROR", artifactPath, {
    cause,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidArtifact(`${field} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const unknownKey = keys.find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw invalidArtifact(`${field} contains unsupported field ${unknownKey}`);
  }
  const missingKey = required.find((key) => !Object.hasOwn(value, key));
  if (missingKey !== undefined) {
    throw invalidArtifact(`${field} is missing required field ${missingKey}`);
  }
}

function assertString(
  value: unknown,
  field: string,
  options: { max?: number; allowEmpty?: boolean } = {},
): asserts value is string {
  const max = options.max ?? MAX_VALUE_LENGTH;
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    value.length > max ||
    value.includes("\0")
  ) {
    throw invalidArtifact(`${field} must be a bounded string`);
  }
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  assertString(value, field, { max: MAX_IDENTIFIER_LENGTH });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(value)) {
    throw invalidArtifact(`${field} contains unsupported characters`);
  }
}

function assertServiceName(value: unknown, field: string): asserts value is string {
  assertString(value, field, { max: MAX_IDENTIFIER_LENGTH });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) {
    throw invalidArtifact(`${field} is not a safe Compose service name`);
  }
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidArtifact(`${field} must be a finite non-negative number`);
  }
}

function assertSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidArtifact(`${field} must be a non-negative safe integer`);
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw invalidArtifact(`${field} must be a boolean`);
  }
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertString(value, field, { max: 40 });
  if (!Number.isFinite(Date.parse(value))) {
    throw invalidArtifact(`${field} must be an ISO timestamp`);
  }
}

function assertStringArray(
  value: unknown,
  field: string,
  itemValidator: (item: unknown, itemField: string) => asserts item is string = assertString,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_MANAGED_SERVICES) {
    throw invalidArtifact(`${field} must be a bounded array`);
  }
  value.forEach((item, index) => itemValidator(item, `${field}[${index}]`));
}

function assertOptionalString(value: unknown, field: string, max = MAX_VALUE_LENGTH): void {
  if (value !== undefined) {
    assertString(value, field, { max });
  }
}

function assertOptionalSafeInteger(value: unknown, field: string): void {
  if (value !== undefined) {
    assertSafeInteger(value, field);
  }
}

function assertOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidArtifact(`${field} has an unsupported value`);
  }
}

function assertFingerprint(value: unknown, field: string): asserts value is string {
  assertString(value, field, { max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidArtifact(`${field} must be a SHA-256 fingerprint`);
  }
}

function assertReviewedIdentity(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(
    value,
    ["configuredImage"],
    ["platform", "currentImageId", "currentDigest", "proposedDigest"],
    field,
  );
  assertString(value["configuredImage"], `${field}.configuredImage`);
  assertOptionalString(value["platform"], `${field}.platform`, MAX_IDENTIFIER_LENGTH);
  assertOptionalString(value["currentImageId"], `${field}.currentImageId`);
  assertOptionalString(value["currentDigest"], `${field}.currentDigest`);
  assertOptionalString(value["proposedDigest"], `${field}.proposedDigest`);
}

function assertManagedPlanService(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(
    value,
    [
      "service",
      "resolvedConfigFingerprint",
      "status",
      "configuredImage",
      "recoveryEligible",
      "verification",
    ],
    [
      "platform",
      "currentImageId",
      "currentDigest",
      "proposedDigest",
      "recoveryGeneration",
      "errorCode",
      "message",
    ],
    field,
  );
  assertServiceName(value["service"], `${field}.service`);
  assertFingerprint(value["resolvedConfigFingerprint"], `${field}.resolvedConfigFingerprint`);
  assertOneOf(
    value["status"],
    ["update-available", "up-to-date", "unsupported", "local-missing", "unknown"] as const,
    `${field}.status`,
  );
  assertString(value["configuredImage"], `${field}.configuredImage`);
  assertOptionalString(value["platform"], `${field}.platform`, MAX_IDENTIFIER_LENGTH);
  assertOptionalString(value["currentImageId"], `${field}.currentImageId`);
  assertOptionalString(value["currentDigest"], `${field}.currentDigest`);
  assertOptionalString(value["proposedDigest"], `${field}.proposedDigest`);
  assertOptionalSafeInteger(value["recoveryGeneration"], `${field}.recoveryGeneration`);
  assertBoolean(value["recoveryEligible"], `${field}.recoveryEligible`);
  assertOneOf(
    value["verification"],
    ["healthcheck", "running-only"] as const,
    `${field}.verification`,
  );
  if (value["errorCode"] !== undefined) {
    assertIdentifier(value["errorCode"], `${field}.errorCode`);
  }
  assertOptionalString(value["message"], `${field}.message`, MAX_MESSAGE_LENGTH);
}

function assertManagedUpdatePlan(value: unknown): asserts value is ManagedUpdatePlan {
  assertRecord(value, "Managed update plan");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "intent",
      "id",
      "createdAt",
      "composeHash",
      "composePath",
      "dockerContextFingerprint",
      "envSourceFingerprint",
      "composeProjectName",
      "targetServices",
      "applyPolicy",
      "restorePolicy",
      "services",
    ],
    ["profiles"],
    "Managed update plan",
  );
  if (value["schemaVersion"] !== MANAGED_UPDATE_PLAN_SCHEMA_VERSION) {
    throw invalidArtifact("Managed update plan has an unsupported schemaVersion");
  }
  if (value["intent"] !== "managed-update") {
    throw invalidArtifact("Managed update plan has an unsupported intent");
  }
  assertIdentifier(value["id"], "Managed update plan.id");
  assertIsoDate(value["createdAt"], "Managed update plan.createdAt");
  assertString(value["composeHash"], "Managed update plan.composeHash", { max: 128 });
  assertString(value["composePath"], "Managed update plan.composePath", {
    max: MAX_PATH_LENGTH,
  });
  assertString(value["dockerContextFingerprint"], "Managed update plan.dockerContextFingerprint", {
    max: MAX_IDENTIFIER_LENGTH,
  });
  assertFingerprint(value["envSourceFingerprint"], "Managed update plan.envSourceFingerprint");
  assertIdentifier(value["composeProjectName"], "Managed update plan.composeProjectName");
  assertStringArray(
    value["targetServices"],
    "Managed update plan.targetServices",
    assertServiceName,
  );
  if (value["profiles"] !== undefined) {
    assertStringArray(value["profiles"], "Managed update plan.profiles", assertIdentifier);
  }
  if (value["applyPolicy"] !== "sequential") {
    throw invalidArtifact("Managed update plan.applyPolicy must be sequential");
  }
  assertOneOf(
    value["restorePolicy"],
    ["restore-on-failure", "no-restore-on-failure"] as const,
    "Managed update plan.restorePolicy",
  );
  if (!Array.isArray(value["services"]) || value["services"].length > MAX_MANAGED_SERVICES) {
    throw invalidArtifact("Managed update plan.services must be a bounded array");
  }
  value["services"].forEach((service, index) =>
    assertManagedPlanService(service, `Managed update plan.services[${index}]`),
  );
  const targets = value["targetServices"];
  const serviceNames = value["services"].map((service) => {
    assertRecord(service, "Managed update plan service");
    return service["service"];
  });
  if (
    new Set(targets).size !== targets.length ||
    new Set(serviceNames).size !== serviceNames.length ||
    targets.length !== serviceNames.length ||
    targets.some((target) => !serviceNames.includes(target))
  ) {
    throw invalidArtifact("Managed update plan targetServices must exactly match unique services");
  }
}

function assertDriftEvidence(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(value, ["kind"], ["expected", "observed"], field);
  assertOneOf(
    value["kind"],
    [
      "compose",
      "docker-context",
      "env-source",
      "resolved-config",
      "scope",
      "platform",
      "current-image",
      "proposed-digest",
      "recovery-generation",
    ] as const,
    `${field}.kind`,
  );
  assertOptionalString(value["expected"], `${field}.expected`);
  assertOptionalString(value["observed"], `${field}.observed`);
}

function assertManagedError(value: unknown, field: string): void {
  assertRecord(value, field);
  if (value["kind"] === "lifecycle") {
    assertExactKeys(value, ["kind", "stage", "code", "message"], [], field);
  } else if (value["kind"] === "drift") {
    assertExactKeys(value, ["kind", "stage", "code", "message", "drift"], [], field);
    if (value["stage"] !== "validate") {
      throw invalidArtifact(`${field}.stage must be validate for drift errors`);
    }
    assertDriftEvidence(value["drift"], `${field}.drift`);
  } else {
    throw invalidArtifact(`${field}.kind has an unsupported value`);
  }
  assertOneOf(
    value["stage"],
    [
      "detect",
      "validate",
      "snapshot",
      "pull",
      "recreate",
      "verify_update",
      "restore",
      "verify_restore",
      "record",
      "complete",
      "interrupted",
    ] as const,
    `${field}.stage`,
  );
  assertIdentifier(value["code"], `${field}.code`);
  assertString(value["message"], `${field}.message`, { max: MAX_MESSAGE_LENGTH });
}

function assertObservedIdentity(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(
    value,
    ["configuredImage"],
    ["containerId", "imageId", "digest", "platform"],
    field,
  );
  assertString(value["configuredImage"], `${field}.configuredImage`);
  assertOptionalString(value["containerId"], `${field}.containerId`);
  assertOptionalString(value["imageId"], `${field}.imageId`);
  assertOptionalString(value["digest"], `${field}.digest`);
  assertOptionalString(value["platform"], `${field}.platform`, MAX_IDENTIFIER_LENGTH);
}

function assertVerificationPassed(value: Record<string, unknown>, field: string): void {
  assertExactKeys(
    value,
    [
      "status",
      "assurance",
      "expectedImageId",
      "observedImageId",
      "runtimeState",
      "dockerHealth",
      "dependenciesReady",
      "elapsedMs",
    ],
    [],
    field,
  );
  assertOneOf(value["assurance"], ["healthcheck", "running-only"] as const, `${field}.assurance`);
  assertString(value["expectedImageId"], `${field}.expectedImageId`);
  assertString(value["observedImageId"], `${field}.observedImageId`);
  if (value["runtimeState"] !== "running") {
    throw invalidArtifact(`${field}.runtimeState must be running`);
  }
  assertOneOf(
    value["dockerHealth"],
    ["healthy", "not-configured"] as const,
    `${field}.dockerHealth`,
  );
  if (value["dependenciesReady"] !== true) {
    throw invalidArtifact(`${field}.dependenciesReady must be true`);
  }
  assertFiniteNonNegative(value["elapsedMs"], `${field}.elapsedMs`);
}

function assertVerificationFailed(value: Record<string, unknown>, field: string): void {
  assertExactKeys(
    value,
    [
      "status",
      "assurance",
      "runtimeState",
      "dockerHealth",
      "dependenciesReady",
      "elapsedMs",
      "error",
    ],
    ["expectedImageId", "observedImageId"],
    field,
  );
  assertOneOf(value["assurance"], ["healthcheck", "running-only"] as const, `${field}.assurance`);
  assertOptionalString(value["expectedImageId"], `${field}.expectedImageId`);
  assertOptionalString(value["observedImageId"], `${field}.observedImageId`);
  assertOneOf(
    value["runtimeState"],
    ["running", "restarting", "exited", "missing", "unknown"] as const,
    `${field}.runtimeState`,
  );
  assertOneOf(
    value["dockerHealth"],
    ["healthy", "unhealthy", "starting", "not-configured", "unknown"] as const,
    `${field}.dockerHealth`,
  );
  assertBoolean(value["dependenciesReady"], `${field}.dependenciesReady`);
  assertFiniteNonNegative(value["elapsedMs"], `${field}.elapsedMs`);
  assertManagedError(value["error"], `${field}.error`);
}

function assertVerification(value: unknown, field: string): void {
  assertRecord(value, field);
  if (value["status"] === "not-run") {
    assertExactKeys(value, ["status", "assurance", "reasonCode"], [], field);
    if (value["assurance"] !== "none") {
      throw invalidArtifact(`${field}.assurance must be none when verification was not run`);
    }
    assertIdentifier(value["reasonCode"], `${field}.reasonCode`);
    return;
  }
  if (value["status"] === "passed") {
    assertVerificationPassed(value, field);
    return;
  }
  if (value["status"] === "failed") {
    assertVerificationFailed(value, field);
    return;
  }
  throw invalidArtifact(`${field}.status has an unsupported value`);
}

function assertRestore(value: unknown, field: string): void {
  assertRecord(value, field);
  switch (value["status"]) {
    case "not-required":
      assertExactKeys(value, ["status"], [], field);
      return;
    case "disabled":
      assertExactKeys(value, ["status", "reasonCode"], [], field);
      assertIdentifier(value["reasonCode"], `${field}.reasonCode`);
      return;
    case "unavailable":
      assertExactKeys(value, ["status", "reasonCode"], ["message"], field);
      assertIdentifier(value["reasonCode"], `${field}.reasonCode`);
      assertOptionalString(value["message"], `${field}.message`, MAX_MESSAGE_LENGTH);
      return;
    case "succeeded":
      assertExactKeys(
        value,
        ["status", "imageId", "generation", "verification", "elapsedMs"],
        [],
        field,
      );
      assertString(value["imageId"], `${field}.imageId`);
      assertSafeInteger(value["generation"], `${field}.generation`);
      assertRecord(value["verification"], `${field}.verification`);
      if (value["verification"]["status"] !== "passed") {
        throw invalidArtifact(`${field}.verification must be passed for a successful restore`);
      }
      assertVerificationPassed(value["verification"], `${field}.verification`);
      assertFiniteNonNegative(value["elapsedMs"], `${field}.elapsedMs`);
      return;
    case "failed":
      assertExactKeys(
        value,
        ["status", "elapsedMs", "error"],
        ["imageId", "generation", "verification"],
        field,
      );
      assertOptionalString(value["imageId"], `${field}.imageId`);
      assertOptionalSafeInteger(value["generation"], `${field}.generation`);
      if (value["verification"] !== undefined) {
        assertRecord(value["verification"], `${field}.verification`);
        if (value["verification"]["status"] !== "failed") {
          throw invalidArtifact(`${field}.verification must be failed for a failed restore`);
        }
        assertVerificationFailed(value["verification"], `${field}.verification`);
      }
      assertFiniteNonNegative(value["elapsedMs"], `${field}.elapsedMs`);
      assertManagedError(value["error"], `${field}.error`);
      return;
    default:
      throw invalidArtifact(`${field}.status has an unsupported value`);
  }
}

function assertGenerationEvidence(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(value, [], ["before", "after", "restored"], field);
  assertOptionalSafeInteger(value["before"], `${field}.before`);
  assertOptionalSafeInteger(value["after"], `${field}.after`);
  assertOptionalSafeInteger(value["restored"], `${field}.restored`);
}

function assertManagedServiceResult(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(
    value,
    [
      "service",
      "outcome",
      "stage",
      "reviewedIdentity",
      "verification",
      "restore",
      "generations",
      "durationMs",
    ],
    ["observedIdentity", "error"],
    field,
  );
  assertServiceName(value["service"], `${field}.service`);
  assertOneOf(
    value["outcome"],
    [
      "up_to_date",
      "unsupported",
      "detection_unknown",
      "blocked",
      "planned",
      "cancelled",
      "updated",
      "restored",
      "update_failed",
      "restore_failed",
      "interrupted",
    ] as const,
    `${field}.outcome`,
  );
  assertOneOf(
    value["stage"],
    [
      "detect",
      "validate",
      "snapshot",
      "pull",
      "recreate",
      "verify_update",
      "restore",
      "verify_restore",
      "record",
      "complete",
      "interrupted",
    ] as const,
    `${field}.stage`,
  );
  assertReviewedIdentity(value["reviewedIdentity"], `${field}.reviewedIdentity`);
  if (value["observedIdentity"] !== undefined) {
    assertObservedIdentity(value["observedIdentity"], `${field}.observedIdentity`);
  }
  assertVerification(value["verification"], `${field}.verification`);
  assertRestore(value["restore"], `${field}.restore`);
  assertGenerationEvidence(value["generations"], `${field}.generations`);
  assertFiniteNonNegative(value["durationMs"], `${field}.durationMs`);
  if (value["error"] !== undefined) {
    assertManagedError(value["error"], `${field}.error`);
  }
}

function assertManagedSummary(
  value: unknown,
  field: string,
): asserts value is ManagedUpdateResult["summary"] {
  assertRecord(value, field);
  const keys = [
    "selected",
    "actionable",
    "updated",
    "restored",
    "upToDate",
    "unsupported",
    "unknown",
    "blocked",
    "failed",
    "interrupted",
  ] as const;
  assertExactKeys(value, keys, [], field);
  keys.forEach((key) => assertSafeInteger(value[key], `${field}.${key}`));
}

function expectedManagedResultAggregate(
  summary: ManagedUpdateResult["summary"],
  applied: boolean,
  cleanupFailed: boolean,
): Pick<ManagedUpdateResult, "status" | "success" | "exitCode"> {
  const aggregate = aggregateManagedUpdateStatus(summary, applied);

  if (cleanupFailed && aggregate.success) {
    return { status: applied ? "partial" : "failed", success: false, exitCode: 1 };
  }
  return aggregate;
}

function assertCleanupFailure(value: unknown, field: string): void {
  assertRecord(value, field);
  assertExactKeys(value, ["operation", "code", "message"], [], field);
  assertOneOf(
    value["operation"],
    ["lock-release", "state-close", "filesystem-cleanup"] as const,
    `${field}.operation`,
  );
  if (value["code"] !== "CLEANUP_FAILED") {
    throw invalidArtifact(`${field}.code must be CLEANUP_FAILED`);
  }
  assertString(value["message"], `${field}.message`, { max: MAX_MESSAGE_LENGTH });
}

function assertManagedUpdateResult(value: unknown): asserts value is ManagedUpdateResult {
  assertRecord(value, "Managed update result");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "runId",
      "planId",
      "startedAt",
      "completedAt",
      "status",
      "success",
      "exitCode",
      "applied",
      "restoreOnFailure",
      "summary",
      "services",
    ],
    ["interruption", "cleanupFailures"],
    "Managed update result",
  );
  if (value["schemaVersion"] !== MANAGED_UPDATE_RESULT_SCHEMA_VERSION) {
    throw invalidArtifact("Managed update result has an unsupported schemaVersion");
  }
  assertIdentifier(value["runId"], "Managed update result.runId");
  assertIdentifier(value["planId"], "Managed update result.planId");
  assertIsoDate(value["startedAt"], "Managed update result.startedAt");
  assertIsoDate(value["completedAt"], "Managed update result.completedAt");
  assertOneOf(
    value["status"],
    ["no_updates", "succeeded", "recovered_failure", "partial", "failed", "interrupted"] as const,
    "Managed update result.status",
  );
  assertBoolean(value["success"], "Managed update result.success");
  if (value["exitCode"] !== 0 && value["exitCode"] !== 1 && value["exitCode"] !== 2) {
    throw invalidArtifact("Managed update result.exitCode must be 0, 1, or 2");
  }
  assertBoolean(value["applied"], "Managed update result.applied");
  assertBoolean(value["restoreOnFailure"], "Managed update result.restoreOnFailure");
  const summary = value["summary"];
  assertManagedSummary(summary, "Managed update result.summary");
  if (!Array.isArray(value["services"]) || value["services"].length > MAX_MANAGED_SERVICES) {
    throw invalidArtifact("Managed update result.services must be a bounded array");
  }
  value["services"].forEach((service, index) =>
    assertManagedServiceResult(service, `Managed update result.services[${index}]`),
  );
  const serviceNames = value["services"].map((service) => {
    assertRecord(service, "Managed update service result");
    return service["service"];
  });
  if (new Set(serviceNames).size !== serviceNames.length) {
    throw invalidArtifact("Managed update result services must be unique");
  }
  if (summary.selected !== value["services"].length) {
    throw invalidArtifact("Managed update result summary.selected must match services.length");
  }
  const outcomes = value["services"].map((service) => {
    assertRecord(service, "Managed update service result");
    return service["outcome"];
  });
  const expectedCounters = {
    updated: outcomes.filter((outcome) => outcome === "updated").length,
    restored: outcomes.filter((outcome) => outcome === "restored").length,
    upToDate: outcomes.filter((outcome) => outcome === "up_to_date").length,
    unsupported: outcomes.filter((outcome) => outcome === "unsupported").length,
    unknown: outcomes.filter((outcome) => outcome === "detection_unknown").length,
    blocked: outcomes.filter((outcome) => outcome === "blocked").length,
    failed: outcomes.filter(
      (outcome) => outcome === "update_failed" || outcome === "restore_failed",
    ).length,
    interrupted: outcomes.filter((outcome) => outcome === "interrupted").length,
  } satisfies Omit<ManagedUpdateResult["summary"], "selected" | "actionable">;
  for (const [counter, expected] of Object.entries(expectedCounters)) {
    if (summary[counter as keyof typeof expectedCounters] !== expected) {
      throw invalidArtifact(`Managed update result summary.${counter} must match service outcomes`);
    }
  }
  const definitelyActionable = outcomes.filter((outcome) =>
    [
      "planned",
      "cancelled",
      "updated",
      "restored",
      "update_failed",
      "restore_failed",
      "interrupted",
    ].includes(String(outcome)),
  ).length;
  if (
    summary.actionable < definitelyActionable ||
    summary.actionable > definitelyActionable + summary.blocked
  ) {
    throw invalidArtifact(
      "Managed update result summary.actionable is inconsistent with service outcomes",
    );
  }
  const definiteMutationOutcomes = outcomes.filter((outcome) =>
    ["updated", "restored", "update_failed", "restore_failed"].includes(String(outcome)),
  ).length;
  const interruptedOutcomes = outcomes.filter((outcome) => outcome === "interrupted").length;
  if (value["applied"] === false && definiteMutationOutcomes > 0) {
    throw invalidArtifact(
      "Managed update result cannot contain mutation outcomes when not applied",
    );
  }
  if (value["applied"] === true && definiteMutationOutcomes === 0 && interruptedOutcomes === 0) {
    throw invalidArtifact("Managed update result applied flag requires a mutation outcome");
  }
  if (value["interruption"] !== undefined) {
    const interruption = value["interruption"];
    assertRecord(interruption, "Managed update result.interruption");
    assertExactKeys(
      interruption,
      ["signal", "stage", "stabilized"],
      ["service"],
      "Managed update result.interruption",
    );
    assertOneOf(
      interruption["signal"],
      ["SIGINT", "SIGTERM"] as const,
      "Managed update result.interruption.signal",
    );
    assertOneOf(
      interruption["stage"],
      [
        "detect",
        "validate",
        "snapshot",
        "pull",
        "recreate",
        "verify_update",
        "restore",
        "verify_restore",
        "record",
        "complete",
        "interrupted",
      ] as const,
      "Managed update result.interruption.stage",
    );
    if (interruption["service"] !== undefined) {
      assertServiceName(interruption["service"], "Managed update result.interruption.service");
    }
    assertBoolean(interruption["stabilized"], "Managed update result.interruption.stabilized");
  }
  if (value["cleanupFailures"] !== undefined) {
    if (
      !Array.isArray(value["cleanupFailures"]) ||
      value["cleanupFailures"].length === 0 ||
      value["cleanupFailures"].length > 3
    ) {
      throw invalidArtifact("Managed update result.cleanupFailures must be a bounded array");
    }
    value["cleanupFailures"].forEach((failure, index) =>
      assertCleanupFailure(failure, `Managed update result.cleanupFailures[${index}]`),
    );
  }
  const expectedAggregate = expectedManagedResultAggregate(
    summary,
    value["applied"],
    value["cleanupFailures"] !== undefined,
  );
  if (
    value["status"] !== expectedAggregate.status ||
    value["success"] !== expectedAggregate.success ||
    value["exitCode"] !== expectedAggregate.exitCode
  ) {
    throw invalidArtifact(
      "Managed update result status, success, and exitCode must match aggregate service outcomes",
    );
  }
}

function copyDriftEvidence(drift: ManagedUpdateDriftEvidence): ManagedUpdateDriftEvidence {
  return {
    kind: drift.kind,
    ...(drift.expected === undefined ? {} : { expected: drift.expected }),
    ...(drift.observed === undefined ? {} : { observed: drift.observed }),
  };
}

function copyManagedError(error: ManagedUpdateError): ManagedUpdateError {
  if (error.kind === "drift") {
    return {
      kind: "drift",
      stage: "validate",
      code: error.code,
      message: redactManagedMessage(error.message),
      drift: copyDriftEvidence(error.drift),
    };
  }
  return {
    kind: "lifecycle",
    stage: error.stage,
    code: error.code,
    message: redactManagedMessage(error.message),
  };
}

function copyReviewedIdentity(
  identity: ManagedUpdatePlanService | ManagedUpdateServiceResult["reviewedIdentity"],
): ManagedUpdateServiceResult["reviewedIdentity"] {
  return {
    configuredImage: identity.configuredImage,
    ...(identity.platform === undefined ? {} : { platform: identity.platform }),
    ...(identity.currentImageId === undefined ? {} : { currentImageId: identity.currentImageId }),
    ...(identity.currentDigest === undefined ? {} : { currentDigest: identity.currentDigest }),
    ...(identity.proposedDigest === undefined ? {} : { proposedDigest: identity.proposedDigest }),
  };
}

function copyObservedIdentity(
  identity: ManagedUpdateObservedIdentity,
): ManagedUpdateObservedIdentity {
  return {
    configuredImage: identity.configuredImage,
    ...(identity.containerId === undefined ? {} : { containerId: identity.containerId }),
    ...(identity.imageId === undefined ? {} : { imageId: identity.imageId }),
    ...(identity.digest === undefined ? {} : { digest: identity.digest }),
    ...(identity.platform === undefined ? {} : { platform: identity.platform }),
  };
}

function copyVerificationPassed(
  verification: ManagedUpdateVerificationPassed,
): ManagedUpdateVerificationPassed {
  return {
    status: "passed",
    assurance: verification.assurance,
    expectedImageId: verification.expectedImageId,
    observedImageId: verification.observedImageId,
    runtimeState: "running",
    dockerHealth: verification.dockerHealth,
    dependenciesReady: true,
    elapsedMs: verification.elapsedMs,
  };
}

function copyVerificationFailed(
  verification: ManagedUpdateVerificationFailed,
): ManagedUpdateVerificationFailed {
  return {
    status: "failed",
    assurance: verification.assurance,
    ...(verification.expectedImageId === undefined
      ? {}
      : { expectedImageId: verification.expectedImageId }),
    ...(verification.observedImageId === undefined
      ? {}
      : { observedImageId: verification.observedImageId }),
    runtimeState: verification.runtimeState,
    dockerHealth: verification.dockerHealth,
    dependenciesReady: verification.dependenciesReady,
    elapsedMs: verification.elapsedMs,
    error: copyManagedError(verification.error),
  };
}

function copyVerification(
  verification: ManagedUpdateVerificationEvidence,
): ManagedUpdateVerificationEvidence {
  switch (verification.status) {
    case "not-run":
      return {
        status: "not-run",
        assurance: "none",
        reasonCode: verification.reasonCode,
      };
    case "passed":
      return copyVerificationPassed(verification);
    case "failed":
      return copyVerificationFailed(verification);
  }
}

function copyRestore(restore: ManagedUpdateRestoreEvidence): ManagedUpdateRestoreEvidence {
  switch (restore.status) {
    case "not-required":
      return { status: "not-required" };
    case "disabled":
      return { status: "disabled", reasonCode: restore.reasonCode };
    case "unavailable":
      return {
        status: "unavailable",
        reasonCode: restore.reasonCode,
        ...(restore.message === undefined
          ? {}
          : { message: redactManagedMessage(restore.message) }),
      };
    case "succeeded":
      return {
        status: "succeeded",
        imageId: restore.imageId,
        generation: restore.generation,
        verification: copyVerificationPassed(restore.verification),
        elapsedMs: restore.elapsedMs,
      };
    case "failed":
      return {
        status: "failed",
        ...(restore.imageId === undefined ? {} : { imageId: restore.imageId }),
        ...(restore.generation === undefined ? {} : { generation: restore.generation }),
        ...(restore.verification === undefined
          ? {}
          : { verification: copyVerificationFailed(restore.verification) }),
        elapsedMs: restore.elapsedMs,
        error: copyManagedError(restore.error),
      };
  }
}

function toPersistedManagedPlan(plan: ManagedUpdatePlan): ManagedUpdatePlan {
  return {
    schemaVersion: MANAGED_UPDATE_PLAN_SCHEMA_VERSION,
    intent: "managed-update",
    id: plan.id,
    createdAt: plan.createdAt,
    composeHash: plan.composeHash,
    composePath: plan.composePath,
    ...(plan.profiles === undefined ? {} : { profiles: [...plan.profiles] }),
    dockerContextFingerprint: plan.dockerContextFingerprint,
    envSourceFingerprint: plan.envSourceFingerprint,
    composeProjectName: plan.composeProjectName,
    targetServices: [...plan.targetServices],
    applyPolicy: "sequential",
    restorePolicy: plan.restorePolicy,
    services: plan.services.map((service) => ({
      service: service.service,
      resolvedConfigFingerprint: service.resolvedConfigFingerprint,
      status: service.status,
      ...copyReviewedIdentity(service),
      ...(service.recoveryGeneration === undefined
        ? {}
        : { recoveryGeneration: service.recoveryGeneration }),
      recoveryEligible: service.recoveryEligible,
      verification: service.verification,
      ...(service.errorCode === undefined ? {} : { errorCode: service.errorCode }),
      ...(service.message === undefined ? {} : { message: redactManagedMessage(service.message) }),
    })),
  };
}

function toPersistedManagedResult(result: ManagedUpdateResult): ManagedUpdateResult {
  return {
    schemaVersion: MANAGED_UPDATE_RESULT_SCHEMA_VERSION,
    runId: result.runId,
    planId: result.planId,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    status: result.status,
    success: result.success,
    exitCode: result.exitCode,
    applied: result.applied,
    restoreOnFailure: result.restoreOnFailure,
    summary: { ...result.summary },
    services: result.services.map((service) => ({
      service: service.service,
      outcome: service.outcome,
      stage: service.stage,
      reviewedIdentity: copyReviewedIdentity(service.reviewedIdentity),
      ...(service.observedIdentity === undefined
        ? {}
        : { observedIdentity: copyObservedIdentity(service.observedIdentity) }),
      verification: copyVerification(service.verification),
      restore: copyRestore(service.restore),
      generations: { ...service.generations },
      durationMs: service.durationMs,
      ...(service.error === undefined ? {} : { error: copyManagedError(service.error) }),
    })),
    ...(result.interruption === undefined
      ? {}
      : {
          interruption: {
            signal: result.interruption.signal,
            stage: result.interruption.stage,
            ...(result.interruption.service === undefined
              ? {}
              : { service: result.interruption.service }),
            stabilized: result.interruption.stabilized,
          },
        }),
    ...(result.cleanupFailures === undefined
      ? {}
      : {
          cleanupFailures: result.cleanupFailures.map(
            (failure): ManagedUpdateCleanupFailure => ({
              operation: failure.operation,
              code: "CLEANUP_FAILED",
              message: redactManagedMessage(failure.message, MAX_MESSAGE_LENGTH),
            }),
          ),
        }),
  };
}

function validateArtifactPath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.length > MAX_PATH_LENGTH ||
    inputPath.includes("\0") ||
    inputPath.split(/[\\/]/u).includes("..")
  ) {
    throw unsafeArtifactPath("Managed artifact path is empty, unbounded, or contains traversal");
  }
  const artifactPath = resolve(inputPath);
  if (basename(artifactPath).length === 0 || artifactPath === parse(artifactPath).root) {
    throw unsafeArtifactPath("Managed artifact path must identify a file", artifactPath);
  }
  return artifactPath;
}

async function assertNoSymlinkComponents(inputPath: string): Promise<void> {
  const artifactPath = resolve(inputPath);
  const root = parse(artifactPath).root;
  const components: string[] = [];
  let cursor = artifactPath;
  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.push(root);

  for (const component of components.reverse()) {
    try {
      const componentStat = await lstat(component);
      if (componentStat.isSymbolicLink()) {
        throw unsafeArtifactPath(
          `Managed artifact path contains a symbolic link: ${component}`,
          artifactPath,
        );
      }
    } catch (error) {
      if (error instanceof ManagedArtifactStorageError) {
        throw error;
      }
      if (!hasCode(error, "ENOENT")) {
        throw unsafeArtifactPath(
          `Managed artifact path cannot be inspected safely: ${component}`,
          artifactPath,
          error,
        );
      }
    }
  }
}

async function ensurePrivateArtifactDirectory(artifactPath: string): Promise<void> {
  const artifactDir = dirname(artifactPath);
  await assertNoSymlinkComponents(artifactDir);
  try {
    await mkdir(artifactDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    throw artifactIoError("Unable to create managed artifact directory", artifactPath, error);
  }
  await assertNoSymlinkComponents(artifactDir);
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await open(
      artifactDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const directoryStat = await directoryHandle.stat();
    if (!directoryStat.isDirectory()) {
      throw unsafeArtifactPath("Managed artifact parent must be a real directory", artifactPath);
    }
    if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
      throw unsafeArtifactPath(
        "Managed artifact parent must be owned by the current user",
        artifactPath,
      );
    }
    await directoryHandle.chmod(PRIVATE_DIRECTORY_MODE);
    if (((await directoryHandle.stat()).mode & 0o077) !== 0) {
      throw unsafeArtifactPath(
        "Managed artifact parent permissions could not be restricted",
        artifactPath,
      );
    }
  } catch (error) {
    if (error instanceof ManagedArtifactStorageError) throw error;
    throw unsafeArtifactPath(
      "Managed artifact parent could not be opened and restricted safely",
      artifactPath,
      error,
    );
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function inspectExistingArtifact(artifactPath: string, overwrite: boolean): Promise<void> {
  try {
    const artifactStat = await lstat(artifactPath);
    if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
      throw unsafeArtifactPath(
        "Managed artifact output must be a regular file and not a symbolic link",
        artifactPath,
      );
    }
    if (!overwrite) {
      throw new ManagedArtifactStorageError(
        "Managed artifact already exists; enable overwrite explicitly to replace it",
        "MANAGED_ARTIFACT_EXISTS",
        artifactPath,
      );
    }
  } catch (error) {
    if (error instanceof ManagedArtifactStorageError) {
      throw error;
    }
    if (!hasCode(error, "ENOENT")) {
      throw unsafeArtifactPath("Managed artifact output cannot be inspected", artifactPath, error);
    }
  }
}

async function writeManagedArtifact(
  inputPath: string,
  value: ManagedUpdatePlan | ManagedUpdateResult,
  options: ManagedArtifactWriteOptions,
): Promise<string> {
  const artifactPath = validateArtifactPath(inputPath);
  await ensurePrivateArtifactDirectory(artifactPath);
  await assertNoSymlinkComponents(artifactPath);
  await inspectExistingArtifact(artifactPath, options.overwrite === true);

  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf-8") > MAX_MANAGED_ARTIFACT_BYTES) {
    throw new ManagedArtifactStorageError(
      "Managed artifact exceeds the supported size",
      "MANAGED_ARTIFACT_TOO_LARGE",
      artifactPath,
    );
  }

  const tempPath = join(dirname(artifactPath), `.${basename(artifactPath)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, artifactPath);
    await chmod(artifactPath, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    if (error instanceof ManagedArtifactStorageError) {
      throw error;
    }
    throw artifactIoError("Unable to write managed artifact atomically", artifactPath, error);
  }
  return artifactPath;
}

async function readManagedArtifact(inputPath: string): Promise<unknown> {
  const artifactPath = validateArtifactPath(inputPath);
  await assertNoSymlinkComponents(artifactPath);
  let handle: FileHandle | undefined;
  try {
    const pathStat = await lstat(artifactPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw unsafeArtifactPath(
        "Managed artifact input must be a regular file and not a symbolic link",
        artifactPath,
      );
    }
    if (pathStat.size > MAX_MANAGED_ARTIFACT_BYTES) {
      throw new ManagedArtifactStorageError(
        "Managed artifact exceeds the supported size",
        "MANAGED_ARTIFACT_TOO_LARGE",
        artifactPath,
      );
    }
    handle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat();
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw unsafeArtifactPath("Managed artifact changed while it was being opened", artifactPath);
    }
    const content = await handle.readFile("utf-8");
    if (Buffer.byteLength(content, "utf-8") > MAX_MANAGED_ARTIFACT_BYTES) {
      throw new ManagedArtifactStorageError(
        "Managed artifact exceeds the supported size",
        "MANAGED_ARTIFACT_TOO_LARGE",
        artifactPath,
      );
    }
    try {
      return JSON.parse(content) as unknown;
    } catch (error) {
      throw new ManagedArtifactStorageError(
        "Managed artifact contains malformed JSON",
        "MANAGED_ARTIFACT_INVALID",
        artifactPath,
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof ManagedArtifactStorageError) {
      throw error;
    }
    if (hasCode(error, "ELOOP")) {
      throw unsafeArtifactPath(
        "Managed artifact resolves through a symbolic link",
        artifactPath,
        error,
      );
    }
    throw artifactIoError("Unable to read managed artifact", artifactPath, error);
  } finally {
    await handle?.close();
  }
}

/** Save a secret-free, allowlisted `update-plan.v1` artifact. */
export async function saveManagedUpdatePlan(
  plan: ManagedUpdatePlan,
  customPath?: string,
  options: ManagedArtifactWriteOptions = {},
): Promise<string> {
  const persisted = toPersistedManagedPlan(plan);
  assertManagedUpdatePlan(persisted);
  const planPath =
    customPath ?? join(DEFAULT_PLAN_DIR, `update-${generatePlanFileName().slice("plan-".length)}`);
  return writeManagedArtifact(planPath, persisted, options);
}

/** Load and runtime-validate an untrusted `update-plan.v1` artifact. */
export async function loadManagedUpdatePlan(planPath: string): Promise<ManagedUpdatePlan> {
  const value = await readManagedArtifact(planPath);
  assertManagedUpdatePlan(value);
  return value;
}

/** Save a secret-free, allowlisted final `update.v1` report. */
export async function saveManagedUpdateResult(
  result: ManagedUpdateResult,
  customPath?: string,
  options: ManagedArtifactWriteOptions = {},
): Promise<string> {
  const persisted = toPersistedManagedResult(result);
  assertManagedUpdateResult(persisted);
  const reportPath =
    customPath ?? join(".rfapps/reports", `update-${result.runId}-${Date.now()}.json`);
  return writeManagedArtifact(reportPath, persisted, options);
}

/**
 * Atomically reserve a custom report destination without publishing a terminal
 * lifecycle document. A successful final or declined report must explicitly
 * overwrite this private, empty placeholder.
 */
export async function reserveManagedUpdateResultPath(customPath: string): Promise<string> {
  const artifactPath = validateArtifactPath(customPath);
  await ensurePrivateArtifactDirectory(artifactPath);
  await assertNoSymlinkComponents(artifactPath);
  await inspectExistingArtifact(artifactPath, false);

  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(
      artifactPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    created = true;
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(artifactPath, PRIVATE_FILE_MODE);
    return artifactPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(artifactPath).catch(() => undefined);
    if (error instanceof ManagedArtifactStorageError) throw error;
    throw artifactIoError("Unable to reserve managed report output", artifactPath, error);
  }
}

/** Load and runtime-validate an untrusted `update.v1` report. */
export async function loadManagedUpdateResult(resultPath: string): Promise<ManagedUpdateResult> {
  const value = await readManagedArtifact(resultPath);
  assertManagedUpdateResult(value);
  return value;
}

/**
 * Ensure plan directory exists
 */
async function ensurePlanDir(planDir: string): Promise<void> {
  try {
    await mkdir(planDir, { recursive: true });
  } catch (error) {
    logDebug(
      `Failed to create plan directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Calculate SHA256 hash of a file
 */
export async function hashFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf-8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    logDebug(
      `Failed to hash file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

/**
 * Generate plan file name from timestamp
 */
function generatePlanFileName(timestamp?: Date): string {
  const date = timestamp ?? new Date();
  const dateStr = date.toISOString().replace(/[:.]/g, "-").replace("T", "-").split("Z")[0];
  return `plan-${dateStr}.json`;
}

/**
 * Save a deployment plan to disk.
 *
 * Plans are saved as JSON files with a timestamp-based filename.
 * A SHA256 hash of the compose file is stored with the plan to detect
 * if the compose file has changed since the plan was created.
 *
 * Automatic cleanup keeps only the most recent 50 plans.
 *
 * @param plan - The deployment plan to save
 * @param customPath - Optional custom file path (defaults to .rfapps/plans/)
 * @returns Absolute path to the saved plan file
 *
 * @example
 * ```typescript
 * const plan = await generatePlan(options);
 * const path = await savePlan(plan);
 * console.log(`Plan saved to ${path}`);
 * ```
 */
export async function savePlan(plan: DeploymentPlan, customPath?: string): Promise<string> {
  // Determine save path
  const planPath = customPath ?? join(DEFAULT_PLAN_DIR, generatePlanFileName());
  const planDir = dirname(planPath);

  // Ensure directory exists
  await ensurePlanDir(planDir);

  // Calculate compose file hash
  const composeHash = await hashFile(plan.composePath);
  const planWithHash: DeploymentPlan = {
    ...plan,
    composeHash,
  };

  // Write plan file
  const content = JSON.stringify(planWithHash, null, 2);
  await writeFile(planPath, content, "utf-8");

  logDebug(`Plan saved to ${planPath}`);

  // Cleanup old plans
  await cleanupOldPlans(planDir);

  return resolve(planPath);
}

/**
 * Load a deployment plan from disk
 */
export async function loadPlan(planPath: string): Promise<DeploymentPlan | undefined> {
  try {
    const content = await readFile(planPath, "utf-8");
    const plan = JSON.parse(content) as DeploymentPlan;
    logDebug(`Loaded plan from ${planPath}`);
    return plan;
  } catch (error) {
    logWarn(
      `Failed to load plan from ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Validate a deployment plan.
 *
 * Checks:
 * - Plan has required fields (id, composePath, services)
 * - Compose file still exists and matches stored hash
 * - Plan age (warns if older than 24 hours)
 *
 * Validation failures (errors) prevent plan application.
 * Warnings allow application but inform the user of potential issues.
 *
 * @param plan - The plan to validate
 * @param options - Validation options
 * @param options.force - If true, compose hash mismatch becomes warning not error
 * @returns Validation result with errors and warnings
 */
export async function validatePlan(
  plan: DeploymentPlan,
  options: { force?: boolean } = {},
): Promise<PlanValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if plan has required fields
  if (plan.id === undefined || plan.id === "") {
    errors.push("Plan ID is missing");
  }

  if (plan.composePath === undefined || plan.composePath === "") {
    errors.push("Compose path is missing");
  }

  if (plan.services === undefined || plan.services.length === 0) {
    warnings.push("Plan contains no services");
  }

  // Check if compose file still exists and matches hash
  if (plan.composePath !== undefined && plan.composePath !== "") {
    try {
      const currentHash = await hashFile(plan.composePath);
      if (currentHash === "") {
        warnings.push("Compose file does not exist or cannot be read");
      } else if (currentHash !== plan.composeHash) {
        if (options.force === true) {
          warnings.push(
            "Compose file has changed since plan was created (applying anyway due to --force)",
          );
        } else {
          errors.push(
            "Compose file has changed since plan was created. Use --force to apply anyway.",
          );
        }
      }
    } catch (error) {
      warnings.push(
        `Could not verify compose file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Check plan age (warn if older than 24 hours)
  const planAge = Date.now() - new Date(plan.createdAt).getTime();
  const hoursSincePlan = planAge / (1000 * 60 * 60);
  if (hoursSincePlan > 24) {
    warnings.push(`Plan is ${hoursSincePlan.toFixed(1)} hours old`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * List all plans in the plan directory
 */
export async function listPlans(planDir: string = DEFAULT_PLAN_DIR): Promise<string[]> {
  try {
    const files = await readdir(planDir);
    const planFiles = files
      .filter((f) => f.startsWith("plan-") && f.endsWith(".json"))
      .map((f) => join(planDir, f));

    // Sort by modification time (newest first)
    const statsPromises = planFiles.map(async (path) => {
      const stats = await stat(path);
      return { path, mtime: stats.mtime };
    });

    const filesWithStats = await Promise.all(statsPromises);
    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return filesWithStats.map((f) => f.path);
  } catch (error) {
    logDebug(`Failed to list plans: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Cleanup old plans (keep only MAX_PLANS most recent)
 */
async function cleanupOldPlans(planDir: string): Promise<void> {
  try {
    const plans = await listPlans(planDir);

    if (plans.length > MAX_PLANS) {
      const toDelete = plans.slice(MAX_PLANS);
      logDebug(`Cleaning up ${toDelete.length} old plan(s)`);

      for (const planPath of toDelete) {
        try {
          await unlink(planPath);
          logDebug(`Deleted old plan: ${planPath}`);
        } catch (error) {
          logDebug(
            `Failed to delete plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  } catch (error) {
    logDebug(
      `Failed to cleanup old plans: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Delete a plan file
 */
export async function deletePlan(planPath: string): Promise<boolean> {
  try {
    await unlink(planPath);
    logDebug(`Deleted plan: ${planPath}`);
    return true;
  } catch (error) {
    logWarn(
      `Failed to delete plan ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
