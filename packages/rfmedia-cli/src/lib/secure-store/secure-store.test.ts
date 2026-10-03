import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, parse } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireExclusiveLock,
  createPrivateFileAtomically,
  prepareSafeParent,
  readBoundedPrivateFile,
  readBoundedPrivateFileSync,
  replacePrivateFileAtomically,
  SECURE_STORE_LOCK_MAX_AGE_MS,
  SecureStoreError,
  syncDirectory,
} from "./index.js";
import type { SecureStoreLockRecord } from "./index.js";

const SUBJECT = "Test credential store";
const MAX_BYTES = 8 * 1024;

let tempDir: string;
let lockPath: string;
let storePath: string;

function readRecord(path: string): SecureStoreLockRecord {
  return JSON.parse(readFileSync(path, "utf8")) as SecureStoreLockRecord;
}

function writeLockRecord(path: string, record: SecureStoreLockRecord): void {
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function captureSync(run: () => unknown): SecureStoreError {
  try {
    run();
  } catch (error) {
    if (error instanceof SecureStoreError) return error;
    throw error;
  }
  throw new Error("Expected a SecureStoreError to be thrown");
}

async function captureAsync(run: () => Promise<unknown>): Promise<SecureStoreError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SecureStoreError) return error;
    throw error;
  }
  throw new Error("Expected a SecureStoreError to be rejected");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "secure-store-"));
  storePath = join(tempDir, "store.json");
  lockPath = `${storePath}.lock`;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("acquireExclusiveLock", () => {
  it("keeps strict lock ownership and temporary UUID seams fail-closed", async () => {
    const host = "strict-lock-host";
    const foreignBytes = JSON.stringify({
      host,
      pid: 424_242,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
      foreign: true,
    });
    writeFileSync(lockPath, foreignBytes, { mode: 0o600 });

    const corrupt = await captureAsync(async () =>
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        hostname: () => host,
        isProcessAlive: () => false,
        strictRecordShape: true,
      }),
    );
    expect(corrupt.code).toBe("SECURE_STORE_CORRUPT");
    expect(readFileSync(lockPath, "utf8")).toBe(foreignBytes);
    await rm(lockPath);

    const ownershipUUID = "11111111-1111-4111-8111-111111111111";
    const temporaryUUID = "22222222-2222-4222-8222-222222222222";
    let ownershipUUIDCalls = 0;
    let temporaryUUIDCalls = 0;
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
      hostname: () => host,
      strictRecordShape: true,
      randomUUID: () => {
        ownershipUUIDCalls += 1;
        return ownershipUUID;
      },
      temporaryUUID: () => {
        temporaryUUIDCalls += 1;
        return temporaryUUID;
      },
    });
    expect(lock.ownershipToken).toBe(ownershipUUID);
    expect(ownershipUUIDCalls).toBe(1);
    expect(temporaryUUIDCalls).toBe(1);

    const replacementBytes = JSON.stringify({ ...readRecord(lockPath), foreign: true });
    writeFileSync(lockPath, replacementBytes, { mode: 0o600 });
    const lost = await captureAsync(async () => lock.assertOwned());
    expect(lost.code).toBe("SECURE_STORE_CORRUPT");
    const release = await captureAsync(async () => lock.release());
    expect(release.code).toBe("SECURE_STORE_CORRUPT");
    expect(readFileSync(lockPath, "utf8")).toBe(replacementBytes);

    await rm(lockPath);
    if (process.platform !== "win32") {
      const probePath = join(tempDir, "sync-probe");
      writeFileSync(probePath, "probe", { mode: 0o600 });
      const probeHandle = await open(probePath, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
        sync(): Promise<void>;
      };
      await probeHandle.close();
      const syncSpy = vi
        .spyOn(fileHandlePrototype, "sync")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          Object.assign(new Error("forced directory sync failure"), { code: "EIO" }),
        );

      try {
        await expect(
          acquireExclusiveLock(lockPath, {
            subject: SUBJECT,
            deadlineEpochMs: Date.now(),
            strictRecordShape: true,
          }),
        ).rejects.toMatchObject({ code: "EIO" });
      } finally {
        syncSpy.mockRestore();
      }

      expect(existsSync(lockPath)).toBe(false);
      const retry = await acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        strictRecordShape: true,
      });
      expect(readRecord(lockPath).ownershipToken).toBe(retry.ownershipToken);
      await retry.release();
    }
  });

  it("makes a contending waiter back off and acquire once the holder releases", async () => {
    const holder = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 10_000,
    });
    const waiting = acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 10_000,
    });

    await delay(150);
    expect(readRecord(lockPath).ownershipToken).toBe(holder.ownershipToken);
    await holder.release();

    const waiter = await waiting;
    expect(waiter.ownershipToken).not.toBe(holder.ownershipToken);
    expect(readRecord(lockPath).ownershipToken).toBe(waiter.ownershipToken);

    await waiter.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("steals a lock held by a dead pid on this host", async () => {
    const abandoned: SecureStoreLockRecord = {
      host: hostname(),
      pid: 424_242,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
    };
    writeLockRecord(lockPath, abandoned);

    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
      isProcessAlive: () => false,
    });

    expect(lock.ownershipToken).not.toBe(abandoned.ownershipToken);
    expect(readRecord(lockPath).ownershipToken).toBe(lock.ownershipToken);
    await lock.release();
  });

  it("steals a lock whose record is older than the max age, on any host", async () => {
    const aged: SecureStoreLockRecord = {
      host: "some-other-host",
      pid: 1,
      createdAt: new Date(Date.now() - SECURE_STORE_LOCK_MAX_AGE_MS - 1_000).toISOString(),
      ownershipToken: randomUUID(),
    };
    writeLockRecord(lockPath, aged);

    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
      // Proves age alone steals: the peer is reported alive and is cross-host.
      isProcessAlive: () => true,
    });

    expect(readRecord(lockPath).ownershipToken).toBe(lock.ownershipToken);
    await lock.release();
  });

  it("gives up with SECURE_STORE_LOCK_BUSY when a live peer holds the lock", async () => {
    const peer: SecureStoreLockRecord = {
      host: hostname(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
    };
    writeLockRecord(lockPath, peer);

    const error = await captureAsync(async () =>
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now() + 250,
        isProcessAlive: () => true,
      }),
    );

    expect(error.code).toBe("SECURE_STORE_LOCK_BUSY");
    expect(error.remediation).toContain(lockPath);
    expect(readRecord(lockPath).ownershipToken).toBe(peer.ownershipToken);
  });
});

