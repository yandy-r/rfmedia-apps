/** Shared strict validation primitives for Lidarr plan artifacts and operations. */

import { LidarrPlanValidationError } from "../errors.js";

const MAX_STRING_LENGTH = 2_048;
const SENSITIVE_KEY_PATTERN = /^(?:api-?key|authorization|bearer|cookie|password|secret|token)$/iu;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

export type UnknownRecord = Record<string, unknown>;

export function validationError(detail: string, planPath?: string): LidarrPlanValidationError {
  return new LidarrPlanValidationError(detail, planPath);
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) throw validationError(`${path} must be an object`);
  return value;
}

export function requireExactKeys(
  value: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw validationError(`${path} contains unknown key ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!(key in value)) throw validationError(`${path}.${key} is required`);
  }
}

export function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_STRING_LENGTH
  ) {
    throw validationError(
      `${path} must be a ${allowEmpty ? "bounded" : "non-empty bounded"} string`,
    );
  }
  if (TERMINAL_CONTROL_PATTERN.test(value)) {
    throw validationError(`${path} must not contain terminal control characters`);
  }
  return value;
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw validationError(`${path} must be a boolean`);
  return value;
}

export function requirePositiveInteger(
  value: unknown,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0 || value > maximum) {
    throw validationError(`${path} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

export function assertNoSensitiveKeys(
  value: unknown,
  path = "plan",
  seen = new Set<object>(),
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw validationError(`${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw validationError(`${path} contains forbidden key ${JSON.stringify(key)}`);
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        throw validationError(`${path} contains sensitive key ${JSON.stringify(key)}`);
      }
      assertNoSensitiveKeys(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}
