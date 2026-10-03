import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  LookupNotFoundError,
  MissingRequiredArgumentError,
  OptionConflictError,
} from "../lib/errors.js";

vi.mock("../lib/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
}));

vi.mock("../cli.js", () => ({
  getLoadedConfig: vi.fn().mockReturnValue({
    copy: {},
    filters: {
      liked: { condition: "rating >= 3" },
      deepCuts: { condition: "rating >= 4" },
    },
  }),
}));

import { copyCommand } from "./copy.js";
import { deleteCommand } from "./delete.js";
import { syncCommand } from "./sync.js";

describe("command fail-fast typed errors", () => {
  let rootCommand: Command;

  beforeEach(() => {
    rootCommand = new Command("rfmedia")
      .exitOverride()
      .option("--dry-run", "Preview actions without executing")
      .option("--output <format>", "Output format")
      .option("--json", "Output in JSON format");

    rootCommand.addCommand(copyCommand);
    rootCommand.addCommand(deleteCommand);
    rootCommand.addCommand(syncCommand);
  });

  it("copy throws MissingRequiredArgumentError when source selection is used without --paths", async () => {
    await expect(
      rootCommand.parseAsync(
        ["node", "rfmedia", "copy", "/music/Artist", "/dest", "--source-name", "britney"],
        { from: "node" },
      ),
    ).rejects.toBeInstanceOf(MissingRequiredArgumentError);
  });

  it("copy throws LookupNotFoundError for unknown smart filter", async () => {
    await expect(
      rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "copy",
          "/music/Artist",
          "/dest",
          "--filter",
          "likde",
          "--range",
          "001-002",
        ],
        { from: "node" },
      ),
    ).rejects.toBeInstanceOf(LookupNotFoundError);
  });

  it("copy throws OptionConflictError for destination range suffix", async () => {
    await expect(
      rootCommand.parseAsync(
        ["node", "rfmedia", "copy", "/music/Artist", "/dest,001-002", "--range", "001-002"],
        { from: "node" },
      ),
    ).rejects.toBeInstanceOf(OptionConflictError);
  });

  it("delete throws MissingRequiredArgumentError when source selection is used without --paths", async () => {
    await expect(
      rootCommand.parseAsync(
        ["node", "rfmedia", "delete", "/music/Artist", "/dest", "--source-idx", "1"],
        { from: "node" },
      ),
    ).rejects.toBeInstanceOf(MissingRequiredArgumentError);
  });

  it("delete throws LookupNotFoundError with explicit suggestions for unknown smart filter", async () => {
    await expect(
      rootCommand.parseAsync(
        ["node", "rfmedia", "delete", "/music/Artist", "/dest", "--filter", "likde"],
        { from: "node" },
      ),
    ).rejects.toMatchObject({
      name: "LookupNotFoundError",
      context: undefined,
      suggestions: ["Add filters to your .rfmedia.yaml file"],
    });
  });

  it("copy throws InvalidNumericArgumentError with specific option name for integer parsing", async () => {
    await expect(
      rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "copy",
          "/music/Artist",
          "/dest",
          "--range",
          "001-002",
          "--workers",
          "abc",
        ],
        { from: "node" },
      ),
    ).rejects.toMatchObject({
      argument: "--workers",
      name: "InvalidNumericArgumentError",
    });
  });

  it("delete throws InvalidNumericArgumentError with specific option name for integer parsing", async () => {
    await expect(
      rootCommand.parseAsync(
        [
          "node",
          "rfmedia",
          "delete",
          "/music/Artist",
          "/dest",
          "--range",
          "001-002",
          "--min-rating",
          "xyz",
        ],
        { from: "node" },
      ),
    ).rejects.toMatchObject({
      argument: "--min-rating",
      name: "InvalidNumericArgumentError",
    });
  });

  it("sync throws MissingRequiredArgumentError when neither --file nor --paths is provided", async () => {
    await expect(
      rootCommand.parseAsync(["node", "rfmedia", "sync", "/dest"], { from: "node" }),
    ).rejects.toBeInstanceOf(MissingRequiredArgumentError);
  });

  it("sync throws InvalidNumericArgumentError with specific option name for integer parsing", async () => {
    await expect(
      rootCommand.parseAsync(
        ["node", "rfmedia", "sync", "--file", "sources.txt", "/dest", "--workers", "oops"],
        { from: "node" },
      ),
    ).rejects.toMatchObject({
      argument: "--workers",
      name: "InvalidNumericArgumentError",
    });
  });
});
