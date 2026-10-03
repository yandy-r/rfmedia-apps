import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commonMocks = vi.hoisted(() => ({
  checkDotenvx: vi.fn(),
  checkOp: vi.fn(),
  envFileExists: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("@rfmedia/common", () => commonMocks);
vi.mock("node:child_process", () => childProcessMocks);

import {
  autoDetectEnvTool,
  buildEnvCommand,
  captureEffectiveEnvironment,
  checkEnvTool,
  execWithEnv,
  isStaticNativeElfExecutable,
  validateEnvToolConfig,
} from "./env-tools.js";

function mockProcess(closeCode: number, chunks: { stdout?: string; stderr?: string } = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  childProcessMocks.spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      if (chunks.stdout !== undefined) proc.stdout.emit("data", Buffer.from(chunks.stdout));
      if (chunks.stderr !== undefined) proc.stderr.emit("data", Buffer.from(chunks.stderr));
      proc.emit("close", closeCode);
    });
    return proc;
  });

  return proc;
}

describe("environment tool utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commonMocks.checkDotenvx.mockResolvedValue({ available: false, error: "missing dotenvx" });
    commonMocks.checkOp.mockResolvedValue({ available: false, error: "missing op" });
    commonMocks.envFileExists.mockResolvedValue(false);
  });

  it("checks configured environment tools through the shared common helpers", async () => {
    commonMocks.checkDotenvx.mockResolvedValue({ available: true });
    commonMocks.checkOp.mockResolvedValue({ available: true });

    await expect(checkEnvTool("dotenvx")).resolves.toEqual({ available: true });
    await expect(checkEnvTool("op")).resolves.toEqual({ available: true });
    await expect(checkEnvTool("none")).resolves.toEqual({ available: true });
    await expect(checkEnvTool("unknown" as never)).resolves.toEqual({
      available: false,
      error: "Unknown environment tool: unknown",
    });
  });

  it("builds dotenvx, 1Password, and no-op command prefixes", () => {
    expect(buildEnvCommand({ tool: "dotenvx", envFile: ".env.local" })).toEqual({
      command: "dotenvx",
      args: ["run", "-q", "-f", ".env.local", "--"],
    });
    expect(buildEnvCommand({ tool: "op" })).toEqual({
      command: "op",
      args: ["run", "--no-masking", "--env-file", ".env", "--"],
    });
    expect(commonMocks.logWarn).toHaveBeenCalledWith(
      "No env file specified for 1Password, using default .env",
    );
    expect(buildEnvCommand({ tool: "none" })).toEqual({ command: "", args: [] });
  });

  it("executes commands with and without an environment tool prefix", async () => {
    mockProcess(0, { stdout: "ok\n", stderr: "warn\n" });

    await expect(
      execWithEnv("docker", ["compose", "ps"], {
        tool: "dotenvx",
        envFile: ".env.local",
        cwd: "/tmp/project",
        env: { EXTRA: "1" },
      }),
    ).resolves.toEqual({
      code: 0,
      stdout: "ok\n",
      stderr: "warn\n",
      success: true,
    });

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "dotenvx",
      ["run", "-q", "-f", ".env.local", "--", "docker", "compose", "ps"],
      expect.objectContaining({
        cwd: "/tmp/project",
        stdio: "pipe",
      }),
    );

    mockProcess(2, { stderr: "bad\n" });
    await expect(execWithEnv("docker", ["ps"], { tool: "none" })).resolves.toMatchObject({
      code: 2,
      stderr: "bad\n",
      success: false,
    });
    expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
      "docker",
      ["ps"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("returns a failed result when spawn emits an error", async () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    childProcessMocks.spawn.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit("error", new Error("spawn failed")));
      return proc;
    });

    await expect(execWithEnv("missing", [], { tool: "none" })).resolves.toEqual({
      code: 1,
      stdout: "",
      stderr: "spawn failed",
      success: false,
    });
  });

  it("captures a bounded effective wrapper environment without logging values", async () => {
    mockProcess(0, {
      stdout: "PATH=/usr/bin\0PRIVATE_TOKEN=secret\0MULTILINE=line1\nline2=equals\0",
    });

    await expect(
      captureEffectiveEnvironment({ tool: "op", envFile: "/private/source.env" }),
    ).resolves.toEqual({
      PATH: "/usr/bin",
      PRIVATE_TOKEN: "secret",
      MULTILINE: "line1\nline2=equals",
    });

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "op",
      [
        "run",
        "--no-masking",
        "--env-file",
        "/private/source.env",
        "--",
        "/usr/bin/busybox",
        "env",
        "-0",
      ],
      expect.any(Object),
    );
    expect(JSON.stringify(commonMocks.logDebug.mock.calls)).not.toContain("secret");
  });

  it("uses the same native dumper through dotenvx", async () => {
    mockProcess(0, { stdout: "PATH=/usr/bin\0" });

    await expect(
      captureEffectiveEnvironment({ tool: "dotenvx", envFile: "/private/source.env" }),
    ).resolves.toEqual({ PATH: "/usr/bin" });

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      "dotenvx",
      ["run", "-q", "-f", "/private/source.env", "--", "/usr/bin/busybox", "env", "-0"],
      expect.any(Object),
    );
  });

  it("rejects incomplete ELF lookalikes", () => {
    const fakeElf = Buffer.alloc(64);
    fakeElf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    fakeElf.writeUInt16LE(2, 16);
    fakeElf.writeBigUInt64LE(64n, 32);
    fakeElf.writeUInt16LE(64, 52);
    fakeElf.writeUInt16LE(56, 54);
    fakeElf.writeUInt16LE(1, 56);

    expect(isStaticNativeElfExecutable(fakeElf)).toBe(false);
  });

  it("fails closed on invalid effective environment capture", async () => {
    mockProcess(0, { stdout: "BAD=value-without-terminator" });

    await expect(captureEffectiveEnvironment({ tool: "dotenvx" })).rejects.toThrow(
      "Effective execution environment capture was invalid",
    );
  });

  it("terminates capture when native environment output exceeds four MiB", async () => {
    const proc = mockProcess(0, { stdout: "X".repeat(4 * 1024 * 1024 + 1) });

    await expect(captureEffectiveEnvironment({ tool: "none" })).rejects.toThrow(
      "Unable to capture the effective execution environment",
    );
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails closed before spawn when a dynamically linked dumper path is injected", async () => {
    await expect(
      captureEffectiveEnvironment({ tool: "none" }, async () => "/usr/bin/env"),
    ).rejects.toThrow("Native environment dumper is unavailable or unsafe");
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("fails closed before spawn when the native dumper is unavailable", async () => {
    await expect(
      captureEffectiveEnvironment({ tool: "none" }, async () => {
        throw new Error("missing");
      }),
    ).rejects.toThrow("Native environment dumper is unavailable or unsafe");
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });

  it("auto-detects dotenvx first, then 1Password, then none", async () => {
    await expect(autoDetectEnvTool(".env")).resolves.toBe("none");

    commonMocks.envFileExists.mockResolvedValue(true);
    commonMocks.checkDotenvx.mockResolvedValue({ available: true });
    await expect(autoDetectEnvTool(".env")).resolves.toBe("dotenvx");

    commonMocks.checkDotenvx.mockResolvedValue({ available: false });
    commonMocks.checkOp.mockResolvedValue({ available: true });
    await expect(autoDetectEnvTool(".env")).resolves.toBe("op");

    commonMocks.checkOp.mockResolvedValue({ available: false });
    await expect(autoDetectEnvTool(".env")).resolves.toBe("none");
  });

  it("validates tool availability and optional env file presence", async () => {
    await expect(validateEnvToolConfig("none")).resolves.toEqual({ valid: true, errors: [] });

    commonMocks.checkDotenvx.mockResolvedValue({ available: false, error: "install dotenvx" });
    commonMocks.envFileExists.mockResolvedValue(false);
    await expect(validateEnvToolConfig("dotenvx", ".env.local")).resolves.toEqual({
      valid: false,
      errors: ["install dotenvx", "Environment file not found: .env.local"],
    });

    commonMocks.checkDotenvx.mockResolvedValue({ available: true });
    commonMocks.envFileExists.mockResolvedValue(true);
    await expect(validateEnvToolConfig("dotenvx", ".env.local")).resolves.toEqual({
      valid: true,
      errors: [],
    });
  });
});
