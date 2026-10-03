import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DockerExecOptions, DockerExecResult } from "./docker.js";
import {
  DockerAuthorityDeadlineError,
  dockerAuthorityFingerprint,
  dockerAuthorityFingerprintFromEnvironment,
  isLocalDockerAuthority,
  isLocalDockerAuthorityFromEnvironment,
  resolveComposeEnvironmentFilePath,
  resolveComposeProjectIdentity,
} from "./identity.js";

type DockerCommandRunner = (
  args: string[],
  options?: DockerExecOptions,
) => Promise<DockerExecResult>;

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rfapps-identity-"));
  temporaryDirectories.push(directory);
  return directory;
}

function dockerResult(stdout: string, success = true): DockerExecResult {
  return { code: success ? 0 : 1, stdout, stderr: "", success };
}

function dockerRunner(endpoint: string, daemonId: string, context = "production") {
  return vi.fn(async (args: string[], _options?: DockerExecOptions) => {
    if (args[0] === "context" && args[1] === "show") return dockerResult(`${context}\n`);
    if (args[0] === "context" && args[1] === "inspect") {
      return dockerResult(`${endpoint}\n`);
    }
    return dockerResult(`${daemonId}\n`);
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dockerAuthorityFingerprint", () => {
  it("binds context, endpoint, Docker host override, and daemon without exposing them", async () => {
    const envTool = { tool: "op" as const, envFile: "/private/runtime-secrets.env" };
    const endpoint = '"ssh://docker-user:docker-secret@example.test"';
    const daemonId = '"daemon-secret-id"';
    const dockerHost = "tcp://docker-host-secret.example.test:2376";
    const runner = dockerRunner(endpoint, daemonId);
    const probe = vi.fn().mockResolvedValue(dockerHost);

    const fingerprint = await dockerAuthorityFingerprint(envTool, runner, probe);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toMatch(
      /docker-user|docker-secret|example\.test|daemon-secret|runtime-secrets/u,
    );
    expect(probe).toHaveBeenCalledWith(envTool);
    expect(runner).toHaveBeenCalledTimes(3);
    for (const [, options] of runner.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({ captureOutput: true, streamOutput: false, envTool }),
      );
    }
  });

  it("changes for each authority component and is stable for identical evidence", async () => {
    const baselineRunner = dockerRunner('"unix:///var/run/docker.sock"', '"daemon-a"');
    const baseline = await dockerAuthorityFingerprint(
      undefined,
      baselineRunner,
      vi.fn().mockResolvedValue(""),
    );
    const same = await dockerAuthorityFingerprint(
      undefined,
      dockerRunner('"unix:///var/run/docker.sock"', '"daemon-a"'),
      vi.fn().mockResolvedValue(""),
    );
    const changes = await Promise.all([
      dockerAuthorityFingerprint(
        undefined,
        dockerRunner('"unix:///var/run/docker.sock"', '"daemon-a"', "staging"),
        vi.fn().mockResolvedValue(""),
      ),
      dockerAuthorityFingerprint(
        undefined,
        dockerRunner('"tcp://docker.example:2376"', '"daemon-a"'),
        vi.fn().mockResolvedValue(""),
      ),
      dockerAuthorityFingerprint(
        undefined,
        dockerRunner('"unix:///var/run/docker.sock"', '"daemon-b"'),
        vi.fn().mockResolvedValue(""),
      ),
      dockerAuthorityFingerprint(
        undefined,
        dockerRunner('"unix:///var/run/docker.sock"', '"daemon-a"'),
        vi.fn().mockResolvedValue("ssh://docker.example"),
      ),
    ]);

    expect(same).toBe(baseline);
    expect(new Set(changes)).toHaveLength(changes.length);
    expect(changes).not.toContain(baseline);
  });

  it("revalidates Docker authority with the pinned environment and no wrapper", async () => {
    const runner = dockerRunner('"tcp://reviewed.example:2376"', '"daemon-reviewed"');
    const environment = {
      PATH: "/usr/bin",
      DOCKER_HOST: "tcp://reviewed.example:2376",
      PRIVATE_TOKEN: "must-not-be-serialized",
    };

    const fingerprint = await dockerAuthorityFingerprintFromEnvironment(environment, runner);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain("must-not-be-serialized");
    for (const [, options] of runner.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ env: environment, replaceEnv: true }));
      expect(options?.envTool).toBeUndefined();
    }
  });

  it("fails closed when any Docker identity component is unavailable", async () => {
    const runner: DockerCommandRunner = vi.fn(async (args) =>
      args[0] === "context" && args[1] === "show"
        ? dockerResult("production\n")
        : dockerResult("", false),
    );

    await expect(
      dockerAuthorityFingerprint(undefined, runner, vi.fn().mockResolvedValue("")),
    ).rejects.toThrow(/Unable to identify the active Docker/u);
  });

  it("does not start another authority command after the shared deadline", async () => {
    let now = 100;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const runner: DockerCommandRunner = vi.fn(async () => {
      now = 151;
      return dockerResult("production\n");
    });

    try {
      await expect(
        dockerAuthorityFingerprintFromEnvironment({}, runner, {
          deadline: 150,
          timeout: 300_000,
          maxRetries: 1,
        }),
      ).rejects.toBeInstanceOf(DockerAuthorityDeadlineError);
      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith(
        ["context", "show"],
        expect.objectContaining({ timeout: 50, maxRetries: 1 }),
      );
    } finally {
      dateNow.mockRestore();
    }
  });
});

