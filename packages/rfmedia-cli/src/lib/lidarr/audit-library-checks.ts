/**
 * Pure catalogue evaluators for `rfmedia lidarr audit` (issue #211).
 *
 * These three checks read the *library* — artists, albums, and the wanted
 * backlog — as opposed to the platform around it, which
 * `./audit-platform-checks.js` owns.
 *
 * Every export is synchronous and free of I/O: the audit action gathers data
 * once, and each evaluator turns an already-materialised
 * {@link LidarrAuditGatheredData} into findings. Selection logic is reused
 * rather than re-derived — `filterLidarrAlbums` already encodes "absent
 * statistics counts as zero files", and `./audit-identity.js` owns the folding
 * and bucketing rules — so the audit can never disagree with `lidarr albums`
 * about what "has files" means.
 *
 * Four invariants hold across this module:
 *
 * 1. Findings are built ONLY through {@link createLidarrAuditFinding}, so
 *    subject capping, `affected` accounting, and freezing are identical
 *    everywhere.
 * 2. Every `remediation.command` is non-mutating — a read command or a
 *    `lidarr plan …` artifact command. Deletion and `lidarr apply` appear in
 *    `remediation.action` prose only, because #211 ships as a read-only view.
 * 3. Duplicate findings are emitted ONE PER GROUP with `affected` counting the
 *    group's ENTITIES, never the number of groups.
 * 4. A hard requirement that is nonetheless missing is an engine or registry
 *    bug, not a data condition, so it throws rather than silently reporting a
 *    clean check. The engine isolates the throw into a `check-error` skip.
 */

import { filterLidarrAlbums } from "./album-selection.js";
import { ARTIST_LIST_COMMAND, requireSlotData, toArtistSubject } from "./audit-check-support.js";
import { foldArtistName, groupDuplicates, normalizeArtistPath } from "./audit-identity.js";
import {
  createLidarrAuditFinding,
  type LidarrAuditAlbumData,
  type LidarrAuditFinding,
  type LidarrAuditGatheredData,
  type LidarrAuditSlot,
  type LidarrAuditSubject,
} from "../../types/lidarr-audit.js";
import type { LidarrAlbum, LidarrArtist } from "../../types/lidarr.js";

/** Read command sampling the library-wide missing backlog. */
const WANTED_COMMAND = "rfmedia lidarr wanted --page-size 50";

/**
 * Read command listing an artist's file-less albums.
 *
 * The `<id>` placeholder is deliberate: aggregate findings span more than one
 * artist, and the concrete ids are carried on the finding's `subjects`.
 */
const ALBUMS_WITHOUT_FILES_COMMAND = "rfmedia lidarr albums --artist-ids <id> --no-files";

/** Plan command that would re-monitor the owning artists. Writes an artifact only. */
const ARTIST_MONITORING_PLAN_COMMAND =
  "rfmedia lidarr plan artist-monitoring --ids <id> --monitored --plan-file ./audit-artist-monitoring.plan.json";

/**
 * Plan command that would monitor an artist's albums. Writes an artifact only.
 *
 * `--types` is mandatory alongside `--artist-ids` on that leaf (`--artist-ids`
 * scopes a type selection), so the selector is spelled out to keep the
 * suggestion runnable as printed.
 */
const ALBUM_MONITORING_PLAN_COMMAND =
  "rfmedia lidarr plan album-monitoring --artist-ids <id> --types albums --monitored --plan-file ./audit-album-monitoring.plan.json";

/**
 * Builds the exact-MusicBrainz artist lookup for one duplicate group.
 *
 * @param foreignArtistId - The shared MusicBrainz artist id.
 * @returns A non-mutating lookup command carrying the concrete id.
 */
function artistLookupCommand(foreignArtistId: string): string {
  return `rfmedia lidarr lookup artist "lidarr:${foreignArtistId}"`;
}

/**
 * Builds the exact-MusicBrainz album lookup for one duplicate group.
 *
 * @param foreignAlbumId - The shared MusicBrainz release-group id.
 * @returns A non-mutating lookup command carrying the concrete id.
 */
function albumLookupCommand(foreignAlbumId: string): string {
  return `rfmedia lidarr lookup album "lidarr:${foreignAlbumId}"`;
}

