/**
 * Private Plex query, library, identity, and scan endpoint family.
 *
 * This module receives the authenticated transport and adapter-local cache. It
 * never reads configuration, performs `fetch`, or exposes Plex machine IDs
 * through the generic adapter contract.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import {
  evaluateMediaFilterWithAppliedRules,
  planMediaFilterQueries,
} from "../../media-filter-evaluator.js";
import { advancePaginationOffset } from "../../pagination.js";
import type {
  MediaAlbum,
  MediaArtist,
  MediaItem,
  MediaKind,
  MediaLibraryContentVersion,
  MediaLibraryContentVersionOptions,
  MediaPage,
  MediaQueryOptions,
  MediaServerLibrary,
  MediaServerLibraryCapability,
  MediaServerQueryCapability,
  MediaServerScanCapability,
  MediaServerScanResult,
  MediaTrack,
  MediaTrackLookupOptions,
} from "../../../types/media-server.js";
import { MediaServerError } from "../../../types/media-server.js";
import type { MediaFilterRule } from "../../../types/media-filters.js";
import type { PlexTransport } from "./client.js";
import type { PlexResponseCache } from "./cache.js";
import {
  mapPlexAlbum,
  mapPlexArtist,
  mapPlexLibrary,
  mapPlexTrack,
  mediaKindToPlexMetadataType,
} from "./mappers.js";
import {
  isPlexWireAlbum,
  isPlexWireArtist,
  isPlexWireLibraryResponse,
  isPlexWireMetadataResponse,
  isPlexWireServerResponse,
  isPlexWireTrack,
  type PlexWireAlbum,
  type PlexWireArtist,
  type PlexWireLibrary,
  type PlexWireTrack,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;

/** A configured destination-root to Plex-library mapping. */
export interface PlexLibraryPathMapping {
  readonly path: string;
  readonly library: string;
}

/** Pure mapper dependencies used by the query/library family. */
export interface PlexQueryLibraryMappers {
  readonly track: (wire: PlexWireTrack) => MediaTrack;
  readonly album: (wire: PlexWireAlbum) => MediaAlbum;
  readonly artist: (wire: PlexWireArtist) => MediaArtist;
  readonly library: (wire: PlexWireLibrary) => MediaServerLibrary | undefined;
}

/** Construction inputs captured by one private Plex endpoint family. */
export interface PlexQueryLibraryDependencies {
  readonly transport: PlexTransport;
  readonly cache: PlexResponseCache;
  readonly mappers?: PlexQueryLibraryMappers;
  readonly defaultLibraryName?: string;
  readonly libraryMappings?: readonly PlexLibraryPathMapping[];
  readonly pageSize?: number;
}

/** Cancellation accepted only by private Plex identity lookup seams. */
export interface PlexPrivateLookupOptions {
  readonly signal?: AbortSignal;
}

/**
 * Private family returned for public adapter composition.
 *
 * `getMachineIdentifier` is intentionally not part of
 * `MediaServerAdapter`; it is injected only into Plex container families.
 */
export interface PlexQueryLibraryFamily {
  readonly query: MediaServerQueryCapability;
  readonly library: MediaServerLibraryCapability;
  readonly scan: MediaServerScanCapability;
  readonly findLibrary: (
    name: string,
    options?: PlexPrivateLookupOptions,
  ) => Promise<MediaServerLibrary>;
  readonly getMachineIdentifier: (options?: PlexPrivateLookupOptions) => Promise<string>;
}

const DEFAULT_MAPPERS: PlexQueryLibraryMappers = Object.freeze({
  track: mapPlexTrack,
  album: mapPlexAlbum,
  artist: mapPlexArtist,
  library: mapPlexLibrary,
});

function invalidResponse(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "invalid-response",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function configurationError(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "configuration",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function notFound(operation: string, message: string): MediaServerError {
  return new MediaServerError(message, {
    code: "not-found",
    serverType: "plex",
    operation,
    retryable: false,
  });
}

function encodePathSegment(value: string, operation: string): string {
  if (value.length === 0) {
    throw configurationError(operation, "Plex resource identifier must not be empty");
  }
  return encodeURIComponent(value);
}

function pageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError("Plex page size must be a positive safe integer");
  }
  return resolved;
}

