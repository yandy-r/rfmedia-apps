/**
 * Filter command definition for rfmedia CLI.
 *
 * Provides subcommands for listing, inspecting, and creating smart filter definitions.
 */

import { Command } from "commander";
import { Table } from "console-table-printer";
import pc from "picocolors";

import { isMachineFormat } from "@rfmedia/common";

import { logError } from "../lib/logger.js";
import type { GlobalOptions } from "../types/options.js";
import type {
  FilterListOptions,
  FilterShowOptions,
  FilterCreateOptions,
  FilterListResult,
  FilterShowResult,
  FilterCreateResult,
} from "../actions/filter.js";

// ============================================================================
// JSON OUTPUT INTERFACES
// ============================================================================

/**
 * JSON output structure for filter list command.
 */
interface FilterListJsonOutput {
  command: "filter";
  subcommand: "list";
  result: FilterListResult;
}

/**
 * JSON output structure for filter show command.
 */
interface FilterShowJsonOutput {
  command: "filter";
  subcommand: "show";
  result: FilterShowResult;
}

/**
 * JSON output structure for filter create command.
 */
interface FilterCreateJsonOutput {
  command: "filter";
  subcommand: "create";
  result: FilterCreateResult;
}

// ============================================================================
// FILTER COMMAND WITH SUBCOMMANDS
// ============================================================================

/**
 * Filter command for managing smart filter definitions.
 *
 * Subcommands:
 * - list: Show all defined filters with rule counts
 * - show: Display detailed filter definition
 * - create: Interactively create a new filter
 */
export const filterCommand = new Command("filter").description("Manage smart filter definitions");

// ============================================================================
// LIST SUBCOMMAND
// ============================================================================

