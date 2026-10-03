/**
 * Deterministic radio-style sequencing for local smart playlists.
 *
 * Artist and genre gaps are hard preferences. When greedy selection stalls,
 * progressively wider bounded searches rearrange recent choices before the
 * least costly constraint violation is recorded and accepted. Tempo, era, and
 * energy are best-effort scoring preferences.
 */

import type { SeparationConfig } from "../types/filters.js";

type BpmBand = "low" | "medium" | "high";
export type SeparationConstraint = "artist" | "genre";

export interface SeparationTrack {
  filePath: string;
  artists?: readonly string[];
  genres?: readonly string[];
  year?: number;
  bpm?: number;
}

export interface SeparationRelaxation {
  /** One-based position of the relaxed placement */
  position: number;
  filePath: string;
  constraints: SeparationConstraint[];
}

export interface SeparationResult<T> {
  tracks: T[];
  relaxations: SeparationRelaxation[];
}

interface IndexedTrack<T> {
  track: T;
  stableIndex: number;
}

interface PreparedTrack<T extends SeparationTrack> extends IndexedTrack<T> {
  artists: ReadonlySet<string>;
  genres: ReadonlySet<string>;
  bpmBand: BpmBand | null;
  decade: number | null;
}

interface ConstraintViolation {
  constraint: SeparationConstraint;
  shortfall: number;
}

interface BpmThresholds {
  lowMax: number;
  highMin: number;
  uniform: boolean;
}

interface SequenceState {
  position: number;
  artistLastSeen: Map<string, number>;
  genreLastSeen: Map<string, number>;
  lastBpmBand: BpmBand | null;
  decadeCounts: Map<number, number>;
}

const BACKTRACK_WINDOWS = [4, 8, 12] as const;
const BACKTRACK_BRANCH_WIDTH = 12;
const BACKTRACK_NODE_BUDGET = 1_000;

const ENERGY_PATTERNS: Record<NonNullable<SeparationConfig["energy"]>, readonly BpmBand[]> = {
  alternate: ["low", "high"],
  rise: ["low", "medium", "high"],
  fall: ["high", "medium", "low"],
  wave: ["low", "medium", "high", "medium"],
};

