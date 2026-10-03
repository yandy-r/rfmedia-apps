/**
 * The consumption-policy join layer (issue #209, design §6.0, §8.2, §8.3, §8.6).
 *
 * This is the highest-defect-risk surface in the feature: a silently wrong
 * answer here is invisible and produces a real unmonitor proposal against a
 * consumed artist. Every function is pure, total on its inputs, and performs no
 * I/O.
 *
 * Two joins, of very different strength:
 *
 * - Ratings join on `MediaArtist.id === ReconciliationSourceIdentity.plexId`.
 *   Both sides derive from `wire.ratingKey`, so the join is exact and is
 *   unaffected by name collisions. Grade `exact-plex-id`.
 * - Play totals have no id path at all: `MediaTrack` carries `artist: string`
 *   and no artist id, and `playCount` exists only on tracks. Totals are bucketed
 *   under `normalizeBridgeArtistName(track.artist)`, REUSING the versioned bridge
 *   normalizer rather than inventing a second normalization policy. Grade
 *   `normalized-name`, with three fail-closed poisonings (§8.2).
 *
 * {@link indexAuthoritativeIdentities} is the SOLE minter of the branded
 * `PolicyIdentityLink`, and `createPolicyProposal` in `./policy-rule-support.js`
 * is its only consumer. That pair is what makes "review-grade name evidence can
 * never reach a proposal" a compile-time property rather than a review
 * convention (§8.3).
 */

import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationAuthoritativeItem,
  ReconciliationItem,
  ReconciliationPlexOnlyItem,
} from "../../types/bridge.js";
import type {
  PolicyEvaluationCoverage,
  PolicyIdentityIndex,
  PolicyIdentityLink,
  PolicyNonAuthoritativeSubject,
  PolicyObservation,
  PolicyPlayIndex,
  PolicyRatingIndex,
  PolicySeedCandidate,
  PolicySignalBundle,
  PolicySubject,
  PolicyTrackSignalBucket,
} from "../../types/lidarr-policy.js";
import type { MediaArtist, MediaTrack } from "../../types/media-server.js";
import { normalizeBridgeArtistName } from "./artist-name.js";

/**
 * The universal §6.0 refusal detail, verbatim.
 *
 * Reaches an output field, so it lives in exactly one place.
 */
export const POLICY_NON_AUTHORITATIVE_DETAIL =
  "review-grade name evidence is never auto-consumed by a policy decision";

/**
 * The normalized form of the `mapPlexTrack` artist fallback.
 *
 * `mapPlexTrack` sets `artist: track.grandparentTitle ?? "Unknown Artist"`, so
 * every track lacking a grandparent title collapses into this one bucket. The
 * key is therefore permanently poisoned: without that, plays would be inflated
 * for any artist whose title normalizes to it, AND the real artists behind the
 * orphaned rows would look zero-play, pushing them toward an unmonitor proposal.
 */
const SENTINEL_ARTIST_KEY = normalizeBridgeArtistName("Unknown Artist");

/**
 * Plex id stand-in for a subject that has no Plex counterpart at all.
 *
 * `PolicySubject.plexId` is required, and a `lidarrOnly` item's `source` is
 * `null` by construction. Such a subject is keyed by its `artistId`, so the
 * empty id never participates in a decision key.
 */
const NO_PLEX_ID = "";

/**
 * Mints the branded authoritative link.
 *
 * The brand is a `declare const unique symbol` with no runtime existence, so a
 * single assertion is required to attach it. Confining that assertion to one
 * private function over one input type — `ReconciliationAuthoritativeItem`,
 * whose `category: "authoritative"` / `reason: "unique-exact-mbid"` /
 * `method: "exact-mbid"` are literal-typed and whose `target.artistMbid` is
 * non-nullable — is precisely what makes the safety invariant enforceable.
 *
 * @param item - One authoritative reconciliation item.
 * @returns The frozen identity link.
 */
function mintPolicyIdentityLink(item: ReconciliationAuthoritativeItem): PolicyIdentityLink {
  return Object.freeze({
    plexId: item.source.plexId,
    lidarrId: item.target.lidarrId,
    plexTitle: item.source.title,
    lidarrTitle: item.target.title,
    artistMbid: item.target.artistMbid,
  }) as PolicyIdentityLink;
}

