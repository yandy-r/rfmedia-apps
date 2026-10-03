import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @rfmedia/common -- must be before imports that use it
vi.mock("@rfmedia/common", () => ({
  formatMachineOutput: vi.fn(),
}));

// Mock the local table module
vi.mock("./table.js", () => ({
  renderTable: vi.fn(),
}));

import { formatOutput, withFormatOutputCapture } from "./index.js";
import { formatMachineOutput } from "@rfmedia/common";
import { renderTable } from "./table.js";

describe("formatters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatOutput", () => {
    const sampleData = { services: ["traefik", "plex"], count: 2 };

    describe("text format", () => {
      it("should return early without producing any output", async () => {
        await formatOutput("text", sampleData);

        expect(formatMachineOutput).not.toHaveBeenCalled();
        expect(renderTable).not.toHaveBeenCalled();
      });

      it("should return early even with options provided", async () => {
        await formatOutput("text", sampleData, { columns: ["services"] });

        expect(formatMachineOutput).not.toHaveBeenCalled();
        expect(renderTable).not.toHaveBeenCalled();
      });
    });

    describe("table format", () => {
      it("should delegate to renderTable", async () => {
        await formatOutput("table", sampleData);

        expect(renderTable).toHaveBeenCalledOnce();
        expect(renderTable).toHaveBeenCalledWith(sampleData, undefined);
      });

      it("should pass columns option to renderTable", async () => {
        const columns = ["services", "count"];
        await formatOutput("table", sampleData, { columns });

        expect(renderTable).toHaveBeenCalledOnce();
        expect(renderTable).toHaveBeenCalledWith(sampleData, columns);
      });

      it("should not delegate to formatMachineOutput", async () => {
        await formatOutput("table", sampleData);

        expect(formatMachineOutput).not.toHaveBeenCalled();
      });
    });

    describe("json format", () => {
      it("should delegate to formatMachineOutput with json format", async () => {
        await formatOutput("json", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("json", sampleData);
      });

      it("should not call renderTable", async () => {
        await formatOutput("json", sampleData);

        expect(renderTable).not.toHaveBeenCalled();
      });
    });

    describe("yaml format", () => {
      it("should delegate to formatMachineOutput with yaml format", async () => {
        await formatOutput("yaml", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", sampleData);
      });

      it("should not call renderTable", async () => {
        await formatOutput("yaml", sampleData);

        expect(renderTable).not.toHaveBeenCalled();
      });
    });

    describe("csv format", () => {
      it("should delegate to formatMachineOutput with csv format", async () => {
        await formatOutput("csv", sampleData);

        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(formatMachineOutput).toHaveBeenCalledWith("csv", sampleData);
      });

      it("should not call renderTable", async () => {
        await formatOutput("csv", sampleData);

        expect(renderTable).not.toHaveBeenCalled();
      });
    });

    describe("data handling", () => {
      it("should pass null data to machine formats", async () => {
        await formatOutput("json", null);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", null);
      });

      it("should pass undefined data to machine formats", async () => {
        await formatOutput("json", undefined);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", undefined);
      });

      it("should pass array data to machine formats", async () => {
        const arrayData = [{ name: "a" }, { name: "b" }];
        await formatOutput("yaml", arrayData);

        expect(formatMachineOutput).toHaveBeenCalledWith("yaml", arrayData);
      });

      it("should pass null data to table format", async () => {
        await formatOutput("table", null);

        expect(renderTable).toHaveBeenCalledWith(null, undefined);
      });

      it("should pass complex nested data to machine formats", async () => {
        const complexData = {
          plan: { services: [{ name: "traefik", changes: { image: "v3.0" } }] },
          metadata: { timestamp: "2026-01-01" },
        };
        await formatOutput("json", complexData);

        expect(formatMachineOutput).toHaveBeenCalledWith("json", complexData);
      });
    });

    describe("format dispatch correctness", () => {
      it("should select the correct formatter for each OutputFormat value", async () => {
        // Test all five format values to ensure dispatch routes correctly
        await formatOutput("text", sampleData);
        expect(formatMachineOutput).not.toHaveBeenCalled();
        expect(renderTable).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await formatOutput("table", sampleData);
        expect(renderTable).toHaveBeenCalledOnce();
        expect(formatMachineOutput).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await formatOutput("json", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(renderTable).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await formatOutput("yaml", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(renderTable).not.toHaveBeenCalled();

        vi.clearAllMocks();

        await formatOutput("csv", sampleData);
        expect(formatMachineOutput).toHaveBeenCalledOnce();
        expect(renderTable).not.toHaveBeenCalled();
      });
    });

    describe("capture context", () => {
      it("captures non-text output without writing to machine or table formatters", async () => {
        const captured: Array<{ format: string; data: unknown }> = [];
        const sample = { ok: true };

        await withFormatOutputCapture(
          (format, data) => {
            captured.push({ format, data });
          },
          async () => {
            await formatOutput("json", sample);
            await formatOutput("table", sample);
          },
        );

        expect(captured).toEqual([
          { format: "json", data: sample },
          { format: "table", data: sample },
        ]);
        expect(formatMachineOutput).not.toHaveBeenCalled();
        expect(renderTable).not.toHaveBeenCalled();
      });

      it("does not capture text format output", async () => {
        const capture = vi.fn();

        await withFormatOutputCapture(capture, async () => {
          await formatOutput("text", { ignored: true });
        });

        expect(capture).not.toHaveBeenCalled();
        expect(formatMachineOutput).not.toHaveBeenCalled();
        expect(renderTable).not.toHaveBeenCalled();
      });
    });
  });
});
