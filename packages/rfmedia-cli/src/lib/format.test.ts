/**
 * Unit tests for format utility functions.
 */

import { describe, it, expect } from "vitest";
import { ratingToStars, formatDuration, truncate } from "./format.js";

describe("ratingToStars", () => {
  it("should return dashes for unrated (0)", () => {
    expect(ratingToStars(0)).toBe("-----");
  });

  it("should return 1 star for rating 2", () => {
    expect(ratingToStars(2)).toBe("\u2605\u2606\u2606\u2606\u2606");
  });

  it("should return 2 stars for rating 4", () => {
    expect(ratingToStars(4)).toBe("\u2605\u2605\u2606\u2606\u2606");
  });

  it("should return 3 stars for rating 6", () => {
    expect(ratingToStars(6)).toBe("\u2605\u2605\u2605\u2606\u2606");
  });

  it("should return 4 stars for rating 8", () => {
    expect(ratingToStars(8)).toBe("\u2605\u2605\u2605\u2605\u2606");
  });

  it("should return 5 stars for rating 10", () => {
    expect(ratingToStars(10)).toBe("\u2605\u2605\u2605\u2605\u2605");
  });

  it("should handle half stars by rounding up", () => {
    // 5 = 2.5 stars -> rounds to 3 filled
    expect(ratingToStars(5)).toBe("\u2605\u2605\u2605\u2606\u2606");
  });

  it("should handle odd ratings", () => {
    // 7 = 3.5 stars -> rounds to 4 filled
    expect(ratingToStars(7)).toBe("\u2605\u2605\u2605\u2605\u2606");
  });
});

describe("formatDuration", () => {
  it("should format duration in minutes:seconds", () => {
    expect(formatDuration(225000)).toBe("3:45");
  });

  it("should pad seconds with leading zero", () => {
    expect(formatDuration(180000)).toBe("3:00");
  });

  it("should handle short durations", () => {
    expect(formatDuration(5000)).toBe("0:05");
  });

  it("should handle long durations", () => {
    expect(formatDuration(600000)).toBe("10:00");
  });

  it("should handle zero duration", () => {
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("truncate", () => {
  it("should not truncate strings shorter than max length", () => {
    expect(truncate("Hello", 10)).toBe("Hello");
  });

  it("should not truncate strings equal to max length", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });

  it("should truncate strings longer than max length and add ellipsis", () => {
    expect(truncate("Hello World", 8)).toBe("Hello...");
  });

  it("should handle very short max length", () => {
    expect(truncate("Hello", 4)).toBe("H...");
  });

  it("should handle empty string", () => {
    expect(truncate("", 10)).toBe("");
  });
});
