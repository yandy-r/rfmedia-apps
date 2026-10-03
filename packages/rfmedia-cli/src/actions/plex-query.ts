/**
 * Plex query action for rfmedia CLI.
 *
 * Query orchestration uses the provider-neutral media-server contract. Plex
 * field names and rating scale are restored only in the pure compatibility
 * projection used by the public result and SQLite persistence boundaries.
 */

import { resolveRequiredMediaServerAdapter } from "../lib/adapters/action-helpers.js";
import { resolveUndoDatabasePath } from "../lib/config.js";
import {
  closeDatabase,
  createPlexQuery,
  initializeDatabase,
  savePlexQueryResults,
  updatePlexQueryStatus,
} from "../lib/db.js";
import {
  evaluateMediaFilterWithAppliedRules,
  planMediaFilterQueries,
} from "../lib/media-filter-evaluator.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { logDebug, logInfo } from "../lib/logger.js";
import { advancePaginationOffset } from "../lib/pagination.js";
import { normalizedToPlex } from "../lib/ratings.js";
import type { DbConnection, PlexQueryFilters, PlexQueryResultItem } from "../types/db.js";
import type { MediaFilter, MediaFilterNode, MediaFilterRule } from "../types/media-filters.js";
import type {
  MediaAlbum,
  MediaArtist,
  MediaItem,
  MediaKind,
  MediaPage,
  MediaQueryOptions,
  MediaServerAdapter,
  MediaTrack,
} from "../types/media-server.js";
import type {
  PlexAlbum,
  PlexAlbumQueryResult,
  PlexArtist,
  PlexArtistQueryResult,
  PlexQueryResult,
  PlexTrack,
} from "../types/plex.js";

/** Options for the Plex query action. */
export interface PlexQueryActionOptions {
  /** Name of the Plex library to query (can be derived from filter defaults or config) */
  library?: string;
  /** Type of media to query (defaults to 'track') */
  type?: "track" | "album" | "artist";
  /** Minimum artist star rating (1-5 scale, works on all types) */
  minArtistRating?: number;
  /** Maximum artist star rating (1-5 scale, works on all types) */
  maxArtistRating?: number;
  /** Minimum album star rating (1-5 scale, works on albums and tracks) */
  minAlbumRating?: number;
  /** Maximum album star rating (1-5 scale, works on albums and tracks) */
  maxAlbumRating?: number;
  /** Minimum track star rating (1-5 scale, works on tracks only) */
  minTrackRating?: number;
  /** Maximum track star rating (1-5 scale, works on tracks only) */
  maxTrackRating?: number;
  /** Filter by genre name */
  genre?: string;
  /** Filter by exact year */
  year?: number;
  /** Filter by minimum year */
  minYear?: number;
  /** Filter by maximum year */
  maxYear?: number;
  /** Filter by minimum play count */
  minPlays?: number;
  /** Filter by artist name (case-insensitive substring match) */
  artist?: string;
  /** Filter by title (case-insensitive substring match) */
  title?: string;
  /** Filter by album name (tracks only, case-insensitive substring match) */
  album?: string;
  /** Filter by style tag (e.g., 'Jazz', 'Fusion') - only for artists/albums */
  style?: string;
  /** Filter by mood tag (e.g., 'Relaxing', 'Energetic') */
  mood?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** CLI override for Plex server URL */
  plexUrl?: string;
  /** CLI override for Plex authentication token */
  plexToken?: string;
  /** Optional name for the saved query (queries are saved by default) */
  name?: string;
  /** Disable saving query to database */
  noSave?: boolean;
  /** Named filter from plexFilters config section */
  filter?: string;
}

/** Established Plex-branded public result with an optional saved-query ID. */
export type PlexQueryActionResult = (
  | PlexQueryResult
  | PlexAlbumQueryResult
  | PlexArtistQueryResult
) & {
  queryId?: number;
};

interface DefaultQueryFilters {
  readonly minRating?: number;
  readonly minPlays?: number;
  readonly genre?: string;
  readonly excludeGenres?: readonly string[];
}