/**
 * Projects any non-authoritative reconciliation item onto a refused subject.
 *
 * Carries no `ruleId`: the refusal list is computed once over the whole report
 * and the engine attributes each entry to exactly one rule when it materialises
 * the `PolicySkip` (plan §1 R4).
 *
 * @param item - One reconciliation item that is not authoritative.
 * @returns The refused subject with its identity evidence.
 */
function toNonAuthoritativeSubject(item: ReconciliationItem): PolicyNonAuthoritativeSubject {
  const subject: PolicySubject =
    item.source === null
      ? Object.freeze({
          kind: "artist",
          name: item.target?.title ?? "",
          plexId: NO_PLEX_ID,
          artistId: item.target?.lidarrId,
          artistMbid: item.target?.artistMbid ?? null,
        })
      : Object.freeze({
          kind: "artist",
          name: item.source.title,
          plexId: item.source.plexId,
          artistMbid: item.source.artistMbid,
        });

  return Object.freeze({
    subject,
    identity: Object.freeze({ category: item.category, reason: item.reason }),
    detail: POLICY_NON_AUTHORITATIVE_DETAIL,
  });
}

/**
 * The dedupe key for a refused subject.
 *
 * `report.plexOnly` is a directional-gap view that re-exports the very same
 * item objects that `reviewSuggested`, `reviewAmbiguous`, `conflicts`, and
 * `unavailable` hold, so enumerating all six arrays naively would refuse the
 * same artist several times and inflate `coverage.nonAuthoritativeArtists`.
 *
 * @param item - One reconciliation item.
 * @returns A key unique per refused artist.
 */
function nonAuthoritativeDedupeKey(item: ReconciliationItem): string {
  return item.source === null
    ? `lidarr:${item.target?.lidarrId ?? ""}`
    : `plex:${item.source.plexId}`;
}

/**
 * Narrows a `plexOnly` member to a seed candidate.
 *
 * `ReconciliationPlexOnlyItem` is a union that also holds review-normalized-name,
 * review-fuzzy-name, ambiguous, conflict, and unavailable members, all of which
 * probably already exist in Lidarr under a slightly different name. Only
 * `no-candidate` means the resolver found nothing at all, which is the one
 * honest "absent from Lidarr" signal (§6.3).
 *
 * @param item - One source-side directional gap.
 * @returns True when the item is an honest absence.
 */
function isPolicySeedCandidate(item: ReconciliationPlexOnlyItem): item is PolicySeedCandidate {
  return item.category === "unmatched" && item.reason === "no-candidate";
}

/**
 * Indexes the authoritative identity substrate and every subject it refuses.
 *
 * The SOLE minter of `PolicyIdentityLink`. It admits only
 * `ReconciliationAuthoritativeItem` values, and takes them only from
 * `report.matchedExact` — there is no `.authoritative` field on
 * `PlexLidarrReconciliationResultV1`.
 *
 * @param report - The shipped Plex to Lidarr reconciliation report.
 * @returns The frozen identity index.
 */
export function indexAuthoritativeIdentities(
  report: PlexLidarrReconciliationResultV1,
): PolicyIdentityIndex {
  const links = report.matchedExact.map(mintPolicyIdentityLink);
  links.sort((left, right) =>
    left.lidarrId === right.lidarrId
      ? left.plexId.localeCompare(right.plexId)
      : left.lidarrId - right.lidarrId,
  );

  const byLidarrId = new Map<number, PolicyIdentityLink>();
  const byPlexId = new Map<string, PolicyIdentityLink>();
  for (const link of links) {
    byLidarrId.set(link.lidarrId, link);
    byPlexId.set(link.plexId, link);
  }

  const seen = new Set<string>();
  const nonAuthoritative: PolicyNonAuthoritativeSubject[] = [];
  const refusedGroups: readonly (readonly ReconciliationItem[])[] = [
    report.reviewSuggested,
    report.reviewAmbiguous,
    report.plexOnly,
    report.lidarrOnly,
    report.conflicts,
    report.unavailable,
  ];
  for (const group of refusedGroups) {
    for (const item of group) {
      const dedupeKey = nonAuthoritativeDedupeKey(item);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      nonAuthoritative.push(toNonAuthoritativeSubject(item));
    }
  }

  return Object.freeze({
    links: Object.freeze(links),
    byLidarrId: Object.freeze(byLidarrId),
    byPlexId: Object.freeze(byPlexId),
    nonAuthoritative: Object.freeze(nonAuthoritative),
    seedCandidates: Object.freeze(report.plexOnly.filter(isPolicySeedCandidate)),
  });
}

