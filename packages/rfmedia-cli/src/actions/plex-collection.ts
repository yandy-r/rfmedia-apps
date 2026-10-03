/**
 * Plex collection action handlers for rfmedia CLI.
 *
 * Provides functions for creating, listing, managing, and deleting Plex collections.
 * These actions implement the business logic for the `plex collection` command group.
 *
 * Supports two modes for adding items to collections:
 * - **Filter mode**: Query tracks/albums with filters (genre, year, rating) and add matches
 * - **Folder mode**: Match local audio files to Plex tracks by file path
 */

import path from "node:path";

import { logInfo, logDebug, logWarn, logSuccess } from "../lib/logger.js";
import { pathExists } from "../lib/filesystem.js";
import { findAudioFiles } from "../lib/audio.js";
import { confirm } from "../lib/prompt.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { resolveRequiredMediaServerAdapter } from "../lib/adapters/action-helpers.js";
import { PLEX_MEDIA_TYPE_CODES } from "../types/plex.js";
import type { CollectionResult, PlexCollection } from "../types/plex.js";
import {
  evaluateMediaFilterWithAppliedRules,
  planMediaFilterQueries,
} from "../lib/media-filter-evaluator.js";
import { advancePaginationOffset } from "../lib/pagination.js";
import type { MediaFilter, MediaFilterNode, MediaFilterRule } from "../types/media-filters.js";
import {
  type MediaAlbum,
  type MediaArtist,
  type MediaCollection,
  type MediaItem,
  type MediaKind,
  type MediaPage,
  type MediaQueryOptions,
  type MediaServerAdapter,
  type MediaTrack,
} from "../types/media-server.js";

// =============================================================================
// Type Definitions for Action Options
// =============================================================================

/**
 * Options for creating a new collection.
 * Interface matches CLI command expectations.
 */
export interface CollectionCreateActionOptions {
  /** Name of the collection to create */
  collectionName: string;
  /** Library name (required) */
  library?: string;
  /** Collection media type (defaults to track) */
  type?: MediaKind;
  /** Filter by genre */
  genre?: string;
  /** Filter by year (supports ranges like ">=2020", "<2000", "2020-2023") */
  year?: string;
  /** Minimum star rating (1.0-5.0 scale) - maps to minTrackRating for backward compatibility */
  minStars?: number;
  /** Maximum number of items to add */
  limit?: number;
  /** Create as smart (filter-based) collection */
  smart?: boolean;
  /** Override Plex server URL */
  plexUrl?: string;
  /** Override Plex authentication token */
  plexToken?: string;

  // Hierarchical rating fields (1-5 star scale)
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

  // Text filter fields
  /** Filter by style tag (comma-separated for OR logic) */
  style?: string;
  /** Filter by mood tag (comma-separated for OR logic) */
  mood?: string;
  /** Filter by artist name (contains match) */
  artist?: string;
  /** Filter by track title (contains match) */
  title?: string;
  /** Filter by album title (contains match) */
  album?: string;

  // Year/play fields
  /** Minimum release year */
  minYear?: number;
  /** Maximum release year */
  maxYear?: number;
  /** Minimum play count */
  minPlays?: number;

  // Named filter support
  /** Name of a filter defined in config.plexFilters */
  filter?: string;
}

/**
 * Options for adding items to a collection.
 * Interface matches CLI command expectations.
 */
export interface CollectionAddActionOptions {
  /** Name of the collection to add items to */
  collectionName: string;
  /** Library name (optional, required for most operations) */
  library?: string;
  /** Add mode (defaults to track) */
  mode?: MediaKind;
  /** Alias for mode=track */
  addTrack?: boolean;
  /** Alias for mode=album */
  addAlbum?: boolean;
  /** Alias for mode=artist */
  addArtist?: boolean;
  /** Local folder path for folder-based matching */
  fromFolder?: string;
  /** Filter by genre */
  genre?: string;
  /** Filter by year */
  year?: string;
  /** Minimum star rating (1.0-5.0 scale) - maps to minTrackRating for backward compatibility */
  minStars?: number;
  /** Maximum number of items to add */
  limit?: number;
  /** Override Plex server URL */
  plexUrl?: string;
  /** Override Plex authentication token */
  plexToken?: string;
  /** Enable verbose output for path matching */
  verbose?: boolean;

  // Hierarchical rating fields (1-5 star scale)
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

  // Text filter fields
  /** Filter by style tag (comma-separated for OR logic) */
  style?: string;
  /** Filter by mood tag (comma-separated for OR logic) */
  mood?: string;
  /** Filter by artist name (contains match) */
  artist?: string;
  /** Filter by track title (contains match) */
  title?: string;
  /** Filter by album title (contains match) */
  album?: string;

  // Year/play fields
  /** Minimum release year */
  minYear?: number;
  /** Maximum release year */
  maxYear?: number;
  /** Minimum play count */
  minPlays?: number;

