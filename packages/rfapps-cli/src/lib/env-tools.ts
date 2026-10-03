/**
 * Environment variable injection tools for rfapps CLI
 *
 * Supports:
 * - dotenvx: Local .env file with encryption
 * - op (1Password CLI): Secrets from 1Password vaults
 * - none: No environment injection
 */

import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  logDebug,
  logWarn,
  checkDotenvx as commonCheckDotenvx,
  checkOp as commonCheckOp,
  envFileExists as commonEnvFileExists,
  type ToolCheckResult,
  type EnvTool,
} from "@rfmedia/common";

// Re-export shared types and functions for backwards compatibility
export { checkDotenvx, checkOp, envFileExists } from "@rfmedia/common";
export type { ToolCheckResult, EnvTool } from "@rfmedia/common";

/**
 * Options for environment tool execution
 */
export interface EnvToolOptions {
  /** Which tool to use */
  tool: EnvTool;
  /** Path to environment file (for dotenvx) */
  envFile?: string;
  /** Working directory */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Replace, rather than extend, the parent environment. */
  replaceEnv?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Maximum stdout bytes retained. */
  maxStdoutBytes?: number;
  /** Maximum stderr bytes retained. */
  maxStderrBytes?: number;
}

const EFFECTIVE_ENVIRONMENT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const EFFECTIVE_ENVIRONMENT_MAX_ENTRIES = 4096;
const EFFECTIVE_ENVIRONMENT_MAX_KEY_BYTES = 256;
const EFFECTIVE_ENVIRONMENT_MAX_VALUE_BYTES = 64 * 1024;
const STATIC_ENVIRONMENT_DUMPER_PATHS = ["/usr/bin/busybox", "/bin/busybox"] as const;
const UNSAFE_WRITE_MODE = 0o022;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const ELF_CLASS_32 = 1;
const ELF_CLASS_64 = 2;
const ELF_DATA_LITTLE_ENDIAN = 1;
const ELF_DATA_BIG_ENDIAN = 2;
const ELF_VERSION_CURRENT = 1;
const ELF_TYPE_EXECUTABLE = 2;
const ELF_TYPE_SHARED_OBJECT = 3;
const ELF_PROGRAM_TYPE_LOAD = 1;
const ELF_PROGRAM_TYPE_INTERPRETER = 3;
const ELF_PROGRAM_FLAG_EXECUTE = 1;
const ELF_MAX_PROGRAM_HEADERS = 1024;
const ELF_ARCHITECTURES: Readonly<Record<string, { elfClass: number; machine: number }>> = {
  arm: { elfClass: ELF_CLASS_32, machine: 40 },
  arm64: { elfClass: ELF_CLASS_64, machine: 183 },
  ia32: { elfClass: ELF_CLASS_32, machine: 3 },
  loong64: { elfClass: ELF_CLASS_64, machine: 258 },
  mips: { elfClass: ELF_CLASS_32, machine: 8 },
  mipsel: { elfClass: ELF_CLASS_32, machine: 8 },
  ppc: { elfClass: ELF_CLASS_32, machine: 20 },
  ppc64: { elfClass: ELF_CLASS_64, machine: 21 },
  riscv64: { elfClass: ELF_CLASS_64, machine: 243 },
  s390x: { elfClass: ELF_CLASS_64, machine: 22 },
  x64: { elfClass: ELF_CLASS_64, machine: 62 },
};

type EnvironmentDumperResolver = () => Promise<string>;

function readElfUnsigned(
  image: Buffer,
  offset: number,
  width: 2 | 4 | 8,
  littleEndian: boolean,
): number {
  if (width === 2) {
    return littleEndian ? image.readUInt16LE(offset) : image.readUInt16BE(offset);
  }
  if (width === 4) {
    return littleEndian ? image.readUInt32LE(offset) : image.readUInt32BE(offset);
  }
  const value = littleEndian ? image.readBigUInt64LE(offset) : image.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ELF integer exceeds safe range");
  return Number(value);
}

