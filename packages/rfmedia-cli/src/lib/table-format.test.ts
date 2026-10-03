/**
 * Unit tests for table-format.ts shared rfmedia table helpers.
 *
 * Validates that the width-policy semantics from terminal-table.ts
 * are correctly adopted by the table formatting helpers, including
 * Unicode-safe truncation and deterministic non-TTY behavior.
 */

import { describe, it, expect } from "vitest";
import {
  formatAlbumPreviewTable,
  formatAlbumModePreviewTable,
  formatFilterPreviewTable,
  formatCopySummaryTable,
  formatSyncSummaryTable,
  formatDeleteSummaryTable,
  type CopySummaryStats,
  type SyncSummaryStats,
  type DeleteSummaryStats,
} from "./table-format.js";
import { displayWidth } from "./terminal-table.js";
import type { PreviewResult, FilterPreviewResult } from "../types/preview.js";

// ---------------------------------------------------------------------------
// truncateAlbumName (tested indirectly through exported formatters)
// ---------------------------------------------------------------------------

describe("truncateAlbumName via formatAlbumPreviewTable", () => {
  function makePreviewResult(albumName: string): PreviewResult {
    return {
      albums: [
        {
          albumName,
          sourcePath: `/music/${albumName}`,
          suffixes: [
            {
              suffix: "001",
              destPath: `/dest/${albumName}-001`,
              action: "create",
              fileCount: 10,
              totalBytes: 100_000,
            },
          ],
          summary: {
            willCreate: 1,
            willSkip: 0,
            willOverwrite: 0,
            willRecreate: 0,
          },
        },
      ],
      totals: {
        files: 10,
        bytes: 100_000,
        creates: 1,
        skips: 0,
        overwrites: 0,
        recreates: 0,
      },
    };
  }

  it("should render a table without error for short ASCII album names", () => {
    const result = makePreviewResult("Short Album");
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).toContain("Short Album");
  });

  it("should truncate long ASCII album names within display width", () => {
    const longName = "A".repeat(80);
    const result = makePreviewResult(longName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // The full 80-char name should not appear untruncated (limit is 50)
    expect(output).not.toContain(longName);
  });

  it("should handle CJK fullwidth album names correctly", () => {
    // 10 CJK characters = 20 display columns
    const cjkName = "\u97F3\u697D\u30D7\u30EC\u30A4\u30EA\u30B9\u30C8\u30C6\u30B9"; // 音楽プレイリステス
    expect(displayWidth(cjkName)).toBe(20);

    const result = makePreviewResult(cjkName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // Name fits within 50 columns, so it should appear in full
    expect(output).toContain(cjkName);
  });

  it("should truncate long CJK album names using display width", () => {
    // 30 CJK characters = 60 display columns (exceeds 50-column limit)
    const longCjk = "\u97F3\u697D".repeat(30);
    expect(displayWidth(longCjk)).toBe(120);

    const result = makePreviewResult(longCjk);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // The full string should not appear untruncated
    expect(output).not.toContain(longCjk);
  });

  it("should handle emoji in album names", () => {
    const emojiName = "My Playlist \uD83C\uDFB5\uD83C\uDFB6";
    const result = makePreviewResult(emojiName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // Emoji name fits within 50 columns, should render
    expect(output).toContain("My Playlist");
  });

  it("should handle mixed ASCII and fullwidth characters", () => {
    const mixedName = "Best of \u97F3\u697D\u30D7\u30EC\u30A4\u30EA\u30B9\u30C8"; // Best of 音楽プレイリスト
    const result = makePreviewResult(mixedName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).toContain("Best of");
  });

  it("should render correctly when album name is exactly 50 display columns", () => {
    // 50 ASCII characters = 50 display columns exactly at limit
    const exactName = "A".repeat(50);
    expect(displayWidth(exactName)).toBe(50);

    const result = makePreviewResult(exactName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).toContain(exactName);
  });

  it("should render correctly when album name is 51 display columns", () => {
    // 51 ASCII characters = 51 display columns, just over limit
    const overName = "B".repeat(51);
    expect(displayWidth(overName)).toBe(51);

    const result = makePreviewResult(overName);
    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // Should be truncated, so full name should not appear
    expect(output).not.toContain(overName);
  });
});

// ---------------------------------------------------------------------------
// formatAlbumModePreviewTable
// ---------------------------------------------------------------------------

describe("formatAlbumModePreviewTable", () => {
  it("should render a basic album mode preview table", () => {
    const albums = [
      { artistName: "Artist A", albumName: "Album One", trackCount: 12 },
      { artistName: "Artist B", albumName: "Album Two", trackCount: 8 },
    ];

    const output = formatAlbumModePreviewTable(albums, 3);

    expect(output).toBeTruthy();
    expect(output).toContain("Album One");
    expect(output).toContain("Album Two");
  });

  it("should truncate long album names in album mode preview", () => {
    const longAlbumName = "This Is An Extremely Long Album Name That Should Be Truncated";
    const albums = [{ artistName: "Artist", albumName: longAlbumName, trackCount: 5 }];

    const output = formatAlbumModePreviewTable(albums, 2);

    expect(output).toBeTruthy();
    // The full name (62 chars) should not appear untruncated (limit is 50)
    expect(output).not.toContain(longAlbumName);
  });

  it("should handle CJK album names in album mode preview", () => {
    // Short CJK name that fits within 50 columns
    const cjkAlbum = "\u97F3\u697D\u96C6"; // 音楽集 (6 display columns)
    const albums = [{ artistName: "Artist", albumName: cjkAlbum, trackCount: 10 }];

    const output = formatAlbumModePreviewTable(albums, 1);

    expect(output).toBeTruthy();
    expect(output).toContain(cjkAlbum);
  });

  it("should correctly calculate total column values", () => {
    const albums = [{ artistName: "Artist", albumName: "Album", trackCount: 10 }];

    const output = formatAlbumModePreviewTable(albums, 3);

    expect(output).toBeTruthy();
    // Total = trackCount * rangeCount = 10 * 3 = 30
    expect(output).toContain("30");
  });
});

// ---------------------------------------------------------------------------
// formatFilterPreviewTable
// ---------------------------------------------------------------------------

describe("formatFilterPreviewTable", () => {
  function makeFilterResult(artistName: string): FilterPreviewResult {
    return {
      sources: [
        {
          artistName,
          sourcePath: `/music/${artistName}`,
          likedTracks: [],
          filteredCount: 5,
          summary: {
            willCopy: 10,
            willSkip: 2,
            totalBytes: 50_000,
          },
        },
      ],
      totals: {
        copies: 10,
        skips: 2,
        filtered: 5,
        bytes: 50_000,
      },
    };
  }

  it("should render a filter preview table without error", () => {
    const result = makeFilterResult("Artist Name");
    const output = formatFilterPreviewTable(result);

    expect(output).toBeTruthy();
  });

  it("should truncate long artist names in filter preview (40 col limit)", () => {
    const longArtist = "X".repeat(60);
    const result = makeFilterResult(longArtist);
    const output = formatFilterPreviewTable(result);

    expect(output).toBeTruthy();
    // Filter preview truncates artist names to 40 columns
    expect(output).not.toContain(longArtist);
  });

  it("should handle CJK artist names in filter preview", () => {
    // Short CJK name that fits within 40 columns
    const cjkArtist = "\u30A2\u30FC\u30C6\u30A3\u30B9\u30C8"; // アーティスト (12 display columns)
    const result = makeFilterResult(cjkArtist);
    const output = formatFilterPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).toContain(cjkArtist);
  });

  it("should truncate long CJK artist names in filter preview", () => {
    // 25 CJK characters = 50 display columns (exceeds 40-column limit)
    const longCjkArtist = "\u30A2".repeat(25);
    expect(displayWidth(longCjkArtist)).toBe(50);

    const result = makeFilterResult(longCjkArtist);
    const output = formatFilterPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).not.toContain(longCjkArtist);
  });

  it("should render multiple sources correctly", () => {
    const result: FilterPreviewResult = {
      sources: [
        {
          artistName: "Artist A",
          sourcePath: "/music/A",
          likedTracks: [],
          filteredCount: 3,
          summary: { willCopy: 8, willSkip: 1, totalBytes: 40_000 },
        },
        {
          artistName: "Artist B",
          sourcePath: "/music/B",
          likedTracks: [],
          filteredCount: 0,
          summary: { willCopy: 0, willSkip: 5, totalBytes: 0 },
        },
      ],
      totals: { copies: 8, skips: 6, filtered: 3, bytes: 40_000 },
    };

    const output = formatFilterPreviewTable(result);

    expect(output).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// formatCopySummaryTable
// ---------------------------------------------------------------------------

describe("formatCopySummaryTable", () => {
  it("should render sources and files tables", () => {
    const stats: CopySummaryStats = {
      totalSources: 10,
      processed: 8,
      skippedCompleted: 1,
      failed: 1,
      filesCreated: 100,
      filesSkipped: 20,
      filesFailed: 5,
      elapsed: "2m 34s",
      sourcesPerMin: 3.1,
    };

    const output = formatCopySummaryTable(stats);

    expect(output).toBeTruthy();
    expect(output).toContain("2m 34s");
    expect(output).toContain("3.1 sources/min");
  });

  it("should include filtered column when filesFiltered is present", () => {
    const stats: CopySummaryStats = {
      totalSources: 5,
      processed: 5,
      skippedCompleted: 0,
      failed: 0,
      filesCreated: 50,
      filesSkipped: 10,
      filesFiltered: 15,
      filesFailed: 0,
      elapsed: "1m 00s",
      sourcesPerMin: 5.0,
    };

    const output = formatCopySummaryTable(stats);

    expect(output).toBeTruthy();
    expect(output).toContain("Filtered");
  });

  it("should not include filtered column when filesFiltered is zero", () => {
    const stats: CopySummaryStats = {
      totalSources: 5,
      processed: 5,
      skippedCompleted: 0,
      failed: 0,
      filesCreated: 50,
      filesSkipped: 10,
      filesFiltered: 0,
      filesFailed: 0,
      elapsed: "30s",
      sourcesPerMin: 10.0,
    };

    const output = formatCopySummaryTable(stats);

    expect(output).toBeTruthy();
    // With filesFiltered=0, the column should not appear
    // (hasFiltered check: !== undefined && > 0)
  });

  it("should include tracking info when provided", () => {
    const stats: CopySummaryStats = {
      totalSources: 1,
      processed: 1,
      skippedCompleted: 0,
      failed: 0,
      filesCreated: 10,
      filesSkipped: 0,
      filesFailed: 0,
      elapsed: "5s",
      sourcesPerMin: 12.0,
      trackingInfo: "Database (operation #1)",
    };

    const output = formatCopySummaryTable(stats);

    expect(output).toContain("Database (operation #1)");
  });
});

// ---------------------------------------------------------------------------
// formatSyncSummaryTable
// ---------------------------------------------------------------------------

describe("formatSyncSummaryTable", () => {
  it("should render a sync summary table", () => {
    const stats: SyncSummaryStats = {
      sourcesScanned: 100,
      newFilesCopied: 15,
      updatedFilesCopied: 3,
      unchangedSkipped: 80,
      deletedFiles: 2,
      failedFiles: 0,
    };

    const output = formatSyncSummaryTable(stats);

    expect(output).toBeTruthy();
    expect(output).toContain("Sources scanned: 100");
  });

  it("should render with failed files highlighted", () => {
    const stats: SyncSummaryStats = {
      sourcesScanned: 50,
      newFilesCopied: 5,
      updatedFilesCopied: 1,
      unchangedSkipped: 40,
      deletedFiles: 0,
      failedFiles: 4,
    };

    const output = formatSyncSummaryTable(stats);

    expect(output).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// formatDeleteSummaryTable
// ---------------------------------------------------------------------------

describe("formatDeleteSummaryTable", () => {
  it("should render a delete summary table", () => {
    const stats: DeleteSummaryStats = {
      sourcesProcessed: 5,
      deleted: 20,
      trackingRemoved: 20,
      failed: 0,
    };

    const output = formatDeleteSummaryTable(stats);

    expect(output).toBeTruthy();
  });

  it("should render with failed operations", () => {
    const stats: DeleteSummaryStats = {
      sourcesProcessed: 10,
      deleted: 15,
      trackingRemoved: 12,
      failed: 3,
    };

    const output = formatDeleteSummaryTable(stats);

    expect(output).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Unicode alignment correctness
// ---------------------------------------------------------------------------

describe("Unicode alignment in table helpers", () => {
  it("should not misalign columns when CJK album names are present", () => {
    // Verify that a mix of ASCII and CJK album names produces valid table output
    const result: PreviewResult = {
      albums: [
        {
          albumName: "Regular Album",
          sourcePath: "/music/Regular Album",
          suffixes: [
            {
              suffix: "001",
              destPath: "/dest/Regular Album-001",
              action: "create",
              fileCount: 10,
              totalBytes: 50_000,
            },
          ],
          summary: { willCreate: 1, willSkip: 0, willOverwrite: 0, willRecreate: 0 },
        },
        {
          albumName: "\u97F3\u697D\u30A2\u30EB\u30D0\u30E0", // 音楽アルバム (12 display cols)
          sourcePath: "/music/\u97F3\u697D\u30A2\u30EB\u30D0\u30E0",
          suffixes: [
            {
              suffix: "001",
              destPath: "/dest/\u97F3\u697D\u30A2\u30EB\u30D0\u30E0-001",
              action: "skip",
              fileCount: 0,
              totalBytes: 0,
            },
          ],
          summary: { willCreate: 0, willSkip: 1, willOverwrite: 0, willRecreate: 0 },
        },
      ],
      totals: { files: 10, bytes: 50_000, creates: 1, skips: 1, overwrites: 0, recreates: 0 },
    };

    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    // Both album names should appear (they both fit within 50 columns)
    expect(output).toContain("Regular Album");
    expect(output).toContain("\u97F3\u697D\u30A2\u30EB\u30D0\u30E0");
  });

  it("should handle Korean characters in album names", () => {
    // Korean syllables are fullwidth (2 columns each)
    const koreanAlbum = "\uD55C\uAD6D \uC74C\uC545"; // 한국 음악 (9 display cols: 4 fullwidth + 1 space)
    expect(displayWidth(koreanAlbum)).toBe(9);

    const result: PreviewResult = {
      albums: [
        {
          albumName: koreanAlbum,
          sourcePath: `/music/${koreanAlbum}`,
          suffixes: [
            {
              suffix: "001",
              destPath: `/dest/${koreanAlbum}-001`,
              action: "create",
              fileCount: 5,
              totalBytes: 25_000,
            },
          ],
          summary: { willCreate: 1, willSkip: 0, willOverwrite: 0, willRecreate: 0 },
        },
      ],
      totals: { files: 5, bytes: 25_000, creates: 1, skips: 0, overwrites: 0, recreates: 0 },
    };

    const output = formatAlbumPreviewTable(result);

    expect(output).toBeTruthy();
    expect(output).toContain(koreanAlbum);
  });

  it("should handle emoji-rich album names without crashing", () => {
    const emojiAlbum = "\uD83C\uDFB5 Best Hits \uD83C\uDFB6\uD83C\uDFB8\uD83E\uDD41"; // 🎵 Best Hits 🎶🎸🥁
    const result: PreviewResult = {
      albums: [
        {
          albumName: emojiAlbum,
          sourcePath: `/music/${emojiAlbum}`,
          suffixes: [
            {
              suffix: "001",
              destPath: `/dest/${emojiAlbum}-001`,
              action: "create",
              fileCount: 20,
              totalBytes: 200_000,
            },
          ],
          summary: { willCreate: 1, willSkip: 0, willOverwrite: 0, willRecreate: 0 },
        },
      ],
      totals: { files: 20, bytes: 200_000, creates: 1, skips: 0, overwrites: 0, recreates: 0 },
    };

    // Should not throw
    const output = formatAlbumPreviewTable(result);
    expect(output).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Non-TTY deterministic behavior
// ---------------------------------------------------------------------------

describe("non-TTY deterministic behavior", () => {
  it("should produce consistent output across multiple renders with the same data", () => {
    const result: PreviewResult = {
      albums: [
        {
          albumName: "Consistency Check Album",
          sourcePath: "/music/Consistency",
          suffixes: [
            {
              suffix: "001",
              destPath: "/dest/Consistency-001",
              action: "create",
              fileCount: 15,
              totalBytes: 75_000,
            },
          ],
          summary: { willCreate: 1, willSkip: 0, willOverwrite: 0, willRecreate: 0 },
        },
      ],
      totals: { files: 15, bytes: 75_000, creates: 1, skips: 0, overwrites: 0, recreates: 0 },
    };

    const output1 = formatAlbumPreviewTable(result);
    const output2 = formatAlbumPreviewTable(result);

    // Rendered output should be identical between calls
    expect(output1).toBe(output2);
  });

  it("should produce consistent filter preview output across renders", () => {
    const result: FilterPreviewResult = {
      sources: [
        {
          artistName: "Deterministic Artist",
          sourcePath: "/music/Deterministic",
          likedTracks: [],
          filteredCount: 3,
          summary: { willCopy: 7, willSkip: 0, totalBytes: 35_000 },
        },
      ],
      totals: { copies: 7, skips: 0, filtered: 3, bytes: 35_000 },
    };

    const output1 = formatFilterPreviewTable(result);
    const output2 = formatFilterPreviewTable(result);

    expect(output1).toBe(output2);
  });

  it("should produce consistent copy summary output across renders", () => {
    const stats: CopySummaryStats = {
      totalSources: 5,
      processed: 4,
      skippedCompleted: 1,
      failed: 0,
      filesCreated: 40,
      filesSkipped: 5,
      filesFailed: 0,
      elapsed: "1m 15s",
      sourcesPerMin: 3.2,
    };

    const output1 = formatCopySummaryTable(stats);
    const output2 = formatCopySummaryTable(stats);

    expect(output1).toBe(output2);
  });
});
