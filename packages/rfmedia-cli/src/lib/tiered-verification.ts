import { lstat } from "node:fs/promises";
import { normalize } from "node:path";

import type { DbInventoryFingerprint } from "../types/db.js";
import type { VerificationTier } from "../types/options.js";
import type {
  FailedOperation,
  FileVerifyStatus,
  VerificationEvidence,
  VerificationReason,
  VerifiedFile,
  VerifyCommandResult,
} from "../types/results.js";
import {
  calculateHash,
  compareFileBytes,
  FileChangedDuringReadError,
  type ByteCompareResult,
} from "./integrity.js";

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface FingerprintIdentity {
  sourcePath: string;
  relativePath: string;
  destinationPath: string;
  convertKey: string | null;
}

export type FingerprintResolution =
  | { status: "found"; fingerprint: DbInventoryFingerprint }
  | { status: "missing" }
  | { status: "ambiguous" };

export interface VerificationStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface VerificationDependencies {
  statFile(path: string): Promise<VerificationStat>;
  calculateHash(path: string, signal?: AbortSignal): Promise<string>;
  compareFileBytes(
    sourcePath: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<ByteCompareResult>;
}

export interface VerifyFileInput {
  tier: VerificationTier;
  sourcePath: string;
  destinationPath: string;
  converted: boolean;
  fingerprint?: DbInventoryFingerprint;
  fingerprintReason?: "fingerprint-missing" | "fingerprint-ambiguous";
  verifySize?: boolean;
  signal?: AbortSignal;
}

interface PresentOutcome {
  status: "present";
  evidence: readonly VerificationEvidence[];
  notApplicableReason?: "conversion-byte-compare" | "same-inode-byte-compare";
}

interface SizeMismatchOutcome {
  status: "size-mismatch";
  evidence: readonly ["metadata"];
  expectedSize: number;
  actualSize: number;
}

interface ReasonedOutcome {
  status: "metadata-mismatch" | "unverifiable" | "unstable";
  evidence: readonly VerificationEvidence[];
  reason: VerificationReason;
  expectedSize?: number;
  actualSize?: number;
}

interface ContentMismatchOutcome {
  status: "hash-mismatch" | "content-mismatch";
  evidence: readonly VerificationEvidence[];
}

export type VerifyFileOutcome =
  | PresentOutcome
  | SizeMismatchOutcome
  | ReasonedOutcome
  | ContentMismatchOutcome;

const defaultDependencies: VerificationDependencies = {
  statFile: async (path) => {
    const result = await lstat(path);
    return { size: result.size, mtimeMs: result.mtimeMs, isFile: result.isFile() };
  },
  calculateHash,
  compareFileBytes,
};

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

/** Resolves exact evidence without guessing across related operations or destinations. */
export function resolveFingerprintCandidate(
  candidates: readonly DbInventoryFingerprint[],
  identity: FingerprintIdentity,
): FingerprintResolution {
  const matches = candidates.filter(
    (candidate) =>
      samePath(candidate.source_path, identity.sourcePath) &&
      samePath(candidate.relative_path, identity.relativePath) &&
      samePath(candidate.dest_path, identity.destinationPath) &&
      candidate.convert_key === identity.convertKey,
  );

  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length > 1) {
    return { status: "ambiguous" };
  }
  return { status: "found", fingerprint: matches[0]! };
}

async function compareSizes(
  input: VerifyFileInput,
  dependencies: VerificationDependencies,
): Promise<SizeMismatchOutcome | undefined> {
  const [sourceStats, destinationStats] = await Promise.all([
    dependencies.statFile(input.sourcePath),
    dependencies.statFile(input.destinationPath),
  ]);
  input.signal?.throwIfAborted();
  if (sourceStats.size === destinationStats.size) {
    return undefined;
  }
  return {
    status: "size-mismatch",
    evidence: ["metadata"],
    expectedSize: sourceStats.size,
    actualSize: destinationStats.size,
  };
}

async function verifyQuick(
  input: VerifyFileInput,
  dependencies: VerificationDependencies,
): Promise<VerifyFileOutcome> {
  if (input.converted) {
    return {
      status: "unverifiable",
      evidence: [],
      reason: "conversion-metadata-unavailable",
    };
  }

  const [sourceStats, destinationStats] = await Promise.all([
    dependencies.statFile(input.sourcePath),
    dependencies.statFile(input.destinationPath),
  ]);
  input.signal?.throwIfAborted();
  if (!sourceStats.isFile) {
    throw new Error(`Verification source is not a regular file: ${input.sourcePath}`);
  }
  if (!destinationStats.isFile) {
    throw new Error(`Verification destination is not a regular file: ${input.destinationPath}`);
  }
  if (sourceStats.size !== destinationStats.size) {
    return {
      status: "size-mismatch",
      evidence: ["metadata"],
      expectedSize: sourceStats.size,
      actualSize: destinationStats.size,
    };
  }
  if (Math.trunc(sourceStats.mtimeMs) !== Math.trunc(destinationStats.mtimeMs)) {
    return {
      status: "metadata-mismatch",
      evidence: ["metadata"],
      reason: "mtime",
      expectedSize: sourceStats.size,
      actualSize: destinationStats.size,
    };
  }
  return { status: "present", evidence: ["metadata"] };
}

