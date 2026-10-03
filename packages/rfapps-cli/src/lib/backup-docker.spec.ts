import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveBackupSource,
  type BackupArchiveProcess,
  type BackupDockerDependencies,
  BackupDockerError,
  buildBackupHelperArgs,
  buildBackupTopologyProbeArgs,
  inspectBackupHelper,
  observeRunningBackupContainers,
  prepareBackupHelper,
  probeBackupBindTopology,
  probeBackupSource,
  startBackupContainer,
  stopBackupWriterServices,
} from "./backup-docker.js";
import { BACKUP_HELPER_IMAGE_REFERENCE } from "../types/backup.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const temporaryDirectories: string[] = [];

function successfulResult(stdout = "") {
  return { code: 0, stdout, stderr: "", success: true };
}

function createProcess(
  run: (stdout: PassThrough, stderr: PassThrough) => Promise<{ code: number; signal: null }>,
): BackupArchiveProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let terminated = false;
  let settleTermination:
    | ((value: { code: number; signal: "SIGTERM" | "SIGKILL" }) => void)
    | undefined;
  const wait = Promise.race([
    run(stdout, stderr),
    new Promise<{ code: number; signal: "SIGTERM" | "SIGKILL" }>((resolve) => {
      settleTermination = resolve;
    }),
  ]);
  return {
    stdout,
    stderr,
    wait,
    terminate: vi.fn((signal: "SIGTERM" | "SIGKILL") => {
      terminated = true;
      stdout.destroy();
      stderr.destroy();
      settleTermination?.({ code: signal === "SIGTERM" ? 143 : 137, signal });
    }),
    get terminated() {
      return terminated;
    },
  };
}