describe("readBoundedPrivateFileSync", () => {
  it("refuses a group-readable file and a symlink, without repairing either", () => {
    writeFileSync(storePath, '{"ok":true}', { mode: 0o600 });
    expect(readBoundedPrivateFileSync(storePath, MAX_BYTES, SUBJECT)?.text).toBe('{"ok":true}');

    chmodSync(storePath, 0o640);
    const permissions = captureSync(() =>
      readBoundedPrivateFileSync(storePath, MAX_BYTES, SUBJECT),
    );
    expect(permissions.code).toBe("SECURE_STORE_PERMISSIONS");
    expect(permissions.remediation).toBe(`chmod 600 ${storePath}`);
    // No silent repair: the mode is exactly as the operator left it.
    expect(lstatSync(storePath).mode & 0o777).toBe(0o640);

    chmodSync(storePath, 0o600);
    const linkPath = join(tempDir, "store-link.json");
    symlinkSync(storePath, linkPath);
    const unsafe = captureSync(() => readBoundedPrivateFileSync(linkPath, MAX_BYTES, SUBJECT));
    expect(unsafe.code).toBe("SECURE_STORE_UNSAFE_PATH");
  });
});

describe("replacePrivateFileAtomically", () => {
  it("replaces a world-readable file with a private one on a new inode", async () => {
    writeFileSync(storePath, "old", { mode: 0o600 });
    chmodSync(storePath, 0o644);
    const before = lstatSync(storePath);

    const identity = await replacePrivateFileAtomically({
      path: storePath,
      text: "new",
      subject: SUBJECT,
      temporaryId: "store",
      expectedIdentity: { dev: before.dev, ino: before.ino },
    });

    const after = lstatSync(storePath);
    expect(after.ino).not.toBe(before.ino);
    expect(identity.ino).toBe(after.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(readFileSync(storePath, "utf8")).toBe("new");
  });
});

describe("final-parent policy", () => {
  it("rejects filesystem-root hardening without changing its mode", async () => {
    const filesystemRoot = parse(tempDir).root;
    const modeBefore = lstatSync(filesystemRoot).mode & 0o777;

    const unsafe = await captureAsync(async () =>
      prepareSafeParent(join(filesystemRoot, "store.json"), false, SUBJECT, "harden-private"),
    );

    expect(unsafe.code).toBe("SECURE_STORE_UNSAFE_PATH");
    expect(lstatSync(filesystemRoot).mode & 0o777).toBe(modeBefore);
  });

  it("preserves validate-only modes and hardens only the selected final parent", async () => {
    const validateParent = join(tempDir, "validate-parent");
    await mkdir(validateParent, { mode: 0o700 });
    chmodSync(validateParent, 0o750);

    await prepareSafeParent(join(validateParent, "store.json"), false, SUBJECT);
    expect(lstatSync(validateParent).mode & 0o777).toBe(0o750);

    const ancestor = join(tempDir, "harden-ancestor");
    const hardenParent = join(ancestor, "harden-parent");
    await mkdir(hardenParent, { recursive: true, mode: 0o700 });
    chmodSync(ancestor, 0o750);
    chmodSync(hardenParent, 0o775);

    await prepareSafeParent(join(hardenParent, "store.json"), false, SUBJECT, "harden-private");
    expect(lstatSync(hardenParent).mode & 0o777).toBe(0o700);
    expect(lstatSync(ancestor).mode & 0o777).toBe(0o750);
  });

  it("propagates harden-private through create and replace under umask 0277", async () => {
    const createParent = join(tempDir, "create-parent");
    const replaceParent = join(tempDir, "replace-parent");
    await mkdir(createParent, { mode: 0o700 });
    await mkdir(replaceParent, { mode: 0o700 });
    chmodSync(createParent, 0o775);
    chmodSync(replaceParent, 0o775);

    const createPath = join(createParent, "created.json");
    const replacePath = join(replaceParent, "replaced.json");
    writeFileSync(replacePath, "old", { mode: 0o600 });
    const beforeReplace = lstatSync(replacePath);
    const previousUmask = process.umask(0o277);
    try {
      await createPrivateFileAtomically({
        path: createPath,
        text: "created",
        subject: SUBJECT,
        temporaryId: "created",
        finalParentPolicy: "harden-private",
      });
      await replacePrivateFileAtomically({
        path: replacePath,
        text: "replaced",
        subject: SUBJECT,
        temporaryId: "replaced",
        expectedIdentity: { dev: beforeReplace.dev, ino: beforeReplace.ino },
        finalParentPolicy: "harden-private",
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(createParent).mode & 0o777).toBe(0o700);
    expect(lstatSync(replaceParent).mode & 0o777).toBe(0o700);
    expect(lstatSync(createPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(replacePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(createPath, "utf8")).toBe("created");
    expect(readFileSync(replacePath, "utf8")).toBe("replaced");
  });
});

describe("readBoundedPrivateFile", () => {
  it("returns undefined for a missing file and refuses an over-permissive or oversized one", async () => {
    expect(await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT)).toBeUndefined();

    writeFileSync(storePath, '{"ok":true}', { mode: 0o600 });
    chmodSync(storePath, 0o600);
    expect((await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT))?.text).toBe('{"ok":true}');

    chmodSync(storePath, 0o640);
    const permissions = await captureAsync(async () =>
      readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT),
    );
    expect(permissions.code).toBe("SECURE_STORE_PERMISSIONS");
    // No silent repair: the mode is exactly as the operator left it.
    expect(lstatSync(storePath).mode & 0o777).toBe(0o640);

    chmodSync(storePath, 0o600);
    const tooLarge = await captureAsync(async () => readBoundedPrivateFile(storePath, 4, SUBJECT));
    expect(tooLarge.code).toBe("SECURE_STORE_TOO_LARGE");
  });

  it("allows foreign reads without allowing foreign writes or bypassing reader checks", async () => {
    writeFileSync(storePath, '{"ok":true}', { mode: 0o600 });
    chmodSync(storePath, 0o644);
    expect(
      (await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT, "allow-foreign-read"))?.text,
    ).toBe('{"ok":true}');

    chmodSync(storePath, 0o620);
    const permissions = await captureAsync(async () =>
      readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT, "allow-foreign-read"),
    );
    expect(permissions.code).toBe("SECURE_STORE_PERMISSIONS");
    expect(lstatSync(storePath).mode & 0o777).toBe(0o620);

    chmodSync(storePath, 0o644);
    const tooLarge = await captureAsync(async () =>
      readBoundedPrivateFile(storePath, 4, SUBJECT, "allow-foreign-read"),
    );
    expect(tooLarge.code).toBe("SECURE_STORE_TOO_LARGE");

    const linkPath = join(tempDir, "store-link.json");
    symlinkSync(storePath, linkPath);
    const unsafe = await captureAsync(async () =>
      readBoundedPrivateFile(linkPath, MAX_BYTES, SUBJECT, "allow-foreign-read"),
    );
    expect(unsafe.code).toBe("SECURE_STORE_UNSAFE_PATH");
  });

  it("allows an explicit non-mutating read from an untrusted final parent", async () => {
    const sharedParent = join(tempDir, "shared-parent");
    const sharedPath = join(sharedParent, "shared.json");
    await mkdir(sharedParent, { mode: 0o700 });
    chmodSync(sharedParent, 0o775);
    writeFileSync(sharedPath, '{"ok":true}', { mode: 0o600 });
    chmodSync(sharedPath, 0o644);

    const strict = await captureAsync(async () =>
      readBoundedPrivateFile(sharedPath, MAX_BYTES, SUBJECT, "allow-foreign-read"),
    );
    expect(strict.code).toBe("SECURE_STORE_UNSAFE_PATH");
    expect(
      (
        await readBoundedPrivateFile(
          sharedPath,
          MAX_BYTES,
          SUBJECT,
          "allow-foreign-read",
          "read-compatible",
        )
      )?.text,
    ).toBe('{"ok":true}');
    expect(lstatSync(sharedParent).mode & 0o777).toBe(0o775);
    expect(lstatSync(sharedPath).mode & 0o777).toBe(0o644);

    chmodSync(sharedPath, 0o664);
    const writable = await captureAsync(async () =>
      readBoundedPrivateFile(
        sharedPath,
        MAX_BYTES,
        SUBJECT,
        "allow-foreign-read",
        "read-compatible",
      ),
    );
    expect(writable.code).toBe("SECURE_STORE_PERMISSIONS");
    expect(lstatSync(sharedPath).mode & 0o777).toBe(0o664);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer in async and sync readers",
    async () => {
      const fifoPath = join(tempDir, "plan.fifo");
      execFileSync("mkfifo", [fifoPath]);

      const read = captureAsync(async () =>
        readBoundedPrivateFile(
          fifoPath,
          MAX_BYTES,
          SUBJECT,
          "allow-foreign-read",
          "read-compatible",
        ),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const blocked = new Promise<{ kind: "blocked" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "blocked" }), 1_000);
      });
      const outcome = await Promise.race([
        read.then((error) => ({ kind: "rejected" as const, error })),
        blocked,
      ]).finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });

      if (outcome.kind === "blocked") {
        const writer = await open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK);
        await writer.close();
        await read;
      }

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.error.code).toBe("SECURE_STORE_UNSAFE_PATH");
      }

      const pathsModuleUrl = new URL("./paths.ts", import.meta.url).href;
      const synchronousProbe = `
        import { readBoundedPrivateFileSync } from ${JSON.stringify(pathsModuleUrl)};
        try {
          readBoundedPrivateFileSync(process.env.SECURE_STORE_FIFO_PATH, ${MAX_BYTES}, ${JSON.stringify(SUBJECT)});
          throw new Error("Synchronous bounded reader accepted a FIFO");
        } catch (error) {
          if (error?.code !== "SECURE_STORE_UNSAFE_PATH") throw error;
        }
      `;
      execFileSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", synchronousProbe],
        {
          cwd: process.cwd(),
          env: { ...process.env, SECURE_STORE_FIFO_PATH: fifoPath },
          timeout: 2_000,
        },
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "returns undefined when the target vanishes after the descriptor read",
    async () => {
      writeFileSync(storePath, '{"ok":true}', { mode: 0o600 });
      const probeHandle = await open(storePath, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
        stat(this: FileHandle): Promise<Stats>;
      };
      const originalStat = fileHandlePrototype.stat;
      await probeHandle.close();
      let statCalls = 0;
      const statSpy = vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (
        this: FileHandle,
      ): Promise<Stats> {
        const stats = await originalStat.call(this);
        statCalls += 1;
        if (statCalls === 2) await rm(storePath);
        return stats;
      });

      try {
        await expect(
          readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT),
        ).resolves.toBeUndefined();
        expect(statCalls).toBe(2);
      } finally {
        statSpy.mockRestore();
      }
    },
  );
});

