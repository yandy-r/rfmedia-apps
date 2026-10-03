/**
 * Unit tests for environment tool utilities.
 *
 * Tests cover:
 * - checkDotenvx() - dotenvx CLI availability and version
 * - checkOp() - 1Password CLI availability and version
 * - envFileExists() - environment file existence checks
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 * Using resetAllMocks() would reset mock implementations and break tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process with vi.hoisted() - must be defined before vi.mock()
const mockSpawn = vi.hoisted(() => {
  return vi.fn();
});

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

// Mock fs/promises with vi.hoisted()
const mockAccess = vi.hoisted(() => {
  return vi.fn();
});

const mockConstants = vi.hoisted(() => ({
  R_OK: 4,
}));

vi.mock("node:fs/promises", () => ({
  access: mockAccess,
  constants: mockConstants,
}));

// Import after mocks
import { checkDotenvx, checkOp, envFileExists } from "./env-tools.js";

/**
 * Create a mock ChildProcess-like object for spawn
 */
function createMockProcess(options: { exitCode?: number; stdout?: string; emitError?: Error }) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
  };
  proc.stdout = new EventEmitter();

  // Schedule events for next tick to allow test code to attach listeners
  process.nextTick(() => {
    if (options.emitError) {
      proc.emit("error", options.emitError);
    } else {
      if (options.stdout) {
        proc.stdout.emit("data", Buffer.from(options.stdout));
      }
      proc.emit("close", options.exitCode ?? 0);
    }
  });

  return proc;
}

describe("checkDotenvx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when dotenvx is available", () => {
    it("should return available: true with version", async () => {
      // Mock 'which dotenvx' succeeds
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
      // Mock 'dotenvx --version' returns version
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0, stdout: "1.2.3\n" }));

      const result = await checkDotenvx();

      expect(result.available).toBe(true);
      expect(result.version).toBe("1.2.3");
      expect(result.error).toBeUndefined();
    });

    it("should handle multi-line version output", async () => {
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
      mockSpawn.mockImplementationOnce(() =>
        createMockProcess({ exitCode: 0, stdout: "dotenvx 1.5.0\nBuilt with love\n" }),
      );

      const result = await checkDotenvx();

      expect(result.available).toBe(true);
      expect(result.version).toBe("dotenvx 1.5.0");
    });

    it("should return undefined version if version command fails", async () => {
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 1 }));

      const result = await checkDotenvx();

      expect(result.available).toBe(true);
      expect(result.version).toBeUndefined();
    });
  });

  describe("when dotenvx is not available", () => {
    it("should return available: false with error message", async () => {
      // Mock 'which dotenvx' fails
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 1 }));

      const result = await checkDotenvx();

      expect(result.available).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.error).toBe(
        "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx",
      );
    });

    it("should handle spawn error gracefully", async () => {
      mockSpawn.mockImplementationOnce(() =>
        createMockProcess({ emitError: new Error("spawn failed") }),
      );

      const result = await checkDotenvx();

      expect(result.available).toBe(false);
      expect(result.error).toBe(
        "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx",
      );
    });
  });
});

describe("checkOp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when op is available", () => {
    it("should return available: true with version", async () => {
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
      mockSpawn.mockImplementationOnce(() =>
        createMockProcess({ exitCode: 0, stdout: "2.18.0\n" }),
      );

      const result = await checkOp();

      expect(result.available).toBe(true);
      expect(result.version).toBe("2.18.0");
      expect(result.error).toBeUndefined();
    });

    it("should return undefined version if version command fails", async () => {
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 1 }));

      const result = await checkOp();

      expect(result.available).toBe(true);
      expect(result.version).toBeUndefined();
    });
  });

  describe("when op is not available", () => {
    it("should return available: false with error message", async () => {
      mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 1 }));

      const result = await checkOp();

      expect(result.available).toBe(false);
      expect(result.version).toBeUndefined();
      expect(result.error).toBe(
        "1Password CLI (op) not found in PATH. Install from: https://1password.com/downloads/command-line/",
      );
    });

    it("should handle spawn error gracefully", async () => {
      mockSpawn.mockImplementationOnce(() =>
        createMockProcess({ emitError: new Error("spawn failed") }),
      );

      const result = await checkOp();

      expect(result.available).toBe(false);
      expect(result.error).toBe(
        "1Password CLI (op) not found in PATH. Install from: https://1password.com/downloads/command-line/",
      );
    });
  });
});

describe("envFileExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("file exists and is readable", () => {
    it("should return true for existing file", async () => {
      mockAccess.mockResolvedValueOnce(undefined);

      const result = await envFileExists(".env");

      expect(result).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith(".env", mockConstants.R_OK);
    });

    it("should return true for absolute path", async () => {
      mockAccess.mockResolvedValueOnce(undefined);

      const result = await envFileExists("/path/to/.env");

      expect(result).toBe(true);
      expect(mockAccess).toHaveBeenCalledWith("/path/to/.env", mockConstants.R_OK);
    });
  });

  describe("file does not exist", () => {
    it("should return false when file not found", async () => {
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

      const result = await envFileExists(".env.missing");

      expect(result).toBe(false);
    });

    it("should return false when access denied", async () => {
      mockAccess.mockRejectedValueOnce(new Error("EACCES"));

      const result = await envFileExists("/root/.env");

      expect(result).toBe(false);
    });
  });
});

describe("integration scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle checking both tools in sequence", async () => {
    // dotenvx available
    mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
    mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0, stdout: "1.0.0" }));

    // op not available
    mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 1 }));

    const dotenvxResult = await checkDotenvx();
    const opResult = await checkOp();

    expect(dotenvxResult.available).toBe(true);
    expect(opResult.available).toBe(false);
  });

  it("should handle checking tool and file together", async () => {
    // dotenvx available
    mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0 }));
    mockSpawn.mockImplementationOnce(() => createMockProcess({ exitCode: 0, stdout: "1.0.0" }));

    // file exists
    mockAccess.mockResolvedValueOnce(undefined);

    const toolResult = await checkDotenvx();
    const fileResult = await envFileExists(".env");

    expect(toolResult.available).toBe(true);
    expect(fileResult).toBe(true);
  });
});