/**
 * Reads an enriching slot, which never gates the check.
 *
 * @param slot - The gathered slot to unwrap.
 * @returns The slot's data, or `undefined` when it was not gathered.
 */
function optionalSlotData<T>(slot: LidarrAuditSlot<T>): T | undefined {
  return slot.status === "available" ? slot.data : undefined;
}

/**
 * Indexes artists by their Lidarr-internal id.
 *
 * @param artists - The library-wide artist list.
 * @returns A lookup map; ids are unique because the boundary projector rejects
 *   duplicate internal ids.
 */
function indexArtistsById(artists: readonly LidarrArtist[]): ReadonlyMap<number, LidarrArtist> {
  return new Map(artists.map((artist) => [artist.id, artist]));
}

/**
 * Builds a display-name resolver for album subjects.
 *
 * The deep scan carries its own artist-name map (it visits artists the
 * library-wide list may have been narrowed away from), so it wins; the artist
 * list is the fallback. An unresolvable id yields `""`, matching the
 * `LidarrAlbum.title` convention for an absent value.
 *
 * @param artistsById - Library-wide artists indexed by id.
 * @param albumData - Deep-scan album data, when the slot was gathered.
 * @returns A resolver from artist id to display name.
 */
function buildArtistNameResolver(
  artistsById: ReadonlyMap<number, LidarrArtist>,
  albumData: LidarrAuditAlbumData | undefined,
): (artistId: number) => string {
  return (artistId: number): string =>
    albumData?.artistNames.get(artistId) ?? artistsById.get(artistId)?.artistName ?? "";
}

/**
 * Projects an album onto a finding subject.
 *
 * @param album - The album to describe.
 * @param resolveArtistName - Owner display-name resolver.
 * @returns The `album` subject.
 */
function toAlbumSubject(
  album: LidarrAlbum,
  resolveArtistName: (artistId: number) => string,
): LidarrAuditSubject {
  return {
    kind: "album",
    albumId: album.id,
    title: album.title,
    ownerArtistId: album.artistId,
    ownerArtistName: resolveArtistName(album.artistId),
  };
}

/**
 * Decides whether an album is scheduled for a future release.
 *
 * An album with NO `releaseDate` stays eligible as a gap: absence means Lidarr
 * never reported one, not that the album is unreleased. An unparseable date
 * yields `NaN`, and `NaN > now` is `false`, so a malformed value also stays
 * eligible rather than silently disappearing from the report.
 *
 * @param album - The album to test.
 * @param now - Epoch milliseconds to compare against.
 * @returns True only when the release date is strictly in the future.
 */
function isFutureRelease(album: LidarrAlbum, now: number): boolean {
  if (album.releaseDate === undefined) {
    return false;
  }
  return Date.parse(album.releaseDate) > now;
}

/**
 * Evaluates `monitoring-drift`: album monitoring that contradicts its owning
 * artist.
 *
 * Two conditions are reported, both as aggregates over the deep scan. Albums
 * monitored under an UNMONITORED artist are a warning: Lidarr gates searching
 * on `artist.monitored`, so that monitoring flag buys nothing and the operator
 * almost certainly meant to monitor the artist too. Monitored artists whose
 * scanned albums are all unmonitored are only `info`, because that is exactly
 * what Lidarr's stock "Monitor: Future" option produces and is frequently
 * intentional — the message says so rather than nagging.
 *
 * Condition (b) is restricted to artists the scan actually returned albums for.
 * `--artist-ids` narrows the scan but not the artist list, so an artist with no
 * scanned albums is indistinguishable from an artist that was never visited,
 * and reporting it would fabricate drift.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings: orphaned monitored albums, then idle monitored artists.
 * @throws {Error} When the required `artists` or `albums` slot is unavailable.
 */