describe("acquireExclusiveLock staleness policy", () => {
  it("steals an aged foreign-host lock by default and never with maxAgeMs null", async () => {
    const nowEpochMs = Date.parse("2026-07-25T12:00:00.000Z");
    const aged: SecureStoreLockRecord = {
      host: "some-other-host",
      pid: 4_242,
      createdAt: new Date(nowEpochMs - 7_200_000).toISOString(),
      ownershipToken: randomUUID(),
    };
    writeLockRecord(lockPath, aged);

    const busy = await captureAsync(async () =>
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: nowEpochMs,
        now: () => nowEpochMs,
        isProcessAlive: () => true,
        maxAgeMs: null,
      }),
    );
    expect(busy.code).toBe("SECURE_STORE_LOCK_BUSY");
    expect(readRecord(lockPath).ownershipToken).toBe(aged.ownershipToken);

    const stolen = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: nowEpochMs,
      now: () => nowEpochMs,
      isProcessAlive: () => true,
    });
    expect(readRecord(lockPath).ownershipToken).toBe(stolen.ownershipToken);
    await stolen.release();
  });

  // Pre-#288 `lidarr/profile-preset-persistence.ts` wrote the binding under
  // `originDigest`. If that shape were unparseable, the corrupt classification
  // would fire before isStale() and — with maxAgeMs null leaving no second steal
  // rule — a lock stranded by the shipped build could never be reclaimed.
  it("steals a legacy record whose binding lives under originDigest", async () => {
    const legacy = {
      host: hostname(),
      pid: 424_242,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
      originDigest: "origin-a",
    } satisfies SecureStoreLockRecord & { readonly originDigest: string };
    writeFileSync(lockPath, JSON.stringify(legacy), { mode: 0o600 });

    const foreign = await captureAsync(async () =>
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        binding: "origin-b",
        isProcessAlive: () => false,
        maxAgeMs: null,
      }),
    );
    expect(foreign.code).toBe("SECURE_STORE_CORRUPT");
    expect(readRecord(lockPath).ownershipToken).toBe(legacy.ownershipToken);

    const stolen = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now(),
      binding: "origin-a",
      isProcessAlive: () => false,
      maxAgeMs: null,
    });
    expect(stolen.binding).toBe("origin-a");
    expect(readRecord(lockPath).ownershipToken).toBe(stolen.ownershipToken);
    expect(readRecord(lockPath).binding).toBe("origin-a");
    await stolen.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("SecureStoreLock.assertOwned", () => {
  it("proves full-record ownership, rejects a foreign binding, and latches after release", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
      binding: "origin-a",
    });
    expect(lock.binding).toBe("origin-a");
    await expect(lock.assertOwned()).resolves.toBeUndefined();

    // Same inode, same token: the binding axis alone must fail the assertion.
    const held = readRecord(lockPath);
    writeLockRecord(lockPath, { ...held, binding: "origin-b" });
    const foreignBinding = await captureAsync(async () => lock.assertOwned());
    expect(foreignBinding.code).toBe("SECURE_STORE_LOCK_BUSY");
    writeLockRecord(lockPath, held);
    await expect(lock.assertOwned()).resolves.toBeUndefined();

    // A new inode carrying the same token is a displacement, not our lock.
    // Staged as a sibling and renamed so the replacement inode is allocated
    // while the original is still linked: ext4 hands the freed inode number
    // straight back on a plain unlink-then-create, which would leave the
    // {dev,ino} axis unmoved and silently void this case.
    const displacedPath = join(tempDir, "displaced.lock");
    writeLockRecord(displacedPath, { ...held, pid: 99 });
    renameSync(displacedPath, lockPath);
    const displaced = await captureAsync(async () => lock.assertOwned());
    expect(displaced.code).toBe("SECURE_STORE_LOCK_BUSY");

    // release() must not unlink a lock it no longer owns, and is idempotent.
    await lock.release();
    await lock.release();
    expect(readRecord(lockPath).pid).toBe(99);
    const afterRelease = await captureAsync(async () => lock.assertOwned());
    expect(afterRelease.code).toBe("SECURE_STORE_LOCK_BUSY");

    // On acquisition, a record carrying another binding is unparseable.
    const otherPath = join(tempDir, "other.lock");
    writeLockRecord(otherPath, {
      host: hostname(),
      pid: 4_243,
      createdAt: new Date().toISOString(),
      ownershipToken: randomUUID(),
      binding: "origin-b",
    });
    const corrupt = await captureAsync(async () =>
      acquireExclusiveLock(otherPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        binding: "origin-a",
      }),
    );
    expect(corrupt.code).toBe("SECURE_STORE_CORRUPT");
  });

  it("rejects an ownership read that overlaps a subsequently started release", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const probeHandle = await open(lockPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      stat(this: FileHandle): Promise<Stats>;
    };
    const originalStat = fileHandlePrototype.stat;
    await probeHandle.close();
    let signalAssertionReadStarted: (() => void) | undefined;
    const assertionReadStarted = new Promise<void>((resolve) => {
      signalAssertionReadStarted = resolve;
    });
    let allowAssertionRead: (() => void) | undefined;
    const assertionReadMayComplete = new Promise<void>((resolve) => {
      allowAssertionRead = resolve;
    });
    let signalReleaseReadStarted: (() => void) | undefined;
    const releaseReadStarted = new Promise<void>((resolve) => {
      signalReleaseReadStarted = resolve;
    });
    let allowReleaseRead: (() => void) | undefined;
    const releaseReadMayComplete = new Promise<void>((resolve) => {
      allowReleaseRead = resolve;
    });
    let assertionHandle: FileHandle | undefined;
    let releaseHandle: FileHandle | undefined;
    const statSpy = vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ): Promise<Stats> {
      const stats = await originalStat.call(this);
      if (assertionHandle === undefined) {
        assertionHandle = this;
        signalAssertionReadStarted?.();
        await assertionReadMayComplete;
      } else if (this !== assertionHandle && releaseHandle === undefined) {
        releaseHandle = this;
        signalReleaseReadStarted?.();
        await releaseReadMayComplete;
      }
      return stats;
    });

    const assertion = captureAsync(async () => lock.assertOwned());
    let release: Promise<void> | undefined;
    try {
      await assertionReadStarted;
      release = lock.release();
      await releaseReadStarted;
      allowAssertionRead?.();

      const overlapping = await assertion;
      expect(overlapping.code).toBe("SECURE_STORE_LOCK_BUSY");

      allowReleaseRead?.();
      await expect(release).resolves.toBeUndefined();
    } finally {
      allowAssertionRead?.();
      allowReleaseRead?.();
      await assertion.catch(() => undefined);
      await release?.catch(() => undefined);
      statSpy.mockRestore();
    }
  });
});

