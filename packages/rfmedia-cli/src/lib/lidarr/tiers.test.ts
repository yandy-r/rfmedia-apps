import { describe, expect, it } from "vitest";

import { LIDARR_TIER_DESCRIPTORS, type LidarrTier } from "./tiers.js";

describe("LIDARR_TIER_DESCRIPTORS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(LIDARR_TIER_DESCRIPTORS)).toBe(true);
  });

  it("marks local-only as always reliable and ungated", () => {
    expect(LIDARR_TIER_DESCRIPTORS["local-only"]).toEqual({
      tier: "local-only",
      metadataServerRequired: false,
      requiresHealthGate: false,
    });
  });

  it("requires the metadata server and a health gate for metadata-dependent ops", () => {
    expect(LIDARR_TIER_DESCRIPTORS["metadata-dependent"]).toEqual({
      tier: "metadata-dependent",
      metadataServerRequired: true,
      requiresHealthGate: true,
    });
  });

  it.each([
    ["local-only", false, false],
    ["metadata-dependent", true, true],
    ["discovery", false, false],
    ["destructive", false, false],
  ])(
    "keys %s to a self-consistent descriptor",
    (tier, metadataServerRequired, requiresHealthGate) => {
      const descriptor = LIDARR_TIER_DESCRIPTORS[tier as LidarrTier];
      expect(descriptor.tier).toBe(tier);
      expect(descriptor.metadataServerRequired).toBe(metadataServerRequired);
      expect(descriptor.requiresHealthGate).toBe(requiresHealthGate);
    },
  );
});
