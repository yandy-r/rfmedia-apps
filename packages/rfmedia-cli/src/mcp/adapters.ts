import { getOutputFormat, normalizeMcpError, setOutputFormat } from "@rfmedia/common";

import { executeAlbumCopyWithFileInput } from "../actions/copy-album.js";
import { executeFilterCopyWithFileInput } from "../actions/copy-filter.js";
import { executeFilterList, executeFilterShow } from "../actions/filter.js";
import { executePlexQuery } from "../actions/plex-query.js";
import { executeSyncWithFileInput } from "../actions/sync.js";
import { requireFfmpeg } from "../lib/convert.js";
import { getLoadedConfig } from "../lib/loaded-config.js";
import { getDefaultWorkers, validateWorkers } from "../lib/parallel.js";
import { loadAndValidatePathsYaml } from "../lib/paths-yaml.js";
import { tryParseRange } from "../lib/range.js";

import type { SmartFilter } from "../types/filters.js";
import type { SyncOptions } from "../types/inventory.js";
import type { CopyRange, CopyOptions, PathEntry, RatingFilter } from "../types/options.js";
import type { PlexAlbum, PlexArtist, PlexTrack } from "../types/plex.js";
import type { CopyResult } from "../types/results.js";
import type { PlexQueryActionResult } from "../actions/plex-query.js";
import type {
  CopyAlbumToolArgs,
  CopyFilterToolArgs,
  FilterListToolArgs,
  FilterShowToolArgs,
  McpConflictStrategy,
  McpPathEntry,
  PlexQueryToolArgs,
  SyncToolArgs,
} from "./schema.js";

const DEFAULT_FILTER_OUTPUT_FOLDER = "liked-songs";

const PLACEHOLDER_RANGE: CopyRange = {
  start: 1,
  end: 1,
  padWidth: 3,
};

export class RfmediaMcpAdapterError extends Error {
  readonly envelope: ReturnType<typeof normalizeMcpError>;

  constructor(error: unknown) {
    const envelope = normalizeMcpError(error);
    super(envelope.message);
    this.name = "RfmediaMcpAdapterError";
    this.envelope = envelope;
  }
}

function validateRange(range: CopyRange | undefined, fieldName: string): CopyRange | undefined {
  if (range === undefined) {
    return undefined;
  }

  if (range.start > range.end) {
    throw new Error(`${fieldName}.start must be less than or equal to ${fieldName}.end`);
  }

  return range;
}

function parseConfigRange(): CopyRange | undefined {
  const configuredRange = getLoadedConfig().copy?.range;
  if (!configuredRange) {
    return undefined;
  }

  const parsed = tryParseRange(configuredRange);
  if (parsed === null) {
    throw new Error(`Invalid copy.range in loaded config: ${configuredRange}`);
  }

  return parsed;
}

function toPathEntries(entries: McpPathEntry[] | undefined): PathEntry[] | undefined {
  if (entries === undefined) {
    return undefined;
  }

  return entries.map((entry) => ({
    path: entry.path,
    range: entry.range,
    count: entry.count,
    filterName: entry.filterName,
    outputFolder: entry.outputFolder,
    convertFormat: entry.convertFormat,
    sourceNames: entry.sourceNames,
    sourceGroups: entry.sourceGroups,
    sourceArtist: entry.sourceArtist,
    sourceIndex: entry.sourceIndex,
  }));
}

function resolveWorkers(
  workers: number | undefined,
  configuredWorkers: number | undefined,
): number {
  return validateWorkers(workers ?? configuredWorkers ?? getDefaultWorkers());
}

function assertConflictStrategy(strategy: McpConflictStrategy | undefined, toolName: string): void {
  if (strategy === "ask") {
    throw new Error(
      `${toolName} does not allow conflictStrategy=ask in MCP mode. Use skip, overwrite, or rename.`,
    );
  }
}

