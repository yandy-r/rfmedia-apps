/** Creates a sealed Lidarr artist-tag plan without mutating Lidarr. */

import { join, resolve } from "node:path";

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
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { getDefaultPlanDir } from "../../lib/plan.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  type LidarrArtistTagMutationMode,
  type LidarrMutationPlanV3,
  type LidarrPlanGenerationResultV3,
  type LidarrPlanSelectionV2,
  type LidarrPlanTagReference,
} from "../../types/lidarr-plan.js";
import type { LidarrProfile, LidarrTag } from "../../types/lidarr.js";

export const TIER: LidarrTier = "local-only";

type LidarrArtistTagMutationPlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-tag-mutation" } }
>;

/** Action-facing options for producing an artist tag-mutation plan. */
export interface LidarrArtistTagPlanActionOptions {
  readonly artistIds?: readonly number[];
  readonly all?: boolean;
  readonly selectMonitored?: boolean;
  readonly selectUnmonitored?: boolean;
  readonly selectQualityProfile?: string;
  readonly selectMetadataProfile?: string;
  readonly selectTags?: readonly string[];
  readonly addTags?: readonly string[];
  readonly removeTags?: readonly string[];
  readonly setTags?: readonly string[];
  readonly clearTags?: boolean;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

interface RequestedTagMode {
  readonly mode: LidarrArtistTagMutationMode;
  readonly references: readonly string[];
}

interface ResolvedSelection {
  readonly input: LidarrArtistSelectionInput;
  readonly plan: LidarrPlanSelectionV2;
}

function defaultOutputPath(planId: string, createdAt: string): string {
  const stamp = createdAt.replaceAll(":", "-").replace(".000Z", "Z");
  return join(getDefaultPlanDir(), `lidarr-${stamp}-${planId.slice(0, 8)}.json`);
}

function validationFailure(error: unknown): LidarrPlanValidationError {
  return error instanceof LidarrPlanValidationError
    ? error
    : new LidarrPlanValidationError(error instanceof Error ? error.message : "validation failed");
}

function requireArtistTagMutationPlanV3(plan: LidarrMutationPlanV3): LidarrArtistTagMutationPlanV3 {
  if (plan.operation.kind !== "artist-tag-mutation") {
    throw new LidarrPlanValidationError("expected an artist-tag-mutation v3 plan");
  }
  return plan as LidarrArtistTagMutationPlanV3;
}

function validate<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    throw validationFailure(error);
  }
}

function resolveRequestedMode(options: LidarrArtistTagPlanActionOptions): RequestedTagMode {
  const modes: RequestedTagMode[] = [
    ...(options.addTags === undefined
      ? []
      : [{ mode: "add" as const, references: options.addTags }]),
    ...(options.removeTags === undefined
      ? []
      : [{ mode: "remove" as const, references: options.removeTags }]),
    ...(options.setTags === undefined
      ? []
      : [{ mode: "set" as const, references: options.setTags }]),
    ...(options.clearTags === true ? [{ mode: "clear" as const, references: [] }] : []),
  ];
  if (modes.length !== 1) {
    throw new LidarrPlanValidationError(
      "exactly one tag mode is required: add, remove, set, or clear",
    );
  }
  const mode = modes[0];
  if (mode === undefined) {
    throw new LidarrPlanValidationError("exactly one tag mode is required");
  }
  if (mode.mode !== "clear" && mode.references.length === 0) {
    throw new LidarrPlanValidationError(`${mode.mode} tag mode requires at least one tag`);
  }
  return mode;
}

function resolveUniqueTags(
  references: readonly string[],
  tags: readonly LidarrTag[],
): readonly LidarrPlanTagReference[] {
  const byId = new Map<number, LidarrPlanTagReference>();
  for (const reference of references) {
    const resolved = resolveLidarrTagReference(reference, tags);
    byId.set(resolved.id, Object.freeze({ id: resolved.id, label: resolved.label }));
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.id - right.id));
}

