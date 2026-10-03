/**
 * Unit tests for terminal table width-policy utility.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FALLBACK_TABLE_COLUMNS,
  getTerminalWidth,
  calculateColumnWidths,
  truncateToWidth,
  displayWidth,
  type ColumnDef,
} from "./terminal-table.js";

// ---------------------------------------------------------------------------
// getTerminalWidth
// ---------------------------------------------------------------------------

describe("getTerminalWidth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return FALLBACK_TABLE_COLUMNS constant of 120", () => {
    expect(FALLBACK_TABLE_COLUMNS).toBe(120);
  });

  it("should return stream columns when stream is a TTY", () => {
    const fakeStream = {
      isTTY: true,
      columns: 80,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(80);
  });

  it("should return fallback width when stream is not a TTY", () => {
    const fakeStream = {
      isTTY: false,
      columns: 80,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(FALLBACK_TABLE_COLUMNS);
  });

  it("should return fallback width when stream has no columns property", () => {
    const fakeStream = {
      isTTY: true,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(FALLBACK_TABLE_COLUMNS);
  });

  it("should return fallback width when columns is zero", () => {
    const fakeStream = {
      isTTY: true,
      columns: 0,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(FALLBACK_TABLE_COLUMNS);
  });

  it("should return fallback width when columns is negative", () => {
    const fakeStream = {
      isTTY: false,
      columns: -1,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(FALLBACK_TABLE_COLUMNS);
  });

  it("should default to process.stdout when no stream is provided", () => {
    // In test environments process.stdout is typically not a TTY
    const width = getTerminalWidth();
    if (
      process.stdout.isTTY &&
      typeof process.stdout.columns === "number" &&
      process.stdout.columns > 0
    ) {
      expect(width).toBe(process.stdout.columns);
    } else {
      expect(width).toBe(FALLBACK_TABLE_COLUMNS);
    }
  });

  it("should detect narrow TTY width", () => {
    const fakeStream = {
      isTTY: true,
      columns: 40,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(40);
  });

  it("should detect wide TTY width", () => {
    const fakeStream = {
      isTTY: true,
      columns: 200,
    } as unknown as NodeJS.WriteStream;

    expect(getTerminalWidth(fakeStream)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// calculateColumnWidths
// ---------------------------------------------------------------------------

describe("calculateColumnWidths", () => {
  const playlistColumns: ColumnDef[] = [
    { name: "name", minWidth: 15, flex: true, alignment: "left" },
    { name: "tracks", minWidth: 8, flex: false, alignment: "right" },
    { name: "smart", minWidth: 7, flex: false, alignment: "center" },
    { name: "duration", minWidth: 10, flex: false, alignment: "right" },
  ];

  it("should allocate remaining width to flex columns on a wide terminal", () => {
    const results = calculateColumnWidths(playlistColumns, 120);
    const nameResult = results.find((r) => r.name === "name");
    const tracksResult = results.find((r) => r.name === "tracks");
    const smartResult = results.find((r) => r.name === "smart");
    const durationResult = results.find((r) => r.name === "duration");

    // Fixed columns get their minWidth
    expect(tracksResult?.width).toBe(8);
    expect(smartResult?.width).toBe(7);
    expect(durationResult?.width).toBe(10);

    // Flex column gets remaining: 120 - 8 - 7 - 10 = 95
    expect(nameResult?.width).toBe(95);
  });

  it("should give minimums when total width equals sum of minimums", () => {
    const totalMin = playlistColumns.reduce((sum, col) => sum + col.minWidth, 0);
    const results = calculateColumnWidths(playlistColumns, totalMin);

    for (const col of playlistColumns) {
      const result = results.find((r) => r.name === col.name);
      expect(result?.width).toBe(col.minWidth);
    }
  });

  it("should give minimums when total width is smaller than sum of minimums", () => {
    const results = calculateColumnWidths(playlistColumns, 20);

    for (const col of playlistColumns) {
      const result = results.find((r) => r.name === col.name);
      expect(result?.width).toBe(col.minWidth);
    }
  });

  it("should handle very narrow width by enforcing minimum usable width of 40", () => {
    const results = calculateColumnWidths(playlistColumns, 10);
    // Sum of minimums is 15 + 8 + 7 + 10 = 40
    // Effective width is max(10, 40) = 40
    // 40 === totalMinWidth, so each gets minWidth
    for (const col of playlistColumns) {
      const result = results.find((r) => r.name === col.name);
      expect(result?.width).toBe(col.minWidth);
    }
  });

  it("should distribute width equally among multiple flex columns", () => {
    const multiFlexColumns: ColumnDef[] = [
      { name: "title", minWidth: 10, flex: true, alignment: "left" },
      { name: "artist", minWidth: 10, flex: true, alignment: "left" },
      { name: "count", minWidth: 6, flex: false, alignment: "right" },
    ];

    const results = calculateColumnWidths(multiFlexColumns, 100);
    const titleResult = results.find((r) => r.name === "title");
    const artistResult = results.find((r) => r.name === "artist");
    const countResult = results.find((r) => r.name === "count");

    expect(countResult?.width).toBe(6);
    // Remaining: 100 - 6 = 94, split between 2 flex columns = 47 each
    expect(titleResult?.width).toBe(47);
    expect(artistResult?.width).toBe(47);
  });

  it("should distribute remainder to first flex columns when width is not evenly divisible", () => {
    const multiFlexColumns: ColumnDef[] = [
      { name: "title", minWidth: 10, flex: true, alignment: "left" },
      { name: "artist", minWidth: 10, flex: true, alignment: "left" },
      { name: "count", minWidth: 5, flex: false, alignment: "right" },
    ];

    // Remaining: 100 - 5 = 95, split 2 ways = 47.5
    // Floor: 47 each, remainder 1 goes to first flex column
    const results = calculateColumnWidths(multiFlexColumns, 100);
    const titleResult = results.find((r) => r.name === "title");
    const artistResult = results.find((r) => r.name === "artist");

    expect(titleResult?.width).toBe(48); // 47 + 1 remainder
    expect(artistResult?.width).toBe(47);
  });

  it("should preserve input column order in results", () => {
    const results = calculateColumnWidths(playlistColumns, 120);
    expect(results.map((r) => r.name)).toEqual(["name", "tracks", "smart", "duration"]);
  });

  it("should handle all-fixed columns", () => {
    const fixedOnly: ColumnDef[] = [
      { name: "a", minWidth: 10, flex: false, alignment: "left" },
      { name: "b", minWidth: 20, flex: false, alignment: "right" },
    ];

    const results = calculateColumnWidths(fixedOnly, 100);
    expect(results).toEqual([
      { name: "a", width: 10 },
      { name: "b", width: 20 },
    ]);
  });

  it("should handle all-flex columns", () => {
    const flexOnly: ColumnDef[] = [
      { name: "a", minWidth: 5, flex: true, alignment: "left" },
      { name: "b", minWidth: 5, flex: true, alignment: "left" },
      { name: "c", minWidth: 5, flex: true, alignment: "left" },
    ];

    const results = calculateColumnWidths(flexOnly, 90);
    // 90 / 3 = 30 each
    expect(results).toEqual([
      { name: "a", width: 30 },
      { name: "b", width: 30 },
      { name: "c", width: 30 },
    ]);
  });

  it("should handle a single flex column", () => {
    const single: ColumnDef[] = [{ name: "only", minWidth: 10, flex: true, alignment: "left" }];

    const results = calculateColumnWidths(single, 80);
    expect(results).toEqual([{ name: "only", width: 80 }]);
  });

  it("should ensure flex columns never go below minWidth", () => {
    const columns: ColumnDef[] = [
      { name: "flex", minWidth: 20, flex: true, alignment: "left" },
      { name: "fixed", minWidth: 70, flex: false, alignment: "right" },
    ];

    // Remaining after fixed: 80 - 70 = 10, but flex minWidth is 20
    const results = calculateColumnWidths(columns, 80);
    const flexResult = results.find((r) => r.name === "flex");
    expect(flexResult?.width).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// truncateToWidth
// ---------------------------------------------------------------------------

describe("truncateToWidth", () => {
  it("should not truncate short ASCII strings", () => {
    expect(truncateToWidth("Hello", 10)).toBe("Hello");
  });

  it("should truncate long ASCII strings with ellipsis", () => {
    const result = truncateToWidth("Hello World, this is a long string", 10);
    expect(displayWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toContain("…");
  });

  it("should handle exact-width strings without truncation", () => {
    expect(truncateToWidth("12345", 5)).toBe("12345");
  });

  it("should return empty string for zero width", () => {
    expect(truncateToWidth("Hello", 0)).toBe("");
  });

  it("should return empty string for negative width", () => {
    expect(truncateToWidth("Hello", -5)).toBe("");
  });

  it("should handle empty input string", () => {
    expect(truncateToWidth("", 10)).toBe("");
  });

  // Unicode scenarios
  it("should handle fullwidth CJK characters correctly", () => {
    // Each CJK character takes 2 columns
    const cjk = "\u4F60\u597D\u4E16\u754C"; // "你好世界" (Hello World in Chinese)
    // Display width = 8 (4 chars * 2 columns each)
    expect(displayWidth(cjk)).toBe(8);

    // Truncate to 6 columns: should fit 2 fullwidth chars (4 cols) + ellipsis (1 col) = 5
    const truncated = truncateToWidth(cjk, 6);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(6);
  });

  it("should handle emoji correctly", () => {
    const emoji = "My Playlist \uD83C\uDFB5\uD83C\uDFB6\uD83C\uDFB8"; // "My Playlist 🎵🎶🎸"
    const truncated = truncateToWidth(emoji, 16);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(16);
  });

  it("should handle mixed ASCII and fullwidth characters", () => {
    const mixed = "Playlist: \u97F3\u697D\u30D7\u30EC\u30A4\u30EA\u30B9\u30C8"; // "Playlist: 音楽プレイリスト"
    const truncated = truncateToWidth(mixed, 20);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(20);
  });

  it("should handle Korean fullwidth characters", () => {
    // Korean syllables are fullwidth (2 columns each)
    const korean = "\uD55C\uAD6D\uC5B4 \uD14C\uC2A4\uD2B8"; // "한국어 테스트"
    expect(displayWidth(korean)).toBe(13); // 6 chars * 2 + 1 space = 13
    const truncated = truncateToWidth(korean, 8);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(8);
  });

  it("should preserve ANSI escape codes during truncation", () => {
    // cli-truncate handles ANSI codes by not counting them in width
    const styled = "\u001B[31mRed Text\u001B[39m";
    const truncated = truncateToWidth(styled, 5);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// displayWidth
// ---------------------------------------------------------------------------

describe("displayWidth", () => {
  it("should return correct width for ASCII strings", () => {
    expect(displayWidth("Hello")).toBe(5);
  });

  it("should return 0 for empty string", () => {
    expect(displayWidth("")).toBe(0);
  });

  it("should count fullwidth CJK characters as width 2", () => {
    expect(displayWidth("\u53E4")).toBe(2); // "古"
  });

  it("should handle mixed-width strings", () => {
    // "a古b" = 1 + 2 + 1 = 4
    expect(displayWidth("a\u53E4b")).toBe(4);
  });

  it("should not count ANSI escape codes", () => {
    expect(displayWidth("\u001B[1mBold\u001B[22m")).toBe(4);
  });

  it("should handle emoji", () => {
    // Most emoji are width 2
    const width = displayWidth("\uD83C\uDE00"); // 🈀
    expect(width).toBeGreaterThanOrEqual(1);
  });

  it("should handle star rating characters", () => {
    // Filled star (U+2605) and empty star (U+2606) are ambiguous width
    // string-width treats ambiguous characters as narrow by default
    const filled = "\u2605";
    const empty = "\u2606";
    expect(displayWidth(filled)).toBe(1);
    expect(displayWidth(empty)).toBe(1);
    expect(displayWidth("\u2605\u2605\u2605\u2606\u2606")).toBe(5);
  });
});
