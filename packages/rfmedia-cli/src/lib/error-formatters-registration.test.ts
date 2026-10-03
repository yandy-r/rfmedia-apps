import { describe, expect, it, vi } from "vitest";

describe("registerRfmediaErrorFormatters", () => {
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

    const { registerRfmediaErrorFormatters } = await import("./error-formatters.js");

    registerRfmediaErrorFormatters();
    const firstCount = registerErrorFormatter.mock.calls.length;

    registerRfmediaErrorFormatters();

    expect(firstCount).toBeGreaterThan(0);
    expect(registerErrorFormatter).toHaveBeenCalledTimes(firstCount);
  });
});
