/**
 * Private Plex connection, transport, cache, and consumed-wire contracts.
 *
 * These types are implementation details of {@link ../plex-adapter.ts} and
 * must not be re-exported from the package's public type barrel.
 */

import {
  MEDIA_IDENTITY_MAX_EXTERNAL_IDS,
  MEDIA_IDENTITY_MAX_EXTERNAL_ID_BYTES,
  MEDIA_IDENTITY_MAX_ID_BYTES,
  MEDIA_IDENTITY_MAX_PAGE_SIZE,
  MEDIA_IDENTITY_MAX_TITLE_BYTES,
} from "../../../types/media-server.js";
import {
  createRotatingPlexCredentialCell,
  createStaticPlexCredentialCell,
  readPlexCredentialCell,
  type PlexCredentialCell,
} from "./credential-cell.js";

/** Plex music metadata type codes used by the PMS API. */
export const PLEX_METADATA_TYPE_CODES = Object.freeze({
  artist: 8,
  album: 9,
  track: 10,
} as const);

/** A supported Plex music metadata type code. */
export type PlexMetadataTypeCode =
  (typeof PLEX_METADATA_TYPE_CODES)[keyof typeof PLEX_METADATA_TYPE_CODES];

/** HTTP methods used by the private Plex transport. */
export type PlexHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Values accepted by the private transport's structured query builder. */
export type PlexQueryValue = string | number | boolean | undefined;

/** Immutable request options accepted by the private Plex transport. */
export interface PlexRequestOptions {
  readonly method?: PlexHttpMethod;
  readonly query?: Readonly<Record<string, PlexQueryValue>>;
  readonly signal?: AbortSignal;
}

/** A relative, operation-labelled request passed to the private transport. */
export interface PlexRequestInput {
  readonly path: string;
  readonly operation: string;
  readonly options?: PlexRequestOptions;
  /**
   * Explicit replay intent for authentication recovery and retry advice.
   *
   * The HTTP verb is not the intent: several scan triggers are transported as
   * `GET` yet mutate server state, so they must never be replayed. Declared at
   * the top level rather than inside {@link PlexRequestOptions} because many
   * read sites omit `options` entirely. Defaults to the verb heuristic when
   * absent.
   */
  readonly replayable?: boolean;
}

/** Captured cache settings for one adapter instance. */
export interface PlexCacheSettings {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
}

/** Bounded resource categories eligible for adapter-local caching. */
export type PlexCacheCategory = "identity" | "libraries" | "queries" | "playlists" | "collections";

/** Captured request policy for one adapter instance. */
export interface PlexRequestSettings {
  readonly timeoutMs: number;
  readonly delayMs: number;
}

/** Non-secret connection input accepted by diagnostics. */
export interface PlexConnectionLogContext {
  readonly origin: string;
  readonly clientIdentifier: string;
  readonly cache: PlexCacheSettings;
  readonly request: PlexRequestSettings;
}

/** Input used to construct an origin-bound private connection. */
export interface PlexConnectionInput {
  /** Canonical URL origin, for example `http://localhost:32400`. */
  readonly origin: string;
  /** Opaque legacy token or pre-issued JWT. */
  readonly token: string;
  /** Stable, non-secret Plex client identity. */
  readonly clientIdentifier: string;
  readonly cache?: Partial<PlexCacheSettings>;
  readonly request?: Partial<PlexRequestSettings>;
}

const credentialBindings = new WeakMap<PlexConnectionSettings, PlexCredentialCell>();

/**
 * Immutable connection state for one Plex adapter.
 *
 * Credentials live in a module-private `WeakMap`, never on this object. They
 * are therefore absent from reflection, object spread, logs, and serialization.
 */
export interface PlexConnectionSettings extends PlexConnectionLogContext {}

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_DELAY_MS = 100;
const MAX_ISO_EPOCH_SECONDS = 8_640_000_000_000;

/**
 * Tests whether a value is one of Plex's supported music metadata codes.
 *
 * @param value - Candidate numeric value.
 * @returns True for artist (8), album (9), or track (10).
 */
