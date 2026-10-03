import { beforeAll, describe, expect, it } from "vitest";
import { formatError } from "@rfmedia/common";
import { registerRfmediaErrorFormatters } from "./error-formatters.js";
import {
  InvalidNumericArgumentError,
  InvalidOutputFormatError,
  LookupNotFoundError,
  MissingRequiredArgumentError,
  OptionConflictError,
  PlanArtifactError,
  PlanStaleError,
  PlanValidationError,
} from "./errors.js";
import { SourceSelectionError } from "./paths-yaml.js";
import { ConfigError } from "./config-validation.js";
import type { PlanStalenessFinding } from "../types/plan.js";

beforeAll(() => {
  registerRfmediaErrorFormatters();
});

function makeStalenessFinding(overrides: Partial<PlanStalenessFinding> = {}): PlanStalenessFinding {
  return {
    severity: "error",
    code: "source-drift",
    message: "source changed since planning",
    overridable: true,
    ...overrides,
  };
}

describe("registerRfmediaErrorFormatters", () => {
  it("formats InvalidNumericArgumentError with range guidance", () => {
    const error = new InvalidNumericArgumentError("--min-stars", 6, "out of range", 1, 5);
    const result = formatError(error);

    expect(result.message).toBe("Invalid value '6' for --min-stars: out of range");
    expect(result.suggestions).toContain("Expected a value between 1 and 5");
  });

  it("formats OptionConflictError with details", () => {
    const error = new OptionConflictError("--filter", "--min-stars", "use one mode only");
    const result = formatError(error);

    expect(result.message).toBe("Cannot use --filter with --min-stars");
    expect(result.suggestions).toContain("use one mode only");
  });

  it("formats MissingRequiredArgumentError directly", () => {
    const error = new MissingRequiredArgumentError("destination argument is required", "--file");
    const result = formatError(error);

    expect(result.message).toBe("--file: destination argument is required");
    expect(result.suggestions).toContain("Provide the required argument(s) and retry");
  });

  it("formats LookupNotFoundError with typo suggestion and available values", () => {
    const error = new LookupNotFoundError(
      "filter",
      "likde",
      ["liked", "favorites"],
      undefined,
      "source path: /music/Britney Spears",
      ["Add filters to your .rfmedia.yaml file"],
    );
    const result = formatError(error);

    expect(result.message).toBe("Unknown filter: 'likde'");
    expect(result.suggestions).toContain("Did you mean 'liked'?");
    expect(result.suggestions).toContain("Available values for filter: liked, favorites");
    expect(result.suggestions).toContain("Context: source path: /music/Britney Spears");
    expect(result.suggestions).toContain("Add filters to your .rfmedia.yaml file");
  });

  it("formats SourceSelectionError with selection details and available source list", () => {
    const error = new SourceSelectionError("No sources matched the selection criteria.", {
      selectionSummary: "--source-name=briteny",
      availableSources: "  1: artist: Britney Spears",
      suggestion: "Britney Spears",
    });
    const result = formatError(error);

    expect(result.message).toBe(
      "Invalid source selection: No sources matched the selection criteria.",
    );
    expect(result.suggestions).toContain("Selection: --source-name=briteny");
    expect(result.suggestions).toContain("Did you mean 'Britney Spears'?");
    expect(result.suggestions).toContain("Available sources:\n  1: artist: Britney Spears");
  });

  it("formats InvalidOutputFormatError with valid formats", () => {
    const error = new InvalidOutputFormatError("xml", ["json", "yaml", "text"]);
    const result = formatError(error);

    expect(result.message).toBe("Unknown output format: xml");
    expect(result.suggestions).toContain("Valid formats: json, yaml, text");
  });

  it("formats PlanArtifactError checksum mismatch with tamper and regenerate guidance", () => {
    const error = new PlanArtifactError(
      "PLAN_CHECKSUM_MISMATCH",
      "Plan checksum mismatch: file was modified after creation",
      "/plans/plan.json",
    );
    const result = formatError(error);

    expect(result.message).toBe("Plan checksum mismatch: file was modified after creation");
    expect(result.suggestions).toContain(
      "The plan file was modified after creation; this is never overridable",
    );
    expect(result.suggestions).toContain("Regenerate the plan with: rfmedia copy ... --plan");
    expect(result.exitCode).toBe(1);
  });

  it("omits the tamper suggestion for non-checksum PlanArtifactError codes", () => {
    const error = new PlanArtifactError(
      "PLAN_MALFORMED",
      "Plan file is not valid JSON",
      "/plans/plan.json",
    );
    const result = formatError(error);

    expect(result.message).toBe("Plan file is not valid JSON");
    expect(result.suggestions).not.toContain(
      "The plan file was modified after creation; this is never overridable",
    );
    expect(result.suggestions).toContain("Regenerate the plan with: rfmedia copy ... --plan");
    expect(result.exitCode).toBe(1);
  });

  it("formats PlanValidationError with message passthrough and version-lock guidance", () => {
    const error = new PlanValidationError(
      "execution.workers must be a finite number",
      "/plans/plan.json",
    );
    const result = formatError(error);

    expect(result.message).toBe("Invalid copy plan: execution.workers must be a finite number");
    expect(result.suggestions).toContain(
      "Plans are version-locked (rfmedia.copy-plan.v1); regenerate with the current CLI",
    );
    expect(result.exitCode).toBe(1);
  });

  it("formats PlanStaleError findings without paths as a bare finding line", () => {
    const error = new PlanStaleError(
      [
        makeStalenessFinding({
          code: "source-missing",
          message: "source directory no longer exists",
        }),
      ],
      "/plans/plan.json",
    );
    const result = formatError(error);

    expect(result.message).toBe(
      [
        "Plan is stale: 1 blocking finding(s)",
        "  [error] source-missing: source directory no longer exists",
      ].join("\n"),
    );
    expect(result.suggestions).toEqual([
      "Pass --force-stale to override world-drift errors (never overrides corruption)",
      "Regenerate the plan to re-review current state",
    ]);
    expect(result.exitCode).toBe(1);
  });

  it("renders every PlanStaleError path when under the 10-path cap", () => {
    const paths = ["/music/a.flac", "/music/b.flac", "/music/c.flac"];
    const error = new PlanStaleError([makeStalenessFinding({ paths })], "/plans/plan.json");
    const result = formatError(error);

    for (const path of paths) {
      expect(result.message).toContain(`    ${path}`);
    }
    expect(result.message).not.toMatch(/\+\d+ more/);
    expect(result.exitCode).toBe(1);
  });

  it("caps PlanStaleError path rendering at 10 with a +N more overflow line", () => {
    const paths = Array.from(
      { length: 12 },
      (_, i) => `/music/track-${String(i + 1).padStart(2, "0")}.flac`,
    );
    const error = new PlanStaleError([makeStalenessFinding({ paths })], "/plans/plan.json");
    const result = formatError(error);

    expect(result.message).toContain("    /music/track-01.flac");
    expect(result.message).toContain("    /music/track-10.flac");
    expect(result.message).not.toContain("/music/track-11.flac");
    expect(result.message).not.toContain("/music/track-12.flac");
    expect(result.message).toContain("    +2 more");
    expect(result.exitCode).toBe(1);
  });

  it("formats ConfigError with property path and config file guidance", () => {
    const error = new ConfigError(
      "Expected boolean for plex.cache.enabled",
      "/test/config.yaml",
      "plex.cache.enabled",
    );
    const result = formatError(error);

    expect(result.message).toBe(
      "Invalid configuration at 'plex.cache.enabled': Expected boolean for plex.cache.enabled",
    );
    expect(result.suggestions).toContain("Check the configuration in /test/config.yaml");
    expect(result.suggestions).toContain("Verify the value of 'plex.cache.enabled'");
    expect(result.exitCode).toBe(1);
  });
});
