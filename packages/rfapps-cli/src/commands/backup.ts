import type { OutputFormat } from "@rfmedia/common";
import type { Command } from "commander";

import type { RawBackupOptions } from "../actions/backup.js";
import { InvalidArgumentError } from "../lib/errors.js";
import { explicitSelectorFlagNames } from "../lib/selector.js";

export interface BackupCommandGlobalOptions {
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly output?: OutputFormat;
  readonly yes?: boolean;
  readonly debug?: boolean;
  readonly verbose?: boolean;
  readonly useDotenvx?: string;
  readonly useOp?: string;
}

type ExecuteBackup = (
  rawOptions: RawBackupOptions,
  globalOptions: BackupCommandGlobalOptions,
) => Promise<void>;

type ExecuteBackupVerify = (
  manifestPath: string,
  globalOptions: BackupCommandGlobalOptions,
) => Promise<void>;

export interface BackupCommandDependencies {
  loadCreateAction(): Promise<{ executeBackup: ExecuteBackup }>;
  loadVerifyAction(): Promise<{ executeBackupVerify: ExecuteBackupVerify }>;
}

const defaultDependencies: BackupCommandDependencies = {
  loadCreateAction: () => import("../actions/backup.js"),
  loadVerifyAction: () => import("../actions/backup-verify.js"),
};

function outputFormat(options: BackupCommandGlobalOptions): OutputFormat {
  return options.output ?? (options.json === true ? "json" : "text");
}

function requireNonBlank(option: string, value: string | undefined, noun: string): void {
  if (value === undefined || value.trim() === "") {
    throw new InvalidArgumentError(option, value ?? "", `Must name ${noun}`);
  }
}

/**
 * Validate creation authorization before loading config, Docker, or the action.
 *
 * Root CLI pre-action invokes this same function before acquiring the state
 * lock; the command callback repeats it for independently embedded registrars.
 */
export function validateBackupCreateOptions(
  options: RawBackupOptions,
  globalOptions: BackupCommandGlobalOptions,
  interactive = process.stdin.isTTY === true,
): void {
  requireNonBlank("--destination", options.destination, "an existing destination directory");
  if (options.service !== undefined) requireNonBlank("--service", options.service, "a service");
  if (options.services !== undefined) {
    const services = options.services.split(",").map((service) => service.trim());
    if (services.length === 0 || services.some((service) => service === "")) {
      throw new InvalidArgumentError(
        "--services",
        options.services,
        "Must be a comma-separated list of service names",
      );
    }
  }
  if (options.group !== undefined) requireNonBlank("--group", options.group, "a service group");

  // Selector site 5. The flag names come from lib/selector.ts, not a local array literal:
  // a copy that predates --tag lets `backup --all --tag "media/**"` past this check, the
  // --all branch then wins, and the whole project is archived with --tag silently ignored.
  const selectorFlags = explicitSelectorFlagNames(options);
  if (options.all === true && selectorFlags.length > 0) {
    throw new InvalidArgumentError(
      "--all",
      "true",
      `Cannot combine --all with ${selectorFlags.join(", ")}`,
    );
  }

  const format = outputFormat(globalOptions);
  if (format === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "CSV output cannot represent backup storage and recovery evidence",
      ["json", "yaml", "table", "text"],
    );
  }
  const machine = format === "json" || format === "yaml";
  const explicitTarget = options.all === true || selectorFlags.length > 0;
  if (!explicitTarget && (globalOptions.yes === true || machine || !interactive)) {
    throw new InvalidArgumentError(
      "--all",
      "false",
      "Backup requires an explicit service target or --all in non-interactive, machine, or --yes mode",
    );
  }
  if (machine && globalOptions.yes !== true) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format backup creation requires explicit --yes",
    );
  }
}

/** Validate the offline verifier operand and lossless output contract. */
export function validateBackupVerifyOptions(
  manifestPath: string,
  globalOptions: BackupCommandGlobalOptions,
): void {
  requireNonBlank("<manifest>", manifestPath, "a backup manifest");
  if (outputFormat(globalOptions) === "csv") {
    throw new InvalidArgumentError(
      "--output",
      "csv",
      "CSV output cannot represent backup integrity evidence",
      ["json", "yaml", "table", "text"],
    );
  }
}

/** Register parent backup creation and its lock-free offline verify child. */
export function registerBackupCommand(
  program: Command,
  dependencies: BackupCommandDependencies = defaultDependencies,
): void {
  const backup = program
    .command("backup")
    .description("Create and verify cold filesystem backup bundles")
    .configureHelp({ showGlobalOptions: true })
    .option("-s, --service <name>", "Target a specific service")
    .option("--services <names>", "Target multiple services (comma-separated)")
    .option("-g, --group <name>", "Target a service group")
    // `addServiceTargetOptions` cannot be used here: --all sits between --group and
    // --no-sidecars, so the shared block is not contiguous. The collector below is
    // byte-identical to the helper's, including the absence of a default value — an `[]`
    // default would make --tag look permanently present and every `backup --all` would
    // report a selector conflict.
    .option(
      "--tag <pattern>",
      "Narrow targets by hierarchical tag pattern (repeatable)",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option("--all", "Target every Compose service explicitly", false)
    .option("--no-sidecars", "Disable automatic sidecar linking")
    .option("--destination <directory>", "Existing directory that will contain the backup bundle")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
Creation is cold and filesystem-level. Dry-run plans without writes, pulls,
locks, prompts, stops, or archives. A real run shows one complete plan and asks
once unless global --yes is present.

Exit codes:
  0  Plan completed or a complete bundle was published
  1  Docker, filesystem, archive, or recovery failure
  2  Invalid usage, unsafe input, or cancelled approval`,
    )
    .action(async (options: RawBackupOptions) => {
      const globalOptions = program.opts<BackupCommandGlobalOptions>();
      validateBackupCreateOptions(options, globalOptions);
      const { executeBackup } = await dependencies.loadCreateAction();
      await executeBackup(options, globalOptions);
    });

  backup
    .command("verify")
    .description("Verify a backup manifest and every declared archive offline")
    .argument("<manifest>", "Path to manifest.json")
    .addHelpText(
      "after",
      `
Verification is read-only and requires no rfapps config, Docker authority, or
state/lifecycle lock. It never extracts archives.

Exit codes:
  0  Every declared artifact verified
  1  Missing, unexpected, size-mismatched, or checksum-mismatched artifact
  2  Invalid, unsafe, or unsupported manifest`,
    )
    .action(async (manifestPath: string) => {
      const globalOptions = program.opts<BackupCommandGlobalOptions>();
      validateBackupVerifyOptions(manifestPath, globalOptions);
      const { executeBackupVerify } = await dependencies.loadVerifyAction();
      await executeBackupVerify(manifestPath, globalOptions);
    });
}