export function evaluateMonitoringDrift(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const artists = requireSlotData(gathered.artists, "monitoring-drift", "artists");
  const albumData = requireSlotData(gathered.albums, "monitoring-drift", "albums");
  const findings: LidarrAuditFinding[] = [];

  const artistsById = indexArtistsById(artists);
  const resolveArtistName = buildArtistNameResolver(artistsById, albumData);

  const orphanedAlbums: LidarrAlbum[] = [];
  const unmonitoredOwnerIds = new Set<number>();
  const scannedArtistIds = new Set<number>();
  const ownerIdsWithMonitoredAlbums = new Set<number>();

  for (const album of albumData.albums) {
    scannedArtistIds.add(album.artistId);
    if (!album.monitored) {
      continue;
    }
    ownerIdsWithMonitoredAlbums.add(album.artistId);

    const owner = artistsById.get(album.artistId);
    if (owner === undefined || owner.monitored) {
      continue;
    }
    orphanedAlbums.push(album);
    unmonitoredOwnerIds.add(owner.id);
  }

  if (orphanedAlbums.length > 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "monitoring-drift",
        code: "monitored-album-under-unmonitored-artist",
        severity: "warning",
        summary: `${orphanedAlbums.length} monitored album(s) sit under ${unmonitoredOwnerIds.size} unmonitored artist(s)`,
        subjects: orphanedAlbums.map((album) => toAlbumSubject(album, resolveArtistName)),
        evidence: { albumCount: orphanedAlbums.length, artistCount: unmonitoredOwnerIds.size },
        remediation: {
          action:
            "Lidarr gates searching on the artist's monitored flag, so these albums are dead work: they will never be searched for while the artist stays unmonitored. Review the plan artifact, then apply it with `rfmedia lidarr apply <file>`.",
          command: ARTIST_MONITORING_PLAN_COMMAND,
        },
      }),
    );
  }

  const idleArtists = artists.filter(
    (artist) =>
      artist.monitored &&
      scannedArtistIds.has(artist.id) &&
      !ownerIdsWithMonitoredAlbums.has(artist.id),
  );

  if (idleArtists.length > 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "monitoring-drift",
        code: "monitored-artist-no-monitored-albums",
        severity: "info",
        summary: `${idleArtists.length} monitored artist(s) have no monitored albums`,
        subjects: idleArtists.map(toArtistSubject),
        evidence: { artistCount: idleArtists.length },
        remediation: {
          action:
            'This is exactly what Lidarr\'s stock "Monitor: Future" option produces and is frequently intentional — nothing is acquired for the existing discography until an album is monitored. Only act if you expected back-catalogue acquisition. Review the plan artifact, then apply it with `rfmedia lidarr apply <file>`.',
          command: ALBUM_MONITORING_PLAN_COMMAND,
        },
      }),
    );
  }

  return Object.freeze(findings);
}

/**
 * Evaluates `library-gaps`: monitored entities missing files, plus the
 * wanted/missing backlog.
 *
 * Artist-level gaps and the backlog total always run. Album-level gaps need the
 * deep scan and are therefore skipped silently when the `albums` slot is
 * absent — `albums` only ENRICHES this check, so its absence must never gate it.
 *
 * Deliberately absent: percent-of-tracks coverage. `trackCount` counts tracks
 * across MONITORED albums while `trackFileCount` counts files across ALL
 * albums, so the ratio mixes scopes and can exceed 100. Only the unambiguous
 * "known tracks, zero files" case ships.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings: artist gaps, backlog, then album gaps.
 * @throws {Error} When the required `artists` or `wanted` slot is unavailable.
 */
