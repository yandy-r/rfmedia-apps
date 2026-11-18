import {
  schemaArray,
  schemaBoolean,
  schemaEnum,
  schemaNumber,
  schemaObject,
  schemaOptional,
  schemaString,
  schemaUnion,
  schemaUnknown,
  type McpSchema,
} from "@rfmedia/common";

import type { FilterListResult, FilterShowResult } from "../actions/filter.js";
import type { PlexQueryActionOptions, PlexQueryActionResult } from "../actions/plex-query.js";
import type {
  ConflictContext,
  ConflictResolution,
  ConflictResolutionResult,
  ConflictType,
} from "../types/conflict.js";
import type { SyncResult } from "../types/inventory.js";
import type { CopyRange, PathEntry } from "../types/options.js";
import type { CopyResult, FailedOperation } from "../types/results.js";
import type {
  PlexAlbum,
  PlexAlbumQueryResult,
  PlexArtist,
  PlexArtistQueryResult,
  PlexQueryResult,
  PlexTrack,
} from "../types/plex.js";

export interface FilterListToolArgs {}

export interface FilterShowToolArgs {
  name: string;
}

export type McpConvertFormat = "alac" | "mp3" | "aac" | "opus";

export type McpConflictStrategy = "skip" | "overwrite" | "rename" | "ask";

export interface McpPathEntry {
  path: string;
  range?: CopyRange;
  count?: number;
  filterName?: string;
  outputFolder?: string;
  convertFormat?: McpConvertFormat;
  sourceNames?: string[];
  sourceGroups?: string[];
  sourceArtist?: string;
  sourceIndex?: number;
}

export interface CopyAlbumToolArgs {
  destination?: string;
  source?: string;
  sources?: McpPathEntry[];
  file?: string;
  paths?: string;
  range?: CopyRange;
  configRange?: CopyRange;
  count?: number;
  albumOnly?: boolean;
  hardlink?: boolean;
  convertFormat?: McpConvertFormat;
  force?: boolean;
  conflictStrategy?: McpConflictStrategy;
  dryRun?: boolean;
  workers?: number;
  progress?: boolean;
  trackCompleted?: boolean;
  completedFile?: string;
  resetCompleted?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireDiskSpace?: boolean;
  verify?: boolean;
  verbose?: boolean;
}

export interface CopyFilterToolArgs {
  destination?: string;
  source?: string;
  sources?: McpPathEntry[];
  file?: string;
  paths?: string;
  range?: CopyRange;
  configRange?: CopyRange;
  count?: number;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  preserveStructure?: boolean;
  albumMode?: boolean;
  minDuration?: number;
  maxDuration?: number;
  minBitrate?: number;
  codec?: string;
  minPlays?: number;
  filterName?: string;
  smartFilter?: unknown;
  hardlink?: boolean;
  convertFormat?: McpConvertFormat;
  force?: boolean;
  conflictStrategy?: McpConflictStrategy;
  dryRun?: boolean;
  workers?: number;
  progress?: boolean;
  trackCompleted?: boolean;
  completedFile?: string;
  resetCompleted?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireDiskSpace?: boolean;
  verify?: boolean;
  verbose?: boolean;
}

export interface SyncToolArgs {
  destination: string;
  file?: string;
  sources?: McpPathEntry[];
  mode?: "album" | "filter";
  range?: CopyRange;
  minStars?: number;
  minRating?: number;
  outputFolder?: string;
  preserveStructure?: boolean;
  albumMode?: boolean;
  hardlink?: boolean;
  convertFormat?: McpConvertFormat;
  force?: boolean;
  dryRun?: boolean;
  workers?: number;
  progress?: boolean;
  resetInventory?: boolean;
  deleteDowngraded?: boolean;
  plexScan?: boolean;
  plexUrl?: string;
  plexToken?: string;
  plexLibrary?: string;
  plexPerSource?: boolean;
  trackingDatabase?: string;
  useLegacyTracking?: boolean;
  requireDiskSpace?: boolean;
}

export interface PlexQueryToolArgs extends PlexQueryActionOptions {}

