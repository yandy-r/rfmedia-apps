/**
 * Tests for lidarr.ts command layer - status/list/wanted/health subcommands.
 *
 * Verifies the command hierarchy contract, machine/human output parity gate,
 * flag forwarding into the action layer, and error handling (exit code + logError).
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { formatMachineOutput } from "@rfmedia/common";
import { LidarrUnreachableError } from "../lib/lidarr/errors.js";
import { createLidarrScheduler, resolveLidarrSchedulerPolicy } from "../lib/lidarr/scheduler.js";
import {
  LIDARR_PLAN_DEFAULT_MAX_BATCH,
  type LidarrArtistAddLegacyPlanEntryV2,
  type LidarrArtistAddLegacyPlanV2,
  type LidarrCascadeAnalysis,
  type LidarrPlanApplyResult,
  type LidarrTrackFileFilterPlanV3,
} from "../types/lidarr-plan.js";

const LIDARR_COMMAND_NAMES = [
  "status",
  "list",
  "albums",
  "wanted",
  "health",
  "audit",
  "reconcile",
  "policy",
  "sync-ratings",
  "validate-import",
  "discover",
  "search",
  "lookup",
  "presets",
  "plan",
  "apply",
] as const;
const LIDARR_PRESET_COMMAND_NAMES = ["list", "show", "diff", "apply"] as const;
const LIDARR_PRESET_DESCRIPTION = "presets Discover, review, and apply Lidarr quality preset packs";
const LIDARR_POLICY_COMMAND_NAMES = ["evaluate", "plan"] as const;
const LIDARR_POLICY_DESCRIPTION =
  "policy Evaluate Plex consumption signals and review or seal Lidarr plans (never applies)";

// Mock action handlers with vi.hoisted() - must be defined before vi.mock() calls
const mockActions = vi.hoisted(() => ({
  executeLidarrStatus: vi.fn(),
  executeLidarrList: vi.fn(),
  executeLidarrWanted: vi.fn(),
  executeLidarrHealth: vi.fn(),
  executeLidarrReconcile: vi.fn(),
  executeLidarrDiscover: vi.fn(),
  executeLidarrSearch: vi.fn(),
  executeLidarrPlan: vi.fn(),
  executeLidarrAlbumPlan: vi.fn(),
  executeLidarrAlbums: vi.fn(),
  executeLidarrAlbumEditPlan: vi.fn(),
  executeLidarrAlbumDeletePlan: vi.fn(),
  executeLidarrArtistProfilePlan: vi.fn(),
  executeLidarrArtistTagPlan: vi.fn(),
  executeLidarrArtistDeletePlan: vi.fn(),
  executeLidarrTrackFilterPlan: vi.fn(),
  executeLidarrApply: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  outputJson: vi.fn(),
}));

const mockFormatters = vi.hoisted(() => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

const mockPrompt = vi.hoisted(() => ({
  confirm: vi.fn(),
  isInteractive: vi.fn(),
}));

const mockPlanEngine = vi.hoisted(() => ({
  readLidarrPlanArtifact: vi.fn(),
}));

const STATUS_RESULT = {
  version: "2.0.0",
  instanceName: "Lidarr",
  artistCount: 3,
  monitoredCount: 2,
  unmonitoredCount: 1,
  totalSizeOnDisk: 1024,
  trackFileCount: 20,
  trackCount: 30,
  execution: {
    taskId: "lidarr-status",
    operation: "lidarr status",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const LIST_RESULT = {
  artists: [
    {
      id: 1,
      artistName: "Artist One",
      foreignArtistId: "mbid-1",
      monitored: true,
      qualityProfileId: 1,
      tags: [7],
      albumCount: 4,
      sizeOnDisk: 2048,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
  execution: {
    taskId: "lidarr-list",
    operation: "lidarr list",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const WANTED_RESULT = {
  records: [
    {
      albumId: 10,
      title: "Missing Album",
      artistName: "Artist One",
      releaseDate: "2024-01-01",
      monitored: true,
    },
  ],
  page: 1,
  pageSize: 50,
  totalRecords: 1,
  execution: {
    taskId: "lidarr-wanted",
    operation: "lidarr wanted",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const SEARCH_RESULT = {
  query: { mode: "search", term: "Björk" },
  results: [
    {
      kind: "artist",
      foreignId: "87e748f1-300e-46e4-9524-a4a65d68ae24",
      name: "Björk",
      rank: 1,
      lidarrId: 8,
      disambiguation: "Icelandic singer",
      artistType: "Person",
    },
    {
      kind: "album",
      foreignId: "714f3359-4499-432f-a2bd-2a3e179f6c74",
      name: "Debut",
      rank: 2,
      artistName: "Björk",
      artistForeignId: "87e748f1-300e-46e4-9524-a4a65d68ae24",
      albumType: "Album",
      releaseDate: "1993-07-05",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
  returned: 2,
  hasMore: false,
  provider: {
    requested: "lidarr",
    used: "lidarr",
    degraded: false,
  },
  execution: {
    taskId: "lidarr-search",
    operation: "lidarr search",
    lane: "metadata-dependent",
    outcome: "succeeded",
    attempts: 1,
  },
};

const DISCOVER_RESULT = {
  seed: {
    requestedName: "Radiohead",
    resolvedName: "Radiohead",
    autocorrected: false,
  },
  request: { limit: 15, autocorrect: true },
  policy: {
    minSimilarity: 0,
    maxPerSeed: 10,
    deep: false,
    cascade: true,
    maxDepth: 1,
    diversityBoost: 0,
    popularityDampening: 0,
    maxAdd: 1,
  },
  hardBounds: {
    providerLimit: 100,
    maxMinSimilarity: 1,
    maxPerSeed: 100,
    maxDepth: 2,
    maxRequests: 25,
    maxVisitedSeeds: 25,
    maxVisibleCandidates: 100,
    maxScoreWeight: 1,
    maxAdd: 25,
  },
  traversal: {
    seedsRequested: 1,
    requestsMade: 1,
    maximumDepthReached: 1,
    visited: 1,
    visible: 1,
    filtered: 0,
    duplicatePaths: 0,
  },
  recommendations: [
    {
      rank: 1,
      name: "Portishead",
      similarity: 0.91,
      rawSimilarity: 0.91,
      adjustedScore: 0.91,
      musicBrainzId: "11111111-1111-4111-8111-111111111111",
      sourceUrl: "https://www.last.fm/music/Portishead",
      addEligibility: "exact-id",
      status: "quarantined",
      reason: "not-selected",
      exposureCount: 1,
      provenance: {
        seedArtist: "Radiohead",
        parentArtist: "Radiohead",
        depth: 1,
        providerRank: 1,
        firstSeenSequence: 1,
        firstPath: ["Radiohead", "Portishead"],
        discoveredAt: "2026-07-25T12:00:00.000Z",
      },
    },
  ],
  returned: 1,
  source: {
    provider: "lastfm",
    method: "artist.getSimilar",
    attribution: "Recommendations provided by Last.fm",
    url: "https://www.last.fm/",
    fetchedAt: "2026-07-25T12:00:00.000Z",
  },
  execution: {
    taskId: "lidarr-discover",
    operation: "lidarr discover",
    lane: "discovery",
    outcome: "succeeded",
    attempts: 1,
  },
  handoff: {
    status: "not-requested",
    approvals: [],
    counts: { approved: 0, alreadyPresent: 0, planned: 0, failed: 0 },
  },
};

/** Healthy resilience snapshot — both circuits closed, empty intent queue. */
const HEALTHY_RESILIENCE = {
  circuits: [
    { scope: "lidarr", state: { state: "closed", recentFailures: [] } },
    { scope: "metadata", state: { state: "closed", recentFailures: [] } },
  ],
  deferredIntents: { pending: 0, failed: 0 },
};

/** Degraded snapshot — lidarr circuit open plus pending/failed intents. */
const DEGRADED_RESILIENCE = {
  circuits: [
    {
      scope: "lidarr",
      state: {
        state: "open",
        openedAt: "2026-07-22T14:31:09.000Z",
        cooldownMs: 60_000,
        reason: "lidarr-unreachable",
      },
      retryAtIso: "2026-07-22T14:32:09.000Z",
    },
    { scope: "metadata", state: { state: "closed", recentFailures: [] } },
  ],
  deferredIntents: { pending: 2, failed: 1 },
};

