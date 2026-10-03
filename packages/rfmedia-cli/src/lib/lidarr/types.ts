/**
 * Private Lidarr connection settings, API-key provider seam, and focused
 * unknown-to-domain projections.
 *
 * This module mirrors the security posture of `src/lib/adapters/plex/types.ts`:
 * the API key lives in a module-private `WeakMap` keyed by the frozen connection
 * object, so it is absent from reflection, object spread, logs, and
 * serialization. Focused guards validate only the command-facing fields, and
 * projectors construct fresh domain objects so generated wire values never
 * cross the client boundary by reference. These are implementation details of
 * the Lidarr client and are not part of the package's public type barrel.
 */

import type {
  LidarrAlbum,
  LidarrAlbumStatistics,
  LidarrArtist,
  LidarrArtistStatistics,
  LidarrHealthCheck,
  LidarrHealthType,
  LidarrManualImportAlbum,
  LidarrManualImportArtist,
  LidarrManualImportAudioTags,
  LidarrManualImportCandidate,
  LidarrManualImportRejection,
  LidarrManualImportTrack,
  LidarrMetadataProfile,
  LidarrMetadataProfileAlbumType,
  LidarrProfile,
  LidarrRootFolder,
  LidarrSearchCandidateInput,
  LidarrSystemStatus,
  LidarrTag,
  LidarrTrack,
  LidarrTrackFile,
  LidarrWantedArtistRef,
  LidarrWantedPage,
  LidarrWantedRecord,
} from "../../types/lidarr.js";
import type {
  LidarrPresetCustomFormatDefinition,
  LidarrPresetCustomFormatFieldSchema,
  LidarrPresetCustomFormatImplementation,
  LidarrPresetCustomFormatSpecificationDefinition,
  LidarrPresetCustomFormatSpecificationSchema,
  LidarrPresetFieldValue,
  LidarrPresetLiveFormatScore,
  LidarrPresetLiveQualityItem,
  LidarrPresetLiveQualityReference,
  LidarrPresetNamingConfig,
  LidarrPresetNamingExamples,
  LidarrPresetQualityProfileDefinition,
  LidarrPresetQualityProfileSchema,
} from "../../types/lidarr-presets.js";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
// Mirrors plan-engine's TERMINAL_CONTROL_PATTERN (C0, DEL + C1, bidi controls)
// as a global strip pattern so projected album strings can never fail plan
// artifact validation.
const TERMINAL_CONTROL_STRIP_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/gu;
// Mirrors plan-engine's MAX_STRING_LENGTH (length > 2048 is rejected there).
const MAX_ALBUM_TITLE_LENGTH = 2_048;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;
const MAX_LIDARR_COLLECTION_SIZE = 1_000;
const MAX_LIDARR_LABEL_LENGTH = 2_048;
const MAX_LIDARR_QUALITY_TREE_DEPTH = 16;
const MAX_LIDARR_QUALITY_TREE_NODES = 4_096;
const CUSTOM_FORMAT_FIELD_NAMES = Object.freeze({
  ReleaseTitleSpecification: Object.freeze(["value"]),
  ReleaseGroupSpecification: Object.freeze(["value"]),
  IndexerFlagSpecification: Object.freeze(["value"]),
  SizeSpecification: Object.freeze(["min", "max"]),
} as const satisfies Record<LidarrPresetCustomFormatImplementation, readonly string[]>);
const MUSICBRAINZ_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_DELAY_MS = 0;

/** Captured request policy for one Lidarr client instance. */
export interface LidarrRequestSettings {
  /** Hard request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Optional post-response delay in milliseconds (mirrors the Plex client). */
  readonly delayMs: number;
}

/** Input used to construct an origin-bound private connection. */
export interface LidarrConnectionInput {
  /** Canonical URL origin, for example `http://localhost:8686`. */
  readonly origin: string;
  /** Lidarr API key sent as the `X-Api-Key` header. */
  readonly apiKey: string;
  /** Optional captured request policy overrides. */
  readonly request?: Partial<LidarrRequestSettings>;
}

/** Non-secret connection fields safe for structured diagnostics. */
export interface LidarrConnectionLogContext {
  /** Canonical URL origin. */
  readonly origin: string;
  /** Captured request policy. */
  readonly request: LidarrRequestSettings;
}

/**
 * Immutable connection state for one Lidarr client.
 *
 * The API key lives in a module-private `WeakMap`, never on this object, so it
 * cannot be reached through reflection, spread, logging, or serialization.
 */
export interface LidarrConnectionSettings extends LidarrConnectionLogContext {}

interface LidarrCredentialBinding {
  readonly origin: string;
  readonly apiKey: string;
}

const credentialBindings = new WeakMap<LidarrConnectionSettings, LidarrCredentialBinding>();

/**
 * Creates immutable connection state from an already-normalized HTTP origin.
 *
 * The API key is bound off-object in a module-private `WeakMap`. Credential
 * content is not interpreted here; empty/control-character validation belongs to
 * the API-key provider.
 *
 * @param input - Canonical origin, API key, and optional request settings.
 * @returns Frozen private connection state.
 * @throws {TypeError} When `origin` is not a canonical HTTP(S) origin.
 */
export function createLidarrConnectionSettings(
  input: LidarrConnectionInput,
): LidarrConnectionSettings {
  let parsed: URL;
  try {
    parsed = new URL(input.origin);
  } catch {
    throw new TypeError("Lidarr connection origin must be a normalized HTTP(S) origin");
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
    throw new TypeError("Lidarr connection origin must be a normalized HTTP(S) origin");
  }

  const request = Object.freeze({
    timeoutMs: input.request?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    delayMs: input.request?.delayMs ?? DEFAULT_REQUEST_DELAY_MS,
  });
  const connection: LidarrConnectionSettings = Object.freeze({ origin: input.origin, request });
  credentialBindings.set(connection, Object.freeze({ origin: input.origin, apiKey: input.apiKey }));
  return connection;
}

/**
 * Reads the bound API key only for its bound canonical origin.
 *
 * @param connection - Private connection state.
 * @param requestOrigin - Canonical origin of the pending request.
 * @returns The unchanged API key.
 * @throws {TypeError} When the credential is unavailable or the request origin
 *   differs from the bound origin.
 */
export function getLidarrConnectionApiKey(
  connection: LidarrConnectionSettings,
  requestOrigin: string,
): string {
  const credential = credentialBindings.get(connection);
  if (credential === undefined) {
    throw new TypeError("Lidarr connection credential is unavailable");
  }
  if (requestOrigin !== connection.origin || requestOrigin !== credential.origin) {
    throw new TypeError("Lidarr credential cannot be used for a different origin");
  }
  return credential.apiKey;
}

/**
 * Projects connection state to an explicitly secret-free log shape.
 *
 * @param connection - Private connection state.
 * @returns Frozen fields safe for structured diagnostics.
 */
export function toLidarrConnectionLogContext(
  connection: LidarrConnectionSettings,
): LidarrConnectionLogContext {
  return Object.freeze({ origin: connection.origin, request: connection.request });
}

/** Private asynchronous credential seam for authenticated Lidarr requests. */
export interface LidarrApiKeyProvider {
  /**
   * Returns the current Lidarr API key.
   *
   * @returns The API key without decoding or normalization.
   */
  getApiKey(): Promise<string>;
}

function validateApiKey(apiKey: string): string {
  if (apiKey.length === 0) {
    throw new TypeError("Lidarr API key must not be empty");
  }
  if (CONTROL_CHARACTER_PATTERN.test(apiKey)) {
    throw new TypeError("Lidarr API key contains a control character");
  }
  return apiKey;
}

/**
 * Static provider for a configured Lidarr API key.
 *
 * The key remains in the connection module's private binding; this provider
 * neither interprets nor persists it.
 */
export class StaticLidarrApiKeyProvider implements LidarrApiKeyProvider {
  readonly #connection: LidarrConnectionSettings;

  /**
   * Creates a provider for one origin-bound private connection.
   *
   * @param connection - Immutable connection whose API key is held off-object.
   */
  constructor(connection: LidarrConnectionSettings) {
    this.#connection = connection;
    Object.freeze(this);
  }

  /**
   * Reads and validates the origin-bound API key.
   *
   * @returns The configured API key byte-for-byte unchanged.
   * @throws {TypeError} When the key is empty or contains a control character.
   */
  async getApiKey(): Promise<string> {
    const apiKey = getLidarrConnectionApiKey(this.#connection, this.#connection.origin);
    return validateApiKey(apiKey);
  }
}

// ── Wire guard primitives ──────────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === "string";
}

