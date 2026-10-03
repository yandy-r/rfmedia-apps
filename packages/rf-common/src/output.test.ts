import { beforeEach, describe, expect, it } from "vitest";
import { isJsonMode, setJsonMode } from "./logger.js";
import {
  getOutputFormat,
  isMachineFormat,
  isValidOutputFormat,
  OUTPUT_FORMATS,
  setOutputFormat,
  type OutputFormat,
} from "./output.js";

describe("output format state", () => {
  beforeEach(() => {
    setJsonMode(false);
  });

  it("defaults to text and retains every supported format", () => {
    expect(getOutputFormat()).toBe("text");
    for (const format of OUTPUT_FORMATS) {
      setOutputFormat(format);
      expect(getOutputFormat(), format).toBe(format);
    }
  });

  it("overwrites the previous format", () => {
    setOutputFormat("json");
    setOutputFormat("yaml");
    setOutputFormat("csv");
    expect(getOutputFormat()).toBe("csv");
  });

  it("validates the closed output-format vocabulary", () => {
    for (const format of OUTPUT_FORMATS) {
      expect(isValidOutputFormat(format), format).toBe(true);
    }
    for (const value of ["xml", 123, null, undefined]) {
      expect(isValidOutputFormat(value), String(value)).toBe(false);
    }
  });

  it("classifies explicit machine and human formats", () => {
    const expected: Readonly<Record<OutputFormat, boolean>> = {
      json: true,
      yaml: true,
      csv: true,
      text: false,
      table: false,
    };
    for (const format of OUTPUT_FORMATS) {
      expect(isMachineFormat(format), format).toBe(expected[format]);
    }
  });

  it("classifies the active format when no argument is supplied", () => {
    for (const format of OUTPUT_FORMATS) {
      setOutputFormat(format);
      expect(isMachineFormat(), format).toBe(["json", "yaml", "csv"].includes(format));
    }
  });

  it("keeps the legacy JSON mode synchronized with output format", () => {
    setJsonMode(true);
    expect(getOutputFormat()).toBe("json");
    expect(isJsonMode()).toBe(true);

    setJsonMode(false);
    expect(getOutputFormat()).toBe("text");
    expect(isJsonMode()).toBe(false);
  });

  it("reports JSON mode only for JSON, not other machine formats", () => {
    for (const format of ["yaml", "csv", "table", "text"] as const) {
      setOutputFormat(format);
      expect(isJsonMode(), format).toBe(false);
    }
  });
});