/**
 * Indexes Plex artists by their rating key — the EXACT join.
 *
 * `rating === null` means UNRATED and is preserved as such: it is a distinct
 * outcome from a rating of `0`, and collapsing the two would let an unrated
 * artist read as the worst-rated artist in the library.
 *
 * @param artists - Plex artists carrying the normalized rating.
 * @returns The frozen rating index.
 */
export function indexArtistRatings(artists: readonly MediaArtist[]): PolicyRatingIndex {
  const byPlexId = new Map<string, MediaArtist>();
  for (const artist of artists) {
    byPlexId.set(artist.id, artist);
  }

  return Object.freeze({ byPlexId: Object.freeze(byPlexId) });
}

/**
 * One normalized-name play-and-recency bucket set plus the counters the
 * coverage block needs.
 *
 * Both public consumers — the play index and the coverage block — are pure
 * projections of this one value, so it is computed once per evaluation and
 * threaded through rather than derived twice over the same track array.
 */
export interface TrackJoinSummary {
  readonly byNormalizedName: ReadonlyMap<string, PolicyTrackSignalBucket>;
  readonly poisoned: ReadonlySet<string>;
  readonly ambiguousNameArtists: number;
  readonly sentinelArtistTracks: number;
  readonly unjoinedTracks: number;
  readonly totalPlaysObserved: number;
}

/**
 * Maps each normalized bridge artist name to the distinct Plex ids claiming it.
 *
 * The universe deliberately spans authoritative links AND refused Plex subjects:
 * if an authoritative artist and a review-grade artist normalize to the same
 * name, their tracks land in the same bucket and the authoritative artist's play
 * total is inflated. Poisoning has to see both.
 *
 * @param identity - The identity index.
 * @returns Normalized name to the set of Plex ids that claim it.
 */
function buildNameOwners(identity: PolicyIdentityIndex): ReadonlyMap<string, ReadonlySet<string>> {
  const owners = new Map<string, Set<string>>();

  const claim = (name: string, plexId: string): void => {
    if (plexId === NO_PLEX_ID) {
      return;
    }
    const key = normalizeBridgeArtistName(name);
    const existing = owners.get(key);
    if (existing === undefined) {
      owners.set(key, new Set([plexId]));
      return;
    }
    existing.add(plexId);
  };

  for (const link of identity.links) {
    claim(link.plexTitle, link.plexId);
  }
  for (const refused of identity.nonAuthoritative) {
    claim(refused.subject.name, refused.subject.plexId);
  }

  return owners;
}

/**
 * Buckets track plays and recency under the normalized artist name and applies
 * all three fail-closed poisonings from §8.2.
 *
 * A track reaches at most ONE of `sentinelArtistTracks`, `unjoinedTracks`, or a
 * play bucket, so those counters never double-count. A track under a POISONED
 * (ambiguous) name reaches none of them: it is deliberately dropped rather than
 * bucketed, because the public index must not expose a total no observation is
 * allowed to use. `plexTracksExamined` therefore does not reconcile against the
 * breakdown; `coverage.ambiguousNameArtists` is the tell for the difference.
 * `totalPlaysObserved` spans every track regardless, because it is the
 * library-wide per-account sanity tell.
 *
 * This is the most expensive pure pass in the feature — it normalizes every
 * drained track name — so run it ONCE per evaluation and hand the result to
 * both {@link toPolicyPlayIndex} and {@link buildPolicyEvaluationCoverage}.
 *
 * KNOWN LIMIT — album-artist rollup. `MediaTrack.artist` is Plex's
 * `grandparentTitle`, which is the ALBUM artist, not the performing artist. On
 * a compilation ("Various Artists", a soundtrack, a DJ mix) every track's plays
 * are therefore credited to the compilation's album artist. A performer whose
 * consumption is compilation-only can read as zero plays under their own name
 * while still having track coverage, so `requireTrackCoverage` does not catch
 * it. Only the `"Unknown Artist"` sentinel is poisoned; no attempt is made to
 * guess the real performer, because that would be a heuristic and this join is
 * fail-closed by construction.
 *
 * @param tracks - Plex tracks carrying `playCount`.
 * @param identity - The identity index supplying the known-name universe.
 * @returns The buckets, the poisoned key set, and the coverage counters.
 */