function unavailableFingerprint(input: VerifyFileInput): VerifyFileOutcome | undefined {
  if (input.fingerprintReason) {
    return { status: "unverifiable", evidence: [], reason: input.fingerprintReason };
  }
  if (!input.fingerprint) {
    return { status: "unverifiable", evidence: [], reason: "fingerprint-missing" };
  }
  if (input.fingerprint.content_hash === null) {
    return { status: "unverifiable", evidence: [], reason: "fingerprint-null" };
  }
  if (!SHA256_HEX_PATTERN.test(input.fingerprint.content_hash)) {
    return { status: "unverifiable", evidence: [], reason: "fingerprint-invalid" };
  }
  return undefined;
}

async function verifyDefault(
  input: VerifyFileInput,
  dependencies: VerificationDependencies,
): Promise<VerifyFileOutcome> {
  const unavailable = unavailableFingerprint(input);
  if (unavailable) {
    return unavailable;
  }

  if (input.verifySize && !input.converted) {
    const mismatch = await compareSizes(input, dependencies);
    if (mismatch) {
      return mismatch;
    }
  }

  try {
    const actualHash = await dependencies.calculateHash(input.destinationPath, input.signal);
    input.signal?.throwIfAborted();
    if (actualHash !== input.fingerprint!.content_hash) {
      return { status: "hash-mismatch", evidence: ["hash"] };
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof FileChangedDuringReadError) {
      return { status: "unstable", evidence: ["hash"], reason: "changed-during-read" };
    }
    throw error;
  }

  return { status: "present", evidence: ["hash"] };
}

/** Verifies one existing destination using only injected evidence operations. */
export async function verifyFileByTier(
  input: VerifyFileInput,
  dependencies: VerificationDependencies = defaultDependencies,
): Promise<VerifyFileOutcome> {
  input.signal?.throwIfAborted();

  switch (input.tier) {
    case "quick":
      return verifyQuick(input, dependencies);
    case "default":
      return verifyDefault(input, dependencies);
    case "deep": {
      const baselineOutcome = await verifyDefault(input, dependencies);
      if (baselineOutcome.status !== "present") {
        return baselineOutcome;
      }
      if (input.converted) {
        return {
          status: "present",
          evidence: ["hash"],
          notApplicableReason: "conversion-byte-compare",
        };
      }

      const comparison = await dependencies.compareFileBytes(
        input.sourcePath,
        input.destinationPath,
        input.signal,
      );
      input.signal?.throwIfAborted();
      if (comparison.status === "unstable") {
        return {
          status: "unstable",
          evidence: ["hash", "bytes"],
          reason: "changed-during-read",
        };
      }
      if (comparison.status === "mismatch") {
        return { status: "content-mismatch", evidence: ["hash", "bytes"] };
      }
      if (comparison.sameInode) {
        return {
          status: "present",
          evidence: ["hash"],
          notApplicableReason: "same-inode-byte-compare",
        };
      }
      return { status: "present", evidence: ["hash", "bytes"] };
    }
  }
}

/** Creates an empty additive result for one source and effective tier. */
export function createVerifyResult(source: string, tier: VerificationTier): VerifyCommandResult {
  return {
    source,
    tier,
    verified: 0,
    missing: 0,
    sizeMismatch: 0,
    metadataMismatch: 0,
    hashMismatch: 0,
    contentMismatch: 0,
    unverifiable: 0,
    notApplicable: 0,
    unstable: 0,
    extra: 0,
    expectedTotal: 0,
    issues: [],
    failed: [],
  };
}

const PRIMARY_STATUSES: ReadonlySet<FileVerifyStatus> = new Set([
  "present",
  "missing",
  "size-mismatch",
  "metadata-mismatch",
  "hash-mismatch",
  "content-mismatch",
  "unverifiable",
  "unstable",
]);

function updateStatusCounter(result: VerifyCommandResult, status: FileVerifyStatus, delta: number) {
  switch (status) {
    case "present":
      result.verified += delta;
      break;
    case "extra":
      result.extra += delta;
      break;
    case "missing":
      result.missing += delta;
      break;
    case "size-mismatch":
      result.sizeMismatch += delta;
      break;
    case "metadata-mismatch":
      result.metadataMismatch += delta;
      break;
    case "hash-mismatch":
      result.hashMismatch += delta;
      break;
    case "content-mismatch":
      result.contentMismatch += delta;
      break;
    case "unverifiable":
      result.unverifiable += delta;
      break;
    case "not-applicable":
      result.notApplicable += delta;
      break;
    case "unstable":
      result.unstable += delta;
      break;
  }
}

/** Adds one primary or coverage outcome to the aggregate. */
export function addVerifyOutcome(result: VerifyCommandResult, file: VerifiedFile): void {
  updateStatusCounter(result, file.status, 1);
  if (PRIMARY_STATUSES.has(file.status)) {
    result.expectedTotal++;
  }
  if (file.status !== "present") {
    result.issues.push(file);
  }
}

