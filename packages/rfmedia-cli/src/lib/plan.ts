/**
 * Copy plan artifact library (rfmedia.copy-plan.v1).
 *
 * Provides hardened plan artifact IO (symlink-free paths, private modes, atomic
 * writes, size caps, dev/ino recheck), canonical serialization with a sha256
 * payload checksum, an allowlist validator, execution-layer freezing and
 * rehydration, source-directory fingerprinting, the world-drift staleness
 * matrix, an append-only apply audit ledger, and plan-directory pruning.
 *
 * Hard corruption failures (checksum mismatch, validator failure, unsafe path,
 * oversize, malformed JSON) are thrown as typed errors and are never
 * represented as staleness findings; findings cover only world drift.
 *
 * mtime convention (binding): every persisted mtime is `Math.trunc(stat.mtimeMs)`
 * and every staleness comparison truncates the freshly-statted value the same
 * way, so nanosecond-resolution filesystems never produce false drift.
 */

import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { constants } from "node:fs";
import { lstat, open, readdir, stat, unlink, type FileHandle } from "node:fs/promises";
import { logDebug, logWarn } from "./logger.js";
import { PlanArtifactError, PlanValidationError } from "./errors.js";
import {
  createPrivateFileAtomically,
  prepareSafeParent,
  PRIVATE_FILE_MODE,
  readBoundedPrivateFile,
  replacePrivateFileAtomically,
  SECURE_STORE_MAX_PATH_LENGTH,
  SecureStoreError,
} from "./secure-store/index.js";
import type { FileIdentity } from "./secure-store/index.js";
import {
  COPY_PLAN_MAX_BYTES,
  COPY_PLAN_MAX_ENTRIES,
  COPY_PLAN_VERSION,
  type CopyPlanV1,
  type PlanApplicationRecord,
  type PlanCreatedBy,
  type PlanExecutionOptions,
  type PlanFingerprints,
  type PlanReviewEntry,
  type PlanReviewSection,
  type PlanSourceFingerprint,
  type PlanStalenessCode,
  type PlanStalenessFinding,
  type PlanStalenessReport,
  type PlanStalenessSeverity,
} from "../types/plan.js";
import type {
  CopyMode,
  CopyOptions,
  CopyRange,
  PathEntry,
  RatingFilter,
} from "../types/options.js";
import type { SmartFilter, SmartFilterRule } from "../types/filters.js";
import pkg from "../../package.json" with { type: "json" };

/** Maximum number of managed plan artifacts retained by {@link prunePlans}. */
export const MAX_PLANS = 50;

const SMART_FILTER_MAX_DEPTH = 16;
const SMART_FILTER_MAX_NODES = 1_000;
const MAX_FINGERPRINT_SOURCES = 10_000;
const MAX_SOURCE_ENTRIES = 10_000;
const PLAN_AGE_WARNING_MS = 24 * 60 * 60 * 1000;
const STALENESS_PATHS_CAP = 10;
const MANAGED_PLAN_FILE_PATTERN = /^plan-.*\.json$/u;
const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PLAN_ARTIFACT_SUBJECT = "Plan artifact";
const PLAN_AUDIT_SUBJECT = "Plan audit ledger";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function unsafePlanPath(message: string, planPath?: string, cause?: unknown): PlanArtifactError {
  return new PlanArtifactError(
    "PLAN_UNSAFE_PATH",
    message,
    planPath,
    cause === undefined ? undefined : { cause },
  );
}

function planIoError(message: string, planPath?: string, cause?: unknown): PlanArtifactError {
  return new PlanArtifactError(
    "PLAN_IO",
    message,
    planPath,
    cause === undefined ? undefined : { cause },
  );
}

function planTooLargeError(planPath: string, cause?: unknown): PlanArtifactError {
  return new PlanArtifactError(
    "PLAN_TOO_LARGE",
    `Plan artifact exceeds the supported size of ${COPY_PLAN_MAX_BYTES} bytes`,
    planPath,
    cause === undefined ? undefined : { cause },
  );
}

function planExistsError(planPath: string, cause?: unknown): PlanArtifactError {
  return new PlanArtifactError(
    "PLAN_EXISTS",
    "Plan artifact already exists; choose a different --plan-output path or remove the existing file",
    planPath,
    cause === undefined ? undefined : { cause },
  );
}

function translatePlanArtifactFailure(
  error: unknown,
  artifactPath: string,
  operation: "read" | "write",
): never {
  if (error instanceof PlanArtifactError || error instanceof PlanValidationError) throw error;
  if (error instanceof SecureStoreError) {
    switch (error.code) {
      case "SECURE_STORE_UNSAFE_PATH":
      case "SECURE_STORE_PERMISSIONS":
        throw unsafePlanPath("Plan artifact path cannot be used safely", artifactPath, error);
      case "SECURE_STORE_TOO_LARGE":
        throw planTooLargeError(artifactPath, error);
      case "SECURE_STORE_VERSION_CONFLICT":
        throw planExistsError(artifactPath, error);
      default:
        break;
    }
  }
  throw planIoError(
    operation === "read"
      ? "Unable to read the plan artifact"
      : "Unable to write the plan artifact atomically",
    artifactPath,
    error,
  );
}

/** Maps null (tolerated by the validator) to undefined for canonical omission. */
function orUndef<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

// ---------------------------------------------------------------------------
// Plan directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the managed plans directory.
 *
 * The `RFMEDIA_PLAN_DIR` environment variable is the test/ops seam; otherwise
 * plans live under the XDG-style `~/.config/rfmedia/plans`. No legacy fallback.
 *
 * @returns Absolute path of the plans directory.
 */
export function getDefaultPlanDir(): string {
  return process.env["RFMEDIA_PLAN_DIR"] ?? join(homedir(), ".config", "rfmedia", "plans");
}

/**
 * Resolves the append-only apply audit ledger path inside the plans directory.
 *
 * @returns Absolute path of `audit.jsonl`.
 */
export function getAuditLedgerPath(): string {
  return join(getDefaultPlanDir(), "audit.jsonl");
}

// ---------------------------------------------------------------------------
// Canonicalization (fixed key order; undefined omitted by JSON.stringify)
// ---------------------------------------------------------------------------

function canonicalizeCopyRange(range: CopyRange): CopyRange {
  return { start: range.start, end: range.end, padWidth: range.padWidth };
}

function canonicalizeSmartFilterRule(rule: SmartFilterRule): SmartFilterRule {
  if (rule.type === "rule") {
    return { type: "rule", field: rule.field, operator: rule.operator, value: rule.value };
  }
  return { type: "group", match: rule.match, rules: rule.rules.map(canonicalizeSmartFilterRule) };
}

function canonicalizeSmartFilter(filter: SmartFilter): SmartFilter {
  return { match: filter.match, rules: filter.rules.map(canonicalizeSmartFilterRule) };
}