function hasFiniteNumber(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === "number" && Number.isFinite(record[key]);
}

function hasPositiveSafeInteger(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasBoolean(record: UnknownRecord, key: string): boolean {
  return typeof record[key] === "boolean";
}

function hasOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function hasOptionalBoolean(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function hasOptionalFiniteNumber(record: UnknownRecord, key: string): boolean {
  return (
    record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key]))
  );
}

function hasNullableOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || record[key] === null || typeof record[key] === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPositiveSafeIntegerArray(value: unknown): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIDARR_COLLECTION_SIZE &&
    value.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item > 0)
  );
}

function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LIDARR_LABEL_LENGTH &&
    value.trim().length > 0 &&
    !TERMINAL_CONTROL_PATTERN.test(value)
  );
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_LIDARR_LABEL_LENGTH &&
    !TERMINAL_CONTROL_PATTERN.test(value)
  );
}

function hasSafeLabel(record: UnknownRecord, key: string): boolean {
  return isSafeLabel(record[key]);
}

function isBoundedArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= MAX_LIDARR_COLLECTION_SIZE;
}

function isMusicBrainzId(value: unknown): value is string {
  return typeof value === "string" && MUSICBRAINZ_ID_PATTERN.test(value);
}

function hasOptionalLookupId(record: UnknownRecord): boolean {
  const value = record["id"];
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function hasNullableOptionalSafeLabel(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || isSafeLabel(value);
}

function hasNullableOptionalMusicBrainzId(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || isMusicBrainzId(value);
}

function isLidarrHealthTypeValue(value: unknown): value is LidarrHealthType {
  return value === "ok" || value === "notice" || value === "warning" || value === "error";
}

// ── Wire guards ─────────────────────────────────────────────────────────────

/**
 * Validates the Lidarr system-status fields consumed by `status`.
 *
 * @param value - Unknown wire value.
 * @returns True when `version` is present and optional fields are well-typed.
 */
export function isLidarrSystemStatus(value: unknown): value is LidarrSystemStatus {
  return (
    isRecord(value) &&
    hasString(value, "version") &&
    hasOptionalString(value, "appName") &&
    hasOptionalString(value, "instanceName") &&
    hasOptionalBoolean(value, "isProduction") &&
    hasOptionalString(value, "runtimeVersion")
  );
}

/**
 * Validates the per-artist statistics block.
 *
 * @param value - Unknown wire value.
 * @returns True when required counts and optional fields are finite numbers.
 */
export function isLidarrArtistStatistics(value: unknown): value is LidarrArtistStatistics {
  return (
    isRecord(value) &&
    hasFiniteNumber(value, "albumCount") &&
    hasFiniteNumber(value, "trackFileCount") &&
    hasFiniteNumber(value, "trackCount") &&
    hasFiniteNumber(value, "sizeOnDisk") &&
    hasOptionalFiniteNumber(value, "totalTrackCount") &&
    hasOptionalFiniteNumber(value, "percentOfTracks")
  );
}

/**
 * Validates a Lidarr artist record consumed by `list` and `status`.
 *
 * @param value - Unknown wire value.
 * @returns True when required identity/profile fields, the numeric tag array,
 *   and any present statistics block are well-typed.
 */
export function isLidarrArtist(value: unknown): value is LidarrArtist {
  return (
    isRecord(value) &&
    hasPositiveSafeInteger(value, "id") &&
    hasSafeLabel(value, "artistName") &&
    hasSafeLabel(value, "foreignArtistId") &&
    hasBoolean(value, "monitored") &&
    (value["monitorNewItems"] === undefined ||
      value["monitorNewItems"] === "all" ||
      value["monitorNewItems"] === "none" ||
      value["monitorNewItems"] === "new") &&
    hasPositiveSafeInteger(value, "qualityProfileId") &&
    hasPositiveSafeInteger(value, "metadataProfileId") &&
    hasOptionalString(value, "path") &&
    isPositiveSafeIntegerArray(value["tags"]) &&
    (value["statistics"] === undefined || isLidarrArtistStatistics(value["statistics"]))
  );
}

/**
 * Validates that a value is an array of Lidarr artist records.
 *
 * @param value - Unknown wire value.
 * @returns True when every element is a valid {@link LidarrArtist}.
 */
export function isLidarrArtistArray(value: unknown): value is LidarrArtist[] {
  return Array.isArray(value) && value.every(isLidarrArtist);
}

interface LidarrRootFolderWire {
  readonly id: number;
  readonly path: string;
  readonly accessible: boolean;
  readonly freeSpace?: number | null;
  readonly defaultMetadataProfileId: number;
}

function isLidarrRootFolder(value: unknown): value is LidarrRootFolderWire {
  return (
    isRecord(value) &&
    hasPositiveSafeInteger(value, "id") &&
    hasSafeLabel(value, "path") &&
    hasBoolean(value, "accessible") &&
    hasPositiveSafeInteger(value, "defaultMetadataProfileId") &&
    (value["freeSpace"] === undefined ||
      value["freeSpace"] === null ||
      (typeof value["freeSpace"] === "number" &&
        Number.isFinite(value["freeSpace"]) &&
        value["freeSpace"] >= 0))
  );
}

interface LidarrMetadataProfileAlbumTypeWire {
  readonly id: number;
  readonly albumType: {
    readonly id: number;
    readonly name: string;
  };
  readonly allowed: boolean;
}

interface LidarrMetadataProfileWire {
  readonly id: number;
  readonly name: string;
  readonly primaryAlbumTypes: readonly LidarrMetadataProfileAlbumTypeWire[];
  readonly secondaryAlbumTypes: readonly LidarrMetadataProfileAlbumTypeWire[];
}

function isLidarrMetadataProfileAlbumType(
  value: unknown,
): value is LidarrMetadataProfileAlbumTypeWire {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasBoolean(value, "allowed") ||
    !isRecord(value["albumType"])
  ) {
    return false;
  }
  return (
    hasPositiveSafeInteger(value["albumType"], "id") && hasSafeLabel(value["albumType"], "name")
  );
}

function hasUniqueMetadataProfileAlbumTypes(
  values: readonly LidarrMetadataProfileAlbumTypeWire[],
): boolean {
  return (
    new Set(values.map((value) => value.id)).size === values.length &&
    new Set(values.map((value) => value.albumType.id)).size === values.length
  );
}

function isLidarrMetadataProfile(value: unknown): value is LidarrMetadataProfileWire {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasSafeLabel(value, "name") ||
    !isBoundedArray(value["primaryAlbumTypes"]) ||
    !isBoundedArray(value["secondaryAlbumTypes"]) ||
    !value["primaryAlbumTypes"].every(isLidarrMetadataProfileAlbumType) ||
    !value["secondaryAlbumTypes"].every(isLidarrMetadataProfileAlbumType)
  ) {
    return false;
  }
  return (
    hasUniqueMetadataProfileAlbumTypes(value["primaryAlbumTypes"]) &&
    hasUniqueMetadataProfileAlbumTypes(value["secondaryAlbumTypes"])
  );
}

/**
 * Validates a generated-independent quality or metadata profile projection.
 *
 * @param value - Unknown wire value.
 * @returns True when the profile has a positive safe id and safe bounded name.
 */
export function isLidarrProfile(value: unknown): value is LidarrProfile {
  return isRecord(value) && hasPositiveSafeInteger(value, "id") && hasSafeLabel(value, "name");
}

/**
 * Validates a generated-independent tag projection.
 *
 * @param value - Unknown wire value.
 * @returns True when the tag has a positive safe id and safe bounded label.
 */
export function isLidarrTag(value: unknown): value is LidarrTag {
  return isRecord(value) && hasPositiveSafeInteger(value, "id") && hasSafeLabel(value, "label");
}

/**
 * Tolerant wire shape accepted for one Lidarr album record.
 *
 * Lidarr types `title`, `albumType`, and `secondaryTypes` as nullable on the
 * wire; the copier normalizes them so one sparse album can never poison a
 * whole `listAlbums` projection into a validation failure.
 *
 * `anyReleaseOk`, `releaseDate`, and `foreignAlbumId` are typed `unknown` on
 * purpose: {@link isLidarrAlbum} never inspects them, so a missing or
 * oddly-typed value can never reject an album — the copier narrows them and
 * silently drops anything that is not well-typed.
 */
export interface LidarrAlbumWire {
  readonly id: number;
  readonly title?: string | null;
  readonly artistId: number;
  readonly monitored: boolean;
  readonly anyReleaseOk?: unknown;
  readonly albumType?: string | null;
  readonly releaseDate?: unknown;
  readonly foreignAlbumId?: unknown;
  readonly secondaryTypes?: readonly string[] | null;
  readonly statistics?: LidarrAlbumStatistics;
}

