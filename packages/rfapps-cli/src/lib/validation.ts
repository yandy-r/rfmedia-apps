/**
 * Configuration validation and compose.yml parsing for rfapps CLI
 *
 * Validates service mappings, groups, and profiles against compose.yml
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import YAML, { type ToJSOptions } from "yaml";
import { logDebug } from "@rfmedia/common";
import type { RfappsConfig, Profile } from "../types/index.js";
import { listConfigLayerPaths } from "./config.js";
import { ComposeFileParseError, ServiceNotFoundError } from "./errors.js";
import { findClosestMatch } from "./fuzzy-match.js";
import { findTagMappingLayers } from "./tags/tag-config-layers.js";
import { buildTagIndex } from "./tags/tag-index.js";

/**
 * Validation warning with context
 */
export interface ValidationWarning {
  /** Warning message */
  message: string;
  /** Context (e.g., service name, group name) */
  context?: string;
  /** Severity level */
  severity: "warning" | "error";
}

/**
 * Parsed compose file structure (minimal)
 */
interface ComposeFile {
  services?: Record<string, unknown>;
}

/**
 * Cached compose metadata and service list
 */
interface ComposeCacheEntry {
  /** Cache key derived from compose path */
  key: string;
  /** File metadata used for cache invalidation */
  mtimeMs: number;
  /** File size used for cache invalidation */
  size: number;
  /** Cached list of service names */
  services: string[];
}

/** YAML parse options for large compose files with many extension aliases */
export const COMPOSE_YAML_PARSE_OPTIONS: ToJSOptions = { maxAliasCount: -1 };

/**
 * Module-level cache for compose parsing
 */
let composeCache: ComposeCacheEntry | null = null;

/**
 * Generate a cache key from the compose path
 */
function getComposeCacheKey(composePath: string): string {
  return resolve(composePath);
}

/**
 * Check if the compose cache is still valid
 */
async function isComposeCacheValid(composePath: string, cacheKey: string): Promise<boolean> {
  if (composeCache === null) {
    return false;
  }
  if (composeCache.key !== cacheKey) {
    return false;
  }
  try {
    const stats = await stat(composePath);
    return stats.mtimeMs === composeCache.mtimeMs && stats.size === composeCache.size;
  } catch {
    return false;
  }
}

/**
 * Update the compose cache if file metadata is available
 */
async function updateComposeCache(
  composePath: string,
  cacheKey: string,
  services: string[],
): Promise<void> {
  try {
    const stats = await stat(composePath);
    composeCache = {
      key: cacheKey,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      services: [...services],
    };
  } catch {
    composeCache = null;
  }
}

/**
 * Clear the validation cache (used by tests)
 */
export function clearValidationCache(): void {
  composeCache = null;
  logDebug("Validation cache cleared");
}

/**
 * Parse a Docker Compose file and extract service names
 */
export async function parseComposeFile(path: string): Promise<string[]> {
  const cacheKey = getComposeCacheKey(path);
  if (await isComposeCacheValid(path, cacheKey)) {
    logDebug(`Compose validation cache hit for ${path}`);
    return [...(composeCache?.services ?? [])];
  }

  try {
    const content = await readFile(path, "utf-8");
    const parsed = YAML.parse(content, COMPOSE_YAML_PARSE_OPTIONS) as ComposeFile;

    if (parsed.services === undefined) {
      logDebug("No services found in compose file");
      const services: string[] = [];
      await updateComposeCache(path, cacheKey, services);
      return services;
    }

    const services = Object.keys(parsed.services);
    await updateComposeCache(path, cacheKey, services);
    return services;
  } catch (error) {
    const parseErrorMessage = error instanceof Error ? error.message : String(error);
    throw new ComposeFileParseError(path, parseErrorMessage);
  }
}

/**
 * Validates that all provided service names exist in the compose file.
 *
 * For each service not found, finds the closest match using fuzzy matching
 * and throws a `ServiceNotFoundError` with the suggestion.
 *
 * @param services - Service names to validate
 * @param composePath - Path to the Docker Compose file
 * @throws {ServiceNotFoundError} If any service name is not found in the compose file
 * @throws {ComposeFileParseError} If the compose file cannot be parsed
 */
export async function validateServiceNames(services: string[], composePath: string): Promise<void> {
  const composeServices = await parseComposeFile(composePath);
  const composeServiceSet = new Set(composeServices);

  for (const service of services) {
    if (!composeServiceSet.has(service)) {
      const suggestion = findClosestMatch(service, composeServices);
      throw new ServiceNotFoundError(service, composeServices, suggestion);
    }
  }
}

