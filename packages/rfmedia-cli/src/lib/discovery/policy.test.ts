import { describe, expect, it } from "vitest";

import type { LidarrDiscoverResolvedPolicy } from "../../types/discovery.js";
import {
  admitDiscoveryCandidates,
  approveDiscoveryRanks,
  computeDiscoveryAdjustedScore,
  createDiscoveryPolicyState,
  discoveryCandidateIdentity,
  LIDARR_DISCOVER_HARD_BOUNDS,
  rankDiscoveryCandidates,
  registerDiscoverySeed,
  registerDiscoverySeedAlias,
  resolveDiscoveryPolicy,
  type DiscoveryCandidateObservation,
  type DiscoveryPolicyState,
} from "./policy.js";

const MBID_A = "11111111-1111-4111-8111-111111111111";
const MBID_B = "22222222-2222-4222-8222-222222222222";
const MBID_C = "33333333-3333-4333-8333-333333333333";
const DISCOVERED_AT = "2026-07-26T00:00:00.000Z";

function observation(
  name: string,
  similarity: number,
  providerRank: number,
  musicBrainzId?: string,
  depth = 1,
): DiscoveryCandidateObservation {
  return {
    name,
    similarity,
    ...(musicBrainzId === undefined ? {} : { musicBrainzId }),
    sourceUrl: `https://www.last.fm/music/${encodeURIComponent(name)}`,
    seedArtist: "Seed",
    parentArtist: "Seed",
    depth,
    providerRank,
    firstPath: ["Seed", name],
    discoveredAt: DISCOVERED_AT,
  };
}

function admit(
  observations: readonly DiscoveryCandidateObservation[],
  policy: LidarrDiscoverResolvedPolicy = resolveDiscoveryPolicy(),
): DiscoveryPolicyState {
  return admitDiscoveryCandidates(
    createDiscoveryPolicyState({ name: "Seed" }),
    observations,
    policy,
  ).state;
}

describe("resolveDiscoveryPolicy", () => {
  it("freezes defaults and rejects every semantic boundary violation", () => {
    expect(resolveDiscoveryPolicy()).toEqual({
      minSimilarity: 0,
      maxPerSeed: 10,
      deep: false,
      cascade: true,
      maxDepth: 1,
      diversityBoost: 0,
      popularityDampening: 0,
      maxAdd: 1,
    });
    expect(Object.isFrozen(resolveDiscoveryPolicy())).toBe(true);
    expect(LIDARR_DISCOVER_HARD_BOUNDS).toMatchObject({
      providerLimit: 100,
      maxDepth: 2,
      maxRequests: 25,
      maxVisitedSeeds: 25,
      maxVisibleCandidates: 100,
      maxAdd: 25,
    });
    expect(Object.isFrozen(LIDARR_DISCOVER_HARD_BOUNDS)).toBe(true);
    expect(resolveDiscoveryPolicy({ deep: true }).maxDepth).toBe(2);

    for (const invalid of [
      { minSimilarity: Number.NaN },
      { minSimilarity: -0.01 },
      { minSimilarity: 1.01 },
      { maxPerSeed: 0 },
      { maxPerSeed: 101 },
      { diversityBoost: Number.POSITIVE_INFINITY },
      { popularityDampening: -1 },
      { maxAdd: 26 },
      { deep: true, cascade: false },
    ]) {
      expect(() => resolveDiscoveryPolicy(invalid)).toThrow(TypeError);
    }
  });
});

