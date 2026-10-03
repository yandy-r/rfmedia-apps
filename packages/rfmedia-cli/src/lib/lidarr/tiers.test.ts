import { describe, expect, it, vi } from "vitest";

import { LIDARR_TIER_DESCRIPTORS, runHealthGate, type LidarrTier } from "./tiers.js";
import type { LidarrClientApi } from "./client.js";
import { LidarrUnreachableError } from "./errors.js";
import type { LidarrHealthCheck } from "../../types/lidarr.js";

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

/**
 * Build a minimal Lidarr client stub exposing only `getHealth`, which is the
 * sole method `runHealthGate` (via `runHealthProbe`) depends on.
 */
function createHealthClient(checks: readonly LidarrHealthCheck[]): {
  client: LidarrClientApi;
  getHealth: ReturnType<typeof vi.fn>;
} {
  const getHealth = vi.fn().mockResolvedValue(checks);
  const client = { getHealth } as unknown as LidarrClientApi;
  return { client, getHealth };
}

const okCheck: LidarrHealthCheck = {
  source: "IndexerStatusCheck",
  type: "ok",
  message: "All indexers are healthy",
};
const warningCheck: LidarrHealthCheck = {
  source: "UpdateCheck",
  type: "warning",
  message: "A new version is available",
};
const errorCheck: LidarrHealthCheck = {
  source: "DownloadClientCheck",
  type: "error",
  message: "Unable to communicate with the download client",
  wikiUrl: "https://wiki.servarr.com/lidarr",
};

describe("runHealthGate", () => {
  it("returns only the error-level checks", async () => {
    const { client } = createHealthClient([okCheck, warningCheck, errorCheck]);
    const result = await runHealthGate(client);
    expect(result).toEqual([errorCheck]);
  });

  it("returns an empty array when no check is at error severity", async () => {
    const { client } = createHealthClient([okCheck, warningCheck]);
    const result = await runHealthGate(client);
    expect(result).toEqual([]);
  });

  it("calls client.getHealth exactly once and forwards the abort signal", async () => {
    const { client, getHealth } = createHealthClient([errorCheck]);
    const signal = AbortSignal.abort();
    await runHealthGate(client, signal);
    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(getHealth).toHaveBeenCalledWith(signal);
  });

  it("propagates errors thrown by client.getHealth", async () => {
    const getHealth = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { getHealth } as unknown as LidarrClientApi;
    await expect(runHealthGate(client)).rejects.toThrow("boom");
  });

  it("throws LidarrUnreachableError when the delegated probe is transport-level unreachable", async () => {
    const getHealth = vi
      .fn()
      .mockRejectedValue(new LidarrUnreachableError("lidarr health", "connect ECONNREFUSED"));
    const client = { getHealth } as unknown as LidarrClientApi;
    await expect(runHealthGate(client)).rejects.toBeInstanceOf(LidarrUnreachableError);
  });
});
