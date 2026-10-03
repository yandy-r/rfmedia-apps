import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LIDARR_PRESET_JOURNAL_VERSION,
  type LidarrPresetApplyJournal,
  type LidarrPresetJournalResourceState,
  type LidarrPresetResourceDiff,
} from "../../types/lidarr-presets.js";
import {
  acquireLidarrPresetApplyLock,
  createLidarrPresetApplyJournal,
  LidarrPresetPersistenceError,
} from "./profile-preset-persistence.js";

const ORIGIN = "https://lidarr.example.test";
const OWNER_ONE = "11111111-1111-4111-8111-111111111111";
const OWNER_TWO = "22222222-2222-4222-8222-222222222222";
const JOURNAL_ID = "33333333-3333-4333-8333-333333333333";
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-preset-persistence-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makeResource(index = 1, text = "desired"): LidarrPresetResourceDiff {
  return {
    key: `custom-format:format-${index}`,
    resource: "custom-format",
    name: `Format ${index}`,
    dependencies: [],
    impact: { kind: "custom-format", referencingQualityProfiles: [] },
    fieldChanges: [{ path: "name", before: null, after: text }],
    action: "create",
    before: null,
    after: { name: text },
  };
}

function makeJournal(
  resources: readonly LidarrPresetJournalResourceState[] = [
    { state: "pending", resource: makeResource() },
  ],
  overrides: Partial<LidarrPresetApplyJournal> = {},
): LidarrPresetApplyJournal {
  return {
    schemaVersion: LIDARR_PRESET_JOURNAL_VERSION,
    id: JOURNAL_ID,
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    status: "in-progress",
    pack: {
      source: "builtin",
      ref: "builtin:balanced",
      id: "balanced",
      version: 1,
      digest: "a".repeat(64),
    },
    targetOrigin: ORIGIN,
    resources,
    ...overrides,
  };
}

function lockOptions(storageDirectory: string, ownershipToken = OWNER_ONE) {
  return {
    storageDirectory,
    hostname: () => "test-host",
    pid: ownershipToken === OWNER_ONE ? 41 : 42,
    now: () => new Date("2026-07-25T12:00:00.000Z"),
    randomUUID: () => ownershipToken,
    isProcessAlive: () => true,
  };
}