export function evaluateLibraryGaps(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const artists = requireSlotData(gathered.artists, "library-gaps", "artists");
  const wanted = requireSlotData(gathered.wanted, "library-gaps", "wanted");
  const albumData = optionalSlotData(gathered.albums);
  const findings: LidarrAuditFinding[] = [];

  const emptyArtists = artists.filter((artist) => {
    if (!artist.monitored) {
      return false;
    }
    const statistics = artist.statistics;
    return statistics !== undefined && statistics.trackCount > 0 && statistics.trackFileCount === 0;
  });

  if (emptyArtists.length > 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "library-gaps",
        code: "artist-monitored-no-files",
        severity: "warning",
        summary: `${emptyArtists.length} monitored artist(s) have known tracks but no files on disk`,
        subjects: emptyArtists.map(toArtistSubject),
        evidence: { artistCount: emptyArtists.length },
        remediation: {
          action:
            "Nothing has been downloaded for this artist. A library-wide collapse is almost always an unmounted root folder, not a search problem — check the root folder before queueing searches.",
          command: ALBUMS_WITHOUT_FILES_COMMAND,
        },
      }),
    );
  }

  if (wanted.total > 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "library-gaps",
        code: "wanted-backlog",
        severity: "info",
        summary: `${wanted.total} album(s) are on Lidarr's wanted/missing list`,
        // The backlog describes the instance, and the report origin is stamped
        // by the engine rather than carried on the gathered data, so there is
        // no subject to attach; `affected` carries the total instead.
        subjects: [],
        affected: wanted.total,
        evidence: { wantedTotal: wanted.total },
        remediation: {
          action:
            "This total is library-wide and ignores `--artist-ids`: it is Lidarr's own missing count, sampled with a single one-record request. A steady backlog is normal; a growing one usually means indexer or metadata trouble.",
          command: WANTED_COMMAND,
        },
      }),
    );
  }

  if (albumData !== undefined) {
    const artistsById = indexArtistsById(artists);
    const resolveArtistName = buildArtistNameResolver(artistsById, albumData);
    const now = Date.now();

    // Filtered on the ALBUM's monitored flag alone. An album under an
    // unmonitored artist is still a genuine file gap, and `monitoring-drift` is
    // separately selectable, so excluding it here would make it vanish from a
    // `--check library-gaps` run entirely. The remediation prose names the
    // caveat instead.
    const releasedGaps = filterLidarrAlbums(albumData.albums, {
      monitored: true,
      hasFiles: false,
    }).filter((album) => !isFutureRelease(album, now));

    if (releasedGaps.length > 0) {
      findings.push(
        createLidarrAuditFinding({
          checkId: "library-gaps",
          code: "album-monitored-no-files",
          severity: "warning",
          summary: `${releasedGaps.length} monitored, released album(s) have no files on disk`,
          subjects: releasedGaps.map((album) => toAlbumSubject(album, resolveArtistName)),
          evidence: { albumCount: releasedGaps.length },
          remediation: {
            action:
              "These albums are monitored and already released, so Lidarr should be acquiring them — unless the owning artist is unmonitored, in which case they will never be searched for; see `monitoring-drift`. Albums with no release date stay in this list on purpose — an absent date is missing metadata, not a future release.",
            command: ALBUMS_WITHOUT_FILES_COMMAND,
          },
        }),
      );
    }

    const partialAlbums = albumData.albums.filter((album) => {
      const trackCount = album.statistics?.trackCount ?? 0;
      const trackFileCount = album.statistics?.trackFileCount ?? 0;
      return trackFileCount > 0 && trackFileCount < trackCount;
    });

    if (partialAlbums.length > 0) {
      findings.push(
        createLidarrAuditFinding({
          checkId: "library-gaps",
          code: "album-partial-files",
          severity: "info",
          summary: `${partialAlbums.length} album(s) have some but not all track files`,
          subjects: partialAlbums.map((album) => toAlbumSubject(album, resolveArtistName)),
          evidence: { albumCount: partialAlbums.length },
          remediation: {
            action:
              "A partially-imported album is usually an incomplete release grab or a failed import of individual tracks; compare the album against its track list before re-searching.",
            command: ALBUMS_WITHOUT_FILES_COMMAND,
          },
        }),
      );
    }
  }

  return Object.freeze(findings);
}

/**
 * Evaluates `duplicate-identity`: repeated MusicBrainz ids, shared root paths,
 * and folded-name collisions.
 *
 * Each collision yields ONE finding per group, whose `subjects` are that
 * group's members and whose `affected` is the member count — never the number
 * of groups. `evidence.groupSize` republishes the same count so a capped
 * subject list still reports its true size.
 *
 * Severity tracks certainty. Two entries claiming the same MusicBrainz artist
 * is real corruption, so it is critical. Two entries writing to one folder is a
 * warning: it is a genuine hazard for the next import but not yet data loss. A
 * folded-name collision is only `info` and is explicitly labelled a candidate —
 * distinct artists legitimately share a name.
 *
 * Album collisions need the deep scan and are skipped silently when the
 * `albums` slot is absent; `albums` only ENRICHES this check.
 *
 * Deletion is named in `action` prose only. Every `command` here is a read.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings: MBID, path, folded-name, then album collisions.
 * @throws {Error} When the required `artists` slot is unavailable.
 */
