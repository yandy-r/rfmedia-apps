/**
 * Change-origin baseline loading for contextual plan annotations (issue #152).
 *
 * This is the only filesystem I/O the plan-intelligence feature performs: one
 * directory scan, at most `MAX_BASELINE_CANDIDATES` plan reads, and one compose
 * file hash — all paid exclusively under `rfapps plan --explain`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { logDebug } from "@rfmedia/common";

import {
  MAX_BASELINE_CANDIDATES,
  type PlanBaselineResult,
  type PlanBaselineService,
} from "../types/plan-intelligence.js";
import { hashFile } from "./plan-storage.js";

/**
 * Directory scanned for baseline candidates.
 *
 * Deliberately duplicated from `plan-storage.ts`, where `DEFAULT_PLAN_DIR` is
 * module-private: that module is on the design's "not changed (verified)" list,
 * so the constant is mirrored here rather than exported there.
 */
const PLAN_DIR = ".rfapps/plans";

/** Saved plan file name shape produced by `savePlan`. */
const PLAN_FILE_PREFIX = "plan-";
const PLAN_FILE_SUFFIX = ".json";

/** SHA-256 hex shape. Any other fingerprint value is dropped at this boundary. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** Baseline-relevant fields of an untrusted saved plan. */
interface CandidatePlan {
  readonly id: string;
  readonly createdAt: string;
  readonly composeHash: string;
  readonly composePath: string;
  readonly intent: string | undefined;
  readonly profiles: readonly string[];
  /** Raw `services` value; narrowed one entry at a time by `liftBaselineServices`. */
  readonly services: unknown;
}

/**
 * Find the newest saved plan usable as a change-origin baseline.
 *
 * A candidate qualifies only when it targets the SAME compose file with the
 * SAME profile set: the saved plan directory is mtime-ordered with no filtering
 * and `savePlan` runs on every `rfapps plan`, so an unfiltered "newest" would
 * compare one compose file's bytes against another file's hash.
 *
 * Best effort: every failure resolves to `{ status: "unavailable", ... }`
 * instead of rejecting, and nothing is logged above `logDebug`.
 *
 * @param composePath - compose file the current plan targets
 * @param profiles - resolved profiles for the current plan
 */