function resolveSmartFilter(
  filterName: string | undefined,
  smartFilter: unknown,
): { resolvedFilterName?: string; resolvedSmartFilter?: SmartFilter } {
  if (filterName !== undefined && smartFilter !== undefined) {
    throw new Error("Provide either filterName or smartFilter, not both");
  }

  if (smartFilter !== undefined) {
    return {
      resolvedSmartFilter: smartFilter as SmartFilter,
    };
  }

  if (filterName === undefined) {
    return {};
  }

  const filters = getLoadedConfig().filters ?? {};
  const resolved = filters[filterName];
  if (!resolved) {
    const names = Object.keys(filters);
    const available = names.length > 0 ? names.join(", ") : "none";
    throw new Error(`Unknown filterName \"${filterName}\". Available filters: ${available}`);
  }

  return {
    resolvedFilterName: filterName,
    resolvedSmartFilter: resolved,
  };
}

function ensureSourceInput(
  source: string | undefined,
  file: string | undefined,
  entries: PathEntry[] | undefined,
  toolName: string,
): void {
  if (!source && !file && (!entries || entries.length === 0)) {
    throw new Error(`${toolName} requires source, file, or sources[]`);
  }
}

function hasPathEntries(entries: PathEntry[] | undefined): boolean {
  return entries !== undefined && entries.length > 0;
}

interface PathResolvableCopyArgs {
  destination?: string;
  source?: string;
  sources?: McpPathEntry[];
  file?: string;
  paths?: string;
  dryRun?: boolean;
}

interface ResolvedCopyInput {
  destination: string;
  source: string | undefined;
  sourceEntries: PathEntry[] | undefined;
  hasYamlFilters: boolean;
  firstYamlFilterName?: string;
}

async function resolveCopyInput(
  args: PathResolvableCopyArgs,
  toolName: string,
): Promise<ResolvedCopyInput> {
  const sourceEntries = toPathEntries(args.sources);

  if (args.paths) {
    if (args.source || args.file || hasPathEntries(sourceEntries)) {
      throw new Error(`${toolName} does not allow paths with source, file, or sources[]`);
    }

    const resolved = await loadAndValidatePathsYaml({
      pathsFile: args.paths,
      dryRun: args.dryRun ?? false,
    });

    if (args.destination !== undefined && args.destination !== resolved.destination) {
      throw new Error(
        `${toolName} destination does not match paths destination (${resolved.destination})`,
      );
    }

    return {
      destination: args.destination ?? resolved.destination,
      source: undefined,
      sourceEntries: resolved.sourceEntries,
      hasYamlFilters: resolved.hasYamlFilters,
      firstYamlFilterName: resolved.firstFilterName,
    };
  }

  if (!args.destination) {
    throw new Error(`${toolName} requires destination when paths is not provided`);
  }

  const source = args.file || hasPathEntries(sourceEntries) ? undefined : args.source;
  ensureSourceInput(source, args.file, sourceEntries, toolName);

  return {
    destination: args.destination,
    source,
    sourceEntries,
    hasYamlFilters: false,
  };
}

async function runAdapter<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
  return withActionExecutionLock(async () => {
    const previousOutputFormat = getOutputFormat();
    setOutputFormat("json");

    try {
      return await execute();
    } catch (error) {
      throw new RfmediaMcpAdapterError(error);
    } finally {
      setOutputFormat(previousOutputFormat);
    }
  });
}

let actionExecutionLock: Promise<void> = Promise.resolve();

async function withActionExecutionLock<TResult>(execute: () => Promise<TResult>): Promise<TResult> {
  const previous = actionExecutionLock;
  let release: (() => void) | undefined;
  actionExecutionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await execute();
  } finally {
    release?.();
  }
}

export async function invokeFilterList(
  _args: FilterListToolArgs,
): Promise<Awaited<ReturnType<typeof executeFilterList>>> {
  return runAdapter(async () => executeFilterList({}));
}

export async function invokeFilterShow(
  args: FilterShowToolArgs,
): Promise<Awaited<ReturnType<typeof executeFilterShow>>> {
  return runAdapter(async () =>
    executeFilterShow({
      name: args.name,
    }),
  );
}