/**
 * Validate sidecar references against available services
 */
export function validateSidecarReferences(
  sidecarMapping: Record<string, string>,
  availableServices: string[],
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const serviceSet = new Set(availableServices);

  for (const [main, sidecar] of Object.entries(sidecarMapping)) {
    // Check if main service exists
    if (!serviceSet.has(main)) {
      warnings.push({
        message: `Sidecar mapping references non-existent main service: ${main}`,
        context: main,
        severity: "warning",
      });
    }

    // Check if sidecar exists
    if (!serviceSet.has(sidecar)) {
      warnings.push({
        message: `Sidecar mapping references non-existent sidecar: ${sidecar}`,
        context: sidecar,
        severity: "warning",
      });
    }
  }

  return warnings;
}

/**
 * Validate group references against available services
 */
export function validateGroupReferences(
  groups: Record<string, string[]>,
  availableServices: string[],
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const serviceSet = new Set(availableServices);

  for (const [groupName, services] of Object.entries(groups)) {
    if (!Array.isArray(services)) {
      warnings.push({
        message: `Group '${groupName}' is not an array of services`,
        context: groupName,
        severity: "error",
      });
      continue;
    }
    for (const service of services) {
      if (!serviceSet.has(service)) {
        warnings.push({
          message: `Group '${groupName}' references non-existent service: ${service}`,
          context: groupName,
          severity: "warning",
        });
      }
    }
  }

  return warnings;
}

/**
 * Label used for the `tags:` source when the caller has not attributed a config layer.
 *
 * The source only names the config file in a `ConfigValidationError`'s `configSource`
 * field, never in its message, so a caller that has not resolved the winning layer loses
 * nothing operator-visible by omitting it. `rfapps tag list` reports the real path.
 */
const UNATTRIBUTED_TAG_SOURCE = "tags.mapping";

/**
 * Validate the declared tag mapping against the compose service universe.
 *
 * Reports two classes of finding, both at **warning severity**:
 *
 * 1. Stale entries — services named in `tags.mapping` that no longer exist in
 *    `compose.yml` (`TagIndex.unresolvedServices`, design post-condition P4).
 * 2. Canonicalization rewrites — entries accepted but rewritten into canonical form,
 *    e.g. `Media/Streaming` becoming `media/streaming`.
 *
 * **This function never throws, and never emits `severity: "error"`.** Both are load-bearing:
 * `validateConfigAgainstCompose` converts any throw from its body into an error-severity
 * warning, and `actions/deploy.ts` calls {@link hasErrors} and aborts. Either mistake would
 * turn one stale `tags.mapping` entry into a total deploy outage. A malformed entry — which
 * makes `buildTagIndex` throw `ConfigValidationError` — is therefore caught here and reported
 * as a warning; `loadConfig` remains the authority that fails hard on bad config.
 *
 * @param config - The merged rfapps config; only `tags.mapping` is read
 * @param composeServices - Compose service names, in declaration order
 * @param source - Absolute path of the config layer the `tags:` block came from, when known
 * @returns Warnings describing stale entries and canonicalization rewrites
 */
export function validateTagReferences(
  config: RfappsConfig,
  composeServices: readonly string[],
  source: string = UNATTRIBUTED_TAG_SOURCE,
): ValidationWarning[] {
  const mapping = config.tags?.mapping;

  if (mapping === undefined) {
    return [];
  }

  try {
    const { index, warnings: normalizations } = buildTagIndex({
      mapping,
      universe: composeServices,
      source,
    });

    const warnings: ValidationWarning[] = [];

    for (const service of index.unresolvedServices) {
      warnings.push({
        message: `Tag mapping references non-existent service: ${service}`,
        context: service,
        severity: "warning",
      });
    }

    for (const normalization of normalizations) {
      warnings.push({
        message: normalization.message,
        context: normalization.service,
        severity: "warning",
      });
    }

    return warnings;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      {
        message: `Failed to validate tag mapping: ${reason}`,
        context: "tags.mapping",
        severity: "warning",
      },
    ];
  }
}

/** The only key `mergeConfig` reads under a `tags:` block. Everything else is silently dropped. */
const RECOGNIZED_TAG_KEYS: ReadonlySet<string> = new Set(["mapping"]);

