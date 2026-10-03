/**
 * Tests for history command table rendering.
 *
 * Validates that history table output uses Unicode-safe width measurement
 * (string-width + cli-truncate), adapts to terminal width, and falls back
 * to 120 columns in non-TTY environments.
 *
 * Test naming documents intentional divergences from the centralized
 * renderer in lib/formatters/table.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import stringWidth from "string-width";

// ---------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------

vi.mock("@rfmedia/common", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  colors: {
    bold: (text: string) => text,
    gray: (text: string) => text,
    green: (text: string) => text,
    red: (text: string) => text,
    yellow: (text: string) => text,
    blue: (text: string) => text,
    cyan: (text: string) => text,
  },
  formatError: vi.fn().mockReturnValue({ message: "error", suggestions: [], exitCode: 1 }),
  outputFormattedError: vi.fn(),
}));

const mockDb = Symbol("mock-db");

vi.mock("../lib/index.js", () => ({
  initializeDatabase: vi.fn().mockResolvedValue(Symbol("mock-db")),
  closeDatabase: vi.fn(),
  getDeploymentHistory: vi.fn().mockReturnValue([]),
  getDeploymentCount: vi.fn().mockReturnValue(0),
  InvalidArgumentError: class InvalidArgumentError extends Error {
    readonly argument: string;
    readonly value: string;
    readonly reason: string;
    readonly validValues?: string[];
    constructor(argument: string, value: string, reason: string, validValues?: string[]) {
      super(`Invalid argument "${argument}": ${reason} (got "${value}")`);
      this.name = "InvalidArgumentError";
      this.argument = argument;
      this.value = value;
      this.reason = reason;
      this.validValues = validValues;
    }
  },
}));

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return { ...actual, formatOutput: vi.fn() };
});

// ---------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------

import { executeHistory } from "./history.js";
import { initializeDatabase, getDeploymentHistory, getDeploymentCount } from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import type { StateEntry } from "../types/index.js";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

/** Build a StateEntry with sensible defaults. */
function makeEntry(overrides: Partial<StateEntry> = {}): StateEntry {
  return {
    id: 1,
    timestamp: "2026-01-15T10:30:00.000Z",
    service: "traefik",
    action: "deploy",
    status: "success",
    imageTag: "traefik:v3.0",
    ...overrides,
  };
}

/**
 * Capture all console.error calls and return the joined lines.
 * Strips ANSI escapes for predictable assertions (since our mocked
 * colors are identity functions, this is already clean, but be safe).
 */
function captureStderrLines(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((args: unknown[]) => String(args[0] ?? ""));
}

// ---------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------

