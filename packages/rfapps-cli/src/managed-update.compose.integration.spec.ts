import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getRunningServiceContainerMap,
  inspectContainerIdentity,
  isDockerAvailable,
  recreateServiceWithImage,
} from "./lib/docker.js";
import { verifyServiceReadiness } from "./lib/health.js";

const execFileAsync = promisify(execFile);
const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures/managed-update/", import.meta.url),
);
const composePath = join(fixtureDirectory, "compose.yml");
const dockerfilePath = join(fixtureDirectory, "Dockerfile");
const smokeRequested = process.env["RFAPPS_RUN_COMPOSE_INTEGRATION"] === "1";
const dockerAvailable = smokeRequested ? await isDockerAvailable() : false;

interface BuiltVariant {
  tag: string;
  repositoryDigest: string;
  localImageId: string;
}

const environmentKeys = [
  "COMPOSE_PROJECT_NAME",
  "MANAGED_UPDATE_TARGET_IMAGE",
  "MANAGED_UPDATE_NEIGHBOR_IMAGE",
  "PATH",
  "RFAPPS_DOCKER_ARG_LOG",
  "RFAPPS_REAL_DOCKER",
] as const;

const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]] as const));

let realDocker = "";
let temporaryDirectory = "";
let registryContainer = "";
let projectName = "";
let dockerArgumentLog = "";
let registryAddress = "";
const builtTags: string[] = [];

