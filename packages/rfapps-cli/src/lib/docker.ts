/**
 * Docker command execution utilities for rfapps CLI
 *
 * Provides wrappers for Docker and Docker Compose commands with:
 * - SSH retry logic for remote contexts
 * - Consistent error handling
 * - Output parsing
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDebug, logError, logWarn } from "@rfmedia/common";

import type { EnvToolExecConfig } from "../types/options.js";
import type {
  RuntimeContainerProjection,
  RuntimeNetworkProjection,
  RuntimeVolumeProjection,
} from "../types/validation.js";
import {
  type CanonicalComposeConfig,
  type CanonicalComposeConfigEvidence,
  type ConflictEvidenceAdapterDependencies,
  type ConflictEvidenceOptions,
  readCanonicalComposeConfig,
  readCanonicalComposeConfigEvidence,
  readConflictRuntimeContainers,
  readConflictRuntimeNetworks,
  readConflictRuntimeVolumes,
} from "./docker-conflict-evidence.js";
import { buildEnvCommand } from "./env-tools.js";

export { DockerEvidenceError } from "./docker-conflict-evidence.js";
export type {
  CanonicalComposeConfig,
  CanonicalComposeConfigEvidence,
  CanonicalComposeMountConfig,
  CanonicalComposeNetworkConfig,
  CanonicalComposeNetworkIpamConfig,
  CanonicalComposePortConfig,
  CanonicalComposeServiceConfig,
  CanonicalComposeVolumeConfig,
  ConflictEvidenceOptions,
} from "./docker-conflict-evidence.js";

/**
 * Options for Docker command execution
 */
export interface DockerExecOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Replace, rather than extend, the parent environment. */
  replaceEnv?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to capture output */
  captureOutput?: boolean;
  /** Whether to stream output to console */
  streamOutput?: boolean;
  /** Maximum stdout bytes retained for a non-streaming command */
  maxStdoutBytes?: number;
  /** Maximum stderr bytes retained for a non-streaming command */
  maxStderrBytes?: number;
  /** Max retries for SSH failures */
  maxRetries?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
  /** Env tool configuration for secrets injection */
  envTool?: EnvToolExecConfig;
}

/** Options shared by Docker Compose operations bound to one effective project. */
export interface DockerComposeExecOptions extends DockerExecOptions {
  /** Docker Compose profiles to activate. */
  profiles?: string[];
  /** Explicit Compose project name. */
  projectName?: string;
  /** Canonical plain Compose environment file. */
  envFile?: string;
}

/**
 * Result of Docker command execution
 */
export interface DockerExecResult {
  /** Exit code */
  code: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Whether command succeeded (code 0) */
  success: boolean;
}

/**
 * Default options for Docker commands
 */
const DEFAULT_OPTIONS: Omit<Required<DockerExecOptions>, "envTool"> & {
  envTool?: EnvToolExecConfig;
} = {
  cwd: process.cwd(),
  env: {},
  replaceEnv: false,
  timeout: 300000, // 5 minutes
  captureOutput: true,
  streamOutput: false,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  maxRetries: 3,
  retryDelay: 2000,
  envTool: undefined,
};

const TERMINATION_GRACE_MS = 100;
const FINAL_SETTLEMENT_GRACE_MS = 100;
type ForwardedParentSignal = "SIGINT" | "SIGTERM";
const activeDetachedGroups = new Map<number, (signal: ForwardedParentSignal) => void>();
let forwardedParentSignal: ForwardedParentSignal | undefined;
let parentSignalHandlersInstalled = false;

function forwardParentSignal(signal: ForwardedParentSignal): void {
  if (forwardedParentSignal !== undefined) return;
  forwardedParentSignal = signal;
  for (const terminateGroup of activeDetachedGroups.values()) {
    terminateGroup(signal);
  }
}

const handleParentSigint = (): void => {
  forwardParentSignal("SIGINT");
};
const handleParentSigterm = (): void => {
  forwardParentSignal("SIGTERM");
};

function installParentSignalForwarding(): void {
  if (parentSignalHandlersInstalled) return;
  parentSignalHandlersInstalled = true;
  process.on("SIGINT", handleParentSigint);
  process.on("SIGTERM", handleParentSigterm);
}

function uninstallParentSignalForwarding(): void {
  if (!parentSignalHandlersInstalled) return;
  parentSignalHandlersInstalled = false;
  process.removeListener("SIGINT", handleParentSigint);
  process.removeListener("SIGTERM", handleParentSigterm);
}

function registerDetachedGroup(
  pid: number | undefined,
  terminateGroup: (signal: ForwardedParentSignal) => void,
): () => void {
  if (process.platform === "win32" || pid === undefined) return () => undefined;
  activeDetachedGroups.set(pid, terminateGroup);
  installParentSignalForwarding();
  if (forwardedParentSignal !== undefined) {
    terminateGroup(forwardedParentSignal);
  }
  return () => {
    activeDetachedGroups.delete(pid);
    if (activeDetachedGroups.size !== 0) return;
    uninstallParentSignalForwarding();
    const signal = forwardedParentSignal;
    forwardedParentSignal = undefined;
    if (signal !== undefined) {
      queueMicrotask(() => {
        process.kill(process.pid, signal);
      });
    }
  };
}

function normalizeCaptureLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

/**
 * Check if an error indicates an SSH connection issue
 */
function isSSHError(stderr: string): boolean {
  const sshErrorPatterns = [
    "connection reset by peer",
    "connection refused",
    "connection timed out",
    "connection closed",
    "exit status 255",
    "ssh_exchange_identification",
    "broken pipe",
    "socket is not connected",
    "no route to host",
    "network is unreachable",
  ];

  const lowerStderr = stderr.toLowerCase();
  return sshErrorPatterns.some((pattern) => lowerStderr.includes(pattern));
}

/**
 * Sleep for the specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Filter out tool output lines from command stdout
 *
 * Tools like dotenvx and 1Password CLI may inject informational messages
 * into stdout that need to be filtered before parsing actual output.
 */
export function filterToolOutput(lines: string[]): string[] {
  return lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;

    // Filter dotenvx output (e.g., "[dotenvx@1.51.3] injecting env (3) from .env.local")
    if (trimmed.startsWith("[dotenvx")) return false;

    // Filter Node.js warnings (e.g., "(node:12345) Warning: ...")
    if (trimmed.startsWith("(node:")) return false;

    // Filter common logging prefixes that tools might emit
    if (trimmed.startsWith("[INFO]")) return false;
    if (trimmed.startsWith("[WARN]")) return false;
    if (trimmed.startsWith("[ERROR]")) return false;
    if (trimmed.startsWith("[DEBUG]")) return false;

    // Filter 1Password CLI output
    if (trimmed.startsWith("[op]")) return false;

    return true;
  });
}

/**
 * Execute a command and return the result
 */
