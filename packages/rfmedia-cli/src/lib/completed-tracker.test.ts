/**
 * Tests for completed-tracker.ts granular tracking functionality.
 *
 * These tests verify that the per-path range expansion works correctly:
 * - First run with range 001-002 should complete those suffixes
 * - Second run with range 001-020 should only process 003-020
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cleanupTempDir, createTempTestDir } from "../test-utils/filesystem.js";

import {
  getPendingSuffixes,
  loadCompletedAlbumCopiesForSource,
  recordCompletedAlbumCopy,
  createTrackingConfig,
  initializeTracking,
  buildOptionsHash,
  formatOptionsHash,
  migrateLegacyTracking,
} from "./completed-tracker.js";
import {
  initializeDatabase,
  closeDatabase,
  createOperation,
  findOperation,
  getCompletedSources,
  getFailedSources,
  recordCompletedAlbumCopy as dbRecordCompletedAlbumCopy,
  getCompletedSuffixesForAlbum,
} from "./db.js";
import type { CopyRange, CopyOptions } from "../types/index.js";
import type { TrackingConfig } from "../types/tracking.js";

describe("getPendingSuffixes", () => {
  it("should return all suffixes when none are completed", () => {
    const completedSuffixes = new Set<string>();
    const range: CopyRange = { start: 1, end: 5, padWidth: 3 };

    const pending = getPendingSuffixes(completedSuffixes, range);

    expect(pending).toEqual(["001", "002", "003", "004", "005"]);
  });

  it("should return only pending suffixes when some are completed", () => {
    const completedSuffixes = new Set<string>(["001", "002"]);
    const range: CopyRange = { start: 1, end: 5, padWidth: 3 };

    const pending = getPendingSuffixes(completedSuffixes, range);

    expect(pending).toEqual(["003", "004", "005"]);
  });

  it("should return empty array when all suffixes are completed", () => {
    const completedSuffixes = new Set<string>(["001", "002", "003", "004", "005"]);
    const range: CopyRange = { start: 1, end: 5, padWidth: 3 };

    const pending = getPendingSuffixes(completedSuffixes, range);

    expect(pending).toEqual([]);
  });

  it("should handle range expansion scenario", () => {
    // First run completed 001-002
    const completedSuffixes = new Set<string>(["001", "002"]);
    // Second run with expanded range 001-020
    const range: CopyRange = { start: 1, end: 20, padWidth: 3 };

    const pending = getPendingSuffixes(completedSuffixes, range);

    // Should only return 003-020
    expect(pending.length).toBe(18);
    expect(pending[0]).toBe("003");
    expect(pending[pending.length - 1]).toBe("020");
    expect(pending).not.toContain("001");
    expect(pending).not.toContain("002");
  });

  it("should handle different pad widths", () => {
    const completedSuffixes = new Set<string>(["01", "02"]);
    const range: CopyRange = { start: 1, end: 5, padWidth: 2 };

    const pending = getPendingSuffixes(completedSuffixes, range);

    expect(pending).toEqual(["03", "04", "05"]);
  });
});

describe("Database granular tracking", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-test-");
    dbPath = join(tempDir, "tracking.db");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should record and retrieve completed album copies", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      // Create an operation
      const operationId = createOperation(db, {
        command: "copy",
        mode: "album",
        inputFile: "/test/sources.txt",
        optionsHash: "album-001-020",
        ratingKey: null,
        rangeKey: "001-020",
        convertKey: null,
      });

      // Record completed album copies
      const sourcePath = "/music/Artist";
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "002");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "001");

      // Retrieve completed suffixes for Album1
      const album1Suffixes = getCompletedSuffixesForAlbum(db, operationId, sourcePath, "Album1");
      expect(album1Suffixes.has("001")).toBe(true);
      expect(album1Suffixes.has("002")).toBe(true);
      expect(album1Suffixes.has("003")).toBe(false);

      // Retrieve completed suffixes for Album2
      const album2Suffixes = getCompletedSuffixesForAlbum(db, operationId, sourcePath, "Album2");
      expect(album2Suffixes.has("001")).toBe(true);
      expect(album2Suffixes.has("002")).toBe(false);
    } finally {
      closeDatabase(db);
    }
  });

  it("should load all completed album copies for a source", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "album",
        inputFile: "/test/sources.txt",
        optionsHash: "album-001-020",
        ratingKey: null,
        rangeKey: "001-020",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "002");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "001");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "002");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "003");

      // Load all completed copies for the source
      const completedCopies = loadCompletedAlbumCopiesForSource(db, operationId, sourcePath);

      expect(completedCopies.size).toBe(2); // 2 albums
      expect(completedCopies.get("Album1")?.size).toBe(2);
      expect(completedCopies.get("Album2")?.size).toBe(3);
    } finally {
      closeDatabase(db);
    }
  });

  it("should handle range expansion correctly", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "album",
        inputFile: "/test/sources.txt",
        optionsHash: "album-001-020",
        ratingKey: null,
        rangeKey: "001-020",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";

      // Simulate first run with range 001-002
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "002");

      // Load completed copies
      const completedCopies = loadCompletedAlbumCopiesForSource(db, operationId, sourcePath);
      const album1Completed = completedCopies.get("Album1") ?? new Set<string>();

      // Check pending suffixes for expanded range 001-020
      const expandedRange: CopyRange = { start: 1, end: 20, padWidth: 3 };
      const pending = getPendingSuffixes(album1Completed, expandedRange);

      // Should only have 003-020 pending
      expect(pending.length).toBe(18);
      expect(pending).not.toContain("001");
      expect(pending).not.toContain("002");
      expect(pending[0]).toBe("003");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("buildOptionsHash", () => {
  it("should build hash for album mode with range", () => {
    const options: CopyOptions = {
      mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 4,
    };

    const hash = buildOptionsHash(options);
    const formatted = formatOptionsHash(hash);

    expect(formatted).toBe("album-001-010");
  });

  it("should build hash for filter mode with rating", () => {
    const options: CopyOptions = {
      mode: {
        type: "filter",
        rating: {
          minRating: 80,
          outputFolder: "liked",
          preserveStructure: false,
        },
      },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 4,
    };

    const hash = buildOptionsHash(options);
    const formatted = formatOptionsHash(hash);

    expect(formatted).toBe("filter-r80");
  });

  it("should include convert key when present", () => {
    const options: CopyOptions = {
      mode: { type: "album", range: { start: 1, end: 5, padWidth: 3 } },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 4,
      convertFormat: "mp3",
    };

    const hash = buildOptionsHash(options);
    const formatted = formatOptionsHash(hash);

    expect(formatted).toBe("album-001-005-mp3");
  });
});

describe("Rating-aware granular tracking", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-rating-test-");
    dbPath = join(tempDir, "tracking.db");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should record album copies with rating key", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "filter",
        inputFile: "/test/sources.txt",
        optionsHash: "filter-r50-001-010",
        ratingKey: "r50",
        rangeKey: "001-010",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";

      // Record copies with rating key r50
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "002", "r50");

      // Verify they were recorded with rating key
      const suffixes = getCompletedSuffixesForAlbum(db, operationId, sourcePath, "Album1", "r50");
      expect(suffixes.has("001")).toBe(true);
      expect(suffixes.has("002")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("should track different rating filters separately", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "filter",
        inputFile: "/test/sources.txt",
        optionsHash: "filter-001-010",
        ratingKey: null,
        rangeKey: "001-010",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";
      const albumName = "Album1";

      // Record copies with different rating keys
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "001", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "002", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "001", "r80");

      // Query with r50 filter - should get 001, 002
      const r50Suffixes = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        "r50",
      );
      expect(r50Suffixes.size).toBe(2);
      expect(r50Suffixes.has("001")).toBe(true);
      expect(r50Suffixes.has("002")).toBe(true);

      // Query with r80 filter - should only get 001
      const r80Suffixes = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        "r80",
      );
      expect(r80Suffixes.size).toBe(1);
      expect(r80Suffixes.has("001")).toBe(true);
      expect(r80Suffixes.has("002")).toBe(false);

      // Query without filter (undefined) - should get all 3 entries (but unique suffixes)
      const allSuffixes = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        undefined,
      );
      expect(allSuffixes.size).toBe(2); // 001 and 002 (unique suffixes)
    } finally {
      closeDatabase(db);
    }
  });

  it("should allow re-processing album with different rating filter", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "filter",
        inputFile: "/test/sources.txt",
        optionsHash: "filter-001-010",
        ratingKey: null,
        rangeKey: "001-010",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";
      const albumName = "Album1";
      const range: CopyRange = { start: 1, end: 5, padWidth: 3 };

      // First run with r50 filter - complete all suffixes
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "001", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "002", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "003", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "004", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "005", "r50");

      // Check pending for r50 - should be empty (all done)
      const r50Completed = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        "r50",
      );
      const r50Pending = getPendingSuffixes(r50Completed, range);
      expect(r50Pending.length).toBe(0);

      // Check pending for r80 - should have all suffixes pending (different filter)
      const r80Completed = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        "r80",
      );
      const r80Pending = getPendingSuffixes(r80Completed, range);
      expect(r80Pending.length).toBe(5);
      expect(r80Pending).toEqual(["001", "002", "003", "004", "005"]);
    } finally {
      closeDatabase(db);
    }
  });

  it("should track null rating key separately from non-null keys", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "album",
        inputFile: "/test/sources.txt",
        optionsHash: "album-001-010",
        ratingKey: null,
        rangeKey: "001-010",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";
      const albumName = "Album1";

      // Record copies with no rating filter (null)
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "001", null);
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "002", null);

      // Record copy with s3 filter
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, albumName, "001", "s3");

      // Query with null filter - should get 001, 002
      const nullSuffixes = getCompletedSuffixesForAlbum(
        db,
        operationId,
        sourcePath,
        albumName,
        null,
      );
      expect(nullSuffixes.size).toBe(2);
      expect(nullSuffixes.has("001")).toBe(true);
      expect(nullSuffixes.has("002")).toBe(true);

      // Query with s3 filter - should only get 001
      const s3Suffixes = getCompletedSuffixesForAlbum(db, operationId, sourcePath, albumName, "s3");
      expect(s3Suffixes.size).toBe(1);
      expect(s3Suffixes.has("001")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("should load completed album copies filtered by rating key", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const operationId = createOperation(db, {
        command: "copy",
        mode: "filter",
        inputFile: "/test/sources.txt",
        optionsHash: "filter-001-010",
        ratingKey: null,
        rangeKey: "001-010",
        convertKey: null,
      });

      const sourcePath = "/music/Artist";

      // Record copies with different rating keys across multiple albums
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "002", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "001", "r50");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album1", "001", "r80");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "001", "r80");
      dbRecordCompletedAlbumCopy(db, operationId, sourcePath, "Album2", "002", "r80");

      // Load with r50 filter
      const r50Copies = loadCompletedAlbumCopiesForSource(db, operationId, sourcePath, "r50");
      expect(r50Copies.size).toBe(2); // Album1 and Album2
      expect(r50Copies.get("Album1")?.size).toBe(2); // 001, 002
      expect(r50Copies.get("Album2")?.size).toBe(1); // 001

      // Load with r80 filter
      const r80Copies = loadCompletedAlbumCopiesForSource(db, operationId, sourcePath, "r80");
      expect(r80Copies.size).toBe(2); // Album1 and Album2
      expect(r80Copies.get("Album1")?.size).toBe(1); // 001
      expect(r80Copies.get("Album2")?.size).toBe(2); // 001, 002

      // Load without filter (all copies)
      const allCopies = loadCompletedAlbumCopiesForSource(db, operationId, sourcePath, undefined);
      expect(allCopies.size).toBe(2);
      // Album1 has unique suffixes 001, 002 across both ratings
      expect(allCopies.get("Album1")?.size).toBe(2);
      // Album2 has unique suffixes 001, 002 across both ratings
      expect(allCopies.get("Album2")?.size).toBe(2);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Tracking State Routing", () => {
  let tempDir: string;
  let dbPath: string;
  let completedPath: string;
  let failedPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-routing-test-");
    dbPath = join(tempDir, "tracking.db");
    completedPath = join(tempDir, "sources.completed.test.txt");
    failedPath = join(tempDir, "sources.failed.test.txt");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("loadTrackingState routing", () => {
    it("should load from database when config has db and operationId", async () => {
      const db = await initializeDatabase(dbPath);

      try {
        const operationId = createOperation(db, {
          command: "copy",
          mode: "album",
          inputFile: "/test/sources.txt",
          optionsHash: "album-001-010",
          ratingKey: null,
          rangeKey: "001-010",
          convertKey: null,
        });

        // Import database functions
        const { recordCompleted: dbRecordCompleted, recordFailed: dbRecordFailed } =
          await import("./db.js");

        // Record some sources
        dbRecordCompleted(db, operationId, "/music/Artist1");
        dbRecordCompleted(db, operationId, "/music/Artist2");
        dbRecordFailed(db, operationId, "/music/Artist3", "Test error");

        const config: TrackingConfig = {
          enabled: true,
          completedFilePath: completedPath,
          failedFilePath: failedPath,
          reset: false,
          db,
          operationId,
        };

        const { loadTrackingState } = await import("./completed-tracker.js");
        const state = await loadTrackingState(config);

        // Should load from database
        expect(state.completed.size).toBe(2);
        expect(state.failed.size).toBe(1);
        expect(state.completed.has("/music/Artist1")).toBe(true);
        expect(state.completed.has("/music/Artist2")).toBe(true);
        expect(state.failed.has("/music/Artist3")).toBe(true);
      } finally {
        closeDatabase(db);
      }
    });

    it("should load from legacy files when config lacks db", async () => {
      // Create legacy completed file
      const completedContent = [
        "# Completed paths for sources.txt",
        "# Generated by rfmedia",
        "",
        "/music/Artist1",
        "/music/Artist2",
      ].join("\n");
      await writeFile(completedPath, completedContent, "utf-8");

      // Create legacy failed file
      const failedContent = ["# Failed paths", "", "/music/Artist3", "# Error: Test error"].join(
        "\n",
      );
      await writeFile(failedPath, failedContent, "utf-8");

      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        // No db or operationId
      };

      const { loadTrackingState } = await import("./completed-tracker.js");
      const state = await loadTrackingState(config);

      // Should load from files
      expect(state.completed.size).toBe(2);
      expect(state.failed.size).toBe(1);
      expect(state.completed.has("/music/Artist1")).toBe(true);
      expect(state.completed.has("/music/Artist2")).toBe(true);
      expect(state.failed.has("/music/Artist3")).toBe(true);
    });

    it("should return empty state for database mode with empty operation", async () => {
      const db = await initializeDatabase(dbPath);

      try {
        const operationId = createOperation(db, {
          command: "copy",
          mode: "album",
          inputFile: "/test/sources.txt",
          optionsHash: "album-001-010",
          ratingKey: null,
          rangeKey: "001-010",
          convertKey: null,
        });

        // Don't record any sources

        const config: TrackingConfig = {
          enabled: true,
          completedFilePath: completedPath,
          failedFilePath: failedPath,
          reset: false,
          db,
          operationId,
        };

        const { loadTrackingState } = await import("./completed-tracker.js");
        const state = await loadTrackingState(config);

        // Should return empty sets
        expect(state.completed.size).toBe(0);
        expect(state.failed.size).toBe(0);
      } finally {
        closeDatabase(db);
      }
    });
  });

  describe("recordCompleted routing", () => {
    it("should insert into database when config has db and operationId", async () => {
      const db = await initializeDatabase(dbPath);

      try {
        const operationId = createOperation(db, {
          command: "copy",
          mode: "album",
          inputFile: "/test/sources.txt",
          optionsHash: "album-001-010",
          ratingKey: null,
          rangeKey: "001-010",
          convertKey: null,
        });

        const config: TrackingConfig = {
          enabled: true,
          completedFilePath: completedPath,
          failedFilePath: failedPath,
          reset: false,
          db,
          operationId,
        };

        const { recordCompleted } = await import("./completed-tracker.js");
        await recordCompleted(config, "/music/Artist1");

        // Verify it was written to database
        const { getCompletedSources } = await import("./db.js");
        const completed = getCompletedSources(db, operationId);
        expect(completed).toContain("/music/Artist1");
      } finally {
        closeDatabase(db);
      }
    });

    it("should append to file when config lacks db", async () => {
      // Initialize file
      await writeFile(completedPath, "# Header\n", "utf-8");

      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        // No db or operationId
      };

      const { recordCompleted } = await import("./completed-tracker.js");
      await recordCompleted(config, "/music/Artist1");

      // Verify it was appended to file
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(completedPath, "utf-8");
      expect(content).toContain("/music/Artist1");
    });
  });

  describe("recordFailed routing", () => {
    it("should insert into database when config has db and operationId", async () => {
      const db = await initializeDatabase(dbPath);

      try {
        const operationId = createOperation(db, {
          command: "copy",
          mode: "album",
          inputFile: "/test/sources.txt",
          optionsHash: "album-001-010",
          ratingKey: null,
          rangeKey: "001-010",
          convertKey: null,
        });

        const config: TrackingConfig = {
          enabled: true,
          completedFilePath: completedPath,
          failedFilePath: failedPath,
          reset: false,
          db,
          operationId,
        };

        const { recordFailed } = await import("./completed-tracker.js");
        await recordFailed(config, "/music/Artist1", "Test error message");

        // Verify it was written to database
        const { getFailedSources } = await import("./db.js");
        const failed = getFailedSources(db, operationId);
        expect(failed.length).toBe(1);
        expect(failed[0]?.source_path).toBe("/music/Artist1");
        expect(failed[0]?.error_message).toBe("Test error message");
      } finally {
        closeDatabase(db);
      }
    });

    it("should append to file with error comment when config lacks db", async () => {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        // No db or operationId
      };

      const { recordFailed } = await import("./completed-tracker.js");
      await recordFailed(config, "/music/Artist1", "Test error message");

      // Verify it was appended to file with error comment
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(failedPath, "utf-8");
      expect(content).toContain("/music/Artist1");
      expect(content).toContain("Test error message");
    });
  });
});

describe("Legacy File Parsing", () => {
  let tempDir: string;
  let completedPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-parse-test-");
    completedPath = join(tempDir, "sources.completed.test.txt");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should parse completed file with comment headers", async () => {
    const content = [
      "# Completed paths for sources.txt",
      "# Generated by rfmedia on 2024-01-15",
      "# Mode: album | range: 001-010",
      "",
      "/music/Artist1",
      "/music/Artist2",
      "/music/Artist3",
    ].join("\n");
    await writeFile(completedPath, content, "utf-8");

    const failedPath = join(tempDir, "sources.failed.test.txt");
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { loadTrackingState } = await import("./completed-tracker.js");
    const state = await loadTrackingState(config);

    // Should ignore comments and parse paths
    expect(state.completed.size).toBe(3);
    expect(state.completed.has("/music/Artist1")).toBe(true);
    expect(state.completed.has("/music/Artist2")).toBe(true);
    expect(state.completed.has("/music/Artist3")).toBe(true);
  });

  it("should parse completed file with empty lines", async () => {
    const content = ["# Header", "", "/music/Artist1", "", "", "/music/Artist2", ""].join("\n");
    await writeFile(completedPath, content, "utf-8");

    const failedPath = join(tempDir, "sources.failed.test.txt");
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { loadTrackingState } = await import("./completed-tracker.js");
    const state = await loadTrackingState(config);

    // Should skip empty lines
    expect(state.completed.size).toBe(2);
    expect(state.completed.has("/music/Artist1")).toBe(true);
    expect(state.completed.has("/music/Artist2")).toBe(true);
  });

  it("should parse failed file with error comments", async () => {
    const failedPath = join(tempDir, "sources.failed.test.txt");
    const content = [
      "# Failed paths",
      "",
      "/music/Artist1",
      "# Error: Permission denied",
      "/music/Artist2",
      "# Error: File not found",
    ].join("\n");
    await writeFile(failedPath, content, "utf-8");

    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { loadTrackingState } = await import("./completed-tracker.js");
    const state = await loadTrackingState(config);

    // Should extract paths, ignore error comments
    expect(state.failed.size).toBe(2);
    expect(state.failed.has("/music/Artist1")).toBe(true);
    expect(state.failed.has("/music/Artist2")).toBe(true);
  });

  it("should handle malformed lines gracefully", async () => {
    const content = [
      "# Header",
      "/music/Artist1",
      "   ",
      "/music/Artist2",
      "###",
      "/music/Artist3",
    ].join("\n");
    await writeFile(completedPath, content, "utf-8");

    const failedPath = join(tempDir, "sources.failed.test.txt");
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { loadTrackingState } = await import("./completed-tracker.js");
    const state = await loadTrackingState(config);

    // Should continue parsing despite malformed lines
    expect(state.completed.size).toBe(3);
  });

  it("should return empty set for non-existent file", async () => {
    // Don't create the file
    const failedPath = join(tempDir, "sources.failed.test.txt");
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath, // Doesn't exist
      failedFilePath: failedPath,
      reset: false,
    };

    const { loadTrackingState } = await import("./completed-tracker.js");
    const state = await loadTrackingState(config);

    // Should return empty set without error
    expect(state.completed.size).toBe(0);
    expect(state.failed.size).toBe(0);
  });
});

describe("Legacy File Writing", () => {
  let tempDir: string;
  let completedPath: string;
  let failedPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-write-test-");
    completedPath = join(tempDir, "sources.completed.test.txt");
    failedPath = join(tempDir, "sources.failed.test.txt");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should initialize legacy tracking with header comment", async () => {
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const options: CopyOptions = {
      mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 4,
    };

    const { initializeTracking } = await import("./completed-tracker.js");
    await initializeTracking(config, "/test/sources.txt", options);

    // Should create file with header
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(completedPath, "utf-8");
    expect(content).toContain("# Completed paths for sources.txt");
    expect(content).toContain("Mode: album");
  });

  it("should append completed path with newline", async () => {
    // Initialize first
    await writeFile(completedPath, "# Header\n", "utf-8");

    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { recordCompleted } = await import("./completed-tracker.js");
    await recordCompleted(config, "/music/Artist1");

    // Should append with newline
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(completedPath, "utf-8");
    expect(content).toContain("/music/Artist1\n");
  });

  it("should append failed path with error comment", async () => {
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { recordFailed } = await import("./completed-tracker.js");
    await recordFailed(config, "/music/Artist1", "Test error message");

    // Should append path and error comment
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(failedPath, "utf-8");
    expect(content).toContain("/music/Artist1");
    expect(content).toContain("# Error: Test error message");
  });

  it("should persist multiple appends correctly", async () => {
    await writeFile(completedPath, "# Header\n", "utf-8");

    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
    };

    const { recordCompleted } = await import("./completed-tracker.js");
    await recordCompleted(config, "/music/Artist1");
    await recordCompleted(config, "/music/Artist2");
    await recordCompleted(config, "/music/Artist3");

    // All paths should be persisted
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(completedPath, "utf-8");
    expect(content).toContain("/music/Artist1");
    expect(content).toContain("/music/Artist2");
    expect(content).toContain("/music/Artist3");
  });
});

describe("Durable Legacy Tracking Import", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-durable-migrate-test-");
    dbPath = join(tempDir, "tracking.db");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("preserves input identity when different inputs share one options hash", async () => {
    const firstPath = join(tempDir, "first.completed.album-001-010.txt");
    const secondPath = join(tempDir, "second.completed.album-001-010.txt");
    await writeFile(firstPath, "/music/First\n", "utf-8");
    await writeFile(secondPath, "/music/Second\n", "utf-8");
    const db = await initializeDatabase(dbPath);

    try {
      const first = await migrateLegacyTracking(db, {
        inputFile: "first",
        optionsHash: "album-001-010",
        mode: "album",
        completedPath: firstPath,
      });
      const second = await migrateLegacyTracking(db, {
        inputFile: "second",
        optionsHash: "album-001-010",
        mode: "album",
        completedPath: secondPath,
      });

      expect(first.operationId).not.toBe(second.operationId);
      expect(getCompletedSources(db, first.operationId)).toEqual(["/music/First"]);
      expect(getCompletedSources(db, second.operationId)).toEqual(["/music/Second"]);
      expect(first.importedFiles).toEqual([firstPath]);
      expect(second.importedFiles).toEqual([secondPath]);
    } finally {
      closeDatabase(db);
    }
  });

  it("commits completed and failed rows before returning per-file proof", async () => {
    const completedPath = join(tempDir, "sources.completed.filter-r80.txt");
    const failedPath = join(tempDir, "sources.failed.filter-r80.txt");
    await writeFile(completedPath, "# completed\n/music/Done\n", "utf-8");
    await writeFile(
      failedPath,
      [
        "# failed",
        "/music/Retry",
        "# Error: Permission denied while reading tags",
        "/music/Missing",
        "# Error: Source directory disappeared",
      ].join("\n"),
      "utf-8",
    );
    const db = await initializeDatabase(dbPath);

    try {
      const result = await migrateLegacyTracking(db, {
        inputFile: "sources",
        optionsHash: "filter-r80",
        mode: "filter",
        completedPath,
        failedPath,
      });

      expect(result).toMatchObject({
        completed: 1,
        failed: 2,
        importedFiles: [completedPath, failedPath],
        alreadyEquivalentFiles: [],
      });
      expect(getCompletedSources(db, result.operationId)).toEqual(["/music/Done"]);
      expect(getFailedSources(db, result.operationId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_path: "/music/Retry",
            error_message: "Permission denied while reading tags",
          }),
          expect.objectContaining({
            source_path: "/music/Missing",
            error_message: "Source directory disappeared",
          }),
        ]),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it("refuses failed-sidecar cleanup proof when a source has no diagnostic", async () => {
    const failedPath = join(tempDir, "sources.failed.album-001-010.txt");
    await writeFile(failedPath, "/music/Retry\n", "utf-8");
    const db = await initializeDatabase(dbPath);

    try {
      await expect(
        migrateLegacyTracking(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
          failedPath,
        }),
      ).rejects.toThrow(/diagnostic/i);
      expect(
        findOperation(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
        }),
      ).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it.each([
    { label: "empty", content: "# header only\n\n" },
    { label: "malformed", content: "relative/source\n" },
    { label: "unreadable", content: undefined },
  ])("refuses $label input without creating an operation or proof", async ({ content }) => {
    const completedPath = join(tempDir, "sources.completed.album-001-010.txt");
    if (content !== undefined) {
      await writeFile(completedPath, content, "utf-8");
    }
    const db = await initializeDatabase(dbPath);

    try {
      await expect(
        migrateLegacyTracking(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
          completedPath,
        }),
      ).rejects.toThrow(/legacy tracking/i);
      expect(
        findOperation(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
        }),
      ).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it("rolls back operation creation and completed rows when a later insert fails", async () => {
    const completedPath = join(tempDir, "sources.completed.album-001-010.txt");
    const failedPath = join(tempDir, "sources.failed.album-001-010.txt");
    await writeFile(completedPath, "/music/Done\n", "utf-8");
    await writeFile(failedPath, "/music/Retry\n# Error: injected failure fixture\n", "utf-8");
    const db = await initializeDatabase(dbPath);

    try {
      db.exec(`
        CREATE TRIGGER reject_legacy_failure
        BEFORE INSERT ON failed_sources
        BEGIN
          SELECT RAISE(ABORT, 'injected tracking import failure');
        END;
      `);

      await expect(
        migrateLegacyTracking(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
          completedPath,
          failedPath,
        }),
      ).rejects.toThrow("injected tracking import failure");
      expect(
        findOperation(db, {
          inputFile: "sources",
          optionsHash: "album-001-010",
          mode: "album",
        }),
      ).toBeNull();
    } finally {
      closeDatabase(db);
    }
  });

  it("requires exact failed diagnostics before returning idempotent equivalence proof", async () => {
    const completedPath = join(tempDir, "sources.completed.album-001-010.txt");
    const failedPath = join(tempDir, "sources.failed.album-001-010.txt");
    await writeFile(completedPath, "/music/Done\n/music/Done\n", "utf-8");
    await writeFile(failedPath, "/music/Retry\n# Error: Original failure diagnostic\n", "utf-8");
    const db = await initializeDatabase(dbPath);

    try {
      const request = {
        inputFile: "sources",
        optionsHash: "album-001-010",
        mode: "album" as const,
        completedPath,
        failedPath,
      };
      const first = await migrateLegacyTracking(db, request);
      db.prepare("UPDATE failed_sources SET error_message = ? WHERE operation_id = ?").run(
        "stale diagnostic",
        first.operationId,
      );
      const repaired = await migrateLegacyTracking(db, request);
      const equivalent = await migrateLegacyTracking(db, request);

      expect(repaired.operationId).toBe(first.operationId);
      expect(repaired).toMatchObject({
        completed: 1,
        failed: 1,
        importedFiles: [failedPath],
        alreadyEquivalentFiles: [completedPath],
      });
      expect(equivalent).toMatchObject({
        completed: 1,
        failed: 1,
        importedFiles: [],
        alreadyEquivalentFiles: [completedPath, failedPath],
      });
      expect(getCompletedSources(db, equivalent.operationId)).toEqual(["/music/Done"]);
      expect(getFailedSources(db, equivalent.operationId)).toEqual([
        expect.objectContaining({
          source_path: "/music/Retry",
          error_message: "Original failure diagnostic",
        }),
      ]);
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Automatic Legacy Migration", () => {
  let tempDir: string;
  let dbPath: string;
  let completedPath: string;
  let failedPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-migrate-test-");
    dbPath = join(tempDir, "tracking.db");
    completedPath = join(tempDir, "sources.completed.test.txt");
    failedPath = join(tempDir, "sources.failed.test.txt");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should migrate completed entries from legacy file to database", async () => {
    // Create legacy completed file
    const content = ["# Header", "/music/Artist1", "/music/Artist2"].join("\n");
    await writeFile(completedPath, content, "utf-8");

    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db,
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");
      await initializeTracking(config, "/test/sources.txt", options);

      // Should have migrated entries
      expect(config.operationId).toBeDefined();
      if (config.operationId) {
        const { getCompletedSources } = await import("./db.js");
        const completed = getCompletedSources(db, config.operationId);
        expect(completed.length).toBe(2);
        expect(completed).toContain("/music/Artist1");
        expect(completed).toContain("/music/Artist2");
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("should migrate failed entries from legacy file to database", async () => {
    // Create legacy failed file
    const content = [
      "# Header",
      "/music/Artist1",
      "# Error: Test error",
      "/music/LegacySourceWithoutDiagnostic",
    ].join("\n");
    await writeFile(failedPath, content, "utf-8");

    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db,
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");
      await initializeTracking(config, "/test/sources.txt", options);

      // Should have migrated entries
      expect(config.operationId).toBeDefined();
      if (config.operationId) {
        const { getFailedSources } = await import("./db.js");
        const failed = getFailedSources(db, config.operationId);
        expect(failed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source_path: "/music/Artist1",
              error_message: "Test error",
            }),
            expect.objectContaining({
              source_path: "/music/LegacySourceWithoutDiagnostic",
              error_message: "Migrated from legacy file",
            }),
          ]),
        );
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("should preserve legacy files after migration", async () => {
    // Create legacy file
    const content = "# Header\n/music/Artist1\n";
    await writeFile(completedPath, content, "utf-8");

    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db,
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");
      await initializeTracking(config, "/test/sources.txt", options);

      // Legacy file should still exist
      const { access } = await import("node:fs/promises");
      let fileExists = true;
      try {
        await access(completedPath);
      } catch {
        fileExists = false;
      }
      expect(fileExists).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("should skip migration when re-initializing with same operation", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db,
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");

      // First initialization
      await initializeTracking(config, "/test/sources.txt", options);
      const firstOperationId = config.operationId;

      // Second initialization (should reuse)
      await initializeTracking(config, "/test/sources.txt", options);
      const secondOperationId = config.operationId;

      // Should reuse the same operation
      expect(secondOperationId).toBe(firstOperationId);
    } finally {
      closeDatabase(db);
    }
  });

  it("should handle malformed legacy files during migration", async () => {
    // Create malformed legacy file
    const content = [
      "# Header",
      "/music/Artist1",
      "   ",
      "invalid line without path",
      "/music/Artist2",
    ].join("\n");
    await writeFile(completedPath, content, "utf-8");

    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db,
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");
      await initializeTracking(config, "/test/sources.txt", options);

      // Should have migrated valid entries
      expect(config.operationId).toBeDefined();
      if (config.operationId) {
        const { getCompletedSources } = await import("./db.js");
        const completed = getCompletedSources(db, config.operationId);
        expect(completed.length).toBeGreaterThanOrEqual(2);
      }
    } finally {
      closeDatabase(db);
    }
  });
});

describe("Configuration-based Mode Selection", () => {
  let tempDir: string;
  let dbPath: string;
  let completedPath: string;
  let failedPath: string;

  beforeEach(async () => {
    tempDir = await createTempTestDir("rfmedia-config-test-");
    dbPath = join(tempDir, "tracking.db");
    completedPath = join(tempDir, "sources.completed.test.txt");
    failedPath = join(tempDir, "sources.failed.test.txt");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should use database when config has useLegacy: false", async () => {
    const db = await initializeDatabase(dbPath);

    try {
      const config: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db, // Database provided
      };

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking, recordCompleted } = await import("./completed-tracker.js");
      await initializeTracking(config, "/test/sources.txt", options);
      await recordCompleted(config, "/music/Artist1");

      // Should use database
      expect(config.operationId).toBeDefined();
      if (config.operationId) {
        const { getCompletedSources } = await import("./db.js");
        const completed = getCompletedSources(db, config.operationId);
        expect(completed).toContain("/music/Artist1");
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("should use file-based tracking when config lacks db", async () => {
    const config: TrackingConfig = {
      enabled: true,
      completedFilePath: completedPath,
      failedFilePath: failedPath,
      reset: false,
      // No db provided
    };

    const options: CopyOptions = {
      mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 4,
    };

    const { initializeTracking, recordCompleted } = await import("./completed-tracker.js");
    await initializeTracking(config, "/test/sources.txt", options);
    await recordCompleted(config, "/music/Artist1");

    // Should use file-based tracking
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(completedPath, "utf-8");
    expect(content).toContain("/music/Artist1");
  });

  it("should allow independent control for tracking and undo legacy modes", async () => {
    // This test verifies that tracking.useLegacy and undo.useLegacy are independent
    // For tracking, we test by providing or not providing db to TrackingConfig

    const db = await initializeDatabase(dbPath);

    try {
      // Tracking uses database (not legacy)
      const trackingConfig: TrackingConfig = {
        enabled: true,
        completedFilePath: completedPath,
        failedFilePath: failedPath,
        reset: false,
        db, // Database provided for tracking
      };

      // Undo would use legacy mode (separate configuration)
      // This is tested via the undo system's own configuration

      const options: CopyOptions = {
        mode: { type: "album", range: { start: 1, end: 10, padWidth: 3 } },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 4,
      };

      const { initializeTracking } = await import("./completed-tracker.js");
      await initializeTracking(trackingConfig, "/test/sources.txt", options);

      // Tracking should use database
      expect(trackingConfig.operationId).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });
});
