/**
 * Shared Commander option declarations for service-targeting commands.
 *
 * Every command that targets services shares the same selector surface
 * (`-s/--service`, `--services`, `-g/--group`, `--tag`, `--no-sidecars`). This
 * module is the single place those flags are declared so their names, ordering,
 * and description strings stay byte-identical across `cli.ts` and every
 * registrar in `src/commands/` — the shell-completion parity extractors in
 * `src/actions/completion.ts` compare live Commander option sets against the
 * hand-maintained completion scripts, and a drifting description or a reordered
 * flag breaks that comparison.
 */

import type { Command } from "commander";

/**
 * Which optional selector flags a command can honor.
 *
 * Both default to enabled; pass `false` for a command that structurally cannot
 * support the flag. `status`, for example, resolves services directly from
 * `docker compose ps` rather than through the resolver pipeline, so it has
 * neither a group axis nor sidecar linking.
 */
export interface ServiceTargetOptionsConfig {
  /** Declare `-g, --group <name>`. Default: `true`. */
  group?: boolean;
  /** Declare `--no-sidecars`. Default: `true`. */
  sidecars?: boolean;
}

/**
 * Declare the shared service-targeting flags on `command`.
 *
 * Emitted long-option order is `--service`, `--services`, `--group`, `--tag`,
 * `--no-sidecars`. That order is asserted by `src/commands/reconcile.spec.ts`,
 * so new flags must be appended by the caller rather than spliced in here.
 *
 * **Replace, do not append.** Commander rejects a duplicate flag at
 * registration time — declaring `-s, --service` twice raises
 * `Cannot add option '-s, --service <n>' … due to conflicting flag '--service'`
 * as the command tree is built, which kills every `rfapps` invocation, not just
 * the affected command. A caller adopting this helper must delete the
 * hand-written `.option()` lines it replaces.
 *
 * `--tag` is long-only (no short form) and is declared with a pure collector
 * and **no default value**: `commands/update.ts` and `commands/backup.ts` build
 * mutually-exclusive-flag lists with `options.X === undefined ? undefined : "--X"`,
 * so an `[]` default would make `--tag` look permanently present. The collector
 * also never raises — Commander v14 exits the process from an `argParser`
 * failure before `.action()` runs, bypassing `handleCliError`, the registered
 * error formatters, and the exit-code contract. All `--tag` pattern validation
 * happens later, in the `cli.ts` preAction hook or in `applyTagAxis`.
 *
 * @param command - The Commander command to declare the flags on
 * @param opts - Which optional flags this command can honor
 * @returns The same `command`, for chaining
 */
export function addServiceTargetOptions(
  command: Command,
  opts?: ServiceTargetOptionsConfig,
): Command {
  command
    .option("-s, --service <name>", "Target a specific service")
    .option("--services <names>", "Target multiple services (comma-separated)");

  if (opts?.group !== false) {
    command.option("-g, --group <name>", "Target a service group");
  }

  command.option(
    "--tag <pattern>",
    "Narrow targets by hierarchical tag pattern (repeatable)",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  );

  if (opts?.sidecars !== false) {
    command.option("--no-sidecars", "Disable automatic sidecar linking");
  }

  return command;
}
