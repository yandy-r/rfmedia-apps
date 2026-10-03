/**
 * Side-effect-free discovery policy evaluation.
 *
 * Provider orchestration owns I/O and breadth-first scheduling. This module
 * owns only deterministic validation, identity, admission, ranking, and
 * invocation-local approval decisions.
 */

import {
  isCanonicalMusicBrainzId,
  LIDARR_DISCOVER_DEFAULT_DEPTH,
  LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST,
  LIDARR_DISCOVER_DEFAULT_MAX_ADD,
  LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED,
  LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY,
  LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING,
  LIDARR_DISCOVER_MAX_ADD,
  LIDARR_DISCOVER_MAX_DEPTH,
  LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
  LIDARR_DISCOVER_MAX_LIMIT,
  LIDARR_DISCOVER_MAX_MIN_SIMILARITY,
  LIDARR_DISCOVER_MAX_PER_SEED,
  LIDARR_DISCOVER_MAX_REQUESTS,
  LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
  LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
  LIDARR_DISCOVER_MAX_VISITED_SEEDS,
  type DiscoveryCandidateLifecycle,
  type DiscoveryCandidateProvenance,
  type DiscoveryCandidateReason,
  type LastFmSimilarArtist,
  type LidarrDiscoverHardBounds,
  type LidarrDiscoverResolvedPolicy,
  type SimilarArtistRecommendation,
} from "../../types/discovery.js";

/** Optional runtime policy knobs accepted by the pure policy resolver. */
export interface DiscoveryPolicyOptions {
  readonly minSimilarity?: number;
  readonly maxPerSeed?: number;
  readonly deep?: boolean;
  readonly cascade?: boolean;
  readonly diversityBoost?: number;
  readonly popularityDampening?: number;
  readonly maxAdd?: number;
}

/** Name and optional authoritative MBID used for invocation-wide identity. */
export interface DiscoveryIdentityInput {
  readonly name: string;
  readonly musicBrainzId?: string;
}

/** Provider observation plus its immutable first-path evidence. */
export interface DiscoveryCandidateObservation extends LastFmSimilarArtist {
  readonly seedArtist: string;
  readonly parentArtist: string;
  readonly depth: number;
  readonly providerRank: number;
  readonly firstPath: readonly string[];
  readonly discoveredAt: string;
}

/** Internal candidate snapshot retained until final exposure-aware ranking. */
export interface DiscoveryPolicyCandidate extends LastFmSimilarArtist {
  readonly identity: string;
  readonly normalizedName: string;
  readonly normalizedNameAliases: readonly string[];
  readonly exposureCount: number;
  readonly provenance: DiscoveryCandidateProvenance;
}

/** Normalized provider name associated with one stable registered seed slot. */
export interface DiscoverySeedNameAlias {
  readonly seedIndex: number;
  readonly normalizedName: string;
}

/** Frozen invocation-local state threaded through pure policy operations. */
export interface DiscoveryPolicyState {
  readonly seedIdentities: readonly string[];
  readonly seedNameAliases: readonly DiscoverySeedNameAlias[];
  readonly candidates: readonly DiscoveryPolicyCandidate[];
  readonly filteredCount: number;
  readonly duplicatePaths: number;
  readonly nextFirstSeenSequence: number;
}

/** One stable decision produced while evaluating a provider observation. */
export interface DiscoveryAdmissionDecision {
  readonly identity: string;
  readonly status: DiscoveryCandidateLifecycle;
  readonly reason: DiscoveryCandidateReason;
  readonly exposureCount?: number;
}

/** Result of one threshold-before-cap provider batch. */
export interface DiscoveryAdmissionResult {
  readonly state: DiscoveryPolicyState;
  readonly decisions: readonly DiscoveryAdmissionDecision[];
}

/** Result of atomically applying explicit visible-rank approvals. */
export interface DiscoveryApprovalResult {
  readonly selectedRanks: readonly number[];
  readonly recommendations: readonly SimilarArtistRecommendation[];
  readonly approved: readonly SimilarArtistRecommendation[];
}