function requestedOffset(value: number | undefined): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError("Plex query offset must be a non-negative safe integer");
  }
  return resolved;
}

function requestedLimit(value: number | undefined, defaultSize: number): number {
  const resolved = value ?? defaultSize;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("Plex query limit must be a positive safe integer");
  }
  return resolved;
}

function queryDigest(kind: MediaKind, options: MediaQueryOptions): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        library: options.library,
        limit: options.limit,
        offset: options.offset,
        filter: options.filter,
      }),
    )
    .digest("hex");
}

function queryKeySuffix(operator: MediaFilterRule["operator"]): string | undefined {
  switch (operator) {
    case ">=":
      return ">";
    case "<=":
      return "<";
    case "==":
    case "contains":
      return "";
    case "!=":
    case "not_contains":
      return "!";
  }
}

function ratingFieldName(field: MediaFilterRule["field"], kind: MediaKind): string | undefined {
  switch (field) {
    case "artistRating":
      return kind === "artist" ? "userRating" : "artist.userRating";
    case "albumRating":
      if (kind === "artist") return undefined;
      return kind === "album" ? "userRating" : "album.userRating";
    case "trackRating":
      return kind === "track" ? "userRating" : undefined;
    default:
      return undefined;
  }
}

function textFieldName(field: MediaFilterRule["field"], kind: MediaKind): string | undefined {
  switch (field) {
    case "genre":
    case "style":
    case "mood":
    case "title":
      return field;
    case "artist":
      return "artist.title";
    case "album":
      return kind === "track" ? "album.title" : undefined;
    default:
      return undefined;
  }
}

function numericFieldName(field: MediaFilterRule["field"], kind: MediaKind): string | undefined {
  switch (field) {
    case "year":
    case "minYear":
    case "maxYear":
      return kind === "artist" ? undefined : "year";
    case "minPlays":
      return kind === "track" ? "viewCount" : undefined;
    default:
      return undefined;
  }
}

function plexFilterEntry(
  rule: MediaFilterRule,
  kind: MediaKind,
): readonly [string, string | number] | undefined {
  const suffix = queryKeySuffix(rule.operator);
  if (suffix === undefined) return undefined;

  const ratingField = ratingFieldName(rule.field, kind);
  if (ratingField !== undefined) {
    if (
      typeof rule.value !== "number" ||
      !Number.isFinite(rule.value) ||
      rule.value < 1 ||
      rule.value > 5 ||
      (rule.operator !== ">=" && rule.operator !== "<=" && rule.operator !== "!=")
    ) {
      return undefined;
    }
    return [`${ratingField}${suffix}`, rule.value * 2];
  }

  const numericField = numericFieldName(rule.field, kind);
  if (numericField !== undefined) {
    if (
      typeof rule.value !== "number" ||
      !Number.isFinite(rule.value) ||
      (rule.field === "year" && rule.operator !== "==" && rule.operator !== "!=") ||
      (rule.field === "minYear" && rule.operator !== ">=") ||
      (rule.field === "maxYear" && rule.operator !== "<=") ||
      (rule.field === "minPlays" && rule.operator !== ">=")
    ) {
      return undefined;
    }
    return [`${numericField}${suffix}`, rule.value];
  }

  const textField = textFieldName(rule.field, kind);
  if (textField === undefined || typeof rule.value !== "string") {
    return undefined;
  }
  if (rule.operator === ">=" || rule.operator === "<=" || rule.operator === "!=") {
    return undefined;
  }
  return [`${textField}${suffix}`, rule.value];
}

function buildPushdown(
  kind: MediaKind,
  filter: MediaQueryOptions["filter"],
): {
  readonly query: Readonly<Record<string, string | number>>;
  readonly applied: readonly MediaFilterRule[];
} {
  if (filter === undefined) {
    return { query: {}, applied: [] };
  }

  const plan = planMediaFilterQueries(filter, (rule) => plexFilterEntry(rule, kind) !== undefined);
  const query: Record<string, string | number> = {};
  for (const rule of plan.baseRules) {
    const entry = plexFilterEntry(rule, kind);
    if (entry !== undefined) {
      query[entry[0]] = entry[1];
    }
  }
  return { query, applied: plan.baseRules };
}