/** RatingFilter keys in the exact declaration order of types/options.ts. */
function canonicalizeRatingFilter(rating: RatingFilter): RatingFilter {
  return {
    minStars: orUndef(rating.minStars),
    minRating: orUndef(rating.minRating),
    outputFolder: rating.outputFolder,
    preserveStructure: rating.preserveStructure,
    range: rating.range == null ? undefined : canonicalizeCopyRange(rating.range),
    albumMode: orUndef(rating.albumMode),
    minDuration: orUndef(rating.minDuration),
    maxDuration: orUndef(rating.maxDuration),
    minBitrate: orUndef(rating.minBitrate),
    codec: orUndef(rating.codec),
    minPlays: orUndef(rating.minPlays),
    smartFilter:
      rating.smartFilter == null ? undefined : canonicalizeSmartFilter(rating.smartFilter),
    filterName: orUndef(rating.filterName),
  };
}

function canonicalizeMode(mode: CopyMode): CopyMode {
  if (mode.type === "album") {
    return { type: "album", range: canonicalizeCopyRange(mode.range) };
  }
  return { type: "filter", rating: canonicalizeRatingFilter(mode.rating) };
}

/** PathEntry keys in the exact declaration order of types/options.ts. */
function canonicalizePathEntry(entry: PathEntry): PathEntry {
  return {
    path: entry.path,
    range: entry.range == null ? undefined : canonicalizeCopyRange(entry.range),
    count: orUndef(entry.count),
    filterName: orUndef(entry.filterName),
    outputFolder: orUndef(entry.outputFolder),
    convertFormat: orUndef(entry.convertFormat),
    sourceNames: entry.sourceNames == null ? undefined : [...entry.sourceNames],
    sourceGroups: entry.sourceGroups == null ? undefined : [...entry.sourceGroups],
    sourceArtist: orUndef(entry.sourceArtist),
    sourceIndex: orUndef(entry.sourceIndex),
  };
}

/**
 * Total mirror of PlanExecutionOptions: every key is REQUIRED (values may
 * still be undefined). Object literals checked against this shape fail to
 * compile when any classified field is omitted, so a newly added
 * PlanExecutionOptions field can never be silently dropped from
 * canonicalization ({@link canonicalizeExecution}) or freezing
 * ({@link toPlanExecutionOptions}).
 */
type TotalPlanExecutionOptions = {
  [K in keyof Required<PlanExecutionOptions>]: PlanExecutionOptions[K];
};

function canonicalizeExecution(execution: PlanExecutionOptions): PlanExecutionOptions {
  return {
    mode: canonicalizeMode(execution.mode),
    albumOnly: execution.albumOnly,
    hardlink: execution.hardlink,
    convertFormat: orUndef(execution.convertFormat),
    force: execution.force,
    conflictStrategy: orUndef(execution.conflictStrategy),
    verify: orUndef(execution.verify),
    workers: execution.workers,
    file: orUndef(execution.file),
    paths: orUndef(execution.paths),
    progress: orUndef(execution.progress),
    trackCompleted: orUndef(execution.trackCompleted),
    completedFile: orUndef(execution.completedFile),
    resetCompleted: orUndef(execution.resetCompleted),
    plexScan: orUndef(execution.plexScan),
    plexUrl: orUndef(execution.plexUrl),
    plexLibrary: orUndef(execution.plexLibrary),
    plexPerSource: orUndef(execution.plexPerSource),
    trackingDatabase: orUndef(execution.trackingDatabase),
    useLegacyTracking: orUndef(execution.useLegacyTracking),
    requireDiskSpace: orUndef(execution.requireDiskSpace),
    cliRange: execution.cliRange == null ? undefined : canonicalizeCopyRange(execution.cliRange),
    configRange:
      execution.configRange == null ? undefined : canonicalizeCopyRange(execution.configRange),
    count: orUndef(execution.count),
    cliSourceEntries:
      execution.cliSourceEntries == null
        ? undefined
        : execution.cliSourceEntries.map(canonicalizePathEntry),
    verbose: orUndef(execution.verbose),
    sourceIdx: orUndef(execution.sourceIdx),
    sourceName: orUndef(execution.sourceName),
    sourceArtist: orUndef(execution.sourceArtist),
    sourceGroup: orUndef(execution.sourceGroup),
  } satisfies TotalPlanExecutionOptions;
}

function canonicalizeReviewEntry(entry: PlanReviewEntry): PlanReviewEntry {
  return {
    op: entry.op,
    kind: entry.kind,
    sourcePath: entry.sourcePath,
    destPath: entry.destPath,
    bytes: entry.bytes,
    sourceSize: orUndef(entry.sourceSize),
    sourceMtimeMs: orUndef(entry.sourceMtimeMs),
    fileCount: orUndef(entry.fileCount),
    reason: orUndef(entry.reason),
  };
}

function canonicalizeReview(review: PlanReviewSection): PlanReviewSection {
  return {
    advisory: true,
    note: review.note,
    granularity: review.granularity,
    truncated: review.truncated,
    rangeExpansion:
      review.rangeExpansion == null
        ? undefined
        : {
            start: review.rangeExpansion.start,
            end: review.rangeExpansion.end,
            padWidth: review.rangeExpansion.padWidth,
            copiesPerEntry: review.rangeExpansion.copiesPerEntry,
            note: review.rangeExpansion.note,
          },
    entries: review.entries.map(canonicalizeReviewEntry),
    summary: {
      create: review.summary.create,
      skip: review.summary.skip,
      overwrite: review.summary.overwrite,
      incomplete: review.summary.incomplete,
      filtered: review.summary.filtered,
      files: review.summary.files,
      bytes: review.summary.bytes,
    },
  };
}

function canonicalizeFingerprints(fingerprints: PlanFingerprints): PlanFingerprints {
  return {
    sources: fingerprints.sources.map(
      (source): PlanSourceFingerprint => ({
        path: source.path,
        exists: source.exists,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes,
        maxMtimeMs: source.maxMtimeMs,
      }),
    ),
    destination: {
      path: fingerprints.destination.path,
      exists: fingerprints.destination.exists,
    },
  };
}

function canonicalizeCreatedBy(createdBy: PlanCreatedBy): PlanCreatedBy {
  return {
    host: createdBy.host,
    user: createdBy.user,
    cliVersion: createdBy.cliVersion,
    cwd: createdBy.cwd,
  };
}

/**
 * Rebuilds the plan body with the fixed canonical key order. Both the write
 * path and the checksum path go through this, so read-side verification is
 * byte-stable regardless of the key order of the parsed input.
 */
