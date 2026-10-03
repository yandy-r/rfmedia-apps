import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { InvalidArgumentError } from "../lib/errors.js";
import type { RawReconcileOptions, ReconcileGlobalOptions } from "../actions/reconcile.js";
import { registerReconcileCommand, type ReconcileCommandDependencies } from "./reconcile.js";

function createProgram(dependencies: ReconcileCommandDependencies): Command {
  const program = new Command()
    .name("rfapps")
    .exitOverride()
    .option("--dry-run", "Preview actions without executing", false)
    .option("--debug", "Enable debug output", false)
    .option("--json", "Output in JSON format", false)
    .option("--output <format>", "Output format", "text")
    .option("-v, --verbose", "Show detailed output", false)
    .option("-y, --yes", "Skip confirmation prompts", false)
    .option("--use-dotenvx <file>", "Use dotenvx for secrets injection")
    .option("--use-op <file>", "Use 1Password CLI for secrets injection");
  registerReconcileCommand(program, dependencies);
  return program;
}

function dependencies() {
  const executeReconcile = vi
    .fn<(raw: RawReconcileOptions, global: ReconcileGlobalOptions) => Promise<void>>()
    .mockResolvedValue(undefined);
  const loadAction = vi.fn().mockResolvedValue({ executeReconcile });
  return { executeReconcile, loadAction, dependencies: { loadAction } };
}

describe("registerReconcileCommand", () => {
  it("registers the complete report-first surface and global option help", () => {
    const fixture = dependencies();
    const program = createProgram(fixture.dependencies);
    const command = program.commands.find((candidate) => candidate.name() === "reconcile");

    expect(command).toBeDefined();
    expect(command?.options.map((option) => option.long)).toEqual([
      "--service",
      "--services",
      "--group",
      "--tag",
      "--no-sidecars",
      "--auto-apply",
      "--show-unchanged",
      "--health-timeout",
      "--compose",
      "--env-file",
      "--profile",
    ]);

    let help = "";
    command?.configureOutput({ writeOut: (chunk) => (help += chunk) });
    command?.outputHelp();
    expect(help).toContain("Report-first");
    expect(help).toContain("Only --auto-apply authorizes");
    expect(help).toContain("Global --yes only skips human confirmation");
    expect(help).toContain("Global --dry-run vetoes mutation");
    expect(help).toContain("Partial, blocked, or residual-drift result");
    expect(help).toContain("--output <format>");
    expect(help).toContain("--use-dotenvx <file>");
  });

  it("does not load the action while registering or rendering help", () => {
    const fixture = dependencies();
    const program = createProgram(fixture.dependencies);
    const command = program.commands.find((candidate) => candidate.name() === "reconcile");

    command?.helpInformation();

    expect(fixture.loadAction).not.toHaveBeenCalled();
    expect(fixture.executeReconcile).not.toHaveBeenCalled();
  });

  it("forwards command and inherited global options without inventing mutation authority", async () => {
    const fixture = dependencies();
    const program = createProgram(fixture.dependencies);

    await program.parseAsync([
      "node",
      "rfapps",
      "--dry-run",
      "--debug",
      "--json",
      "--output",
      "yaml",
      "--verbose",
      "--yes",
      "--use-op",
      "/private/runtime.env",
      "reconcile",
      "--service",
      "plex",
      "--services",
      "sonarr,radarr",
      "--group",
      "media",
      "--no-sidecars",
      "--auto-apply",
      "--show-unchanged",
      "--health-timeout",
      "45",
      "--compose",
      "/project/compose.yml",
      "--env-file",
      "/project/.env",
      "--profile",
      "media",
    ]);

    expect(fixture.loadAction).toHaveBeenCalledOnce();
    expect(fixture.executeReconcile).toHaveBeenCalledWith(
      {
        service: "plex",
        services: "sonarr,radarr",
        group: "media",
        sidecars: false,
        autoApply: true,
        showUnchanged: true,
        healthTimeout: "45",
        compose: "/project/compose.yml",
        envFile: "/project/.env",
        profile: "media",
      },
      expect.objectContaining({
        dryRun: true,
        debug: true,
        json: true,
        output: "yaml",
        verbose: true,
        yes: true,
        useOp: "/private/runtime.env",
      }),
    );
  });

  it("keeps report mode as the default when no command flags are present", async () => {
    const fixture = dependencies();
    const program = createProgram(fixture.dependencies);

    await program.parseAsync(["node", "rfapps", "reconcile"]);

    expect(fixture.executeReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ autoApply: false, showUnchanged: false }),
      expect.any(Object),
    );
  });

  it("collects repeated --tag values and leaves the key absent when the flag is omitted", async () => {
    const collected = dependencies();
    await createProgram(collected.dependencies).parseAsync([
      "node",
      "rfapps",
      "reconcile",
      "--tag",
      "media/**",
      "--tag",
      "!media/streaming",
    ]);

    expect(collected.executeReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ tag: ["media/**", "!media/streaming"] }),
      expect.any(Object),
    );

    // No `[]` default: mutually-exclusive-flag lists elsewhere test `=== undefined`,
    // so a defaulted --tag would read as permanently present.
    const omitted = dependencies();
    await createProgram(omitted.dependencies).parseAsync(["node", "rfapps", "reconcile"]);

    expect(omitted.executeReconcile.mock.calls[0]?.[0]).not.toHaveProperty("tag");
  });

  it.each([
    ["--service", " "],
    ["--services", ",,"],
    ["--group", " "],
    ["--health-timeout", "0"],
    ["--health-timeout", "NaN"],
  ])("rejects invalid %s argv before loading the action", async (option, value) => {
    const fixture = dependencies();
    const program = createProgram(fixture.dependencies);

    await expect(
      program.parseAsync(["node", "rfapps", "reconcile", option, value]),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(fixture.loadAction).not.toHaveBeenCalled();
    expect(fixture.executeReconcile).not.toHaveBeenCalled();
  });

  it("is registered by the root CLI and exposes the expected smoke-test help", () => {
    const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "reconcile", "--help"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: rfapps reconcile [options]");
    expect(result.stdout).toContain("--auto-apply");
    expect(result.stdout).toContain("--show-unchanged");
    expect(result.stdout).toContain("--health-timeout <seconds>");
    expect(result.stdout).toContain("Global Options:");
  });
});