type ProjectedMediaItem =
  | {
      readonly kind: "track";
      readonly publicItem: PlexTrack;
      readonly databaseItem: PlexQueryResultItem;
    }
  | {
      readonly kind: "album";
      readonly publicItem: PlexAlbum;
      readonly databaseItem: PlexQueryResultItem;
    }
  | {
      readonly kind: "artist";
      readonly publicItem: PlexArtist;
      readonly databaseItem: PlexQueryResultItem;
    };

type ProjectedTrack = Extract<ProjectedMediaItem, { readonly kind: "track" }>;
type ProjectedAlbum = Extract<ProjectedMediaItem, { readonly kind: "album" }>;
type ProjectedArtist = Extract<ProjectedMediaItem, { readonly kind: "artist" }>;

interface QueryOutcome {
  readonly result: PlexQueryActionResult;
  readonly databaseItems: PlexQueryResultItem[];
  readonly resultCount: number;
  readonly total: number;
}

function rule(
  field: MediaFilterRule["field"],
  operator: MediaFilterRule["operator"],
  value: string | number | undefined,
): MediaFilterRule | undefined {
  return value === undefined ? undefined : { type: "rule", field, operator, value };
}

function optionRules(
  options: PlexQueryActionOptions,
  defaults: DefaultQueryFilters | undefined,
): MediaFilterRule[] {
  return [
    rule("artistRating", ">=", options.minArtistRating),
    rule("artistRating", "<=", options.maxArtistRating),
    rule("albumRating", ">=", options.minAlbumRating),
    rule("albumRating", "<=", options.maxAlbumRating),
    rule("trackRating", ">=", options.minTrackRating ?? defaults?.minRating),
    rule("trackRating", "<=", options.maxTrackRating),
    rule("genre", "contains", options.genre ?? defaults?.genre),
    rule("style", "contains", options.style),
    rule("mood", "contains", options.mood),
    rule("year", "==", options.year),
    rule("minYear", ">=", options.minYear),
    rule("maxYear", "<=", options.maxYear),
    rule("minPlays", ">=", options.minPlays ?? defaults?.minPlays),
    rule("artist", "contains", options.artist),
    rule("title", "contains", options.title),
    rule("album", "contains", options.album),
  ].filter((candidate): candidate is MediaFilterRule => candidate !== undefined);
}

function overrideRole(candidate: MediaFilterRule): string {
  const positiveTextOperator = candidate.operator === "==" || candidate.operator === "contains";
  return `${candidate.field}:${positiveTextOperator ? "positive-text" : candidate.operator}`;
}

function removeOverriddenRules(
  nodes: readonly MediaFilterNode[],
  roles: ReadonlySet<string>,
): MediaFilterNode[] {
  const retained: MediaFilterNode[] = [];
  for (const node of nodes) {
    if (node.type === "rule") {
      if (!roles.has(overrideRole(node))) {
        retained.push(node);
      }
      continue;
    }

    if (node.match === "any" && containsOverriddenRule(node.rules, roles)) {
      continue;
    }

    const rules = removeOverriddenRules(node.rules, roles);
    if (rules.length > 0) {
      retained.push({ ...node, rules });
    }
  }
  return retained;
}

function containsOverriddenRule(
  nodes: readonly MediaFilterNode[],
  roles: ReadonlySet<string>,
): boolean {
  return nodes.some((node) =>
    node.type === "rule"
      ? roles.has(overrideRole(node))
      : containsOverriddenRule(node.rules, roles),
  );
}

function buildEffectiveFilter(
  namedFilter: MediaFilter | undefined,
  options: PlexQueryActionOptions,
  defaults: DefaultQueryFilters | undefined,
): MediaFilter | undefined {
  const explicitRules = optionRules(options, namedFilter === undefined ? defaults : undefined);
  if (namedFilter === undefined) {
    return explicitRules.length === 0 ? undefined : { match: "all", rules: explicitRules };
  }
  if (explicitRules.length === 0) {
    return namedFilter;
  }

  const overriddenRoles = new Set(explicitRules.map(overrideRole));
  const retainedNamedRules =
    namedFilter.match === "any" && containsOverriddenRule(namedFilter.rules, overriddenRoles)
      ? []
      : removeOverriddenRules(namedFilter.rules, overriddenRoles);
  const namedRules =
    namedFilter.match === "all"
      ? retainedNamedRules
      : retainedNamedRules.length === 0
        ? []
        : [{ type: "group" as const, match: namedFilter.match, rules: retainedNamedRules }];
  return { match: "all", rules: [...namedRules, ...explicitRules] };
}