  // Named filter support
  /** Name of a filter defined in config.plexFilters */
  filter?: string;
}

/**
 * Options for listing collections.
 */
export interface CollectionListActionOptions {
  /** Library name (required at runtime, validated in function) */
  library?: string;
  /** Override Plex server URL */
  plexUrl?: string;
  /** Override Plex authentication token */
  plexToken?: string;
}

/**
 * Options for showing a collection's details.
 */
export interface CollectionShowActionOptions {
  /** Name of the collection to show */
  collectionName: string;
  /** Library name (optional) */
  library?: string;
  /** Override Plex server URL */
  plexUrl?: string;
  /** Override Plex authentication token */
  plexToken?: string;
}

/**
 * Options for deleting a collection.
 */
export interface CollectionDeleteActionOptions {
  /** Name of the collection to delete */
  collectionName: string;
  /** Library name (optional) */
  library?: string;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Override Plex server URL */
  plexUrl?: string;
  /** Override Plex authentication token */
  plexToken?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

type MediaServerContext = MediaServerAdapter;

/**
 * Builds a required media server adapter from loaded config and CLI overrides.
 *
 * @param options - CLI options that may override config values
 * @returns Validated media server adapter
 */
function buildPlexApiConfig(options: { plexUrl?: string; plexToken?: string }): MediaServerContext {
  return resolveRequiredMediaServerAdapter({
    plexUrl: options.plexUrl,
    plexToken: options.plexToken,
  });
}

/**
 * Loads a named filter from the plexFilters configuration section.
 *
 * @param filterName - Name of the filter to load from config.plexFilters
 * @returns The loaded provider-neutral media filter
 * @throws Error if the filter is not found, listing available filters
 */
function loadNamedFilter(filterName: string): MediaFilter {
  const config = getLoadedConfig();
  const filters = config?.plexFilters;
  if (!filters || !(filterName in filters)) {
    const available = filters ? Object.keys(filters).join(", ") : "none";
    throw new Error(
      `Filter "${filterName}" not found in plexFilters config. Available: ${available}`,
    );
  }
  const filter = filters[filterName];
  if (!filter) {
    throw new Error(`Filter "${filterName}" is undefined in plexFilters config.`);
  }
  logDebug(`Loaded Plex filter: ${filterName}`);
  return filter;
}

/**
 * Filter options input type for parseFilterOptions.
 * Covers all filter fields from CollectionCreateActionOptions and CollectionAddActionOptions.
 */
interface FilterOptionsInput {
  // Legacy/backward compatible options
  genre?: string;
  year?: string;
  /** @deprecated Use minTrackRating instead. Maps to minTrackRating for backward compatibility. */
  minStars?: number;

  // Hierarchical rating fields (1-5 star scale)
  minArtistRating?: number;
  maxArtistRating?: number;
  minAlbumRating?: number;
  maxAlbumRating?: number;
  minTrackRating?: number;
  maxTrackRating?: number;

  // Text filter fields
  style?: string;
  mood?: string;
  artist?: string;
  title?: string;
  album?: string;

