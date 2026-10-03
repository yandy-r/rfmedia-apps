/**
 * Tests for sync-helper.ts - Sync helper for rating synchronization during copy operations.
 *
 * Tests the syncTrackRating() function that syncs Plex ratings to file metadata
 * during copy operations, ensuring it handles various edge cases correctly.
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock definitions with vi.hoisted() - must be defined before vi.mock() calls
const mockFunctions = vi.hoisted(() => ({
  writeRating: vi.fn().mockResolvedValue({ success: true, message: "Rating written" }),
  plexToNormalized: vi.fn((rating: number) => rating / 10),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  formatDryRun: vi.fn((msg: string) => `[DRY RUN] ${msg}`),
}));

vi.mock("./tag-writer.js", () => ({
  writeRating: mockFunctions.writeRating,
}));

vi.mock("./ratings.js", () => ({
  plexToNormalized: mockFunctions.plexToNormalized,
}));

vi.mock("./logger.js", () => ({
  logDebug: mockFunctions.logDebug,
  logInfo: mockFunctions.logInfo,
  formatDryRun: mockFunctions.formatDryRun,
}));

// Import after mocks
import { syncTrackRating } from "./sync-helper.js";

describe("syncTrackRating", () => {
  beforeEach(() => {
    // Clear mocks but preserve implementations
    vi.clearAllMocks();

    // Re-establish default mock implementations after clearAllMocks
    mockFunctions.writeRating.mockResolvedValue({
      success: true,
      message: "Rating written",
    });
    mockFunctions.plexToNormalized.mockImplementation((rating: number) => rating / 10);
    mockFunctions.formatDryRun.mockImplementation((msg: string) => `[DRY RUN] ${msg}`);
  });

  describe("unrated tracks", () => {
    it("should skip unrated tracks (userRating === 0) and return success with skipped reason", async () => {
      const result = await syncTrackRating("/path/to/file.flac", 0);

      expect(result).toEqual({ success: true, skipped: "unrated" });
      expect(mockFunctions.writeRating).not.toHaveBeenCalled();
      expect(mockFunctions.plexToNormalized).not.toHaveBeenCalled();
    });
  });

  describe("rated tracks", () => {
    it("should call writeRating with normalized value for rated tracks", async () => {
      const destPath = "/path/to/dest.flac";
      const plexRating = 8; // 0-10 scale

      const result = await syncTrackRating(destPath, plexRating);

      expect(result).toEqual({ success: true });
      expect(mockFunctions.plexToNormalized).toHaveBeenCalledWith(8);
      expect(mockFunctions.writeRating).toHaveBeenCalledWith(
        destPath,
        0.8, // 8 / 10 = 0.8
        { popmEmail: undefined, vorbisScale: undefined },
      );
    });

    it("should handle maximum rating (10)", async () => {
      const destPath = "/path/to/dest.flac";

      const result = await syncTrackRating(destPath, 10);

      expect(result).toEqual({ success: true });
      expect(mockFunctions.plexToNormalized).toHaveBeenCalledWith(10);
      expect(mockFunctions.writeRating).toHaveBeenCalledWith(
        destPath,
        1.0, // 10 / 10 = 1.0
        expect.any(Object),
      );
    });

    it("should handle minimum non-zero rating (1)", async () => {
      const destPath = "/path/to/dest.flac";

      const result = await syncTrackRating(destPath, 1);

      expect(result).toEqual({ success: true });
      expect(mockFunctions.plexToNormalized).toHaveBeenCalledWith(1);
      expect(mockFunctions.writeRating).toHaveBeenCalledWith(
        destPath,
        0.1, // 1 / 10 = 0.1
        expect.any(Object),
      );
    });
  });

  describe("dry-run mode", () => {
    it("should log intent and not call writeRating in dry-run mode", async () => {
      const destPath = "/path/to/dest.flac";
      const plexRating = 8;

      const result = await syncTrackRating(destPath, plexRating, {
        dryRun: true,
      });

      expect(result).toEqual({ success: true });
      expect(mockFunctions.writeRating).not.toHaveBeenCalled();
      expect(mockFunctions.plexToNormalized).toHaveBeenCalledWith(8);
      expect(mockFunctions.formatDryRun).toHaveBeenCalledWith(
        expect.stringContaining("Would sync rating"),
      );
      expect(mockFunctions.logInfo).toHaveBeenCalledWith(expect.stringContaining("[DRY RUN]"));
    });

    it("should include normalized rating in dry-run log message", async () => {
      const destPath = "/path/to/dest.mp3";
      const plexRating = 6;

      await syncTrackRating(destPath, plexRating, { dryRun: true });

      expect(mockFunctions.formatDryRun).toHaveBeenCalledWith(expect.stringContaining("0.60"));
      expect(mockFunctions.formatDryRun).toHaveBeenCalledWith(expect.stringContaining(destPath));
    });

    it("should still skip unrated tracks in dry-run mode", async () => {
      const result = await syncTrackRating("/path/to/file.flac", 0, {
        dryRun: true,
      });

      expect(result).toEqual({ success: true, skipped: "unrated" });
      expect(mockFunctions.logInfo).not.toHaveBeenCalled();
      expect(mockFunctions.formatDryRun).not.toHaveBeenCalled();
    });
  });

  describe("writeRating failure handling", () => {
    it("should return failure (not throw) when writeRating fails", async () => {
      mockFunctions.writeRating.mockResolvedValue({
        success: false,
        message: "File is read-only",
      });

      const result = await syncTrackRating("/path/to/file.flac", 8);

      expect(result).toEqual({ success: false, message: "File is read-only" });
    });

    it("should return failure when writeRating returns unsupported format error", async () => {
      mockFunctions.writeRating.mockResolvedValue({
        success: false,
        message: "Unsupported format: m4a",
      });

      const result = await syncTrackRating("/path/to/file.m4a", 8);

      expect(result).toEqual({
        success: false,
        message: "Unsupported format: m4a",
      });
    });

    it("should catch and return unexpected errors from writeRating", async () => {
      mockFunctions.writeRating.mockRejectedValue(new Error("Unexpected disk error"));

      const result = await syncTrackRating("/path/to/file.flac", 8);

      expect(result).toEqual({
        success: false,
        message: "Unexpected disk error",
      });
    });

    it("should handle non-Error throws from writeRating", async () => {
      mockFunctions.writeRating.mockRejectedValue("String error");

      const result = await syncTrackRating("/path/to/file.flac", 8);

      expect(result).toEqual({ success: false, message: "String error" });
    });
  });

  describe("options pass-through", () => {
    it("should pass popmEmail option to writeRating", async () => {
      const destPath = "/path/to/dest.mp3";

      await syncTrackRating(destPath, 8, { popmEmail: "custom@email.com" });

      expect(mockFunctions.writeRating).toHaveBeenCalledWith(destPath, 0.8, {
        popmEmail: "custom@email.com",
        vorbisScale: undefined,
      });
    });

    it("should pass vorbisScale option to writeRating", async () => {
      const destPath = "/path/to/dest.flac";

      await syncTrackRating(destPath, 8, { vorbisScale: "stars" });

      expect(mockFunctions.writeRating).toHaveBeenCalledWith(destPath, 0.8, {
        popmEmail: undefined,
        vorbisScale: "stars",
      });
    });

    it("should pass both popmEmail and vorbisScale options to writeRating", async () => {
      const destPath = "/path/to/dest.flac";

      await syncTrackRating(destPath, 8, {
        popmEmail: "user@example.com",
        vorbisScale: "percent",
      });

      expect(mockFunctions.writeRating).toHaveBeenCalledWith(destPath, 0.8, {
        popmEmail: "user@example.com",
        vorbisScale: "percent",
      });
    });

    it("should pass normalized vorbisScale option", async () => {
      const destPath = "/path/to/dest.flac";

      await syncTrackRating(destPath, 6, { vorbisScale: "normalized" });

      expect(mockFunctions.writeRating).toHaveBeenCalledWith(destPath, 0.6, {
        popmEmail: undefined,
        vorbisScale: "normalized",
      });
    });
  });

  describe("logging", () => {
    it("should log debug message on successful sync", async () => {
      const destPath = "/path/to/dest.flac";

      await syncTrackRating(destPath, 8);

      expect(mockFunctions.logDebug).toHaveBeenCalledWith(expect.stringContaining("Synced rating"));
      expect(mockFunctions.logDebug).toHaveBeenCalledWith(expect.stringContaining("0.80"));
      expect(mockFunctions.logDebug).toHaveBeenCalledWith(expect.stringContaining(destPath));
    });

    it("should not log debug message when writeRating fails", async () => {
      mockFunctions.writeRating.mockResolvedValue({
        success: false,
        message: "Write failed",
      });

      await syncTrackRating("/path/to/dest.flac", 8);

      expect(mockFunctions.logDebug).not.toHaveBeenCalled();
    });

    it("should not log debug message for skipped unrated tracks", async () => {
      await syncTrackRating("/path/to/dest.flac", 0);

      expect(mockFunctions.logDebug).not.toHaveBeenCalled();
    });
  });
});
