/**
 * Completion command definition for rfmedia CLI.
 *
 * Generates shell completion scripts for bash, zsh, and fish shells.
 */

import { Command, Option } from "commander";
import { logError } from "../lib/logger.js";
import { isMachineFormat } from "@rfmedia/common";
import { SUPPORTED_SHELLS } from "../types/index.js";
import type { SupportedShell, CompletionOptions } from "../types/index.js";

/**
 * Raw options as parsed by Commander.js before transformation.
 */
interface RawCompletionOptions {
  shell?: string;
  install?: boolean;
  force?: boolean;
}

/**
 * JSON output structure for completion command.
 */
interface CompletionJsonOutput {
  command: "completion";
  result: {
    success: boolean;
    shell: SupportedShell;
    script?: string;
    installedPath?: string;
    alreadyInstalled?: boolean;
    error?: string;
  };
}

/**
 * Validates that the provided string is a supported shell.
 *
 * @param value - Shell name to validate
 * @returns Validated shell type
 * @throws Error if shell is not supported
 */
function validateShell(value: string): SupportedShell {
  if (!SUPPORTED_SHELLS.includes(value as SupportedShell)) {
    throw new Error(`Invalid shell: '${value}'. Supported shells: ${SUPPORTED_SHELLS.join(", ")}`);
  }
  return value as SupportedShell;
}

/**
 * Completion command for generating shell completion scripts.
 */
export const completionCommand = new Command("completion")
  .description("Generate shell completion scripts for bash, zsh, or fish")
  .argument("[shell]", "Target shell (bash, zsh, fish)")
  .addOption(new Option("-s, --shell <shell>", "Target shell").choices([...SUPPORTED_SHELLS]))
  .addOption(new Option("--install", "Install completion script to shell configuration"))
  .addOption(new Option("--force", "Overwrite existing installation without prompting"))
  .action(async (shellArg: string | undefined, options: RawCompletionOptions, command: Command) => {
    // Get global options from parent command
    const globalOpts = command.parent?.opts() ?? {};
    const globalDryRun = Boolean(globalOpts["dryRun"]);
    // Determine shell from argument or option
    const shellValue = shellArg ?? options.shell;
    if (!shellValue) {
      logError("Shell not specified. Provide shell as argument or use --shell option.");
      logError(`Supported shells: ${SUPPORTED_SHELLS.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    // Validate shell
    let shell: SupportedShell;
    try {
      shell = validateShell(shellValue);
    } catch (err) {
      const error = err as Error;
      logError(error.message);
      process.exitCode = 1;
      return;
    }

    // Build completion options
    const completionOptions: CompletionOptions = {
      shell,
      install: options.install ?? false,
      dryRun: globalDryRun,
      force: options.force ?? false,
    };

    // Lazy load the action handler to improve startup time
    const { executeCompletion } = await import("../actions/completion.js");
    const result = await executeCompletion(completionOptions);

    // Handle output mode
    const format = globalOpts?.["output"] ?? "text";
    if (isMachineFormat(format)) {
      const jsonOutput: CompletionJsonOutput = {
        command: "completion",
        result: {
          success: result.success,
          shell,
          script: result.script,
          installedPath: result.installedPath,
          alreadyInstalled: result.alreadyInstalled,
          error: result.error,
        },
      };
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, jsonOutput);
    } else if (!completionOptions.install) {
      // Print script to stdout for piping (non-machine mode, no install)
      console.log(result.script);
    }

    // Exit with error code if operation failed
    if (!result.success) {
      process.exitCode = 1;
    }
  });