const HEALTH_RESULT = {
  checks: [{ source: "IndexerStatusCheck", type: "warning", message: "An indexer is unavailable" }],
  hasErrors: false,
  metadataProvider: { available: true, failingChecks: [] },
  resilience: HEALTHY_RESILIENCE,
  execution: {
    taskId: "lidarr-health",
    operation: "lidarr health",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const PLAN_RESULT = {
  planPath: "/tmp/lidarr-plan.json",
  plan: {
    version: "rfmedia.lidarr-plan.v1",
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-22T12:00:00.000Z",
    createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
    command: "lidarr",
    target: { origin: "https://lidarr.example.test" },
    operation: { kind: "artist-monitoring", desiredMonitored: false },
    maxBatch: 25,
    entries: [
      {
        id: "artist:3",
        artistId: 3,
        artistName: "Three",
        before: { monitored: true },
        after: { monitored: false },
        idempotencyKey: `sha256:${"a".repeat(64)}`,
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    risk: {
      level: "low",
      destructive: false,
      cascade: ["Existing files remain unchanged."],
    },
    payloadChecksum: `sha256:${"b".repeat(64)}`,
  },
};

const CASCADE_ANALYSIS = {
  modelVersion: "rfmedia.lidarr-cascade.v1",
  assumptions: {
    albumsPerArtist: null,
    indexerQueriesPerCandidate: 2,
  },
  metrics: {
    immediateIndexerQueries: {
      value: 0,
      certainty: "exact",
      horizon: "none",
      unit: "indexer-queries",
      basis: "current-operation-no-search",
    },
    acquisitionCandidates: {
      value: 1,
      certainty: "exact",
      horizon: "conditional",
      unit: "acquisition-candidates",
      basis: "monitored-album-file-removal",
    },
    conditionalIndexerQueries: {
      value: 2,
      certainty: "modelled",
      horizon: "conditional",
      unit: "indexer-queries",
      basis: "configured-indexer-queries-per-candidate",
    },
    newlyMonitored: {
      value: 0,
      certainty: "exact",
      horizon: "none",
      unit: "albums",
      basis: "changed-entries",
    },
    filesAffected: {
      value: 1,
      certainty: "exact",
      horizon: "immediate",
      unit: "files",
      basis: "track-file-delete-candidates",
    },
    bytesAffected: {
      value: 1_024,
      certainty: "exact",
      horizon: "immediate",
      unit: "bytes",
      basis: "affected-file-bytes",
    },
  },
  budgets: {
    indexerQueries: {
      status: "exceeded",
      limit: 1,
      projected: 2,
      provenance: "configured-per-plan",
    },
    acquisitionCandidates: {
      status: "within",
      limit: 1,
      projected: 1,
      provenance: "configured-per-plan",
    },
  },
  warnings: [
    {
      code: "indexer-query-budget-exceeded",
      metric: "indexerQueries",
      projected: 2,
      limit: 1,
      overBy: 1,
    },
  ],
  recommendations: ["reduce-scope", "split-into-batches"],
} satisfies LidarrCascadeAnalysis;

const NOT_RECORDED_CASCADE_CSV = {
  "result.cascade.status": "not-recorded",
  "result.cascade.modelVersion": "",
  "result.cascade.immediateIndexerQueries": "",
  "result.cascade.acquisitionCandidates": "",
  "result.cascade.conditionalIndexerQueries": "",
  "result.cascade.newlyMonitored": "",
  "result.cascade.filesAffected": "",
  "result.cascade.bytesAffected": "",
  "result.cascade.indexerQueriesBudgetStatus": "",
  "result.cascade.indexerQueriesBudgetLimit": "",
  "result.cascade.indexerQueriesBudgetProjected": "",
  "result.cascade.acquisitionCandidatesBudgetStatus": "",
  "result.cascade.acquisitionCandidatesBudgetLimit": "",
  "result.cascade.acquisitionCandidatesBudgetProjected": "",
  "result.cascade.highestWarningSeverity": "",
  "result.cascade.highestWarningCode": "",
  "result.cascade.warnings": "",
  "result.cascade.recommendations": "",
};

const RECORDED_CASCADE_CSV = {
  "result.cascade.status": "recorded",
  "result.cascade.modelVersion": CASCADE_ANALYSIS.modelVersion,
  "result.cascade.immediateIndexerQueries": CASCADE_ANALYSIS.metrics.immediateIndexerQueries.value,
  "result.cascade.acquisitionCandidates": CASCADE_ANALYSIS.metrics.acquisitionCandidates.value,
  "result.cascade.conditionalIndexerQueries":
    CASCADE_ANALYSIS.metrics.conditionalIndexerQueries.value,
  "result.cascade.newlyMonitored": CASCADE_ANALYSIS.metrics.newlyMonitored.value,
  "result.cascade.filesAffected": CASCADE_ANALYSIS.metrics.filesAffected.value,
  "result.cascade.bytesAffected": CASCADE_ANALYSIS.metrics.bytesAffected.value,
  "result.cascade.indexerQueriesBudgetStatus": CASCADE_ANALYSIS.budgets.indexerQueries.status,
  "result.cascade.indexerQueriesBudgetLimit": CASCADE_ANALYSIS.budgets.indexerQueries.limit,
  "result.cascade.indexerQueriesBudgetProjected": CASCADE_ANALYSIS.budgets.indexerQueries.projected,
  "result.cascade.acquisitionCandidatesBudgetStatus":
    CASCADE_ANALYSIS.budgets.acquisitionCandidates.status,
  "result.cascade.acquisitionCandidatesBudgetLimit":
    CASCADE_ANALYSIS.budgets.acquisitionCandidates.limit,
  "result.cascade.acquisitionCandidatesBudgetProjected":
    CASCADE_ANALYSIS.budgets.acquisitionCandidates.projected,
  "result.cascade.highestWarningSeverity": "warning",
  "result.cascade.highestWarningCode": "indexer-query-budget-exceeded",
  "result.cascade.warnings": JSON.stringify(CASCADE_ANALYSIS.warnings),
  "result.cascade.recommendations": JSON.stringify(CASCADE_ANALYSIS.recommendations),
};

const ALBUM_PLAN_RESULT = {
  status: "planned",
  planPath: "/tmp/lidarr-album-plan.json",
  plan: {
    version: "rfmedia.lidarr-plan.v1",
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-07-22T12:00:00.000Z",
    createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
    command: "lidarr",
    target: { origin: "https://lidarr.example.test" },
    operation: {
      kind: "album-monitoring",
      desiredMonitored: false,
      selectors: ["eps", "singles"],
    },
    maxBatch: 25,
    entries: [
      {
        id: "album:11",
        albumId: 11,
        albumTitle: "Single One",
        artistId: 3,
        artistName: "Three",
        albumType: "Single",
        before: { monitored: true },
        after: { monitored: false },
        idempotencyKey: `sha256:${"c".repeat(64)}`,
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    risk: {
      level: "low",
      destructive: false,
      cascade: ["Album files remain on disk."],
    },
    payloadChecksum: `sha256:${"d".repeat(64)}`,
  },
  selection: {
    artistsScanned: 1,
    albumsScanned: 4,
    matched: 2,
    alreadyInDesiredState: 1,
    planned: 1,
    bySelector: { eps: 1, singles: 1 },
  },
  execution: {
    taskId: "lidarr-plan-album-monitoring",
    operation: "lidarr plan album monitoring",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const APPLY_RESULT = {
  planId: PLAN_RESULT.plan.id,
  planChecksum: PLAN_RESULT.plan.payloadChecksum,
  planPath: PLAN_RESULT.planPath,
  risk: PLAN_RESULT.plan.risk,
  status: "completed",
  dryRun: false,
  resumed: false,
  cascadeAnalysis: { status: "not-recorded" as const },
  summary: {
    total: 1,
    succeeded: 1,
    satisfied: 0,
    failed: 0,
    deferred: 0,
    uncertain: 0,
    skippedResume: 0,
    wouldApply: 0,
    blockedStale: 0,
    notAttempted: 0,
  },
  entries: [
    {
      entryId: "artist:3",
      artistId: 3,
      artistName: "Three",
      outcome: "succeeded",
    },
  ],
  execution: {
    taskId: "apply",
    operation: "lidarr apply",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const ALBUM_APPLY_RESULT = {
  planId: ALBUM_PLAN_RESULT.plan.id,
  planChecksum: ALBUM_PLAN_RESULT.plan.payloadChecksum,
  planPath: ALBUM_PLAN_RESULT.planPath,
  risk: ALBUM_PLAN_RESULT.plan.risk,
  status: "completed",
  dryRun: false,
  resumed: false,
  cascadeAnalysis: { status: "not-recorded" as const },
  summary: {
    total: 1,
    succeeded: 1,
    satisfied: 0,
    failed: 0,
    deferred: 0,
    uncertain: 0,
    skippedResume: 0,
    wouldApply: 0,
    blockedStale: 0,
    notAttempted: 0,
  },
  entries: [
    {
      entryId: "album:11",
      albumId: 11,
      albumTitle: "Single One",
      artistId: 3,
      artistName: "Three",
      outcome: "succeeded",
    },
  ],
  execution: {
    taskId: "apply",
    operation: "lidarr apply",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const APPLY_CHECK_RESULT = {
  ...APPLY_RESULT,
  status: "checked",
  dryRun: true,
  summary: {
    ...APPLY_RESULT.summary,
    succeeded: 0,
    wouldApply: 1,
  },
  entries: [
    {
      ...APPLY_RESULT.entries[0],
      outcome: "would-apply",
    },
  ],
};

const PROFILE_PLAN_RESULT = {
  planPath: "/tmp/lidarr-profile-plan.json",
  plan: {
    version: "rfmedia.lidarr-plan.v2",
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-07-23T12:00:00.000Z",
    createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
    command: "lidarr",
    target: { origin: "https://lidarr.example.test" },
    selection: { kind: "all" },
    operation: {
      kind: "artist-profile-assignment",
      qualityProfile: { id: 4, name: "Lossless" },
      metadataProfile: { id: 6, name: "Standard" },
    },
    maxBatch: 25,
    entries: [
      {
        id: "artist-profile:3",
        artistId: 3,
        artistName: "Three",
        before: {
          qualityProfile: { id: 1, name: "Default" },
          metadataProfile: { id: 2, name: "Minimal" },
        },
        after: {
          qualityProfile: { id: 4, name: "Lossless" },
          metadataProfile: { id: 6, name: "Standard" },
        },
        idempotencyKey: `sha256:${"c".repeat(64)}`,
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: {
      kind: "artist-profile-assignment",
      qualityProfileChanged: 1,
      metadataProfileChanged: 1,
    },
    risk: {
      level: "medium",
      destructive: false,
      cascade: ["Future acquisition policy may change."],
    },
    payloadChecksum: `sha256:${"d".repeat(64)}`,
  },
};

const RECORDED_APPLY_RESULT = {
  ...APPLY_RESULT,
  cascadeAnalysis: { status: "recorded" as const, analysis: CASCADE_ANALYSIS },
};

const TAG_PLAN_RESULT = {
  planPath: "/tmp/lidarr-tag-plan.json",
  plan: {
    version: "rfmedia.lidarr-plan.v2",
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-07-23T12:00:00.000Z",
    createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
    command: "lidarr",
    target: { origin: "https://lidarr.example.test" },
    selection: { kind: "ids", artistIds: [3] },
    operation: {
      kind: "artist-tag-mutation",
      mode: "set",
      tags: [{ id: 9, label: "Lossless" }],
    },
    maxBatch: 25,
    entries: [
      {
        id: "artist-tag:3",
        artistId: 3,
        artistName: "Three",
        before: { tags: [{ id: 7, label: "Favorite" }] },
        after: { tags: [{ id: 9, label: "Lossless" }] },
        added: [{ id: 9, label: "Lossless" }],
        removed: [{ id: 7, label: "Favorite" }],
        retained: [],
        idempotencyKey: `sha256:${"e".repeat(64)}`,
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: { kind: "artist-tag-mutation", added: 1, removed: 1, retained: 0 },
    risk: {
      level: "high",
      destructive: true,
      cascade: ["Existing tag assignments will be removed."],
    },
    payloadChecksum: `sha256:${"f".repeat(64)}`,
  },
};

/**
 * Sealed-shaped album-delete plan fixtures for the command-layer authorization
 * matrix. `readLidarrPlanArtifact` is mocked, so a plain object matching the v2
 * delete shape suffices — the T8 builder cannot run in this file because it
 * seals through the plan-engine module that this suite mocks. The command layer
 * only inspects `operation.kind`/`operation.deleteFiles` (plus id/checksum).
 */
const ALBUM_DELETE_PLAN = {
  version: "rfmedia.lidarr-plan.v2",
  id: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-07-24T12:00:00.000Z",
  createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
  command: "lidarr",
  target: { origin: "https://lidarr.example.test" },
  selection: { kind: "album-ids", albumIds: [9] },
  operation: {
    kind: "album-delete",
    deleteFiles: false,
    addImportListExclusion: false,
    includeMonitored: false,
    selectors: [],
  },
  maxBatch: 25,
  entries: [
    {
      id: "album:9",
      albumId: 9,
      albumTitle: "Nine",
      artistId: 3,
      artistName: "Three",
      foreignAlbumId: "mbid-9",
      before: { monitored: false, trackFileCount: 10, sizeOnDisk: 1024 },
      after: { deleted: true },
      idempotencyKey: `sha256:${"9".repeat(64)}`,
    },
  ],
  review: { requested: 1, changed: 1, unchanged: 0 },
  summary: {
    kind: "album-delete",
    albums: 1,
    withFiles: 1,
    totalTrackFiles: 10,
    totalSizeOnDisk: 1024,
    deleteFiles: false,
    importListExclusions: false,
  },
  risk: {
    level: "high",
    destructive: true,
    cascade: ["1 album removed from the Lidarr library."],
  },
  payloadChecksum: `sha256:${"e".repeat(64)}`,
};

/** Variant that permanently deletes files — requires the second authorization key. */
const ALBUM_DELETE_FILES_PLAN = {
  ...ALBUM_DELETE_PLAN,
  id: "55555555-5555-4555-8555-555555555555",
  operation: { ...ALBUM_DELETE_PLAN.operation, deleteFiles: true },
  summary: { ...ALBUM_DELETE_PLAN.summary, deleteFiles: true },
  payloadChecksum: `sha256:${"f".repeat(64)}`,
};

const TRACK_FILTER_PLAN = {
  version: "rfmedia.lidarr-plan.v3",
  id: "21621621-6216-4216-8216-216216216216",
  createdAt: "2026-07-25T12:00:00.000Z",
  createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
  command: "lidarr",
  target: { origin: "https://lidarr.example.test" },
  selection: { kind: "album-track-filter", albumId: 9 },
  operation: {
    kind: "track-file-filter",
    explicitKeepTrackIds: [91],
    minStars: 3,
  },
  maxBatch: 100,
  entries: [
    {
      id: "album:9:track-file-filter",
      albumId: 9,
      albumTitle: "Nine",
      artistId: 3,
      artistName: "Three",
      before: {
        albumMonitored: true,
        deleteCandidates: [
          {
            trackId: 92,
            trackTitle: "Delete",
            trackFileId: 902,
            path: "/music/nine/02.flac",
            size: 1_024,
            rating: 0.2,
          },
        ],
      },
      after: { deletedTrackFileIds: [902] },
      keptTrackIds: [91],
      warnings: [],
      idempotencyKey: `sha256:${"d".repeat(64)}`,
    },
  ],
  review: { requested: 1, changed: 1, unchanged: 0 },
  summary: {
    kind: "track-file-filter",
    tracks: 2,
    kept: 1,
    deleteCandidates: 1,
    warnings: 0,
    totalDeleteBytes: 1_024,
  },
  risk: {
    level: "high",
    destructive: true,
    cascade: ["Lidarr deletes the exact managed trackfiles from disk."],
  },
  cascadeAnalysis: CASCADE_ANALYSIS,
  payloadChecksum: `sha256:${"c".repeat(64)}`,
} satisfies LidarrTrackFileFilterPlanV3;

const TRACK_FILTER_PREVIEW_RESULT = {
  status: "previewed",
  plan: TRACK_FILTER_PLAN,
  selection: {
    tracks: 2,
    trackFiles: 2,
    kept: 1,
    deleteCandidates: 1,
    warnings: [],
    totalDeleteBytes: 1_024,
  },
  execution: {
    taskId: "track-filter",
    operation: "lidarr plan track filter",
    lane: "local-only",
    outcome: "succeeded",
    attempts: 1,
  },
};

const ARTIST_DELETE_PLAN_RESULT = {
  planPath: "/tmp/lidarr-artist-delete-plan.json",
  plan: {
    version: "rfmedia.lidarr-plan.v2",
    id: "44444444-4444-4444-8444-444444444444",
    createdAt: "2026-07-24T12:00:00.000Z",
    createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
    command: "lidarr",
    target: { origin: "https://lidarr.example.test" },
    selection: { kind: "ids", artistIds: [3] },
    operation: { kind: "artist-delete", deleteFiles: true },
    maxBatch: 25,
    entries: [
      {
        id: "artist-delete:3",
        artistId: 3,
        artistName: "Three",
        before: {
          path: "/music/Three",
          albumCount: 4,
          trackFileCount: 20,
          sizeOnDisk: 2048,
        },
        after: { exists: false },
        idempotencyKey: `sha256:${"1".repeat(64)}`,
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: {
      kind: "artist-delete",
      artists: 1,
      albums: 4,
      trackFiles: 20,
      sizeOnDisk: 2048,
    },
    risk: {
      level: "high",
      destructive: true,
      cascade: ["Artist and album records will be permanently deleted."],
    },
    payloadChecksum: `sha256:${"2".repeat(64)}`,
  },
};

const ARTIST_DELETE_APPLY_RESULT = {
  ...APPLY_RESULT,
  planId: ARTIST_DELETE_PLAN_RESULT.plan.id,
  planChecksum: ARTIST_DELETE_PLAN_RESULT.plan.payloadChecksum,
  planPath: ARTIST_DELETE_PLAN_RESULT.planPath,
  risk: ARTIST_DELETE_PLAN_RESULT.plan.risk,
  entries: [
    {
      entryId: "artist-delete:3",
      artistId: 3,
      artistName: "Three",
      outcome: "succeeded",
      before: {
        kind: "artist-delete",
        exists: true,
        evidence: ARTIST_DELETE_PLAN_RESULT.plan.entries[0]!.before,
      },
      after: { kind: "artist-delete", exists: false },
      observed: { kind: "artist-delete", exists: false },
    },
  ],
  scan: {
    requested: true,
    attempted: true,
    status: "failed",
    message: "Media-server scan failed; deletion results are unchanged.",
  },
};

/** Cache provenance attached by the actions when a stale projection served. */
const STALE_CACHE_STATUS = {
  source: "stale-cache",
  fetchedAt: "2026-07-22T13:00:00.000Z",
  ageSeconds: 720,
};

/**
 * Builds an error shaped like the LidarrError taxonomy (structural fields
 * only — the command layer duck-types `code`/`retryAfterSeconds`).
 */
function createLidarrErrorLike(message: string, code: string, retryAfterSeconds?: number): Error {
  return Object.assign(new Error(message), { code, retryAfterSeconds });
}

/** Creates an error carrying the scheduler's private execution metadata. */
async function createScheduledFailure(): Promise<unknown> {
  const scheduler = createLidarrScheduler(
    resolveLidarrSchedulerPolicy({
      lanes: { "local-only": { retryAttempts: 0 } },
    }),
  );
  const error = new LidarrUnreachableError("lidarr status", "Lidarr is unreachable");
  try {
    await scheduler.runSingle("local-only", {
      id: "lidarr-status",
      operation: "lidarr status",
      idempotent: true,
      run: () => Promise.reject(error),
    });
  } catch (scheduledError) {
    return scheduledError;
  }
  throw new Error("Expected scheduler failure");
}

// Apply mocks BEFORE importing the module under test
vi.mock("../actions/lidarr/index.js", () => mockActions);
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/formatters/index.js", () => mockFormatters);
vi.mock("../lib/prompt.js", () => mockPrompt);
vi.mock("../lib/lidarr/plan-engine.js", () => mockPlanEngine);

// Import after mocks - we need to import the lidarrCommand
import { lidarrCommand } from "./lidarr.js";
import { renderMutationApply, renderMutationPlan } from "./lidarr-mutation-presenter.js";

describe("lidarr commands", () => {
  let rootCommand: Command;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks(); // NOT resetAllMocks!

    // Re-establish default action resolutions after clearAllMocks
    mockActions.executeLidarrStatus.mockResolvedValue(STATUS_RESULT);
    mockActions.executeLidarrList.mockResolvedValue(LIST_RESULT);
    mockActions.executeLidarrWanted.mockResolvedValue(WANTED_RESULT);
    mockActions.executeLidarrHealth.mockResolvedValue(HEALTH_RESULT);
    mockActions.executeLidarrDiscover.mockResolvedValue(DISCOVER_RESULT);
    mockActions.executeLidarrSearch.mockResolvedValue(SEARCH_RESULT);
    mockActions.executeLidarrPlan.mockResolvedValue(PLAN_RESULT);
    mockActions.executeLidarrAlbumPlan.mockResolvedValue(ALBUM_PLAN_RESULT);
    mockActions.executeLidarrArtistProfilePlan.mockResolvedValue(PROFILE_PLAN_RESULT);
    mockActions.executeLidarrArtistTagPlan.mockResolvedValue(TAG_PLAN_RESULT);
    mockActions.executeLidarrArtistDeletePlan.mockResolvedValue(ARTIST_DELETE_PLAN_RESULT);
    mockActions.executeLidarrTrackFilterPlan.mockResolvedValue(TRACK_FILTER_PREVIEW_RESULT);
    mockActions.executeLidarrApply.mockResolvedValue(APPLY_RESULT);
    mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(PLAN_RESULT.plan);
    mockFormatters.formatOutput.mockResolvedValue(undefined);
    mockPrompt.confirm.mockResolvedValue(true);
    mockPrompt.isInteractive.mockReturnValue(false);

    // Suppress human table rendering (goes to stderr via console.error)
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Guard the machine-only stdout contract (formatOutput is mocked, so
    // nothing may write to stdout directly).
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Create a root command to attach the lidarr command to (for global options)
    rootCommand = new Command("rfmedia");
    rootCommand.option("--json", "Output in JSON format");
    rootCommand.option("--output <format>", "Output format (json, yaml, csv, table, text)");
    rootCommand.option("--debug", "Enable debug output");

    // Mirror cli.ts's preAction reconciliation of --json into the resolved
    // --output format, so bare --json exercises the same parity gate.
    rootCommand.hook("preAction", () => {
      const opts = rootCommand.opts();
      if (opts["json"] && rootCommand.getOptionValueSource("output") !== "cli") {
        rootCommand.setOptionValue("output", "json");
      }
    });

    rootCommand.addCommand(lidarrCommand);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  /** Joins every stderr line captured by the console.error spy. */
  function capturedStderr(): string {
    return consoleErrorSpy.mock.calls
      .map((call: readonly unknown[]) => call.map(String).join(" "))
      .join("\n");
  }

  function declaredConflicts(option: unknown): readonly string[] {
    if (
      typeof option !== "object" ||
      option === null ||
      !("conflictsWith" in option) ||
      !Array.isArray(option.conflictsWith) ||
      !option.conflictsWith.every((value: unknown) => typeof value === "string")
    ) {
      return [];
    }
    return option.conflictsWith;
  }

  describe("command contract", () => {
    it("keeps the lidarr command hierarchy stable", () => {
      expect(lidarrCommand.commands.map((command) => command.name())).toEqual(LIDARR_COMMAND_NAMES);
      const lookup = lidarrCommand.commands.find((command) => command.name() === "lookup");
      expect(lookup?.commands.map((command) => command.name())).toEqual(["artist", "album"]);
      const plan = lidarrCommand.commands.find((command) => command.name() === "plan");
      expect(plan?.commands.map((command) => command.name())).toEqual([
        "artist-monitoring",
        "album-monitoring",
        "artist-profiles",
        "artist-tags",
        "album-edit",
        "album-delete",
        "artist-delete",
        "track-filter",
      ]);
      const policy = lidarrCommand.commands.find((command) => command.name() === "policy");
      expect(policy?.commands.map((command) => command.name())).toEqual(
        LIDARR_POLICY_COMMAND_NAMES,
      );
      expect(lidarrCommand.helpInformation().replaceAll(/\s+/gu, " ")).toContain(
        LIDARR_POLICY_DESCRIPTION,
      );
    });

    it("exposes only the bounded discovery and conditional add-plan grammar", () => {
      const discover = lidarrCommand.commands.find((command) => command.name() === "discover");
      const optionLongs = discover?.options.map((option) => option.long);

      expect(optionLongs).toEqual([
        "--artist",
        "--limit",
        "--no-autocorrect",
        "--min-similarity",
        "--max-per-seed",
        "--deep",
        "--no-cascade",
        "--diversity-boost",
        "--popularity-dampening",
        "--max-add",
        "--add",
        "--root-folder",
        "--quality-profile",
        "--metadata-profile",
        "--monitored",
        "--unmonitor-types",
        "--plan-file",
        "--lidarr-url",
        "--lidarr-api-key",
      ]);
      expect(optionLongs).not.toEqual(
        expect.arrayContaining([
          "--yes",
          "--dry-run",
          "--allow-stale",
          "--source",
          "--lastfm-api-key",
        ]),
      );
    });

    it("attaches the preset namespace and exposes its public hierarchy in parent help", () => {
      const presets = lidarrCommand.commands.find((command) => command.name() === "presets");

      expect(presets?.parent).toBe(lidarrCommand);
      const presetCommandNames = presets?.commands.map((command) => command.name());
      expect(presetCommandNames).toEqual(LIDARR_PRESET_COMMAND_NAMES);

      const lidarrHelp = lidarrCommand.helpInformation().replaceAll(/\s+/gu, " ");
      const presetsHelp = (presets?.helpInformation() ?? "").replaceAll(/\s+/gu, " ");
      expect(lidarrHelp).toContain(LIDARR_PRESET_DESCRIPTION);
      expect(presetsHelp).toContain("Usage: rfmedia lidarr presets [options] [command]");
      expect(presetsHelp).toContain("list");
      expect(presetsHelp).toContain("show <pack-ref>");
      expect(presetsHelp).toContain("diff [options] <pack-ref>");
      expect(presetsHelp).toContain("apply [options] <pack-ref>");
    });

    it("attaches reconcile with its exact leaf options and side-effect-free help", () => {
      const reconcile = lidarrCommand.commands.find((command) => command.name() === "reconcile");

      expect(reconcile?.parent).toBe(lidarrCommand);
      expect(reconcile?.options.map((option) => option.long)).toEqual([
        "--plex-library",
        "--plex-library-id",
        "--offline",
        "--duplicates",
        "--verbose",
        "--plex-url",
        "--plex-token",
        "--lidarr-url",
        "--lidarr-api-key",
      ]);
      expect(reconcile?.helpInformation()).toContain("Usage: rfmedia lidarr reconcile [options]");
      expect(mockActions.executeLidarrReconcile).not.toHaveBeenCalled();
    });

    it("preserves the root output format for reconcile failures", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "--output", "yaml", "lidarr", "reconcile"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "yaml",
        expect.objectContaining({ command: "lidarr-reconcile" }),
      );
      expect(mockActions.executeLidarrReconcile).not.toHaveBeenCalled();
    });

    it.each(["artist-profiles", "artist-tags", "artist-delete"])(
      "groups %s help without contacting Lidarr",
      (leafName) => {
        const plan = lidarrCommand.commands.find((command) => command.name() === "plan");
        const leaf = plan?.commands.find((command) => command.name() === leafName);
        const help = leaf?.helpInformation() ?? "";

        expect(help).toContain("Selection:");
        expect(help).toContain("Desired changes:");
        expect(help).toContain("Safety:");
        expect(help).toContain("Connection:");
        expect(help).toContain("Output:");
        expect(mockActions.executeLidarrArtistProfilePlan).not.toHaveBeenCalled();
        expect(mockActions.executeLidarrArtistTagPlan).not.toHaveBeenCalled();
        expect(mockActions.executeLidarrArtistDeletePlan).not.toHaveBeenCalled();
      },
    );

    it("declares selection and tag-mode conflicts in Commander", () => {
      const plan = lidarrCommand.commands.find((command) => command.name() === "plan");
      const profiles = plan?.commands.find((command) => command.name() === "artist-profiles");
      const tags = plan?.commands.find((command) => command.name() === "artist-tags");
      const artistDelete = plan?.commands.find((command) => command.name() === "artist-delete");

      expect(
        declaredConflicts(profiles?.options.find((option) => option.long === "--ids")),
      ).toContain("all");
      expect(
        declaredConflicts(profiles?.options.find((option) => option.long === "--select-monitored")),
      ).toContain("selectUnmonitored");
      expect(
        declaredConflicts(tags?.options.find((option) => option.long === "--add-tag")),
      ).toEqual(expect.arrayContaining(["removeTag", "setTag", "clearTags"]));
      expect(
        declaredConflicts(artistDelete?.options.find((option) => option.long === "--ids")),
      ).toContain("all");
    });
  });

  describe("album leaves command contract", () => {
    /**
     * Commander option conflicts abort before the action handler; override exit
     * (recursively — subcommands do not inherit it) so the parse rejects instead
     * of exiting the process, and silence Commander's own stderr.
     */
    function armCommanderThrow(command: Command): void {
      command.exitOverride();
      command.configureOutput({ writeErr: () => {} });
      for (const sub of command.commands) armCommanderThrow(sub);
    }

    function planLeaf(name: string): Command | undefined {
      return lidarrCommand.commands
        .find((command) => command.name() === "plan")
        ?.commands.find((command) => command.name() === name);
    }

    function optionLongs(command: Command | undefined): readonly (string | undefined)[] {
      return command?.options.map((option) => option.long) ?? [];
    }

    it("requires exactly one selection scope on the albums read leaf", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "albums"], { from: "node" });

      expect(mockActions.executeLidarrAlbums).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining(
          "Choose exactly one selection scope: --artist-ids, --album-ids, or --all",
        ),
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["--artist-ids with --album-ids", ["--artist-ids", "3", "--album-ids", "5"]],
      ["--artist-ids with --all", ["--artist-ids", "3", "--all"]],
      ["--album-ids with --all", ["--album-ids", "5", "--all"]],
      ["--album-ids with --types", ["--album-ids", "5", "--types", "singles"]],
      ["--monitored with --unmonitored", ["--all", "--monitored", "--unmonitored"]],
      ["--has-files with --no-files", ["--all", "--has-files", "--no-files"]],
    ])("albums rejects %s via Commander conflicts before the action", async (_name, flags) => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(["node", "rfmedia", "lidarr", "albums", ...flags], { from: "node" }),
      ).rejects.toThrow(/cannot be used with/);
      expect(mockActions.executeLidarrAlbums).not.toHaveBeenCalled();
    });

    it("requires an explicit any-release-ok direction on album-edit", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "album-edit", "--types", "singles"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumEditPlan).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Pass --any-release-ok or --no-any-release-ok"),
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["--album-ids with --types", ["--album-ids", "5", "--types", "singles"]],
      ["--album-ids with --artist-ids", ["--album-ids", "5", "--artist-ids", "3"]],
      [
        "--dry-run with --plan-file",
        ["--types", "singles", "--any-release-ok", "--dry-run", "--plan-file", "/tmp/p.json"],
      ],
    ])("album-edit rejects %s via Commander conflicts before the action", async (_name, flags) => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(["node", "rfmedia", "lidarr", "plan", "album-edit", ...flags], {
          from: "node",
        }),
      ).rejects.toThrow(/cannot be used with/);
      expect(mockActions.executeLidarrAlbumEditPlan).not.toHaveBeenCalled();
    });

    it("exposes the delete flag set without a library-wide --all sweep", () => {
      const longs = optionLongs(planLeaf("album-delete"));

      expect(longs).not.toContain("--all");
      expect(longs).toEqual(
        expect.arrayContaining([
          "--album-ids",
          "--artist-ids",
          "--types",
          "--include-monitored",
          "--delete-files",
          "--add-import-list-exclusion",
          "--dry-run",
          "--max-batch",
          "--plan-file",
          "--lidarr-url",
          "--lidarr-api-key",
        ]),
      );
    });

    it("rejects --dry-run with --plan-file on album-delete before the action", async () => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "lidarr",
            "plan",
            "album-delete",
            "--album-ids",
            "5",
            "--dry-run",
            "--plan-file",
            "/tmp/p.json",
          ],
          { from: "node" },
        ),
      ).rejects.toThrow(/cannot be used with/);
      expect(mockActions.executeLidarrAlbumDeletePlan).not.toHaveBeenCalled();
    });

    it("emits the previewed album-delete CSV projection without a planPath column", async () => {
      mockActions.executeLidarrAlbumDeletePlan.mockResolvedValue({
        status: "previewed",
        plan: ALBUM_DELETE_PLAN,
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "plan",
          "album-delete",
          "--album-ids",
          "9",
          "--dry-run",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-plan",
        "result.planId": ALBUM_DELETE_PLAN.id,
        "result.origin": ALBUM_DELETE_PLAN.target.origin,
        "result.risk": "high",
        "result.maxBatch": 25,
        "result.changed": 1,
        "result.unchanged": 0,
        "result.operation": "album-delete",
        "result.selection": JSON.stringify(ALBUM_DELETE_PLAN.selection),
        "result.summary": JSON.stringify(ALBUM_DELETE_PLAN.summary),
        "result.entries": JSON.stringify(ALBUM_DELETE_PLAN.entries),
        ...NOT_RECORDED_CASCADE_CSV,
        "result.status": "previewed",
      });
      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      expect(csvData).not.toHaveProperty("result.planPath");
      expect(process.exitCode).toBeUndefined();
    });

    it("previews track-filter by default and only writes when --out is supplied", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "track-filter",
          "--album-id",
          "9",
          "--keep-track-ids",
          "91",
          "--min-stars",
          "3",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrTrackFilterPlan).toHaveBeenCalledWith({
        albumId: 9,
        keepTrackIds: [91],
        minStars: 3,
        maxBatch: 100,
        dryRun: true,
        output: undefined,
        lidarrUrl: undefined,
        lidarrApiKey: undefined,
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "track-filter",
          "--album-id",
          "9",
          "--keep-track-ids",
          "91",
          "--out",
          "/tmp/track-filter.json",
        ],
        { from: "node" },
      );
      expect(mockActions.executeLidarrTrackFilterPlan).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dryRun: false,
          output: "/tmp/track-filter.json",
        }),
      );
    });

    it("requires retention criteria and validates half-star thresholds locally", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "track-filter", "--album-id", "9"],
        { from: "node" },
      );
      expect(mockActions.executeLidarrTrackFilterPlan).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Pass --keep-track-ids and/or --min-stars"),
      );

      armCommanderThrow(rootCommand);
      await expect(
        rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "lidarr",
            "plan",
            "track-filter",
            "--album-id",
            "9",
            "--min-stars",
            "3.2",
          ],
          { from: "node" },
        ),
      ).rejects.toThrow(/half-star/u);
    });

    it("declares both destructive album authorization flags on apply", () => {
      const apply = lidarrCommand.commands.find((command) => command.name() === "apply");

      expect(optionLongs(apply)).toEqual(
        expect.arrayContaining([
          "--yes",
          "--allow-tag-replacement",
          "--allow-album-delete",
          "--allow-file-delete",
          "--expected-plan-id",
          "--expected-plan-checksum",
          "--resume",
          "--dry-run",
          "--lidarr-url",
          "--lidarr-api-key",
          "--verbose",
        ]),
      );
    });
  });

  describe("apply authorization fail-closed matrix (command layer)", () => {
    it("rejects a real album-delete apply when --yes alone is passed", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ALBUM_DELETE_PLAN);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/del.json", "--yes"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("--allow-album-delete is required for album-delete plans"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("rejects a deleteFiles plan authorized only with --allow-album-delete", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ALBUM_DELETE_FILES_PLAN);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/del.json", "--yes", "--allow-album-delete"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining(
          "--allow-file-delete is required when the sealed plan deletes files",
        ),
      );
      expect(process.exitCode).toBe(1);
    });

    it("proceeds to the action once both authorization keys are present", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ALBUM_DELETE_FILES_PLAN);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          "/tmp/del.json",
          "--yes",
          "--allow-album-delete",
          "--allow-file-delete",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: false,
          approved: true,
          allowAlbumDelete: true,
          allowFileDelete: true,
          expectedPlanId: ALBUM_DELETE_FILES_PLAN.id,
          expectedPlanChecksum: ALBUM_DELETE_FILES_PLAN.payloadChecksum,
        }),
      );
    });

    it("requires neither authorization key for a dry-run album-delete check", async () => {
      mockActions.executeLidarrApply.mockResolvedValue(APPLY_CHECK_RESULT);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/del.json", "--dry-run"],
        { from: "node" },
      );

      expect(mockPlanEngine.readLidarrPlanArtifact).not.toHaveBeenCalled();
      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, approved: true }),
      );
      expect(mockLogger.logError).not.toHaveBeenCalled();
    });

    it("requires only file-delete authorization for a track-filter plan", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(TRACK_FILTER_PLAN);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/filter.json", "--yes"],
        { from: "node" },
      );
      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining(
          "--allow-file-delete is required when the sealed plan deletes files",
        ),
      );

      vi.clearAllMocks();
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(TRACK_FILTER_PLAN);
      mockActions.executeLidarrApply.mockResolvedValue(APPLY_RESULT);
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/filter.json", "--yes", "--allow-file-delete"],
        { from: "node" },
      );
      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          allowAlbumDelete: false,
          allowFileDelete: true,
          expectedPlanId: TRACK_FILTER_PLAN.id,
        }),
      );
    });
  });

  describe("machine output parity", () => {
    it("emits the lidarr-plan envelope for machine review", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "yaml",
          "lidarr",
          "plan",
          "artist-monitoring",
          "--ids",
          "3",
          "--unmonitored",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "lidarr-plan",
        result: PLAN_RESULT,
      });
    });

    it("emits complete v2 profile-plan evidence in machine output", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "yaml",
          "lidarr",
          "plan",
          "artist-profiles",
          "--all",
          "--quality-profile",
          "Lossless",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "lidarr-plan",
        result: PROFILE_PLAN_RESULT,
      });
    });

    it("preserves structured v3 cascade evidence in one clean machine document", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "json",
          "lidarr",
          "plan",
          "track-filter",
          "--album-id",
          "9",
          "--keep-track-ids",
          "91",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-plan",
        result: TRACK_FILTER_PREVIEW_RESULT,
      });
      expect(TRACK_FILTER_PREVIEW_RESULT.plan.cascadeAnalysis).toBe(CASCADE_ANALYSIS);
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(capturedStderr()).toBe("");
    });

    it("keeps preview and apply cascade aggregates in CSV parity", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "plan",
          "track-filter",
          "--album-id",
          "9",
          "--keep-track-ids",
          "91",
        ],
        { from: "node" },
      );
      const preview = mockFormatters.formatOutput.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(preview).toMatchObject(RECORDED_CASCADE_CSV);
      expect(preview).not.toHaveProperty("result.planPath");

      mockActions.executeLidarrApply.mockResolvedValue(RECORDED_APPLY_RESULT);
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "csv", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );
      const apply = mockFormatters.formatOutput.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(apply).toMatchObject(RECORDED_CASCADE_CSV);
      expect(
        Object.fromEntries(
          Object.entries(apply).filter(([key]) => key.startsWith("result.cascade")),
        ),
      ).toEqual(
        Object.fromEntries(
          Object.entries(preview).filter(([key]) => key.startsWith("result.cascade")),
        ),
      );
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(capturedStderr()).toBe("");
    });

    it.each(["json", "yaml"])(
      "preserves exact artist-delete evidence in %s output",
      async (format) => {
        await rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "--output",
            format,
            "lidarr",
            "plan",
            "artist-delete",
            "--ids",
            "3",
            "--delete-files",
          ],
          { from: "node" },
        );

        expect(mockFormatters.formatOutput).toHaveBeenCalledWith(format, {
          command: "lidarr-plan",
          result: ARTIST_DELETE_PLAN_RESULT,
        });
      },
    );

    it("emits the lidarr-apply envelope with explicit approval", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--json", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-apply",
        result: APPLY_RESULT,
      });
    });

    it("emits the lidarr-status envelope for --output json", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "--output", "json", "lidarr", "status"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-status",
        result: STATUS_RESULT,
      });
    });

    it("emits the lidarr-list envelope for --json", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "--json", "lidarr", "list"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-list",
        result: LIST_RESULT,
      });
    });

    it("emits the lidarr-wanted envelope for --output yaml", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "--output", "yaml", "lidarr", "wanted"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "lidarr-wanted",
        result: WANTED_RESULT,
      });
    });

    it("emits a flat lidarr-health projection accepted by the shared CSV serializer", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "--output", "csv", "lidarr", "health"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-health",
        "result.checks": JSON.stringify(HEALTH_RESULT.checks),
        "result.hasErrors": false,
        "result.metadataProvider": JSON.stringify(HEALTH_RESULT.metadataProvider),
        "result.resilience": JSON.stringify(HEALTH_RESULT.resilience),
        "result.execution.lane": "local-only",
        "result.execution.outcome": "succeeded",
        "result.execution.attempts": 1,
      });

      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();

      const renderedCsv = String(consoleLogSpy.mock.calls.at(-1)?.[0]);
      expect(renderedCsv).toContain("result.execution.lane");
      expect(renderedCsv).toContain("result.execution.outcome");
      expect(renderedCsv).toContain("result.execution.attempts");
      expect(renderedCsv).toContain("local-only");
      expect(renderedCsv).toContain("succeeded");
    });

    it("does not call formatOutput in default text mode", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status"], { from: "node" });

      expect(mockFormatters.formatOutput).not.toHaveBeenCalled();
      expect(mockActions.executeLidarrStatus).toHaveBeenCalledTimes(1);
      expect(capturedStderr()).toContain("Execution: local-only lane · 1 attempt");
    });

    it("emits classified lane metadata for machine-readable failures", async () => {
      mockActions.executeLidarrStatus.mockRejectedValue(await createScheduledFailure());

      await rootCommand.parseAsync(["node", "rfmedia", "--json", "lidarr", "status"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-status",
          error: expect.objectContaining({
            message: "Lidarr is unreachable",
            code: "lidarr-unreachable",
            lane: "local-only",
            outcome: "failed",
            attempts: 1,
            failureType: "lidarr-unreachable",
            retryable: true,
          }),
        }),
      );
      expect(mockLogger.logError).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("flag forwarding", () => {
    it("forwards exact-ID monitoring plan flags", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-monitoring",
          "--ids",
          "8,3",
          "--unmonitored",
          "--max-batch",
          "10",
          "--plan-file",
          "/tmp/review.json",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          artistIds: [8, 3],
          monitored: false,
          maxBatch: 10,
          output: "/tmp/review.json",
        }),
      );
    });

    it("uses the shared default batch cap for legacy and selector-based plans", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "artist-monitoring", "--ids", "8", "--monitored"],
        { from: "node" },
      );
      expect(mockActions.executeLidarrPlan).toHaveBeenCalledWith(
        expect.objectContaining({ maxBatch: LIDARR_PLAN_DEFAULT_MAX_BATCH }),
      );

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-profiles",
          "--all",
          "--quality-profile",
          "Lossless",
        ],
        { from: "node" },
      );
      expect(mockActions.executeLidarrArtistProfilePlan).toHaveBeenCalledWith(
        expect.objectContaining({ maxBatch: LIDARR_PLAN_DEFAULT_MAX_BATCH }),
      );
    });

    it("runs apply as a no-write check without requiring --yes", async () => {
      mockActions.executeLidarrApply.mockResolvedValue({
        ...APPLY_RESULT,
        status: "checked",
        dryRun: true,
      });
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/review.json", "--dry-run", "--resume"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          planPath: "/tmp/review.json",
          dryRun: true,
          approved: true,
          resume: true,
        }),
      );
    });

    it("forwards profile selection, desired changes, cap, path, and connection flags", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-profiles",
          "--select-monitored",
          "--select-quality-profile",
          "name:1",
          "--select-tag",
          "Favorite",
          "--select-tag",
          "Archive",
          "--quality-profile",
          "4",
          "--metadata-profile",
          "Standard",
          "--max-batch",
          "40",
          "--plan-file",
          "/tmp/profiles.json",
          "--lidarr-url",
          "https://lidarr.example.test",
          "--lidarr-api-key",
          "secret",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrArtistProfilePlan).toHaveBeenCalledWith({
        artistIds: undefined,
        all: undefined,
        selectMonitored: true,
        selectUnmonitored: undefined,
        selectQualityProfile: "name:1",
        selectMetadataProfile: undefined,
        selectTags: ["Favorite", "Archive"],
        qualityProfile: "4",
        metadataProfile: "Standard",
        maxBatch: 40,
        output: "/tmp/profiles.json",
        lidarrUrl: "https://lidarr.example.test",
        lidarrApiKey: "secret",
      });
    });

    it("forwards exact tag-set intent and an exact-ID selection", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-tags",
          "--ids",
          "8,3",
          "--set-tag",
          "9",
          "--set-tag",
          "name:7",
          "--plan-file",
          "/tmp/tags.json",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrArtistTagPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          artistIds: [8, 3],
          setTags: ["9", "name:7"],
          clearTags: undefined,
          output: "/tmp/tags.json",
        }),
      );
    });

    it("forwards explicit tag clear without inventing an empty tag list", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "artist-tags", "--all", "--clear-tags"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrArtistTagPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          all: true,
          addTags: undefined,
          removeTags: undefined,
          setTags: undefined,
          clearTags: true,
        }),
      );
    });

    it("forwards artist-delete selection, file mode, dry-run, cap, path, and connection flags", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-delete",
          "--select-unmonitored",
          "--select-tag",
          "Archive",
          "--delete-files",
          "--dry-run",
          "--max-batch",
          "10",
          "--plan-file",
          "/tmp/delete.json",
          "--lidarr-url",
          "https://lidarr.example.test",
          "--lidarr-api-key",
          "secret",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrArtistDeletePlan).toHaveBeenCalledWith({
        artistIds: undefined,
        all: undefined,
        selectMonitored: undefined,
        selectUnmonitored: true,
        selectQualityProfile: undefined,
        selectMetadataProfile: undefined,
        selectTags: ["Archive"],
        deleteFiles: true,
        dryRun: true,
        maxBatch: 10,
        output: "/tmp/delete.json",
        lidarrUrl: "https://lidarr.example.test",
        lidarrApiKey: "secret",
      });
    });

    it("requires --yes for a non-interactive real apply", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "apply", "/tmp/review.json"], {
        from: "node",
      });

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("--yes is required"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("renders a validated interactive review before confirmation and real apply", async () => {
      mockPrompt.isInteractive.mockReturnValue(true);
      mockActions.executeLidarrApply
        .mockResolvedValueOnce(APPLY_CHECK_RESULT)
        .mockResolvedValueOnce(APPLY_RESULT);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          "/tmp/review.json",
          "--resume",
          "--allow-tag-replacement",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          dryRun: true,
          approved: true,
          resume: true,
          allowTagReplacement: true,
        }),
      );
      expect(mockActions.executeLidarrApply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          dryRun: false,
          approved: true,
          resume: true,
          allowTagReplacement: true,
          expectedPlanId: PLAN_RESULT.plan.id,
          expectedPlanChecksum: PLAN_RESULT.plan.payloadChecksum,
        }),
      );
      expect(capturedStderr()).toContain("Lidarr Apply Check");
      expect(capturedStderr()).toContain("would-apply");
      expect(capturedStderr()).toContain("Risk: low · non-destructive");
      const reviewRenderCall = consoleErrorSpy.mock.calls.findIndex((call: readonly unknown[]) =>
        call.map(String).join(" ").includes("Lidarr Apply Check"),
      );
      expect(consoleErrorSpy.mock.invocationCallOrder[reviewRenderCall]).toBeLessThan(
        mockPrompt.confirm.mock.invocationCallOrder[0]!,
      );
      expect(mockPrompt.confirm.mock.invocationCallOrder[0]).toBeLessThan(
        mockActions.executeLidarrApply.mock.invocationCallOrder[1]!,
      );
    });

    it.each([
      ["add", [], `Apply Lidarr mutation plan ${TAG_PLAN_RESULT.planPath}?`],
      ["remove", [], `Apply Lidarr mutation plan ${TAG_PLAN_RESULT.planPath}?`],
      [
        "set",
        ["--allow-tag-replacement"],
        `Apply destructive tag-replacement Lidarr mutation plan ${TAG_PLAN_RESULT.planPath}?`,
      ],
      [
        "clear",
        ["--allow-tag-replacement"],
        `Apply destructive tag-replacement Lidarr mutation plan ${TAG_PLAN_RESULT.planPath}?`,
      ],
    ] as const)(
      "labels an artist tag %s apply prompt accurately",
      async (mode, flags, expectedPrompt) => {
        const reviewedPlan = {
          ...TAG_PLAN_RESULT.plan,
          operation: { ...TAG_PLAN_RESULT.plan.operation, mode },
        };
        mockPrompt.isInteractive.mockReturnValue(true);
        mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(reviewedPlan);
        mockActions.executeLidarrApply
          .mockResolvedValueOnce(APPLY_CHECK_RESULT)
          .mockResolvedValueOnce(APPLY_RESULT);

        await rootCommand.parseAsync(
          ["node", "rfmedia", "lidarr", "apply", TAG_PLAN_RESULT.planPath, ...flags],
          { from: "node" },
        );

        expect(mockPrompt.confirm).toHaveBeenCalledWith(expectedPrompt);
      },
    );

    it.each(["invalid artifact", "target origin mismatch", "artist state changed after planning"])(
      "does not prompt when interactive preflight rejects an %s plan",
      async (message) => {
        mockPrompt.isInteractive.mockReturnValue(true);
        mockActions.executeLidarrApply.mockRejectedValueOnce(new Error(message));

        await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "apply", "/tmp/review.json"], {
          from: "node",
        });

        expect(mockActions.executeLidarrApply).toHaveBeenCalledTimes(1);
        expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
          expect.objectContaining({ dryRun: true, approved: true }),
        );
        expect(mockPrompt.confirm).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
      },
    );

    it("cancels after interactive review without running a real apply", async () => {
      mockPrompt.isInteractive.mockReturnValue(true);
      mockPrompt.confirm.mockResolvedValue(false);
      mockActions.executeLidarrApply.mockResolvedValueOnce(APPLY_CHECK_RESULT);

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "apply", "/tmp/review.json"], {
        from: "node",
      });

      expect(mockActions.executeLidarrApply).toHaveBeenCalledTimes(1);
      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, approved: true }),
      );
      expect(capturedStderr()).toContain("Lidarr apply cancelled; no changes were made.");
      expect(process.exitCode).toBeUndefined();
    });

    it.each(["/tmp/review\u001b]52;spoof.json", "/tmp/review\u202Espoof.json"])(
      "rejects terminal controls in plan path %j before preflight or prompting",
      async (planPath) => {
        mockPrompt.isInteractive.mockReturnValue(true);

        await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "apply", planPath], {
          from: "node",
        });

        expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
        expect(mockPrompt.confirm).not.toHaveBeenCalled();
        expect(mockLogger.logError).toHaveBeenCalledWith(
          expect.stringContaining("free of terminal control characters"),
        );
        expect(process.exitCode).toBe(1);
      },
    );

    it("requires --yes for machine-output real apply before preflight", async () => {
      mockPrompt.isInteractive.mockReturnValue(true);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--json", "lidarr", "apply", "/tmp/review.json"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockPrompt.confirm).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("forwards explicit approval for real apply", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: false,
          approved: true,
          expectedPlanId: PLAN_RESULT.plan.id,
          expectedPlanChecksum: PLAN_RESULT.plan.payloadChecksum,
        }),
      );
    });

    it("requires replacement-specific authorization before a real tag set apply", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(TAG_PLAN_RESULT.plan);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/tags.json", "--yes"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("--allow-tag-replacement is required"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("forwards reviewed ID/checksum pins for an authorized tag replacement", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(TAG_PLAN_RESULT.plan);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          "/tmp/tags.json",
          "--yes",
          "--allow-tag-replacement",
          "--expected-plan-id",
          TAG_PLAN_RESULT.plan.id,
          "--expected-plan-checksum",
          TAG_PLAN_RESULT.plan.payloadChecksum,
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          approved: true,
          allowTagReplacement: true,
          expectedPlanId: TAG_PLAN_RESULT.plan.id,
          expectedPlanChecksum: TAG_PLAN_RESULT.plan.payloadChecksum,
        }),
      );
    });

    it.each([
      [[], "--allow-artist-delete is required"],
      [["--allow-artist-delete"], "--allow-file-delete is required"],
    ])("requires explicit artist/file deletion authority", async (flags, expectedMessage) => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ARTIST_DELETE_PLAN_RESULT.plan);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          ARTIST_DELETE_PLAN_RESULT.planPath,
          "--yes",
          ...flags,
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(expect.stringContaining(expectedMessage));
      expect(process.exitCode).toBe(1);
    });

    it("forwards deletion authority and scan intent with reviewed checksum pins", async () => {
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ARTIST_DELETE_PLAN_RESULT.plan);
      mockActions.executeLidarrApply.mockResolvedValue(ARTIST_DELETE_APPLY_RESULT);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          ARTIST_DELETE_PLAN_RESULT.planPath,
          "--yes",
          "--allow-artist-delete",
          "--allow-file-delete",
          "--plex-scan",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({
          approved: true,
          allowArtistDelete: true,
          allowFileDelete: true,
          plexScan: true,
          expectedPlanId: ARTIST_DELETE_PLAN_RESULT.plan.id,
          expectedPlanChecksum: ARTIST_DELETE_PLAN_RESULT.plan.payloadChecksum,
        }),
      );
    });

    it("prompts with irreversible deletion mode and exact aggregate evidence", async () => {
      mockPrompt.isInteractive.mockReturnValue(true);
      mockPlanEngine.readLidarrPlanArtifact.mockResolvedValue(ARTIST_DELETE_PLAN_RESULT.plan);
      mockActions.executeLidarrApply
        .mockResolvedValueOnce({
          ...ARTIST_DELETE_APPLY_RESULT,
          status: "checked",
          dryRun: true,
          scan: {
            requested: true,
            attempted: false,
            status: "skipped",
            message: "A dry-run does not request a media-server scan.",
          },
        })
        .mockResolvedValueOnce(ARTIST_DELETE_APPLY_RESULT);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          ARTIST_DELETE_PLAN_RESULT.planPath,
          "--allow-artist-delete",
          "--allow-file-delete",
          "--plex-scan",
        ],
        { from: "node" },
      );

      expect(mockPrompt.confirm).toHaveBeenCalledWith(
        expect.stringMatching(
          /IRREVERSIBLE: apply delete-files .*1 artist\(s\), 4 album\(s\), 20 track file\(s\), 2048 bytes \(.+\)\?/,
        ),
      );
      expect(capturedStderr()).toContain("/music/Three");
      expect(mockActions.executeLidarrApply).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          allowArtistDelete: true,
          allowFileDelete: true,
          plexScan: true,
          expectedPlanId: ARTIST_DELETE_PLAN_RESULT.plan.id,
          expectedPlanChecksum: ARTIST_DELETE_PLAN_RESULT.plan.payloadChecksum,
        }),
      );
    });

    it("keeps dry-run mutation-free without requiring replacement authorization", async () => {
      mockActions.executeLidarrApply.mockResolvedValue(APPLY_CHECK_RESULT);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/tags.json", "--dry-run"],
        { from: "node" },
      );

      expect(mockPlanEngine.readLidarrPlanArtifact).not.toHaveBeenCalled();
      expect(mockActions.executeLidarrApply).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, approved: true }),
      );
    });

    it("preserves deletion authority in a dry-run recovery command", async () => {
      mockActions.executeLidarrApply.mockResolvedValue({
        ...ARTIST_DELETE_APPLY_RESULT,
        dryRun: true,
        status: "partial",
        summary: {
          ...ARTIST_DELETE_APPLY_RESULT.summary,
          succeeded: 0,
          failed: 1,
        },
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "apply",
          ARTIST_DELETE_PLAN_RESULT.planPath,
          "--dry-run",
          "--allow-artist-delete",
          "--allow-file-delete",
        ],
        { from: "node" },
      );

      expect(capturedStderr()).toContain(
        `Safe next step: rfmedia lidarr apply '${ARTIST_DELETE_PLAN_RESULT.planPath}' --resume --allow-artist-delete --allow-file-delete --expected-plan-id ${ARTIST_DELETE_APPLY_RESULT.planId} --expected-plan-checksum ${ARTIST_DELETE_APPLY_RESULT.planChecksum}`,
      );
    });

    it("forwards connection overrides to executeLidarrStatus", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "status",
          "--lidarr-url",
          "http://localhost:8686",
          "--lidarr-api-key",
          "secret-key",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          lidarrUrl: "http://localhost:8686",
          lidarrApiKey: "secret-key",
        }),
      );
    });

    it("forwards filter and paging flags to executeLidarrList", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "list",
          "--tag",
          "7",
          "--tag",
          "9",
          "--monitored",
          "--quality-profile",
          "3",
          "--limit",
          "10",
          "--offset",
          "5",
          "--lidarr-url",
          "http://localhost:8686",
          "--lidarr-api-key",
          "secret-key",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrList).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: [7, 9],
          monitored: true,
          qualityProfile: 3,
          limit: 10,
          offset: 5,
          lidarrUrl: "http://localhost:8686",
          lidarrApiKey: "secret-key",
        }),
      );
    });

    it("forwards paging and sort flags to executeLidarrWanted", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "wanted",
          "--page",
          "2",
          "--page-size",
          "25",
          "--sort-key",
          "title",
          "--sort-dir",
          "ascending",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrWanted).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          pageSize: 25,
          sortKey: "title",
          sortDir: "ascending",
        }),
      );
    });

    it("applies wanted defaults when flags are omitted", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "wanted"], { from: "node" });

      expect(mockActions.executeLidarrWanted).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 1,
          pageSize: 50,
          sortKey: "releaseDate",
          sortDir: "descending",
        }),
      );
    });

    it("forwards repeatable --type filters to executeLidarrHealth", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "health", "--type", "error", "warning"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrHealth).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ["error", "warning"],
        }),
      );
    });

    it("surfaces error-level checks without setting a failing exit code (report, not gate)", async () => {
      mockActions.executeLidarrHealth.mockResolvedValue({
        ...HEALTH_RESULT,
        checks: [
          {
            source: "DownloadClientCheck",
            type: "error",
            message: "No download client is available",
          },
        ],
        hasErrors: true,
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "health"], { from: "node" });

      // health is diagnostic: a non-empty error list must NOT by itself set exit 1
      // (only an action throw does — covered in the error-handling block).
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("album-monitoring plan leaf", () => {
    /**
     * Commander option conflicts abort before the action handler; override
     * exit (recursively — subcommands do not inherit it) so the parse rejects
     * instead of exiting the test process, and silence Commander's own stderr.
     */
    function armCommanderThrow(command: Command): void {
      command.exitOverride();
      command.configureOutput({ writeErr: () => {} });
      for (const sub of command.commands) armCommanderThrow(sub);
    }

    it("forwards selector-mode flags with canonicalized types", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "singles,ep",
          "--artist-ids",
          "8,3",
          "--dry-run",
          "--max-batch",
          "10",
          "--lidarr-url",
          "http://localhost:8686",
          "--lidarr-api-key",
          "secret-key",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          monitored: false,
          types: ["eps", "singles"],
          artistIds: [8, 3],
          albumIds: undefined,
          dryRun: true,
          maxBatch: 10,
          output: undefined,
          lidarrUrl: "http://localhost:8686",
          lidarrApiKey: "secret-key",
        }),
      );
    });

    it("forwards explicit album IDs with the default max batch and plan file", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--monitored",
          "--album-ids",
          "5,9",
          "--plan-file",
          "/tmp/album-review.json",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          monitored: true,
          types: undefined,
          artistIds: undefined,
          albumIds: [5, 9],
          dryRun: undefined,
          maxBatch: 25,
          output: "/tmp/album-review.json",
        }),
      );
    });

    it.each([
      ["--monitored with --unmonitored", ["--monitored", "--unmonitored", "--types", "singles"]],
      ["--album-ids with --types", ["--unmonitored", "--album-ids", "5", "--types", "singles"]],
      ["--album-ids with --artist-ids", ["--unmonitored", "--album-ids", "5", "--artist-ids", "3"]],
      [
        "--dry-run with --plan-file",
        ["--unmonitored", "--types", "singles", "--dry-run", "--plan-file", "/tmp/p.json"],
      ],
    ])("rejects %s via Commander conflicts before the action runs", async (_name, flags) => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(
          ["node", "rfmedia", "lidarr", "plan", "album-monitoring", ...flags],
          {
            from: "node",
          },
        ),
      ).rejects.toThrow(/cannot be used with/);
      expect(mockActions.executeLidarrAlbumPlan).not.toHaveBeenCalled();
    });

    it("rejects an unknown --types token listing the allowlist", async () => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "lidarr",
            "plan",
            "album-monitoring",
            "--unmonitored",
            "--types",
            "vinyls",
          ],
          { from: "node" },
        ),
      ).rejects.toThrow(/albums, eps, singles, broadcasts, others, compilations/);
      expect(mockActions.executeLidarrAlbumPlan).not.toHaveBeenCalled();
    });

    it("requires a direction flag in the handler guard", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "album-monitoring", "--types", "singles"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumPlan).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Pass --monitored or --unmonitored"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("requires a selection flag — --artist-ids alone is not a selector", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--artist-ids",
          "3",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumPlan).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Pass --types or --album-ids"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("rejects terminal controls in --plan-file on the album leaf only", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "singles",
          "--plan-file",
          "/tmp/review\u001b]52;spoof.json",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrAlbumPlan).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("free of terminal control characters"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("emits the lidarr-plan envelope for machine album plans, stdout-clean", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "yaml",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "singles",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
        command: "lidarr-plan",
        result: ALBUM_PLAN_RESULT,
      });
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(capturedStderr()).toBe("");
    });

    it("emits the lidarr-plan failure envelope when the album action rejects", async () => {
      mockActions.executeLidarrAlbumPlan.mockRejectedValue(new Error("no albums matched"));

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--json",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "singles",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-plan",
          error: expect.objectContaining({ message: "no albums matched", outcome: "failed" }),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it("emits a flat album-plan projection accepted by the shared CSV serializer", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "eps,singles",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-plan",
        "result.status": "planned",
        "result.selection.artistsScanned": 1,
        "result.selection.albumsScanned": 4,
        "result.selection.matched": 2,
        "result.selection.alreadyInDesiredState": 1,
        "result.selection.planned": 1,
        "result.selection.bySelector": JSON.stringify(ALBUM_PLAN_RESULT.selection.bySelector),
        "result.planId": ALBUM_PLAN_RESULT.plan.id,
        "result.origin": ALBUM_PLAN_RESULT.plan.target.origin,
        "result.risk": "low",
        "result.maxBatch": 25,
        "result.changed": 1,
        "result.unchanged": 0,
        "result.entries": JSON.stringify(ALBUM_PLAN_RESULT.plan.entries),
        "result.planPath": ALBUM_PLAN_RESULT.planPath,
      });

      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();
    });

    it("emits the previewed CSV projection without a planPath column", async () => {
      mockActions.executeLidarrAlbumPlan.mockResolvedValue({
        status: "previewed",
        plan: ALBUM_PLAN_RESULT.plan,
        selection: ALBUM_PLAN_RESULT.selection,
        execution: ALBUM_PLAN_RESULT.execution,
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "eps,singles",
          "--dry-run",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-plan",
        "result.status": "previewed",
        "result.selection.artistsScanned": 1,
        "result.selection.albumsScanned": 4,
        "result.selection.matched": 2,
        "result.selection.alreadyInDesiredState": 1,
        "result.selection.planned": 1,
        "result.selection.bySelector": JSON.stringify(ALBUM_PLAN_RESULT.selection.bySelector),
        "result.planId": ALBUM_PLAN_RESULT.plan.id,
        "result.origin": ALBUM_PLAN_RESULT.plan.target.origin,
        "result.risk": "low",
        "result.maxBatch": 25,
        "result.changed": 1,
        "result.unchanged": 0,
        "result.entries": JSON.stringify(ALBUM_PLAN_RESULT.plan.entries),
      });
      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      expect(csvData).not.toHaveProperty("result.planPath");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();
    });

    it("emits the no-change CSV projection without any plan-derived columns", async () => {
      mockActions.executeLidarrAlbumPlan.mockResolvedValue({
        status: "no-change",
        selection: { ...ALBUM_PLAN_RESULT.selection, planned: 0, alreadyInDesiredState: 2 },
        execution: ALBUM_PLAN_RESULT.execution,
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "eps,singles",
          "--dry-run",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-plan",
        "result.status": "no-change",
        "result.selection.artistsScanned": 1,
        "result.selection.albumsScanned": 4,
        "result.selection.matched": 2,
        "result.selection.alreadyInDesiredState": 2,
        "result.selection.planned": 0,
        "result.selection.bySelector": JSON.stringify(ALBUM_PLAN_RESULT.selection.bySelector),
      });
      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      expect(csvData).not.toHaveProperty("result.planId");
      expect(csvData).not.toHaveProperty("result.entries");
      expect(csvData).not.toHaveProperty("result.planPath");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();
    });

    it("renders the selection summary and sample table to stderr in text mode", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "eps,singles",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).not.toHaveBeenCalled();
      const stderr = capturedStderr();
      expect(stderr).toContain("Lidarr Album Monitoring Plan");
      expect(stderr).toContain(
        "Selection: 2 matched, 1 already in state, 1 planned (1 artist(s) / 4 album(s) scanned)",
      );
      expect(stderr).toContain("Selector counts overlap");
      expect(stderr).toContain("Album ID");
      expect(stderr).toContain("Single One");
    });

    it("renders the honest no-change summary without an entry table", async () => {
      mockActions.executeLidarrAlbumPlan.mockResolvedValue({
        status: "no-change",
        selection: { ...ALBUM_PLAN_RESULT.selection, planned: 0, alreadyInDesiredState: 2 },
        execution: ALBUM_PLAN_RESULT.execution,
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "album-monitoring",
          "--unmonitored",
          "--types",
          "eps,singles",
          "--dry-run",
        ],
        { from: "node" },
      );

      const stderr = capturedStderr();
      expect(stderr).toContain("No album monitoring changes to plan.");
      expect(stderr).not.toContain("Album ID");
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("apply rendering per plan kind", () => {
    it("renders the album entry-result table (renderMutationApply album branch)", async () => {
      mockActions.executeLidarrApply.mockResolvedValue(ALBUM_APPLY_RESULT);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/lidarr-album-plan.json", "--yes"],
        { from: "node" },
      );

      const stderr = capturedStderr();
      expect(stderr).toContain("Album ID");
      expect(stderr).toContain("Single One");
      expect(stderr).not.toContain("Artist ID");
    });

    it("keeps the artist entry-result table unchanged", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );

      const stderr = capturedStderr();
      expect(stderr).toContain("Artist ID");
      expect(stderr).not.toContain("Album ID");
    });

    it("emits a flat lidarr-apply CSV projection for artist plans", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "csv", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-apply",
        "result.planId": APPLY_RESULT.planId,
        "result.planPath": APPLY_RESULT.planPath,
        "result.status": "completed",
        "result.dryRun": false,
        "result.resumed": false,
        "result.risk": JSON.stringify(APPLY_RESULT.risk),
        "result.summary": JSON.stringify(APPLY_RESULT.summary),
        "result.entries": JSON.stringify(APPLY_RESULT.entries),
        "result.execution.lane": "local-only",
        "result.execution.outcome": "succeeded",
        "result.execution.attempts": 1,
        ...NOT_RECORDED_CASCADE_CSV,
      });

      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();
    });

    it("emits a flat lidarr-apply CSV projection for album plans", async () => {
      mockActions.executeLidarrApply.mockResolvedValue(ALBUM_APPLY_RESULT);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--output",
          "csv",
          "lidarr",
          "apply",
          "/tmp/lidarr-album-plan.json",
          "--yes",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("csv", {
        command: "lidarr-apply",
        "result.planId": ALBUM_APPLY_RESULT.planId,
        "result.planPath": ALBUM_APPLY_RESULT.planPath,
        "result.status": "completed",
        "result.dryRun": false,
        "result.resumed": false,
        "result.risk": JSON.stringify(ALBUM_APPLY_RESULT.risk),
        "result.summary": JSON.stringify(ALBUM_APPLY_RESULT.summary),
        "result.entries": JSON.stringify(ALBUM_APPLY_RESULT.entries),
        "result.execution.lane": "local-only",
        "result.execution.outcome": "succeeded",
        "result.execution.attempts": 1,
        ...NOT_RECORDED_CASCADE_CSV,
      });

      const csvData = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      await expect(formatMachineOutput("csv", csvData)).resolves.toBeUndefined();
    });
  });

  describe("mutation review rendering", () => {
    it("renders explicit non-color cascade states before rows and labels apply evidence", () => {
      renderMutationPlan({ planPath: "/tmp/track-filter.json", plan: TRACK_FILTER_PLAN }, false);
      const planOutput = capturedStderr();
      expect(planOutput).toContain("Cascade analysis");
      expect(planOutput).toContain("EXCEEDED");
      expect(planOutput).toContain("[WARNING indexer-query-budget-exceeded]");
      expect(planOutput).toContain("Configured per-plan indexer-query allowance exceeded");
      expect(planOutput.indexOf("Cascade analysis")).toBeLessThan(planOutput.indexOf("Track ID"));

      consoleErrorSpy.mockClear();
      renderMutationApply(RECORDED_APPLY_RESULT as LidarrPlanApplyResult, {
        verbose: false,
        allowTagReplacement: false,
        allowArtistDelete: false,
        allowAlbumDelete: false,
        allowFileDelete: false,
        plexScan: false,
      });
      expect(capturedStderr()).toContain("Plan-time cascade analysis");
      expect(capturedStderr()).toContain("EXCEEDED");
    });

    it("renders legacy apply evidence as NOT RECORDED", () => {
      renderMutationApply(APPLY_RESULT as LidarrPlanApplyResult, {
        verbose: false,
        allowTagReplacement: false,
        allowArtistDelete: false,
        allowAlbumDelete: false,
        allowFileDelete: false,
        plexScan: false,
      });

      expect(capturedStderr()).toContain("Plan-time cascade analysis: NOT RECORDED (legacy plan)");
    });

    it("shows only 20 human plan rows by default and all rows with --verbose", async () => {
      const entries = Array.from({ length: 21 }, (_, index) => ({
        ...PROFILE_PLAN_RESULT.plan.entries[0],
        id: `artist-profile:${index + 1}`,
        artistId: index + 1,
        artistName: `Artist ${String(index + 1).padStart(2, "0")}`,
      }));
      mockActions.executeLidarrArtistProfilePlan.mockResolvedValue({
        ...PROFILE_PLAN_RESULT,
        plan: {
          ...PROFILE_PLAN_RESULT.plan,
          entries,
          review: { requested: 21, changed: 21, unchanged: 0 },
        },
      });

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-profiles",
          "--all",
          "--quality-profile",
          "Lossless",
        ],
        { from: "node" },
      );
      expect(capturedStderr()).toContain("Showing 20 of 21; rerun with --verbose to show all.");
      expect(capturedStderr()).not.toContain("Artist 21");

      consoleErrorSpy.mockClear();
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "plan",
          "artist-profiles",
          "--all",
          "--quality-profile",
          "Lossless",
          "--verbose",
        ],
        { from: "node" },
      );
      expect(capturedStderr()).not.toContain("Showing 20 of 21");
      expect(capturedStderr()).toContain("Artist 21");
    });

    it("renders names with IDs, destructive removals, and all-no-op state", async () => {
      const existingEntry = TAG_PLAN_RESULT.plan.entries[0];
      if (existingEntry === undefined) throw new Error("Tag plan fixture requires one entry");
      mockActions.executeLidarrArtistTagPlan.mockResolvedValue({
        ...TAG_PLAN_RESULT,
        plan: {
          ...TAG_PLAN_RESULT.plan,
          entries: [
            {
              ...existingEntry,
              after: existingEntry.before,
              added: [],
              removed: [],
              retained: existingEntry.before.tags,
            },
          ],
          review: { requested: 1, changed: 0, unchanged: 1 },
          summary: { kind: "artist-tag-mutation", added: 0, removed: 0, retained: 1 },
        },
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "plan", "artist-tags", "--ids", "3", "--set-tag", "7"],
        { from: "node" },
      );

      expect(capturedStderr()).toContain("Favorite (7)");
      expect(capturedStderr()).toContain("NO-OP");
      expect(capturedStderr()).toContain("already converged");
    });

    it("renders structured uncertain recovery as a copy-pasteable pinned resume command", async () => {
      mockActions.executeLidarrApply.mockResolvedValue({
        ...APPLY_RESULT,
        planPath: "/tmp/review.json",
        status: "partial",
        summary: {
          ...APPLY_RESULT.summary,
          succeeded: 0,
          uncertain: 1,
          notAttempted: 1,
        },
        entries: [
          {
            ...APPLY_RESULT.entries[0],
            outcome: "uncertain",
            before: { kind: "artist-monitoring", monitored: true },
            after: { kind: "artist-monitoring", monitored: false },
            observed: { kind: "artist-monitoring", monitored: true },
            message: "Outcome was not visible after bounded reconciliation",
            failure: {
              code: "verification-inconclusive",
              stage: "verification",
              operation: "artist-monitoring",
              planId: APPLY_RESULT.planId,
              planChecksum: APPLY_RESULT.planChecksum,
              targetIds: [3],
              dispatchState: "dispatched",
              verificationState: "inconclusive",
              retryable: true,
              safeNextAction: "resume-plan",
            },
          },
          {
            entryId: "artist:4",
            artistId: 4,
            artistName: "Four",
            outcome: "not-attempted",
          },
        ],
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "apply", "/tmp/review.json", "--yes"],
        { from: "node" },
      );

      expect(capturedStderr()).toContain(
        "verification-inconclusive/verification; dispatch=dispatched; verification=inconclusive; retryable=true; next=resume-plan",
      );
      expect(capturedStderr()).toContain(
        `rfmedia lidarr apply '/tmp/review.json' --resume --expected-plan-id ${APPLY_RESULT.planId} --expected-plan-checksum ${APPLY_RESULT.planChecksum}`,
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["/tmp/plan with spaces.json", "'/tmp/plan with spaces.json'"],
      ["/tmp/$(touch should-not-run).json", "'/tmp/$(touch should-not-run).json'"],
      ["/tmp/`touch should-not-run`.json", "'/tmp/`touch should-not-run`.json'"],
      ["/tmp/user's plan.json", "'/tmp/user'\"'\"'s plan.json'"],
      ["/tmp/plan-[*]?.json", "'/tmp/plan-[*]?.json'"],
    ])("quotes recovery path %j as an inert POSIX shell argument", async (planPath, quotedPath) => {
      mockActions.executeLidarrApply.mockResolvedValue({
        ...APPLY_RESULT,
        planPath,
        status: "partial",
        summary: {
          ...APPLY_RESULT.summary,
          succeeded: 0,
          failed: 1,
        },
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "apply", planPath, "--yes"], {
        from: "node",
      });

      expect(capturedStderr()).toContain(
        `Safe next step: rfmedia lidarr apply ${quotedPath} --resume --expected-plan-id ${APPLY_RESULT.planId} --expected-plan-checksum ${APPLY_RESULT.planChecksum}`,
      );
    });
  });

  describe("error handling", () => {
    it("sets exit code and logs when the status action rejects", async () => {
      mockActions.executeLidarrStatus.mockRejectedValue(new Error("Lidarr is unreachable"));

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status"], { from: "node" });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Lidarr status failed: Lidarr is unreachable"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("sets exit code and logs when the list action rejects", async () => {
      mockActions.executeLidarrList.mockRejectedValue(new Error("bad config"));

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list"], { from: "node" });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Lidarr list failed: bad config"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("sets exit code and logs when the wanted action rejects", async () => {
      mockActions.executeLidarrWanted.mockRejectedValue(new Error("rate limited"));

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "wanted"], { from: "node" });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Lidarr wanted failed: rate limited"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("sets exit code and logs when the health action rejects", async () => {
      mockActions.executeLidarrHealth.mockRejectedValue(new Error("timeout"));

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "health"], { from: "node" });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Lidarr health failed: timeout"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("emits a stable credential-free machine envelope for plan failures", async () => {
      mockActions.executeLidarrArtistProfilePlan.mockRejectedValue(
        Object.assign(new Error("request failed for token secret-key"), {
          code: "authentication",
          statusCode: 401,
          retryable: false,
        }),
      );

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--json",
          "lidarr",
          "plan",
          "artist-profiles",
          "--all",
          "--quality-profile",
          "Lossless",
          "--lidarr-api-key",
          "secret-key",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-plan-artist-profiles",
          error: expect.objectContaining({
            message: "request failed for token [REDACTED]",
            code: "authentication",
            lane: "unknown",
            outcome: "failed",
            attempts: 1,
            failureType: "unknown",
            statusCode: 401,
            retryable: false,
          }),
        }),
      );
      expect(JSON.stringify(mockFormatters.formatOutput.mock.calls.at(-1)?.[1])).not.toContain(
        "secret-key",
      );
    });
  });

  describe("--allow-stale flag surface", () => {
    function longFlags(name: string): (string | undefined)[] {
      const leaf = lidarrCommand.commands.find((command) => command.name() === name);
      return leaf === undefined ? [] : leaf.options.map((option) => option.long);
    }

    it("declares --allow-stale on status and list only", () => {
      expect(longFlags("status")).toContain("--allow-stale");
      expect(longFlags("list")).toContain("--allow-stale");
      expect(longFlags("wanted")).not.toContain("--allow-stale");
      expect(longFlags("health")).not.toContain("--allow-stale");
    });

    it("forwards --allow-stale to executeLidarrStatus", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status", "--allow-stale"], {
        from: "node",
      });

      expect(mockActions.executeLidarrStatus).toHaveBeenCalledWith(
        expect.objectContaining({ allowStale: true }),
      );
    });

    it("forwards --allow-stale to executeLidarrList", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list", "--allow-stale"], {
        from: "node",
      });

      expect(mockActions.executeLidarrList).toHaveBeenCalledWith(
        expect.objectContaining({ allowStale: true }),
      );
    });

    it("leaves allowStale undefined when the flag is omitted", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status"], { from: "node" });

      expect(mockActions.executeLidarrStatus).toHaveBeenCalledWith(
        expect.objectContaining({ allowStale: undefined }),
      );
    });
  });

  describe("stale-serve surface", () => {
    it("passes cacheStatus through the lidarr-status JSON envelope untouched", async () => {
      const staleResult = { ...STATUS_RESULT, cacheStatus: STALE_CACHE_STATUS };
      mockActions.executeLidarrStatus.mockResolvedValue(staleResult);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "json", "lidarr", "status", "--allow-stale"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-status",
        result: staleResult,
      });
    });

    it("passes cacheStatus through the lidarr-list JSON envelope untouched", async () => {
      const staleResult = { ...LIST_RESULT, cacheStatus: STALE_CACHE_STATUS };
      mockActions.executeLidarrList.mockResolvedValue(staleResult);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--json", "lidarr", "list", "--allow-stale"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-list",
        result: staleResult,
      });
    });

    it("emits no stale-serve warning of its own — the decorator owns the sole warning", async () => {
      const staleResult = { ...LIST_RESULT, cacheStatus: STALE_CACHE_STATUS };
      mockActions.executeLidarrList.mockResolvedValue(staleResult);

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list", "--allow-stale"], {
        from: "node",
      });

      expect(mockLogger.logWarn).not.toHaveBeenCalled();
      expect(mockLogger.logError).not.toHaveBeenCalled();
      expect(capturedStderr()).not.toContain("serving cached data");
      expect(capturedStderr()).not.toContain("Warning:");
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("failure-message contract", () => {
    it("renders the circuit-open retry-at line plus the stale hint on a circuit-open rejection", async () => {
      mockActions.executeLidarrList.mockRejectedValue(
        createLidarrErrorLike("Lidarr is unavailable (circuit open)", "lidarr-unreachable", 58),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list"], { from: "node" });

      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("Lidarr list failed: Lidarr is unavailable (circuit open)"),
      );
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Circuit open — automatic retries resume at \d{2}:\d{2}:\d{2} \(58s\)\.$/,
        ),
      );
      expect(mockLogger.logError).toHaveBeenCalledWith(
        "Hint: rerun with --allow-stale to use cached data, or run `rfmedia lidarr health`.",
      );
      expect(process.exitCode).toBe(1);
    });

    it("renders the hint without a fetched-age parenthetical", async () => {
      mockActions.executeLidarrStatus.mockRejectedValue(
        createLidarrErrorLike("request timed out", "timeout"),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status"], { from: "node" });

      const hintCalls = mockLogger.logError.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("Hint:"));
      expect(hintCalls).toEqual([
        "Hint: rerun with --allow-stale to use cached data, or run `rfmedia lidarr health`.",
      ]);
      expect(hintCalls[0]).not.toContain("last fetched");
    });

    it("omits the circuit-open line when the error carries no cooldown", async () => {
      mockActions.executeLidarrList.mockRejectedValue(
        createLidarrErrorLike("connection refused", "lidarr-unreachable"),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list"], { from: "node" });

      const lines = mockLogger.logError.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.startsWith("Circuit open"))).toBe(false);
      expect(lines.some((line) => line.startsWith("Hint:"))).toBe(true);
      expect(process.exitCode).toBe(1);
    });

    it("suppresses the hint when --allow-stale was already passed", async () => {
      mockActions.executeLidarrList.mockRejectedValue(
        createLidarrErrorLike("Lidarr is unavailable", "lidarr-unreachable", 30),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "list", "--allow-stale"], {
        from: "node",
      });

      const lines = mockLogger.logError.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.startsWith("Hint:"))).toBe(false);
      expect(lines.some((line) => line.startsWith("Circuit open"))).toBe(true);
      expect(process.exitCode).toBe(1);
    });

    it("renders neither the circuit line nor the hint for non-eligible codes", async () => {
      mockActions.executeLidarrStatus.mockRejectedValue(
        createLidarrErrorLike("bad request", "validation"),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "status"], { from: "node" });

      const lines = mockLogger.logError.mock.calls.map((call) => String(call[0]));
      expect(lines).toEqual(["Lidarr status failed: bad request"]);
      expect(process.exitCode).toBe(1);
    });

    it("never hints --allow-stale on wanted (the flag does not exist there)", async () => {
      mockActions.executeLidarrWanted.mockRejectedValue(
        createLidarrErrorLike("Lidarr is unavailable", "lidarr-unreachable", 10),
      );

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "wanted"], { from: "node" });

      const lines = mockLogger.logError.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.startsWith("Hint:"))).toBe(false);
      expect(lines.some((line) => line.startsWith("Circuit open"))).toBe(true);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("similar artist discovery", () => {
    function armCommanderThrow(command: Command): void {
      command.exitOverride();
      command.configureOutput({ writeErr: () => {} });
      for (const subcommand of command.commands) armCommanderThrow(subcommand);
    }

    function discoverLeaf(): Command | undefined {
      return lidarrCommand.commands.find((command) => command.name() === "discover");
    }

    it("declares the exact ordered controls and forwards defaults plus canonical selected ranks", async () => {
      expect(discoverLeaf()?.options.map((option) => option.long)).toEqual([
        "--artist",
        "--limit",
        "--no-autocorrect",
        "--min-similarity",
        "--max-per-seed",
        "--deep",
        "--no-cascade",
        "--diversity-boost",
        "--popularity-dampening",
        "--max-add",
        "--add",
        "--root-folder",
        "--quality-profile",
        "--metadata-profile",
        "--monitored",
        "--unmonitor-types",
        "--plan-file",
        "--lidarr-url",
        "--lidarr-api-key",
      ]);

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "discover",
          "--artist",
          "Radiohead",
          "--max-add",
          "2",
          "--add",
          "2, 1",
          "--root-folder",
          "/music",
          "--quality-profile",
          "Lossless",
          "--metadata-profile",
          "Standard",
          "--monitored",
          "--unmonitor-types",
          "Single, albums",
          "--plan-file",
          "/tmp/add.json",
          "--lidarr-url",
          "https://lidarr.example.test",
          "--lidarr-api-key",
          "lidarr-secret",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).toHaveBeenCalledWith({
        artist: "Radiohead",
        limit: 15,
        autocorrect: true,
        minSimilarity: 0,
        maxPerSeed: 10,
        deep: false,
        cascade: true,
        diversityBoost: 0,
        popularityDampening: 0,
        maxAdd: 2,
        handoff: {
          selectedRanks: [1, 2],
          rootFolder: "/music",
          qualityProfile: "Lossless",
          metadataProfile: "Standard",
          monitored: true,
          postAddUnmonitorSelectors: ["albums", "singles"],
          planFile: "/tmp/add.json",
          lidarrUrl: "https://lidarr.example.test",
          lidarrApiKey: "lidarr-secret",
        },
      });
      expect(mockActions.executeLidarrApply).not.toHaveBeenCalled();
    });

    it("forwards every non-default discovery policy control", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "discover",
          "--artist",
          "Radiohead",
          "--limit",
          "40",
          "--no-autocorrect",
          "--min-similarity",
          "0.75",
          "--max-per-seed",
          "20",
          "--deep",
          "--diversity-boost",
          "0.25",
          "--popularity-dampening",
          "1.0",
          "--max-add",
          "4",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).toHaveBeenCalledWith({
        artist: "Radiohead",
        limit: 40,
        autocorrect: false,
        minSimilarity: 0.75,
        maxPerSeed: 20,
        deep: true,
        cascade: true,
        diversityBoost: 0.25,
        popularityDampening: 1,
        maxAdd: 4,
      });
    });

    it.each([
      ["malformed similarity", ["--min-similarity", "0.5oops"]],
      ["non-finite similarity", ["--min-similarity", "Infinity"]],
      ["negative similarity", ["--min-similarity", "-0.1"]],
      ["oversized similarity", ["--min-similarity", "1.01"]],
      ["zero per-seed count", ["--max-per-seed", "0"]],
      ["unsafe per-seed count", ["--max-per-seed", "9007199254740992"]],
      ["oversized per-seed count", ["--max-per-seed", "101"]],
      ["zero max-add count", ["--max-add", "0"]],
      ["oversized max-add count", ["--max-add", "26"]],
      ["empty rank segment", ["--add", "1,,2"]],
      ["zero rank", ["--add", "0"]],
      ["duplicate ranks", ["--max-add", "2", "--add", "1,1"]],
      ["rank above visible hard bound", ["--add", "101"]],
      ["empty resource reference", ["--root-folder", ""]],
      ["terminal-unsafe resource reference", ["--quality-profile", "Lossless\u001b[2J"]],
      ["oversized resource reference", ["--metadata-profile", "m".repeat(2_049)]],
      ["unknown unmonitor selector", ["--unmonitor-types", "bootlegs"]],
      ["terminal-unsafe plan path", ["--plan-file", "plan\nunsafe.json"]],
      ["oversized plan path", ["--plan-file", "p".repeat(4_097)]],
    ])("rejects %s before the discovery action can load", async (_label, args) => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(
          ["node", "rfmedia", "lidarr", "discover", "--artist", "Radiohead", ...args],
          { from: "node" },
        ),
      ).rejects.toThrow();

      expect(mockActions.executeLidarrDiscover).not.toHaveBeenCalled();
      expect(mockFormatters.formatOutput).not.toHaveBeenCalled();
    });

    it.each([
      [
        "deep traversal with no cascade",
        ["--deep", "--no-cascade"],
        "--deep conflicts with --no-cascade",
      ],
      [
        "a selection larger than max-add",
        [
          "--max-add",
          "1",
          "--add",
          "1,2",
          "--root-folder",
          "/music",
          "--quality-profile",
          "Lossless",
          "--metadata-profile",
          "Standard",
          "--plan-file",
          "/tmp/add.json",
        ],
        "--max-add allows at most 1",
      ],
      ["an add-only resource without add", ["--root-folder", "/music"], "requires --add"],
    ])("rejects %s before discovery", async (_label, args, expectedMessage) => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "discover", "--artist", "Radiohead", ...args],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(expect.stringContaining(expectedMessage));
      expect(process.exitCode).toBe(1);
    });

    it("allows max-add without add and performs no plan handoff", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "discover", "--artist", "Radiohead", "--max-add", "5"],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).toHaveBeenCalledWith(
        expect.objectContaining({ maxAdd: 5 }),
      );
      expect(mockActions.executeLidarrDiscover.mock.calls[0]?.[0]).not.toHaveProperty("handoff");
    });

    it("rejects an incomplete add handoff before discovery", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "discover",
          "--artist",
          "Radiohead",
          "--add",
          "1",
          "--root-folder",
          "/music",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).not.toHaveBeenCalled();
      expect(mockLogger.logError).toHaveBeenCalledWith(
        expect.stringContaining("--add requires --quality-profile"),
      );
      expect(process.exitCode).toBe(1);
    });

    it("allows metadata profile omission through the producer fallback", async () => {
      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "lidarr",
          "discover",
          "--artist",
          "Radiohead",
          "--add",
          "1",
          "--root-folder",
          "/music",
          "--quality-profile",
          "Lossless",
          "--plan-file",
          "/tmp/add.json",
        ],
        { from: "node" },
      );

      expect(mockActions.executeLidarrDiscover).toHaveBeenCalledWith(
        expect.objectContaining({
          handoff: {
            selectedRanks: [1],
            rootFolder: "/music",
            qualityProfile: "Lossless",
            planFile: "/tmp/add.json",
          },
        }),
      );
    });

    it.each(["json", "yaml"] as const)(
      "emits one %s document and sets failure only after a failed handoff is rendered",
      async (format) => {
        const failed = {
          ...DISCOVER_RESULT,
          handoff: {
            status: "failed",
            selectedRank: 1,
            selectedRanks: [1],
            code: "lidarr-plan-failed",
            message: "Lidarr unavailable",
            retryable: true,
            approvals: [
              {
                status: "failed",
                selectedRank: 1,
                musicBrainzId: "11111111-1111-4111-8111-111111111111",
                code: "lidarr-plan-failed",
                message: "Lidarr unavailable",
                retryable: true,
              },
            ],
            counts: { approved: 1, alreadyPresent: 0, planned: 0, failed: 1 },
          },
        };
        mockActions.executeLidarrDiscover.mockResolvedValue(failed);

        await rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "--output",
            format,
            "lidarr",
            "discover",
            "--artist",
            "Radiohead",
            "--add",
            "1",
            "--root-folder",
            "/music",
            "--quality-profile",
            "Lossless",
            "--metadata-profile",
            "Standard",
            "--plan-file",
            "/tmp/add.json",
          ],
          { from: "node" },
        );

        expect(mockFormatters.formatOutput).toHaveBeenCalledOnce();
        expect(mockFormatters.formatOutput).toHaveBeenCalledWith(format, {
          command: "lidarr-discover",
          result: failed,
        });
        expect(mockLogger.logError).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(1);
        expect(consoleLogSpy).not.toHaveBeenCalled();
      },
    );

    it.each(["json", "csv"] as const)(
      "projects every valid-first invalid-later atomic failure to %s",
      async (format) => {
        const approvals = [
          {
            status: "failed" as const,
            selectedRank: 1,
            musicBrainzId: "11111111-1111-4111-8111-111111111111",
            code: "candidate-not-found" as const,
            message: "No visible discovery candidate has rank 99",
            retryable: false,
          },
          {
            status: "failed" as const,
            selectedRank: 99,
            code: "candidate-not-found" as const,
            message: "No visible discovery candidate has rank 99",
            retryable: false,
          },
        ];
        const failed = {
          ...DISCOVER_RESULT,
          policy: { ...DISCOVER_RESULT.policy, maxAdd: 2 },
          handoff: {
            status: "failed" as const,
            selectedRank: 1,
            selectedRanks: [1, 99],
            code: "candidate-not-found" as const,
            message: "No visible discovery candidate has rank 99",
            retryable: false,
            approvals,
            counts: { approved: 0, alreadyPresent: 0, planned: 0, failed: 2 },
          },
        };
        mockActions.executeLidarrDiscover.mockResolvedValue(failed);

        await rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "--output",
            format,
            "lidarr",
            "discover",
            "--artist",
            "Radiohead",
            "--max-add",
            "2",
            "--add",
            "1,99",
            "--root-folder",
            "/music",
            "--quality-profile",
            "Lossless",
            "--metadata-profile",
            "Standard",
            "--plan-file",
            "/tmp/add.json",
          ],
          { from: "node" },
        );

        const [calledFormat, payload] = mockFormatters.formatOutput.mock.calls.at(-1) ?? [];
        expect(calledFormat).toBe(format);
        if (format === "json") {
          expect(payload).toEqual({ command: "lidarr-discover", result: failed });
        } else {
          expect(payload).toEqual([
            expect.objectContaining({
              rowType: "summary",
              "handoff.selectedRank": 1,
              "handoff.selectedRanks": "1,99",
              "handoff.counts.failed": 2,
              "handoff.approvals": JSON.stringify(approvals),
            }),
            expect.objectContaining({ rowType: "recommendation" }),
          ]);
        }
        expect(process.exitCode).toBe(1);
      },
    );

    it("renders stable policy, traversal, candidate, attribution, and handoff text", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "lidarr", "discover", "--artist", "Radiohead"],
        { from: "node" },
      );

      const output = consoleErrorSpy.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .join("\n");
      expect(output).toContain("Policy: min similarity 0; max per seed 10; depth 1");
      expect(output).toContain("Traversal: 1 seed(s); 1 request(s); depth 1");
      expect(output).toContain("quarantined");
      expect(output).toContain("not-selected");
      expect(output).toContain("Recommendations provided by Last.fm");
      expect(output).toContain(
        "Handoff counts: 0 approved; 0 already present; 0 planned; 0 failed",
      );
    });

    it("uses the exact fixed CSV columns for its attributed summary and candidate rows", async () => {
      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "csv", "lidarr", "discover", "--artist", "Radiohead"],
        { from: "node" },
      );

      const [, rows, csvOptions] = mockFormatters.formatOutput.mock.calls.at(-1) ?? [];
      expect(rows).toEqual([
        expect.objectContaining({
          command: "lidarr-discover",
          rowType: "summary",
          returned: 1,
          "source.provider": "lastfm",
          "source.attribution": "Recommendations provided by Last.fm",
          "handoff.status": "not-requested",
          "policy.maxPerSeed": 10,
          "hardBounds.maxVisibleCandidates": 100,
          "traversal.visible": 1,
          "handoff.counts.approved": 0,
        }),
        expect.objectContaining({
          command: "lidarr-discover",
          rowType: "recommendation",
          "recommendation.rank": 1,
          "recommendation.status": "quarantined",
          "recommendation.reason": "not-selected",
          "recommendation.rawSimilarity": 0.91,
          "recommendation.adjustedScore": 0.91,
          "recommendation.exposureCount": 1,
          "recommendation.provenance.firstPath": "Radiohead > Portishead",
        }),
      ]);
      expect(csvOptions).toEqual({
        columns: [
          "command",
          "rowType",
          "seed.requestedName",
          "seed.resolvedName",
          "seed.autocorrected",
          "request.limit",
          "request.autocorrect",
          "policy.minSimilarity",
          "policy.maxPerSeed",
          "policy.deep",
          "policy.cascade",
          "policy.maxDepth",
          "policy.diversityBoost",
          "policy.popularityDampening",
          "policy.maxAdd",
          "hardBounds.providerLimit",
          "hardBounds.maxMinSimilarity",
          "hardBounds.maxPerSeed",
          "hardBounds.maxDepth",
          "hardBounds.maxRequests",
          "hardBounds.maxVisitedSeeds",
          "hardBounds.maxVisibleCandidates",
          "hardBounds.maxScoreWeight",
          "hardBounds.maxAdd",
          "traversal.seedsRequested",
          "traversal.requestsMade",
          "traversal.maximumDepthReached",
          "traversal.visited",
          "traversal.visible",
          "traversal.filtered",
          "traversal.duplicatePaths",
          "returned",
          "source.provider",
          "source.method",
          "source.attribution",
          "source.url",
          "source.fetchedAt",
          "execution.taskId",
          "execution.operation",
          "execution.lane",
          "execution.outcome",
          "execution.attempts",
          "handoff.status",
          "handoff.selectedRank",
          "handoff.selectedRanks",
          "handoff.musicBrainzId",
          "handoff.planId",
          "handoff.planChecksum",
          "handoff.planPath",
          "handoff.nextCommand",
          "handoff.lidarrId",
          "handoff.code",
          "handoff.message",
          "handoff.retryable",
          "handoff.counts.approved",
          "handoff.counts.alreadyPresent",
          "handoff.counts.planned",
          "handoff.counts.failed",
          "handoff.approvals",
          "recommendation.rank",
          "recommendation.name",
          "recommendation.similarity",
          "recommendation.rawSimilarity",
          "recommendation.adjustedScore",
          "recommendation.musicBrainzId",
          "recommendation.sourceUrl",
          "recommendation.addEligibility",
          "recommendation.status",
          "recommendation.reason",
          "recommendation.exposureCount",
          "recommendation.popularityEvidence",
          "recommendation.provenance.seedArtist",
          "recommendation.provenance.parentArtist",
          "recommendation.provenance.depth",
          "recommendation.provenance.providerRank",
          "recommendation.provenance.firstSeenSequence",
          "recommendation.provenance.firstPath",
          "recommendation.provenance.discoveredAt",
        ],
      });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe("multi-entry artist-add presentation", () => {
    function artistAddPlan(): LidarrArtistAddLegacyPlanV2 {
      const entries = Array.from({ length: 21 }, (_, offset): LidarrArtistAddLegacyPlanEntryV2 => {
        const rank = offset + 1;
        const foreignArtistId = `11111111-1111-4111-8111-${String(rank).padStart(12, "0")}`;
        return {
          id: `artist-add:${foreignArtistId}`,
          artistName: `Candidate ${rank}`,
          foreignArtistId,
          before: { exists: false },
          after: {
            exists: true,
            rootFolder: { id: 1, path: "/music" },
            qualityProfile: { id: 2, name: "Lossless" },
            metadataProfile: { id: 3, name: "Standard" },
            monitored: false,
            monitorNewItems: "none",
            searchForMissingAlbums: false,
          },
          provenance: {
            source: "lastfm",
            method: "artist.getSimilar",
            seedArtist: "Radiohead",
            similarity: 0.9,
            candidateUrl: `https://www.last.fm/music/Candidate-${rank}`,
            discoveredAt: "2026-07-25T12:00:00.000Z",
            selectedRank: rank,
          },
          idempotencyKey: `sha256:${String(rank).padStart(64, "0")}`,
        };
      });
      const [first, ...rest] = entries;
      if (first === undefined) throw new Error("artist-add test fixture must be non-empty");
      return {
        version: "rfmedia.lidarr-plan.v2",
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: "2026-07-25T12:00:00.000Z",
        createdBy: { host: "host", user: "user", cliVersion: "0.5.0", cwd: "/tmp" },
        command: "lidarr",
        target: { origin: "https://lidarr.example.test" },
        selection: {
          kind: "foreign-artist-ids",
          foreignArtistIds: [first.foreignArtistId, ...rest.map((entry) => entry.foreignArtistId)],
        },
        operation: {
          kind: "artist-add",
          rootFolder: { id: 1, path: "/music" },
          qualityProfile: { id: 2, name: "Lossless" },
          metadataProfile: { id: 3, name: "Standard" },
          monitored: false,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
        },
        maxBatch: entries.length,
        entries: [first, ...rest],
        review: { requested: entries.length, changed: entries.length, unchanged: 0 },
        summary: { kind: "artist-add", artists: entries.length },
        risk: { level: "low", destructive: false, cascade: ["Adds unmonitored artists"] },
        payloadChecksum: `sha256:${"a".repeat(64)}`,
      };
    }

    it("renders a multi-MBID selection and every plan/apply entry without verbose", () => {
      const plan = artistAddPlan();
      renderMutationPlan({ planPath: "/tmp/add.json", plan }, false);

      let output = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(output).toContain("MusicBrainz IDs:");
      expect(output).toContain(plan.entries[0].foreignArtistId);
      expect(output).toContain("Candidate 1");
      expect(output).toContain("Candidate 21");
      expect(output).not.toContain("Showing 20 of 21");

      consoleErrorSpy.mockClear();
      const applyResult: LidarrPlanApplyResult = {
        planId: plan.id,
        planChecksum: plan.payloadChecksum,
        planPath: "/tmp/add.json",
        status: "completed",
        dryRun: false,
        resumed: false,
        risk: plan.risk,
        cascadeAnalysis: { status: "not-recorded" },
        summary: {
          total: 21,
          succeeded: 21,
          satisfied: 0,
          failed: 0,
          deferred: 0,
          uncertain: 0,
          blockedStale: 0,
          notAttempted: 0,
          skippedResume: 0,
          wouldApply: 0,
        },
        entries: plan.entries.map((entry, index) => ({
          entryId: entry.id,
          foreignArtistId: entry.foreignArtistId,
          artistName: entry.artistName,
          outcome: "succeeded",
          lidarrId: index + 100,
        })),
      };
      renderMutationApply(applyResult, {
        verbose: false,
        allowTagReplacement: false,
        allowArtistDelete: false,
        allowAlbumDelete: false,
        allowFileDelete: false,
        plexScan: false,
      });

      output = consoleErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(output).toContain("Candidate 1");
      expect(output).toContain("Candidate 21");
      expect(output).not.toContain("Showing 20 of 21");
    });
  });

  describe("search and typed lookup commands", () => {
    const SEARCH_CSV_COLUMNS = [
      "command",
      "rowType",
      "query.mode",
      "query.term",
      "page.total",
      "page.limit",
      "page.offset",
      "page.returned",
      "page.hasMore",
      "provider.requested",
      "provider.used",
      "provider.degraded",
      "provider.fallbackReason",
      "cache.source",
      "cache.fetchedAt",
      "cache.ageSeconds",
      "execution.taskId",
      "execution.operation",
      "execution.lane",
      "execution.outcome",
      "execution.attempts",
      "candidate.rank",
      "candidate.kind",
      "candidate.name",
      "candidate.foreignId",
      "candidate.lidarrId",
      "candidate.artistName",
      "candidate.artistForeignId",
      "candidate.artistType",
      "candidate.albumType",
      "candidate.disambiguation",
      "candidate.releaseDate",
    ] as const;

    function lookupLeaf(name: "artist" | "album"): Command | undefined {
      return lidarrCommand.commands
        .find((command) => command.name() === "lookup")
        ?.commands.find((command) => command.name() === name);
    }

    function armCommanderThrow(command: Command): void {
      command.exitOverride();
      command.configureOutput({ writeErr: () => {} });
      for (const subcommand of command.commands) armCommanderThrow(subcommand);
    }

    it("exposes the shared options in help without importing the action", () => {
      const search = lidarrCommand.commands.find((command) => command.name() === "search");
      const help = [search, lookupLeaf("artist"), lookupLeaf("album")]
        .map((command) => command?.helpInformation() ?? "")
        .join("\n");

      expect(help).toContain("<term>");
      expect(help).toContain("--limit <n>");
      expect(help).toContain("--offset <n>");
      expect(help).toContain("--allow-stale");
      expect(help).toContain("--lidarr-url <url>");
      expect(help).toContain("--lidarr-api-key <key>");
      expect(mockActions.executeLidarrSearch).not.toHaveBeenCalled();
    });

    it.each([
      {
        path: ["search"],
        mode: "search",
        command: "lidarr-search",
      },
      {
        path: ["lookup", "artist"],
        mode: "artist",
        command: "lidarr-lookup-artist",
      },
      {
        path: ["lookup", "album"],
        mode: "album",
        command: "lidarr-lookup-album",
      },
    ] as const)(
      "forwards normalized terms and paging for $command",
      async ({ path, mode, command }) => {
        const result = {
          ...SEARCH_RESULT,
          query: { mode, term: "Café" },
          execution: {
            ...SEARCH_RESULT.execution,
            taskId: command,
            operation: command.replaceAll("-", " "),
          },
        };
        mockActions.executeLidarrSearch.mockResolvedValue(result);

        await rootCommand.parseAsync(
          [
            "node",
            "rfmedia",
            "--output",
            "yaml",
            "lidarr",
            ...path,
            " Cafe\u0301 ",
            "--limit",
            "12",
            "--offset",
            "4",
            "--allow-stale",
            "--lidarr-url",
            "http://localhost:8686",
            "--lidarr-api-key",
            "secret-key",
          ],
          { from: "node" },
        );

        expect(mockActions.executeLidarrSearch).toHaveBeenCalledWith({
          mode,
          term: "Café",
          limit: 12,
          offset: 4,
          allowStale: true,
          lidarrUrl: "http://localhost:8686",
          lidarrApiKey: "secret-key",
        });
        expect(mockFormatters.formatOutput).toHaveBeenCalledWith("yaml", {
          command,
          result,
        });
        expect(consoleLogSpy).not.toHaveBeenCalled();
      },
    );

    it("emits the exact successful JSON envelope without human stderr", async () => {
      const result = {
        ...SEARCH_RESULT,
        query: { mode: "album", term: "Debut" },
        results: [SEARCH_RESULT.results[1]],
        total: 1,
        returned: 1,
        execution: {
          ...SEARCH_RESULT.execution,
          taskId: "lidarr-lookup-album",
          operation: "lidarr lookup album",
        },
      };
      mockActions.executeLidarrSearch.mockResolvedValue(result);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--json", "lidarr", "lookup", "album", "Debut"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-lookup-album",
        result,
      });
      expect(capturedStderr()).toBe("");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it.each(["\u001bunsafe", "mbid:not-a-uuid"])(
      "rejects unsafe term %j before the action is reached",
      async (term) => {
        await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "search", term], {
          from: "node",
        });

        expect(mockActions.executeLidarrSearch).not.toHaveBeenCalled();
        expect(mockLogger.logError).toHaveBeenCalledWith(
          expect.stringContaining("Lidarr search failed:"),
        );
        expect(process.exitCode).toBe(1);
      },
    );

    it.each([
      ["--limit", "0"],
      ["--limit", "201"],
      ["--limit", "1.5"],
      ["--offset", "-1"],
      ["--offset", "9007199254740992"],
    ])("rejects invalid numeric option %s %s before the action", async (flag, value) => {
      armCommanderThrow(rootCommand);

      await expect(
        rootCommand.parseAsync(["node", "rfmedia", "lidarr", "search", "Björk", flag, value], {
          from: "node",
        }),
      ).rejects.toThrow();
      expect(mockActions.executeLidarrSearch).not.toHaveBeenCalled();
    });

    it("emits a summary-first fixed CSV shape even when the page is empty", async () => {
      const emptyResult = {
        ...SEARCH_RESULT,
        results: [],
        total: 0,
        returned: 0,
      };
      mockActions.executeLidarrSearch.mockResolvedValue(emptyResult);

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "csv", "lidarr", "search", "unknown"],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "csv",
        [
          expect.objectContaining({
            command: "lidarr-search",
            rowType: "summary",
            "query.mode": "search",
            "page.total": 0,
            "provider.used": "lidarr",
            "execution.taskId": "lidarr-search",
          }),
        ],
        { columns: [...SEARCH_CSV_COLUMNS] },
      );
    });

    it("preserves full identifiers and relies on the CSV formatter's formula guard", async () => {
      const formulaName = '=HYPERLINK("https://example.test")';
      mockActions.executeLidarrSearch.mockResolvedValue({
        ...SEARCH_RESULT,
        results: [{ ...SEARCH_RESULT.results[0], name: formulaName }, SEARCH_RESULT.results[1]],
      });

      await rootCommand.parseAsync(
        ["node", "rfmedia", "--output", "csv", "lidarr", "search", "Björk"],
        { from: "node" },
      );

      const csvCall = mockFormatters.formatOutput.mock.calls.at(-1);
      const rows = csvCall?.[1] as readonly Record<string, unknown>[];
      expect(rows[1]).toEqual(
        expect.objectContaining({
          "candidate.rank": 1,
          "candidate.kind": "artist",
          "candidate.name": formulaName,
          "candidate.foreignId": "87e748f1-300e-46e4-9524-a4a65d68ae24",
          "candidate.lidarrId": 8,
          "candidate.artistType": "Person",
          "candidate.disambiguation": "Icelandic singer",
        }),
      );
      expect(rows[2]).toEqual(
        expect.objectContaining({
          "candidate.rank": 2,
          "candidate.kind": "album",
          "candidate.name": "Debut",
          "candidate.foreignId": "714f3359-4499-432f-a2bd-2a3e179f6c74",
          "candidate.artistName": "Björk",
          "candidate.artistForeignId": "87e748f1-300e-46e4-9524-a4a65d68ae24",
          "candidate.albumType": "Album",
          "candidate.releaseDate": "1993-07-05",
        }),
      );
      const actualFormatters = await vi.importActual<typeof import("../lib/formatters/index.js")>(
        "../lib/formatters/index.js",
      );
      await actualFormatters.formatOutput("csv", rows, {
        columns: [...SEARCH_CSV_COLUMNS],
      });
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("\"'=HYPERLINK("));
    });

    it("renders ranked combined results with width-safe labels and full IDs to stderr only", async () => {
      const longWideName = "界".repeat(40);
      mockActions.executeLidarrSearch.mockResolvedValue({
        ...SEARCH_RESULT,
        results: [{ ...SEARCH_RESULT.results[0], name: longWideName }, SEARCH_RESULT.results[1]],
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "search", "Björk"], {
        from: "node",
      });

      const output = capturedStderr();
      const plainOutput = output.replace(/\u001b\[[\d;]*m/gu, "");
      expect(plainOutput).toContain("Lidarr Search: Björk");
      expect(plainOutput).toContain("Kind");
      expect(plainOutput).toMatch(/│\s*1\s*│\s*artist\s*│/u);
      expect(plainOutput).toMatch(/│\s*2\s*│\s*album\s*│/u);
      expect(plainOutput).toContain(`${"界".repeat(17)}…`);
      expect(plainOutput).not.toContain(longWideName);
      expect(plainOutput).toContain("87e748f1-300e-46e4-9524-a4a65d68ae24");
      expect(plainOutput).toContain("714f3359-4499-432f-a2bd-2a3e179f6c74");
      expect(mockFormatters.formatOutput).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("renders empty and degraded provenance to stderr only", async () => {
      mockActions.executeLidarrSearch.mockResolvedValue({
        ...SEARCH_RESULT,
        results: [],
        total: 0,
        returned: 0,
        provider: {
          requested: "lidarr",
          used: "sqlite-cache",
          degraded: true,
          fallbackReason: "Lidarr unavailable",
        },
        cacheStatus: {
          source: "stale-cache",
          fetchedAt: "2026-07-22T13:00:00.000Z",
          ageSeconds: 720,
        },
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "search", "Björk"], {
        from: "node",
      });

      expect(capturedStderr()).toContain("No results.");
      expect(capturedStderr()).toContain("Provider: sqlite-cache");
      expect(capturedStderr()).toContain("degraded: Lidarr unavailable");
      expect(capturedStderr()).toContain("cached 720s ago");
      expect(capturedStderr()).toContain("Execution: metadata-dependent lane");
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("redacts lookup credentials in the stable failure envelope", async () => {
      mockActions.executeLidarrSearch.mockRejectedValue(
        Object.assign(new Error("authentication failed for secret-key"), {
          code: "authentication",
          statusCode: 401,
          retryable: false,
        }),
      );

      await rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "--json",
          "lidarr",
          "lookup",
          "artist",
          "Björk",
          "--lidarr-api-key",
          "secret-key",
        ],
        { from: "node" },
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-lookup-artist",
          error: expect.objectContaining({
            message: "authentication failed for [REDACTED]",
            code: "authentication",
            outcome: "failed",
          }),
        }),
      );
      expect(JSON.stringify(mockFormatters.formatOutput.mock.calls)).not.toContain("secret-key");
      expect(process.exitCode).toBe(1);
    });
  });

  describe("health resilience block", () => {
    it("stays quiet when healthy in text mode", async () => {
      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "health"], { from: "node" });

      expect(capturedStderr()).not.toContain("Circuit [");
      expect(capturedStderr()).not.toContain("Deferred intents:");
      expect(process.exitCode).toBeUndefined();
    });

    it("renders the compact block on degradation, stderr-only", async () => {
      mockActions.executeLidarrHealth.mockResolvedValue({
        ...HEALTH_RESULT,
        resilience: DEGRADED_RESILIENCE,
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "health"], { from: "node" });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Circuit [lidarr]: open · Circuit [metadata]: closed · Deferred intents: 2 pending, 1 failed",
        ),
      );
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it("skips the block when the snapshot is absent", async () => {
      mockActions.executeLidarrHealth.mockResolvedValue({
        ...HEALTH_RESULT,
        checks: [],
        hasErrors: false,
        resilience: undefined,
      });

      await rootCommand.parseAsync(["node", "rfmedia", "lidarr", "health"], { from: "node" });

      expect(capturedStderr()).not.toContain("Circuit [");
      expect(process.exitCode).toBeUndefined();
    });

    it("passes the additive fields through the lidarr-health JSON envelope untouched", async () => {
      const degraded = { ...HEALTH_RESULT, resilience: DEGRADED_RESILIENCE };
      mockActions.executeLidarrHealth.mockResolvedValue(degraded);

      await rootCommand.parseAsync(["node", "rfmedia", "--json", "lidarr", "health"], {
        from: "node",
      });

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-health",
        result: degraded,
      });
      expect(capturedStderr()).not.toContain("Circuit [");
    });
  });
});
