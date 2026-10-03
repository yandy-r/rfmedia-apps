import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";

export function registerDoctorCommand(program: Command): void {
  const doctor = program
    .command("doctor")
    .description("Run read-only diagnostics across runtime, config, updates, and state");

  addServiceTargetOptions(doctor)
    .option("--check-updates", "Check registries for newer image versions", false)
    .option(
      "--fail-on <severity>",
      "Exit non-zero at or above severity: none, info, warn, error, critical",
      "critical",
    )
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
Read-only by default: doctor inspects compose config, Docker state, registry metadata
only when --check-updates is set, and rfapps state history. It does not mutate
containers, save plans, or record deployments.

Failure threshold defaults to critical. Use --fail-on none to keep diagnostics
advisory-only in automation.`,
    )
    .action(async (options) => {
      const { executeDoctor } = await import("../actions/doctor.js");
      await executeDoctor(options, program.opts());
    });
}
