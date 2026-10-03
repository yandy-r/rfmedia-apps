/**
 * Init command for rfapps CLI
 *
 * Generates a configuration file from the project's compose.yml
 */

import { Command, Option } from "commander";
import type { GlobalOptions } from "../types/index.js";

/**
 * Options specific to init command
 */
export interface InitCommandOptions extends GlobalOptions {
  /** Write to global config location (~/.rfapps.yaml) */
  global: boolean;
  /** Use JSON format instead of YAML */
  json: boolean;
  /** Overwrite existing config file */
  force: boolean;
}

/**
 * Create the init command
 */
export function createInitCommand(): Command {
  return new Command("init")
    .description("Generate configuration file from compose.yml")
    .addOption(new Option("-g, --global", "Write to global config (~/.rfapps.yaml)"))
    .addOption(new Option("--json", "Generate JSON config instead of YAML"))
    .addOption(new Option("-f, --force", "Overwrite existing config file"))
    .addOption(new Option("--dry-run", "Preview config without writing"))
    .addOption(new Option("--debug", "Enable debug output"))
    .addOption(new Option("--json-output", "Output in JSON format").conflicts("json"))
    .addOption(new Option("-v, --verbose", "Show detailed output"))
    .addOption(new Option("-y, --yes", "Skip confirmation prompts"))
    .action(async (options: InitCommandOptions) => {
      const { executeInit } = await import("../actions/init.js");
      await executeInit(options);
    });
}
