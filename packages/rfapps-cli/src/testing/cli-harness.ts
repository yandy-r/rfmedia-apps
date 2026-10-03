/**
 * Subprocess harness for rfapps CLI integration tests.
 *
 * Spawns the real `src/cli.ts` via tsx as a child process with a generated mock
 * `docker` executable prepended to PATH (see `mock-docker.ts`), a throwaway
 * fixture project as cwd, and a fake HOME for state-DB isolation.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// better-sqlite3 typings use `export = Database` (class + namespace) — there is NO
// named `Database` export. Mirror src/lib/db.ts:19,31 exactly (plan correction 20).
import Database from "better-sqlite3";

import type { DockerInvocation, MockArgvMatcher, MockDockerScenario } from "./mock-docker.js";
import { matchesArgv, readDockerInvocations, writeMockDocker } from "./mock-docker.js";

export interface FixtureProjectOptions {
  /** Full replacement for the generated rfapps.config.yaml (raw YAML). */
  readonly configYaml?: string;
  /** Full replacement for the default 2-service compose.yml (raw YAML). */
  readonly composeYaml?: string;
  /** Skip writing rfapps.config.yaml entirely (ConfigNotFoundError test S5). */
  readonly omitConfig?: boolean;
}

export interface FixtureProject {
  /** child cwd; contains rfapps.config.yaml + compose.yml */
  readonly projectDir: string;
  /** fake HOME */
  readonly homeDir: string;
  /** <projectDir>/compose.yml */
  readonly composePath: string;
  /** <homeDir>/.config/rfapps/state.db — where deploy/apply's bare initializeDatabase() lands. */
  readonly stateDbPath: string;
  /** rm -rf projectDir + homeDir (+ binDir) */
  cleanup(): Promise<void>;
}

/** Default 2-service compose file for the fixture project. */
const DEFAULT_COMPOSE_YAML = `services:
  web:
    image: nginx:1.27
  db:
    image: postgres:16
`;

/**
 * Default fixture config — satisfies partialToFull's required fields
 * (sidecars.mapping, groups, profiles.mapping, profiles.validProfiles).
 *
 * envFile defaults to .env.local; it need not exist — it is only validated when
 * --use-dotenvx/--use-op are passed, which these tests never do. All compose argv
 * will carry `--profile all`.
 */
export const DEFAULT_FIXTURE_CONFIG_YAML = `composePath: compose.yml
sidecars:
  enabled: false
  mapping: {}
groups:
  test-stack:
    - web
    - db
profiles:
  mapping:
    web: all
    db: all
  validProfiles:
    - all
  defaultProfile: all
healthCheck:
  timeout: 5
  interval: 1
  retries: 2
  waitForReady: false
docker:
  sshRetry: # NOTE: currently unplumbed into action call paths (issue #246); inert.
    maxRetries: 3
    delayMs: 100
`;

/** binDir is deliberately NOT exposed on FixtureProject — it is harness-internal. */
const binDirs = new WeakMap<FixtureProject, string>();

/**
 * Create a throwaway fixture project (cwd for the CLI child) plus a fake HOME.
 *
 * Why a fake HOME (and not env-based DB redirection):
 * - `db.ts` resolves `XDG_RFAPPS_DIR = join(homedir(), ".config", "rfapps")` at
 *   module load, and deploy/apply call `initializeDatabase()` with NO arguments —
 *   `RFAPPS_STATE_DB_PATH`, `config.state.dbPath`, and `state.enabled` are all
 *   ignored by these actions, so only `HOME` isolation actually redirects the DB.
 * - `config.ts:430-459` layers `~/.config/rfapps/config.yaml` and `~/.rfapps.yaml`
 *   over the project config; a fake HOME guarantees the developer's real home
 *   configs can never leak into a test run.
 *
 * Precondition (plan correction 12): `packages/rf-common` must be built
 * (`npm run build -w packages/rf-common`) — `@rfmedia/common`'s package exports
 * point at `dist/*.js`, so the tsx child cannot resolve it on a fresh clone.
 */
export async function createFixtureProject(
  options: FixtureProjectOptions = {},
): Promise<FixtureProject> {
  const projectDir = await mkdtemp(join(tmpdir(), "rfapps-cli-it-proj-"));
  const homeDir = await mkdtemp(join(tmpdir(), "rfapps-cli-it-home-"));
  const binDir = await mkdtemp(join(tmpdir(), "rfapps-cli-it-bin-"));

  const composePath = join(projectDir, "compose.yml");
  await writeFile(composePath, options.composeYaml ?? DEFAULT_COMPOSE_YAML, "utf8");
  if (options.omitConfig !== true) {
    await writeFile(
      join(projectDir, "rfapps.config.yaml"),
      options.configYaml ?? DEFAULT_FIXTURE_CONFIG_YAML,
      "utf8",
    );
  }
  const project: FixtureProject = {
    projectDir,
    homeDir,
    composePath,
    stateDbPath: join(homeDir, ".config", "rfapps", "state.db"),
    cleanup: async (): Promise<void> => {
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    },
  };
  binDirs.set(project, binDir);
  return project;
}

