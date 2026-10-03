/**
 * Pure projection of a complete bridge snapshot into the public
 * Plex-to-Lidarr reconciliation report.
 */

import {
  BRIDGE_ARTIST_MAX_RECORDS,
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  type BridgeArtistCandidate,
  type BridgeArtistIdentitySnapshot,
  type BridgeArtistResolutionOutcome,
  type BridgeTargetArtist,
  type PlexLidarrReconciliationResultV1,
  type ReconciliationCandidate,
  type ReconciliationConflictItem,
  type ReconciliationDuplicate,
  type ReconciliationDuplicateMember,
  type ReconciliationAuthoritativeItem,
  type ReconciliationAmbiguousItem,
  type ReconciliationItem,
  type ReconciliationPlexOnlyItem,
  type ReconciliationReviewSuggestedItem,
  type ReconciliationSourceIdentity,
  type ReconciliationSourceUnmatchedItem,
  type ReconciliationSuggestion,
  type ReconciliationTargetIdentity,
  type ReconciliationTargetUnmatchedItem,
  type ReconciliationUnavailableItem,
} from "../../types/bridge.js";
import { normalizeBridgeArtistName } from "./artist-name.js";

export interface ReconcilePlexLidarrSnapshotOptions {
  readonly includeDuplicates?: boolean;
}

const RECONCILIATION_MAX_DUPLICATE_MEMBERS = BRIDGE_ARTIST_MAX_RECORDS * 6;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sourceArtistMbid(outcome: BridgeArtistResolutionOutcome): string | null {
  return outcome.state === "resolved" ||
    (outcome.state === "conflict" && outcome.reason === "duplicate-source-mbid")
    ? outcome.sourceMbid
    : null;
}

function sourceIdentity(outcome: BridgeArtistResolutionOutcome): ReconciliationSourceIdentity {
  return {
    plexId: outcome.plexId,
    title: outcome.title,
    artistMbid: sourceArtistMbid(outcome),
  };
}

function targetIdentity(
  target: Pick<BridgeTargetArtist, "lidarrId" | "title" | "artistMbid">,
): ReconciliationTargetIdentity {
  return {
    lidarrId: target.lidarrId,
    title: target.title,
    artistMbid: target.artistMbid,
  };
}

function projectCandidate(candidate: BridgeArtistCandidate): ReconciliationCandidate {
  return {
    rank: candidate.rank,
    target: targetIdentity(candidate),
    method: candidate.method,
    score: candidate.score,
  };
}

function projectCandidates(
  outcome: BridgeArtistResolutionOutcome,
): readonly ReconciliationCandidate[] {
  return outcome.candidates
    .map(projectCandidate)
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.target.lidarrId - right.target.lidarrId ||
        compareStrings(left.target.title, right.target.title),
    );
}

function projectResolvedOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "resolved" }>,
): ReconciliationAuthoritativeItem {
  return {
    category: "authoritative",
    reason: outcome.reason,
    method: outcome.method,
    source: sourceIdentity(outcome),
    target: {
      lidarrId: outcome.target.lidarrId,
      title: outcome.target.title,
      artistMbid: outcome.target.artistMbid,
    },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function projectSuggestedOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "suggested" }>,
): ReconciliationReviewSuggestedItem {
  const shared = {
    source: sourceIdentity(outcome),
    target: targetIdentity(outcome.target),
    score: outcome.target.score,
    runnerUpMargin: outcome.runnerUpMargin,
    candidates: projectCandidates(outcome),
  };
  if (outcome.method === "normalized-name" && outcome.reason === "unique-normalized-name") {
    return {
      category: "review-normalized-name",
      reason: outcome.reason,
      method: outcome.method,
      ...shared,
    };
  }
  if (outcome.method === "fuzzy-name" && outcome.reason === "unique-fuzzy-name") {
    return {
      category: "review-fuzzy-name",
      reason: outcome.reason,
      method: outcome.method,
      ...shared,
    };
  }
  throw new TypeError("reconciliation snapshot contains inconsistent suggestion evidence");
}

function projectAmbiguousOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "ambiguous" }>,
): ReconciliationAmbiguousItem {
  const candidates = projectCandidates(outcome);
  return {
    category: "ambiguous",
    reason: outcome.reason,
    method: outcome.method,
    source: sourceIdentity(outcome),
    target: null,
    score: candidates[0]?.score ?? null,
    runnerUpMargin:
      candidates.length > 1 ? (candidates[0]?.score ?? 0) - (candidates[1]?.score ?? 0) : null,
    candidates,
  };
}

function projectUnmatchedOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "unmatched" }>,
): ReconciliationSourceUnmatchedItem {
  const candidates = projectCandidates(outcome);
  return {
    category: "unmatched",
    reason: outcome.reason,
    method: outcome.method,
    source: sourceIdentity(outcome),
    target: null,
    score: candidates[0]?.score ?? null,
    runnerUpMargin: null,
    candidates,
  };
}

function projectConflictOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "conflict" }>,
): ReconciliationConflictItem {
  return {
    category: "conflict",
    reason: outcome.reason,
    method: outcome.method,
    source: sourceIdentity(outcome),
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: projectCandidates(outcome),
  };
}

function projectUnavailableOutcome(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "unavailable" }>,
): ReconciliationUnavailableItem {
  return {
    category: "unavailable",
    reason: outcome.reason,
    method: outcome.method,
    source: sourceIdentity(outcome),
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: projectCandidates(outcome),
  };
}

function projectOutcome(outcome: BridgeArtistResolutionOutcome): ReconciliationItem {
  switch (outcome.state) {
    case "resolved":
      return projectResolvedOutcome(outcome);
    case "suggested":
      return projectSuggestedOutcome(outcome);
    case "ambiguous":
      return projectAmbiguousOutcome(outcome);
    case "unmatched":
      return projectUnmatchedOutcome(outcome);
    case "conflict":
      return projectConflictOutcome(outcome);
    case "unavailable":
      return projectUnavailableOutcome(outcome);
  }
}

function assertSnapshotEnvelope(snapshot: BridgeArtistIdentitySnapshot): void {
  if (
    snapshot.snapshotVersion !== BRIDGE_IDENTITY_SNAPSHOT_VERSION ||
    snapshot.resolverVersion !== BRIDGE_ARTIST_RESOLVER_VERSION ||
    snapshot.normalizationVersion !== BRIDGE_ARTIST_NORMALIZATION_VERSION ||
    snapshot.scoringVersion !== BRIDGE_ARTIST_SCORING_VERSION
  ) {
    throw new TypeError("reconciliation requires a compatible bridge identity snapshot");
  }

  const { completeness } = snapshot;
  if (
    !completeness.complete ||
    !completeness.sourceComplete ||
    !completeness.targetComplete ||
    !completeness.resolutionsComplete
  ) {
    throw new TypeError("reconciliation requires a complete bridge identity snapshot");
  }
  if (
    snapshot.outcomes.length > BRIDGE_ARTIST_MAX_RECORDS ||
    snapshot.targetArtists.length > BRIDGE_ARTIST_MAX_RECORDS
  ) {
    throw new RangeError(`reconciliation accepts at most ${BRIDGE_ARTIST_MAX_RECORDS} artists`);
  }
  if (
    completeness.sourceArtistCount !== snapshot.outcomes.length ||
    completeness.resolutionCount !== snapshot.outcomes.length ||
    completeness.targetArtistCount !== snapshot.targetArtists.length
  ) {
    throw new TypeError("reconciliation snapshot count mismatch");
  }
}

function assertUniqueSourceIds(outcomes: readonly BridgeArtistResolutionOutcome[]): void {
  const sourceIds = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.plexId.length === 0 || sourceIds.has(outcome.plexId)) {
      throw new TypeError("reconciliation snapshot contains invalid or duplicate Plex IDs");
    }
    sourceIds.add(outcome.plexId);
  }
}

function indexTargetsById(
  targets: readonly BridgeTargetArtist[],
): ReadonlyMap<number, BridgeTargetArtist> {
  const targetsById = new Map<number, BridgeTargetArtist>();
  for (const target of targets) {
    if (
      !Number.isSafeInteger(target.lidarrId) ||
      target.lidarrId <= 0 ||
      targetsById.has(target.lidarrId)
    ) {
      throw new TypeError("reconciliation snapshot contains invalid or duplicate Lidarr IDs");
    }
    targetsById.set(target.lidarrId, target);
  }
  return targetsById;
}

function assertCandidateConsistency(
  outcome: BridgeArtistResolutionOutcome,
  targetsById: ReadonlyMap<number, BridgeTargetArtist>,
): void {
  const candidateRanks = new Set<number>();
  for (const candidate of outcome.candidates) {
    const candidateTarget = targetsById.get(candidate.lidarrId);
    if (
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank <= 0 ||
      candidateRanks.has(candidate.rank) ||
      !Number.isFinite(candidate.score) ||
      candidate.score < 0 ||
      candidate.score > 1 ||
      candidateTarget === undefined ||
      candidateTarget.title !== candidate.title ||
      candidateTarget.artistMbid !== candidate.artistMbid
    ) {
      throw new TypeError("reconciliation snapshot contains inconsistent candidate evidence");
    }
    candidateRanks.add(candidate.rank);
  }
}