export function isPlexMetadataTypeCode(value: unknown): value is PlexMetadataTypeCode {
  return value === 8 || value === 9 || value === 10;
}

/** Builds the credential box a freshly created connection is bound to. */
type PlexCredentialCellFactory = (origin: string, token: string) => PlexCredentialCell;

function buildPlexConnectionSettings(
  input: PlexConnectionInput,
  createCell: PlexCredentialCellFactory,
): PlexConnectionSettings {
  let parsed: URL;
  try {
    parsed = new URL(input.origin);
  } catch {
    throw new TypeError("Plex connection origin must be a normalized HTTP(S) origin");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.origin !== input.origin ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("Plex connection origin must be a normalized HTTP(S) origin");
  }

  const cache = Object.freeze({
    enabled: input.cache?.enabled ?? false,
    ttlSeconds: input.cache?.ttlSeconds ?? DEFAULT_CACHE_TTL_SECONDS,
  });
  const request = Object.freeze({
    timeoutMs: input.request?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    delayMs: input.request?.delayMs ?? DEFAULT_REQUEST_DELAY_MS,
  });
  const connection: PlexConnectionSettings = Object.freeze({
    origin: input.origin,
    clientIdentifier: input.clientIdentifier,
    cache,
    request,
  });
  credentialBindings.set(connection, createCell(input.origin, input.token));
  return connection;
}

/**
 * Creates immutable connection state from an already-normalized HTTP origin.
 *
 * The credential is bound to a non-rotatable cell, so a configured legacy token
 * or a caller-supplied JWT can never be replaced in place.
 *
 * Credential content is deliberately not parsed. Empty/control-character
 * validation and token lifecycle behavior belong to the token provider.
 *
 * @param input - Canonical origin, opaque credential, and captured settings.
 * @returns Frozen private connection state.
 * @throws TypeError when `origin` is not a canonical HTTP(S) origin.
 */
export function createPlexConnectionSettings(input: PlexConnectionInput): PlexConnectionSettings {
  return buildPlexConnectionSettings(input, createStaticPlexCredentialCell);
}

/**
 * Creates connection state whose credential may be refreshed in place.
 *
 * Used only for enrolled installs, where the JWT provider swaps in a rotated
 * credential without rebuilding the connection or the adapter. Everything else
 * — origin validation, freezing, and the credential guard — is identical to
 * {@link createPlexConnectionSettings}, so both credential sources terminate at
 * {@link getPlexConnectionToken}.
 *
 * @param input - Canonical origin, currently issued JWT, and captured settings.
 * @returns Frozen private connection state bound to a rotatable credential cell.
 * @throws TypeError when `origin` is not a canonical HTTP(S) origin.
 */
export function createPlexRotatingConnectionSettings(
  input: PlexConnectionInput,
): PlexConnectionSettings {
  return buildPlexConnectionSettings(input, createRotatingPlexCredentialCell);
}

/**
 * Reads the opaque credential only for its bound canonical origin.
 *
 * @param connection - Private connection state.
 * @param requestOrigin - Canonical origin of the pending request.
 * @returns The unchanged opaque credential.
 * @throws TypeError when the request origin differs from the bound origin, or
 *   when the credential is empty or contains a control character.
 */
export function getPlexConnectionToken(
  connection: PlexConnectionSettings,
  requestOrigin: string,
): string {
  const cell = credentialBindings.get(connection);
  if (cell === undefined) {
    throw new TypeError("Plex connection credential is unavailable");
  }
  if (requestOrigin !== connection.origin) {
    throw new TypeError("Plex credential cannot be used for a different origin");
  }
  return readPlexCredentialCell(cell, requestOrigin);
}

/**
 * Returns the credential cell a connection is bound to.
 *
 * The cell holds no enumerable credential, so handing it out discloses nothing;
 * reading or rotating it still requires the bound origin. This is the seam the
 * rotating JWT provider uses to install a refreshed credential, which is why
 * both providers keep terminating at {@link getPlexConnectionToken}.
 *
 * @param connection - Private connection state.
 * @returns The origin-bound credential box.
 * @throws TypeError when the connection has no bound credential.
 */
