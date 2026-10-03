/** Creates sealed or previewed file-aware Lidarr artist-delete plans. */

import { join, resolve } from "node:path";

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import {
  resolveLidarrProfileReference,
  resolveLidarrTagReference,
  selectLidarrArtists,
  type LidarrArtistSelectionInput,
} from "../../lib/lidarr/artist-selection.js";
import {
  buildLidarrMutationPlanV3,
  writeLidarrPlanArtifact,
  type LidarrPlanEntrySource,
} from "../../lib/lidarr/plan-engine.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { getDefaultPlanDir } from "../../lib/plan.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  type LidarrMutationPlanV3,
  type LidarrPlanGenerationResultV3,
  type LidarrPlanSelectionV2,
  type LidarrPlanTagReference,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist, LidarrProfile, LidarrTag } from "../../types/lidarr.js";

export const TIER: LidarrTier = "local-only";

/** Inputs accepted by the Commander-independent artist-delete planning action. */
export interface LidarrArtistDeletePlanActionOptions {
  readonly artistIds?: readonly number[];
  readonly all?: boolean;
  readonly selectMonitored?: boolean;
  readonly selectUnmonitored?: boolean;
  readonly selectQualityProfile?: string;
  readonly selectMetadataProfile?: string;
  readonly selectTags?: readonly string[];
  readonly deleteFiles?: boolean;
  readonly dryRun?: boolean;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

interface ResolvedSelection {
  readonly input: LidarrArtistSelectionInput;
  readonly plan: LidarrPlanSelectionV2;
}

type LidarrArtistDeletePlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-delete" } }
>;

function isArtistDeletePlanV3(plan: LidarrMutationPlanV3): plan is LidarrArtistDeletePlanV3 {
  return plan.operation.kind === "artist-delete";
}

function defaultOutputPath(planId: string, createdAt: string): string {
  const stamp = createdAt.replaceAll(":", "-").replace(".000Z", "Z");
  return join(getDefaultPlanDir(), `lidarr-${stamp}-${planId.slice(0, 8)}.json`);
}

function resolveOptionalProfile(
  reference: string | undefined,
  profiles: readonly LidarrProfile[],
): LidarrProfile | undefined {
  return reference === undefined ? undefined : resolveLidarrProfileReference(reference, profiles);
}

function resolveSelectionTags(
  references: readonly string[],
  tags: readonly LidarrTag[],
): readonly LidarrPlanTagReference[] {
  const byId = new Map<number, LidarrPlanTagReference>();
  for (const reference of references) {
    const tag = resolveLidarrTagReference(reference, tags);
    byId.set(tag.id, Object.freeze({ id: tag.id, label: tag.label }));
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.id - right.id));
}

function resolveSelection(
  options: LidarrArtistDeletePlanActionOptions,
  profiles: {
    readonly quality: readonly LidarrProfile[];
    readonly metadata: readonly LidarrProfile[];
  },
  tags: readonly LidarrTag[],
): ResolvedSelection {
  const qualityProfile = resolveOptionalProfile(options.selectQualityProfile, profiles.quality);
  const metadataProfile = resolveOptionalProfile(options.selectMetadataProfile, profiles.metadata);
  const selectedTags = resolveSelectionTags(options.selectTags ?? [], tags);
  const input: LidarrArtistSelectionInput = {
    ...(options.artistIds === undefined ? {} : { ids: options.artistIds }),
    ...(options.all === true ? { all: true } : {}),
    ...(options.selectMonitored === true ? { monitored: true } : {}),
    ...(options.selectUnmonitored === true ? { unmonitored: true } : {}),
    ...(qualityProfile === undefined ? {} : { qualityProfileId: qualityProfile.id }),
    ...(metadataProfile === undefined ? {} : { metadataProfileId: metadataProfile.id }),
    ...(selectedTags.length === 0 ? {} : { tagIds: selectedTags.map((tag) => tag.id) }),
    ...(options.maxBatch === undefined ? {} : { maxBatch: options.maxBatch }),
  };

  if (options.artistIds !== undefined) {
    return {
      input,
      plan: {
        kind: "ids",
        artistIds: Object.freeze([...options.artistIds].sort((left, right) => left - right)),
      },
    };
  }
  if (options.all === true) {
    return { input, plan: Object.freeze({ kind: "all" }) };
  }
  return {
    input,
    plan: Object.freeze({
      kind: "filters",
      ...(options.selectMonitored === true ? { monitored: true } : {}),
      ...(options.selectUnmonitored === true ? { monitored: false } : {}),
      ...(qualityProfile === undefined
        ? {}
        : { qualityProfile: { id: qualityProfile.id, name: qualityProfile.name } }),
      ...(metadataProfile === undefined
        ? {}
        : { metadataProfile: { id: metadataProfile.id, name: metadataProfile.name } }),
      ...(selectedTags.length === 0 ? {} : { tags: selectedTags }),
    }),
  };
}

