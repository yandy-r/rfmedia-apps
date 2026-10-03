import { describe, expect, it } from "vitest";

import {
  BRIDGE_ARTIST_MAX_CANDIDATES,
  type BridgeArtistResolutionInput,
} from "../../types/bridge.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import type { MediaArtistIdentity } from "../../types/media-server.js";
import { calculateBridgeExpansionImpact, resolveArtistIdentities } from "./mapping.js";

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c";
const MBID_C = "33333333-3333-4333-8333-333333333333";

function artistMbid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function sourceArtist(
  id: string,
  title: string,
  artistMbids: readonly string[] = [],
): MediaArtistIdentity {
  return {
    id,
    kind: "artist",
    title,
    externalIds: artistMbids.map((value) => ({
      namespace: "musicbrainz",
      kind: "artist",
      value,
    })),
  };
}

function targetArtist(id: number, artistName: string, foreignArtistId = ""): LidarrArtist {
  return {
    id,
    artistName,
    foreignArtistId,
    monitored: false,
    qualityProfileId: 1,
    metadataProfileId: 1,
    tags: [],
  };
}

function resolutionInput(
  sourceArtists: readonly MediaArtistIdentity[],
  targetArtists: readonly LidarrArtist[],
  completeness: Pick<BridgeArtistResolutionInput, "sourceComplete" | "targetComplete"> = {
    sourceComplete: true,
    targetComplete: true,
  },
): BridgeArtistResolutionInput {
  return {
    scope: {
      plexOrigin: "https://plex.example.test",
      plexInstanceId: "machine-1",
      plexLibraryId: "7",
      lidarrOrigin: "https://lidarr.example.test",
      entityKind: "artist",
    },
    sourceArtists,
    targetArtists,
    ...completeness,
    capturedAt: "2026-07-27T12:00:00.000Z",
    verifiedAt: "2026-07-27T12:00:00.000Z",
  };
}

