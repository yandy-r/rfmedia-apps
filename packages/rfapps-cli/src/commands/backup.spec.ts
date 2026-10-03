import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InvalidArgumentError } from "../lib/errors.js";
import {
  registerBackupCommand,
  validateBackupCreateOptions,
  type BackupCommandDependencies,
} from "./backup.js";

function dependencies() {
  const executeBackup = vi.fn();
  const executeBackupVerify = vi.fn();
  const loadCreateAction = vi.fn(async () => ({ executeBackup }));
  const loadVerifyAction = vi.fn(async () => ({ executeBackupVerify }));
  const injected: BackupCommandDependencies = { loadCreateAction, loadVerifyAction };
  return { executeBackup, executeBackupVerify, loadCreateAction, loadVerifyAction, injected };
}

function program(fixture: ReturnType<typeof dependencies>): Command {
  const command = new Command().name("rfapps").exitOverride();
  command
    .option("--dry-run", "", false)
    .option("--json", "", false)
    .option("--output <format>", "", "text")
    .option("--yes", "", false);
  registerBackupCommand(command, fixture.injected);
  return command;
}

describe("backup command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps both actions lazy while registering and rendering help", () => {
    const fixture = dependencies();
    const command = program(fixture);
    const backup = command.commands.find((candidate) => candidate.name() === "backup");

    backup?.helpInformation();
    backup?.commands.forEach((subcommand) => subcommand.helpInformation());

    expect(fixture.loadCreateAction).not.toHaveBeenCalled();
    expect(fixture.loadVerifyAction).not.toHaveBeenCalled();
  });

  it("is registered by the root CLI with the nested offline verifier", () => {
    const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cliPath, "backup", "verify", "--help"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: rfapps backup verify [options] <manifest>");
    expect(result.stdout).toContain("Verification is read-only");
  });

  it("registers parent creation and nested verification without requiring a destination for verify", async () => {
    const fixture = dependencies();
    const command = program(fixture);

    await command.parseAsync(
      ["node", "rfapps", "--yes", "backup", "--all", "--destination", "/backups"],
      { from: "node" },
    );
    expect(fixture.executeBackup).toHaveBeenCalledWith(
      expect.objectContaining({ all: true, destination: "/backups" }),
      expect.objectContaining({ yes: true }),
    );

    await command.parseAsync(["node", "rfapps", "backup", "verify", "/bundle/manifest.json"], {
      from: "node",
    });
    expect(fixture.executeBackupVerify).toHaveBeenCalledWith(
      "/bundle/manifest.json",
      expect.objectContaining({ output: "text" }),
    );
  });

  it("rejects all selector conflicts, CSV, and blank destinations before loading creation", async () => {
    const cases = [
      ["--all", "--service", "plex", "--destination", "/backups"],
      ["--all", "--services", "plex,sonarr", "--destination", "/backups"],
      ["--all", "--group", "media", "--destination", "/backups"],
      // Selector site 5: without explicitSelectorFlagNames this combination passes the
      // mutual-exclusion check, --all wins, and the whole project is archived.
      ["--all", "--tag", "media/**", "--destination", "/backups"],
      ["--service", "plex", "--destination", "   "],
    ] as const;

    for (const args of cases) {
      const fixture = dependencies();
      await expect(
        program(fixture).parseAsync(["node", "rfapps", "--yes", "backup", ...args], {
          from: "node",
        }),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(fixture.loadCreateAction).not.toHaveBeenCalled();
    }

    expect(() =>
      validateBackupCreateOptions(
        { service: "plex", destination: "/backups" },
        { output: "csv", yes: true },
        true,
      ),
    ).toThrow(InvalidArgumentError);
  });

  it("accepts --tag as an explicit target and collects one entry per occurrence", async () => {
    expect(() =>
      validateBackupCreateOptions(
        { tag: ["media/**"], destination: "/backups" },
        { yes: true },
        true,
      ),
    ).not.toThrow();

    const fixture = dependencies();
    await program(fixture).parseAsync(
      [
        "node",
        "rfapps",
        "--yes",
        "backup",
        "--tag",
        "media/**",
        "--tag",
        "!media/streaming",
        "--destination",
        "/backups",
      ],
      { from: "node" },
    );

    expect(fixture.executeBackup).toHaveBeenCalledWith(
      expect.objectContaining({ tag: ["media/**", "!media/streaming"], destination: "/backups" }),
      expect.objectContaining({ yes: true }),
    );
  });

  it("requires explicit targeting for yes, machine, and non-interactive creation", () => {
    const noTarget = { destination: "/backups" };

    expect(() => validateBackupCreateOptions(noTarget, { yes: true }, true)).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      validateBackupCreateOptions(noTarget, { output: "json", yes: true }, true),
    ).toThrow(InvalidArgumentError);
    expect(() => validateBackupCreateOptions(noTarget, {}, false)).toThrow(InvalidArgumentError);
    expect(() => validateBackupCreateOptions(noTarget, { output: "table" }, true)).not.toThrow();
  });

  it("requires --yes for machine creation and rejects verify CSV before loading verification", async () => {
    expect(() =>
      validateBackupCreateOptions({ all: true, destination: "/backups" }, { output: "yaml" }, true),
    ).toThrow(InvalidArgumentError);

    const fixture = dependencies();
    await expect(
      program(fixture).parseAsync(
        ["node", "rfapps", "--output", "csv", "backup", "verify", "/bundle/manifest.json"],
        { from: "node" },
      ),
    ).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(fixture.loadVerifyAction).not.toHaveBeenCalled();
  });
});