function supportsRule(
  adapter: MediaServerAdapter,
  kind: MediaKind,
  candidate: MediaFilterRule,
): boolean {
  const pushdown = adapter.features.filterPushdown;
  if (
    !pushdown.supported ||
    !pushdown.fields.includes(candidate.field) ||
    !pushdown.operators.includes(candidate.operator)
  ) {
    return false;
  }

  switch (candidate.field) {
    case "album":
    case "trackRating":
    case "minPlays":
      return kind === "track";
    case "albumRating":
      return kind !== "artist";
    case "style":
      return kind !== "track";
    case "year":
    case "minYear":
    case "maxYear":
      return kind !== "artist";
    default:
      return true;
  }
}

function queryVariantFilters(
  adapter: MediaServerAdapter,
  kind: MediaKind,
  filter: MediaFilter | undefined,
): readonly {
  readonly filter: MediaFilter | undefined;
  readonly appliedRules: readonly MediaFilterRule[];
}[] {
  if (filter === undefined) {
    return [{ filter: undefined, appliedRules: [] }];
  }

  const plan = planMediaFilterQueries(filter, (candidate) =>
    supportsRule(adapter, kind, candidate),
  );
  const expanded = plan.queryVariants.length > 1 || (plan.queryVariants[0]?.length ?? 0) > 0;
  if (!expanded) {
    return [{ filter, appliedRules: plan.baseRules }];
  }

  return plan.queryVariants.map((variantRules) => ({
    filter: {
      match: "all",
      rules: [...plan.baseRules, ...variantRules],
    },
    appliedRules: [...plan.baseRules, ...variantRules],
  }));
}

async function collectQueryItems<T extends MediaItem>(
  kind: T["kind"],
  library: string,
  limit: number | undefined,
  filter: MediaFilter | undefined,
  adapter: MediaServerAdapter,
  query: (options: MediaQueryOptions & { readonly kind: T["kind"] }) => Promise<MediaPage<T>>,
): Promise<{ readonly items: readonly T[]; readonly total: number }> {
  const variants = queryVariantFilters(adapter, kind, filter);
  const combined: T[] = [];
  let total = 0;

  for (const variant of variants) {
    let offset = 0;
    let matchedForVariant = 0;
    let hasMore = true;

    while (hasMore && (limit === undefined || matchedForVariant < limit)) {
      const page = await query({ library, kind, limit, offset, filter: variant.filter });
      total = page.total;
      const matched =
        filter === undefined
          ? page.items
          : page.items.filter((item) =>
              evaluateMediaFilterWithAppliedRules(filter, item, variant.appliedRules),
            );
      combined.push(...matched);
      matchedForVariant += matched.length;
      hasMore = page.hasMore;
      if (hasMore) {
        offset = advancePaginationOffset(page, `${kind}s`);
      }
    }
  }

  const seen = new Set<string>();
  const items =
    variants.length === 1
      ? combined
      : combined.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });

  return { items: limit === undefined ? items : items.slice(0, limit), total };
}

function filterByExcludedGenres<T extends MediaItem>(
  items: readonly T[],
  excludeGenres: readonly string[],
): readonly T[] {
  if (excludeGenres.length === 0) {
    return items;
  }
  const excluded = new Set(excludeGenres.map((genre) => genre.toLowerCase()));
  return items.filter(
    (item) =>
      item.genres === undefined || !item.genres.some((genre) => excluded.has(genre.toLowerCase())),
  );
}

/**
 * Project one generic entity once for both compatibility consumers.
 *
 * The public action result and SQLite input deliberately retain Plex names and
 * the native 0..10 rating scale. No provider DTO or private adapter helper
 * crosses into this action.
 */
