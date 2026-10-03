/**
 * Init command definition for rfmedia CLI.
 *
 * Generates a configuration file template with all available options.
 */

import { Command, Option } from "commander";
import { isMachineFormat } from "@rfmedia/common";
import type { GlobalOptions } from "../types/options.js";

/**
 * Raw options as parsed by Commander.js before transformation.
 */
interface RawInitOptions {
  path?: string;
  global?: boolean;
  force?: boolean;
  merge?: boolean;
}

/**
 * JSON output structure for init command.
 */
interface InitJsonOutput {
  command: "init";
  result: {
    created: boolean;
    path: string;
    merged?: boolean;
    error?: string;
  };
}

/**
 * Init command for generating a configuration file template.
 */
export const initCommand = new Command("init")
  .description("Generate a configuration file template")
  .addOption(new Option("-p, --path <path>", "Custom path for the config file"))
  .addOption(new Option("-g, --global", "Write to global config (~/.rfmedia.yaml)"))
  .addOption(new Option("--force", "Overwrite existing config file"))
  .addOption(new Option("--no-merge", "Generate fresh template without merging existing config"))
  .action(async (options: RawInitOptions) => {
    // Lazy load the action handler to improve startup time
    const { executeInit } = await import("../actions/init.js");
    const result = await executeInit({
      path: options.path,
      global: options.global ?? false,
      force: options.force ?? false,
      merge: options.merge ?? true, // Default to true (merge enabled)
    });

    // Output JSON if --json flag is set
    const jsonOutput: InitJsonOutput = {
      command: "init",
      result: {
        created: result.created,
        path: result.path,
        merged: result.merged,
        error: result.error,
      },
    };

    const globalOpts = initCommand.parent?.opts() as GlobalOptions | undefined;
    const format = globalOpts?.output ?? "text";
    if (isMachineFormat(format)) {
      const { formatOutput } = await import("../lib/formatters/index.js");
      await formatOutput(format, jsonOutput);
    }

    // Exit with error code if operation failed
    if (!result.created) {
      process.exitCode = 1;
    }
  });