async function execCommand(
  command: string,
  args: string[],
  options: Omit<Required<DockerExecOptions>, "envTool"> & { envTool?: EnvToolExecConfig },
): Promise<DockerExecResult> {
  return new Promise((resolve) => {
    const fullEnv = options.replaceEnv ? { ...options.env } : { ...process.env, ...options.env };

    // Wrap with env tool if configured
    let finalCommand = command;
    let finalArgs = args;

    if (options.envTool !== undefined && options.envTool.tool !== "none") {
      const envWrapper = buildEnvCommand({
        tool: options.envTool.tool,
        envFile: options.envTool.envFile,
      });
      finalCommand = envWrapper.command;
      finalArgs = [...envWrapper.args, command, ...args];
      logDebug(`Wrapping with ${options.envTool.tool}: ${finalCommand} ${finalArgs.join(" ")}`);
    } else {
      logDebug(`Executing: ${command} ${args.join(" ")}`);
    }

    const proc = spawn(finalCommand, finalArgs, {
      cwd: options.cwd,
      env: fullEnv,
      stdio: options.streamOutput ? "inherit" : "pipe",
      detached: process.platform !== "win32",
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowStream: "stdout" | "stderr" | undefined;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationStarted = false;
    let unregisterDetachedGroup = (): void => undefined;

    const signalProcess = (signal: NodeJS.Signals): void => {
      if (process.platform !== "win32" && proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          // The child may have exited between the bound firing and group cleanup.
        }
      }
      try {
        proc.kill(signal);
      } catch {
        // Final settlement remains bounded even when signaling races child exit.
      }
    };

    const forceKill = (): void => {
      if (settled) return;
      signalProcess("SIGKILL");
      if (settled) return;
      settlementTimer = setTimeout(() => {
        finish(1);
      }, FINAL_SETTLEMENT_GRACE_MS);
    };

    const terminate = (signal: NodeJS.Signals = "SIGTERM"): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      signalProcess(signal);
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        if (signal !== "SIGTERM") {
          signalProcess("SIGTERM");
          if (settled) return;
          killTimer = setTimeout(forceKill, TERMINATION_GRACE_MS);
          return;
        }
        forceKill();
      }, TERMINATION_GRACE_MS);
    };

    unregisterDetachedGroup = registerDetachedGroup(proc.pid, (signal) => {
      terminate(signal);
    });

    const retainChunk = (
      data: Buffer,
      chunks: Buffer[],
      retainedBytes: number,
      limit: number,
      stream: "stdout" | "stderr",
    ): number => {
      if (!options.captureOutput) return retainedBytes;
      const remaining = Math.max(0, limit - retainedBytes);
      if (remaining > 0) chunks.push(data.subarray(0, remaining));
      const nextBytes = retainedBytes + Math.min(data.length, remaining);
      if (data.length > remaining && overflowStream === undefined) {
        overflowStream = stream;
        terminate();
      }
      return nextBytes;
    };

    const capturedStdout = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString();
    const capturedStderr = (): string => Buffer.concat(stderrChunks, stderrBytes).toString();
    const failureMessage = (): string | undefined => {
      if (overflowStream !== undefined) {
        const limit = overflowStream === "stdout" ? options.maxStdoutBytes : options.maxStderrBytes;
        return `Command ${overflowStream} exceeded capture limit of ${limit} bytes`;
      }
      return timedOut ? "Command timed out" : undefined;
    };

    const finish = (code: number, processError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      unregisterDetachedGroup();
      const boundedFailure = failureMessage();
      const finalCode = boundedFailure === undefined && processError === undefined ? code : 1;
      resolve({
        code: finalCode,
        stdout: capturedStdout(),
        stderr:
          boundedFailure ?? (processError === undefined ? capturedStderr() : processError.message),
        success: finalCode === 0,
      });
    };

    if (!options.streamOutput && proc.stdout) {
      proc.stdout.on("data", (value: Buffer | string) => {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        stdoutBytes = retainChunk(
          data,
          stdoutChunks,
          stdoutBytes,
          options.maxStdoutBytes,
          "stdout",
        );
      });
    }

    if (!options.streamOutput && proc.stderr) {
      proc.stderr.on("data", (value: Buffer | string) => {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        stderrBytes = retainChunk(
          data,
          stderrChunks,
          stderrBytes,
          options.maxStderrBytes,
          "stderr",
        );
      });
    }

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout);

    proc.on("close", (code) => {
      finish(code ?? 1);
    });

    proc.on("error", (error) => {
      finish(1, error);
    });
  });
}

/**
 * Execute a Docker command with retry logic for SSH failures.
 *
 * When using remote Docker contexts over SSH, network issues can cause
 * transient failures. This function automatically retries on SSH-related
 * errors with configurable retry count and delay.
 *
 * SSH errors that trigger retry:
 * - Connection reset/refused/timed out
 * - Broken pipe
 * - Socket not connected
 * - Network unreachable
 *
 * @param args - Docker command arguments (e.g., ['ps', '--format', 'json'])
 * @param options - Execution options (timeout, retry settings, etc.)
 * @returns Command execution result with stdout, stderr, and exit code
 *
 * @example
 * ```typescript
 * // List containers
 * const result = await execDocker(['ps', '-a']);
 *
 * // Inspect a container with env tool wrapper
 * const result = await execDocker(['inspect', 'traefik'], {
 *   envTool: { tool: 'dotenvx', envFile: '.env.local' }
 * });
 * ```
 */
export async function execDocker(
  args: string[],
  options: DockerExecOptions = {},
): Promise<DockerExecResult> {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    maxStdoutBytes: normalizeCaptureLimit(options.maxStdoutBytes, DEFAULT_OPTIONS.maxStdoutBytes),
    maxStderrBytes: normalizeCaptureLimit(options.maxStderrBytes, DEFAULT_OPTIONS.maxStderrBytes),
  };

  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    const result = await execCommand("docker", args, opts);

    if (result.success) {
      return result;
    }

    // Check if this is an SSH error that might be retried
    if (isSSHError(result.stderr) && attempt < opts.maxRetries) {
      logDebug(`SSH error detected, retrying (attempt ${attempt + 1}/${opts.maxRetries})...`);
      await sleep(opts.retryDelay);
      continue;
    }

    return result;
  }

  // Should not reach here, but return failure just in case
  return {
    code: 1,
    stdout: "",
    stderr: "Max retries exceeded",
    success: false,
  };
}

/**
 * Execute a Docker Compose command.
 *
 * Wrapper around execDocker that automatically prepends 'compose' to args.
 * Inherits SSH retry logic and all execution options from execDocker.
 *
 * @param args - Docker Compose arguments (e.g., ['-f', 'compose.yml', 'up', '-d'])
 * @param options - Execution options (timeout, retry settings, env tool, etc.)
 * @returns Command execution result
 */
export async function execDockerCompose(
  args: string[],
  options: DockerExecOptions = {},
): Promise<DockerExecResult> {
  return execDocker(["compose", ...args], options);
}

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  const result = await execDocker(["version", "--format", "{{.Server.Version}}"], {
    timeout: 10000,
  });
  return result.success;
}

/**
 * Get Docker Compose version
 */
export async function getDockerComposeVersion(): Promise<string | undefined> {
  const result = await execDockerCompose(["version", "--short"], {
    timeout: 10000,
  });
  return result.success ? result.stdout.trim() : undefined;
}

export type ComposeCapability =
  | {
      readonly status: "supported";
      readonly version: string;
      readonly digestResolution: "resolve-image-digests";
      readonly wait: "wait-with-timeout";
    }
  | {
      readonly status: "unsupported";
      readonly version?: string;
      readonly missing: readonly string[];
      readonly message: string;
    };

const composeCapabilityCache = new Map<string, Promise<ComposeCapability>>();

/** Clear the capability cache. Intended for tests and Docker-context changes. */
export function clearComposeCapabilityCache(): void {
  composeCapabilityCache.clear();
}

/** Probe version-variable Compose features required by the managed lifecycle. */
export function probeComposeCapabilities(
  options: DockerExecOptions = {},
): Promise<ComposeCapability> {
  const cacheKey = JSON.stringify({
    cwd: options.cwd ?? process.cwd(),
    envTool: options.envTool,
  });
  const cached = composeCapabilityCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const probe = (async (): Promise<ComposeCapability> => {
    const commandOptions = {
      ...options,
      timeout: Math.min(options.timeout ?? 10000, 10000),
      captureOutput: true,
      streamOutput: false,
    };
    const [versionResult, upHelp, configHelp] = await Promise.all([
      execDockerCompose(["version", "--short"], commandOptions),
      execDockerCompose(["up", "--help"], commandOptions),
      execDockerCompose(["config", "--help"], commandOptions),
    ]);
    const version = versionResult.success ? versionResult.stdout.trim() : undefined;
    const upText = `${upHelp.stdout}\n${upHelp.stderr}`;
    const configText = `${configHelp.stdout}\n${configHelp.stderr}`;
    const missing: string[] = [];
    if (!configHelp.success || !configText.includes("--resolve-image-digests")) {
      missing.push("config --resolve-image-digests");
    }
    if (!upHelp.success || !/(^|\s)--wait(?:\s|,|$)/m.test(upText)) {
      missing.push("up --wait");
    }
    if (!upHelp.success || !upText.includes("--wait-timeout")) {
      missing.push("up --wait-timeout");
    }

    if (missing.length > 0 || version === undefined || version === "") {
      return {
        status: "unsupported",
        ...(version === undefined || version === "" ? {} : { version }),
        missing,
        message:
          "Managed updates require Docker Compose support for config --resolve-image-digests, up --wait, and up --wait-timeout.",
      };
    }
    return {
      status: "supported",
      version,
      digestResolution: "resolve-image-digests",
      wait: "wait-with-timeout",
    };
  })();

  composeCapabilityCache.set(cacheKey, probe);
  return probe;
}

/**
 * List running containers
 *
 * @param all - Include stopped containers
 * @param format - Output format (default: 'json')
 * @param options - Execution options including timeout
 */
export async function listContainers(
  all: boolean = false,
  format: string = "json",
  options: DockerExecOptions = {},
): Promise<DockerExecResult> {
  const args = ["ps", "--format", format];
  if (all) {
    args.splice(1, 0, "-a");
  }
  return execDocker(args, options);
}

/**
 * Get container stats
 */
export async function getContainerStats(
  containers?: string[],
  noStream: boolean = true,
): Promise<DockerExecResult> {
  const args = ["stats", "--format", "json"];
  if (noStream) {
    args.push("--no-stream");
  }
  if (containers !== undefined && containers.length > 0) {
    args.push(...containers);
  }
  return execDocker(args);
}