export async function loadPlanBaseline(
  composePath: string,
  profiles: readonly string[],
): Promise<PlanBaselineResult> {
  let candidatePaths: readonly string[];
  try {
    candidatePaths = await listCandidatePaths();
  } catch (error) {
    logDebug(
      `Plan baseline: cannot read ${PLAN_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "unavailable", reason: "plan-history-unreadable" };
  }

  const wantedProfiles = [...profiles].sort();

  for (const candidatePath of candidatePaths) {
    const candidate = await readCandidate(candidatePath);
    if (candidate === undefined || !isScopeCompatible(candidate, composePath, wantedProfiles)) {
      continue;
    }

    // `hashFile` yields "" when the compose file cannot be read, which reports
    // the file as changed — the conservative direction for an inferred reason.
    const currentHash = await hashFile(composePath);

    return {
      status: "loaded",
      baseline: {
        planId: candidate.id,
        createdAt: candidate.createdAt,
        composeFileChanged: currentHash !== candidate.composeHash,
        services: liftBaselineServices(candidate.services),
      },
    };
  }

  return { status: "unavailable", reason: "no-comparable-plan" };
}

/** A plan file paired with the mtime the newest-first ordering uses. */
interface DatedPlanFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Newest-first saved plan paths, capped at `MAX_BASELINE_CANDIDATES`.
 *
 * The cap is applied before any plan is read, so the I/O budget stays at one
 * directory scan plus at most `MAX_BASELINE_CANDIDATES` file reads.
 *
 * Only a `readdir` failure propagates: that is the sole condition under which
 * the plan history genuinely could not be read.
 */
async function listCandidatePaths(): Promise<readonly string[]> {
  const entries = await readdir(PLAN_DIR);
  const planFiles = entries.filter(
    (entry) => entry.startsWith(PLAN_FILE_PREFIX) && entry.endsWith(PLAN_FILE_SUFFIX),
  );

  const stated = await Promise.all(planFiles.map((name) => statPlanFile(name)));
  const dated = stated.filter((entry): entry is DatedPlanFile => entry !== undefined);

  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return dated.slice(0, MAX_BASELINE_CANDIDATES).map((entry) => entry.path);
}

/**
 * Stat one directory entry, dropping it on failure.
 *
 * A plan file unlinked between `readdir` and `stat`, or one whose mode blocks
 * the current user, is a single stale artifact — it must not collapse the whole
 * scan into `plan-history-unreadable`.
 */
async function statPlanFile(name: string): Promise<DatedPlanFile | undefined> {
  const path = join(PLAN_DIR, name);
  try {
    const stats = await stat(path);
    return { path, mtimeMs: stats.mtimeMs };
  } catch (error) {
    logDebug(
      `Plan baseline: skipping ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Read and parse one candidate defensively.
 *
 * Parsing is done here rather than through `loadPlan`, which swallows failures
 * and reports them at WARN: a truncated or hand-edited `plan-*.json` is not
 * actionable by the operator and does not affect the plan, so every failure
 * stays at `logDebug` and a single stale artifact never fails `rfapps plan`.
 */
async function readCandidate(planPath: string): Promise<CandidatePlan | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(planPath, "utf-8"));
    return narrowCandidate(raw);
  } catch (error) {
    logDebug(
      `Plan baseline: skipping ${planPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Narrow an untrusted parsed plan to the fields a baseline needs. */
function narrowCandidate(value: unknown): CandidatePlan | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const {
    id,
    createdAt,
    composeHash,
    composePath,
    intent,
    profiles: rawProfiles,
    services,
  } = record;

  if (typeof id !== "string" || typeof createdAt !== "string") {
    return undefined;
  }
  if (typeof composeHash !== "string" || typeof composePath !== "string") {
    return undefined;
  }
  if (intent !== undefined && typeof intent !== "string") {
    return undefined;
  }

  const profiles = readStringArray(rawProfiles);
  if (profiles === undefined) {
    return undefined;
  }

  return { id, createdAt, composeHash, composePath, intent, profiles, services };
}

/** Read an optional string array; `undefined` means the value was malformed. */
function readStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries: readonly unknown[] = value;
  const parsed: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      return undefined;
    }
    parsed.push(entry);
  }

  return parsed;
}

/**
 * Baseline eligibility: all four predicates are required.
 *
 * A `managed-update` plan records a different intent and scope, and an empty
 * `composeHash` means `savePlan` could not read the compose file, which would
 * make every service look edited.
 */
function isScopeCompatible(
  candidate: CandidatePlan,
  composePath: string,
  wantedProfiles: readonly string[],
): boolean {
  if (candidate.intent === "managed-update") {
    return false;
  }
  if (candidate.composePath !== composePath) {
    return false;
  }
  if (candidate.composeHash.length === 0) {
    return false;
  }

  const candidateProfiles = [...candidate.profiles].sort();
  return (
    candidateProfiles.length === wantedProfiles.length &&
    candidateProfiles.every((profile, index) => profile === wantedProfiles[index])
  );
}

/**
 * Lift per-service fingerprints out of a baseline plan.
 *
 * Only 64-hex `resolvedConfigFingerprint` values cross this boundary. No other
 * field is lifted — saved plans persist resolved environment values unmasked,
 * so an `EnvChange` must never reach the annotation pipeline.
 */
function liftBaselineServices(value: unknown): Record<string, PlanBaselineService> {
  const services: Record<string, PlanBaselineService> = {};
  if (!Array.isArray(value)) {
    return services;
  }

  const entries: readonly unknown[] = value;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const { service, resolvedConfigFingerprint } = record;
    if (typeof service !== "string" || typeof resolvedConfigFingerprint !== "string") {
      continue;
    }
    if (!FINGERPRINT_PATTERN.test(resolvedConfigFingerprint)) {
      continue;
    }

    services[service] = { resolvedConfigFingerprint };
  }

  return services;
}