export interface RunCliOptions {
  readonly project: FixtureProject;
  readonly scenario: MockDockerScenario;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Default 12_000 — deliberately below vitest's testTimeout (15_000) so the
   * harness's loud failure (with partial stdout/stderr) always fires before
   * vitest's, and the child's whole process group is SIGKILLed before afterEach
   * cleanup can race its writes (plan correction 17). Tests that call runCli
   * more than once, or raise timeoutMs, must set an explicit per-test timeout
   * above the summed harness budgets to preserve that ordering.
   */
  readonly timeoutMs?: number;
}

export interface CliRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly invocations: readonly DockerInvocation[];
  /** diagnostic only — timing assertions use invocation timestamps (plan correction 18) */
  readonly durationMs: number;
}

const require = createRequire(import.meta.url);

/**
 * Run the real CLI (`src/cli.ts` via tsx) as a subprocess against the fixture
 * project with the given mock-docker scenario.
 *
 * Per call: rewrites the scenario, truncates the invocation log, and clears the
 * `times` counters, so each run's invocations/counters start clean (required for
 * multi-phase plan→apply flows sharing one FixtureProject).
 *
 * The child environment is built from scratch (never spread from process.env):
 * PATH (mock docker first, then node's own dir, then the inherited PATH), fake
 * HOME, TZ/NO_COLOR/FORCE_COLOR, the mock-docker scenario/log vars, and TMPDIR
 * pass-through. `INIT_CWD` and every inherited `RFAPPS_*` are deliberately
 * dropped so the developer's environment cannot leak into a test.
 */
export async function runCli(
  args: readonly string[],
  options: RunCliOptions,
): Promise<CliRunResult> {
  const binDir = binDirs.get(options.project);
  if (binDir === undefined) {
    throw new Error("runCli: project was not created by createFixtureProject");
  }

  // Per-call reset: fresh scenario, clean log, clean counters.
  await rm(join(binDir, "invocations.jsonl"), { force: true });
  await rm(join(binDir, "counters"), { recursive: true, force: true });
  const paths = await writeMockDocker(binDir, options.scenario);

  const tsxCliPath = require.resolve("tsx/cli");
  const cliTsPath = fileURLToPath(new URL("../cli.ts", import.meta.url));

  const env: Record<string, string> = {
    // Mock docker shadows real docker; node stays resolvable for `#!/usr/bin/env node`.
    PATH: `${binDir}${delimiter}${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`,
    HOME: options.project.homeDir,
    TZ: "UTC",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    RFAPPS_MOCK_DOCKER_SCENARIO: paths.scenarioPath,
    RFAPPS_MOCK_DOCKER_LOG: paths.logPath,
  };
  const inheritedTmpdir = process.env["TMPDIR"];
  if (inheritedTmpdir !== undefined) {
    env["TMPDIR"] = inheritedTmpdir;
  }
  Object.assign(env, options.env);

  const timeoutMs = options.timeoutMs ?? 12_000;
  const startedAt = performance.now();

  // detached: the child leads a new process group so the timeout path can kill
  // the whole tree — tsx runs cli.ts in a grandchild node process, and SIGKILL
  // on the tsx wrapper alone cannot be forwarded to it.
  const child = spawn(process.execPath, [tsxCliPath, cliTsPath, ...args], {
    cwd: options.project.projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Kill the whole process group (tsx wrapper + cli.ts grandchild + any mock
      // docker children) so a hung CLI cannot keep writing while cleanup runs.
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // Group already gone (ESRCH race) — fall back to the direct child.
        child.kill("SIGKILL");
      }
      reject(
        new Error(
          `runCli timed out after ${timeoutMs}ms: rfapps ${args.join(" ")}\n` +
            `--- partial stdout ---\n${stdout}\n--- partial stderr ---\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  return {
    exitCode,
    stdout,
    stderr,
    invocations: await readDockerInvocations(paths.logPath),
    durationMs: performance.now() - startedAt,
  };
}

/** Readonly better-sqlite3 handle on the fixture's state.db. Caller must .close(). */
export function openStateDb(project: FixtureProject): Database.Database {
  return new Database(project.stateDbPath, { readonly: true, fileMustExist: true });
}

/** Assert that no logged invocation matches the given argv matcher. */
export function expectNoInvocationMatching(
  invocations: readonly DockerInvocation[],
  match: MockArgvMatcher,
): void {
  for (const invocation of invocations) {
    if (matchesArgv(match, invocation.argv)) {
      throw new Error(
        `Expected no docker invocation matching ${JSON.stringify(match)}, ` +
          `but found: ${invocation.argv.join(" ")}`,
      );
    }
  }
}

/** Asserts ruleIds appear among invocations' matchedRuleId values as a subsequence, in order. */
export function expectInvocationOrder(
  invocations: readonly DockerInvocation[],
  ruleIds: readonly string[],
): void {
  const actual = invocations.map((i) => i.matchedRuleId);
  let cursor = 0;
  for (const matchedId of actual) {
    if (cursor < ruleIds.length && matchedId === ruleIds[cursor]) {
      cursor += 1;
    }
  }
  if (cursor !== ruleIds.length) {
    throw new Error(
      `Expected invocation order ${JSON.stringify(ruleIds)} as a subsequence, ` +
        `but matched rule ids were ${JSON.stringify(actual)}`,
    );
  }
}