function normalizeValues(values: readonly string[] | undefined): Set<string> {
  return new Set(
    (values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
  );
}

function createBpmThresholds<T extends SeparationTrack>(
  tracks: readonly IndexedTrack<T>[],
): BpmThresholds | undefined {
  const values = tracks
    .map(({ track }) => track.bpm)
    .filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  if (values.length === 0) return undefined;

  const minimum = values[0] as number;
  const maximum = values[values.length - 1] as number;
  if (minimum === maximum) {
    return { lowMax: minimum, highMin: maximum, uniform: true };
  }

  const lowIndex = Math.floor((values.length - 1) / 3);
  const highIndex = Math.ceil(((values.length - 1) * 2) / 3);
  return {
    lowMax: values[lowIndex] as number,
    highMin: values[highIndex] as number,
    uniform: false,
  };
}

function getBpmBand(
  bpm: number | undefined,
  thresholds: BpmThresholds | undefined,
): BpmBand | null {
  if (bpm === undefined || !Number.isFinite(bpm) || bpm <= 0 || thresholds === undefined) {
    return null;
  }
  if (thresholds.uniform) return "medium";
  if (bpm <= thresholds.lowMax) return "low";
  if (bpm >= thresholds.highMin) return "high";
  return "medium";
}

function prepareTracks<T extends SeparationTrack>(tracks: readonly T[]): PreparedTrack<T>[] {
  const indexed = tracks
    .map((track, stableIndex) => ({ track, stableIndex }))
    .sort((left, right) => {
      const pathDifference = left.track.filePath.localeCompare(right.track.filePath);
      return pathDifference !== 0 ? pathDifference : left.stableIndex - right.stableIndex;
    });
  const thresholds = createBpmThresholds(indexed);

  return indexed.map(({ track, stableIndex }) => ({
    track,
    stableIndex,
    artists: normalizeValues(track.artists),
    genres: normalizeValues(track.genres),
    bpmBand: getBpmBand(track.bpm, thresholds),
    decade: Number.isInteger(track.year) ? Math.floor((track.year as number) / 10) * 10 : null,
  }));
}

function createSequenceState(): SequenceState {
  return {
    position: 0,
    artistLastSeen: new Map(),
    genreLastSeen: new Map(),
    lastBpmBand: null,
    decadeCounts: new Map(),
  };
}

function cloneSequenceState(state: SequenceState): SequenceState {
  return {
    position: state.position,
    artistLastSeen: new Map(state.artistLastSeen),
    genreLastSeen: new Map(state.genreLastSeen),
    lastBpmBand: state.lastBpmBand,
    decadeCounts: new Map(state.decadeCounts),
  };
}

function appendToState<T extends SeparationTrack>(
  state: SequenceState,
  candidate: PreparedTrack<T>,
): void {
  for (const artist of candidate.artists) {
    state.artistLastSeen.set(artist, state.position);
  }
  for (const genre of candidate.genres) {
    state.genreLastSeen.set(genre, state.position);
  }
  if (candidate.bpmBand !== null) {
    state.lastBpmBand = candidate.bpmBand;
  }
  if (candidate.decade !== null) {
    state.decadeCounts.set(candidate.decade, (state.decadeCounts.get(candidate.decade) ?? 0) + 1);
  }
  state.position++;
}

function buildSequenceState<T extends SeparationTrack>(
  tracks: readonly PreparedTrack<T>[],
): SequenceState {
  const state = createSequenceState();
  for (const track of tracks) appendToState(state, track);
  return state;
}

function gapShortfall(
  values: ReadonlySet<string>,
  lastSeen: ReadonlyMap<string, number>,
  position: number,
  gap: number,
): number {
  let maximumShortfall = 0;
  for (const value of values) {
    const previousPosition = lastSeen.get(value);
    if (previousPosition === undefined) continue;
    const intervening = position - previousPosition - 1;
    maximumShortfall = Math.max(maximumShortfall, gap - intervening);
  }
  return Math.max(0, maximumShortfall);
}

function getViolations<T extends SeparationTrack>(
  candidate: PreparedTrack<T>,
  state: SequenceState,
  config: SeparationConfig,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  if (config.artist !== undefined) {
    const shortfall = gapShortfall(
      candidate.artists,
      state.artistLastSeen,
      state.position,
      config.artist,
    );
    if (shortfall > 0) violations.push({ constraint: "artist", shortfall });
  }

  if (config.genre !== undefined) {
    const shortfall = gapShortfall(
      candidate.genres,
      state.genreLastSeen,
      state.position,
      config.genre,
    );
    if (shortfall > 0) violations.push({ constraint: "genre", shortfall });
  }

  return violations;
}

function softScore<T extends SeparationTrack>(
  candidate: PreparedTrack<T>,
  state: SequenceState,
  config: SeparationConfig,
): number {
  let score = 0;

  if (config.tempo === "alternate" && candidate.bpmBand !== null && state.lastBpmBand !== null) {
    score += candidate.bpmBand === state.lastBpmBand ? -4 : 4;
  }

  if (config.era === "distribute" && candidate.decade !== null) {
    score += 3 - (state.decadeCounts.get(candidate.decade) ?? 0) * 2;
  }

  if (config.energy !== undefined && candidate.bpmBand !== null) {
    const pattern = ENERGY_PATTERNS[config.energy];
    const target = pattern[state.position % pattern.length];
    if (candidate.bpmBand === target) {
      score += 6;
    } else if (candidate.bpmBand === "medium" || target === "medium") {
      score += 1;
    } else {
      score -= 2;
    }
  }

  return score;
}

function isPreferredCandidate<T extends SeparationTrack>(
  candidate: PreparedTrack<T>,
  currentBest: PreparedTrack<T> | undefined,
  state: SequenceState,
  config: SeparationConfig,
): boolean {
  if (currentBest === undefined) return true;

  const candidateScore = softScore(candidate, state, config);
  const bestScore = softScore(currentBest, state, config);
  if (candidateScore !== bestScore) return candidateScore > bestScore;

  const pathDifference = candidate.track.filePath.localeCompare(currentBest.track.filePath);
  return pathDifference !== 0
    ? pathDifference < 0
    : candidate.stableIndex < currentBest.stableIndex;
}

function rankEligibleCandidates<T extends SeparationTrack>(
  available: readonly PreparedTrack<T>[],
  state: SequenceState,
  config: SeparationConfig,
): PreparedTrack<T>[] {
  return available
    .filter((candidate) => getViolations(candidate, state, config).length === 0)
    .sort((left, right) => {
      if (isPreferredCandidate(left, right, state, config)) return -1;
      if (isPreferredCandidate(right, left, state, config)) return 1;
      return 0;
    })
    .slice(0, BACKTRACK_BRANCH_WIDTH);
}

function searchReplacement<T extends SeparationTrack>(
  prefixState: SequenceState,
  pool: readonly PreparedTrack<T>[],
  targetLength: number,
  config: SeparationConfig,
): PreparedTrack<T>[] | null {
  let visitedNodes = 0;

  function search(
    partial: PreparedTrack<T>[],
    available: PreparedTrack<T>[],
    state: SequenceState,
  ): PreparedTrack<T>[] | null {
    if (partial.length === targetLength) return partial;
    if (visitedNodes >= BACKTRACK_NODE_BUDGET) return null;

    const eligible = rankEligibleCandidates(available, state, config);
    for (const candidate of eligible) {
      visitedNodes++;
      const nextState = cloneSequenceState(state);
      appendToState(nextState, candidate);
      const result = search(
        [...partial, candidate],
        available.filter((entry) => entry.stableIndex !== candidate.stableIndex),
        nextState,
      );
      if (result !== null) return result;
    }

    return null;
  }

  return search([], [...pool], cloneSequenceState(prefixState));
}

function tryBacktrack<T extends SeparationTrack>(
  selected: readonly PreparedTrack<T>[],
  remaining: readonly PreparedTrack<T>[],
  config: SeparationConfig,
): { selected: PreparedTrack<T>[]; remaining: PreparedTrack<T>[]; state: SequenceState } | null {
  const windowSizes = [
    ...new Set(BACKTRACK_WINDOWS.map((size) => Math.min(size, selected.length))),
  ].filter((size) => size > 0);

  for (const tailLength of windowSizes) {
    const prefix = selected.slice(0, selected.length - tailLength);
    const pool = [...selected.slice(selected.length - tailLength), ...remaining];
    const replacement = searchReplacement(buildSequenceState(prefix), pool, tailLength + 1, config);
    if (replacement === null) continue;

    const replacementIds = new Set(replacement.map(({ stableIndex }) => stableIndex));
    const nextSelected = [...prefix, ...replacement];
    return {
      selected: nextSelected,
      remaining: pool.filter(({ stableIndex }) => !replacementIds.has(stableIndex)),
      state: buildSequenceState(nextSelected),
    };
  }

  return null;
}

function selectRelaxedCandidate<T extends SeparationTrack>(
  remaining: readonly PreparedTrack<T>[],
  state: SequenceState,
  config: SeparationConfig,
): { candidate: PreparedTrack<T>; index: number } {
  let bestCandidate = remaining[0] as PreparedTrack<T>;
  let bestIndex = 0;
  let bestShortfall = Number.POSITIVE_INFINITY;

  for (let index = 0; index < remaining.length; index++) {
    const candidate = remaining[index] as PreparedTrack<T>;
    const shortfall = getViolations(candidate, state, config).reduce(
      (sum, violation) => sum + violation.shortfall,
      0,
    );
    if (
      shortfall < bestShortfall ||
      (shortfall === bestShortfall && isPreferredCandidate(candidate, bestCandidate, state, config))
    ) {
      bestCandidate = candidate;
      bestIndex = index;
      bestShortfall = shortfall;
    }
  }

  return { candidate: bestCandidate, index: bestIndex };
}

function collectRelaxations<T extends SeparationTrack>(
  selected: readonly PreparedTrack<T>[],
  config: SeparationConfig,
): SeparationRelaxation[] {
  const state = createSequenceState();
  const relaxations: SeparationRelaxation[] = [];

  for (const candidate of selected) {
    const violations = getViolations(candidate, state, config);
    if (violations.length > 0) {
      relaxations.push({
        position: state.position + 1,
        filePath: candidate.track.filePath,
        constraints: violations.map(({ constraint }) => constraint),
      });
    }
    appendToState(state, candidate);
  }

  return relaxations;
}

/**
 * Reorders tracks according to a separation policy without dropping or
 * duplicating candidates. Input order is not mutated.
 */
export function sequenceTracks<T extends SeparationTrack>(
  tracks: readonly T[],
  config: SeparationConfig,
): SeparationResult<T> {
  let remaining = prepareTracks(tracks);
  let selected: PreparedTrack<T>[] = [];
  let state = createSequenceState();

  while (remaining.length > 0) {
    let bestCandidate: PreparedTrack<T> | undefined;
    let bestIndex = -1;

    for (let index = 0; index < remaining.length; index++) {
      const candidate = remaining[index] as PreparedTrack<T>;
      if (getViolations(candidate, state, config).length > 0) continue;
      if (isPreferredCandidate(candidate, bestCandidate, state, config)) {
        bestCandidate = candidate;
        bestIndex = index;
      }
    }

    if (bestCandidate !== undefined) {
      selected.push(bestCandidate);
      remaining.splice(bestIndex, 1);
      appendToState(state, bestCandidate);
      continue;
    }

    const backtracked = tryBacktrack(selected, remaining, config);
    if (backtracked !== null) {
      selected = backtracked.selected;
      remaining = backtracked.remaining;
      state = backtracked.state;
      continue;
    }

    const relaxed = selectRelaxedCandidate(remaining, state, config);
    selected.push(relaxed.candidate);
    remaining.splice(relaxed.index, 1);
    appendToState(state, relaxed.candidate);
  }

  return {
    tracks: selected.map(({ track }) => track),
    relaxations: collectRelaxations(selected, config),
  };
}
