import { normalizeReconciliationPath } from "../../lib/reconciliation.js";
import type { DbReconciliationInventoryCandidate } from "../../types/db.js";
import type { MediaTrack } from "../../types/media-server.js";
import type {
  DatabaseStatOutcome,
  RatingTargetOutcome,
  ReconciliationTargetOutcome,
} from "../../types/reconciliation.js";

const RATING_TARGET_ORDER = ["file", "database", "server"] as const;

export interface OutcomeIndexes {
  readonly byKey: Map<string, number>;
  readonly byPath: Map<string, number[]>;
}

function outcomeKey(outcome: ReconciliationTargetOutcome): string {
  return `${outcome.kind}\0${outcome.target}\0${outcome.path}`;
}

function ratingOutcomeKey(path: string, target: RatingTargetOutcome["target"]): string {
  return `rating\0${target}\0${path}`;
}

function databaseStatOutcomeKey(path: string): string {
  return `database-stat\0database\0${path}`;
}

export function compareOutcomeOrder(
  left: ReconciliationTargetOutcome,
  right: ReconciliationTargetOutcome,
): number {
  const pathOrder = left.path.localeCompare(right.path);
  if (pathOrder !== 0) return pathOrder;
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) return kindOrder;
  if (left.kind === "rating" && right.kind === "rating") {
    return RATING_TARGET_ORDER.indexOf(left.target) - RATING_TARGET_ORDER.indexOf(right.target);
  }
  return 0;
}

export function indexOutcomes(outcomes: readonly ReconciliationTargetOutcome[]): OutcomeIndexes {
  const byKey = new Map<string, number>();
  const byPath = new Map<string, number[]>();
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    const key = outcomeKey(outcome);
    if (byKey.has(key)) throw new Error(`Duplicate reconciliation outcome: ${key}`);
    byKey.set(key, index);
    const pathIndexes = byPath.get(outcome.path) ?? [];
    pathIndexes.push(index);
    byPath.set(outcome.path, pathIndexes);
  }
  return { byKey, byPath };
}

export function getRatingOutcome(
  outcomes: readonly ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  path: string,
  target: RatingTargetOutcome["target"],
): RatingTargetOutcome | undefined {
  const index = indexes.byKey.get(ratingOutcomeKey(path, target));
  const outcome = index === undefined ? undefined : outcomes[index];
  return outcome?.kind === "rating" ? outcome : undefined;
}

export function getDatabaseStatOutcome(
  outcomes: readonly ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  path: string,
): DatabaseStatOutcome | undefined {
  const index = indexes.byKey.get(databaseStatOutcomeKey(path));
  const outcome = index === undefined ? undefined : outcomes[index];
  return outcome?.kind === "database-stat" ? outcome : undefined;
}

export function replaceOutcome(
  outcomes: ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  original: ReconciliationTargetOutcome,
  replacement: ReconciliationTargetOutcome,
): void {
  const key = outcomeKey(original);
  const index = indexes.byKey.get(key);
  if (index === undefined || outcomes[index] !== original || outcomeKey(replacement) !== key) {
    throw new Error("Reconciliation outcome identity was lost.");
  }
  outcomes[index] = replacement;
}

export function addOutcome(
  outcomes: ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  outcome: ReconciliationTargetOutcome,
): void {
  const key = outcomeKey(outcome);
  if (indexes.byKey.has(key)) throw new Error(`Duplicate reconciliation outcome: ${key}`);
  const index = outcomes.length;
  outcomes.push(outcome);
  indexes.byKey.set(key, index);
  const pathIndexes = indexes.byPath.get(outcome.path) ?? [];
  pathIndexes.push(index);
  indexes.byPath.set(outcome.path, pathIndexes);
}

export function markLaterPathOutcomesSkipped(
  outcomes: ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  path: string,
): void {
  for (const index of indexes.byPath.get(path) ?? []) {
    const outcome = outcomes[index]!;
    if (outcome.status === "planned") {
      outcomes[index] = { ...outcome, status: "skipped", code: "prior-target-failed" };
    }
  }
}

