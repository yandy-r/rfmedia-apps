/**
 * Integration tests for `rfapps stop`, `rfapps plan`, and `rfapps apply`.
 *
 * Spawns the real src/cli.ts via tsx with a mock `docker` on PATH — see
 * src/testing/cli-harness.ts and src/testing/mock-docker.ts.
 */

import { existsSync } from "node:fs";
import { appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFixtureProject,
  expectInvocationOrder,
  openStateDb,
  runCli,
} from "./testing/cli-harness.js";
import type { FixtureProject } from "./testing/cli-harness.js";
import { deployReadinessRules, pullOk, upOk } from "./testing/deploy-scenarios.js";
import { argvLines, composeConfigJson } from "./testing/mock-docker.js";
import type { MockDockerRule } from "./testing/mock-docker.js";
import type { DeploymentPlan, StopResult } from "./types/index.js";

/** Rules for `rfapps plan`: compose config JSON + empty running-service map (no inspect). */
const planRules = (): MockDockerRule[] => [
  {
    id: "config-json",
    match: { prefix: ["compose"], contains: ["config", "--format", "json"] },
    response: {
      stdout: composeConfigJson({
        services: { web: { image: "nginx:1.27" }, db: { image: "postgres:16" } },
      }),
      exitCode: 0,
    },
  },
  {
    id: "ps-service-map",
    match: { prefix: ["compose"], contains: ["ps", "--status", "running"] },
    response: { stdout: "", exitCode: 0 },
  },
];

/** Locate the single saved plan file in the fixture's .rfapps/plans directory. */
async function findSavedPlanPath(project: FixtureProject): Promise<string> {
  const plansDir = join(project.projectDir, ".rfapps", "plans");
  const files = await readdir(plansDir);
  const planFiles = files.filter((f) => /^plan-.*\.json$/.test(f));
  expect(planFiles).toHaveLength(1);
  const fileName = planFiles[0];
  if (fileName === undefined) {
    throw new Error("No plan file found in .rfapps/plans");
  }
  return join(plansDir, fileName);
}

describe("rfapps stop / plan / apply (integration)", () => {
  let project: FixtureProject;

  beforeEach(async () => {
    project = await createFixtureProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("P1: stop happy path issues a single compose stop", async () => {
    const result = await runCli(["stop", "-s", "web", "--yes"], {
      project,
      scenario: {
        rules: [
          {
            id: "stop",
            match: { prefix: ["compose"], contains: ["stop", "web"] },
            response: { exitCode: 0 },
          },
        ],
      },
    });

    // Assert via invocation log + exit code, never stderr text (streamed output).
    expect(result.exitCode).toBe(0);
    expect(result.invocations).toHaveLength(1);
    expect(argvLines(result.invocations)[0]).toMatch(
      /^compose -f .*compose\.yml --profile all stop web$/,
    );
  });

  it("P2: stop failure surfaces in machine output with exit 1", async () => {
    const result = await runCli(["stop", "-s", "web", "--yes", "--output", "json"], {
      project,
      scenario: {
        rules: [
          {
            id: "stop-fail",
            match: { prefix: ["compose"], contains: ["stop"] },
            response: { exitCode: 1, stderr: "some compose failure\n" },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as StopResult;
    expect(parsed.failed[0]?.name).toBe("stop");
    // Streamed stderr is empty by design (stop.ts) — the action substitutes this text.
    expect(parsed.failed[0]?.error).toBe("See output above for details");
    expect(parsed.stopped).toBe(0);
    expect(result.stderr).toContain("Docker stop failed for web");
    // The mock's stderr reaches the CLI's own stderr via the inherited fd.
    expect(result.stderr).toContain("some compose failure");
    expect(result.invocations).toHaveLength(1);
  });

  it("P3: plan creates a plan file with id, composeHash, and a create change", async () => {
    const result = await runCli(["plan", "-s", "web", "--yes"], {
      project,
      scenario: { rules: planRules() },
    });

    expect(result.exitCode).toBe(0);
    const planPath = await findSavedPlanPath(project);
    const plan = JSON.parse(await readFile(planPath, "utf8")) as DeploymentPlan;
    expect(plan.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(plan.composeHash).toMatch(/^[0-9a-f]{64}$/);
    const webChange = plan.services.find((s) => s.service === "web");
    expect(webChange?.changeType).toBe("create");
  });

  it("P4: plan then apply round-trip records an apply row linked to the plan", async () => {
    // Phase 1: generate the plan (same rules as P3).
    const planResult = await runCli(["plan", "-s", "web", "--yes"], {
      project,
      scenario: { rules: planRules() },
    });
    expect(planResult.exitCode).toBe(0);
    const planPath = await findSavedPlanPath(project);
    const plan = JSON.parse(await readFile(planPath, "utf8")) as DeploymentPlan;

    // Phase 2: apply the plan (runCli truncates the invocation log per call).
    // Apply never runs the DB-phase inspect (imageTag comes from the plan), so
    // the shared rule set's `inspect-db` rule simply goes unmatched — kept for parity.
    const result = await runCli(["apply", planPath, "--yes"], {
      project,
      scenario: {
        rules: [
          pullOk,
          upOk,
          ...deployReadinessRules({
            runningNames: ["fixture-web-1"],
            dbInspectServices: [{ name: "web", image: "nginx:1.27" }],
          }),
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    expectInvocationOrder(result.invocations, ["pull", "up"]);

    // Apply/deploy asymmetry (plan correction 1): apply's up never passes --pull never.
    const upLine = argvLines(result.invocations).find((line) => line.includes(" up -d "));
    expect(upLine).toBeDefined();
    expect(upLine).toContain("--remove-orphans");
    expect(upLine).not.toContain("--pull never");

    const db = openStateDb(project);
    try {
      const rows = db
        .prepare("SELECT service, action, status, plan_id FROM deployments")
        .all() as Array<{
        service: string;
        action: string;
        status: string;
        plan_id: string | null;
      }>;
      expect(rows).toEqual([
        { service: "web", action: "apply", status: "success", plan_id: plan.id },
      ]);
    } finally {
      db.close();
    }
    // Two runCli phases: per-test timeout must exceed the summed 12s harness
    // budgets so the harness's loud SIGKILL failure still fires before vitest's.
  }, 30_000);

  it("P5: stale plan is rejected before any docker call", async () => {
    // Phase 1: generate the plan.
    const planResult = await runCli(["plan", "-s", "web", "--yes"], {
      project,
      scenario: { rules: planRules() },
    });
    expect(planResult.exitCode).toBe(0);
    const planPath = await findSavedPlanPath(project);

    // Mutate the compose file so the stored composeHash no longer matches.
    await appendFile(project.composePath, "\n# mutated\n");

    // Phase 2: apply must fail during validation, before any docker spawn.
    const result = await runCli(["apply", planPath, "--yes"], {
      project,
      scenario: { rules: [] },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Plan validation failed");
    expect(result.stderr).toContain(
      "Compose file has changed since plan was created. Use --force to apply anyway.",
    );
    expect(result.invocations).toHaveLength(0);
    expect(existsSync(project.stateDbPath)).toBe(false);
    // Two runCli phases: see P4's timeout note.
  }, 30_000);
});