/** Validate the executable structure without invoking file, ldd, or another interpreter. */
export function isStaticNativeElfExecutable(image: Buffer): boolean {
  try {
    if (image.length < 16 || !image.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC)) return false;

    const elfClass = image[4];
    const elfData = image[5];
    if (
      (elfClass !== ELF_CLASS_32 && elfClass !== ELF_CLASS_64) ||
      (elfData !== ELF_DATA_LITTLE_ENDIAN && elfData !== ELF_DATA_BIG_ENDIAN) ||
      image[6] !== ELF_VERSION_CURRENT
    ) {
      return false;
    }

    const littleEndian = elfData === ELF_DATA_LITTLE_ENDIAN;
    const is64Bit = elfClass === ELF_CLASS_64;
    const headerSize = is64Bit ? 64 : 52;
    const expectedProgramHeaderSize = is64Bit ? 56 : 32;
    const expectedArchitecture = ELF_ARCHITECTURES[process.arch];
    if (image.length < headerSize) return false;
    if (
      expectedArchitecture === undefined ||
      elfClass !== expectedArchitecture.elfClass ||
      readElfUnsigned(image, 18, 2, littleEndian) !== expectedArchitecture.machine
    ) {
      return false;
    }

    const executableType = readElfUnsigned(image, 16, 2, littleEndian);
    if (executableType !== ELF_TYPE_EXECUTABLE && executableType !== ELF_TYPE_SHARED_OBJECT) {
      return false;
    }

    const programHeaderOffset = readElfUnsigned(
      image,
      is64Bit ? 32 : 28,
      is64Bit ? 8 : 4,
      littleEndian,
    );
    const declaredHeaderSize = readElfUnsigned(image, is64Bit ? 52 : 40, 2, littleEndian);
    const programHeaderSize = readElfUnsigned(image, is64Bit ? 54 : 42, 2, littleEndian);
    const programHeaderCount = readElfUnsigned(image, is64Bit ? 56 : 44, 2, littleEndian);
    if (
      declaredHeaderSize !== headerSize ||
      programHeaderSize !== expectedProgramHeaderSize ||
      programHeaderCount === 0 ||
      programHeaderCount > ELF_MAX_PROGRAM_HEADERS ||
      programHeaderOffset < headerSize ||
      programHeaderOffset > image.length ||
      programHeaderSize * programHeaderCount > image.length - programHeaderOffset
    ) {
      return false;
    }

    let hasExecutableLoadSegment = false;
    for (let index = 0; index < programHeaderCount; index += 1) {
      const offset = programHeaderOffset + index * programHeaderSize;
      const programType = readElfUnsigned(image, offset, 4, littleEndian);
      if (programType === ELF_PROGRAM_TYPE_INTERPRETER) return false;
      if (programType !== ELF_PROGRAM_TYPE_LOAD) continue;

      const flags = readElfUnsigned(image, offset + (is64Bit ? 4 : 24), 4, littleEndian);
      const fileOffset = readElfUnsigned(
        image,
        offset + (is64Bit ? 8 : 4),
        is64Bit ? 8 : 4,
        littleEndian,
      );
      const fileSize = readElfUnsigned(
        image,
        offset + (is64Bit ? 32 : 16),
        is64Bit ? 8 : 4,
        littleEndian,
      );
      const memorySize = readElfUnsigned(
        image,
        offset + (is64Bit ? 40 : 20),
        is64Bit ? 8 : 4,
        littleEndian,
      );
      if (
        memorySize < fileSize ||
        fileOffset > image.length ||
        fileSize > image.length - fileOffset
      ) {
        return false;
      }
      if ((flags & ELF_PROGRAM_FLAG_EXECUTE) !== 0 && fileSize > 0) {
        hasExecutableLoadSegment = true;
      }
    }
    return hasExecutableLoadSegment;
  } catch {
    return false;
  }
}

function pathComponents(path: (typeof STATIC_ENVIRONMENT_DUMPER_PATHS)[number]): readonly string[] {
  return path === "/usr/bin/busybox" ? ["/", "/usr", "/usr/bin", path] : ["/", "/bin", path];
}

function isStaticEnvironmentDumperPath(
  dumperPath: string,
): dumperPath is (typeof STATIC_ENVIRONMENT_DUMPER_PATHS)[number] {
  return STATIC_ENVIRONMENT_DUMPER_PATHS.some((candidate) => candidate === dumperPath);
}

