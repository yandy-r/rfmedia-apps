/** Creates a sealed, reviewable Lidarr mutation plan without mutating Lidarr. */

import { join, resolve } from "node:path";

import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import {
  buildLidarrMutationPlanV3,
  writeLidarrPlanArtifact,
} from "../../lib/lidarr/plan-engine.js";
import { resolveLidarrCascadePolicy } from "../../lib/lidarr/cascade-analysis.js";
import { LidarrPlanValidationError } from "../../lib/errors.js";
import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { getDefaultPlanDir } from "../../lib/plan.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  type LidarrMutationPlanV3,
  type LidarrPlanGenerationResultV3,
} from "../../types/lidarr-plan.js";

export const TIER: LidarrTier = "local-only";

export interface LidarrPlanActionOptions {
  readonly artistIds: readonly number[];
  readonly monitored: boolean;
  readonly maxBatch?: number;
  readonly output?: string;
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
}

type LidarrArtistMonitoringPlanV3 = Extract<
  LidarrMutationPlanV3,
  { readonly operation: { readonly kind: "artist-monitoring" } }
>;

function isArtistMonitoringPlanV3(
  plan: LidarrMutationPlanV3,
): plan is LidarrArtistMonitoringPlanV3 {
  return plan.operation.kind === "artist-monitoring";
}

/** Default artifact path shared by every Lidarr plan kind (stamp format is contractual). */
export function defaultOutputPath(planId: string, createdAt: string): string {
  const stamp = createdAt.replaceAll(":", "-").replace(".000Z", "Z");
  return join(getDefaultPlanDir(), `lidarr-${stamp}-${planId.slice(0, 8)}.json`);
}

/** Reads exact artist IDs and writes an immutable desired-state plan. */
export async function executeLidarrPlan(
  options: LidarrPlanActionOptions,
): Promise<LidarrPlanGenerationResultV3<LidarrArtistMonitoringPlanV3>> {
  if (options.artistIds.length === 0) {
    throw new LidarrPlanValidationError("at least one artist ID is required");
  }
  if (new Set(options.artistIds).size !== options.artistIds.length) {
    throw new LidarrPlanValidationError("artist IDs must be unique");
  }
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);
  const cascadePolicy = resolveLidarrCascadePolicy(getLoadedLidarrConfig().cascadeAnalysis);
  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-plan-artist-monitoring",
    operation: "lidarr plan artist monitoring",
    idempotent: true,
    run: async () => {
      const client = resolveRequiredLidarrClient(overrides, {
        tier: TIER,
        retryAttemptsOverride: 0,
      });
      const requested = new Set(options.artistIds);
      const selectedArtistIds = [...requested].sort((left, right) => left - right);
      const artists = (await client.listArtists()).filter((artist) => requested.has(artist.id));
      const found = new Set(artists.map((artist) => artist.id));
      const missing = [...requested].filter((artistId) => !found.has(artistId));
      if (missing.length > 0) {
        throw new LidarrPlanValidationError(
          `Lidarr artist IDs were not found: ${missing.join(", ")}`,
        );
      }
      return buildLidarrMutationPlanV3({
        origin,
        selection: { kind: "ids", artistIds: selectedArtistIds },
        operation: { kind: "artist-monitoring", desiredMonitored: options.monitored },
        maxBatch: options.maxBatch ?? LIDARR_PLAN_DEFAULT_MAX_BATCH,
        entries: artists.map((artist) => ({
          kind: "artist-monitoring",
          artistId: artist.id,
          artistName: artist.artistName,
          monitored: artist.monitored,
        })),
        cascadePolicy,
      });
    },
  });
  if (!isArtistMonitoringPlanV3(scheduled.value)) {
    throw new LidarrPlanValidationError(
      "artist-monitoring builder returned an inconsistent operation",
    );
  }
  const plan = scheduled.value;
  const planPath = resolve(options.output ?? defaultOutputPath(plan.id, plan.createdAt));
  await writeLidarrPlanArtifact(planPath, plan);
  return { planPath, plan };
}
