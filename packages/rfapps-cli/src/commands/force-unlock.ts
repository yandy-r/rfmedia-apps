import type { Command } from "commander";

import type { ForceUnlockGlobalOptions, ForceUnlockResult } from "../actions/force-unlock.js";

type ExecuteForceUnlock = (options: ForceUnlockGlobalOptions) => Promise<ForceUnlockResult>;

export interface ForceUnlockCommandDependencies {
  loadAction(): Promise<{ executeForceUnlock: ExecuteForceUnlock }>;
}

const defaultDependencies: ForceUnlockCommandDependencies = {
  loadAction: () => import("../actions/force-unlock.js"),
};

export function registerForceUnlockCommand(
  program: Command,
  dependencies: ForceUnlockCommandDependencies = defaultDependencies,
): void {
  program
    .command("force-unlock")
    .description("Dangerously remove the active rfapps state lock")
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Danger: force-unlock can allow concurrent mutations and corrupt deployment state.
Use it only after verifying that no rfapps mutation is still active. Global
--yes skips confirmation; machine-format output requires --yes.`,
    )
    .action(async () => {
      const { executeForceUnlock } = await dependencies.loadAction();
      await executeForceUnlock(program.opts());
    });
}
