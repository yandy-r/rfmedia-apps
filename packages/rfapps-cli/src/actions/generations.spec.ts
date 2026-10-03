/**
 * Tests for the generations listing action (history --generations).
 *
 * Validates filter validation, table rendering, machine-format output,
 * and empty-state messaging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../lib/index.js", () => ({
  initializeDatabase: vi.fn().mockResolvedValue(Symbol("mock-db")),
  closeDatabase: vi.fn(),
  getGenerations: vi.fn().mockReturnValue([]),
  getGenerationCount: vi.fn().mockReturnValue(0),
  InvalidArgumentError: class InvalidArgumentError extends Error {
    readonly argument: string;
    readonly value: string;
    readonly reason: string;
    constructor(argument: string, value: string, reason: string) {
      super(`Invalid argument "${argument}": ${reason} (got "${value}")`);
      this.name = "InvalidArgumentError";
      this.argument = argument;
      this.value = value;
      this.reason = reason;
    }
  },
}));

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return { ...actual, formatOutput: vi.fn() };
});

import { executeGenerations } from "./generations.js";
import { getGenerations, getGenerationCount, closeDatabase } from "../lib/index.js";
import { formatOutput } from "../lib/formatters/index.js";
import { logInfo } from "@rfmedia/common";
import type { GenerationEntry } from "../types/index.js";

function makeGeneration(overrides: Partial<GenerationEntry> = {}): GenerationEntry {
  return {
    id: 1,
    service: "traefik",
    generation: 1,
    deploymentId: 10,
    timestamp: "2026-01-15T10:30:00.000Z",
    imageTag: "traefik:v3.0",
    configSnapshot: JSON.stringify({ image: "traefik:v3.0" }),
    createdByAction: "deploy",
    ...overrides,
  };
}

describe("generations action", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function stderrOutput(): string {
    return consoleErrorSpy.mock.calls.map((args: unknown[]) => String(args[0] ?? "")).join("\n");
  }

  describe("validation", () => {
    it("throws InvalidArgumentError for a non-positive limit", async () => {
      await expect(executeGenerations({ limit: "0" }, {})).rejects.toThrow(/limit/);
      await expect(executeGenerations({ limit: "abc" }, {})).rejects.toThrow(/limit/);
    });

    it("rejects the history --action filter in generations mode", async () => {
      await expect(executeGenerations({ action: "deploy" }, {})).rejects.toThrow(/--action/);
    });

    it("rejects the history --since filter in generations mode", async () => {
      await expect(executeGenerations({ since: "2026-01-01" }, {})).rejects.toThrow(/--since/);
    });
  });

  describe("table output", () => {
    it("renders generation rows with numbers, action, and image", async () => {
      vi.mocked(getGenerations).mockReturnValue([
        makeGeneration({ generation: 2, imageTag: "traefik:v3.1", createdByAction: "rebuild" }),
        makeGeneration({ generation: 1 }),
      ]);
      vi.mocked(getGenerationCount).mockReturnValue(2);

      await executeGenerations({ service: "traefik" }, {});

      const output = stderrOutput();
      expect(output).toContain("Generations");
      expect(output).toContain("#2");
      expect(output).toContain("#1");
      expect(output).toContain("rebuild");
      expect(output).toContain("traefik:v3.1");
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "Restore with: rfapps rollback -s <service> --to-generation <n>",
      );
    });

    it("shows a dash for generations without a deployment link or image", async () => {
      vi.mocked(getGenerations).mockReturnValue([
        makeGeneration({ deploymentId: undefined, imageTag: undefined }),
      ]);
      vi.mocked(getGenerationCount).mockReturnValue(1);

      await executeGenerations({}, {});

      expect(stderrOutput()).toContain("-");
    });

    it("shows an empty-state message when no generations exist", async () => {
      vi.mocked(getGenerations).mockReturnValue([]);
      vi.mocked(getGenerationCount).mockReturnValue(0);

      await executeGenerations({ service: "plex" }, {});

      expect(vi.mocked(logInfo)).toHaveBeenCalledWith("No generations found");
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith('Applied filters: service="plex"');
    });

    it("reports truncated result counts", async () => {
      vi.mocked(getGenerations).mockReturnValue([makeGeneration()]);
      vi.mocked(getGenerationCount).mockReturnValue(5);

      await executeGenerations({ limit: "1" }, {});

      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "Showing 1 of 5 generations (use --limit to see more)",
      );
    });
  });

  describe("machine output", () => {
    it("outputs a GenerationsResult for non-text formats", async () => {
      const entries = [makeGeneration()];
      vi.mocked(getGenerations).mockReturnValue(entries);
      vi.mocked(getGenerationCount).mockReturnValue(1);

      await executeGenerations({ service: "traefik", limit: "5" }, { output: "json" });

      expect(formatOutput).toHaveBeenCalledWith("json", {
        entries,
        totalCount: 1,
        filters: { service: "traefik", limit: 5 },
      });
    });
  });

  it("always closes the database connection", async () => {
    vi.mocked(getGenerations).mockImplementation(() => {
      throw new Error("query failed");
    });

    await executeGenerations({}, {});

    expect(closeDatabase).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
