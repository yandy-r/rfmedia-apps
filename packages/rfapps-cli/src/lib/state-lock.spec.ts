import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STATE_LOCK_STALE_AFTER_MS,
  StateLockError,
  acquireStateLock,
  forceUnlockStateLock,
  inspectStateLock,
  withStateLock,
  type StateLock,
} from "./state-lock.js";

describe("state lock", () => {
  let tempDir: string;
  let lockPath: string;
  const locks: StateLock[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rfapps-state-lock-"));
    lockPath = join(tempDir, ".rfapps", "lock");
  });

  afterEach(async () => {
    await Promise.allSettled(locks.map(async (lock) => lock.release()));
    await rm(tempDir, { recursive: true, force: true });
  });

  async function acquire(
    overrides: {
      operation?: string;
      when?: string;
      lockId?: string;
    } = {},
  ): Promise<StateLock> {
    const lock = await acquireStateLock({
      operation: overrides.operation ?? "deploy",
      lockPath,
      who: "operator@host",
      now: () => new Date(overrides.when ?? "2026-07-24T12:00:00.000Z"),
      randomId: () => overrides.lockId ?? "123e4567-e89b-42d3-a456-426614174000",
    });
    locks.push(lock);
    return lock;
  }

  it("acquires atomically with private permissions and exact owner metadata", async () => {
    const lock = await acquire();
    const tokenPath = join(lockPath, lock.metadata.lockId);

    await expect(readFile(tokenPath, "utf-8")).resolves.toBe(
      '{"operation":"deploy","who":"operator@host","when":"2026-07-24T12:00:00.000Z",' +
        '"lockId":"123e4567-e89b-42d3-a456-426614174000"}\n',
    );
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(lockPath)).mode & 0o777).toBe(0o700);
    expect((await stat(join(tempDir, ".rfapps"))).mode & 0o777).toBe(0o700);
    expect(lock.metadata.operation).toBe("deploy");
  });

  it("distinguishes active locks, the exact threshold, and locks older than ten minutes", async () => {
    await acquire({ when: "2026-07-24T12:00:00.000Z" });
    const acquiredAt = Date.parse("2026-07-24T12:00:00.000Z");

    await expect(
      acquireStateLock({
        operation: "stop",
        lockPath,
        who: "second@host",
        now: () => new Date(acquiredAt + STATE_LOCK_STALE_AFTER_MS),
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });

    await expect(
      acquireStateLock({
        operation: "stop",
        lockPath,
        who: "second@host",
        now: () => new Date(acquiredAt + STATE_LOCK_STALE_AFTER_MS + 1),
      }),
    ).rejects.toMatchObject({
      code: "LOCK_STALE",
      metadata: { operation: "deploy", who: "operator@host" },
    });
    await expect(lstat(lockPath)).resolves.toBeDefined();
  });

  it("releases in finally when the protected operation fails", async () => {
    const failure = new Error("deploy failed");

    await expect(
      withStateLock(
        "deploy",
        async () => {
          throw failure;
        },
        {
          lockPath,
          who: "operator@host",
          now: () => new Date("2026-07-24T12:00:00.000Z"),
          randomId: () => "123e4567-e89b-42d3-a456-426614174000",
        },
      ),
    ).rejects.toBe(failure);

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(tempDir, ".rfapps"))).resolves.toEqual([]);
  });

  it("fails closed on invalid metadata but permits explicit inspected force-unlock", async () => {
    const lock = await acquire();
    await lock.release();
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(join(lockPath, "invalid-token"), "{not-json", { mode: 0o600 });

    const inspection = await inspectStateLock({ lockPath });
    expect(inspection).toMatchObject({ status: "invalid" });
    await expect(
      acquireStateLock({ operation: "deploy", lockPath, who: "operator@host" }),
    ).rejects.toMatchObject({ code: "LOCK_METADATA_INVALID" });
    await expect(forceUnlockStateLock(inspection)).resolves.toBe(true);
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses force-unlock when invalid metadata changes on the same inode", async () => {
    const lock = await acquire();
    await lock.release();
    const replacementId = "223e4567-e89b-42d3-a456-426614174000";
    const tokenPath = join(lockPath, replacementId);
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(tokenPath, "{not-json", { mode: 0o600 });
    const inspection = await inspectStateLock({ lockPath });

    await writeFile(
      tokenPath,
      '{"operation":"stop","who":"other@host","when":"2026-07-24T12:01:00.000Z",' +
        `"lockId":"${replacementId}"}\n`,
    );

    await expect(forceUnlockStateLock(inspection)).rejects.toMatchObject({
      code: "LOCK_CHANGED",
    });
    await expect(readFile(tokenPath, "utf-8")).resolves.toContain(`"lockId":"${replacementId}"`);
  });

  it("does not remove a replacement during release or force-unlock", async () => {
    const lock = await acquire();
    const inspection = await inspectStateLock({ lockPath });
    const replacementId = "223e4567-e89b-42d3-a456-426614174000";

    await rm(lockPath, { recursive: true });
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(
      join(lockPath, replacementId),
      '{"operation":"stop","who":"other@host","when":"2026-07-24T12:01:00.000Z",' +
        `"lockId":"${replacementId}"}\n`,
      { mode: 0o600 },
    );

    await expect(lock.release()).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    await expect(forceUnlockStateLock(inspection)).rejects.toMatchObject({
      code: "LOCK_CHANGED",
    });
    await expect(readFile(join(lockPath, replacementId), "utf-8")).resolves.toContain(
      `"lockId":"${replacementId}"`,
    );
    await expect(readdir(join(tempDir, ".rfapps"))).resolves.toEqual(["lock"]);
  });

  it("keeps a replacement owner locked when the previous owner releases", async () => {
    const previous = await acquire();
    await rm(lockPath, { recursive: true });
    const replacement = await acquire({
      operation: "stop",
      lockId: "223e4567-e89b-42d3-a456-426614174000",
    });

    await expect(previous.release()).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    await expect(
      acquireStateLock({
        operation: "deploy",
        lockPath,
        who: "third@host",
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "LOCK_HELD" });
    await replacement.release();
  });

  it("does not let an acquisition succeed after force-unlock removes its published token", async () => {
    await expect(
      acquireStateLock({
        operation: "deploy",
        lockPath,
        who: "operator@host",
        now: () => new Date("2026-07-24T12:00:00.000Z"),
        randomId: () => "123e4567-e89b-42d3-a456-426614174000",
        onTokenWritten: async () => {
          const inspection = await inspectStateLock({ lockPath });
          await forceUnlockStateLock(inspection);
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not clean up a replacement directory after publication verification fails", async () => {
    const lockId = "123e4567-e89b-42d3-a456-426614174000";
    const replacementContent =
      '{"operation":"stop","who":"replacement@host","when":"2026-07-24T12:01:00.000Z",' +
      `"lockId":"${lockId}"}\n`;

    await expect(
      acquireStateLock({
        operation: "deploy",
        lockPath,
        who: "operator@host",
        now: () => new Date("2026-07-24T12:00:00.000Z"),
        randomId: () => lockId,
        onTokenWritten: async () => {
          await rm(lockPath, { recursive: true });
          await mkdir(lockPath, { mode: 0o700 });
          await writeFile(join(lockPath, lockId), replacementContent, { mode: 0o600 });
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_CHANGED" });
    await expect(readFile(join(lockPath, lockId), "utf-8")).resolves.toBe(replacementContent);
  });

  it("rejects symlink lock paths without touching their targets", async () => {
    const target = join(tempDir, "target");
    await writeFile(target, "keep", { mode: 0o600 });
    await chmod(tempDir, 0o700);
    await mkdir(join(tempDir, ".rfapps"), { mode: 0o700 });
    await symlink(target, lockPath);

    await expect(
      acquireStateLock({ operation: "deploy", lockPath, who: "operator@host" }),
    ).rejects.toBeInstanceOf(StateLockError);
    await expect(readFile(target, "utf-8")).resolves.toBe("keep");
  });

  it("rejects symlinked parent components before creating the lock directory", async () => {
    const targetDirectory = join(tempDir, "target-directory");
    const linkedDirectory = join(tempDir, "linked-directory");
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(targetDirectory, linkedDirectory);

    await expect(
      acquireStateLock({
        operation: "deploy",
        lockPath: join(linkedDirectory, ".rfapps", "lock"),
        who: "operator@host",
      }),
    ).rejects.toMatchObject({ code: "LOCK_PATH_UNSAFE" });
    await expect(lstat(join(targetDirectory, ".rfapps"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
