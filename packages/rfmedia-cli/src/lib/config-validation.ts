/**
 * Shared configuration validation primitives for rfmedia CLI.
 *
 * Declares `ConfigError` and the domain-generic assertion helpers used by every
 * `validateXxxConfig` section validator in `./config.js`.
 *
 * Admission rule — a helper belongs here **iff all four hold**:
 *
 * 1. Its signature is `(value: unknown, …, propertyPath: string, configPath: string)` and it
 *    throws `new ConfigError(message, configPath, propertyPath)`.
 * 2. Its message text names no feature domain — no "convert format", "range", "page size",
 *    "preset", "disk space".
 * 3. Its imports are confined to `./http-url.js`; it pulls in no `../types/*` feature type.
 * 4. It has at least 2 call sites spanning at least 2 distinct top-level config sections.
 *
 * The rule has no exceptions and no sibling escape hatch. Helpers that fail any clause stay in
 * `./config.js` beside the validator that owns their prose.
 *
 * Honesty note: `validateStarRating` has a domain-flavoured *name* but a domain-free *contract*
 * and message. It is admitted under clause 4 as a shared cross-section value domain
 * (copy + plex + policy), not because it is "generic".
 *
 * Message-shape note: `validatePositiveInteger`, `validateNonNegativeInteger`,
 * `validateBoundedInteger` and `validateStarRating` end with the raw `got ${value}`; the rest end
 * with `got ${describeType(value)}`. The asymmetry is load-bearing — `got NaN` must not become
 * `got number`. Do not harmonise it.
 *
 * Primitives added here after this module was created ship with direct unit tests. The primitives
 * moved in during issue #312 are covered through `validateConfig` in `./config.test.ts` and are
 * deliberately not retro-fitted.
 */

import { normalizeHttpUrl } from "./http-url.js";

/**
 * Custom error class for configuration validation errors.
 */
export class ConfigError extends Error {
  /** Path to the config file that caused the error */
  readonly configPath: string;
  /** JSON path to the invalid property (e.g., "copy.workers") */
  readonly propertyPath?: string;

  constructor(message: string, configPath: string, propertyPath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.configPath = configPath;
    this.propertyPath = propertyPath;
  }
}

/**
 * Returns a human-readable type description for error messages.
 * Handles JavaScript quirks where typeof null === 'object'.
 */
export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Rejects keys outside one exact configuration object contract. */
export function rejectUnknownConfigKeys(
  raw: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  propertyPath: string,
  configPath: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      const keyPath = `${propertyPath}.${key}`;
      throw new ConfigError(`Unknown property ${keyPath}`, configPath, keyPath);
    }
  }
}

/**
 * Validates that a value is a boolean.
 */
export function validateBoolean(value: unknown, propertyPath: string, configPath: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(
      `Expected boolean for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a positive integer.
 */
export function validatePositiveInteger(
  value: unknown,
  propertyPath: string,
  configPath: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `Expected positive integer for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a non-negative integer (0 or positive).
 */
export function validateNonNegativeInteger(
  value: unknown,
  propertyPath: string,
  configPath: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `Expected non-negative integer for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is an integer within an inclusive range.
 */
export function validateBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  propertyPath: string,
  configPath: string,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(
      `Expected integer between ${minimum} and ${maximum} for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a non-empty string.
 */
export function validateString(value: unknown, propertyPath: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `Expected non-empty string for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is an array of strings.
 * Filters out empty strings (including whitespace-only strings) from the result.
 */
export function validateStringArray(
  value: unknown,
  propertyPath: string,
  configPath: string,
): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ConfigError(
      `Expected array of strings for ${propertyPath}`,
      configPath,
      propertyPath,
    );
  }
  // Filter out empty strings (including whitespace-only)
  return (value as string[]).filter((s) => s.trim() !== "");
}

/**
 * Validates that a value is a valid star rating (1.0-5.0).
 * Supports both integer and float values.
 *
 * `Number.isFinite` is deliberate: YAML's `.nan` / `.inf` literals load as JS
 * `NaN` / `Infinity`, and a bare `value < 1 || value > 5` bounds check is false
 * for `NaN`. A `NaN` threshold would then survive into the resolved policy and
 * make every `>=` comparison false, silently disabling a rating veto.
 */
export function validateStarRating(
  value: unknown,
  propertyPath: string,
  configPath: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 5) {
    throw new ConfigError(
      `Expected number between 1.0 and 5.0 for ${propertyPath}, got ${value}`,
      configPath,
      propertyPath,
    );
  }
  return value;
}

/**
 * Validates that a value is a valid URL.
 */
export function validateUrl(value: unknown, propertyPath: string, configPath: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(
      `Expected non-empty URL string for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }

  if (!normalizeHttpUrl(value).ok) {
    throw new ConfigError(
      `Invalid URL format for ${propertyPath}: ${value}. Must be http:// or https://`,
      configPath,
      propertyPath,
    );
  }

  return value;
}

/** Narrows a nested configuration value to a plain object, or throws with its exact path. */
export function requireConfigObject(
  value: unknown,
  propertyPath: string,
  configPath: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(
      `Expected object for ${propertyPath}, got ${describeType(value)}`,
      configPath,
      propertyPath,
    );
  }
  return value as Record<string, unknown>;
}
