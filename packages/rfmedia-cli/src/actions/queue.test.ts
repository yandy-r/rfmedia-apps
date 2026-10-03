/**
 * Integration tests for queue actions.
 *
 * Tests cover:
 * - toSerializableOptions: Conversion of CopyOptions to serializable form
 * - executeQueueAdd: Adding jobs to the queue with persistence
 * - executeQueueClear: Removing jobs from the queue
 * - executeQueueRun: Running queued jobs including multi-source jobs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// MOCK SETUP
// ============================================================================

// Mock homedir to use temp directory - must be hoisted before imports
const mockHomedir = vi.hoisted(() => vi.fn());
const mockResolveOptionalScanAdapter = vi.hoisted(() =>
  vi.fn().mockReturnValue({ adapter: undefined, scanPerSource: false }),
);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: mockHomedir,
  };
});

// Mock config to prevent tracking system interference
vi.mock("../lib/loaded-config.js", () => ({
  getLoadedConfig: vi.fn().mockReturnValue(null),
  getLoadedPlexConfig: vi.fn().mockReturnValue({}),
}));

// Mock logger to reduce test output noise
vi.mock("../lib/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/logger.js")>();
  return {
    ...original,
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logSuccess: vi.fn(),
    logError: vi.fn(),
    isJsonMode: vi.fn().mockReturnValue(false),
    isDebugMode: vi.fn().mockReturnValue(false),
  };
});

// Mock prompt to avoid interactive prompts in tests
vi.mock("../lib/prompt.js", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

// Mock copy actions for queue run tests
const mockCopyAlbum = vi.hoisted(() => ({
  executeAlbumCopyWithFileInput: vi.fn().mockResolvedValue({
    source: "/music/Artist",
    created: 10,
    skipped: 0,
    filtered: 0,
    failed: [],
  }),
}));

const mockCopyFilter = vi.hoisted(() => ({
  executeFilterCopyWithFileInput: vi.fn().mockResolvedValue({
    source: "/music/Artist",
    created: 5,
    skipped: 0,
    filtered: 3,
    failed: [],
  }),
}));

vi.mock("./copy-album.js", () => ({
  executeAlbumCopyWithFileInput: mockCopyAlbum.executeAlbumCopyWithFileInput,
}));

vi.mock("./copy-filter.js", () => ({
  executeFilterCopyWithFileInput: mockCopyFilter.executeFilterCopyWithFileInput,
}));

// Mock signal handler for queue run tests
vi.mock("../lib/signal-handler.js", () => ({
  getGlobalSignal: vi.fn().mockReturnValue({
    aborted: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }),
  registerGlobalCleanup: vi.fn(),
  unregisterGlobalCleanup: vi.fn(),
}));

// No media server is configured for these queue persistence/orchestration tests.
vi.mock("../lib/adapters/action-helpers.js", () => ({
  resolveOptionalScanAdapter: mockResolveOptionalScanAdapter,
}));

// Mock delete actions for queue run tests
const mockDeleteAlbum = vi.hoisted(() => ({
  executeAlbumDeleteWithFileInput: vi.fn().mockResolvedValue({
    source: "/music/Artist",
    deleted: 5,
    skipped: 0,
    trackingRemoved: 5,
    failed: [],
  }),
}));

const mockDeleteFilter = vi.hoisted(() => ({
  executeFilterDeleteWithFileInput: vi.fn().mockResolvedValue({
    source: "/music/Artist",
    deleted: 3,
    skipped: 0,
    trackingRemoved: 3,
    failed: [],
  }),
}));

vi.mock("./delete-album.js", () => ({
  executeAlbumDeleteWithFileInput: mockDeleteAlbum.executeAlbumDeleteWithFileInput,
}));

vi.mock("./delete-filter.js", () => ({
  executeFilterDeleteWithFileInput: mockDeleteFilter.executeFilterDeleteWithFileInput,
}));

// Import after mocks are set up
import {
  executeQueueAdd,
  executeQueueAddDelete,
  executeQueueClear,
  executeQueueRun,
  toSerializableOptions,
  toSerializableDeleteOptions,
} from "./queue.js";
import { loadQueue, addJob, resetDb } from "../lib/queue.js";
import type {
  CopyOptions,
  DeleteOptions,
  CopySelection,
  SourceSelection,
  PathEntry,
} from "../types/options.js";
import type { SerializableCopyOptions, SerializableDeleteOptions } from "../types/queue.js";

// ============================================================================
// TEST SUITES
// ============================================================================

describe("Queue Actions", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Clear call history but preserve mock implementations
    vi.clearAllMocks();

    // Create isolated temp directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-queue-actions-test-"));
    mockHomedir.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    // Close stale DB connection before removing temp directory
    resetDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // toSerializableOptions Tests
  // ==========================================================================

  describe("toSerializableOptions", () => {
    it("should exclude non-serializable selection field", () => {
      const sourceSelection: SourceSelection = {
        sourcePath: "/test/source",
        level: "album",
        selectedAlbums: ["Album1", "Album2"],
      };

      const selection: CopySelection = {
        selectedSources: ["/test/source"],
        sourceSelections: new Map([["/test/source", sourceSelection]]),
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: true,
        workers: 2,
        selection,
      };

      const serializable = toSerializableOptions(options);

      // Verify non-serializable fields are excluded
      expect(serializable).not.toHaveProperty("selection");
      expect(serializable).not.toHaveProperty("dryRun");

      // Verify serializable fields are preserved
      expect(serializable.mode).toEqual({
        type: "album",
        range: { start: 1, end: 5, padWidth: 3 },
      });
      expect(serializable.workers).toBe(2);
      expect(serializable.albumOnly).toBe(false);
      expect(serializable.hardlink).toBe(false);
      expect(serializable.force).toBe(false);
    });

    it("should preserve all serializable fields for album mode", () => {
      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: true,
        hardlink: true,
        convertFormat: "mp3",
        force: true,
        dryRun: false,
        workers: 4,
        file: "/path/to/sources.txt",
        progress: true,
        plexScan: true,
        plexLibrary: "Music",
      };

      const serializable = toSerializableOptions(options);

      expect(serializable.mode).toEqual({
        type: "album",
        range: { start: 1, end: 10, padWidth: 3 },
      });
      expect(serializable.albumOnly).toBe(true);
      expect(serializable.hardlink).toBe(true);
      expect(serializable.convertFormat).toBe("mp3");
      expect(serializable.force).toBe(true);
      expect(serializable.workers).toBe(4);
      expect(serializable.file).toBe("/path/to/sources.txt");
      expect(serializable.progress).toBe(true);
      expect(serializable.plexScan).toBe(true);
      expect(serializable.plexLibrary).toBe("Music");
    });

    it("should preserve all serializable fields for filter mode", () => {
      const options: CopyOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "liked-songs",
            preserveStructure: true,
            albumMode: true,
          },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: true,
        workers: 2,
      };

      const serializable = toSerializableOptions(options);

      expect(serializable.mode.type).toBe("filter");
      if (serializable.mode.type === "filter") {
        expect(serializable.mode.rating.minStars).toBe(4.0);
        expect(serializable.mode.rating.outputFolder).toBe("liked-songs");
        expect(serializable.mode.rating.preserveStructure).toBe(true);
        expect(serializable.mode.rating.albumMode).toBe(true);
      }
    });

    it("should handle options with undefined optional fields", () => {
      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
        // All optional fields are undefined
      };

      const serializable = toSerializableOptions(options);

      // Result should be serializable to JSON
      expect(() => JSON.stringify(serializable)).not.toThrow();

      // Verify the result can be parsed back
      const parsed = JSON.parse(JSON.stringify(serializable));
      expect(parsed.mode.type).toBe("album");
      expect(parsed.workers).toBe(1);
    });
  });

  // ==========================================================================
  // executeQueueAdd Tests
  // ==========================================================================

  describe("executeQueueAdd", () => {
    it("should add job to queue and persist correctly", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      const job = await executeQueueAdd("/source/path", "/dest/path", copyOptions, {
        dryRun: false,
      });

      // Verify job was created
      expect(job.source).toBe("/source/path");
      expect(job.destination).toBe("/dest/path");
      expect(job.status).toBe("pending");
      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // Verify job was persisted to queue
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.id).toBe(job.id);
      expect(queue.jobs[0]?.source).toBe("/source/path");
    });

    it("should not persist job in dry-run mode", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      const job = await executeQueueAdd("/source/path", "/dest/path", copyOptions, {
        dryRun: true,
      });

      // Verify mock job was returned
      expect(job.id).toBe("dry-run");
      expect(job.source).toBe("/source/path");
      expect(job.destination).toBe("/dest/path");
      expect(job.status).toBe("pending");

      // Verify queue is empty (not persisted)
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(0);
    });

    it("should add multiple jobs to queue", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 3, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      await executeQueueAdd("/source1", "/dest1", copyOptions, { dryRun: false });
      await executeQueueAdd("/source2", "/dest2", copyOptions, { dryRun: false });
      await executeQueueAdd("/source3", "/dest3", copyOptions, { dryRun: false });

      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(3);
      expect(queue.jobs[0]?.source).toBe("/source1");
      expect(queue.jobs[1]?.source).toBe("/source2");
      expect(queue.jobs[2]?.source).toBe("/source3");
    });

    it("should serialize filter mode options correctly", async () => {
      const copyOptions: CopyOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "favorites",
            preserveStructure: true,
          },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 2,
      };

      const job = await executeQueueAdd("/music/artist", "/dest", copyOptions, { dryRun: false });

      expect(job.options.mode.type).toBe("filter");
      if (job.options.mode.type === "filter") {
        expect(job.options.mode.rating.minStars).toBe(4.0);
        expect(job.options.mode.rating.outputFolder).toBe("favorites");
      }

      // Verify it was persisted correctly
      const queue = await loadQueue();
      const savedJob = queue.jobs[0];
      expect(savedJob?.options.mode.type).toBe("filter");
    });
  });

  // ==========================================================================
  // executeQueueAdd with Multi-Source (--paths YAML) Tests
  // ==========================================================================

  describe("executeQueueAdd with sources parameter", () => {
    it("should create multi-source job when sources array is provided via addJob", async () => {
      const sources: PathEntry[] = [
        { path: "/music/Artist1" },
        { path: "/music/Artist2" },
        { path: "/music/Artist3" },
      ];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      // Use addJob directly which supports multi-source (from lib/queue.ts)
      const job = await addJob(sources, "/dest/path", options);

      // Verify multi-source job structure
      expect(job.sources).toBeDefined();
      expect(job.sources).toHaveLength(3);
      expect(job.sources?.[0]?.path).toBe("/music/Artist1");
      expect(job.sources?.[1]?.path).toBe("/music/Artist2");
      expect(job.sources?.[2]?.path).toBe("/music/Artist3");

      // Verify single source field is not set
      expect(job.source).toBeUndefined();

      // Verify job was persisted correctly
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.sources).toHaveLength(3);
    });

    it("should preserve PathEntry properties in multi-source job", async () => {
      const sources: PathEntry[] = [
        {
          path: "/music/Artist1/Album1",
          range: { start: 1, end: 3, padWidth: 3 },
          filterName: "liked",
        },
        {
          path: "/music/Artist2/Album2",
          count: 5,
          outputFolder: "custom-output",
        },
      ];

      const options: SerializableCopyOptions = {
        mode: {
          type: "filter",
          rating: { minStars: 4.0, outputFolder: "favorites", preserveStructure: true },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 2,
      };

      const job = await addJob(sources, "/dest/from/yaml", options);

      // Verify PathEntry properties are preserved
      expect(job.sources?.[0]?.path).toBe("/music/Artist1/Album1");
      expect(job.sources?.[0]?.range).toEqual({ start: 1, end: 3, padWidth: 3 });
      expect(job.sources?.[0]?.filterName).toBe("liked");

      expect(job.sources?.[1]?.path).toBe("/music/Artist2/Album2");
      expect(job.sources?.[1]?.count).toBe(5);
      expect(job.sources?.[1]?.outputFolder).toBe("custom-output");

      // Verify serialization round-trip preserves DB-stored fields
      // Note: filterName and outputFolder are NOT stored in the DB schema
      // (queue_job_sources table only stores: path, sourceIndex, sourceNames,
      //  sourceArtist, sourceGroups, range, count)
      const queue = await loadQueue();
      const savedJob = queue.jobs[0];
      expect(savedJob?.sources?.[0]?.path).toBe("/music/Artist1/Album1");
      expect(savedJob?.sources?.[0]?.range).toEqual({ start: 1, end: 3, padWidth: 3 });
      expect(savedJob?.sources?.[1]?.count).toBe(5);
    });

    it("should use YAML destination when multi-source job is created", async () => {
      const sources: PathEntry[] = [
        { path: "/music/PopDivas/Madonna" },
        { path: "/music/PopDivas/Beyonce" },
      ];

      const yamlDestination = "/output/pop-divas-collection";

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob(sources, yamlDestination, options);

      // Verify YAML-provided destination is used
      expect(job.destination).toBe("/output/pop-divas-collection");

      // Verify persistence
      const queue = await loadQueue();
      expect(queue.jobs[0]?.destination).toBe("/output/pop-divas-collection");
    });

    it("should store source selection tracking fields for verbose display", async () => {
      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
        // Source selection tracking fields (document what selection was applied)
        sourceIdx: "1,3",
        sourceName: "Madonna",
        sourceArtist: "Pop Divas",
        sourceGroup: "favorites",
      };

      const job = await addJob(sources, "/dest", options);

      // Verify source selection fields are preserved for display
      expect(job.options.sourceIdx).toBe("1,3");
      expect(job.options.sourceName).toBe("Madonna");
      expect(job.options.sourceArtist).toBe("Pop Divas");
      expect(job.options.sourceGroup).toBe("favorites");

      // Verify serialization round-trip
      const queue = await loadQueue();
      const savedJob = queue.jobs[0];
      expect(savedJob?.options.sourceIdx).toBe("1,3");
      expect(savedJob?.options.sourceGroup).toBe("favorites");
    });

    it("should create single-source job when string is provided (backward compat)", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/music/Artist", "/dest", options);

      // Verify single-source structure
      expect(job.source).toBe("/music/Artist");
      expect(job.sources).toBeUndefined();

      // Verify persistence
      const queue = await loadQueue();
      expect(queue.jobs[0]?.source).toBe("/music/Artist");
      expect(queue.jobs[0]?.sources).toBeUndefined();
    });

    it("should handle empty sources array gracefully", async () => {
      const sources: PathEntry[] = [];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob(sources, "/dest", options);

      // Empty array should still create job with sources field
      expect(job.sources).toBeDefined();
      expect(job.sources).toHaveLength(0);
      expect(job.source).toBeUndefined();
    });

    it("should auto-enable filter mode from YAML filters in options", async () => {
      // When loadAndValidatePathsYaml returns hasYamlFilters: true,
      // the command handler should set options.filter = firstFilterName
      // This test verifies that filter mode options are preserved in the job

      const sources: PathEntry[] = [
        { path: "/music/Artist1", filterName: "liked" },
        { path: "/music/Artist2", filterName: "liked" },
      ];

      const options: SerializableCopyOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "liked-songs",
            preserveStructure: true,
            albumMode: true,
          },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob(sources, "/dest/from/yaml", options);

      // Verify filter mode is set correctly
      expect(job.options.mode.type).toBe("filter");
      if (job.options.mode.type === "filter") {
        expect(job.options.mode.rating.minStars).toBe(4.0);
        expect(job.options.mode.rating.outputFolder).toBe("liked-songs");
        expect(job.options.mode.rating.albumMode).toBe(true);
      }

      // Verify source filter names are preserved
      expect(job.sources?.[0]?.filterName).toBe("liked");
      expect(job.sources?.[1]?.filterName).toBe("liked");
    });

    it("should support mixed PathEntry properties for different sources", async () => {
      // Real-world YAML may have different settings per source
      const sources: PathEntry[] = [
        {
          path: "/music/Artist1",
          filterName: "liked",
          outputFolder: "pop-liked",
        },
        {
          path: "/music/Artist2",
          filterName: "favorites",
          outputFolder: "rock-favorites",
        },
        {
          path: "/music/Artist3",
          // No filter, just default settings
        },
      ];

      const options: SerializableCopyOptions = {
        mode: {
          type: "filter",
          rating: { minStars: 4.0, outputFolder: "default", preserveStructure: true },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 2,
      };

      const job = await addJob(sources, "/dest", options);

      expect(job.sources).toHaveLength(3);
      expect(job.sources?.[0]?.filterName).toBe("liked");
      expect(job.sources?.[0]?.outputFolder).toBe("pop-liked");
      expect(job.sources?.[1]?.filterName).toBe("favorites");
      expect(job.sources?.[1]?.outputFolder).toBe("rock-favorites");
      expect(job.sources?.[2]?.filterName).toBeUndefined();
      expect(job.sources?.[2]?.outputFolder).toBeUndefined();
    });
  });

  // ==========================================================================
  // executeQueueClear Tests
  // ==========================================================================

  describe("executeQueueClear", () => {
    it("should remove all jobs with force flag", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      // Add jobs to the queue
      await executeQueueAdd("/s1", "/d1", copyOptions, { dryRun: false });
      await executeQueueAdd("/s2", "/d2", copyOptions, { dryRun: false });

      // Verify jobs were added
      let queue = await loadQueue();
      expect(queue.jobs).toHaveLength(2);

      // Clear the queue with force flag
      const result = await executeQueueClear({ force: true, dryRun: false });

      expect(result.removed).toBe(2);
      expect(result.remaining).toBe(0);

      // Verify queue is empty
      queue = await loadQueue();
      expect(queue.jobs).toHaveLength(0);
    });

    it("should not remove jobs in dry-run mode", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      // Add jobs to the queue
      await executeQueueAdd("/s1", "/d1", copyOptions, { dryRun: false });
      await executeQueueAdd("/s2", "/d2", copyOptions, { dryRun: false });

      // Clear in dry-run mode
      const result = await executeQueueClear({ force: true, dryRun: true });

      expect(result.removed).toBe(0);

      // Verify jobs are still in queue
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(2);
    });

    it("should return empty result when queue is already empty", async () => {
      const result = await executeQueueClear({ force: true, dryRun: false });

      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it("should clear only jobs with specified status", async () => {
      const copyOptions: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
      };

      // Add jobs to the queue
      await executeQueueAdd("/s1", "/d1", copyOptions, { dryRun: false });
      await executeQueueAdd("/s2", "/d2", copyOptions, { dryRun: false });

      // Load and manually update one job to completed status
      const { updateJobStatus } = await import("../lib/queue.js");
      let queue = await loadQueue();
      const jobToComplete = queue.jobs[0];
      if (jobToComplete) {
        await updateJobStatus(jobToComplete.id, "completed");
      }

      // Clear only completed jobs
      const result = await executeQueueClear({ status: "completed", force: true, dryRun: false });

      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);

      // Verify only pending job remains
      queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.status).toBe("pending");
    });
  });

  // ==========================================================================
  // executeQueueRun Tests - Multi-Source Jobs
  // ==========================================================================

  describe("executeQueueRun with multi-source jobs", () => {
    it("should populate cliSourceEntries from job.sources for album mode", async () => {
      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      // Create multi-source job directly using addJob
      await addJob(sources, "/dest", options);

      // Run queue
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      // Verify executeAlbumCopyWithFileInput was called
      expect(mockCopyAlbum.executeAlbumCopyWithFileInput).toHaveBeenCalled();

      // Verify cliSourceEntries was populated from job.sources
      const callArgs = mockCopyAlbum.executeAlbumCopyWithFileInput.mock.calls[0];
      expect(callArgs).toBeDefined();
      const copyOptions = callArgs?.[2];
      expect(copyOptions?.cliSourceEntries).toHaveLength(2);
      expect(copyOptions?.cliSourceEntries?.[0]?.path).toBe("/music/Artist1");
      expect(copyOptions?.cliSourceEntries?.[1]?.path).toBe("/music/Artist2");
    });

    it("should populate cliSourceEntries from job.sources for filter mode", async () => {
      const sources: PathEntry[] = [
        { path: "/music/Artist1", filterName: "liked" },
        { path: "/music/Artist2", filterName: "liked" },
        { path: "/music/Artist3", filterName: "liked" },
      ];

      const options: SerializableCopyOptions = {
        mode: {
          type: "filter",
          rating: { minStars: 4.0, outputFolder: "liked-songs", preserveStructure: true },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      // Create multi-source job directly using addJob
      await addJob(sources, "/dest", options);

      // Run queue
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      // Verify executeFilterCopyWithFileInput was called
      expect(mockCopyFilter.executeFilterCopyWithFileInput).toHaveBeenCalled();

      // Verify cliSourceEntries was populated from job.sources
      const callArgs = mockCopyFilter.executeFilterCopyWithFileInput.mock.calls[0];
      expect(callArgs).toBeDefined();
      const copyOptions = callArgs?.[2];
      expect(copyOptions?.cliSourceEntries).toHaveLength(3);
      expect(copyOptions?.cliSourceEntries?.[0]?.path).toBe("/music/Artist1");
      expect(copyOptions?.cliSourceEntries?.[1]?.path).toBe("/music/Artist2");
      expect(copyOptions?.cliSourceEntries?.[2]?.path).toBe("/music/Artist3");
    });

    it("should use first source path as sourcePath for multi-source jobs", async () => {
      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 3, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob(sources, "/dest", options);
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      // Verify the first argument (sourcePath) is the first source's path
      const callArgs = mockCopyAlbum.executeAlbumCopyWithFileInput.mock.calls[0];
      expect(callArgs?.[0]).toBe("/music/Artist1");
      // Verify the second argument (destination)
      expect(callArgs?.[1]).toBe("/dest");
    });

    it("should preserve PathEntry fields in cliSourceEntries", async () => {
      const sources: PathEntry[] = [
        {
          path: "/music/Artist1",
          range: { start: 1, end: 3, padWidth: 3 },
          filterName: "liked",
          outputFolder: "custom-output",
          sourceNames: ["artist1", "pop"],
          sourceGroups: ["pop-divas"],
          sourceArtist: "Artist One",
          sourceIndex: 1,
        },
        {
          path: "/music/Artist2",
          count: 5,
          sourceIndex: 2,
        },
      ];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob(sources, "/dest", options);
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      const callArgs = mockCopyAlbum.executeAlbumCopyWithFileInput.mock.calls[0];
      const cliSourceEntries = callArgs?.[2]?.cliSourceEntries;

      expect(cliSourceEntries).toHaveLength(2);

      // Verify first entry preserves DB-stored fields
      // Note: filterName and outputFolder are NOT stored in the DB schema
      // (queue_job_sources only stores: path, sourceIndex, sourceNames,
      //  sourceArtist, sourceGroups, range, count)
      const firstEntry = cliSourceEntries?.[0];
      expect(firstEntry?.path).toBe("/music/Artist1");
      expect(firstEntry?.range).toEqual({ start: 1, end: 3, padWidth: 3 });
      expect(firstEntry?.sourceNames).toEqual(["artist1", "pop"]);
      expect(firstEntry?.sourceGroups).toEqual(["pop-divas"]);
      expect(firstEntry?.sourceArtist).toBe("Artist One");
      expect(firstEntry?.sourceIndex).toBe(1);

      // Verify second entry preserves its fields
      const secondEntry = cliSourceEntries?.[1];
      expect(secondEntry?.path).toBe("/music/Artist2");
      expect(secondEntry?.count).toBe(5);
      expect(secondEntry?.sourceIndex).toBe(2);
    });

    it("should not set cliSourceEntries for single-source jobs", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      // Create single-source job
      await addJob("/music/SingleArtist", "/dest", options);
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      const callArgs = mockCopyAlbum.executeAlbumCopyWithFileInput.mock.calls[0];
      expect(callArgs?.[0]).toBe("/music/SingleArtist");
      // cliSourceEntries should not be set for single-source jobs
      expect(callArgs?.[2]?.cliSourceEntries).toBeUndefined();
    });

    it("should process all sources when cliSourceEntries is populated", async () => {
      const sources: PathEntry[] = [
        { path: "/music/Artist1" },
        { path: "/music/Artist2" },
        { path: "/music/Artist3" },
        { path: "/music/Artist4" },
        { path: "/music/Artist5" },
      ];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob(sources, "/dest", options);
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      // Verify all 5 sources are passed via cliSourceEntries
      const callArgs = mockCopyAlbum.executeAlbumCopyWithFileInput.mock.calls[0];
      expect(callArgs?.[2]?.cliSourceEntries).toHaveLength(5);
    });

    it("should complete multi-source job and mark as completed in queue", async () => {
      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob(sources, "/dest", options);

      // Verify job is in queue before run
      let queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.status).toBe("pending");

      const result = await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);

      // Verify job is marked as completed (kept in queue for history/search)
      queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.status).toBe("completed");
    });
  });

  // ==========================================================================
  // toSerializableDeleteOptions Tests
  // ==========================================================================

  describe("toSerializableDeleteOptions", () => {
    it("should exclude non-serializable selection field", () => {
      const deleteOptions: DeleteOptions = {
        mode: { type: "album", range: { start: 8, end: 10, padWidth: 3 } },
        albumOnly: false,
        force: false,
        dryRun: true,
        workers: 2,
        useTrash: true,
        keepTracking: false,
        selection: {
          selectedSources: ["/test/source"],
          sourceSelections: new Map(),
        },
      };

      const serializable = toSerializableDeleteOptions(deleteOptions);

      // Verify non-serializable fields are excluded
      expect(serializable).not.toHaveProperty("selection");
      expect(serializable).not.toHaveProperty("dryRun");

      // Verify serializable fields are preserved
      expect(serializable.mode).toEqual({
        type: "album",
        range: { start: 8, end: 10, padWidth: 3 },
      });
      expect(serializable.workers).toBe(2);
      expect(serializable.useTrash).toBe(true);
      expect(serializable.keepTracking).toBe(false);
    });

    it("should preserve all serializable fields for album mode delete", () => {
      const deleteOptions: DeleteOptions = {
        mode: { type: "album", range: { start: 5, end: 10, padWidth: 3 } },
        albumOnly: true,
        convertFormat: "mp3",
        force: true,
        dryRun: false,
        workers: 4,
        file: "/path/to/sources.txt",
        progress: true,
        useTrash: false,
        keepTracking: true,
        plexScan: true,
        plexLibrary: "Music",
      };

      const serializable = toSerializableDeleteOptions(deleteOptions);

      expect(serializable.mode).toEqual({
        type: "album",
        range: { start: 5, end: 10, padWidth: 3 },
      });
      expect(serializable.albumOnly).toBe(true);
      expect(serializable.convertFormat).toBe("mp3");
      expect(serializable.force).toBe(true);
      expect(serializable.workers).toBe(4);
      expect(serializable.file).toBe("/path/to/sources.txt");
      expect(serializable.progress).toBe(true);
      expect(serializable.useTrash).toBe(false);
      expect(serializable.keepTracking).toBe(true);
      expect(serializable.plexScan).toBe(true);
      expect(serializable.plexLibrary).toBe("Music");
    });

    it("should preserve all serializable fields for filter mode delete", () => {
      const deleteOptions: DeleteOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "liked-songs",
            preserveStructure: true,
            albumMode: true,
          },
        },
        albumOnly: false,
        force: false,
        dryRun: true,
        workers: 2,
        useTrash: true,
        keepTracking: false,
      };

      const serializable = toSerializableDeleteOptions(deleteOptions);

      expect(serializable.mode.type).toBe("filter");
      if (serializable.mode.type === "filter") {
        expect(serializable.mode.rating.minStars).toBe(4.0);
        expect(serializable.mode.rating.outputFolder).toBe("liked-songs");
        expect(serializable.mode.rating.preserveStructure).toBe(true);
        expect(serializable.mode.rating.albumMode).toBe(true);
      }
      expect(serializable.useTrash).toBe(true);
      expect(serializable.keepTracking).toBe(false);
    });
  });

  // ==========================================================================
  // executeQueueAddDelete Tests
  // ==========================================================================

  describe("executeQueueAddDelete", () => {
    it("should add delete job to queue and persist correctly", async () => {
      const deleteOptions: DeleteOptions = {
        mode: { type: "album", range: { start: 8, end: 10, padWidth: 3 } },
        albumOnly: false,
        force: false,
        dryRun: false,
        workers: 1,
        useTrash: true,
        keepTracking: false,
      };

      const job = await executeQueueAddDelete("/source/path", "/dest/path", deleteOptions, {
        dryRun: false,
      });

      // Verify job was created with correct jobType
      expect(job.jobType).toBe("delete");
      expect(job.source).toBe("/source/path");
      expect(job.destination).toBe("/dest/path");
      expect(job.status).toBe("pending");
      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      // Verify delete-specific options are preserved
      const opts = job.options as SerializableDeleteOptions;
      expect(opts.useTrash).toBe(true);
      expect(opts.keepTracking).toBe(false);

      // Verify job was persisted to queue
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.id).toBe(job.id);
      expect(queue.jobs[0]?.jobType).toBe("delete");
      expect(queue.jobs[0]?.source).toBe("/source/path");
    });

    it("should not persist delete job in dry-run mode", async () => {
      const deleteOptions: DeleteOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        force: false,
        dryRun: false,
        workers: 1,
        useTrash: false,
        keepTracking: false,
      };

      const job = await executeQueueAddDelete("/source/path", "/dest/path", deleteOptions, {
        dryRun: true,
      });

      // Verify mock job was returned
      expect(job.id).toBe("dry-run");
      expect(job.jobType).toBe("delete");
      expect(job.source).toBe("/source/path");
      expect(job.destination).toBe("/dest/path");
      expect(job.status).toBe("pending");

      // Verify queue is empty (not persisted)
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(0);
    });

    it("should create multi-source delete job with sources parameter", async () => {
      const sources: PathEntry[] = [
        { path: "/music/Artist1" },
        { path: "/music/Artist2" },
        { path: "/music/Artist3" },
      ];

      const deleteOptions: DeleteOptions = {
        mode: { type: "album" },
        albumOnly: false,
        force: false,
        dryRun: false,
        workers: 1,
        useTrash: false,
        keepTracking: false,
        count: 3,
      };

      const job = await executeQueueAddDelete(
        "/music/Artist1",
        "/dest/path",
        deleteOptions,
        { dryRun: false },
        sources,
      );

      // Verify multi-source job structure
      expect(job.jobType).toBe("delete");
      expect(job.sources).toBeDefined();
      expect(job.sources).toHaveLength(3);
      expect(job.sources?.[0]?.path).toBe("/music/Artist1");
      expect(job.source).toBeUndefined();

      // Verify persistence
      const queue = await loadQueue();
      expect(queue.jobs[0]?.sources).toHaveLength(3);
      expect(queue.jobs[0]?.jobType).toBe("delete");
    });

    it("should serialize filter mode delete options correctly", async () => {
      const deleteOptions: DeleteOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "liked-songs",
            preserveStructure: false,
            albumMode: true,
          },
        },
        albumOnly: false,
        force: false,
        dryRun: false,
        workers: 2,
        useTrash: true,
        keepTracking: false,
      };

      const job = await executeQueueAddDelete("/music/artist", "/dest", deleteOptions, {
        dryRun: false,
      });

      expect(job.jobType).toBe("delete");
      expect(job.options.mode.type).toBe("filter");
      if (job.options.mode.type === "filter") {
        expect(job.options.mode.rating.minStars).toBe(4.0);
        expect(job.options.mode.rating.outputFolder).toBe("liked-songs");
      }

      // Verify it was persisted correctly
      const queue = await loadQueue();
      const savedJob = queue.jobs[0];
      expect(savedJob?.jobType).toBe("delete");
      expect(savedJob?.options.mode.type).toBe("filter");
    });
  });

  // ==========================================================================
  // executeQueueRun Tests - Delete Jobs
  // ==========================================================================

  describe("executeQueueRun with delete jobs", () => {
    it("should execute delete album job correctly", async () => {
      const options: SerializableDeleteOptions = {
        mode: { type: "album", range: { start: 8, end: 10, padWidth: 3 } },
        albumOnly: false,
        force: false,
        workers: 1,
        useTrash: false,
        keepTracking: false,
      };

      await addJob("/music/Artist", "/dest", options, "delete");

      const result = await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockDeleteAlbum.executeAlbumDeleteWithFileInput).toHaveBeenCalled();
    });

    it("should execute delete filter job correctly", async () => {
      const options: SerializableDeleteOptions = {
        mode: {
          type: "filter",
          rating: {
            minStars: 4.0,
            outputFolder: "liked-songs",
            preserveStructure: false,
          },
        },
        albumOnly: false,
        force: false,
        workers: 1,
        useTrash: true,
        keepTracking: false,
      };

      await addJob("/music/Artist", "/dest", options, "delete");

      const result = await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockDeleteFilter.executeFilterDeleteWithFileInput).toHaveBeenCalled();
    });

    it("should handle mixed copy and delete jobs in same queue", async () => {
      const copyOptions: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const deleteOptions: SerializableDeleteOptions = {
        mode: { type: "album", range: { start: 8, end: 10, padWidth: 3 } },
        albumOnly: false,
        force: false,
        workers: 1,
        useTrash: false,
        keepTracking: false,
      };

      // Add both copy and delete jobs
      await addJob("/music/Artist1", "/dest", copyOptions, "copy");
      await addJob("/music/Artist2", "/dest", deleteOptions, "delete");

      const result = await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      expect(result.total).toBe(2);
      expect(result.completed).toBe(2);
      expect(result.failed).toBe(0);

      // Verify both handlers were called
      expect(mockCopyAlbum.executeAlbumCopyWithFileInput).toHaveBeenCalled();
      expect(mockDeleteAlbum.executeAlbumDeleteWithFileInput).toHaveBeenCalled();
    });

    it("should populate cliSourceEntries from job.sources for delete jobs", async () => {
      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const options: SerializableDeleteOptions = {
        mode: { type: "album" },
        albumOnly: false,
        force: false,
        workers: 1,
        useTrash: false,
        keepTracking: false,
        count: 3,
      };

      await addJob(sources, "/dest", options, "delete");
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      // Verify executeAlbumDeleteWithFileInput was called
      expect(mockDeleteAlbum.executeAlbumDeleteWithFileInput).toHaveBeenCalled();

      // Verify cliSourceEntries was populated from job.sources
      const callArgs = mockDeleteAlbum.executeAlbumDeleteWithFileInput.mock.calls[0];
      expect(callArgs).toBeDefined();
      const deleteOpts = callArgs?.[2];
      expect(deleteOpts?.cliSourceEntries).toHaveLength(2);
      expect(deleteOpts?.cliSourceEntries?.[0]?.path).toBe("/music/Artist1");
      expect(deleteOpts?.cliSourceEntries?.[1]?.path).toBe("/music/Artist2");
    });

    it("should use trash and keepTracking options from delete job", async () => {
      const options: SerializableDeleteOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        force: false,
        workers: 1,
        useTrash: true,
        keepTracking: true,
      };

      await addJob("/music/Artist", "/dest", options, "delete");
      await executeQueueRun({ workers: 1, continueOnError: false, dryRun: false });

      const callArgs = mockDeleteAlbum.executeAlbumDeleteWithFileInput.mock.calls[0];
      const deleteOpts = callArgs?.[2];
      expect(deleteOpts?.useTrash).toBe(true);
      expect(deleteOpts?.keepTracking).toBe(true);
    });
  });

  // ==========================================================================
  // Backward Compatibility Tests
  // ==========================================================================

  describe("Backward compatibility", () => {
    it("should migrate jobs without jobType to copy type", async () => {
      // Write a legacy JSON queue file directly to disk before any loadQueue() call.
      // migrateFromJsonIfNeeded() reads from ~/.rfmedia/queue.json (where ~ = tempDir)
      // and adds missing jobType: "copy" to legacy jobs during migration.
      const rfmediaDir = join(tempDir, ".rfmedia");
      await mkdir(rfmediaDir, { recursive: true });

      const legacyQueueData = {
        version: "1",
        updatedAt: new Date().toISOString(),
        jobs: [
          {
            id: "old-job-id",
            addedAt: new Date().toISOString(),
            source: "/old/source",
            destination: "/old/dest",
            options: {
              mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
              albumOnly: false,
              hardlink: false,
              force: false,
              workers: 1,
            },
            status: "pending",
            // Intentionally omitting jobType to simulate legacy format
          },
        ],
      };

      await writeFile(join(rfmediaDir, "queue.json"), JSON.stringify(legacyQueueData), "utf-8");

      // loadQueue() initializes DB and triggers migrateFromJsonIfNeeded(),
      // which reads the JSON file, adds jobType: "copy", and inserts into DB.
      const reloadedQueue = await loadQueue();
      expect(reloadedQueue.jobs).toHaveLength(1);
      expect(reloadedQueue.jobs[0]?.jobType).toBe("copy");
    });
  });
});