function canonicalizePlanBody(
  plan: Omit<CopyPlanV1, "payloadChecksum">,
): Omit<CopyPlanV1, "payloadChecksum"> {
  return {
    version: plan.version,
    id: plan.id,
    createdAt: plan.createdAt,
    createdBy: canonicalizeCreatedBy(plan.createdBy),
    command: plan.command,
    destination: plan.destination,
    execution: canonicalizeExecution(plan.execution),
    optionsKey: plan.optionsKey,
    review: canonicalizeReview(plan.review),
    fingerprints: canonicalizeFingerprints(plan.fingerprints),
  };
}

/**
 * Computes the sha256 checksum over the canonical JSON (fixed key order,
 * 2-space indent) of the plan minus `payloadChecksum`.
 *
 * @param plan - Plan body without the checksum field.
 * @returns Checksum in `sha256:<hex>` form.
 */
export function computePlanChecksum(plan: Omit<CopyPlanV1, "payloadChecksum">): string {
  const canonical = JSON.stringify(canonicalizePlanBody(plan), null, 2);
  return `sha256:${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Allowlist validator
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "plexToken",
  "plexJwt",
  "plexCredential",
  "privateKey",
]);

function fail(detail: string): never {
  throw new PlanValidationError(detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`forbidden key "${key}" at ${path}`);
    assertNoForbiddenKeys(value[key], `${path}.${key}`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of required) {
    if (!(key in record) || record[key] === undefined) fail(`${path}.${key} is required`);
  }
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`unknown key ${path}.${key}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const text = requireString(value, path);
  if (text.length === 0) fail(`${path} must be a non-empty string`);
  return text;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path} must be a finite number`);
  return value;
}

function requireArray(value: unknown, path: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  if (value.length > maxItems) fail(`${path} exceeds the maximum of ${maxItems} items`);
  return value;
}

function requireOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function checkOptional<T>(
  value: unknown,
  path: string,
  check: (candidate: unknown, checkPath: string) => T,
): T | undefined {
  return isAbsent(value) ? undefined : check(value, path);
}

function assertCopyRange(value: unknown, path: string): void {
  const range = requireRecord(value, path);
  requireExactKeys(range, path, ["start", "end", "padWidth"]);
  requireFiniteNumber(range["start"], `${path}.start`);
  requireFiniteNumber(range["end"], `${path}.end`);
  requireFiniteNumber(range["padWidth"], `${path}.padWidth`);
}

function assertSmartFilterRules(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): void {
  if (depth > SMART_FILTER_MAX_DEPTH) {
    fail(`${path} exceeds the maximum smart-filter nesting depth of ${SMART_FILTER_MAX_DEPTH}`);
  }
  const rules = requireArray(value, path, SMART_FILTER_MAX_NODES);
  for (let index = 0; index < rules.length; index++) {
    const rulePath = `${path}[${index}]`;
    budget.nodes += 1;
    if (budget.nodes > SMART_FILTER_MAX_NODES) {
      fail(`smart filter exceeds the maximum of ${SMART_FILTER_MAX_NODES} total rules`);
    }
    const rule = requireRecord(rules[index], rulePath);
    const type = rule["type"];
    if (type === "rule") {
      requireExactKeys(rule, rulePath, ["type", "field", "operator", "value"]);
      requireOneOf(rule["field"], `${rulePath}.field`, [
        "rating",
        "genre",
        "artist",
        "year",
        "bpm",
        "date_added",
      ]);
      requireOneOf(rule["operator"], `${rulePath}.operator`, [
        ">=",
        "<=",
        "==",
        "contains",
        "within",
      ]);
      const ruleValue = rule["value"];
      if (typeof ruleValue !== "string" && typeof ruleValue !== "number") {
        fail(`${rulePath}.value must be a string or number`);
      }
    } else if (type === "group") {
      requireExactKeys(rule, rulePath, ["type", "match", "rules"]);
      requireOneOf(rule["match"], `${rulePath}.match`, ["all", "any"]);
      assertSmartFilterRules(rule["rules"], `${rulePath}.rules`, depth + 1, budget);
    } else {
      fail(`${rulePath}.type must be "rule" or "group"`);
    }
  }
}

function assertSmartFilter(value: unknown, path: string): void {
  const filter = requireRecord(value, path);
  requireExactKeys(filter, path, ["match", "rules"]);
  requireOneOf(filter["match"], `${path}.match`, ["all", "any"]);
  assertSmartFilterRules(filter["rules"], `${path}.rules`, 1, { nodes: 0 });
}

function assertRatingFilter(value: unknown, path: string): void {
  const rating = requireRecord(value, path);
  requireExactKeys(
    rating,
    path,
    ["outputFolder", "preserveStructure"],
    [
      "minStars",
      "minRating",
      "range",
      "albumMode",
      "minDuration",
      "maxDuration",
      "minBitrate",
      "codec",
      "minPlays",
      "smartFilter",
      "filterName",
    ],
  );
  checkOptional(rating["minStars"], `${path}.minStars`, requireFiniteNumber);
  checkOptional(rating["minRating"], `${path}.minRating`, requireFiniteNumber);
  requireString(rating["outputFolder"], `${path}.outputFolder`);
  requireBoolean(rating["preserveStructure"], `${path}.preserveStructure`);
  if (!isAbsent(rating["range"])) assertCopyRange(rating["range"], `${path}.range`);
  checkOptional(rating["albumMode"], `${path}.albumMode`, requireBoolean);
  checkOptional(rating["minDuration"], `${path}.minDuration`, requireFiniteNumber);
  checkOptional(rating["maxDuration"], `${path}.maxDuration`, requireFiniteNumber);
  checkOptional(rating["minBitrate"], `${path}.minBitrate`, requireFiniteNumber);
  checkOptional(rating["codec"], `${path}.codec`, requireString);
  checkOptional(rating["minPlays"], `${path}.minPlays`, requireFiniteNumber);
  if (!isAbsent(rating["smartFilter"]))
    assertSmartFilter(rating["smartFilter"], `${path}.smartFilter`);
  checkOptional(rating["filterName"], `${path}.filterName`, requireString);
}

function assertCopyMode(value: unknown, path: string): void {
  const mode = requireRecord(value, path);
  const type = mode["type"];
  if (type === "album") {
    requireExactKeys(mode, path, ["type", "range"]);
    assertCopyRange(mode["range"], `${path}.range`);
  } else if (type === "filter") {
    requireExactKeys(mode, path, ["type", "rating"]);
    assertRatingFilter(mode["rating"], `${path}.rating`);
  } else {
    fail(`${path}.type must be "album" or "filter"`);
  }
}

function assertStringArray(value: unknown, path: string): void {
  const items = requireArray(value, path, MAX_SOURCE_ENTRIES);
  items.forEach((item, index) => requireString(item, `${path}[${index}]`));
}

function assertPathEntry(value: unknown, path: string): void {
  const entry = requireRecord(value, path);
  requireExactKeys(
    entry,
    path,
    ["path"],
    [
      "range",
      "count",
      "filterName",
      "outputFolder",
      "convertFormat",
      "sourceNames",
      "sourceGroups",
      "sourceArtist",
      "sourceIndex",
    ],
  );
  requireNonEmptyString(entry["path"], `${path}.path`);
  if (!isAbsent(entry["range"])) assertCopyRange(entry["range"], `${path}.range`);
  checkOptional(entry["count"], `${path}.count`, requireFiniteNumber);
  checkOptional(entry["filterName"], `${path}.filterName`, requireString);
  checkOptional(entry["outputFolder"], `${path}.outputFolder`, requireString);
  if (!isAbsent(entry["convertFormat"])) {
    requireOneOf(entry["convertFormat"], `${path}.convertFormat`, ["alac", "mp3", "aac", "opus"]);
  }
  if (!isAbsent(entry["sourceNames"]))
    assertStringArray(entry["sourceNames"], `${path}.sourceNames`);
  if (!isAbsent(entry["sourceGroups"])) {
    assertStringArray(entry["sourceGroups"], `${path}.sourceGroups`);
  }
  checkOptional(entry["sourceArtist"], `${path}.sourceArtist`, requireString);
  checkOptional(entry["sourceIndex"], `${path}.sourceIndex`, requireFiniteNumber);
}

function assertExecution(value: unknown, path: string): void {
  const execution = requireRecord(value, path);
  requireExactKeys(
    execution,
    path,
    ["mode", "albumOnly", "hardlink", "force", "workers"],
    [
      "convertFormat",
      "conflictStrategy",
      "verify",
      "file",
      "paths",
      "progress",
      "trackCompleted",
      "completedFile",
      "resetCompleted",
      "plexScan",
      "plexUrl",
      "plexLibrary",
      "plexPerSource",
      "trackingDatabase",
      "useLegacyTracking",
      "requireDiskSpace",
      "cliRange",
      "configRange",
      "count",
      "cliSourceEntries",
      "verbose",
      "sourceIdx",
      "sourceName",
      "sourceArtist",
      "sourceGroup",
    ],
  );
  assertCopyMode(execution["mode"], `${path}.mode`);
  requireBoolean(execution["albumOnly"], `${path}.albumOnly`);
  requireBoolean(execution["hardlink"], `${path}.hardlink`);
  if (!isAbsent(execution["convertFormat"])) {
    requireOneOf(execution["convertFormat"], `${path}.convertFormat`, [
      "alac",
      "mp3",
      "aac",
      "opus",
    ]);
  }
  requireBoolean(execution["force"], `${path}.force`);
  if (!isAbsent(execution["conflictStrategy"])) {
    requireOneOf(execution["conflictStrategy"], `${path}.conflictStrategy`, [
      "skip",
      "overwrite",
      "rename",
      "ask",
    ]);
  }
  checkOptional(execution["verify"], `${path}.verify`, requireBoolean);
  requireFiniteNumber(execution["workers"], `${path}.workers`);
  checkOptional(execution["file"], `${path}.file`, requireString);
  checkOptional(execution["paths"], `${path}.paths`, requireString);
  checkOptional(execution["progress"], `${path}.progress`, requireBoolean);
  checkOptional(execution["trackCompleted"], `${path}.trackCompleted`, requireBoolean);
  checkOptional(execution["completedFile"], `${path}.completedFile`, requireString);
  checkOptional(execution["resetCompleted"], `${path}.resetCompleted`, requireBoolean);
  checkOptional(execution["plexScan"], `${path}.plexScan`, requireBoolean);
  checkOptional(execution["plexUrl"], `${path}.plexUrl`, requireString);
  checkOptional(execution["plexLibrary"], `${path}.plexLibrary`, requireString);
  checkOptional(execution["plexPerSource"], `${path}.plexPerSource`, requireBoolean);
  checkOptional(execution["trackingDatabase"], `${path}.trackingDatabase`, requireString);
  checkOptional(execution["useLegacyTracking"], `${path}.useLegacyTracking`, requireBoolean);
  checkOptional(execution["requireDiskSpace"], `${path}.requireDiskSpace`, requireBoolean);
  if (!isAbsent(execution["cliRange"])) assertCopyRange(execution["cliRange"], `${path}.cliRange`);
  if (!isAbsent(execution["configRange"])) {
    assertCopyRange(execution["configRange"], `${path}.configRange`);
  }
  checkOptional(execution["count"], `${path}.count`, requireFiniteNumber);
  if (!isAbsent(execution["cliSourceEntries"])) {
    const entries = requireArray(
      execution["cliSourceEntries"],
      `${path}.cliSourceEntries`,
      MAX_SOURCE_ENTRIES,
    );
    entries.forEach((entry, index) => assertPathEntry(entry, `${path}.cliSourceEntries[${index}]`));
  }
  checkOptional(execution["verbose"], `${path}.verbose`, requireBoolean);
  checkOptional(execution["sourceIdx"], `${path}.sourceIdx`, requireString);
  checkOptional(execution["sourceName"], `${path}.sourceName`, requireString);
  checkOptional(execution["sourceArtist"], `${path}.sourceArtist`, requireString);
  checkOptional(execution["sourceGroup"], `${path}.sourceGroup`, requireString);
}

function assertReviewEntry(value: unknown, path: string): void {
  const entry = requireRecord(value, path);
  requireExactKeys(
    entry,
    path,
    ["op", "kind", "sourcePath", "destPath", "bytes"],
    ["sourceSize", "sourceMtimeMs", "fileCount", "reason"],
  );
  requireOneOf(entry["op"], `${path}.op`, ["create", "skip", "overwrite", "incomplete"]);
  requireOneOf(entry["kind"], `${path}.kind`, ["copy", "convert", "hardlink"]);
  requireNonEmptyString(entry["sourcePath"], `${path}.sourcePath`);
  requireNonEmptyString(entry["destPath"], `${path}.destPath`);
  requireFiniteNumber(entry["bytes"], `${path}.bytes`);
  checkOptional(entry["sourceSize"], `${path}.sourceSize`, requireFiniteNumber);
  checkOptional(entry["sourceMtimeMs"], `${path}.sourceMtimeMs`, requireFiniteNumber);
  checkOptional(entry["fileCount"], `${path}.fileCount`, requireFiniteNumber);
  checkOptional(entry["reason"], `${path}.reason`, requireString);
}

function assertReview(value: unknown, path: string): void {
  const review = requireRecord(value, path);
  requireExactKeys(
    review,
    path,
    ["advisory", "note", "granularity", "truncated", "entries", "summary"],
    ["rangeExpansion"],
  );
  if (review["advisory"] !== true) fail(`${path}.advisory must be true`);
  requireString(review["note"], `${path}.note`);
  requireOneOf(review["granularity"], `${path}.granularity`, ["track", "suffix"]);
  requireBoolean(review["truncated"], `${path}.truncated`);
  if (!isAbsent(review["rangeExpansion"])) {
    const expansion = requireRecord(review["rangeExpansion"], `${path}.rangeExpansion`);
    requireExactKeys(expansion, `${path}.rangeExpansion`, [
      "start",
      "end",
      "padWidth",
      "copiesPerEntry",
      "note",
    ]);
    requireFiniteNumber(expansion["start"], `${path}.rangeExpansion.start`);
    requireFiniteNumber(expansion["end"], `${path}.rangeExpansion.end`);
    requireFiniteNumber(expansion["padWidth"], `${path}.rangeExpansion.padWidth`);
    requireFiniteNumber(expansion["copiesPerEntry"], `${path}.rangeExpansion.copiesPerEntry`);
    requireString(expansion["note"], `${path}.rangeExpansion.note`);
  }
  const entries = requireArray(review["entries"], `${path}.entries`, COPY_PLAN_MAX_ENTRIES);
  entries.forEach((entry, index) => assertReviewEntry(entry, `${path}.entries[${index}]`));
  const summary = requireRecord(review["summary"], `${path}.summary`);
  requireExactKeys(summary, `${path}.summary`, [
    "create",
    "skip",
    "overwrite",
    "incomplete",
    "filtered",
    "files",
    "bytes",
  ]);
  for (const key of ["create", "skip", "overwrite", "incomplete", "filtered", "files", "bytes"]) {
    requireFiniteNumber(summary[key], `${path}.summary.${key}`);
  }
}

function assertFingerprints(value: unknown, path: string): void {
  const fingerprints = requireRecord(value, path);
  requireExactKeys(fingerprints, path, ["sources", "destination"]);
  const sources = requireArray(fingerprints["sources"], `${path}.sources`, MAX_FINGERPRINT_SOURCES);
  sources.forEach((source, index) => {
    const sourcePath = `${path}.sources[${index}]`;
    const record = requireRecord(source, sourcePath);
    requireExactKeys(record, sourcePath, [
      "path",
      "exists",
      "fileCount",
      "totalBytes",
      "maxMtimeMs",
    ]);
    requireNonEmptyString(record["path"], `${sourcePath}.path`);
    requireBoolean(record["exists"], `${sourcePath}.exists`);
    requireFiniteNumber(record["fileCount"], `${sourcePath}.fileCount`);
    requireFiniteNumber(record["totalBytes"], `${sourcePath}.totalBytes`);
    requireFiniteNumber(record["maxMtimeMs"], `${sourcePath}.maxMtimeMs`);
  });
  const destination = requireRecord(fingerprints["destination"], `${path}.destination`);
  requireExactKeys(destination, `${path}.destination`, ["path", "exists"]);
  requireNonEmptyString(destination["path"], `${path}.destination.path`);
  requireBoolean(destination["exists"], `${path}.destination.exists`);
}

/**
 * Allowlist validator for untrusted plan artifacts: exact keys per section,
 * typed field asserts, bounded arrays, forbidden-key rejection (`__proto__`,
 * `constructor`, `prototype`, and any `plexToken` at any depth), and a locked
 * version/command pair.
 *
 * @param value - Untrusted parsed JSON value.
 * @throws PlanValidationError when any check fails.
 */
export function assertCopyPlanV1(value: unknown): asserts value is CopyPlanV1 {
  assertNoForbiddenKeys(value, "plan");
  const plan = requireRecord(value, "plan");
  requireExactKeys(plan, "plan", [
    "version",
    "id",
    "createdAt",
    "createdBy",
    "command",
    "destination",
    "execution",
    "optionsKey",
    "review",
    "fingerprints",
    "payloadChecksum",
  ]);
  if (plan["version"] !== COPY_PLAN_VERSION) {
    fail(
      `unsupported plan version ${JSON.stringify(plan["version"])}; this CLI only applies "${COPY_PLAN_VERSION}"`,
    );
  }
  requireNonEmptyString(plan["id"], "plan.id");
  const createdAt = requireNonEmptyString(plan["createdAt"], "plan.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) fail("plan.createdAt must be an ISO 8601 timestamp");
  const createdBy = requireRecord(plan["createdBy"], "plan.createdBy");
  requireExactKeys(createdBy, "plan.createdBy", ["host", "user", "cliVersion", "cwd"]);
  requireString(createdBy["host"], "plan.createdBy.host");
  requireString(createdBy["user"], "plan.createdBy.user");
  requireString(createdBy["cliVersion"], "plan.createdBy.cliVersion");
  requireString(createdBy["cwd"], "plan.createdBy.cwd");
  if (plan["command"] !== "copy") fail(`plan.command must be "copy"`);
  requireNonEmptyString(plan["destination"], "plan.destination");
  assertExecution(plan["execution"], "plan.execution");
  requireString(plan["optionsKey"], "plan.optionsKey");
  assertReview(plan["review"], "plan.review");
  assertFingerprints(plan["fingerprints"], "plan.fingerprints");
  const checksum = requireString(plan["payloadChecksum"], "plan.payloadChecksum");
  if (!CHECKSUM_PATTERN.test(checksum)) fail("plan.payloadChecksum must match sha256:<hex>");
}

// ---------------------------------------------------------------------------
// Execution layer freezing / rehydration
// ---------------------------------------------------------------------------

/**
 * Freezes the binding execution layer from live CopyOptions. Copies every
 * allowlisted field faithfully; callers strip a non-explicit
 * `conflictStrategy` BEFORE calling this (resolution 5 / Task D2).
 *
 * @param options - Fully built copy options.
 * @returns The allowlisted execution layer (never contains plexToken,
 *   dryRun, selection, or the runtime hooks).
 */
export function toPlanExecutionOptions(options: CopyOptions): PlanExecutionOptions {
  const execution = {
    mode: options.mode,
    albumOnly: options.albumOnly,
    hardlink: options.hardlink,
    convertFormat: options.convertFormat,
    force: options.force,
    conflictStrategy: options.conflictStrategy,
    verify: options.verify,
    workers: options.workers,
    file: options.file,
    paths: options.paths,
    progress: options.progress,
    trackCompleted: options.trackCompleted,
    completedFile: options.completedFile,
    resetCompleted: options.resetCompleted,
    plexScan: options.plexScan,
    plexUrl: options.plexUrl,
    plexLibrary: options.plexLibrary,
    plexPerSource: options.plexPerSource,
    trackingDatabase: options.trackingDatabase,
    useLegacyTracking: options.useLegacyTracking,
    requireDiskSpace: options.requireDiskSpace,
    cliRange: options.cliRange,
    configRange: options.configRange,
    count: options.count,
    cliSourceEntries: options.cliSourceEntries,
    verbose: options.verbose,
    sourceIdx: options.sourceIdx,
    sourceName: options.sourceName,
    sourceArtist: options.sourceArtist,
    sourceGroup: options.sourceGroup,
  } satisfies TotalPlanExecutionOptions;
  return execution;
}

/** Compile-time drift fence: adding a CopyOptions field breaks the build until classified. */
type ExcludedFromPlan =
  | "dryRun"
  | "selection"
  | "plexToken"
  | "capturePreview"
  | "onHistorySession";
type UnclassifiedCopyOptionKeys = Exclude<
  keyof CopyOptions,
  keyof PlanExecutionOptions | ExcludedFromPlan
>;
const _planAllowlistCoversCopyOptions: UnclassifiedCopyOptionKeys extends never ? true : never =
  true;
void _planAllowlistCoversCopyOptions;

/**
 * Rehydrates live CopyOptions from a plan's frozen execution layer — mirrors
 * the queue's private toCopyOptions (actions/queue.ts).
 *
 * @param plan - Verified plan artifact.
 * @param dryRun - Whether the replay is a dry run.
 * @returns CopyOptions for the copy entry points.
 */
export function planToCopyOptions(plan: CopyPlanV1, dryRun: boolean): CopyOptions {
  return { ...plan.execution, dryRun };
}

// ---------------------------------------------------------------------------
// Source fingerprinting
// ---------------------------------------------------------------------------

/**
 * Recursively aggregates a source directory into a fingerprint: fileCount,
 * totalBytes, and the maximum `Math.trunc(stat.mtimeMs)` over regular files
 * (resolution 20). Symlinks are never followed. A missing path or non-directory
 * short-circuits to `exists: false` with zeroed aggregates.
 *
 * @param dirPath - Source directory path.
 * @returns The fingerprint of the directory tree.
 */
export async function fingerprintSourceDir(dirPath: string): Promise<PlanSourceFingerprint> {
  const resolvedPath = resolve(dirPath);
  const absent: PlanSourceFingerprint = {
    path: resolvedPath,
    exists: false,
    fileCount: 0,
    totalBytes: 0,
    maxMtimeMs: 0,
  };
  try {
    const rootStat = await stat(resolvedPath);
    if (!rootStat.isDirectory()) return absent;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return absent;
    throw error;
  }

  let fileCount = 0;
  let totalBytes = 0;
  let maxMtimeMs = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const entryStat = await stat(entryPath);
        fileCount += 1;
        totalBytes += entryStat.size;
        const mtime = Math.trunc(entryStat.mtimeMs);
        if (mtime > maxMtimeMs) maxMtimeMs = mtime;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
    }
  };
  await walk(resolvedPath);
  return { path: resolvedPath, exists: true, fileCount, totalBytes, maxMtimeMs };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

/** Inputs for {@link buildCopyPlan}; everything else is filled automatically. */
export interface BuildCopyPlanArgs {
  destination: string;
  execution: PlanExecutionOptions;
  optionsKey: string;
  review: PlanReviewSection;
  fingerprints: PlanFingerprints;
}

/**
 * Assembles a complete plan: fills version/id/createdAt/createdBy from the
 * environment, canonicalizes the body, and computes the payload checksum.
 * Pure assembly, no IO.
 *
 * @param args - Frozen sections produced by plan generation.
 * @returns A checksum-sealed CopyPlanV1.
 */
export function buildCopyPlan(args: BuildCopyPlanArgs): CopyPlanV1 {
  const body = canonicalizePlanBody({
    version: COPY_PLAN_VERSION,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    createdBy: {
      host: hostname(),
      user: userInfo().username,
      cliVersion: pkg.version,
      cwd: process.cwd(),
    },
    command: "copy",
    destination: args.destination,
    execution: args.execution,
    optionsKey: args.optionsKey,
    review: args.review,
    fingerprints: args.fingerprints,
  });
  return { ...body, payloadChecksum: computePlanChecksum(body) };
}

// ---------------------------------------------------------------------------
// Hardened artifact IO (ported from rfapps plan-storage, adapted to
// PlanArtifactError and COPY_PLAN_MAX_BYTES)
// ---------------------------------------------------------------------------

function validateArtifactPath(inputPath: string): string {
  if (
    inputPath.length === 0 ||
    inputPath.length > SECURE_STORE_MAX_PATH_LENGTH ||
    inputPath.includes("\0") ||
    inputPath.split(/[\\/]/u).includes("..")
  ) {
    throw unsafePlanPath("Plan artifact path is empty, unbounded, or contains traversal");
  }
  const artifactPath = resolve(inputPath);
  if (basename(artifactPath).length === 0 || artifactPath === parse(artifactPath).root) {
    throw unsafePlanPath("Plan artifact path must identify a file", artifactPath);
  }
  return artifactPath;
}

async function inspectExistingArtifact(
  artifactPath: string,
  overwrite: boolean,
): Promise<FileIdentity | undefined> {
  try {
    const artifactStat = await lstat(artifactPath);
    if (artifactStat.isSymbolicLink() || !artifactStat.isFile()) {
      throw unsafePlanPath(
        "Plan artifact output must be a regular file and not a symbolic link",
        artifactPath,
      );
    }
    if (!overwrite) {
      throw planExistsError(artifactPath);
    }
    return { dev: artifactStat.dev, ino: artifactStat.ino };
  } catch (error) {
    if (error instanceof PlanArtifactError) throw error;
    if (!hasCode(error, "ENOENT")) {
      throw unsafePlanPath("Plan artifact output cannot be inspected", artifactPath, error);
    }
    return undefined;
  }
}

/**
 * Atomically writes a plan artifact with hardened IO: validated symlink-free
 * path, private 0o700 directory, size cap, exclusive temp file, fsync, atomic
 * rename, and 0o600 file mode.
 *
 * @param inputPath - Target artifact path.
 * @param plan - Checksum-sealed plan to persist.
 * @param options - Set `overwrite: true` to replace an existing regular file.
 * @returns The resolved artifact path.
 * @throws PlanArtifactError with code `PLAN_EXISTS` when the path exists and
 *   overwrite is not enabled, `PLAN_TOO_LARGE`, `PLAN_UNSAFE_PATH`, or `PLAN_IO`.
 */
export async function writePlanArtifact(
  inputPath: string,
  plan: CopyPlanV1,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const artifactPath = validateArtifactPath(inputPath);
  try {
    await prepareSafeParent(artifactPath, true, PLAN_ARTIFACT_SUBJECT, "harden-private");
    const existingIdentity = await inspectExistingArtifact(
      artifactPath,
      options.overwrite === true,
    );

    const { payloadChecksum, ...body } = plan;
    const canonical: CopyPlanV1 = { ...canonicalizePlanBody(body), payloadChecksum };
    const content = `${JSON.stringify(canonical, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf-8") > COPY_PLAN_MAX_BYTES) {
      throw planTooLargeError(artifactPath);
    }

    const input = {
      path: artifactPath,
      text: content,
      subject: PLAN_ARTIFACT_SUBJECT,
      temporaryId: basename(artifactPath),
      finalParentPolicy: "harden-private" as const,
    };
    if (existingIdentity === undefined) {
      await createPrivateFileAtomically(input);
    } else {
      await replacePrivateFileAtomically({ ...input, expectedIdentity: existingIdentity });
    }
  } catch (error) {
    translatePlanArtifactFailure(error, artifactPath, "write");
  }
  return artifactPath;
}