describe("isLocalDockerAuthority", () => {
  it("classifies only the pinned environment when the live DOCKER_HOST drifts", async () => {
    const environment = {
      PATH: "/usr/bin",
      DOCKER_HOST: "ssh://authority-token@reviewed.example.test",
      PRIVATE_TOKEN: "must-not-be-serialized",
    };
    const runner = dockerRunner('"unix:///var/run/docker.sock"', '"unused-daemon"');

    const locality = await isLocalDockerAuthorityFromEnvironment(environment, runner);

    expect(locality).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.stringify(locality)).not.toMatch(/authority-token|PRIVATE_TOKEN|reviewed/u);
  });

  it("gives the effective DOCKER_HOST override precedence without inspecting context", async () => {
    const runner = dockerRunner(
      '"ssh://context-user:context-secret@remote.example.test"',
      '"unused-daemon"',
    );
    const probe = vi.fn().mockResolvedValue("unix:///run/user/1000/docker.sock");

    await expect(isLocalDockerAuthority(undefined, runner, probe)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledWith(undefined);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    "unix:///var/run/docker.sock",
    "unix:///run/user/1000/docker.sock",
    "npipe:////./pipe/docker_engine",
  ])("classifies local active-context endpoint %s", async (endpoint) => {
    const runner = dockerRunner(JSON.stringify(endpoint), '"unused-daemon"');

    await expect(
      isLocalDockerAuthority(undefined, runner, vi.fn().mockResolvedValue("")),
    ).resolves.toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it.each([
    "ssh://docker-user:docker-secret@remote.example.test",
    "tcp://remote.example.test:2376",
    "http://remote.example.test:2375",
    "https://remote.example.test:2376",
  ])("classifies remote effective override %s without exposing it", async (endpoint) => {
    const runner = dockerRunner('"unix:///var/run/docker.sock"', '"unused-daemon"');

    const locality = await isLocalDockerAuthority(
      undefined,
      runner,
      vi.fn().mockResolvedValue(endpoint),
    );

    expect(locality).toBe(false);
    expect(String(locality)).not.toMatch(/docker-user|docker-secret|remote\.example/u);
    expect(runner).not.toHaveBeenCalled();
  });

  it("classifies a remote active-context endpoint when DOCKER_HOST is unset", async () => {
    const runner = dockerRunner(
      '"ssh://docker-user:docker-secret@remote.example.test"',
      '"unused-daemon"',
    );

    await expect(
      isLocalDockerAuthority(undefined, runner, vi.fn().mockResolvedValue("")),
    ).resolves.toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed context evidence without exposing endpoint contents", async () => {
    const endpointSecret = "malformed://user:secret@private.example.test";
    const runner = dockerRunner(JSON.stringify(endpointSecret), '"unused-daemon"');

    const failure = isLocalDockerAuthority(undefined, runner, vi.fn().mockResolvedValue(""));

    await expect(failure).rejects.toThrow(/classify Docker authority locality/u);
    await expect(failure).rejects.not.toThrow(/user|secret|private\.example/u);
  });

  it("rejects non-JSON active-context endpoint evidence", async () => {
    const runner = dockerRunner("unix:///var/run/docker.sock", '"unused-daemon"');

    await expect(
      isLocalDockerAuthority(undefined, runner, vi.fn().mockResolvedValue("")),
    ).rejects.toThrow(/classify Docker authority locality/u);
  });

  it("fails closed on malformed host override without falling back to context", async () => {
    const runner = dockerRunner('"unix:///var/run/docker.sock"', '"unused-daemon"');

    await expect(
      isLocalDockerAuthority(undefined, runner, vi.fn().mockResolvedValue("not a Docker endpoint")),
    ).rejects.toThrow(/classify Docker authority locality/u);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("resolveComposeProjectIdentity", () => {
  it("returns one canonical regular file, directory, and safe effective project name", async () => {
    const directory = await temporaryDirectory();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "name: reviewed_project\nservices: {}\n", "utf8");

    await expect(resolveComposeProjectIdentity(composePath)).resolves.toEqual({
      composePath,
      projectDir: directory,
      projectName: "reviewed_project",
    });
  });

  it("uses the canonical plain env file for project name and required interpolation", async () => {
    const directory = await temporaryDirectory();
    const composePath = join(directory, "compose.yml");
    const envFile = join(directory, "reviewed.env");
    await writeFile(
      composePath,
      "name: ${REVIEWED_PROJECT:?required}\nservices:\n  app:\n    image: ${REVIEWED_IMAGE:?required}\n",
      "utf8",
    );
    await writeFile(envFile, "REVIEWED_PROJECT=reviewed_project\nREVIEWED_IMAGE=busybox:1.36\n");

    const canonicalEnvFile = await resolveComposeEnvironmentFilePath(`${directory}/./reviewed.env`);

    await expect(
      resolveComposeProjectIdentity(composePath, { envFile: canonicalEnvFile }),
    ).resolves.toEqual({
      composePath,
      projectDir: directory,
      projectName: "reviewed_project",
    });
  });

  it("rejects empty, NUL-containing, non-canonical, missing, and non-file paths", async () => {
    const directory = await temporaryDirectory();
    const composePath = join(directory, "compose.yml");
    await writeFile(composePath, "name: reviewed_project\nservices: {}\n", "utf8");

    await expect(resolveComposeProjectIdentity("")).rejects.toThrow(/non-empty/u);
    await expect(resolveComposeProjectIdentity(`${composePath}\0suffix`)).rejects.toThrow(
      /non-empty/u,
    );
    await expect(
      resolveComposeProjectIdentity(`${directory}/nested/../compose.yml`, {
        requireCanonicalInput: true,
      }),
    ).rejects.toThrow(/absolute and normalized/u);
    await expect(resolveComposeProjectIdentity(join(directory, "missing.yml"))).rejects.toThrow(
      /does not exist/u,
    );
    await expect(resolveComposeProjectIdentity(directory)).rejects.toThrow(/regular file/u);
  });

  it("rejects symbolic links in both the file and parent path", async () => {
    const directory = await temporaryDirectory();
    const realDirectory = join(directory, "real");
    const linkedDirectory = join(directory, "linked");
    await mkdir(realDirectory);
    const composePath = join(realDirectory, "compose.yml");
    await writeFile(composePath, "name: reviewed_project\nservices: {}\n", "utf8");
    await symlink(realDirectory, linkedDirectory);
    const linkedFile = join(directory, "linked-compose.yml");
    await symlink(composePath, linkedFile);

    await expect(resolveComposeProjectIdentity(linkedFile)).rejects.toThrow(/symbolic link/u);
    await expect(
      resolveComposeProjectIdentity(join(linkedDirectory, "compose.yml")),
    ).rejects.toThrow(/symbolic link/u);
  });

  it("rejects missing, non-file, and symlinked plain environment files", async () => {
    const directory = await temporaryDirectory();
    const envFile = join(directory, "reviewed.env");
    const linkedEnvFile = join(directory, "linked.env");
    await writeFile(envFile, "SAFE=value\n", "utf8");
    await symlink(envFile, linkedEnvFile);

    await expect(resolveComposeEnvironmentFilePath(envFile)).resolves.toBe(envFile);
    await expect(resolveComposeEnvironmentFilePath("")).rejects.toThrow(/non-empty/u);
    await expect(resolveComposeEnvironmentFilePath(join(directory, "missing.env"))).rejects.toThrow(
      /does not exist/u,
    );
    await expect(resolveComposeEnvironmentFilePath(directory)).rejects.toThrow(/regular file/u);
    await expect(resolveComposeEnvironmentFilePath(linkedEnvFile)).rejects.toThrow(
      /symbolic link/u,
    );
  });
});
