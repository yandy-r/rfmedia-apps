/** Creates sealed Lidarr artist-profile plans from fresh, complete local state. */

import { join, resolve } from "node:path";

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import {
  type LidarrArtistSelectionInput,
  resolveLidarrProfileReference,
  resolveLidarrTagReference,
  selectLidarrArtists,
} from "../../lib/lidarr/artist-selection.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import {
  buildLidarrMutationPlanV3,
  writeLidarrPlanArtifact,
} from "../../lib/lidarr/plan-engine.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { getDefaultPlanDir } from "../../lib/plan.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  type LidarrMutationPlanV3,
  type LidarrPlanGenerationResultV3,
  type LidarrPlanResourceReference,
  type LidarrPlanSelectionV2,
  type LidarrPlanTagReference,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist, LidarrProfile, LidarrTag } from "../../types/lidarr.js";

export const TIER: LidarrTier = "local-only";

type LidarrArtistProfilePlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-profile-assignment" } }
>;

/** Inputs accepted by the read-only artist-profile plan action. */
export interface LidarrArtistProfilePlanActionOptions {
  readonly artistIds?: readonly number[];
  readonly all?: boolean;
  readonly selectMonitored?: boolean;
  readonly selectUnmonitored?: boolean;
  readonly selectQualityProfile?: string;
  readonly selectMetadataProfile?: string;
  readonly selectTags?: readonly string[];
  readonly qualityProfile?: string;
  readonly metadataProfile?: string;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

interface ResolvedProfilePlanContext {
  readonly selectedArtists: readonly LidarrArtist[];
  readonly selection: LidarrPlanSelectionV2;
  readonly qualityProfile?: LidarrPlanResourceReference;
  readonly metadataProfile?: LidarrPlanResourceReference;
  readonly qualityProfiles: readonly LidarrProfile[];
  readonly metadataProfiles: readonly LidarrProfile[];
}

function defaultOutputPath(planId: string, createdAt: string): string {
  const stamp = createdAt.replaceAll(":", "-").replace(".000Z", "Z");
  return join(getDefaultPlanDir(), `lidarr-${stamp}-${planId.slice(0, 8)}.json`);
}

function toProfileReference(profile: LidarrProfile): LidarrPlanResourceReference {
  return Object.freeze({ id: profile.id, name: profile.name });
}

function toTagReference(tag: LidarrTag): LidarrPlanTagReference {
  return Object.freeze({ id: tag.id, label: tag.label });
}

function resolveOptionalProfile(
  reference: string | undefined,
  profiles: readonly LidarrProfile[],
): LidarrPlanResourceReference | undefined {
  return reference === undefined
    ? undefined
    : toProfileReference(resolveLidarrProfileReference(reference, profiles));
}

function resolveSelectionTags(
  references: readonly string[],
  tags: readonly LidarrTag[],
): readonly LidarrPlanTagReference[] {
  const byId = new Map(
    references.map((reference) => {
      const tag = resolveLidarrTagReference(reference, tags);
      return [tag.id, toTagReference(tag)] as const;
    }),
  );
  return Object.freeze([...byId.values()].sort((left, right) => left.id - right.id));
}

function requireArtistProfilePlanV3(plan: LidarrMutationPlanV3): LidarrArtistProfilePlanV3 {
  if (plan.operation.kind !== "artist-profile-assignment") {
    throw new LidarrPlanValidationError("expected an artist-profile-assignment v3 plan");
  }
  return plan as LidarrArtistProfilePlanV3;
}

function buildSelectionInput(
  options: LidarrArtistProfilePlanActionOptions,
  selectedQualityProfile: LidarrPlanResourceReference | undefined,
  selectedMetadataProfile: LidarrPlanResourceReference | undefined,
  selectedTags: readonly LidarrPlanTagReference[],
): LidarrArtistSelectionInput {
  return {
    ids: options.artistIds,
    all: options.all,
    monitored: options.selectMonitored,
    unmonitored: options.selectUnmonitored,
    qualityProfileId: selectedQualityProfile?.id,
    metadataProfileId: selectedMetadataProfile?.id,
    tagIds: selectedTags.map((tag) => tag.id),
    maxBatch: options.maxBatch,
  };
}

function buildSelection(
  options: LidarrArtistProfilePlanActionOptions,
  artists: readonly LidarrArtist[],
  selectedQualityProfile: LidarrPlanResourceReference | undefined,
  selectedMetadataProfile: LidarrPlanResourceReference | undefined,
  selectedTags: readonly LidarrPlanTagReference[],
): LidarrPlanSelectionV2 {
  if (options.artistIds !== undefined) {
    return Object.freeze({
      kind: "ids",
      artistIds: Object.freeze(artists.map((artist) => artist.id)),
    });
  }
  if (options.all === true) {
    return Object.freeze({ kind: "all" });
  }
  const monitored =
    options.selectMonitored === true
      ? true
      : options.selectUnmonitored === true
        ? false
        : undefined;
  return Object.freeze({
    kind: "filters",
    ...(monitored === undefined ? {} : { monitored }),
    ...(selectedQualityProfile === undefined ? {} : { qualityProfile: selectedQualityProfile }),
    ...(selectedMetadataProfile === undefined ? {} : { metadataProfile: selectedMetadataProfile }),
    ...(selectedTags.length === 0 ? {} : { tags: selectedTags }),
  });
}

async function resolveProfilePlanContext(
  options: LidarrArtistProfilePlanActionOptions,
  client: ReturnType<typeof resolveRequiredLidarrClient>,
): Promise<ResolvedProfilePlanContext> {
  const needsQualityProfiles =
    options.qualityProfile !== undefined || options.selectQualityProfile !== undefined;
  const needsMetadataProfiles =
    options.metadataProfile !== undefined || options.selectMetadataProfile !== undefined;
  const needsTags = (options.selectTags?.length ?? 0) > 0;
  const [artists, qualityProfiles, metadataProfiles, tags] = await Promise.all([
    client.listArtists(),
    needsQualityProfiles ? client.listQualityProfiles() : Promise.resolve([]),
    needsMetadataProfiles ? client.listMetadataProfiles() : Promise.resolve([]),
    needsTags ? client.listTags() : Promise.resolve([]),
  ]);

  const qualityProfile = resolveOptionalProfile(options.qualityProfile, qualityProfiles);
  const metadataProfile = resolveOptionalProfile(options.metadataProfile, metadataProfiles);
  const selectedQualityProfile = resolveOptionalProfile(
    options.selectQualityProfile,
    qualityProfiles,
  );
  const selectedMetadataProfile = resolveOptionalProfile(
    options.selectMetadataProfile,
    metadataProfiles,
  );
  const selectedTags = resolveSelectionTags(options.selectTags ?? [], tags);
  const selectedArtists = selectLidarrArtists(
    artists,
    buildSelectionInput(options, selectedQualityProfile, selectedMetadataProfile, selectedTags),
  );

  return Object.freeze({
    selectedArtists,
    selection: buildSelection(
      options,
      selectedArtists,
      selectedQualityProfile,
      selectedMetadataProfile,
      selectedTags,
    ),
    qualityProfile,
    metadataProfile,
    qualityProfiles,
    metadataProfiles,
  });
}

/**
 * Reads a complete fresh Lidarr snapshot and writes an immutable profile plan.
 *
 * @param options - Explicit artist selection, desired profiles, cap, output,
 *   and optional Lidarr connection overrides.
 * @returns The resolved artifact path and strict version 3 plan.
 * @throws {LidarrPlanValidationError} When no desired profile is supplied.
 * @throws {Error} When selection or resource resolution fails.
 */
export async function executeLidarrArtistProfilePlan(
  options: LidarrArtistProfilePlanActionOptions,
): Promise<LidarrPlanGenerationResultV3<LidarrArtistProfilePlanV3>> {
  if (options.qualityProfile === undefined && options.metadataProfile === undefined) {
    throw new LidarrPlanValidationError(
      "at least one desired quality or metadata profile is required",
    );
  }

  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-plan-artist-profiles",
    operation: "lidarr plan artist profiles",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      const context = await resolveProfilePlanContext(options, client);
      return requireArtistProfilePlanV3(
        buildLidarrMutationPlanV3({
          origin,
          selection: context.selection,
          operation: {
            kind: "artist-profile-assignment",
            ...(context.qualityProfile === undefined
              ? {}
              : { qualityProfile: context.qualityProfile }),
            ...(context.metadataProfile === undefined
              ? {}
              : { metadataProfile: context.metadataProfile }),
          },
          maxBatch: options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH,
          entries: context.selectedArtists.map((artist) => ({
            kind: "artist-profile-assignment",
            artistId: artist.id,
            artistName: artist.artistName,
            ...(context.qualityProfile === undefined
              ? {}
              : {
                  qualityProfile: toProfileReference(
                    resolveLidarrProfileReference(
                      String(artist.qualityProfileId),
                      context.qualityProfiles,
                    ),
                  ),
                }),
            ...(context.metadataProfile === undefined
              ? {}
              : {
                  metadataProfile: toProfileReference(
                    resolveLidarrProfileReference(
                      String(artist.metadataProfileId),
                      context.metadataProfiles,
                    ),
                  ),
                }),
          })),
          cascadePolicy,
        }),
      );
    },
  });

  const planPath = resolve(
    options.output ?? defaultOutputPath(scheduled.value.id, scheduled.value.createdAt),
  );
  await writeLidarrPlanArtifact(planPath, scheduled.value);
  return { planPath, plan: scheduled.value };
}
