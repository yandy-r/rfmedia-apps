/**
 * Provider-neutral media server domain and capability contracts.
 *
 * Provider wire types, persistence rows, authentication details, and local
 * filesystem checks must be mapped outside this boundary.
 */

import type { MediaFilter, MediaFilterField, MediaFilterOperator } from "./media-filters.js";

/** Identifier for a media server implementation. */
export type MediaServerType = string;

/** Supported music entity kinds at the generic adapter boundary. */
export type MediaKind = "track" | "album" | "artist";

/** Maximum UTF-8 bytes accepted for a projected identity-local identifier. */
export const MEDIA_IDENTITY_MAX_ID_BYTES = 1_024;

/** Maximum UTF-8 bytes accepted for a projected artist identity title. */
export const MEDIA_IDENTITY_MAX_TITLE_BYTES = 2_048;

/** Maximum external identity records accepted for one projected artist. */
export const MEDIA_IDENTITY_MAX_EXTERNAL_IDS = 32;

/** Maximum UTF-8 bytes accepted for one external identity value. */
export const MEDIA_IDENTITY_MAX_EXTERNAL_ID_BYTES = 1_024;

/** Maximum artist identity records requested in one provider page. */
export const MEDIA_IDENTITY_MAX_PAGE_SIZE = 1_000;

/**
 * A normalized media rating.
 *
 * Runtime producers and consumers must validate that non-null values are
 * finite numbers in the closed interval from 0 to 1.
 */
export type NormalizedMediaRating = number;

/** Fields shared by all generic media entities. */
export interface MediaEntityBase {
  /** Opaque provider-owned identifier. */
  readonly id: string;
  /** Entity discriminator. */
  readonly kind: MediaKind;
  /** Display title. */
  readonly title: string;
  /** Normalized rating, or null when the entity is unrated. */
  readonly rating: NormalizedMediaRating | null;
  /** Release year when supplied by the server. */
  readonly year?: number;
  /** Genre tags when supplied by the server. */
  readonly genres?: readonly string[];
  /** Style tags when supplied by the server. */
  readonly styles?: readonly string[];
  /** Mood tags when supplied by the server. */
  readonly moods?: readonly string[];
}

/** Generic track metadata. */
export interface MediaTrack extends MediaEntityBase {
  readonly kind: "track";
  readonly artist: string;
  readonly album: string;
  readonly playCount: number;
  /** Whole epoch seconds for the latest view reported by the media server. */
  readonly lastViewedAt?: number;
  readonly durationMs: number;
  readonly filePath: string;
}

/** Generic album metadata. */
export interface MediaAlbum extends MediaEntityBase {
  readonly kind: "album";
  readonly artist: string;
  readonly trackCount: number;
  readonly artworkPath?: string;
}

/** Generic artist metadata. */
export interface MediaArtist extends MediaEntityBase {
  readonly kind: "artist";
  readonly albumCount: number;
  readonly artworkPath?: string;
}

/** Any generic music entity returned by an adapter. */
export type MediaItem = MediaTrack | MediaAlbum | MediaArtist;

/** Provider-neutral query pagination inputs. */
export interface MediaQueryOptions {
  /** Library name or opaque library identifier understood by the adapter. */
  readonly library: string;
  /** Maximum number of server results requested for this page. */
  readonly limit?: number;
  /** Zero-based server offset requested for this page. */
  readonly offset?: number;
  /** Provider-neutral filter expression for pushdown and residual evaluation. */
  readonly filter?: MediaFilter;
  /** Optional caller cancellation signal; never part of query cache identity. */
  readonly signal?: AbortSignal;
}