/**
 * Pull images for services
 */
export async function pullImages(
  composePath: string,
  services?: string[],
  options: DockerComposeExecOptions = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  // Add profile flags
  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("pull");

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Build containers for services
 */
export async function buildImages(
  composePath: string,
  services?: string[],
  options: DockerComposeExecOptions = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  // Add profile flags
  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("build");

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Start services
 */
export async function startServices(
  composePath: string,
  services?: string[],
  options: DockerComposeExecOptions & {
    forceRecreate?: boolean;
    noPull?: boolean;
  } = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  // Add profile flags
  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("up", "-d", "--remove-orphans");

  // Skip pulling if images were already pulled
  if (options.noPull === true) {
    args.push("--pull", "never");
  }

  // Add force-recreate flag if requested
  if (options.forceRecreate === true) {
    args.push("--force-recreate");
  }

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Stop services
 */
export async function stopServices(
  composePath: string,
  services?: string[],
  options: DockerComposeExecOptions = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  // Add profile flags
  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("stop");

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Stop and remove services
 */
export async function downServices(
  composePath: string,
  options: DockerExecOptions & {
    services?: string[];
    volumes?: boolean;
    removeOrphans?: boolean;
  } = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath, "down"];

  if (options.volumes) {
    args.push("-v");
  }

  if (options.removeOrphans !== false) {
    args.push("--remove-orphans");
  }

  // Note: docker compose down doesn't support service names directly
  // You need to stop services first, then run down

  return execDockerCompose(args, options);
}

/**
 * Remove stopped containers for services
 */
export async function removeServices(
  composePath: string,
  services?: string[],
  options: DockerExecOptions & { profiles?: string[]; force?: boolean } = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("rm");

  if (options.force !== false) {
    args.push("-f"); // Force removal (no prompt)
  }

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Prune unused Docker images
 */
export async function pruneImages(
  options: DockerExecOptions & { all?: boolean } = {},
): Promise<DockerExecResult> {
  const args = ["image", "prune", "-f"];

  if (options.all) {
    args.push("--all");
  }

  return execDocker(args, options);
}

/**
 * Get service logs
 */
export async function getLogs(
  composePath: string,
  services?: string[],
  options: DockerExecOptions & {
    tail?: number;
    follow?: boolean;
    timestamps?: boolean;
  } = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath, "logs"];

  if (options.tail !== undefined) {
    args.push("--tail", options.tail.toString());
  }

  if (options.follow) {
    args.push("-f");
  }

  if (options.timestamps) {
    args.push("-t");
  }

  if (services !== undefined && services.length > 0) {
    args.push(...services);
  }

  return execDockerCompose(args, options);
}

/**
 * Validate compose file
 */
export async function validateComposeFile(
  composePath: string,
  options: DockerExecOptions & { profiles?: string[] } = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("config", "--quiet");

  return execDockerCompose(args, options);
}

/**
 * Get list of services from compose file
 */
export async function getComposeServices(
  composePath: string,
  options: DockerExecOptions & {
    profiles?: string[];
    projectName?: string;
    envFile?: string;
  } = {},
): Promise<string[]> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("config", "--services");

  const result = await execDockerCompose(args, options);

  if (!result.success) {
    logError(`Failed to get compose services: ${result.stderr}`);
    return [];
  }

  return filterToolOutput(result.stdout.split("\n"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Get list of running containers from compose project
 */
export async function getRunningContainers(
  composePath: string,
  options: DockerComposeExecOptions = {},
): Promise<DockerExecResult> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("ps", "--status", "running", "--format", "{{.Name}}");

  return execDockerCompose(args, options);
}

/**
 * Service to container mapping entry
 */
export interface ServiceContainerEntry {
  /** Compose service name */
  serviceName: string;
  /** Actual Docker container name */
  containerName: string;
}

/**
 * Get mapping of service names to container names for running containers
 *
 * This is more reliable than using container names directly because:
 * 1. Container names can have prefixes added by Docker on conflicts
 * 2. Service names are stable and match the compose config
 *
 * @returns Map from service name to container name, or undefined on error
 */
export async function getRunningServiceContainerMap(
  composePath: string,
  options: DockerExecOptions & {
    profiles?: string[];
    projectName?: string;
    envFile?: string;
  } = {},
): Promise<Map<string, string> | undefined> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  // Use tab-separated format for reliable parsing: service\tcontainer
  args.push("ps", "--status", "running", "--format", "{{.Service}}\t{{.Name}}");

  const result = await execDockerCompose(args, {
    ...options,
    captureOutput: true,
    streamOutput: false,
  });

  if (!result.success) {
    logDebug(`Failed to get running service/container map: ${result.stderr}`);
    return undefined;
  }

  const serviceMap = new Map<string, string>();

  // Parse output, filtering tool messages
  const lines = result.stdout.split("\n");
  const filteredLines = filterToolOutput(lines);

  for (const line of filteredLines) {
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const serviceName = parts[0]?.trim();
      const containerName = parts[1]?.trim();
      if (
        serviceName !== undefined &&
        containerName !== undefined &&
        serviceName.length > 0 &&
        containerName.length > 0
      ) {
        serviceMap.set(serviceName, containerName);
      }
    }
  }

  logDebug(`Found ${serviceMap.size} running services`);
  return serviceMap;
}

/**
 * Compose service configuration from docker compose config
 */
export interface ComposeServiceConfig {
  /** Service name */
  name: string;
  /** Image name (e.g., "nginx:latest") */
  image?: string;
  /** Direct dependencies from depends_on */
  depends_on?: string[] | Record<string, unknown>;
  /** Port bindings from compose config */
  ports?: string[];
  /** Exposed container ports from compose config */
  expose?: string[];
  /** Network mode (e.g., "bridge", "host", "service:sidecar") */
  network_mode?: string;
  /** Build context (if using build instead of image) */
  build?: {
    context?: string;
    dockerfile?: string;
  };
}

/** Parsed top-level Docker Compose configuration. */
export interface ComposeConfig {
  /** Effective Compose project name selected by Compose precedence rules. */
  name?: string;
  services: Record<string, ComposeServiceConfig>;
}

/**
 * Get parsed compose configuration as JSON
 */
export async function getComposeConfig(
  composePath: string,
  options: DockerExecOptions & { profiles?: string[]; envFile?: string; projectName?: string } = {},
): Promise<ComposeConfig | undefined> {
  const args = ["-f", composePath];

  if (options.projectName !== undefined) {
    args.push("--project-name", options.projectName);
  }

  if (options.envFile !== undefined && options.envFile.trim() !== "") {
    args.push("--env-file", options.envFile);
  }

  if (options.profiles !== undefined) {
    for (const profile of options.profiles) {
      args.push("--profile", profile);
    }
  }

  args.push("config", "--format", "json");

  // Force captureOutput and disable streaming for JSON parsing
  const result = await execDockerCompose(args, {
    ...options,
    captureOutput: true,
    streamOutput: false,
  });

  if (!result.success) {
    logError(`Failed to get compose config: ${result.stderr}`);
    return undefined;
  }

  try {
    // Try to extract JSON from output (in case secrets tool adds extra output)
    let jsonStr = result.stdout.trim();

    // If output doesn't start with {, try to find the JSON part
    if (!jsonStr.startsWith("{")) {
      const jsonStart = jsonStr.indexOf("{");
      if (jsonStart > 0) {
        jsonStr = jsonStr.substring(jsonStart);
        logDebug("Extracted JSON from wrapped output");
      }
    }

    return JSON.parse(jsonStr) as ComposeConfig;
  } catch (error) {
    logError(
      `Failed to parse compose config: ${error instanceof Error ? error.message : String(error)}`,
    );
    logDebug(`Output was: ${result.stdout.substring(0, 200)}...`);
    return undefined;
  }
}

/**
 * Extract direct dependency service names from a compose service definition.
 */
export function getComposeServiceDependencies(service?: ComposeServiceConfig): string[] {
  if (service === undefined || service.depends_on === undefined) {
    return [];
  }

  if (Array.isArray(service.depends_on)) {
    return service.depends_on.filter((name): name is string => typeof name === "string");
  }

  return Object.keys(service.depends_on);
}

/**
 * Remove a Docker image by name or ID
 */
export async function removeImage(
  image: string,
  options: DockerExecOptions & { force?: boolean } = {},
): Promise<DockerExecResult> {
  const args = ["image", "rm"];

  if (options.force) {
    args.push("-f");
  }

  args.push(image);

  return execDocker(args, options);
}

/**
 * Prune Docker volumes
 */
export async function pruneVolumes(
  options: DockerExecOptions & { all?: boolean } = {},
): Promise<DockerExecResult> {
  const args = ["volume", "prune", "-f"];

  if (options.all) {
    args.push("--all");
  }

  return execDocker(args, options);
}

/**
 * Parse Docker container IDs from command output
 *
 * Filters out noise from environment tools (dotenvx banners, etc.)
 * Docker container IDs are 12 or 64 character hexadecimal strings.
 */
function parseContainerIds(output: string): string[] {
  // Docker container IDs are hex strings (12 chars short form, 64 chars full)
  const containerIdRegex = /^[a-f0-9]{12,64}$/i;

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => containerIdRegex.test(line));
}

/**
 * Check if an image is in use by any running container
 *
 * Includes retry logic for transient Docker daemon failures.
 * After retries exhausted, returns false to allow removal attempt
 * since Phase 2 already removed containers and removeImage uses force flag.
 */
export async function isImageInUse(
  image: string,
  options: DockerExecOptions = {},
): Promise<boolean> {
  const args = ["ps", "-q", "--filter", `ancestor=${image}`];
  const maxRetries = 3;
  const retryDelayMs = 200;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await execDocker(args, options);

    if (result.success) {
      // Parse actual container IDs, filtering out env tool banners (e.g., dotenvx)
      const containerIds = parseContainerIds(result.stdout);
      const hasContainers = containerIds.length > 0;
      logDebug(
        `Image ${image} in use check: ${hasContainers ? `yes (${containerIds.length} container(s))` : "no"}`,
      );
      return hasContainers;
    }

    logDebug(
      `Attempt ${attempt}/${maxRetries} failed to check image usage for ${image}: ${result.stderr}`,
    );

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  // After retries exhausted, log warning and return false
  // Rationale: Phase 2 already removed containers, and removeImage uses force flag
  logWarn(`Could not verify image usage for ${image}, proceeding with removal attempt`);
  return false;
}

/**
 * Get image info by name (to check if it exists)
 */
export async function imageExists(
  image: string,
  options: DockerExecOptions = {},
): Promise<boolean> {
  const args = ["image", "inspect", image, "--format", "{{.Id}}"];

  const result = await execDocker(args, options);
  return result.success;
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const SAFE_COMPOSE_OPERAND = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const COMPOSE_OBSERVATION_MAX_OUTPUT_BYTES = 1024 * 1024;
const COMPOSE_OBSERVATION_MAX_ITEMS = 4096;
const COMPOSE_OBSERVATION_MAX_FIELD_BYTES = 1024;
const RECONCILE_ACTION_MAX_OUTPUT_BYTES = 256 * 1024;
const IMAGE_ENVIRONMENT_MAX_OUTPUT_BYTES = 1024 * 1024;
const IMAGE_ENVIRONMENT_BATCH_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const IMAGE_ENVIRONMENT_BATCH_MAX_IMAGES = 256;
const IMAGE_ENVIRONMENT_MAX_ITEMS = 4096;
const IMAGE_ENVIRONMENT_MAX_ENTRY_BYTES = 64 * 1024;

export type DockerIdentityErrorCode =
  | "IMAGE_INSPECTION_FAILED"
  | "IMAGE_INSPECTION_INVALID"
  | "IMAGE_IDENTITY_MISMATCH"
  | "INVALID_IMAGE_IDENTITY"
  | "UNSAFE_SERVICE_NAME"
  | "UNSAFE_PROJECT_NAME"
  | "UNSAFE_PROFILE_NAME"
  | "UNSAFE_COMPOSE_PATH"
  | "UNSAFE_ENV_FILE"
  | "COMPOSE_OBSERVATION_FAILED"
  | "COMPOSE_OBSERVATION_INVALID"
  | "COMPOSE_OBSERVATION_TOO_LARGE"
  | "UNSAFE_RECONCILE_ACTION"
  | "IMAGE_PULL_FAILED";

export class DockerIdentityError extends Error {
  override readonly name = "DockerIdentityError";

  constructor(
    message: string,
    readonly code: DockerIdentityErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * One exact container entry returned by `docker compose ps --all`.
 *
 * The observer intentionally returns a flat array rather than a service map so
 * callers can classify zero, one, or multiple instances without losing
 * evidence through key overwrites.
 */
export interface ComposeContainerObservation {
  readonly containerId: string;
  readonly containerName: string;
  readonly serviceName: string;
  readonly state: string;
  readonly health: string;
}

export interface ComposeContainerObservationOptions extends DockerExecOptions {
  /** Explicit effective Compose project name. */
  readonly projectName?: string;
  /** Canonical plain Compose environment file used for interpolation. */
  readonly envFile?: string;
  /** Effective Compose profiles. Arguments are de-duplicated and sorted. */
  readonly profiles?: readonly string[];
}

/** The only Compose mutations authorized by the reconciliation coordinator. */
export type ReconcileServiceAction = "create" | "start" | "recreate";

/** Reviewed, explicit authority for one reconciliation mutation. */
export interface ReconcileServiceInput {
  /** Canonicalized and validated before the command is executed. */
  readonly composePath: string;
  /** Effective Compose project name bound to the reviewed reconciliation. */
  readonly projectName: string;
  /** Exactly one reviewed Compose service. */
  readonly service: string;
  /** Effective Compose profiles. Arguments are de-duplicated and sorted. */
  readonly profiles?: readonly string[];
  /** Optional reviewed plain Compose environment file. */
  readonly envFile?: string;
  /** Complete resolved Compose model captured and fingerprinted under the lifecycle lock. */
  readonly resolvedComposeJson?: string;
  /** Original canonical project directory used to preserve Compose path semantics. */
  readonly projectDirectory?: string;
  /** Expected hash of the resolved model; consumed by the production mutation boundary. */
  readonly expectedResolvedComposeFingerprint?: string;
  readonly action: ReconcileServiceAction;
}

export interface ReconcileServiceDependencies {
  removeTemporaryDirectory(path: string): Promise<void>;
}

const DEFAULT_RECONCILE_SERVICE_DEPENDENCIES: ReconcileServiceDependencies = {
  removeTemporaryDirectory(path) {
    return rm(path, { recursive: true, force: true });
  },
};

async function safeProjectDirectoryPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
    throw new DockerIdentityError("Project directory is not safe", "UNSAFE_COMPOSE_PATH");
  }
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new DockerIdentityError("Project directory is not safe", "UNSAFE_COMPOSE_PATH", {
      cause: error,
    });
  }
}

async function createPrivateResolvedComposeSnapshot(resolvedComposeJson: string): Promise<{
  directory: string;
  composePath: string;
}> {
  if (
    typeof resolvedComposeJson !== "string" ||
    resolvedComposeJson === "" ||
    Buffer.byteLength(resolvedComposeJson, "utf8") > DEFAULT_OPTIONS.maxStdoutBytes
  ) {
    throw new DockerIdentityError("Resolved Compose authority is invalid", "UNSAFE_COMPOSE_PATH");
  }
  try {
    const parsed = JSON.parse(resolvedComposeJson) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a Compose object");
    }
  } catch (error) {
    throw new DockerIdentityError("Resolved Compose authority is invalid", "UNSAFE_COMPOSE_PATH", {
      cause: error,
    });
  }

  const directory = await mkdtemp(join(tmpdir(), "rfapps-reconcile-"));
  const composePath = join(directory, "compose.json");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await chmod(directory, 0o700);
    handle = await open(
      composePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(resolvedComposeJson, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(composePath, 0o600);
    return { directory, composePath };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new DockerIdentityError(
      "Unable to create private resolved Compose authority",
      "UNSAFE_COMPOSE_PATH",
      { cause: error },
    );
  }
}

interface ComposePsObservationPayload {
  readonly ID?: unknown;
  readonly Name?: unknown;
  readonly Service?: unknown;
  readonly State?: unknown;
  readonly Health?: unknown;
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isBoundedObservationString(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= COMPOSE_OBSERVATION_MAX_FIELD_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function parseComposeObservationPayload(output: string): unknown[] {
  const filtered = filterToolOutput(output.split("\n"));
  if (filtered.length === 0) return [];
  const payload = filtered.join("\n");

  try {
    const parsed = JSON.parse(payload) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const items: unknown[] = [];
    for (const line of filtered) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (Array.isArray(parsed)) {
          throw new Error("Nested arrays are not JSON-Lines entries");
        }
        items.push(parsed);
      } catch {
        throw new DockerIdentityError(
          "Docker Compose returned invalid container observation data",
          "COMPOSE_OBSERVATION_INVALID",
        );
      }
    }
    return items;
  }
}

function normalizeComposeObservationItem(value: unknown): ComposeContainerObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DockerIdentityError(
      "Docker Compose returned invalid container observation data",
      "COMPOSE_OBSERVATION_INVALID",
    );
  }
  const item = value as ComposePsObservationPayload;
  if (
    !isBoundedObservationString(item.ID) ||
    !/^[a-f0-9]{12,64}$/i.test(item.ID) ||
    !isBoundedObservationString(item.Name) ||
    !SAFE_COMPOSE_OPERAND.test(item.Name) ||
    !isBoundedObservationString(item.Service) ||
    !SAFE_COMPOSE_OPERAND.test(item.Service) ||
    !isBoundedObservationString(item.State) ||
    !isBoundedObservationString(item.Health, true)
  ) {
    throw new DockerIdentityError(
      "Docker Compose returned invalid container observation data",
      "COMPOSE_OBSERVATION_INVALID",
    );
  }

  return Object.freeze({
    containerId: item.ID,
    containerName: item.Name,
    serviceName: item.Service,
    state: item.State,
    health: item.Health,
  });
}