/**
 * Validates the per-album statistics block.
 *
 * @param value - Unknown wire value.
 * @returns True when every present count is a finite number.
 */
export function isLidarrAlbumStatistics(value: unknown): value is LidarrAlbumStatistics {
  return (
    isRecord(value) &&
    hasOptionalFiniteNumber(value, "trackCount") &&
    hasOptionalFiniteNumber(value, "trackFileCount") &&
    hasOptionalFiniteNumber(value, "sizeOnDisk")
  );
}

/**
 * Validates one Lidarr album record consumed by the album-monitoring lane.
 *
 * Requires `id`/`artistId` positive safe integers and a boolean `monitored`;
 * tolerates the nullable wire fields normalized by the copier. The
 * `anyReleaseOk`/`releaseDate`/`foreignAlbumId` leaves are deliberately not
 * inspected here (they are `unknown` on the wire shape): a malformed value
 * must never reject an album this guard accepts today — the copier drops it.
 *
 * @param value - Unknown wire value.
 * @returns True when the record matches the tolerant album wire shape.
 */
export function isLidarrAlbum(value: unknown): value is LidarrAlbumWire {
  return (
    isRecord(value) &&
    hasPositiveSafeInteger(value, "id") &&
    hasPositiveSafeInteger(value, "artistId") &&
    hasBoolean(value, "monitored") &&
    hasNullableOptionalString(value, "title") &&
    hasNullableOptionalString(value, "albumType") &&
    (value["secondaryTypes"] === undefined ||
      value["secondaryTypes"] === null ||
      isStringArray(value["secondaryTypes"])) &&
    (value["statistics"] === undefined || isLidarrAlbumStatistics(value["statistics"]))
  );
}

/**
 * Validates that a value is an array of Lidarr album records.
 *
 * @param value - Unknown wire value.
 * @returns True when every element satisfies {@link isLidarrAlbum}.
 */
export function isLidarrAlbumArray(value: unknown): value is LidarrAlbumWire[] {
  return Array.isArray(value) && value.every(isLidarrAlbum);
}

/**
 * Validates the minimal artist reference embedded in a wanted record.
 *
 * @param value - Unknown wire value.
 * @returns True when `id`/`artistName` are present and typed.
 */
export function isLidarrWantedArtistRef(value: unknown): value is LidarrWantedArtistRef {
  return (
    isRecord(value) &&
    hasFiniteNumber(value, "id") &&
    hasString(value, "artistName") &&
    hasOptionalString(value, "foreignArtistId")
  );
}

/**
 * Validates a single wanted/missing album record.
 *
 * @param value - Unknown wire value.
 * @returns True when required fields and the nested artist reference are valid.
 */
export function isLidarrWantedRecord(value: unknown): value is LidarrWantedRecord {
  return (
    isRecord(value) &&
    hasFiniteNumber(value, "id") &&
    hasString(value, "title") &&
    isLidarrWantedArtistRef(value["artist"]) &&
    hasOptionalString(value, "releaseDate") &&
    hasBoolean(value, "monitored")
  );
}

/**
 * Validates the paged wanted/missing envelope.
 *
 * @param value - Unknown wire value.
 * @returns True when the paging fields and every record are valid.
 */
export function isLidarrWantedPage(value: unknown): value is LidarrWantedPage {
  return (
    isRecord(value) &&
    hasFiniteNumber(value, "page") &&
    hasFiniteNumber(value, "pageSize") &&
    hasFiniteNumber(value, "totalRecords") &&
    hasOptionalString(value, "sortKey") &&
    hasOptionalString(value, "sortDirection") &&
    Array.isArray(value["records"]) &&
    value["records"].every(isLidarrWantedRecord)
  );
}

/**
 * Validates a single Lidarr health-check record.
 *
 * @param value - Unknown wire value.
 * @returns True when `source`/`message` are strings and `type` is in the union.
 */
export function isLidarrHealthCheck(value: unknown): value is LidarrHealthCheck {
  return (
    isRecord(value) &&
    hasString(value, "source") &&
    isLidarrHealthTypeValue(value["type"]) &&
    hasString(value, "message") &&
    hasOptionalString(value, "wikiUrl")
  );
}

/**
 * Validates that a value is an array of Lidarr health-check records.
 *
 * @param value - Unknown wire value.
 * @returns True when every element is a valid {@link LidarrHealthCheck}.
 */
export function isLidarrHealthArray(value: unknown): value is LidarrHealthCheck[] {
  return Array.isArray(value) && value.every(isLidarrHealthCheck);
}

// ── Domain projectors ─────────────────────────────────────────────────────────────

function copySystemStatus(value: LidarrSystemStatus): LidarrSystemStatus {
  return Object.freeze({
    version: value.version,
    ...(value.appName === undefined ? {} : { appName: value.appName }),
    ...(value.instanceName === undefined ? {} : { instanceName: value.instanceName }),
    ...(value.isProduction === undefined ? {} : { isProduction: value.isProduction }),
    ...(value.runtimeVersion === undefined ? {} : { runtimeVersion: value.runtimeVersion }),
  });
}

function copyArtistStatistics(value: LidarrArtistStatistics): LidarrArtistStatistics {
  return Object.freeze({
    albumCount: value.albumCount,
    trackFileCount: value.trackFileCount,
    trackCount: value.trackCount,
    sizeOnDisk: value.sizeOnDisk,
    ...(value.totalTrackCount === undefined ? {} : { totalTrackCount: value.totalTrackCount }),
    ...(value.percentOfTracks === undefined ? {} : { percentOfTracks: value.percentOfTracks }),
  });
}

function copyArtist(value: LidarrArtist): LidarrArtist {
  return Object.freeze({
    id: value.id,
    artistName: value.artistName,
    foreignArtistId: value.foreignArtistId,
    monitored: value.monitored,
    ...(value.monitorNewItems === undefined ? {} : { monitorNewItems: value.monitorNewItems }),
    qualityProfileId: value.qualityProfileId,
    metadataProfileId: value.metadataProfileId,
    ...(value.path === undefined ? {} : { path: value.path }),
    tags: Object.freeze([...new Set(value.tags)].sort((left, right) => left - right)),
    ...(value.statistics === undefined
      ? {}
      : { statistics: copyArtistStatistics(value.statistics) }),
  });
}

function copyRootFolder(value: LidarrRootFolderWire): LidarrRootFolder {
  return Object.freeze({
    id: value.id,
    path: value.path,
    accessible: value.accessible,
    defaultMetadataProfileId: value.defaultMetadataProfileId,
    ...(value.freeSpace === undefined || value.freeSpace === null
      ? {}
      : { freeSpace: value.freeSpace }),
  });
}

/** Strips every character plan-engine's artifact validators reject. */
function sanitizeAlbumString(value: string): string {
  return value.replace(TERMINAL_CONTROL_STRIP_PATTERN, "");
}

function copyAlbumStatistics(value: LidarrAlbumStatistics): LidarrAlbumStatistics {
  return Object.freeze({
    ...(value.trackCount === undefined ? {} : { trackCount: value.trackCount }),
    ...(value.trackFileCount === undefined ? {} : { trackFileCount: value.trackFileCount }),
    ...(value.sizeOnDisk === undefined ? {} : { sizeOnDisk: value.sizeOnDisk }),
  });
}

/**
 * Narrows one unchecked optional string leaf from the tolerant album wire
 * shape: non-strings are dropped, survivors are sanitized and truncated like
 * every other album string, and an empty result is omitted (plan-engine treats
 * optional fields as absent but rejects an empty string).
 */
function sanitizeOptionalAlbumLeaf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = sanitizeAlbumString(value).slice(0, MAX_ALBUM_TITLE_LENGTH);
  return sanitized === "" ? undefined : sanitized;
}

