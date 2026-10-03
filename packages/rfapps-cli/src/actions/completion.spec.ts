import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dependencyMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  homedir: vi.fn(() => "/home/test"),
  logInfo: vi.fn(),
  logSuccess: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  outputFormattedError: vi.fn(),
}));

// `readFile` is never called by the completion action; it is here because `completion.ts`
// imports the tag guards from `lib/tags/tag-index.js`, which re-exports `findClosestTag` and
// so transitively loads `tag-config-layers.ts` -> `node:fs/promises`. A factory that omits it
// fails at import time, not at call time.
vi.mock("node:fs/promises", () => ({
  mkdir: dependencyMocks.mkdir,
  writeFile: dependencyMocks.writeFile,
  readFile: dependencyMocks.readFile,
}));
vi.mock("node:os", () => ({ homedir: dependencyMocks.homedir }));
vi.mock("@rfmedia/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rfmedia/common")>()),
  logInfo: dependencyMocks.logInfo,
  logSuccess: dependencyMocks.logSuccess,
  logDebug: dependencyMocks.logDebug,
  logWarn: dependencyMocks.logWarn,
  outputFormattedError: dependencyMocks.outputFormattedError,
}));
// Same reason as the `node:fs/promises` factory above: `lib/tags/tag-index.ts` imports
// `listConfigLayerPaths` from this module for `getTagIndex`, which the completion action never
// calls but ESM still resolves at import time.
vi.mock("../lib/config.js", () => ({
  loadConfig: vi.fn(),
  listConfigLayerPaths: vi.fn(() => []),
}));

import { registerReconcileCommand } from "../commands/reconcile.js";
import { registerImportCommand } from "../commands/import.js";
import { registerStateCommand } from "../commands/state.js";
import { registerBackupCommand } from "../commands/backup.js";
import { registerHardenCommand } from "../commands/harden.js";
import { registerTagCommand } from "../commands/tag.js";
import { ConfigNotFoundError, InvalidArgumentError } from "../lib/errors.js";
import { loadConfig } from "../lib/config.js";
import { buildTagIndex } from "../lib/tags/tag-index.js";
import type { RfappsConfig } from "../types/index.js";
import { executeCompletion } from "./completion.js";

const shells = ["bash", "zsh", "fish"] as const;
const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));

const mockConfig: RfappsConfig = {
  composePath: "compose.yml",
  envFile: ".env",
  profiles: {
    defaultProfile: "core",
    validProfiles: ["core", "all"],
    mapping: {
      traefik: "core",
      plex: "media",
      sonarr: "arr-stack",
      radarr: "arr-stack",
    },
  },
  sidecars: { enabled: true, mapping: {} },
  groups: { core: ["traefik"] },
  // Service-keyed, exactly like profiles.mapping: the completion scripts must
  // interpolate the VALUES (ancestor-closed), never these keys.
  tags: {
    mapping: {
      traefik: ["infrastructure/core/networking"],
      plex: ["media/streaming"],
      sonarr: ["media/automation/arr"],
    },
  },
  healthCheck: { timeout: 30, interval: 5, retries: 3, waitForReady: true },
  envTool: { tool: "none" },
  docker: {},
  interactive: { pageSize: 10 },
  state: { enabled: true },
  parallel: { enabled: false, workers: 4 },
};

function getReconcileCommand(): Command {
  const program = new Command();
  registerReconcileCommand(program, {
    loadAction: async () => ({ executeReconcile: async () => {} }),
  });
  const command = program.commands.find((candidate) => candidate.name() === "reconcile");
  if (command === undefined) throw new Error("reconcile command was not registered");
  return command;
}

function getImportCommand(): Command {
  const program = new Command();
  registerImportCommand(program, {
    loadAction: async () => ({ executeImport: async () => {} }),
  });
  const command = program.commands.find((candidate) => candidate.name() === "import");
  if (command === undefined) throw new Error("import command was not registered");
  return command;
}

function getStateRebuildCommand(): Command {
  const program = new Command();
  registerStateCommand(program, {
    loadRebuildAction: async () => ({ executeStateRebuild: async () => {} }),
    loadExportAction: async () => ({ executeStateExport: async () => {} }),
  });
  const group = program.commands.find((candidate) => candidate.name() === "state");
  if (group === undefined) throw new Error("state command was not registered");
  const command = group.commands.find((candidate) => candidate.name() === "rebuild");
  if (command === undefined) throw new Error("state rebuild command was not registered");
  return command;
}

function getBackupCommands(): { create: Command; verify: Command } {
  const program = new Command();
  registerBackupCommand(program, {
    loadCreateAction: async () => ({ executeBackup: async () => {} }),
    loadVerifyAction: async () => ({ executeBackupVerify: async () => {} }),
  });
  const create = program.commands.find((candidate) => candidate.name() === "backup");
  if (create === undefined) throw new Error("backup command was not registered");
  const verify = create.commands.find((candidate) => candidate.name() === "verify");
  if (verify === undefined) throw new Error("backup verify command was not registered");
  return { create, verify };
}

function getHardenCommand(): Command {
  const program = new Command();
  registerHardenCommand(program, {
    loadAction: async () => ({ executeHarden: async () => {} }),
  });
  const command = program.commands.find((candidate) => candidate.name() === "harden");
  if (command === undefined) throw new Error("harden command was not registered");
  return command;
}