  // Year/play fields
  minYear?: number;
  maxYear?: number;
  minPlays?: number;
}

/**
 * Parses CLI filter options into a provider-neutral media filter.
 *
 * Handles all filter fields from the extended action options interfaces and returns
 * a generic filter expression for adapter pushdown and residual evaluation.
 *
 * Key behaviors:
 * - Rating fields (1-5 scale) are passed through directly - the adapter handles conversion
 * - Text fields (style, mood, artist, title, album) become generic filter rules
 * - Year string parsing: supports ">=2020", "<2000", "2020-2023", or exact year
 * - Individual minYear/maxYear take precedence over parsed year string
 * - Legacy minStars maps to minTrackRating for backward compatibility (with deprecation warning)
 *
 * @param options - CLI options with filter fields
 * @returns Media filter or undefined if no filters were provided
 */
function parseFilterOptions(options: FilterOptionsInput): MediaFilter | undefined {
  const rules: MediaFilterRule[] = [];
  const addRule = (
    field: MediaFilterRule["field"],
    operator: MediaFilterRule["operator"],
    value: string | number | undefined,
  ): void => {
    if (value !== undefined) {
      rules.push({ type: "rule", field, operator, value });
    }
  };

  addRule("genre", "contains", options.genre);
  addRule("style", "contains", options.style);
  addRule("mood", "contains", options.mood);
  addRule("artist", "contains", options.artist);
  addRule("title", "contains", options.title);
  addRule("album", "contains", options.album);

  if (options.year) {
    const yearStr = options.year.trim();

    if (yearStr.startsWith(">=")) {
      if (options.minYear === undefined) {
        addRule("minYear", ">=", parseInt(yearStr.slice(2), 10));
      }
    } else if (yearStr.startsWith("<=")) {
      if (options.maxYear === undefined) {
        addRule("maxYear", "<=", parseInt(yearStr.slice(2), 10));
      }
    } else if (yearStr.startsWith(">")) {
      if (options.minYear === undefined) {
        addRule("minYear", ">=", parseInt(yearStr.slice(1), 10) + 1);
      }
    } else if (yearStr.startsWith("<")) {
      if (options.maxYear === undefined) {
        addRule("maxYear", "<=", parseInt(yearStr.slice(1), 10) - 1);
      }
    } else if (yearStr.includes("-")) {
      const [startStr, endStr] = yearStr.split("-");
      if (startStr && endStr) {
        if (options.minYear === undefined) {
          addRule("minYear", ">=", parseInt(startStr, 10));
        }
        if (options.maxYear === undefined) {
          addRule("maxYear", "<=", parseInt(endStr, 10));
        }
      }
    } else {
      const exactYear = parseInt(yearStr, 10);
      if (options.minYear === undefined && options.maxYear === undefined) {
        addRule("year", "==", exactYear);
      }
    }
  }

  addRule("minYear", ">=", options.minYear);
  addRule("maxYear", "<=", options.maxYear);
  addRule("artistRating", ">=", options.minArtistRating);
  addRule("artistRating", "<=", options.maxArtistRating);
  addRule("albumRating", ">=", options.minAlbumRating);
  addRule("albumRating", "<=", options.maxAlbumRating);
  addRule("trackRating", ">=", options.minTrackRating);
  addRule("trackRating", "<=", options.maxTrackRating);

  if (options.minStars !== undefined && options.minTrackRating === undefined) {
    logWarn("--min-stars is deprecated. Use --min-track-stars instead.");
    addRule("trackRating", ">=", options.minStars);
  }
  addRule("minPlays", ">=", options.minPlays);

  return rules.length === 0 ? undefined : { match: "all", rules };
}

function ruleRole(candidate: MediaFilterRule): string {
  const positiveTextOperator = candidate.operator === "==" || candidate.operator === "contains";
  return `${candidate.field}:${positiveTextOperator ? "positive-text" : candidate.operator}`;
}

function collectRuleRoles(nodes: readonly MediaFilterNode[], roles: Set<string>): void {
  for (const node of nodes) {
    if (node.type === "rule") {
      roles.add(ruleRole(node));
    } else {
      collectRuleRoles(node.rules, roles);
    }
  }
}

/** Named filter rules retain their established precedence over colliding CLI fields. */
function mergeFilters(
  namedFilter: MediaFilter | undefined,
  cliFilter: MediaFilter | undefined,
): MediaFilter | undefined {
  if (namedFilter === undefined) return cliFilter;
  if (cliFilter === undefined) return namedFilter;

  const namedRoles = new Set<string>();
  collectRuleRoles(namedFilter.rules, namedRoles);
  const cliRules = cliFilter.rules.filter(
    (node) => node.type !== "rule" || !namedRoles.has(ruleRole(node)),
  );
  const namedRules: MediaFilterNode[] =
    namedFilter.match === "all"
      ? [...namedFilter.rules]
      : [{ type: "group", match: namedFilter.match, rules: [...namedFilter.rules] }];
  return { match: "all", rules: [...namedRules, ...cliRules] };
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
    filter: { match: "all", rules: [...plan.baseRules, ...variantRules] },
    appliedRules: [...plan.baseRules, ...variantRules],
  }));
}

async function queryMediaItemsWithFilters<T extends MediaItem>(
  adapter: MediaServerAdapter,
  kind: T["kind"],
  library: string,
  cliFilter: MediaFilter | undefined,
  limit: number | undefined,
  namedFilter: MediaFilter | undefined,
  query: (options: MediaQueryOptions & { readonly kind: T["kind"] }) => Promise<MediaPage<T>>,
): Promise<readonly T[]> {
  const pageSize = 500;
  const filter = mergeFilters(namedFilter, cliFilter);
  const variants = queryVariantFilters(adapter, kind, filter);
  const combined: T[] = [];
  const seen = new Set<string>();

  for (const variant of variants) {
    let offset = 0;
    let hasMore = true;

    while (hasMore && (limit === undefined || combined.length < limit)) {
      const page = await query({ library, kind, offset, limit: pageSize, filter: variant.filter });
      const matched =
        filter === undefined
          ? page.items
          : page.items.filter((item) =>
              evaluateMediaFilterWithAppliedRules(filter, item, variant.appliedRules),
            );
      for (const item of matched) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          combined.push(item);
        }
      }
      hasMore = page.hasMore;
      if (hasMore && (limit === undefined || combined.length < limit)) {
        offset = advancePaginationOffset(page, `${kind}s`);
      }
    }

    if (limit !== undefined && combined.length >= limit) {
      break;
    }
  }

  return limit === undefined ? combined : combined.slice(0, limit);
}

