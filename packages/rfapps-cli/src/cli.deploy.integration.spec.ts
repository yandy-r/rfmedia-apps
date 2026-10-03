/**
 * Integration tests for `rfapps deploy`.
 *
 * Spawns the real src/cli.ts via tsx with a mock `docker` on PATH — see
 * src/testing/cli-harness.ts and src/testing/mock-docker.ts.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FIXTURE_CONFIG_YAML,
  createFixtureProject,
  expectInvocationOrder,
  expectNoInvocationMatching,
  openStateDb,
  runCli,
} from "./testing/cli-harness.js";
import type { FixtureProject } from "./testing/cli-harness.js";
import {
  deployReadinessRules,
  preflightBlockedRules,
  preflightInconclusiveRules,
  preflightPassRules,
  preflightReadRuleIds,
  preflightRuleIds,
  pullOk,
  upOk,
} from "./testing/deploy-scenarios.js";
import { argvLines, composePsStatusJson } from "./testing/mock-docker.js";
import type { DockerInvocation, MockDockerRule } from "./testing/mock-docker.js";
import type { ConflictValidationResult, DeployResult } from "./types/index.js";

interface ValidateFirstDryRunResult {
  readonly dryRun: boolean;
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
  readonly validation: ConflictValidationResult;
}

interface DeploymentRow {
  readonly service: string;
  readonly action: string;
  readonly status: string;
  readonly image_tag: string | null;
  readonly plan_id: string | null;
}

interface PartialDeploymentRow {
  readonly service: string;
  readonly status: string;
  readonly error_message: string | null;
}

interface GenerationRow {
  readonly service: string;
  readonly created_by_action: string;
}

const deployWorkRuleIds = new Set([
  "pull",
  "up",
  "up-fail",
  "config-json",
  "config-services",
  "ps-a-json",
  "ps-service-map",
  "ps-running-names",
  "inspect-readiness",
  "inspect-db",
]);

function preflightPaths(project: FixtureProject): {
  readonly composePath: string;
  readonly envFile: string;
} {
  return {
    composePath: project.composePath,
    envFile: join(project.projectDir, ".env.local"),
  };
}

function expectNoDeployWork(invocations: readonly DockerInvocation[]): void {
  expect(
    invocations
      .map((invocation) => invocation.matchedRuleId)
      .filter((ruleId) => ruleId !== null && deployWorkRuleIds.has(ruleId)),
  ).toEqual([]);
  expectNoInvocationMatching(invocations, { contains: ["pull"] });
  expectNoInvocationMatching(invocations, { contains: ["up", "-d"] });
}

describe("rfapps deploy (integration)", () => {
  let project: FixtureProject;

  beforeEach(async () => {
    project = await createFixtureProject();
    await writeFile(join(project.projectDir, ".env.local"), "", "utf8");
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("D1: happy path pulls, ups, and records a success row + generation", async () => {
    const result = await runCli(["deploy", "-s", "web", "--yes"], {
      project,
      scenario: {
        rules: [
          pullOk,
          upOk,
          // dbInspectServices exactly equals the deployed list ["web"] — see
          // deploy-scenarios.ts for the early-return constraint.
          ...deployReadinessRules({
            runningNames: ["fixture-web-1"],
            dbInspectServices: [{ name: "web", image: "nginx:1.27" }],
          }),
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    expectInvocationOrder(result.invocations, ["pull", "up"]);

    const upLines = argvLines(result.invocations).filter((line) => line.includes(" up -d "));
    expect(upLines).toHaveLength(1);
    const upLine = upLines[0] ?? "";
    // startServices always emits --remove-orphans; deploy's up adds --pull never
    // (noPull: !skipPull) — plan correction 1.
    expect(upLine).toContain("--remove-orphans");
    expect(upLine).toContain("--pull never");
    expect(upLine).toContain(`-f ${project.composePath}`);
    expect(upLine).toContain("--profile all");
    expect(upLine.endsWith(" web")).toBe(true);

    // Exactly one DB-phase inspect: the retry loop early-returned on attempt 1
    // (canned entries exactly equal the deployed-service list — plan correction 16).
    const dbInspects = result.invocations.filter((i) => i.matchedRuleId === "inspect-db");
    expect(dbInspects).toHaveLength(1);

    const db = openStateDb(project);
    try {
      const deployments = db
        .prepare("SELECT service, action, status, image_tag, plan_id FROM deployments")
        .all() as DeploymentRow[];
      expect(deployments).toEqual([
        {
          service: "web",
          action: "deploy",
          status: "success",
          image_tag: "nginx:1.27",
          plan_id: null,
        },
      ]);
      const generations = db
        .prepare("SELECT service, created_by_action FROM generations")
        .all() as GenerationRow[];
      expect(generations).toEqual([{ service: "web", created_by_action: "deploy" }]);
    } finally {
      db.close();
    }
    expect(existsSync(join(project.homeDir, ".rfapps"))).toBe(false);
  });

  it("D2: --dry-run touches neither docker nor the state DB", async () => {
    const result = await runCli(["deploy", "-s", "web", "--dry-run", "--yes"], {
      project,
      scenario: { rules: [] },
    });

    expect(result.exitCode).toBe(0);
    expect(result.invocations).toHaveLength(0);
    expect(existsSync(project.stateDbPath)).toBe(false);
  });

  it("D2a: a held state lock blocks mutation before Docker while dry-run remains lock-free", async () => {
    const lockDirectory = join(project.homeDir, ".rfapps");
    const lockPath = join(lockDirectory, "lock");
    const lockId = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, lockId),
      `${JSON.stringify({
        operation: "rebuild",
        who: "other@host",
        when: new Date().toISOString(),
        lockId,
      })}\n`,
      { mode: 0o600 },
    );

    const blocked = await runCli(["deploy", "-s", "web", "--yes"], {
      project,
      scenario: { rules: [] },
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("State lock is held for rebuild by other@host");
    expect(blocked.invocations).toHaveLength(0);

    const recoveryPreview = await runCli(["force-unlock", "--dry-run", "--yes"], {
      project,
      scenario: { rules: [] },
    });
    expect(recoveryPreview.exitCode).toBe(0);
    expect(recoveryPreview.stderr).toContain("would be removed");
    expect(existsSync(lockPath)).toBe(true);

    const preview = await runCli(["deploy", "-s", "web", "--dry-run", "--yes"], {
      project,
      scenario: { rules: [] },
    });
    expect(preview.exitCode).toBe(0);
    expect(preview.invocations).toHaveLength(0);
  }, 30_000);

  it("V1: passing validate-first dry-run emits one deterministic document without mutation", async () => {
    const paths = preflightPaths(project);
    const args = ["deploy", "-s", "web", "--validate-first", "--dry-run", "--yes", "--json"];
    const first = await runCli(args, {
      project,
      scenario: { rules: preflightPassRules(paths) },
    });
    const second = await runCli(args, {
      project,
      scenario: { rules: preflightPassRules(paths) },
    });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    const document = JSON.parse(first.stdout) as ValidateFirstDryRunResult;
    expect(document).toMatchObject({
      dryRun: true,
      services: ["web"],
      profiles: ["all"],
      composePath: project.composePath,
      validation: {
        schemaVersion: "conflict-validation.v1",
        status: "passed",
        scope: {
          project: "fixture",
          services: ["web"],
          profiles: ["all"],
        },
      },
    });

    const expectedReadRuleIds = [
      preflightRuleIds.composeCanonical,
      preflightRuleIds.authorityContextShow,
      preflightRuleIds.authorityContextInspect,
      preflightRuleIds.authorityInfo,
      preflightRuleIds.containerList,
      preflightRuleIds.networkList,
      preflightRuleIds.networkInspect,
      preflightRuleIds.volumeList,
      preflightRuleIds.volumeInspect,
    ];
    expect(first.invocations.map((invocation) => invocation.matchedRuleId).toSorted()).toEqual(
      expectedReadRuleIds.toSorted(),
    );
    expectInvocationOrder(first.invocations, [
      preflightRuleIds.authorityContextShow,
      preflightRuleIds.authorityContextInspect,
    ]);
    expectInvocationOrder(first.invocations, [
      preflightRuleIds.authorityContextShow,
      preflightRuleIds.authorityInfo,
    ]);
    expectInvocationOrder(first.invocations, [
      preflightRuleIds.networkList,
      preflightRuleIds.networkInspect,
    ]);
    expectInvocationOrder(first.invocations, [
      preflightRuleIds.volumeList,
      preflightRuleIds.volumeInspect,
    ]);
    expectNoDeployWork(first.invocations);
    expect(existsSync(project.stateDbPath)).toBe(false);
  }, 30_000);

  it("V2: validate-first runtime port conflict blocks before mutation, readiness, and state", async () => {
    const result = await runCli(["deploy", "-s", "web", "--validate-first", "--yes", "--json"], {
      project,
      scenario: { rules: preflightBlockedRules(preflightPaths(project)) },
    });

    expect(result.exitCode).toBe(1);
    const document = JSON.parse(result.stdout) as DeployResult;
    expect(document).toMatchObject({
      services: [],
      started: 0,
      failed: [{ name: "validation", code: "SERVICE_CONFLICT" }],
      validation: {
        schemaVersion: "conflict-validation.v1",
        status: "blocked",
        scope: {
          project: "fixture",
          services: ["web"],
          profiles: ["all"],
        },
      },
    });
    expectInvocationOrder(result.invocations, [
      preflightRuleIds.composeCanonical,
      preflightRuleIds.containerList,
      preflightRuleIds.containerInspect,
    ]);
    expect(result.invocations.some((invocation) => invocation.matchedRuleId === null)).toBe(false);
    expect(
      result.invocations.some(
        (invocation) => invocation.matchedRuleId === preflightRuleIds.composeRevalidation,
      ),
    ).toBe(false);
    expectNoDeployWork(result.invocations);
    expect(existsSync(project.stateDbPath)).toBe(false);
  });

  it("V3: validate-first required-evidence failure is inconclusive at the same boundary", async () => {
    const result = await runCli(["deploy", "-s", "web", "--validate-first", "--yes", "--json"], {
      project,
      scenario: { rules: preflightInconclusiveRules(preflightPaths(project)) },
    });

    expect(result.exitCode).toBe(1);
    const document = JSON.parse(result.stdout) as DeployResult;
    expect(document).toMatchObject({
      services: [],
      started: 0,
      failed: [{ name: "validation", code: "VALIDATION_INCONCLUSIVE" }],
      validation: {
        schemaVersion: "conflict-validation.v1",
        status: "inconclusive",
        scope: {
          project: "fixture",
          services: ["web"],
          profiles: ["all"],
        },
        checks: [
          { id: "compose", status: "passed", required: true, resources: 1 },
          { id: "scope", status: "passed", required: true, resources: 1 },
          { id: "authority", status: "passed", required: true, resources: 2 },
          {
            id: "containers",
            status: "failed",
            required: true,
            resources: 0,
            failure: {
              code: "CONTAINER_SNAPSHOT_UNAVAILABLE",
              check: "containers",
              message: "Docker container evidence was unavailable",
            },
          },
          { id: "volumes", status: "passed", required: true, resources: 0 },
          { id: "networks", status: "passed", required: true, resources: 0 },
          { id: "normalization", status: "passed", required: true, resources: 2 },
        ],
        summary: {
          total: 0,
          errors: 0,
          warnings: 0,
          ports: 0,
          volumes: 0,
          networks: 0,
        },
        conflicts: [],
        warnings: [],
        error: {
          code: "CONTAINER_SNAPSHOT_UNAVAILABLE",
          check: "containers",
          message: "Docker container evidence was unavailable",
        },
      },
    });
    expectInvocationOrder(result.invocations, [
      preflightRuleIds.containerList,
      preflightRuleIds.containerInspect,
    ]);
    expect(result.invocations.some((invocation) => invocation.matchedRuleId === null)).toBe(false);
    expect(
      result.invocations.some(
        (invocation) => invocation.matchedRuleId === preflightRuleIds.composeRevalidation,
      ),
    ).toBe(false);
    expectNoDeployWork(result.invocations);
    expect(existsSync(project.stateDbPath)).toBe(false);
  });

  it("V4: passing validate-first revalidates its binding before handing off to deploy", async () => {
    const result = await runCli(["deploy", "-s", "web", "--validate-first", "--yes", "--json"], {
      project,
      scenario: {
        rules: [
          ...preflightPassRules(preflightPaths(project)),
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
    const document = JSON.parse(result.stdout) as DeployResult;
    expect(document).toMatchObject({
      services: ["web"],
      started: 1,
      validation: {
        schemaVersion: "conflict-validation.v1",
        status: "passed",
      },
    });
    expectInvocationOrder(result.invocations, [
      preflightRuleIds.composeCanonical,
      preflightRuleIds.composeRevalidation,
      "pull",
      "up",
      "config-json",
      "inspect-db",
    ]);

    const ruleIds = result.invocations.map((invocation) => invocation.matchedRuleId);
    const pullIndex = ruleIds.indexOf("pull");
    expect(pullIndex).toBeGreaterThan(-1);
    const allowedBeforeMutation = new Set<string>(preflightReadRuleIds);
    expect(
      ruleIds
        .slice(0, pullIndex)
        .filter((ruleId): ruleId is string => ruleId !== null)
        .every((ruleId) => allowedBeforeMutation.has(ruleId)),
    ).toBe(true);
    expect(ruleIds.slice(0, pullIndex)).toContain(preflightRuleIds.composeRevalidation);
    expect(
      ruleIds.slice(0, pullIndex).filter((ruleId) => ruleId === preflightRuleIds.authorityInfo),
    ).toHaveLength(2);
    expect(result.invocations.some((invocation) => invocation.matchedRuleId === null)).toBe(false);

    const db = openStateDb(project);
    try {
      const deployments = db
        .prepare("SELECT service, action, status, image_tag, plan_id FROM deployments")
        .all() as DeploymentRow[];
      expect(deployments).toEqual([
        {
          service: "web",
          action: "deploy",
          status: "success",
          image_tag: "nginx:1.27",
          plan_id: null,
        },
      ]);
    } finally {
      db.close();
    }
    expect(existsSync(project.stateDbPath)).toBe(true);
    expect(existsSync(join(project.homeDir, ".rfapps"))).toBe(false);
  });

  it("D3: pull failure stops before up and writes no DB", async () => {
    const result = await runCli(["deploy", "-s", "web", "--yes", "--json"], {
      project,
      scenario: {
        rules: [
          {
            id: "pull-fail",
            match: { prefix: ["compose"], contains: ["pull"] },
            response: {
              exitCode: 1,
              stderr:
                'Get "https://registry-1.docker.io/v2/": net/http: request canceled (Client.Timeout exceeded)\n',
            },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as DeployResult;
    expect(parsed.failed[0]?.name).toBe("pull");
    // Streamed pull captures no stderr, so the failure entry falls back to
    // ImagePullError's message (plan correction 9).
    expect(parsed.failed[0]?.error).toContain("Failed to pull images");
    // Mock stderr reaches the CLI's own stderr through the inherited fd…
    expect(result.stderr).toContain("registry-1.docker.io");
    // …and the formatted ImagePullError block lands on stderr too.
    expect(result.stderr).toContain("Failed to pull images for web");
    expectNoInvocationMatching(result.invocations, { contains: ["up"] });
    expect(existsSync(project.stateDbPath)).toBe(false);
    expect(existsSync(join(project.homeDir, ".rfapps", "lock"))).toBe(false);
  });

  it("D4: up port conflict fails before readiness and writes no DB", async () => {
    const result = await runCli(["deploy", "-s", "web", "--yes"], {
      project,
      scenario: {
        rules: [
          pullOk,
          {
            id: "up-fail",
            match: { prefix: ["compose"], contains: ["up", "-d"] },
            response: {
              exitCode: 1,
              stderr: "Bind for 0.0.0.0:8080 failed: port is already allocated\n",
            },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Failed to start services");
    expect(result.stderr).toContain("port is already allocated");
    expect(result.invocations.map((invocation) => invocation.matchedRuleId)).toEqual([
      "pull",
      "up-fail",
    ]);
    // Early return on up failure — the readiness phase (compose config …) never runs.
    expectNoInvocationMatching(result.invocations, { contains: ["config"] });
    expect(existsSync(project.stateDbPath)).toBe(false);
  });

  it("D5: up container-name conflict fails the same way", async () => {
    const result = await runCli(["deploy", "-s", "web", "--yes"], {
      project,
      scenario: {
        rules: [
          pullOk,
          {
            id: "up-fail",
            match: { prefix: ["compose"], contains: ["up", "-d"] },
            response: {
              exitCode: 1,
              stderr: 'Conflict. The container name "/web" is already in use\n',
            },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already in use");
    expectNoInvocationMatching(result.invocations, { contains: ["config"] });
  });

  it("D6: unknown service exits 2 with a did-you-mean suggestion", async () => {
    const result = await runCli(["deploy", "-s", "webz", "--yes"], {
      project,
      scenario: { rules: [] },
    });

    // ServiceNotFoundError's formatter registers ExitCode.UsageError (2) and
    // handleCliError exits with the formatter's code (plan correction 15).
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("webz");
    expect(result.stderr).toContain("Did you mean 'web'?");
    expect(result.invocations).toHaveLength(0);
  });

  it("D7: partial success exits 3 and records mixed DB rows", async () => {
    const result = await runCli(["deploy", "--services", "web,db", "--allow-partial", "--yes"], {
      project,
      scenario: {
        rules: [
          pullOk,
          upOk,
          // runningNames omits any db-containing name → `db` is marked unhealthy
          // after a successful up (plan correction 4). deployedServices is
          // ["web","db"], so inspect-db must return exactly those two entries.
          ...deployReadinessRules({
            runningNames: ["fixture-web-1"],
            dbInspectServices: [
              { name: "web", image: "nginx:1.27" },
              { name: "db", image: "postgres:16" },
            ],
          }),
        ],
      },
    });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("health-check");

    const dbInspects = result.invocations.filter((i) => i.matchedRuleId === "inspect-db");
    expect(dbInspects).toHaveLength(1);

    const db = openStateDb(project);
    try {
      const deployments = db
        .prepare("SELECT service, status, error_message FROM deployments ORDER BY service")
        .all() as PartialDeploymentRow[];
      expect(deployments).toEqual([
        { service: "db", status: "failed", error_message: "Service failed to start" },
        { service: "web", status: "success", error_message: null },
      ]);
      // Failed rows create no generations row.
      const generations = db.prepare("SELECT service FROM generations").all() as {
        readonly service: string;
      }[];
      expect(generations).toEqual([{ service: "web" }]);
    } finally {
      db.close();
    }
  });

  it("D8: --staged --batch-size 1 halts before the second batch and records the untouched service", async () => {
    // Dedicated fixture so envTool can be pinned to `none`: partialToFull
    // defaults envTool.tool to "dotenvx" (config.ts:217) and CI runners have no
    // dotenvx binary. `deploy` resolves its env tool through the ONE-argument
    // getEnvToolExecConfig(globalOptions) overload, which ignores config
    // entirely, so the pin changes no argv — it just removes the failure mode
    // from this fixture for good.
    const staged = await createFixtureProject({
      configYaml: `${DEFAULT_FIXTURE_CONFIG_YAML}envTool:
  tool: none
`,
    });
    await writeFile(join(staged.projectDir, ".env.local"), "", "utf8");

    try {
      // Batch membership: both fixture services map to profile `all` (never
      // `core`) and neither declares depends_on, so every service is tier 0 with
      // fan-in 0 and blast-radius ordering falls through to the name tiebreak —
      // batch 1 = db, batch 2 = web.
      //
      // ps-a-json must be hand-overridden because deployReadinessRules hard-codes
      // both services to `running`. Reporting `db` as exited, while ps-service-map
      // maps only web -> fixture-web-1, leaves db with no container: the batch
      // observer skips `docker inspect` and db.exitCode stays undefined.
      // classifyTargetObservation tests `state === "exited"` before the
      // imageId/exitCode telemetry branches, and isCompletedOneShot needs
      // exitCode === 0, so the gate returns a terminal `failed` verdict on
      // attempt 1 and the rollout halts.
      const rules: MockDockerRule[] = deployReadinessRules({
        runningNames: ["fixture-web-1"],
        // On a halt `attempted` is ["db"], and the canned inspect list must equal
        // it exactly or inspectContainersWithRetry burns its full retry loop.
        dbInspectServices: [{ name: "db", image: "postgres:16" }],
      }).map((rule) =>
        rule.id === "ps-a-json"
          ? {
              ...rule,
              response: {
                stdout: composePsStatusJson([
                  { Service: "db", State: "exited" },
                  { Service: "web", State: "running" },
                ]),
                exitCode: 0,
              },
            }
          : rule,
      );

      // --wait-for-ready is load-bearing: the fixture config pins
      // healthCheck.waitForReady: false and Commander leaves the flag undefined,
      // so without it the per-batch gate never runs and nothing can halt.
      const result = await runCli(
        [
          "deploy",
          "--services",
          "web,db",
          "--staged",
          "--batch-size",
          "1",
          "--wait-for-ready",
          "--yes",
        ],
        { project: staged, scenario: { rules: [pullOk, upOk, ...rules] } },
      );

      expect(result.exitCode).toBe(1);
      expectInvocationOrder(result.invocations, ["pull", "up"]);

      // Exactly one start, and it is the canary — batch 2 issued no Docker work.
      const upLines = argvLines(result.invocations).filter((line) => line.includes(" up -d "));
      expect(upLines).toHaveLength(1);
      expect((upLines[0] ?? "").endsWith(" db")).toBe(true);
      expectNoInvocationMatching(result.invocations, { contains: ["up", "-d", "web"] });
      // The parallel start operation strips --remove-orphans, so the orphan
      // cleanup pass is its only possible source; skipping it on a halt is what
      // keeps the pass from starting the very services the halt protects.
      expectNoInvocationMatching(result.invocations, { contains: ["--remove-orphans"] });

      // The DB-phase inspect is scoped to `attempted`, so it early-returns on
      // attempt 1 instead of burning the ~3s retry loop.
      const dbInspects = result.invocations.filter((i) => i.matchedRuleId === "inspect-db");
      expect(dbInspects).toHaveLength(1);

      const db = openStateDb(staged);
      try {
        const deployments = db
          .prepare("SELECT service, status, error_message FROM deployments ORDER BY service")
          .all() as PartialDeploymentRow[];
        expect(deployments).toHaveLength(2);
        const dbRow = deployments.find((row) => row.service === "db");
        expect(dbRow?.status).toBe("failed");
        const webRow = deployments.find((row) => row.service === "web");
        expect(webRow?.status).toBe("failed");
        // STAGE_NOT_ATTEMPTED is what keeps a halted rollout off exit code 0.
        expect(webRow?.error_message).toMatch(/^Not attempted:/);

        const generations = db.prepare("SELECT service FROM generations").all() as {
          readonly service: string;
        }[];
        expect(generations).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      await staged.cleanup();
    }
  }, 30_000);
});