type PlexWireFor<T extends MediaItem> = T extends MediaTrack
  ? PlexWireTrack
  : T extends MediaAlbum
    ? PlexWireAlbum
    : PlexWireArtist;

type PlexWireGuard<T extends MediaItem> = (value: unknown) => value is PlexWireFor<T>;
type PlexWireMapper<T extends MediaItem> = (value: PlexWireFor<T>) => T;

function toPage<T extends MediaItem>(
  operation: string,
  queryTarget: string,
  response: unknown,
  requestedStart: number,
  filter: MediaQueryOptions["filter"],
  appliedRules: readonly MediaFilterRule[],
  guard: PlexWireGuard<T>,
  mapper: PlexWireMapper<T>,
): MediaPage<T> {
  if (!isPlexWireMetadataResponse(response, guard)) {
    throw invalidResponse(operation, "Plex returned malformed media metadata");
  }

  const container = response.MediaContainer;
  const wireItems = container.Metadata ?? [];
  let mapped: readonly T[];
  try {
    mapped = wireItems.map(mapper);
  } catch {
    throw invalidResponse(operation, "Plex returned invalid media field values");
  }

  const items =
    filter === undefined
      ? mapped
      : mapped.filter((item) => evaluateMediaFilterWithAppliedRules(filter, item, appliedRules));
  const offset = container.offset ?? requestedStart;
  const returned = wireItems.length;
  const total = container.totalSize ?? returned;
  const page: MediaPage<T> = {
    items,
    total,
    offset,
    returned,
    hasMore: offset + returned < total,
  };

  // Validate the forward-progress invariant at the endpoint boundary even
  // though outer actions own the multi-page loop.
  advancePaginationOffset(page, queryTarget);
  return page;
}