function copyAlbum(value: LidarrAlbumWire): LidarrAlbum {
  // Net-new sanitization (unlike copyArtist): a null title becomes "", terminal
  // control and bidi characters are stripped, and title/albumType are truncated
  // so a built plan artifact can never fail its own string validation. An
  // albumType that is empty after sanitization is omitted (plan-engine treats
  // the field as optional but rejects an empty string).
  const title = sanitizeAlbumString(value.title ?? "").slice(0, MAX_ALBUM_TITLE_LENGTH);
  const sanitizedAlbumType =
    value.albumType === undefined || value.albumType === null
      ? undefined
      : sanitizeAlbumString(value.albumType).slice(0, MAX_ALBUM_TITLE_LENGTH);
  const albumType = sanitizedAlbumType === "" ? undefined : sanitizedAlbumType;
  // The guard never inspects these leaves, so they are narrowed here; the
  // conditional spreads guarantee an album without them projects with NO new
  // keys, keeping pre-existing projections byte-identical.
  const releaseDate = sanitizeOptionalAlbumLeaf(value.releaseDate);
  const foreignAlbumId = sanitizeOptionalAlbumLeaf(value.foreignAlbumId);
  return Object.freeze({
    id: value.id,
    title,
    artistId: value.artistId,
    monitored: value.monitored,
    ...(typeof value.anyReleaseOk === "boolean" ? { anyReleaseOk: value.anyReleaseOk } : {}),
    ...(albumType === undefined ? {} : { albumType }),
    ...(releaseDate === undefined ? {} : { releaseDate }),
    ...(foreignAlbumId === undefined ? {} : { foreignAlbumId }),
    secondaryTypes: Object.freeze([...(value.secondaryTypes ?? [])]),
    ...(value.statistics === undefined
      ? {}
      : { statistics: copyAlbumStatistics(value.statistics) }),
  });
}

function copyProfile(value: LidarrProfile): LidarrProfile {
  return Object.freeze({ id: value.id, name: value.name });
}

function copyMetadataProfileAlbumType(
  value: LidarrMetadataProfileAlbumTypeWire,
): LidarrMetadataProfileAlbumType {
  return Object.freeze({
    id: value.albumType.id,
    name: value.albumType.name,
    allowed: value.allowed,
  });
}

function copyMetadataProfile(value: LidarrMetadataProfileWire): LidarrMetadataProfile {
  return Object.freeze({
    id: value.id,
    name: value.name,
    primaryAlbumTypes: Object.freeze(value.primaryAlbumTypes.map(copyMetadataProfileAlbumType)),
    secondaryAlbumTypes: Object.freeze(value.secondaryAlbumTypes.map(copyMetadataProfileAlbumType)),
  });
}

function copyTag(value: LidarrTag): LidarrTag {
  return Object.freeze({ id: value.id, label: value.label });
}

function hasUniqueIds(values: readonly { readonly id: number }[]): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function copyWantedArtistRef(value: LidarrWantedArtistRef): LidarrWantedArtistRef {
  return Object.freeze({
    id: value.id,
    artistName: value.artistName,
    ...(value.foreignArtistId === undefined ? {} : { foreignArtistId: value.foreignArtistId }),
  });
}

function copyWantedRecord(value: LidarrWantedRecord): LidarrWantedRecord {
  return Object.freeze({
    id: value.id,
    title: value.title,
    artist: copyWantedArtistRef(value.artist),
    ...(value.releaseDate === undefined ? {} : { releaseDate: value.releaseDate }),
    monitored: value.monitored,
  });
}

function copyWantedPage(value: LidarrWantedPage): LidarrWantedPage {
  return Object.freeze({
    page: value.page,
    pageSize: value.pageSize,
    totalRecords: value.totalRecords,
    ...(value.sortKey === undefined ? {} : { sortKey: value.sortKey }),
    ...(value.sortDirection === undefined ? {} : { sortDirection: value.sortDirection }),
    records: Object.freeze(value.records.map(copyWantedRecord)),
  });
}

function copyHealthCheck(value: LidarrHealthCheck): LidarrHealthCheck {
  return Object.freeze({
    source: value.source,
    type: value.type,
    message: value.message,
    ...(value.wikiUrl === undefined ? {} : { wikiUrl: value.wikiUrl }),
  });
}

function projectLookupId(value: UnknownRecord): Readonly<{ lidarrId: number }> | undefined {
  const id = value["id"];
  return typeof id === "number" && id > 0 ? { lidarrId: id } : undefined;
}

function projectOptionalSafeLabel(
  value: UnknownRecord,
  key: string,
  outputKey: string = key,
): Readonly<Record<string, string>> {
  const label = value[key];
  return typeof label === "string" ? { [outputKey]: label } : {};
}

function projectArtistSearchCandidate(
  value: unknown,
  foreignIdOverride?: string,
): LidarrSearchCandidateInput | undefined {
  if (
    !isRecord(value) ||
    !hasOptionalLookupId(value) ||
    !isSafeLabel(value["artistName"]) ||
    !hasNullableOptionalMusicBrainzId(value, "foreignArtistId") ||
    !hasNullableOptionalSafeLabel(value, "disambiguation") ||
    !hasNullableOptionalSafeLabel(value, "artistType")
  ) {
    return undefined;
  }

  const nestedForeignId = value["foreignArtistId"];
  if (
    foreignIdOverride !== undefined &&
    typeof nestedForeignId === "string" &&
    nestedForeignId !== foreignIdOverride
  ) {
    return undefined;
  }
  const foreignId =
    foreignIdOverride ?? (typeof nestedForeignId === "string" ? nestedForeignId : undefined);
  if (!isMusicBrainzId(foreignId)) {
    return undefined;
  }

  return Object.freeze({
    kind: "artist",
    foreignId,
    name: value["artistName"],
    ...projectLookupId(value),
    ...projectOptionalSafeLabel(value, "disambiguation"),
    ...projectOptionalSafeLabel(value, "artistType"),
  });
}

function projectAlbumSearchCandidate(
  value: unknown,
  foreignIdOverride?: string,
): LidarrSearchCandidateInput | undefined {
  if (
    !isRecord(value) ||
    !hasOptionalLookupId(value) ||
    !isSafeLabel(value["title"]) ||
    !hasNullableOptionalMusicBrainzId(value, "foreignAlbumId") ||
    !hasNullableOptionalSafeLabel(value, "albumType") ||
    !hasNullableOptionalSafeLabel(value, "releaseDate") ||
    (value["artist"] !== undefined && !isRecord(value["artist"]))
  ) {
    return undefined;
  }

  const nestedForeignId = value["foreignAlbumId"];
  if (
    foreignIdOverride !== undefined &&
    typeof nestedForeignId === "string" &&
    nestedForeignId !== foreignIdOverride
  ) {
    return undefined;
  }
  const foreignId =
    foreignIdOverride ?? (typeof nestedForeignId === "string" ? nestedForeignId : undefined);
  if (!isMusicBrainzId(foreignId)) {
    return undefined;
  }

  const artist = value["artist"];
  if (
    artist !== undefined &&
    (!hasNullableOptionalSafeLabel(artist, "artistName") ||
      !hasNullableOptionalMusicBrainzId(artist, "foreignArtistId"))
  ) {
    return undefined;
  }

  return Object.freeze({
    kind: "album",
    foreignId,
    name: value["title"],
    ...projectLookupId(value),
    ...(artist === undefined ? {} : projectOptionalSafeLabel(artist, "artistName")),
    ...(artist === undefined
      ? {}
      : projectOptionalSafeLabel(artist, "foreignArtistId", "artistForeignId")),
    ...projectOptionalSafeLabel(value, "albumType"),
    ...projectOptionalSafeLabel(value, "releaseDate"),
  });
}

function projectSearchCollection(
  value: unknown,
  projector: (entry: unknown) => LidarrSearchCandidateInput | undefined,
): readonly LidarrSearchCandidateInput[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }

  const projected: LidarrSearchCandidateInput[] = [];
  for (const entry of value) {
    const candidate = projector(entry);
    if (candidate === undefined) {
      return undefined;
    }
    projected.push(candidate);
  }
  return Object.freeze(projected);
}

function projectCombinedSearchCandidate(value: unknown): LidarrSearchCandidateInput | undefined {
  if (!isRecord(value) || !hasNullableOptionalMusicBrainzId(value, "foreignId")) {
    return undefined;
  }

  const hasArtist = value["artist"] !== undefined;
  const hasAlbum = value["album"] !== undefined;
  if (hasArtist === hasAlbum) {
    return undefined;
  }

  const foreignId = typeof value["foreignId"] === "string" ? value["foreignId"] : undefined;
  return hasArtist
    ? projectArtistSearchCandidate(value["artist"], foreignId)
    : projectAlbumSearchCandidate(value["album"], foreignId);
}

function normalizeLidarrName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function hasUniqueProjectedIdentities(
  values: readonly { readonly id: number; readonly name: string }[],
): boolean {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const value of values) {
    const normalizedName = normalizeLidarrName(value.name);
    if (ids.has(value.id) || names.has(normalizedName)) {
      return false;
    }
    ids.add(value.id);
    names.add(normalizedName);
  }
  return true;
}

