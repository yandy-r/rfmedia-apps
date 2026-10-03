import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LifecycleLockError,
  acquireLifecycleLock,
  withLifecycleLock,
  type AcquireLifecycleLockOptions,
  type LifecycleLock,
} from "./lifecycle-lock.js";

describe("lifecycle lock", () => {
  let tempDir: string;
  let projectA: string;
  let projectB: string;
  let stateDir: string;
  const acquiredLocks: LifecycleLock[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfapps-lifecycle-lock-"));
    projectA = join(tempDir, "project-a");
    projectB = join(tempDir, "project-b");
    stateDir = join(tempDir, "state");
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
  });

  afterEach(async () => {
    await Promise.allSettled(acquiredLocks.map(async (lock) => lock.release()));
    await rm(tempDir, { recursive: true, force: true });
  });

  function options(
    overrides: Partial<AcquireLifecycleLockOptions> = {},
  ): AcquireLifecycleLockOptions {
    return {
      projectPath: projectA,
      dockerContext: "default",
      stateDir,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      isProcessAlive: () => true,
      ...overrides,
    };
  }

  async function acquire(
    overrides: Partial<AcquireLifecycleLockOptions> = {},
  ): Promise<LifecycleLock> {
    const lock = await acquireLifecycleLock(options(overrides));
    acquiredLocks.push(lock);
    return lock;
  }

  it("acquires atomically with private state and bounded owner metadata", async () => {
    const lock = await acquire();
    const lockStat = await stat(lock.path);
    const directoryStat = await stat(dirname(lock.path));

    expect(lock.owner).toEqual({
      pid: process.pid,
      startedAt: "2026-07-17T12:00:00.000Z",
      projectPath: projectA,
      dockerContext: "default",
    });
    expect(lockStat.mode & 0o777).toBe(0o600);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(lockStat.size).toBeLessThanOrEqual(8192);
  });

  it("rejects contention for the same canonical project and Docker context", async () => {
    const first = await acquire({ pid: 1234 });

    await expect(acquireLifecycleLock(options())).rejects.toMatchObject({
      name: "LifecycleLockError",
      code: "LOCK_HELD",
      lockPath: first.path,
      owner: {
        pid: 1234,
        projectPath: projectA,
        dockerContext: "default",
      },
    });
  });

  it("uses the canonical project path so a symlink alias contends", async () => {
    const alias = join(tempDir, "project-alias");
    await symlink(projectA, alias);
    await acquire();

    await expect(acquireLifecycleLock(options({ projectPath: alias }))).rejects.toMatchObject({
      code: "LOCK_HELD",
    });
  });

  it("allows different projects and Docker contexts to hold independent locks", async () => {
    const locks = await Promise.all([
      acquire(),
      acquire({ projectPath: projectB }),
      acquire({ dockerContext: "remote-production" }),
      acquire({ composeProjectName: "alternate-project" }),
    ]);

    expect(new Set(locks.map((lock) => lock.path))).toHaveLength(4);
  });

  it("reports stale owners without taking over their lock", async () => {
    const stale = await acquire({ pid: 987_654 });

    await expect(
      acquireLifecycleLock(options({ isProcessAlive: () => false })),
    ).rejects.toMatchObject({
      code: "LOCK_STALE",
      lockPath: stale.path,
      owner: { pid: 987_654 },
    });
    await expect(lstat(stale.path)).resolves.toBeDefined();
  });

  it("rejects malformed and oversized metadata without taking over", async () => {
    const malformed = await acquire();
    await writeFile(malformed.path, "{not-json", "utf-8");

    await expect(acquireLifecycleLock(options())).rejects.toMatchObject({
      code: "LOCK_METADATA_INVALID",
    });
    await writeFile(malformed.path, "x".repeat(8193), "utf-8");
    await expect(acquireLifecycleLock(options())).rejects.toMatchObject({
      code: "LOCK_METADATA_INVALID",
    });
    await expect(lstat(malformed.path)).resolves.toBeDefined();
  });

  it("rejects symlinked state paths and lock files", async () => {
    const realState = join(tempDir, "real-state");
    const linkedState = join(tempDir, "linked-state");
    await mkdir(realState);
    await symlink(realState, linkedState);

    await expect(acquireLifecycleLock(options({ stateDir: linkedState }))).rejects.toMatchObject({
      code: "LOCK_PATH_UNSAFE",
    });

    const lock = await acquire();
    const lockPath = lock.path;
    await lock.release();
    const target = join(tempDir, "symlink-target");
    await writeFile(target, "do not touch", "utf-8");
    await symlink(target, lockPath);

    await expect(acquireLifecycleLock(options())).rejects.toMatchObject({
      code: "LOCK_PATH_UNSAFE",
    });
  });

  it("rejects state directories that are not private", async () => {
    const lockDir = join(stateDir, "locks");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await chmod(lockDir, 0o755);

    await expect(acquireLifecycleLock(options())).rejects.toMatchObject({
      code: "LOCK_PATH_UNSAFE",
    });
  });

  it("releases in finally when an operation is interrupted", async () => {
    let lockPath = "";
    const interrupted = new Error("SIGINT");

    await expect(
      withLifecycleLock(options(), async (lock) => {
        lockPath = lock.path;
        throw interrupted;
      }),
    ).rejects.toBe(interrupted);

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const reacquired = await acquire();
    expect(reacquired.path).toBe(lockPath);
  });

  it("makes release idempotent", async () => {
    const lock = await acquire();

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lstat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not unlink a replacement lock during release", async () => {
    const lock = await acquire();
    await rm(lock.path);
    await writeFile(lock.path, "replacement", { mode: 0o600 });

    await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_PATH_UNSAFE" });
    await expect(lstat(lock.path)).resolves.toBeDefined();
  });

  it("rejects invalid project paths and unbounded or unsafe contexts", async () => {
    await expect(
      acquireLifecycleLock(options({ projectPath: join(tempDir, "missing") })),
    ).rejects.toBeInstanceOf(LifecycleLockError);
    await expect(
      acquireLifecycleLock(options({ dockerContext: `bad\ncontext` })),
    ).rejects.toMatchObject({ code: "LOCK_METADATA_INVALID" });
    await expect(
      acquireLifecycleLock(options({ dockerContext: "x".repeat(257) })),
    ).rejects.toMatchObject({ code: "LOCK_METADATA_INVALID" });
  });
});