async function queryTracksWithFilters(
  adapter: MediaServerAdapter,
  library: string,
  cliFilter: MediaFilter | undefined,
  limit?: number,
  namedFilter?: MediaFilter,
): Promise<readonly MediaTrack[]> {
  if (namedFilter?.type === "album") {
    const albums = await queryAlbumsWithFilters(
      adapter,
      library,
      cliFilter,
      undefined,
      namedFilter,
    );
    const tracks: MediaTrack[] = [];
    for (const album of albums) {
      const albumTracks = await adapter.query.albumTracks(album.id);
      tracks.push(...albumTracks);
      logDebug(`Album "${album.title}" by ${album.artist}: ${albumTracks.length} tracks`);
    }
    return limit === undefined ? tracks : tracks.slice(0, limit);
  }

  return queryMediaItemsWithFilters<MediaTrack>(
    adapter,
    "track",
    library,
    cliFilter,
    limit,
    namedFilter,
    (options) => adapter.query.tracks(options),
  );
}

async function queryAlbumsWithFilters(
  mediaServerAdapter: MediaServerContext,
  library: string,
  cliFilter: MediaFilter | undefined,
  limit?: number,
  namedFilter?: MediaFilter,
): Promise<readonly MediaAlbum[]> {
  return queryMediaItemsWithFilters<MediaAlbum>(
    mediaServerAdapter,
    "album",
    library,
    cliFilter,
    limit,
    namedFilter,
    (options) => mediaServerAdapter.query.albums(options),
  );
}

async function queryArtistsWithFilters(
  mediaServerAdapter: MediaServerContext,
  library: string,
  cliFilter: MediaFilter | undefined,
  limit?: number,
  namedFilter?: MediaFilter,
): Promise<readonly MediaArtist[]> {
  return queryMediaItemsWithFilters<MediaArtist>(
    mediaServerAdapter,
    "artist",
    library,
    cliFilter,
    limit,
    namedFilter,
    (options) => mediaServerAdapter.query.artists(options),
  );
}

function extractItemIds(items: readonly MediaItem[]): string[] {
  return items.map((item) => item.id);
}

function formatMediaTypeCountLabel(mediaType: MediaKind, count: number): string {
  if (mediaType === "artist") {
    return count === 1 ? "artist" : "artists";
  }
  if (mediaType === "album") {
    return count === 1 ? "album" : "albums";
  }
  return count === 1 ? "track" : "tracks";
}

function resolveAddMode(options: CollectionAddActionOptions): MediaKind {
  if (options.mode) {
    return options.mode;
  }
  if (options.addArtist) {
    return "artist";
  }
  if (options.addAlbum) {
    return "album";
  }
  if (options.addTrack) {
    return "track";
  }
  return "track";
}

/** Projects a generic collection only at the established public action boundary. */
function projectCollection(collection: MediaCollection): PlexCollection {
  return {
    ratingKey: collection.id,
    key: `/library/collections/${collection.id}/children`,
    title: collection.title,
    childCount: collection.itemCount,
    smart: collection.smart,
    addedAt: 0,
    updatedAt: 0,
    type: "collection",
    metadataType: PLEX_MEDIA_TYPE_CODES[collection.kind],
    mediaType: collection.kind,
  };
}

/**
 * Matches local audio files to Plex tracks using a three-tier matching strategy.
 *
 * This function implements robust path matching to handle common filesystem differences:
 * - Different mount points (e.g., `/mnt/media/` vs `/media/`)
 * - Case sensitivity differences between Linux and macOS/Windows
 * - Symlinked directories that result in different absolute paths
 *
 * Strategy:
 * 1. **Tier 1: Exact path match** - direct string comparison of full paths
 * 2. **Tier 2: Filename match** - compare basenames to handle different mount points
 * 3. **Tier 3: Case-insensitive filename match** - handle case sensitivity differences
 *
 * @param localFiles - Array of local audio file absolute paths
 * @param serverTracks - Array of generic server tracks with file paths
 * @param verbose - Whether to log detailed matching info for debugging
 * @returns Object containing:
 *   - `matchedItemIds`: Opaque IDs of successfully matched tracks
 *   - `unmatchedFiles`: Local file paths that could not be matched
 *   - `matchStats`: Statistics about which tier matched each file
 */