function isCustomFormatImplementation(
  value: unknown,
): value is LidarrPresetCustomFormatImplementation {
  return (
    value === "ReleaseTitleSpecification" ||
    value === "ReleaseGroupSpecification" ||
    value === "IndexerFlagSpecification" ||
    value === "SizeSpecification"
  );
}

function projectPresetFieldValue(value: unknown): LidarrPresetFieldValue | undefined {
  if (typeof value === "string") {
    return isSafeText(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasExpectedCustomFormatFields(
  implementation: LidarrPresetCustomFormatImplementation,
  fields: Readonly<Record<string, LidarrPresetFieldValue>>,
): boolean {
  const expected = CUSTOM_FORMAT_FIELD_NAMES[implementation];
  const actual = Object.keys(fields);
  if (!hasExpectedCustomFormatFieldNames(implementation, actual)) {
    return false;
  }
  if (
    (implementation === "ReleaseTitleSpecification" ||
      implementation === "ReleaseGroupSpecification") &&
    typeof fields["value"] !== "string"
  ) {
    return false;
  }
  if (
    implementation === "IndexerFlagSpecification" &&
    (typeof fields["value"] !== "number" || !Number.isSafeInteger(fields["value"]))
  ) {
    return false;
  }
  return (
    implementation !== "SizeSpecification" ||
    (typeof fields["min"] === "number" && typeof fields["max"] === "number")
  );
}

function hasExpectedCustomFormatFieldNames(
  implementation: LidarrPresetCustomFormatImplementation,
  actual: readonly string[],
): boolean {
  const expected = CUSTOM_FORMAT_FIELD_NAMES[implementation];
  return actual.length === expected.length && expected.every((name) => actual.includes(name));
}

function projectCustomFormatFields(
  value: unknown,
  implementation: LidarrPresetCustomFormatImplementation,
): Readonly<Record<string, LidarrPresetFieldValue>> | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }

  const entries: [string, LidarrPresetFieldValue][] = [];
  const names = new Set<string>();
  for (const field of value) {
    if (!isRecord(field) || !isSafeLabel(field["name"])) {
      return undefined;
    }
    const normalizedName = normalizeLidarrName(field["name"]);
    const fieldValue = projectPresetFieldValue(field["value"]);
    if (names.has(normalizedName) || fieldValue === undefined) {
      return undefined;
    }
    names.add(normalizedName);
    entries.push([field["name"], fieldValue]);
  }

  const fields = Object.freeze(Object.fromEntries(entries));
  return hasExpectedCustomFormatFields(implementation, fields) ? fields : undefined;
}

function projectCustomFormatSpecificationDefinition(
  value: unknown,
): LidarrPresetCustomFormatSpecificationDefinition | undefined {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !isSafeLabel(value["name"]) ||
    !isCustomFormatImplementation(value["implementation"]) ||
    !hasBoolean(value, "negate") ||
    !hasBoolean(value, "required")
  ) {
    return undefined;
  }
  const fields = projectCustomFormatFields(value["fields"], value["implementation"]);
  return fields === undefined
    ? undefined
    : Object.freeze({
        id: value["id"] as number,
        name: value["name"],
        implementation: value["implementation"],
        negate: value["negate"] as boolean,
        required: value["required"] as boolean,
        fields,
      });
}

function projectCustomFormatFieldSchema(
  value: unknown,
): LidarrPresetCustomFormatFieldSchema | undefined {
  if (
    !isRecord(value) ||
    !isSafeLabel(value["name"]) ||
    !isSafeLabel(value["label"]) ||
    !isSafeLabel(value["type"]) ||
    !hasBoolean(value, "advanced")
  ) {
    return undefined;
  }
  const rawOptions = value["selectOptions"];
  if (rawOptions !== undefined && rawOptions !== null && !isBoundedArray(rawOptions)) {
    return undefined;
  }

  const options: { readonly value: LidarrPresetFieldValue; readonly name: string }[] = [];
  for (const option of rawOptions ?? []) {
    if (!isRecord(option) || !isSafeLabel(option["name"])) {
      return undefined;
    }
    const optionValue = projectPresetFieldValue(option["value"]);
    if (optionValue === undefined) {
      return undefined;
    }
    options.push(Object.freeze({ value: optionValue, name: option["name"] }));
  }
  return Object.freeze({
    name: value["name"],
    label: value["label"],
    type: value["type"],
    advanced: value["advanced"] as boolean,
    selectOptions: Object.freeze(options),
  });
}

function projectCustomFormatSpecificationSchema(
  value: unknown,
): LidarrPresetCustomFormatSpecificationSchema | undefined {
  if (
    !isRecord(value) ||
    !isCustomFormatImplementation(value["implementation"]) ||
    !isSafeLabel(value["implementationName"]) ||
    !isBoundedArray(value["fields"])
  ) {
    return undefined;
  }
  const fields: LidarrPresetCustomFormatFieldSchema[] = [];
  const names = new Set<string>();
  for (const field of value["fields"]) {
    const projected = projectCustomFormatFieldSchema(field);
    if (projected === undefined || names.has(normalizeLidarrName(projected.name))) {
      return undefined;
    }
    names.add(normalizeLidarrName(projected.name));
    fields.push(projected);
  }
  if (
    !hasExpectedCustomFormatFieldNames(
      value["implementation"],
      fields.map((field) => field.name),
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    implementation: value["implementation"],
    implementationName: value["implementationName"],
    fields: Object.freeze(fields),
  });
}

interface QualityTreeContext {
  readonly itemIds: Set<number>;
  readonly qualityIds: Set<number>;
  readonly names: Set<string>;
  nodes: number;
}

function projectLiveQualityReference(
  value: unknown,
  context: QualityTreeContext,
): LidarrPresetLiveQualityReference | undefined {
  if (!isRecord(value) || !hasPositiveSafeInteger(value, "id") || !isSafeLabel(value["name"])) {
    return undefined;
  }
  const id = value["id"] as number;
  const name = normalizeLidarrName(value["name"]);
  if (context.qualityIds.has(id) || context.names.has(name)) {
    return undefined;
  }
  context.qualityIds.add(id);
  context.names.add(name);
  return Object.freeze({ id, name: value["name"] });
}

function projectLiveQualityItem(
  value: unknown,
  depth: number,
  context: QualityTreeContext,
): LidarrPresetLiveQualityItem | undefined {
  if (
    !isRecord(value) ||
    depth > MAX_LIDARR_QUALITY_TREE_DEPTH ||
    ++context.nodes > MAX_LIDARR_QUALITY_TREE_NODES ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasBoolean(value, "allowed")
  ) {
    return undefined;
  }
  const id = value["id"] as number;
  if (context.itemIds.has(id)) {
    return undefined;
  }
  context.itemIds.add(id);

  const hasQuality = value["quality"] !== undefined && value["quality"] !== null;
  const rawItems = value["items"];
  if (hasQuality) {
    if (
      rawItems !== undefined &&
      rawItems !== null &&
      (!isBoundedArray(rawItems) || rawItems.length !== 0)
    ) {
      return undefined;
    }
    const quality = projectLiveQualityReference(value["quality"], context);
    return quality === undefined
      ? undefined
      : Object.freeze({ kind: "quality", id, quality, allowed: value["allowed"] as boolean });
  }
  if (!isSafeLabel(value["name"]) || !isBoundedArray(rawItems)) {
    return undefined;
  }
  const normalizedName = normalizeLidarrName(value["name"]);
  if (context.names.has(normalizedName)) {
    return undefined;
  }
  context.names.add(normalizedName);
  const items: LidarrPresetLiveQualityItem[] = [];
  for (const item of rawItems) {
    const projected = projectLiveQualityItem(item, depth + 1, context);
    if (projected === undefined) {
      return undefined;
    }
    items.push(projected);
  }
  return Object.freeze({
    kind: "group",
    id,
    name: value["name"],
    allowed: value["allowed"] as boolean,
    items: Object.freeze(items),
  });
}

function projectLiveQualityItems(
  value: unknown,
): readonly LidarrPresetLiveQualityItem[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }
  const context: QualityTreeContext = {
    itemIds: new Set(),
    qualityIds: new Set(),
    names: new Set(),
    nodes: 0,
  };
  const items: LidarrPresetLiveQualityItem[] = [];
  for (const item of value) {
    const projected = projectLiveQualityItem(item, 1, context);
    if (projected === undefined) {
      return undefined;
    }
    items.push(projected);
  }
  return Object.freeze(items);
}

