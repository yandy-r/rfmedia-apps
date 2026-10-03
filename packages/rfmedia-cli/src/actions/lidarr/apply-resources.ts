/** Focused resource collection and catalog preflight for Lidarr plan apply. */

import { resolveLidarrScheduler } from "../../lib/lidarr/index.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type {
  LidarrArtistAddReferencedResource,
  LidarrPlanReferencedResource,
} from "../../lib/lidarr/plan-operation-definitions.js";
import type {
  LidarrArtistAddPlanV2,
  LidarrArtistAddPlanV3,
  LidarrMutationPlan,
  LidarrMutationPlanV3,
} from "../../types/lidarr-plan.js";
import type { LidarrProfile, LidarrRootFolder, LidarrTag } from "../../types/lidarr.js";

const TIER = "local-only";
type LidarrResourcePlan =
  | LidarrMutationPlan
  | LidarrMutationPlanV3
  | LidarrArtistAddPlanV2
  | LidarrArtistAddPlanV3;

/** Live resource catalogs and non-blocking rename warnings used during apply. */
export interface LidarrApplyResourceContext {
  readonly rootFolders: ReadonlyMap<number, LidarrRootFolder>;
  readonly qualityProfiles: ReadonlyMap<number, LidarrProfile>;
  readonly metadataProfiles: ReadonlyMap<number, LidarrProfile>;
  readonly tags: ReadonlyMap<number, LidarrTag>;
  readonly warnings: readonly string[];
}

/** Resource-preflight result before artist admission is evaluated. */
export interface LidarrApplyResourcePreflight {
  readonly resources: LidarrApplyResourceContext;
  readonly missing: readonly LidarrArtistAddReferencedResource[];
  readonly drifted: readonly {
    readonly reference: LidarrArtistAddReferencedResource;
    readonly message: string;
  }[];
}

function selectionReferences(plan: LidarrResourcePlan): readonly LidarrPlanReferencedResource[] {
  if (plan.operation.kind === "artist-add") return [];
  if (!("selection" in plan) || plan.selection.kind !== "filters") return [];
  return Object.freeze([
    ...(plan.selection.qualityProfile === undefined
      ? []
      : [
          {
            kind: "quality-profile" as const,
            ...plan.selection.qualityProfile,
          },
        ]),
    ...(plan.selection.metadataProfile === undefined
      ? []
      : [
          {
            kind: "metadata-profile" as const,
            ...plan.selection.metadataProfile,
          },
        ]),
    ...(plan.selection.tags ?? []).map((tag) => ({
      kind: "tag" as const,
      ...tag,
    })),
  ]);
}

/**
 * Collects the deduplicated resource references sealed into an apply plan.
 *
 * @param plan - Validated immutable mutation plan.
 * @param operationReferences - Resources referenced by the mutation operation.
 * @returns Operation and filter-selection references, deduplicated by kind and ID.
 */
export function collectLidarrApplyResourceReferences(
  plan: LidarrResourcePlan,
  operationReferences: readonly LidarrArtistAddReferencedResource[],
): readonly LidarrArtistAddReferencedResource[] {
  const seen = new Set<string>();
  return Object.freeze(
    [...operationReferences, ...selectionReferences(plan)].filter((reference) => {
      const key = `${reference.kind}:${reference.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

async function runResourceRead<T>(
  id: string,
  operation: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await resolveLidarrScheduler().runSingle(
    TIER,
    { id, operation, idempotent: true, run },
    { signal },
  );
  return result.value;
}

/**
 * Loads every catalog needed by apply references and reconciles stable IDs.
 *
 * Missing resources block the caller's complete preflight. Renames remain
 * non-blocking warnings because execution binds resources by stable ID.
 *
 * @param input - Plan identity, references, client, and optional cancellation.
 * @returns Live catalogs, missing references, and rename warnings.
 */
export async function preflightLidarrApplyResources(input: {
  readonly planId: string;
  readonly references: readonly LidarrArtistAddReferencedResource[];
  readonly client: LidarrClientApi;
  readonly signal?: AbortSignal;
}): Promise<LidarrApplyResourcePreflight> {
  const requiredKinds = new Set(input.references.map((reference) => reference.kind));
  const rootFolders = new Map<number, LidarrRootFolder>();
  const qualityProfiles = new Map<number, LidarrProfile>();
  const metadataProfiles = new Map<number, LidarrProfile>();
  const tags = new Map<number, LidarrTag>();

  if (requiredKinds.has("root-folder")) {
    const folders = await runResourceRead(
      `lidarr-apply-root-folders-${input.planId}`,
      "lidarr apply root-folder preflight",
      () => input.client.listRootFolders(input.signal),
      input.signal,
    );
    folders.forEach((folder) => rootFolders.set(folder.id, folder));
  }
  if (requiredKinds.has("quality-profile")) {
    const profiles = await runResourceRead(
      `lidarr-apply-quality-profiles-${input.planId}`,
      "lidarr apply quality-profile preflight",
      () => input.client.listQualityProfiles(input.signal),
      input.signal,
    );
    profiles.forEach((profile) => qualityProfiles.set(profile.id, profile));
  }
  if (requiredKinds.has("metadata-profile")) {
    const profiles = await runResourceRead(
      `lidarr-apply-metadata-profiles-${input.planId}`,
      "lidarr apply metadata-profile preflight",
      () => input.client.listMetadataProfiles(input.signal),
      input.signal,
    );
    profiles.forEach((profile) => metadataProfiles.set(profile.id, profile));
  }
  if (requiredKinds.has("tag")) {
    const liveTags = await runResourceRead(
      `lidarr-apply-tags-${input.planId}`,
      "lidarr apply tag preflight",
      () => input.client.listTags(input.signal),
      input.signal,
    );
    liveTags.forEach((tag) => tags.set(tag.id, tag));
  }

  const missing: LidarrArtistAddReferencedResource[] = [];
  const drifted: Array<{
    readonly reference: LidarrArtistAddReferencedResource;
    readonly message: string;
  }> = [];
  const warnings: string[] = [];
  for (const reference of input.references) {
    const live =
      reference.kind === "root-folder"
        ? rootFolders.get(reference.id)
        : reference.kind === "quality-profile"
          ? qualityProfiles.get(reference.id)
          : reference.kind === "metadata-profile"
            ? metadataProfiles.get(reference.id)
            : tags.get(reference.id);
    if (live === undefined) {
      missing.push(reference);
      continue;
    }
    if (reference.kind === "root-folder") {
      const rootFolder = live as LidarrRootFolder;
      if (rootFolder.path !== reference.path) {
        drifted.push({
          reference,
          message: `root-folder ${reference.id} path changed from ${reference.path} to ${rootFolder.path}`,
        });
      } else if (!rootFolder.accessible) {
        drifted.push({
          reference,
          message: `root-folder ${reference.id} (${reference.path}) is no longer accessible`,
        });
      }
      continue;
    }
    const plannedName = reference.kind === "tag" ? reference.label : reference.name;
    const liveName = "label" in live ? live.label : "name" in live ? live.name : undefined;
    if (liveName !== plannedName) {
      warnings.push(
        `${reference.kind} ${reference.id} was renamed from ${plannedName} to ${liveName}`,
      );
    }
  }

  return {
    resources: {
      rootFolders,
      qualityProfiles,
      metadataProfiles,
      tags,
      warnings: Object.freeze(warnings),
    },
    missing: Object.freeze(missing),
    drifted: Object.freeze(drifted),
  };
}
