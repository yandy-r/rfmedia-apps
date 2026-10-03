import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecuteUpdate = vi.hoisted(() => vi.fn());

vi.mock("../actions/update.js", () => ({
  executeUpdate: mockExecuteUpdate,
}));

import { InvalidArgumentError } from "../lib/errors.js";
import { registerUpdateCommand } from "./update.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--dry-run").option("--yes");
  registerUpdateCommand(program);
  return program;
}

describe("update command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects every reviewed-scope override used with --from-plan before loading the action", async () => {
    const cases = [
      ["--service", "plex"],
      ["--services", "plex,sonarr"],
      ["--group", "media"],
      ["--tag", "media/**"],
      ["--compose", "/srv/compose.yml"],
      ["--profile", "media"],
      ["--no-sidecars"],
    ] as const;

    for (const conflictingArgs of cases) {
      const program = createProgram();

      await expect(
        program.parseAsync(
          ["node", "rfapps", "update", "--from-plan", "/plans/reviewed.json", ...conflictingArgs],
          { from: "node" },
        ),
        conflictingArgs.join(" "),
      ).rejects.toBeInstanceOf(InvalidArgumentError);
      expect(mockExecuteUpdate).not.toHaveBeenCalled();
    }
  });

  it("leaves --tag undefined when absent so --from-plan alone still loads the reviewed plan", async () => {
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "rfapps", "update", "--from-plan", "/plans/reviewed.json"], {
        from: "node",
      }),
    ).resolves.toBeDefined();

    // Regression guard for the Commander-default trap: an `[]` default on the --tag
    // collector would make it look permanently present, and this invocation - the normal
    // way a reviewed plan is applied - would throw the reviewed-scope conflict every time.
    expect(mockExecuteUpdate).toHaveBeenCalledOnce();
    expect(mockExecuteUpdate.mock.calls[0]?.[0]).toMatchObject({
      fromPlan: "/plans/reviewed.json",
    });
    expect(mockExecuteUpdate.mock.calls[0]?.[0]).not.toHaveProperty("tag");
  });

  it("collects one --tag entry per occurrence without a default", async () => {
    const program = createProgram();

    await program.parseAsync(
      ["node", "rfapps", "update", "--tag", "media/**", "--tag", "!media/streaming"],
      { from: "node" },
    );

    expect(mockExecuteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tag: ["media/**", "!media/streaming"] }),
      expect.any(Object),
    );
  });

  it("forwards mutation controls separately from global options", async () => {
    const program = createProgram();

    await program.parseAsync(
      [
        "node",
        "rfapps",
        "--dry-run",
        "--yes",
        "update",
        "--from-plan",
        "/plans/reviewed.json",
        "--apply",
        "--out",
        "/reports/result.json",
        "--no-restore-on-failure",
        "--health-timeout",
        "45",
        "--env-file",
        "/srv/apps.env",
      ],
      { from: "node" },
    );

    expect(mockExecuteUpdate).toHaveBeenCalledOnce();
    expect(mockExecuteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPlan: "/plans/reviewed.json",
        apply: true,
        out: "/reports/result.json",
        restoreOnFailure: false,
        healthTimeout: "45",
        envFile: "/srv/apps.env",
      }),
      expect.objectContaining({ dryRun: true, yes: true }),
    );
  });
});
