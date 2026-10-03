#!/usr/bin/env node

/**
 * rfapps CLI - Docker orchestration for rfmedia-apps
 *
 * Primary entry point for the rfapps command line interface.
 *
 * Features:
 * - Service lifecycle management (deploy, rebuild, stop, delete, prune)
 * - Plan/apply workflow (Terraform-inspired deployment planning)
 * - Drift detection and reconciliation
 * - Automatic Tailscale sidecar linking
 * - Shell completion for bash/zsh/fish
 * - JSON output mode for scripting
 * - Secrets injection via dotenvx or 1Password CLI
 *
 * Configuration:
 * - rfapps.config.yaml in working directory (required, fallback to project root)
 * - ~/.rfapps.yaml for user defaults
 * - .rfapps.yaml in current directory for project overrides
 * - Environment variables RFAPPS_* for runtime overrides
 *
 * @see packages/rfapps-cli/README.md for usage documentation
 * @see docs/features/docker-orchestration.md for architecture
 * @module rfapps-cli/cli
 */

import { Command, CommanderError, Option } from "commander";
import {
  initLogger,
  setDebugMode,
  setJsonMode,
  setOutputFormat,
  logWarn,
  OUTPUT_FORMATS,
  isValidOutputFormat,
  handleCliError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";
import { registerRfappsErrorFormatters } from "./lib/error-formatters.js";
import { takeDeferredSignal } from "./lib/deferred-signal.js";
import { InvalidArgumentError, EnvFileNotFoundError } from "./lib/errors.js";
import { ExitCode } from "./lib/exit-codes.js";
import { acquireStateLock, type StateLock } from "./lib/state-lock.js";
import { addServiceTargetOptions } from "./lib/command-options.js";
import { hasExplicitSelector } from "./lib/selector.js";
import { parseTagTerm } from "./lib/tags/tag-pattern.js";
import { registerAuditCommand } from "./commands/audit.js";
import {
  registerBackupCommand,
  validateBackupCreateOptions,
  validateBackupVerifyOptions,
} from "./commands/backup.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDriftCommand } from "./commands/drift.js";
import { registerForceUnlockCommand } from "./commands/force-unlock.js";
import { registerHardenCommand, validateHardenOptions } from "./commands/harden.js";
import { registerImportCommand } from "./commands/import.js";
import { registerReconcileCommand } from "./commands/reconcile.js";
import { registerStateCommand } from "./commands/state.js";
import {
  registerTagCommand,
  validateTagShowOptions,
  validateTagSuggestOptions,
} from "./commands/tag.js";
import { registerUpdateCommand } from "./commands/update.js";

// Initialize logger with rfapps-specific environment variable
initLogger({ debugEnvVar: "RFAPPS_DEBUG" });

// Register rfapps-specific error formatters early, before any errors can occur
registerRfappsErrorFormatters();

// Create the main program
const program = new Command();
let activeStateLock: StateLock | undefined;

const ALWAYS_MUTATING_COMMANDS = new Set([
  "apply",
  "build",
  "delete",
  "deploy",
  "prune",
  "pull",
  "rebuild",
  "rollback",
  "stop",
]);

function resolveStateLockOperation(
  actionCommand: Command,
  globalOptions: Record<string, unknown>,
): string | undefined {
  if (globalOptions["dryRun"] === true) {
    return undefined;
  }

  const commandName = actionCommand.name();
  const parentName = actionCommand.parent?.name();
  const options = actionCommand.opts<Record<string, unknown>>();

  if (parentName === "drift") {
    return commandName === "reconcile" || commandName === "import"
      ? `drift-${commandName}`
      : undefined;
  }
  if (parentName === "state") {
    return commandName === "rebuild" && options["rewrite"] === true ? "state-rebuild" : undefined;
  }
  if (commandName === "backup" && parentName === "rfapps") {
    return "backup";
  }
  if (ALWAYS_MUTATING_COMMANDS.has(commandName)) {
    return commandName;
  }
  if (commandName === "plan" || commandName === "update") {
    return options["apply"] === true ? commandName : undefined;
  }
  if (commandName === "harden") {
    // Propose and --out are read-only; only --apply writes compose.yml, the
    // same shared resource `drift import` locks.
    return options["apply"] === true ? "harden" : undefined;
  }
  if (commandName === "reconcile") {
    return options["autoApply"] === true ? commandName : undefined;
  }
  if (commandName === "import") {
    return options["adopt"] === true ? commandName : undefined;
  }
  // `rfapps tag` (list/show/suggest) falls through to `undefined` and MUST keep
  // doing so: every subcommand is read-only, so taking the global state lock
  // would block a concurrent deploy for a pure inspection.
  //
  // That fall-through is positional, not nominal. `ALWAYS_MUTATING_COMMANDS` is
  // tested against the BARE subcommand name, after only the `drift` and `state`
  // parent branches above, so a future `tag` subcommand named `apply`, `build`,
  // `delete`, `deploy`, `prune`, `pull`, `rebuild`, `rollback`, or `stop` would
  // silently acquire the lock without anyone editing this function. Adding one
  // of those names means adding a `parentName === "tag"` branch here first.
  return undefined;
}

program
  .name("rfapps")
  .description("Docker orchestration CLI for rfmedia-apps")
  .version("0.1.0")
  .option("--dry-run", "Preview actions without executing", false)
  .option("--debug", "Enable debug output", false)
  .option("--json", "Output in JSON format", false)
  .option("-v, --verbose", "Show detailed output", false)
  .option("-y, --yes", "Skip confirmation prompts", false)
  .option("--use-dotenvx <file>", "Use dotenvx for secrets injection (specify env file path)")
  .option("--use-op <file>", "Use 1Password CLI for secrets injection (specify env file path)")
  .addOption(
    new Option("--output <format>", "Output format (json, yaml, csv, table, text)")
      .choices(OUTPUT_FORMATS)
      .default("text"),
  )
  .addHelpText(
    "after",
    `
Exit codes:
  0  Success
  1  Operational error
  2  Usage error
  3  Partial success`,
  )
  // Pre-action hook runs before every command
  // Used to configure logger state and validate env tool options
  .hook("preAction", async (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    if (opts["debug"] === true) {
      setDebugMode(true);
    }

    // Reconcile --json and --output flags
    const jsonFlag = opts["json"] === true;
    const outputFlag = opts["output"] as string;
    const commandName = actionCommand.name();

    // Determine if --output was explicitly passed (not just the default)
    const outputExplicitlySet = thisCommand.getOptionValueSource("output") === "cli";

    if (jsonFlag && outputExplicitlySet) {
      // Both --json and --output passed: --output takes precedence
      const resolvedFormat = outputFlag as OutputFormat;
      if (resolvedFormat !== "json") {
        logWarn("Both --json and --output were specified; --output takes precedence.");
      }
      opts["output"] = resolvedFormat;
    } else if (jsonFlag && !outputExplicitlySet) {
      // Only --json passed (without --output): set output to "json"
      opts["output"] = "json";
    }
    // If only --output passed (without --json), use the specified format (already set)

    const resolvedOutput = opts["output"];

    // Validate the format value
    if (!isValidOutputFormat(resolvedOutput)) {
      throw new InvalidArgumentError("--output", String(resolvedOutput), "Invalid output format", [
        ...OUTPUT_FORMATS,
      ]);
    }
    const resolvedOutputFormat = resolvedOutput;
    const parentName = actionCommand.parent?.name();
    const backupVerify = parentName === "backup" && commandName === "verify";

    if (commandName === "backup" && parentName === "rfapps") {
      validateBackupCreateOptions(
        actionCommand.opts(),
        {
          dryRun: opts["dryRun"] as boolean | undefined,
          json: opts["json"] as boolean | undefined,
          output: resolvedOutputFormat,
          yes: opts["yes"] as boolean | undefined,
        },
        process.stdin.isTTY === true,
      );
    } else if (backupVerify) {
      validateBackupVerifyOptions(actionCommand.args[0] ?? "", {
        json: opts["json"] as boolean | undefined,
        output: resolvedOutputFormat,
      });
    }

    if (commandName === "harden") {
      // Reject incoherent write-mode combinations before the state lock is
      // taken; `executeHarden` repeats the check for embedded registrars.
      validateHardenOptions(actionCommand.opts(), {
        dryRun: opts["dryRun"] as boolean | undefined,
        json: opts["json"] as boolean | undefined,
        output: resolvedOutputFormat,
        yes: opts["yes"] as boolean | undefined,
      });
    }

    if (parentName === "tag") {
      // `rfapps tag` is read-only and takes no lock, but its usage errors are
      // raised here for the same reason harden's and backup's are: before any
      // config or compose I/O runs. `tag list` has nothing to validate.
      if (commandName === "show") {
        validateTagShowOptions(actionCommand.opts());
      } else if (commandName === "suggest") {
        validateTagSuggestOptions(actionCommand.opts());
      }
    }

    // Reject a malformed --tag pattern before the state lock is acquired at the
    // bottom of this hook. The collector in lib/command-options.ts deliberately
    // cannot throw -- Commander v14 calls process.exit(1) when an argParser
    // raises, before .action() runs, which bypasses handleCliError, the
    // registered formatters, and the exit-code contract -- so this is the first
    // point at which a bad pattern can fail as a real usage error. `applyTagAxis`
    // re-parses downstream and stays the authoritative check, since it also
    // covers the action-layer callers that never pass through this hook.
    const tagPatterns = actionCommand.opts()["tag"] as string[] | undefined;
    for (const pattern of tagPatterns ?? []) {
      parseTagTerm(pattern);
    }

    if (
      commandName === "deploy" &&
      actionCommand.opts()["validateFirst"] === true &&
      resolvedOutputFormat === "csv"
    ) {
      throw new InvalidArgumentError(
        "--output",
        "csv",
        "CSV output is not supported with --validate-first",
        ["json", "yaml", "table", "text"],
      );
    }

    if (commandName === "deploy") {
      const deployOpts = actionCommand.opts();
      const rawBatchSize: unknown = deployOpts["batchSize"];
      const rawOnFailure: unknown = deployOpts["onFailure"];
      const staged = deployOpts["staged"] === true;

      if (!staged && (rawBatchSize !== undefined || rawOnFailure !== undefined)) {
        // Report the flag the operator actually typed; naming --batch-size for a
        // lone --on-failure points at an option that never appeared in the argv.
        const suppliedFlag = rawBatchSize !== undefined ? "--batch-size" : "--on-failure";
        throw new InvalidArgumentError(
          suppliedFlag,
          String(rawBatchSize ?? rawOnFailure),
          "Staged rollout options require --staged",
        );
      }
      if (rawBatchSize !== undefined && !/^[1-9][0-9]*$/.test(String(rawBatchSize))) {
        throw new InvalidArgumentError(
          "--batch-size",
          String(rawBatchSize),
          "Batch size must be a positive integer",
        );
      }
      // Interactive multi-select can still supply a target, so reject only when
      // it cannot run -- the same conditions `shouldShowInteractiveSelection`
      // uses. `executeDeploy` re-checks on the RESOLVED service list, which is
      // the authoritative gate; this one just fails fast before any Docker work.
      //
      // `hasExplicitSelector` is the single definition of "a target was named",
      // shared with the resolver and the interactive check, so --tag counts as a
      // target here for free. It also narrows one pre-existing behavior:
      // `--services ""` used to pass this gate on `!== undefined` alone despite
      // splitting to zero service names, which suppressed the preflight for a
      // selector that resolves to nothing. It is now correctly treated as absent.
      const hasServiceTarget = hasExplicitSelector(deployOpts);
      const interactiveTargetPossible =
        process.stdin.isTTY === true && resolvedOutputFormat !== "json" && opts["yes"] !== true;
      if (staged && !hasServiceTarget && !interactiveTargetPossible) {
        throw new InvalidArgumentError(
          "--staged",
          "true",
          "staged rollout requires an explicit service target; pass -g <group>, --services a,b,c, or -s <service>",
        );
      }
    }

    // For the init command, only call setOutputFormat when the global --json or --output
    // flags are used. The init command has its own local --json flag that means
    // "generate JSON config file" and should not trigger log suppression.
    if (commandName === "init") {
      // Only activate output format if the global --output was explicitly set
      // or the global --json flag was used (not init's local --json)
      if (outputExplicitlySet) {
        setOutputFormat(resolvedOutputFormat);
      } else if (jsonFlag) {
        // When init is running, the --json flag is ambiguous (global vs local).
        // Since init merges options, we let the existing setJsonMode handle it
        // only if the user explicitly intended global JSON output.
        // The init command's local --json controls config format, not output format.
        // Do NOT call setOutputFormat here for init's local --json.
      }
    } else {
      // For all other commands, apply the resolved output format
      if (jsonFlag && !outputExplicitlySet) {
        // --json without --output: use legacy setJsonMode for backwards compatibility
        setJsonMode(true);
      } else if (resolvedOutputFormat !== "text") {
        // --output with a non-default format: use the new setOutputFormat
        setOutputFormat(resolvedOutputFormat);
      }
    }

    // Validate secrets injection options (--use-dotenvx and --use-op are mutually exclusive)
    const useDotenvx = opts["useDotenvx"] as string | undefined;
    const useOp = opts["useOp"] as string | undefined;

    // Mutual exclusion check
    if (!backupVerify && useDotenvx !== undefined && useOp !== undefined) {
      throw new InvalidArgumentError(
        "secrets-provider",
        "both",
        "Cannot use --use-dotenvx and --use-op simultaneously",
        ["--use-dotenvx", "--use-op"],
      );
    }

    // Validate tool availability when option is used
    if (!backupVerify && useDotenvx !== undefined) {
      const { checkDotenvx, envFileExists } = await import("./lib/env-tools.js");
      const toolCheck = await checkDotenvx();
      if (!toolCheck.available) {
        throw new InvalidArgumentError(
          "--use-dotenvx",
          "true",
          toolCheck.error ?? "dotenvx is not installed",
        );
      }
      const fileExists = await envFileExists(useDotenvx);
      if (!fileExists) {
        throw new EnvFileNotFoundError("--use-dotenvx", useDotenvx);
      }
    }

    if (!backupVerify && useOp !== undefined) {
      const { checkOp, envFileExists } = await import("./lib/env-tools.js");
      const toolCheck = await checkOp();
      if (!toolCheck.available) {
        throw new InvalidArgumentError(
          "--use-op",
          "true",
          toolCheck.error ?? "1Password CLI is not installed",
        );
      }
      const fileExists = await envFileExists(useOp);
      if (!fileExists) {
        throw new EnvFileNotFoundError("--use-op", useOp);
      }
    }

    const lockOperation = resolveStateLockOperation(actionCommand, opts);
    if (lockOperation !== undefined) {
      activeStateLock = await acquireStateLock({ operation: lockOperation });
    }
  });

// Status command
//
// `status` opts out of -g/--group and --no-sidecars: it never runs the resolver
// pipeline, post-filtering a bare `docker ps` on container names instead, so it
// can honor neither a group axis nor sidecar linking.
addServiceTargetOptions(program.command("status").description("Show status of Docker services"), {
  group: false,
  sidecars: false,
})
  .option("-a, --all", "Show all services (including stopped)", false)
  .option("--health", "Show health status", false)
  .option("--stats", "Show resource statistics", false)
  .option("--logs", "Show recent logs", false)
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .action(async (options) => {
    const { executeStatus } = await import("./actions/status.js");
    await executeStatus(options, program.opts());
  });

// Health command
addServiceTargetOptions(program.command("health").description("Check service dependency readiness"))
  .option(
    "--wait-for-ready",
    "Wait for dependencies to become ready (disable with --no-wait-for-ready)",
  )
  .option("--no-wait-for-ready", "Return immediate dependency readiness snapshot")
  .option("--health-timeout <seconds>", "Health check timeout")
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .action(async (options) => {
    const { executeHealth } = await import("./actions/health.js");
    await executeHealth(options, program.opts());
  });

registerAuditCommand(program);
registerBackupCommand(program);
registerDoctorCommand(program);
registerForceUnlockCommand(program);
registerImportCommand(program);
registerReconcileCommand(program);
registerStateCommand(program);
registerTagCommand(program);
registerUpdateCommand(program);

// Pull command
addServiceTargetOptions(program.command("pull").description("Pull Docker images"))
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .action(async (options) => {
    const { executePull } = await import("./actions/pull.js");
    await executePull(options, program.opts());
  });

// Build command
addServiceTargetOptions(
  program.command("build").description("Build Docker containers (pull + build)"),
)
  .option("--skip-pull", "Skip pulling images before building", false)
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .action(async (options) => {
    const { executeBuild } = await import("./actions/build.js");
    await executeBuild(options, program.opts());
  });

// Deploy command
addServiceTargetOptions(
  program.command("deploy").description("Deploy Docker services (pull + start)"),
)
  .option("--skip-pull", "Skip pulling images before deploying", false)
  .option("--force-recreate", "Force recreate containers even if unchanged", false)
  .option("--validate-first", "Validate Docker resource conflicts before deploying", false)
  .option("--scan", "Scan resolved images for known vulnerabilities", false)
  .option("--scanner <name>", "Scanner backend: trivy, grype")
  .option(
    "--scan-fail-on <severity>",
    "Block at or above severity: none, unknown, negligible, low, medium, high, critical",
  )
  .option(
    "--allow-partial",
    "Exit 3 instead of 1 when a grouped or multi-service deploy partially succeeds",
    false,
  )
  .option("--parallel", "Execute operations in parallel using dependency phases")
  .option("--workers <count>", "Maximum concurrent workers for parallel execution")
  .option("--staged", "Roll out services in dependency-ordered batches with a health gate")
  .option("--batch-size <count>", "Services per staged batch")
  .addOption(
    new Option("--on-failure <policy>", "Staged batch failure policy").choices([
      "halt",
      "continue",
    ]),
  )
  .option(
    "--wait-for-ready",
    "Wait for dependencies to become ready after startup (disable with --no-wait-for-ready)",
  )
  .option("--no-wait-for-ready", "Skip dependency readiness waiting after startup")
  .option("--health-timeout <seconds>", "Health check timeout")
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .addHelpText(
    "after",
    `
Exit codes:
  0  Success
  1  Operational error
  2  Usage error
  3  Partial success with --allow-partial

Staged rollout:
  Requires an explicit service target (-s, --services, or -g); --staged without
  one is a usage error rather than an unstaged fleet deploy. Batches are gated on
  the health of the services they just deployed. A failed batch halts the rollout
  by default; services in later batches are reported as not attempted and keep
  running their previous containers. Staged mode always uses dependency-phased
  execution, even when parallel execution is disabled in config.

Vulnerability scanning:
  Pass --scan to resolve the targeted images and scan each distinct image with
  trivy or grype, which must already be installed. The gate runs after conflict
  validation and before the confirmation prompt, so a blocked deploy never pulls
  an image or touches a container. Findings at or above --scan-fail-on block the
  deploy and exit 1; a scan that cannot complete is inconclusive and blocks the
  same way unless --scan-fail-on is none. Under --dry-run the report is printed,
  the gate is reported as would-block, and the exit code stays 0.`,
  )
  .action(async (options) => {
    const { executeDeploy } = await import("./actions/deploy.js");
    await executeDeploy(options, program.opts());
  });

// Stop command
addServiceTargetOptions(program.command("stop").description("Stop Docker services"))
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .action(async (options) => {
    const { executeStop } = await import("./actions/stop.js");
    await executeStop(options, program.opts());
  });

// Rebuild command
addServiceTargetOptions(
  program.command("rebuild").description("Rebuild Docker services (stop + build + start)"),
)
  .option("--skip-pull", "Skip pulling images before rebuilding", false)
  .option("--parallel", "Execute operations in parallel using dependency phases")
  .option("--workers <count>", "Maximum concurrent workers for parallel execution")
  .option(
    "--wait-for-ready",
    "Wait for dependencies to become ready after startup (disable with --no-wait-for-ready)",
  )
  .option("--no-wait-for-ready", "Skip dependency readiness waiting after startup")
  .option("--health-timeout <seconds>", "Health check timeout")
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .action(async (options) => {
    const { executeRebuild } = await import("./actions/rebuild.js");
    await executeRebuild(options, program.opts());
  });

// Delete command
addServiceTargetOptions(
  program.command("delete").description("Delete Docker services (stop + remove)"),
)
  .option("--volumes", "Also remove volumes", false)
  .option("--images", "Also remove images", false)
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .action(async (options) => {
    const { executeDelete } = await import("./actions/delete.js");
    await executeDelete(options, program.opts());
  });

// Prune command
addServiceTargetOptions(program.command("prune").description("Prune Docker resources"))
  .option("--images", "Also prune images", false)
  .option("--volumes", "Also prune volumes", false)
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .action(async (options) => {
    const { executePrune } = await import("./actions/prune.js");
    await executePrune(options, program.opts());
  });

// Plan command
addServiceTargetOptions(
  program.command("plan").description("Generate deployment plan showing what will change"),
)
  .option("--apply", "Immediately apply the plan after generation", false)
  .option("-o, --out <path>", "Custom plan output path")
  .option("--show-unchanged", "Show unchanged services in output", false)
  .option("--check-updates", "Check registry for newer image versions", false)
  .option("--explain", "Annotate changes with likely cause and dependency impact", false)
  .option("--scan", "Scan resolved images for known vulnerabilities", false)
  .option("--scanner <name>", "Scanner backend: trivy, grype")
  .option(
    "--scan-fail-on <severity>",
    "Block at or above severity: none, unknown, negligible, low, medium, high, critical",
  )
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .addHelpText(
    "after",
    `
Exit codes:
  0  Success
  1  Operational error
  2  Usage error

Vulnerability scanning:
  Pass --scan to resolve the targeted images and scan each distinct image with
  trivy or grype, which must already be installed. The plan file is written
  before the gate runs, so a blocked plan is still saved as evidence. Findings
  at or above --scan-fail-on exit 1 and suppress --apply; run rfapps apply
  <plan-file> to override. A scan that cannot complete is inconclusive and
  blocks the same way unless --scan-fail-on is none. --dry-run generates no
  plan, so it scans nothing.`,
  )
  .action(async (options) => {
    const { executePlan } = await import("./actions/plan.js");
    await executePlan(options, program.opts());
  });

registerDriftCommand(program);

// Lint command
addServiceTargetOptions(
  program
    .command("lint")
    .description("Check compose configuration for production-readiness issues"),
)
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .option("--json", "Output findings in JSON format", false)
  .option("--sarif", "Output findings in SARIF 2.1.0 format", false)
  .option("--runtime", "Include runtime drift findings from running containers", false)
  .option("--list-rules", "List available lint rules and exit", false)
  .option(
    "--fail-on <severity>",
    "Exit with error when findings meet or exceed severity (none, info, warn, error)",
    "error",
  )
  .addHelpText(
    "after",
    `
Exit codes:
  0  Success
  1  Operational error
  2  Usage error`,
  )
  .action(async (options) => {
    const { executeLint } = await import("./actions/lint.js");
    await executeLint(options, program.opts());
  });

registerHardenCommand(program);

// Apply command
program
  .command("apply")
  .description("Apply a saved deployment plan")
  .argument("<plan-file>", "Path to plan file")
  .option("--force", "Apply even if plan is stale", false)
  .action(async (planFile, options) => {
    const { executeApply } = await import("./actions/apply.js");
    await executeApply({ planFile, ...options }, program.opts());
  });

// History command
program
  .command("history")
  .description("Show deployment history or generation snapshots for services")
  .option("-s, --service <name>", "Filter by service name")
  .option("--limit <n>", "Number of entries to show", "10")
  .option("--since <date>", "Show entries after this date")
  .option("--action <type>", "Filter by action type")
  .option("--generations", "Show immutable generation snapshots instead of raw history", false)
  .action(async (options) => {
    if (options.generations) {
      const { executeGenerations } = await import("./actions/generations.js");
      await executeGenerations(options, program.opts());
      return;
    }
    const { executeHistory } = await import("./actions/history.js");
    await executeHistory(options, program.opts());
  });

// Rollback command
program
  .command("rollback")
  .description("Rollback or restore a service to a previous deployment or generation")
  .requiredOption("-s, --service <name>", "Service to rollback")
  .option("--steps <n>", "Number of deployments to rollback (default: 1)")
  .option("--to-deployment <id>", "Rollback to specific deployment ID")
  .option("--to-generation <n>", "Restore to a specific generation number")
  .option("--to-time <timestamp>", "Restore to the generation active at this time (ISO 8601)")
  .option("--force", "Skip validation warnings", false)
  .action(async (options) => {
    const { executeRollback } = await import("./actions/rollback.js");
    await executeRollback(options, program.opts());
  });

// Init command
program
  .command("init")
  .description("Generate configuration file from compose.yml")
  .option("-g, --global", "Write to global config (~/.rfapps.yaml)", false)
  .option("--json", "Generate JSON config instead of YAML", false)
  .option("-f, --force", "Overwrite existing config file", false)
  .action(async (options) => {
    const { executeInit } = await import("./actions/init.js");
    await executeInit({ ...options, ...program.opts() });
  });

// Validate command
program
  .command("validate")
  .description("Validate configuration against compose.yml")
  .option("-f, --compose <path>", "Path to Docker Compose file")
  .option("-e, --env-file <path>", "Path to environment file")
  .action(async (rawOptions) => {
    const { executeValidate } = await import("./actions/validate.js");
    const globalOpts = program.opts();
    // Transform commander options to match expected interface
    await executeValidate({
      // Global options
      dryRun: (globalOpts["dryRun"] as boolean | undefined) ?? false,
      debug: (globalOpts["debug"] as boolean | undefined) ?? false,
      json: (globalOpts["json"] as boolean | undefined) ?? false,
      verbose: (globalOpts["verbose"] as boolean | undefined) ?? false,
      yes: (globalOpts["yes"] as boolean | undefined) ?? false,
      useDotenvx: globalOpts["useDotenvx"] as string | undefined,
      useOp: globalOpts["useOp"] as string | undefined,
      // Command-specific options
      composePath: rawOptions.compose as string | undefined,
      envFile: rawOptions.envFile as string | undefined,
    });
  });

// Completion command
program
  .command("completion")
  .description("Generate shell completion scripts")
  .argument("[shell]", "Target shell (bash, zsh, fish)")
  .option("-s, --shell <shell>", "Target shell")
  .option("--install", "Install completion script to shell configuration", false)
  .option("--force", "Skip confirmation prompts during installation", false)
  .action(async (shell, options) => {
    const { executeCompletion } = await import("./actions/completion.js");
    await executeCompletion(shell ?? options.shell, options);
  });

// MCP server command
program
  .command("mcp")
  .description("Run the rfapps MCP server over stdio")
  .action(async () => {
    const { runRfappsMcpServer } = await import("./mcp/server.js");
    runRfappsMcpServer();
  });

// Parse arguments and run with graceful error handling
function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || stream.writableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}

async function flushTerminalOutput(): Promise<void> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

async function main(): Promise<void> {
  let pendingError: unknown;
  let hasPendingError = false;

  try {
    program.exitOverride();
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === ExitCode.Success) {
      process.exitCode = ExitCode.Success;
    } else if (error instanceof CommanderError) {
      process.exitCode = ExitCode.UsageError;
    } else {
      pendingError = error;
      hasPendingError = true;
    }
  } finally {
    if (activeStateLock !== undefined) {
      try {
        await activeStateLock.release();
      } catch (error) {
        pendingError = hasPendingError
          ? new AggregateError(
              [pendingError, error],
              "rfapps command failed and the state lock could not be released",
            )
          : error;
        hasPendingError = true;
      } finally {
        activeStateLock = undefined;
      }
    }
  }

  if (hasPendingError) {
    handleCliError(pendingError);
  }
  await flushTerminalOutput();
  const deferredSignal = takeDeferredSignal();
  if (deferredSignal !== undefined) {
    process.kill(process.pid, deferredSignal);
  }
}

main();
