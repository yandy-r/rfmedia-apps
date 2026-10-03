import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlinkFailure = vi.hoisted(() => ({ temporary: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: Parameters<typeof actual.unlink>[0]): Promise<void> => {
      if (unlinkFailure.temporary && String(path).endsWith(".tmp")) {
        unlinkFailure.temporary = false;
        throw Object.assign(new Error("forced staging unlink failure"), { code: "EIO" });
      }
      await actual.unlink(path);
    },
  };
});

import { acquireExclusiveLock } from "./lock.js";

const SUBJECT = "Atomic publication test";
let tempDir: string;
let lockPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "secure-store-publication-"));
  lockPath = join(tempDir, "store.lock");
});

afterEach(async () => {
  unlinkFailure.temporary = false;
  await rm(tempDir, { recursive: true, force: true });
});

describe("atomic create publication ordering", () => {
  it("cleans the published lock when staging unlink fails after link", async () => {
    unlinkFailure.temporary = true;

    await expect(
      acquireExclusiveLock(lockPath, {
        subject: SUBJECT,
        deadlineEpochMs: Date.now(),
        hostname: () => "publication-test-host",
        pid: 42_424,
        randomUUID: () => "11111111-1111-4111-8111-111111111111",
        temporaryUUID: () => "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toMatchObject({ code: "EIO" });

    expect(existsSync(lockPath)).toBe(false);
    expect(readdirSync(tempDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