/** Applies a verifier outcome, including successful not-applicable coverage. */
export function applyVerifyFileOutcome(
  result: VerifyCommandResult,
  path: string,
  outcome: VerifyFileOutcome,
  sourcePath?: string,
): void {
  const file: VerifiedFile = { path, sourcePath, ...outcome };
  addVerifyOutcome(result, file);
  if (outcome.status === "present" && outcome.notApplicableReason) {
    addVerifyOutcome(result, {
      path,
      sourcePath,
      status: "not-applicable",
      reason: outcome.notApplicableReason,
      evidence: outcome.evidence,
    });
  }
}

/** Replaces a pre-repair outcome with its final-path re-verification outcome. */
export function transitionVerifyOutcome(
  result: VerifyCommandResult,
  previous: VerifiedFile,
  next: VerifiedFile,
): void {
  updateStatusCounter(result, previous.status, -1);
  if (PRIMARY_STATUSES.has(previous.status)) {
    result.expectedTotal--;
  }
  const issueIndex = result.issues.findIndex(
    (issue) =>
      issue.path === previous.path &&
      issue.status === previous.status &&
      issue.reason === previous.reason,
  );
  if (issueIndex >= 0) {
    result.issues.splice(issueIndex, 1);
  }
  addVerifyOutcome(result, next);
  sortVerifyResult(result);
}

export function addExtraFile(result: VerifyCommandResult, path: string): void {
  addVerifyOutcome(result, { path, status: "extra" });
}

export function addVerifyFailure(result: VerifyCommandResult, failure: FailedOperation): void {
  result.failed.push(failure);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorts stable path-based details after parallel verification. */
export function sortVerifyResult(result: VerifyCommandResult): void {
  result.issues.sort(
    (left, right) =>
      compareText(normalize(left.path), normalize(right.path)) ||
      compareText(left.status, right.status) ||
      compareText(left.reason ?? "", right.reason ?? ""),
  );
  result.failed.sort(
    (left, right) =>
      compareText(normalize(left.path), normalize(right.path)) ||
      compareText(left.message, right.message),
  );
}

/** Merges one source result into another without losing additive repair state. */
export function mergeVerifyResults(target: VerifyCommandResult, source: VerifyCommandResult): void {
  if (target.tier !== source.tier) {
    throw new Error(`Cannot merge verification tiers ${target.tier} and ${source.tier}.`);
  }

  target.verified += source.verified;
  target.missing += source.missing;
  target.sizeMismatch += source.sizeMismatch;
  target.metadataMismatch += source.metadataMismatch;
  target.hashMismatch += source.hashMismatch;
  target.contentMismatch += source.contentMismatch;
  target.unverifiable += source.unverifiable;
  target.notApplicable += source.notApplicable;
  target.unstable += source.unstable;
  target.extra += source.extra;
  target.expectedTotal += source.expectedTotal;
  target.issues.push(...source.issues);
  target.failed.push(...source.failed);
  target.conflictResolutions = [
    ...(target.conflictResolutions ?? []),
    ...(source.conflictResolutions ?? []),
  ];

  if (source.fixResults) {
    if (!target.fixResults) {
      target.fixResults = {
        copiedFiles: 0,
        removedFiles: 0,
        failedFixes: [],
        repairedFiles: 0,
        reverifiedFiles: 0,
        refusedFiles: 0,
        remainingIssues: 0,
        conflictResolutions: [],
      };
    }
    target.fixResults.copiedFiles += source.fixResults.copiedFiles;
    target.fixResults.removedFiles += source.fixResults.removedFiles;
    target.fixResults.failedFixes.push(...source.fixResults.failedFixes);
    target.fixResults.repairedFiles += source.fixResults.repairedFiles;
    target.fixResults.reverifiedFiles += source.fixResults.reverifiedFiles;
    target.fixResults.refusedFiles += source.fixResults.refusedFiles;
    target.fixResults.remainingIssues += source.fixResults.remainingIssues;
    target.fixResults.conflictResolutions = [
      ...(target.fixResults.conflictResolutions ?? []),
      ...(source.fixResults.conflictResolutions ?? []),
    ];
  }

  sortVerifyResult(target);
}

/** Returns whether the final aggregate remains incomplete or unsuccessful. */
export function hasUnresolvedVerificationProblems(result: VerifyCommandResult): boolean {
  return (
    result.missing > 0 ||
    result.sizeMismatch > 0 ||
    result.metadataMismatch > 0 ||
    result.hashMismatch > 0 ||
    result.contentMismatch > 0 ||
    result.unverifiable > 0 ||
    result.unstable > 0 ||
    result.extra > 0 ||
    result.failed.length > 0 ||
    (result.fixResults !== undefined &&
      (result.fixResults.failedFixes.length > 0 ||
        result.fixResults.refusedFiles > 0 ||
        result.fixResults.remainingIssues > 0))
  );
}