function assertSuggestedConsistency(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "suggested" }>,
  targetsById: ReadonlyMap<number, BridgeTargetArtist>,
): void {
  const target = targetsById.get(outcome.target.lidarrId);
  if (
    target === undefined ||
    target.title !== outcome.target.title ||
    target.artistMbid !== outcome.target.artistMbid ||
    outcome.candidates[0]?.lidarrId !== outcome.target.lidarrId
  ) {
    throw new TypeError("reconciliation snapshot contains inconsistent suggestion evidence");
  }
}

function assertExactConsistency(
  outcome: Extract<BridgeArtistResolutionOutcome, { state: "resolved" }>,
  targetsById: ReadonlyMap<number, BridgeTargetArtist>,
  consumed: Set<number>,
): void {
  const target = targetsById.get(outcome.target.lidarrId);
  if (
    target === undefined ||
    target.title !== outcome.target.title ||
    target.artistMbid !== outcome.sourceMbid ||
    outcome.target.artistMbid !== outcome.sourceMbid ||
    consumed.has(outcome.target.lidarrId)
  ) {
    throw new TypeError("reconciliation snapshot contains inconsistent exact resolution evidence");
  }
  consumed.add(outcome.target.lidarrId);
}

function assertOutcomeConsistency(
  outcomes: readonly BridgeArtistResolutionOutcome[],
  targetsById: ReadonlyMap<number, BridgeTargetArtist>,
): void {
  const consumed = new Set<number>();
  for (const outcome of outcomes) {
    assertCandidateConsistency(outcome, targetsById);
    if (outcome.state === "suggested") {
      assertSuggestedConsistency(outcome, targetsById);
    } else if (outcome.state === "resolved") {
      assertExactConsistency(outcome, targetsById, consumed);
    }
  }
}

function assertCompleteSnapshot(snapshot: BridgeArtistIdentitySnapshot): void {
  assertSnapshotEnvelope(snapshot);
  assertUniqueSourceIds(snapshot.outcomes);
  assertOutcomeConsistency(snapshot.outcomes, indexTargetsById(snapshot.targetArtists));
}

function sourceMember(outcome: BridgeArtistResolutionOutcome): ReconciliationDuplicateMember {
  return {
    side: "plex",
    plexId: outcome.plexId,
    title: outcome.title,
    artistMbid: sourceArtistMbid(outcome),
  };
}

function targetMember(target: BridgeTargetArtist): ReconciliationDuplicateMember {
  return {
    side: "lidarr",
    lidarrId: target.lidarrId,
    title: target.title,
    artistMbid: target.artistMbid,
  };
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey);
    if (group === undefined) groups.set(groupKey, [value]);
    else group.push(value);
  }
  return groups;
}

interface DuplicateCollector {
  readonly findings: ReconciliationDuplicate[];
  memberCount: number;
}

function appendDuplicate(collector: DuplicateCollector, duplicate: ReconciliationDuplicate): void {
  const nextMemberCount = collector.memberCount + duplicate.members.length;
  if (
    !Number.isSafeInteger(nextMemberCount) ||
    nextMemberCount > RECONCILIATION_MAX_DUPLICATE_MEMBERS
  ) {
    throw new RangeError("reconciliation duplicate member budget exceeded");
  }
  collector.findings.push(duplicate);
  collector.memberCount = nextMemberCount;
}

function detectDuplicateSourceMbids(
  outcomes: readonly BridgeArtistResolutionOutcome[],
  collector: DuplicateCollector,
): void {
  const duplicateSourceOutcomes = outcomes.filter(
    (
      outcome,
    ): outcome is Extract<
      BridgeArtistResolutionOutcome,
      { state: "conflict"; reason: "duplicate-source-mbid" }
    > => outcome.state === "conflict" && outcome.reason === "duplicate-source-mbid",
  );
  for (const [sourceMbid, group] of groupBy(
    duplicateSourceOutcomes,
    (outcome) => outcome.sourceMbid,
  )) {
    appendDuplicate(collector, {
      code: "duplicate-source-mbid",
      artistMbid: sourceMbid,
      normalizedTitle: null,
      members: group.map(sourceMember),
    });
  }
}

