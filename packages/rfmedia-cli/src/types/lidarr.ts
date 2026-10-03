/**
 * Public command-facing Lidarr domain projections.
 *
 * These interfaces model only the stable fields consumed by Lidarr commands.
 * They are deliberately independent from the private generated Lidarr wire
 * models: generated types are broad, optional API descriptions and must never
 * be imported, aliased, or re-exported through this public module.
 *
 * Focused boundary projectors in `src/lib/lidarr/types.ts` validate unknown
 * response data and construct fresh objects before values cross into actions.
 *
 * The `LidarrConfigOptions` config-section type is defined in
 * `./config.ts` (mirroring `PlexConfigOptions`) and re-exported here for
 * cohesion with the rest of the Lidarr surface.
 */

import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type { LidarrCacheStatus } from "./lidarr-resilience.js";

// Config section is defined once in types/config.ts and re-exported here so
// callers can import the whole Lidarr surface from a single module.
export type { LidarrConfigOptions } from "./config.js";

// ── Search and lookup domain projections ──

/** Supported Lidarr search and lookup operation modes. */
export type LidarrSearchMode = "search" | "artist" | "album";

/** Generated-independent input for one Lidarr search or lookup request. */
export interface LidarrSearchQuery {
  /** Operation selected by the command or action. */
  readonly mode: LidarrSearchMode;
  /** Validated search term sent to Lidarr. */
  readonly term: string;
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Unranked artist candidate projected from an untrusted Lidarr response. */
export interface LidarrArtistSearchCandidateInput {
  readonly kind: "artist";
  /** Durable MusicBrainz artist identifier. */
  readonly foreignId: string;
  /** Artist display name. */
  readonly name: string;
  /** Positive local Lidarr identifier, when the result is already installed. */
  readonly lidarrId?: number;
  /** Bounded artist disambiguation text, when reported. */
  readonly disambiguation?: string;
  /** Bounded artist type, when reported. */
  readonly artistType?: string;
}

/** Unranked album candidate projected from an untrusted Lidarr response. */
export interface LidarrAlbumSearchCandidateInput {
  readonly kind: "album";
  /** Durable MusicBrainz release-group identifier. */
  readonly foreignId: string;
  /** Album display name. */
  readonly name: string;
  /** Positive local Lidarr identifier, when the result is already installed. */
  readonly lidarrId?: number;
  /** Bounded owning-artist display name, when reported. */
  readonly artistName?: string;
  /** Durable MusicBrainz identifier for the owning artist, when reported. */
  readonly artistForeignId?: string;
  /** Bounded album type, when reported. */
  readonly albumType?: string;
  /** Release date text reported by Lidarr, when present. */
  readonly releaseDate?: string;
}

/** Unranked candidate returned by the private Lidarr facade. */
export type LidarrSearchCandidateInput =
  | LidarrArtistSearchCandidateInput
  | LidarrAlbumSearchCandidateInput;

/** Ranked candidate exposed by the Lidarr search action. */
export type LidarrSearchCandidate = LidarrSearchCandidateInput & {
  /** Stable one-based position in the complete deduplicated result set. */
  readonly rank: number;
};

/** Complete search result exposed by the Lidarr action layer. */
export interface LidarrSearchActionResult {
  readonly query: {
    readonly mode: LidarrSearchMode;
    readonly term: string;
  };
  readonly results: readonly LidarrSearchCandidate[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
  readonly provider: {
    readonly requested: "lidarr";
    readonly used: "lidarr" | "sqlite-cache";
    readonly degraded: boolean;
    readonly fallbackReason?: string;
  };
  readonly cacheStatus?: LidarrCacheStatus;
  readonly execution: LidarrExecutionSuccessMetadata;
}

// ── System-status domain projection ──

/**
 * Narrowed Lidarr system status projection.
 *
 * Only the fields surfaced by `rfmedia lidarr status` are modeled; the raw
 * `SystemResource` carries many more fields that the baseline command ignores.
 */
export interface LidarrSystemStatus {
  /** Lidarr application version string, e.g. "2.1.7.4030". */
  readonly version: string;
  /** Application name reported by the instance, e.g. "Lidarr". */
  readonly appName?: string;
  /** Operator-assigned instance name, when configured. */
  readonly instanceName?: string;
  /** Whether the instance reports a production build. */
  readonly isProduction?: boolean;
  /** Underlying .NET runtime version, when reported. */
  readonly runtimeVersion?: string;
}

// ── Artist domain projection ──

/**
 * Per-artist statistics consumed by status and list output.
 *
 * Present on most artists but optional because Lidarr may omit it for
 * freshly-added or unscanned artists.
 */
export interface LidarrArtistStatistics {
  /** Number of albums known for the artist. */
  readonly albumCount: number;
  /** Number of track files present on disk. */
  readonly trackFileCount: number;
  /** Number of tracks known across monitored albums. */
  readonly trackCount: number;
  /** Total track count including unmonitored albums, when reported. */
  readonly totalTrackCount?: number;
  /** Total size on disk in bytes. */
  readonly sizeOnDisk: number;
  /** Fraction of tracks present, expressed 0-100, when reported. */
  readonly percentOfTracks?: number;
}

/**
 * Narrowed Lidarr artist projection consumed by `list` and `status`.
 *
 * `foreignArtistId` is the MusicBrainz artist id — the canonical join key for
 * the future Plex-Lidarr bridge (#208+), carried here so later phases need no
 * schema change.
 */
export interface LidarrArtist {
  /** Lidarr-internal artist id. */
  readonly id: number;
  /** Display name of the artist. */
  readonly artistName: string;
  /** MusicBrainz artist id — canonical key for the future Plex-Lidarr bridge. */
  readonly foreignArtistId: string;
  /** Whether the artist is monitored for downloads. */
  readonly monitored: boolean;
  /**
   * Policy for monitoring newly discovered albums, when reported by Lidarr.
   *
   * List/status callers tolerate older sparse responses, while mutation
   * reconciliation treats omission as a policy mismatch.
   */
  readonly monitorNewItems?: "all" | "none" | "new";
  /** Quality profile id assigned to the artist. */
  readonly qualityProfileId: number;
  /** Metadata profile id assigned to the artist. */
  readonly metadataProfileId: number;
  /** Root-relative path on disk, when the artist has one. */
  readonly path?: string;
  /** Tag ids applied to the artist. */
  readonly tags: readonly number[];
  /** Aggregate statistics, when reported by the server. */
  readonly statistics?: LidarrArtistStatistics;
}

/**
 * Narrowed Lidarr root-folder projection used by artist-add planning.
 *
 * Generated capacity/default-profile fields remain private implementation
 * details; the stable facade exposes only identity, path, accessibility, and
 * optional free-space review context.
 */
export interface LidarrRootFolder {
  /** Lidarr-internal root-folder id. */
  readonly id: number;
  /** Exact filesystem path configured in Lidarr. */
  readonly path: string;
  /** Positive metadata-profile id configured as this root folder's default, when reported. */
  readonly defaultMetadataProfileId?: number;
  /** Whether Lidarr currently reports the path as accessible. */
  readonly accessible: boolean;
  /** Available bytes reported by Lidarr, when known. */
  readonly freeSpace?: number;
}

/**
 * Complete conservative policy for adding one MBID-backed artist.
 *
 * The literal policy fields prevent callers from requesting monitoring,
 * automatic new-item monitoring, or an immediate missing-album search.
 */
export interface LidarrArtistAddInput {
  /** Review-context name; authoritative write identity comes from Lidarr lookup. */
  readonly artistName: string;
  /** Canonical lowercase MusicBrainz artist UUID. */
  readonly foreignArtistId: string;
  /** Exact sealed root-folder path. */
  readonly rootFolderPath: string;
  /** Sealed positive quality-profile id. */
  readonly qualityProfileId: number;
  /** Sealed positive metadata-profile id. */
  readonly metadataProfileId: number;
  /** Resolved artist monitoring policy; omission resolves to `false` before this boundary. */
  readonly monitored: boolean;
  /** Newly discovered albums are never monitored automatically. */
  readonly monitorNewItems: "none";
  /** Artist creation never triggers a missing-album search. */
  readonly searchForMissingAlbums: false;
}

// ── Album domain projection ──

/**
 * Per-album statistics consumed by the album-monitoring plan lane.
 *
 * Every field is optional because Lidarr may omit the block, or individual
 * counts, for freshly-added or unscanned albums.
 */
export interface LidarrAlbumStatistics {
  /** Number of tracks known for the album, when reported. */
  readonly trackCount?: number;
  /** Number of track files present on disk, when reported. */
  readonly trackFileCount?: number;
  /** Total size on disk in bytes, when reported. */
  readonly sizeOnDisk?: number;
}

/**
 * Narrowed Lidarr album projection consumed by the album-monitoring plan lane.
 *
 * The boundary projector normalizes a null wire title to `""` and sanitizes
 * titles so plan-engine artifact validation can never reject a valid album.
 */
export interface LidarrAlbum {
  /** Lidarr-internal album id. */
  readonly id: number;
  /** Album title; `""` when Lidarr reports none. */
  readonly title: string;
  /** Owning Lidarr-internal artist id. */
  readonly artistId: number;
  /** Whether the album is monitored for downloads. */
  readonly monitored: boolean;
  /** Whether any release satisfies the album (release policy), when reported. */
  readonly anyReleaseOk?: boolean;
  /** Primary album type name, e.g. "Single", when reported. */
  readonly albumType?: string;
  /** Release date string as reported by Lidarr, when present. */
  readonly releaseDate?: string;
  /** MusicBrainz release-group id — wrong-target drift guard for album deletion. */
  readonly foreignAlbumId?: string;
  /** Secondary album type names; frozen, `[]` default. */
  readonly secondaryTypes: readonly string[];
  /** Aggregate statistics, when reported by the server. */
  readonly statistics?: LidarrAlbumStatistics;
}

/**
 * Intent for deleting one Lidarr album.
 *
 * Both flags are required by the type so callers must decide file deletion and
 * import-list exclusion explicitly; there is no implicit default.
 */
export interface LidarrAlbumDeleteInput {
  /** Whether to also delete the album's files on disk. */
  readonly deleteFiles: boolean;
  /** Whether to add an import-list exclusion so the album is not re-imported. */
  readonly addImportListExclusion: boolean;
}

// ── Profile and tag domain projections ──

/**
 * Narrowed Lidarr quality or metadata profile projection.
 *
 * The stable numeric id is authoritative; the name is bounded review context.
 * This type deliberately does not expose the generated profile DTOs.
 */
export interface LidarrProfile {
  /** Lidarr-internal profile id. */
  readonly id: number;
  /** Human-readable profile name. */
  readonly name: string;
}

/** Generated-independent album-type evidence carried by one metadata profile. */
export interface LidarrMetadataProfileAlbumType {
  /** Lidarr-internal album-type id. */
  readonly id: number;
  /** Human-readable primary or secondary album-type name. */
  readonly name: string;
  /** Whether this metadata profile permits the album type. */
  readonly allowed: boolean;
}

/**
 * Detailed metadata-profile projection used for structural artist-add defaults.
 *
 * Quality profiles retain the narrower {@link LidarrProfile} contract.
 */
export interface LidarrMetadataProfile extends LidarrProfile {
  /** Complete frozen primary album-type evidence reported for this profile. */
  readonly primaryAlbumTypes: readonly LidarrMetadataProfileAlbumType[];
  /** Complete frozen secondary album-type evidence reported for this profile. */
  readonly secondaryAlbumTypes: readonly LidarrMetadataProfileAlbumType[];
}

/**
 * Narrowed Lidarr tag projection.
 *
 * The stable numeric id is authoritative; the label is bounded review context.
 * This type deliberately does not expose the generated tag DTO.
 */
export interface LidarrTag {
  /** Lidarr-internal tag id. */
  readonly id: number;
  /** Human-readable tag label. */
  readonly label: string;
}

/**
 * Intent for assigning one or both supported profile dimensions to an artist.
 *
 * At least one profile id is required by the type, and unrelated artist editor
 * fields are intentionally unrepresentable.
 */
export type LidarrProfileAssignmentInput =
  | {
      /** Desired quality profile id. */
      readonly qualityProfileId: number;
      /** Desired metadata profile id, when assigning both dimensions. */
      readonly metadataProfileId?: number;
    }
  | {
      /** Quality profile is not managed by this assignment. */
      readonly qualityProfileId?: never;
      /** Desired metadata profile id. */
      readonly metadataProfileId: number;
    };

/** Supported one-artist tag mutation intents. */
export type LidarrTagMutationMode = "add" | "remove" | "set" | "clear";

/**
 * Intent for mutating one artist's tags.
 *
 * Runtime validation enforces non-empty tag ids for add/remove/set and an empty
 * list for clear. The facade maps this intent to the narrow Lidarr wire mode.
 */
export interface LidarrTagMutationInput {
  /** Requested tag-set operation. */
  readonly mode: LidarrTagMutationMode;
  /** Requested tag ids, normalized before transport. */
  readonly tagIds: readonly number[];
}

// ── Wanted/missing domain projection ──

/**
 * Minimal artist reference embedded in a wanted/missing record.
 */
export interface LidarrWantedArtistRef {
  /** Lidarr-internal artist id. */
  readonly id: number;
  /** Display name of the artist. */
  readonly artistName: string;
  /** MusicBrainz artist id, when reported. */
  readonly foreignArtistId?: string;
}

/**
 * A single wanted/missing album record.
 */
export interface LidarrWantedRecord {
  /** Album id. */
  readonly id: number;
  /** Album title. */
  readonly title: string;
  /** Owning artist reference. */
  readonly artist: LidarrWantedArtistRef;
  /** ISO release date, when known. */
  readonly releaseDate?: string;
  /** Whether the album is monitored. */
  readonly monitored: boolean;
}

/**
 * Command-facing wanted/missing page, independent from the wire paging model.
 */
export interface LidarrWantedPage {
  /** 1-based page number represented by this response. */
  readonly page: number;
  /** Page size requested for this response. */
  readonly pageSize: number;
  /** Total records available across all pages. */
  readonly totalRecords: number;
  /** Sort key applied by the server, when reported. */
  readonly sortKey?: string;
  /** Sort direction applied by the server, when reported. */
  readonly sortDirection?: string;
  /** Records contained in this page. */
  readonly records: readonly LidarrWantedRecord[];
}

// ── Health-check domain projection ──

/** Severity values accepted by the health command and its filters. */
export type LidarrHealthType = "ok" | "notice" | "warning" | "error";

/**
 * A single Lidarr health-check record.
 */
export interface LidarrHealthCheck {
  /** Source subsystem that produced the check, e.g. "IndexerStatusCheck". */
  readonly source: string;
  /** Severity of the check. */
  readonly type: LidarrHealthType;
  /** Human-readable description of the condition. */
  readonly message: string;
  /** Wiki URL with remediation guidance, when provided. */
  readonly wikiUrl?: string;
}

// ── Manual-import and trackfile domain projections ──

/** Read-only parameters accepted by Lidarr's manual-import probe. */
export interface LidarrManualImportProbeInput {
  /** Local folder visible to Lidarr. */
  readonly folder: string;
  /** Optional positive Lidarr artist anchor. */
  readonly artistId?: number;
  /** Whether Lidarr should suppress files it already knows about. */
  readonly filterExistingFiles?: boolean;
  /** Whether Lidarr should evaluate replacement candidates. */
  readonly replaceExistingFiles?: boolean;
  /** Optional caller abort signal. */
  readonly signal?: AbortSignal;
}

/** Minimal artist identity returned with a manual-import candidate. */
export interface LidarrManualImportArtist {
  readonly id?: number;
  readonly name?: string;
  readonly foreignArtistId?: string;
}

/** Minimal album identity returned with a manual-import candidate. */
export interface LidarrManualImportAlbum {
  readonly id?: number;
  readonly artistId?: number;
  readonly title?: string;
  readonly foreignAlbumId?: string;
}

/** Minimal track identity returned with a manual-import candidate. */
export interface LidarrManualImportTrack {
  readonly id?: number;
  readonly artistId?: number;
  readonly albumId?: number;
  readonly title?: string;
  readonly foreignTrackId?: string;
  readonly foreignRecordingId?: string;
  readonly mediumNumber?: number;
  readonly absoluteTrackNumber?: number;
}

/** Parsed tag evidence Lidarr used while evaluating a manual import. */
export interface LidarrManualImportAudioTags {
  readonly title?: string;
  readonly artistTitle?: string;
  readonly albumTitle?: string;
  readonly artistMbId?: string;
  readonly albumMbId?: string;
  readonly releaseMbId?: string;
  readonly recordingMbId?: string;
  readonly trackMbId?: string;
  readonly discNumber?: number;
  readonly trackNumbers: readonly number[];
}

/** One rejection attached to a manual-import candidate. */
export interface LidarrManualImportRejection {
  readonly reason: string;
  readonly type?: "permanent" | "temporary";
}

/** Strict command-facing result from Lidarr's manual-import probe. */
export interface LidarrManualImportCandidate {
  readonly id?: number;
  readonly path: string;
  readonly name?: string;
  readonly size?: number;
  readonly artist?: LidarrManualImportArtist;
  readonly album?: LidarrManualImportAlbum;
  readonly albumReleaseId?: number;
  readonly albumReleaseForeignId?: string;
  readonly tracks: readonly LidarrManualImportTrack[];
  readonly releaseGroup?: string;
  readonly rejections: readonly LidarrManualImportRejection[];
  readonly audioTags?: LidarrManualImportAudioTags;
  readonly additionalFile: boolean;
  readonly replaceExistingFiles: boolean;
}

/** Parent-scoped track projection used by retention planning. */
export interface LidarrTrack {
  readonly id: number;
  readonly artistId: number;
  readonly albumId: number;
  readonly title: string;
  readonly foreignTrackId?: string;
  readonly foreignRecordingId?: string;
  readonly trackFileId?: number;
  readonly absoluteTrackNumber?: number;
  readonly trackNumber?: string;
  readonly mediumNumber?: number;
  readonly hasFile: boolean;
}

/** Exact Lidarr-managed trackfile before-state used by planning and apply. */
export interface LidarrTrackFile {
  readonly id: number;
  readonly artistId: number;
  readonly albumId: number;
  readonly path: string;
  readonly size: number;
  readonly dateAdded?: string;
}
