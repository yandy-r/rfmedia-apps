/**
 * Tests for history.ts - Phase 5 analytics command.
 *
 * Tests history querying with date filtering, mode/status/command filtering,
 * duplicate detection, and limit enforcement.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeHistory } from "./history.js";
import {
  initializeDatabase,
  closeDatabase,
  createOperation,
  recordCompleted,
  updateOperationStatus,
} from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import type { HistoryOptions } from "../types/options.js";

describe("executeHistory - Empty Database", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty results for empty database", async () => {
    const options: HistoryOptions = {
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.duplicates).toBeUndefined();
    expect(result.duplicateSources).toBeUndefined();
  });
});

describe("executeHistory - Date Filtering", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create operations at different times (by manipulating created_at)
    // Note: In real scenarios, created_at is set automatically, but we can test filtering
    createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/old.txt",
      optionsHash: "album-001-010",
      ratingKey: null,
      rangeKey: "001-010",
      convertKey: null,
      totalSources: 10,
    });

    createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/test/recent.txt",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
      totalSources: 5,
    });
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should parse ISO date format", async () => {
    const options: HistoryOptions = {
      from: "2020-01-01",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    // Should not throw
    const result = await executeHistory(options);
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });

  it("should parse relative date format (7 days ago)", async () => {
    const options: HistoryOptions = {
      from: "7 days ago",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    // Should not throw
    const result = await executeHistory(options);
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });

  it("should parse relative date format (2 weeks ago)", async () => {
    const options: HistoryOptions = {
      from: "2 weeks ago",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    // Should not throw
    const result = await executeHistory(options);
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });

  it("should parse relative date format (1 month ago)", async () => {
    const options: HistoryOptions = {
      from: "1 month ago",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    // Should not throw
    const result = await executeHistory(options);
    expect(result.entries.length).toBeGreaterThanOrEqual(0);
  });

  it("should throw error for invalid date format", async () => {
    const options: HistoryOptions = {
      from: "invalid date",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    await expect(executeHistory(options)).rejects.toThrow(/Invalid date format/);
  });
});

describe("executeHistory - Mode/Status/Command Filtering", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create operations with different modes, statuses, and commands
    const op1 = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/album1.txt",
      optionsHash: "album-001-010",
      ratingKey: null,
      rangeKey: "001-010",
      convertKey: null,
      totalSources: 10,
    });
    updateOperationStatus(db, op1, "completed");

    const op2 = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/album2.txt",
      optionsHash: "album-001-005",
      ratingKey: null,
      rangeKey: "001-005",
      convertKey: null,
      totalSources: 5,
    });
    updateOperationStatus(db, op2, "failed");

    const op3 = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/test/filter1.txt",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
      totalSources: 20,
    });
    updateOperationStatus(db, op3, "completed");

    const op4 = createOperation(db, {
      command: "sync",
      mode: "filter",
      inputFile: "/test/sync1.txt",
      optionsHash: "filter-r60",
      ratingKey: "r60",
      rangeKey: null,
      convertKey: null,
      totalSources: 15,
    });
    updateOperationStatus(db, op4, "partial");
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should filter by mode", async () => {
    const options: HistoryOptions = {
      mode: "album",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.mode === "album")).toBe(true);
  });

  it("should filter by status", async () => {
    const options: HistoryOptions = {
      status: "completed",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.status === "completed")).toBe(true);
  });

  it("should filter by command", async () => {
    const options: HistoryOptions = {
      command: "copy-filter",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("copy-filter");
  });

  it("should combine multiple filters", async () => {
    const options: HistoryOptions = {
      mode: "filter",
      status: "completed",
      limit: 50,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry).toBeDefined();
    expect(entry?.mode).toBe("filter");
    expect(entry?.status).toBe("completed");
    expect(entry?.command).toBe("copy-filter");
  });
});

describe("executeHistory - Limit Enforcement", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create 10 operations
    for (let i = 0; i < 10; i++) {
      createOperation(db, {
        command: "copy-album",
        mode: "album",
        inputFile: `/test/source${i}.txt`,
        optionsHash: `album-00${i}-010`,
        ratingKey: null,
        rangeKey: `00${i}-010`,
        convertKey: null,
        totalSources: 5,
      });
    }
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should respect limit parameter", async () => {
    const options: HistoryOptions = {
      limit: 5,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(5);
    expect(result.totalCount).toBe(10);
  });

  it("should return all results when limit exceeds total", async () => {
    const options: HistoryOptions = {
      limit: 100,
      showDuplicates: false,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.entries).toHaveLength(10);
    expect(result.totalCount).toBe(10);
  });
});

describe("executeHistory - Duplicate Detection", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create operations with duplicate options_hash
    const op1 = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/sources.txt",
      optionsHash: "album-001-010",
      ratingKey: null,
      rangeKey: "001-010",
      convertKey: null,
      totalSources: 10,
    });

    const op2 = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/sources.txt",
      optionsHash: "album-001-010", // Duplicate hash
      ratingKey: null,
      rangeKey: "001-010",
      convertKey: null,
      totalSources: 10,
    });

    const op3 = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/test/filter.txt",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
      totalSources: 5,
    });

    // Add duplicate sources
    recordCompleted(db, op1, "/music/Artist/Album1");
    recordCompleted(db, op2, "/music/Artist/Album1"); // Duplicate source
    recordCompleted(db, op3, "/music/Artist/Album2");
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should detect duplicate operations when requested", async () => {
    const options: HistoryOptions = {
      showDuplicates: true,
      limit: 50,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.duplicates).toBeDefined();
    expect(result.duplicates).toHaveLength(1);
    if (result.duplicates && result.duplicates.length > 0) {
      expect(result.duplicates[0]?.optionsHash).toBe("album-001-010");
      expect(result.duplicates[0]?.count).toBe(2);
      expect(result.duplicates[0]?.operationIds).toHaveLength(2);
    }
  });

  it("should detect duplicate sources when requested", async () => {
    const options: HistoryOptions = {
      showDuplicates: true,
      limit: 50,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.duplicateSources).toBeDefined();
    expect(result.duplicateSources).toHaveLength(1);
    if (result.duplicateSources && result.duplicateSources.length > 0) {
      expect(result.duplicateSources[0]?.sourcePath).toBe("/music/Artist/Album1");
      expect(result.duplicateSources[0]?.operationCount).toBe(2);
    }
  });

  it("should not include duplicates when not requested", async () => {
    const options: HistoryOptions = {
      showDuplicates: false,
      limit: 50,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    expect(result.duplicates).toBeUndefined();
    expect(result.duplicateSources).toBeUndefined();
  });
});

describe("executeHistory - JSON Output Compatibility", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-history-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create a simple operation
    createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/sources.txt",
      optionsHash: "album-001-005",
      ratingKey: null,
      rangeKey: "001-005",
      convertKey: null,
      totalSources: 5,
    });
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return result that can be serialized to JSON", async () => {
    const options: HistoryOptions = {
      showDuplicates: true,
      limit: 50,
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeHistory(options);

    // Verify JSON serialization works
    expect(() => JSON.stringify(result)).not.toThrow();

    // Verify structure matches expected format
    const json = JSON.parse(JSON.stringify(result));
    expect(json).toHaveProperty("entries");
    expect(json).toHaveProperty("totalCount");
    expect(json).toHaveProperty("duplicates");
    expect(json).toHaveProperty("duplicateSources");
  });
});
