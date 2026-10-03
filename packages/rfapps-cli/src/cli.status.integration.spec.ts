/**
 * Integration tests for `rfapps status` and global CLI behavior.
 *
 * Spawns the real src/cli.ts via tsx with a mock `docker` on PATH — see
 * src/testing/cli-harness.ts and src/testing/mock-docker.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FIXTURE_CONFIG_YAML,
  createFixtureProject,
  expectInvocationOrder,
  expectNoInvocationMatching,
  runCli,
} from "./testing/cli-harness.js";
import type { FixtureProject } from "./testing/cli-harness.js";
import { dockerPsEntry, dockerPsJson } from "./testing/mock-docker.js";
import type { MockDockerRule } from "./testing/mock-docker.js";
import type { StatusResult } from "./types/index.js";

const psRule = (stdout: string): MockDockerRule => ({
  id: "ps",
  match: { prefix: ["ps"], contains: ["--format", "json"] },
  response: { stdout, exitCode: 0 },
});

describe("rfapps status (integration)", () => {
  let project: FixtureProject;

  beforeEach(async () => {
    project = await createFixtureProject();
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("S1: --json emits a single pure-JSON document on stdout (happy path)", async () => {
    const result = await runCli(["status", "-s", "web", "--json"], {
      project,
      scenario: {
        rules: [
          psRule(
            dockerPsJson([
              dockerPsEntry({
                Names: "web",
                State: "running",
                Status: "Up 5 seconds",
                Image: "nginx:1.27",
                ID: "0123456789abcdef",
              }),
            ]),
          ),
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    // Whole stdout is one JSON document — nothing may precede it.
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(result.stdout) as StatusResult;
    expect(parsed.services[0]?.name).toBe("web");
    expect(parsed.services[0]?.containerId).toBe("0123456789ab");
    expect(parsed.total).toBe(1);
    expect(parsed.running).toBe(1);
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.matchedRuleId).toBe("ps");
  });

  it("S2: daemon down surfaces the docker error in JSON output with no retry", async () => {
    const result = await runCli(["status", "--json"], {
      project,
      scenario: {
        rules: [
          {
            id: "ps-fail",
            match: { prefix: ["ps"] },
            response: {
              exitCode: 1,
              // Deliberately contains NO SSH-retry substrings (docker.ts isSSHError),
              // so the retry loop must not fire.
              stderr:
                "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
            },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { error: string };
    expect(parsed.error).toContain("Cannot connect to the Docker daemon");
    expect(result.stderr).toContain("Docker status failed");
    // Non-SSH failure: exactly one docker invocation — no retry.
    expect(result.invocations).toHaveLength(1);
  });

  it("S3: unknown service name is not an error — empty result (documents real behavior)", async () => {
    // executeStatus never validates service names; it filters `docker ps` output by
    // exact Names equality. An unknown name therefore yields exit 0 with an empty
    // result, NOT ServiceNotFoundError — that coverage lives in the deploy spec (D6).
    const result = await runCli(["status", "-s", "webz", "--json"], {
      project,
      scenario: {
        rules: [psRule(dockerPsJson([dockerPsEntry({ Names: "web" })]))],
      },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as StatusResult;
    expect(parsed.services).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it("S4: unknown subcommand exits 2 (usage error) without touching docker", async () => {
    const result = await runCli(["bogus"], {
      project,
      scenario: { rules: [] },
    });

    // CommanderError branch in cli.ts main() exits with ExitCode.UsageError.
    expect(result.exitCode).toBe(2);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.invocations).toHaveLength(0);
  });

  it("S6: unknown group exits 2 listing available groups", async () => {
    const result = await runCli(["deploy", "-g", "nope", "--yes"], {
      project,
      scenario: { rules: [] },
    });

    // GroupNotFoundError's formatter registers ExitCode.UsageError (2);
    // handleCliError exits with the formatter's code.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope");
    expect(result.stderr).toContain("test-stack");
    expect(result.invocations).toHaveLength(0);
  });

  it("S7: transient SSH failure on docker ps retries after the hard-coded 2s delay", async () => {
    const result = await runCli(["status", "--json"], {
      project,
      // The mandatory 2s retry sleep makes this the slowest test in the suite:
      // raise the harness budget toward this test's 20s timeout (kept below it
      // so the harness's loud partial-output failure still fires first).
      timeoutMs: 18_000,
      scenario: {
        rules: [
          {
            id: "ps-ssh-fail",
            match: { prefix: ["ps"] },
            times: 1,
            response: {
              exitCode: 1,
              // Matches docker.ts isSSHError ("connection reset by peer") →
              // triggers the retry loop in execDockerCommand.
              stderr: "read tcp 10.0.0.1:22: connection reset by peer\n",
            },
          },
          psRule(dockerPsJson([dockerPsEntry({ Names: "web" })])),
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.invocations).toHaveLength(2);
    expectInvocationOrder(result.invocations, ["ps-ssh-fail", "ps"]);

    // Retry-delay tripwire via invocation-log timestamps — NOT whole-run
    // durationMs, which is dominated by node/tsx startup noise and would keep
    // passing even if the retry sleep vanished. The hard-coded retryDelay of
    // 2000ms (docker.ts DEFAULT_OPTIONS) must separate the two ps calls. If
    // config.docker.sshRetry is ever plumbed into the action call paths (the
    // fixture sets delayMs: 100, currently inert), this fails loudly.
    // Timestamps are per-process wall clocks while the sleep is monotonic, so
    // allow 100ms of clock-skew slack below the 2000ms floor; the upper bound
    // still catches a config-plumbed 100ms delay or a vanished sleep replaced
    // by an unbounded stall.
    const [first, second] = result.invocations;
    if (first === undefined || second === undefined) {
      throw new Error("expected two logged docker invocations");
    }
    const deltaMs = Date.parse(second.timestamp) - Date.parse(first.timestamp);
    expect(deltaMs).toBeGreaterThanOrEqual(1900);
    expect(deltaMs).toBeLessThan(10_000);

    const parsed = JSON.parse(result.stdout) as StatusResult;
    expect(parsed.total).toBe(1);
  }, 20_000);
});

/**
 * The default fixture config plus a `tags:` block whose service keys (`web`, `db`)
 * both exist in the fixture compose file. Composed by appending to the harness's
 * exported default rather than by restating it, so the four sections
 * `partialToFull` requires (sidecars.mapping, groups, profiles.mapping,
 * profiles.validProfiles) stay satisfied if the harness default ever changes —
 * `cli-harness.ts` is shared and must not be edited for this suite.
 *
 * Only LEAF paths are stored; `infrastructure` and `infrastructure/edge` are
 * derived by the index's ancestor closure, which is what `infrastructure/**`
 * below relies on.
 */