function projectLiveFormatScores(
  value: unknown,
): readonly LidarrPresetLiveFormatScore[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }
  const formatItems: LidarrPresetLiveFormatScore[] = [];
  const identities: { id: number; name: string }[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !hasPositiveSafeInteger(item, "format") ||
      !isSafeLabel(item["name"]) ||
      typeof item["score"] !== "number" ||
      !Number.isSafeInteger(item["score"])
    ) {
      return undefined;
    }
    const customFormat = Object.freeze({
      id: item["format"] as number,
      name: item["name"],
    });
    identities.push(customFormat);
    formatItems.push(Object.freeze({ customFormat, score: item["score"] }));
  }
  return hasUniqueProjectedIdentities(identities) ? Object.freeze(formatItems) : undefined;
}

function projectQualityProfileCore(
  value: unknown,
): Omit<LidarrPresetQualityProfileDefinition, "id" | "name"> | undefined {
  if (
    !isRecord(value) ||
    !hasBoolean(value, "upgradeAllowed") ||
    !hasPositiveSafeInteger(value, "cutoff") ||
    typeof value["minFormatScore"] !== "number" ||
    !Number.isSafeInteger(value["minFormatScore"]) ||
    typeof value["cutoffFormatScore"] !== "number" ||
    !Number.isSafeInteger(value["cutoffFormatScore"])
  ) {
    return undefined;
  }
  const items = projectLiveQualityItems(value["items"]);
  const formatItems = projectLiveFormatScores(value["formatItems"]);
  return items === undefined || formatItems === undefined
    ? undefined
    : Object.freeze({
        upgradeAllowed: value["upgradeAllowed"] as boolean,
        cutoff: value["cutoff"] as number,
        items,
        minFormatScore: value["minFormatScore"],
        cutoffFormatScore: value["cutoffFormatScore"],
        formatItems,
      });
}

function projectQualityProfileDefinition(
  value: unknown,
): LidarrPresetQualityProfileDefinition | undefined {
  if (!isRecord(value) || !hasPositiveSafeInteger(value, "id") || !isSafeLabel(value["name"])) {
    return undefined;
  }
  const core = projectQualityProfileCore(value);
  return core === undefined
    ? undefined
    : Object.freeze({ id: value["id"] as number, name: value["name"], ...core });
}

/**
 * Validates and copies the command-facing system-status projection.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrSystemStatus(value: unknown): LidarrSystemStatus | undefined {
  return isLidarrSystemStatus(value) ? copySystemStatus(value) : undefined;
}

/**
 * Validates and copies the command-facing artist-statistics projection.
 *
 * @param value - Unknown nested response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrArtistStatistics(value: unknown): LidarrArtistStatistics | undefined {
  return isLidarrArtistStatistics(value) ? copyArtistStatistics(value) : undefined;
}

/**
 * Validates and copies one command-facing artist projection.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrArtist(value: unknown): LidarrArtist | undefined {
  return isLidarrArtist(value) ? copyArtist(value) : undefined;
}

/**
 * Validates and copies one targeted artist response for mutation preflight or verification.
 *
 * Artist tag ids are normalized to a sorted unique frozen array.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrTargetArtist(value: unknown): LidarrArtist | undefined {
  return isLidarrArtist(value) ? copyArtist(value) : undefined;
}

/**
 * Validates and copies the complete, unpaged command-facing artist list.
 *
 * Lidarr returns every artist from this endpoint, so its read-side collection
 * must not inherit the separate mutation batch or small resource-list bound.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh projections, or `undefined` when validation fails.
 */
export function projectLidarrArtistArray(value: unknown): readonly LidarrArtist[] | undefined {
  return isLidarrArtistArray(value) && hasUniqueIds(value)
    ? Object.freeze(value.map(copyArtist))
    : undefined;
}

/**
 * Validates and copies the bounded root-folder collection used by add planning.
 *
 * @param value - Unknown generated-client response data.
 * @returns Fresh frozen projections, or `undefined` when any entry is invalid.
 */
export function projectLidarrRootFolders(value: unknown): readonly LidarrRootFolder[] | undefined {
  return isBoundedArray(value) && value.every(isLidarrRootFolder) && hasUniqueIds(value)
    ? Object.freeze(value.map(copyRootFolder))
    : undefined;
}

/**
 * Projects one complete custom-format definition, including ordered conditions.
 */
export function projectLidarrCustomFormatDefinition(
  value: unknown,
): LidarrPresetCustomFormatDefinition | undefined {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !isSafeLabel(value["name"]) ||
    !hasBoolean(value, "includeCustomFormatWhenRenaming") ||
    !isBoundedArray(value["specifications"]) ||
    value["specifications"].length === 0
  ) {
    return undefined;
  }
  const specifications: LidarrPresetCustomFormatSpecificationDefinition[] = [];
  for (const specification of value["specifications"]) {
    const projected = projectCustomFormatSpecificationDefinition(specification);
    if (projected === undefined) {
      return undefined;
    }
    specifications.push(projected);
  }
  if (
    !hasUniqueProjectedIdentities(specifications.map(({ id, name }) => Object.freeze({ id, name })))
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value["id"] as number,
    name: value["name"],
    includeCustomFormatWhenRenaming: value["includeCustomFormatWhenRenaming"] as boolean,
    specifications: Object.freeze(specifications),
  });
}

/**
 * Projects a bounded custom-format collection atomically.
 */
export function projectLidarrCustomFormatDefinitions(
  value: unknown,
): readonly LidarrPresetCustomFormatDefinition[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }
  const definitions: LidarrPresetCustomFormatDefinition[] = [];
  for (const definition of value) {
    const projected = projectLidarrCustomFormatDefinition(definition);
    if (projected === undefined) {
      return undefined;
    }
    definitions.push(projected);
  }
  return hasUniqueProjectedIdentities(definitions) ? Object.freeze(definitions) : undefined;
}

/**
 * Projects the dynamic custom-format schema into the supported frozen domain.
 */
export function projectLidarrCustomFormatSchema(
  value: unknown,
): readonly LidarrPresetCustomFormatSpecificationSchema[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }
  const schemas: LidarrPresetCustomFormatSpecificationSchema[] = [];
  const implementations = new Set<LidarrPresetCustomFormatImplementation>();
  const names = new Set<string>();
  for (const schema of value) {
    const projected = projectCustomFormatSpecificationSchema(schema);
    const normalizedName =
      projected === undefined ? undefined : normalizeLidarrName(projected.implementationName);
    if (
      projected === undefined ||
      normalizedName === undefined ||
      implementations.has(projected.implementation) ||
      names.has(normalizedName)
    ) {
      return undefined;
    }
    implementations.add(projected.implementation);
    names.add(normalizedName);
    schemas.push(projected);
  }
  return Object.freeze(schemas);
}

/**
 * Projects one complete rich quality profile without changing tree order.
 */
export function projectLidarrQualityProfileDefinition(
  value: unknown,
): LidarrPresetQualityProfileDefinition | undefined {
  return projectQualityProfileDefinition(value);
}

/**
 * Projects a bounded rich quality-profile collection atomically.
 */
export function projectLidarrQualityProfileDefinitions(
  value: unknown,
): readonly LidarrPresetQualityProfileDefinition[] | undefined {
  if (!isBoundedArray(value)) {
    return undefined;
  }
  const definitions: LidarrPresetQualityProfileDefinition[] = [];
  for (const definition of value) {
    const projected = projectQualityProfileDefinition(definition);
    if (projected === undefined) {
      return undefined;
    }
    definitions.push(projected);
  }
  return hasUniqueProjectedIdentities(definitions) ? Object.freeze(definitions) : undefined;
}

/**
 * Projects Lidarr's recursive quality-profile construction template.
 */
export function projectLidarrQualityProfileSchema(
  value: unknown,
): LidarrPresetQualityProfileSchema | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const items = projectLiveQualityItems(value["items"]);
  const formatItems = projectLiveFormatScores(value["formatItems"]);
  return items === undefined || formatItems === undefined
    ? undefined
    : Object.freeze({ items, formatItems });
}

/**
 * Projects the complete persisted naming singleton.
 */
export function projectLidarrNamingConfig(value: unknown): LidarrPresetNamingConfig | undefined {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasBoolean(value, "renameTracks") ||
    !hasBoolean(value, "replaceIllegalCharacters") ||
    typeof value["colonReplacementFormat"] !== "number" ||
    !Number.isSafeInteger(value["colonReplacementFormat"]) ||
    !isSafeText(value["standardTrackFormat"]) ||
    !isSafeText(value["multiDiscTrackFormat"]) ||
    !isSafeText(value["artistFolderFormat"])
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value["id"] as number,
    renameTracks: value["renameTracks"] as boolean,
    replaceIllegalCharacters: value["replaceIllegalCharacters"] as boolean,
    colonReplacementFormat: value["colonReplacementFormat"],
    standardTrackFormat: value["standardTrackFormat"],
    multiDiscTrackFormat: value["multiDiscTrackFormat"],
    artistFolderFormat: value["artistFolderFormat"],
  });
}

