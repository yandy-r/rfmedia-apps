/**
 * Unit tests for input file parsing with count and range detection.
 *
 * Tests cover:
 * - Count suffix parsing (pure digits)
 * - Range suffix parsing (with hyphen)
 * - No suffix (plain paths)
 * - Invalid suffixes
 * - Edge cases (zero count, negative count, paths with commas)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourcePaths } from "./input-file.js";

// Mock the logger to avoid console output during tests
vi.mock("./logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

describe("input-file: count and range detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create isolated temp directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "input-file-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("count suffix parsing", () => {
    it("should parse count suffix (single digit)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,5\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album", count: 5 }]);
    });

    it("should parse count suffix (multiple digits)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,42\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album", count: 42 }]);
    });

    it("should parse count with whitespace around suffix", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album, 10 \n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album", count: 10 }]);
    });

    it("should throw error for count less than 1 (zero)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,0\n", "utf-8");

      await expect(readSourcePaths(testFile)).rejects.toThrow(
        'Invalid count "0" for path "/music/Album": must be at least 1',
      );
    });

    it("should throw error for count less than 1 (negative via string)", async () => {
      const testFile = join(tempDir, "test.txt");
      // Note: parseInt('-5') would parse, but our regex /^\d+$/ won't match
      // So this should be treated as invalid suffix, not parsed as count
      await writeFile(testFile, "/music/Album,-5\n", "utf-8");

      const result = await readSourcePaths(testFile);

      // Since -5 doesn't match /^\d+$/, it's treated as part of the path
      expect(result).toEqual([{ path: "/music/Album,-5" }]);
    });
  });

  describe("range suffix parsing", () => {
    it("should parse range suffix", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,001-003\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([
        {
          path: "/music/Album",
          range: { start: 1, end: 3, padWidth: 3 },
        },
      ]);
    });

    it("should parse range with different padding", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,01-10\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([
        {
          path: "/music/Album",
          range: { start: 1, end: 10, padWidth: 2 },
        },
      ]);
    });

    it("should treat numeric range as range not count (e.g., 1-5)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,1-5\n", "utf-8");

      const result = await readSourcePaths(testFile);

      // This should be parsed as a range, not a count
      expect(result[0]?.range).toBeDefined();
      expect(result[0]?.count).toBeUndefined();
      expect(result[0]?.range?.start).toBe(1);
      expect(result[0]?.range?.end).toBe(5);
    });
  });

  describe("no suffix (plain paths)", () => {
    it("should parse path without suffix", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album" }]);
    });

    it("should handle path with no comma", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Artist/Album Name\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Artist/Album Name" }]);
    });
  });

  describe("invalid suffixes", () => {
    it("should treat invalid suffix as part of path (letters)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,abc\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album,abc" }]);
    });

    it("should treat empty suffix as part of path", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album," }]);
    });

    it("should treat suffix with spaces and text as invalid", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Album,5 copies\n", "utf-8");

      const result = await readSourcePaths(testFile);

      // Not pure digits, so treated as part of path
      expect(result).toEqual([{ path: "/music/Album,5 copies" }]);
    });
  });

  describe("paths with commas", () => {
    it("should handle path with comma using last comma as delimiter (count)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Artist, The/Album,3\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Artist, The/Album", count: 3 }]);
    });

    it("should handle path with comma using last comma as delimiter (range)", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Artist, The/Album,001-005\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([
        {
          path: "/music/Artist, The/Album",
          range: { start: 1, end: 5, padWidth: 3 },
        },
      ]);
    });

    it("should handle multiple commas in path", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "/music/Artist, The/Album, Vol. 2,10\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Artist, The/Album, Vol. 2", count: 10 }]);
    });
  });

  describe("mixed file with counts, ranges, and plain paths", () => {
    it("should parse file with mixed formats", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(
        testFile,
        [
          "/music/Artist1/Album1,4",
          "/music/Artist2/Album2,001-003",
          "/music/Artist3/Album3",
          "# This is a comment",
          "",
          "/music/Artist4/Album4,001-010",
          "/music/Artist5/Album5,7",
        ].join("\n"),
        "utf-8",
      );

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([
        { path: "/music/Artist1/Album1", count: 4 },
        {
          path: "/music/Artist2/Album2",
          range: { start: 1, end: 3, padWidth: 3 },
        },
        { path: "/music/Artist3/Album3" },
        {
          path: "/music/Artist4/Album4",
          range: { start: 1, end: 10, padWidth: 3 },
        },
        { path: "/music/Artist5/Album5", count: 7 },
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([]);
    });

    it("should skip comments and empty lines", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(
        testFile,
        ["# Comment 1", "", "/music/Album1,5", "# Comment 2", "", "/music/Album2"].join("\n"),
        "utf-8",
      );

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Album1", count: 5 }, { path: "/music/Album2" }]);
    });

    it("should handle shell-escaped paths with quotes", async () => {
      const testFile = join(tempDir, "test.txt");
      await writeFile(testFile, "'/music/Artist (2024)'/Album,3\n", "utf-8");

      const result = await readSourcePaths(testFile);

      expect(result).toEqual([{ path: "/music/Artist (2024)/Album", count: 3 }]);
    });
  });
});
