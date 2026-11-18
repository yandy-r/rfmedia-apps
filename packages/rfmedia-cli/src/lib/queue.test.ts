/**
 * Unit tests for queue library.
 *
 * Tests queue database operations including load, add, remove,
 * and status tracking functionality.
 *
 * The queue uses SQLite (via better-sqlite3) as its storage backend.
 * Each test gets a fresh database by resetting the singleton connection
 * and pointing homedir to a new temp directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock homedir to use temp directory
const mockHomedir = vi.hoisted(() => vi.fn());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: mockHomedir,
  };
});

import {
  getQueuePath,
  loadQueue,
  addJob,
  getJobs,
  updateJobStatus,
  removeJob,
  removeJobsByStatus,
  getQueueStats,
  resetDb,
} from "./queue.js";
import type { SerializableCopyOptions } from "../types/queue.js";
import type { PathEntry } from "../types/options.js";

describe("Queue Library", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-queue-test-"));
    mockHomedir.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    // Close the database connection before removing the temp directory
    // to avoid SQLITE_READONLY_DBMOVED errors on subsequent tests
    resetDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("getQueuePath", () => {
    it("should return legacy JSON path under home directory", () => {
      const path = getQueuePath();
      expect(path).toBe(join(tempDir, ".rfmedia", "queue.json"));
    });
  });

  describe("loadQueue", () => {
    it("should return empty queue when no jobs exist", async () => {
      const queue = await loadQueue();
      expect(queue.version).toBe("1");
      expect(queue.jobs).toEqual([]);
    });

    it("should handle corrupted legacy JSON file gracefully", async () => {
      // Create the .rfmedia directory with a corrupted JSON file
      await mkdir(join(tempDir, ".rfmedia"), { recursive: true });
      await writeFile(join(tempDir, ".rfmedia", "queue.json"), "invalid json", "utf-8");

      // loadQueue initializes DB and attempts JSON migration (which fails gracefully)
      const queue = await loadQueue();
      expect(queue.jobs).toEqual([]);
      expect(queue.version).toBe("1");
    });

    it("should migrate valid legacy JSON file to database", async () => {
      // Create the .rfmedia directory with a valid JSON queue file
      await mkdir(join(tempDir, ".rfmedia"), { recursive: true });

      const validQueue = {
        version: "1",
        updatedAt: "2024-01-15T10:00:00.000Z",
        jobs: [
          {
            id: "test-id-123",
            jobType: "copy",
            addedAt: "2024-01-15T09:00:00.000Z",
            source: "/source",
            destination: "/dest",
            options: {
              mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
              albumOnly: false,
              hardlink: false,
              force: false,
              workers: 1,
            },
            status: "pending",
          },
        ],
      };

      await writeFile(join(tempDir, ".rfmedia", "queue.json"), JSON.stringify(validQueue), "utf-8");

      // loadQueue initializes DB and migrates the JSON file
      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.id).toBe("test-id-123");
    });
  });

  describe("addJob", () => {
    it("should add job with UUID and persist", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/source", "/dest", options);

      expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(job.source).toBe("/source");
      expect(job.destination).toBe("/dest");
      expect(job.status).toBe("pending");
      expect(job.addedAt).toBeDefined();

      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(1);
      expect(queue.jobs[0]?.id).toBe(job.id);
    });

    it("should add multiple jobs", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);
      await addJob("/source2", "/dest2", options);
      await addJob("/source3", "/dest3", options);

      const queue = await loadQueue();
      expect(queue.jobs).toHaveLength(3);
    });

    it("should create multi-source job with sources field", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const job = await addJob(sources, "/dest", options);

      expect(job.sources).toEqual(sources);
      expect(job.source).toBeUndefined();
      expect(job.destination).toBe("/dest");
      expect(job.status).toBe("pending");
    });

    it("should create single-source job with source field (backward compat)", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/music/Artist", "/dest", options);

      expect(job.source).toBe("/music/Artist");
      expect(job.sources).toBeUndefined();
      expect(job.destination).toBe("/dest");
      expect(job.status).toBe("pending");
    });

    it("should preserve database-supported PathEntry fields through serialization", async () => {
      const options: SerializableCopyOptions = {
        mode: {
          type: "filter",
          rating: { minRating: 0.8, outputFolder: "liked-songs", preserveStructure: false },
        },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const sources: PathEntry[] = [
        {
          path: "/music/Artist1",
          range: { start: 1, end: 3, padWidth: 3 },
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

      const job = await addJob(sources, "/dest", options);

      // Reload from database to verify serialization round-trip
      const queue = await loadQueue();
      const loadedJob = queue.jobs.find((j) => j.id === job.id);

      expect(loadedJob).toBeDefined();
      expect(loadedJob?.sources).toHaveLength(2);

      // Verify fields that survive database round-trip
      const source0 = loadedJob?.sources?.[0];
      expect(source0?.path).toBe("/music/Artist1");
      expect(source0?.range?.start).toBe(1);
      expect(source0?.range?.end).toBe(3);
      expect(source0?.sourceNames).toEqual(["artist1", "pop"]);
      expect(source0?.sourceGroups).toEqual(["pop-divas"]);
      expect(source0?.sourceArtist).toBe("Artist One");
      expect(source0?.sourceIndex).toBe(1);

      const source1 = loadedJob?.sources?.[1];
      expect(source1?.path).toBe("/music/Artist2");
      expect(source1?.count).toBe(5);
      expect(source1?.sourceIndex).toBe(2);

      expect(loadedJob?.source).toBeUndefined();
    });
  });

  describe("getJobs", () => {
    it("should return all jobs when no status filter", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);
      await addJob("/source2", "/dest2", options);

      const all = await getJobs();
      expect(all).toHaveLength(2);
    });

    it("should filter by status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);
      const job2 = await addJob("/source2", "/dest2", options);
      await updateJobStatus(job2.id, "completed");

      const pending = await getJobs("pending");
      expect(pending).toHaveLength(1);

      const completed = await getJobs("completed");
      expect(completed).toHaveLength(1);

      const all = await getJobs();
      expect(all).toHaveLength(2);
    });

    it("should return empty array when no jobs match status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);

      const completed = await getJobs("completed");
      expect(completed).toHaveLength(0);
    });

    it("should return multi-source jobs correctly", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const sources: PathEntry[] = [
        { path: "/music/Artist1", sourceIndex: 1 },
        { path: "/music/Artist2", sourceIndex: 2 },
        { path: "/music/Artist3", sourceIndex: 3 },
      ];

      await addJob(sources, "/dest1", options);
      await addJob("/single-source", "/dest2", options);

      const all = await getJobs();
      expect(all).toHaveLength(2);

      // First job should be multi-source
      const multiSourceJob = all.find((j) => j.sources !== undefined);
      expect(multiSourceJob).toBeDefined();
      expect(multiSourceJob?.sources).toHaveLength(3);
      expect(multiSourceJob?.sources?.[0]?.path).toBe("/music/Artist1");
      expect(multiSourceJob?.source).toBeUndefined();

      // Second job should be single-source
      const singleSourceJob = all.find((j) => j.source !== undefined);
      expect(singleSourceJob).toBeDefined();
      expect(singleSourceJob?.source).toBe("/single-source");
      expect(singleSourceJob?.sources).toBeUndefined();
    });

    it("should filter multi-source jobs by status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const sources: PathEntry[] = [{ path: "/music/Artist1" }, { path: "/music/Artist2" }];

      const job1 = await addJob(sources, "/dest1", options);
      await addJob(sources, "/dest2", options);

      await updateJobStatus(job1.id, "completed");

      const pending = await getJobs("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sources).toHaveLength(2);

      const completed = await getJobs("completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]?.sources).toHaveLength(2);
    });
  });

  describe("updateJobStatus", () => {
    it("should update status to running with startedAt", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/source", "/dest", options);
      await updateJobStatus(job.id, "running");

      const jobs = await getJobs("running");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.startedAt).toBeDefined();
    });

    it("should update status to completed with completedAt", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/source", "/dest", options);
      await updateJobStatus(job.id, "completed");

      const jobs = await getJobs("completed");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.completedAt).toBeDefined();
    });

    it("should update status to failed with error message", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/source", "/dest", options);
      await updateJobStatus(job.id, "failed", "Test error message");

      const jobs = await getJobs("failed");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.completedAt).toBeDefined();
      expect(jobs[0]?.error).toBe("Test error message");
    });

    it("should throw error for non-existent job", async () => {
      await expect(updateJobStatus("non-existent-id", "running")).rejects.toThrow(
        "Job not found: non-existent-id",
      );
    });
  });

  describe("removeJob", () => {
    it("should remove single job", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job = await addJob("/source", "/dest", options);

      const removed = await removeJob(job.id);
      expect(removed).toBe(true);

      const jobs = await getJobs();
      expect(jobs).toHaveLength(0);
    });

    it("should return false when job not found", async () => {
      const removed = await removeJob("non-existent-id");
      expect(removed).toBe(false);
    });

    it("should only remove specified job", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      const job1 = await addJob("/source1", "/dest1", options);
      const job2 = await addJob("/source2", "/dest2", options);

      await removeJob(job1.id);

      const jobs = await getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe(job2.id);
    });
  });

  describe("removeJobsByStatus", () => {
    it("should remove all jobs when no status specified", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);
      await addJob("/source2", "/dest2", options);

      const removed = await removeJobsByStatus();
      expect(removed).toBe(2);

      const jobs = await getJobs();
      expect(jobs).toHaveLength(0);
    });

    it("should remove only jobs with specified status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);
      const job2 = await addJob("/source2", "/dest2", options);
      await updateJobStatus(job2.id, "completed");

      const removed = await removeJobsByStatus("completed");
      expect(removed).toBe(1);

      const jobs = await getJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.status).toBe("pending");
    });

    it("should return 0 when no jobs match status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/source1", "/dest1", options);

      const removed = await removeJobsByStatus("completed");
      expect(removed).toBe(0);
    });
  });

  describe("getQueueStats", () => {
    it("should return correct counts by status", async () => {
      const options: SerializableCopyOptions = {
        mode: { type: "album", range: { start: 1, end: 1, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        workers: 1,
      };

      await addJob("/s1", "/d1", options);
      const job2 = await addJob("/s2", "/d2", options);
      const job3 = await addJob("/s3", "/d3", options);
      await updateJobStatus(job2.id, "failed", "test error");
      await updateJobStatus(job3.id, "completed");

      const stats = await getQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.running).toBe(0);
    });

    it("should return zeros for empty queue", async () => {
      const stats = await getQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
    });
  });
});
