/**
 * Unit tests for rfmedia-cli formatter dispatch.
 *
 * Tests the `formatOutput()` function from index.ts to verify:
 * - Machine formats (json, yaml, csv) delegate to @rfmedia/common's formatMachineOutput
 * - Human-readable formats (text, table) return early without producing output
 * - CsvOptions are forwarded when columns are specified
 * - isMachineFormat() and isHumanFormat() correctly classify all output formats
 * - Machine format data passthrough is referentially identical (no transformation)
 * - Machine format behavior is isolated from table rendering evolution
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @rfmedia/common -- must be before imports that use it
vi.mock("@rfmedia/common", () => ({
  formatMachineOutput: vi.fn(),
  isMachineFormat: vi.fn((format?: string) => {
    const machineFormats = new Set(["json", "yaml", "csv"]);
    return machineFormats.has(format ?? "text");
  }),
  OUTPUT_FORMATS: ["json", "yaml", "csv", "table", "text"],
}));

import { formatOutput, isHumanFormat } from "./index.js";
import { formatMachineOutput, isMachineFormat, OUTPUT_FORMATS } from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

describe("formatters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatOutput", () => {
    const sampleData = {
      command: "stats",
      result: {
        operations: [{ command: "copy-album", total: 5 }],
        totalFiles: 100,
        totalSize: 5000000,
      },
    };

    describe("text format", () => {
      it("should return early without producing any output", async () => {
        await formatOutput("text", sampleData);

        expect(formatMachineOutput).not.toHaveBeenCalled();
      });

      it("should return early even with options provided", async () => {
        await formatOutput("text", sampleData, { columns: ["command"] });

        expect(formatMachineOutput).not.toHaveBeenCalled();
      });
    });

    describe("table format", () => {
      it("should return early without producing any output", async () => {
        await formatOutput("table", sampleData);

        expect(formatMachineOutput).not.toHaveBeenCalled();
      });

      it("should return early even with options provided", async () => {
        await formatOutput("table", sampleData, { columns: ["command"] });

        expect(formatMachineOutput).not.toHaveBeenCalled();
      });
    });

    describe("json format", () => {
      it("should delegate to formatMachineOutput with json format", async () => {
        await formatOutput("json", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("json", sampleData, undefined);
      });

      it("should pass undefined csvOptions when no columns specified", async () => {
        await formatOutput("json", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", sampleData, undefined);
      });
    });

    describe("yaml format", () => {
      it("should delegate to formatMachineOutput with yaml format", async () => {
        await formatOutput("yaml", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", sampleData, undefined);
      });
    });

    describe("csv format", () => {
      it("should delegate to formatMachineOutput with csv format", async () => {
        await formatOutput("csv", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("csv", sampleData, undefined);
      });

      it("should forward columns option as CsvOptions", async () => {
        const columns = ["command", "totalFiles"];
        await formatOutput("csv", sampleData, { columns });

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("csv", sampleData, { columns });
      });

      it("neutralizes formula-looking artist, profile, and tag cells without mutating input", async () => {
        const projection = [
          {
            artist: '=HYPERLINK("https://example.test")',
            before: "+Lossless",
            after: "-Standard",
            detail: "@Managed",
            tab: "\tTabbed",
            carriageReturn: "\rCarriage return",
            lineFeed: "\nLine feed",
            safe: "Archive",
          },
        ];

        await formatOutput("csv", projection);

        expect(formatMachineOutput).toHaveBeenCalledWith(
          "csv",
          [
            {
              artist: '\'=HYPERLINK("https://example.test")',
              before: "'+Lossless",
              after: "'-Standard",
              detail: "'@Managed",
              tab: "'\tTabbed",
              carriageReturn: "'\rCarriage return",
              lineFeed: "'\nLine feed",
              safe: "Archive",
            },
          ],
          undefined,
        );
        expect(projection[0]?.artist).toBe('=HYPERLINK("https://example.test")');
      });

      it.each(["json", "yaml"] as const)(
        "does not neutralize formula-looking cells for %s output",
        async (format) => {
          const projection = {
            formula: "=1+1",
            tab: "\tTabbed",
            carriageReturn: "\rCarriage return",
            lineFeed: "\nLine feed",
          };

          await formatOutput(format, projection);

          expect(formatMachineOutput).toHaveBeenCalledWith(format, projection, undefined);
          expect(vi.mocked(formatMachineOutput).mock.calls[0]?.[1]).toBe(projection);
        },
      );
    });

    describe("data handling", () => {
      it("should pass null data to machine formats", async () => {
        await formatOutput("json", null);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", null, undefined);
      });

      it("should pass undefined data to machine formats", async () => {
        await formatOutput("json", undefined);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", undefined, undefined);
      });

      it("should pass array data to machine formats", async () => {
        const arrayData = [{ name: "copy-album" }, { name: "copy-filter" }];
        await formatOutput("yaml", arrayData);

        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", arrayData, undefined);
      });

      it("should pass complex nested data to machine formats", async () => {
        const complexData = {
          command: "history",
          result: {
            entries: [
              {
                id: 1,
                command: "copy-album",
                status: "completed",
                totalSources: 50,
              },
            ],
            totalCount: 150,
            duplicates: [{ optionsHash: "album-001-010", count: 3 }],
          },
        };
        await formatOutput("json", complexData);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", complexData, undefined);
      });

      it("should pass empty object to machine formats", async () => {
        await formatOutput("yaml", {});

        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", {}, undefined);
      });
    });

    describe("format dispatch correctness", () => {
      it("should select the correct handler for each OutputFormat value", async () => {
        // text: returns early, no delegation
        await formatOutput("text", sampleData);
        expect(formatMachineOutput).not.toHaveBeenCalled();

        vi.clearAllMocks();

        // table: returns early, no delegation
        await formatOutput("table", sampleData);
        expect(formatMachineOutput).not.toHaveBeenCalled();

        vi.clearAllMocks();

        // json: delegates to formatMachineOutput
        await formatOutput("json", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();

        vi.clearAllMocks();

        // yaml: delegates to formatMachineOutput
        await formatOutput("yaml", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();

        vi.clearAllMocks();

        // csv: delegates to formatMachineOutput
        await formatOutput("csv", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();
      });
    });

    describe("options forwarding", () => {
      it("should not forward colorize option to formatMachineOutput", async () => {
        await formatOutput("json", sampleData, { colorize: true });

        // colorize is not part of CsvOptions, so csvOptions should be undefined
        expect(formatMachineOutput).toHaveBeenCalledWith("json", sampleData, undefined);
      });

      it("should forward columns as CsvOptions for all machine formats", async () => {
        const columns = ["name", "status"];

        await formatOutput("json", sampleData, { columns });
        expect(formatMachineOutput).toHaveBeenCalledWith("json", sampleData, { columns });

        vi.clearAllMocks();

        await formatOutput("yaml", sampleData, { columns });
        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", sampleData, { columns });

        vi.clearAllMocks();

        await formatOutput("csv", sampleData, { columns });
        expect(formatMachineOutput).toHaveBeenCalledWith("csv", sampleData, { columns });
      });

      it("should not forward options to human-readable formats", async () => {
        await formatOutput("text", sampleData, { columns: ["name"], colorize: true });
        expect(formatMachineOutput).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await formatOutput("table", sampleData, { columns: ["name"], colorize: true });
        expect(formatMachineOutput).not.toHaveBeenCalled();
      });
    });

    describe("machine-output invariants", () => {
      const machineFormats: OutputFormat[] = ["json", "yaml", "csv"];
      const humanFormats: OutputFormat[] = ["text", "table"];

      describe("isMachineFormat classification", () => {
        it("should classify json, yaml, csv as machine formats", () => {
          for (const format of machineFormats) {
            expect(isMachineFormat(format)).toBe(true);
          }
        });

        it("should not classify text or table as machine formats", () => {
          for (const format of humanFormats) {
            expect(isMachineFormat(format)).toBe(false);
          }
        });
      });

      describe("isHumanFormat classification", () => {
        it("should classify text and table as human formats", () => {
          for (const format of humanFormats) {
            expect(isHumanFormat(format)).toBe(true);
          }
        });

        it("should not classify json, yaml, csv as human formats", () => {
          for (const format of machineFormats) {
            expect(isHumanFormat(format)).toBe(false);
          }
        });

        it("should be the inverse of isMachineFormat for all known formats", () => {
          const allFormats: OutputFormat[] = [...machineFormats, ...humanFormats];
          for (const format of allFormats) {
            expect(isHumanFormat(format)).toBe(!isMachineFormat(format));
          }
        });
      });

      describe("OUTPUT_FORMATS completeness", () => {
        it("should cover all five known format values", () => {
          expect(OUTPUT_FORMATS).toHaveLength(5);
          expect(OUTPUT_FORMATS).toContain("json");
          expect(OUTPUT_FORMATS).toContain("yaml");
          expect(OUTPUT_FORMATS).toContain("csv");
          expect(OUTPUT_FORMATS).toContain("table");
          expect(OUTPUT_FORMATS).toContain("text");
        });

        it("should have every format handled by either machine or human path", () => {
          for (const format of OUTPUT_FORMATS) {
            const isMachine = isMachineFormat(format as OutputFormat);
            const isHuman = isHumanFormat(format as OutputFormat);
            expect(isMachine || isHuman).toBe(true);
            expect(isMachine && isHuman).toBe(false);
          }
        });
      });

      describe("machine format data passthrough", () => {
        it("should pass the exact data reference to formatMachineOutput for json", async () => {
          const data = { key: "value", nested: { deep: [1, 2, 3] } };
          await formatOutput("json", data);

          const callArgs = vi.mocked(formatMachineOutput).mock.calls[0];
          expect(callArgs?.[1]).toBe(data);
        });

        it("should pass the exact data reference to formatMachineOutput for yaml", async () => {
          const data = [{ name: "playlist-a" }, { name: "playlist-b" }];
          await formatOutput("yaml", data);

          const callArgs = vi.mocked(formatMachineOutput).mock.calls[0];
          expect(callArgs?.[1]).toBe(data);
        });

        it("should pass the exact data reference to formatMachineOutput for csv", async () => {
          const data = { tracks: 50, duration: 12345 };
          await formatOutput("csv", data);

          const callArgs = vi.mocked(formatMachineOutput).mock.calls[0];
          expect(callArgs?.[1]).toBe(data);
        });
      });

      describe("machine format isolation from table rendering", () => {
        it("should delegate to formatMachineOutput regardless of colorize option", async () => {
          for (const format of machineFormats) {
            vi.clearAllMocks();
            await formatOutput(format, sampleData, { colorize: true });

            expect(formatMachineOutput).toHaveBeenCalledOnce();
            expect(formatMachineOutput).toHaveBeenCalledWith(format, sampleData, undefined);
          }
        });

        it("should never call formatMachineOutput for human formats even with machine-like data", async () => {
          const jsonLikeData = JSON.stringify({ services: [] });
          const csvLikeData = "name,status\ntraefik,running";

          for (const format of humanFormats) {
            vi.clearAllMocks();
            await formatOutput(format, jsonLikeData);
            expect(formatMachineOutput).not.toHaveBeenCalled();

            vi.clearAllMocks();
            await formatOutput(format, csvLikeData);
            expect(formatMachineOutput).not.toHaveBeenCalled();
          }
        });

        it("should preserve machine format routing when columns and colorize are both set", async () => {
          const columns = ["name", "tracks", "duration"];
          for (const format of machineFormats) {
            vi.clearAllMocks();
            await formatOutput(format, sampleData, { columns, colorize: true });

            expect(formatMachineOutput).toHaveBeenCalledOnce();
            // colorize should be stripped; only columns forwarded as CsvOptions
            expect(formatMachineOutput).toHaveBeenCalledWith(format, sampleData, { columns });
          }
        });

        it("should pass format string verbatim to formatMachineOutput", async () => {
          for (const format of machineFormats) {
            vi.clearAllMocks();
            await formatOutput(format, sampleData);

            const callArgs = vi.mocked(formatMachineOutput).mock.calls[0];
            expect(callArgs?.[0]).toBe(format);
          }
        });
      });

      describe("machine format consistency across data shapes", () => {
        it("should handle primitive data identically across all machine formats", async () => {
          const primitives: unknown[] = ["string-value", 42, true, null];

          for (const primitive of primitives) {
            for (const format of machineFormats) {
              vi.clearAllMocks();
              await formatOutput(format, primitive);

              expect(formatMachineOutput).toHaveBeenCalledOnce();
              expect(formatMachineOutput).toHaveBeenCalledWith(format, primitive, undefined);
            }
          }
        });

        it("should handle playlist-shaped data identically across all machine formats", async () => {
          const playlistData = {
            playlists: [
              {
                ratingKey: "123",
                title: "My Favorites \u2014 Best of 2025",
                smart: false,
                leafCount: 42,
                duration: 7200000,
              },
              {
                ratingKey: "456",
                title: "\u97f3\u697d\u30d7\u30ec\u30a4\u30ea\u30b9\u30c8",
                smart: true,
                leafCount: 100,
                duration: 18000000,
              },
            ],
          };

          for (const format of machineFormats) {
            vi.clearAllMocks();
            await formatOutput(format, playlistData);

            expect(formatMachineOutput).toHaveBeenCalledOnce();
            expect(formatMachineOutput).toHaveBeenCalledWith(format, playlistData, undefined);
            // Verify the reference is passed through, not a copy
            const callArgs = vi.mocked(formatMachineOutput).mock.calls[0];
            expect(callArgs?.[1]).toBe(playlistData);
          }
        });
      });
    });
  });
});
