/** Creates one sealed foreign-ID artist-add plan from approved visible recommendations. */

import { resolve } from "node:path";

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrExecutionContext,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import {
  resolveLidarrProfileReference,
  resolveLidarrRootFolderReference,
} from "../../lib/lidarr/artist-selection.js";
import {
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "../../lib/lidarr/album-types.js";
import {
  buildLidarrArtistAddPlanV3,
  canonicalizeLidarrArtistAddPlanEntryInput,
  writeLidarrPlanArtifact,
  type BuildLidarrArtistAddPlanEntryV2Input,
} from "../../lib/lidarr/plan-engine.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import type { LidarrScheduledTask } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import {
  isCanonicalMusicBrainzId,
  LIDARR_DISCOVER_MAX_ADD,
  LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES,
  type SimilarArtistRecommendation,
} from "../../types/discovery.js";
import type {
  LidarrArtistAddPlanGenerationResultV3,
  LidarrPlanResourceReference,
  LidarrPlanRootFolderReference,
} from "../../types/lidarr-plan.js";

export const TIER = "metadata-dependent" as const satisfies LidarrTier;

const MAX_RESOURCE_REFERENCE_LENGTH = 2_048;
const MAX_PLAN_PATH_LENGTH = 4_096;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

interface LidarrArtistAddPlanSharedOptions {
  readonly seedArtist: string;
  readonly discoveredAt: string;
  readonly rootFolder: string;
  readonly qualityProfile: string;
  readonly metadataProfile?: string;
  readonly monitored?: boolean;
  readonly postAddUnmonitorSelectors?: readonly string[];
  readonly output: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

/** Inputs supplied by the successful discovery action for approved visible ranks. */
export type LidarrArtistAddPlanActionOptions = LidarrArtistAddPlanSharedOptions &
  (
    | {
        readonly recommendations: readonly [
          SimilarArtistRecommendation,
          ...SimilarArtistRecommendation[],
        ];
        readonly recommendation?: never;
      }
    | {
        /** Compatibility input for the former single-recommendation handoff. */
        readonly recommendation: SimilarArtistRecommendation;
        readonly recommendations?: never;
      }
  );

/** Evidence for one approved candidate that remains addable. */
export interface LidarrArtistAddPlannedEvidence {
  readonly selectedRank: number;
  readonly foreignArtistId: string;
}

/** Evidence for one approved candidate already installed by exact MBID. */
export interface LidarrArtistAddAlreadyPresentEvidence extends LidarrArtistAddPlannedEvidence {
  readonly lidarrId: number;
}

/** One aggregate plan artifact or an all-satisfied exact-MBID no-op. */
export type LidarrArtistAddPlanActionResult =
  | ({
      readonly status: "plan-created";
      readonly planned: readonly LidarrArtistAddPlannedEvidence[];
      readonly alreadyPresent: readonly LidarrArtistAddAlreadyPresentEvidence[];
    } & LidarrArtistAddPlanGenerationResultV3)
  | {
      readonly status: "already-present";
      readonly planned: readonly [];
      readonly alreadyPresent: readonly LidarrArtistAddAlreadyPresentEvidence[];
      /** First selected MBID retained for the former single-result caller. */
      readonly foreignArtistId: string;
      /** First selected Lidarr ID retained for the former single-result caller. */
      readonly lidarrId: number;
    };

interface ValidatedRecommendation {
  readonly recommendation: SimilarArtistRecommendation;
  readonly selectedRank: number;
  readonly foreignArtistId: string;
}

interface ArtistAddSharedResourceRead {
  readonly kind: "shared-resources";
  readonly rootFolders: Awaited<ReturnType<LidarrClientApi["listRootFolders"]>>;
  readonly qualityProfiles: Awaited<ReturnType<LidarrClientApi["listQualityProfiles"]>>;
  readonly metadataProfiles: Awaited<ReturnType<LidarrClientApi["listMetadataProfileDetails"]>>;
}

interface ArtistAddCandidateRead {
  readonly kind: "candidate";
  readonly candidate: ValidatedRecommendation;
  readonly lookup: Awaited<ReturnType<LidarrClientApi["lookupArtists"]>>;
  readonly installed: Awaited<ReturnType<LidarrClientApi["getArtistByForeignId"]>>;
}

type ArtistAddPlanRead = ArtistAddSharedResourceRead | ArtistAddCandidateRead;

function toProfileReference(profile: {
  readonly id: number;
  readonly name: string;
}): LidarrPlanResourceReference {
  return Object.freeze({ id: profile.id, name: profile.name });
}

function toRootFolderReference(rootFolder: {
  readonly id: number;
  readonly path: string;
}): LidarrPlanRootFolderReference {
  return Object.freeze({ id: rootFolder.id, path: rootFolder.path });
}

function validateRecommendations(
  options: LidarrArtistAddPlanActionOptions,
): readonly [ValidatedRecommendation, ...ValidatedRecommendation[]] {
  const seedArtist = validateEvidenceString(options.seedArtist, "discovery seed artist");
  const discoveredAt = validateEvidenceString(options.discoveredAt, "discovery timestamp");
  if (!Number.isFinite(Date.parse(discoveredAt))) {
    throw new LidarrPlanValidationError("discovery timestamp must be a valid date");
  }
  const recommendations =
    options.recommendations === undefined ? [options.recommendation] : options.recommendations;
  if (recommendations.length === 0 || recommendations.length > LIDARR_DISCOVER_MAX_ADD) {
    throw new LidarrPlanValidationError(
      `selected recommendations must contain from 1 through ${LIDARR_DISCOVER_MAX_ADD} candidates`,
    );
  }

  const seenRanks = new Set<number>();
  const seenForeignArtistIds = new Set<string>();
  const validated = recommendations.map((recommendation, index) => {
    if (
      typeof recommendation !== "object" ||
      recommendation === null ||
      Array.isArray(recommendation) ||
      typeof recommendation.provenance !== "object" ||
      recommendation.provenance === null ||
      Array.isArray(recommendation.provenance)
    ) {
      throw new LidarrPlanValidationError(
        `selected recommendation ${index + 1} must contain provenance`,
      );
    }
    const selectedRank = recommendation.rank;
    if (
      !Number.isSafeInteger(selectedRank) ||
      selectedRank < 1 ||
      selectedRank > LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES
    ) {
      throw new LidarrPlanValidationError(
        `selected recommendation rank must be a positive safe integer no greater than ${LIDARR_DISCOVER_MAX_VISIBLE_CANDIDATES}`,
      );
    }
    if (seenRanks.has(selectedRank)) {
      throw new LidarrPlanValidationError(
        `selected recommendations contain duplicate rank ${selectedRank}`,
      );
    }
    seenRanks.add(selectedRank);

    const foreignArtistId = recommendation.musicBrainzId;
    if (
      foreignArtistId === undefined ||
      !isCanonicalMusicBrainzId(foreignArtistId) ||
      foreignArtistId !== foreignArtistId.toLowerCase()
    ) {
      throw new LidarrPlanValidationError(
        `selected recommendation rank ${selectedRank} requires a canonical lowercase MusicBrainz artist ID`,
      );
    }
    if (seenForeignArtistIds.has(foreignArtistId)) {
      throw new LidarrPlanValidationError(
        `selected recommendations contain duplicate MusicBrainz artist ID ${foreignArtistId}`,
      );
    }
    seenForeignArtistIds.add(foreignArtistId);
    if (
      recommendation.addEligibility !== "exact-id" ||
      recommendation.status !== "approved" ||
      recommendation.reason !== "selected" ||
      recommendation.rawSimilarity !== recommendation.similarity
    ) {
      throw new LidarrPlanValidationError(
        `selected recommendation rank ${selectedRank} has contradictory selection evidence`,
      );
    }
    const candidate = Object.freeze({ recommendation, selectedRank, foreignArtistId });
    const canonicalEntry = canonicalizeLidarrArtistAddPlanEntryInput(
      toPlanEntry(candidate, recommendation.name),
      `selected recommendations[${index}]`,
    );
    if (canonicalEntry.provenance.seedArtist !== seedArtist) {
      throw new LidarrPlanValidationError(
        `selected recommendation rank ${selectedRank} has a contradictory discovery seed`,
      );
    }
    return candidate;
  });
  const first = validated[0];
  if (first === undefined) {
    throw new LidarrPlanValidationError("selected recommendations must not be empty");
  }
  return Object.freeze([first, ...validated.slice(1)]);
}

function validateEvidenceString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RESOURCE_REFERENCE_LENGTH ||
    TERMINAL_CONTROL_PATTERN.test(value)
  ) {
    throw new LidarrPlanValidationError(
      `${label} must be a non-empty bounded terminal-safe string`,
    );
  }
  return value;
}