function buildAlbumCopyOptions(args: CopyAlbumToolArgs): CopyOptions {
  const copyConfig = getLoadedConfig().copy ?? {};
  const cliRange = validateRange(args.range, "range");
  const configRange = validateRange(args.configRange, "configRange") ?? parseConfigRange();

  const options: CopyOptions = {
    mode: {
      type: "album",
      range: cliRange ?? configRange ?? PLACEHOLDER_RANGE,
    },
    albumOnly: args.albumOnly ?? copyConfig.albumOnly ?? false,
    hardlink: args.hardlink ?? copyConfig.hardlink ?? false,
    convertFormat: args.convertFormat ?? copyConfig.convertFormat,
    force: args.force ?? copyConfig.force ?? false,
    conflictStrategy: args.conflictStrategy ?? copyConfig.conflictStrategy ?? "skip",
    dryRun: args.dryRun ?? false,
    workers: resolveWorkers(args.workers, copyConfig.workers),
    file: args.file,
    paths: args.paths,
    progress: args.progress ?? copyConfig.progress,
    trackCompleted: args.trackCompleted ?? copyConfig.trackCompleted,
    completedFile: args.completedFile,
    resetCompleted: args.resetCompleted,
    plexScan: args.plexScan,
    plexUrl: args.plexUrl,
    plexToken: args.plexToken,
    plexLibrary: args.plexLibrary,
    plexPerSource: args.plexPerSource,
    trackingDatabase: args.trackingDatabase,
    useLegacyTracking: args.useLegacyTracking,
    requireDiskSpace: args.requireDiskSpace ?? copyConfig.requireDiskSpace,
    verify: args.verify ?? copyConfig.verify ?? false,
    cliRange,
    configRange,
    count: args.count,
    cliSourceEntries: toPathEntries(args.sources),
    verbose: args.verbose,
  };

  assertConflictStrategy(options.conflictStrategy, "rfmedia.copy.album");

  return options;
}

export async function invokeCopyAlbum(args: CopyAlbumToolArgs): Promise<CopyResult> {
  return runAdapter(async () => {
    const resolvedInput = await resolveCopyInput(args, "rfmedia.copy.album");
    const options = buildAlbumCopyOptions(args);
    options.cliSourceEntries = resolvedInput.sourceEntries;

    if (options.convertFormat) {
      await requireFfmpeg();
    }

    return executeAlbumCopyWithFileInput(resolvedInput.source, resolvedInput.destination, options);
  });
}

function buildFilterRating(args: CopyFilterToolArgs): RatingFilter {
  const copyConfig = getLoadedConfig().copy ?? {};
  const smartFilter = resolveSmartFilter(args.filterName, args.smartFilter);

  const rating: RatingFilter = {
    minStars: args.minStars ?? copyConfig.minStars,
    minRating: args.minRating ?? copyConfig.minRating,
    outputFolder: args.outputFolder ?? copyConfig.outputFolder ?? DEFAULT_FILTER_OUTPUT_FOLDER,
    preserveStructure: args.preserveStructure ?? copyConfig.preserveStructure ?? false,
    range: validateRange(args.range, "range"),
    albumMode: args.albumMode ?? copyConfig.albumMode ?? false,
    minDuration: args.minDuration ?? copyConfig.minDuration,
    maxDuration: args.maxDuration ?? copyConfig.maxDuration,
    minBitrate: args.minBitrate ?? copyConfig.minBitrate,
    codec: args.codec ?? copyConfig.codec,
    minPlays: args.minPlays ?? copyConfig.minPlays,
    smartFilter: smartFilter.resolvedSmartFilter,
    filterName: smartFilter.resolvedFilterName,
  };

  if (
    rating.minStars === undefined &&
    rating.minRating === undefined &&
    rating.smartFilter === undefined
  ) {
    throw new Error(
      "rfmedia.copy.filter requires minStars, minRating, filterName, smartFilter, or configured copy defaults",
    );
  }

  return rating;
}

