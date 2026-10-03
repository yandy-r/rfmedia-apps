import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";
import { InvalidArgumentError } from "../lib/errors.js";
import type { RawImportOptions, ImportGlobalOptions } from "../actions/import.js";

type ExecuteImport = (
  rawOptions: RawImportOptions,
  globalOptions: ImportGlobalOptions,
) => Promise<void>;

export interface ImportCommandDependencies {
  loadAction(): Promise<{ executeImport: ExecuteImport }>;
}

const defaultDependencies: ImportCommandDependencies = {
  loadAction: () => import("../actions/import.js"),
};

function validateNonBlank(option: string, value: string | undefined, noun: string): void {
  if (value !== undefined && value.trim() === "") {
    throw new InvalidArgumentError(option, value, `Must name ${noun}`);
  }
}

/** Validate values Commander has parsed before loading the action module. */
export function validateImportOptions(options: RawImportOptions): void {
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
}

/** Register the report-first, explicitly authorized runtime-state import surface. */
export function registerImportCommand(
  program: Command,
  dependencies: ImportCommandDependencies = defaultDependencies,
): void {
  const importCommand = program
    .command("import")
    .description("Adopt externally-created running services into rfapps state tracking")
    .configureHelp({ showGlobalOptions: true });

  addServiceTargetOptions(importCommand)
    .option("--adopt", "Record baseline snapshots for discovered services", false)
    .option(
      "--show-tracked",
      "Include already-tracked and not-running services in the report",
      false,
    )
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
Report-first: bare invocation discovers running services absent from rfapps state
and previews the baseline snapshot that WOULD be recorded. It writes nothing and
does NOT modify compose.yml (see \`rfapps drift import\` for that). Only --adopt
authorizes the state write. Global --yes only skips human confirmation; it does
not grant write authority. Global --dry-run vetoes the write even when --adopt is
present. Machine-format adoption also requires global --yes.

Exit codes:
  0  Report completed, nothing to import, or every candidate adopted
  1  Observation or state-write operation failed
  2  Invalid or unsafe usage, or adoption was cancelled
  3  Partial adoption: a running candidate could not be inspected and was skipped`,
    )
    .action(async (options: RawImportOptions) => {
      validateImportOptions(options);
      const { executeImport } = await dependencies.loadAction();
      await executeImport(options, program.opts());
    });
}