export function getPlexConnectionCredentialCell(
  connection: PlexConnectionSettings,
): PlexCredentialCell {
  const cell = credentialBindings.get(connection);
  if (cell === undefined) {
    throw new TypeError("Plex connection credential is unavailable");
  }
  return cell;
}

/**
 * Projects connection state to an explicitly secret-free log shape.
 *
 * @param connection - Private connection state.
 * @returns Frozen fields safe for structured diagnostics.
 */
export function toPlexConnectionLogContext(
  connection: PlexConnectionSettings,
): PlexConnectionLogContext {
  return Object.freeze({
    origin: connection.origin,
    clientIdentifier: connection.clientIdentifier,
    cache: connection.cache,
    request: connection.request,
  });
}

/** A Plex tag object consumed from `Style` or `Mood`. */
export interface PlexWireTag {
  readonly tag: string;
}

/** A consumed Plex media part. */
export interface PlexWirePart {
  readonly file?: string;
}

/** A consumed Plex media record. */
export interface PlexWireMedia {
  readonly Part?: readonly PlexWirePart[];
}

/** Consumed wire fields for a Plex track. */
export interface PlexWireTrack {
  readonly ratingKey: string;
  readonly title: string;
  readonly grandparentTitle?: string;
  readonly parentTitle?: string;
  readonly userRating?: number;
  readonly viewCount?: number;
  /** Whole Plex epoch seconds visible to the resolved credential. */
  readonly lastViewedAt?: number;
  readonly duration?: number;
  readonly year?: number;
  readonly Mood?: readonly PlexWireTag[];
  readonly Media?: readonly PlexWireMedia[];
}

/** Consumed wire fields for a Plex album. */
export interface PlexWireAlbum {
  readonly ratingKey: string;
  readonly title: string;
  readonly parentTitle?: string;
  readonly userRating?: number;
  readonly year?: number;
  readonly leafCount?: number;
  readonly thumb?: string;
  readonly Style?: readonly PlexWireTag[];
  readonly Mood?: readonly PlexWireTag[];
}

/** Consumed wire fields for a Plex artist. */
export interface PlexWireArtist {
  readonly ratingKey: string;
  readonly title: string;
  readonly userRating?: number;
  readonly childCount?: number;
  readonly thumb?: string;
  readonly Style?: readonly PlexWireTag[];
  readonly Mood?: readonly PlexWireTag[];
}

/** One bounded external GUID consumed only by the private identity family. */
export interface PlexWireGuid {
  readonly id: string;
}

/** Consumed wire fields for a Plex artist identity record. */
export interface PlexWireArtistIdentity {
  readonly ratingKey: string;
  readonly title: string;
  readonly Guid?: readonly PlexWireGuid[];
}

/** Consumed wire fields for a Plex library section. */
export interface PlexWireLibrary {
  readonly key: string;
  readonly title: string;
  readonly type: string;
  /** Stable section identity used only by uncached content-version checks. */
  readonly uuid?: string;
  /**
   * Plex database ChangeStamp for this section.
   *
   * Plex increments this value whenever the section's content changes.
   */
  readonly contentChangedAt?: number;
}

/** Consumed wire fields for a Plex playlist. */
export interface PlexWirePlaylist {
  readonly ratingKey: string;
  readonly title: string;
  readonly smart?: boolean;
  readonly leafCount?: number;
  readonly duration?: number;
  readonly addedAt?: number;
  readonly updatedAt?: number;
  readonly playlistType?: string;
}

/** Consumed wire fields for a Plex collection. */
export interface PlexWireCollection {
  readonly ratingKey: string;
  readonly key?: string;
  readonly title: string;
  readonly childCount?: number;
  readonly smart?: boolean;
  readonly summary?: string;
  readonly addedAt?: number;
  readonly updatedAt?: number;
  readonly thumb?: string;
  readonly subtype?: string;
  readonly metadataType?: number;
}

/** Consumed wire fields for an item returned by a collection. */
export interface PlexWireCollectionItem extends PlexWireTrack {
  readonly type?: string;
  readonly leafCount?: number;
  readonly thumb?: string;
}