async function readRawPlanArtifact(artifactPath: string): Promise<unknown> {
  try {
    const read = await readBoundedPrivateFile(
      artifactPath,
      COPY_PLAN_MAX_BYTES,
      PLAN_ARTIFACT_SUBJECT,
      "allow-foreign-read",
      "read-compatible",
    );
    if (read === undefined) {
      throw planIoError("Unable to read the plan artifact", artifactPath);
    }
    try {
      return JSON.parse(read.text) as unknown;
    } catch (error) {
      throw new PlanArtifactError(
        "PLAN_MALFORMED",
        "Plan artifact contains malformed JSON",
        artifactPath,
        {
          cause: error,
        },
      );
    }
  } catch (error) {
    translatePlanArtifactFailure(error, artifactPath, "read");
  }
}

/**
 * Reads and fully verifies a plan artifact: path validation, symlink rejection,
 * size cap, dev/ino recheck, JSON parse, allowlist validation, and checksum
 * verification. Returns the canonicalized plan or throws.
 *
 * @param inputPath - Artifact path to read.
 * @returns The verified, canonicalized plan.
 * @throws PlanArtifactError for IO/safety/tamper failures (checksum mismatch is
 *   never overridable) or PlanValidationError for allowlist failures.
 */
export async function readPlanArtifact(inputPath: string): Promise<CopyPlanV1> {
  const artifactPath = validateArtifactPath(inputPath);
  const raw = await readRawPlanArtifact(artifactPath);
  try {
    assertCopyPlanV1(raw);
  } catch (error) {
    if (error instanceof PlanValidationError) {
      throw new PlanValidationError(error.detail, artifactPath);
    }
    throw error;
  }
  const { payloadChecksum, ...body } = raw;
  const expectedChecksum = computePlanChecksum(body);
  if (expectedChecksum !== payloadChecksum) {
    throw new PlanArtifactError(
      "PLAN_CHECKSUM_MISMATCH",
      "Plan payload checksum mismatch: the artifact was modified after creation",
      artifactPath,
    );
  }
  return { ...canonicalizePlanBody(body), payloadChecksum };
}

