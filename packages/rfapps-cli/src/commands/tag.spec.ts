import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerTagCommand, type TagCommandDependencies } from "./tag.js";

const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** Spawn the real CLI and render help for a `tag` subcommand. */
function spawnTagHelp(subcommand: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, "tag", subcommand, "--help"], {
    encoding: "utf8",
  });
}

function dependencies() {
  const loadInspectActions = vi
    .fn()
    .mockResolvedValue({ executeTagList: vi.fn(), executeTagShow: vi.fn() });
  const loadSuggestAction = vi.fn().mockResolvedValue({ executeTagSuggest: vi.fn() });
  const injected: TagCommandDependencies = { loadInspectActions, loadSuggestAction };
  return { loadInspectActions, loadSuggestAction, dependencies: injected };
}

describe("registerTagCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered by the root CLI and exposes the expected smoke-test help", () => {
    const list = spawnTagHelp("list");

    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain("Usage: rfapps tag list [options]");
    expect(list.stdout).toContain("--tree");
    expect(list.stdout).toContain("-f, --compose <path>");
    expect(list.stdout).toContain("-e, --env-file <path>");
    expect(list.stdout).toContain("-p, --profile <name>");
    expect(list.stdout).toContain("--json");
    // Proves `.configureHelp({ showGlobalOptions: true })` was chained on the parent
    // BEFORE the subcommands were created — Commander copies the parent's help
    // configuration into a subcommand at creation time, so a later call never lands.
    expect(list.stdout).toContain("Global Options:");

    const suggest = spawnTagHelp("suggest");

    expect(suggest.status, suggest.stderr).toBe(0);
    expect(suggest.stdout).toContain("Usage: rfapps tag suggest [options]");
    expect(suggest.stdout).toContain("-s, --service <name>");
    expect(suggest.stdout).toContain("--services <names>");
    expect(suggest.stdout).toContain("-g, --group <name>");
    expect(suggest.stdout).toContain("--rule <ids>");
    expect(suggest.stdout).toContain("--list-rules");
    expect(suggest.stdout).toContain("--include-tagged");
    expect(suggest.stdout).toContain("-o, --out <path>");
    expect(suggest.stdout).toContain("--json");
    expect(suggest.stdout).toContain("Global Options:");
  }, 30_000);

  it("does not load any action while registering or rendering help", () => {
    const fixture = dependencies();
    const program = new Command().name("rfapps").exitOverride();
    registerTagCommand(program, fixture.dependencies);

    const tag = program.commands.find((candidate) => candidate.name() === "tag");
    expect(tag?.commands.map((subcommand) => subcommand.name())).toEqual([
      "list",
      "show",
      "suggest",
    ]);

    tag?.helpInformation();
    tag?.commands.forEach((subcommand) => subcommand.helpInformation());

    expect(fixture.loadInspectActions).not.toHaveBeenCalled();
    expect(fixture.loadSuggestAction).not.toHaveBeenCalled();
  });
});