/** Narrows a parsed YAML/JSON value to a plain object without reaching for `any`. */
/**
 * Narrows to a **plain** object. The prototype check keeps an explicit YAML type tag
 * (`!!set`, `!!omap`, `!!timestamp`) from passing as a well-formed `tags:` block and
 * suppressing the warnings below. See the matching guard in `lib/tags/tag-index.ts`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Names a value's shape for an operator, distinguishing `null` and a list from an object. */
function describeShape(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "a list";
  }

  if (typeof value === "object") {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)
      ?.constructor?.name;
    return name === undefined || name === "Object" ? "an object" : `a ${name}`;
  }

  return `a ${typeof value}`;
}

/**
 * Warn when a layer's `tags:` block holds anything other than `mapping`.
 *
 * The two mistakes this catches — omitting the `mapping:` level and writing service names
 * directly under `tags:`, or misspelling it as `mappings:` — are *indistinguishable from having
 * no taxonomy at all*. `mergeConfig` reads exactly `override.tags?.mapping`, so the block merges
 * to `{}`, `rfapps validate` reports success, and `--tag '!media'` matches every service in the
 * project. `assertTagMapping` cannot see this: by the time it runs, the stray keys are already
 * gone. Only the raw layer text still has the evidence, which is why the check lives here rather
 * than in `lib/tags`.
 *
 * **Warning severity, and non-throwing**, for the reason spelled out on
 * {@link validateTagLayerOwnership}. It is deliberately *not* a hard error: this config loader
 * performs no unknown-key validation anywhere else, so rejecting a stray key only under `tags:`
 * would be an inconsistency that fails configs every other section accepts.
 *
 * A layer that cannot be read or parsed yields nothing — `loadConfig` is the authority for
 * config errors and has already thrown for any real one by the time this runs.
 *
 * @param path - Absolute path of one config layer
 * @returns At most one warning naming the layer and its ignored keys
 */
async function validateTagBlockKeys(path: string): Promise<ValidationWarning[]> {
  let parsed: unknown;

  try {
    const content = await readFile(path, "utf-8");
    parsed = path.endsWith(".json") ? JSON.parse(content) : YAML.parse(content);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || !Object.hasOwn(parsed, "tags")) {
    return [];
  }

  const tags: unknown = parsed["tags"];

  // `tags:` with nothing after it is how an operator stubs the section out before filling it in.
  // That is indistinguishable from an absent block to every consumer, so it is not a mistake.
  if (tags === null || tags === undefined) {
    return [];
  }

  if (!isRecord(tags)) {
    return [
      {
        message:
          `Config layer '${path}' declares 'tags:' as ${describeShape(tags)} rather than a ` +
          `block; only 'tags.mapping' is read, so this layer contributes no taxonomy`,
        context: "tags",
        severity: "warning",
      },
    ];
  }

  const stray = Object.keys(tags).filter((key) => !RECOGNIZED_TAG_KEYS.has(key));

  if (stray.length === 0) {
    return [];
  }

  return [
    {
      message:
        `Config layer '${path}' declares unrecognized key(s) under 'tags:': ` +
        `${stray.join(", ")}; only 'tags.mapping' is read, so these are ignored. ` +
        `Nest service names under a 'mapping:' key`,
      context: "tags",
      severity: "warning",
    },
  ];
}

/**
 * Warn when more than one config layer supplies `tags.mapping`.
 *
 * Config layering is one level deep and every collection is whole-value replacement, so a
 * `tags:` block in a personal `.rfapps.yaml` does not extend the project taxonomy — it
 * **discards** it. That is the intended, consistent semantics, but it is invisible at the
 * point of use, so it is surfaced here and the winning layer's absolute path is named.
 *
 * Ownership is decided by the shared {@link layerSuppliesTagMapping}, the same predicate
 * `TagIndex.source` uses, so this warning and `rfapps tag list` can never name different
 * winners. Deciding it locally on a bare `tags:` key instead made a layer holding only
 * `tags: {}` — which `mergeConfig` ignores entirely — the reported winner, while the layer
 * that actually supplied the taxonomy was reported as shadowed.
 *
 * Warning severity only, and non-throwing, for the same reason as
 * {@link validateTagReferences}: this runs inside `validateConfigAgainstCompose`, whose
 * errors abort `rfapps deploy`.
 *
 * It also carries {@link validateTagBlockKeys} across every layer, because this is the only
 * validation surface that reads the raw layer text — the merged config it would need to inspect
 * instead has already dropped every unrecognized key.
 *
 * @param cwd - Working directory for config layer discovery
 * @returns A warning naming the winning and shadowed layers, plus one per layer whose `tags:`
 *   block holds keys that are read by nothing
 */