/**
 * Projects the advisory naming examples response.
 */
export function projectLidarrNamingExamples(
  value: unknown,
): LidarrPresetNamingExamples | undefined {
  if (
    !isRecord(value) ||
    !isSafeText(value["singleTrackExample"]) ||
    !isSafeText(value["multiDiscTrackExample"]) ||
    !isSafeText(value["artistFolderExample"]) ||
    !isSafeText(value["albumFolderExample"])
  ) {
    return undefined;
  }
  return Object.freeze({
    singleTrackExample: value["singleTrackExample"],
    multiDiscTrackExample: value["multiDiscTrackExample"],
    artistFolderExample: value["artistFolderExample"],
    albumFolderExample: value["albumFolderExample"],
  });
}

/**
 * Validates and copies a bounded list of profile summaries.
 *
 * The whole response is rejected when it exceeds the resource bound, contains
 * a malformed profile summary, or repeats an id.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh profiles, or `undefined` on failure.
 */
export function projectLidarrProfileSummaries(
  value: unknown,
): readonly LidarrProfile[] | undefined {
  if (!isBoundedArray(value) || !value.every(isLidarrProfile) || !hasUniqueIds(value)) {
    return undefined;
  }
  return Object.freeze(value.map(copyProfile));
}

/** Projects the summary fields exposed by the quality-profile list endpoint. */
export const projectLidarrQualityProfiles = projectLidarrProfileSummaries;

/**
 * Validates and copies a complete metadata-profile response.
 *
 * The whole response is rejected when it exceeds the resource bound, contains
 * a malformed profile, or repeats an id.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh profiles, or `undefined` on failure.
 */
export function projectLidarrMetadataProfiles(
  value: unknown,
): readonly LidarrMetadataProfile[] | undefined {
  if (!isBoundedArray(value) || !value.every(isLidarrMetadataProfile) || !hasUniqueIds(value)) {
    return undefined;
  }
  return Object.freeze(value.map(copyMetadataProfile));
}

/**
 * Validates and copies a complete tag response.
 *
 * The whole response is rejected when it exceeds the resource bound, contains
 * a malformed tag, or repeats an id.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh tags, or `undefined` on failure.
 */
export function projectLidarrTags(value: unknown): readonly LidarrTag[] | undefined {
  if (!isBoundedArray(value) || !value.every(isLidarrTag) || !hasUniqueIds(value)) {
    return undefined;
  }
  return Object.freeze(value.map(copyTag));
}

/**
 * Validates, sanitizes, and copies one command-facing album projection.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrAlbum(value: unknown): LidarrAlbum | undefined {
  return isLidarrAlbum(value) ? copyAlbum(value) : undefined;
}

/**
 * Validates, sanitizes, and copies the complete command-facing album list.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh projections, or `undefined` when validation fails.
 */
export function projectLidarrAlbumArray(value: unknown): readonly LidarrAlbum[] | undefined {
  return isLidarrAlbumArray(value) ? Object.freeze(value.map(copyAlbum)) : undefined;
}

/**
 * Validates and copies a wanted record's nested artist projection.
 *
 * @param value - Unknown nested response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrWantedArtistRef(value: unknown): LidarrWantedArtistRef | undefined {
  return isLidarrWantedArtistRef(value) ? copyWantedArtistRef(value) : undefined;
}

/**
 * Validates and copies one command-facing wanted/missing record.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrWantedRecord(value: unknown): LidarrWantedRecord | undefined {
  return isLidarrWantedRecord(value) ? copyWantedRecord(value) : undefined;
}

/**
 * Validates and copies the command-facing wanted/missing page.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection with fresh nested records, or `undefined` on failure.
 */
export function projectLidarrWantedPage(value: unknown): LidarrWantedPage | undefined {
  return isLidarrWantedPage(value) ? copyWantedPage(value) : undefined;
}

/**
 * Validates and copies one command-facing health-check projection.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen projection, or `undefined` when validation fails.
 */
export function projectLidarrHealthCheck(value: unknown): LidarrHealthCheck | undefined {
  return isLidarrHealthCheck(value) ? copyHealthCheck(value) : undefined;
}

/**
 * Validates and copies the complete command-facing health-check list.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh projections, or `undefined` when validation fails.
 */
export function projectLidarrHealthArray(value: unknown): readonly LidarrHealthCheck[] | undefined {
  return isLidarrHealthArray(value) ? Object.freeze(value.map(copyHealthCheck)) : undefined;
}

/**
 * Validates and copies a complete polymorphic Lidarr combined-search response.
 *
 * Every member must contain one artist or album branch and a durable foreign
 * identifier. The response-local top-level `id` is intentionally ignored.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh frozen candidates, or `undefined` on failure.
 */
export function projectLidarrSearchCandidates(
  value: unknown,
): readonly LidarrSearchCandidateInput[] | undefined {
  return projectSearchCollection(value, projectCombinedSearchCandidate);
}

/**
 * Validates and copies a complete Lidarr artist-lookup response.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh frozen candidates, or `undefined` on failure.
 */
export function projectLidarrArtistLookupCandidates(
  value: unknown,
): readonly LidarrSearchCandidateInput[] | undefined {
  return projectSearchCollection(value, projectArtistSearchCandidate);
}

/**
 * Validates and copies a complete Lidarr album-lookup response.
 *
 * @param value - Unknown generated-client response data.
 * @returns A fresh frozen array of fresh frozen candidates, or `undefined` on failure.
 */
export function projectLidarrAlbumLookupCandidates(
  value: unknown,
): readonly LidarrSearchCandidateInput[] | undefined {
  return projectSearchCollection(value, projectAlbumSearchCandidate);
}

function optionalPositiveInteger(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalFiniteNonNegativeNumber(record: UnknownRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalSafeText(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && isSafeText(value) ? value : undefined;
}

function projectManualImportArtist(value: unknown): LidarrManualImportArtist | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalPositiveInteger(value, "id");
  const name = optionalSafeText(value, "artistName");
  const foreignArtistId =
    optionalSafeText(value, "foreignArtistId") ?? optionalSafeText(value, "mbId");
  return id === undefined && name === undefined && foreignArtistId === undefined
    ? undefined
    : Object.freeze({
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(foreignArtistId === undefined ? {} : { foreignArtistId }),
      });
}

function projectManualImportAlbum(value: unknown): LidarrManualImportAlbum | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalPositiveInteger(value, "id");
  const artistId = optionalPositiveInteger(value, "artistId");
  const title = optionalSafeText(value, "title");
  const foreignAlbumId = optionalSafeText(value, "foreignAlbumId");
  return id === undefined &&
    artistId === undefined &&
    title === undefined &&
    foreignAlbumId === undefined
    ? undefined
    : Object.freeze({
        ...(id === undefined ? {} : { id }),
        ...(artistId === undefined ? {} : { artistId }),
        ...(title === undefined ? {} : { title }),
        ...(foreignAlbumId === undefined ? {} : { foreignAlbumId }),
      });
}

function projectManualImportTrack(value: unknown): LidarrManualImportTrack | undefined {
  if (!isRecord(value)) return undefined;
  const id = optionalPositiveInteger(value, "id");
  const artistId = optionalPositiveInteger(value, "artistId");
  const albumId = optionalPositiveInteger(value, "albumId");
  const title = optionalSafeText(value, "title");
  const foreignTrackId = optionalSafeText(value, "foreignTrackId");
  const foreignRecordingId = optionalSafeText(value, "foreignRecordingId");
  const mediumNumber = optionalFiniteNonNegativeNumber(value, "mediumNumber");
  const absoluteTrackNumber = optionalFiniteNonNegativeNumber(value, "absoluteTrackNumber");
  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    ...(artistId === undefined ? {} : { artistId }),
    ...(albumId === undefined ? {} : { albumId }),
    ...(title === undefined ? {} : { title }),
    ...(foreignTrackId === undefined ? {} : { foreignTrackId }),
    ...(foreignRecordingId === undefined ? {} : { foreignRecordingId }),
    ...(mediumNumber === undefined ? {} : { mediumNumber }),
    ...(absoluteTrackNumber === undefined ? {} : { absoluteTrackNumber }),
  });
}

