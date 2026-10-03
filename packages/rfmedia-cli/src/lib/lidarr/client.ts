/**
 * Stable command-facing Lidarr facade backed by the generated OpenAPI client.
 *
 * Generated code owns endpoint paths, methods, query serialization, and wire
 * response types. The handwritten facade owns operation context, strict domain
 * projection, and the public error boundary. The hardened transport remains the
 * sole owner of origin, credentials, redirects, timeouts, and body limits.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  LidarrAlbum,
  LidarrAlbumDeleteInput,
  LidarrArtist,
  LidarrArtistAddInput,
  LidarrHealthCheck,
  LidarrManualImportCandidate,
  LidarrManualImportProbeInput,
  LidarrMetadataProfile,
  LidarrProfile,
  LidarrProfileAssignmentInput,
  LidarrRootFolder,
  LidarrSearchCandidateInput,
  LidarrSearchQuery,
  LidarrSystemStatus,
  LidarrTag,
  LidarrTagMutationInput,
  LidarrTrack,
  LidarrTrackFile,
  LidarrWantedPage,
} from "../../types/lidarr.js";
import { LIDARR_PLAN_MAX_ENTRIES } from "../../types/lidarr-plan.js";
import type {
  LidarrPresetCustomFormatCreateInput,
  LidarrPresetCustomFormatDefinition,
  LidarrPresetCustomFormatSpecificationSchema,
  LidarrPresetCustomFormatUpdateInput,
  LidarrPresetLiveQualityItem,
  LidarrPresetNamingConfig,
  LidarrPresetNamingExamples,
  LidarrPresetNamingUpdateInput,
  LidarrPresetQualityProfileCreateInput,
  LidarrPresetQualityProfileDefinition,
  LidarrPresetQualityProfileSchema,
  LidarrPresetQualityProfileUpdateInput,
} from "../../types/lidarr-presets.js";
import {
  LidarrError,
  LidarrNotFoundError,
  LidarrUnreachableError,
  LidarrValidationError,
  classifyLidarrStatus,
  hasLidarrHttpStatus,
  parseRetryAfter,
} from "./errors.js";
import { createClient, type Client as GeneratedClient } from "./generated/client/index.js";
import {
  deleteApiV1AlbumById,
  deleteApiV1ArtistById,
  deleteApiV1TrackfileBulk,
  getApiV1Album,
  getApiV1AlbumById,
  getApiV1AlbumLookup,
  getApiV1Artist,
  getApiV1ArtistById,
  getApiV1ArtistLookup,
  getApiV1ConfigNaming,
  getApiV1ConfigNamingExamples,
  getApiV1Customformat,
  getApiV1CustomformatById,
  getApiV1CustomformatSchema,
  getApiV1Health,
  getApiV1Manualimport,
  getApiV1Metadataprofile,
  getApiV1Qualityprofile,
  getApiV1QualityprofileById,
  getApiV1QualityprofileSchema,
  getApiV1Rootfolder,
  getApiV1Search,
  getApiV1SystemStatus,
  getApiV1Tag,
  getApiV1Track,
  getApiV1Trackfile,
  getApiV1WantedMissing,
  postApiV1Artist,
  postApiV1Customformat,
  postApiV1Qualityprofile,
  putApiV1AlbumById,
  putApiV1AlbumMonitor,
  putApiV1ArtistEditor,
  putApiV1ConfigNamingById,
  putApiV1CustomformatById,
  putApiV1QualityprofileById,
} from "./generated/sdk.gen.js";
import type {
  AlbumResourceWritable,
  ArtistResourceWritable,
  CustomFormatResource,
  QualityProfileQualityItemResource,
  QualityProfileResource,
} from "./generated/types.gen.js";
import { createLidarrTransport, type LidarrTransportDependencies } from "./transport.js";
import type { LidarrApiKeyProvider, LidarrConnectionSettings } from "./types.js";
import {
  projectLidarrAlbumLookupCandidates,
  projectLidarrAlbumArray,
  projectLidarrArtistLookupCandidates,
  projectLidarrArtistArray,
  projectLidarrCustomFormatDefinition,
  projectLidarrCustomFormatDefinitions,
  projectLidarrCustomFormatSchema,
  projectLidarrHealthArray,
  projectLidarrManualImportCandidates,
  projectLidarrMetadataProfiles,
  projectLidarrNamingConfig,
  projectLidarrNamingExamples,
  projectLidarrProfileSummaries,
  projectLidarrQualityProfileDefinition,
  projectLidarrQualityProfileDefinitions,
  projectLidarrQualityProfileSchema,
  projectLidarrRootFolders,
  projectLidarrSearchCandidates,
  projectLidarrSystemStatus,
  projectLidarrTags,
  projectLidarrTargetArtist,
  projectLidarrTrackFiles,
  projectLidarrTracks,
  projectLidarrWantedPage,
} from "./types.js";

const DEFAULT_WANTED_PAGE = 1;
const DEFAULT_WANTED_PAGE_SIZE = 50;
const DEFAULT_WANTED_SORT_KEY = "releaseDate";
const CANONICAL_MUSICBRAINZ_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const UNSAFE_WRITE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u;

/**
 * Maximum album IDs serialized into one `GET /api/v1/album` query. IDs are
 * form-exploded (`albumIds=1&albumIds=2`), so 200 IDs keep the URL near 4 KB;
 * do not raise past ~300-400 without checking proxy URL limits.
 */
export const LIDARR_ALBUM_IDS_CHUNK_SIZE = 200;

type DomainProjector<T> = (value: unknown) => T | undefined;

/** Test seams and hard response limits for one private Lidarr client. */
export interface LidarrClientDependencies extends Omit<
  LidarrTransportDependencies,
  "operation" | "getOperation"
> {}

/** Query parameters for the server-paginated wanted/missing endpoint. */
export interface LidarrWantedQuery {
  /** 1-based page number; defaults to 1. */
  readonly page?: number;
  /** Page size; defaults to 50. */
  readonly pageSize?: number;
  /** Sort key; defaults to `releaseDate`. */
  readonly sortKey?: string;
  /** Sort direction; omitted when not supplied. */
  readonly sortDirection?: "ascending" | "descending";
  /** Optional caller abort signal. */
  readonly signal?: AbortSignal;
}

/**
 * Query for the client-side-scoped album list endpoint.
 *
 * At least one of `artistId`/`albumIds` is required at runtime — every query
 * parameter on `GET /api/v1/album` is optional in the SDK, so this guard is
 * the sole protection against an accidental whole-library fetch.
 */
export interface LidarrAlbumQuery {
  /** Scope to one artist's albums. */
  readonly artistId?: number;
  /** Scope to exact album IDs (chunked into sequential GETs). */
  readonly albumIds?: readonly number[];
  /** Optional caller abort signal. */
  readonly signal?: AbortSignal;
}

/** Parent-scoped track query; whole-library reads are intentionally unsupported. */
export interface LidarrTrackQuery {
  readonly albumId: number;
  readonly trackIds?: readonly number[];
  readonly signal?: AbortSignal;
}

/** Exact album or trackfile scope for managed-file reads. */
export interface LidarrTrackFileQuery {
  readonly albumIds?: readonly number[];
  readonly trackFileIds?: readonly number[];
  readonly signal?: AbortSignal;
}