function detectDuplicateTargetMbids(
  targets: readonly BridgeTargetArtist[],
  collector: DuplicateCollector,
): void {
  const targetsWithMbids = targets.filter((target) => target.artistMbid !== null);
  for (const [artistMbid, group] of groupBy(
    targetsWithMbids,
    (target) => target.artistMbid as string,
  )) {
    if (group.length <= 1) continue;
    appendDuplicate(collector, {
      code: "duplicate-target-mbid",
      artistMbid,
      normalizedTitle: null,
      members: group.map(targetMember),
    });
  }
}

function detectNormalizedNameCollisions(
  outcomes: readonly BridgeArtistResolutionOutcome[],
  targetsByNormalizedTitle: ReadonlyMap<string, readonly BridgeTargetArtist[]>,
  collector: DuplicateCollector,
): void {
  for (const [normalizedTitle, group] of groupBy(outcomes, (outcome) =>
    normalizeBridgeArtistName(outcome.title),
  )) {
    if (normalizedTitle === "" || group.length <= 1) continue;
    appendDuplicate(collector, {
      code: "source-normalized-name-collision",
      artistMbid: null,
      normalizedTitle,
      members: group.map(sourceMember),
    });
  }

  for (const [normalizedTitle, group] of targetsByNormalizedTitle) {
    if (normalizedTitle === "" || group.length <= 1) continue;
    appendDuplicate(collector, {
      code: "target-normalized-name-collision",
      artistMbid: null,
      normalizedTitle,
      members: group.map(targetMember),
    });
  }
}

function detectContradictoryNameMbids(
  outcomes: readonly BridgeArtistResolutionOutcome[],
  targetsByNormalizedTitle: ReadonlyMap<string, readonly BridgeTargetArtist[]>,
  collector: DuplicateCollector,
): void {
  const contradictorySourcesByTitle = groupBy(
    outcomes.filter(
      (outcome) => outcome.state === "conflict" && outcome.reason === "contradictory-mbid",
    ),
    (outcome) => normalizeBridgeArtistName(outcome.title),
  );
  for (const [normalizedTitle, group] of contradictorySourcesByTitle) {
    appendDuplicate(collector, {
      code: "contradictory-name-mbid",
      artistMbid: null,
      normalizedTitle: normalizedTitle === "" ? null : normalizedTitle,
      members: [
        ...group.map(sourceMember),
        ...(targetsByNormalizedTitle.get(normalizedTitle) ?? []).map(targetMember),
      ],
    });
  }
}

function deriveDuplicates(
  outcomes: readonly BridgeArtistResolutionOutcome[],
  targets: readonly BridgeTargetArtist[],
): ReconciliationDuplicate[] {
  const collector: DuplicateCollector = { findings: [], memberCount: 0 };
  const targetsByNormalizedTitle = groupBy(targets, (target) =>
    normalizeBridgeArtistName(target.title),
  );
  detectDuplicateSourceMbids(outcomes, collector);
  detectDuplicateTargetMbids(targets, collector);
  detectNormalizedNameCollisions(outcomes, targetsByNormalizedTitle, collector);
  detectContradictoryNameMbids(outcomes, targetsByNormalizedTitle, collector);

  return collector.findings.sort(
    (left, right) =>
      compareStrings(left.code, right.code) ||
      compareStrings(left.artistMbid ?? "", right.artistMbid ?? "") ||
      compareStrings(left.normalizedTitle ?? "", right.normalizedTitle ?? ""),
  );
}

function deriveSuggestions(
  reviewSuggested: readonly ReconciliationReviewSuggestedItem[],
  conflicts: readonly ReconciliationConflictItem[],
  duplicatesIncluded: boolean,
  duplicateFindingCount: number,
): ReconciliationSuggestion[] {
  const suggestions: ReconciliationSuggestion[] = reviewSuggested.map((item) => ({
    code: "inspect-target",
    source: item.source,
    target: item.target,
    argv:
      item.target === null
        ? []
        : [
            "rfmedia",
            "lidarr",
            "lookup",
            "artist",
            item.target.artistMbid === null
              ? item.target.title
              : `lidarr:${item.target.artistMbid}`,
          ],
  }));

  for (const item of conflicts) {
    suggestions.push({
      code:
        item.reason === "malformed-source-mbid" ||
        item.reason === "conflicting-source-mbids" ||
        item.reason === "duplicate-source-mbid"
          ? "refresh-source-metadata"
          : "correct-target-metadata",
      source: item.source,
      target: item.target,
      argv: [],
    });
  }

  if (duplicatesIncluded && duplicateFindingCount > 0) {
    suggestions.push({
      code: "run-duplicate-audit",
      source: null,
      target: null,
      argv: ["rfmedia", "lidarr", "audit", "--check", "duplicate-identity"],
    });
  }

  return suggestions.sort(
    (left, right) =>
      compareStrings(left.code, right.code) ||
      compareStrings(left.source?.plexId ?? "", right.source?.plexId ?? "") ||
      (left.target?.lidarrId ?? 0) - (right.target?.lidarrId ?? 0),
  );
}