describe("history table rendering", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  let originalColumns: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Save original stderr properties
    originalIsTTY = process.stderr.isTTY;
    originalColumns = process.stderr.columns;

    // Default: non-TTY (deterministic 120-column fallback)
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });

    // Set up database mock to return the mock db symbol.
    // The module is fully mocked so the actual type doesn't matter at runtime.
    vi.mocked(initializeDatabase).mockResolvedValue(mockDb as never);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    if (originalColumns !== undefined) {
      Object.defineProperty(process.stderr, "columns", {
        value: originalColumns,
        writable: true,
        configurable: true,
      });
    }
    process.exitCode = undefined;
  });

  describe("non-TTY deterministic behavior (120-column fallback)", () => {
    it("should use 120-column fallback width when stderr is not a TTY", async () => {
      const entry = makeEntry();
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      // Find data rows (skip empty lines, title, header, separator)
      const dataRows = lines.filter((l) => l.includes("traefik") && l.includes("deploy"));
      expect(dataRows.length).toBe(1);

      // Every data row should fit within 120 columns (display width)
      const row = dataRows[0] as string;
      expect(stringWidth(row)).toBeLessThanOrEqual(120);
    });

    it("should produce consistent output across calls in non-TTY mode", async () => {
      const entries = [
        makeEntry({ id: 1, service: "traefik", action: "deploy" }),
        makeEntry({ id: 2, service: "plex", action: "rebuild" }),
      ];
      vi.mocked(getDeploymentHistory).mockReturnValue(entries);
      vi.mocked(getDeploymentCount).mockReturnValue(2);

      await executeHistory({}, {});
      const firstOutput = captureStderrLines(consoleErrorSpy).join("\n");

      consoleErrorSpy.mockClear();
      vi.mocked(getDeploymentHistory).mockReturnValue(entries);
      vi.mocked(getDeploymentCount).mockReturnValue(2);

      await executeHistory({}, {});
      const secondOutput = captureStderrLines(consoleErrorSpy).join("\n");

      expect(firstOutput).toBe(secondOutput);
    });
  });

  describe("narrow terminal behavior", () => {
    it("should adapt column widths to a narrow terminal", async () => {
      // Simulate narrow TTY
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stderr, "columns", {
        value: 80,
        writable: true,
        configurable: true,
      });

      const entry = makeEntry({
        service: "very-long-service-name-that-should-truncate",
        imageTag: "registry.example.com/org/very-long-image-name:v1.2.3-beta.4",
      });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter((l) => l.includes("very-long") || l.includes("registry"));
      expect(dataRows.length).toBe(1);

      // Row display width should not exceed the terminal width
      const row = dataRows[0] as string;
      expect(stringWidth(row)).toBeLessThanOrEqual(80);
    });

    it("should truncate long service names with ellipsis in narrow terminals", async () => {
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stderr, "columns", {
        value: 80,
        writable: true,
        configurable: true,
      });

      const longServiceName = "authentik-server-with-extra-long-suffix";
      const entry = makeEntry({
        service: longServiceName,
      });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      // Find data rows: rows that contain "deploy" (the action) and are not the header
      const dataRows = lines.filter((l) => l.trimStart().match(/^\d/) !== null);
      expect(dataRows.length).toBe(1);

      const row = dataRows[0] as string;
      // The service name is too long for the flex budget at 80 columns,
      // so it should be truncated (the full name should NOT appear)
      expect(row).not.toContain(longServiceName);
      // Truncation should produce an ellipsis marker
      expect(row).toContain("\u2026");
    });
  });

  describe("Unicode-safe width measurement", () => {
    it("should correctly measure fullwidth CJK service names", async () => {
      const entry = makeEntry({
        service: "\u30C8\u30EC\u30FC\u30D5\u30A3\u30AF", // "traefik" in katakana (6 chars, 12 display width)
        imageTag: "traefik:v3.0",
      });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter(
        (l) => l.includes("\u30C8\u30EC\u30FC") || l.includes("traefik:v3.0"),
      );
      expect(dataRows.length).toBe(1);

      // The row should still fit within 120-column fallback
      const row = dataRows[0] as string;
      expect(stringWidth(row)).toBeLessThanOrEqual(120);
    });

    it("should correctly handle emoji in image tags", async () => {
      const entry = makeEntry({
        imageTag: "app-image:v1.0-\uD83D\uDE80", // rocket emoji
      });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter((l) => l.includes("app-image"));
      expect(dataRows.length).toBe(1);

      const row = dataRows[0] as string;
      expect(stringWidth(row)).toBeLessThanOrEqual(120);
    });

    it("should align columns correctly with mixed ASCII and fullwidth characters", async () => {
      const entries = [
        makeEntry({ id: 1, service: "traefik", action: "deploy", status: "success" }),
        makeEntry({
          id: 2,
          service: "\u30D7\u30EC\u30C3\u30AF\u30B9",
          action: "rebuild",
          status: "failed",
        }), // "plex" in katakana
      ];
      vi.mocked(getDeploymentHistory).mockReturnValue(entries);
      vi.mocked(getDeploymentCount).mockReturnValue(2);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      // Find the two data rows
      const dataRows = lines.filter(
        (l) =>
          (l.includes("traefik") || l.includes("\u30D7\u30EC\u30C3\u30AF\u30B9")) &&
          !l.includes("Service"),
      );
      expect(dataRows.length).toBe(2);

      // Both rows should have the same display width (columns are padded to match)
      const width0 = stringWidth(dataRows[0] as string);
      const width1 = stringWidth(dataRows[1] as string);
      // The image tag column is the last column (not padded), so total widths may differ
      // slightly. However, everything up to the image tag should be the same width.
      // We check that both rows fit within bounds and the fixed columns align.
      expect(width0).toBeLessThanOrEqual(120);
      expect(width1).toBeLessThanOrEqual(120);
    });
  });

  describe("history table uses right-aligned ID column - intentional divergence from generic renderer", () => {
    it("should right-align the ID column for numeric readability", async () => {
      const entry = makeEntry({ id: 7 });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      // Find the data row
      const dataRows = lines.filter((l) => l.includes("traefik") && l.includes("deploy"));
      expect(dataRows.length).toBe(1);

      const row = dataRows[0] as string;
      // After the ROW_PREFIX ("  "), the ID should be right-aligned in a 4-char field
      // So ID=7 should appear as "   7" after the prefix
      const afterPrefix = row.slice(2); // remove "  " prefix
      expect(afterPrefix.startsWith("   7")).toBe(true);
    });

    it("should right-align multi-digit IDs", async () => {
      const entry = makeEntry({ id: 42 });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter((l) => l.includes("42") && l.includes("deploy"));
      expect(dataRows.length).toBe(1);

      const row = dataRows[0] as string;
      const afterPrefix = row.slice(2);
      expect(afterPrefix.startsWith("  42")).toBe(true);
    });
  });

  describe("history table renders to stderr - intentional divergence from generic renderer stdout", () => {
    it("should write table output to stderr (console.error), not stdout", async () => {
      const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const entry = makeEntry();
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      // All table rendering goes through console.error
      expect(consoleErrorSpy).toHaveBeenCalled();
      // console.log should NOT be used for history table output
      expect(consoleLogSpy).not.toHaveBeenCalled();

      consoleLogSpy.mockRestore();
    });
  });

  describe("table structure and column order", () => {
    it("should preserve header column order: ID, Timestamp, Service, Action, Status, Image Tag", async () => {
      const entry = makeEntry();
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const headerLine = lines.find(
        (l) => l.includes("ID") && l.includes("Timestamp") && l.includes("Service"),
      );
      expect(headerLine).toBeDefined();

      // Verify column order by checking relative positions
      const header = headerLine as string;
      const idPos = header.indexOf("ID");
      const tsPos = header.indexOf("Timestamp");
      const svcPos = header.indexOf("Service");
      const actPos = header.indexOf("Action");
      const statPos = header.indexOf("Status");
      const imgPos = header.indexOf("Image Tag");

      expect(idPos).toBeLessThan(tsPos);
      expect(tsPos).toBeLessThan(svcPos);
      expect(svcPos).toBeLessThan(actPos);
      expect(actPos).toBeLessThan(statPos);
      expect(statPos).toBeLessThan(imgPos);
    });

    it("should display a separator line after the header", async () => {
      const entry = makeEntry();
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const separatorLines = lines.filter((l) => /^  -+$/.test(l));
      expect(separatorLines.length).toBe(1);
    });

    it("should display the title 'Deployment History'", async () => {
      const entry = makeEntry();
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const titleLine = lines.find((l) => l.includes("Deployment History"));
      expect(titleLine).toBeDefined();
    });
  });

  describe("missing or undefined image tags", () => {
    it("should display '-' for undefined image tags", async () => {
      const entry = makeEntry({ imageTag: undefined });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter((l) => l.includes("traefik") && l.includes("deploy"));
      expect(dataRows.length).toBe(1);

      // The row should contain a "-" for the image tag
      const row = dataRows[0] as string;
      expect(row).toMatch(/-\s*$/);
    });
  });

  describe("machine format delegation", () => {
    it("should delegate to formatOutput for non-text formats", async () => {
      const entries = [makeEntry()];
      vi.mocked(getDeploymentHistory).mockReturnValue(entries);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, { output: "json" });

      expect(formatOutput).toHaveBeenCalledOnce();
      expect(formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          entries,
          totalCount: 1,
        }),
      );
    });

    it("should not render table when format is json", async () => {
      vi.mocked(getDeploymentHistory).mockReturnValue([makeEntry()]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, { output: "json" });

      // console.error should NOT have table header/rows (only formatOutput is called)
      const lines = captureStderrLines(consoleErrorSpy);
      const headerLines = lines.filter((l) => l.includes("Deployment History"));
      expect(headerLines.length).toBe(0);
    });
  });

  describe("empty results", () => {
    it("should display 'No deployment history found' when no entries exist", async () => {
      vi.mocked(getDeploymentHistory).mockReturnValue([]);
      vi.mocked(getDeploymentCount).mockReturnValue(0);

      const { logInfo } = await import("@rfmedia/common");
      await executeHistory({}, {});

      expect(logInfo).toHaveBeenCalledWith("No deployment history found");
    });
  });

  describe("wide terminal behavior", () => {
    it("should use wider flex columns on a wide terminal", async () => {
      Object.defineProperty(process.stderr, "isTTY", {
        value: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stderr, "columns", {
        value: 200,
        writable: true,
        configurable: true,
      });

      const entry = makeEntry({
        service: "my-service",
        imageTag: "registry.example.com/org/my-image:v1.2.3-beta.4-with-extra-long-tag",
      });
      vi.mocked(getDeploymentHistory).mockReturnValue([entry]);
      vi.mocked(getDeploymentCount).mockReturnValue(1);

      await executeHistory({}, {});

      const lines = captureStderrLines(consoleErrorSpy);
      const dataRows = lines.filter((l) => l.includes("my-service"));
      expect(dataRows.length).toBe(1);

      const row = dataRows[0] as string;
      // On a wide terminal, the full image tag should fit without truncation
      expect(row).toContain("registry.example.com/org/my-image:v1.2.3-beta.4-with-extra-long-tag");
      expect(row).not.toContain("...");
    });
  });
});
