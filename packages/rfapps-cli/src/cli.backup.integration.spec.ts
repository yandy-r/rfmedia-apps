/**
 * Process-boundary integration coverage for `rfapps backup`.
 *
 * These tests spawn the real CLI through the shared harness. Docker is always
 * the scripted executable on PATH; filesystem effects occur only below
 * throwaway project, HOME, source, and destination directories.
 */

import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { BackupManifest } from "./types/backup.js";
import {
  DEFAULT_FIXTURE_CONFIG_YAML,
  createFixtureProject,
  expectInvocationOrder,
  expectNoInvocationMatching,
  runCli,
  type FixtureProject,
} from "./testing/cli-harness.js";
import {
  canonicalComposeMount,
  canonicalComposeService,
  composeConfigJson,
  type MockDockerRule,
  type MockDockerScenario,
} from "./testing/mock-docker.js";

const HELPER_IMAGE =
  "docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1";
const HELPER_ID = `sha256:${"c".repeat(64)}`;
const RUNNING_CONTAINER_ID = "a".repeat(64);

const projects: FixtureProject[] = [];

async function fixture(options: Parameters<typeof createFixtureProject>[0] = {}) {
  const project = await createFixtureProject(options);
  projects.push(project);
  return project;
}

function configuredFixtureYaml(): string {
  return `${DEFAULT_FIXTURE_CONFIG_YAML}envTool:
  tool: none
`;
}

async function createBackupFixture(): Promise<{
  project: FixtureProject;
  sourcePath: string;
  destinationPath: string;
  composeJson: string;
}> {
  const project = await fixture({ configYaml: configuredFixtureYaml() });
  const sourcePath = join(project.projectDir, "source");
  const destinationPath = join(project.projectDir, "backups");
  await mkdir(sourcePath, { mode: 0o700 });
  await mkdir(destinationPath, { mode: 0o700 });
  await writeFile(join(sourcePath, "payload.txt"), "fixture payload\n", "utf8");
  await writeFile(join(project.projectDir, ".env.local"), "", "utf8");
  const composeJson = composeConfigJson({
    name: "fixture",
    services: {
      web: canonicalComposeService({
        volumes: [
          canonicalComposeMount({
            type: "bind",
            source: sourcePath,
            target: "/data",
            read_only: false,
          }),
        ],
      }),
    },
  });
  return { project, sourcePath, destinationPath, composeJson };
}

function authorityRules(composeJson: string): MockDockerRule[] {
  return [
    {
      id: "compose-config",
      match: { prefix: ["compose"], contains: ["config", "--format", "json"] },
      response: { stdout: composeJson, exitCode: 0 },
    },
    {
      id: "context-show",
      match: { exact: ["context", "show"] },
      response: { stdout: "default\n", exitCode: 0 },
    },
    {
      id: "context-inspect",
      match: {
        exact: ["context", "inspect", "default", "--format", "{{json .Endpoints.docker.Host}}"],
      },
      response: { stdout: '"unix:///var/run/docker.sock"\n', exitCode: 0 },
    },
    {
      id: "daemon-info",
      match: { exact: ["info", "--format", "{{json .ID}}"] },
      response: { stdout: '"fixture-daemon"\n', exitCode: 0 },
    },
  ];
}

function cachedHelperRule(): MockDockerRule {
  return {
    id: "helper-inspect",
    match: { exact: ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE] },
    response: { stdout: `${HELPER_ID}\n`, exitCode: 0 },
  };
}

function mountInfoPath(path: string): string {
  return path
    .replaceAll("\\", "\\134")
    .replaceAll(" ", "\\040")
    .replaceAll("\t", "\\011")
    .replaceAll("\n", "\\012");
}