describe("discovery identity and admission", () => {
  it("uses canonical MBIDs first and full Unicode case-folded NFC names otherwise", () => {
    expect(
      discoveryCandidateIdentity({ name: "ignored", musicBrainzId: MBID_A.toUpperCase() }),
    ).toBe(`mbid\u0000${MBID_A}`);
    expect(discoveryCandidateIdentity({ name: "Beyonce\u0301" })).toBe(
      discoveryCandidateIdentity({ name: "BEYONCÉ" }),
    );
    expect(discoveryCandidateIdentity({ name: "Straße" })).toBe(
      discoveryCandidateIdentity({ name: "STRASSE" }),
    );
    expect(discoveryCandidateIdentity({ name: "ΟΣ" })).toBe(
      discoveryCandidateIdentity({ name: "ος" }),
    );
    expect(discoveryCandidateIdentity({ name: "ος" })).toBe(
      discoveryCandidateIdentity({ name: "οσ" }),
    );
  });

  it("pre-registers seeds and prevents cycles before scheduling", () => {
    const initial = createDiscoveryPolicyState({ name: "Seed" });
    const backEdge = registerDiscoverySeed(initial, { name: "sEeD" });

    expect(initial.seedIdentities).toHaveLength(1);
    expect(backEdge.state).toBe(initial);
    expect(backEdge).toMatchObject({ registered: false, reason: "back-edge" });
    expect(Object.isFrozen(initial.seedIdentities)).toBe(true);
    expect(Object.isFrozen(initial.seedNameAliases)).toBe(true);
    expect(initial.seedNameAliases.every(Object.isFrozen)).toBe(true);
  });

  it("tracks requested and resolved seed aliases without consuming another visited slot", () => {
    const initial = createDiscoveryPolicyState({ name: "Beatles" });
    const aliased = registerDiscoverySeedAlias(initial, 0, "The Beatles");
    const result = admitDiscoveryCandidates(
      aliased,
      [observation("THE BEATLES", 1, 1, MBID_A)],
      resolveDiscoveryPolicy(),
    );

    expect(aliased.seedIdentities).toHaveLength(1);
    expect(aliased.seedNameAliases).toHaveLength(2);
    expect(result.state.candidates).toHaveLength(0);
    expect(result.state.duplicatePaths).toBe(1);
    expect(result.decisions).toEqual([
      expect.objectContaining({ status: "visited", reason: "back-edge" }),
    ]);
  });

  it("promotes mixed name-only identity to MBID without merging distinct canonical MBIDs", () => {
    const policy = resolveDiscoveryPolicy();
    const firstAdmission = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      [observation("Same Name", 0.8, 1)],
      policy,
    );
    const registration = registerDiscoverySeed(firstAdmission.state, {
      name: "Same Name",
    });
    if (!registration.registered) throw new Error("Expected fallback seed registration");

    const promoted = admitDiscoveryCandidates(
      registration.state,
      [observation("same name", 0.9, 1, MBID_A)],
      policy,
    );
    const distinct = admitDiscoveryCandidates(
      promoted.state,
      [observation("SAME NAME", 0.7, 1, MBID_B), observation("Same Name", 0.6, 2)],
      policy,
    );

    expect(promoted.state.seedIdentities).toContain(`mbid\u0000${MBID_A}`);
    expect(promoted.state.seedIdentities).not.toContain(
      discoveryCandidateIdentity({ name: "Same Name" }),
    );
    expect(firstAdmission.decisions[0]).toMatchObject({
      status: "quarantined",
      reason: "identity-required",
    });
    expect(promoted.decisions[0]).toMatchObject({
      status: "visited",
      reason: "duplicate-identity",
      identity: `mbid\u0000${MBID_A}`,
    });
    expect(distinct.state.seedIdentities).toHaveLength(2);
    expect(distinct.state.candidates).toHaveLength(2);
    expect(distinct.state.candidates.map(({ musicBrainzId }) => musicBrainzId)).toEqual([
      MBID_A,
      MBID_B,
    ]);
    expect(distinct.state.candidates.map(({ exposureCount }) => exposureCount)).toEqual([2, 1]);
    expect(distinct.state.duplicatePaths).toBe(2);
    expect(distinct.decisions.map(({ status }) => status)).toEqual(["quarantined", "visited"]);

    const reverseOrder = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      [observation("Reverse", 0.8, 1, MBID_C), observation("reverse", 0.7, 2)],
      policy,
    );
    expect(reverseOrder.state.candidates).toHaveLength(1);
    expect(reverseOrder.state.candidates[0]).toMatchObject({
      musicBrainzId: MBID_C,
      exposureCount: 2,
    });
  });

  it("applies the raw threshold before the per-seed cap", () => {
    const result = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      [
        observation("Below", 0.49, 1, MBID_A),
        observation("Accepted", 0.5, 2, MBID_B),
        observation("Capped", 0.9, 3, MBID_C),
      ],
      resolveDiscoveryPolicy({ minSimilarity: 0.5, maxPerSeed: 1 }),
    );

    expect(result.decisions.map(({ reason }) => reason)).toEqual([
      "below-threshold",
      "not-selected",
      "per-seed-cap",
    ]);
    expect(result.state.candidates.map(({ name }) => name)).toEqual(["Accepted"]);
  });

  it("exposes duplicate paths without creating another row or overwriting raw similarity", () => {
    const result = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      [observation("First", 0.8, 1, MBID_A), observation("Alias", 0.99, 2, MBID_A)],
      resolveDiscoveryPolicy(),
    );

    expect(result.state.candidates).toHaveLength(1);
    expect(result.state.candidates[0]).toMatchObject({
      name: "First",
      similarity: 0.8,
      exposureCount: 2,
    });
    expect(result.state.duplicatePaths).toBe(1);
    expect(result.decisions[1]).toMatchObject({
      status: "visited",
      reason: "duplicate-identity",
      exposureCount: 2,
    });
    expect(
      rankDiscoveryCandidates(
        result.state,
        resolveDiscoveryPolicy({ diversityBoost: 0.5, popularityDampening: 0.25 }),
      )[0],
    ).toMatchObject({
      similarity: 0.8,
      rawSimilarity: 0.8,
      adjustedScore: 0.8 + 0.5 * (1 / 2) * (1 - 0.8) - 0.25 * ((2 - 1) / 2) * 0.8,
      popularityEvidence: "graph-exposure",
    });
  });

  it("retains exact-MBID provider aliases for later name-only observations", () => {
    const result = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      [
        observation("Official Name", 0.9, 1, MBID_A),
        observation("Alias Name", 0.8, 2, MBID_A),
        observation("Alias Name", 0.7, 3),
      ],
      resolveDiscoveryPolicy(),
    );

    expect(result.state.candidates).toHaveLength(1);
    expect(result.state.candidates[0]).toMatchObject({
      name: "Official Name",
      musicBrainzId: MBID_A,
      normalizedNameAliases: ["official name", "alias name"],
      exposureCount: 3,
    });
    expect(Object.isFrozen(result.state.candidates[0]?.normalizedNameAliases)).toBe(true);
    expect(result.state.duplicatePaths).toBe(2);
    expect(result.decisions.map(({ status }) => status)).toEqual([
      "quarantined",
      "visited",
      "visited",
    ]);
  });

  it("retains every bounded duplicate observation as exposure evidence", () => {
    const result = admitDiscoveryCandidates(
      createDiscoveryPolicyState({ name: "Seed" }),
      Array.from({ length: 26 }, (_, index) =>
        observation(`Alias ${index + 1}`, 0.9, index + 1, MBID_A),
      ),
      resolveDiscoveryPolicy(),
    );

    expect(result.state.candidates).toHaveLength(1);
    expect(result.state.candidates[0]?.exposureCount).toBe(26);
    expect(result.state.duplicatePaths).toBe(25);
  });
});