describe("resolveArtistIdentities", () => {
  it.each([
    {
      catalog: "source",
      completeness: { sourceComplete: false, targetComplete: true },
    },
    {
      catalog: "target",
      completeness: { sourceComplete: true, targetComplete: false },
    },
  ])("rejects a partial $catalog artist enumeration", ({ catalog, completeness }) => {
    expect(() =>
      resolveArtistIdentities(
        resolutionInput(
          [sourceArtist("plex-1", "Artist", [MBID_A])],
          [targetArtist(1, "Artist", MBID_A)],
          completeness,
        ),
      ),
    ).toThrow(`requires a complete ${catalog} artist enumeration`);
  });

  it("canonicalizes an artist MBID and gives a unique exact join absolute precedence", () => {
    const snapshot = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", "Completely Different", [MBID_A.toUpperCase()])],
        [targetArtist(2, "Completely Different", MBID_B), targetArtist(1, "Expected", MBID_A)],
      ),
    );

    expect(snapshot.outcomes).toEqual([
      expect.objectContaining({
        state: "resolved",
        method: "exact-mbid",
        sourceMbid: MBID_A,
        target: { lidarrId: 1, artistMbid: MBID_A, title: "Expected" },
      }),
    ]);
  });

  it.each([
    {
      name: "malformed source",
      sources: [sourceArtist("plex-1", "Artist", ["not-an-mbid"])],
      targets: [targetArtist(1, "Artist")],
      reason: "malformed-source-mbid",
    },
    {
      name: "duplicate source evidence",
      sources: [sourceArtist("plex-1", "Artist", [MBID_A, MBID_A.toUpperCase()])],
      targets: [targetArtist(1, "Artist", MBID_A)],
      reason: "duplicate-source-mbid",
    },
    {
      name: "conflicting source evidence",
      sources: [sourceArtist("plex-1", "Artist", [MBID_A, MBID_B])],
      targets: [targetArtist(1, "Artist", MBID_A)],
      reason: "conflicting-source-mbids",
    },
    {
      name: "malformed target",
      sources: [sourceArtist("plex-1", "Artist")],
      targets: [targetArtist(1, "Artist", "not-an-mbid")],
      reason: "malformed-target-mbid",
    },
    {
      name: "duplicate target MBID",
      sources: [sourceArtist("plex-1", "Artist", [MBID_A])],
      targets: [targetArtist(1, "One", MBID_A), targetArtist(2, "Two", MBID_A)],
      reason: "duplicate-target-mbid",
    },
    {
      name: "contradictory exact-name MBID",
      sources: [sourceArtist("plex-1", "Artist", [MBID_A])],
      targets: [targetArtist(1, "Artist", MBID_B)],
      reason: "contradictory-mbid",
    },
  ])("fails closed on $name without name fallback", ({ sources, targets, reason }) => {
    const outcome = resolveArtistIdentities(resolutionInput(sources, targets)).outcomes[0];

    expect(outcome).toMatchObject({
      state: "conflict",
      method: "none",
      reason,
      candidates: [],
    });
  });

  it.each([
    {
      name: "retains targets that are not outcome candidates",
      sources: [sourceArtist("plex-1", "Exact", [MBID_A])],
      targets: [targetArtist(2, "Not a candidate"), targetArtist(1, "Exact", MBID_A.toUpperCase())],
      expectedTargetArtists: [
        { lidarrId: 1, title: "Exact", artistMbid: MBID_A },
        { lidarrId: 2, title: "Not a candidate", artistMbid: null },
      ],
      error: null,
      frozen: false,
    },
    {
      name: "retains the complete target catalog when Plex is empty",
      sources: [],
      targets: [targetArtist(1, "Lidarr only", MBID_A)],
      expectedTargetArtists: [{ lidarrId: 1, title: "Lidarr only", artistMbid: MBID_A }],
      error: null,
      frozen: false,
    },
    {
      name: "rejects a non-positive target ID",
      sources: [],
      targets: [targetArtist(0, "Invalid")],
      expectedTargetArtists: [],
      error: "positive safe integer",
      frozen: false,
    },
    {
      name: "rejects a fractional target ID",
      sources: [],
      targets: [targetArtist(1.5, "Invalid")],
      expectedTargetArtists: [],
      error: "positive safe integer",
      frozen: false,
    },
    {
      name: "rejects an unsafe target ID",
      sources: [],
      targets: [targetArtist(Number.MAX_SAFE_INTEGER + 1, "Invalid")],
      expectedTargetArtists: [],
      error: "positive safe integer",
      frozen: false,
    },
    {
      name: "rejects duplicate target IDs",
      sources: [],
      targets: [targetArtist(1, "One"), targetArtist(1, "Duplicate")],
      expectedTargetArtists: [],
      error: "unique",
      frozen: false,
    },
    {
      name: "orders and deeply freezes the complete target catalog",
      sources: [],
      targets: [
        targetArtist(3, "Three", MBID_C),
        targetArtist(1, "One", MBID_A),
        targetArtist(2, "Two", MBID_B),
      ],
      expectedTargetArtists: [
        { lidarrId: 1, title: "One", artistMbid: MBID_A },
        { lidarrId: 2, title: "Two", artistMbid: MBID_B },
        { lidarrId: 3, title: "Three", artistMbid: MBID_C },
      ],
      error: null,
      frozen: true,
    },
  ])("$name", ({ sources, targets, expectedTargetArtists, error, frozen }) => {
    const resolve = () => resolveArtistIdentities(resolutionInput(sources, targets));
    if (error !== null) {
      expect(resolve).toThrow(error);
      return;
    }

    const snapshot = resolve();
    expect(snapshot.targetArtists).toEqual(expectedTargetArtists);
    expect(snapshot.targetArtists).toHaveLength(snapshot.completeness.targetArtistCount);
    if (frozen) {
      expect(Object.isFrozen(snapshot.targetArtists)).toBe(true);
      expect(snapshot.targetArtists.every(Object.isFrozen)).toBe(true);
    }
  });

  it("treats a source MBID shared by two Plex artists as non-unique", () => {
    const outcomes = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-2", "Two", [MBID_A]), sourceArtist("plex-1", "One", [MBID_A])],
        [targetArtist(1, "One", MBID_A)],
      ),
    ).outcomes;

    expect(outcomes.map((outcome) => [outcome.plexId, outcome.state, outcome.reason])).toEqual([
      ["plex-1", "conflict", "duplicate-source-mbid"],
      ["plex-2", "conflict", "duplicate-source-mbid"],
    ]);
  });

  it.each([
    ["case", "MASSIVE ATTACK", "massive attack"],
    ["Unicode and diacritics", "Björk", "BJORK"],
    ["punctuation", "Run-D.M.C.", "run d m c"],
    ["article and ampersand", "The Ting Tings & Friends", "ting tings and friends"],
  ])("keeps a normalized $case winner review-only", (_case, sourceName, targetName) => {
    const outcome = resolveArtistIdentities(
      resolutionInput([sourceArtist("plex-1", sourceName)], [targetArtist(1, targetName, MBID_A)]),
    ).outcomes[0];

    expect(outcome).toMatchObject({
      state: "suggested",
      reason: "unique-normalized-name",
      method: "normalized-name",
      target: { lidarrId: 1, score: 1 },
    });
  });

  it("keeps short names exact-only", () => {
    const fuzzy = resolveArtistIdentities(
      resolutionInput([sourceArtist("plex-1", "AB")], [targetArtist(1, "AC", MBID_A)]),
    ).outcomes[0];
    const exact = resolveArtistIdentities(
      resolutionInput([sourceArtist("plex-1", "AB")], [targetArtist(1, "ab", MBID_A)]),
    ).outcomes[0];

    expect(fuzzy).toMatchObject({ state: "unmatched", reason: "insufficient-score" });
    expect(exact).toMatchObject({ state: "suggested", reason: "unique-normalized-name" });
  });

  it("accepts the exact score floor and exact runner-up margin boundaries", () => {
    const scoreFloor = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", "abcdefghij")],
        [targetArtist(1, "abcdefghix", MBID_A)],
      ),
    ).outcomes[0];
    const sourceName = "abcdefghijklmnopqrstuvwxy";
    const margin = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", sourceName)],
        [
          targetArtist(1, sourceName, MBID_A),
          targetArtist(2, `${sourceName.slice(0, -2)}zz`, MBID_B),
        ],
      ),
    ).outcomes[0];

    expect(scoreFloor).toMatchObject({
      state: "suggested",
      method: "fuzzy-name",
      target: { score: 0.9 },
    });
    expect(margin).toMatchObject({ state: "suggested" });
    expect(margin?.state === "suggested" ? margin.runnerUpMargin : null).toBeCloseTo(0.08, 12);
  });

  it("returns ambiguity for normalized collisions and near-tied winners", () => {
    const collision = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", "Artist Name")],
        [targetArtist(2, "Artist-Name", MBID_B), targetArtist(1, "Artist Name", MBID_A)],
      ),
    ).outcomes[0];
    const sourceName = "abcdefghijklmnopqrstuvwxy";
    const nearTie = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", sourceName)],
        [
          targetArtist(1, sourceName, MBID_A),
          targetArtist(2, `${sourceName.slice(0, -1)}z`, MBID_B),
        ],
      ),
    ).outcomes[0];

    expect(collision).toMatchObject({
      state: "ambiguous",
      reason: "normalized-name-collision",
    });
    expect(nearTie).toMatchObject({ state: "ambiguous", reason: "insufficient-margin" });
  });

  it("caps candidates and rejects work beyond the comparison budget", () => {
    const capped = resolveArtistIdentities(
      resolutionInput(
        [sourceArtist("plex-1", "source")],
        Array.from({ length: 8 }, (_, index) => targetArtist(index + 1, `target ${index}`)),
      ),
    ).outcomes[0];

    expect(capped?.candidates).toHaveLength(BRIDGE_ARTIST_MAX_CANDIDATES);

    const sources = Array.from({ length: 101 }, (_, index) =>
      sourceArtist(`plex-${index}`, `source ${index}`),
    );
    const targets = Array.from({ length: 9_901 }, (_, index) =>
      targetArtist(index + 1, `target ${index}`),
    );
    expect(() => resolveArtistIdentities(resolutionInput(sources, targets))).toThrow(
      "comparison budget exceeded",
    );
  });

  it("rejects exact-MBID miss scans beyond the comparison budget", () => {
    const sources = Array.from({ length: 101 }, (_, index) =>
      sourceArtist(`plex-${index}`, `source ${index}`, [artistMbid(index)]),
    );
    const targets = Array.from({ length: 9_901 }, (_, index) =>
      targetArtist(index + 1, `target ${index}`, artistMbid(10_000 + index)),
    );

    expect(() => resolveArtistIdentities(resolutionInput(sources, targets))).toThrow(
      "comparison budget exceeded",
    );
  });

  it("is stable across input permutations and deeply freezes the snapshot", () => {
    const sources = [
      sourceArtist("plex-2", "The Example"),
      sourceArtist("plex-1", "Exact", [MBID_A]),
    ];
    const targets = [
      targetArtist(2, "example", MBID_B),
      targetArtist(1, "Exact", MBID_A),
      targetArtist(3, "Examplf", MBID_C),
    ];
    const forward = resolveArtistIdentities(resolutionInput(sources, targets));
    const reversed = resolveArtistIdentities(
      resolutionInput([...sources].reverse(), [...targets].reverse()),
    );

    expect(reversed).toEqual(forward);
    expect(Object.isFrozen(forward)).toBe(true);
    expect(Object.isFrozen(forward.scope)).toBe(true);
    expect(Object.isFrozen(forward.completeness)).toBe(true);
    expect(Object.isFrozen(forward.outcomes)).toBe(true);
    expect(forward.outcomes.every(Object.isFrozen)).toBe(true);
    expect(forward.outcomes.every((outcome) => Object.isFrozen(outcome.candidates))).toBe(true);
    expect(forward.outcomes.flatMap((outcome) => outcome.candidates).every(Object.isFrozen)).toBe(
      true,
    );
  });
});

