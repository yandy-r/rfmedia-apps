/**
 * Secrets injection re-execution module for rfmedia CLI
 *
 * When --use-dotenvx or --use-op options are detected, the CLI re-executes
 * itself under the wrapper command (e.g., `dotenvx run -f .env -- rfmedia ...`).
 * This ensures environment variables are available during config loading for
 * template resolution.
 *
 * @module rfmedia-cli/lib/secrets-reexec
 */

import { spawn } from "node:child_process";
import { checkDotenvx, checkOp, envFileExists, buildEnvCommand } from "./env-tools.js";

/**
 * Result of detecting secrets options in argv
 */
export interface SecretsDetectionResult {
  /** Whether re-execution is needed */
  shouldReexec: boolean;
  /** The tool to use for re-execution */
  tool?: "dotenvx" | "op";
  /** Path to the environment file */
  envFile?: string;
  /** Error message if detection failed */
  error?: string;
  /** Filtered argv with secrets options removed */
  filteredArgv?: string[];
}

/**
 * Detect --use-dotenvx or --use-op options from argv BEFORE Commander parses it.
 *
 * This is necessary because the secrets wrapper must be applied before any
 * module imports that might read environment variables (like config loading).
 *
 * @param argv - The process.argv array
 * @returns Detection result indicating whether re-execution is needed
 */
export function detectSecretsOption(argv: string[]): SecretsDetectionResult {
  let useDotenvx: string | undefined;
  let useOp: string | undefined;
  const filteredArgv: string[] = [];
  let i = 0;

  // Skip node and script path
  filteredArgv.push(argv[0] ?? "");
  filteredArgv.push(argv[1] ?? "");

  for (i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--use-dotenvx") {
      // Next arg is the file
      i++;
      useDotenvx = argv[i];
      if (!useDotenvx) {
        return {
          shouldReexec: false,
          error: "--use-dotenvx requires a file path argument",
        };
      }
    } else if (arg.startsWith("--use-dotenvx=")) {
      useDotenvx = arg.slice("--use-dotenvx=".length);
    } else if (arg === "--use-op") {
      // Next arg is the file
      i++;
      useOp = argv[i];
      if (!useOp) {
        return {
          shouldReexec: false,
          error: "--use-op requires a file path argument",
        };
      }
    } else if (arg.startsWith("--use-op=")) {
      useOp = arg.slice("--use-op=".length);
    } else {
      filteredArgv.push(arg);
    }
  }

  // Check mutual exclusion
  if (useDotenvx !== undefined && useOp !== undefined) {
    return {
      shouldReexec: false,
      error: "Cannot use both --use-dotenvx and --use-op. Choose one secrets injection method.",
    };
  }

  // No secrets options found
  if (useDotenvx === undefined && useOp === undefined) {
    return {
      shouldReexec: false,
    };
  }

  // Determine which tool to use
  const tool: "dotenvx" | "op" = useDotenvx !== undefined ? "dotenvx" : "op";
  const envFile = useDotenvx ?? useOp;

  return {
    shouldReexec: true,
    tool,
    envFile,
    filteredArgv,
  };
}

/**
 * Execute the CLI with a secrets wrapper (dotenvx or op)
 *
 * This spawns a new process with the wrapper command prepended, which will
 * inject environment variables before the CLI starts.
 *
 * @param result - The detection result from detectSecretsOption
 * @returns The exit code from the wrapped process
 */
export async function executeWithSecretsWrapper(result: SecretsDetectionResult): Promise<number> {
  if (!result.tool || !result.envFile || !result.filteredArgv) {
    throw new Error("Invalid secrets detection result");
  }

  // Validate tool availability
  if (result.tool === "dotenvx") {
    const check = await checkDotenvx();
    if (!check.available) {
      console.error(`Error: ${check.error}`);
      return 1;
    }
  } else {
    const check = await checkOp();
    if (!check.available) {
      console.error(`Error: ${check.error}`);
      return 1;
    }
  }

  // Validate env file exists
  const fileExists = await envFileExists(result.envFile);
  if (!fileExists) {
    console.error(`Error: Environment file not found: ${result.envFile}`);
    return 1;
  }

  // Build the wrapper command
  const envCommand = buildEnvCommand(result.tool, result.envFile);

  // The CLI command is the script path from filtered argv
  const cliScript = result.filteredArgv[1];
  if (!cliScript) {
    throw new Error("Could not determine CLI script path");
  }

  // Build full command: node script.js [remaining args]
  // We skip argv[0] (node) since spawn will use it implicitly
  const cliArgs = result.filteredArgv.slice(2);

  // Final command: dotenvx run -f .env -- node script.js [args]
  // or: op run --env-file .env -- node script.js [args]
  const fullArgs = [
    ...envCommand.args,
    process.execPath, // node binary
    cliScript,
    ...cliArgs,
  ];

  return new Promise((resolve) => {
    const proc = spawn(envCommand.command, fullArgs, {
      stdio: "inherit",
      env: process.env,
    });

    proc.on("close", (code) => {
      resolve(code ?? 1);
    });

    proc.on("error", (error) => {
      console.error(`Error executing ${envCommand.command}: ${error.message}`);
      resolve(1);
    });
  });
}
