/**
 * Tests for queue database operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DbConnection } from "../types/db.js";
import type { QueueJob } from "../types/queue.js";
import type { DeleteSelection, CopySelection } from "../types/options.js";
import {
  addJobToDb,
  getJobsFromDb,
  updateJobStatusInDb,
  removeJobFromDb,
  getQueueStatsFromDb,
  serializeSelectionToDb,
  deserializeDeleteSelectionFromDb,
  deserializeCopySelectionFromDb,
} from "./queue-db.js";
import { initializeDatabase } from "./db.js";

describe("Queue Database Operations", () => {
  let tempDir: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary database for each test
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-test-"));
    const dbPath = join(tempDir, "test.db");
    db = await initializeDatabase(dbPath);
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      db.close();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("Basic Queue Operations", () => {
    it("should add and retrieve a copy job", () => {
      const job: QueueJob = {
        id: "test-job-1",
        jobType: "copy",
        addedAt: new Date().toISOString(),
        source: "/test/source",
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
          trackCompleted: true,
        },
        status: "pending",
      };

      addJobToDb(db, job);
      const jobs = getJobsFromDb(db);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.id).toBe("test-job-1");
      expect(jobs[0]?.jobType).toBe("copy");
      expect(jobs[0]?.status).toBe("pending");
    });

    it("should add a job with multi-source entries", () => {
      const job: QueueJob = {
        id: "test-job-2",
        jobType: "delete",
        addedAt: new Date().toISOString(),
        sources: [
          { path: "/test/source1", count: 5 },
          { path: "/test/source2", range: { start: 1, end: 3, padWidth: 3 } },
        ],
        destination: "/test/dest",
        options: {
          mode: { type: "album" },
          albumOnly: false,
          force: false,
          workers: 4,
          useTrash: false,
          keepTracking: false,
        },
        status: "pending",
      };

      addJobToDb(db, job);
      const jobs = getJobsFromDb(db);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.sources).toHaveLength(2);
      expect(jobs[0]?.sources?.[0]?.path).toBe("/test/source1");
      expect(jobs[0]?.sources?.[0]?.count).toBe(5);
      expect(jobs[0]?.sources?.[1]?.range?.start).toBe(1);
    });

    it("should round-trip source names and groups containing commas", () => {
      const job: QueueJob = {
        id: "test-job-commas",
        jobType: "copy",
        addedAt: new Date().toISOString(),
        sources: [
          {
            path: "/test/source1",
            sourceNames: ["Crosby, Stills & Nash", "Earth, Wind & Fire"],
            sourceGroups: ["rock, classic"],
          },
        ],
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
        },
        status: "pending",
      };

      addJobToDb(db, job);
      const jobs = getJobsFromDb(db);

      expect(jobs[0]?.sources?.[0]?.sourceNames).toEqual([
        "Crosby, Stills & Nash",
        "Earth, Wind & Fire",
      ]);
      expect(jobs[0]?.sources?.[0]?.sourceGroups).toEqual(["rock, classic"]);
    });

    it("should read legacy comma-delimited source names and groups", () => {
      const job: QueueJob = {
        id: "test-job-legacy",
        jobType: "copy",
        addedAt: new Date().toISOString(),
        sources: [{ path: "/test/source1" }],
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
        },
        status: "pending",
      };

      addJobToDb(db, job);

      // Simulate a row written by a pre-v8 version of the CLI
      db.prepare(
        "UPDATE queue_job_sources SET source_name = ?, source_group = ? WHERE job_id = ?",
      ).run("Artist A,Artist B", "pop", "test-job-legacy");

      const jobs = getJobsFromDb(db);
      expect(jobs[0]?.sources?.[0]?.sourceNames).toEqual(["Artist A", "Artist B"]);
      expect(jobs[0]?.sources?.[0]?.sourceGroups).toEqual(["pop"]);
    });

    it("should update job status", () => {
      const job: QueueJob = {
        id: "test-job-3",
        jobType: "copy",
        addedAt: new Date().toISOString(),
        source: "/test/source",
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
        },
        status: "pending",
      };

      addJobToDb(db, job);
      updateJobStatusInDb(db, job.id, "running");

      const jobs = getJobsFromDb(db);
      expect(jobs[0]?.status).toBe("running");
      expect(jobs[0]?.startedAt).toBeDefined();
    });

    it("should remove a job", () => {
      const job: QueueJob = {
        id: "test-job-4",
        jobType: "copy",
        addedAt: new Date().toISOString(),
        source: "/test/source",
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
        },
        status: "pending",
      };

      addJobToDb(db, job);
      const removed = removeJobFromDb(db, job.id);

      expect(removed).toBe(true);
      expect(getJobsFromDb(db)).toHaveLength(0);
    });

    it("should get queue statistics", () => {
      const jobs: QueueJob[] = [
        {
          id: "job-1",
          jobType: "copy",
          addedAt: new Date().toISOString(),
          source: "/test/1",
          destination: "/dest",
          options: {
            mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
            albumOnly: false,
            hardlink: false,
            force: false,
            workers: 4,
          },
          status: "pending",
        },
        {
          id: "job-2",
          jobType: "copy",
          addedAt: new Date().toISOString(),
          source: "/test/2",
          destination: "/dest",
          options: {
            mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
            albumOnly: false,
            hardlink: false,
            force: false,
            workers: 4,
          },
          status: "completed",
        },
        {
          id: "job-3",
          jobType: "copy",
          addedAt: new Date().toISOString(),
          source: "/test/3",
          destination: "/dest",
          options: {
            mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
            albumOnly: false,
            hardlink: false,
            force: false,
            workers: 4,
          },
          status: "failed",
        },
      ];

      for (const job of jobs) {
        addJobToDb(db, job);
      }

      const stats = getQueueStatsFromDb(db);
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.running).toBe(0);
    });
  });

  describe("Selection Serialization", () => {
    it("should serialize and deserialize delete selection", () => {
      const jobId = "delete-job-1";

      // Create parent job first (required by FK constraint on queue_job_selections)
      const parentJob: QueueJob = {
        id: jobId,
        jobType: "delete",
        addedAt: new Date().toISOString(),
        source: "/test/source1",
        destination: "/test/dest",
        options: {
          mode: { type: "album" },
          albumOnly: false,
          force: false,
          workers: 4,
          useTrash: false,
          keepTracking: false,
        },
        status: "pending",
      };
      addJobToDb(db, parentJob);

      const deleteSelection: DeleteSelection = {
        selectedSources: ["/test/source1", "/test/source2"],
        sourceSelections: new Map([
          [
            "/test/source1",
            {
              sourcePath: "/test/source1",
              selectedSuffixes: ["/test/source1/Album-001", "/test/source1/Album-002"],
            },
          ],
          [
            "/test/source2",
            {
              sourcePath: "/test/source2",
              selectedSuffixes: ["/test/source2/Album-005"],
            },
          ],
        ]) as ReadonlyMap<string, any>,
      };

      serializeSelectionToDb(db, jobId, deleteSelection, "delete");

      const deserialized = deserializeDeleteSelectionFromDb(db, jobId);

      expect(deserialized).toBeDefined();
      expect(deserialized?.selectedSources).toHaveLength(2);
      expect(deserialized?.sourceSelections.size).toBe(2);

      const source1Selection = deserialized?.sourceSelections.get("/test/source1");
      expect(source1Selection?.selectedSuffixes).toHaveLength(2);
      expect(source1Selection?.selectedSuffixes).toContain("/test/source1/Album-001");
    });

    it("should serialize and deserialize copy selection", () => {
      const jobId = "copy-job-1";

      // Create parent job first (required by FK constraint on queue_job_selections)
      const parentJob: QueueJob = {
        id: jobId,
        jobType: "copy",
        addedAt: new Date().toISOString(),
        source: "/test/source1",
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          hardlink: false,
          force: false,
          workers: 4,
        },
        status: "pending",
      };
      addJobToDb(db, parentJob);

      const copySelection: CopySelection = {
        selectedSources: ["/test/source1"],
        sourceSelections: new Map([
          [
            "/test/source1",
            {
              sourcePath: "/test/source1",
              level: "album",
              selectedAlbums: ["Album1", "Album2"],
            },
          ],
        ]) as ReadonlyMap<string, any>,
      };

      serializeSelectionToDb(db, jobId, copySelection, "copy");

      const deserialized = deserializeCopySelectionFromDb(db, jobId);

      expect(deserialized).toBeDefined();
      expect(deserialized?.selectedSources).toHaveLength(1);
      expect(deserialized?.sourceSelections.size).toBe(1);

      const source1Selection = deserialized?.sourceSelections.get("/test/source1");
      expect(source1Selection?.level).toBe("album");
      expect(source1Selection?.selectedAlbums).toHaveLength(2);
      expect(source1Selection?.selectedAlbums).toContain("Album1");
    });

    it("should handle jobs without selections", () => {
      const jobId = "no-selection-job";
      const deserialized = deserializeDeleteSelectionFromDb(db, jobId);

      expect(deserialized).toBeUndefined();
    });

    it("should cascade delete selections when job is removed", () => {
      const job: QueueJob = {
        id: "cascade-test-job",
        jobType: "delete",
        addedAt: new Date().toISOString(),
        source: "/test/source",
        destination: "/test/dest",
        options: {
          mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
          albumOnly: false,
          force: false,
          workers: 4,
          useTrash: false,
          keepTracking: false,
        },
        status: "pending",
      };

      const selection: DeleteSelection = {
        selectedSources: ["/test/source"],
        sourceSelections: new Map([
          [
            "/test/source",
            { sourcePath: "/test/source", selectedSuffixes: ["/test/source/Album-001"] },
          ],
        ]) as ReadonlyMap<string, any>,
      };

      addJobToDb(db, job, selection);

      // Verify selection exists
      const beforeDelete = deserializeDeleteSelectionFromDb(db, job.id);
      expect(beforeDelete).toBeDefined();

      // Remove job
      removeJobFromDb(db, job.id);

      // Selection should be gone (CASCADE)
      const afterDelete = deserializeDeleteSelectionFromDb(db, job.id);
      expect(afterDelete).toBeUndefined();
    });
  });
});