/** A metadata-bearing Plex `MediaContainer` response. */
export interface PlexWireMetadataResponse<T> {
  readonly MediaContainer: {
    readonly size?: number;
    readonly totalSize?: number;
    readonly offset?: number;
    readonly Metadata?: readonly T[];
  };
}

/** Bounded artist-identity response consumed only by the private identity family. */
export type PlexWireArtistIdentityResponse = PlexWireMetadataResponse<PlexWireArtistIdentity>;

/** Plex server-root response fields consumed for identity. */
export interface PlexWireServerResponse {
  readonly MediaContainer: {
    readonly machineIdentifier: string;
    readonly version?: string;
    readonly friendlyName?: string;
  };
}

/** Plex library-list response fields consumed by the adapter. */
export interface PlexWireLibraryResponse {
  readonly MediaContainer: {
    readonly Directory: readonly PlexWireLibrary[];
  };
}

type UnknownRecord = Record<string, unknown>;

const UNSAFE_IDENTITY_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isBoundedIdentityText(
  value: unknown,
  maximumBytes: number,
  requireNonEmpty: boolean,
): value is string {
  return (
    typeof value === "string" &&
    (!requireNonEmpty || (value.length > 0 && value.trim().length > 0)) &&
    utf8Bytes(value) <= maximumBytes &&
    !UNSAFE_IDENTITY_TEXT_PATTERN.test(value)
  );
}

function hasOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function hasOptionalNonEmptyString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || (typeof record[key] === "string" && record[key].length > 0);
}

function hasOptionalBoolean(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function hasOptionalFiniteNumber(record: UnknownRecord, key: string): boolean {
  return (
    record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key]))
  );
}

function hasOptionalIsoEpochSecond(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_ISO_EPOCH_SECONDS)
  );
}

function hasConsistentOptionalLastViewedAt(record: UnknownRecord): boolean {
  if (!hasOptionalIsoEpochSecond(record, "lastViewedAt")) {
    return false;
  }
  if (record["lastViewedAt"] === undefined) {
    return true;
  }
  const viewCount = record["viewCount"];
  return typeof viewCount === "number" && Number.isFinite(viewCount) && viewCount > 0;
}

function isTagArray(value: unknown): value is readonly PlexWireTag[] {
  return (
    Array.isArray(value) && value.every((item) => isRecord(item) && typeof item["tag"] === "string")
  );
}

function hasOptionalTagArray(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || isTagArray(record[key]);
}

function isMediaArray(value: unknown): value is readonly PlexWireMedia[] {
  return (
    Array.isArray(value) &&
    value.every(
      (media) =>
        isRecord(media) &&
        (media["Part"] === undefined ||
          (Array.isArray(media["Part"]) &&
            media["Part"].every((part) => isRecord(part) && hasOptionalString(part, "file")))),
    )
  );
}

function hasRequiredIdentity(record: UnknownRecord): boolean {
  return (
    typeof record["ratingKey"] === "string" &&
    record["ratingKey"].length > 0 &&
    typeof record["title"] === "string"
  );
}

function hasCommonTrackFields(record: UnknownRecord): boolean {
  return (
    hasRequiredIdentity(record) &&
    hasOptionalString(record, "grandparentTitle") &&
    hasOptionalString(record, "parentTitle") &&
    hasOptionalFiniteNumber(record, "userRating") &&
    hasOptionalFiniteNumber(record, "viewCount") &&
    hasConsistentOptionalLastViewedAt(record) &&
    hasOptionalFiniteNumber(record, "duration") &&
    hasOptionalFiniteNumber(record, "year") &&
    hasOptionalTagArray(record, "Mood") &&
    (record["Media"] === undefined || isMediaArray(record["Media"]))
  );
}

/**
 * Validates the Plex track fields consumed by mappers.
 *
 * @param value - Unknown wire value.
 * @returns True when required and present optional fields have valid types.
 */
export function isPlexWireTrack(value: unknown): value is PlexWireTrack {
  return isRecord(value) && hasCommonTrackFields(value);
}