const convertFormatSchema = schemaEnum(["alac", "mp3", "aac", "opus"] as const);

const conflictStrategySchema = schemaEnum(["skip", "overwrite", "rename", "ask"] as const);

const copyRangeSchema = schemaObject({
  start: schemaNumber({ integer: true, minimum: 1 }),
  end: schemaNumber({ integer: true, minimum: 1 }),
  padWidth: schemaNumber({ integer: true, minimum: 1 }),
});

const sourceEntrySchema = schemaObject({
  path: schemaString(),
  range: schemaOptional(copyRangeSchema),
  count: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  filterName: schemaOptional(schemaString()),
  outputFolder: schemaOptional(schemaString()),
  convertFormat: schemaOptional(convertFormatSchema),
  sourceNames: schemaOptional(schemaArray(schemaString())),
  sourceGroups: schemaOptional(schemaArray(schemaString())),
  sourceArtist: schemaOptional(schemaString()),
  sourceIndex: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const failedOperationSchema = schemaObject({
  path: schemaString(),
  message: schemaString(),
  code: schemaOptional(schemaString()),
});

const conflictTypeSchema = schemaUnion([
  schemaObject({
    type: schemaEnum(["exists"] as const),
    destPath: schemaString(),
    destSize: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  }),
  schemaObject({
    type: schemaEnum(["size-mismatch"] as const),
    destPath: schemaString(),
    expected: schemaNumber({ integer: true, minimum: 0 }),
    actual: schemaNumber({ integer: true, minimum: 0 }),
  }),
  schemaObject({
    type: schemaEnum(["extra"] as const),
    destPath: schemaString(),
    size: schemaNumber({ integer: true, minimum: 0 }),
  }),
]);

const conflictContextSchema = schemaObject({
  sourcePath: schemaString(),
  destPath: schemaString(),
  conflictType: conflictTypeSchema,
  sourceSize: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  destSize: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
});

const conflictResolutionSchema = schemaEnum([
  "skip",
  "overwrite",
  "rename",
  "remove",
  "keep",
] as const);

const conflictResolutionResultSchema = schemaObject({
  context: conflictContextSchema,
  resolution: conflictResolutionSchema,
  newPath: schemaOptional(schemaString()),
  success: schemaBoolean(),
  error: schemaOptional(schemaString()),
});

const filterSummarySchema = schemaObject({
  name: schemaString(),
  match: schemaEnum(["all", "any"] as const),
  ruleCount: schemaNumber({ integer: true, minimum: 0 }),
});

const filterListResultSchema = schemaObject({
  filters: schemaArray(filterSummarySchema),
  total: schemaNumber({ integer: true, minimum: 0 }),
});

const filterShowResultSchema = schemaObject({
  name: schemaString(),
  filter: schemaUnknown() as McpSchema<FilterShowResult["filter"]>,
  ruleTree: schemaString(),
});

const copyResultSchema = schemaObject({
  source: schemaString(),
  created: schemaNumber({ integer: true, minimum: 0 }),
  skipped: schemaNumber({ integer: true, minimum: 0 }),
  filtered: schemaNumber({ integer: true, minimum: 0 }),
  failed: schemaArray(failedOperationSchema),
  conflictResolutions: schemaOptional(schemaArray(conflictResolutionResultSchema)),
});

const syncFailedOperationSchema = schemaObject({
  sourcePath: schemaString(),
  destPath: schemaOptional(schemaString()),
  message: schemaString(),
  code: schemaOptional(schemaString()),
});

const syncResultSchema = schemaObject({
  inputFile: schemaString(),
  sourcesScanned: schemaNumber({ integer: true, minimum: 0 }),
  newFilesCopied: schemaNumber({ integer: true, minimum: 0 }),
  updatedFilesCopied: schemaNumber({ integer: true, minimum: 0 }),
  unchangedFilesSkipped: schemaNumber({ integer: true, minimum: 0 }),
  deletedFiles: schemaNumber({ integer: true, minimum: 0 }),
  failedFiles: schemaNumber({ integer: true, minimum: 0 }),
  failed: schemaArray(syncFailedOperationSchema),
});

const plexTrackSchema = schemaObject({
  ratingKey: schemaString(),
  title: schemaString(),
  artist: schemaString(),
  album: schemaString(),
  userRating: schemaNumber({ minimum: 0 }),
  viewCount: schemaNumber({ integer: true, minimum: 0 }),
  duration: schemaNumber({ integer: true, minimum: 0 }),
  year: schemaOptional(schemaNumber({ integer: true })),
  filePath: schemaString(),
  moods: schemaOptional(schemaArray(schemaString())),
});

const plexAlbumSchema = schemaObject({
  ratingKey: schemaString(),
  title: schemaString(),
  artist: schemaString(),
  userRating: schemaNumber({ minimum: 0 }),
  year: schemaOptional(schemaNumber({ integer: true })),
  trackCount: schemaNumber({ integer: true, minimum: 0 }),
  thumb: schemaOptional(schemaString()),
  styles: schemaOptional(schemaArray(schemaString())),
  moods: schemaOptional(schemaArray(schemaString())),
});

const plexArtistSchema = schemaObject({
  ratingKey: schemaString(),
  title: schemaString(),
  userRating: schemaNumber({ minimum: 0 }),
  albumCount: schemaNumber({ integer: true, minimum: 0 }),
  thumb: schemaOptional(schemaString()),
  styles: schemaOptional(schemaArray(schemaString())),
  moods: schemaOptional(schemaArray(schemaString())),
});

const plexTrackResultSchema = schemaObject({
  tracks: schemaArray(plexTrackSchema),
  totalSize: schemaNumber({ integer: true, minimum: 0 }),
  offset: schemaNumber({ integer: true, minimum: 0 }),
  hasMore: schemaBoolean(),
  queryId: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const plexAlbumResultSchema = schemaObject({
  albums: schemaArray(plexAlbumSchema),
  totalSize: schemaNumber({ integer: true, minimum: 0 }),
  offset: schemaNumber({ integer: true, minimum: 0 }),
  hasMore: schemaBoolean(),
  queryId: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const plexArtistResultSchema = schemaObject({
  artists: schemaArray(plexArtistSchema),
  totalSize: schemaNumber({ integer: true, minimum: 0 }),
  offset: schemaNumber({ integer: true, minimum: 0 }),
  hasMore: schemaBoolean(),
  queryId: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
});

const copyAlbumInputSchema = schemaObject({
  destination: schemaOptional(schemaString()),
  source: schemaOptional(schemaString()),
  sources: schemaOptional(schemaArray(sourceEntrySchema)),
  file: schemaOptional(schemaString()),
  paths: schemaOptional(schemaString()),
  range: schemaOptional(copyRangeSchema),
  configRange: schemaOptional(copyRangeSchema),
  count: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  albumOnly: schemaOptional(schemaBoolean()),
  hardlink: schemaOptional(schemaBoolean()),
  convertFormat: schemaOptional(convertFormatSchema),
  force: schemaOptional(schemaBoolean()),
  conflictStrategy: schemaOptional(conflictStrategySchema),
  dryRun: schemaOptional(schemaBoolean()),
  workers: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  progress: schemaOptional(schemaBoolean()),
  trackCompleted: schemaOptional(schemaBoolean()),
  completedFile: schemaOptional(schemaString()),
  resetCompleted: schemaOptional(schemaBoolean()),
  plexScan: schemaOptional(schemaBoolean()),
  plexUrl: schemaOptional(schemaString()),
  plexToken: schemaOptional(schemaString()),
  plexLibrary: schemaOptional(schemaString()),
  plexPerSource: schemaOptional(schemaBoolean()),
  trackingDatabase: schemaOptional(schemaString()),
  useLegacyTracking: schemaOptional(schemaBoolean()),
  requireDiskSpace: schemaOptional(schemaBoolean()),
  verify: schemaOptional(schemaBoolean()),
  verbose: schemaOptional(schemaBoolean()),
});

const copyFilterInputSchema = schemaObject({
  destination: schemaOptional(schemaString()),
  source: schemaOptional(schemaString()),
  sources: schemaOptional(schemaArray(sourceEntrySchema)),
  file: schemaOptional(schemaString()),
  paths: schemaOptional(schemaString()),
  range: schemaOptional(copyRangeSchema),
  configRange: schemaOptional(copyRangeSchema),
  count: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  minStars: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  minRating: schemaOptional(schemaNumber({ integer: true, minimum: 0, maximum: 100 })),
  outputFolder: schemaOptional(schemaString()),
  preserveStructure: schemaOptional(schemaBoolean()),
  albumMode: schemaOptional(schemaBoolean()),
  minDuration: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  maxDuration: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  minBitrate: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  codec: schemaOptional(schemaString()),
  minPlays: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  filterName: schemaOptional(schemaString()),
  smartFilter: schemaOptional(schemaUnknown()),
  hardlink: schemaOptional(schemaBoolean()),
  convertFormat: schemaOptional(convertFormatSchema),
  force: schemaOptional(schemaBoolean()),
  conflictStrategy: schemaOptional(conflictStrategySchema),
  dryRun: schemaOptional(schemaBoolean()),
  workers: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  progress: schemaOptional(schemaBoolean()),
  trackCompleted: schemaOptional(schemaBoolean()),
  completedFile: schemaOptional(schemaString()),
  resetCompleted: schemaOptional(schemaBoolean()),
  plexScan: schemaOptional(schemaBoolean()),
  plexUrl: schemaOptional(schemaString()),
  plexToken: schemaOptional(schemaString()),
  plexLibrary: schemaOptional(schemaString()),
  plexPerSource: schemaOptional(schemaBoolean()),
  trackingDatabase: schemaOptional(schemaString()),
  useLegacyTracking: schemaOptional(schemaBoolean()),
  requireDiskSpace: schemaOptional(schemaBoolean()),
  verify: schemaOptional(schemaBoolean()),
  verbose: schemaOptional(schemaBoolean()),
});

const syncInputSchema = schemaObject({
  destination: schemaString(),
  file: schemaOptional(schemaString()),
  sources: schemaOptional(schemaArray(sourceEntrySchema)),
  mode: schemaOptional(schemaEnum(["album", "filter"] as const)),
  range: schemaOptional(copyRangeSchema),
  minStars: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  minRating: schemaOptional(schemaNumber({ integer: true, minimum: 0, maximum: 100 })),
  outputFolder: schemaOptional(schemaString()),
  preserveStructure: schemaOptional(schemaBoolean()),
  albumMode: schemaOptional(schemaBoolean()),
  hardlink: schemaOptional(schemaBoolean()),
  convertFormat: schemaOptional(convertFormatSchema),
  force: schemaOptional(schemaBoolean()),
  dryRun: schemaOptional(schemaBoolean()),
  workers: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  progress: schemaOptional(schemaBoolean()),
  resetInventory: schemaOptional(schemaBoolean()),
  deleteDowngraded: schemaOptional(schemaBoolean()),
  plexScan: schemaOptional(schemaBoolean()),
  plexUrl: schemaOptional(schemaString()),
  plexToken: schemaOptional(schemaString()),
  plexLibrary: schemaOptional(schemaString()),
  plexPerSource: schemaOptional(schemaBoolean()),
  trackingDatabase: schemaOptional(schemaString()),
  useLegacyTracking: schemaOptional(schemaBoolean()),
  requireDiskSpace: schemaOptional(schemaBoolean()),
});

const plexQueryInputSchema = schemaObject({
  library: schemaOptional(schemaString()),
  type: schemaOptional(schemaEnum(["track", "album", "artist"] as const)),
  minArtistRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  maxArtistRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  minAlbumRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  maxAlbumRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  minTrackRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  maxTrackRating: schemaOptional(schemaNumber({ minimum: 1, maximum: 5 })),
  genre: schemaOptional(schemaString()),
  year: schemaOptional(schemaNumber({ integer: true })),
  minYear: schemaOptional(schemaNumber({ integer: true })),
  maxYear: schemaOptional(schemaNumber({ integer: true })),
  minPlays: schemaOptional(schemaNumber({ integer: true, minimum: 0 })),
  artist: schemaOptional(schemaString()),
  title: schemaOptional(schemaString()),
  album: schemaOptional(schemaString()),
  style: schemaOptional(schemaString()),
  mood: schemaOptional(schemaString()),
  limit: schemaOptional(schemaNumber({ integer: true, minimum: 1 })),
  plexUrl: schemaOptional(schemaString()),
  plexToken: schemaOptional(schemaString()),
  name: schemaOptional(schemaString()),
  noSave: schemaOptional(schemaBoolean()),
  filter: schemaOptional(schemaString()),
});

export interface RfmediaMcpToolSchema<TArgs, TResult> {
  input: McpSchema<TArgs>;
  output: McpSchema<TResult>;
}

export const rfmediaMcpSchemas = {
  filterList: {
    input: schemaObject({}),
    output: filterListResultSchema,
  },
  filterShow: {
    input: schemaObject({
      name: schemaString(),
    }),
    output: filterShowResultSchema,
  },
  copyAlbum: {
    input: copyAlbumInputSchema,
    output: copyResultSchema,
  },
  copyFilter: {
    input: copyFilterInputSchema,
    output: copyResultSchema,
  },
  sync: {
    input: syncInputSchema,
    output: syncResultSchema,
  },
  plexQuery: {
    input: plexQueryInputSchema,
    output: schemaUnion([plexTrackResultSchema, plexAlbumResultSchema, plexArtistResultSchema]),
  },
} as const satisfies {
  filterList: RfmediaMcpToolSchema<FilterListToolArgs, FilterListResult>;
  filterShow: RfmediaMcpToolSchema<FilterShowToolArgs, FilterShowResult>;
  copyAlbum: RfmediaMcpToolSchema<CopyAlbumToolArgs, CopyResult>;
  copyFilter: RfmediaMcpToolSchema<CopyFilterToolArgs, CopyResult>;
  sync: RfmediaMcpToolSchema<SyncToolArgs, SyncResult>;
  plexQuery: RfmediaMcpToolSchema<PlexQueryToolArgs, PlexQueryActionResult>;
};

export const RFMEDIA_MCP_TOOL_NAMES = {
  filterList: "rfmedia.filter.list",
  filterShow: "rfmedia.filter.show",
  copyAlbum: "rfmedia.copy.album",
  copyFilter: "rfmedia.copy.filter",
  sync: "rfmedia.sync",
  plexQuery: "rfmedia.plex.query",
} as const;

const _typeCheck: {
  pathEntry: McpSchema<PathEntry>;
  copyRange: McpSchema<CopyRange>;
  failedOperation: McpSchema<FailedOperation>;
  conflictType: McpSchema<ConflictType>;
  conflictContext: McpSchema<ConflictContext>;
  conflictResolution: McpSchema<ConflictResolution>;
  conflictResolutionResult: McpSchema<ConflictResolutionResult>;
  plexTrack: McpSchema<PlexTrack>;
  plexAlbum: McpSchema<PlexAlbum>;
  plexArtist: McpSchema<PlexArtist>;
  plexTrackResult: McpSchema<PlexQueryResult>;
  plexAlbumResult: McpSchema<PlexAlbumQueryResult>;
  plexArtistResult: McpSchema<PlexArtistQueryResult>;
} = {
  pathEntry: sourceEntrySchema,
  copyRange: copyRangeSchema,
  failedOperation: failedOperationSchema,
  conflictType: conflictTypeSchema,
  conflictContext: conflictContextSchema,
  conflictResolution: conflictResolutionSchema,
  conflictResolutionResult: conflictResolutionResultSchema,
  plexTrack: plexTrackSchema,
  plexAlbum: plexAlbumSchema,
  plexArtist: plexArtistSchema,
  plexTrackResult: plexTrackResultSchema,
  plexAlbumResult: plexAlbumResultSchema,
  plexArtistResult: plexArtistResultSchema,
};

void _typeCheck;