function getTagSubcommands(): { list: Command; show: Command; suggest: Command } {
  const program = new Command();
  registerTagCommand(program, {
    loadInspectActions: async () => ({
      executeTagList: async () => {},
      executeTagShow: async () => {},
    }),
    loadSuggestAction: async () => ({ executeTagSuggest: async () => {} }),
  });
  const group = program.commands.find((candidate) => candidate.name() === "tag");
  if (group === undefined) throw new Error("tag command was not registered");
  const find = (name: string): Command => {
    const command = group.commands.find((candidate) => candidate.name() === name);
    if (command === undefined) throw new Error(`tag ${name} command was not registered`);
    return command;
  };
  return { list: find("list"), show: find("show"), suggest: find("suggest") };
}

function getCommanderLongOptions(command: Command): string[] {
  return command.options
    .map((option) => option.long?.replace(/^--/, ""))
    .filter((option): option is string => option !== undefined)
    .sort();
}

const IMPORT_FISH_GUARD =
  "__fish_seen_subcommand_from import; and not __fish_seen_subcommand_from drift";

const STATE_REBUILD_FISH_GUARD =
  "__fish_seen_subcommand_from state; and __fish_seen_subcommand_from rebuild";

const BACKUP_CREATE_FISH_GUARD =
  "__fish_seen_subcommand_from backup; and not __rfapps_seen_backup_verify";

const BACKUP_VERIFY_FISH_GUARD =
  "__fish_seen_subcommand_from backup; and __rfapps_seen_backup_verify";

// `show` is already taken by `drift show`, and fish matches a subcommand token
// anywhere on the line, so `tag show` carries the reciprocal exclusion.
const TAG_FISH_GUARDS = {
  list: "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from list",
  show: "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from drift",
  suggest: "__fish_seen_subcommand_from tag; and __fish_seen_subcommand_from suggest",
} as const;

const DRIFT_SHOW_FISH_GUARD =
  "__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from show; and not __fish_seen_subcommand_from tag";

function getTagSubcommandCompletionOptions(
  subcommand: keyof typeof TAG_FISH_GUARDS,
  shell: (typeof shells)[number],
  script: string,
): string[] {
  if (shell === "bash") {
    const options = script.match(new RegExp(`local tag_${subcommand}_opts="([^"]*)"`))?.[1];
    if (options === undefined) throw new Error(`bash tag ${subcommand} options were not generated`);
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    // Two-step, reusing both established shapes: the top-level `tag)` arm is
    // 8-space/10-space like every other command arm, and the subcommand arms
    // nested inside it are 16-space/18-space like `state rebuild`. Scoping to the
    // outer arm first is what disambiguates `tag show` from `drift show`, which
    // sits at the same nesting depth.
    const arm = script.match(/\n {8}tag\)\n([\s\S]*?)\n {10};;/)?.[1];
    if (arm === undefined) throw new Error("zsh tag arm was not generated");
    const section = arm.match(new RegExp(`\\n {16}${subcommand}\\)\\n([\\s\\S]*?)\\n {18};;`))?.[1];
    if (section === undefined) throw new Error(`zsh tag ${subcommand} options were not generated`);
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter((line) => line.includes(TAG_FISH_GUARDS[subcommand]))
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getImportCompletionOptions(shell: (typeof shells)[number], script: string): string[] {
  if (shell === "bash") {
    const options = script.match(/local import_opts="([^"]*)"/)?.[1];
    if (options === undefined) throw new Error("bash import options were not generated");
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    const section = script.match(/\n        import\)\n([\s\S]*?)\n          ;;/)?.[1];
    if (section === undefined) throw new Error("zsh import options were not generated");
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter((line) => line.includes(IMPORT_FISH_GUARD))
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getStateRebuildCompletionOptions(
  shell: (typeof shells)[number],
  script: string,
): string[] {
  if (shell === "bash") {
    const options = script.match(/local state_rebuild_opts="([^"]*)"/)?.[1];
    if (options === undefined) throw new Error("bash state rebuild options were not generated");
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    // The state rebuild arm is nested inside the `state)` case, so it is
    // indented 16 spaces with an 18-space `;;` (top-level arms use 8/10).
    const section = script.match(/\n {16}rebuild\)\n([\s\S]*?)\n {18};;/)?.[1];
    if (section === undefined) throw new Error("zsh state rebuild options were not generated");
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter((line) => line.includes(STATE_REBUILD_FISH_GUARD))
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getLongOptionNames(text: string): string[] {
  return [...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1] ?? "");
}

function getCommanderCommandOptions(command: "deploy" | "rebuild" | "plan"): string[] {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  delete env["NO_COLOR"];
  const help = execFileSync(process.execPath, ["--import", "tsx", cliPath, command, "--help"], {
    encoding: "utf8",
    env,
  });
  return [
    ...new Set(
      help
        .split("\n")
        .filter((line) => /^\s+-/.test(line))
        .flatMap((line) => getLongOptionNames(line))
        .filter((option) => option !== "help"),
    ),
  ].sort();
}