export function evaluateDuplicateIdentity(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const artists = requireSlotData(gathered.artists, "duplicate-identity", "artists");
  const albumData = optionalSlotData(gathered.albums);
  const findings: LidarrAuditFinding[] = [];

  for (const group of groupDuplicates(artists, (artist) => artist.foreignArtistId)) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "duplicate-identity",
        code: "duplicate-artist-mbid",
        severity: "critical",
        summary: `${group.members.length} artists claim MusicBrainz artist ${group.key}`,
        subjects: group.members.map(toArtistSubject),
        evidence: { foreignArtistId: group.key, groupSize: group.members.length },
        remediation: {
          action:
            "Two Lidarr entries claim the same MusicBrainz artist. Decide which is canonical, then remove the other with `rfmedia lidarr plan artist-delete` once you have confirmed which entry owns the files.",
          command: artistLookupCommand(group.key),
        },
      }),
    );
  }

  const pathGroups = groupDuplicates(artists, (artist) =>
    artist.path === undefined ? undefined : normalizeArtistPath(artist.path),
  );
  for (const group of pathGroups) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "duplicate-identity",
        code: "duplicate-artist-path",
        severity: "warning",
        summary: `${group.members.length} artists share the folder ${group.key}`,
        subjects: group.members.map(toArtistSubject),
        evidence: { path: group.key, groupSize: group.members.length },
        remediation: {
          action:
            "Reassign one artist to its own folder in Lidarr before the next import; do not delete files until the paths are separated, because both entries currently claim the same directory. Path comparison is case-sensitive, matching the Linux bind mounts these containers use.",
          command: ARTIST_LIST_COMMAND,
        },
      }),
    );
  }

  for (const group of groupDuplicates(artists, (artist) => foldArtistName(artist.artistName))) {
    // Members that share an MBID are already reported as `duplicate-artist-mbid`;
    // keeping one entry per distinct MusicBrainz id leaves only the genuine
    // "same name, different identity" candidates behind.
    const seenIds = new Set<string>();
    const distinctMembers = group.members.filter((artist) => {
      if (seenIds.has(artist.foreignArtistId)) {
        return false;
      }
      seenIds.add(artist.foreignArtistId);
      return true;
    });
    if (distinctMembers.length < 2) {
      continue;
    }

    findings.push(
      createLidarrAuditFinding({
        checkId: "duplicate-identity",
        code: "similar-artist-name",
        severity: "info",
        summary: `${distinctMembers.length} artists fold to the same name "${group.key}"`,
        subjects: distinctMembers.map(toArtistSubject),
        evidence: { foldedName: group.key, groupSize: distinctMembers.length },
        remediation: {
          action:
            "This is a candidate, not a verdict: the names collide after case, accent, punctuation, and leading-article folding, but the MusicBrainz ids differ. Confirm on MusicBrainz whether these are distinct artists; if so no action is needed.",
          command: ARTIST_LIST_COMMAND,
        },
      }),
    );
  }

  if (albumData !== undefined) {
    const resolveArtistName = buildArtistNameResolver(indexArtistsById(artists), albumData);
    const albumGroups = groupDuplicates(albumData.albums, (album) => album.foreignAlbumId);
    for (const group of albumGroups) {
      findings.push(
        createLidarrAuditFinding({
          checkId: "duplicate-identity",
          code: "duplicate-album-mbid",
          severity: "info",
          summary: `${group.members.length} albums claim MusicBrainz release group ${group.key}`,
          subjects: group.members.map((album) => toAlbumSubject(album, resolveArtistName)),
          evidence: { foreignAlbumId: group.key, groupSize: group.members.length },
          remediation: {
            action:
              "Lidarr sometimes tracks one release group under two entries after a metadata refresh. Confirm which entry holds the files before removing the other; album removal is a separate, explicitly authorized plan.",
            command: albumLookupCommand(group.key),
          },
        }),
      );
    }
  }

  return Object.freeze(findings);
}
