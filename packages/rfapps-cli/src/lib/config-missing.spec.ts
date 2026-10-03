/**
 * Missing configuration file behavior tests.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

const mockFs = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: mockFs.access,
  readFile: mockFs.readFile,
}));

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    ...mockLogger,
  };
});

describe("loadConfig missing project config", () => {
  it("throws ConfigNotFoundError when project config is missing", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });

    mockFs.access.mockRejectedValue(enoent);
    mockFs.readFile.mockRejectedValue(enoent);

    const { loadConfig } = await import("./config.js");
    const { ConfigNotFoundError } = await import("./errors.js");

    const cwd = "/tmp/rfapps-missing-config";

    try {
      await loadConfig(cwd);
      expect.fail("Expected ConfigNotFoundError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigNotFoundError);
      const typedError = error as InstanceType<typeof ConfigNotFoundError>;
      expect(typedError.searchedPaths[0]).toBe(join(cwd, "rfapps.config.yaml"));
      expect(typedError.searchedPaths[1]).toMatch(/rfapps\.config\.yaml$/);
    }
  });
});