describe("ranking and quarantine", () => {
  it("uses the exact disclosed formula and clamps validated results", () => {
    expect(computeDiscoveryAdjustedScore(0.6, 2, 0.5, 0.25)).toBe(
      0.6 + 0.5 * (1 / 2) * (1 - 0.6) - 0.25 * ((2 - 1) / 2) * 0.6,
    );
    expect(computeDiscoveryAdjustedScore(1, 1, 1, 0)).toBe(1);
    expect(computeDiscoveryAdjustedScore(0, 1, 0, 1)).toBe(0);
  });

  it("orders ties deterministically and quarantines MBID-less candidates", () => {
    const policy = resolveDiscoveryPolicy({ deep: true });
    const state = admit(
      [
        observation("Later", 0.7, 1, MBID_A, 2),
        observation("Earlier", 0.7, 2, MBID_B, 1),
        observation("No Id", 0.6, 3),
      ],
      policy,
    );
    const ranked = rankDiscoveryCandidates(state, policy);

    expect(ranked.map(({ name }) => name)).toEqual(["Earlier", "Later", "No Id"]);
    expect(ranked[2]).toMatchObject({
      addEligibility: "requires-resolution",
      status: "quarantined",
      reason: "identity-required",
      similarity: 0.6,
      rawSimilarity: 0.6,
    });
    expect(Object.isFrozen(ranked)).toBe(true);
  });
});

describe("approveDiscoveryRanks", () => {
  it("validates the whole selection before returning approved rows in visible-rank order", () => {
    const ranked = rankDiscoveryCandidates(
      admit([
        observation("A", 0.9, 1, MBID_A),
        observation("B", 0.8, 2, MBID_B),
        observation("No Id", 0.7, 3),
      ]),
      resolveDiscoveryPolicy(),
    );
    const approved = approveDiscoveryRanks(ranked, [2, 1], 2);

    expect(approved.selectedRanks).toEqual([1, 2]);
    expect(approved.approved.map(({ rank, status, reason }) => ({ rank, status, reason }))).toEqual(
      [
        { rank: 1, status: "approved", reason: "selected" },
        { rank: 2, status: "approved", reason: "selected" },
      ],
    );
    expect(ranked.every(({ status }) => status === "quarantined")).toBe(true);

    const invalidSelections: readonly (readonly number[])[] = [[0], [1, 1], [1, 2, 3], [4], [3]];
    for (const selection of invalidSelections) {
      expect(() => approveDiscoveryRanks(ranked, selection, 2)).toThrow(TypeError);
      expect(ranked.every(({ status }) => status === "quarantined")).toBe(true);
    }
  });
});