export async function validateTagLayerOwnership(cwd?: string): Promise<ValidationWarning[]> {
  let layers: string[];

  try {
    layers = await listConfigLayerPaths(cwd);
  } catch {
    return [];
  }

  const warnings: ValidationWarning[] = [];
  const owning = await findTagMappingLayers(layers);
  const winner = owning[0];

  if (winner !== undefined && owning.length >= 2) {
    const shadowed = owning.slice(1);

    warnings.push({
      message:
        `${owning.length} config layers define 'tags:'; the section is replaced wholesale, ` +
        `so only '${winner}' takes effect (shadowed: ${shadowed.join(", ")})`,
      context: "tags",
      severity: "warning",
    });
  }

  for (const layer of layers) {
    warnings.push(...(await validateTagBlockKeys(layer)));
  }

  return warnings;
}

/**
 * Validate profile mappings against valid profiles
 */
export function validateProfileMappings(
  profileMapping: Record<string, Profile>,
  validProfiles: Profile[],
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const profileSet = new Set(validProfiles);

  for (const [service, profile] of Object.entries(profileMapping)) {
    if (!profileSet.has(profile)) {
      warnings.push({
        message: `Service '${service}' has invalid profile: ${profile}`,
        context: service,
        severity: "error",
      });
    }
  }

  return warnings;
}

/**
 * Check for services in compose.yml not defined in config
 */
export function findUndefinedServices(
  availableServices: string[],
  profileMapping: Record<string, Profile>,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const configuredServices = new Set(Object.keys(profileMapping));

  for (const service of availableServices) {
    if (!configuredServices.has(service)) {
      warnings.push({
        message: `Service '${service}' found in compose.yml but not defined in config profiles`,
        context: service,
        severity: "warning",
      });
    }
  }

  return warnings;
}

/**
 * Check for services in config not found in compose.yml
 */
export function findOrphanedServices(
  availableServices: string[],
  profileMapping: Record<string, Profile>,
): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const serviceSet = new Set(availableServices);

  for (const service of Object.keys(profileMapping)) {
    if (!serviceSet.has(service)) {
      warnings.push({
        message: `Service '${service}' defined in config but not found in compose.yml`,
        context: service,
        severity: "warning",
      });
    }
  }

  return warnings;
}

/**
 * Validate configuration against a compose file
 */
export async function validateConfigAgainstCompose(
  config: RfappsConfig,
  composePath: string,
): Promise<ValidationWarning[]> {
  const warnings: ValidationWarning[] = [];

  try {
    // Parse compose file
    const services = await parseComposeFile(composePath);
    logDebug(`Found ${services.length} services in compose file`);

    // Validate sidecars
    const sidecarWarnings = validateSidecarReferences(config.sidecars.mapping, services);
    warnings.push(...sidecarWarnings);

    // Validate groups
    const groupWarnings = validateGroupReferences(config.groups, services);
    warnings.push(...groupWarnings);

    // Validate profiles
    const profileWarnings = validateProfileMappings(
      config.profiles.mapping,
      config.profiles.validProfiles,
    );
    warnings.push(...profileWarnings);

    // Check for undefined services
    const undefinedWarnings = findUndefinedServices(services, config.profiles.mapping);
    warnings.push(...undefinedWarnings);

    // Check for orphaned services
    const orphanedWarnings = findOrphanedServices(services, config.profiles.mapping);
    warnings.push(...orphanedWarnings);

    // Validate the tag taxonomy — warning severity only, and neither call may throw
    const tagWarnings = validateTagReferences(config, services);
    warnings.push(...tagWarnings);

    const tagLayerWarnings = await validateTagLayerOwnership();
    warnings.push(...tagLayerWarnings);

    logDebug(`Validation complete: ${warnings.length} warnings found`);
  } catch (error) {
    warnings.push({
      message: `Failed to validate config: ${error instanceof Error ? error.message : String(error)}`,
      severity: "error",
    });
  }

  return warnings;
}

/**
 * Format validation warnings for display
 */
export function formatValidationWarnings(warnings: ValidationWarning[]): string[] {
  return warnings.map((w) => {
    const prefix = w.severity === "error" ? "❌" : "⚠️";
    const context = w.context !== undefined ? ` [${w.context}]` : "";
    return `${prefix} ${w.message}${context}`;
  });
}

/**
 * Check if validation warnings contain any errors
 */
export function hasErrors(warnings: ValidationWarning[]): boolean {
  return warnings.some((w) => w.severity === "error");
}