describe("calculateBridgeExpansionImpact", () => {
  it("counts distinct identifiers and returns a finite complete ratio", () => {
    const impact = calculateBridgeExpansionImpact({
      sourceTrackIds: ["track-1", "track-1", "track-2"],
      targetAlbums: [
        { id: "album-1", trackCount: 10 },
        { id: "album-1", trackCount: 10 },
        { id: "album-2", trackCount: 6 },
      ],
    });

    expect(impact).toEqual({
      sourceTrackCount: 2,
      targetAlbumCount: 2,
      knownTargetTrackCount: 16,
      unknownTargetAlbumCount: 0,
      trackExpansionRatio: 8,
      complete: true,
      requiresConfirmation: true,
    });
    expect(Number.isFinite(impact.trackExpansionRatio)).toBe(true);
    expect(Object.isFrozen(impact)).toBe(true);
  });

  it("handles empty evidence without manufacturing a ratio or confirmation", () => {
    expect(calculateBridgeExpansionImpact({ sourceTrackIds: [], targetAlbums: [] })).toEqual({
      sourceTrackCount: 0,
      targetAlbumCount: 0,
      knownTargetTrackCount: 0,
      unknownTargetAlbumCount: 0,
      trackExpansionRatio: null,
      complete: true,
      requiresConfirmation: false,
    });
  });

  it("marks a non-empty target incomplete when there are no source tracks", () => {
    expect(
      calculateBridgeExpansionImpact({
        sourceTrackIds: [],
        targetAlbums: [{ id: "album-1", trackCount: 10 }],
      }),
    ).toEqual({
      sourceTrackCount: 0,
      targetAlbumCount: 1,
      knownTargetTrackCount: 10,
      unknownTargetAlbumCount: 0,
      trackExpansionRatio: null,
      complete: false,
      requiresConfirmation: true,
    });
  });

  it("deduplicates incomplete albums and keeps the ratio null", () => {
    expect(
      calculateBridgeExpansionImpact({
        sourceTrackIds: ["track-1"],
        targetAlbums: [
          { id: "unknown", trackCount: 12 },
          { id: "unknown", trackCount: null },
          { id: "known", trackCount: 4 },
        ],
      }),
    ).toEqual({
      sourceTrackCount: 1,
      targetAlbumCount: 2,
      knownTargetTrackCount: 4,
      unknownTargetAlbumCount: 1,
      trackExpansionRatio: null,
      complete: false,
      requiresConfirmation: true,
    });
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe track count %s",
    (trackCount) => {
      expect(() =>
        calculateBridgeExpansionImpact({
          sourceTrackIds: ["track-1"],
          targetAlbums: [{ id: "album-1", trackCount }],
        }),
      ).toThrow("non-negative safe integer");
    },
  );

  it("rejects unsafe sums and contradictory duplicate album counts", () => {
    expect(() =>
      calculateBridgeExpansionImpact({
        sourceTrackIds: ["track-1"],
        targetAlbums: [
          { id: "album-1", trackCount: Number.MAX_SAFE_INTEGER },
          { id: "album-2", trackCount: 1 },
        ],
      }),
    ).toThrow("arithmetic overflow");
    expect(() =>
      calculateBridgeExpansionImpact({
        sourceTrackIds: ["track-1"],
        targetAlbums: [
          { id: "album-1", trackCount: 10 },
          { id: "album-1", trackCount: 11 },
        ],
      }),
    ).toThrow("conflicting track counts");
  });
});