describe("SecureStoreLock.release", () => {
  it("coalesces concurrent idempotent releases onto one cleanup", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });

    const firstRelease = lock.release();
    const concurrentRelease = lock.release();

    expect(concurrentRelease).toBe(firstRelease);
    await expect(firstRelease).resolves.toBeUndefined();
    expect(existsSync(lockPath)).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("SecureStoreLock.release ownership policy", () => {
  it("removes an owned same-inode lock whose mode widened to 0644", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const held = lstatSync(lockPath);
    chmodSync(lockPath, 0o644);
    expect(lstatSync(lockPath).ino).toBe(held.ino);

    await lock.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  it("preserves exact foreign record bytes on the held inode at 0644", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const held = lstatSync(lockPath);
    const foreignBytes = JSON.stringify({ ...readRecord(lockPath), pid: 99 });
    writeFileSync(lockPath, foreignBytes);
    chmodSync(lockPath, 0o644);
    expect(lstatSync(lockPath).ino).toBe(held.ino);

    await lock.release();

    expect(readFileSync(lockPath, "utf8")).toBe(foreignBytes);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o644);
  });

  it("preserves a replacement inode carrying the original record at 0644", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const originalBytes = readFileSync(lockPath, "utf8");
    const held = lstatSync(lockPath);
    const replacementPath = join(tempDir, "replacement.lock");
    writeFileSync(replacementPath, originalBytes, { mode: 0o644 });
    chmodSync(replacementPath, 0o644);
    renameSync(replacementPath, lockPath);
    const replacement = lstatSync(lockPath);
    expect(replacement.ino).not.toBe(held.ino);

    await lock.release();

    expect(readFileSync(lockPath, "utf8")).toBe(originalBytes);
    expect(lstatSync(lockPath).ino).toBe(replacement.ino);
    expect(lstatSync(lockPath).mode & 0o777).toBe(0o644);
  });

  it("retries release after an unsafe parent is repaired", async () => {
    const lock = await acquireExclusiveLock(lockPath, {
      subject: SUBJECT,
      deadlineEpochMs: Date.now() + 2_000,
    });
    const probeHandle = await open(lockPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      stat(this: FileHandle): Promise<Stats>;
    };
    const originalStat = fileHandlePrototype.stat;
    await probeHandle.close();
    let signalStatStarted: (() => void) | undefined;
    const statStarted = new Promise<void>((resolve) => {
      signalStatStarted = resolve;
    });
    let allowStatToComplete: (() => void) | undefined;
    const statMayComplete = new Promise<void>((resolve) => {
      allowStatToComplete = resolve;
    });
    let blocked = false;
    const statSpy = vi.spyOn(fileHandlePrototype, "stat").mockImplementation(async function (
      this: FileHandle,
    ): Promise<Stats> {
      const stats = await originalStat.call(this);
      if (!blocked) {
        blocked = true;
        signalStatStarted?.();
        await statMayComplete;
      }
      return stats;
    });

    const firstRelease = lock.release();
    const concurrentRelease = lock.release();
    expect(concurrentRelease).toBe(firstRelease);
    try {
      await statStarted;
      const releasing = await captureAsync(async () => lock.assertOwned());
      expect(releasing.code).toBe("SECURE_STORE_LOCK_BUSY");

      chmodSync(tempDir, 0o777);
      allowStatToComplete?.();
      const unsafe = await captureAsync(async () => firstRelease);
      expect(unsafe.code).toBe("SECURE_STORE_UNSAFE_PATH");
      expect(existsSync(lockPath)).toBe(true);

      chmodSync(tempDir, 0o700);
      await expect(lock.assertOwned()).resolves.toBeUndefined();
      const retry = lock.release();
      expect(retry).not.toBe(firstRelease);
      await retry;
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      allowStatToComplete?.();
      await firstRelease.catch(() => undefined);
      chmodSync(tempDir, 0o700);
      statSpy.mockRestore();
    }
  });
});

