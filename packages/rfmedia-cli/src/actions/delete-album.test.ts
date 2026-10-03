/**
 * Tests for delete-album action.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeAlbumDelete } from "./delete-album.js";
import { pathExists } from "../lib/filesystem.js";
import type { DeleteOptions, DeleteMode } from "../types/index.js";

// Mock the logger to suppress output during tests
vi.mock("../lib/logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((msg: string) => `[DRY-RUN] ${msg}`),
  isJsonMode: vi.fn(() => false),
}));

// Mock progress.js
vi.mock("../lib/progress.js", () => ({
  withSpinner: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
}));

describe("executeAlbumDelete", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create temp directory structure
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-delete-test-"));
    sourceDir = path.join(tempDir, "source", "Artist");
    destDir = path.join(tempDir, "dest");

    // Create source artist with albums
    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(sourceDir, "Album1"));
    await writeFile(path.join(sourceDir, "Album1", "track.flac"), "dummy");

    // Create destination with numbered copies
    const artistDest = path.join(destDir, "Artist");
    await mkdir(artistDest, { recursive: true });

    // Create Album1-001 through Album1-005
    for (let i = 1; i <= 5; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(artistDest, `Album1-${suffix}`);
      await mkdir(albumDir);
      await writeFile(path.join(albumDir, "track.flac"), "dummy");
    }
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create delete options.
   */
  function createOptions(overrides: Partial<DeleteOptions> = {}): DeleteOptions {
    const mode: DeleteMode = overrides.mode ?? { type: "album", range: undefined };
    return {
      mode,
      albumOnly: false,
      force: true, // Skip confirmation in tests
      dryRun: false,
      workers: 1,
      useTrash: false,
      keepTracking: true, // Don't try to update DB in tests
      ...overrides,
    };
  }

  it("should delete all album copies when no range/count specified", async () => {
    const options = createOptions();

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    expect(result.deleted).toBe(5);
    expect(result.failed).toHaveLength(0);

    // Verify all copies are deleted
    for (let i = 1; i <= 5; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(destDir, "Artist", `Album1-${suffix}`);
      expect(await pathExists(albumDir)).toBe(false);
    }
  });

  it("should delete only highest N copies when --count is specified", async () => {
    const options = createOptions({ count: 2 });

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    expect(result.deleted).toBe(2);
    expect(result.failed).toHaveLength(0);

    // Verify highest copies are deleted (005, 004)
    expect(await pathExists(path.join(destDir, "Artist", "Album1-005"))).toBe(false);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-004"))).toBe(false);

    // Verify lower copies remain (001, 002, 003)
    expect(await pathExists(path.join(destDir, "Artist", "Album1-001"))).toBe(true);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-002"))).toBe(true);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-003"))).toBe(true);
  });

  it("should delete only copies within specified range", async () => {
    const mode: DeleteMode = {
      type: "album",
      range: { start: 2, end: 4, padWidth: 3 },
    };
    const options = createOptions({
      mode,
      cliRange: { start: 2, end: 4, padWidth: 3 },
    });

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    expect(result.deleted).toBe(3);
    expect(result.failed).toHaveLength(0);

    // Verify copies in range are deleted (002, 003, 004)
    expect(await pathExists(path.join(destDir, "Artist", "Album1-002"))).toBe(false);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-003"))).toBe(false);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-004"))).toBe(false);

    // Verify copies outside range remain (001, 005)
    expect(await pathExists(path.join(destDir, "Artist", "Album1-001"))).toBe(true);
    expect(await pathExists(path.join(destDir, "Artist", "Album1-005"))).toBe(true);
  });

  it("should preview deletions in dry-run mode without actually deleting", async () => {
    const options = createOptions({ dryRun: true });

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    expect(result.deleted).toBe(5);
    expect(result.failed).toHaveLength(0);

    // Verify all copies still exist
    for (let i = 1; i <= 5; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(destDir, "Artist", `Album1-${suffix}`);
      expect(await pathExists(albumDir)).toBe(true);
    }
  });

  it("should handle empty destination gracefully", async () => {
    // Create empty destination
    const emptyDest = path.join(tempDir, "empty-dest");
    await mkdir(emptyDest, { recursive: true });
    await mkdir(path.join(emptyDest, "Artist"));

    const options = createOptions();

    const result = await executeAlbumDelete(sourceDir, emptyDest, options);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("should handle non-existent destination gracefully", async () => {
    const nonExistentDest = path.join(tempDir, "non-existent");

    const options = createOptions();

    const result = await executeAlbumDelete(sourceDir, nonExistentDest, options);

    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  it("should process multiple albums when present", async () => {
    // Create second album copies
    const artistDest = path.join(destDir, "Artist");
    for (let i = 1; i <= 3; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(artistDest, `Album2-${suffix}`);
      await mkdir(albumDir);
      await writeFile(path.join(albumDir, "track.flac"), "dummy");
    }

    const options = createOptions({ count: 2 });

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    // Should delete 2 highest from each album series
    // Album1: 005, 004 deleted
    // Album2: 003, 002 deleted
    // But since --count applies globally to all discovered suffixes sorted descending,
    // it will delete the 2 highest overall
    // Actually, let's check: 005, 004 (from Album1), 003, 002, 001 (from Album2)
    // Sorted descending: 005, 004, 003, 002, 001 (Album1), 003, 002, 001 (Album2)
    // The count applies to ALL suffixes sorted by number, so:
    // 005, 004 get deleted (both from Album1)
    expect(result.deleted).toBe(2);
    expect(result.failed).toHaveLength(0);
  });
});

describe("reverse order processing", () => {
  let tempDir: string;
  let sourceDir: string;
  let destDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-reverse-test-"));
    sourceDir = path.join(tempDir, "source", "Artist");
    destDir = path.join(tempDir, "dest");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(sourceDir, "Album"));
    await writeFile(path.join(sourceDir, "Album", "track.flac"), "dummy");

    // Create 10 copies
    const artistDest = path.join(destDir, "Artist");
    await mkdir(artistDest, { recursive: true });

    for (let i = 1; i <= 10; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(artistDest, `Album-${suffix}`);
      await mkdir(albumDir);
      await writeFile(path.join(albumDir, "track.flac"), "dummy");
    }
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should delete highest suffixes first when using --count", async () => {
    const options: DeleteOptions = {
      mode: { type: "album", range: undefined },
      albumOnly: false,
      force: true,
      dryRun: false,
      workers: 1,
      useTrash: false,
      keepTracking: true,
      count: 5,
    };

    const result = await executeAlbumDelete(sourceDir, destDir, options);

    expect(result.deleted).toBe(5);

    // Highest 5 should be deleted (010, 009, 008, 007, 006)
    for (let i = 6; i <= 10; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(destDir, "Artist", `Album-${suffix}`);
      expect(await pathExists(albumDir)).toBe(false);
    }

    // Lowest 5 should remain (001, 002, 003, 004, 005)
    for (let i = 1; i <= 5; i++) {
      const suffix = String(i).padStart(3, "0");
      const albumDir = path.join(destDir, "Artist", `Album-${suffix}`);
      expect(await pathExists(albumDir)).toBe(true);
    }
  });
});
