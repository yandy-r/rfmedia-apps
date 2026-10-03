import { describe, expect, it } from "vitest";

import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationAmbiguousItem,
  ReconciliationAuthoritativeItem,
  ReconciliationConflictItem,
  ReconciliationNormalizedNameReviewItem,
  ReconciliationSourceUnmatchedItem,
  ReconciliationTargetUnmatchedItem,
  ReconciliationUnavailableItem,
} from "../../types/bridge.js";
import type {
  PolicyIdentityIndex,
  PolicyIdentityLink,
  PolicySignalBundle,
} from "../../types/lidarr-policy.js";
import type { MediaArtist, MediaTrack } from "../../types/media-server.js";
import { normalizeBridgeArtistName } from "./artist-name.js";
import {
  POLICY_NON_AUTHORITATIVE_DETAIL,
  buildPolicyEvaluationCoverage,
  buildTrackJoinSummary,
  indexArtistRatings,
  indexAuthoritativeIdentities,
  indexTrackPlays,
  lookupArtistLastViewedAt,
  lookupArtistPlays,
  toPolicyPlayIndex,
} from "./policy-signals.js";

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c";
const MBID_C = "33333333-3333-4333-8333-333333333333";

const SENTINEL_KEY = normalizeBridgeArtistName("Unknown Artist");

/* ── Reconciliation fixtures (the `reconcile.test.ts` literal style) ─────── */