function getCommandCompletionOptions(
  command: "deploy" | "rebuild" | "plan" | "harden",
  shell: (typeof shells)[number],
  script: string,
): string[] {
  if (shell === "bash") {
    const options = script.match(new RegExp(`local ${command}_opts="([^"]*)"`))?.[1];
    if (options === undefined) throw new Error(`bash ${command} options were not generated`);
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    const section = script.match(
      new RegExp(`\\n        ${command}\\)\\n([\\s\\S]*?)\\n          ;;`),
    )?.[1];
    if (section === undefined) throw new Error(`zsh ${command} options were not generated`);
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter(
      (line) =>
        line.includes(`-n "__fish_seen_subcommand_from ${command}`) &&
        !line.includes("__fish_seen_subcommand_from state;"),
    )
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getReconcileCompletionOptions(shell: (typeof shells)[number], script: string): string[] {
  if (shell === "bash") {
    const options = script.match(/local reconcile_opts="([^"]*)"/)?.[1];
    if (options === undefined) throw new Error("bash reconcile options were not generated");
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    const section = script.match(/\n        reconcile\)\n([\s\S]*?)\n          ;;/)?.[1];
    if (section === undefined) throw new Error("zsh reconcile options were not generated");
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter((line) =>
      line.includes(
        "__fish_seen_subcommand_from reconcile; and not __fish_seen_subcommand_from drift",
      ),
    )
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getBackupCreateCompletionOptions(
  shell: (typeof shells)[number],
  script: string,
): string[] {
  if (shell === "bash") {
    const options = script.match(/local backup_opts="([^"]*)"/)?.[1];
    if (options === undefined) throw new Error("bash backup options were not generated");
    return getLongOptionNames(options);
  }
  if (shell === "zsh") {
    const section = script.match(
      /\n {10}else\n {12}_arguments -C \\\n([\s\S]*?)\n {14}'1: :->backup_command'/,
    )?.[1];
    if (section === undefined) throw new Error("zsh backup options were not generated");
    return getLongOptionNames(section);
  }
  return script
    .split("\n")
    .filter((line) => line.includes(BACKUP_CREATE_FISH_GUARD))
    .map((line) => line.match(/ -l ([a-z][a-z-]*)/)?.[1])
    .filter((option): option is string => option !== undefined);
}

function getBackupCompletionSubcommands(shell: (typeof shells)[number], script: string): string[] {
  if (shell === "bash") {
    const subcommands = script.match(/compgen -W "(verify)" -- "\$cur"/)?.[1];
    return subcommands === undefined ? [] : subcommands.split(" ");
  }
  if (shell === "zsh") {
    const subcommands = script.match(/backup_commands=\(\n([\s\S]*?)\n {10}\)/)?.[1];
    return subcommands === undefined
      ? []
      : [...subcommands.matchAll(/'([a-z][a-z-]*):/g)].map((match) => match[1] ?? "");
  }
  return script
    .split("\n")
    .filter(
      (line) =>
        line.includes(BACKUP_CREATE_FISH_GUARD) &&
        line.includes('-a "verify"') &&
        !line.includes(" -l "),
    )
    .map(() => "verify");
}

function getBackupVerifyClassifier(
  shell: (typeof shells)[number],
  script: string,
): {
  valueOptions: string[];
  inlineValueOptions: string[];
  consumesPendingValueBeforeClassification: boolean;
  stopsAtFirstPositional: boolean;
} {
  const classifier =
    shell === "bash"
      ? script.match(
          /  __rfapps_find_backup_subcommand\(\) \{\n([\s\S]*?)\n  \}\n\n  # Determine/,
        )?.[1]
      : shell === "zsh"
        ? script.match(/          __rfapps_find_backup_cmd\(\) \{\n([\s\S]*?)\n          \}/)?.[1]
        : script.match(/function __rfapps_seen_backup_verify\n([\s\S]*?)\nend\n\n# Commands/)?.[1];
  if (classifier === undefined) {
    throw new Error(`${shell} backup verify classifier was not generated`);
  }
  const valueOptionLine = classifier
    .split("\n")
    .find(
      (line) =>
        line.includes("--service") && line.includes("--use-op") && !line.includes("--service=*"),
    );
  const inlineValueOptionLine = classifier
    .split("\n")
    .find((line) => line.includes("--service=*") && line.includes("--use-op=*"));
  if (valueOptionLine === undefined || inlineValueOptionLine === undefined) {
    throw new Error(`${shell} backup value-option cases were not generated`);
  }

  const consumesPendingValueBeforeClassification =
    shell === "fish"
      ? /if test \$expect_value -eq 1\n\s+set expect_value 0\n\s+continue\n\s+end[\s\S]*switch "\$word"/.test(
          classifier,
        )
      : /if (?:\[\[ "\$expect_value" == "true" \]\]|\(\( expect_value \)\)); then\n\s+expect_value=(?:false|0)\n\s+continue\n\s+fi[\s\S]*case "\$word" in/.test(
          classifier,
        );
  const stopsAtFirstPositional =
    shell === "fish"
      ? /case verify\n\s+return 0\n\s+case '\*'\n\s+return 1/.test(classifier)
      : /\*\)\n\s+if \[\[ "\$word" == "verify" \]\]; then\n\s+echo "verify"\n\s+fi\n\s+return/.test(
          classifier,
        );

  return {
    valueOptions: getLongOptionNames(valueOptionLine).sort(),
    inlineValueOptions: getLongOptionNames(inlineValueOptionLine).sort(),
    consumesPendingValueBeforeClassification,
    stopsAtFirstPositional,
  };
}

async function render(shell: (typeof shells)[number]): Promise<string> {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  await executeCompletion(shell, { install: false });
  const script = logSpy.mock.calls[0]?.[0];
  logSpy.mockRestore();
  if (typeof script !== "string") throw new Error(`${shell} completion was not rendered`);
  return script;
}

describe("completion action", () => {
  const originalShell = process.env["SHELL"];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockResolvedValue(mockConfig);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env["SHELL"] = originalShell;
    process.exitCode = undefined;
  });

  it("renders the complete command, configuration, and global option surface for every shell", async () => {
    const commands = [
      "status",
      "health",
      "pull",
      "build",
      "deploy",
      "stop",
      "rebuild",
      "delete",
      "prune",
      "plan",
      "update",
      "reconcile",
      "import",
      "backup",
      "apply",
      "history",
      "rollback",
      "drift",
      "lint",
      "audit",
      "harden",
      "doctor",
      "force-unlock",
      "completion",
      "init",
      "validate",
      "mcp",
      "state",
      "tag",
    ];
    for (const shell of shells) {
      const script = await render(shell);
      for (const token of [
        ...commands,
        "traefik",
        "plex",
        "sonarr",
        "radarr",
        "core",
        "all",
        "dry-run",
        "debug",
        "output",
      ]) {
        expect(script, `${shell}:${token}`).toContain(token);
      }
    }
  });

  it("keeps the Commander-derived backup create and verify surface in parity across all shells", async () => {
    const { create, verify } = getBackupCommands();
    const commanderSurface = {
      createOptions: create.options
        .map((option) => option.long?.replace(/^--/, ""))
        .filter((option): option is string => option !== undefined)
        .sort(),
      subcommands: create.commands.map((command) => command.name()).sort(),
      verifyArguments: verify.registeredArguments.map((argument) => argument.name()),
    };

    expect(commanderSurface.subcommands).toEqual(["verify"]);
    expect(commanderSurface.verifyArguments).toEqual(["manifest"]);

    for (const shell of shells) {
      const script = await render(shell);
      expect([...new Set(getBackupCreateCompletionOptions(shell, script))].sort(), shell).toEqual(
        commanderSurface.createOptions,
      );
      expect(getBackupCompletionSubcommands(shell, script), shell).toEqual(
        commanderSurface.subcommands,
      );
    }

    const bash = await render("bash");
    expect(bash).toContain('if [[ "$subcmd" == "verify" ]]');
    expect(bash).toContain('compgen -W "$backup_opts $global_opts"');

    const zsh = await render("zsh");
    expect(zsh).toContain("backup_commands");
    expect(zsh).toContain("local backup_cmd=$(__rfapps_find_backup_cmd)");

    const fish = await render("fish");
    for (const option of commanderSurface.createOptions) {
      const optionLine = fish
        .split("\n")
        .find((line) => line.includes(`-l ${option}`) && line.includes("backup"));
      expect(optionLine, `fish:${option}`).toContain(BACKUP_CREATE_FISH_GUARD);
    }
  });

  it("completes backup destination directories and verify manifests in Bash, Zsh, and Fish", async () => {
    const pathContracts = {
      bash: [
        "--destination)\n      _filedir -d",
        'if [[ "$cmd" == "backup" ]] && [[ "$subcmd" == "verify" ]] && [[ "$cur" != -* ]]; then\n    _filedir',
      ],
      zsh: [
        "'--destination[Existing backup destination directory]:directory:_files -/'",
        "'1:manifest file:_files'",
      ],
      fish: [
        '-l destination -d "Existing backup destination directory" -xa "(__fish_complete_directories)"',
        `${BACKUP_VERIFY_FISH_GUARD}" -a "(__fish_complete_suffix .json)"`,
      ],
    } as const;

    for (const shell of shells) {
      const script = await render(shell);
      for (const token of pathContracts[shell]) {
        expect(script, `${shell}:${token}`).toContain(token);
      }
    }
  });

  it("keeps option values named verify in backup creation context across all shells", async () => {
    const valueOptions = [
      "compose",
      "destination",
      "env-file",
      "group",
      "output",
      "profile",
      "service",
      "services",
      "tag",
      "use-dotenvx",
      "use-op",
    ];

    for (const shell of shells) {
      const script = await render(shell);
      expect(getBackupVerifyClassifier(shell, script), shell).toEqual({
        valueOptions,
        inlineValueOptions: valueOptions,
        consumesPendingValueBeforeClassification: true,
        stopsAtFirstPositional: true,
      });
    }

    const fish = await render("fish");
    expect(fish).not.toContain(
      "__fish_seen_subcommand_from backup; and __fish_seen_subcommand_from verify",
    );
  });

  it("keeps reconcile completions in parity with Commander and supplies dynamic values", async () => {
    const command = getReconcileCommand();
    const commanderOptions = command.options
      .map((option) => option.long?.replace(/^--/, ""))
      .filter((option): option is string => option !== undefined)
      .sort();
    for (const option of commanderOptions) {
      expect(command.helpInformation()).toContain(`--${option}`);
    }

    for (const shell of shells) {
      const script = await render(shell);
      expect([...new Set(getReconcileCompletionOptions(shell, script))].sort(), shell).toEqual(
        commanderOptions,
      );
      for (const token of ["service", "services", "group", "profile", "health-timeout"]) {
        expect(script, `${shell}:${token}`).toContain(token);
      }
      expect(script, shell).toContain("30 60 120 300");
      expect(script, shell).toContain("drift");
      expect(script, shell).toContain("reconcile");
    }
  });

  it("keeps deploy completions in exact parity with Commander without leaking deploy-only options to rebuild", async () => {
    const deployOptions = getCommanderCommandOptions("deploy");
    const rebuildOptions = getCommanderCommandOptions("rebuild");
    const deployOnlyOptions = [
      "allow-partial",
      "batch-size",
      "force-recreate",
      "on-failure",
      "staged",
      "validate-first",
    ];

    for (const shell of shells) {
      const script = await render(shell);
      expect(
        [...new Set(getCommandCompletionOptions("deploy", shell, script))].sort(),
        shell,
      ).toEqual(deployOptions);
      expect(
        [...new Set(getCommandCompletionOptions("rebuild", shell, script))].sort(),
        shell,
      ).toEqual(rebuildOptions);
      for (const option of deployOnlyOptions) {
        expect(
          getCommandCompletionOptions("rebuild", shell, script),
          `${shell}:${option}`,
        ).not.toContain(option);
      }
    }
  });

  it("keeps plan completions in exact parity with Commander including the scan flags", async () => {
    const planOptions = getCommanderCommandOptions("plan");
    expect(planOptions).toEqual(expect.arrayContaining(["scan", "scanner", "scan-fail-on"]));

    for (const shell of shells) {
      const script = await render(shell);
      expect(
        [...new Set(getCommandCompletionOptions("plan", shell, script))].sort(),
        shell,
      ).toEqual(planOptions);
    }
  });

  it("keeps harden completions in parity with Commander across all shells", async () => {
    const command = getHardenCommand();
    const commanderOptions = command.options
      .map((option) => option.long?.replace(/^--/, ""))
      .filter((option): option is string => option !== undefined)
      .sort();
    // The write-authorization flags must be advertised, in Commander's rendered
    // form: `.option("--no-backup", …)` yields only the negated long name.
    expect(commanderOptions).toEqual(
      expect.arrayContaining(["apply", "out", "include-review", "no-backup", "allow-reformat"]),
    );

    for (const shell of shells) {
      const script = await render(shell);
      expect(
        [...new Set(getCommandCompletionOptions("harden", shell, script))].sort(),
        shell,
      ).toEqual(commanderOptions);
      // Guards an empty `${hardenRuleIds}` interpolation, which the option-name
      // parity assertion above cannot see.
      expect(script, shell).toContain("harden-no-new-privileges");
    }
  });

  it("keeps import completions in parity with Commander and disjoint from drift import", async () => {
    const command = getImportCommand();
    const commanderOptions = command.options
      .map((option) => option.long?.replace(/^--/, ""))
      .filter((option): option is string => option !== undefined)
      .sort();
    // The write-authorization and reporting flags must be advertised.
    expect(commanderOptions).toContain("adopt");
    expect(commanderOptions).toContain("show-tracked");

    for (const shell of shells) {
      const script = await render(shell);
      expect([...new Set(getImportCompletionOptions(shell, script))].sort(), shell).toEqual(
        commanderOptions,
      );
    }

    // Fish must guard the top-level import command against the drift import
    // subcommand, and the drift import block must remain intact and distinct.
    const fish = await render("fish");
    expect(fish).toContain(`complete -c rfapps -n "__fish_use_subcommand" -a "import"`);
    for (const line of fish.split("\n")) {
      if (
        line.includes("-l adopt") &&
        line.includes("__fish_seen_subcommand_from import") &&
        !line.includes("__fish_seen_subcommand_from drift;")
      ) {
        expect(line, "top-level import flags must exclude the drift context").toContain(
          "and not __fish_seen_subcommand_from drift",
        );
      }
    }
    // drift import (compose.yml rewrite) stays as its own project-scoped block.
    expect(fish).toContain(
      `__fish_seen_subcommand_from drift; and __fish_seen_subcommand_from import`,
    );
  });

  it("keeps state rebuild completions in parity with Commander and disjoint from rebuild", async () => {
    const command = getStateRebuildCommand();
    const commanderOptions = command.options
      .map((option) => option.long?.replace(/^--/, ""))
      .filter((option): option is string => option !== undefined)
      .sort();
    // The write-authorization and mode flags must be advertised.
    expect(commanderOptions).toContain("rewrite");
    expect(commanderOptions).toContain("confirm-project");

    for (const shell of shells) {
      const script = await render(shell);
      expect([...new Set(getStateRebuildCompletionOptions(shell, script))].sort(), shell).toEqual(
        commanderOptions,
      );
    }

    // Fish matches subcommands by name anywhere on the command line, so every
    // top-level rebuild option must exclude the `state rebuild` context.
    const fish = await render("fish");
    expect(fish).toContain(`complete -c rfapps -n "__fish_use_subcommand" -a "state"`);
    for (const line of fish.split("\n")) {
      if (
        line.includes("__fish_seen_subcommand_from rebuild") &&
        !line.includes("__fish_seen_subcommand_from state;")
      ) {
        expect(line, "top-level rebuild flags must exclude the state context").toContain(
          "and not __fish_seen_subcommand_from state",
        );
      }
    }
  });

  it("keeps command-specific safety and targeting options in every shell", async () => {
    const required = [
      "from-plan",
      "no-restore-on-failure",
      "sarif",
      "list-rules",
      "runtime",
      "check-updates",
      "explain",
      "critical",
      "parallel",
      "workers",
      "report-only",
      "staged",
      "batch-size",
      "tag",
    ];
    for (const shell of shells) {
      const script = await render(shell);
      for (const token of required) {
        expect(script, `${shell}:${token}`).toContain(token);
      }
    }
  });

  it("keeps tag completions in parity with Commander and interpolates config-derived values", async () => {
    const subcommands = getTagSubcommands();
    const commanderOptions = {
      list: getCommanderLongOptions(subcommands.list),
      show: getCommanderLongOptions(subcommands.show),
      suggest: getCommanderLongOptions(subcommands.suggest),
    };
    expect(commanderOptions.list).toContain("tree");
    expect(commanderOptions.suggest).toEqual(
      expect.arrayContaining(["rule", "list-rules", "include-tagged", "out"]),
    );

    for (const shell of shells) {
      const script = await render(shell);
      for (const subcommand of ["list", "show", "suggest"] as const) {
        expect(
          [...new Set(getTagSubcommandCompletionOptions(subcommand, shell, script))].sort(),
          `${shell}:tag ${subcommand}`,
        ).toEqual(commanderOptions[subcommand]);
      }
      // Guards an empty `${tagValues}` / `${tagRuleIds}` interpolation. The option-name
      // parity assertions above are structurally blind to it: a script that offers no
      // tag values at all still advertises the flag names correctly.
      expect(script, shell).toContain("media/streaming");
      // Ancestor closure: `media` is never authored in mockConfig.tags.mapping.
      expect(script, shell).toContain("media/automation");
      expect(script, shell).toContain("tag-infer-ingress");
    }

    // `--tag` is comma-separated, so every shell needs segment-aware value completion
    // rather than a plain word list.
    const bash = await render("bash");
    expect(bash).toContain("__rfapps_tag_completion");
    const zsh = await render("zsh");
    expect(zsh).toContain("_values -s , tag ");
    const fish = await render("fish");
    expect(fish).toContain("function __rfapps_complete_tags");
    expect(fish).toContain(`complete -c rfapps -n "__fish_use_subcommand" -a "tag"`);
    // `show` is a taken global token, so both sides carry the reciprocal exclusion.
    expect(fish).toContain(TAG_FISH_GUARDS.show);
    expect(fish).toContain(DRIFT_SHOW_FISH_GUARD);
  });

  it("renders a usable --tag completion for every shell when the config declares no tags", async () => {
    // The shipped `rfapps.config.yaml` ships its `tags:` block commented out, so the
    // day-one config carries no `tags` key at all and `deriveTagValues` returns "".
    const { tags: _omitted, ...untaggedConfig } = mockConfig;
    vi.mocked(loadConfig).mockResolvedValue(untaggedConfig);

    // zsh's `_values` needs a description plus at least one value spec, so an empty
    // list makes every `--tag <TAB>` abort with `_values:compvalues: not enough
    // arguments`. An empty action is a valid `_arguments` spec meaning "no completion".
    const zsh = await render("zsh");
    expect(zsh).not.toContain("_values -s , tag");
    const tagSpecs = zsh.match(/'--tag\[[^\]]*\]:tag:[^']*'/g) ?? [];
    expect(tagSpecs.length).toBeGreaterThan(0);
    expect([...new Set(tagSpecs)]).toEqual(["'--tag[Narrow targets by tag pattern]:tag:'"]);

    // bash and fish degrade to an empty word list, which both parse and complete
    // silently; this pins that the empty interpolation stays syntactically inert.
    const bash = await render("bash");
    expect(bash).toContain('local tags=""');
    const fish = await render("fish");
    expect(fish).toMatch(/set -l all_tags *\n/);
  });

  it("degrades --tag completion to an empty list when tags.mapping is malformed", async () => {
    // `config.ts` casts `YAML.parse(...)` straight to `PartialRfappsConfig`, so every shape
    // below typechecks clean at the boundary and only ever surfaces at runtime; the cast
    // reproduces exactly what a hand-written config file delivers.
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      // A string is iterable, so the scalar `profiles.mapping` shape used to survive `.flat()`
      // intact and advertise `media` — a tag `rfapps tag list` and `--tag media` hard-error on.
      ["scalar", "media"],
      // YAML types an unquoted `2024` as a number, which used to reach `normalizeTag` and die
      // with a bare `input.trim is not a function` naming no config file.
      ["numeric element", ["monitoring", 2024]],
      ["null", null],
      ["nested list", [["media", "streaming"]]],
      ["object", { media: "streaming" }],
    ];

    for (const [label, mapping] of malformed) {
      for (const shell of shells) {
        vi.mocked(loadConfig).mockResolvedValue({
          ...mockConfig,
          tags: { mapping: { plex: mapping } },
        } as unknown as RfappsConfig);
        dependencyMocks.logWarn.mockClear();

        // Completion is sourced from shell startup, so a throw here breaks every new shell:
        // `render` rejecting is itself the regression this pins.
        const script = await render(shell);

        // No tag may be advertised: `buildTagIndex` rejects the whole `tags.mapping` when any
        // entry is malformed, so with one bad entry nothing on the tag axis is selectable and
        // the surfaces would otherwise contradict each other about what is legal.
        if (shell === "zsh") {
          expect(script, `${label}:zsh`).not.toContain("_values -s , tag");
          const tagSpecs = script.match(/'--tag\[[^\]]*\]:tag:[^']*'/g) ?? [];
          expect(tagSpecs.length, `${label}:zsh`).toBeGreaterThan(0);
          expect([...new Set(tagSpecs)], `${label}:zsh`).toEqual([
            "'--tag[Narrow targets by tag pattern]:tag:'",
          ]);
        } else if (shell === "bash") {
          expect(script, `${label}:bash`).toContain('local tags=""');
        } else {
          expect(script, `${label}:fish`).toMatch(/set -l all_tags *\n/);
        }

        // Degrading silently would leave the operator with a completion that quietly forgets
        // the taxonomy. `logWarn` writes to stderr, so it cannot corrupt the sourced script.
        const warning = dependencyMocks.logWarn.mock.calls[0]?.[0];
        expect(typeof warning, `${label}:${shell}`).toBe("string");
        expect(String(warning), `${label}:${shell}`).toContain("tags.mapping");
        expect(String(warning), `${label}:${shell}`).toContain("rfapps tag list");
      }
    }
  });

  it("degrades --tag completion when the tags.mapping container itself is not a mapping", async () => {
    // The leaf guard cannot see this class of mistake: it runs per service key, and for a
    // number, a boolean, or an empty string `Object.entries` yields no keys at all. Before the
    // container guard those three produced an empty taxonomy with ZERO diagnostics here while
    // `rfapps tag list` hard-errored on the same file — the exact two-surface divergence the
    // shared guards exist to prevent. A string or a list did warn, but only by accident: their
    // numeric indices became "service" keys, so the message blamed a phantom service named '0'
    // instead of naming the container.
    const containers: ReadonlyArray<readonly [string, unknown, string]> = [
      ["number", 42, "number"],
      ["boolean", true, "boolean"],
      ["empty string", "", "string"],
      ["non-empty string", "media", "string"],
      ["list", ["plex", "sonarr"], "list"],
    ];

    for (const [label, mapping, shape] of containers) {
      for (const shell of shells) {
        vi.mocked(loadConfig).mockResolvedValue({
          ...mockConfig,
          tags: { mapping },
        } as unknown as RfappsConfig);
        dependencyMocks.logWarn.mockClear();

        // Sourced from shell startup: `render` rejecting is itself the regression.
        const script = await render(shell);

        if (shell === "zsh") {
          expect(script, `${label}:zsh`).not.toContain("_values -s , tag");
          const tagSpecs = script.match(/'--tag\[[^\]]*\]:tag:[^']*'/g) ?? [];
          expect(tagSpecs.length, `${label}:zsh`).toBeGreaterThan(0);
          expect([...new Set(tagSpecs)], `${label}:zsh`).toEqual([
            "'--tag[Narrow targets by tag pattern]:tag:'",
          ]);
        } else if (shell === "bash") {
          expect(script, `${label}:bash`).toContain('local tags=""');
        } else {
          expect(script, `${label}:fish`).toMatch(/set -l all_tags *\n/);
        }

        const warning = String(dependencyMocks.logWarn.mock.calls[0]?.[0]);
        expect(warning, `${label}:${shell}`).toContain("tags.mapping must be a mapping");
        expect(warning, `${label}:${shell}`).toContain(`(got ${shape})`);
        expect(warning, `${label}:${shell}`).toContain("rfapps tag list");
        // The container is the defect; no phantom service may be blamed for it.
        expect(warning, `${label}:${shell}`).not.toContain("entry for '0'");
      }
    }
  });

  it("keeps an absent, null, or empty tags.mapping silent rather than warning", async () => {
    // `tags: {}`, a bare `mapping:` (YAML null), and an empty mapping are all legal ways to
    // say "this project has not adopted tags yet" — the container guard must not turn a
    // day-one config into a startup warning on every new shell.
    const quiet: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["empty mapping", {}],
    ];

    for (const [label, mapping] of quiet) {
      vi.mocked(loadConfig).mockResolvedValue({
        ...mockConfig,
        tags: { mapping },
      } as unknown as RfappsConfig);
      dependencyMocks.logWarn.mockClear();

      const bash = await render("bash");
      expect(bash, `${label}:bash`).toContain('local tags=""');
      expect(dependencyMocks.logWarn, label).not.toHaveBeenCalled();
    }
  });

  it("advertises exactly the tag universe buildTagIndex accepts", async () => {
    // The one thing completion must never do is offer a value `rfapps stop --tag <value>`
    // rejects. `buildTagIndex` owns that universe, so this compares against it directly
    // rather than against a hand-written list that could drift from the selector.
    const { index } = buildTagIndex({
      mapping: mockConfig.tags?.mapping ?? {},
      universe: Object.keys(mockConfig.profiles.mapping),
      source: "/repo/rfapps.config.yaml",
    });

    const bash = await render("bash");
    const advertised = /local tags="([^"]*)"/.exec(bash)?.[1];
    expect(typeof advertised).toBe("string");
    expect(String(advertised).split(" ")).toEqual([...index.allTags]);
  });

  it("declares --tag on every Commander command path that carries it", async () => {
    const tagged = [
      "status_opts",
      "health_opts",
      "pull_opts",
      "build_opts",
      "deploy_opts",
      "stop_opts",
      "rebuild_opts",
      "delete_opts",
      "prune_opts",
      "plan_opts",
      "lint_opts",
      "audit_opts",
      "backup_opts",
      "doctor_opts",
      "drift_detect_opts",
      "drift_reconcile_opts",
      "drift_import_opts",
      "harden_opts",
      "import_opts",
      "reconcile_opts",
      "update_opts",
    ];
    const bash = await render("bash");
    for (const variable of tagged) {
      const options = bash.match(new RegExp(`local ${variable}="([^"]*)"`))?.[1];
      expect(options, variable).toBeDefined();
      expect(getLongOptionNames(options ?? ""), variable).toContain("tag");
    }
    // `drift show` and `rollback` take a single required service, and `history -s` is
    // a SQL filter rather than a target, so none of them gets a tag axis.
    const driftShow = bash.match(/local drift_show_opts="([^"]*)"/)?.[1];
    expect(getLongOptionNames(driftShow ?? "")).not.toContain("tag");
  });

  it("generates a hybrid static and Docker-backed service helper for every shell", async () => {
    for (const shell of shells) {
      const script = await render(shell);
      expect(script, shell).toContain("docker compose config --no-interpolate --services");
      expect(script, shell).toContain("timeout 0.5s");
      expect(script, shell).toContain("traefik");
      expect(script, shell).toContain("plex");
      if (shell === "bash") {
        expect(script).toContain("__rfapps_service_completion");
        expect(script).toContain("${cur%,*}");
      } else if (shell === "zsh") {
        expect(script).toContain("__rfapps_get_services()");
        expect(script).toContain("__rfapps_services_values");
      } else {
        expect(script).toContain("function __rfapps_get_services");
        expect(script).toContain("function __rfapps_complete_services_list");
      }
    }
  });

  it("resolves explicit, option, and detected shells and rejects invalid selection", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await executeCompletion(undefined, { shell: "bash", install: false });
    process.env["SHELL"] = "/bin/zsh";
    await executeCompletion(undefined, { install: false });
    expect(loadConfig).toHaveBeenCalledTimes(2);

    await expect(executeCompletion("powershell", { install: false })).rejects.toBeInstanceOf(
      InvalidArgumentError,
    );
    process.env["SHELL"] = "/bin/unknown";
    await expect(executeCompletion(undefined, { install: false })).rejects.toThrow(
      "Could not detect shell",
    );
  });

  it("rethrows typed config failures and formats unexpected config failures", async () => {
    const typed = new ConfigNotFoundError(["/missing"]);
    vi.mocked(loadConfig).mockRejectedValueOnce(typed);
    await expect(executeCompletion("bash", { install: false })).rejects.toBe(typed);

    vi.mocked(loadConfig).mockRejectedValueOnce(new Error("invalid config"));
    await executeCompletion("bash", { install: false });
    expect(dependencyMocks.outputFormattedError).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("installs each shell script to its canonical path with activation guidance", async () => {
    const expectedPaths = {
      bash: "/home/test/.bash_completion.d/rfapps",
      zsh: "/home/test/.zfunc/_rfapps",
      fish: "/home/test/.config/fish/completions/rfapps.fish",
    } as const;

    for (const shell of shells) {
      vi.clearAllMocks();
      vi.mocked(loadConfig).mockResolvedValue(mockConfig);
      await executeCompletion(shell, { install: true });
      expect(dependencyMocks.mkdir, shell).toHaveBeenCalledWith(
        expect.stringContaining("/home/test/"),
        { recursive: true },
      );
      expect(dependencyMocks.writeFile, shell).toHaveBeenCalledWith(
        expectedPaths[shell],
        expect.stringContaining("rfapps"),
        "utf-8",
      );
      expect(dependencyMocks.logSuccess, shell).toHaveBeenCalledWith(
        expect.stringContaining(`Installed ${shell} completion`),
      );
      expect(dependencyMocks.logInfo, shell).toHaveBeenCalledOnce();
    }
  });

  it("formats installation failures without throwing", async () => {
    dependencyMocks.writeFile.mockRejectedValueOnce(new Error("read-only filesystem"));
    await executeCompletion("bash", { install: true });
    expect(dependencyMocks.outputFormattedError).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });
});