export function markRemainingCancelled(outcomes: ReconciliationTargetOutcome[]): void {
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index]!;
    if (outcome.status === "planned") {
      outcomes[index] = { ...outcome, status: "skipped", code: "cancelled" };
    }
  }
}

export function failFirstPlannedOutcome(
  outcomes: ReconciliationTargetOutcome[],
  indexes: OutcomeIndexes,
  path: string,
  code: "stale-evidence" | "write-failed" | "verification-failed",
): void {
  let outcome: ReconciliationTargetOutcome | undefined;
  let outcomeOrder = Number.POSITIVE_INFINITY;
  for (const index of indexes.byPath.get(path) ?? []) {
    const candidate = outcomes[index]!;
    if (candidate.status !== "planned") continue;
    const candidateOrder =
      candidate.kind === "rating" && candidate.target === "file"
        ? 0
        : candidate.kind === "rating" && candidate.target === "server"
          ? 1
          : 2;
    if (candidateOrder < outcomeOrder) {
      outcome = candidate;
      outcomeOrder = candidateOrder;
    }
  }
  if (outcome === undefined) return;
  replaceOutcome(
    outcomes,
    indexes,
    outcome,
    outcome.kind === "rating"
      ? { ...outcome, status: "failed", code }
      : { ...outcome, status: "failed", code },
  );
  markLaterPathOutcomesSkipped(outcomes, indexes, path);
}

function inventoryRowMatches(
  left: DbReconciliationInventoryCandidate,
  right: DbReconciliationInventoryCandidate,
): boolean {
  return (
    left.id === right.id &&
    left.operation_id === right.operation_id &&
    left.source_path === right.source_path &&
    left.relative_path === right.relative_path &&
    left.mtime === right.mtime &&
    left.size === right.size &&
    left.rating === right.rating &&
    left.genre === right.genre &&
    left.year === right.year &&
    left.bpm === right.bpm &&
    left.artist === right.artist &&
    left.dest_path === right.dest_path &&
    left.content_hash === right.content_hash &&
    left.copied_at === right.copied_at
  );
}

export function databaseRowsMatch(
  expected: readonly DbReconciliationInventoryCandidate[],
  current: readonly DbReconciliationInventoryCandidate[],
): boolean {
  if (expected.length !== current.length) return false;
  const sortedExpected = [...expected].sort((left, right) => left.id - right.id);
  const sortedCurrent = [...current].sort((left, right) => left.id - right.id);
  return sortedExpected.every((row, index) => inventoryRowMatches(row, sortedCurrent[index]!));
}

export function serverTracksMatch(
  sourceRoot: string,
  path: string,
  expected: readonly MediaTrack[],
  current: readonly MediaTrack[],
): boolean {
  const exactCurrent = current.filter(
    (track) => normalizeReconciliationPath(sourceRoot, track.filePath) === path,
  );
  if (expected.length !== exactCurrent.length) return false;
  const sortedExpected = [...expected].sort((left, right) => left.id.localeCompare(right.id));
  const sortedCurrent = [...exactCurrent].sort((left, right) => left.id.localeCompare(right.id));
  return sortedExpected.every((track, index) => {
    const currentTrack = sortedCurrent[index]!;
    return (
      track.id === currentTrack.id &&
      track.rating === currentTrack.rating &&
      normalizeReconciliationPath(sourceRoot, track.filePath) ===
        normalizeReconciliationPath(sourceRoot, currentTrack.filePath)
    );
  });
}

export function serverTrackIdentitiesMatch(
  expected: readonly MediaTrack[],
  current: readonly MediaTrack[],
): boolean {
  if (expected.length !== current.length) return false;
  const identity = (track: MediaTrack): string => JSON.stringify([track.id, track.filePath]);
  const sortedExpected = expected.map(identity).sort();
  const sortedCurrent = current.map(identity).sort();
  return sortedExpected.every((value, index) => value === sortedCurrent[index]);
}