/**
 * Observe every running and stopped container in one Compose project.
 *
 * Docker Compose has emitted both a JSON array and JSON Lines for this command
 * across supported versions. Both forms are accepted, but malformed, partial,
 * duplicate, or oversized evidence fails closed with a sanitized typed error.
 */
export async function getComposeContainerObservations(
  composePath: string,
  options: ComposeContainerObservationOptions = {},
): Promise<readonly ComposeContainerObservation[]> {
  if (
    options.projectName !== undefined &&
    (typeof options.projectName !== "string" ||
      !SAFE_COMPOSE_OPERAND.test(options.projectName) ||
      Buffer.byteLength(options.projectName, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES)
  ) {
    throw new DockerIdentityError("Unsafe Compose project name", "UNSAFE_PROJECT_NAME");
  }
  if (options.profiles !== undefined && !Array.isArray(options.profiles)) {
    throw new DockerIdentityError("Unsafe profile name", "UNSAFE_PROFILE_NAME");
  }
  const profiles = [...new Set(options.profiles ?? [])].sort(compareCodePoint);
  for (const profile of profiles) {
    if (
      typeof profile !== "string" ||
      !SAFE_COMPOSE_OPERAND.test(profile) ||
      Buffer.byteLength(profile, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
    ) {
      throw new DockerIdentityError("Unsafe profile name", "UNSAFE_PROFILE_NAME");
    }
  }

  const [canonicalComposePath] = await safeComposePaths([composePath]);
  if (canonicalComposePath === undefined) {
    throw new DockerIdentityError("Compose path is not a safe regular file", "UNSAFE_COMPOSE_PATH");
  }
  const canonicalEnvFile =
    options.envFile === undefined ? undefined : await safeEnvironmentFilePath(options.envFile);
  const args = [
    ...(options.projectName === undefined ? [] : ["--project-name", options.projectName]),
    "-f",
    canonicalComposePath,
    ...(canonicalEnvFile === undefined ? [] : ["--env-file", canonicalEnvFile]),
    ...profiles.flatMap((profile) => ["--profile", profile]),
    "ps",
    "--all",
    "--format",
    "json",
  ];
  const maxStdoutBytes = Math.min(
    normalizeCaptureLimit(options.maxStdoutBytes, COMPOSE_OBSERVATION_MAX_OUTPUT_BYTES),
    COMPOSE_OBSERVATION_MAX_OUTPUT_BYTES,
  );
  const result = await execDockerCompose(args, {
    ...options,
    captureOutput: true,
    streamOutput: false,
    maxStdoutBytes,
  });
  if (!result.success) {
    if (result.stderr.startsWith("Command stdout exceeded capture limit")) {
      throw new DockerIdentityError(
        "Docker Compose container observation exceeded the allowed size",
        "COMPOSE_OBSERVATION_TOO_LARGE",
      );
    }
    throw new DockerIdentityError(
      "Unable to observe Docker Compose containers",
      "COMPOSE_OBSERVATION_FAILED",
    );
  }
  if (Buffer.byteLength(result.stdout, "utf8") > maxStdoutBytes) {
    throw new DockerIdentityError(
      "Docker Compose container observation exceeded the allowed size",
      "COMPOSE_OBSERVATION_TOO_LARGE",
    );
  }

  const payload = parseComposeObservationPayload(result.stdout);
  if (payload.length > COMPOSE_OBSERVATION_MAX_ITEMS) {
    throw new DockerIdentityError(
      "Docker Compose container observation exceeded the allowed size",
      "COMPOSE_OBSERVATION_TOO_LARGE",
    );
  }
  const observations = payload.map(normalizeComposeObservationItem);
  const containerIds = new Set<string>();
  const containerNames = new Set<string>();
  for (const observation of observations) {
    const normalizedId = observation.containerId.toLowerCase();
    if (containerIds.has(normalizedId) || containerNames.has(observation.containerName)) {
      throw new DockerIdentityError(
        "Docker Compose returned duplicate container observation data",
        "COMPOSE_OBSERVATION_INVALID",
      );
    }
    containerIds.add(normalizedId);
    containerNames.add(observation.containerName);
  }

  return Object.freeze(
    observations.sort(
      (a, b) =>
        compareCodePoint(a.serviceName, b.serviceName) ||
        compareCodePoint(a.containerName, b.containerName) ||
        compareCodePoint(a.containerId, b.containerId),
    ),
  );
}

/**
 * Apply one reviewed reconciliation action without widening Compose scope.
 *
 * This is intentionally separate from `startServices()`: reconciliation must
 * never remove orphans, pull or build images, renew volumes, start implicit
 * dependencies, or accept more than one target service.
 */
export async function reconcileService(
  input: ReconcileServiceInput,
  options: DockerExecOptions = {},
  dependencies: ReconcileServiceDependencies = DEFAULT_RECONCILE_SERVICE_DEPENDENCIES,
): Promise<DockerExecResult> {
  if (
    typeof input.service !== "string" ||
    !SAFE_COMPOSE_OPERAND.test(input.service) ||
    Buffer.byteLength(input.service, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
  ) {
    throw new DockerIdentityError("Unsafe service name", "UNSAFE_SERVICE_NAME");
  }
  if (
    typeof input.projectName !== "string" ||
    !SAFE_COMPOSE_OPERAND.test(input.projectName) ||
    Buffer.byteLength(input.projectName, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
  ) {
    throw new DockerIdentityError("Unsafe Compose project name", "UNSAFE_PROJECT_NAME");
  }
  if (input.profiles !== undefined && !Array.isArray(input.profiles)) {
    throw new DockerIdentityError("Unsafe profile name", "UNSAFE_PROFILE_NAME");
  }
  const profiles = [...new Set(input.profiles ?? [])].sort(compareCodePoint);
  for (const profile of profiles) {
    if (
      typeof profile !== "string" ||
      !SAFE_COMPOSE_OPERAND.test(profile) ||
      Buffer.byteLength(profile, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
    ) {
      throw new DockerIdentityError("Unsafe profile name", "UNSAFE_PROFILE_NAME");
    }
  }
  if (input.action !== "create" && input.action !== "start" && input.action !== "recreate") {
    throw new DockerIdentityError("Unsafe reconciliation action", "UNSAFE_RECONCILE_ACTION");
  }

  const snapshot =
    input.resolvedComposeJson === undefined
      ? undefined
      : await createPrivateResolvedComposeSnapshot(input.resolvedComposeJson);
  try {
    const [canonicalComposePath] =
      snapshot === undefined ? await safeComposePaths([input.composePath]) : [snapshot.composePath];
    if (canonicalComposePath === undefined) {
      throw new DockerIdentityError(
        "Compose path is not a safe regular file",
        "UNSAFE_COMPOSE_PATH",
      );
    }
    const canonicalEnvFile =
      snapshot !== undefined || input.envFile === undefined
        ? undefined
        : await safeEnvironmentFilePath(input.envFile);
    const projectDirectory =
      snapshot === undefined
        ? undefined
        : await safeProjectDirectoryPath(input.projectDirectory ?? "");
    const args = [
      "--project-name",
      input.projectName,
      ...(projectDirectory === undefined ? [] : ["--project-directory", projectDirectory]),
      "-f",
      canonicalComposePath,
      ...(canonicalEnvFile === undefined ? [] : ["--env-file", canonicalEnvFile]),
      ...profiles.flatMap((profile) => ["--profile", profile]),
      "up",
      "-d",
      "--pull",
      "never",
      "--no-build",
      "--no-deps",
      ...(input.action === "recreate" ? ["--force-recreate"] : []),
      input.service,
    ];

    return await execDockerCompose(args, {
      ...options,
      captureOutput: true,
      streamOutput: false,
      maxStdoutBytes: Math.min(
        normalizeCaptureLimit(options.maxStdoutBytes, RECONCILE_ACTION_MAX_OUTPUT_BYTES),
        RECONCILE_ACTION_MAX_OUTPUT_BYTES,
      ),
      maxStderrBytes: Math.min(
        normalizeCaptureLimit(options.maxStderrBytes, RECONCILE_ACTION_MAX_OUTPUT_BYTES),
        RECONCILE_ACTION_MAX_OUTPUT_BYTES,
      ),
    });
  } finally {
    if (snapshot !== undefined) {
      try {
        await dependencies.removeTemporaryDirectory(snapshot.directory);
      } catch (error) {
        throw new DockerIdentityError(
          "Unable to remove private resolved Compose authority",
          "UNSAFE_COMPOSE_PATH",
          { cause: error },
        );
      }
    }
  }
}

export type DockerRuntimeState = "running" | "restarting" | "exited" | "unknown";
export type DockerHealthState = "healthy" | "unhealthy" | "starting" | "not-configured" | "unknown";

export interface DockerImageIdentity {
  readonly localImageId: string;
  readonly configuredImage: string;
  readonly repositoryDigest?: string;
  readonly platform?: string;
}

export interface DockerContainerIdentity extends DockerImageIdentity {
  readonly containerId: string;
  readonly state: DockerRuntimeState;
  readonly exitCode: number;
  readonly health: DockerHealthState;
}

interface ImageInspectPayload {
  Id?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Variant?: unknown;
  Config?: { Env?: unknown } | null;
}

function normalizePlatformValue(
  os: unknown,
  architecture: unknown,
  variant?: unknown,
): string | undefined {
  if (typeof os !== "string" || typeof architecture !== "string") return undefined;
  const normalizedArchitecture =
    architecture.toLowerCase() === "x86_64"
      ? "amd64"
      : architecture.toLowerCase() === "aarch64"
        ? "arm64"
        : architecture.toLowerCase();
  const parts = [os.toLowerCase(), normalizedArchitecture];
  if (typeof variant === "string" && variant.trim() !== "") parts.push(variant.toLowerCase());
  return parts.join("/");
}

function normalizeRequestedPlatform(platform: string): string | undefined {
  const parts = platform
    .trim()
    .split("/")
    .map((part) => part.trim());
  return normalizePlatformValue(parts[0], parts[1], parts[2]);
}

function canonicalRepository(image: string): string | undefined {
  if (image === "" || /[\u0000-\u0020\u007f]/u.test(image)) return undefined;
  const withoutDigest = image.split("@", 1)[0];
  if (withoutDigest === undefined || withoutDigest === "") return undefined;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const withoutTag = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const segments = withoutTag.split("/");
  const first = segments[0];
  if (first === undefined || first === "") return undefined;
  const hasRegistry =
    segments.length > 1 &&
    (first.includes(".") || first.includes(":") || first.toLowerCase() === "localhost");
  let registry = hasRegistry ? first.toLowerCase() : "docker.io";
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") {
    registry = "docker.io";
  }
  let repository = hasRegistry ? segments.slice(1).join("/") : segments.join("/");
  if (registry === "docker.io" && !repository.includes("/")) repository = `library/${repository}`;
  return `${registry}/${repository.toLowerCase()}`;
}

function normalizeRepositoryDigest(value: string): string | undefined {
  const atIndex = value.lastIndexOf("@");
  if (atIndex <= 0) return undefined;
  const repository = canonicalRepository(value.slice(0, atIndex));
  const digest = value.slice(atIndex + 1).toLowerCase();
  if (repository === undefined || !SHA256_PATTERN.test(digest)) return undefined;
  return `${repository}@${digest}`;
}

function selectRepositoryDigest(repoDigests: unknown, configuredImage: string): string | undefined {
  const repository = canonicalRepository(configuredImage);
  if (repository === undefined || !Array.isArray(repoDigests)) return undefined;
  for (const value of repoDigests) {
    if (typeof value !== "string") continue;
    const normalized = normalizeRepositoryDigest(value);
    if (normalized?.startsWith(`${repository}@`) === true) return normalized;
  }
  return undefined;
}

/** Inspect one image while keeping daemon-local and registry identities distinct. */
export async function inspectImageIdentity(
  imageReference: string,
  configuredImage: string = imageReference,
  options: DockerExecOptions = {},
): Promise<DockerImageIdentity> {
  const result = await execDocker(["image", "inspect", imageReference], {
    ...options,
    captureOutput: true,
    streamOutput: false,
  });
  if (!result.success) {
    throw new DockerIdentityError(
      "Unable to inspect the requested Docker image",
      "IMAGE_INSPECTION_FAILED",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new DockerIdentityError(
      "Docker returned invalid image inspection data",
      "IMAGE_INSPECTION_INVALID",
      { cause: error },
    );
  }
  const payload = Array.isArray(parsed)
    ? (parsed[0] as ImageInspectPayload | undefined)
    : undefined;
  if (payload === undefined || typeof payload.Id !== "string" || !SHA256_PATTERN.test(payload.Id)) {
    throw new DockerIdentityError(
      "Docker image inspection did not include a valid daemon-local image ID",
      "IMAGE_INSPECTION_INVALID",
    );
  }

  const repositoryDigest = selectRepositoryDigest(payload.RepoDigests, configuredImage);
  const platform = normalizePlatformValue(payload.Os, payload.Architecture, payload.Variant);
  return Object.freeze({
    localImageId: payload.Id.toLowerCase(),
    configuredImage,
    ...(repositoryDigest === undefined ? {} : { repositoryDigest }),
    ...(platform === undefined ? {} : { platform }),
  });
}

/**
 * Inspect the immutable image behind a running container and return its default environment.
 *
 * Reconciliation uses this evidence to distinguish a removed Compose override from an
 * unchanged image-default variable. Output and individual entries are bounded, and malformed
 * image inspection data fails closed rather than weakening drift evidence.
 */
function normalizeImageDefaultEnvironment(
  payload: ImageInspectPayload,
): Readonly<Record<string, string>> {
  const rawEnvironment = payload.Config?.Env;
  if (rawEnvironment === undefined || rawEnvironment === null) return Object.freeze({});
  if (!Array.isArray(rawEnvironment) || rawEnvironment.length > IMAGE_ENVIRONMENT_MAX_ITEMS) {
    throw new DockerIdentityError(
      "Docker image inspection contained invalid environment data",
      "IMAGE_INSPECTION_INVALID",
    );
  }
  const environment: Record<string, string> = {};
  for (const entry of rawEnvironment) {
    if (
      typeof entry !== "string" ||
      Buffer.byteLength(entry, "utf8") > IMAGE_ENVIRONMENT_MAX_ENTRY_BYTES ||
      entry.includes("\0")
    ) {
      throw new DockerIdentityError(
        "Docker image inspection contained invalid environment data",
        "IMAGE_INSPECTION_INVALID",
      );
    }
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new DockerIdentityError(
        "Docker image inspection contained invalid environment data",
        "IMAGE_INSPECTION_INVALID",
      );
    }
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return Object.freeze(environment);
}

/** Inspect image defaults for a bounded set with exactly one Docker subprocess. */
export async function inspectImageDefaultEnvironments(
  imageIds: readonly string[],
  options: DockerExecOptions = {},
): Promise<Map<string, Readonly<Record<string, string>>>> {
  const requested = [...new Set(imageIds.map((imageId) => imageId.toLowerCase()))];
  if (
    requested.length !== imageIds.length ||
    requested.length > IMAGE_ENVIRONMENT_BATCH_MAX_IMAGES ||
    requested.some((imageId) => !SHA256_PATTERN.test(imageId))
  ) {
    throw new DockerIdentityError("Invalid Docker image identity", "INVALID_IMAGE_IDENTITY");
  }
  if (requested.length === 0) return new Map();
  const result = await execDocker(["image", "inspect", ...requested], {
    ...options,
    captureOutput: true,
    streamOutput: false,
    maxStdoutBytes: Math.min(
      normalizeCaptureLimit(options.maxStdoutBytes, IMAGE_ENVIRONMENT_BATCH_MAX_OUTPUT_BYTES),
      IMAGE_ENVIRONMENT_BATCH_MAX_OUTPUT_BYTES,
    ),
  });
  if (!result.success) {
    throw new DockerIdentityError(
      "Unable to inspect the requested Docker image",
      "IMAGE_INSPECTION_FAILED",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new DockerIdentityError(
      "Docker returned invalid image inspection data",
      "IMAGE_INSPECTION_INVALID",
      { cause: error },
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== requested.length) {
    throw new DockerIdentityError(
      "Docker image inspection did not match the requested images",
      "IMAGE_INSPECTION_INVALID",
    );
  }
  const requestedSet = new Set(requested);
  const defaults = new Map<string, Readonly<Record<string, string>>>();
  for (const value of parsed) {
    const payload = value as ImageInspectPayload | null;
    const inspectedId = typeof payload?.Id === "string" ? payload.Id.toLowerCase() : undefined;
    if (
      payload === null ||
      typeof payload !== "object" ||
      inspectedId === undefined ||
      !requestedSet.has(inspectedId) ||
      defaults.has(inspectedId)
    ) {
      throw new DockerIdentityError(
        "Docker image inspection did not match the requested images",
        "IMAGE_INSPECTION_INVALID",
      );
    }
    defaults.set(inspectedId, normalizeImageDefaultEnvironment(payload));
  }
  return defaults;
}

export async function inspectImageDefaultEnvironment(
  imageId: string,
  options: DockerExecOptions = {},
): Promise<Readonly<Record<string, string>>> {
  const normalized = imageId.toLowerCase();
  const defaults = await inspectImageDefaultEnvironments([normalized], {
    ...options,
    maxStdoutBytes: Math.min(
      normalizeCaptureLimit(options.maxStdoutBytes, IMAGE_ENVIRONMENT_MAX_OUTPUT_BYTES),
      IMAGE_ENVIRONMENT_MAX_OUTPUT_BYTES,
    ),
  });
  return defaults.get(normalized)!;
}

/**
 * Container inspection result from docker inspect
 */
export interface ContainerInspect {
  /** Container ID */
  Id: string;
  /** Container name */
  Name: string;
  /** Image used */
  Image: string;
  /** Container configuration */
  Config: {
    /** Image name */
    Image: string;
    /** Environment variables */
    Env: string[];
    /** Exposed ports */
    ExposedPorts?: Record<string, unknown>;
    /** Volumes */
    Volumes?: Record<string, unknown>;
    /** Container labels (includes com.docker.compose.* and user labels) */
    Labels?: Record<string, string>;
  };
  /** Host configuration */
  HostConfig: {
    /** Port bindings */
    PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>>;
    /** Volume bindings */
    Binds?: string[];
    /** Restart policy */
    RestartPolicy?: {
      Name: string;
      MaximumRetryCount?: number;
    };
    /** Network mode (e.g., "bridge", "host", "container:xxx", "service:xxx") */
    NetworkMode?: string;
  };
  /** Network settings */
  NetworkSettings: {
    /** Networks the container is connected to */
    Networks?: Record<string, unknown>;
  };
  /** Container state */
  State: {
    /** Running status */
    Running: boolean;
    /** Exit code */
    ExitCode: number;
    Restarting?: boolean;
    Status?: string;
    Health?: { Status?: string };
  };
}

/**
 * Inspect running containers to get detailed configuration
 */
export async function inspectContainers(
  containerNames: string[],
  options: DockerExecOptions = {},
): Promise<ContainerInspect[] | undefined> {
  if (containerNames.length === 0) {
    return [];
  }

  const args = ["inspect", ...containerNames];

  const result = await execDocker(args, options);

  if (!result.success) {
    logDebug(`Failed to inspect containers: ${result.stderr}`);
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as ContainerInspect[];
  } catch (error) {
    logError(
      `Failed to parse container inspect output: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function inspectContainerIdentity(
  containerName: string,
  options: DockerExecOptions = {},
): Promise<DockerContainerIdentity> {
  if (!SAFE_COMPOSE_OPERAND.test(containerName)) {
    throw new DockerIdentityError("Unsafe container name", "UNSAFE_SERVICE_NAME");
  }
  const containers = await inspectContainers([containerName], options);
  const container = containers?.[0];
  if (container === undefined) {
    throw new DockerIdentityError(
      "Unable to inspect the requested container",
      "IMAGE_INSPECTION_FAILED",
    );
  }
  const image = await inspectImageIdentity(container.Image, container.Config.Image, options);
  const state: DockerRuntimeState =
    container.State.Restarting === true
      ? "restarting"
      : container.State.Running
        ? "running"
        : container.State.Status === "exited"
          ? "exited"
          : "unknown";
  const rawHealth = container.State.Health?.Status;
  const health: DockerHealthState =
    rawHealth === undefined
      ? "not-configured"
      : rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "starting"
        ? rawHealth
        : "unknown";
  return Object.freeze({
    ...image,
    containerId: container.Id,
    state,
    exitCode: container.State.ExitCode,
    health,
  });
}

export type ImmutableImageSource =
  | {
      readonly kind: "repository-digest";
      readonly configuredImage: string;
      readonly repositoryDigest: string;
      readonly platform?: string;
    }
  | {
      readonly kind: "local-image-id";
      readonly configuredImage: string;
      readonly localImageId: string;
      readonly platform?: string;
    };

export interface RecreateServiceWithImageInput {
  readonly composePaths: readonly string[];
  /** Explicit project name binding for managed project-scoped mutations. */
  readonly projectName?: string;
  readonly service: string;
  readonly profiles?: readonly string[];
  readonly source: ImmutableImageSource;
}

export interface RecreateServiceCleanupFailure {
  readonly status: "failed";
  readonly code: "TEMP_OVERRIDE_CLEANUP_FAILED";
  readonly message: string;
  readonly temporaryDirectory: string;
}

export interface RecreateServiceWithImageDependencies {
  removeTemporaryDirectory(path: string): Promise<void>;
}

export type RecreateServiceWithImageResult = (
  | {
      readonly success: true;
      readonly command: DockerExecResult;
      readonly identity: DockerImageIdentity;
    }
  | {
      readonly success: false;
      readonly stage: "pull" | "recreate";
      readonly command: DockerExecResult;
    }
) & {
  readonly cleanup?: RecreateServiceCleanupFailure;
};

const TEMP_OVERRIDE_CLEANUP_MESSAGE =
  "Temporary image override cleanup failed; remove the retained directory manually";

const DEFAULT_RECREATE_SERVICE_DEPENDENCIES: RecreateServiceWithImageDependencies = {
  removeTemporaryDirectory(path) {
    return rm(path, { recursive: true, force: true });
  },
};

async function cleanupTemporaryOverride(
  directory: string,
  dependencies: RecreateServiceWithImageDependencies,
): Promise<RecreateServiceCleanupFailure | undefined> {
  try {
    await dependencies.removeTemporaryDirectory(directory);
    return undefined;
  } catch {
    const cleanup: RecreateServiceCleanupFailure = {
      status: "failed",
      code: "TEMP_OVERRIDE_CLEANUP_FAILED",
      message: TEMP_OVERRIDE_CLEANUP_MESSAGE,
      temporaryDirectory: directory,
    };
    logWarn(`${cleanup.message}; retained directory: ${directory}`);
    return cleanup;
  }
}

async function safeComposePaths(paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0)
    throw new DockerIdentityError("At least one Compose path is required", "UNSAFE_COMPOSE_PATH");
  const safe: string[] = [];
  for (const path of paths) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isFile()) throw new Error("not a regular file");
      safe.push(canonical);
    } catch (error) {
      throw new DockerIdentityError(
        "Compose path is not a safe regular file",
        "UNSAFE_COMPOSE_PATH",
        { cause: error },
      );
    }
  }
  return safe;
}

async function safeEnvironmentFilePath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || path.includes("\0")) {
    throw new DockerIdentityError(
      "Environment file path is not a safe regular file",
      "UNSAFE_ENV_FILE",
    );
  }
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular file");
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error("not a regular file");
    return canonical;
  } catch (error) {
    if (error instanceof DockerIdentityError) throw error;
    throw new DockerIdentityError(
      "Environment file path is not a safe regular file",
      "UNSAFE_ENV_FILE",
      { cause: error },
    );
  }
}

const CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES: ConflictEvidenceAdapterDependencies = {
  defaultTimeoutMs: DEFAULT_OPTIONS.timeout,
  execDocker,
  execDockerCompose,
  filterToolOutput,
  safeComposePaths,
  safeEnvironmentFilePath,
};

/** Resolve the complete effective Compose evidence and its secret-free projection. */
export function getCanonicalComposeConfigEvidence(
  composePath: string,
  options: ConflictEvidenceOptions = {},
): Promise<CanonicalComposeConfigEvidence> {
  return readCanonicalComposeConfigEvidence(
    CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES,
    composePath,
    options,
  );
}

/** Resolve and strictly project the effective Compose model without retaining secrets. */
export function getCanonicalComposeConfig(
  composePath: string,
  options: ConflictEvidenceOptions = {},
): Promise<CanonicalComposeConfig> {
  return readCanonicalComposeConfig(CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES, composePath, options);
}

/** List and inspect all running containers with strict, bounded projection. */
export function getConflictRuntimeContainers(
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeContainerProjection[]> {
  return readConflictRuntimeContainers(CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES, options);
}

/** List and inspect Docker networks with strict, bounded projection. */
export function getConflictRuntimeNetworks(
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeNetworkProjection[]> {
  return readConflictRuntimeNetworks(CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES, options);
}

/** List and inspect named Docker volumes with strict, bounded projection. */
export function getConflictRuntimeVolumes(
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeVolumeProjection[]> {
  return readConflictRuntimeVolumes(CONFLICT_EVIDENCE_ADAPTER_DEPENDENCIES, options);
}
export async function recreateServiceWithImage(
  input: RecreateServiceWithImageInput,
  options: DockerExecOptions = {},
  dependencies: RecreateServiceWithImageDependencies = DEFAULT_RECREATE_SERVICE_DEPENDENCIES,
): Promise<RecreateServiceWithImageResult> {
  if (!SAFE_COMPOSE_OPERAND.test(input.service))
    throw new DockerIdentityError("Unsafe service name", "UNSAFE_SERVICE_NAME");
  if (input.projectName !== undefined && !SAFE_COMPOSE_OPERAND.test(input.projectName))
    throw new DockerIdentityError("Unsafe Compose project name", "UNSAFE_PROJECT_NAME");
  for (const profile of input.profiles ?? [])
    if (!SAFE_COMPOSE_OPERAND.test(profile))
      throw new DockerIdentityError("Unsafe profile name", "UNSAFE_PROFILE_NAME");
  const composePaths = await safeComposePaths(input.composePaths);
  const immutableReference =
    input.source.kind === "repository-digest"
      ? normalizeRepositoryDigest(input.source.repositoryDigest)
      : input.source.localImageId.toLowerCase();
  if (
    immutableReference === undefined ||
    (input.source.kind === "local-image-id" && !SHA256_PATTERN.test(immutableReference))
  )
    throw new DockerIdentityError("Invalid immutable image identity", "INVALID_IMAGE_IDENTITY");
  const directory = await mkdtemp(join(tmpdir(), "rfapps-update-"));
  await chmod(directory, 0o700);
  const overridePath = join(directory, "override.json");
  let result: RecreateServiceWithImageResult | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;
  try {
    const handle = await open(
      overridePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(
      JSON.stringify({
        services: {
          [input.service]: {
            image: immutableReference,
            ...(input.source.platform === undefined ? {} : { platform: input.source.platform }),
          },
        },
      }),
    );
    await handle.close();
    const prefix = [
      ...(input.projectName === undefined ? [] : ["--project-name", input.projectName]),
      ...composePaths.flatMap((path) => ["-f", path]),
    ];
    prefix.push("-f", overridePath);
    for (const profile of input.profiles ?? []) prefix.push("--profile", profile);
    if (input.source.kind === "repository-digest") {
      const pull = await execDockerCompose([...prefix, "pull", input.service], options);
      if (!pull.success) {
        result = { success: false, stage: "pull", command: pull };
      }
    }
    if (result === undefined) {
      const identity = await inspectImageIdentity(
        immutableReference,
        input.source.configuredImage,
        options,
      );
      if (
        (input.source.kind === "repository-digest" &&
          identity.repositoryDigest !== immutableReference) ||
        (input.source.kind === "local-image-id" && identity.localImageId !== immutableReference)
      )
        throw new DockerIdentityError(
          "Pulled image identity did not match the reviewed identity",
          "IMAGE_IDENTITY_MISMATCH",
        );
      const command = await execDockerCompose(
        [...prefix, "up", "-d", "--force-recreate", "--pull", "never", input.service],
        options,
      );
      result = command.success
        ? { success: true, command, identity }
        : { success: false, stage: "recreate", command };
    }
  } catch (error) {
    primaryFailure = { error };
  }

  const cleanup = await cleanupTemporaryOverride(directory, dependencies);
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (result === undefined) {
    throw new DockerIdentityError(
      "Image recreation completed without a primary result",
      "IMAGE_INSPECTION_FAILED",
    );
  }
  return cleanup === undefined ? result : { ...result, cleanup };
}

/**
 * Get the local image's canonical repository digest
 *
 * Selects the RepoDigest whose repository matches the configured image instead
 * of trusting daemon alias ordering. Returns undefined when the image or a
 * matching immutable repository digest is unavailable locally.
 */
export async function getLocalImageDigest(
  image: string,
  options: DockerExecOptions = {},
): Promise<string | undefined> {
  // First check if image exists locally
  const existsResult = await execDocker(["image", "inspect", image, "--format", "{{.Id}}"], {
    ...options,
    captureOutput: true,
    streamOutput: false,
  });

  if (!existsResult.success) {
    logDebug(`Image not found locally: ${image}`);
    return undefined;
  }

  // Get RepoDigests which contains the sha256 hash
  const args = ["image", "inspect", image, "--format", "{{json .RepoDigests}}"];

  const result = await execDocker(args, {
    ...options,
    captureOutput: true,
    streamOutput: false,
  });

  if (!result.success) {
    logDebug(`Failed to get local image digest for ${image}: ${result.stderr}`);
    return undefined;
  }

  try {
    const digests = JSON.parse(result.stdout.trim()) as unknown;
    return selectRepositoryDigest(digests, image);
  } catch (error) {
    logDebug(
      `Failed to parse local image digest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

/**
 * Get a canonical remote repository digest from the registry without pulling
 *
 * Uses docker manifest inspect to query the registry for the image digest.
 * Requires DOCKER_CLI_EXPERIMENTAL=enabled environment variable.
 */
export async function getRemoteImageDigest(
  image: string,
  options: DockerExecOptions & { platform?: string } = {},
): Promise<string | undefined> {
  const args = ["manifest", "inspect", image, "--verbose"];

  const result = await execDocker(args, {
    ...options,
    captureOutput: true,
    streamOutput: false,
    env: {
      ...options.env,
      DOCKER_CLI_EXPERIMENTAL: "enabled",
    },
  });

  if (!result.success) {
    logDebug(`Failed to get remote image digest for ${image}: ${result.stderr}`);
    return undefined;
  }

  try {
    // Parse the manifest response
    const parsed = JSON.parse(result.stdout.trim()) as unknown;
    const manifests = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
      Descriptor?: { digest?: string };
    }>;
    const requested =
      options.platform === undefined ? undefined : normalizeRequestedPlatform(options.platform);
    const manifest =
      requested === undefined
        ? manifests[0]
        : manifests.find((entry) => {
            const platform = (
              entry.Descriptor as
                | { platform?: { os?: unknown; architecture?: unknown; variant?: unknown } }
                | undefined
            )?.platform;
            return (
              normalizePlatformValue(platform?.os, platform?.architecture, platform?.variant) ===
              requested
            );
          });

    // Descriptor.digest is the pullable manifest identity. A config digest is
    // content-addressed too, but it is not a valid replacement for repo@digest.
    const digest = manifest?.Descriptor?.digest;

    if (typeof digest === "string") {
      const repository = canonicalRepository(image);
      const normalizedDigest = digest.toLowerCase();
      if (repository !== undefined && SHA256_PATTERN.test(normalizedDigest)) {
        return `${repository}@${normalizedDigest}`;
      }
    }
  } catch (error) {
    logDebug(
      `Failed to parse remote image manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

/**
 * Image update check result
 */
export interface ImageUpdateCheck {
  /** Whether an update is available */
  hasUpdate: boolean;
  /** Local image digest */
  localDigest?: string;
  /** Remote image digest */
  remoteDigest?: string;
  /** Error message if check failed */
  error?: string;
}

/**
 * Check if an image has updates available on the registry
 *
 * Compares the local image digest with the remote registry digest
 * to determine if a newer version is available without pulling.
 */
export async function checkImageUpdate(
  image: string,
  options: DockerExecOptions & { platform?: string } = {},
): Promise<ImageUpdateCheck> {
  try {
    const { platform: _platform, ...dockerOptions } = options;
    const [localDigest, remoteDigest] = await Promise.all([
      getLocalImageDigest(image, dockerOptions),
      getRemoteImageDigest(image, options),
    ]);

    // If we couldn't get either digest, we can't determine if there's an update
    if (localDigest === undefined) {
      return {
        hasUpdate: false,
        error: "Local image not found",
      };
    }

    if (remoteDigest === undefined) {
      return {
        hasUpdate: false,
        localDigest,
        error:
          options.platform === undefined
            ? "Could not fetch remote image digest"
            : "No matching manifest for the selected platform",
      };
    }

    // Compare digests
    const hasUpdate = localDigest !== remoteDigest;

    return {
      hasUpdate,
      localDigest,
      remoteDigest,
    };
  } catch (error) {
    return {
      hasUpdate: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