function buildFilterCopyOptions(args: CopyFilterToolArgs): CopyOptions {
  const copyConfig = getLoadedConfig().copy ?? {};
  const cliRange = validateRange(args.range, "range");
  const configRange = validateRange(args.configRange, "configRange") ?? parseConfigRange();

  const options: CopyOptions = {
    mode: {
      type: "filter",
      rating: buildFilterRating(args),
    },
    albumOnly: false,
    hardlink: args.hardlink ?? copyConfig.hardlink ?? false,
    convertFormat: args.convertFormat ?? copyConfig.convertFormat,
    force: args.force ?? copyConfig.force ?? false,
    conflictStrategy: args.conflictStrategy ?? copyConfig.conflictStrategy ?? "skip",
    dryRun: args.dryRun ?? false,
    workers: resolveWorkers(args.workers, copyConfig.workers),
    file: args.file,
    paths: args.paths,
    progress: args.progress ?? copyConfig.progress,
    trackCompleted: args.trackCompleted ?? copyConfig.trackCompleted,
    completedFile: args.completedFile,
    resetCompleted: args.resetCompleted,
    plexScan: args.plexScan,
    plexUrl: args.plexUrl,
    plexToken: args.plexToken,
    plexLibrary: args.plexLibrary,
    plexPerSource: args.plexPerSource,
    trackingDatabase: args.trackingDatabase,
    useLegacyTracking: args.useLegacyTracking,
    requireDiskSpace: args.requireDiskSpace ?? copyConfig.requireDiskSpace,
    verify: args.verify ?? copyConfig.verify ?? false,
    cliRange,
    configRange,
    count: args.count,
    cliSourceEntries: toPathEntries(args.sources),
    verbose: args.verbose,
  };

  assertConflictStrategy(options.conflictStrategy, "rfmedia.copy.filter");

  return options;
}

export async function invokeCopyFilter(args: CopyFilterToolArgs): Promise<CopyResult> {
  return runAdapter(async () => {
    const resolvedInput = await resolveCopyInput(args, "rfmedia.copy.filter");
    const normalizedArgs: CopyFilterToolArgs =
      resolvedInput.hasYamlFilters &&
      args.filterName === undefined &&
      args.smartFilter === undefined &&
      args.minStars === undefined &&
      args.minRating === undefined &&
      resolvedInput.firstYamlFilterName !== undefined
        ? { ...args, filterName: resolvedInput.firstYamlFilterName }
        : args;

    const options = buildFilterCopyOptions(normalizedArgs);
    options.cliSourceEntries = resolvedInput.sourceEntries;

    if (options.convertFormat) {
      await requireFfmpeg();
    }

    return executeFilterCopyWithFileInput(resolvedInput.source, resolvedInput.destination, options);
  });
}

function buildSyncCopyOptions(args: SyncToolArgs): CopyOptions {
  const copyConfig = getLoadedConfig().copy ?? {};
  const sourceEntries = toPathEntries(args.sources);
  const resolvedMinStars = args.minStars ?? copyConfig.minStars;
  const resolvedMinRating = args.minRating ?? copyConfig.minRating;
  const hasFilterCriteria = resolvedMinStars !== undefined || resolvedMinRating !== undefined;
  const validatedRange = validateRange(args.range, "range");
  const filterMode: CopyOptions["mode"] = {
    type: "filter",
    rating: {
      minStars: resolvedMinStars,
      minRating: resolvedMinRating,
      outputFolder: args.outputFolder ?? copyConfig.outputFolder ?? DEFAULT_FILTER_OUTPUT_FOLDER,
      preserveStructure: args.preserveStructure ?? copyConfig.preserveStructure ?? false,
      range: validatedRange,
      albumMode: args.albumMode ?? copyConfig.albumMode ?? false,
    },
  };
  let mode: CopyOptions["mode"];

  if (args.mode === "album") {
    mode = {
      type: "album",
      range:
        validatedRange ??
        (() => {
          throw new Error("rfmedia.sync album mode requires range");
        })(),
    };
  } else if (args.mode === "filter") {
    if (!hasFilterCriteria) {
      throw new Error(
        "rfmedia.sync mode=filter requires minStars or minRating (from args or configured copy defaults)",
      );
    }

    mode = filterMode;
  } else if (hasFilterCriteria) {
    mode = filterMode;
  } else if (validatedRange !== undefined) {
    mode = {
      type: "album",
      range: validatedRange,
    };
  } else {
    throw new Error(
      "rfmedia.sync requires mode=album with range, or filter criteria (minStars/minRating/config defaults)",
    );
  }

  return {
    mode,
    albumOnly: false,
    hardlink: args.hardlink ?? copyConfig.hardlink ?? false,
    convertFormat: args.convertFormat ?? copyConfig.convertFormat,
    force: args.force ?? false,
    dryRun: args.dryRun ?? false,
    workers: resolveWorkers(args.workers, copyConfig.workers),
    file: args.file,
    progress: args.progress ?? copyConfig.progress,
    plexScan: args.plexScan,
    plexUrl: args.plexUrl,
    plexToken: args.plexToken,
    plexLibrary: args.plexLibrary,
    plexPerSource: args.plexPerSource,
    trackingDatabase: args.trackingDatabase,
    useLegacyTracking: args.useLegacyTracking,
    requireDiskSpace: args.requireDiskSpace ?? copyConfig.requireDiskSpace,
    cliSourceEntries: sourceEntries,
  };
}