// ---------------------------------------------------------------------------
// Staleness matrix (world drift only)
// ---------------------------------------------------------------------------

function makeFinding(
  severity: PlanStalenessSeverity,
  code: PlanStalenessCode,
  message: string,
  paths: string[] | undefined,
  overridable: boolean,
): PlanStalenessFinding {
  if (paths === undefined || paths.length === 0) {
    return { severity, code, message, overridable };
  }
  const capped = paths.slice(0, STALENESS_PATHS_CAP);
  const extra = paths.length - capped.length;
  return {
    severity,
    code,
    message: extra > 0 ? `${message} (+${extra} more)` : message,
    paths: capped,
    overridable,
  };
}

async function pathExistsSafe(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

/**
 * Runs the world-drift staleness matrix against the current filesystem.
 * Hard corruption errors are NOT findings — they throw earlier in
 * {@link readPlanArtifact} and are never re-classified here.
 *
 * With `forceStale: true`, every overridable error finding moves to
 * `overridden` (and `warnings`); `errors` retains only what remains.
 *
 * @param plan - Verified plan artifact.
 * @param options - `forceStale` downgrade flag and an optional `now` clock seam.
 * @returns The classified staleness report (findings errors-first).
 */
export async function checkStaleness(
  plan: CopyPlanV1,
  options: { forceStale: boolean; now?: number },
): Promise<PlanStalenessReport> {
  const now = options.now ?? Date.now();
  const errors: PlanStalenessFinding[] = [];
  const nativeWarnings: PlanStalenessFinding[] = [];

  const missingSources: string[] = [];
  const driftedSources: string[] = [];
  for (const stored of plan.fingerprints.sources) {
    const current = await fingerprintSourceDir(stored.path);
    if (!current.exists) {
      missingSources.push(stored.path);
      continue;
    }
    if (
      !stored.exists ||
      current.fileCount !== stored.fileCount ||
      current.totalBytes !== stored.totalBytes ||
      current.maxMtimeMs !== stored.maxMtimeMs
    ) {
      driftedSources.push(stored.path);
    }
  }
  if (missingSources.length > 0) {
    errors.push(
      makeFinding(
        "error",
        "source-missing",
        `${missingSources.length} source path(s) are missing or no longer directories since planning`,
        missingSources,
        true,
      ),
    );
  }
  if (driftedSources.length > 0) {
    errors.push(
      makeFinding(
        "error",
        "source-drift",
        `${driftedSources.length} source director(y/ies) changed since planning (fileCount/totalBytes/maxMtimeMs differ)`,
        driftedSources,
        true,
      ),
    );
  }

  if (plan.execution.mode.type === "filter" && !plan.review.truncated) {
    const driftedEntries: string[] = [];
    const seenSources = new Set<string>();
    for (const entry of plan.review.entries) {
      if (entry.sourceSize === undefined && entry.sourceMtimeMs === undefined) continue;
      if (seenSources.has(entry.sourcePath)) continue;
      seenSources.add(entry.sourcePath);
      try {
        const entryStat = await stat(entry.sourcePath);
        const sizeDrift = entry.sourceSize !== undefined && entryStat.size !== entry.sourceSize;
        const mtimeDrift =
          entry.sourceMtimeMs !== undefined &&
          Math.trunc(entryStat.mtimeMs) !== entry.sourceMtimeMs;
        if (sizeDrift || mtimeDrift) driftedEntries.push(entry.sourcePath);
      } catch (error) {
        if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
          driftedEntries.push(entry.sourcePath);
        } else {
          throw error;
        }
      }
    }
    if (driftedEntries.length > 0) {
      errors.push(
        makeFinding(
          "error",
          "entry-drift",
          `${driftedEntries.length} reviewed source file(s) changed or vanished since planning`,
          driftedEntries,
          true,
        ),
      );
    }
  }

  const createdAtMs = Date.parse(plan.createdAt);
  if (Number.isFinite(createdAtMs) && now - createdAtMs > PLAN_AGE_WARNING_MS) {
    const hours = Math.floor((now - createdAtMs) / 3_600_000);
    nativeWarnings.push(
      makeFinding(
        "warning",
        "plan-age",
        `Plan is ~${hours}h old (created ${plan.createdAt}); the review snapshot may no longer reflect the filesystem`,
        undefined,
        false,
      ),
    );
  }
  const currentHost = hostname();
  if (plan.createdBy.host !== currentHost) {
    nativeWarnings.push(
      makeFinding(
        "warning",
        "host-mismatch",
        `Plan was created on host "${plan.createdBy.host}" but is being applied on "${currentHost}"`,
        undefined,
        false,
      ),
    );
  }
  if (plan.createdBy.cliVersion !== pkg.version) {
    nativeWarnings.push(
      makeFinding(
        "warning",
        "cli-version",
        `Plan was created by rfmedia ${plan.createdBy.cliVersion} but is being applied by ${pkg.version}`,
        undefined,
        false,
      ),
    );
  }

  if (!plan.review.truncated) {
    const destDrifted: string[] = [];
    const seenDests = new Set<string>();
    for (const entry of plan.review.entries) {
      if (seenDests.has(entry.destPath)) continue;
      seenDests.add(entry.destPath);
      if (entry.op === "create") {
        if (await pathExistsSafe(entry.destPath)) destDrifted.push(entry.destPath);
      } else if (entry.op === "skip" || entry.op === "overwrite") {
        if (!(await pathExistsSafe(entry.destPath))) destDrifted.push(entry.destPath);
      }
    }
    if (destDrifted.length > 0) {
      nativeWarnings.push(
        makeFinding(
          "warning",
          "dest-drift",
          `${destDrifted.length} destination path(s) no longer match the reviewed create/skip/overwrite decisions`,
          destDrifted,
          false,
        ),
      );
    }
  }

  const namedFilterEntries = (plan.execution.cliSourceEntries ?? []).filter(
    (entry) => entry.filterName !== undefined,
  );
  if (namedFilterEntries.length > 0) {
    nativeWarnings.push(
      makeFinding(
        "warning",
        "filter-resolution",
        "Per-source filter definitions resolve from the CURRENT config at apply; an edited filter executes different filtering than reviewed",
        namedFilterEntries.map((entry) => entry.path),
        false,
      ),
    );
  }

  if (plan.review.truncated) {
    nativeWarnings.push(
      makeFinding(
        "warning",
        "review-truncated",
        `Review entries were truncated at plan time (cap ${COPY_PLAN_MAX_ENTRIES}); per-entry staleness checks degraded to source-dir checks`,
        undefined,
        false,
      ),
    );
  }

  const findings = [...errors, ...nativeWarnings];
  if (options.forceStale) {
    const overridden = errors.filter((finding) => finding.overridable);
    const remaining = errors.filter((finding) => !finding.overridable);
    return {
      findings,
      errors: remaining,
      overridden,
      warnings: [...nativeWarnings, ...overridden],
    };
  }
  return { findings, errors, overridden: [], warnings: nativeWarnings };
}

