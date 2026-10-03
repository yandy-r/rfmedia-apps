import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";

export function registerAuditCommand(program: Command): void {
  const audit = program
    .command("audit")
    .description("Run a read-only Docker Compose security posture audit");

  addServiceTargetOptions(audit)
    .option(
      "--fail-on <severity>",
      "Exit non-zero at or above severity: none, info, warn, error, critical",
      "critical",
    )
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output audit result in JSON format", false)
    .addHelpText(
      "after",
      `
Read-only and advisory: audit resolves Docker Compose configuration, evaluates
container security posture, and prints remediation guidance. It does not mutate
containers, edit compose files, save plans, or record deployments.

Failure threshold defaults to critical. Use --fail-on none to keep audit
advisory-only in automation.`,
    )
    .action(async (options) => {
      const { executeAudit } = await import("../actions/audit.js");
      await executeAudit(options, program.opts());
    });
}