describe("Lidarr preset origin lock", () => {
  it.each([
    ["empty hostname", { hostname: () => "" }],
    ["zero PID", { pid: 0 }],
    ["invalid ownership token", { randomUUID: () => "not-a-uuid" }],
  ])("rejects %s", async (_case, overrides) => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const options = { ...lockOptions(storageDirectory), ...overrides };

    await expect(acquireLidarrPresetApplyLock(ORIGIN, options)).rejects.toMatchObject({
      code: "LIDARR_PRESET_LOCK_METADATA_INVALID",
    });
  });

  it("serializes different pack applies for one canonical origin", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const first = await acquireLidarrPresetApplyLock(
      ORIGIN,
      lockOptions(storageDirectory, OWNER_ONE),
    );

    await expect(
      acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory, OWNER_TWO)),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_ALREADY_RUNNING" });

    expect(first.originDigest).toBe(createHash("sha256").update(ORIGIN).digest("hex"));
    await first.release();
    await first.release();
  });

  it("permits different origins and creates private directories and files", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const first = await acquireLidarrPresetApplyLock(
      ORIGIN,
      lockOptions(storageDirectory, OWNER_ONE),
    );
    const second = await acquireLidarrPresetApplyLock(
      "https://other.example.test",
      lockOptions(storageDirectory, OWNER_TWO),
    );
    const journal = await createLidarrPresetApplyJournal(first, makeJournal());

    expect((await stat(join(storageDirectory, "locks"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(storageDirectory, "journals"))).mode & 0o777).toBe(0o700);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);

    await first.release();
    await second.release();
  });

  it("refuses a live owner and recovers only a same-host dead owner", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const first = await acquireLidarrPresetApplyLock(
      ORIGIN,
      lockOptions(storageDirectory, OWNER_ONE),
    );

    await expect(
      acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory, OWNER_TWO)),
    ).rejects.toBeInstanceOf(LidarrPresetPersistenceError);

    const recovered = await acquireLidarrPresetApplyLock(ORIGIN, {
      ...lockOptions(storageDirectory, OWNER_TWO),
      isProcessAlive: () => false,
    });
    await first.release();
    await expect(recovered.assertOwned()).resolves.toBeUndefined();
    await recovered.release();
  });

  it("never recovers a dead owner recorded on another host", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    await acquireLidarrPresetApplyLock(ORIGIN, {
      ...lockOptions(storageDirectory, OWNER_ONE),
      hostname: () => "other-host",
    });

    await expect(
      acquireLidarrPresetApplyLock(ORIGIN, {
        ...lockOptions(storageDirectory, OWNER_TWO),
        isProcessAlive: () => false,
      }),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_ALREADY_RUNNING" });
  });

  it("rejects symlinked storage and path-swapped lock ownership", async () => {
    const root = await makeTempRoot();
    const storageDirectory = join(root, "state");
    const realLocks = join(root, "real-locks");
    await mkdir(storageDirectory, { mode: 0o700 });
    await mkdir(realLocks, { mode: 0o700 });
    await symlink(realLocks, join(storageDirectory, "locks"));

    await expect(
      acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory)),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_UNSAFE_PATH" });

    await unlink(join(storageDirectory, "locks"));
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    const replacement = JSON.parse(await readFile(lock.path, "utf8")) as Record<string, unknown>;
    await unlink(lock.path);
    await writeFile(lock.path, JSON.stringify({ ...replacement, pid: 99 }), { mode: 0o600 });

    await expect(lock.assertOwned()).rejects.toMatchObject({ code: "LIDARR_PRESET_LOCK_LOST" });
    await lock.release();
    await expect(readFile(lock.path, "utf8")).resolves.toContain('"pid":99');
  });

  // The sole production caller invokes `release()` from inside a `finally`
  // (`actions/lidarr/profile-presets.ts:894-901`), and that inner block is
  // try/FINALLY, so a throw here discards the `applyResult(...)` already being
  // returned and reports a successful apply as a hard failure. The shared
  // release accepts ordinary foreign read bits while still proving the full
  // record and inode, so an owned 0644 lock is removed without throwing.
  it("releases without throwing when the lock file gained foreign access bits", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    await chmod(lock.path, 0o644);

    await expect(lock.release()).resolves.toBeUndefined();
    await expect(stat(lock.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Bounds the non-throwing release above. Without this, widening the guard until it
  // discards everything still ships green and every genuine release failure is
  // lost. A locks directory that gained foreign write bits fails the parent
  // safety walk on the PRE-read pass, so nothing is unlinked; pre-#288 this
  // threw too (`assertSafeDirectory`), and it must keep throwing.
  it("still surfaces a genuine release failure it must not swallow", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    await chmod(join(storageDirectory, "locks"), 0o777);

    await expect(lock.release()).rejects.toMatchObject({ code: "LIDARR_PRESET_UNSAFE_PATH" });
  });
});