const TAGGED_FIXTURE_CONFIG_YAML = `${DEFAULT_FIXTURE_CONFIG_YAML}tags:
  mapping:
    web:
      - infrastructure/edge/ingress
    db:
      - data/postgres
`;

describe("rfapps status --tag (integration)", () => {
  let project: FixtureProject;

  beforeEach(async () => {
    project = await createFixtureProject({ configYaml: TAGGED_FIXTURE_CONFIG_YAML });
  });

  afterEach(async () => {
    await project.cleanup();
  });

  it("S8: --tag narrows docker ps rows to the matching service keys and exits 0", async () => {
    const result = await runCli(["status", "--tag", "infrastructure/**", "--json"], {
      project,
      scenario: {
        rules: [
          psRule(
            dockerPsJson([
              dockerPsEntry({ Names: "web", Image: "nginx:1.27", ID: "0123456789abcdef" }),
              dockerPsEntry({ Names: "db", Image: "postgres:16", ID: "fedcba9876543210" }),
            ]),
          ),
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    // Whole stdout is one JSON document — the tag path must not print to stdout.
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    const parsed = JSON.parse(result.stdout) as StatusResult;
    // `db` is tagged `data/postgres`, so the ancestor closure of `web`'s
    // `infrastructure/edge/ingress` is the only thing `infrastructure/**` reaches.
    expect(parsed.services.map((service) => service.name)).toEqual(["web"]);
    expect(parsed.total).toBe(1);
    expect(parsed.running).toBe(1);
    // Still a single bare `docker ps` — §7.9 deliberately drops the
    // `docker compose ps` service-to-container round-trip.
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]?.matchedRuleId).toBe("ps");
  });

  it("S9: a --tag that matches nothing exits 2 and never reaches docker", async () => {
    const result = await runCli(["status", "--tag", "typoo/**", "--json"], {
      project,
      scenario: {
        rules: [psRule(dockerPsJson([dockerPsEntry({ Names: "web" })]))],
      },
    });

    // TagSelectorEmptyError's formatter registers ExitCode.UsageError (2). P2: a
    // zero-match tag must NEVER degrade to "no filter" and report the whole fleet.
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("typoo/**");
    // Resolution happens before listContainers, so nothing is spent on docker.
    expectNoInvocationMatching(result.invocations, {});
  });
});

describe("rfapps CLI without a config file (integration)", () => {
  it("S5: missing config exits 1 with ConfigNotFoundError before any docker call", async () => {
    // Dev-mode caveat (plan correction 6): under tsx, getProjectRoot() walks 3
    // levels up from src/lib → <worktree>/packages, where rfapps.config.yaml does
    // NOT exist (verified), so ConfigNotFoundError fires for a bare fixture cwd.
    // If the harness ever spawns dist/cli.js instead (4 levels up = worktree root,
    // where the real repo's rfapps.config.yaml DOES exist), this test would
    // silently load that config and stop covering ConfigNotFoundError.
    const project = await createFixtureProject({ omitConfig: true });
    try {
      const result = await runCli(["status", "--json"], {
        project,
        scenario: { rules: [] },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Configuration file not found");
      // Catch-all matcher: any docker invocation at all fails this assertion.
      expectNoInvocationMatching(result.invocations, {});
    } finally {
      await project.cleanup();
    }
  });
});