function projectManualImportAudioTags(value: unknown): LidarrManualImportAudioTags | undefined {
  if (!isRecord(value)) return undefined;
  const rawTrackNumbers = value["trackNumbers"];
  if (
    rawTrackNumbers !== undefined &&
    (!isBoundedArray(rawTrackNumbers) ||
      rawTrackNumbers.some(
        (trackNumber) =>
          typeof trackNumber !== "number" || !Number.isSafeInteger(trackNumber) || trackNumber < 0,
      ))
  ) {
    return undefined;
  }
  const title = optionalSafeText(value, "title");
  const artistTitle = optionalSafeText(value, "artistTitle");
  const albumTitle = optionalSafeText(value, "albumTitle");
  const artistMbId = optionalSafeText(value, "artistMBId");
  const albumMbId = optionalSafeText(value, "albumMBId");
  const releaseMbId = optionalSafeText(value, "releaseMBId");
  const recordingMbId = optionalSafeText(value, "recordingMBId");
  const trackMbId = optionalSafeText(value, "trackMBId");
  const discNumber = optionalFiniteNonNegativeNumber(value, "discNumber");
  return Object.freeze({
    ...(title === undefined ? {} : { title }),
    ...(artistTitle === undefined ? {} : { artistTitle }),
    ...(albumTitle === undefined ? {} : { albumTitle }),
    ...(artistMbId === undefined ? {} : { artistMbId }),
    ...(albumMbId === undefined ? {} : { albumMbId }),
    ...(releaseMbId === undefined ? {} : { releaseMbId }),
    ...(recordingMbId === undefined ? {} : { recordingMbId }),
    ...(trackMbId === undefined ? {} : { trackMbId }),
    ...(discNumber === undefined ? {} : { discNumber }),
    trackNumbers: Object.freeze([...(rawTrackNumbers ?? [])] as number[]),
  });
}

function projectManualImportReleaseForeignId(
  album: unknown,
  albumReleaseId: number | undefined,
): string | undefined {
  if (!isRecord(album) || albumReleaseId === undefined || !isBoundedArray(album["releases"])) {
    return undefined;
  }
  const selectedRelease = album["releases"].find(
    (release) => isRecord(release) && release["id"] === albumReleaseId,
  );
  return isRecord(selectedRelease)
    ? optionalSafeText(selectedRelease, "foreignReleaseId")
    : undefined;
}

function projectManualImportRejection(value: unknown): LidarrManualImportRejection | undefined {
  if (!isRecord(value)) return undefined;
  const reason = optionalSafeText(value, "reason") ?? "Lidarr rejected this candidate";
  const rawType = value["type"];
  const type = rawType === "permanent" || rawType === "temporary" ? rawType : undefined;
  return Object.freeze({ reason, ...(type === undefined ? {} : { type }) });
}

function projectManualImportCandidate(value: unknown): LidarrManualImportCandidate | undefined {
  if (!isRecord(value) || !isSafeLabel(value["path"])) return undefined;
  const rawTracks = value["tracks"];
  const rawRejections = value["rejections"];
  if (
    (rawTracks !== undefined && rawTracks !== null && !isBoundedArray(rawTracks)) ||
    (rawRejections !== undefined && rawRejections !== null && !isBoundedArray(rawRejections))
  ) {
    return undefined;
  }
  const tracks = (rawTracks ?? []).map(projectManualImportTrack);
  const rejections = (rawRejections ?? []).map(projectManualImportRejection);
  if (
    tracks.some((track) => track === undefined) ||
    rejections.some((item) => item === undefined)
  ) {
    return undefined;
  }
  const artist = projectManualImportArtist(value["artist"]);
  const album = projectManualImportAlbum(value["album"]);
  const audioTags = projectManualImportAudioTags(value["audioTags"]);
  const id = optionalPositiveInteger(value, "id");
  const name = optionalSafeText(value, "name");
  const size = optionalFiniteNonNegativeNumber(value, "size");
  const albumReleaseId = optionalPositiveInteger(value, "albumReleaseId");
  const albumReleaseForeignId = projectManualImportReleaseForeignId(value["album"], albumReleaseId);
  const releaseGroup = optionalSafeText(value, "releaseGroup");
  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    path: value["path"],
    ...(name === undefined ? {} : { name }),
    ...(size === undefined ? {} : { size }),
    ...(artist === undefined ? {} : { artist }),
    ...(album === undefined ? {} : { album }),
    ...(albumReleaseId === undefined ? {} : { albumReleaseId }),
    ...(albumReleaseForeignId === undefined ? {} : { albumReleaseForeignId }),
    tracks: Object.freeze(tracks as LidarrManualImportTrack[]),
    ...(releaseGroup === undefined ? {} : { releaseGroup }),
    rejections: Object.freeze(rejections as LidarrManualImportRejection[]),
    ...(audioTags === undefined ? {} : { audioTags }),
    additionalFile: value["additionalFile"] === true,
    replaceExistingFiles: value["replaceExistingFiles"] === true,
  });
}

/** Projects Lidarr's manual-import probe response without leaking generated resources. */
export function projectLidarrManualImportCandidates(
  value: unknown,
): readonly LidarrManualImportCandidate[] | undefined {
  if (!isBoundedArray(value)) return undefined;
  const candidates = value.map(projectManualImportCandidate);
  return candidates.some((candidate) => candidate === undefined)
    ? undefined
    : Object.freeze(candidates as LidarrManualImportCandidate[]);
}

function projectTrack(value: unknown): LidarrTrack | undefined {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasPositiveSafeInteger(value, "artistId") ||
    !hasPositiveSafeInteger(value, "albumId")
  ) {
    return undefined;
  }
  const title = optionalSafeText(value, "title") ?? `Track ${String(value["id"])}`;
  const foreignTrackId = optionalSafeText(value, "foreignTrackId");
  const foreignRecordingId = optionalSafeText(value, "foreignRecordingId");
  const trackFileId = optionalPositiveInteger(value, "trackFileId");
  const absoluteTrackNumber = optionalFiniteNonNegativeNumber(value, "absoluteTrackNumber");
  const trackNumber = optionalSafeText(value, "trackNumber");
  const mediumNumber = optionalFiniteNonNegativeNumber(value, "mediumNumber");
  return Object.freeze({
    id: value["id"] as number,
    artistId: value["artistId"] as number,
    albumId: value["albumId"] as number,
    title,
    ...(foreignTrackId === undefined ? {} : { foreignTrackId }),
    ...(foreignRecordingId === undefined ? {} : { foreignRecordingId }),
    ...(trackFileId === undefined ? {} : { trackFileId }),
    ...(absoluteTrackNumber === undefined ? {} : { absoluteTrackNumber }),
    ...(trackNumber === undefined ? {} : { trackNumber }),
    ...(mediumNumber === undefined ? {} : { mediumNumber }),
    hasFile: value["hasFile"] === true,
  });
}

/** Projects a bounded parent-scoped Lidarr track response. */
export function projectLidarrTracks(value: unknown): readonly LidarrTrack[] | undefined {
  if (!isBoundedArray(value)) return undefined;
  const tracks = value.map(projectTrack);
  if (tracks.some((track) => track === undefined)) return undefined;
  const projected = tracks as LidarrTrack[];
  return new Set(projected.map((track) => track.id)).size === projected.length
    ? Object.freeze(projected)
    : undefined;
}

function projectTrackFile(value: unknown): LidarrTrackFile | undefined {
  if (
    !isRecord(value) ||
    !hasPositiveSafeInteger(value, "id") ||
    !hasPositiveSafeInteger(value, "artistId") ||
    !hasPositiveSafeInteger(value, "albumId") ||
    !isSafeLabel(value["path"]) ||
    typeof value["size"] !== "number" ||
    !Number.isSafeInteger(value["size"]) ||
    value["size"] < 0
  ) {
    return undefined;
  }
  const dateAdded = optionalSafeText(value, "dateAdded");
  return Object.freeze({
    id: value["id"] as number,
    artistId: value["artistId"] as number,
    albumId: value["albumId"] as number,
    path: value["path"],
    size: value["size"],
    ...(dateAdded === undefined ? {} : { dateAdded }),
  });
}

/** Projects a bounded exact Lidarr trackfile response. */
export function projectLidarrTrackFiles(value: unknown): readonly LidarrTrackFile[] | undefined {
  if (!isBoundedArray(value)) return undefined;
  const trackFiles = value.map(projectTrackFile);
  if (trackFiles.some((trackFile) => trackFile === undefined)) return undefined;
  const projected = trackFiles as LidarrTrackFile[];
  return new Set(projected.map((trackFile) => trackFile.id)).size === projected.length
    ? Object.freeze(projected)
    : undefined;
}