function validateResourceReference(value: unknown, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (
    typeof value !== "string" ||
    trimmed.length === 0 ||
    value.length > MAX_RESOURCE_REFERENCE_LENGTH ||
    TERMINAL_CONTROL_PATTERN.test(value)
  ) {
    throw new LidarrPlanValidationError(
      `${label} must be non-empty, at most ${MAX_RESOURCE_REFERENCE_LENGTH} characters, and terminal-safe`,
    );
  }
  return trimmed;
}

function validatePlanPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PLAN_PATH_LENGTH ||
    TERMINAL_CONTROL_PATTERN.test(value)
  ) {
    throw new LidarrPlanValidationError(
      "plan file path must be non-empty, bounded, and free of terminal control characters",
    );
  }
  return value;
}

function resolveMonitored(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new LidarrPlanValidationError("artist monitored policy must be a boolean");
  }
  return value ?? false;
}

function canonicalizePostAddUnmonitorSelectors(
  value: readonly string[] | undefined,
): readonly LidarrAlbumTypeSelector[] {
  if (value === undefined || value.length === 0) return Object.freeze([]);
  if (!Array.isArray(value) || value.some((selector) => typeof selector !== "string")) {
    throw new LidarrPlanValidationError("post-add unmonitor selectors must be a string array");
  }
  try {
    return parseAlbumTypeSelectors(value.join(","));
  } catch (error: unknown) {
    throw new LidarrPlanValidationError(
      error instanceof Error ? error.message : "post-add unmonitor selectors are invalid",
    );
  }
}

