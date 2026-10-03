import { Option, type Command } from "commander";

import { InvalidArgumentError } from "../lib/errors.js";
import type {
  RawStateExportOptions,
  RawStateRebuildOptions,
  StateCommandGlobalOptions,
} from "../types/state-rebuild.js";

type ExecuteStateRebuild = (
  rawOptions: RawStateRebuildOptions,
  globalOptions: StateCommandGlobalOptions,
) => Promise<void>;

type ExecuteStateExport = (
  rawOptions: RawStateExportOptions,
  globalOptions: StateCommandGlobalOptions,
) => Promise<void>;

export interface StateCommandDependencies {
  loadRebuildAction(): Promise<{ executeStateRebuild: ExecuteStateRebuild }>;
  loadExportAction(): Promise<{ executeStateExport: ExecuteStateExport }>;
}

const defaultDependencies: StateCommandDependencies = {
  loadRebuildAction: () => import("../actions/state-rebuild.js"),
  loadExportAction: () => import("../actions/state-export.js"),
};

function validateNonBlank(option: string, value: string | undefined, noun: string): void {
  if (value !== undefined && value.trim() === "") {
    throw new InvalidArgumentError(option, value, `Must name ${noun}`);
  }
}

/** Validate rebuild values Commander has parsed before loading the action module. */
export function validateStateRebuildOptions(options: RawStateRebuildOptions): void {
  validateNonBlank("--confirm-project", options.confirmProject, "a Compose project");
  validateNonBlank("--backup-dir", options.backupDir, "a directory");
}

/** Validate export values Commander has parsed before loading the action module. */
export function validateStateExportOptions(options: RawStateExportOptions): void {
  validateNonBlank("--out", options.out, "a destination file");
}

/** Register the state database inspect/export/rebuild command group. */
export function registerStateCommand(
  program: Command,
  dependencies: StateCommandDependencies = defaultDependencies,
): void {
  // `.configureHelp()` MUST be chained before the subcommands are created:
  // Commander copies the parent's help configuration into a subcommand at
  // creation time, so a later call never reaches `export` or `rebuild`.
  const state = program
    .command("state")
    .description("Inspect, export, and reconstruct the rfapps state database")
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Read-only commands:
  export   Write a consistent, private copy of the state database.

Mutation commands:
  rebuild  Reconstruct the state database from Docker runtime and compose declarations.`,
    );

  state
    .command("export")
    .description("Write a consistent backup copy of the rfapps state database")
    .option("-o, --out <path>", "Backup destination file")
    .addHelpText(
      "after",
      `
Uses SQLite's online backup API, so the copy is consistent even while another
rfapps mutation is writing. It never modifies the source database and never
acquires the state lock, so a precautionary backup is never blocked by a stuck
lock. Global --dry-run reports the destination and writes nothing.

An unreadable source is NOT a failure. If SQLite cannot parse the source, its
raw bytes are copied instead and the run still succeeds, reporting
method "raw-copy". That artifact preserves a corrupt file for forensics but may
not open as a database.

The artifact is created mode 600 inside a mode 700 parent. It contains full
deployment topology and config snapshots (secret-like environment values are
masked, but treat the file as sensitive).

Restore is a plain file copy:
  cp <backup> ~/.config/rfapps/state.db

Exit codes:
  0  Backup written (including the raw-copy fallback), or dry-run reported
  1  The backup could not be written; no artifact exists
  2  Invalid or unsafe usage`,
    )
    .action(async (options: RawStateExportOptions) => {
      validateStateExportOptions(options);
      const { executeStateExport } = await dependencies.loadExportAction();
      await executeStateExport(options, program.opts());
    });

  state
    .command("rebuild")
    .description("Reconstruct the state database from Docker runtime and compose declarations")
    .addOption(
      new Option(
        "--mode <mode>",
        "Reconstruction mode (salvage keeps every readable row, runtime-only discards them)",
      )
        .choices(["salvage", "runtime-only"])
        .default("salvage"),
    )
    .option("--rewrite", "Replace the state database with the reconstruction", false)
    .option("--confirm-project <name>", "Compose project name; required by --mode runtime-only")
    .option(
      "--running-only",
      "Only reconstruct services whose container is currently running",
      false,
    )
    .option("--backup-dir <path>", "Directory for the mandatory pre-rewrite backup")
    .option(
      "--show-unchanged",
      "Include carried, absent, and orphaned services in the report",
      false,
    )
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
This is NOT \`rfapps rebuild\`, which recreates containers. This command only
touches the rfapps state database; it never mutates Docker and never modifies
compose.yml.

Report-first: a bare invocation opens the existing database READ-ONLY, observes
Docker and compose, and prints the database that WOULD be built. It writes
nothing and takes no state lock. Only --rewrite authorizes the replacement.
Global --yes only skips human confirmation; it does not grant write authority.
Global --dry-run vetoes the rewrite even when --rewrite is present. Machine-
format rewrite additionally requires global --yes.

A pre-rewrite backup is mandatory and cannot be disabled. If the backup cannot
be written, nothing is rewritten.

The rebuild NEVER mutates the existing database. It builds a complete
replacement beside it and swaps atomically, so any failure leaves the original
file byte-for-byte untouched.

Modes:
  salvage       (default) Carry every readable deployment and generation row
                from the existing database into the replacement, preserving
                deployment ids and generation numbers, then add baselines only
                for services that have no carried history.
  runtime-only  Discard every existing row; the replacement contains only
                runtime-derived baselines. Because this drops history that
                Docker cannot re-derive, it additionally requires
                --confirm-project <name> matching the resolved Compose project.

This is a whole-database operation and takes no service scope. To adopt one
untracked service without touching the rest, use \`rfapps import --adopt\`.

Exit codes:
  0  Report completed, or the database was rewritten with nothing discarded
  1  Observation, backup, build, or swap failed (the database is unchanged)
  2  Invalid or unsafe usage, cancelled, or the rewrite was refused
  3  Partial: the database was rewritten but a container could not be inspected
     or unreadable rows were discarded during salvage`,
    )
    .action(async (options: RawStateRebuildOptions) => {
      validateStateRebuildOptions(options);
      const { executeStateRebuild } = await dependencies.loadRebuildAction();
      await executeStateRebuild(options, program.opts());
    });
}
