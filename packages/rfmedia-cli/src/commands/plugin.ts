/**
 * Plugin command definition for rfmedia CLI.
 *
 * Provides plugin management capabilities including listing installed plugins,
 * showing plugin details, and displaying the plugin directory path.
 */

import { Command } from "commander";

/**
 * Plugin management command with subcommands for listing, inspecting, and managing plugins.
 */
export const pluginCommand = new Command("plugin").description("Manage rfmedia plugins");

// List subcommand
pluginCommand.addCommand(
  new Command("list")
    .alias("ls")
    .description("List installed plugins")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      const { executePluginList } = await import("../actions/plugin.js");
      await executePluginList(options);
    }),
);

// Info subcommand
pluginCommand.addCommand(
  new Command("info")
    .description("Show plugin details")
    .argument("<name>", "Plugin name")
    .option("--json", "Output as JSON")
    .action(async (name: string, options: { json?: boolean }) => {
      const { executePluginInfo } = await import("../actions/plugin.js");
      await executePluginInfo(name, options);
    }),
);

// Directory subcommand
pluginCommand.addCommand(
  new Command("dir").description("Show plugin directory path").action(async () => {
    const { executePluginDir } = await import("../actions/plugin.js");
    await executePluginDir();
  }),
);