function probeRules(sourcePaths: readonly string[]): MockDockerRule[] {
  const mountInfo = [...new Set(sourcePaths)]
    .sort()
    .map(
      (sourcePath, index) =>
        `${String(40 + index)} 25 8:1 ${mountInfoPath(sourcePath)} /rfapps-bind-${String(index).padStart(4, "0")} ro - ext4 /dev/sda1 rw`,
    )
    .join("\n");
  return [
    {
      id: "bind-topology-probe",
      match: {
        prefix: ["run", "--rm", "--name"],
        contains: [HELPER_ID, "cat", "/proc/self/mountinfo"],
      },
      response: {
        stdout: `${mountInfo}\n`,
        exitCode: 0,
      },
    },
    {
      id: "source-probe",
      match: {
        prefix: ["run", "--rm", "--name"],
        contains: [HELPER_ID, "stat", "%F", "/source"],
      },
      response: { stdout: "directory\n", exitCode: 0 },
    },
    {
      id: "helper-cleanup",
      match: { prefix: ["container", "rm", "--force"] },
      response: { exitCode: 0 },
    },
  ];
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function waitForPublishedArtifact(destinationPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const bundles = await readdir(destinationPath);
      for (const bundle of bundles) {
        const artifacts = await readdir(join(destinationPath, bundle, "artifacts"));
        if (artifacts.some((artifact) => artifact.endsWith(".tar.gz"))) return;
      }
    } catch {
      // The bundle and artifacts directory are intentionally created in stages.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Timed out waiting for the backup artifact to be published");
}

async function waitForActiveBackupLocks(project: FixtureProject): Promise<number> {
  const stateLockPath = join(project.homeDir, ".config", "rfapps", "lock");
  const lifecycleLockPath = join(project.homeDir, ".config", "rfapps", "locks");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const [stateTokens, lifecycleLocks] = await Promise.all([
        readdir(stateLockPath),
        readdir(lifecycleLockPath),
      ]);
      if (stateTokens.length === 1 && lifecycleLocks.length === 1) {
        const metadata = JSON.parse(
          await readFile(join(lifecycleLockPath, lifecycleLocks[0]!), "utf8"),
        ) as { pid?: unknown };
        if (Number.isSafeInteger(metadata.pid) && Number(metadata.pid) > 0) {
          return Number(metadata.pid);
        }
      }
    } catch {
      // Both locks are intentionally created at different lifecycle boundaries.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error("Timed out waiting for both backup locks");
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()));
});