async function docker(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(realDocker, [...args], {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function buildAndPushVariant(variant: string, healthy: boolean): Promise<BuiltVariant> {
  const tag = `${registryAddress}/rfapps-managed-update:${variant}`;
  await docker([
    "build",
    "--file",
    dockerfilePath,
    "--build-arg",
    `FIXTURE_VARIANT=${variant}`,
    "--build-arg",
    `FIXTURE_HEALTHY=${healthy ? "true" : "false"}`,
    "--tag",
    tag,
    fixtureDirectory,
  ]);
  builtTags.push(tag);
  await docker(["push", tag]);

  const inspection = JSON.parse(await docker(["image", "inspect", tag])) as Array<{
    Id: string;
    RepoDigests: string[];
  }>;
  const image = inspection[0];
  const repositoryDigest = image?.RepoDigests.find((digest) =>
    digest.startsWith(`${registryAddress}/rfapps-managed-update@`),
  );
  if (image === undefined || repositoryDigest === undefined) {
    throw new Error(`Docker did not report a repository digest for ${tag}`);
  }

  return { tag, repositoryDigest, localImageId: image.Id.toLowerCase() };
}

async function serviceContainers(): Promise<Map<string, string>> {
  const containers = await getRunningServiceContainerMap(composePath);
  if (containers === undefined) throw new Error("Unable to resolve Compose service containers");
  return containers;
}

async function serviceIdentity(service: string) {
  const containerName = (await serviceContainers()).get(service);
  if (containerName === undefined) throw new Error(`Compose service ${service} is not running`);
  return inspectContainerIdentity(containerName);
}

describe
  .skipIf(!smokeRequested || !dockerAvailable)
  .sequential("managed update local Compose smoke", () => {
    let oldVariant: BuiltVariant;
    let updatedVariant: BuiltVariant;
    let unhealthyVariant: BuiltVariant;

    beforeAll(async () => {
      const resolvedDocker = await execFileAsync("which", ["docker"]);
      realDocker = resolvedDocker.stdout.trim();
      temporaryDirectory = await mkdtemp(join(tmpdir(), "rfapps-managed-update-smoke-"));
      projectName = basename(temporaryDirectory).toLowerCase();
      registryContainer = `${projectName}-registry`;
      dockerArgumentLog = join(temporaryDirectory, "docker-arguments.log");

      await docker([
        "run",
        "--detach",
        "--name",
        registryContainer,
        "--publish",
        "127.0.0.1::5000",
        "registry:2",
      ]);
      const publishedPort = await docker(["port", registryContainer, "5000/tcp"]);
      const port = publishedPort.match(/:(\d+)$/)?.[1];
      if (port === undefined) throw new Error(`Unable to parse registry port: ${publishedPort}`);
      registryAddress = `127.0.0.1:${port}`;

      oldVariant = await buildAndPushVariant("old-healthy", true);
      updatedVariant = await buildAndPushVariant("updated-healthy", true);
      unhealthyVariant = await buildAndPushVariant("updated-unhealthy", false);

      process.env["COMPOSE_PROJECT_NAME"] = projectName;
      process.env["MANAGED_UPDATE_TARGET_IMAGE"] = oldVariant.repositoryDigest;
      process.env["MANAGED_UPDATE_NEIGHBOR_IMAGE"] = oldVariant.repositoryDigest;
      await docker(["compose", "--file", composePath, "up", "--detach", "--pull", "never"]);

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
      if (realDocker !== "" && projectName !== "") {
        await docker([
          "compose",
          "--file",
          composePath,
          "--project-name",
          projectName,
          "down",
          "--volumes",
          "--remove-orphans",
        ]).catch(() => undefined);
      }
      if (realDocker !== "" && registryContainer !== "") {
        await docker(["container", "rm", "--force", registryContainer]).catch(() => undefined);
      }
      for (const tag of builtTags) {
        if (realDocker !== "") {
          await docker(["image", "rm", "--force", tag]).catch(() => undefined);
        }
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

    it("recreates only the reviewed target and restores its exact original local image ID", async () => {
      const originalTarget = await serviceIdentity("target");
      const originalNeighbor = await serviceIdentity("neighbor");
      expect(originalTarget.localImageId).toBe(oldVariant.localImageId);

      const updated = await recreateServiceWithImage({
        composePaths: [composePath],
        service: "target",
        source: {
          kind: "repository-digest",
          configuredImage: updatedVariant.tag,
          repositoryDigest: updatedVariant.repositoryDigest,
        },
      });
      expect(updated.success).toBe(true);
      if (!updated.success) throw new Error(`Update failed during ${updated.stage}`);
      expect(updated.identity.repositoryDigest).toBe(updatedVariant.repositoryDigest);

      const updatedReadiness = await verifyServiceReadiness({
        composePath,
        targetService: "target",
        expectedImageId: updated.identity.localImageId,
        projectDir: temporaryDirectory,
        poll: { timeoutSeconds: 15, intervalSeconds: 1, retries: 15 },
      });
      expect(updatedReadiness.ready).toBe(true);
      expect(updatedReadiness.assurance).toBe("healthcheck");

      const updatedTarget = await serviceIdentity("target");
      expect(updatedTarget.localImageId).toBe(updatedVariant.localImageId);
      expect(updatedTarget.repositoryDigest).toBe(updatedVariant.repositoryDigest);
      expect(updatedTarget.health).toBe("healthy");
      expect((await serviceIdentity("neighbor")).containerId).toBe(originalNeighbor.containerId);

      const unhealthy = await recreateServiceWithImage({
        composePaths: [composePath],
        service: "target",
        source: {
          kind: "repository-digest",
          configuredImage: unhealthyVariant.tag,
          repositoryDigest: unhealthyVariant.repositoryDigest,
        },
      });
      expect(unhealthy.success).toBe(true);
      if (!unhealthy.success) throw new Error(`Unhealthy update failed during ${unhealthy.stage}`);

      const failedReadiness = await verifyServiceReadiness({
        composePath,
        targetService: "target",
        expectedImageId: unhealthy.identity.localImageId,
        projectDir: temporaryDirectory,
        poll: { timeoutSeconds: 10, intervalSeconds: 1, retries: 10 },
      });
      expect(failedReadiness.ready).toBe(false);
      expect(failedReadiness.target.reason).toBe("health-unhealthy");

      const restored = await recreateServiceWithImage({
        composePaths: [composePath],
        service: "target",
        source: {
          kind: "local-image-id",
          configuredImage: oldVariant.tag,
          localImageId: originalTarget.localImageId,
        },
      });
      expect(restored.success).toBe(true);
      if (!restored.success) throw new Error(`Restore failed during ${restored.stage}`);

      const restoredReadiness = await verifyServiceReadiness({
        composePath,
        targetService: "target",
        expectedImageId: originalTarget.localImageId,
        projectDir: temporaryDirectory,
        poll: { timeoutSeconds: 15, intervalSeconds: 1, retries: 15 },
      });
      expect(restoredReadiness.ready).toBe(true);
      const restoredTarget = await serviceIdentity("target");
      expect(restoredTarget.localImageId).toBe(originalTarget.localImageId);
      expect(restoredTarget.health).toBe("healthy");
      expect((await serviceIdentity("neighbor")).containerId).toBe(originalNeighbor.containerId);

      const lifecycleArguments = await readFile(dockerArgumentLog, "utf8");
      expect(lifecycleArguments).not.toContain("--remove-orphans");
    }, 90_000);
  });