/** Narrow interface the Lidarr actions depend on (mockable seam). */
export interface LidarrClientApi {
  /**
   * Fetches the Lidarr system status.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated system status.
   */
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>;
  /**
   * Fetches the Lidarr health checks.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated health-check list.
   */
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>;
  /**
   * Fetches the full Lidarr artist list.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated artist list.
   */
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>;
  /**
   * Searches Lidarr for artist and album candidates.
   *
   * @param query - Normalized term and optional caller abort signal.
   * @returns The validated complete candidate list.
   */
  search(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
  /**
   * Looks up artist candidates in Lidarr.
   *
   * @param query - Normalized term and optional caller abort signal.
   * @returns The validated complete artist candidate list.
   */
  lookupArtists(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
  /**
   * Looks up album candidates in Lidarr.
   *
   * @param query - Normalized term and optional caller abort signal.
   * @returns The validated complete album candidate list.
   */
  lookupAlbums(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]>;
  /**
   * Reads one installed artist by canonical MusicBrainz artist id.
   *
   * @param foreignArtistId - Canonical lowercase MusicBrainz artist UUID.
   * @param signal - Optional caller abort signal.
   * @returns The exact installed artist, or `undefined` only for an empty result.
   */
  getArtistByForeignId(
    foreignArtistId: string,
    signal?: AbortSignal,
  ): Promise<LidarrArtist | undefined>;
  /**
   * Fetches the complete root-folder list.
   *
   * @param signal - Optional caller abort signal.
   * @returns Strict generated-independent root-folder projections.
   */
  listRootFolders(signal?: AbortSignal): Promise<readonly LidarrRootFolder[]>;
  /**
   * Resolves authoritative Lidarr lookup identity for one sealed add request.
   *
   * @param input - Reviewed artist identity, root, profiles, and fixed policy.
   * @param signal - Optional caller abort signal.
   * @returns A validated add input whose name and MBID came from one exact lookup.
   */
  prepareArtistAdd(
    input: LidarrArtistAddInput,
    signal?: AbortSignal,
  ): Promise<LidarrArtistAddInput>;
  /**
   * Sends one previously prepared artist create request without another read.
   *
   * @param input - Input returned by `prepareArtistAdd`.
   * @param signal - Optional caller abort signal.
   * @returns The authoritative created artist.
   */
  addArtist(input: LidarrArtistAddInput, signal?: AbortSignal): Promise<LidarrArtist>;
  /**
   * Fetches one artist by its stable Lidarr ID.
   *
   * @param artistId - Positive Lidarr artist ID.
   * @param signal - Optional caller abort signal.
   * @returns The validated targeted artist.
   */
  getArtist(artistId: number, signal?: AbortSignal): Promise<LidarrArtist>;
  /**
   * Deletes one artist through Lidarr's single-resource endpoint.
   *
   * @param artistId - Positive Lidarr artist ID.
   * @param deleteFiles - Whether Lidarr should delete managed artist files.
   * @param signal - Optional caller abort signal.
   * @returns When Lidarr accepts the delete request.
   */
  deleteArtist(artistId: number, deleteFiles: boolean, signal?: AbortSignal): Promise<void>;
  /**
   * Fetches the complete quality-profile list.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated quality profiles.
   */
  listQualityProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]>;
  /** Fetches complete custom-format definitions. */
  listCustomFormats(signal?: AbortSignal): Promise<readonly LidarrPresetCustomFormatDefinition[]>;
  /** Fetches one complete custom-format definition by positive ID. */
  getCustomFormat(
    customFormatId: number,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition>;
  /** Fetches the supported custom-format condition schema. */
  getCustomFormatSchema(
    signal?: AbortSignal,
  ): Promise<readonly LidarrPresetCustomFormatSpecificationSchema[]>;
  /** Creates one complete custom format and returns the authoritative response. */
  createCustomFormat(
    input: LidarrPresetCustomFormatCreateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition>;
  /** Replaces one complete custom format and returns the authoritative response. */
  updateCustomFormat(
    input: LidarrPresetCustomFormatUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition>;
  /** Fetches complete rich quality-profile definitions. */
  listQualityProfileDefinitions(
    signal?: AbortSignal,
  ): Promise<readonly LidarrPresetQualityProfileDefinition[]>;
  /** Fetches one complete rich quality profile by positive ID. */
  getQualityProfileDefinition(
    qualityProfileId: number,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition>;
  /** Fetches the recursive quality-profile construction template. */
  getQualityProfileSchema(signal?: AbortSignal): Promise<LidarrPresetQualityProfileSchema>;
  /** Creates one complete quality profile and returns the authoritative response. */
  createQualityProfile(
    input: LidarrPresetQualityProfileCreateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition>;
  /** Replaces one complete quality profile and returns the authoritative response. */
  updateQualityProfile(
    input: LidarrPresetQualityProfileUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition>;
  /** Fetches Lidarr's persisted naming singleton. */
  getNamingConfig(signal?: AbortSignal): Promise<LidarrPresetNamingConfig>;
  /** Renders advisory examples for one complete candidate naming configuration. */
  getNamingExamples(
    input: LidarrPresetNamingUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetNamingExamples>;
  /** Replaces the persisted naming singleton and returns the authoritative response. */
  updateNamingConfig(
    input: LidarrPresetNamingUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetNamingConfig>;
  /**
   * Fetches the complete metadata-profile list.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated metadata profiles.
   */
  listMetadataProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]>;
  /**
   * Fetches detailed metadata profiles for structural artist-add policy.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated metadata profiles with album-type evidence.
   */
  listMetadataProfileDetails(signal?: AbortSignal): Promise<readonly LidarrMetadataProfile[]>;
  /**
   * Fetches the complete tag list.
   *
   * @param signal - Optional caller abort signal.
   * @returns The validated tags.
   */
  listTags(signal?: AbortSignal): Promise<readonly LidarrTag[]>;
  /** Updates the monitored state for exact Lidarr artist IDs. */
  setArtistsMonitored(
    artistIds: readonly number[],
    monitored: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Fetches albums scoped by artist or exact album IDs.
   *
   * @param query - Scope query; at least one of `artistId`/`albumIds` required.
   * @returns The validated, sanitized album list.
   */
  listAlbums(query: LidarrAlbumQuery): Promise<readonly LidarrAlbum[]>;
  /** Runs Lidarr's read-only manual-import matcher for one local folder. */
  probeManualImport(
    input: LidarrManualImportProbeInput,
  ): Promise<readonly LidarrManualImportCandidate[]>;
  /** Fetches tracks for one exact parent album. */
  listTracks(query: LidarrTrackQuery): Promise<readonly LidarrTrack[]>;
  /** Fetches managed trackfiles under one explicit album or ID scope. */
  listTrackFiles(query: LidarrTrackFileQuery): Promise<readonly LidarrTrackFile[]>;
  /** Deletes one non-empty exact set of managed trackfiles through Lidarr. */
  bulkDeleteTrackFiles(trackFileIds: readonly number[], signal?: AbortSignal): Promise<void>;
  /** Updates the monitored state for exact Lidarr album IDs. */
  setAlbumsMonitored(
    albumIds: readonly number[],
    monitored: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Deletes one Lidarr album, optionally including its files on disk.
   *
   * A 404 propagates as a `not-found` {@link LidarrError} — already-deleted
   * idempotency belongs to the plan/apply layer, never to this boundary.
   *
   * @param albumId - Positive Lidarr album ID.
   * @param options - Explicit file-deletion and import-list-exclusion intent.
   * @param signal - Optional caller abort signal.
   * @returns When Lidarr accepts the deletion.
   */
  deleteAlbum(
    albumId: number,
    options: LidarrAlbumDeleteInput,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Sets one album's release policy (`anyReleaseOk`) via a confined
   * GET → mutate-one-field → PUT round-trip that forwards every unprojected
   * wire field verbatim.
   *
   * @param albumId - Positive Lidarr album ID.
   * @param anyReleaseOk - Desired release-policy value.
   * @param signal - Optional caller abort signal.
   * @returns When Lidarr accepts the update.
   */
  setAlbumAnyReleaseOk(albumId: number, anyReleaseOk: boolean, signal?: AbortSignal): Promise<void>;
  /**
   * Assigns one artist's requested profile dimensions.
   *
   * @param artistId - Positive Lidarr artist ID.
   * @param assignment - One or both desired profile IDs.
   * @param signal - Optional caller abort signal.
   * @returns When Lidarr accepts the editor request.
   */
  setArtistProfiles(
    artistId: number,
    assignment: LidarrProfileAssignmentInput,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Applies one explicit tag intent to one artist.
   *
   * @param artistId - Positive Lidarr artist ID.
   * @param mutation - Tag mode and requested tag IDs.
   * @param signal - Optional caller abort signal.
   * @returns When Lidarr accepts the editor request.
   */
  updateArtistTags(
    artistId: number,
    mutation: LidarrTagMutationInput,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Fetches one page of wanted/missing albums.
   *
   * @param query - Optional paging and sort parameters.
   * @returns The validated wanted/missing page.
   */
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callerAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Lidarr request was cancelled", "AbortError");
}

function invalidResponseError(operation: string, malformed = false): LidarrValidationError {
  return new LidarrValidationError(
    operation,
    malformed
      ? `Lidarr returned a malformed ${operation} response`
      : "Lidarr returned an invalid JSON response",
    "invalid-response",
  );
}

function validationError(operation: string, message: string): LidarrValidationError {
  return new LidarrValidationError(operation, message, "validation");
}

function validatePositiveId(value: unknown, operation: string, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw validationError(operation, `${field} must be a positive safe integer`);
  }
  return value;
}

function validateCanonicalMusicBrainzId(value: unknown, operation: string, field: string): string {
  if (typeof value !== "string" || !CANONICAL_MUSICBRAINZ_ID_PATTERN.test(value)) {
    throw validationError(operation, `${field} must be a canonical lowercase MusicBrainz UUID`);
  }
  return value;
}

function validateSafeWriteText(value: unknown, operation: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim().length === 0 ||
    UNSAFE_WRITE_TEXT_PATTERN.test(value)
  ) {
    throw validationError(operation, `${field} must be a non-empty control-free string`);
  }
  return value;
}

function validateArtistAddInput(
  input: LidarrArtistAddInput,
  operation: string,
): LidarrArtistAddInput {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "artistName",
      "foreignArtistId",
      "rootFolderPath",
      "qualityProfileId",
      "metadataProfileId",
      "monitored",
      "monitorNewItems",
      "searchForMissingAlbums",
    ]) ||
    typeof input["monitored"] !== "boolean" ||
    input["monitorNewItems"] !== "none" ||
    input["searchForMissingAlbums"] !== false
  ) {
    throw validationError(operation, "Artist add input is malformed");
  }
  return Object.freeze({
    artistName: validateSafeWriteText(input["artistName"], operation, "Artist name"),
    foreignArtistId: validateCanonicalMusicBrainzId(
      input["foreignArtistId"],
      operation,
      "Foreign artist ID",
    ),
    rootFolderPath: validateSafeWriteText(input["rootFolderPath"], operation, "Root folder path"),
    qualityProfileId: validatePositiveId(
      input["qualityProfileId"],
      operation,
      "Quality profile ID",
    ),
    metadataProfileId: validatePositiveId(
      input["metadataProfileId"],
      operation,
      "Metadata profile ID",
    ),
    monitored: input["monitored"],
    monitorNewItems: "none",
    searchForMissingAlbums: false,
  });
}

function validateExactIds(value: readonly number[], operation: string, field: string): number[] {
  if (
    value.length === 0 ||
    value.length > LIDARR_PLAN_MAX_ENTRIES ||
    new Set(value).size !== value.length ||
    value.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw validationError(
      operation,
      `${field} must contain 1-${LIDARR_PLAN_MAX_ENTRIES} unique positive integers`,
    );
  }
  return [...value].sort((left, right) => left - right);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const MAX_PRESET_WRITE_COLLECTION_SIZE = 1_000;
const MAX_PRESET_WRITE_TREE_DEPTH = 16;
const MAX_PRESET_WRITE_TREE_NODES = 4_096;

function buildCustomFormatBody(
  input: LidarrPresetCustomFormatCreateInput | LidarrPresetCustomFormatUpdateInput,
  operation: string,
  update: boolean,
): CustomFormatResource {
  const allowedKeys = update
    ? ["id", "name", "includeCustomFormatWhenRenaming", "specifications"]
    : ["name", "includeCustomFormatWhenRenaming", "specifications"];
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, allowedKeys) ||
    !Array.isArray(input["specifications"]) ||
    input["specifications"].length > MAX_PRESET_WRITE_COLLECTION_SIZE
  ) {
    throw validationError(operation, "Custom format input is malformed");
  }
  const id = update ? validatePositiveId(input["id"], operation, "Custom format ID") : 1;
  const validationSpecifications = input["specifications"].map((specification, index) => {
    if (
      !isRecord(specification) ||
      !hasOnlyKeys(specification, ["name", "implementation", "negate", "required", "fields"]) ||
      !isRecord(specification["fields"])
    ) {
      return undefined;
    }
    return {
      id: index + 1,
      name: specification["name"],
      implementation: specification["implementation"],
      negate: specification["negate"],
      required: specification["required"],
      fields: Object.entries(specification["fields"]).map(([name, value]) => ({ name, value })),
    };
  });
  const projected = projectLidarrCustomFormatDefinition({
    id,
    name: input["name"],
    includeCustomFormatWhenRenaming: input["includeCustomFormatWhenRenaming"],
    specifications: validationSpecifications,
  });
  if (projected === undefined) {
    throw validationError(operation, "Custom format input is malformed");
  }
  return {
    ...(update ? { id: projected.id } : {}),
    name: projected.name,
    includeCustomFormatWhenRenaming: projected.includeCustomFormatWhenRenaming,
    specifications: projected.specifications.map((specification) => ({
      name: specification.name,
      implementation: specification.implementation,
      negate: specification.negate,
      required: specification.required,
      fields: Object.entries(specification.fields).map(([name, value]) => ({ name, value })),
    })),
  };
}

interface QualityWriteContext {
  nodes: number;
}

function buildQualityItemValidationWire(
  value: unknown,
  depth: number,
  context: QualityWriteContext,
): QualityProfileQualityItemResource | undefined {
  if (
    !isRecord(value) ||
    depth > MAX_PRESET_WRITE_TREE_DEPTH ||
    ++context.nodes > MAX_PRESET_WRITE_TREE_NODES
  ) {
    return undefined;
  }
  if (value["kind"] === "quality") {
    if (
      !hasOnlyKeys(value, ["kind", "id", "quality", "allowed"]) ||
      !isRecord(value["quality"]) ||
      !hasOnlyKeys(value["quality"], ["id", "name"])
    ) {
      return undefined;
    }
    return {
      id: value["id"] as number,
      quality: {
        id: value["quality"]["id"] as number,
        name: value["quality"]["name"] as string,
      },
      allowed: value["allowed"] as boolean,
      items: [],
    };
  }
  if (
    value["kind"] !== "group" ||
    !hasOnlyKeys(value, ["kind", "id", "name", "allowed", "items"]) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > MAX_PRESET_WRITE_COLLECTION_SIZE
  ) {
    return undefined;
  }
  const items = value["items"].map((item) =>
    buildQualityItemValidationWire(item, depth + 1, context),
  );
  if (items.some((item) => item === undefined)) {
    return undefined;
  }
  return {
    id: value["id"] as number,
    name: value["name"] as string,
    allowed: value["allowed"] as boolean,
    items: items as QualityProfileQualityItemResource[],
  };
}

function buildQualityItemBody(
  item: LidarrPresetLiveQualityItem,
): QualityProfileQualityItemResource {
  return item.kind === "quality"
    ? {
        id: item.id,
        quality: { id: item.quality.id, name: item.quality.name },
        allowed: item.allowed,
        items: [],
      }
    : {
        id: item.id,
        name: item.name,
        allowed: item.allowed,
        items: item.items.map(buildQualityItemBody),
      };
}

function buildQualityProfileBody(
  input: LidarrPresetQualityProfileCreateInput | LidarrPresetQualityProfileUpdateInput,
  operation: string,
  update: boolean,
): QualityProfileResource {
  const allowedKeys = update
    ? [
        "id",
        "name",
        "upgradeAllowed",
        "cutoff",
        "items",
        "minFormatScore",
        "cutoffFormatScore",
        "formatItems",
      ]
    : [
        "name",
        "upgradeAllowed",
        "cutoff",
        "items",
        "minFormatScore",
        "cutoffFormatScore",
        "formatItems",
      ];
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, allowedKeys) ||
    !Array.isArray(input["items"]) ||
    input["items"].length > MAX_PRESET_WRITE_COLLECTION_SIZE ||
    !Array.isArray(input["formatItems"]) ||
    input["formatItems"].length > MAX_PRESET_WRITE_COLLECTION_SIZE
  ) {
    throw validationError(operation, "Quality profile input is malformed");
  }
  const context: QualityWriteContext = { nodes: 0 };
  const items = input["items"].map((item) => buildQualityItemValidationWire(item, 1, context));
  const formatItems = input["formatItems"].map((item) => {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ["customFormat", "score"]) ||
      !isRecord(item["customFormat"]) ||
      !hasOnlyKeys(item["customFormat"], ["id", "name"])
    ) {
      return undefined;
    }
    return {
      format: item["customFormat"]["id"],
      name: item["customFormat"]["name"],
      score: item["score"],
    };
  });
  const id = update ? validatePositiveId(input["id"], operation, "Quality profile ID") : 1;
  const projected = projectLidarrQualityProfileDefinition({
    id,
    name: input["name"],
    upgradeAllowed: input["upgradeAllowed"],
    cutoff: input["cutoff"],
    items,
    minFormatScore: input["minFormatScore"],
    cutoffFormatScore: input["cutoffFormatScore"],
    formatItems,
  });
  if (projected === undefined) {
    throw validationError(operation, "Quality profile input is malformed");
  }
  return {
    ...(update ? { id: projected.id } : {}),
    name: projected.name,
    upgradeAllowed: projected.upgradeAllowed,
    cutoff: projected.cutoff,
    items: projected.items.map(buildQualityItemBody),
    minFormatScore: projected.minFormatScore,
    cutoffFormatScore: projected.cutoffFormatScore,
    formatItems: projected.formatItems.map(({ customFormat, score }) => ({
      format: customFormat.id,
      name: customFormat.name,
      score,
    })),
  };
}

function buildNamingBody(
  input: LidarrPresetNamingUpdateInput,
  operation: string,
): LidarrPresetNamingConfig {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, [
      "id",
      "renameTracks",
      "replaceIllegalCharacters",
      "colonReplacementFormat",
      "standardTrackFormat",
      "multiDiscTrackFormat",
      "artistFolderFormat",
    ])
  ) {
    throw validationError(operation, "Naming configuration input is malformed");
  }
  const projected = projectLidarrNamingConfig(input);
  if (projected === undefined) {
    throw validationError(operation, "Naming configuration input is malformed");
  }
  return {
    id: projected.id,
    renameTracks: projected.renameTracks,
    replaceIllegalCharacters: projected.replaceIllegalCharacters,
    colonReplacementFormat: projected.colonReplacementFormat,
    standardTrackFormat: projected.standardTrackFormat,
    multiDiscTrackFormat: projected.multiDiscTrackFormat,
    artistFolderFormat: projected.artistFolderFormat,
  };
}

/**
 * Exact message `classifyLidarrStatus` (the single status mapper, which the
 * transport applies before this facade sees a response) produces for HTTP 404.
 * It is the only signal distinguishing a transport 404 from other
 * non-retryable validation failures, which carry no status code.
 */
const LIDARR_HTTP_404_MESSAGE = "Lidarr resource not found (HTTP 404)";

/**
 * Album-deletion 404 surfaced with the taxonomy's `not-found` code.
 *
 * The shared status mapper folds 404 into the generic `validation` code;
 * album deletion is the one lane where the apply layer must distinguish an
 * already-deleted target (dispatch `not-found` → satisfied), so the facade
 * re-codes exactly that failure — it never swallows it.
 */
class LidarrAlbumNotFoundError extends LidarrError {
  readonly code = "not-found" as const;