filterCommand
  .command("list")
  .description("List all defined smart filters (or Plex filters with --plex)")
  .option("--plex", "List Plex filters from config.plexFilters (for Plex -F/--filter completion)")
  .option("--names", "Output only filter names, one per line (for shell completion)")
  .action(async (cmdOpts: { plex?: boolean; names?: boolean }) => {
    // Get global options from parent command chain
    const globalOpts = filterCommand.parent?.opts() as GlobalOptions | undefined;

    // Build FilterListOptions
    const options: FilterListOptions = {
      plex: Boolean(cmdOpts.plex),
      namesOnly: Boolean(cmdOpts.names),
    };

    try {
      // Lazy load the action handler to improve startup time
      const { executeFilterList } = await import("../actions/filter.js");
      const result: FilterListResult = await executeFilterList(options);

      if (options.namesOnly) {
        for (const f of result.filters) {
          console.log(f.name);
        }
        return;
      }

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const jsonOutput: FilterListJsonOutput = {
          command: "filter",
          subcommand: "list",
          result,
        };
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, jsonOutput);
      } else {
        formatFilterListOutput(result, options.plex);
      }
    } catch (error) {
      logError(`Filter list failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// ============================================================================
// SHOW SUBCOMMAND
// ============================================================================

filterCommand
  .command("show <name>")
  .description("Display detailed filter definition")
  .action(async (name: string) => {
    // Get global options from parent command chain
    const globalOpts = filterCommand.parent?.opts() as GlobalOptions | undefined;

    // Build FilterShowOptions
    const options: FilterShowOptions = {
      name,
    };

    try {
      // Lazy load the action handler to improve startup time
      const { executeFilterShow } = await import("../actions/filter.js");
      const result: FilterShowResult = await executeFilterShow(options);

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const jsonOutput: FilterShowJsonOutput = {
          command: "filter",
          subcommand: "show",
          result,
        };
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, jsonOutput);
      } else {
        formatFilterShowOutput(result);
      }
    } catch (error) {
      logError(`Filter show failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// ============================================================================
// CREATE SUBCOMMAND
// ============================================================================

filterCommand
  .command("create")
  .description("Interactively create a new smart filter")
  .option("-n, --name <name>", "Filter name (will prompt if not provided)")
  .option("-c, --config <path>", "Path to config file to save filter")
  .action(async (cmdOpts: { name?: string; config?: string }) => {
    // Get global options from parent command chain
    const globalOpts = filterCommand.parent?.opts() as GlobalOptions | undefined;

    // Build FilterCreateOptions
    const options: FilterCreateOptions = {
      name: cmdOpts.name,
      configPath: cmdOpts.config,
      dryRun: Boolean(globalOpts?.dryRun),
    };

    try {
      // Lazy load the action handler to improve startup time
      const { executeFilterCreate } = await import("../actions/filter.js");
      const result: FilterCreateResult = await executeFilterCreate(options);

      const format = globalOpts?.output ?? "text";
      if (isMachineFormat(format)) {
        const jsonOutput: FilterCreateJsonOutput = {
          command: "filter",
          subcommand: "create",
          result,
        };
        const { formatOutput } = await import("../lib/formatters/index.js");
        await formatOutput(format, jsonOutput);
      }
      // Success message already logged by action
    } catch (error) {
      logError(`Filter create failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

// ============================================================================
// CONSOLE OUTPUT FORMATTERS
// ============================================================================

/**
 * Formats filter list result for console output using tables.
 *
 * @param result - Filter list result
 * @param isPlex - Whether listing Plex filters (affects empty message)
 */
function formatFilterListOutput(result: FilterListResult, isPlex?: boolean): void {
  if (result.filters.length === 0) {
    console.error("");
    if (isPlex) {
      console.error(pc.yellow("No Plex filters defined in configuration."));
      console.error(pc.dim("Add filters under plexFilters: in your .rfmedia.yaml."));
    } else {
      console.error(pc.yellow("No filters defined in configuration."));
      console.error(pc.dim("Add filters to your .rfmedia.json or filters.yml file."));
    }
    console.error("");
    return;
  }

  console.error("");
  console.error(pc.bold(isPlex ? "Plex Filters" : "Smart Filters"));
  console.error("");

  const table = new Table({
    columns: [
      { name: "name", title: "Filter Name", alignment: "left" },
      { name: "match", title: "Match", alignment: "center" },
      { name: "rules", title: "Rules", alignment: "right" },
    ],
  });

  for (const filter of result.filters) {
    const matchLabel = filter.match === "all" ? "AND" : "OR";
    const matchColor = filter.match === "all" ? "cyan" : "magenta";
    table.addRow(
      { name: filter.name, match: matchLabel, rules: filter.ruleCount },
      { color: matchColor },
    );
  }

  console.error(table.render());
  console.error("");
  console.error(pc.dim(`Total: ${result.total} filter(s)`));
  console.error("");
}

/**
 * Formats filter show result for console output.
 *
 * @param result - Filter show result
 */
function formatFilterShowOutput(result: FilterShowResult): void {
  console.error("");
  console.error(pc.bold(`Filter: ${pc.cyan(result.name)}`));
  console.error(pc.dim("─".repeat(60)));

  // Display the formatted rule tree with colors
  const lines = result.ruleTree.split("\n");
  for (const line of lines) {
    // Color the match type labels
    let coloredLine = line;

    // Highlight AND/OR keywords
    coloredLine = coloredLine.replace(/\bAND\b/g, pc.cyan("AND"));
    coloredLine = coloredLine.replace(/\bOR\b/g, pc.magenta("OR"));

    // Highlight operators
    coloredLine = coloredLine.replace(/\s>=\s/g, ` ${pc.yellow(">=")} `);
    coloredLine = coloredLine.replace(/\s<=\s/g, ` ${pc.yellow("<=")} `);
    coloredLine = coloredLine.replace(/\s==\s/g, ` ${pc.yellow("==")} `);
    coloredLine = coloredLine.replace(/\scontains\s/g, ` ${pc.yellow("contains")} `);
    coloredLine = coloredLine.replace(/\swithin\s/g, ` ${pc.yellow("within")} `);

    // Highlight field names
    coloredLine = coloredLine.replace(
      /\b(rating|genre|artist|year|bpm|date_added)\b/g,
      pc.green("$1"),
    );

    // Highlight string values
    coloredLine = coloredLine.replace(/"([^"]+)"/g, pc.blue('"$1"'));

    console.error(coloredLine);
  }

  console.error(pc.dim("─".repeat(60)));
  console.error("");
}
