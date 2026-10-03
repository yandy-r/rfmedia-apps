import { describe, expect, it } from "vitest";
import {
  InvalidNumericArgumentError,
  InvalidOutputFormatError,
  LookupNotFoundError,
  MissingRequiredArgumentError,
  OptionConflictError,
} from "./errors.js";

describe("rfmedia validation errors", () => {
  it("creates InvalidNumericArgumentError with stable message and context", () => {
    const error = new InvalidNumericArgumentError("--count", "abc", "expected an integer", 1, 10);

    expect(error.name).toBe("InvalidNumericArgumentError");
    expect(error.message).toBe("Invalid value 'abc' for --count: expected an integer");
    expect(error.argument).toBe("--count");
    expect(error.value).toBe("abc");
    expect(error.reason).toBe("expected an integer");
    expect(error.min).toBe(1);
    expect(error.max).toBe(10);
  });

  it("creates OptionConflictError with optional details", () => {
    const error = new OptionConflictError("--filter", "--min-stars", "use one mode only");

    expect(error.name).toBe("OptionConflictError");
    expect(error.message).toBe("Cannot use --filter with --min-stars: use one mode only");
    expect(error.option).toBe("--filter");
    expect(error.conflictingOption).toBe("--min-stars");
    expect(error.details).toBe("use one mode only");
  });

  it("creates MissingRequiredArgumentError with context prefix", () => {
    const error = new MissingRequiredArgumentError("destination path is required", "--file");

    expect(error.name).toBe("MissingRequiredArgumentError");
    expect(error.message).toBe("--file: destination path is required");
    expect(error.requirement).toBe("destination path is required");
    expect(error.context).toBe("--file");
  });

  it("creates LookupNotFoundError with candidates and suggestion", () => {
    const error = new LookupNotFoundError(
      "filter",
      "likde",
      ["liked", "favorites"],
      "liked",
      "source path: /music/Artist",
      ["Add filters to your .rfmedia.yaml file"],
    );

    expect(error.name).toBe("LookupNotFoundError");
    expect(error.message).toBe("Unknown filter: 'likde' (source path: /music/Artist)");
    expect(error.lookupType).toBe("filter");
    expect(error.value).toBe("likde");
    expect(error.availableValues).toEqual(["liked", "favorites"]);
    expect(error.suggestion).toBe("liked");
    expect(error.context).toBe("source path: /music/Artist");
    expect(error.suggestions).toEqual(["Add filters to your .rfmedia.yaml file"]);
  });

  it("creates InvalidOutputFormatError with valid format list", () => {
    const error = new InvalidOutputFormatError("xml", ["json", "yaml", "text"]);

    expect(error.name).toBe("InvalidOutputFormatError");
    expect(error.message).toBe("Unknown output format: xml");
    expect(error.outputFormat).toBe("xml");
    expect(error.validFormats).toEqual(["json", "yaml", "text"]);
  });
});
