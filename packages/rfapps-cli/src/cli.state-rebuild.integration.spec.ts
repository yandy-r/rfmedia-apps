/**
 * Integration test for `rfapps state rebuild` state-lock wiring.
 *
 * Spawns the real src/cli.ts via tsx with a mock `docker` on PATH — see
 * src/testing/cli-harness.ts and src/testing/mock-docker.ts.
 *
 * Why a spawned CLI: `resolveStateLockOperation` is module-private in cli.ts and
 * has no unit test, and `"rebuild"` is in `ALWAYS_MUTATING_COMMANDS`. Without the
 * `parentName === "state"` branch a READ-ONLY `rfapps state rebuild` report would
 * acquire the global lock labelled `rebuild`, be blocked, and exit 1 — the
 * highest-probability silent bug in this change. Only a spawned CLI exercises it.
 *
 * Why the fixture lock says `deploy`: state-lock.ts's `contentionError` renders
 * `State lock is held for ${metadata.operation} by ...` from the HOLDER's stored
 * metadata — never the label the blocked command requested. A pre-created lock
 * can therefore never surface `"state-rebuild"`, so this file deliberately
 * asserts the holder's label and never the requester's.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FIXTURE_CONFIG_YAML,
  createFixtureProject,
  runCli,
} from "./testing/cli-harness.js";
import type { FixtureProject } from "./testing/cli-harness.js";
import { composeConfigJson } from "./testing/mock-docker.js";
import type { MockDockerRule } from "./testing/mock-docker.js";

/**
 * `docker compose ... config --format json`, served to BOTH config calls the
 * report makes (resolveComposeProjectIdentity's internal one and the action's
 * own). The project name must match identity.ts's /^[a-z0-9][a-z0-9_-]*$/u or
 * resolveComposeProjectIdentity throws a plain Error and the run exits 1.
 */
const composeConfigRule: MockDockerRule = {
  id: "config-json",
  match: { prefix: ["compose"], contains: ["config", "--format", "json"] },
  response: {
    stdout: composeConfigJson({
      name: "fixture",
      services: { web: { image: "nginx:1.27" }, db: { image: "postgres:16" } },
    }),
    exitCode: 0,
  },
};

/**
 * `docker compose ... ps --all --format json` — the created-and-running view the
 * rebuild observes. `normalizeComposeObservationItem` (docker.ts) fails closed
 * unless every entry carries a hex `ID` plus non-empty `Name`, `Service` and
 * `State` and a string `Health` (real Compose emits `""` when no healthcheck is
 * configured), so they are spelled out here rather than approximated.
 */
const composePsAllRule: MockDockerRule = {
  id: "ps-all-json",
  match: { prefix: ["compose"], contains: ["ps", "--all", "--format", "json"] },
  response: {
    stdout: JSON.stringify([
      { ID: "a1b2c3d4e5f6", Name: "fixture-web-1", Service: "web", State: "running", Health: "" },
      { ID: "f6e5d4c3b2a1", Name: "fixture-db-1", Service: "db", State: "exited", Health: "" },
    ]),
    exitCode: 0,
  },
};

describe("rfapps state rebuild (integration)", () => {
  let project: FixtureProject;

  beforeEach(async () => {
    // envTool MUST be pinned to `none`. partialToFull defaults envTool.tool to
    // "dotenvx" (config.ts:217), and unlike the other integration specs this one
    // has to write a real .env.local (see below) — which is exactly the condition
    // that makes the CLI actually spawn `dotenvx`. CI runners have no dotenvx
    // binary, so leaving the default turns every compose call into
    // `spawn dotenvx ENOENT`. This test is about lock wiring, not secrets
    // injection, so it must not depend on an external binary.
    project = await createFixtureProject({
      configYaml: `${DEFAULT_FIXTURE_CONFIG_YAML}envTool:
  tool: none
`,
    });
    // getComposeContainerObservations canonicalizes config.envFile (default
    // <projectDir>/.env.local) through safeEnvironmentFilePath, which demands a
    // real regular file; createFixtureProject does not write one.
    await writeFile(join(project.projectDir, ".env.local"), "", "utf8");
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("keeps the report lock-free while --rewrite locks before any Docker call", async () => {
    const lockPath = join(project.homeDir, ".rfapps", "lock");
    const lockId = "123e4567-e89b-42d3-a456-426614174000";
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockPath, lockId),
      `${JSON.stringify({
        operation: "deploy",
        who: "other@host",
        when: new Date().toISOString(),
        lockId,
      })}\n`,
      { mode: 0o600 },
    );

    // A: the report phase takes no lock, so a held lock cannot block it.
    const report = await runCli(["state", "rebuild"], {
      project,
      scenario: { rules: [composeConfigRule, composePsAllRule] },
    });
    expect(report.exitCode, report.stderr).toBe(0);
    expect(report.invocations.length).toBeGreaterThan(0);

    // B: the rewrite locks in cli.ts's preAction, before any Docker call.
    const blocked = await runCli(["state", "rebuild", "--rewrite", "--yes"], {
      project,
      scenario: { rules: [] },
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("State lock is held for deploy by other@host");
    expect(blocked.invocations).toHaveLength(0);
  }, 30_000);
});