/**
 * Validates the Plex album fields consumed by mappers.
 *
 * @param value - Unknown wire value.
 * @returns True when required and present optional fields have valid types.
 */
export function isPlexWireAlbum(value: unknown): value is PlexWireAlbum {
  return (
    isRecord(value) &&
    hasRequiredIdentity(value) &&
    hasOptionalString(value, "parentTitle") &&
    hasOptionalFiniteNumber(value, "userRating") &&
    hasOptionalFiniteNumber(value, "year") &&
    hasOptionalFiniteNumber(value, "leafCount") &&
    hasOptionalString(value, "thumb") &&
    hasOptionalTagArray(value, "Style") &&
    hasOptionalTagArray(value, "Mood")
  );
}

/**
 * Validates the Plex artist fields consumed by mappers.
 *
 * @param value - Unknown wire value.
 * @returns True when required and present optional fields have valid types.
 */
export function isPlexWireArtist(value: unknown): value is PlexWireArtist {
  return (
    isRecord(value) &&
    hasRequiredIdentity(value) &&
    hasOptionalFiniteNumber(value, "userRating") &&
    hasOptionalFiniteNumber(value, "childCount") &&
    hasOptionalString(value, "thumb") &&
    hasOptionalTagArray(value, "Style") &&
    hasOptionalTagArray(value, "Mood")
  );
}

/**
 * Validates one bounded external GUID object consumed by identity acquisition.
 *
 * Provider recognition intentionally belongs to the projector. The guard
 * bounds every provider value before an unknown provider can be ignored.
 */
export function isPlexWireGuid(value: unknown): value is PlexWireGuid {
  return (
    isRecord(value) &&
    isBoundedIdentityText(value["id"], MEDIA_IDENTITY_MAX_EXTERNAL_ID_BYTES, true)
  );
}

/**
 * Validates a bounded artist identity record without widening ordinary query DTOs.
 */
export function isPlexWireArtistIdentity(value: unknown): value is PlexWireArtistIdentity {
  if (
    !isRecord(value) ||
    !isBoundedIdentityText(value["ratingKey"], MEDIA_IDENTITY_MAX_ID_BYTES, true) ||
    !isBoundedIdentityText(value["title"], MEDIA_IDENTITY_MAX_TITLE_BYTES, true)
  ) {
    return false;
  }

  const guids = value["Guid"];
  return (
    guids === undefined ||
    (Array.isArray(guids) &&
      guids.length <= MEDIA_IDENTITY_MAX_EXTERNAL_IDS &&
      guids.every(isPlexWireGuid))
  );
}

/**
 * Validates a consumed Plex library record.
 *
 * @param value - Unknown wire value.
 * @returns True when key, title, and type are strings.
 */
export function isPlexWireLibrary(value: unknown): value is PlexWireLibrary {
  return (
    isRecord(value) &&
    typeof value["key"] === "string" &&
    value["key"].length > 0 &&
    typeof value["title"] === "string" &&
    typeof value["type"] === "string" &&
    (value["uuid"] === undefined ||
      (typeof value["uuid"] === "string" && value["uuid"].length > 0)) &&
    (value["contentChangedAt"] === undefined ||
      (typeof value["contentChangedAt"] === "number" &&
        Number.isSafeInteger(value["contentChangedAt"]) &&
        value["contentChangedAt"] >= 0))
  );
}

/**
 * Validates a consumed Plex playlist record.
 *
 * @param value - Unknown wire value.
 * @returns True when required and present optional fields have valid types.
 */
export function isPlexWirePlaylist(value: unknown): value is PlexWirePlaylist {
  return (
    isRecord(value) &&
    hasRequiredIdentity(value) &&
    hasOptionalBoolean(value, "smart") &&
    hasOptionalFiniteNumber(value, "leafCount") &&
    hasOptionalFiniteNumber(value, "duration") &&
    hasOptionalFiniteNumber(value, "addedAt") &&
    hasOptionalFiniteNumber(value, "updatedAt") &&
    hasOptionalString(value, "playlistType")
  );
}

/**
 * Validates a consumed Plex collection record.
 *
 * @param value - Unknown wire value.
 * @returns True when required and present optional fields have valid types.
 */