function projectMediaItem(item: MediaTrack): ProjectedTrack;
function projectMediaItem(item: MediaAlbum): ProjectedAlbum;
function projectMediaItem(item: MediaArtist): ProjectedArtist;
function projectMediaItem(item: MediaItem): ProjectedMediaItem {
  const userRating = normalizedToPlex(item.rating ?? 0);
  const databaseBase = {
    ratingKey: item.id,
    mediaType: item.kind,
    title: item.title,
    userRating,
    year: item.year,
  };

  switch (item.kind) {
    case "track": {
      const publicItem: PlexTrack = {
        ratingKey: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        userRating,
        viewCount: item.playCount,
        duration: item.durationMs,
        year: item.year,
        filePath: item.filePath,
        moods: item.moods === undefined ? [] : [...item.moods],
      };
      return {
        kind: "track",
        publicItem,
        databaseItem: {
          ...databaseBase,
          artist: item.artist,
          album: item.album,
          viewCount: item.playCount,
          filePath: item.filePath,
        },
      };
    }
    case "album": {
      const publicItem: PlexAlbum = {
        ratingKey: item.id,
        title: item.title,
        artist: item.artist,
        userRating,
        year: item.year,
        trackCount: item.trackCount,
        thumb: item.artworkPath,
        styles: item.styles === undefined ? [] : [...item.styles],
        moods: item.moods === undefined ? [] : [...item.moods],
      };
      return {
        kind: "album",
        publicItem,
        databaseItem: { ...databaseBase, artist: item.artist, trackCount: item.trackCount },
      };
    }
    case "artist": {
      const publicItem: PlexArtist = {
        ratingKey: item.id,
        title: item.title,
        userRating,
        albumCount: item.albumCount,
        thumb: item.artworkPath,
        styles: item.styles === undefined ? [] : [...item.styles],
        moods: item.moods === undefined ? [] : [...item.moods],
      };
      return {
        kind: "artist",
        publicItem,
        databaseItem: { ...databaseBase, albumCount: item.albumCount },
      };
    }
  }
}

async function runQuery(
  kind: MediaKind,
  library: string,
  limit: number | undefined,
  filter: MediaFilter | undefined,
  excludeGenres: readonly string[],
  adapter: MediaServerAdapter,
): Promise<QueryOutcome> {
  switch (kind) {
    case "track": {
      const page = await collectQueryItems<MediaTrack>(
        kind,
        library,
        limit,
        filter,
        adapter,
        (options) => adapter.query.tracks(options),
      );
      const items = filterByExcludedGenres(page.items, excludeGenres);
      const projected = items.map((item) => projectMediaItem(item));
      const result: PlexQueryResult = {
        tracks: projected.map(({ publicItem }) => publicItem),
        totalSize: page.total,
        offset: 0,
        hasMore: false,
      };
      return {
        result,
        databaseItems: projected.map(({ databaseItem }) => databaseItem),
        resultCount: items.length,
        total: page.total,
      };
    }
    case "album": {
      const page = await collectQueryItems<MediaAlbum>(
        kind,
        library,
        limit,
        filter,
        adapter,
        (options) => adapter.query.albums(options),
      );
      const items = filterByExcludedGenres(page.items, excludeGenres);
      const projected = items.map((item) => projectMediaItem(item));
      const result: PlexAlbumQueryResult = {
        albums: projected.map(({ publicItem }) => publicItem),
        totalSize: page.total,
        offset: 0,
        hasMore: false,
      };
      return {
        result,
        databaseItems: projected.map(({ databaseItem }) => databaseItem),
        resultCount: items.length,
        total: page.total,
      };
    }
    case "artist": {
      const page = await collectQueryItems<MediaArtist>(
        kind,
        library,
        limit,
        filter,
        adapter,
        (options) => adapter.query.artists(options),
      );
      const items = filterByExcludedGenres(page.items, excludeGenres);
      const projected = items.map((item) => projectMediaItem(item));
      const result: PlexArtistQueryResult = {
        artists: projected.map(({ publicItem }) => publicItem),
        totalSize: page.total,
        offset: 0,
        hasMore: false,
      };
      return {
        result,
        databaseItems: projected.map(({ databaseItem }) => databaseItem),
        resultCount: items.length,
        total: page.total,
      };
    }
  }
}