// ---------------------------------------------------------------------------
// Apply audit ledger
// ---------------------------------------------------------------------------

/**
 * Appends one JSONL record to the audit ledger as a SINGLE write() of
 * `JSON.stringify(record) + "\n"`, opening with
 * `O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW` mode 0o600 after securing the
 * ledger directory. NON-BLOCKING: any failure logs a warning and never throws.
 *
 * @param record - Application record to append.
 */
export async function appendPlanAudit(record: PlanApplicationRecord): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const ledgerPath = getAuditLedgerPath();
    await prepareSafeParent(ledgerPath, true, PLAN_AUDIT_SUBJECT, "harden-private");
    handle = await open(
      ledgerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.write(`${JSON.stringify(record)}\n`, null, "utf-8");
  } catch (error) {
    logWarn(
      `Failed to record plan application in the audit ledger: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isPlanApplicationRecord(value: unknown): value is PlanApplicationRecord {
  return (
    isRecord(value) &&
    typeof value["planId"] === "string" &&
    typeof value["planPath"] === "string" &&
    typeof value["appliedAt"] === "string" &&
    typeof value["status"] === "string" &&
    isRecord(value["counts"])
  );
}

/**
 * Linear scan of the audit ledger for records matching a plan id.
 * Malformed or foreign lines are skipped with a debug log; a missing ledger
 * yields an empty result. NON-BLOCKING (matching {@link appendPlanAudit}):
 * any other read failure (EACCES, ELOOP, ...) logs a warning to stderr and
 * yields an empty result — the ledger only feeds the advisory
 * already-applied warning and must never block an apply.
 *
 * @param planId - Plan id to look up.
 * @returns All matching application records in append order.
 */
export async function findPlanApplications(planId: string): Promise<PlanApplicationRecord[]> {
  const ledgerPath = getAuditLedgerPath();
  let content: string;
  let handle: FileHandle | undefined;
  try {
    handle = await open(ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    content = await handle.readFile("utf-8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      logWarn(
        `Unable to read the plan audit ledger at ${ledgerPath}; skipping the already-applied check: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const records: PlanApplicationRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isPlanApplicationRecord(parsed) && parsed.planId === planId) {
        records.push(parsed);
      }
    } catch {
      logDebug(`Skipping malformed audit ledger line: ${trimmed.slice(0, 120)}`);
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Plans directory maintenance
// ---------------------------------------------------------------------------

/**
 * Deletes the oldest managed `plan-*.json` artifacts beyond `max` (mtime
 * order). Never touches `audit.jsonl` or unmanaged files. Concurrency-safe:
 * ENOENT from stat OR unlink (file already pruned by a concurrent generation)
 * is swallowed and the scan continues.
 *
 * @param max - Number of newest plans to retain (default {@link MAX_PLANS}).
 */
export async function prunePlans(max: number = MAX_PLANS): Promise<void> {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(`prunePlans max must be a non-negative integer, got ${max}`);
  }
  const planDir = getDefaultPlanDir();
  let entries;
  try {
    entries = await readdir(planDir, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw planIoError("Unable to scan the plans directory", planDir, error);
  }

  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MANAGED_PLAN_FILE_PATTERN.test(entry.name)) continue;
    const entryPath = join(planDir, entry.name);
    try {
      const entryStat = await stat(entryPath);
      candidates.push({ path: entryPath, mtimeMs: entryStat.mtimeMs });
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  if (candidates.length <= max) return;
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const excess = candidates.slice(0, candidates.length - max);
  for (const candidate of excess) {
    try {
      await unlink(candidate.path);
      logDebug(`Pruned old plan artifact: ${candidate.path}`);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}