function scanFailure(error: unknown): MediaServerScanResult {
  if (error instanceof MediaServerError) {
    return {
      success: false,
      message: error.message,
      statusCode: error.statusCode,
    };
  }
  return {
    success: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

interface PlexQueryLibraryContext {
  readonly transport: PlexTransport;
  readonly cache: PlexResponseCache;
  readonly mappers: PlexQueryLibraryMappers;
  readonly defaultSize: number;
  readonly defaultLibraryName: string | undefined;
  readonly libraryMappings: readonly PlexLibraryPathMapping[];
}

interface PlexLibraryIdentityFamily {
  readonly capability: MediaServerLibraryCapability;
  readonly find: (name: string) => Promise<MediaServerLibrary>;
  readonly findWithOptions: (
    name: string,
    options?: PlexPrivateLookupOptions,
  ) => Promise<MediaServerLibrary>;
  readonly getMachineIdentifier: (options?: PlexPrivateLookupOptions) => Promise<string>;
}

function createQueryLibraryContext(
  dependencies: PlexQueryLibraryDependencies,
): PlexQueryLibraryContext {
  return Object.freeze({
    transport: dependencies.transport,
    cache: dependencies.cache,
    mappers: dependencies.mappers ?? DEFAULT_MAPPERS,
    defaultSize: pageSize(dependencies.pageSize),
    defaultLibraryName: dependencies.defaultLibraryName,
    libraryMappings: Object.freeze(
      (dependencies.libraryMappings ?? []).map((mapping) => Object.freeze({ ...mapping })),
    ),
  });
}

async function listLibraries(
  context: PlexQueryLibraryContext,
  options?: PlexPrivateLookupOptions,
): Promise<readonly MediaServerLibrary[]> {
  const cached = context.cache.get<readonly MediaServerLibrary[]>({ category: "libraries" });
  if (cached !== undefined) return cached;

  const operation = "list Plex libraries";
  const response = await context.transport.request<unknown>({
    path: "/library/sections",
    operation,
    options: { method: "GET", signal: options?.signal },
  });
  if (!isPlexWireLibraryResponse(response)) {
    throw invalidResponse(operation, "Plex returned a malformed library list");
  }
  const libraries = response.MediaContainer.Directory.map(context.mappers.library).filter(
    (library): library is MediaServerLibrary => library !== undefined,
  );
  context.cache.set({ category: "libraries" }, libraries);
  return libraries;
}

async function findLibrary(
  context: PlexQueryLibraryContext,
  name: string,
  options?: PlexPrivateLookupOptions,
): Promise<MediaServerLibrary> {
  const libraries = await listLibraries(context, options);
  const normalizedName = name.toLowerCase();
  const library = libraries.find(({ title }) => title.toLowerCase() === normalizedName);
  if (library !== undefined) return library;

  throw notFound(
    "find Plex library",
    `Library "${name}" not found. Available: ${libraries.map(({ title }) => title).join(", ")}`,
  );
}

async function fetchLibraryContentVersion(
  context: PlexQueryLibraryContext,
  name: string,
  options?: MediaLibraryContentVersionOptions,
): Promise<MediaLibraryContentVersion> {
  const operation = "fetch Plex library content version";
  const response = await context.transport.request<unknown>({
    path: "/library/sections",
    operation,
    options: { method: "GET", signal: options?.signal },
  });
  if (!isPlexWireLibraryResponse(response)) {
    throw invalidResponse(operation, "Plex returned a malformed library list");
  }

  const normalizedName = name.toLowerCase();
  const library = response.MediaContainer.Directory.find(
    (candidate) =>
      (candidate.type === "artist" || candidate.type === "album" || candidate.type === "track") &&
      candidate.title.toLowerCase() === normalizedName,
  );
  if (library === undefined) {
    throw notFound(operation, `Library "${name}" not found`);
  }
  if (library.uuid === undefined || library.contentChangedAt === undefined) {
    throw invalidResponse(
      operation,
      "Plex library did not provide uuid and contentChangedAt freshness evidence",
    );
  }

  return Object.freeze({
    libraryId: library.key,
    value: JSON.stringify([library.uuid, library.contentChangedAt]),
  });
}

async function getMachineIdentifier(
  context: PlexQueryLibraryContext,
  options?: PlexPrivateLookupOptions,
): Promise<string> {
  const cached = context.cache.get<string>({ category: "identity" });
  if (cached !== undefined) return cached;

  const operation = "fetch Plex server identity";
  const response = await context.transport.request<unknown>({
    path: "/",
    operation,
    options: { method: "GET", signal: options?.signal },
  });
  if (!isPlexWireServerResponse(response)) {
    throw invalidResponse(operation, "Plex server response did not contain a machine identifier");
  }
  const machineIdentifier = response.MediaContainer.machineIdentifier;
  context.cache.set({ category: "identity" }, machineIdentifier);
  return machineIdentifier;
}

function createPlexLibraryIdentityFamily(
  context: PlexQueryLibraryContext,
): PlexLibraryIdentityFamily {
  const list = (): Promise<readonly MediaServerLibrary[]> => listLibraries(context);
  const find = (name: string): Promise<MediaServerLibrary> => findLibrary(context, name);
  const findWithOptions = (
    name: string,
    options?: PlexPrivateLookupOptions,
  ): Promise<MediaServerLibrary> => findLibrary(context, name, options);
  const loadIdentity = (options?: PlexPrivateLookupOptions): Promise<string> =>
    getMachineIdentifier(context, options);
  return Object.freeze({
    capability: Object.freeze({ list, byName: find }),
    find,
    findWithOptions,
    getMachineIdentifier: loadIdentity,
  });
}

async function executeQuery<T extends MediaItem>(
  context: PlexQueryLibraryContext,
  find: PlexLibraryIdentityFamily["findWithOptions"],
  kind: MediaKind,
  options: MediaQueryOptions,
  operation: string,
  queryTarget: string,
  guard: PlexWireGuard<T>,
  mapper: PlexWireMapper<T>,
): Promise<MediaPage<T>> {
  options.signal?.throwIfAborted();
  const cacheKey = {
    category: "queries" as const,
    discriminator: [kind, queryDigest(kind, options)],
  };
  const cached = context.cache.get<MediaPage<T>>(cacheKey);
  if (cached !== undefined) return cached;

  const library = await find(options.library, { signal: options.signal });
  const offset = requestedOffset(options.offset);
  const limit = requestedLimit(options.limit, context.defaultSize);
  const pushdown = buildPushdown(kind, options.filter);
  const response = await context.transport.request<unknown>({
    path: `/library/sections/${encodePathSegment(library.id, operation)}/all`,
    operation,
    options: {
      method: "GET",
      signal: options.signal,
      query: {
        type: mediaKindToPlexMetadataType(kind),
        "X-Plex-Container-Start": offset,
        "X-Plex-Container-Size": limit,
        ...pushdown.query,
      },
    },
  });
  const result = toPage(
    operation,
    queryTarget,
    response,
    offset,
    options.filter,
    pushdown.applied,
    guard,
    mapper,
  );
  options.signal?.throwIfAborted();
  context.cache.set(cacheKey, result);
  return result;
}

async function fetchAlbumTracks(
  context: PlexQueryLibraryContext,
  albumId: string,
): Promise<readonly MediaTrack[]> {
  const operation = "fetch Plex album tracks";
  const cacheKey = {
    category: "queries" as const,
    discriminator: ["album-tracks", albumId],
  };
  const cached = context.cache.get<readonly MediaTrack[]>(cacheKey);
  if (cached !== undefined) return cached;

  const response = await context.transport.request<unknown>({
    path: `/library/metadata/${encodePathSegment(albumId, operation)}/children`,
    operation,
    options: { method: "GET" },
  });
  if (!isPlexWireMetadataResponse(response, isPlexWireTrack)) {
    throw invalidResponse(operation, "Plex returned malformed album track metadata");
  }
  let tracks: readonly MediaTrack[];
  try {
    tracks = (response.MediaContainer.Metadata ?? []).map(context.mappers.track);
  } catch {
    throw invalidResponse(operation, "Plex returned invalid album track field values");
  }
  context.cache.set(cacheKey, tracks);
  return tracks;
}

async function fetchTrackById(
  context: PlexQueryLibraryContext,
  trackId: string,
  options?: MediaTrackLookupOptions,
): Promise<MediaTrack> {
  const operation = "fetch Plex track";
  const response = await context.transport.request<unknown>({
    path: `/library/metadata/${encodePathSegment(trackId, operation)}`,
    operation,
    options: { method: "GET", signal: options?.signal },
  });
  if (!isPlexWireMetadataResponse(response, isPlexWireTrack)) {
    throw invalidResponse(operation, "Plex returned malformed track metadata");
  }
  const wireTracks = response.MediaContainer.Metadata ?? [];
  if (wireTracks.length !== 1) {
    throw invalidResponse(operation, "Plex did not return exactly one track");
  }
  try {
    const track = context.mappers.track(wireTracks[0]!);
    if (track.id !== trackId) {
      throw invalidResponse(operation, "Plex returned a different track identifier");
    }
    return track;
  } catch (error: unknown) {
    if (error instanceof MediaServerError) throw error;
    throw invalidResponse(operation, "Plex returned invalid track field values");
  }
}

function createPlexQueryCapability(
  context: PlexQueryLibraryContext,
  find: PlexLibraryIdentityFamily["findWithOptions"],
): MediaServerQueryCapability {
  return Object.freeze({
    libraryContentVersion: (
      library: string,
      options?: MediaLibraryContentVersionOptions,
    ): Promise<MediaLibraryContentVersion> => fetchLibraryContentVersion(context, library, options),
    trackById: (trackId: string, options?: MediaTrackLookupOptions) =>
      fetchTrackById(context, trackId, options),
    tracks: (options: MediaQueryOptions & { readonly kind: "track" }) =>
      executeQuery<MediaTrack>(
        context,
        find,
        "track",
        options,
        "query Plex tracks",
        "Plex tracks",
        isPlexWireTrack,
        context.mappers.track,
      ),
    albums: (options: MediaQueryOptions & { readonly kind: "album" }) =>
      executeQuery<MediaAlbum>(
        context,
        find,
        "album",
        options,
        "query Plex albums",
        "Plex albums",
        isPlexWireAlbum,
        context.mappers.album,
      ),
    artists: (options: MediaQueryOptions & { readonly kind: "artist" }) =>
      executeQuery<MediaArtist>(
        context,
        find,
        "artist",
        options,
        "query Plex artists",
        "Plex artists",
        isPlexWireArtist,
        context.mappers.artist,
      ),
    albumTracks: (albumId: string) => fetchAlbumTracks(context, albumId),
  });
}

async function triggerScan(
  context: PlexQueryLibraryContext,
  find: PlexLibraryIdentityFamily["find"],
): Promise<MediaServerScanResult> {
  try {
    if (context.defaultLibraryName !== undefined) {
      const library = await find(context.defaultLibraryName);
      await context.transport.request<void>({
        path: `/library/sections/${encodePathSegment(library.id, "scan Plex library")}/refresh`,
        operation: "scan Plex library",
        options: { method: "GET" },
        replayable: false,
      });
      return {
        success: true,
        message: `Scan triggered for "${library.title}"`,
        libraryName: library.title,
      };
    }

    await context.transport.request<void>({
      path: "/library/sections/all/refresh",
      operation: "scan all Plex libraries",
      options: { method: "GET" },
      replayable: false,
    });
    return { success: true, message: "Scan triggered for all libraries" };
  } catch (error: unknown) {
    return scanFailure(error);
  }
}

async function triggerPathScan(
  context: PlexQueryLibraryContext,
  libraryId: string,
  scanPath: string,
): Promise<MediaServerScanResult> {
  try {
    await context.transport.request<void>({
      path: `/library/sections/${encodePathSegment(libraryId, "scan Plex path")}/refresh`,
      operation: "scan Plex path",
      options: { method: "GET", query: { path: scanPath } },
      replayable: false,
    });
    return { success: true, message: `Path scan triggered for: ${scanPath}` };
  } catch (error: unknown) {
    return scanFailure(error);
  }
}

function matchLibraryName(
  context: PlexQueryLibraryContext,
  destinationPath: string,
): string | undefined {
  const normalizedDestination = path.resolve(destinationPath);
  const sortedMappings = [...context.libraryMappings].sort(
    (left, right) => right.path.length - left.path.length,
  );
  for (const mapping of sortedMappings) {
    const normalizedMapping = path.resolve(mapping.path);
    if (
      normalizedDestination === normalizedMapping ||
      normalizedDestination.startsWith(`${normalizedMapping}${path.sep}`)
    ) {
      return mapping.library;
    }
  }
  return context.defaultLibraryName;
}

async function triggerSourceScan(
  context: PlexQueryLibraryContext,
  find: PlexLibraryIdentityFamily["find"],
  trigger: () => Promise<MediaServerScanResult>,
  triggerPath: (libraryId: string, scanPath: string) => Promise<MediaServerScanResult>,
  destinationPath: string,
): Promise<MediaServerScanResult> {
  const libraryName = matchLibraryName(context, destinationPath);
  if (libraryName === undefined) return trigger();

  try {
    const library = await find(libraryName);
    const result = await triggerPath(library.id, destinationPath);
    return {
      ...result,
      libraryName: library.title,
      message: result.success
        ? `Path scan triggered for "${destinationPath}" in "${library.title}"`
        : result.message,
    };
  } catch {
    return trigger();
  }
}

function createPlexScanCapability(
  context: PlexQueryLibraryContext,
  find: PlexLibraryIdentityFamily["find"],
): MediaServerScanCapability {
  const trigger = (): Promise<MediaServerScanResult> => triggerScan(context, find);
  const triggerPath = (libraryId: string, scanPath: string): Promise<MediaServerScanResult> =>
    triggerPathScan(context, libraryId, scanPath);
  const triggerSource = (destinationPath: string): Promise<MediaServerScanResult> =>
    triggerSourceScan(context, find, trigger, triggerPath, destinationPath);
  return Object.freeze({ trigger, triggerPath, triggerSource });
}

/**
 * Creates the private Plex query/library/identity/scan family.
 *
 * @param dependencies - Captured transport, cache, mappers, and scan settings.
 * @returns Generic query/library/scan capabilities plus a private identity callback.
 * @throws TypeError when the configured page size is invalid.
 */
export function createPlexQueryLibraryFamily(
  dependencies: PlexQueryLibraryDependencies,
): PlexQueryLibraryFamily {
  const context = createQueryLibraryContext(dependencies);
  const libraryIdentity = createPlexLibraryIdentityFamily(context);
  return Object.freeze({
    query: createPlexQueryCapability(context, libraryIdentity.findWithOptions),
    library: libraryIdentity.capability,
    scan: createPlexScanCapability(context, libraryIdentity.find),
    findLibrary: libraryIdentity.findWithOptions,
    getMachineIdentifier: libraryIdentity.getMachineIdentifier,
  });
}