/** Execute a Plex library query with the given options. */
export async function executePlexQuery(
  options: PlexQueryActionOptions,
): Promise<PlexQueryActionResult> {
  const config = getLoadedConfig();
  const plexConfig = config?.plex ?? {};
  const defaultFilters = plexConfig.defaultFilters ?? {};
  const adapter = resolveRequiredMediaServerAdapter({
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
  });

  let namedFilter: MediaFilter | undefined;
  if (options.filter !== undefined) {
    const filters = config.plexFilters;
    if (!filters || !(options.filter in filters)) {
      const available = filters ? Object.keys(filters).join(", ") : "none";
      throw new Error(
        `Filter "${options.filter}" not found in plexFilters config. Available: ${available}`,
      );
    }
    namedFilter = filters[options.filter];
    logDebug(`Loaded Plex filter: ${options.filter}`);
  }

  const library = options.library ?? namedFilter?.library;
  const kind: MediaKind = options.type ?? namedFilter?.type ?? "track";
  const limit = options.limit ?? namedFilter?.limit;
  if (!library) {
    throw new Error("Library is required. Set via --library option or filter defaults");
  }

  logDebug(
    `Query type resolution: options.type=${options.type}, namedFilter?.type=${namedFilter?.type}, result=${kind}`,
  );
  const filter = buildEffectiveFilter(namedFilter, options, defaultFilters);
  const excludeGenres = namedFilter === undefined ? (defaultFilters.excludeGenres ?? []) : [];

  let db: DbConnection | undefined;
  let queryId: number | undefined;
  if (options.noSave !== true) {
    const dbPath = resolveUndoDatabasePath(config);
    db = await initializeDatabase(dbPath);
    logDebug(`Initialized database for query tracking: ${dbPath}`);
  }

  try {
    if (db !== undefined) {
      queryId = createPlexQuery(db, {
        libraryName: library,
        mediaType: kind,
        filters: buildFiltersObject(options, options.filter),
        name: options.name,
      });
      logDebug(`Created Plex query record with ID: ${queryId}`);
    }

    const outcome = await runQuery(kind, library, limit, filter, excludeGenres, adapter);
    logInfo(`Found ${outcome.resultCount} of ${outcome.total} ${kind}s`);

    if (db !== undefined && queryId !== undefined) {
      updatePlexQueryStatus(db, queryId, "completed", outcome.resultCount, outcome.total);
      const savedCount = savePlexQueryResults(db, queryId, outcome.databaseItems);
      logInfo(`Saved ${savedCount} query results to database (query ID: ${queryId})`);
      return { ...outcome.result, queryId };
    }

    return outcome.result;
  } catch (error: unknown) {
    if (db !== undefined && queryId !== undefined) {
      updatePlexQueryStatus(db, queryId, "failed", 0, 0);
      logDebug(`Updated Plex query ${queryId} status to failed`);
    }
    throw error;
  } finally {
    if (db !== undefined) {
      closeDatabase(db);
    }
  }
}

function buildFiltersObject(
  options: PlexQueryActionOptions,
  filterName?: string,
): PlexQueryFilters {
  const filters: PlexQueryFilters = {};
  if (filterName !== undefined) filters.filterName = filterName;
  if (options.minArtistRating !== undefined) filters.minArtistRating = options.minArtistRating;
  if (options.maxArtistRating !== undefined) filters.maxArtistRating = options.maxArtistRating;
  if (options.minAlbumRating !== undefined) filters.minAlbumRating = options.minAlbumRating;
  if (options.maxAlbumRating !== undefined) filters.maxAlbumRating = options.maxAlbumRating;
  if (options.minTrackRating !== undefined) filters.minTrackRating = options.minTrackRating;
  if (options.maxTrackRating !== undefined) filters.maxTrackRating = options.maxTrackRating;
  if (options.genre !== undefined) filters.genre = options.genre;
  if (options.year !== undefined) filters.year = options.year;
  if (options.minYear !== undefined) filters.minYear = options.minYear;
  if (options.maxYear !== undefined) filters.maxYear = options.maxYear;
  if (options.minPlays !== undefined) filters.minPlays = options.minPlays;
  if (options.artist !== undefined) filters.artist = options.artist;
  if (options.title !== undefined) filters.title = options.title;
  if (options.album !== undefined) filters.album = options.album;
  return filters;
}
