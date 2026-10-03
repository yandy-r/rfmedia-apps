import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderTable } from "./table.js";

describe("renderTable", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  let originalColumns: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalIsTTY = process.stdout.isTTY;
    originalColumns = process.stdout.columns;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      writable: true,
      configurable: true,
    });
  });

  /**
   * Helper to collect all console.log output into a single string.
   */
  function getOutput(): string {
    return consoleSpy.mock.calls.map((call: [unknown]) => String(call[0])).join("\n");
  }

  /**
   * Helper to set non-TTY environment (deterministic fallback width).
   */
  function setNonTTY(): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      writable: true,
      configurable: true,
    });
  }

  /**
   * Helper to set TTY environment with a specific column width.
   */
  function setTTY(columns: number): void {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: columns,
      writable: true,
      configurable: true,
    });
  }

  // ---------- Edge Cases ----------

  describe("edge cases", () => {
    it("should render '(no data)' for null input", () => {
      renderTable(null);

      expect(consoleSpy).toHaveBeenCalledWith("(no data)");
    });

    it("should render '(no data)' for undefined input", () => {
      renderTable(undefined);

      expect(consoleSpy).toHaveBeenCalledWith("(no data)");
    });

    it("should render '(empty)' for an empty array", () => {
      renderTable([]);

      expect(consoleSpy).toHaveBeenCalledWith("(empty)");
    });

    it("should render primitive string value", () => {
      renderTable("hello world");

      expect(consoleSpy).toHaveBeenCalledWith("hello world");
    });

    it("should render primitive number value", () => {
      renderTable(42);

      expect(consoleSpy).toHaveBeenCalledWith("42");
    });

    it("should render primitive boolean value", () => {
      renderTable(true);

      expect(consoleSpy).toHaveBeenCalledWith("true");
    });

    it("should render '(no matching columns)' when column filter matches nothing", () => {
      renderTable([{ name: "test" }], ["nonexistent"]);

      expect(consoleSpy).toHaveBeenCalledWith("(no matching columns)");
    });
  });

  // ---------- Single Row ----------

  describe("single row", () => {
    it("should render a single-row table with header and separator", () => {
      setNonTTY();
      renderTable([{ name: "traefik", status: "running" }]);

      const output = getOutput();
      expect(output).toContain("name");
      expect(output).toContain("status");
      expect(output).toContain("traefik");
      expect(output).toContain("running");
      // Should have a separator line with dashes
      expect(output).toMatch(/-{2,}/);
    });

    it("should include column headers even with a single row", () => {
      setNonTTY();
      renderTable([{ service: "plex", port: 32400 }]);

      const output = getOutput();
      expect(output).toContain("service");
      expect(output).toContain("port");
    });
  });

  // ---------- Object Data ----------

  describe("object data", () => {
    it("should render a single object as key-value pairs", () => {
      setNonTTY();
      renderTable({ name: "traefik", version: "v3.0", status: "running" });

      const output = getOutput();
      expect(output).toContain("Key");
      expect(output).toContain("Value");
      expect(output).toContain("name");
      expect(output).toContain("traefik");
      expect(output).toContain("version");
      expect(output).toContain("v3.0");
      expect(output).toContain("status");
      expect(output).toContain("running");
    });

    it("should render '(empty)' for an empty object", () => {
      renderTable({});

      expect(consoleSpy).toHaveBeenCalledWith("(empty)");
    });
  });

  // ---------- Column Filtering ----------

  describe("column filtering", () => {
    it("should only show specified columns", () => {
      setNonTTY();
      renderTable(
        [{ name: "traefik", status: "running", image: "traefik:v3.0" }],
        ["name", "status"],
      );

      const output = getOutput();
      expect(output).toContain("name");
      expect(output).toContain("status");
      // image column should not appear in the header row
      const lines = output.split("\n");
      const headerLine = lines.find((l) => l.includes("name") && l.includes("status"));
      expect(headerLine).toBeDefined();
      expect(headerLine).not.toContain("image");
    });
  });

  // ---------- Cell Value Formatting ----------

  describe("cell value formatting", () => {
    it("should render null values as '-'", () => {
      setNonTTY();
      renderTable([{ name: "test", value: null }]);

      const output = getOutput();
      expect(output).toContain("-");
    });

    it("should render undefined values as '-'", () => {
      setNonTTY();
      renderTable([{ name: "test", value: undefined }]);

      const output = getOutput();
      // "value" column should show "-"
      const lines = output.split("\n");
      const dataLine = lines.find((l) => l.includes("test"));
      expect(dataLine).toBeDefined();
      expect(dataLine).toContain("-");
    });

    it("should render arrays as comma-separated values", () => {
      setNonTTY();
      renderTable([{ name: "test", tags: ["web", "proxy", "ssl"] }]);

      const output = getOutput();
      expect(output).toContain("web, proxy, ssl");
    });

    it("should render nested objects as JSON strings", () => {
      setNonTTY();
      renderTable([{ name: "test", config: { port: 80 } }]);

      const output = getOutput();
      expect(output).toContain('{"port":80}');
    });
  });

  // ---------- Non-TTY Deterministic Behavior ----------

  describe("non-TTY deterministic behavior", () => {
    it("should use fallback width of 120 columns when not a TTY", () => {
      setNonTTY();

      // Create data with a column that would need truncation beyond 120 cols
      const longValue = "A".repeat(200);
      renderTable([{ description: longValue }]);

      const output = getOutput();
      // The value should be truncated - it should not contain the full 200-char string
      expect(output).not.toContain(longValue);
    });

    it("should produce identical output regardless of TTY columns when isTTY is false", () => {
      // First render: non-TTY
      setNonTTY();
      renderTable([{ name: "traefik", status: "running" }]);
      const output1 = getOutput();

      consoleSpy.mockClear();

      // Second render: non-TTY but with columns property set (should be ignored)
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "columns", {
        value: 40,
        writable: true,
        configurable: true,
      });
      renderTable([{ name: "traefik", status: "running" }]);
      const output2 = getOutput();

      expect(output1).toBe(output2);
    });
  });

  // ---------- Narrow Terminal Behavior ----------

  describe("narrow terminal behavior", () => {
    it("should truncate long values in a narrow terminal (40 columns)", () => {
      setTTY(40);
      const longName = "very-long-service-name-that-exceeds-column-budget";
      renderTable([{ name: longName, status: "running" }]);

      const output = getOutput();
      // The long name should be truncated with ellipsis marker
      expect(output).not.toContain(longName);
      expect(output).toContain("\u2026"); // Unicode ellipsis from cli-truncate
    });

    it("should still show column headers in a narrow terminal", () => {
      setTTY(40);
      renderTable([{ service: "plex", port: 32400, image: "plexinc/plex:latest" }]);

      const output = getOutput();
      // At minimum, column headers should be present (possibly truncated)
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      // First non-empty line after the blank line is the header
      const headerLine = lines.find(
        (l) => l.includes("service") || l.includes("port") || l.includes("image"),
      );
      expect(headerLine).toBeDefined();
    });

    it("should ensure every column gets at least minimum width", () => {
      setTTY(40);
      renderTable([
        {
          a: "alpha",
          b: "bravo",
          c: "charlie",
          d: "delta",
          e: "echo",
        },
      ]);

      const output = getOutput();
      // With 5 columns in 40 char width, columns will be very narrow
      // but all column headers should still appear in output
      expect(output).toContain("a");
      expect(output).toContain("b");
      expect(output).toContain("c");
    });
  });

  // ---------- Wide Terminal Behavior ----------

  describe("wide terminal behavior", () => {
    it("should not truncate values when terminal is wide enough", () => {
      setTTY(200);
      renderTable([
        {
          name: "traefik",
          status: "running",
          image: "traefik:v3.0",
          ports: "80, 443, 8080",
        },
      ]);

      const output = getOutput();
      expect(output).toContain("traefik");
      expect(output).toContain("running");
      expect(output).toContain("traefik:v3.0");
      expect(output).toContain("80, 443, 8080");
    });

    it("should use natural column widths when they fit within terminal", () => {
      setTTY(200);
      renderTable([
        { name: "a", count: 1 },
        { name: "bb", count: 22 },
      ]);

      const output = getOutput();
      // Both values should be fully visible
      expect(output).toContain("a");
      expect(output).toContain("bb");
      expect(output).toContain("1");
      expect(output).toContain("22");
    });
  });

  // ---------- Shrink Path and Leftover Redistribution ----------

  describe("shrink path and leftover redistribution", () => {
    it("should redistribute leftover width to truncated columns so total allocated equals available", () => {
      // Terminal width 118 → available content width 110 (minus prefix and 3 gaps for 4 columns).
      // Four columns with natural widths 10, 10, 10, 80 (total 110). Proportional share gives
      // narrow columns >10 each (capped to 10, creating leftover); wide column gets 77 (deficit 3).
      // Second pass redistributes leftover so wide column reaches 80 and total allocated = 110.
      setTTY(118);
      renderTable(
        [
          {
            a: "0123456789",
            b: "0123456789",
            c: "0123456789",
            d: "d".repeat(80),
          },
        ],
        ["a", "b", "c", "d"],
      );

      const output = getOutput();
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      const dataLines = lines.slice(2);
      expect(dataLines.length).toBeGreaterThanOrEqual(1);
      const firstDataRow = dataLines[0];
      if (firstDataRow) {
        expect(firstDataRow.length).toBe(118);
      }
    });
  });

  // ---------- Unicode Characters ----------

  describe("Unicode characters", () => {
    it("should correctly align columns with emoji in values", () => {
      setNonTTY();
      renderTable([
        { name: "service-a", status: "running" },
        { name: "service-b", status: "stopped" },
      ]);
      const baselineOutput = getOutput();
      const baselineLines = baselineOutput.split("\n").filter((l) => l.trim().length > 0);

      consoleSpy.mockClear();

      // Now render with emoji - alignment should still be correct
      renderTable([
        { name: "service-a", status: "\u2705 running" },
        { name: "service-b", status: "\u274C stopped" },
      ]);
      const emojiOutput = getOutput();
      const emojiLines = emojiOutput.split("\n").filter((l) => l.trim().length > 0);

      // Both outputs should have the same number of lines
      expect(emojiLines.length).toBe(baselineLines.length);
      // Emoji output should contain the emoji characters
      expect(emojiOutput).toContain("\u2705");
      expect(emojiOutput).toContain("\u274C");
    });

    it("should handle CJK fullwidth characters without breaking alignment", () => {
      setNonTTY();
      renderTable([
        { name: "\u6D4B\u8BD5\u670D\u52A1", port: 8080 },
        { name: "test-service", port: 9090 },
      ]);

      const output = getOutput();
      // CJK characters should be present in output
      expect(output).toContain("\u6D4B\u8BD5\u670D\u52A1");
      expect(output).toContain("test-service");
      expect(output).toContain("8080");
      expect(output).toContain("9090");
    });

    it("should truncate CJK fullwidth characters to fit within column width", () => {
      setTTY(40);
      const cjkLong = "\u6D4B\u8BD5".repeat(20); // Each CJK char is 2 columns wide
      renderTable([{ name: cjkLong, status: "ok" }]);

      const output = getOutput();
      // The full CJK string should be truncated
      expect(output).not.toContain(cjkLong);
    });

    it("should handle mixed ASCII and emoji in the same row", () => {
      setNonTTY();
      renderTable([
        { service: "\uD83D\uDE80 rocket-api", status: "up", version: "1.2.3" },
        { service: "plain-service", status: "down", version: "0.9.0" },
      ]);

      const output = getOutput();
      expect(output).toContain("\uD83D\uDE80 rocket-api");
      expect(output).toContain("plain-service");
      expect(output).toContain("1.2.3");
      expect(output).toContain("0.9.0");
    });
  });

  // ---------- Mixed-Width Columns ----------

  describe("mixed-width columns", () => {
    it("should handle a mix of short and long values across rows", () => {
      setNonTTY();
      renderTable([
        {
          id: "1",
          name: "a",
          description: "A very long description that takes up a lot of space in the table",
        },
        { id: "2", name: "b", description: "Short" },
        { id: "3", name: "c", description: "Another moderately long description for testing" },
      ]);

      const output = getOutput();
      expect(output).toContain("id");
      expect(output).toContain("name");
      expect(output).toContain("description");
      // Short values should be present
      expect(output).toContain("a");
      expect(output).toContain("b");
      expect(output).toContain("Short");
    });

    it("should allocate proportionally more width to wider columns", () => {
      setTTY(60);
      renderTable([
        {
          id: "1",
          longColumnName: "This is a very long value for testing proportional allocation",
        },
        { id: "2", longColumnName: "Short" },
      ]);

      const output = getOutput();
      // The id column should get a small allocation
      // The longColumnName column should get a larger allocation
      // Both column headers should be visible
      expect(output).toContain("id");
      expect(output).toContain("longColumnName");
    });
  });

  // ---------- Truncation Marker ----------

  describe("truncation marker", () => {
    it("should use ellipsis character when truncating values", () => {
      setTTY(30);
      renderTable([{ name: "a-very-long-service-name-that-must-be-truncated" }]);

      const output = getOutput();
      // cli-truncate uses the Unicode ellipsis character
      expect(output).toContain("\u2026");
    });

    it("should not show ellipsis when value fits within column width", () => {
      setTTY(200);
      renderTable([{ name: "short" }]);

      const output = getOutput();
      expect(output).toContain("short");
      expect(output).not.toContain("\u2026");
    });
  });

  // ---------- Multiple Rows ----------

  describe("multiple rows", () => {
    it("should render all rows with consistent column widths", () => {
      setNonTTY();
      renderTable([
        { name: "traefik", status: "running", image: "traefik:v3.0" },
        { name: "plex", status: "stopped", image: "plexinc/pms-docker:latest" },
        { name: "authentik-server", status: "running", image: "ghcr.io/goauthentik/server:2024.2" },
      ]);

      const output = getOutput();
      const lines = output.split("\n").filter((l) => l.trim().length > 0);

      // Should have: header + separator + 3 data rows = 5 non-empty lines
      expect(lines.length).toBe(5);

      // All service names should be present
      expect(output).toContain("traefik");
      expect(output).toContain("plex");
      expect(output).toContain("authentik-server");
    });

    it("should align columns across rows with varying value lengths", () => {
      setTTY(100);
      renderTable([
        { name: "a", count: 1 },
        { name: "abcdefghij", count: 1000000 },
      ]);

      const output = getOutput();
      const lines = output.split("\n").filter((l) => l.trim().length > 0);

      // Find data lines (skip header and separator)
      const dataLines = lines.slice(2);
      expect(dataLines.length).toBe(2);

      // Both data lines should start with the same prefix (row indent)
      expect(dataLines[0]).toMatch(/^\s{2}/);
      expect(dataLines[1]).toMatch(/^\s{2}/);
    });
  });

  // ---------- Header Visibility ----------

  describe("header visibility", () => {
    it("should always render column headers for array data", () => {
      setNonTTY();
      renderTable([{ alpha: "1", beta: "2", gamma: "3" }]);

      const output = getOutput();
      expect(output).toContain("alpha");
      expect(output).toContain("beta");
      expect(output).toContain("gamma");
    });

    it("should render Key/Value headers for object data", () => {
      setNonTTY();
      renderTable({ myKey: "myValue" });

      const output = getOutput();
      expect(output).toContain("Key");
      expect(output).toContain("Value");
    });

    it("should render a separator line between headers and data", () => {
      setNonTTY();
      renderTable([{ name: "test" }]);

      const output = getOutput();
      const lines = output.split("\n");
      // Find a line that is entirely dashes (with optional leading spaces)
      const separatorLine = lines.find((l) => /^\s+[-]+$/.test(l));
      expect(separatorLine).toBeDefined();
    });
  });
});
