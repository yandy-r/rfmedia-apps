import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { RawReconcileOptions, ReconcileGlobalOptions } from "../actions/reconcile.js";

type ExecuteReconcile = (
  rawOptions: RawReconcileOptions,
  globalOptions: ReconcileGlobalOptions,
) => Promise<void>;

export interface ReconcileCommandDependencies {
  loadAction(): Promise<{ executeReconcile: ExecuteReconcile }>;
}

const defaultDependencies: ReconcileCommandDependencies = {
  loadAction: () => import("../actions/reconcile.js"),
};

function validateNonBlank(option: string, value: string | undefined, noun: string): void {
  if (value !== undefined && value.trim() === "") {
    throw new InvalidArgumentError(option, value, `Must name ${noun}`);
  }
}

/** Validate values Commander has parsed before loading the action module. */
export function validateReconcileOptions(options: RawReconcileOptions): void {
  validateNonBlank("--service", options.service, "a service");
  validateNonBlank("--group", options.group, "a service group");

  if (options.services !== undefined) {
    const services = options.services
      .split(",")
      .map((service) => service.trim())
      .filter((service) => service !== "");
    if (services.length === 0) {
      throw new InvalidArgumentError("--services", options.services, "Must name a service");
    }
  }

  if (options.healthTimeout !== undefined) {
    const timeout = Number(options.healthTimeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new InvalidArgumentError(
        "--health-timeout",
        String(options.healthTimeout),
        "Must be a positive number of seconds",
      );
    }
  }
}

/** Register the report-first, explicitly authorized reconciliation surface. */
export function registerReconcileCommand(
  program: Command,
  dependencies: ReconcileCommandDependencies = defaultDependencies,
): void {
  const reconcile = program
    .command("reconcile")
    .description("Report and optionally reconcile Docker Compose drift")
    .configureHelp({ showGlobalOptions: true });

  addServiceTargetOptions(reconcile)
    .option("--auto-apply", "Apply the reviewed reconciliation actions", false)
    .option("--show-unchanged", "Show unchanged services in output", false)
    .option("--health-timeout <seconds>", "Target verification timeout in seconds")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
Report-first: bare invocation compares resolved Compose intent with Docker state
and does not mutate containers or persist a plan. Only --auto-apply authorizes
the reviewed target actions. Global --yes only skips human confirmation; it does
not grant mutation authority. Global --dry-run vetoes mutation even when
--auto-apply is present. Machine-format auto-apply also requires global --yes.

Exit codes:
  0  Trustworthy report completed, or every requested service converged
  1  Observation or reconciliation operation failed
  2  Invalid or unsafe usage, or reconciliation was cancelled
  3  Partial, blocked, or residual-drift result`,
    )
    .action(async (options: RawReconcileOptions) => {
      validateReconcileOptions(options);
      const { executeReconcile } = await dependencies.loadAction();
      await executeReconcile(options, program.opts());
    });
}
