import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";

export function registerDriftCommand(program: Command): void {
  const drift = program
    .command("drift")
    .description("Detect and manage configuration drift")
    .addHelpText(
      "after",
      `
Read-only commands:
  detect  Inspect compose and Docker state without mutating containers or files.
  show    Inspect one service without mutating containers or files.

Mutation commands:
  reconcile  Apply the safe reconciliation workflow with explicit auto-apply intent.
  import     Explicitly update compose.yml from runtime configuration.`,
    );

  const detect = drift.command("detect").description("Show drifted services");

  addServiceTargetOptions(detect)
    .option("--show-unchanged", "Show unchanged services", false)
    .option("--report-only", "Always exit successfully when drift is found", false)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .action(async (options) => {
      const { executeDriftDetect } = await import("../actions/drift.js");
      await executeDriftDetect(options, program.opts());
    });

  drift
    .command("show")
    .description("Show detailed drift for a service")
    .requiredOption("-s, --service <name>", "Service to inspect")
    .option("--report-only", "Always exit successfully when drift is found", false)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .action(async (options) => {
      const { executeDriftShow } = await import("../actions/drift.js");
      await executeDriftShow(options, program.opts());
    });

  const reconcile = drift
    .command("reconcile")
    .description("Reconcile containers to compose.yml (legacy alias for reconcile --auto-apply)");

  addServiceTargetOptions(reconcile)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .action(async (options) => {
      const { executeDriftReconcile } = await import("../actions/drift.js");
      await executeDriftReconcile(options, program.opts());
    });

  const driftImport = drift
    .command("import")
    .description("Update compose.yml to match running containers");

  addServiceTargetOptions(driftImport)
    .option("--backup", "Create a .bak backup of compose.yml", false)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .action(async (options) => {
      const { executeDriftImport } = await import("../actions/drift.js");
      await executeDriftImport(options, program.opts());
    });
}
