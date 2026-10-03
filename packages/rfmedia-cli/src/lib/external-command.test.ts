/**
 * Unit tests for external-command.ts.
 *
 * Tests cover command existence checking, successful execution, timeout
 * scenarios, abort signal handling, stderr/stdout collection with buffer
 * limits, and argument interpolation.
 *
 * Uses real process spawning for executeExternalCommand tests (node is always
 * available). interpolateArgs tests are pure and require no mocks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock which for commandExists tests - enables testing both branches
const mockWhich = vi.hoisted(() => vi.fn());
vi.mock("which", () => ({ default: mockWhich }));

import { commandExists, executeExternalCommand, interpolateArgs } from "./external-command.js";
import { ExternalCommandError } from "../types/plugins.js";

describe("commandExists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true when command exists", async () => {
    mockWhich.mockResolvedValue("/usr/bin/node");

    const result = await commandExists("node");

    expect(result).toBe(true);
    expect(mockWhich).toHaveBeenCalledWith("node", { nothrow: true });
  });

  it("should return false when command does not exist", async () => {
    mockWhich.mockResolvedValue(null);

    const result = await commandExists("nonexistent-command-xyz");

    expect(result).toBe(false);
  });

  it("should return false when which throws", async () => {
    mockWhich.mockRejectedValue(new Error("which failed"));

    const result = await commandExists("node");

    expect(result).toBe(false);
  });
});

describe("executeExternalCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: node exists for real execution tests
    mockWhich.mockImplementation((cmd: string, opts?: { nothrow?: boolean }) =>
      cmd === "node"
        ? Promise.resolve("/usr/bin/node")
        : opts?.nothrow
          ? Promise.resolve(null)
          : Promise.reject(new Error("not found")),
    );
  });

  it("should throw ExternalCommandError when command does not exist", async () => {
    mockWhich.mockResolvedValue(null);

    await expect(executeExternalCommand("nonexistent-cmd-xyz-123", [])).rejects.toThrow(
      ExternalCommandError,
    );
    await expect(executeExternalCommand("nonexistent-cmd-xyz-123", [])).rejects.toThrow(
      "Command not found",
    );
  });

  it("should execute successfully and return stdout/stderr", async () => {
    const result = await executeExternalCommand("node", [
      "-e",
      "console.log('hello'); console.error('warning')",
    ]);

    expect(result).toEqual({
      success: true,
      stdout: "hello",
      stderr: "warning",
      exitCode: 0,
    });
  });

  it("should reject when process exits with non-zero code", async () => {
    await expect(executeExternalCommand("node", ["-e", "process.exit(42)"])).rejects.toThrow(
      ExternalCommandError,
    );
    await expect(executeExternalCommand("node", ["-e", "process.exit(42)"])).rejects.toMatchObject({
      command: "node",
      exitCode: 42,
    });
  });

  it("should reject when process times out", async () => {
    const executePromise = executeExternalCommand("node", ["-e", "setTimeout(()=>{}, 60000)"], {
      timeout: 100,
    });

    await expect(executePromise).rejects.toThrow(ExternalCommandError);
    await expect(executePromise).rejects.toThrow("timed out or was aborted");
  });

  it("should reject when abort signal is triggered", async () => {
    const abortController = new AbortController();

    const executePromise = executeExternalCommand("node", ["-e", "setTimeout(()=>{}, 60000)"], {
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(executePromise).rejects.toThrow(ExternalCommandError);
    await expect(executePromise).rejects.toThrow("aborted");
  });

  it("should reject immediately when signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const executePromise = executeExternalCommand("node", ["-v"], {
      signal: abortController.signal,
    });

    await expect(executePromise).rejects.toThrow("Operation aborted");
  });

  it("should limit stdout buffer to 10KB", async () => {
    const size = 15 * 1024; // 15KB
    const result = await executeExternalCommand("node", ["-e", `console.log('x'.repeat(${size}))`]);

    expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 + 100);
  });

  it("should limit stderr buffer to 10KB", async () => {
    const size = 15 * 1024; // 15KB
    const result = await executeExternalCommand("node", [
      "-e",
      `console.error('e'.repeat(${size}))`,
    ]);

    expect(result.stderr.length).toBeLessThanOrEqual(10 * 1024 + 100);
  });

  it("should pass env to spawn", async () => {
    const result = await executeExternalCommand(
      "node",
      ["-e", "console.log(process.env.CUSTOM_VAR || '')"],
      { env: { CUSTOM_VAR: "custom_value" } },
    );

    expect(result.stdout).toBe("custom_value");
  });
});

describe("interpolateArgs", () => {
  it("should replace placeholders with context values", () => {
    const args = ["import", "-q", "{destPath}", "--artist={artist}"];
    const context = { destPath: "/music/album", artist: "Beatles" };

    const result = interpolateArgs(args, context);

    expect(result).toEqual(["import", "-q", "/music/album", "--artist=Beatles"]);
  });

  it("should replace unknown placeholders with empty string", () => {
    const args = ["{known}", "{unknown}"];
    const context = { known: "value" };

    const result = interpolateArgs(args, context);

    expect(result).toEqual(["value", ""]);
  });

  it("should handle undefined context values as empty string", () => {
    const args = ["{maybe}"];
    const context = { maybe: undefined };

    const result = interpolateArgs(args, context);

    expect(result).toEqual([""]);
  });

  it("should handle multiple placeholders in single argument", () => {
    const args = ["{a}-{b}-{c}"];
    const context = { a: "1", b: "2", c: "3" };

    const result = interpolateArgs(args, context);

    expect(result).toEqual(["1-2-3"]);
  });

  it("should leave args without placeholders unchanged", () => {
    const args = ["plain", "args", "no-placeholders"];
    const context = { x: "ignored" };

    const result = interpolateArgs(args, context);

    expect(result).toEqual(["plain", "args", "no-placeholders"]);
  });

  it("should handle empty args array", () => {
    const result = interpolateArgs([], {});

    expect(result).toEqual([]);
  });

  it("should handle empty context", () => {
    const args = ["{a}", "{b}"];

    const result = interpolateArgs(args, {});

    expect(result).toEqual(["", ""]);
  });

  it("should support alphanumeric placeholder names", () => {
    const args = ["{var1}", "{var_2}", "{var3}"];
    const context = { var1: "a", var_2: "b", var3: "c" };

    const result = interpolateArgs(args, context);

    expect(result).toEqual(["a", "b", "c"]);
  });
});
