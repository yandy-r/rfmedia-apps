import type { Command } from "commander";

import { addServiceTargetOptions } from "../lib/command-options.js";
import { InvalidArgumentError } from "../lib/errors.js";

interface UpdateCommandOptions {
  service?: string;
  services?: string;
  group?: string;
  /** Hierarchical tag patterns (`--tag`), one entry per occurrence. Never defaulted to `[]`. */
  tag?: string[];
  sidecars?: boolean;
  apply?: boolean;
  fromPlan?: string;
  out?: string;
  restoreOnFailure?: boolean;
  healthTimeout?: string;
  compose?: string;
  envFile?: string;
  profile?: string;
}

function validateUpdateOptions(options: UpdateCommandOptions): void {
  if (options.fromPlan === undefined) return;

  const conflicts = [
    options.service === undefined ? undefined : "--service",
    options.services === undefined ? undefined : "--services",
    options.group === undefined ? undefined : "--group",
    // Without --tag here, `update --from-plan reviewed.json --tag "media/**" --apply`
    // silently re-scopes a frozen, reviewed plan on a command that holds the global state
    // lock and recreates containers.
    options.tag === undefined ? undefined : "--tag",
    options.compose === undefined ? undefined : "--compose",
    options.profile === undefined ? undefined : "--profile",
    options.sidecars === false ? "--no-sidecars" : undefined,
  ].filter((option): option is string => option !== undefined);

  if (conflicts.length > 0) {
    throw new InvalidArgumentError(
      "--from-plan",
      options.fromPlan,
      `Cannot change reviewed scope with --from-plan (${conflicts.join(", ")})`,
    );
  }
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command("update")
    .description("Preview and apply verified Docker image updates")
    .configureHelp({ showGlobalOptions: true });

  // Replaces the hand-written -s/--service, --services, -g/--group and --no-sidecars
  // block. Commander throws on a duplicate flag at registration time, which kills every
  // rfapps invocation, so this must replace those declarations rather than join them.
  addServiceTargetOptions(update);

  update
    .option("--apply", "Apply the reviewed image update plan after confirmation", false)
    .option("--from-plan <path>", "Load a saved managed update plan")
    .option("-o, --out <path>", "Write the preview plan or final update report")
    .option(
      "--no-restore-on-failure",
      "Continue without automatic exact-image restore if verification fails",
    )
    .option("--health-timeout <seconds>", "Target verification timeout in seconds")
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .addHelpText(
      "after",
      `
Preview-first: bare invocation checks registry image identities, saves a managed
plan, and does not mutate containers. Use --apply to authorize sequential updates;
global --dry-run keeps --apply preview-only, and global --yes skips confirmation.

Recovery is image-only under the current Compose configuration. It restores the
exact prior daemon-local image, not volumes, databases, data, or migrations.

Exit codes:
  0  Preview/no updates completed, or every applied update was verified
  1  Detection, update, verification, or restore failure (including verified restore)
  2  Invalid arguments or managed plan`,
    )
    .action(async (options: UpdateCommandOptions) => {
      validateUpdateOptions(options);
      const { executeUpdate } = await import("../actions/update.js");
      await executeUpdate(options, program.opts());
    });
}