function authoritative(
  plexId: string,
  lidarrId: number,
  title: string,
  artistMbid: string,
  plexTitle: string = title,
): ReconciliationAuthoritativeItem {
  return {
    category: "authoritative",
    reason: "unique-exact-mbid",
    method: "exact-mbid",
    source: { plexId, title: plexTitle, artistMbid },
    target: { lidarrId, title, artistMbid },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function normalizedNameReview(
  plexId: string,
  lidarrId: number,
  title: string,
): ReconciliationNormalizedNameReviewItem {
  return {
    category: "review-normalized-name",
    reason: "unique-normalized-name",
    method: "normalized-name",
    source: { plexId, title, artistMbid: null },
    target: { lidarrId, title, artistMbid: null },
    score: 1,
    runnerUpMargin: 1,
    candidates: [
      {
        rank: 1,
        target: { lidarrId, title, artistMbid: null },
        method: "normalized-name",
        score: 1,
      },
    ],
  };
}

function ambiguous(plexId: string, title: string): ReconciliationAmbiguousItem {
  return {
    category: "ambiguous",
    reason: "normalized-name-collision",
    method: "normalized-name",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function sourceUnmatched(
  plexId: string,
  title: string,
  reason: ReconciliationSourceUnmatchedItem["reason"],
): ReconciliationSourceUnmatchedItem {
  return {
    category: "unmatched",
    reason,
    method: "none",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function targetUnmatched(lidarrId: number, title: string): ReconciliationTargetUnmatchedItem {
  return {
    category: "unmatched",
    reason: "no-authoritative-source-match",
    method: "none",
    source: null,
    target: { lidarrId, title, artistMbid: MBID_C },
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function conflict(plexId: string, title: string): ReconciliationConflictItem {
  return {
    category: "conflict",
    reason: "duplicate-source-mbid",
    method: "none",
    source: { plexId, title, artistMbid: MBID_B },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function unavailable(plexId: string, title: string): ReconciliationUnavailableItem {
  return {
    category: "unavailable",
    reason: "invalid-response",
    method: "none",
    source: { plexId, title, artistMbid: null },
    target: null,
    score: null,
    runnerUpMargin: null,
    candidates: [],
  };
}

function report(
  overrides: Partial<
    Pick<
      PlexLidarrReconciliationResultV1,
      | "matchedExact"
      | "reviewSuggested"
      | "reviewAmbiguous"
      | "plexOnly"
      | "lidarrOnly"
      | "conflicts"
      | "unavailable"
    >
  >,
): PlexLidarrReconciliationResultV1 {
  const matchedExact = overrides.matchedExact ?? [];
  const reviewSuggested = overrides.reviewSuggested ?? [];
  const reviewAmbiguous = overrides.reviewAmbiguous ?? [];
  const plexOnly = overrides.plexOnly ?? [];
  const lidarrOnly = overrides.lidarrOnly ?? [];
  const conflicts = overrides.conflicts ?? [];
  const unavailableItems = overrides.unavailable ?? [];

  return {
    schema: "rfmedia.plex-lidarr-reconciliation.v1",
    scope: {
      plexOrigin: "https://plex.example.test",
      plexInstanceId: "machine-1",
      plexLibraryId: "7",
      lidarrOrigin: "https://lidarr.example.test",
      entityKind: "artist",
    },
    provenance: { source: "live", mode: "online", freshness: "fresh" },
    capturedAt: "2026-07-28T12:00:00.000Z",
    verifiedAt: "2026-07-28T12:00:00.000Z",
    completeness: {
      sourceComplete: true,
      targetComplete: true,
      resolutionsComplete: true,
      complete: true,
      sourceArtistCount: matchedExact.length + plexOnly.length,
      targetArtistCount: matchedExact.length + lidarrOnly.length,
      resolutionCount: matchedExact.length + plexOnly.length,
    },
    summary: {
      sourceArtistCount: matchedExact.length + plexOnly.length,
      targetArtistCount: matchedExact.length + lidarrOnly.length,
      primaryOutcomeCount: matchedExact.length + plexOnly.length,
      matchedExactCount: matchedExact.length,
      reviewSuggestedCount: reviewSuggested.length,
      reviewAmbiguousCount: reviewAmbiguous.length,
      plexOnlyCount: plexOnly.length,
      lidarrOnlyCount: lidarrOnly.length,
      conflictCount: conflicts.length,
      unavailableCount: unavailableItems.length,
      duplicatesIncluded: false,
      duplicateFindingCount: 0,
      suggestionCount: 0,
    },
    matchedExact,
    reviewSuggested,
    reviewAmbiguous,
    plexOnly,
    lidarrOnly,
    conflicts,
    unavailable: unavailableItems,
    duplicates: [],
    suggestions: [],
  };
}

/* ── Plex fixtures ───────────────────────────────────────────────────────── */

function artist(id: string, title: string, rating: number | null): MediaArtist {
  return { id, kind: "artist", title, rating, albumCount: 1 };
}

function track(
  id: string,
  artistName: string,
  album: string,
  playCount: number,
  lastViewedAt?: number,
): MediaTrack {
  return {
    id,
    kind: "track",
    title: `${album} track ${id}`,
    rating: null,
    artist: artistName,
    album,
    playCount,
    ...(lastViewedAt === undefined ? {} : { lastViewedAt }),
    durationMs: 180_000,
    filePath: `/music/${artistName}/${album}/${id}.flac`,
  };
}

function bundle(
  artists: readonly MediaArtist[],
  tracks: readonly MediaTrack[],
): PolicySignalBundle {
  return {
    bridgeIdentity: {
      status: "unavailable",
      reason: "not-requested",
      detail: "coverage reads the identity index, not this slot",
    },
    lidarrArtists: { status: "unavailable", reason: "not-requested", detail: "not gathered" },
    lidarrQualityProfiles: {
      status: "unavailable",
      reason: "not-requested",
      detail: "not gathered",
    },
    plexArtistRatings: { status: "available", data: artists },
    plexTrackPlays: { status: "available", data: tracks },
  };
}

/**
 * Obtains a branded link from the ONLY minter.
 *
 * No test may cast its way to a `PolicyIdentityLink`: routing every link through
 * `indexAuthoritativeIdentities` is what actually exercises the compile-time
 * safety property.
 */
function linkFor(index: PolicyIdentityIndex, lidarrId: number): PolicyIdentityLink {
  const link = index.byLidarrId.get(lidarrId);
  if (link === undefined) {
    throw new Error(`fixture error: no authoritative link for lidarr id ${lidarrId}`);
  }
  return link;
}

describe("indexAuthoritativeIdentities", () => {
  it("mints links only from matchedExact and refuses every other category exactly once", () => {
    const review = normalizedNameReview("plex-2", 22, "Review Grade");
    const ambiguousItem = ambiguous("plex-3", "Ambiguous Grade");
    const noCandidate = sourceUnmatched("plex-4", "Absent Artist", "no-candidate");
    const insufficientScore = sourceUnmatched("plex-7", "Weak Evidence", "insufficient-score");
    const conflictItem = conflict("plex-5", "Conflicting Artist");
    const unavailableItem = unavailable("plex-6", "Unavailable Artist");

    const index = indexAuthoritativeIdentities(
      report({
        matchedExact: [authoritative("plex-1", 11, "Exact One", MBID_A)],
        reviewSuggested: [review],
        reviewAmbiguous: [ambiguousItem],
        // `plexOnly` re-exports the same item objects the primary arrays hold.
        plexOnly: [
          review,
          ambiguousItem,
          noCandidate,
          insufficientScore,
          conflictItem,
          unavailableItem,
        ],
        lidarrOnly: [targetUnmatched(99, "Lidarr Only")],
        conflicts: [conflictItem],
        unavailable: [unavailableItem],
      }),
    );

    expect(index.links.map((link) => [link.plexId, link.lidarrId])).toEqual([["plex-1", 11]]);
    expect(index.byPlexId.get("plex-1")?.artistMbid).toBe(MBID_A);
    expect(index.byPlexId.get("plex-2")).toBeUndefined();
    expect(index.byLidarrId.get(22)).toBeUndefined();

    expect(
      index.nonAuthoritative.map((entry) => [
        entry.subject.plexId,
        entry.identity.category,
        entry.identity.reason,
      ]),
    ).toEqual([
      ["plex-2", "review-normalized-name", "unique-normalized-name"],
      ["plex-3", "ambiguous", "normalized-name-collision"],
      ["plex-4", "unmatched", "no-candidate"],
      ["plex-7", "unmatched", "insufficient-score"],
      ["plex-5", "conflict", "duplicate-source-mbid"],
      ["plex-6", "unavailable", "invalid-response"],
      ["", "unmatched", "no-authoritative-source-match"],
    ]);
    expect(
      index.nonAuthoritative.every((entry) => entry.detail === POLICY_NON_AUTHORITATIVE_DETAIL),
    ).toBe(true);
    expect(index.nonAuthoritative.at(-1)?.subject.artistId).toBe(99);

    // Seeds come from honest absence only, never from evidence that probably
    // already exists in Lidarr under a slightly different name.
    expect(index.seedCandidates.map((candidate) => candidate.source.plexId)).toEqual(["plex-4"]);
  });
});

describe("indexTrackPlays", () => {
  it("poisons BOTH artists when two Plex artists normalize to one name", () => {
    const index = indexAuthoritativeIdentities(
      report({
        matchedExact: [
          authoritative("plex-10", 1, "The Beatles", MBID_A),
          authoritative("plex-11", 2, "The Beatles!", MBID_B, "The Beatles!"),
        ],
      }),
    );
    const tracks = [
      track("t1", "The Beatles", "Revolver", 5),
      track("t2", "The Beatles!", "Revolver", 7),
    ];
    const plays = indexTrackPlays(tracks, index);

    expect(lookupArtistPlays(plays, linkFor(index, 1))).toEqual({
      status: "unavailable",
      reason: "ambiguous-name-join",
    });
    expect(lookupArtistPlays(plays, linkFor(index, 2))).toEqual({
      status: "unavailable",
      reason: "ambiguous-name-join",
    });
    expect(lookupArtistLastViewedAt(plays, linkFor(index, 1))).toEqual({
      status: "unavailable",
      reason: "ambiguous-name-join",
    });
    // A poisoned key never reaches the public bucket map either.
    expect(plays.byNormalizedName.has(normalizeBridgeArtistName("The Beatles"))).toBe(false);
    expect(
      buildPolicyEvaluationCoverage({ signals: bundle([], tracks), identity: index })
        .ambiguousNameArtists,
    ).toBe(2);
  });

  it("permanently poisons the Unknown Artist sentinel bucket and counts its tracks", () => {
    const index = indexAuthoritativeIdentities(
      report({
        matchedExact: [
          authoritative("plex-20", 3, "Real Artist", MBID_A),
          authoritative("plex-21", 4, "Unknown Artist", MBID_B),
        ],
      }),
    );
    const tracks = [
      track("t1", "Unknown Artist", "Orphans", 40),
      track("t2", "Real Artist", "Real Album", 2),
    ];
    const plays = indexTrackPlays(tracks, index);

    expect(plays.poisoned.has(SENTINEL_KEY)).toBe(true);
    expect(lookupArtistPlays(plays, linkFor(index, 4))).toEqual({
      status: "unavailable",
      reason: "sentinel-artist-name",
    });
    expect(lookupArtistLastViewedAt(plays, linkFor(index, 4))).toEqual({
      status: "unavailable",
      reason: "sentinel-artist-name",
    });
    // The orphaned rows are not credited to anyone.
    expect(plays.byNormalizedName.has(SENTINEL_KEY)).toBe(false);
    expect(lookupArtistPlays(plays, linkFor(index, 3))).toEqual({
      status: "observed",
      value: 2,
      join: "normalized-name",
      sampleSize: 1,
    });

    const coverage = buildPolicyEvaluationCoverage({
      signals: bundle([], tracks),
      identity: index,
    });
    expect(coverage.sentinelArtistTracks).toBe(1);
    expect(coverage.unjoinedTracks).toBe(0);

    // The poisoning is permanent, not a consequence of a track landing there.
    expect(indexTrackPlays([], index).poisoned.has(SENTINEL_KEY)).toBe(true);
  });

  it("counts a track that matches no bridge item instead of silently dropping it", () => {
    const index = indexAuthoritativeIdentities(
      report({ matchedExact: [authoritative("plex-30", 5, "Known Artist", MBID_A)] }),
    );
    const tracks = [
      track("t1", "Known Artist", "Known Album", 3),
      track("t2", "Nobody Here", "Stray Album", 11),
    ];
    const plays = indexTrackPlays(tracks, index);
    const coverage = buildPolicyEvaluationCoverage({
      signals: bundle([], tracks),
      identity: index,
    });

    expect(coverage.unjoinedTracks).toBe(1);
    expect(coverage.plexTracksExamined).toBe(2);
    // Never credited to the joined artist, and never lost from the library total.
    expect(lookupArtistPlays(plays, linkFor(index, 5))).toEqual({
      status: "observed",
      value: 3,
      join: "normalized-name",
      sampleSize: 1,
    });
    expect(coverage.totalPlaysObserved).toBe(14);
  });

  it("reports no-track-coverage for a link with no joined tracks", () => {
    const index = indexAuthoritativeIdentities(
      report({ matchedExact: [authoritative("plex-40", 6, "Silent Artist", MBID_A)] }),
    );

    expect(lookupArtistPlays(indexTrackPlays([], index), linkFor(index, 6))).toEqual({
      status: "unavailable",
      reason: "no-track-coverage",
    });
    expect(lookupArtistLastViewedAt(indexTrackPlays([], index), linkFor(index, 6))).toEqual({
      status: "unavailable",
      reason: "no-track-coverage",
    });
  });

  it("aggregates the newest view while tolerating zero-play timestamp omissions", () => {
    const index = indexAuthoritativeIdentities(
      report({ matchedExact: [authoritative("plex-41", 8, "Viewed Artist", MBID_A)] }),
    );
    const tracks = [
      track("t1", "Viewed Artist", "New Album", 4, 1_800_000_000),
      track("t2", "Viewed Artist", "Old Album", 2, 1_700_000_000),
      track("t3", "Viewed Artist", "Unplayed Album", 0),
    ];
    const plays = indexTrackPlays(tracks, index);

    expect(plays.byNormalizedName.get(normalizeBridgeArtistName("Viewed Artist"))).toEqual({
      plays: 6,
      sampleSize: 3,
      latestLastViewedAt: 1_800_000_000,
      lastViewedAtSampleSize: 2,
      playedRowsMissingLastViewedAt: 0,
    });
    expect(lookupArtistLastViewedAt(plays, linkFor(index, 8))).toEqual({
      status: "observed",
      value: 1_800_000_000,
      join: "normalized-name",
      sampleSize: 2,
    });
  });

  it("refuses partial recency when any played row omits its timestamp", () => {
    const index = indexAuthoritativeIdentities(
      report({ matchedExact: [authoritative("plex-42", 9, "Partial Artist", MBID_A)] }),
    );
    const plays = indexTrackPlays(
      [
        track("t1", "Partial Artist", "Observed Album", 2, 1_800_000_000),
        track("t2", "Partial Artist", "Missing Album", 1),
      ],
      index,
    );

    expect(lookupArtistLastViewedAt(plays, linkFor(index, 9))).toEqual({
      status: "unavailable",
      reason: "partial-recency-coverage",
    });
  });

  it("reports no recency coverage when every joined row omits the timestamp", () => {
    const index = indexAuthoritativeIdentities(
      report({ matchedExact: [authoritative("plex-43", 10, "Never Viewed", MBID_A)] }),
    );
    const plays = indexTrackPlays(
      [track("t1", "Never Viewed", "Album One", 2), track("t2", "Never Viewed", "Album Two", 1)],
      index,
    );

    expect(lookupArtistLastViewedAt(plays, linkFor(index, 10))).toEqual({
      status: "unavailable",
      reason: "no-recency-coverage",
    });
  });
});

describe("indexArtistRatings", () => {
  it("keeps unrated distinct from a zero rating and joins on plexId despite name collisions", () => {
    const unrated = artist("plex-50", "Colliding Name", null);
    const zeroRated = artist("plex-51", "Colliding Name", 0);
    const highlyRated = artist("plex-52", "Colliding Name", 1);
    const ratings = indexArtistRatings([unrated, zeroRated, highlyRated]);

    expect(ratings.byPlexId.get("plex-50")?.rating).toBeNull();
    expect(ratings.byPlexId.get("plex-51")?.rating).toBe(0);
    expect(ratings.byPlexId.get("plex-52")?.rating).toBe(1);
    expect(ratings.byPlexId.size).toBe(3);
  });
});

describe("buildPolicyEvaluationCoverage", () => {
  it("sums totalPlaysObserved across albums and reports the slot totals", () => {
    const index = indexAuthoritativeIdentities(
      report({
        matchedExact: [authoritative("plex-60", 7, "Prolific Artist", MBID_A)],
        lidarrOnly: [targetUnmatched(77, "Lidarr Only")],
      }),
    );
    const tracks = [
      track("t1", "Prolific Artist", "Album One", 4),
      track("t2", "Prolific Artist", "Album One", 6),
      track("t3", "Prolific Artist", "Album Two", 10),
    ];
    const artists = [artist("plex-60", "Prolific Artist", 0.8)];
    const coverage = buildPolicyEvaluationCoverage({
      signals: bundle(artists, tracks),
      identity: index,
    });

    expect(coverage).toEqual({
      plexArtistsExamined: 1,
      plexTracksExamined: 3,
      authoritativeLinks: 1,
      nonAuthoritativeArtists: 1,
      ambiguousNameArtists: 0,
      sentinelArtistTracks: 0,
      unjoinedTracks: 0,
      totalPlaysObserved: 20,
    });
    expect(lookupArtistPlays(indexTrackPlays(tracks, index), linkFor(index, 7))).toEqual({
      status: "observed",
      value: 20,
      join: "normalized-name",
      sampleSize: 3,
    });
  });

  // The engine summarizes the track join once and feeds both projections from
  // it. If the shared-summary path could ever disagree with the single-shot
  // path, the coverage block would stop describing the play index it shipped
  // with.
  it("yields identical results whether the join summary is shared or recomputed", () => {
    const index = indexAuthoritativeIdentities(
      report({
        matchedExact: [
          authoritative("plex-80", 20, "Shared Artist", MBID_A),
          authoritative("plex-81", 21, "Collide", MBID_B),
          authoritative("plex-82", 22, "Unknown Artist", MBID_C),
        ],
        reviewSuggested: [normalizedNameReview("plex-83", 23, "Collide!")],
      }),
    );
    const tracks = [
      track("t1", "Shared Artist", "Album One", 3),
      track("t2", "Shared Artist", "Album Two", 4),
      track("t3", "Collide", "Colliding Album", 9),
      track("t4", "Unknown Artist", "Orphans", 12),
      track("t5", "Nobody Here", "Stray Album", 5),
    ];
    const signals = bundle([artist("plex-80", "Shared Artist", 0.8)], tracks);
    const trackJoin = buildTrackJoinSummary(tracks, index);

    const shared = toPolicyPlayIndex(trackJoin);
    const single = indexTrackPlays(tracks, index);
    expect([...shared.byNormalizedName.entries()]).toEqual([...single.byNormalizedName.entries()]);
    expect([...shared.poisoned]).toEqual([...single.poisoned]);
    expect(Object.isFrozen(shared)).toBe(true);

    expect(buildPolicyEvaluationCoverage({ signals, identity: index, trackJoin })).toEqual(
      buildPolicyEvaluationCoverage({ signals, identity: index }),
    );
    // And the shared block still reports the real counters, not empty ones.
    expect(buildPolicyEvaluationCoverage({ signals, identity: index, trackJoin })).toEqual({
      plexArtistsExamined: 1,
      plexTracksExamined: 5,
      authoritativeLinks: 3,
      nonAuthoritativeArtists: 1,
      ambiguousNameArtists: 2,
      sentinelArtistTracks: 1,
      unjoinedTracks: 1,
      totalPlaysObserved: 33,
    });
  });
});

describe("policy signal indexes", () => {
  const fixture = report({
    matchedExact: [
      authoritative("plex-71", 12, "Second Artist", MBID_B),
      authoritative("plex-70", 9, "First Artist", MBID_A),
    ],
    plexOnly: [sourceUnmatched("plex-72", "Absent Artist", "no-candidate")],
  });
  const tracks = [
    track("t1", "First Artist", "Album One", 1),
    track("t2", "Second Artist", "Album Two", 2),
  ];
  const artists = [artist("plex-70", "First Artist", 1), artist("plex-71", "Second Artist", 0.4)];

  it("freezes every returned index", () => {
    const index = indexAuthoritativeIdentities(fixture);
    const ratings = indexArtistRatings(artists);
    const plays = indexTrackPlays(tracks, index);
    const coverage = buildPolicyEvaluationCoverage({
      signals: bundle(artists, tracks),
      identity: index,
    });

    for (const frozen of [
      index,
      index.links,
      index.byLidarrId,
      index.byPlexId,
      index.nonAuthoritative,
      index.seedCandidates,
      ratings,
      ratings.byPlexId,
      plays,
      plays.byNormalizedName,
      plays.poisoned,
      coverage,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });

  it("produces deterministic iteration order across runs", () => {
    const first = indexAuthoritativeIdentities(fixture);
    const second = indexAuthoritativeIdentities(fixture);

    expect(first.links.map((link) => link.lidarrId)).toEqual([9, 12]);
    expect(second.links.map((link) => link.lidarrId)).toEqual(first.links.map((l) => l.lidarrId));
    expect([...second.byPlexId.keys()]).toEqual([...first.byPlexId.keys()]);
    expect(second.nonAuthoritative).toEqual(first.nonAuthoritative);
    expect([...indexTrackPlays(tracks, second).byNormalizedName.keys()]).toEqual([
      ...indexTrackPlays(tracks, first).byNormalizedName.keys(),
    ]);
  });
});