describe("rfapps backup (integration)", () => {
  it("keeps cached-helper dry-run free of pull, bundle, stop, and lock mutations", async () => {
    const { project, sourcePath, destinationPath, composeJson } = await createBackupFixture();
    const scenario: MockDockerScenario = {
      rules: [
        ...authorityRules(composeJson),
        cachedHelperRule(),
        ...probeRules([sourcePath, destinationPath]),
      ],
    };

    const result = await runCli(
      [
        "backup",
        "--service",
        "web",
        "--destination",
        destinationPath,
        "--dry-run",
        "--output",
        "json",
        "--yes",
      ],
      { project, scenario },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "planned",
      success: true,
      dryRun: true,
      summary: { plannedArtifacts: 1, archivedArtifacts: 0 },
    });
    expectInvocationOrder(result.invocations, ["helper-inspect", "source-probe", "helper-cleanup"]);
    expect(result.invocations.filter((item) => item.matchedRuleId === "source-probe")).toHaveLength(
      1,
    );
    expect(
      result.invocations.filter((item) => item.matchedRuleId === "helper-cleanup"),
    ).toHaveLength(2);
    expectNoInvocationMatching(result.invocations, { prefix: ["image", "pull"] });
    expectNoInvocationMatching(result.invocations, { contains: ["stop"] });
    expectNoInvocationMatching(result.invocations, { contains: ["tar"] });
    expect(await readdir(destinationPath)).toEqual([]);
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    await expect(access(join(project.homeDir, ".config", "rfapps", "locks"))).rejects.toThrow();
  });

  it("fails an absent-helper dry-run deterministically with zero mutation", async () => {
    const { project, sourcePath, destinationPath, composeJson } = await createBackupFixture();
    const scenario: MockDockerScenario = {
      rules: [
        ...authorityRules(composeJson),
        {
          id: "helper-absent",
          match: { exact: ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE] },
          response: { stderr: "Error: No such image\n", exitCode: 1 },
        },
      ],
    };

    const result = await runCli(
      [
        "backup",
        "--service",
        "web",
        "--destination",
        destinationPath,
        "--dry-run",
        "--output",
        "json",
        "--yes",
      ],
      { project, scenario },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "failed",
      success: false,
      dryRun: true,
      primaryFailure: { code: "SOURCE_PROBE_FAILED", stage: "validate" },
    });
    expect(
      result.invocations.filter((item) => item.matchedRuleId === "helper-absent"),
    ).toHaveLength(1);
    expectNoInvocationMatching(result.invocations, { prefix: ["image", "pull"] });
    expectNoInvocationMatching(result.invocations, { prefix: ["run"] });
    expectNoInvocationMatching(result.invocations, { contains: ["stop"] });
    expect(await readdir(destinationPath)).toEqual([]);
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    await expect(access(join(project.homeDir, ".config", "rfapps", "locks"))).rejects.toThrow();
  });

  it("emits one secret-free v1 result when initial Docker authority evidence fails", async () => {
    const { project, destinationPath, composeJson } = await createBackupFixture();
    const scenario: MockDockerScenario = {
      rules: [
        authorityRules(composeJson)[0]!,
        {
          id: "context-show-failure",
          match: { exact: ["context", "show"] },
          response: {
            stderr: "token=private-authority-secret\n",
            exitCode: 1,
          },
        },
      ],
    };

    const result = await runCli(
      ["backup", "--service", "web", "--destination", destinationPath, "--output", "json", "--yes"],
      { project, scenario },
    );

    expect(result.exitCode).toBe(2);
    expect(occurrences(result.stdout, "rfapps-backup-result.v1")).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "failed",
      success: false,
      dryRun: false,
      primaryFailure: {
        stage: "validate",
        code: "PLANNER_INPUT_UNAVAILABLE",
      },
    });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("private-authority-secret");
    expect(await readdir(destinationPath)).toEqual([]);
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    await expect(access(join(project.homeDir, ".config", "rfapps", "locks"))).rejects.toThrow();
  });

  it("rejects machine authorization and CSV before config, Docker, locks, or bundles", async () => {
    const project = await fixture({ omitConfig: true });
    const destinationPath = join(project.projectDir, "backups");
    await mkdir(destinationPath, { mode: 0o700 });
    const cases: readonly (readonly string[])[] = [
      ["backup", "--destination", destinationPath, "--output", "json", "--yes"],
      ["backup", "--service", "web", "--destination", destinationPath, "--output", "json"],
      ["backup", "--service", "web", "--destination", destinationPath, "--output", "csv", "--yes"],
    ];

    for (const args of cases) {
      const result = await runCli(args, { project, scenario: { rules: [] } });
      expect(result.exitCode).toBe(2);
      expect(result.invocations).toEqual([]);
      expect(await readdir(destinationPath)).toEqual([]);
      await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    }
  }, 45_000);

  it("verifies success and checksum failure offline without config, Docker, or a state lock", async () => {
    const project = await fixture({ omitConfig: true });
    const bundlePath = join(project.projectDir, "offline-bundle");
    const artifactsPath = join(bundlePath, "artifacts");
    const artifactPath = join(artifactsPath, "mount-0001.tar.gz");
    const manifestPath = join(bundlePath, "manifest.json");
    const bytes = Buffer.from([0x00, 0xff, 0x42, 0x10]);
    await mkdir(artifactsPath, { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, bytes, { mode: 0o600 });
    const manifest: BackupManifest = {
      schemaVersion: "rfapps-backup.v1",
      backupId: "backup-integration",
      createdAt: "2026-07-29T10:00:00.000Z",
      completedAt: "2026-07-29T10:01:00.000Z",
      consistency: "detected-compose-writers-stopped",
      project: {
        name: "fixture",
        resolvedConfigSha256: "a".repeat(64),
        dockerAuthorityFingerprint: "b".repeat(64),
      },
      scope: {
        requestedServices: ["web"],
        resolvedServices: ["web"],
        quiescedServices: ["web"],
        previouslyRunningServices: ["web"],
      },
      helperImage: { reference: HELPER_IMAGE, resolvedImageId: HELPER_ID },
      skipped: [],
      mounts: [
        {
          id: "mount-0001",
          artifactPath: "artifacts/mount-0001.tar.gz",
          source: { kind: "bind", path: "/srv/data" },
          consumers: [{ service: "web", target: "/data", readOnly: false }],
          archiveStartedAt: "2026-07-29T10:00:10.000Z",
          archiveCompletedAt: "2026-07-29T10:00:20.000Z",
          compressedBytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          restore: {
            kind: "bind-tar",
            destinationPath: "/srv/data",
            precondition: "writers-stopped",
          },
        },
      ],
      warnings: [],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

    const success = await runCli(["backup", "verify", manifestPath, "--output", "json"], {
      project,
      scenario: { rules: [] },
    });
    expect(success.exitCode, success.stderr).toBe(0);
    expect(success.invocations).toEqual([]);
    expect(JSON.parse(success.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-verify-result.v1",
      status: "succeeded",
      success: true,
      summary: { verifiedArtifacts: 1, checksumMismatches: 0 },
    });

    await writeFile(artifactPath, Buffer.from([0x00, 0xff, 0x42, 0x11]), { mode: 0o600 });
    const failure = await runCli(["backup", "verify", manifestPath, "--output", "json"], {
      project,
      scenario: { rules: [] },
    });
    expect(failure.exitCode).toBe(1);
    expect(failure.invocations).toEqual([]);
    expect(JSON.parse(failure.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-verify-result.v1",
      status: "failed",
      success: false,
      summary: { verifiedArtifacts: 0, checksumMismatches: 1 },
    });
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
  }, 30_000);

  it("creates one machine result while coordinating stop, archive, and exact recovery", async () => {
    const { project, sourcePath, destinationPath, composeJson } = await createBackupFixture();
    const running = JSON.stringify([
      {
        ID: RUNNING_CONTAINER_ID,
        Name: "fixture-web-1",
        Service: "web",
        State: "running",
        Health: "",
      },
    ]);
    const scenario: MockDockerScenario = {
      rules: [
        ...authorityRules(composeJson),
        cachedHelperRule(),
        ...probeRules([sourcePath, destinationPath]),
        {
          id: "writers-running",
          times: 1,
          match: { prefix: ["compose"], contains: ["ps", "--all", "--format", "json"] },
          response: { stdout: running, exitCode: 0 },
        },
        {
          id: "writers-stopped",
          times: 3,
          match: { prefix: ["compose"], contains: ["ps", "--all", "--format", "json"] },
          response: { stdout: "[]\n", exitCode: 0 },
        },
        {
          id: "writer-recovered",
          match: { prefix: ["compose"], contains: ["ps", "--all", "--format", "json"] },
          response: { stdout: running, exitCode: 0 },
        },
        {
          id: "stop-writer",
          match: { prefix: ["compose"], contains: ["stop", "web"] },
          response: { exitCode: 0 },
        },
        {
          id: "archive-source",
          match: { prefix: ["run", "--rm", "--name"], contains: [HELPER_ID, "tar", "-cf", "-"] },
          response: { stdout: "archive fixture bytes\n", exitCode: 0 },
        },
        {
          id: "recover-container",
          match: { exact: ["container", "start", RUNNING_CONTAINER_ID] },
          response: { exitCode: 0, delayMs: 1_000 },
        },
      ],
    };

    const runningBackup = runCli(
      ["backup", "--service", "web", "--destination", destinationPath, "--output", "json", "--yes"],
      { project, scenario, timeoutMs: 20_000 },
    );
    await waitForPublishedArtifact(destinationPath);
    expect(await readdir(join(project.homeDir, ".config", "rfapps", "lock"))).toHaveLength(1);
    expect(await readdir(join(project.homeDir, ".config", "rfapps", "locks"))).toHaveLength(1);
    const result = await runningBackup;

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(occurrences(result.stdout, "rfapps-backup-result.v1")).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "succeeded",
      success: true,
      dryRun: false,
      summary: {
        plannedArtifacts: 1,
        archivedArtifacts: 1,
        previouslyRunningContainers: 1,
        recoveryFailures: 0,
      },
    });
    expectInvocationOrder(result.invocations, [
      "source-probe",
      "helper-cleanup",
      "writers-running",
      "stop-writer",
      "writers-stopped",
      "archive-source",
      "helper-cleanup",
      "recover-container",
    ]);
    const bundles = await readdir(destinationPath);
    expect(bundles).toHaveLength(1);
    expect(await readdir(join(destinationPath, bundles[0]!))).toEqual([
      "artifacts",
      "manifest.json",
    ]);
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    expect(await readdir(join(project.homeDir, ".config", "rfapps", "locks"))).toEqual([]);
  }, 25_000);

  it("flushes one interruption result and releases both locks before signal termination", async () => {
    const { project, sourcePath, destinationPath, composeJson } = await createBackupFixture();
    const scenario: MockDockerScenario = {
      rules: [
        ...authorityRules(composeJson),
        {
          id: "helper-inspect-fast",
          times: 2,
          match: { exact: ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE] },
          response: { stdout: `${HELPER_ID}\n`, exitCode: 0 },
        },
        {
          id: "helper-inspect-held",
          match: { exact: ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE] },
          response: { stdout: `${HELPER_ID}\n`, exitCode: 0, delayMs: 5_000 },
        },
        ...probeRules([sourcePath, destinationPath]),
      ],
    };

    const runningBackup = runCli(
      ["backup", "--service", "web", "--destination", destinationPath, "--output", "json", "--yes"],
      { project, scenario, timeoutMs: 20_000 },
    );
    const cliPid = await waitForActiveBackupLocks(project);
    process.kill(cliPid, "SIGTERM");
    const result = await runningBackup;

    expect(occurrences(result.stdout, "rfapps-backup-result.v1")).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "rfapps-backup-result.v1",
      status: "cancelled",
      success: false,
      dryRun: false,
      primaryFailure: { code: "INTERRUPTED" },
    });
    await expect(access(join(project.homeDir, ".config", "rfapps", "lock"))).rejects.toThrow();
    expect(await readdir(join(project.homeDir, ".config", "rfapps", "locks"))).toEqual([]);
  }, 25_000);
});
