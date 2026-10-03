/**
 * Registration guard tests for rfapps error formatters.
 */

import { describe, it, expect, vi } from "vitest";

describe("registerRfappsErrorFormatters", () => {
  it("registers formatters only once per process", async () => {
    vi.resetModules();

    const registerErrorFormatter = vi.fn();

    vi.doMock("@rfmedia/common", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@rfmedia/common")>();
      return {
        ...actual,
        registerErrorFormatter,
      };
    });

    const { registerRfappsErrorFormatters } = await import("./error-formatters.js");

    registerRfappsErrorFormatters();
    const firstCount = registerErrorFormatter.mock.calls.length;

    registerRfappsErrorFormatters();

    expect(firstCount).toBeGreaterThan(0);
    expect(registerErrorFormatter).toHaveBeenCalledTimes(firstCount);
  });
});