function isAlbumsOnlyMetadataProfile(
  profile: ArtistAddSharedResourceRead["metadataProfiles"][number],
): boolean {
  const allowedPrimary = profile.primaryAlbumTypes.filter(({ allowed }) => allowed);
  return (
    allowedPrimary.length === 1 &&
    allowedPrimary[0]?.name === "Album" &&
    profile.secondaryAlbumTypes.every(({ allowed }) => !allowed)
  );
}

function resolveMetadataProfile(
  reference: string | undefined,
  rootFolder: ArtistAddSharedResourceRead["rootFolders"][number],
  profiles: ArtistAddSharedResourceRead["metadataProfiles"],
): ArtistAddSharedResourceRead["metadataProfiles"][number] {
  if (reference !== undefined) {
    const resolved = resolveLidarrProfileReference(reference, profiles);
    const profile = profiles.find(({ id }) => id === resolved.id);
    if (profile === undefined) {
      throw new Error("Artist-add metadata-profile resolution invariant violated");
    }
    return profile;
  }
  const candidates = profiles.filter(isAlbumsOnlyMetadataProfile);
  const rootDefault = candidates.find(({ id }) => id === rootFolder.defaultMetadataProfileId);
  if (rootDefault !== undefined) return rootDefault;
  const candidate = candidates[0];
  if (candidates.length !== 1 || candidate === undefined) {
    throw new LidarrPlanValidationError(
      candidates.length === 0
        ? "metadata profile is required because no structurally albums-only profile is available"
        : "metadata profile is required because multiple structurally albums-only profiles are available",
    );
  }
  return candidate;
}

