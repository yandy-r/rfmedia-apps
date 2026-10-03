/**
 * Framework-independent Last.fm similar-artist discovery action.
 *
 * The action validates before resolving dependencies, performs deterministic
 * bounded breadth-first traversal through the discovery scheduler lane, and
 * returns one fresh immutable attributed projection. It never resolves or
 * calls Lidarr on the ordinary preview path.
 */

import {
  admitDiscoveryCandidates,
  approveDiscoveryRanks,
  createDiscoveryPolicyState,
  LIDARR_DISCOVER_HARD_BOUNDS,
  rankDiscoveryCandidates,
  registerDiscoverySeed,
  registerDiscoverySeedAlias,
  resolveDiscoveryPolicy,
  type DiscoveryPolicyOptions,
  type DiscoveryPolicyState,
} from "../../lib/discovery/policy.js";
import { createLastFmClient, LastFmProviderError } from "../../lib/discovery/lastfm.js";
import { getLoadedConfig } from "../../lib/loaded-config.js";
import {
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../../lib/lidarr/album-types.js";
import { LidarrValidationError } from "../../lib/lidarr/errors.js";
import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import type {
  LidarrExecutionFailure,
  LidarrExecutionResult,
  LidarrExecutionSuccessMetadata,
  LidarrScheduledTask,
  LidarrScheduler,
} from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { redactErrorMessage } from "../../lib/redact-error-message.js";
import type {
  DiscoveryProviderFailureCode,
  LastFmClient,
  LastFmSimilarArtistResult,
  LidarrDiscoverHandoff,
  LidarrDiscoverHandoffCounts,
  LidarrDiscoverResult,
} from "../../types/discovery.js";
import { LIDARR_DISCOVER_DEFAULT_LIMIT, LIDARR_DISCOVER_MAX_LIMIT } from "../../types/discovery.js";

export { LIDARR_DISCOVER_DEFAULT_LIMIT, LIDARR_DISCOVER_MAX_LIMIT } from "../../types/discovery.js";

const DISCOVERY_OPERATION = "lidarr discover";
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const MAX_ARTIST_CODE_POINTS = 256;
const MAX_ARTIST_UTF8_BYTES = 1_024;
const MAX_RESOURCE_REFERENCE_LENGTH = 2_048;
const MAX_PLAN_PATH_LENGTH = 4_096;

/** Reliability tier for independent similar-artist discovery. */
export const TIER = "discovery" as const satisfies LidarrTier;

interface LidarrDiscoverHandoffSharedOptions {
  readonly rootFolder: string;
  readonly qualityProfile: string;
  readonly metadataProfile?: string;
  readonly monitored?: boolean;
  readonly postAddUnmonitorSelectors?: readonly LidarrAlbumTypeSelector[];
  readonly planFile: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

interface ValidatedHandoffOptions {
  readonly selectedRanks: readonly number[];
  readonly postAddUnmonitorSelectors?: readonly LidarrAlbumTypeSelector[];
}

/** Explicit visible-rank selection and shared resources for one optional plan handoff. */
export type LidarrDiscoverHandoffActionOptions = LidarrDiscoverHandoffSharedOptions &
  (
    | {
        readonly selectedRanks: readonly number[];
        readonly selectedRank?: never;
      }
    | {
        /** Compatibility input for the former single-rank action handoff. */
        readonly selectedRank: number;
        readonly selectedRanks?: never;
      }
  );

/** Inputs for one attributed Last.fm discovery and optional sealed-plan handoff. */
export interface LidarrDiscoverActionOptions extends DiscoveryPolicyOptions {
  readonly artist: string;
  readonly limit?: number;
  readonly autocorrect?: boolean;
  readonly signal?: AbortSignal;
  readonly handoff?: LidarrDiscoverHandoffActionOptions;
}

interface DiscoverySeedWork {
  readonly artist: string;
  readonly seedIndex: number;
  readonly depth: number;
  readonly path: readonly string[];
  readonly sequence: number;
}

interface DiscoveryProviderSuccess {
  readonly seed: DiscoverySeedWork;
  readonly value: LastFmSimilarArtistResult;
  readonly execution?: LidarrExecutionSuccessMetadata;
}

function validationError(message: string): LidarrValidationError {
  return new LidarrValidationError(DISCOVERY_OPERATION, message);
}

function normalizeArtistName(artist: string): string {
  if (typeof artist !== "string") {
    throw validationError("Discovery artist must be a string");
  }
  if (TERMINAL_CONTROL_PATTERN.test(artist)) {
    throw validationError("Discovery artist must not contain control characters");
  }

  const normalized = artist.trim().normalize("NFC");
  const codePointLength = [...normalized].length;
  if (codePointLength < 1 || codePointLength > MAX_ARTIST_CODE_POINTS) {
    throw validationError(
      `Discovery artist must contain 1-${MAX_ARTIST_CODE_POINTS} Unicode code points`,
    );
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_ARTIST_UTF8_BYTES) {
    throw validationError(`Discovery artist must not exceed ${MAX_ARTIST_UTF8_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? LIDARR_DISCOVER_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > LIDARR_DISCOVER_MAX_LIMIT) {
    throw validationError(
      `Discovery limit must be a safe integer from 1 to ${LIDARR_DISCOVER_MAX_LIMIT}`,
    );
  }
  return resolved;
}

function resolveAutocorrect(autocorrect: boolean | undefined): boolean {
  const resolved = autocorrect ?? true;
  if (typeof resolved !== "boolean") {
    throw validationError("Discovery autocorrect must be a boolean");
  }
  return resolved;
}

function resolveActionPolicy(options: LidarrDiscoverActionOptions) {
  try {
    return resolveDiscoveryPolicy({
      minSimilarity: options.minSimilarity,
      maxPerSeed: options.maxPerSeed,
      deep: options.deep,
      cascade: options.cascade,
      diversityBoost: options.diversityBoost,
      popularityDampening: options.popularityDampening,
      maxAdd: options.maxAdd,
    });
  } catch (error: unknown) {
    if (error instanceof TypeError) throw validationError(error.message);
    throw error;
  }
}

function validateHandoffText(
  handoff: Readonly<Record<string, unknown>>,
  key: keyof LidarrDiscoverHandoffSharedOptions,
  label: string,
  maximum: number,
  trimForPresence: boolean,
): void {
  const value = handoff[key];
  const presence = typeof value === "string" && trimForPresence ? value.trim() : value;
  if (
    typeof value !== "string" ||
    typeof presence !== "string" ||
    presence.length === 0 ||
    value.length > maximum ||
    TERMINAL_CONTROL_PATTERN.test(value)
  ) {
    throw validationError(
      `${label} must be non-empty, at most ${maximum} characters, and terminal-safe`,
    );
  }
}

function validateHandoffOptions(
  handoff: unknown,
  maxAdd: number,
): ValidatedHandoffOptions | undefined {
  if (handoff === undefined) return undefined;
  if (typeof handoff !== "object" || handoff === null || Array.isArray(handoff)) {
    throw validationError("Discovery handoff must be an object");
  }
  const values = handoff as Readonly<Record<string, unknown>>;
  const hasSelectedRanks = values["selectedRanks"] !== undefined;
  const hasSelectedRank = values["selectedRank"] !== undefined;
  if (hasSelectedRanks === hasSelectedRank) {
    throw validationError("Discovery handoff requires exactly one rank selection shape");
  }
  const rawRanks = hasSelectedRanks ? values["selectedRanks"] : [values["selectedRank"]];
  if (!Array.isArray(rawRanks) || rawRanks.length === 0) {
    throw validationError("Discovery handoff ranks must be a non-empty array");
  }
  if (rawRanks.length > maxAdd) {
    throw validationError(`Discovery handoff selects more than the maximum of ${maxAdd} ranks`);
  }
  const ranks = rawRanks.map((rank) => {
    if (
      !Number.isSafeInteger(rank) ||
      typeof rank !== "number" ||
      rank < 1 ||
      rank > LIDARR_DISCOVER_HARD_BOUNDS.maxVisibleCandidates
    ) {
      throw validationError(
        `Discovery handoff ranks must be safe integers from 1 to ${LIDARR_DISCOVER_HARD_BOUNDS.maxVisibleCandidates}`,
      );
    }
    return rank;
  });
  if (new Set(ranks).size !== ranks.length) {
    throw validationError("Discovery handoff ranks must be unique");
  }

  validateHandoffText(
    values,
    "rootFolder",
    "Discovery handoff root folder",
    MAX_RESOURCE_REFERENCE_LENGTH,
    true,
  );
  validateHandoffText(
    values,
    "qualityProfile",
    "Discovery handoff quality profile",
    MAX_RESOURCE_REFERENCE_LENGTH,
    true,
  );
  if (values["metadataProfile"] !== undefined) {
    validateHandoffText(
      values,
      "metadataProfile",
      "Discovery handoff metadata profile",
      MAX_RESOURCE_REFERENCE_LENGTH,
      true,
    );
  }
  if (values["monitored"] !== undefined && typeof values["monitored"] !== "boolean") {
    throw validationError("Discovery handoff monitored policy must be a boolean");
  }
  const rawSelectors = values["postAddUnmonitorSelectors"];
  let postAddUnmonitorSelectors: readonly LidarrAlbumTypeSelector[] | undefined;
  if (rawSelectors !== undefined) {
    if (
      !Array.isArray(rawSelectors) ||
      rawSelectors.some((selector) => typeof selector !== "string")
    ) {
      throw validationError("Discovery handoff post-add selectors must be a string array");
    }
    try {
      postAddUnmonitorSelectors =
        rawSelectors.length === 0
          ? Object.freeze([])
          : parseAlbumTypeSelectors(rawSelectors.join(","));
    } catch (error: unknown) {
      throw validationError(
        error instanceof Error ? error.message : "Discovery handoff post-add selectors are invalid",
      );
    }
  }
  validateHandoffText(
    values,
    "planFile",
    "Discovery handoff plan file",
    MAX_PLAN_PATH_LENGTH,
    false,
  );
  return Object.freeze({
    selectedRanks: Object.freeze(ranks),
    ...(postAddUnmonitorSelectors === undefined ? {} : { postAddUnmonitorSelectors }),
  });
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("Discovery was cancelled", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function providerFailureCode(
  failureType: LidarrExecutionFailure["failureType"],
): DiscoveryProviderFailureCode {
  switch (failureType) {
    case "discovery-provider-unavailable":
    case "rate-limited":
    case "validation":
    case "authentication":
    case "authorization":
    case "invalid-response":
    case "timeout":
    case "configuration":
      return failureType;
    case "aborted":
    case "budget-exhausted":
    case "lidarr-unreachable":
    case "metadata-provider-unavailable":
    case "not-found":
    case "unknown":
      return "discovery-provider-unavailable";
  }
}

function throwStructuredBatchFailure(
  result: Exclude<
    LidarrExecutionResult<LastFmSimilarArtistResult>,
    { readonly outcome: "succeeded" }
  >,
  signal: AbortSignal | undefined,
): never {
  if (result.failureType === "aborted") throw abortReason(signal);
  const code =
    result.failureType === "budget-exhausted"
      ? "configuration"
      : providerFailureCode(result.failureType);
  throw new LastFmProviderError(
    code,
    result.failureType === "budget-exhausted"
      ? "Last.fm discovery scheduler budget was exhausted"
      : "Last.fm discovery request failed",
    result.retryable === true,
    {
      ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
      ...(result.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: result.retryAfterSeconds }),
    },
  );
}

function providerTask(
  client: LastFmClient,
  seed: DiscoverySeedWork,
  limit: number,
  autocorrect: boolean,
): LidarrScheduledTask<LastFmSimilarArtistResult> {
  return {
    id: seed.depth === 0 ? "lidarr-discover" : `lidarr-discover-${seed.depth}-${seed.sequence}`,
    operation: DISCOVERY_OPERATION,
    idempotent: true,
    run: ({ signal }) =>
      client.getSimilarArtists({
        artist: seed.artist,
        limit,
        autocorrect,
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}

async function executeProviderWave(
  scheduler: LidarrScheduler,
  client: LastFmClient,
  wave: readonly DiscoverySeedWork[],
  limit: number,
  autocorrect: boolean,
  signal: AbortSignal | undefined,
): Promise<readonly DiscoveryProviderSuccess[]> {
  const tasks = wave.map((seed) => providerTask(client, seed, limit, autocorrect));
  if (wave.length === 1 && wave[0]?.depth === 0) {
    const initialTask = tasks[0];
    const initialSeed = wave[0];
    if (initialTask === undefined || initialSeed === undefined) {
      throw new Error("Discovery initial wave invariant violated");
    }
    const scheduled = await scheduler.runSingle(
      TIER,
      initialTask,
      signal === undefined ? {} : { signal },
    );
    return Object.freeze([
      Object.freeze({
        seed: initialSeed,
        value: scheduled.value,
        execution: Object.freeze({ ...scheduled.execution }),
      }),
    ]);
  }

  const batch = await scheduler.runBatch(TIER, tasks, signal === undefined ? {} : { signal });
  const terminal = batch.results.find((result) => result.outcome !== "succeeded");
  if (terminal !== undefined) {
    throwStructuredBatchFailure(terminal, signal);
  }
  return Object.freeze(
    batch.results.map((result, index) => {
      if (result.outcome !== "succeeded") {
        throw new Error("Discovery batch success invariant violated");
      }
      const seed = wave[index];
      if (seed === undefined) throw new Error("Discovery wave ordering invariant violated");
      return Object.freeze({ seed, value: result.value });
    }),
  );
}

function emptyHandoffCounts(): LidarrDiscoverHandoffCounts {
  return Object.freeze({ approved: 0, alreadyPresent: 0, planned: 0, failed: 0 });
}

function freezeHandoff(handoff: LidarrDiscoverHandoff): LidarrDiscoverHandoff {
  return Object.freeze({
    ...handoff,
    approvals: Object.freeze([...handoff.approvals]),
    counts: Object.freeze({ ...handoff.counts }),
    ...("selectedRanks" in handoff
      ? { selectedRanks: Object.freeze([...handoff.selectedRanks]) }
      : {}),
  }) as LidarrDiscoverHandoff;
}

function withHandoff(
  result: Omit<LidarrDiscoverResult, "handoff">,
  handoff: LidarrDiscoverHandoff,
): LidarrDiscoverResult {
  return Object.freeze({ ...result, handoff: freezeHandoff(handoff) });
}

function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function approvalFailureCode(
  message: string,
): "candidate-not-found" | "identity-required" | "lidarr-plan-failed" {
  if (message.startsWith("No visible discovery candidate has rank ")) {
    return "candidate-not-found";
  }
  if (message.includes("requires a canonical MusicBrainz ID")) {
    return "identity-required";
  }
  return "lidarr-plan-failed";
}

function retryableError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}

/**
 * Executes one bounded, attributed Last.fm similar-artist discovery.
 *
 * @param options - Artist, provider request, policy, cancellation, and optional rank handoff.
 * @returns A fresh immutable discovery result with traversal and scheduler evidence.
 * @throws {LidarrValidationError} When local or policy input is invalid.
 * @throws {LastFmProviderError} When any scheduled provider request fails.
 */
export async function executeLidarrDiscover(
  options: LidarrDiscoverActionOptions,
): Promise<LidarrDiscoverResult> {
  const artist = normalizeArtistName(options.artist);
  const limit = resolveLimit(options.limit);
  const autocorrect = resolveAutocorrect(options.autocorrect);
  const policy = resolveActionPolicy(options);
  const validatedHandoff = validateHandoffOptions(options.handoff, policy.maxAdd);

  const loadedConfig = getLoadedConfig();
  const lastFm = createLastFmClient(loadedConfig.discovery?.lastfm ?? {});
  const scheduler = resolveLidarrScheduler();
  let state: DiscoveryPolicyState = createDiscoveryPolicyState({ name: artist });
  let wave: readonly DiscoverySeedWork[] = Object.freeze([
    Object.freeze({ artist, seedIndex: 0, depth: 0, path: Object.freeze([artist]), sequence: 0 }),
  ]);
  let nextSequence = 1;
  let requestsMade = 0;
  let maximumDepthReached = 0;
  let initialResult: LastFmSimilarArtistResult | undefined;
  let initialExecution: LidarrExecutionSuccessMetadata | undefined;

  while (wave.length > 0) {
    throwIfAborted(options.signal);
    const successes = await executeProviderWave(
      scheduler,
      lastFm,
      wave,
      limit,
      autocorrect,
      options.signal,
    );
    requestsMade += wave.length;
    const nextWave: DiscoverySeedWork[] = [];

    for (const success of successes) {
      throwIfAborted(options.signal);
      state = registerDiscoverySeedAlias(state, success.seed.seedIndex, success.value.resolvedName);
      if (initialResult === undefined) {
        initialResult = success.value;
        initialExecution = success.execution;
      }
      const candidateDepth = success.seed.depth + 1;
      maximumDepthReached = Math.max(maximumDepthReached, candidateDepth);
      const seedArtist = initialResult.resolvedName;
      const resolvedPath =
        success.seed.depth === 0
          ? [success.value.resolvedName]
          : [...success.seed.path.slice(0, -1), success.value.resolvedName];
      const observations = success.value.recommendations.map((candidate, providerIndex) => ({
        ...candidate,
        seedArtist,
        parentArtist: success.value.resolvedName,
        depth: candidateDepth,
        providerRank: providerIndex + 1,
        firstPath: Object.freeze([...resolvedPath, candidate.name]),
        discoveredAt: success.value.source.fetchedAt,
      }));
      const admission = admitDiscoveryCandidates(state, observations, policy);
      state = admission.state;

      if (candidateDepth >= policy.maxDepth || !policy.cascade) continue;
      for (const decision of admission.decisions) {
        if (decision.status !== "quarantined") continue;
        throwIfAborted(options.signal);
        if (requestsMade + nextWave.length >= LIDARR_DISCOVER_HARD_BOUNDS.maxRequests) break;
        const candidate = state.candidates.find(({ identity }) => identity === decision.identity);
        if (candidate === undefined) {
          throw new Error("Discovery admitted candidate identity invariant violated");
        }
        const registration = registerDiscoverySeed(state, candidate);
        state = registration.state;
        if (!registration.registered) continue;
        nextWave.push(
          Object.freeze({
            artist: candidate.name,
            seedIndex: registration.seedIndex,
            depth: candidateDepth,
            path: candidate.provenance.firstPath,
            sequence: nextSequence,
          }),
        );
        nextSequence += 1;
      }
    }
    wave = Object.freeze(nextWave);
  }

  if (initialResult === undefined || initialExecution === undefined) {
    throw new Error("Discovery initial request invariant violated");
  }
  const recommendations = rankDiscoveryCandidates(state, policy);
  const baseResult: Omit<LidarrDiscoverResult, "handoff"> = Object.freeze({
    seed: Object.freeze({
      requestedName: initialResult.requestedName,
      resolvedName: initialResult.resolvedName,
      autocorrected: initialResult.autocorrected,
    }),
    request: Object.freeze({ limit, autocorrect }),
    policy,
    hardBounds: LIDARR_DISCOVER_HARD_BOUNDS,
    traversal: Object.freeze({
      seedsRequested: requestsMade,
      requestsMade,
      maximumDepthReached,
      visited: state.seedIdentities.length,
      visible: recommendations.length,
      filtered: state.filteredCount,
      duplicatePaths: state.duplicatePaths,
    }),
    recommendations,
    returned: recommendations.length,
    source: Object.freeze({ ...initialResult.source }),
    execution: initialExecution,
  });
  if (options.handoff === undefined || validatedHandoff === undefined) {
    return withHandoff(baseResult, {
      status: "not-requested",
      approvals: Object.freeze([]),
      counts: emptyHandoffCounts(),
    });
  }
  const requestedRanks = validatedHandoff.selectedRanks;

  let approval;
  try {
    approval = approveDiscoveryRanks(recommendations, requestedRanks, policy.maxAdd);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = approvalFailureCode(message);
    const selectedRank = requestedRanks[0];
    if (selectedRank === undefined) {
      throw new Error("Discovery prevalidated handoff rank invariant violated");
    }
    const approvals = requestedRanks.map((rank) => {
      const candidate = recommendations.find((recommendation) => recommendation.rank === rank);
      return Object.freeze({
        status: "failed" as const,
        selectedRank: rank,
        ...(candidate?.musicBrainzId === undefined
          ? {}
          : { musicBrainzId: candidate.musicBrainzId }),
        code,
        message,
        retryable: false,
      });
    });
    return withHandoff(baseResult, {
      status: "failed",
      selectedRank,
      selectedRanks: requestedRanks,
      code,
      message,
      retryable: false,
      approvals: Object.freeze(approvals),
      counts: Object.freeze({ ...emptyHandoffCounts(), failed: approvals.length }),
    });
  }

  const firstApproved = approval.approved[0];
  if (firstApproved === undefined || firstApproved.musicBrainzId === undefined) {
    throw new Error("Discovery approval non-empty exact-identity invariant violated");
  }
  const approvedResult: Omit<LidarrDiscoverResult, "handoff"> = Object.freeze({
    ...baseResult,
    recommendations: approval.recommendations,
  });

  try {
    const { executeLidarrArtistAddPlan } = await import("./plan-artist-add.js");
    const planned = await executeLidarrArtistAddPlan({
      recommendations: Object.freeze([firstApproved, ...approval.approved.slice(1)]),
      seedArtist: initialResult.resolvedName,
      discoveredAt: initialResult.source.fetchedAt,
      rootFolder: options.handoff.rootFolder,
      qualityProfile: options.handoff.qualityProfile,
      metadataProfile: options.handoff.metadataProfile,
      monitored: options.handoff.monitored,
      postAddUnmonitorSelectors: validatedHandoff.postAddUnmonitorSelectors,
      output: options.handoff.planFile,
      lidarrUrl: options.handoff.lidarrUrl,
      lidarrApiKey: options.handoff.lidarrApiKey,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (planned.status === "already-present") {
      const alreadyPresentByRank = new Map(
        planned.alreadyPresent.map((candidate) => [candidate.selectedRank, candidate] as const),
      );
      const approvals = approval.approved.map((candidate) => {
        const evidence = alreadyPresentByRank.get(candidate.rank);
        if (candidate.musicBrainzId === undefined || evidence === undefined) {
          throw new Error("Discovery already-present evidence invariant violated");
        }
        return Object.freeze({
          status: "already-present" as const,
          selectedRank: candidate.rank,
          musicBrainzId: candidate.musicBrainzId,
          lidarrId: evidence.lidarrId,
        });
      });
      return withHandoff(approvedResult, {
        status: "already-present",
        selectedRank: firstApproved.rank,
        selectedRanks: approval.selectedRanks,
        musicBrainzId: planned.foreignArtistId,
        lidarrId: planned.lidarrId,
        approvals: Object.freeze(approvals),
        counts: Object.freeze({
          approved: approval.approved.length,
          alreadyPresent: planned.alreadyPresent.length,
          planned: 0,
          failed: 0,
        }),
      });
    }
    const plannedByRank = new Map(
      planned.planned.map((candidate) => [candidate.selectedRank, candidate] as const),
    );
    const alreadyPresentByRank = new Map(
      planned.alreadyPresent.map((candidate) => [candidate.selectedRank, candidate] as const),
    );
    const approvals = approval.approved.map((candidate) => {
      if (candidate.musicBrainzId === undefined) {
        throw new Error("Discovery approved identity invariant violated");
      }
      const alreadyPresent = alreadyPresentByRank.get(candidate.rank);
      if (alreadyPresent !== undefined) {
        return Object.freeze({
          status: "already-present" as const,
          selectedRank: candidate.rank,
          musicBrainzId: candidate.musicBrainzId,
          lidarrId: alreadyPresent.lidarrId,
        });
      }
      if (!plannedByRank.has(candidate.rank)) {
        throw new Error("Discovery planned evidence invariant violated");
      }
      return Object.freeze({
        status: "planned" as const,
        selectedRank: candidate.rank,
        musicBrainzId: candidate.musicBrainzId,
      });
    });
    return withHandoff(approvedResult, {
      status: "plan-created",
      selectedRank: firstApproved.rank,
      selectedRanks: approval.selectedRanks,
      musicBrainzId: firstApproved.musicBrainzId,
      approvals: Object.freeze(approvals),
      counts: Object.freeze({
        approved: approval.approved.length,
        alreadyPresent: planned.alreadyPresent.length,
        planned: planned.planned.length,
        failed: 0,
      }),
      planId: planned.plan.id,
      planChecksum: planned.plan.payloadChecksum,
      planPath: planned.planPath,
      nextCommand: `rfmedia lidarr apply ${quotePosixShellArgument(planned.planPath)}`,
    });
  } catch (error) {
    const message = redactErrorMessage(error, [
      loadedConfig.discovery?.lastfm?.apiKey,
      loadedConfig.lidarr?.apiKey,
      options.handoff.lidarrApiKey,
    ]);
    const retryable = retryableError(error);
    return withHandoff(approvedResult, {
      status: "failed",
      selectedRank: firstApproved.rank,
      selectedRanks: approval.selectedRanks,
      code: "lidarr-plan-failed",
      message,
      retryable,
      approvals: Object.freeze(
        approval.approved.map((candidate) =>
          Object.freeze({
            status: "failed",
            selectedRank: candidate.rank,
            ...(candidate.musicBrainzId === undefined
              ? {}
              : { musicBrainzId: candidate.musicBrainzId }),
            code: "lidarr-plan-failed",
            message,
            retryable,
          }),
        ),
      ),
      counts: Object.freeze({
        approved: approval.approved.length,
        alreadyPresent: 0,
        planned: 0,
        failed: approval.approved.length,
      }),
    });
  }
}
