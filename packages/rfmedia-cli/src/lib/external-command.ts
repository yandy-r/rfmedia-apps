/**
 * External command wrapper utilities for plugin system.
 *
 * Provides utilities for spawning external command plugins with:
 * - Command existence checking (cross-platform via which package)
 * - Timeout support via AbortController
 * - Stdout/stderr collection with buffer limits
 * - Argument interpolation for context variables
 *
 * @module external-command
 */

import { spawn } from "node:child_process";
import which from "which";
import { ExternalCommandError } from "../types/plugins.js";

/** Maximum buffer size for stdout/stderr collection (10KB) */
const MAX_BUFFER_SIZE = 10 * 1024;

/**
 * Options for executing an external command.
 */
export interface ExternalCommandOptions {
  /** Timeout in milliseconds. If exceeded, the process is killed. */
  timeout?: number;
  /** Abort signal for external cancellation support. */
  signal?: AbortSignal;
  /** Additional environment variables to pass to the process. */
  env?: Record<string, string>;
}

/**
 * Result from executing an external command.
 */
export interface ExternalCommandResult {
  /** Whether the command completed successfully (exit code 0). */
  success: boolean;
  /** Standard output from the command. */
  stdout: string;
  /** Standard error output from the command. */
  stderr: string;
  /** Exit code from the command. */
  exitCode: number;
}

/**
 * Check if a command exists in PATH.
 *
 * Uses the cross-platform `which` package for Windows compatibility.
 *
 * @param command - The command name to check
 * @returns Promise resolving to true if command exists, false otherwise
 *
 * @example
 * ```typescript
 * if (await commandExists('beet')) {
 *   // Safe to execute beet command
 * } else {
 *   console.error('beet is not installed');
 * }
 * ```
 */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const resolved = await which(command, { nothrow: true });
    return resolved !== null;
  } catch {
    return false;
  }
}

/**
 * Execute an external command with timeout and cancellation support.
 *
 * The command is spawned with stdio piped for stdout/stderr collection.
 * Output buffers are limited to 10KB to prevent memory issues.
 *
 * @param command - The command to execute
 * @param args - Array of command arguments
 * @param options - Execution options (timeout, signal, env)
 * @returns Promise resolving to ExternalCommandResult
 * @throws ExternalCommandError if command not found or exits with non-zero code
 *
 * @example
 * ```typescript
 * const result = await executeExternalCommand('beet', ['import', '-q', '/music/album'], {
 *   timeout: 60000,
 * });
 *
 * if (result.success) {
 *   console.log('Import completed:', result.stdout);
 * }
 * ```
 */
export async function executeExternalCommand(
  command: string,
  args: string[],
  options: ExternalCommandOptions = {},
): Promise<ExternalCommandResult> {
  // Check command exists first
  const exists = await commandExists(command);
  if (!exists) {
    throw new ExternalCommandError(command, `Command not found: ${command}`, undefined);
  }

  return new Promise((resolve, reject) => {
    // Set up timeout via AbortController
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const localController = new AbortController();

    // Link to external signal if provided
    if (options.signal?.aborted) {
      reject(new ExternalCommandError(command, "Operation aborted", undefined));
      return;
    }

    const abortHandler = () => {
      localController.abort();
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler, { once: true });
    }

    // Set up timeout
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        localController.abort();
      }, options.timeout);
    }

    // Spawn process with stdio piped
    const proc = spawn(command, args, {
      stdio: "pipe",
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    // Collect stdout (limit buffer to 10KB)
    proc.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (stdout.length > MAX_BUFFER_SIZE) {
        stdout = stdout.slice(-MAX_BUFFER_SIZE);
      }
    });

    // Collect stderr (limit buffer to 10KB)
    proc.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (stderr.length > MAX_BUFFER_SIZE) {
        stderr = stderr.slice(-MAX_BUFFER_SIZE);
      }
    });

    // Handle abort
    localController.signal.addEventListener("abort", () => {
      if (!killed) {
        killed = true;
        proc.kill("SIGTERM");
      }
    });

    // Handle process completion
    proc.on("close", (code) => {
      // Clean up timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Clean up signal listener
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      const exitCode = code ?? 1;

      if (killed) {
        reject(new ExternalCommandError(command, "Operation timed out or was aborted", exitCode));
        return;
      }

      if (exitCode === 0) {
        resolve({
          success: true,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: 0,
        });
      } else {
        reject(new ExternalCommandError(command, stderr.trim() || "Command failed", exitCode));
      }
    });

    // Handle spawn errors (e.g., ENOENT - command not found)
    proc.on("error", (err: NodeJS.ErrnoException) => {
      // Clean up timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Clean up signal listener
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }

      const errorMessage = err.message || "Unknown error";

      // Check for command not found error
      if (err.code === "ENOENT") {
        reject(new ExternalCommandError(command, `Command not found: ${command}`, undefined));
      } else {
        reject(new ExternalCommandError(command, errorMessage, undefined));
      }
    });
  });
}

/**
 * Interpolate placeholder variables in command arguments.
 *
 * Supports placeholders in the format `{varName}`. Unknown placeholders
 * are replaced with empty strings.
 *
 * @param args - Array of arguments with potential placeholders
 * @param context - Map of variable names to values
 * @returns Array of interpolated arguments
 *
 * @example
 * ```typescript
 * const args = interpolateArgs(
 *   ['import', '-q', '{destPath}', '--artist={artist}'],
 *   { destPath: '/music/album', artist: 'Beatles' }
 * );
 * // Returns: ['import', '-q', '/music/album', '--artist=Beatles']
 * ```
 */
export function interpolateArgs(
  args: string[],
  context: Record<string, string | undefined>,
): string[] {
  return args.map((arg) => arg.replace(/\{(\w+)\}/g, (_, key: string) => context[key] ?? ""));
}