function captureTaskFailure<T>(
  task: LidarrScheduledTask<T>,
  failures: Map<string, unknown>,
  onFailure: (error: unknown, attempt: number) => void,
): LidarrScheduledTask<T> {
  return {
    ...task,
    run: async (context) => {
      try {
        return await task.run(context);
      } catch (error: unknown) {
        failures.set(task.id, error);
        onFailure(error, context.attempt);
        throw error;
      }
    },
  };
}

function schedulerWillRetryPlanningTask(
  error: unknown,
  attempt: number,
  retryAttempts: number,
  retryBackoffCapMs: number,
): boolean {
  if (attempt > retryAttempts || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly statusCode?: unknown;
    readonly retryAfterSeconds?: unknown;
  };
  if (
    candidate.retryable !== true ||
    (candidate.statusCode !== undefined &&
      (typeof candidate.statusCode !== "number" ||
        !Number.isSafeInteger(candidate.statusCode) ||
        candidate.statusCode < 100 ||
        candidate.statusCode > 599)) ||
    (candidate.retryAfterSeconds !== undefined &&
      (typeof candidate.retryAfterSeconds !== "number" ||
        !Number.isSafeInteger(candidate.retryAfterSeconds) ||
        candidate.retryAfterSeconds < 0))
  ) {
    return false;
  }
  if (candidate.code === "lidarr-unreachable" || candidate.code === "timeout") return true;
  return (
    candidate.code === "rate-limited" &&
    (candidate.retryAfterSeconds === undefined ||
      candidate.retryAfterSeconds * 1_000 <= retryBackoffCapMs)
  );
}

function toPlanEntry(
  candidate: ValidatedRecommendation,
  artistName: string,
): BuildLidarrArtistAddPlanEntryV2Input {
  const { recommendation } = candidate;
  return Object.freeze({
    artistName,
    foreignArtistId: candidate.foreignArtistId,
    provenance: Object.freeze({
      source: "lastfm",
      method: "artist.getSimilar",
      seedArtist: recommendation.provenance.seedArtist,
      similarity: recommendation.similarity,
      candidateUrl: recommendation.sourceUrl,
      discoveredAt: recommendation.provenance.discoveredAt,
      selectedRank: candidate.selectedRank,
      parentArtist: recommendation.provenance.parentArtist,
      depth: recommendation.provenance.depth,
      providerRank: recommendation.provenance.providerRank,
      firstSeenSequence: recommendation.provenance.firstSeenSequence,
      firstPath: recommendation.provenance.firstPath,
      adjustedScore: recommendation.adjustedScore,
      exposureCount: recommendation.exposureCount,
      ...(recommendation.popularityEvidence === undefined
        ? {}
        : { popularityEvidence: recommendation.popularityEvidence }),
    }),
  });
}

/**
 * Reads exact fresh Lidarr identity/resources and writes at most one add plan.
 *
 * @param options - Ordered approved recommendations, provenance, shared resources,
 *   artifact path, and optional Lidarr connection overrides.
 * @returns One aggregate sealed plan or an all-already-present no-op.
 * @throws {LidarrPlanValidationError} Before Lidarr I/O when any rank or MBID is
 *   invalid, or before writing when any exact Lidarr identity is not unambiguous.
 */