/** Result of pre-registering one future breadth-first seed. */
export type DiscoverySeedRegistration =
  | {
      readonly registered: true;
      readonly state: DiscoveryPolicyState;
      readonly identity: string;
      readonly seedIndex: number;
    }
  | {
      readonly registered: false;
      readonly state: DiscoveryPolicyState;
      readonly identity: string;
      readonly reason: "back-edge" | "visited-budget";
    };

/** Fixed, non-configurable discovery safety ceilings. */
export const LIDARR_DISCOVER_HARD_BOUNDS: LidarrDiscoverHardBounds = Object.freeze({
  providerLimit: LIDARR_DISCOVER_MAX_LIMIT,
  maxMinSimilarity: LIDARR_DISCOVER_MAX_MIN_SIMILARITY,
  maxPerSeed: LIDARR_DISCOVER_MAX_PER_SEED,
  maxDepth: LIDARR_DISCOVER_MAX_DEPTH,
  maxRequests: LIDARR_DISCOVER_MAX_REQUESTS,
  maxVisitedSeeds: LIDARR_DISCOVER_MAX_VISITED_SEEDS,
  maxVisibleCandidates: LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
  maxScoreWeight: LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
  maxAdd: LIDARR_DISCOVER_MAX_ADD,
});

function finiteRange(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function positiveSafeInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive safe integer at most ${maximum}`);
  }
  return value;
}

// Default full-fold exceptions that remain after canonical decomposition and simple lowercase.
const FULL_CASE_FOLD_OVERRIDES = Object.freeze({
  "\u00b5": "\u03bc",
  "\u00df": "ss",
  "\u0149": "\u02bcn",
  "\u017f": "s",
  "\u0345": "\u03b9",
  "\u03c2": "\u03c3",
  "\u03d0": "\u03b2",
  "\u03d1": "\u03b8",
  "\u03d5": "\u03c6",
  "\u03d6": "\u03c0",
  "\u03f0": "\u03ba",
  "\u03f1": "\u03c1",
  "\u03f5": "\u03b5",
  "\u0587": "\u0565\u0582",
  "\u1c80": "\u0432",
  "\u1c81": "\u0434",
  "\u1c82": "\u043e",
  "\u1c83": "\u0441",
  "\u1c84": "\u0442",
  "\u1c85": "\u0442",
  "\u1c86": "\u044a",
  "\u1c87": "\u0463",
  "\u1c88": "\ua64b",
  "\u1e9a": "a\u02be",
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
  "\ufb05": "st",
  "\ufb06": "st",
  "\ufb13": "\u0574\u0576",
  "\ufb14": "\u0574\u0565",
  "\ufb15": "\u0574\u056b",
  "\ufb16": "\u057e\u0576",
  "\ufb17": "\u0574\u056d",
} satisfies Readonly<Record<string, string>>);

function foldCherokee(character: string): string | undefined {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return undefined;
  if (codePoint >= 0xab70 && codePoint <= 0xabbf) {
    return String.fromCodePoint(codePoint - 0xab70 + 0x13a0);
  }
  if (codePoint >= 0x13f8 && codePoint <= 0x13fd) {
    return String.fromCodePoint(codePoint - 8);
  }
  return undefined;
}

function fullUnicodeCaseFold(value: string): string {
  const decomposedLowercase = value.normalize("NFD").toLocaleLowerCase("und");
  return [...decomposedLowercase]
    .map(
      (character) =>
        foldCherokee(character) ??
        FULL_CASE_FOLD_OVERRIDES[character as keyof typeof FULL_CASE_FOLD_OVERRIDES] ??
        character,
    )
    .join("")
    .normalize("NFC");
}

function normalizeName(name: string): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Discovery identity name must be a non-empty string");
  }
  return fullUnicodeCaseFold(name);
}

function freezeCandidate(candidate: DiscoveryPolicyCandidate): DiscoveryPolicyCandidate {
  return Object.freeze({
    ...candidate,
    normalizedNameAliases: Object.freeze([...candidate.normalizedNameAliases]),
    provenance: Object.freeze({
      ...candidate.provenance,
      firstPath: Object.freeze([...candidate.provenance.firstPath]),
    }),
  });
}

function freezeState(state: DiscoveryPolicyState): DiscoveryPolicyState {
  return Object.freeze({
    ...state,
    seedIdentities: Object.freeze([...state.seedIdentities]),
    seedNameAliases: Object.freeze(
      state.seedNameAliases.map((alias) => Object.freeze({ ...alias })),
    ),
    candidates: Object.freeze(state.candidates.map(freezeCandidate)),
  });
}

function freezeDecision(decision: DiscoveryAdmissionDecision): DiscoveryAdmissionDecision {
  return Object.freeze(decision);
}

/**
 * Resolves and semantically validates every discovery policy knob.
 *
 * @param options - Optional plain runtime policy values.
 * @returns A frozen policy with defaults and the fixed traversal depth applied.
 * @throws {TypeError} When a value is invalid or deep traversal conflicts with no-cascade.
 */
export function resolveDiscoveryPolicy(
  options: DiscoveryPolicyOptions = {},
): LidarrDiscoverResolvedPolicy {
  const deep = options.deep ?? false;
  const cascade = options.cascade ?? true;
  if (typeof deep !== "boolean" || typeof cascade !== "boolean") {
    throw new TypeError("Discovery deep and cascade controls must be booleans");
  }
  if (deep && !cascade) {
    throw new TypeError("Discovery deep traversal conflicts with no-cascade");
  }

  return Object.freeze({
    minSimilarity: finiteRange(
      "Discovery minimum similarity",
      options.minSimilarity ?? LIDARR_DISCOVER_DEFAULT_MIN_SIMILARITY,
      0,
      LIDARR_DISCOVER_MAX_MIN_SIMILARITY,
    ),
    maxPerSeed: positiveSafeInteger(
      "Discovery maximum per seed",
      options.maxPerSeed ?? LIDARR_DISCOVER_DEFAULT_MAX_PER_SEED,
      LIDARR_DISCOVER_MAX_PER_SEED,
    ),
    deep,
    cascade,
    maxDepth: deep ? LIDARR_DISCOVER_MAX_DEPTH : LIDARR_DISCOVER_DEFAULT_DEPTH,
    diversityBoost: finiteRange(
      "Discovery diversity boost",
      options.diversityBoost ?? LIDARR_DISCOVER_DEFAULT_DIVERSITY_BOOST,
      0,
      LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
    ),
    popularityDampening: finiteRange(
      "Discovery popularity dampening",
      options.popularityDampening ?? LIDARR_DISCOVER_DEFAULT_POPULARITY_DAMPENING,
      0,
      LIDARR_DISCOVER_MAX_SCORE_WEIGHT,
    ),
    maxAdd: positiveSafeInteger(
      "Discovery maximum approved adds",
      options.maxAdd ?? LIDARR_DISCOVER_DEFAULT_MAX_ADD,
      LIDARR_DISCOVER_MAX_ADD,
    ),
  });
}

/**
 * Creates the stable MBID-first discovery identity for a seed or candidate.
 *
 * @param input - Artist name and optional authoritative MusicBrainz ID.
 * @returns A provider-independent MBID key or Last.fm-scoped NFC case-folded name key.
 * @throws {TypeError} When the supplied identity is not canonical.
 */
export function discoveryCandidateIdentity(input: DiscoveryIdentityInput): string {
  if (input.musicBrainzId !== undefined) {
    if (!isCanonicalMusicBrainzId(input.musicBrainzId)) {
      throw new TypeError("Discovery MusicBrainz ID must be canonical");
    }
    return `mbid\u0000${input.musicBrainzId.toLowerCase()}`;
  }
  return `lastfm-name\u0000${normalizeName(input.name)}`;
}

/**
 * Creates an empty policy state with the initial seed registered before any request.
 *
 * @param initialSeed - Initial discovery seed identity.
 * @returns A deeply frozen invocation state.
 */
export function createDiscoveryPolicyState(
  initialSeed: DiscoveryIdentityInput,
): DiscoveryPolicyState {
  const identity = discoveryCandidateIdentity(initialSeed);
  return freezeState({
    seedIdentities: [identity],
    seedNameAliases: [{ seedIndex: 0, normalizedName: normalizeName(initialSeed.name) }],
    candidates: [],
    filteredCount: 0,
    duplicatePaths: 0,
    nextFirstSeenSequence: 1,
  });
}

/**
 * Associates a provider-resolved name with an already registered seed slot.
 *
 * @param state - Current immutable invocation state.
 * @param seedIndex - Stable registered seed slot.
 * @param resolvedName - Provider-resolved or autocorrected artist name.
 * @returns The original state for an existing alias, otherwise a frozen state with the alias.
 */
export function registerDiscoverySeedAlias(
  state: DiscoveryPolicyState,
  seedIndex: number,
  resolvedName: string,
): DiscoveryPolicyState {
  if (
    !Number.isSafeInteger(seedIndex) ||
    seedIndex < 0 ||
    seedIndex >= state.seedIdentities.length
  ) {
    throw new TypeError("Discovery seed alias requires a registered seed index");
  }
  const normalizedName = normalizeName(resolvedName);
  if (
    state.seedNameAliases.some(
      (alias) => alias.seedIndex === seedIndex && alias.normalizedName === normalizedName,
    )
  ) {
    return state;
  }
  return freezeState({
    ...state,
    seedNameAliases: [...state.seedNameAliases, { seedIndex, normalizedName }],
  });
}

function isSeedBackEdge(
  state: Pick<DiscoveryPolicyState, "seedIdentities" | "seedNameAliases">,
  seed: DiscoveryIdentityInput,
  identity: string,
): boolean {
  if (state.seedIdentities.includes(identity)) return true;
  const normalizedName = normalizeName(seed.name);
  return state.seedNameAliases.some((alias) => {
    if (alias.normalizedName !== normalizedName) return false;
    const seedIdentity = state.seedIdentities[alias.seedIndex];
    if (seedIdentity === undefined) {
      throw new Error("Discovery seed alias index invariant violated");
    }
    return seed.musicBrainzId === undefined || !seedIdentity.startsWith("mbid\u0000");
  });
}

/**
 * Registers a future breadth-first seed before it can be scheduled.
 *
 * @param state - Current immutable invocation state.
 * @param seed - Candidate seed to register.
 * @returns A frozen success or stable back-edge/budget rejection.
 */
export function registerDiscoverySeed(
  state: DiscoveryPolicyState,
  seed: DiscoveryIdentityInput,
): DiscoverySeedRegistration {
  const identity = discoveryCandidateIdentity(seed);
  if (isSeedBackEdge(state, seed, identity)) {
    return Object.freeze({
      registered: false,
      state,
      identity,
      reason: "back-edge",
    });
  }
  if (state.seedIdentities.length >= LIDARR_DISCOVER_MAX_VISITED_SEEDS) {
    return Object.freeze({
      registered: false,
      state,
      identity,
      reason: "visited-budget",
    });
  }
  const seedIndex = state.seedIdentities.length;
  return Object.freeze({
    registered: true,
    state: freezeState({
      ...state,
      seedIdentities: [...state.seedIdentities, identity],
      seedNameAliases: [
        ...state.seedNameAliases,
        { seedIndex, normalizedName: normalizeName(seed.name) },
      ],
    }),
    identity,
    seedIndex,
  });
}

function candidateAliasIndexes(
  candidates: readonly DiscoveryPolicyCandidate[],
  normalizedName: string,
): readonly number[] {
  return candidates.flatMap((candidate, index) =>
    candidate.normalizedNameAliases.includes(normalizedName) ? [index] : [],
  );
}

function promoteSeedIdentity(
  seedIdentities: readonly string[],
  fallbackIdentity: string,
  authoritativeIdentity: string,
): readonly string[] {
  if (!seedIdentities.includes(fallbackIdentity)) return seedIdentities;
  return seedIdentities.map((identity) =>
    identity === fallbackIdentity ? authoritativeIdentity : identity,
  );
}

function observationDecision(
  identity: string,
  status: DiscoveryCandidateLifecycle,
  reason: DiscoveryCandidateReason,
  exposureCount?: number,
): DiscoveryAdmissionDecision {
  return freezeDecision({
    identity,
    status,
    reason,
    ...(exposureCount === undefined ? {} : { exposureCount }),
  });
}

/**
 * Evaluates one provider batch with thresholding before its per-seed admission cap.
 *
 * Duplicate paths update exposure evidence without consuming a visible row.
 *
 * @param state - Current immutable invocation state.
 * @param observations - Provider observations in provider-rank order.
 * @param policy - Resolved discovery policy.
 * @returns Frozen next state and one stable decision per observation.
 */
export function admitDiscoveryCandidates(
  state: DiscoveryPolicyState,
  observations: readonly DiscoveryCandidateObservation[],
  policy: LidarrDiscoverResolvedPolicy,
): DiscoveryAdmissionResult {
  let seedIdentities = state.seedIdentities;
  let candidates = [...state.candidates];
  let filteredCount = state.filteredCount;
  let duplicatePaths = state.duplicatePaths;
  let nextSequence = state.nextFirstSeenSequence;
  let admittedFromSeed = 0;
  const decisions: DiscoveryAdmissionDecision[] = [];

  for (const observation of observations) {
    const identity = discoveryCandidateIdentity(observation);
    const normalizedName = normalizeName(observation.name);
    if (observation.similarity < policy.minSimilarity) {
      filteredCount += 1;
      decisions.push(observationDecision(identity, "filtered", "below-threshold"));
      continue;
    }
    if (observation.depth > policy.maxDepth) {
      filteredCount += 1;
      decisions.push(observationDecision(identity, "filtered", "depth-cap"));
      continue;
    }

    const exactIndex = candidates.findIndex((candidate) => candidate.identity === identity);
    const aliasIndexes = candidateAliasIndexes(candidates, normalizedName);
    const fallbackIndex =
      observation.musicBrainzId === undefined
        ? aliasIndexes.length === 1
          ? aliasIndexes[0]
          : undefined
        : aliasIndexes.find((index) => candidates[index]?.musicBrainzId === undefined);
    const existingIndex = exactIndex >= 0 ? exactIndex : fallbackIndex;
    if (existingIndex !== undefined && existingIndex >= 0) {
      const existing = candidates[existingIndex];
      if (existing === undefined) throw new Error("Discovery candidate index invariant violated");
      const exposureCount = positiveSafeInteger(
        "Discovery exposure count",
        existing.exposureCount + 1,
        LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
      );
      const promotedIdentity =
        observation.musicBrainzId !== undefined && existing.musicBrainzId === undefined
          ? identity
          : existing.identity;
      candidates = candidates.map((candidate, index) =>
        index === existingIndex
          ? freezeCandidate({
              ...candidate,
              ...(observation.musicBrainzId === undefined
                ? {}
                : { musicBrainzId: observation.musicBrainzId.toLowerCase() }),
              identity: promotedIdentity,
              normalizedNameAliases: candidate.normalizedNameAliases.includes(normalizedName)
                ? candidate.normalizedNameAliases
                : [...candidate.normalizedNameAliases, normalizedName],
              exposureCount,
            })
          : candidate,
      );
      if (promotedIdentity !== existing.identity) {
        seedIdentities = promoteSeedIdentity(seedIdentities, existing.identity, promotedIdentity);
        for (const [index, decision] of decisions.entries()) {
          if (decision.identity === existing.identity) {
            decisions[index] = observationDecision(
              promotedIdentity,
              decision.status,
              decision.reason === "identity-required" ? "not-selected" : decision.reason,
              decision.exposureCount,
            );
          }
        }
      }
      duplicatePaths += 1;
      decisions.push(
        observationDecision(promotedIdentity, "visited", "duplicate-identity", exposureCount),
      );
      continue;
    }
    if (observation.musicBrainzId === undefined && aliasIndexes.length > 1) {
      duplicatePaths += 1;
      decisions.push(observationDecision(identity, "visited", "duplicate-identity"));
      continue;
    }
    if (
      isSeedBackEdge(
        { seedIdentities, seedNameAliases: state.seedNameAliases },
        observation,
        identity,
      )
    ) {
      duplicatePaths += 1;
      decisions.push(observationDecision(identity, "visited", "back-edge"));
      continue;
    }
    if (admittedFromSeed >= policy.maxPerSeed) {
      filteredCount += 1;
      decisions.push(observationDecision(identity, "filtered", "per-seed-cap"));
      continue;
    }
    if (candidates.length >= LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES) {
      filteredCount += 1;
      decisions.push(observationDecision(identity, "filtered", "visible-budget"));
      continue;
    }

    const provenance: DiscoveryCandidateProvenance = Object.freeze({
      seedArtist: observation.seedArtist,
      parentArtist: observation.parentArtist,
      depth: observation.depth,
      providerRank: observation.providerRank,
      firstSeenSequence: nextSequence,
      firstPath: Object.freeze([...observation.firstPath]),
      discoveredAt: observation.discoveredAt,
    });
    candidates.push(
      freezeCandidate({
        name: observation.name,
        similarity: observation.similarity,
        ...(observation.musicBrainzId === undefined
          ? {}
          : { musicBrainzId: observation.musicBrainzId.toLowerCase() }),
        sourceUrl: observation.sourceUrl,
        identity,
        normalizedName,
        normalizedNameAliases: [normalizedName],
        exposureCount: 1,
        provenance,
      }),
    );
    admittedFromSeed += 1;
    nextSequence += 1;
    decisions.push(
      observationDecision(
        identity,
        "quarantined",
        observation.musicBrainzId === undefined ? "identity-required" : "not-selected",
        1,
      ),
    );
  }

  return Object.freeze({
    state: freezeState({
      seedIdentities,
      seedNameAliases: state.seedNameAliases,
      candidates,
      filteredCount,
      duplicatePaths,
      nextFirstSeenSequence: nextSequence,
    }),
    decisions: Object.freeze(decisions),
  });
}

/**
 * Computes the exact disclosed graph-exposure adjusted-score formula.
 *
 * @param similarity - Immutable raw provider similarity from zero through one.
 * @param exposureCount - Number of admitted graph paths exposing the identity.
 * @param diversityBoost - Diversity weight from zero through one.
 * @param popularityDampening - Graph-exposure dampening weight from zero through one.
 * @returns The formula result clamped to the inclusive zero-through-one range.
 * @throws {TypeError} When any formula input is outside its semantic bounds.
 */
export function computeDiscoveryAdjustedScore(
  similarity: number,
  exposureCount: number,
  diversityBoost: number,
  popularityDampening: number,
): number {
  finiteRange("Discovery similarity", similarity, 0, 1);
  positiveSafeInteger(
    "Discovery exposure count",
    exposureCount,
    LIDARR_DISCOVER_MAX_EXPOSURE_COUNT,
  );
  finiteRange("Discovery diversity boost", diversityBoost, 0, 1);
  finiteRange("Discovery popularity dampening", popularityDampening, 0, 1);
  const novelty = 1 / exposureCount;
  const exposure = (exposureCount - 1) / exposureCount;
  const score =
    similarity +
    diversityBoost * novelty * (1 - similarity) -
    popularityDampening * exposure * similarity;
  return Math.min(1, Math.max(0, score));
}

/**
 * Produces final deterministic visible ranking without changing raw similarity.
 *
 * @param state - Final immutable policy state after all provider waves.
 * @param policy - Resolved discovery policy.
 * @returns Deeply frozen visible recommendations in disclosed stable order.
 */
export function rankDiscoveryCandidates(
  state: DiscoveryPolicyState,
  policy: LidarrDiscoverResolvedPolicy,
): readonly SimilarArtistRecommendation[] {
  const ranked = state.candidates
    .map((candidate) => ({
      candidate,
      adjustedScore: computeDiscoveryAdjustedScore(
        candidate.similarity,
        candidate.exposureCount,
        policy.diversityBoost,
        policy.popularityDampening,
      ),
    }))
    .sort(
      (left, right) =>
        right.adjustedScore - left.adjustedScore ||
        right.candidate.similarity - left.candidate.similarity ||
        left.candidate.provenance.depth - right.candidate.provenance.depth ||
        left.candidate.provenance.firstSeenSequence -
          right.candidate.provenance.firstSeenSequence ||
        (left.candidate.normalizedName < right.candidate.normalizedName
          ? -1
          : left.candidate.normalizedName > right.candidate.normalizedName
            ? 1
            : 0),
    )
    .map(({ candidate, adjustedScore }, index): SimilarArtistRecommendation => {
      const exactIdentity = candidate.musicBrainzId !== undefined;
      return Object.freeze({
        name: candidate.name,
        similarity: candidate.similarity,
        ...(candidate.musicBrainzId === undefined
          ? {}
          : { musicBrainzId: candidate.musicBrainzId }),
        sourceUrl: candidate.sourceUrl,
        rank: index + 1,
        addEligibility: exactIdentity ? "exact-id" : "requires-resolution",
        status: "quarantined",
        reason: exactIdentity ? "not-selected" : "identity-required",
        rawSimilarity: candidate.similarity,
        adjustedScore,
        exposureCount: candidate.exposureCount,
        ...(policy.popularityDampening === 0
          ? {}
          : { popularityEvidence: "graph-exposure" as const }),
        provenance: candidate.provenance,
      });
    });
  return Object.freeze(ranked);
}

/**
 * Atomically validates and applies explicit visible-rank approvals.
 *
 * @param recommendations - Fresh visible ranking from the same invocation.
 * @param requestedRanks - One or more explicit positive visible ranks.
 * @param maxAdd - Resolved approval ceiling.
 * @returns Frozen recommendations plus approved candidates in visible-rank order.
 * @throws {TypeError} When any rank is malformed, duplicate, over budget, absent, or ineligible.
 */
export function approveDiscoveryRanks(
  recommendations: readonly SimilarArtistRecommendation[],
  requestedRanks: readonly number[],
  maxAdd: number,
): DiscoveryApprovalResult {
  positiveSafeInteger("Discovery maximum approved adds", maxAdd, LIDARR_DISCOVER_MAX_ADD);
  if (requestedRanks.length === 0) {
    throw new TypeError("Discovery approval requires at least one visible rank");
  }
  if (requestedRanks.length > maxAdd) {
    throw new TypeError(`Discovery approval exceeds the maximum of ${maxAdd}`);
  }

  const selected = new Set<number>();
  for (const rank of requestedRanks) {
    if (!Number.isSafeInteger(rank) || rank < 1) {
      throw new TypeError("Discovery approval ranks must be positive safe integers");
    }
    if (selected.has(rank)) throw new TypeError(`Discovery approval rank ${rank} is duplicated`);
    selected.add(rank);
  }
  const selectedRanks = [...selected].sort((left, right) => left - right);
  const selectedCandidates = selectedRanks.map((rank) => {
    const candidate = recommendations.find((recommendation) => recommendation.rank === rank);
    if (candidate === undefined) {
      throw new TypeError(`No visible discovery candidate has rank ${rank}`);
    }
    if (candidate.addEligibility !== "exact-id" || candidate.musicBrainzId === undefined) {
      throw new TypeError(`Discovery candidate rank ${rank} requires a canonical MusicBrainz ID`);
    }
    return candidate;
  });

  const approvedRanks = new Set(selectedRanks);
  const updated = recommendations.map(
    (candidate): SimilarArtistRecommendation =>
      Object.freeze({
        ...candidate,
        status: approvedRanks.has(candidate.rank) ? "approved" : "quarantined",
        reason: approvedRanks.has(candidate.rank)
          ? "selected"
          : candidate.addEligibility === "exact-id"
            ? "not-selected"
            : "identity-required",
      }),
  );
  const byRank = new Map(updated.map((candidate) => [candidate.rank, candidate] as const));
  const approved = selectedCandidates.map((candidate) => {
    const updatedCandidate = byRank.get(candidate.rank);
    if (updatedCandidate === undefined) {
      throw new Error("Discovery approval rank invariant violated");
    }
    return updatedCandidate;
  });

  return Object.freeze({
    selectedRanks: Object.freeze(selectedRanks),
    recommendations: Object.freeze(updated),
    approved: Object.freeze(approved),
  });
}
