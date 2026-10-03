import { describe, expect, it } from "vitest";

import {
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  type BridgeArtistIdentitySnapshot,
  type BridgeArtistResolutionOutcome,
  type BridgeTargetArtist,
} from "../../types/bridge.js";
import { resolveArtistIdentities } from "./mapping.js";
import { reconcilePlexLidarrSnapshot } from "./reconcile.js";

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c";
const MBID_C = "33333333-3333-4333-8333-333333333333";
const MBID_D = "44444444-4444-4444-8444-444444444444";

const targets: readonly BridgeTargetArtist[] = [
  { lidarrId: 1, title: "Exact", artistMbid: MBID_A },
  { lidarrId: 2, title: "Suggested", artistMbid: null },
  { lidarrId: 3, title: "Ambiguous One", artistMbid: MBID_B },
  { lidarrId: 4, title: "Lidarr only", artistMbid: MBID_C },
  { lidarrId: 5, title: "Duplicate One", artistMbid: MBID_D },
  { lidarrId: 6, title: "Duplicate Two", artistMbid: MBID_D },
];

const outcomes: readonly BridgeArtistResolutionOutcome[] = [
  {
    state: "resolved",
    plexId: "plex-1",
    title: "Exact",
    reason: "unique-exact-mbid",
    method: "exact-mbid",
    sourceMbid: MBID_A,
    target: { lidarrId: 1, title: "Exact", artistMbid: MBID_A },
    candidates: [],
  },
  {
    state: "suggested",
    plexId: "plex-2",
    title: "Suggested",
    reason: "unique-normalized-name",
    method: "normalized-name",
    target: {
      rank: 1,
      lidarrId: 2,
      title: "Suggested",
      normalizedTitle: "suggested",
      artistMbid: null,
      method: "normalized-name",
      score: 1,
    },
    runnerUpMargin: 1,
    candidates: [
      {
        rank: 1,
        lidarrId: 2,
        title: "Suggested",
        normalizedTitle: "suggested",
        artistMbid: null,
        method: "normalized-name",
        score: 1,
      },
    ],
  },
  {
    state: "ambiguous",
    plexId: "plex-3",
    title: "Ambiguous",
    reason: "insufficient-margin",
    method: "fuzzy-name",
    candidates: [
      {
        rank: 1,
        lidarrId: 3,
        title: "Ambiguous One",
        normalizedTitle: "ambiguous one",
        artistMbid: MBID_B,
        method: "fuzzy-name",
        score: 0.94,
      },
      {
        rank: 2,
        lidarrId: 4,
        title: "Lidarr only",
        normalizedTitle: "lidarr only",
        artistMbid: MBID_C,
        method: "fuzzy-name",
        score: 0.91,
      },
    ],
  },
  {
    state: "unmatched",
    plexId: "plex-4",
    title: "Plex only",
    reason: "no-candidate",
    method: "none",
    candidates: [],
  },
  {
    state: "conflict",
    plexId: "plex-5",
    title: "Duplicate Source",
    reason: "duplicate-source-mbid",
    method: "none",
    sourceMbid: MBID_B,
    candidates: [],
  },
  {
    state: "unavailable",
    plexId: "plex-6",
    title: "Unavailable",
    reason: "invalid-response",
    method: "none",
    candidates: [],
  },
];

function snapshot(
  sourceOutcomes: readonly BridgeArtistResolutionOutcome[] = outcomes,
  targetArtists: readonly BridgeTargetArtist[] = targets,
): BridgeArtistIdentitySnapshot {
  return {
    snapshotVersion: BRIDGE_IDENTITY_SNAPSHOT_VERSION,
    resolverVersion: BRIDGE_ARTIST_RESOLVER_VERSION,
    normalizationVersion: BRIDGE_ARTIST_NORMALIZATION_VERSION,
    scoringVersion: BRIDGE_ARTIST_SCORING_VERSION,
    scope: {
      plexOrigin: "https://plex.example.test",
      plexInstanceId: "machine-1",
      plexLibraryId: "7",
      lidarrOrigin: "https://lidarr.example.test",
      entityKind: "artist",
    },
    capturedAt: "2026-07-27T12:00:00.000Z",
    verifiedAt: "2026-07-27T12:00:00.000Z",
    provenance: { source: "live", mode: "online", freshness: "fresh" },
    completeness: {
      sourceComplete: true,
      targetComplete: true,
      resolutionsComplete: true,
      complete: true,
      sourceArtistCount: sourceOutcomes.length,
      targetArtistCount: targetArtists.length,
      resolutionCount: sourceOutcomes.length,
    },
    outcomes: sourceOutcomes,
    targetArtists,
  };
}

function isDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return (
    Object.isFrozen(value) && Object.values(value).every((child) => isDeeplyFrozen(child, seen))
  );
}

describe("reconcilePlexLidarrSnapshot", () => {
  it("projects the classification matrix with count parity and exact-only gap subtraction", () => {
    const result = reconcilePlexLidarrSnapshot(snapshot());

    expect(result.matchedExact.map((item) => item.source?.plexId)).toEqual(["plex-1"]);
    expect(result.reviewSuggested.map((item) => item.category)).toEqual(["review-normalized-name"]);
    expect(result.reviewAmbiguous.map((item) => item.source?.plexId)).toEqual(["plex-3"]);
    expect(result.conflicts.map((item) => item.source?.plexId)).toEqual(["plex-5"]);
    expect(result.unavailable.map((item) => item.source?.plexId)).toEqual(["plex-6"]);
    expect(result.plexOnly.map((item) => item.source?.plexId)).toEqual([
      "plex-2",
      "plex-3",
      "plex-4",
      "plex-5",
      "plex-6",
    ]);
    expect(result.lidarrOnly.map((item) => item.target?.lidarrId)).toEqual([2, 3, 4, 5, 6]);
    expect(result.summary).toMatchObject({
      sourceArtistCount: 6,
      targetArtistCount: 6,
      primaryOutcomeCount: 6,
      matchedExactCount: 1,
      reviewSuggestedCount: 1,
      reviewAmbiguousCount: 1,
      plexOnlyCount: 5,
      lidarrOnlyCount: 5,
      conflictCount: 1,
      unavailableCount: 1,
      duplicatesIncluded: false,
      duplicateFindingCount: 0,
    });
    expect(result.reviewSuggested[0]).toBe(result.plexOnly[0]);
    expect(result.lidarrOnly[0]).toMatchObject({
      category: "unmatched",
      reason: "no-authoritative-source-match",
      target: { lidarrId: 2 },
    });
  });

  it("adds bridge-owned duplicate findings without changing primary classifications", () => {
    const withoutDuplicates = reconcilePlexLidarrSnapshot(snapshot());
    const withDuplicates = reconcilePlexLidarrSnapshot(snapshot(), { includeDuplicates: true });

    expect(withDuplicates.duplicates.map((finding) => finding.code)).toEqual([
      "duplicate-source-mbid",
      "duplicate-target-mbid",
    ]);
    expect(withDuplicates.duplicates[1]?.members.map((member) => member.side)).toEqual([
      "lidarr",
      "lidarr",
    ]);
    expect(withDuplicates.matchedExact).toEqual(withoutDuplicates.matchedExact);
    expect(withDuplicates.plexOnly).toEqual(withoutDuplicates.plexOnly);
    expect(withDuplicates.lidarrOnly).toEqual(withoutDuplicates.lidarrOnly);
    expect(withDuplicates.suggestions.at(-1)).toEqual({
      code: "run-duplicate-audit",
      source: null,
      target: null,
      argv: ["rfmedia", "lidarr", "audit", "--check", "duplicate-identity"],
    });
    expect(
      withDuplicates.suggestions.some((suggestion) =>
        suggestion.argv.join(" ").includes("rfmedia lidarr apply"),
      ),
    ).toBe(false);
  });

  it("groups resolver-produced duplicate source MBIDs into one deterministic finding", () => {
    const identitySnapshot = resolveArtistIdentities({
      scope: {
        plexOrigin: "https://plex.example.test",
        plexInstanceId: "machine-1",
        plexLibraryId: "7",
        lidarrOrigin: "https://lidarr.example.test",
        entityKind: "artist",
      },
      sourceArtists: [
        {
          id: "plex-2",
          kind: "artist",
          title: "Second",
          externalIds: [{ namespace: "musicbrainz", kind: "artist", value: MBID_A.toUpperCase() }],
        },
        {
          id: "plex-1",
          kind: "artist",
          title: "First",
          externalIds: [{ namespace: "musicbrainz", kind: "artist", value: MBID_A }],
        },
      ],
      targetArtists: [],
      sourceComplete: true,
      targetComplete: true,
      capturedAt: "2026-07-27T12:00:00.000Z",
      verifiedAt: "2026-07-27T12:00:00.000Z",
    });

    const result = reconcilePlexLidarrSnapshot(identitySnapshot, { includeDuplicates: true });

    expect(result.conflicts.map((item) => item.source.artistMbid)).toEqual([MBID_A, MBID_A]);
    expect(result.duplicates).toContainEqual({
      code: "duplicate-source-mbid",
      artistMbid: MBID_A,
      normalizedTitle: null,
      members: [
        { side: "plex", plexId: "plex-1", title: "First", artistMbid: MBID_A },
        { side: "plex", plexId: "plex-2", title: "Second", artistMbid: MBID_A },
      ],
    });
  });

  it("groups contradictory sources against one normalized target index within a linear member bound", () => {
    const sourceCount = 201;
    const targetCount = 200;
    const contradictoryOutcomes = Array.from(
      { length: sourceCount },
      (_, index): BridgeArtistResolutionOutcome => ({
        state: "conflict",
        plexId: `plex-contradictory-${index}`,
        title: index % 2 === 0 ? "Björk & Co." : "BJORK AND CO",
        reason: "contradictory-mbid",
        method: "none",
        candidates: [],
      }),
    );
    const matchingTargets = Array.from(
      { length: targetCount },
      (_, index): BridgeTargetArtist => ({
        lidarrId: index + 1,
        title: index % 2 === 0 ? "bjork and co" : "Björk & Co.",
        artistMbid: null,
      }),
    );

    const result = reconcilePlexLidarrSnapshot(snapshot(contradictoryOutcomes, matchingTargets), {
      includeDuplicates: true,
    });
    const contradictory = result.duplicates.filter(
      (finding) => finding.code === "contradictory-name-mbid",
    );

    expect(contradictory).toHaveLength(1);
    expect(contradictory[0]).toMatchObject({ normalizedTitle: "bjork and co" });
    expect(contradictory[0]?.members).toHaveLength(sourceCount + targetCount);
  });

  it.each([
    { name: "both catalogs", sourceOutcomes: [], targetArtists: [] },
    {
      name: "Plex catalog",
      sourceOutcomes: [],
      targetArtists: [{ lidarrId: 1, title: "Lidarr only", artistMbid: MBID_A }],
    },
    {
      name: "Lidarr catalog",
      sourceOutcomes: [
        {
          state: "unmatched",
          plexId: "plex-1",
          title: "Plex only",
          reason: "no-candidate",
          method: "none",
          candidates: [],
        } satisfies BridgeArtistResolutionOutcome,
      ],
      targetArtists: [],
    },
  ])("accepts an empty $name side", ({ sourceOutcomes, targetArtists }) => {
    const result = reconcilePlexLidarrSnapshot(snapshot(sourceOutcomes, targetArtists));

    expect(result.summary.sourceArtistCount).toBe(sourceOutcomes.length);
    expect(result.summary.targetArtistCount).toBe(targetArtists.length);
    expect(result.summary.plexOnlyCount).toBe(sourceOutcomes.length);
    expect(result.summary.lidarrOnlyCount).toBe(targetArtists.length);
  });

  it("is permutation-stable, deeply frozen, and rejects inconsistent target reuse", () => {
    const forward = reconcilePlexLidarrSnapshot(snapshot(), { includeDuplicates: true });
    const reversed = reconcilePlexLidarrSnapshot(
      snapshot([...outcomes].reverse(), [...targets].reverse()),
      { includeDuplicates: true },
    );
    expect(reversed).toEqual(forward);
    expect(isDeeplyFrozen(forward)).toBe(true);

    const reused = [
      outcomes[0] as BridgeArtistResolutionOutcome,
      {
        ...(outcomes[0] as Extract<BridgeArtistResolutionOutcome, { state: "resolved" }>),
        plexId: "plex-reused",
      },
    ];
    expect(() => reconcilePlexLidarrSnapshot(snapshot(reused, [targets[0]!]))).toThrow(
      "inconsistent exact resolution evidence",
    );
  });

  it("fails closed on incomplete or count-inconsistent snapshots", () => {
    const incomplete = snapshot();
    const inconsistent = snapshot();

    expect(() =>
      reconcilePlexLidarrSnapshot({
        ...incomplete,
        completeness: { ...incomplete.completeness, complete: false },
      }),
    ).toThrow("complete bridge identity snapshot");
    expect(() =>
      reconcilePlexLidarrSnapshot({
        ...inconsistent,
        completeness: { ...inconsistent.completeness, targetArtistCount: 5 },
      }),
    ).toThrow("snapshot count mismatch");
  });
});