export function isPlexWireCollection(value: unknown): value is PlexWireCollection {
  return (
    isRecord(value) &&
    hasRequiredIdentity(value) &&
    hasOptionalNonEmptyString(value, "key") &&
    hasOptionalFiniteNumber(value, "childCount") &&
    hasOptionalBoolean(value, "smart") &&
    hasOptionalString(value, "summary") &&
    hasOptionalFiniteNumber(value, "addedAt") &&
    hasOptionalFiniteNumber(value, "updatedAt") &&
    hasOptionalString(value, "thumb") &&
    hasOptionalString(value, "subtype") &&
    hasOptionalFiniteNumber(value, "metadataType")
  );
}

/**
 * Validates a consumed collection-child record.
 *
 * @param value - Unknown wire value.
 * @returns True when track/common fields and collection discriminators are valid.
 */
export function isPlexWireCollectionItem(value: unknown): value is PlexWireCollectionItem {
  return (
    isRecord(value) &&
    hasCommonTrackFields(value) &&
    hasOptionalString(value, "type") &&
    hasOptionalFiniteNumber(value, "leafCount") &&
    hasOptionalString(value, "thumb")
  );
}

function hasOptionalPageNumber(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

/**
 * Validates a metadata `MediaContainer` and every present metadata item.
 *
 * @param value - Unknown response body.
 * @param itemGuard - Guard for the endpoint-specific metadata shape.
 * @returns True when the consumed container and item fields are valid.
 */
export function isPlexWireMetadataResponse<T>(
  value: unknown,
  itemGuard: (item: unknown) => item is T,
): value is PlexWireMetadataResponse<T> {
  if (!isRecord(value) || !isRecord(value["MediaContainer"])) {
    return false;
  }
  const container = value["MediaContainer"];
  return (
    hasOptionalPageNumber(container, "size") &&
    hasOptionalPageNumber(container, "totalSize") &&
    hasOptionalPageNumber(container, "offset") &&
    (container["Metadata"] === undefined ||
      (Array.isArray(container["Metadata"]) && container["Metadata"].every(itemGuard)))
  );
}

/**
 * Validates the bounded response envelope used for artist identity acquisition.
 */
export function isPlexWireArtistIdentityResponse(
  value: unknown,
): value is PlexWireArtistIdentityResponse {
  if (!isPlexWireMetadataResponse(value, isPlexWireArtistIdentity)) {
    return false;
  }

  const container = value.MediaContainer;
  const metadata = container.Metadata ?? [];
  if (
    metadata.length > MEDIA_IDENTITY_MAX_PAGE_SIZE ||
    (container.size !== undefined &&
      (container.size > MEDIA_IDENTITY_MAX_PAGE_SIZE || container.size !== metadata.length))
  ) {
    return false;
  }

  const offset = container.offset ?? 0;
  const total = container.totalSize ?? offset + metadata.length;
  const end = offset + metadata.length;
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(end) &&
    total >= end
  );
}

/**
 * Validates the server identity response fields consumed by the adapter.
 *
 * @param value - Unknown response body.
 * @returns True when a machine identifier and valid optional labels are present.
 */
export function isPlexWireServerResponse(value: unknown): value is PlexWireServerResponse {
  return (
    isRecord(value) &&
    isRecord(value["MediaContainer"]) &&
    typeof value["MediaContainer"]["machineIdentifier"] === "string" &&
    value["MediaContainer"]["machineIdentifier"].length > 0 &&
    hasOptionalString(value["MediaContainer"], "version") &&
    hasOptionalString(value["MediaContainer"], "friendlyName")
  );
}

/**
 * Validates the library list response fields consumed by the adapter.
 *
 * @param value - Unknown response body.
 * @returns True when the directory list and all library records are valid.
 */
export function isPlexWireLibraryResponse(value: unknown): value is PlexWireLibraryResponse {
  return (
    isRecord(value) &&
    isRecord(value["MediaContainer"]) &&
    Array.isArray(value["MediaContainer"]["Directory"]) &&
    value["MediaContainer"]["Directory"].every(isPlexWireLibrary)
  );
}
