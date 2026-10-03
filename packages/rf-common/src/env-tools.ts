/**
 * Environment tool utilities for CLI tools.
 *
 * This module provides shared utilities for checking environment tool availability
 * and managing environment file access. These utilities are used by both rfapps-cli
 * and rfmedia-cli for secrets injection via dotenvx or 1Password CLI.
 *
 * ## Supported Tools
 *
 * - **dotenvx**: Local .env file with encryption support
 * - **op (1Password CLI)**: Secrets from 1Password vaults
 * - **any PATH executable**: via `checkExternalTool` (caller supplies binary, version
 *   flag, install hint)
 *
 * @module @rfmedia/common/env-tools
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

/**
 * Result of checking tool availability.
 *
 * @example
 * ```typescript
 * const result = await checkDotenvx();
 * if (result.available) {
 *   console.log(`dotenvx version: ${result.version}`);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */
export interface ToolCheckResult {
  /** Whether the tool is available in PATH */
  available: boolean;
  /** Version string if available */
  version?: string;
  /** Error message if not available */
  error?: string;
}

/**
 * Supported environment tools for secrets injection.
 *
 * - `"dotenvx"`: Use dotenvx for .env file encryption
 * - `"op"`: Use 1Password CLI for vault secrets
 * - `"none"`: No environment injection
 */
export type EnvTool = "dotenvx" | "op" | "none";

/**
 * Check if a command is available in PATH.
 *
 * @param command - The command name to check
 * @returns Promise resolving to true if command exists, false otherwise
 * @internal
 */
async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [command], { stdio: "pipe" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

/**
 * Get version of a command.
 *
 * @param command - The command name
 * @param versionFlag - The flag to get version (default: "--version")
 * @returns Promise resolving to version string or undefined if unavailable
 * @internal
 */
async function getCommandVersion(
  command: string,
  versionFlag: string = "--version",
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const proc = spawn(command, [versionFlag], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim().split("\n")[0]);
      } else {
        resolve(undefined);
      }
    });

    proc.on("error", () => resolve(undefined));
  });
}

/**
 * Check if dotenvx CLI is available in PATH.
 *
 * @returns Promise resolving to ToolCheckResult with availability and version info
 *
 * @example
 * ```typescript
 * const result = await checkDotenvx();
 * if (!result.available) {
 *   console.error(result.error);
 *   // "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx"
 * }
 * ```
 */
export async function checkDotenvx(): Promise<ToolCheckResult> {
  const available = await commandExists("dotenvx");

  if (!available) {
    return {
      available: false,
      error: "dotenvx not found in PATH. Install with: npm install -g @dotenvx/dotenvx",
    };
  }

  const version = await getCommandVersion("dotenvx", "--version");

  return {
    available: true,
    version,
  };
}

/**
 * Check if 1Password CLI (op) is available in PATH.
 *
 * @returns Promise resolving to ToolCheckResult with availability and version info
 *
 * @example
 * ```typescript
 * const result = await checkOp();
 * if (!result.available) {
 *   console.error(result.error);
 *   // "1Password CLI (op) not found in PATH. Install from: https://1password.com/downloads/command-line/"
 * }
 * ```
 */
export async function checkOp(): Promise<ToolCheckResult> {
  const available = await commandExists("op");

  if (!available) {
    return {
      available: false,
      error:
        "1Password CLI (op) not found in PATH. Install from: https://1password.com/downloads/command-line/",
    };
  }

  const version = await getCommandVersion("op", "--version");

  return {
    available: true,
    version,
  };
}

/**
 * Probe an arbitrary external tool on PATH.
 *
 * Generic counterpart to {@link checkDotenvx} and {@link checkOp} for callers that
 * carry their own binary name and install instructions (for example pluggable
 * vulnerability-scanner backends). Performs a `which` lookup followed by a version
 * read; it never throws.
 *
 * @param command - Executable name to look up in PATH
 * @param versionFlag - Flag that prints a version (e.g. `"--version"`, `"version"`)
 * @param installHint - Operator-facing install instruction, returned verbatim as `error`
 * @returns Promise resolving to ToolCheckResult with availability and version info
 *
 * @example
 * ```typescript
 * const result = await checkExternalTool(
 *   "trivy",
 *   "--version",
 *   "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
 * );
 * if (!result.available) {
 *   console.error(result.error); // the install hint, verbatim
 * }
 * ```
 */
export async function checkExternalTool(
  command: string,
  versionFlag: string,
  installHint: string,
): Promise<ToolCheckResult> {
  if (!(await commandExists(command))) {
    return { available: false, error: installHint };
  }

  return { available: true, version: await getCommandVersion(command, versionFlag) };
}

/**
 * Check if an environment file exists and is readable.
 *
 * @param envFile - Path to the environment file
 * @returns Promise resolving to true if file exists and is readable, false otherwise
 *
 * @example
 * ```typescript
 * const exists = await envFileExists('.env');
 * if (!exists) {
 *   console.error('Environment file not found: .env');
 * }
 * ```
 */
export async function envFileExists(envFile: string): Promise<boolean> {
  try {
    await access(envFile, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