function matchLocalFilesToServerTracks(
  localFiles: string[],
  serverTracks: readonly MediaTrack[],
  verbose: boolean = false,
): {
  matchedItemIds: string[];
  unmatchedFiles: string[];
  matchStats: { exact: number; basename: number; caseInsensitive: number };
} {
  const matchedItemIds: string[] = [];
  const unmatchedFiles: string[] = [];
  const matchStats = { exact: 0, basename: 0, caseInsensitive: 0 };

  // Build lookup maps for server tracks for efficient O(1) lookups
  const tracksByPath = new Map<string, MediaTrack>();
  const tracksByBasename = new Map<string, MediaTrack[]>();
  const tracksByBasenameLower = new Map<string, MediaTrack[]>();

  for (const track of serverTracks) {
    if (!track.filePath) continue;

    // Exact path lookup
    tracksByPath.set(track.filePath, track);

    // Basename lookup (case-sensitive)
    const basename = path.basename(track.filePath);
    if (!tracksByBasename.has(basename)) {
      tracksByBasename.set(basename, []);
    }
    tracksByBasename.get(basename)!.push(track);

    // Basename lookup (case-insensitive)
    const basenameLower = basename.toLowerCase();
    if (!tracksByBasenameLower.has(basenameLower)) {
      tracksByBasenameLower.set(basenameLower, []);
    }
    tracksByBasenameLower.get(basenameLower)!.push(track);
  }

  for (const localFile of localFiles) {
    // Tier 1: Exact path match
    const exactMatch = tracksByPath.get(localFile);
    if (exactMatch) {
      matchedItemIds.push(exactMatch.id);
      matchStats.exact++;
      if (verbose) {
        logDebug(`  [Tier 1] Exact match: ${localFile}`);
      }
      continue;
    }

    const localBasename = path.basename(localFile);

    // Tier 2: Filename match (handle different mount points)
    const basenameMatches = tracksByBasename.get(localBasename);
    if (basenameMatches) {
      if (basenameMatches.length === 1) {
        matchedItemIds.push(basenameMatches[0]!.id);
        matchStats.basename++;
        if (verbose) {
          logDebug(`  [Tier 2] Basename match: ${localFile} -> ${basenameMatches[0]!.filePath}`);
        }
        continue;
      } else {
        // Multiple matches - skip to avoid ambiguity
        logWarn(
          `Multiple Plex tracks (${basenameMatches.length}) match filename "${localBasename}" - skipping to avoid ambiguity`,
        );
        if (verbose) {
          for (const track of basenameMatches.slice(0, 3)) {
            logDebug(`    Candidate: ${track.filePath}`);
          }
          if (basenameMatches.length > 3) {
            logDebug(`    ... and ${basenameMatches.length - 3} more`);
          }
        }
        unmatchedFiles.push(localFile);
        continue;
      }
    }

    // Tier 3: Case-insensitive filename match
    const localBasenameLower = localBasename.toLowerCase();
    const basenameLowerMatches = tracksByBasenameLower.get(localBasenameLower);
    if (basenameLowerMatches) {
      if (basenameLowerMatches.length === 1) {
        matchedItemIds.push(basenameLowerMatches[0]!.id);
        matchStats.caseInsensitive++;
        if (verbose) {
          logDebug(
            `  [Tier 3] Case-insensitive match: ${localFile} -> ${basenameLowerMatches[0]!.filePath}`,
          );
        }
        continue;
      } else {
        // Multiple matches - skip to avoid ambiguity
        logWarn(
          `Multiple Plex tracks (${basenameLowerMatches.length}) match filename "${localBasename}" (case-insensitive) - skipping`,
        );
        if (verbose) {
          for (const track of basenameLowerMatches.slice(0, 3)) {
            logDebug(`    Candidate: ${track.filePath}`);
          }
          if (basenameLowerMatches.length > 3) {
            logDebug(`    ... and ${basenameLowerMatches.length - 3} more`);
          }
        }
        unmatchedFiles.push(localFile);
        continue;
      }
    }

    // No match found at any tier
    unmatchedFiles.push(localFile);
  }

  return { matchedItemIds, unmatchedFiles, matchStats };
}

// =============================================================================
// Action Handlers
// =============================================================================

/**
 * Creates a new Plex collection.
 *
 * Loads config via getLoadedConfig() and builds Plex config with CLI overrides.
 * Resolves library name to section ID via findLibraryByName().
 * If filters provided, queries tracks and adds them to the collection.
 * Warns and aborts if filter returns no matches.
 *
 * @param options - Collection creation options
 * @returns Result with collection metadata and item count
 * @throws Error if Plex configuration is invalid or operation fails
 *
 * @example
 * const result = await executeCollectionCreate({
 *   collectionName: '2020s Rock',
 *   library: 'Music',
 *   genre: 'Rock',
 *   year: '>=2020',
 * });
 */