export async function executeLidarrArtistAddPlan(
  options: LidarrArtistAddPlanActionOptions,
): Promise<LidarrArtistAddPlanActionResult> {
  const selected = validateRecommendations(options);
  const rootFolderReference = validateResourceReference(
    options.rootFolder,
    "root folder reference",
  );
  const qualityProfileReference = validateResourceReference(
    options.qualityProfile,
    "quality profile reference",
  );
  const metadataProfileReference =
    options.metadataProfile === undefined
      ? undefined
      : validateResourceReference(options.metadataProfile, "metadata profile reference");
  const monitored = resolveMonitored(options.monitored);
  const postAddUnmonitorSelectors = canonicalizePostAddUnmonitorSelectors(
    options.postAddUnmonitorSelectors,
  );
  const output = validatePlanPath(options.output);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const context = resolveRequiredLidarrExecutionContext(overrides, {
    tier: TIER,
    retryAttemptsOverride: 0,
  });
  const scheduler = resolveLidarrScheduler();
  const lanePolicy = scheduler.policy[TIER];
  const failFastController = new AbortController();
  const planningSignal =
    options.signal === undefined
      ? failFastController.signal
      : AbortSignal.any([options.signal, failFastController.signal]);
  const failures = new Map<string, unknown>();
  let hasTerminalTaskFailure = false;
  let terminalTaskFailure: unknown;
  const captureFailure = (error: unknown, attempt: number): void => {
    if (
      options.signal?.aborted === true ||
      schedulerWillRetryPlanningTask(
        error,
        attempt,
        lanePolicy.retryAttempts,
        lanePolicy.retryBackoffCapMs,
      )
    ) {
      return;
    }
    if (!hasTerminalTaskFailure) {
      hasTerminalTaskFailure = true;
      terminalTaskFailure = error;
    }
    failFastController.abort(error);
  };
  const sharedResourceTaskId = "lidarr-plan-artist-add:shared-resources";
  const tasks: LidarrScheduledTask<ArtistAddPlanRead>[] = [
    captureTaskFailure(
      {
        id: sharedResourceTaskId,
        operation: "lidarr plan artist-add shared resources",
        idempotent: true,
        run: async ({ signal }) => {
          const rootFolders = await context.client.listRootFolders(signal);
          const qualityProfiles = await context.client.listQualityProfiles(signal);
          const metadataProfiles = await context.client.listMetadataProfileDetails(signal);
          return Object.freeze({
            kind: "shared-resources" as const,
            rootFolders,
            qualityProfiles,
            metadataProfiles,
          });
        },
      },
      failures,
      captureFailure,
    ),
    ...selected.map((candidate) => {
      const id = `lidarr-plan-artist-add:${candidate.foreignArtistId}`;
      return captureTaskFailure<ArtistAddPlanRead>(
        {
          id,
          operation: "lidarr plan artist-add candidate",
          idempotent: true,
          run: async ({ signal }) => {
            const lookup = await context.client.lookupArtists({
              mode: "artist",
              term: `lidarr:${candidate.foreignArtistId}`,
              signal,
            });
            const installed = await context.client.getArtistByForeignId(
              candidate.foreignArtistId,
              signal,
            );
            return Object.freeze({ kind: "candidate" as const, candidate, lookup, installed });
          },
        },
        failures,
        captureFailure,
      );
    }),
  ];
  let preflightFailure: unknown;
  const batch = await scheduler.runBatch(TIER, tasks, {
    signal: planningSignal,
    preflight: async (preflightContext) => {
      try {
        await context.preflight(preflightContext);
      } catch (error: unknown) {
        preflightFailure = error;
        throw error;
      }
    },
  });
  const terminal = batch.results.find((result) => result.outcome !== "succeeded");
  if (terminal !== undefined) {
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new DOMException("Artist-add planning aborted", "AbortError");
    }
    if (hasTerminalTaskFailure) throw terminalTaskFailure;
    const failure = failures.get(terminal.taskId) ?? preflightFailure;
    if (failure !== undefined) throw failure;
    throw new LidarrPlanValidationError(
      `artist-add planning task ${terminal.taskId} was not completed (${terminal.failureType})`,
    );
  }
  const reads = batch.results.map((result) => {
    if (result.outcome !== "succeeded") {
      throw new Error("Artist-add planning batch success invariant violated");
    }
    return result.value;
  });
  const sharedResources = reads[0];
  if (sharedResources?.kind !== "shared-resources") {
    throw new Error("Artist-add shared-resource read invariant violated");
  }
  const candidateReads = reads.slice(1).map((read) => {
    if (read.kind !== "candidate") {
      throw new Error("Artist-add candidate read invariant violated");
    }
    return read;
  });
  const rootFolder = resolveLidarrRootFolderReference(
    rootFolderReference,
    sharedResources.rootFolders,
  );
  const rootFolderEvidence =
    sharedResources.rootFolders.find(({ id }) => id === rootFolder.id) ?? rootFolder;
  const qualityProfile = resolveLidarrProfileReference(
    qualityProfileReference,
    sharedResources.qualityProfiles,
  );
  const metadataProfile = resolveMetadataProfile(
    metadataProfileReference,
    rootFolderEvidence,
    sharedResources.metadataProfiles,
  );
  const planned: LidarrArtistAddPlannedEvidence[] = [];
  const alreadyPresent: LidarrArtistAddAlreadyPresentEvidence[] = [];
  const entries: BuildLidarrArtistAddPlanEntryV2Input[] = [];

  for (const read of candidateReads) {
    const exactLookup = read.lookup.filter(
      (candidate) =>
        candidate.kind === "artist" && candidate.foreignId === read.candidate.foreignArtistId,
    );
    const authoritative = exactLookup[0];
    if (exactLookup.length !== 1 || authoritative === undefined) {
      throw new LidarrPlanValidationError(
        `Lidarr exact artist lookup for ${read.candidate.foreignArtistId} was missing or ambiguous`,
      );
    }
    if (read.installed !== undefined) {
      alreadyPresent.push(
        Object.freeze({
          selectedRank: read.candidate.selectedRank,
          foreignArtistId: read.candidate.foreignArtistId,
          lidarrId: read.installed.id,
        }),
      );
      continue;
    }
    planned.push(
      Object.freeze({
        selectedRank: read.candidate.selectedRank,
        foreignArtistId: read.candidate.foreignArtistId,
      }),
    );
    entries.push(toPlanEntry(read.candidate, read.candidate.recommendation.name));
  }

  if (entries.length === 0) {
    const first = alreadyPresent[0];
    if (first === undefined) {
      throw new LidarrPlanValidationError("artist-add selection produced no classified candidates");
    }
    return Object.freeze({
      status: "already-present" as const,
      planned: Object.freeze([]) as readonly [],
      alreadyPresent: Object.freeze(alreadyPresent),
      foreignArtistId: first.foreignArtistId,
      lidarrId: first.lidarrId,
    });
  }
  const firstEntry = entries[0];
  if (firstEntry === undefined) {
    throw new LidarrPlanValidationError("artist-add entries must not be empty");
  }
  const plan = buildLidarrArtistAddPlanV3({
    origin,
    operation: {
      kind: "artist-add",
      rootFolder: toRootFolderReference(rootFolder),
      qualityProfile: toProfileReference(qualityProfile),
      metadataProfile: toProfileReference(metadataProfile),
      monitored,
      monitorNewItems: "none",
      searchForMissingAlbums: false,
      postAddUnmonitorSelectors,
    },
    entries: Object.freeze([firstEntry, ...entries.slice(1)]),
    cascadePolicy,
  });
  options.signal?.throwIfAborted();
  const planPath = resolve(output);
  await writeLidarrPlanArtifact(planPath, plan);
  return Object.freeze({
    status: "plan-created",
    planPath,
    plan,
    planned: Object.freeze(planned),
    alreadyPresent: Object.freeze(alreadyPresent),
  });
}