describe("Lidarr preset apply journal", () => {
  it("atomically advances pre-dispatch state and finalizes terminal outcomes", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    const initial = makeJournal();
    const handle = await createLidarrPresetApplyJournal(lock, initial);
    const initialIdentity = await stat(handle.path);
    const dispatching = makeJournal(
      [
        {
          state: "dispatching",
          resource: initial.resources[0]!.resource,
          dispatchStartedAt: "2026-07-25T12:00:01.000Z",
        },
      ],
      { updatedAt: "2026-07-25T12:00:01.000Z" },
    );

    await handle.transition(dispatching);
    expect(JSON.parse(await readFile(handle.path, "utf8"))).toEqual(dispatching);
    expect((await stat(handle.path)).ino).not.toBe(initialIdentity.ino);

    const terminal = makeJournal(
      [
        {
          state: "terminal",
          resource: initial.resources[0]!.resource,
          outcome: {
            key: "custom-format:format-1",
            resource: "custom-format",
            name: "Format 1",
            outcome: "succeeded",
            attempted: true,
            dispatchState: "dispatched",
            verificationState: "verified",
          },
          recordedAt: "2026-07-25T12:00:02.000Z",
        },
      ],
      {
        updatedAt: "2026-07-25T12:00:02.000Z",
        status: "completed",
      },
    );
    await handle.finalize(terminal);
    expect(JSON.parse(await readFile(handle.path, "utf8"))).toEqual(terminal);
    await expect(handle.transition(dispatching)).rejects.toMatchObject({
      code: "LIDARR_PRESET_JOURNAL_INVALID",
    });
    await lock.release();
  });

  it("requires a durable dispatching transition before an attempted outcome", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    const initial = makeJournal();
    const handle = await createLidarrPresetApplyJournal(lock, initial);

    await expect(
      handle.finalize(
        makeJournal(
          [
            {
              state: "terminal",
              resource: initial.resources[0]!.resource,
              outcome: {
                key: "custom-format:format-1",
                resource: "custom-format",
                name: "Format 1",
                outcome: "succeeded",
                attempted: true,
                dispatchState: "dispatched",
                verificationState: "verified",
              },
              recordedAt: "2026-07-25T12:00:01.000Z",
            },
          ],
          { updatedAt: "2026-07-25T12:00:01.000Z", status: "completed" },
        ),
      ),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_JOURNAL_INVALID" });
    await lock.release();
  });

  it("rejects invalid, sensitive, and oversized journals before publication", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));

    await expect(
      createLidarrPresetApplyJournal(lock, {
        ...makeJournal(),
        targetOrigin: "https://other.example.test",
      }),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_JOURNAL_INVALID" });
    await expect(
      createLidarrPresetApplyJournal(lock, {
        ...makeJournal(),
        apiKey: "must-not-persist",
      } as LidarrPresetApplyJournal),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_JOURNAL_INVALID" });

    const oversized = Array.from({ length: 10 }, (_, index) => ({
      state: "pending" as const,
      resource: makeResource(index + 1, "x".repeat(60_000)),
    }));
    await expect(
      createLidarrPresetApplyJournal(lock, makeJournal(oversized)),
    ).rejects.toMatchObject({
      code: "LIDARR_PRESET_JOURNAL_TOO_LARGE",
    });
    await lock.release();
  });

  it("rejects journal path swaps and leaves no temporary files", async () => {
    const storageDirectory = join(await makeTempRoot(), "state");
    const lock = await acquireLidarrPresetApplyLock(ORIGIN, lockOptions(storageDirectory));
    const initial = makeJournal();
    const handle = await createLidarrPresetApplyJournal(lock, initial);
    const target = join(storageDirectory, "replacement.json");
    await writeFile(target, "replacement", { mode: 0o600 });
    await unlink(handle.path);
    await symlink(target, handle.path);

    await expect(
      handle.transition(
        makeJournal(
          [
            {
              state: "dispatching",
              resource: initial.resources[0]!.resource,
              dispatchStartedAt: "2026-07-25T12:00:01.000Z",
            },
          ],
          { updatedAt: "2026-07-25T12:00:01.000Z" },
        ),
      ),
    ).rejects.toMatchObject({ code: "LIDARR_PRESET_UNSAFE_PATH" });
    expect(await readFile(target, "utf8")).toBe("replacement");
    expect(
      (await readdir(join(storageDirectory, "journals"))).every((name) => !name.endsWith(".tmp")),
    ).toBe(true);
    await chmod(join(storageDirectory, "journals"), 0o700);
    await lock.release();
  });
});