export async function executeCollectionCreate(
  options: CollectionCreateActionOptions,
): Promise<CollectionResult> {
  const adapter = buildPlexApiConfig(options);
  const targetMediaType = options.type ?? "track";

  // Load named filter if provided
  const namedFilter = options.filter ? loadNamedFilter(options.filter) : undefined;

  // Prevent incompatible explicit mode/filter combinations before any API mutation.
  if (options.type && namedFilter?.type && options.type !== namedFilter.type) {
    throw new Error(
      `Filter "${options.filter}" is typed as "${namedFilter.type}" but create type was "${options.type}". Align --type with the filter type.`,
    );
  }

  // Smart collections are currently only supported for track mode.
  if (options.smart && targetMediaType !== "track") {
    throw new Error(
      `Smart collections are only supported for track type. Received --type ${targetMediaType}.`,
    );
  }

  // Determine library: CLI option takes precedence over filter default
  const libraryName = options.library ?? namedFilter?.library;

  // Library is required for collection creation
  if (!libraryName) {
    throw new Error("Library name is required. Use --library <name> or specify in filter");
  }

  logDebug(
    `Creating collection "${options.collectionName}" in library "${libraryName}" (type=${targetMediaType})`,
  );

  // Resolve library name to section ID
  const library = await adapter.library.byName(libraryName);
  const libraryId = library.id;

  logDebug(`Resolved library "${libraryName}" to ID: ${libraryId}`);

  // Parse filter options from CLI
  const filterOptions = parseFilterOptions(options);

  // Determine if we should query for items (either CLI filters or named filter)
  const hasFilters = filterOptions !== undefined || namedFilter !== undefined;

  // If filters provided, query for items first
  let itemIds: string[] = [];

  if (hasFilters) {
    logInfo("Querying library with filters...");

    if (targetMediaType === "artist") {
      const artists = await queryArtistsWithFilters(
        adapter,
        libraryName,
        filterOptions,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );
      if (artists.length === 0) {
        throw new Error(
          "Filter returned no matching artists. Collection not created to avoid empty collection.",
        );
      }
      itemIds = extractItemIds(artists);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("artist", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    } else if (targetMediaType === "album") {
      const albums = await queryAlbumsWithFilters(
        adapter,
        libraryName,
        filterOptions,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );
      if (albums.length === 0) {
        throw new Error(
          "Filter returned no matching albums. Collection not created to avoid empty collection.",
        );
      }
      itemIds = extractItemIds(albums);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("album", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    } else {
      // Query tracks with pagination and hybrid filtering
      // The queryTracksWithFilters function handles:
      // - Simple server queries when no named filter provided
      // - Hybrid server/client filtering when named filter provided
      const tracks = await queryTracksWithFilters(
        adapter,
        libraryName,
        filterOptions,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );

      if (tracks.length === 0) {
        throw new Error(
          "Filter returned no matching tracks. Collection not created to avoid empty collection.",
        );
      }

      itemIds = extractItemIds(tracks);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("track", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    }
  }

  // Create the collection
  const collection = await adapter.collection.create(libraryId, {
    title: options.collectionName,
    kind: targetMediaType,
  });
  logSuccess(`Created collection "${collection.title}" (key: ${collection.id})`);

  // Add items if we have any from filters
  if (itemIds.length > 0) {
    logInfo(`Adding ${itemIds.length} items to collection...`);

    await adapter.collection.addItems(collection.id, itemIds);

    logSuccess(`Added ${itemIds.length} items to collection`);

    // Fetch updated collection to get accurate child count
    const updatedCollection = await adapter.collection.get(collection.id);

    return {
      collection: projectCollection(updatedCollection),
      itemsAdded: itemIds.length,
      totalItems: updatedCollection.itemCount,
    };
  }

  return {
    collection: projectCollection(collection),
    itemsAdded: 0,
    totalItems: collection.itemCount,
  };
}

/**
 * Adds items to an existing Plex collection.
 *
 * Supports two modes:
 * - **Filter mode**: Query tracks with filters, extract rating keys
 * - **Folder mode**: Match local audio files to Plex tracks by file path
 *
 * @param options - Add options including collection name, library, filters, or folder path
 * @returns Result with items added count
 * @throws Error if collection not found, no items match, or operation fails
 *
 * @example
 * // Filter mode
 * const result = await executeCollectionAdd({
 *   collectionName: 'My Collection',
 *   library: 'Music',
 *   genre: 'Jazz',
 *   rating: '>=4',
 * });
 *
 * @example
 * // Folder mode
 * const result = await executeCollectionAdd({
 *   collectionName: 'Imported Jazz',
 *   library: 'Music',
 *   fromFolder: '/dest/jazz-imports',
 * });
 */
export async function executeCollectionAdd(
  options: CollectionAddActionOptions,
): Promise<CollectionResult> {
  const adapter = buildPlexApiConfig(options);
  const addMode = resolveAddMode(options);

  // We need a library to find the collection
  if (!options.library) {
    throw new Error("Library name is required. Use --library <name>");
  }

  logDebug(
    `Adding items to collection "${options.collectionName}" in library "${options.library}"`,
  );

  // Resolve library
  const library = await adapter.library.byName(options.library);
  const libraryId = library.id;

  // Find collection by name
  const collection = await adapter.collection.byName(libraryId, options.collectionName);
  if (collection.kind !== addMode) {
    throw new Error(
      `Collection "${collection.title}" uses media type "${collection.kind}", but add mode was "${addMode}". Use --mode ${collection.kind}.`,
    );
  }
  if (options.fromFolder && addMode !== "track") {
    throw new Error(
      `--from-folder is only supported for track mode. Collection "${collection.title}" is "${collection.kind}".`,
    );
  }

  logDebug(`Found collection "${collection.title}" with ${collection.itemCount} items`);

  let itemIds: string[] = [];

  if (options.fromFolder) {
    // Folder mode: match local files to Plex tracks using three-tier matching
    logInfo(`Scanning folder: ${options.fromFolder}`);

    // Validate folder exists
    if (!(await pathExists(options.fromFolder))) {
      throw new Error(`Folder not found: ${options.fromFolder}`);
    }

    // Find local audio files using fast-glob (follows symlinks by default)
    const localFiles = await findAudioFiles(options.fromFolder);

    // Edge case: Empty folder
    if (localFiles.length === 0) {
      logWarn(`No audio files found in folder: ${options.fromFolder}`);
      throw new Error(
        `No audio files found in folder. Ensure the folder contains audio files (${[
          "flac",
          "mp3",
          "m4a",
          "ogg",
          "wav",
        ].join(", ")}, etc.)`,
      );
    }

    logInfo(`Found ${localFiles.length} audio files in folder`);

    // Query all tracks in the library to match against
    logInfo("Querying all library tracks for path matching...");
    const serverTracks = await queryTracksWithFilters(
      adapter,
      options.library,
      undefined,
      undefined,
      undefined,
    );
    logDebug(`Loaded ${serverTracks.length} tracks from library for matching`);

    if (serverTracks.length === 0) {
      throw new Error(
        `No tracks found in Plex library "${options.library}". Ensure the library contains music and has been scanned.`,
      );
    }

    // Match local files to Plex tracks using three-tier strategy
    logDebug("Starting path matching with three-tier strategy...");
    const { matchedItemIds, unmatchedFiles, matchStats } = matchLocalFilesToServerTracks(
      localFiles,
      serverTracks,
      options.verbose,
    );

    // Edge case: No matches at all
    if (matchedItemIds.length === 0) {
      logWarn("No files could be matched to Plex tracks");
      logWarn("This may indicate different mount points between local filesystem and Plex server");
      throw new Error(
        `No matches found. ${unmatchedFiles.length} files could not be matched to Plex tracks. ` +
          "Check that the files exist in your Plex library and paths are accessible.",
      );
    }

    itemIds = matchedItemIds;

    // Report matching results with statistics
    logInfo(`Matched ${itemIds.length} of ${localFiles.length} files to Plex tracks`);

    // Log match statistics in verbose mode
    if (
      options.verbose &&
      (matchStats.exact > 0 || matchStats.basename > 0 || matchStats.caseInsensitive > 0)
    ) {
      logDebug("Match statistics:");
      if (matchStats.exact > 0) {
        logDebug(`  Tier 1 (exact path): ${matchStats.exact} files`);
      }
      if (matchStats.basename > 0) {
        logDebug(`  Tier 2 (basename): ${matchStats.basename} files`);
      }
      if (matchStats.caseInsensitive > 0) {
        logDebug(`  Tier 3 (case-insensitive): ${matchStats.caseInsensitive} files`);
      }
    }

    // Edge case: Partial matches - proceed but warn
    if (unmatchedFiles.length > 0) {
      logWarn(`${unmatchedFiles.length} files could not be matched to Plex tracks`);

      // Always show first few unmatched files for debugging (not just in verbose mode)
      const maxToShow = 5;
      const filesToShow = unmatchedFiles.slice(0, maxToShow);
      logWarn("Unmatched files (showing first 5):");
      for (const file of filesToShow) {
        logWarn(`  - ${path.basename(file)}`);
      }
      if (unmatchedFiles.length > maxToShow) {
        logWarn(`  ... and ${unmatchedFiles.length - maxToShow} more`);
      }

      // In verbose mode, show full paths
      if (options.verbose) {
        logDebug("Full paths of unmatched files:");
        for (const file of unmatchedFiles) {
          logDebug(`  ${file}`);
        }
      }
    }
  } else {
    // Filter mode: parse and apply filters with hybrid filtering support
    const filters = parseFilterOptions(options);

    // Load named filter if provided for hybrid server/client filtering
    const namedFilter = options.filter ? loadNamedFilter(options.filter) : undefined;
    if (options.mode && namedFilter?.type && options.mode !== namedFilter.type) {
      throw new Error(
        `Filter "${options.filter}" is typed as "${namedFilter.type}" but add mode was "${options.mode}". Align --mode with the filter type.`,
      );
    }

    if (!filters && !namedFilter) {
      throw new Error(
        "Either --from-folder or filter options (--genre, --year, --min-stars, --filter) required",
      );
    }

    logInfo("Querying library with filters...");

    if (addMode === "artist") {
      const artists = await queryArtistsWithFilters(
        adapter,
        options.library,
        filters,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );

      if (artists.length === 0) {
        throw new Error("Filter returned no matching artists. No items added.");
      }

      itemIds = extractItemIds(artists);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("artist", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    } else if (addMode === "album") {
      const albums = await queryAlbumsWithFilters(
        adapter,
        options.library,
        filters,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );

      if (albums.length === 0) {
        throw new Error("Filter returned no matching albums. No items added.");
      }

      itemIds = extractItemIds(albums);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("album", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    } else {
      // Query tracks with pagination (fetches all matching results)
      // Pass plexFilter for hybrid server/client filtering when named filter is provided
      const tracks = await queryTracksWithFilters(
        adapter,
        options.library,
        filters,
        options.limit ?? namedFilter?.limit,
        namedFilter,
      );

      if (tracks.length === 0) {
        throw new Error("Filter returned no matching tracks. No items added.");
      }

      itemIds = extractItemIds(tracks);
      logInfo(
        `Found ${itemIds.length} ${formatMediaTypeCountLabel("track", itemIds.length)} matching filters${options.limit ? ` (limited to ${options.limit})` : ""}`,
      );
    }
  }

  // Add items to collection
  logInfo(`Adding ${itemIds.length} items to collection "${collection.title}"...`);

  await adapter.collection.addItems(collection.id, itemIds);

  logSuccess(`Added ${itemIds.length} items to collection`);

  // Fetch updated collection to get accurate child count
  const updatedCollection = await adapter.collection.get(collection.id);

  return {
    collection: projectCollection(updatedCollection),
    itemsAdded: itemIds.length,
    totalItems: updatedCollection.itemCount,
  };
}

/**
 * Lists all collections in a Plex library.
 *
 * @param options - List options including library name
 * @returns Array of collections in the library
 * @throws Error if library not found or operation fails
 *
 * @example
 * const collections = await executeCollectionList({ library: 'Music' });
 * console.log(`Found ${collections.length} collections`);
 */
export async function executeCollectionList(
  options: CollectionListActionOptions,
): Promise<PlexCollection[]> {
  const adapter = buildPlexApiConfig(options);

  // Library is required for listing collections
  if (!options.library) {
    throw new Error("Library name is required. Use --library <name>");
  }

  logDebug(`Listing collections in library "${options.library}"`);

  // Resolve library name to section ID
  const library = await adapter.library.byName(options.library);
  const libraryId = library.id;

  logDebug(`Resolved library "${options.library}" to ID: ${libraryId}`);

  // Fetch collections
  const collections = await adapter.collection.list(libraryId);

  logDebug(`Found ${collections.length} collections in library`);

  return collections.map(projectCollection);
}

/**
 * Shows details of a Plex collection.
 *
 * @param options - Show options including collection name and library
 * @returns The collection metadata
 * @throws Error if collection not found or operation fails
 *
 * @example
 * const collection = await executeCollectionShow({
 *   collectionName: 'My Favorites',
 *   library: 'Music',
 * });
 * console.log(`Collection has ${collection.childCount} items`);
 */
export async function executeCollectionShow(
  options: CollectionShowActionOptions,
): Promise<PlexCollection> {
  const adapter = buildPlexApiConfig(options);

  // We need a library to find the collection
  if (!options.library) {
    throw new Error("Library name is required. Use --library <name>");
  }

  logDebug(`Showing collection "${options.collectionName}" from library "${options.library}"`);

  // Resolve library
  const library = await adapter.library.byName(options.library);

  // Find collection by name
  const collection = await adapter.collection.byName(library.id, options.collectionName);

  return projectCollection(collection);
}

/**
 * Deletes a Plex collection.
 *
 * Confirms deletion unless --yes flag is passed.
 *
 * @param options - Delete options including collection name, library, and confirmation flag
 * @throws Error if collection not found, user cancels, or operation fails
 *
 * @example
 * await executeCollectionDelete({
 *   collectionName: 'Old Collection',
 *   library: 'Music',
 *   yes: true,
 * });
 */
export async function executeCollectionDelete(
  options: CollectionDeleteActionOptions,
): Promise<void> {
  const adapter = buildPlexApiConfig(options);

  // We need a library to find the collection
  if (!options.library) {
    throw new Error("Library name is required. Use --library <name>");
  }

  logDebug(`Deleting collection "${options.collectionName}" from library "${options.library}"`);

  // Resolve library
  const library = await adapter.library.byName(options.library);

  // Find collection by name
  const collection = await adapter.collection.byName(library.id, options.collectionName);

  logInfo(`Found collection "${collection.title}" with ${collection.itemCount} items`);

  // Confirm deletion unless --yes flag
  if (!options.yes) {
    const confirmed = await confirm(
      `Are you sure you want to delete collection "${collection.title}"?`,
    );

    if (!confirmed) {
      logInfo("Delete cancelled");
      return;
    }
  }

  // Delete the collection
  await adapter.collection.delete(collection.id);

  logSuccess(`Deleted collection "${collection.title}"`);
}