async function assertNativeEnvironmentDumperSafe(dumperPath: string): Promise<void> {
  if (!isStaticEnvironmentDumperPath(dumperPath)) throw new Error("unexpected path");
  const canonicalPath = await realpath(dumperPath);
  if (canonicalPath !== dumperPath) throw new Error("non-canonical path");

  const components = pathComponents(dumperPath);
  for (const [index, component] of components.entries()) {
    const metadata = await lstat(component);
    const isExecutable = (metadata.mode & 0o111) !== 0;
    const expectedType =
      index === components.length - 1 ? metadata.isFile() : metadata.isDirectory();
    if (
      metadata.isSymbolicLink() ||
      metadata.uid !== 0 ||
      (metadata.mode & UNSAFE_WRITE_MODE) !== 0 ||
      !expectedType ||
      (index === components.length - 1 && !isExecutable)
    ) {
      throw new Error("unsafe native environment dumper");
    }
  }

  if (!isStaticNativeElfExecutable(await readFile(dumperPath))) {
    throw new Error("native environment dumper is not a static ELF executable");
  }
}

const resolveConfiguredEnvironmentDumper: EnvironmentDumperResolver = async () => {
  for (const dumperPath of STATIC_ENVIRONMENT_DUMPER_PATHS) {
    try {
      await assertNativeEnvironmentDumperSafe(dumperPath);
      return dumperPath;
    } catch {
      // Continue to the next fixed candidate and fail closed if none are safe.
    }
  }
  throw new Error("no safe static environment dumper");
};

/**
 * Check if the specified environment tool is available
 */
export async function checkEnvTool(tool: EnvTool): Promise<ToolCheckResult> {
  switch (tool) {
    case "dotenvx":
      return commonCheckDotenvx();
    case "op":
      return commonCheckOp();
    case "none":
      return { available: true };
    default:
      return {
        available: false,
        error: `Unknown environment tool: ${tool}`,
      };
  }
}

/**
 * Build command prefix for running with environment injection
 */
export function buildEnvCommand(options: EnvToolOptions): {
  command: string;
  args: string[];
} {
  switch (options.tool) {
    case "dotenvx":
      if (options.envFile === undefined) {
        logWarn("No env file specified for dotenvx, using default .env");
      }
      return {
        command: "dotenvx",
        args: ["run", "-q", "-f", options.envFile ?? ".env", "--"],
      };

    case "op":
      if (options.envFile === undefined) {
        logWarn("No env file specified for 1Password, using default .env");
      }
      // Masking rewrites resolved values in captured stdout (e.g. `docker compose config`).
      return {
        command: "op",
        args: ["run", "--no-masking", "--env-file", options.envFile ?? ".env", "--"],
      };

    case "none":
    default:
      return {
        command: "",
        args: [],
      };
  }
}

/**
 * Execute a command with environment variable injection
 */
export async function execWithEnv(
  command: string,
  args: string[],
  options: EnvToolOptions,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}> {
  const envCommand = buildEnvCommand(options);

  // Build the full command
  let fullCommand: string;
  let fullArgs: string[];

  if (envCommand.command !== "") {
    fullCommand = envCommand.command;
    fullArgs = [...envCommand.args, command, ...args];
  } else {
    fullCommand = command;
    fullArgs = args;
  }

  logDebug(`Executing with env (${options.tool}): ${fullCommand} ${fullArgs.join(" ")}`);

  return new Promise((resolve) => {
    const proc = spawn(fullCommand, fullArgs, {
      cwd: options.cwd,
      env: options.replaceEnv ? { ...options.env } : { ...process.env, ...options.env },
      stdio: "pipe",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maxStdoutBytes = options.maxStdoutBytes ?? 4 * 1024 * 1024;
    const maxStderrBytes = options.maxStderrBytes ?? 1024 * 1024;

    const retain = (data: Buffer, chunks: Buffer[], bytes: number, limit: number): number => {
      const remaining = Math.max(0, limit - bytes);
      if (remaining > 0) chunks.push(data.subarray(0, remaining));
      if (data.length > remaining) {
        overflow = true;
        proc.kill("SIGTERM");
      }
      return bytes + Math.min(data.length, remaining);
    };

    const finish = (code: number, processError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        code: overflow || timedOut || processError !== undefined ? 1 : code,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString(),
        stderr: overflow
          ? "Command output exceeded capture limit"
          : timedOut
            ? "Command timed out"
            : (processError?.message ?? Buffer.concat(stderrChunks, stderrBytes).toString()),
        success: !overflow && !timedOut && processError === undefined && code === 0,
      });
    };

    proc.stdout?.on("data", (data: Buffer) => {
      stdoutBytes = retain(data, stdoutChunks, stdoutBytes, maxStdoutBytes);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderrBytes = retain(data, stderrChunks, stderrBytes, maxStderrBytes);
    });

    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, options.timeout ?? 300000);

    proc.on("close", (code) => {
      finish(code ?? 1);
    });

    proc.on("error", (error) => {
      finish(1, error);
    });
  });
}