export function buildTrackJoinSummary(
  tracks: readonly MediaTrack[],
  identity: PolicyIdentityIndex,
): TrackJoinSummary {
  const owners = buildNameOwners(identity);

  // The sentinel bucket is poisoned unconditionally, not only when a track
  // happens to land in it.
  const poisoned = new Set<string>([SENTINEL_ARTIST_KEY]);
  let ambiguousNameArtists = 0;
  for (const [name, claimants] of owners) {
    if (claimants.size >= 2) {
      poisoned.add(name);
      ambiguousNameArtists += claimants.size;
    }
  }

  const byNormalizedName = new Map<
    string,
    {
      plays: number;
      sampleSize: number;
      latestLastViewedAt: number | null;
      lastViewedAtSampleSize: number;
      playedRowsMissingLastViewedAt: number;
    }
  >();
  let sentinelArtistTracks = 0;
  let unjoinedTracks = 0;
  let totalPlaysObserved = 0;

  for (const track of tracks) {
    totalPlaysObserved += track.playCount;

    const key = normalizeBridgeArtistName(track.artist);
    if (key === SENTINEL_ARTIST_KEY) {
      sentinelArtistTracks += 1;
      continue;
    }
    if (!owners.has(key)) {
      unjoinedTracks += 1;
      continue;
    }
    if (poisoned.has(key)) {
      // Never bucket a poisoned key: the public index must not expose a total
      // that no observation is allowed to use.
      continue;
    }

    const bucket = byNormalizedName.get(key);
    if (bucket === undefined) {
      byNormalizedName.set(key, {
        plays: track.playCount,
        sampleSize: 1,
        latestLastViewedAt: track.lastViewedAt ?? null,
        lastViewedAtSampleSize: track.lastViewedAt === undefined ? 0 : 1,
        playedRowsMissingLastViewedAt:
          track.playCount > 0 && track.lastViewedAt === undefined ? 1 : 0,
      });
      continue;
    }
    bucket.plays += track.playCount;
    bucket.sampleSize += 1;
    if (track.lastViewedAt === undefined) {
      if (track.playCount > 0) {
        bucket.playedRowsMissingLastViewedAt += 1;
      }
    } else {
      bucket.latestLastViewedAt =
        bucket.latestLastViewedAt === null
          ? track.lastViewedAt
          : Math.max(bucket.latestLastViewedAt, track.lastViewedAt);
      bucket.lastViewedAtSampleSize += 1;
    }
  }

  for (const bucket of byNormalizedName.values()) {
    Object.freeze(bucket);
  }

  return {
    byNormalizedName,
    poisoned,
    ambiguousNameArtists,
    sentinelArtistTracks,
    unjoinedTracks,
    totalPlaysObserved,
  };
}

/**
 * Projects an already-computed join summary onto the play index — the WEAK
 * join. Pure and allocation-only; it never re-walks the track array.
 *
 * @param trackJoin - The summary from {@link buildTrackJoinSummary}.
 * @returns The frozen play index.
 */
export function toPolicyPlayIndex(trackJoin: TrackJoinSummary): PolicyPlayIndex {
  return Object.freeze({
    byNormalizedName: Object.freeze(trackJoin.byNormalizedName),
    poisoned: Object.freeze(trackJoin.poisoned),
  });
}

/**
 * Builds the play index from raw tracks — the single-shot convenience form.
 *
 * A caller that also needs the coverage block must NOT use this: it would walk
 * the track array a second time. Build the summary once and use
 * {@link toPolicyPlayIndex} instead.
 *
 * @param tracks - Plex tracks carrying `playCount`.
 * @param identity - The identity index supplying the known-name universe.
 * @returns The frozen play index.
 */
export function indexTrackPlays(
  tracks: readonly MediaTrack[],
  identity: PolicyIdentityIndex,
): PolicyPlayIndex {
  return toPolicyPlayIndex(buildTrackJoinSummary(tracks, identity));
}

