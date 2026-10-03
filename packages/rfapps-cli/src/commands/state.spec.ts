import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerStateCommand, type StateCommandDependencies } from "./state.js";

function dependencies() {
  const loadRebuildAction = vi.fn().mockResolvedValue({ executeStateRebuild: vi.fn() });
  const loadExportAction = vi.fn().mockResolvedValue({ executeStateExport: vi.fn() });
  const injected: StateCommandDependencies = { loadRebuildAction, loadExportAction };
  return { loadRebuildAction, loadExportAction, dependencies: injected };
}

describe("registerStateCommand", () => {
  it("is registered by the root CLI and exposes the expected smoke-test help", () => {
    const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "state", "rebuild", "--help"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: rfapps state rebuild [options]");
    expect(result.stdout).toContain("--mode");
    expect(result.stdout).toContain("--rewrite");
    expect(result.stdout).toContain("--confirm-project");
    expect(result.stdout).toContain("Global Options:");
  });

  it("does not load either action while registering or rendering help", () => {
    const fixture = dependencies();
    const program = new Command().name("rfapps").exitOverride();
    registerStateCommand(program, fixture.dependencies);

    const state = program.commands.find((candidate) => candidate.name() === "state");
    state?.helpInformation();
    state?.commands.forEach((subcommand) => subcommand.helpInformation());

    expect(fixture.loadRebuildAction).not.toHaveBeenCalled();
    expect(fixture.loadExportAction).not.toHaveBeenCalled();
  });
});