function createDependencies(
  overrides: Partial<BackupDockerDependencies> = {},
): BackupDockerDependencies {
  return {
    execDocker: vi.fn(async () => successfulResult()),
    stopServices: vi.fn(async () => successfulResult()),
    getComposeContainerObservations: vi.fn(async () => []),
    spawnArchive: vi.fn(() =>
      createProcess(async (stdout, stderr) => {
        stdout.end();
        stderr.end();
        return { code: 0, signal: null };
      }),
    ),
    createArchiveSink: (handle) => {
      let position = 0;
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          handle
            .write(buffer, 0, buffer.byteLength, position)
            .then(({ bytesWritten }) => {
              position += bytesWritten;
              callback();
            })
            .catch((error: unknown) => {
              callback(error instanceof Error ? error : new Error("test sink failure"));
            });
        },
      });
    },
    createId: vi.fn(() => "attempt-id"),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("backup Docker adapter", () => {
  it.each([
    {
      name: "present",
      result: successfulResult(`${IMAGE_ID}\n`),
      expected: {
        reference: BACKUP_HELPER_IMAGE_REFERENCE,
        resolvedImageId: IMAGE_ID,
      },
    },
    {
      name: "missing",
      result: { code: 1, stdout: "", stderr: "not found", success: false },
      expected: undefined,
    },
    {
      name: "invalid identity",
      result: successfulResult("sha256:not-an-image-id\n"),
      expected: undefined,
    },
  ])("inspects the pinned helper without mutation when $name", async ({ result, expected }) => {
    const execDocker = vi.fn<BackupDockerDependencies["execDocker"]>().mockResolvedValue(result);
    const dependencies = createDependencies({ execDocker });

    await expect(inspectBackupHelper({}, dependencies)).resolves.toEqual(expected);
    expect(execDocker).toHaveBeenCalledTimes(1);
    expect(execDocker).toHaveBeenCalledWith(
      ["image", "inspect", "--format", "{{.Id}}", BACKUP_HELPER_IMAGE_REFERENCE],
      expect.any(Object),
    );
    expect(execDocker.mock.calls.some(([args]) => args.includes("pull"))).toBe(false);
  });

  it("pre-pulls the literal digest and resolves an immutable local image ID", async () => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found", success: false })
      .mockResolvedValueOnce(successfulResult())
      .mockResolvedValueOnce(successfulResult(`${IMAGE_ID}\n`));
    const dependencies = createDependencies({ execDocker });

    await expect(prepareBackupHelper({}, dependencies)).resolves.toEqual({
      reference: BACKUP_HELPER_IMAGE_REFERENCE,
      resolvedImageId: IMAGE_ID,
    });
    expect(execDocker.mock.calls.map(([args]) => args)).toEqual([
      ["image", "inspect", "--format", "{{.Id}}", BACKUP_HELPER_IMAGE_REFERENCE],
      ["image", "pull", BACKUP_HELPER_IMAGE_REFERENCE],
      ["image", "inspect", "--format", "{{.Id}}", BACKUP_HELPER_IMAGE_REFERENCE],
    ]);
  });

  it("builds one-mount hardened helper argv and rejects Docker mount delimiters", () => {
    expect(
      buildBackupHelperArgs(
        { kind: "volume", name: "media_data", driver: "local", external: false },
        IMAGE_ID,
        "rfapps-backup-attempt",
        ["tar", "-C", "/source", "-cf", "-", "."],
      ),
    ).toEqual([
      "run",
      "--rm",
      "--name",
      "rfapps-backup-attempt",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      "type=volume,src=media_data,dst=/source,readonly,volume-nocopy",
      "--pull",
      "never",
      IMAGE_ID,
      "tar",
      "-C",
      "/source",
      "-cf",
      "-",
      ".",
    ]);
    expect(() =>
      buildBackupHelperArgs(
        { kind: "bind", path: "/srv/data,ro" },
        IMAGE_ID,
        "rfapps-backup-attempt",
        ["test", "-d", "/source"],
      ),
    ).toThrowError(BackupDockerError);
  });

  it("builds a hardened fixed-target topology probe with direct mountinfo argv", () => {
    const args = buildBackupTopologyProbeArgs(
      ["/srv/data", "/srv/cache"],
      IMAGE_ID,
      "rfapps-backup-topology-attempt",
    );

    expect(args).toEqual([
      "run",
      "--rm",
      "--name",
      "rfapps-backup-topology-attempt",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      "type=bind,src=/srv/data,dst=/rfapps-bind-0000,readonly",
      "--mount",
      "type=bind,src=/srv/cache,dst=/rfapps-bind-0001,readonly",
      "--pull",
      "never",
      IMAGE_ID,
      "cat",
      "/proc/self/mountinfo",
    ]);
  });

  it("streams arbitrary binary bytes through gzip while hashing and counting compressed output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const input = Buffer.from([0, 255, 195, 40, 10, 1, 2, 3, 128]);
    const dependencies = createDependencies({
      spawnArchive: vi.fn(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end(input);
          stderr.end();
          return { code: 0, signal: null };
        }),
      ),
    });

    const outcome = await archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
      },
      dependencies,
    );
    const compressed = await readFile(destinationPath);

    expect(gunzipSync(compressed)).toEqual(input);
    expect(outcome).toEqual({
      compressedBytes: compressed.byteLength,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    });
  });

  it("restarts a failed partial archive from byte zero with fresh helper state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const spawnArchive = vi
      .fn<BackupDockerDependencies["spawnArchive"]>()
      .mockImplementationOnce(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end(Buffer.from("partial"));
          stderr.end("ssh: connection reset");
          return { code: 1, signal: null };
        }),
      )
      .mockImplementationOnce(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end(Buffer.from("complete"));
          stderr.end();
          return { code: 0, signal: null };
        }),
      );
    let nextId = 0;
    const dependencies = createDependencies({
      spawnArchive,
      createId: () => `attempt-${++nextId}`,
    });

    await archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
        maxAttempts: 2,
        retryDelayMs: 0,
      },
      dependencies,
    );

    expect(gunzipSync(await readFile(destinationPath)).toString()).toBe("complete");
    expect(spawnArchive.mock.calls.map(([args]) => args[args.indexOf("--name") + 1])).toEqual([
      "rfapps-backup-attempt-1",
      "rfapps-backup-attempt-2",
    ]);
  });

  it("times out inactive helpers, sanitizes stderr, and leaves no completed artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const process = createProcess(async (_stdout, stderr) => {
      stderr.write("https://user:password@example.test token=super-secret ");
      return await new Promise<{ code: number; signal: null }>(() => undefined);
    });
    const dependencies = createDependencies({ spawnArchive: vi.fn(() => process) });

    const failure = archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
        inactivityTimeoutMs: 10,
      },
      dependencies,
    );

    await expect(failure).rejects.toMatchObject({
      code: "ARCHIVE_INACTIVITY_TIMEOUT",
      stage: "archive",
    });
    await expect(failure).rejects.not.toThrow(/super-secret|user:password/u);
    expect(process.terminate).toHaveBeenCalledWith("SIGTERM");
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("escalates a noncooperative helper from SIGTERM to SIGKILL and awaits settlement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let settle: ((value: { code: number; signal: "SIGKILL" }) => void) | undefined;
    const wait = new Promise<{ code: number; signal: "SIGKILL" }>((resolve) => {
      settle = resolve;
    });
    const terminate = vi.fn((signal: "SIGTERM" | "SIGKILL") => {
      if (signal !== "SIGKILL") return;
      stdout.destroy();
      stderr.destroy();
      settle?.({ code: 137, signal });
    });
    const dependencies = createDependencies({
      spawnArchive: vi.fn(() => ({ stdout, stderr, wait, terminate })),
    });

    await expect(
      archiveBackupSource(
        {
          source: { kind: "bind", path: "/srv/media" },
          resolvedImageId: IMAGE_ID,
          destinationPath,
          inactivityTimeoutMs: 5,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_INACTIVITY_TIMEOUT" });

    expect(terminate.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("tears down and settles the helper after a sink failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const process = createProcess(async (stdout, stderr) => {
      stdout.write(Buffer.from("archive bytes"));
      stderr.end();
      return await new Promise<{ code: number; signal: null }>(() => undefined);
    });
    const dependencies = createDependencies({
      spawnArchive: vi.fn(() => process),
      createArchiveSink: () =>
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error("disk full"));
          },
        }),
    });

    await expect(
      archiveBackupSource(
        {
          source: { kind: "bind", path: "/srv/media" },
          resolvedImageId: IMAGE_ID,
          destinationPath,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "ARCHIVE_WRITE_FAILED" });

    expect(process.terminate).toHaveBeenCalledWith("SIGTERM");
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("surfaces helper cleanup failure and does not publish the artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const dependencies = createDependencies({
      execDocker: vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "daemon cleanup failure",
        success: false,
      })),
      spawnArchive: vi.fn(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end(Buffer.from("complete"));
          stderr.end();
          return { code: 0, signal: null };
        }),
      ),
    });

    await expect(
      archiveBackupSource(
        {
          source: { kind: "bind", path: "/srv/media" },
          resolvedImageId: IMAGE_ID,
          destinationPath,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "HELPER_CLEANUP_FAILED" });
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("aggregates helper cleanup failure without replacing the primary archive failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const dependencies = createDependencies({
      execDocker: vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "daemon cleanup failure",
        success: false,
      })),
      spawnArchive: vi.fn(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end();
          stderr.end("tar failed");
          return { code: 1, signal: null };
        }),
      ),
    });

    const failure = archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
      },
      dependencies,
    );

    await expect(failure).rejects.toMatchObject({ code: "ARCHIVE_HELPER_FAILED" });
    await expect(failure).rejects.toThrow(/confirm backup helper cleanup/u);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("bounds and sanitizes helper stderr before exposing a failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const dependencies = createDependencies({
      spawnArchive: vi.fn(() =>
        createProcess(async (stdout, stderr) => {
          stdout.end();
          stderr.end(
            `token=super-secret https://user:password@example.test ${"x".repeat(32 * 1024)}`,
          );
          return { code: 1, signal: null };
        }),
      ),
    });

    const failure = archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
      },
      dependencies,
    );

    await expect(failure).rejects.toMatchObject({
      code: "ARCHIVE_HELPER_FAILED",
      stage: "archive",
    });
    await expect(failure).rejects.not.toThrow(/super-secret|user:password/u);
    await expect(failure).rejects.toThrow(/\[REDACTED\]/u);
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("honors cancellation without publishing an artifact or re-raising a signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-backup-docker-test-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "artifact.tar.gz");
    const process = createProcess(async () => {
      return await new Promise<{ code: number; signal: null }>(() => undefined);
    });
    const controller = new AbortController();
    const dependencies = createDependencies({ spawnArchive: vi.fn(() => process) });

    const archive = archiveBackupSource(
      {
        source: { kind: "bind", path: "/srv/media" },
        resolvedImageId: IMAGE_ID,
        destinationPath,
        signal: controller.signal,
      },
      dependencies,
    );
    controller.abort();

    await expect(archive).rejects.toMatchObject({
      code: "ARCHIVE_CANCELLED",
      stage: "cancelled",
    });
    expect(process.terminate).toHaveBeenCalled();
    await expect(readFile(destinationPath)).rejects.toThrow();
  });

  it("probes named volumes and starts only a full captured container ID", async () => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce(successfulResult('[{"Name":"media","Driver":"local"}]'))
      .mockResolvedValueOnce(successfulResult(CONTAINER_ID));
    const dependencies = createDependencies({ execDocker });

    await expect(
      probeBackupSource(
        { kind: "volume", name: "media", driver: "local", external: false },
        IMAGE_ID,
        {},
        dependencies,
      ),
    ).resolves.toEqual({ status: "available" });
    await startBackupContainer(CONTAINER_ID, {}, dependencies);

    expect(execDocker.mock.calls.map(([args]) => args)).toEqual([
      ["volume", "inspect", "media"],
      ["container", "start", CONTAINER_ID],
    ]);
    await expect(startBackupContainer("short-id", {}, dependencies)).rejects.toMatchObject({
      code: "INVALID_CONTAINER_ID",
    });
  });

  it.each([
    { stdout: "directory\n", expected: { status: "available" } },
    {
      stdout: "regular file\n",
      expected: { status: "not-directory", kind: "file" },
    },
    {
      stdout: "socket\n",
      expected: { status: "not-directory", kind: "socket" },
    },
    {
      stdout: "block special file\n",
      expected: { status: "not-directory", kind: "device" },
    },
    {
      stdout: "symbolic link\n",
      expected: { status: "not-directory", kind: "other" },
    },
  ])("classifies daemon-side bind evidence from $stdout", async ({ stdout, expected }) => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce(successfulResult(stdout))
      .mockResolvedValueOnce(successfulResult());
    const dependencies = createDependencies({ execDocker });

    await expect(
      probeBackupSource({ kind: "bind", path: "/remote/source" }, IMAGE_ID, {}, dependencies),
    ).resolves.toEqual(expected);
    expect(execDocker.mock.calls[0]?.[0].slice(-4)).toEqual(["stat", "-c", "%F", "/source"]);
  });

  it("classifies a missing daemon-side bind without consulting the client filesystem", async () => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce({
        code: 125,
        stdout: "",
        stderr: "invalid mount config: bind source path does not exist",
        success: false,
      })
      .mockResolvedValueOnce(successfulResult());
    const dependencies = createDependencies({ execDocker });

    await expect(
      probeBackupSource({ kind: "bind", path: "/remote/missing" }, IMAGE_ID, {}, dependencies),
    ).resolves.toEqual({ status: "missing" });
  });

  it("rejects a bind probe result when strict helper cleanup fails", async () => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce(successfulResult("directory\n"))
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "daemon cleanup failure",
        success: false,
      });
    const dependencies = createDependencies({ execDocker });

    await expect(
      probeBackupSource({ kind: "bind", path: "/remote/source" }, IMAGE_ID, {}, dependencies),
    ).rejects.toMatchObject({ code: "HELPER_CLEANUP_FAILED" });
  });

  it("aggregates bind-probe cleanup failure without replacing the primary probe failure", async () => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce({
        code: 125,
        stdout: "",
        stderr: "daemon unavailable",
        success: false,
      })
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "daemon cleanup failure",
        success: false,
      });
    const dependencies = createDependencies({ execDocker });

    const failure = probeBackupSource(
      { kind: "bind", path: "/remote/source" },
      IMAGE_ID,
      {},
      dependencies,
    );

    await expect(failure).rejects.toMatchObject({ code: "SOURCE_PROBE_FAILED" });
    await expect(failure).rejects.toThrow(/confirm backup helper cleanup/u);
  });

  it("parses and hashes daemon bind topology identity deterministically", async () => {
    const output = [
      "40 25 8:1 /srv/cache /rfapps-bind-0000 ro - ext4 /dev/sda1 rw",
      "41 25 8:1 /srv/My\\040Data /rfapps-bind-0001 ro - ext4 /dev/sda1 rw",
    ].join("\n");
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce(successfulResult(output))
      .mockResolvedValueOnce(successfulResult());
    const dependencies = createDependencies({ execDocker });

    const result = await probeBackupBindTopology(
      ["/srv/data", "/srv/cache"],
      IMAGE_ID,
      {},
      dependencies,
    );

    expect(result.entries).toEqual([
      { sourcePath: "/srv/cache", majorMinor: "8:1", mountRoot: "/srv/cache" },
      { sourcePath: "/srv/data", majorMinor: "8:1", mountRoot: "/srv/My Data" },
    ]);
    expect(result.fingerprint).toBe(
      createHash("sha256")
        .update("/srv/cache\u00008:1\u0000/srv/cache\n/srv/data\u00008:1\u0000/srv/My Data\n")
        .digest("hex"),
    );
    expect(execDocker.mock.calls[0]?.[0].slice(-2)).toEqual(["cat", "/proc/self/mountinfo"]);
  });

  it.each([
    {
      name: "missing target",
      output: "40 25 8:1 /srv/data /not-the-target ro - ext4 /dev/sda1 rw",
    },
    {
      name: "duplicate target",
      output: [
        "40 25 8:1 /srv/data /rfapps-bind-0000 ro - ext4 /dev/sda1 rw",
        "41 25 8:1 /srv/data /rfapps-bind-0000 ro - ext4 /dev/sda1 rw",
      ].join("\n"),
    },
    {
      name: "malformed device",
      output: "40 25 invalid /srv/data /rfapps-bind-0000 ro - ext4 /dev/sda1 rw",
    },
    {
      name: "malformed root escape",
      output: "40 25 8:1 /srv/Bad\\077Root /rfapps-bind-0000 ro - ext4 /dev/sda1 rw",
    },
  ])("rejects $name topology evidence", async ({ output }) => {
    const execDocker = vi
      .fn<BackupDockerDependencies["execDocker"]>()
      .mockResolvedValueOnce(successfulResult(output))
      .mockResolvedValueOnce(successfulResult());
    const dependencies = createDependencies({ execDocker });

    await expect(
      probeBackupBindTopology(["/srv/data"], IMAGE_ID, {}, dependencies),
    ).rejects.toMatchObject({ code: "SOURCE_PROBE_FAILED", stage: "validate" });
  });

  it("captures active exact writer containers and pins the Compose stop authority", async () => {
    const observations = [
      {
        containerId: CONTAINER_ID,
        containerName: "fixture-web-1",
        serviceName: "web",
        state: "running",
        health: "healthy",
      },
      {
        containerId: "c".repeat(64),
        containerName: "fixture-db-1",
        serviceName: "db",
        state: "exited",
        health: "",
      },
    ];
    const getComposeContainerObservations = vi.fn(async () => observations);
    const stopServices = vi.fn(async () => successfulResult());
    const dependencies = createDependencies({
      getComposeContainerObservations,
      stopServices,
    });
    const options = {
      projectName: "fixture",
      envFile: "/project/.env",
      profiles: ["media"] as const,
    };

    await expect(
      observeRunningBackupContainers("/project/compose.yml", ["web", "db"], options, dependencies),
    ).resolves.toEqual([observations[0]]);
    await stopBackupWriterServices("/project/compose.yml", ["web", "db"], options, dependencies);

    expect(getComposeContainerObservations).toHaveBeenCalledWith("/project/compose.yml", options);
    expect(stopServices).toHaveBeenCalledWith(
      "/project/compose.yml",
      ["web", "db"],
      expect.objectContaining({
        projectName: "fixture",
        envFile: "/project/.env",
        profiles: ["media"],
      }),
    );
  });

  it("does not observe or stop the Compose project when there are no writer services", async () => {
    const getComposeContainerObservations = vi.fn(async () => []);
    const stopServices = vi.fn(async () => successfulResult());
    const dependencies = createDependencies({
      getComposeContainerObservations,
      stopServices,
    });

    await expect(
      observeRunningBackupContainers("/project/compose.yml", [], {}, dependencies),
    ).resolves.toEqual([]);
    await stopBackupWriterServices("/project/compose.yml", [], {}, dependencies);

    expect(getComposeContainerObservations).not.toHaveBeenCalled();
    expect(stopServices).not.toHaveBeenCalled();
  });
});