function resolveOptionalProfile(
  reference: string | undefined,
  profiles: readonly LidarrProfile[],
): LidarrProfile | undefined {
  return reference === undefined ? undefined : resolveLidarrProfileReference(reference, profiles);
}

function resolveSelection(
  options: LidarrArtistTagPlanActionOptions,
  tags: readonly LidarrTag[],
  qualityProfiles: readonly LidarrProfile[],
  metadataProfiles: readonly LidarrProfile[],
): ResolvedSelection {
  const qualityProfile = resolveOptionalProfile(options.selectQualityProfile, qualityProfiles);
  const metadataProfile = resolveOptionalProfile(options.selectMetadataProfile, metadataProfiles);
  const selectedTags = resolveUniqueTags(options.selectTags ?? [], tags);
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
    return { input, plan: { kind: "all" } };
  }
  return {
    input,
    plan: {
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
    },
  };
}

function indexTags(tags: readonly LidarrTag[]): ReadonlyMap<number, LidarrPlanTagReference> {
  return new Map(
    tags.map((tag) => [tag.id, Object.freeze({ id: tag.id, label: tag.label })] as const),
  );
}

function buildTagSource(
  artist: {
    readonly id: number;
    readonly artistName: string;
    readonly tags: readonly number[];
  },
  tagById: ReadonlyMap<number, LidarrPlanTagReference>,
): LidarrPlanEntrySource {
  const missing = artist.tags.filter((tagId) => !tagById.has(tagId));
  if (missing.length > 0) {
    throw new LidarrPlanValidationError(
      `artist ${artist.id} references unknown Lidarr tag IDs: ${missing.join(", ")}`,
    );
  }
  return {
    kind: "artist-tag-mutation",
    artistId: artist.id,
    artistName: artist.artistName,
    tags: artist.tags.map((tagId) => {
      const tag = tagById.get(tagId);
      if (tag === undefined) {
        throw new LidarrPlanValidationError(`Lidarr tag ${tagId} was not found`);
      }
      return tag;
    }),
  };
}

/**
 * Reads a complete fresh artist/tag snapshot and writes a strict v3 tag plan.
 *
 * The action performs no Lidarr mutation. Add/remove/set resolve existing tags
 * exactly; clear is the only mode that authorizes an empty replacement set.
 *
 * @param options - Selection, tag intent, output, and connection overrides.
 * @returns The written plan path and sealed strict-v3 plan.
 */
export async function executeLidarrArtistTagPlan(
  options: LidarrArtistTagPlanActionOptions,
): Promise<LidarrPlanGenerationResultV3<LidarrArtistTagMutationPlanV3>> {
  const requestedMode = resolveRequestedMode(options);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-plan-artist-tags",
    operation: "lidarr plan artist tags",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      const [artists, tags, qualityProfiles, metadataProfiles] = await Promise.all([
        client.listArtists(),
        client.listTags(),
        options.selectQualityProfile === undefined
          ? Promise.resolve([])
          : client.listQualityProfiles(),
        options.selectMetadataProfile === undefined
          ? Promise.resolve([])
          : client.listMetadataProfiles(),
      ]);

      return validate(() => {
        const requestedTags = resolveUniqueTags(requestedMode.references, tags);
        const selection = resolveSelection(options, tags, qualityProfiles, metadataProfiles);
        const selectedArtists = selectLidarrArtists(artists, selection.input);
        const tagById = indexTags(tags);
        return requireArtistTagMutationPlanV3(
          buildLidarrMutationPlanV3({
            origin,
            selection: selection.plan,
            operation: {
              kind: "artist-tag-mutation",
              mode: requestedMode.mode,
              tags: requestedTags,
            },
            maxBatch: options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH,
            entries: selectedArtists.map((artist) => buildTagSource(artist, tagById)),
            cascadePolicy,
          }),
        );
      });
    },
  });

  const planPath = resolve(
    options.output ?? defaultOutputPath(scheduled.value.id, scheduled.value.createdAt),
  );
  await writeLidarrPlanArtifact(planPath, scheduled.value);
  return { planPath, plan: scheduled.value };
}