describe("syncDirectory", () => {
  it.skipIf(process.platform === "win32")(
    "fsyncs a real directory and refuses a regular-file path",
    async () => {
      await expect(syncDirectory(tempDir)).resolves.toBeUndefined();

      writeFileSync(storePath, "not a directory", { mode: 0o600 });
      const notADirectory = await captureAsync(async () => syncDirectory(storePath));
      expect(notADirectory.code).toBe("SECURE_STORE_UNSAFE_PATH");
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["create", "replaced"],
    ["replace", "replaced"],
    ["create", "removed"],
  ] as const)(
    "rejects a %s parent that is %s during identity-bound directory sync",
    async (operation, displacement) => {
      const parent = join(tempDir, `${operation}-${displacement}-parent`);
      const displacedParent = `${parent}-displaced`;
      const path = join(parent, "history.jsonl");
      mkdirSync(parent, { mode: 0o700 });
      let expectedIdentity: { dev: number; ino: number } | undefined;
      if (operation === "replace") {
        writeFileSync(path, "old\n", { mode: 0o600 });
        const existing = lstatSync(path);
        expectedIdentity = { dev: existing.dev, ino: existing.ino };
      }

      const probeHandle = await open(parent, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
        sync(this: FileHandle): Promise<void>;
      };
      const originalSync = fileHandlePrototype.sync;
      await probeHandle.close();
      let syncCalls = 0;
      const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (
        this: FileHandle,
      ): Promise<void> {
        syncCalls += 1;
        if (syncCalls === 2) {
          renameSync(parent, displacedParent);
          if (displacement === "replaced") {
            mkdirSync(parent, { mode: 0o700 });
          }
        }
        await originalSync.call(this);
      });

      try {
        const unsafe = await captureAsync(async () => {
          if (operation === "create") {
            await createPrivateFileAtomically({
              path,
              text: "new\n",
              subject: SUBJECT,
              temporaryId: operation,
            });
          } else {
            await replacePrivateFileAtomically({
              path,
              text: "new\n",
              subject: SUBJECT,
              temporaryId: operation,
              expectedIdentity: expectedIdentity!,
            });
          }
        });
        expect(unsafe.code).toBe("SECURE_STORE_UNSAFE_PATH");
        expect(syncCalls).toBe(2);
        expect(readdirSync(displacedParent).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );
});