/**
 * Reads one artist's play total off the weak join, honestly.
 *
 * Every gap it can report is a refusal, never a zero:
 * `sentinel-artist-name` for the `"Unknown Artist"` bucket,
 * `ambiguous-name-join` for a name claimed by two or more Plex artists, and
 * `no-track-coverage` when the artist simply has no joined tracks.
 *
 * @param playIndex - The play index.
 * @param link - The authoritative link to observe.
 * @returns The observation, carrying `sampleSize` when observed.
 */
export function lookupArtistPlays(
  playIndex: PolicyPlayIndex,
  link: PolicyIdentityLink,
): PolicyObservation<number> {
  const key = normalizeBridgeArtistName(link.plexTitle);

  if (key === SENTINEL_ARTIST_KEY) {
    return { status: "unavailable", reason: "sentinel-artist-name" };
  }
  if (playIndex.poisoned.has(key)) {
    return { status: "unavailable", reason: "ambiguous-name-join" };
  }

  const bucket = playIndex.byNormalizedName.get(key);
  if (bucket === undefined) {
    return { status: "unavailable", reason: "no-track-coverage" };
  }

  return {
    status: "observed",
    value: bucket.plays,
    join: "normalized-name",
    sampleSize: bucket.sampleSize,
  };
}

/**
 * Reads one artist's newest trustworthy last-viewed timestamp off the weak join.
 *
 * Sentinel and ambiguous-name poisonings retain precedence over recency gaps.
 * An entirely timestamp-free bucket has no recency coverage. Once any timestamp
 * exists, a played-row omission makes the bucket partial; zero-play omissions
 * are tolerated because Plex has no historical view to timestamp.
 *
 * @param playIndex - The shared play and recency index.
 * @param link - The authoritative link to observe.
 * @returns The newest timestamp or a fail-closed observation gap.
 */
export function lookupArtistLastViewedAt(
  playIndex: PolicyPlayIndex,
  link: PolicyIdentityLink,
): PolicyObservation<number> {
  const key = normalizeBridgeArtistName(link.plexTitle);

  if (key === SENTINEL_ARTIST_KEY) {
    return { status: "unavailable", reason: "sentinel-artist-name" };
  }
  if (playIndex.poisoned.has(key)) {
    return { status: "unavailable", reason: "ambiguous-name-join" };
  }

  const bucket = playIndex.byNormalizedName.get(key);
  if (bucket === undefined) {
    return { status: "unavailable", reason: "no-track-coverage" };
  }
  if (bucket.latestLastViewedAt === null) {
    return { status: "unavailable", reason: "no-recency-coverage" };
  }
  if (bucket.playedRowsMissingLastViewedAt > 0) {
    return { status: "unavailable", reason: "partial-recency-coverage" };
  }

  return {
    status: "observed",
    value: bucket.latestLastViewedAt,
    join: "normalized-name",
    sampleSize: bucket.lastViewedAtSampleSize,
  };
}

/**
 * Computes how much data actually backed a report, from the gathered slots
 * ALONE — never from rule outcomes, so the coverage block stays an honest
 * description of the evidence even when every rule was deselected.
 *
 * @param input - The gathered signal bundle, the identity index, and optionally
 *   the join summary already computed for the play index. When `trackJoin` is
 *   supplied it MUST be the summary of `signals.plexTrackPlays` against
 *   `identity`; omit it and the summary is computed here instead.
 * @returns The frozen coverage block.
 */
export function buildPolicyEvaluationCoverage(input: {
  readonly signals: PolicySignalBundle;
  readonly identity: PolicyIdentityIndex;
  readonly trackJoin?: TrackJoinSummary;
}): PolicyEvaluationCoverage {
  const artists =
    input.signals.plexArtistRatings.status === "available"
      ? input.signals.plexArtistRatings.data
      : [];
  const tracks =
    input.signals.plexTrackPlays.status === "available" ? input.signals.plexTrackPlays.data : [];
  const summary = input.trackJoin ?? buildTrackJoinSummary(tracks, input.identity);

  return Object.freeze({
    plexArtistsExamined: artists.length,
    plexTracksExamined: tracks.length,
    authoritativeLinks: input.identity.links.length,
    nonAuthoritativeArtists: input.identity.nonAuthoritative.length,
    ambiguousNameArtists: summary.ambiguousNameArtists,
    sentinelArtistTracks: summary.sentinelArtistTracks,
    unjoinedTracks: summary.unjoinedTracks,
    totalPlaysObserved: summary.totalPlaysObserved,
  });
}