  /** @param operation - Human-readable label for the failing operation. */
  constructor(operation: string) {
    super("Lidarr album not found (HTTP 404)", { operation, statusCode: 404, retryable: false });
  }
}

/**
 * Origin-bound Lidarr facade with generated endpoint ownership and strict
 * command-facing domain projection.
 */
export class LidarrClient implements LidarrClientApi {
  readonly #generatedClient: GeneratedClient;
  readonly #operationContext = new AsyncLocalStorage<string>();

  /**
   * @param connection - Origin-bound connection produced by
   *   `createLidarrConnectionSettings`.
   * @param apiKeyProvider - Credential seam; `StaticLidarrApiKeyProvider` by default.
   * @param dependencies - Test seams and hard response limits.
   */
  constructor(
    connection: LidarrConnectionSettings,
    apiKeyProvider: LidarrApiKeyProvider,
    dependencies: LidarrClientDependencies = {},
  ) {
    const transport = createLidarrTransport(connection, apiKeyProvider, {
      ...dependencies,
      getOperation: () => this.#operationContext.getStore(),
    });
    this.#generatedClient = createClient({
      baseUrl: connection.origin,
      fetch: transport,
    });
    Object.freeze(this);
  }

  /** {@inheritDoc LidarrClientApi.getSystemStatus} */
  async getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus> {
    return this.#execute(
      "lidarr system status",
      signal,
      () => getApiV1SystemStatus({ client: this.#generatedClient, signal }),
      projectLidarrSystemStatus,
    );
  }

  /** {@inheritDoc LidarrClientApi.getHealth} */
  async getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]> {
    return this.#execute(
      "lidarr health",
      signal,
      () => getApiV1Health({ client: this.#generatedClient, signal }),
      projectLidarrHealthArray,
    );
  }

  /** {@inheritDoc LidarrClientApi.listArtists} */
  async listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]> {
    return this.#execute(
      "lidarr list artists",
      signal,
      () => getApiV1Artist({ client: this.#generatedClient, signal }),
      projectLidarrArtistArray,
    );
  }

  /** {@inheritDoc LidarrClientApi.search} */
  async search(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]> {
    return this.#execute(
      "lidarr search",
      query.signal,
      () =>
        getApiV1Search({
          client: this.#generatedClient,
          query: { term: query.term },
          signal: query.signal,
        }),
      projectLidarrSearchCandidates,
    );
  }

  /** {@inheritDoc LidarrClientApi.lookupArtists} */
  async lookupArtists(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]> {
    return this.#execute(
      "lidarr lookup artists",
      query.signal,
      () =>
        getApiV1ArtistLookup({
          client: this.#generatedClient,
          query: { term: query.term },
          signal: query.signal,
        }),
      projectLidarrArtistLookupCandidates,
    );
  }

  /** {@inheritDoc LidarrClientApi.lookupAlbums} */
  async lookupAlbums(query: LidarrSearchQuery): Promise<readonly LidarrSearchCandidateInput[]> {
    return this.#execute(
      "lidarr lookup albums",
      query.signal,
      () =>
        getApiV1AlbumLookup({
          client: this.#generatedClient,
          query: { term: query.term },
          signal: query.signal,
        }),
      projectLidarrAlbumLookupCandidates,
    );
  }

  /** {@inheritDoc LidarrClientApi.getArtistByForeignId} */
  async getArtistByForeignId(
    foreignArtistId: string,
    signal?: AbortSignal,
  ): Promise<LidarrArtist | undefined> {
    const operation = "lidarr get artist by foreign id";
    const validatedForeignArtistId = validateCanonicalMusicBrainzId(
      foreignArtistId,
      operation,
      "Foreign artist ID",
    );
    const artists = await this.#execute(
      operation,
      signal,
      () =>
        getApiV1Artist({
          client: this.#generatedClient,
          query: { mbId: validatedForeignArtistId },
          signal,
        }),
      projectLidarrArtistArray,
    );
    if (artists.length === 0) {
      return undefined;
    }
    if (artists.length !== 1 || artists[0]?.foreignArtistId !== validatedForeignArtistId) {
      throw invalidResponseError(operation, true);
    }
    return artists[0];
  }

  /** {@inheritDoc LidarrClientApi.listRootFolders} */
  async listRootFolders(signal?: AbortSignal): Promise<readonly LidarrRootFolder[]> {
    return this.#execute(
      "lidarr list root folders",
      signal,
      () => getApiV1Rootfolder({ client: this.#generatedClient, signal }),
      projectLidarrRootFolders,
    );
  }

  /** {@inheritDoc LidarrClientApi.prepareArtistAdd} */
  async prepareArtistAdd(
    input: LidarrArtistAddInput,
    signal?: AbortSignal,
  ): Promise<LidarrArtistAddInput> {
    const operation = "lidarr add artist";
    const validated = validateArtistAddInput(input, operation);
    const candidates = await this.lookupArtists({
      mode: "artist",
      term: `lidarr:${validated.foreignArtistId}`,
      signal,
    });
    const exact = candidates.filter(
      (candidate) =>
        candidate.kind === "artist" && candidate.foreignId === validated.foreignArtistId,
    );
    if (exact.length !== 1) {
      throw invalidResponseError(operation, true);
    }

    const authoritative = exact[0];
    if (authoritative === undefined) {
      throw invalidResponseError(operation, true);
    }
    return Object.freeze({ ...validated, artistName: authoritative.name });
  }

  /** {@inheritDoc LidarrClientApi.addArtist} */
  async addArtist(input: LidarrArtistAddInput, signal?: AbortSignal): Promise<LidarrArtist> {
    const operation = "lidarr add artist";
    const validated = validateArtistAddInput(input, operation);
    const body: ArtistResourceWritable = {
      artistName: validated.artistName,
      foreignArtistId: validated.foreignArtistId,
      rootFolderPath: validated.rootFolderPath,
      qualityProfileId: validated.qualityProfileId,
      metadataProfileId: validated.metadataProfileId,
      monitored: validated.monitored,
      monitorNewItems: "none",
      addOptions: {
        monitor: "none",
        searchForMissingAlbums: false,
      },
    };
    const created = await this.#execute(
      operation,
      signal,
      () =>
        postApiV1Artist({
          client: this.#generatedClient,
          body,
          signal,
        }),
      projectLidarrTargetArtist,
    );
    if (
      created.foreignArtistId !== validated.foreignArtistId ||
      created.monitored !== validated.monitored ||
      created.monitorNewItems !== "none" ||
      created.qualityProfileId !== validated.qualityProfileId ||
      created.metadataProfileId !== validated.metadataProfileId
    ) {
      throw invalidResponseError(operation, true);
    }
    return created;
  }

  /** {@inheritDoc LidarrClientApi.getArtist} */
  async getArtist(artistId: number, signal?: AbortSignal): Promise<LidarrArtist> {
    const operation = "lidarr get artist";
    validatePositiveId(artistId, operation, "Artist ID");
    try {
      return await this.#execute(
        operation,
        signal,
        () =>
          getApiV1ArtistById({
            client: this.#generatedClient,
            path: { id: artistId },
            signal,
          }),
        projectLidarrTargetArtist,
      );
    } catch (error: unknown) {
      if (error instanceof LidarrValidationError && hasLidarrHttpStatus(error, 404)) {
        throw new LidarrNotFoundError(operation, error.message);
      }
      throw error;
    }
  }

  /** {@inheritDoc LidarrClientApi.deleteArtist} */
  async deleteArtist(artistId: number, deleteFiles: boolean, signal?: AbortSignal): Promise<void> {
    const operation = "lidarr delete artist";
    const validatedArtistId = validatePositiveId(artistId, operation, "Artist ID");
    if (typeof deleteFiles !== "boolean") {
      throw validationError(operation, "Delete files must be a boolean");
    }

    await this.#executeVoid(operation, signal, () =>
      deleteApiV1ArtistById({
        client: this.#generatedClient,
        path: { id: validatedArtistId },
        query: { deleteFiles, addImportListExclusion: false },
        parseAs: "stream",
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.listQualityProfiles} */
  async listQualityProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]> {
    return this.#execute(
      "lidarr list quality profiles",
      signal,
      () => getApiV1Qualityprofile({ client: this.#generatedClient, signal }),
      projectLidarrProfileSummaries,
    );
  }

  /** {@inheritDoc LidarrClientApi.listCustomFormats} */
  async listCustomFormats(
    signal?: AbortSignal,
  ): Promise<readonly LidarrPresetCustomFormatDefinition[]> {
    return this.#execute(
      "lidarr list custom formats",
      signal,
      () => getApiV1Customformat({ client: this.#generatedClient, signal }),
      projectLidarrCustomFormatDefinitions,
    );
  }

  /** {@inheritDoc LidarrClientApi.getCustomFormat} */
  async getCustomFormat(
    customFormatId: number,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition> {
    const operation = "lidarr get custom format";
    const id = validatePositiveId(customFormatId, operation, "Custom format ID");
    try {
      return await this.#execute(
        operation,
        signal,
        () =>
          getApiV1CustomformatById({
            client: this.#generatedClient,
            path: { id },
            signal,
          }),
        projectLidarrCustomFormatDefinition,
      );
    } catch (error: unknown) {
      if (error instanceof LidarrValidationError && hasLidarrHttpStatus(error, 404)) {
        throw new LidarrNotFoundError(operation, error.message);
      }
      throw error;
    }
  }

  /** {@inheritDoc LidarrClientApi.getCustomFormatSchema} */
  async getCustomFormatSchema(
    signal?: AbortSignal,
  ): Promise<readonly LidarrPresetCustomFormatSpecificationSchema[]> {
    return this.#execute(
      "lidarr custom format schema",
      signal,
      () => getApiV1CustomformatSchema({ client: this.#generatedClient, signal }),
      projectLidarrCustomFormatSchema,
    );
  }

  /** {@inheritDoc LidarrClientApi.createCustomFormat} */
  async createCustomFormat(
    input: LidarrPresetCustomFormatCreateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition> {
    const operation = "lidarr create custom format";
    const body = buildCustomFormatBody(input, operation, false);
    return this.#execute(
      operation,
      signal,
      () => postApiV1Customformat({ client: this.#generatedClient, body, signal }),
      projectLidarrCustomFormatDefinition,
    );
  }

  /** {@inheritDoc LidarrClientApi.updateCustomFormat} */
  async updateCustomFormat(
    input: LidarrPresetCustomFormatUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetCustomFormatDefinition> {
    const operation = "lidarr update custom format";
    const body = buildCustomFormatBody(input, operation, true);
    const id = validatePositiveId(body.id, operation, "Custom format ID");
    return this.#execute(
      operation,
      signal,
      () =>
        putApiV1CustomformatById({
          client: this.#generatedClient,
          path: { id: String(id) },
          body,
          signal,
        }),
      projectLidarrCustomFormatDefinition,
    );
  }

  /** {@inheritDoc LidarrClientApi.listQualityProfileDefinitions} */
  async listQualityProfileDefinitions(
    signal?: AbortSignal,
  ): Promise<readonly LidarrPresetQualityProfileDefinition[]> {
    return this.#execute(
      "lidarr list quality profile definitions",
      signal,
      () => getApiV1Qualityprofile({ client: this.#generatedClient, signal }),
      projectLidarrQualityProfileDefinitions,
    );
  }

  /** {@inheritDoc LidarrClientApi.getQualityProfileDefinition} */
  async getQualityProfileDefinition(
    qualityProfileId: number,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition> {
    const operation = "lidarr get quality profile definition";
    const id = validatePositiveId(qualityProfileId, operation, "Quality profile ID");
    try {
      return await this.#execute(
        operation,
        signal,
        () =>
          getApiV1QualityprofileById({
            client: this.#generatedClient,
            path: { id },
            signal,
          }),
        projectLidarrQualityProfileDefinition,
      );
    } catch (error: unknown) {
      if (error instanceof LidarrValidationError && hasLidarrHttpStatus(error, 404)) {
        throw new LidarrNotFoundError(operation, error.message);
      }
      throw error;
    }
  }

  /** {@inheritDoc LidarrClientApi.getQualityProfileSchema} */
  async getQualityProfileSchema(signal?: AbortSignal): Promise<LidarrPresetQualityProfileSchema> {
    return this.#execute(
      "lidarr quality profile schema",
      signal,
      () => getApiV1QualityprofileSchema({ client: this.#generatedClient, signal }),
      projectLidarrQualityProfileSchema,
    );
  }

  /** {@inheritDoc LidarrClientApi.createQualityProfile} */
  async createQualityProfile(
    input: LidarrPresetQualityProfileCreateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition> {
    const operation = "lidarr create quality profile";
    const body = buildQualityProfileBody(input, operation, false);
    return this.#execute(
      operation,
      signal,
      () => postApiV1Qualityprofile({ client: this.#generatedClient, body, signal }),
      projectLidarrQualityProfileDefinition,
    );
  }

  /** {@inheritDoc LidarrClientApi.updateQualityProfile} */
  async updateQualityProfile(
    input: LidarrPresetQualityProfileUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetQualityProfileDefinition> {
    const operation = "lidarr update quality profile";
    const body = buildQualityProfileBody(input, operation, true);
    const id = validatePositiveId(body.id, operation, "Quality profile ID");
    return this.#execute(
      operation,
      signal,
      () =>
        putApiV1QualityprofileById({
          client: this.#generatedClient,
          path: { id: String(id) },
          body,
          signal,
        }),
      projectLidarrQualityProfileDefinition,
    );
  }

  /** {@inheritDoc LidarrClientApi.getNamingConfig} */
  async getNamingConfig(signal?: AbortSignal): Promise<LidarrPresetNamingConfig> {
    return this.#execute(
      "lidarr naming config",
      signal,
      () => getApiV1ConfigNaming({ client: this.#generatedClient, signal }),
      projectLidarrNamingConfig,
    );
  }

  /** {@inheritDoc LidarrClientApi.getNamingExamples} */
  async getNamingExamples(
    input: LidarrPresetNamingUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetNamingExamples> {
    const operation = "lidarr naming examples";
    const query = buildNamingBody(input, operation);
    return this.#execute(
      operation,
      signal,
      () =>
        getApiV1ConfigNamingExamples({
          client: this.#generatedClient,
          query,
          signal,
        }),
      projectLidarrNamingExamples,
    );
  }

  /** {@inheritDoc LidarrClientApi.updateNamingConfig} */
  async updateNamingConfig(
    input: LidarrPresetNamingUpdateInput,
    signal?: AbortSignal,
  ): Promise<LidarrPresetNamingConfig> {
    const operation = "lidarr update naming config";
    const body = buildNamingBody(input, operation);
    const id = validatePositiveId(body.id, operation, "Naming config ID");
    return this.#execute(
      operation,
      signal,
      () =>
        putApiV1ConfigNamingById({
          client: this.#generatedClient,
          path: { id: String(id) },
          body,
          signal,
        }),
      projectLidarrNamingConfig,
    );
  }

  /** {@inheritDoc LidarrClientApi.listMetadataProfiles} */
  async listMetadataProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]> {
    return this.#execute(
      "lidarr list metadata profiles",
      signal,
      () => getApiV1Metadataprofile({ client: this.#generatedClient, signal }),
      projectLidarrProfileSummaries,
    );
  }

  /** {@inheritDoc LidarrClientApi.listMetadataProfileDetails} */
  async listMetadataProfileDetails(
    signal?: AbortSignal,
  ): Promise<readonly LidarrMetadataProfile[]> {
    return this.#execute(
      "lidarr list metadata profile details",
      signal,
      () => getApiV1Metadataprofile({ client: this.#generatedClient, signal }),
      projectLidarrMetadataProfiles,
    );
  }

  /** {@inheritDoc LidarrClientApi.listTags} */
  async listTags(signal?: AbortSignal): Promise<readonly LidarrTag[]> {
    return this.#execute(
      "lidarr list tags",
      signal,
      () => getApiV1Tag({ client: this.#generatedClient, signal }),
      projectLidarrTags,
    );
  }

  /** {@inheritDoc LidarrClientApi.setArtistsMonitored} */
  async setArtistsMonitored(
    artistIds: readonly number[],
    monitored: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof monitored !== "boolean") {
      throw new LidarrValidationError(
        "lidarr update artist monitoring",
        "Monitored must be a boolean",
        "validation",
      );
    }
    if (artistIds.length > LIDARR_PLAN_MAX_ENTRIES) {
      throw new LidarrValidationError(
        "lidarr update artist monitoring",
        `Artist IDs must contain at most ${LIDARR_PLAN_MAX_ENTRIES} entries`,
        "validation",
      );
    }
    if (
      artistIds.length === 0 ||
      new Set(artistIds).size !== artistIds.length ||
      artistIds.some((artistId) => !Number.isSafeInteger(artistId) || artistId <= 0)
    ) {
      throw new LidarrValidationError(
        "lidarr update artist monitoring",
        "Artist IDs must be unique positive integers",
        "validation",
      );
    }
    await this.#executeVoid("lidarr update artist monitoring", signal, () =>
      putApiV1ArtistEditor({
        client: this.#generatedClient,
        body: { artistIds: [...artistIds], monitored },
        parseAs: "stream",
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.setArtistProfiles} */
  async setArtistProfiles(
    artistId: number,
    assignment: LidarrProfileAssignmentInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = "lidarr set artist profiles";
    const validatedArtistId = validatePositiveId(artistId, operation, "Artist ID");
    if (
      !isRecord(assignment) ||
      !hasOnlyKeys(assignment, ["qualityProfileId", "metadataProfileId"])
    ) {
      throw validationError(operation, "Profile assignment contains unsupported fields");
    }

    const qualityProfileId =
      assignment["qualityProfileId"] === undefined
        ? undefined
        : validatePositiveId(assignment["qualityProfileId"], operation, "Quality profile ID");
    const metadataProfileId =
      assignment["metadataProfileId"] === undefined
        ? undefined
        : validatePositiveId(assignment["metadataProfileId"], operation, "Metadata profile ID");
    if (qualityProfileId === undefined && metadataProfileId === undefined) {
      throw validationError(operation, "At least one profile ID must be provided");
    }

    await this.#executeVoid(operation, signal, () =>
      putApiV1ArtistEditor({
        client: this.#generatedClient,
        body: {
          artistIds: [validatedArtistId],
          ...(qualityProfileId === undefined ? {} : { qualityProfileId }),
          ...(metadataProfileId === undefined ? {} : { metadataProfileId }),
        },
        parseAs: "stream",
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.updateArtistTags} */
  async updateArtistTags(
    artistId: number,
    mutation: LidarrTagMutationInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = "lidarr update artist tags";
    const validatedArtistId = validatePositiveId(artistId, operation, "Artist ID");
    if (!isRecord(mutation) || !hasOnlyKeys(mutation, ["mode", "tagIds"])) {
      throw validationError(operation, "Tag mutation contains unsupported fields");
    }

    const mode = mutation["mode"];
    if (mode !== "add" && mode !== "remove" && mode !== "set" && mode !== "clear") {
      throw validationError(operation, "Tag mode must be add, remove, set, or clear");
    }
    const tagIds = mutation["tagIds"];
    if (!Array.isArray(tagIds) || tagIds.length > LIDARR_PLAN_MAX_ENTRIES) {
      throw validationError(
        operation,
        `Tag IDs must contain at most ${LIDARR_PLAN_MAX_ENTRIES} entries`,
      );
    }
    const normalizedTagIds = [
      ...new Set(tagIds.map((tagId) => validatePositiveId(tagId, operation, "Tag ID"))),
    ].sort((left, right) => left - right);
    if (mode === "clear" ? normalizedTagIds.length !== 0 : normalizedTagIds.length === 0) {
      throw validationError(
        operation,
        mode === "clear"
          ? "Clear tag mutations must not contain tag IDs"
          : `${mode} tag mutations require at least one tag ID`,
      );
    }

    await this.#executeVoid(operation, signal, () =>
      putApiV1ArtistEditor({
        client: this.#generatedClient,
        body: {
          artistIds: [validatedArtistId],
          tags: normalizedTagIds,
          applyTags: mode === "set" || mode === "clear" ? "replace" : mode,
        },
        parseAs: "stream",
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.listAlbums} */
  async listAlbums(query: LidarrAlbumQuery): Promise<readonly LidarrAlbum[]> {
    const operation = "lidarr list albums";
    const { artistId, albumIds, signal } = query;
    // Runtime scope guard: with every GET /api/v1/album query parameter
    // optional in the SDK, this is the only protection against accidentally
    // requesting the whole library, which can trip the 8 MiB transport cap.
    if (artistId === undefined && albumIds === undefined) {
      throw new LidarrValidationError(
        operation,
        "Album query must be scoped by artistId or albumIds",
        "validation",
      );
    }
    if (artistId !== undefined && (!Number.isSafeInteger(artistId) || artistId <= 0)) {
      throw new LidarrValidationError(
        operation,
        "Artist ID must be a positive integer",
        "validation",
      );
    }
    if (albumIds !== undefined) {
      if (albumIds.length > LIDARR_PLAN_MAX_ENTRIES) {
        throw new LidarrValidationError(
          operation,
          `Album IDs must contain at most ${LIDARR_PLAN_MAX_ENTRIES} entries`,
          "validation",
        );
      }
      if (
        albumIds.length === 0 ||
        new Set(albumIds).size !== albumIds.length ||
        albumIds.some((albumId) => !Number.isSafeInteger(albumId) || albumId <= 0)
      ) {
        throw new LidarrValidationError(
          operation,
          "Album IDs must be unique positive integers",
          "validation",
        );
      }
    }

    if (albumIds === undefined) {
      // The scope guard above guarantees artistId is present on this path.
      return this.#execute(
        operation,
        signal,
        () =>
          getApiV1Album({
            client: this.#generatedClient,
            query: { ...(artistId === undefined ? {} : { artistId }) },
            signal,
          }),
        projectLidarrAlbumArray,
      );
    }

    const albums: LidarrAlbum[] = [];
    for (let index = 0; index < albumIds.length; index += LIDARR_ALBUM_IDS_CHUNK_SIZE) {
      const chunk = albumIds.slice(index, index + LIDARR_ALBUM_IDS_CHUNK_SIZE);
      const projected = await this.#execute(
        operation,
        signal,
        () =>
          getApiV1Album({
            client: this.#generatedClient,
            query: {
              ...(artistId === undefined ? {} : { artistId }),
              albumIds: [...chunk],
            },
            signal,
          }),
        projectLidarrAlbumArray,
      );
      albums.push(...projected);
    }
    return Object.freeze(albums);
  }

  /** {@inheritDoc LidarrClientApi.probeManualImport} */
  async probeManualImport(
    input: LidarrManualImportProbeInput,
  ): Promise<readonly LidarrManualImportCandidate[]> {
    const operation = "lidarr validate import";
    if (
      !isRecord(input) ||
      !hasOnlyKeys(input, [
        "folder",
        "artistId",
        "filterExistingFiles",
        "replaceExistingFiles",
        "signal",
      ]) ||
      typeof input["folder"] !== "string" ||
      input["folder"].trim() === "" ||
      input["folder"].length > 4_096
    ) {
      throw validationError(operation, "Folder must be a non-empty path");
    }
    const artistId =
      input["artistId"] === undefined
        ? undefined
        : validatePositiveId(input["artistId"], operation, "Artist ID");
    for (const key of ["filterExistingFiles", "replaceExistingFiles"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") {
        throw validationError(operation, `${key} must be a boolean`);
      }
    }
    const signal = input["signal"] as AbortSignal | undefined;
    return this.#execute(
      operation,
      signal,
      () =>
        getApiV1Manualimport({
          client: this.#generatedClient,
          query: {
            folder: input["folder"] as string,
            ...(artistId === undefined ? {} : { artistId }),
            ...(input["filterExistingFiles"] === undefined
              ? {}
              : { filterExistingFiles: input["filterExistingFiles"] as boolean }),
            ...(input["replaceExistingFiles"] === undefined
              ? {}
              : { replaceExistingFiles: input["replaceExistingFiles"] as boolean }),
          },
          signal,
        }),
      projectLidarrManualImportCandidates,
    );
  }

  /** {@inheritDoc LidarrClientApi.listTracks} */
  async listTracks(query: LidarrTrackQuery): Promise<readonly LidarrTrack[]> {
    const operation = "lidarr list album tracks";
    const albumId = validatePositiveId(query.albumId, operation, "Album ID");
    const trackIds =
      query.trackIds === undefined
        ? undefined
        : validateExactIds(query.trackIds, operation, "Track IDs");
    return this.#execute(
      operation,
      query.signal,
      () =>
        getApiV1Track({
          client: this.#generatedClient,
          query: {
            albumId,
            ...(trackIds === undefined ? {} : { trackIds }),
          },
          signal: query.signal,
        }),
      projectLidarrTracks,
    );
  }

  /** {@inheritDoc LidarrClientApi.listTrackFiles} */
  async listTrackFiles(query: LidarrTrackFileQuery): Promise<readonly LidarrTrackFile[]> {
    const operation = "lidarr list trackfiles";
    if (query.albumIds === undefined && query.trackFileIds === undefined) {
      throw validationError(operation, "Trackfile query must be scoped by album or trackfile IDs");
    }
    const albumIds =
      query.albumIds === undefined
        ? undefined
        : validateExactIds(query.albumIds, operation, "Album IDs");
    const trackFileIds =
      query.trackFileIds === undefined
        ? undefined
        : validateExactIds(query.trackFileIds, operation, "Trackfile IDs");
    return this.#execute(
      operation,
      query.signal,
      () =>
        getApiV1Trackfile({
          client: this.#generatedClient,
          query: {
            ...(albumIds === undefined ? {} : { albumId: albumIds }),
            ...(trackFileIds === undefined ? {} : { trackFileIds }),
          },
          signal: query.signal,
        }),
      projectLidarrTrackFiles,
    );
  }

  /** {@inheritDoc LidarrClientApi.bulkDeleteTrackFiles} */
  async bulkDeleteTrackFiles(trackFileIds: readonly number[], signal?: AbortSignal): Promise<void> {
    const operation = "lidarr delete trackfiles";
    const validatedIds = validateExactIds(trackFileIds, operation, "Trackfile IDs");
    await this.#executeVoid(operation, signal, () =>
      deleteApiV1TrackfileBulk({
        client: this.#generatedClient,
        body: { trackFileIds: validatedIds },
        parseAs: "stream",
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.setAlbumsMonitored} */
  async setAlbumsMonitored(
    albumIds: readonly number[],
    monitored: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof monitored !== "boolean") {
      throw new LidarrValidationError(
        "lidarr update album monitoring",
        "Monitored must be a boolean",
        "validation",
      );
    }
    if (albumIds.length > LIDARR_PLAN_MAX_ENTRIES) {
      throw new LidarrValidationError(
        "lidarr update album monitoring",
        `Album IDs must contain at most ${LIDARR_PLAN_MAX_ENTRIES} entries`,
        "validation",
      );
    }
    if (
      albumIds.length === 0 ||
      new Set(albumIds).size !== albumIds.length ||
      albumIds.some((albumId) => !Number.isSafeInteger(albumId) || albumId <= 0)
    ) {
      throw new LidarrValidationError(
        "lidarr update album monitoring",
        "Album IDs must be unique positive integers",
        "validation",
      );
    }
    await this.#executeVoid("lidarr update album monitoring", signal, () =>
      putApiV1AlbumMonitor({
        client: this.#generatedClient,
        body: { albumIds: [...albumIds], monitored },
        signal,
      }),
    );
  }

  /** {@inheritDoc LidarrClientApi.deleteAlbum} */
  async deleteAlbum(
    albumId: number,
    options: LidarrAlbumDeleteInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = "lidarr delete album";
    const validatedAlbumId = validatePositiveId(albumId, operation, "Album ID");
    if (
      !isRecord(options) ||
      !hasOnlyKeys(options, ["deleteFiles", "addImportListExclusion"]) ||
      typeof options.deleteFiles !== "boolean" ||
      typeof options.addImportListExclusion !== "boolean"
    ) {
      throw validationError(operation, "Delete options must be explicit booleans");
    }
    const { deleteFiles, addImportListExclusion } = options;
    try {
      await this.#executeVoid(operation, signal, () =>
        deleteApiV1AlbumById({
          client: this.#generatedClient,
          path: { id: validatedAlbumId },
          query: { deleteFiles, addImportListExclusion },
          parseAs: "stream",
          signal,
        }),
      );
    } catch (error: unknown) {
      // Re-code exactly the transport's 404 so the apply layer can classify
      // already-deleted targets; every other failure propagates unchanged.
      if (
        error instanceof LidarrError &&
        error.code === "validation" &&
        error.message === LIDARR_HTTP_404_MESSAGE
      ) {
        throw new LidarrAlbumNotFoundError(operation);
      }
      throw error;
    }
  }

  /** {@inheritDoc LidarrClientApi.setAlbumAnyReleaseOk} */
  async setAlbumAnyReleaseOk(
    albumId: number,
    anyReleaseOk: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = "lidarr set album release policy";
    const validatedAlbumId = validatePositiveId(albumId, operation, "Album ID");
    if (typeof anyReleaseOk !== "boolean") {
      throw validationError(operation, "Any-release-ok must be a boolean");
    }
    // Confined raw round-trip: the wire album never escapes this closure, and
    // every unprojected field (including ones newer than the generated spec)
    // forwards verbatim — only `anyReleaseOk` is mutated.
    await this.#executeVoid(operation, signal, async () => {
      const current = await getApiV1AlbumById({
        client: this.#generatedClient,
        path: { id: validatedAlbumId },
        signal,
      });
      const wire = this.#unwrapGeneratedResult(current, operation, signal);
      if (!isRecord(wire)) {
        throw invalidResponseError(operation, true);
      }
      // Single cast: the opaque record is re-labeled for the generated PUT
      // body; the runtime spread forwards all fields regardless of the label.
      const wireAlbum = wire as AlbumResourceWritable;
      return putApiV1AlbumById({
        client: this.#generatedClient,
        // OpenAPI quirk: the PUT path id is string-typed (types.gen.ts).
        path: { id: String(validatedAlbumId) },
        body: { ...wireAlbum, anyReleaseOk },
        parseAs: "stream",
        signal,
      });
    });
  }

  /** {@inheritDoc LidarrClientApi.getWantedMissing} */
  async getWantedMissing(query: LidarrWantedQuery = {}): Promise<LidarrWantedPage> {
    const generatedQuery = {
      page: query.page ?? DEFAULT_WANTED_PAGE,
      pageSize: query.pageSize ?? DEFAULT_WANTED_PAGE_SIZE,
      sortKey: query.sortKey ?? DEFAULT_WANTED_SORT_KEY,
      ...(query.sortDirection === undefined ? {} : { sortDirection: query.sortDirection }),
    };
    return this.#execute(
      "lidarr wanted missing",
      query.signal,
      () =>
        getApiV1WantedMissing({
          client: this.#generatedClient,
          query: generatedQuery,
          signal: query.signal,
        }),
      projectLidarrWantedPage,
    );
  }

  async #execute<T>(
    operation: string,
    callerSignal: AbortSignal | undefined,
    invoke: () => Promise<unknown>,
    project: DomainProjector<T>,
  ): Promise<T> {
    if (callerSignal?.aborted === true) {
      throw callerAbortReason(callerSignal);
    }

    return this.#operationContext.run(operation, async () => {
      try {
        const result = await invoke();
        const data = this.#unwrapGeneratedResult(result, operation, callerSignal);
        const projected = project(data);
        if (projected === undefined) {
          throw invalidResponseError(operation, true);
        }
        return projected;
      } catch (error: unknown) {
        this.#throwFacadeError(error, operation, callerSignal);
      }
    });
  }

  async #executeVoid(
    operation: string,
    callerSignal: AbortSignal | undefined,
    invoke: () => Promise<unknown>,
  ): Promise<void> {
    if (callerSignal?.aborted === true) {
      throw callerAbortReason(callerSignal);
    }

    return this.#operationContext.run(operation, async () => {
      try {
        const result = await invoke();
        this.#unwrapGeneratedResult(result, operation, callerSignal);
      } catch (error: unknown) {
        this.#throwFacadeError(error, operation, callerSignal);
      }
    });
  }

  #unwrapGeneratedResult(
    result: unknown,
    operation: string,
    callerSignal: AbortSignal | undefined,
  ): unknown {
    if (!isRecord(result)) {
      throw invalidResponseError(operation);
    }

    if ("error" in result && result["error"] !== undefined) {
      const error = result["error"];
      if (error instanceof LidarrError) {
        throw error;
      }
      if (callerSignal?.aborted === true) {
        throw callerAbortReason(callerSignal);
      }
      const response = result["response"];
      if (response instanceof Response && !response.ok) {
        throw classifyLidarrStatus(
          response.status,
          operation,
          parseRetryAfter(response.headers.get("retry-after")),
        );
      }
      throw new LidarrUnreachableError(operation);
    }

    if (!("data" in result)) {
      throw invalidResponseError(operation);
    }
    return result["data"];
  }

  #throwFacadeError(
    error: unknown,
    operation: string,
    callerSignal: AbortSignal | undefined,
  ): never {
    if (error instanceof LidarrError) {
      throw error;
    }
    if (callerSignal?.aborted === true) {
      throw callerAbortReason(callerSignal);
    }
    if (error instanceof SyntaxError) {
      throw invalidResponseError(operation);
    }
    throw new LidarrUnreachableError(operation);
  }
}
