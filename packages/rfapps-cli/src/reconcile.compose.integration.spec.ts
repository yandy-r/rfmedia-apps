import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getComposeContainerObservations,
  isDockerAvailable,
  reconcileService,
} from "./lib/docker.js";

const execFileAsync = promisify(execFile);
const smokeRequested = process.env["RFAPPS_RUN_COMPOSE_INTEGRATION"] === "1";
const dockerAvailable = smokeRequested ? await isDockerAvailable() : false;
const fixtureImage = process.env["RFAPPS_RECONCILE_FIXTURE_IMAGE"] ?? "busybox:1.36";

const environmentKeys = ["PATH", "RFAPPS_DOCKER_ARG_LOG", "RFAPPS_REAL_DOCKER"] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));

let realDocker = "";
let temporaryDirectory = "";
let composePath = "";
let projectName = "";
let dockerArgumentLog = "";
let orphanContainerName = "";
let resolvedComposeJson = "";

async function docker(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(realDocker, [...args], {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function composeFixture(includeNeighbor: boolean): string {
  return `services:
  dependency:
    image: ${fixtureImage}
    command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]
  target:
    image: ${fixtureImage}
    command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]
    depends_on:
      - dependency
${includeNeighbor ? `  neighbor:\n    image: ${fixtureImage}\n    command: ["sh", "-c", "trap 'exit 0' TERM; while :; do sleep 1; done"]\n` : ""}`;
}

describe
  .skipIf(!smokeRequested || !dockerAvailable)
  .sequential("reconciliation local Compose smoke", () => {
    beforeAll(async () => {
      const resolvedDocker = await execFileAsync("which", ["docker"]);
      realDocker = resolvedDocker.stdout.trim();
      temporaryDirectory = await mkdtemp(join(tmpdir(), "rfapps-reconcile-smoke-"));
      await chmod(temporaryDirectory, 0o700);
      composePath = join(temporaryDirectory, "compose.yml");
      projectName = basename(temporaryDirectory).toLowerCase();
      dockerArgumentLog = join(temporaryDirectory, "docker-arguments.log");
      orphanContainerName = `${projectName}-neighbor-1`;

      await docker(["pull", fixtureImage]);
      await writeFile(composePath, composeFixture(true), "utf8");
      await docker([
        "compose",
        "--project-name",
        projectName,
        "-f",
        composePath,
        "up",
        "-d",
        "--pull",
        "never",
        "--no-deps",
        "neighbor",
      ]);
      await writeFile(composePath, composeFixture(false), "utf8");
      resolvedComposeJson = await docker([
        "compose",
        "--project-name",
        projectName,
        "-f",
        composePath,
        "config",
        "--format",
        "json",
      ]);

      const wrapperPath = join(temporaryDirectory, "docker");
      await writeFile(
        wrapperPath,
        '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$RFAPPS_DOCKER_ARG_LOG"\nexec "$RFAPPS_REAL_DOCKER" "$@"\n',
      );
      await chmod(wrapperPath, 0o755);
      process.env["RFAPPS_REAL_DOCKER"] = realDocker;
      process.env["RFAPPS_DOCKER_ARG_LOG"] = dockerArgumentLog;
      process.env["PATH"] = `${temporaryDirectory}:${originalEnvironment.get("PATH") ?? ""}`;
    }, 120_000);

    afterAll(async () => {
      process.env["PATH"] = originalEnvironment.get("PATH");
      if (realDocker !== "" && composePath !== "" && projectName !== "") {
        await docker([
          "compose",
          "--project-name",
          projectName,
          "-f",
          composePath,
          "down",
          "--volumes",
          "--remove-orphans",
        ]).catch(() => undefined);
      }
      if (realDocker !== "" && orphanContainerName !== "") {
        await docker(["container", "rm", "--force", orphanContainerName]).catch(() => undefined);
      }
      for (const key of environmentKeys) {
        const value = originalEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (temporaryDirectory !== "") {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }, 60_000);

    it("creates, starts, and recreates exactly one target without deps, pulls, or orphan cleanup", async () => {
      const created = await reconcileService({
        composePath,
        projectName,
        projectDirectory: temporaryDirectory,
        resolvedComposeJson,
        profiles: [],
        service: "target",
        action: "create",
      });
      expect(created.success).toBe(true);

      let observations = await getComposeContainerObservations(composePath, { projectName });
      const createdTarget = observations.find((item) => item.serviceName === "target");
      expect(createdTarget?.state).toBe("running");
      expect(observations.some((item) => item.serviceName === "dependency")).toBe(false);
      await expect(docker(["container", "inspect", orphanContainerName])).resolves.not.toBe("");

      await docker(["compose", "--project-name", projectName, "-f", composePath, "stop", "target"]);
      const started = await reconcileService({
        composePath,
        projectName,
        projectDirectory: temporaryDirectory,
        resolvedComposeJson,
        profiles: [],
        service: "target",
        action: "start",
      });
      expect(started.success).toBe(true);
      observations = await getComposeContainerObservations(composePath, { projectName });
      expect(observations.find((item) => item.serviceName === "target")?.state).toBe("running");

      const beforeRecreate = observations.find(
        (item) => item.serviceName === "target",
      )?.containerId;
      const recreated = await reconcileService({
        composePath,
        projectName,
        projectDirectory: temporaryDirectory,
        resolvedComposeJson,
        profiles: [],
        service: "target",
        action: "recreate",
      });
      expect(recreated.success).toBe(true);
      observations = await getComposeContainerObservations(composePath, { projectName });
      expect(observations.find((item) => item.serviceName === "target")?.containerId).not.toBe(
        beforeRecreate,
      );
      expect(observations.some((item) => item.serviceName === "dependency")).toBe(false);
      await expect(docker(["container", "inspect", orphanContainerName])).resolves.not.toBe("");

      const lifecycleLines = (await readFile(dockerArgumentLog, "utf8"))
        .split("\n")
        .filter((line) => line.includes(" up -d "));
      expect(lifecycleLines).toHaveLength(3);
      for (const line of lifecycleLines) {
        expect(line).toContain("--pull never --no-build --no-deps");
        expect(line).toMatch(/ target$/u);
        expect(line).not.toContain("dependency");
        expect(line).not.toContain("neighbor");
        expect(line).not.toContain("--remove-orphans");
        expect(line).not.toContain("--renew-anon-volumes");
      }
      expect(lifecycleLines[0]).not.toContain("--force-recreate");
      expect(lifecycleLines[1]).not.toContain("--force-recreate");
      expect(lifecycleLines[2]).toContain("--force-recreate");
      expect(lifecycleLines.join("\n")).not.toMatch(/(?:^|\s)(?:pull|build)(?:\s|$)/u);
    }, 90_000);
  });