export async function invokeSync(
  args: SyncToolArgs,
): Promise<Awaited<ReturnType<typeof executeSyncWithFileInput>>> {
  return runAdapter(async () => {
    const copyOptions = buildSyncCopyOptions(args);

    if (
      !copyOptions.file &&
      (!copyOptions.cliSourceEntries || copyOptions.cliSourceEntries.length === 0)
    ) {
      throw new Error("rfmedia.sync requires file or sources[]");
    }

    if (copyOptions.convertFormat) {
      await requireFfmpeg();
    }

    const copyConfig = getLoadedConfig().copy ?? {};
    const syncOptions: SyncOptions = {
      copyOptions,
      dryRun: args.dryRun ?? false,
      force: args.force ?? false,
      resetInventory: args.resetInventory ?? false,
      deleteDowngraded: args.deleteDowngraded ?? copyConfig.deleteDowngraded ?? true,
    };

    return executeSyncWithFileInput(args.destination, syncOptions);
  });
}

export async function invokePlexQuery(args: PlexQueryToolArgs): Promise<PlexQueryActionResult> {
  return runAdapter(async () => projectPlexQueryResult(await executePlexQuery(args)));
}

function projectPlexTrack(track: PlexTrack): PlexTrack {
  return {
    ratingKey: track.ratingKey,
    title: track.title,
    artist: track.artist,
    album: track.album,
    userRating: track.userRating,
    viewCount: track.viewCount,
    duration: track.duration,
    ...(track.year === undefined ? {} : { year: track.year }),
    filePath: track.filePath,
    ...(track.moods === undefined ? {} : { moods: track.moods }),
  };
}

function projectPlexAlbum(album: PlexAlbum): PlexAlbum {
  return {
    ratingKey: album.ratingKey,
    title: album.title,
    artist: album.artist,
    userRating: album.userRating,
    ...(album.year === undefined ? {} : { year: album.year }),
    trackCount: album.trackCount,
    ...(album.thumb === undefined ? {} : { thumb: album.thumb }),
    ...(album.styles === undefined ? {} : { styles: album.styles }),
    ...(album.moods === undefined ? {} : { moods: album.moods }),
  };
}

function projectPlexArtist(artist: PlexArtist): PlexArtist {
  return {
    ratingKey: artist.ratingKey,
    title: artist.title,
    userRating: artist.userRating,
    albumCount: artist.albumCount,
    ...(artist.thumb === undefined ? {} : { thumb: artist.thumb }),
    ...(artist.styles === undefined ? {} : { styles: artist.styles }),
    ...(artist.moods === undefined ? {} : { moods: artist.moods }),
  };
}

function projectPlexQueryResult(result: PlexQueryActionResult): PlexQueryActionResult {
  const pagination = {
    totalSize: result.totalSize,
    offset: result.offset,
    hasMore: result.hasMore,
    ...(result.queryId === undefined ? {} : { queryId: result.queryId }),
  };

  if ("tracks" in result) {
    return {
      tracks: result.tracks.map(projectPlexTrack),
      ...pagination,
    };
  }

  if ("albums" in result) {
    return {
      albums: result.albums.map(projectPlexAlbum),
      ...pagination,
    };
  }

  return {
    artists: result.artists.map(projectPlexArtist),
    ...pagination,
  };
}

export const rfmediaActionAdapters = {
  filterList: invokeFilterList,
  filterShow: invokeFilterShow,
  copyAlbum: invokeCopyAlbum,
  copyFilter: invokeCopyFilter,
  sync: invokeSync,
  plexQuery: invokePlexQuery,
} as const;