/**
 * Projects one complete v2 identity snapshot into a deterministic frozen report.
 *
 * Only authoritative exact matches consume a target. Review suggestions remain
 * visible in both directional gaps until an operator resolves them elsewhere.
 */
export function reconcilePlexLidarrSnapshot(
  snapshot: BridgeArtistIdentitySnapshot,
  options: ReconcilePlexLidarrSnapshotOptions = {},
): PlexLidarrReconciliationResultV1 {
  assertCompleteSnapshot(snapshot);

  const outcomes = [...snapshot.outcomes].sort(
    (left, right) =>
      compareStrings(left.plexId, right.plexId) ||
      compareStrings(left.title, right.title) ||
      compareStrings(left.state, right.state) ||
      compareStrings(left.reason, right.reason),
  );
  const targets = [...snapshot.targetArtists].sort(
    (left, right) => left.lidarrId - right.lidarrId || compareStrings(left.title, right.title),
  );
  const items = outcomes.map(projectOutcome);
  const matchedExact = items.filter(
    (item): item is ReconciliationAuthoritativeItem => item.category === "authoritative",
  );
  const reviewSuggested = items.filter(
    (item): item is ReconciliationReviewSuggestedItem =>
      item.category === "review-normalized-name" || item.category === "review-fuzzy-name",
  );
  const reviewAmbiguous = items.filter(
    (item): item is ReconciliationAmbiguousItem => item.category === "ambiguous",
  );
  const conflicts = items.filter(
    (item): item is ReconciliationConflictItem => item.category === "conflict",
  );
  const unavailable = items.filter(
    (item): item is ReconciliationUnavailableItem => item.category === "unavailable",
  );
  const plexOnly = items.filter(
    (item): item is ReconciliationPlexOnlyItem => item.category !== "authoritative",
  );
  const consumedTargetIds = new Set(
    matchedExact.flatMap((item) => (item.target === null ? [] : [item.target.lidarrId])),
  );
  const lidarrOnly: ReconciliationTargetUnmatchedItem[] = targets
    .filter((target) => !consumedTargetIds.has(target.lidarrId))
    .map((target) => ({
      category: "unmatched",
      reason: "no-authoritative-source-match",
      method: "none",
      source: null,
      target: targetIdentity(target),
      score: null,
      runnerUpMargin: null,
      candidates: [],
    }));

  const duplicatesIncluded = options.includeDuplicates === true;
  const duplicates = duplicatesIncluded ? deriveDuplicates(outcomes, targets) : [];
  const suggestions = deriveSuggestions(
    reviewSuggested,
    conflicts,
    duplicatesIncluded,
    duplicates.length,
  );

  return deepFreeze({
    schema: "rfmedia.plex-lidarr-reconciliation.v1",
    scope: { ...snapshot.scope },
    provenance: { ...snapshot.provenance },
    capturedAt: snapshot.capturedAt,
    verifiedAt: snapshot.verifiedAt,
    completeness: { ...snapshot.completeness },
    summary: {
      sourceArtistCount: snapshot.completeness.sourceArtistCount,
      targetArtistCount: snapshot.completeness.targetArtistCount,
      primaryOutcomeCount: items.length,
      matchedExactCount: matchedExact.length,
      reviewSuggestedCount: reviewSuggested.length,
      reviewAmbiguousCount: reviewAmbiguous.length,
      plexOnlyCount: plexOnly.length,
      lidarrOnlyCount: lidarrOnly.length,
      conflictCount: conflicts.length,
      unavailableCount: unavailable.length,
      duplicatesIncluded,
      duplicateFindingCount: duplicates.length,
      suggestionCount: suggestions.length,
    },
    matchedExact,
    reviewSuggested,
    reviewAmbiguous,
    plexOnly,
    lidarrOnly,
    conflicts,
    unavailable,
    duplicates,
    suggestions,
  });
}