/** Capture and validate one effective environment without serializing it into plan evidence. */
export async function captureEffectiveEnvironment(
  options: Pick<EnvToolOptions, "tool" | "envFile" | "cwd" | "env" | "replaceEnv">,
  resolveDumper: EnvironmentDumperResolver = resolveConfiguredEnvironmentDumper,
): Promise<Record<string, string>> {
  let dumperPath: string;
  try {
    dumperPath = await resolveDumper();
    await assertNativeEnvironmentDumperSafe(dumperPath);
  } catch {
    throw new Error("Native environment dumper is unavailable or unsafe");
  }

  const result = await execWithEnv(dumperPath, ["env", "-0"], {
    ...options,
    timeout: 10_000,
    maxStdoutBytes: EFFECTIVE_ENVIRONMENT_MAX_OUTPUT_BYTES,
    maxStderrBytes: 64 * 1024,
  });
  if (!result.success) throw new Error("Unable to capture the effective execution environment");

  if (result.stdout !== "" && !result.stdout.endsWith("\0")) {
    throw new Error("Effective execution environment capture was invalid");
  }
  const entries = result.stdout === "" ? [] : result.stdout.slice(0, -1).split("\0");
  if (entries.length > EFFECTIVE_ENVIRONMENT_MAX_ENTRIES) {
    throw new Error("Effective execution environment capture exceeded safety limits");
  }
  const validatedEntries: Array<[string, string]> = [];
  const keys = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = separator > 0 ? entry.slice(0, separator) : "";
    const value = separator > 0 ? entry.slice(separator + 1) : "";
    if (
      key === "" ||
      key.includes("\0") ||
      Buffer.byteLength(key, "utf8") > EFFECTIVE_ENVIRONMENT_MAX_KEY_BYTES ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > EFFECTIVE_ENVIRONMENT_MAX_VALUE_BYTES ||
      keys.has(key)
    ) {
      throw new Error("Effective execution environment capture was invalid");
    }
    keys.add(key);
    validatedEntries.push([key, value]);
  }
  return Object.fromEntries(validatedEntries);
}

/**
 * Auto-detect which environment tool to use based on available tools and files
 */
export async function autoDetectEnvTool(envFile: string): Promise<EnvTool> {
  // Check if env file exists
  const fileExists = await commonEnvFileExists(envFile);

  if (!fileExists) {
    logDebug(`Env file not found: ${envFile}, using 'none'`);
    return "none";
  }

  // Prefer dotenvx if available
  const dotenvxCheck = await commonCheckDotenvx();
  if (dotenvxCheck.available) {
    logDebug("Using dotenvx for environment injection");
    return "dotenvx";
  }

  // Fall back to op if available
  const opCheck = await commonCheckOp();
  if (opCheck.available) {
    logDebug("Using 1Password CLI for environment injection");
    return "op";
  }

  // No tools available
  logWarn("No environment injection tool found, secrets may not be available");
  return "none";
}

/**
 * Validate environment tool configuration
 */
export async function validateEnvToolConfig(
  tool: EnvTool,
  envFile?: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Check tool availability
  const toolCheck = await checkEnvTool(tool);
  if (!toolCheck.available) {
    errors.push(toolCheck.error ?? `Tool ${tool} is not available`);
  }

  // Check env file if tool requires it
  if (tool !== "none" && envFile !== undefined) {
    const fileExists = await commonEnvFileExists(envFile);
    if (!fileExists) {
      errors.push(`Environment file not found: ${envFile}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