/** Inputs for an exact, uncached track identity lookup. */
export interface MediaTrackLookupOptions {
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Inputs for an uncached media-library content-version lookup. */
export interface MediaLibraryContentVersionOptions {
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/**
 * Opaque provider evidence that identifies one library content generation.
 *
 * `value` must change whenever membership or path identity in the selected
 * library changes. Consumers compare it for equality and must not interpret it.
 */
export interface MediaLibraryContentVersion {
  /** Stable provider-owned library identifier. */
  readonly libraryId: string;
  /** Opaque provider-owned content generation. */
  readonly value: string;
}

/** A response-driven page of generic media entities. */
export interface MediaPage<T extends MediaItem> {
  readonly items: readonly T[];
  /** Total reported by the server or compatibility projection. */
  readonly total: number;
  /** Offset represented by this response. */
  readonly offset: number;
  /** Server-returned item count before residual filtering. */
  readonly returned: number;
  /** Whether the server indicates that another page may be available. */
  readonly hasMore: boolean;
}

/**
 * Bounded external artist identity evidence.
 *
 * Values are intentionally not declared canonical here. The artist bridge
 * validates MusicBrainz UUID semantics after provider wire projection.
 */
export interface MediaArtistExternalIdentity {
  readonly namespace: "musicbrainz";
  readonly kind: "artist";
  readonly value: string;
}

/** Provider-neutral artist identity used by bridge consumers. */
export interface MediaArtistIdentity {
  /** Opaque provider-owned artist identifier. */
  readonly id: string;
  readonly kind: "artist";
  /** Bounded terminal-safe display title. */
  readonly title: string;
  /** Bounded MusicBrainz artist evidence projected by the provider adapter. */
  readonly externalIds: readonly MediaArtistExternalIdentity[];
}

/** A response-driven page of provider-neutral artist identities. */
export interface MediaIdentityPage {
  /** Stable resolved provider library section identifier. */
  readonly libraryId: string;
  readonly items: readonly MediaArtistIdentity[];
  /** Total reported by the server or compatibility projection. */
  readonly total: number;
  /** Offset represented by this response. */
  readonly offset: number;
  /** Server-returned item count. */
  readonly returned: number;
  /** Whether the server indicates that another page may be available. */
  readonly hasMore: boolean;
}

/** Provider-neutral artist identity pagination inputs. */
export interface MediaIdentityListArtistsOptions {
  /** Configured name or opaque identifier understood by the adapter. */
  readonly library: string;
  /** Maximum number of provider results requested for this page. */
  readonly limit?: number;
  /** Zero-based provider offset requested for this page. */
  readonly offset?: number;
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal;
}

/** Optional identity capability surface for media server adapters. */
export interface MediaServerIdentityCapability {
  /** Return a stable opaque provider-instance identifier, never a credential. */
  getInstanceId(options?: { readonly signal?: AbortSignal }): Promise<string>;
  /** List projected artists from one resolved provider library section. */
  listArtists(options: MediaIdentityListArtistsOptions): Promise<MediaIdentityPage>;
}

/** Generic media library metadata. */
export interface MediaServerLibrary {
  /** Opaque provider-owned library identifier. */
  readonly id: string;
  readonly title: string;
  /** Primary media kind exposed by the library. */
  readonly kind: MediaKind;
}

/** Generic playlist metadata. */
export interface MediaPlaylist {
  /** Opaque provider-owned playlist identifier. */
  readonly id: string;
  readonly title: string;
  readonly smart: boolean;
  readonly itemCount: number;
  readonly durationMs: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/** Generic collection metadata. */
export interface MediaCollection {
  /** Opaque provider-owned collection identifier. */
  readonly id: string;
  readonly title: string;
  /** Kind of item accepted by this collection. */
  readonly kind: MediaKind;
  readonly itemCount: number;
  readonly smart: boolean;
}

/** Provider-neutral collection creation input. */
export interface MediaCollectionCreateInput {
  readonly title: string;
  readonly kind: MediaKind;
}

/** Result for scan operations, which intentionally do not throw. */
export interface MediaServerScanResult {
  readonly success: boolean;
  readonly message: string;
  readonly statusCode?: number;
  readonly libraryName?: string;
}

/** Result for rating updates, which intentionally do not throw. */
export interface MediaServerRatingUpdateResult {
  readonly success: boolean;
  readonly message: string;
  readonly statusCode?: number;
}

/** Coarse capability flags exposed by a media server adapter. */
export interface MediaServerCapabilities {
  readonly query: boolean;
  readonly library: boolean;
  readonly scan: boolean;
  readonly playlist: boolean;
  readonly collection: boolean;
  readonly metadata: boolean;
}

/** Native rating scale information for compatibility presentation. */
export interface MediaServerNativeRatingScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** Rating behavior implemented by an adapter. */
export interface MediaServerRatingFeatures {
  readonly readable: boolean;
  readonly writable: boolean;
  /** Generic reads and writes always use the normalized scale. */
  readonly normalized: true;
  /** Provider-native scale for compatibility projection and diagnostics. */
  readonly nativeScale: MediaServerNativeRatingScale;
}

/** Describes which generic filter concepts can be pushed to the server. */
export interface MediaServerFilterPushdownFeatures {
  readonly supported: boolean;
  readonly fields: readonly MediaFilterField[];
  readonly operators: readonly MediaFilterOperator[];
}

/** Availability values for server- or entitlement-dependent features. */
export type MediaServerFeatureAvailability = "available" | "unavailable" | "server-dependent";

/** Semantic feature metadata exposed by an adapter. */
export interface MediaServerFeatures {
  readonly ratings: MediaServerRatingFeatures;
  readonly smartPlaylists: boolean;
  readonly smartCollections: boolean;
  readonly pathScopedScans: boolean;
  readonly filterPushdown: MediaServerFilterPushdownFeatures;
  readonly sonicAnalysis: MediaServerFeatureAvailability;
}

/** Stable reason codes for media server failures. */
export type MediaServerErrorCode =
  | "configuration"
  | "authentication"
  | "authorization"
  | "not-found"
  | "unsupported"
  | "rate-limited"
  | "timeout"
  | "network"
  | "invalid-response"
  | "request-failed";

/** Structured context required to construct a media server error. */
export interface MediaServerErrorOptions {
  readonly code: MediaServerErrorCode;
  readonly serverType: MediaServerType;
  readonly operation: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  /**
   * Server-advertised cooperative wait in seconds, parsed from a `Retry-After`
   * response header. Present only when the server supplied a usable value; it is
   * advisory metadata, never a substitute for {@link MediaServerErrorOptions.retryable}.
   */
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/**
 * Typed failure raised by query and CRUD capabilities.
 *
 * Provider clients must sanitize messages and causes before they cross this
 * boundary; credentials and raw response bodies do not belong in this type.
 */
export class MediaServerError extends Error {
  override readonly name = "MediaServerError";
  readonly code: MediaServerErrorCode;
  readonly serverType: MediaServerType;
  readonly operation: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  /** Server-advertised cooperative wait in seconds, when the response supplied one. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: MediaServerErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.serverType = options.serverType;
    this.operation = options.operation;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Query capability surface for media server adapters. */
export interface MediaServerQueryCapability {
  /**
   * Fetch the current library content generation without consulting a response cache.
   *
   * Implementations must change the returned value whenever library membership
   * or a member's path identity changes.
   */
  libraryContentVersion(
    library: string,
    options?: MediaLibraryContentVersionOptions,
  ): Promise<MediaLibraryContentVersion>;
  /**
   * Fetch one track by its provider-owned identifier.
   *
   * Implementations must bypass response caches so callers can use the result
   * as current pre-mutation identity and metadata evidence.
   */
  trackById(trackId: string, options?: MediaTrackLookupOptions): Promise<MediaTrack>;
  tracks(options: MediaQueryOptions & { readonly kind: "track" }): Promise<MediaPage<MediaTrack>>;
  albums(options: MediaQueryOptions & { readonly kind: "album" }): Promise<MediaPage<MediaAlbum>>;
  artists(
    options: MediaQueryOptions & { readonly kind: "artist" },
  ): Promise<MediaPage<MediaArtist>>;
  albumTracks(albumId: string): Promise<readonly MediaTrack[]>;
}

/** Library capability surface for media server adapters. */
export interface MediaServerLibraryCapability {
  list(): Promise<readonly MediaServerLibrary[]>;
  byName(name: string): Promise<MediaServerLibrary>;
}

/** Scan capability surface for media server adapters. */
export interface MediaServerScanCapability {
  trigger(): Promise<MediaServerScanResult>;
  triggerPath(libraryId: string, scanPath: string): Promise<MediaServerScanResult>;
  triggerSource(destinationPath: string): Promise<MediaServerScanResult>;
}

/** Playlist capability surface for media server adapters. */
export interface MediaServerPlaylistCapability {
  list(): Promise<readonly MediaPlaylist[]>;
  byName(name: string): Promise<MediaPlaylist>;
  delete(id: string): Promise<void>;
  tracks(id: string): Promise<readonly MediaTrack[]>;
  create(name: string, options?: { readonly smart?: boolean }): Promise<MediaPlaylist>;
  addTracks(id: string, trackIds: readonly string[]): Promise<void>;
}

/** Collection capability surface for media server adapters. */
export interface MediaServerCollectionCapability {
  list(libraryId: string): Promise<readonly MediaCollection[]>;
  get(id: string): Promise<MediaCollection>;
  byName(libraryId: string, name: string): Promise<MediaCollection>;
  items(id: string): Promise<readonly MediaItem[]>;
  create(libraryId: string, input: MediaCollectionCreateInput): Promise<MediaCollection>;
  addItems(id: string, itemIds: readonly string[]): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Metadata update capability surface for media server adapters. */
export interface MediaServerMetadataCapability {
  updateTrackRating(
    trackId: string,
    rating: NormalizedMediaRating | null,
  ): Promise<MediaServerRatingUpdateResult>;
}

/**
 * Capability-oriented adapter contract consumed by actions.
 *
 * Query and CRUD methods throw {@link MediaServerError} on failure. Scan and
 * rating update methods return result objects to preserve best-effort action
 * behavior.
 */
export interface MediaServerAdapter {
  readonly type: MediaServerType;
  readonly capabilities: MediaServerCapabilities;
  readonly features: MediaServerFeatures;
  readonly query: MediaServerQueryCapability;
  readonly library: MediaServerLibraryCapability;
  readonly scan: MediaServerScanCapability;
  readonly playlist: MediaServerPlaylistCapability;
  readonly collection: MediaServerCollectionCapability;
  readonly metadata: MediaServerMetadataCapability;
  /** Optional provider-neutral identity evidence for bridge consumers. */
  readonly identity?: MediaServerIdentityCapability;
}
