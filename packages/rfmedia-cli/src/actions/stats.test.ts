/**
 * Tests for stats.ts - Phase 5 analytics command.
 *
 * Tests comprehensive statistics querying from the tracking database.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeStats } from "./stats.js";
import {
  initializeDatabase,
  closeDatabase,
  createOperation,
  recordInventoryFile,
  updateOperationStatus,
} from "../lib/db.js";
import type { DbConnection } from "../types/db.js";
import type { StatsOptions } from "../types/options.js";

describe("executeStats - Empty Database", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-stats-test-"));
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
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    expect(result.operations).toEqual([]);
    expect(result.totalFiles).toBe(0);
    expect(result.totalSize).toBe(0);
    expect(result.storageByRating).toEqual([]);
    expect(result.successRateByMode).toEqual({});
  });
});

describe("executeStats - Operation Statistics", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-stats-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create test operations with different commands and statuses
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
    updateOperationStatus(db, op1, "completed");

    const op2 = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/sources2.txt",
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
      inputFile: "/test/filter.txt",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
      totalSources: 20,
    });
    updateOperationStatus(db, op3, "completed");

    const op4 = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/test/filter2.txt",
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

  it("should aggregate operation statistics by command", async () => {
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    expect(result.operations).toHaveLength(2);

    // Find copy-filter stats
    const filterStats = result.operations.find((op) => op.command === "copy-filter");
    expect(filterStats).toBeDefined();
    expect(filterStats!.total).toBe(2);
    expect(filterStats!.completed).toBe(1);
    expect(filterStats!.failed).toBe(0);
    expect(filterStats!.partial).toBe(1);
    expect(filterStats!.successRate).toBe(50);

    // Find copy-album stats
    const albumStats = result.operations.find((op) => op.command === "copy-album");
    expect(albumStats).toBeDefined();
    expect(albumStats!.total).toBe(2);
    expect(albumStats!.completed).toBe(1);
    expect(albumStats!.failed).toBe(1);
    expect(albumStats!.partial).toBe(0);
    expect(albumStats!.successRate).toBe(50);
  });

  it("should calculate success rates by mode", async () => {
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    expect(result.successRateByMode.album).toBe(50);
    expect(result.successRateByMode.filter).toBe(50);
  });
});

describe("executeStats - Storage Statistics", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-stats-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create an operation
    const opId = createOperation(db, {
      command: "copy-filter",
      mode: "filter",
      inputFile: "/test/sources.txt",
      optionsHash: "filter-r80",
      ratingKey: "r80",
      rangeKey: null,
      convertKey: null,
      totalSources: 10,
    });

    // Add inventory files with different ratings
    recordInventoryFile(db, opId, {
      sourcePath: "/source/album",
      relativePath: "track1.flac",
      mtime: Date.now(),
      size: 10000000, // 10 MB
      rating: 0.9, // 4-5 stars
      destPath: "/dest/track1.flac",
    });

    recordInventoryFile(db, opId, {
      sourcePath: "/source/album",
      relativePath: "track2.flac",
      mtime: Date.now(),
      size: 8000000, // 8 MB
      rating: 0.7, // 3-4 stars
      destPath: "/dest/track2.flac",
    });

    recordInventoryFile(db, opId, {
      sourcePath: "/source/album",
      relativePath: "track3.flac",
      mtime: Date.now(),
      size: 5000000, // 5 MB
      rating: 0.5, // 2-3 stars
      destPath: "/dest/track3.flac",
    });

    recordInventoryFile(db, opId, {
      sourcePath: "/source/album",
      relativePath: "track4.flac",
      mtime: Date.now(),
      size: 3000000, // 3 MB
      rating: null, // Unrated
      destPath: "/dest/track4.flac",
    });
  });

  afterEach(async () => {
    // Clean up
    if (db) {
      closeDatabase(db);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should calculate total files and size", async () => {
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    expect(result.totalFiles).toBe(4);
    expect(result.totalSize).toBe(26000000); // 26 MB total
  });

  it("should group storage by rating ranges", async () => {
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    expect(result.storageByRating).toHaveLength(4);

    // 4-5 stars (rating >= 0.8)
    const stars45 = result.storageByRating.find((r) => r.range === "4-5 stars");
    expect(stars45).toBeDefined();
    expect(stars45!.fileCount).toBe(1);
    expect(stars45!.totalSize).toBe(10000000);

    // 3-4 stars (rating >= 0.6)
    const stars34 = result.storageByRating.find((r) => r.range === "3-4 stars");
    expect(stars34).toBeDefined();
    expect(stars34!.fileCount).toBe(1);
    expect(stars34!.totalSize).toBe(8000000);

    // 2-3 stars (rating >= 0.4)
    const stars23 = result.storageByRating.find((r) => r.range === "2-3 stars");
    expect(stars23).toBeDefined();
    expect(stars23!.fileCount).toBe(1);
    expect(stars23!.totalSize).toBe(5000000);

    // Unrated (rating < 0.2 or NULL)
    const unrated = result.storageByRating.find((r) => r.range === "Unrated");
    expect(unrated).toBeDefined();
    expect(unrated!.fileCount).toBe(1);
    expect(unrated!.totalSize).toBe(3000000);
  });

  it("should order rating ranges correctly", async () => {
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    const ranges = result.storageByRating.map((r) => r.range);
    expect(ranges).toEqual(["4-5 stars", "3-4 stars", "2-3 stars", "Unrated"]);
  });
});

describe("executeStats - JSON Output Compatibility", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DbConnection;

  beforeEach(async () => {
    // Create temporary directory for database
    tempDir = await mkdtemp(join(tmpdir(), "rfmedia-stats-test-"));
    dbPath = join(tempDir, "tracking.db");
    db = await initializeDatabase(dbPath);

    // Create a simple operation
    const opId = createOperation(db, {
      command: "copy-album",
      mode: "album",
      inputFile: "/test/sources.txt",
      optionsHash: "album-001-005",
      ratingKey: null,
      rangeKey: "001-005",
      convertKey: null,
      totalSources: 5,
    });
    updateOperationStatus(db, opId, "completed");

    // Add one inventory file
    recordInventoryFile(db, opId, {
      sourcePath: "/source/album",
      relativePath: "track.flac",
      mtime: Date.now(),
      size: 1000000,
      rating: 0.8,
      destPath: "/dest/track.flac",
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
    const options: StatsOptions = {
      trackingDatabase: dbPath,
      dryRun: false,
    };

    const result = await executeStats(options);

    // Verify JSON serialization works
    expect(() => JSON.stringify(result)).not.toThrow();

    // Verify structure matches expected format
    const json = JSON.parse(JSON.stringify(result));
    expect(json).toHaveProperty("operations");
    expect(json).toHaveProperty("totalFiles");
    expect(json).toHaveProperty("totalSize");
    expect(json).toHaveProperty("storageByRating");
    expect(json).toHaveProperty("successRateByMode");
  });
});