function requireNonNegativeSafeInteger(value: number, artistId: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LidarrPlanValidationError(
      `artist ${artistId} ${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function buildDeleteSource(artist: LidarrArtist): LidarrPlanEntrySource {
  if (artist.path === undefined || artist.path.length === 0) {
    throw new LidarrPlanValidationError(`artist ${artist.id} path must be non-empty`);
  }
  if (artist.statistics === undefined) {
    throw new LidarrPlanValidationError(`artist ${artist.id} statistics are required`);
  }
  return Object.freeze({
    kind: "artist-delete",
    artistId: artist.id,
    artistName: artist.artistName,
    path: artist.path,
    albumCount: requireNonNegativeSafeInteger(
      artist.statistics.albumCount,
      artist.id,
      "albumCount",
    ),
    trackFileCount: requireNonNegativeSafeInteger(
      artist.statistics.trackFileCount,
      artist.id,
      "trackFileCount",
    ),
    sizeOnDisk: requireNonNegativeSafeInteger(
      artist.statistics.sizeOnDisk,
      artist.id,
      "sizeOnDisk",
    ),
  });
}

/**
 * Reads one complete fresh artist snapshot and builds a strict artist-delete plan.
 *
 * The action treats Lidarr paths and statistics only as sealed review evidence;
 * it performs no local filesystem inspection or deletion. Omitted
 * `deleteFiles` means keep-files. Dry-run returns the complete plan and its
 * prospective path without writing an artifact.
 *
 * @param options - Selection, file mode, dry-run, output, and connection overrides.
 * @returns The prospective or written artifact path and complete strict-v3 plan.
 * @throws {LidarrPlanValidationError} When selected deletion evidence is incomplete.
 * @throws {Error} When selection or referenced-resource resolution fails.
 */
export async function executeLidarrArtistDeletePlan(
  options: LidarrArtistDeletePlanActionOptions,
): Promise<LidarrPlanGenerationResultV3<LidarrArtistDeletePlanV3>> {
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-plan-artist-delete",
    operation: "lidarr plan artist-delete",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      const [artists, qualityProfiles, metadataProfiles, tags] = await Promise.all([
        client.listArtists(),
        options.selectQualityProfile === undefined
          ? Promise.resolve([])
          : client.listQualityProfiles(),
        options.selectMetadataProfile === undefined
          ? Promise.resolve([])
          : client.listMetadataProfiles(),
        (options.selectTags?.length ?? 0) === 0 ? Promise.resolve([]) : client.listTags(),
      ]);
      const selection = resolveSelection(
        options,
        { quality: qualityProfiles, metadata: metadataProfiles },
        tags,
      );
      const selectedArtists = selectLidarrArtists(artists, selection.input);
      return buildLidarrMutationPlanV3({
        origin,
        selection: selection.plan,
        operation: {
          kind: "artist-delete",
          deleteFiles: options.deleteFiles === true,
        },
        maxBatch: options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH,
        entries: selectedArtists.map(buildDeleteSource),
        cascadePolicy,
      });
    },
  });

  if (!isArtistDeletePlanV3(scheduled.value)) {
    throw new LidarrPlanValidationError("artist-delete builder returned an inconsistent operation");
  }
  const plan = scheduled.value;
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  if (options.dryRun !== true) {
    await writeLidarrPlanArtifact(planPath, plan);
  }
  return { planPath, plan };
}
