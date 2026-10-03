import { appendFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateHash,
  compareFileBytes,
  FileChangedDuringReadError,
  verifyFileIntegrity,
  type IntegrityTestHooks,
} from "./integrity.js";

const loggerMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("./logger.js", () => loggerMocks);

describe("integrity", () => {
  let testDirectory: string;

  beforeEach(async () => {
    loggerMocks.logDebug.mockReset();
    testDirectory = await mkdtemp(join(tmpdir(), "rfmedia-integrity-"));
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  function testPath(name: string): string {
    return join(testDirectory, name);
  }

  describe("calculateHash", () => {
    it("calculates a SHA-256 hash from a real file", async () => {
      const filePath = testPath("track.flac");
      await writeFile(filePath, "hello");

      await expect(calculateHash(filePath)).resolves.toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    });

    it("hashes empty and multi-chunk files", async () => {
      const emptyPath = testPath("empty.flac");
      const largePath = testPath("large.flac");
      await writeFile(emptyPath, "");
      await writeFile(largePath, Buffer.alloc(196_731, 0xab));

      await expect(calculateHash(emptyPath)).resolves.toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      await expect(calculateHash(largePath)).resolves.toBe(
        "547b7fe6d874b5a6dd7768c4fbb0b3402a5626a9680f6c019c90a786a62921be",
      );
    });

    it("rejects a non-regular file", async () => {
      const directoryPath = testPath("album");
      await mkdir(directoryPath);

      await expect(calculateHash(directoryPath)).rejects.toThrow(/regular file/i);
    });

    it("rejects a symbolic-link artifact", async () => {
      const targetPath = testPath("target.flac");
      const linkPath = testPath("linked.flac");
      await writeFile(targetPath, "content outside the requested artifact");
      await symlink(targetPath, linkPath);

      await expect(calculateHash(linkPath)).rejects.toThrow(/symbolic link/i);
    });

    it("rejects an already-aborted operation", async () => {
      const filePath = testPath("track.flac");
      const controller = new AbortController();
      await writeFile(filePath, "content");
      controller.abort();

      await expect(calculateHash(filePath, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    });

    it("aborts between hash chunks and closes the handle", async () => {
      const filePath = testPath("large.flac");
      const controller = new AbortController();
      const closedRoles: string[] = [];
      await writeFile(filePath, Buffer.alloc(196_731, 0x23));
      let aborted = false;
      const hooks: IntegrityTestHooks = {
        afterRead: ({ operation }) => {
          if (operation === "hash" && !aborted) {
            aborted = true;
            controller.abort();
          }
        },
        afterClose: ({ role }) => {
          closedRoles.push(role);
        },
      };

      await expect(calculateHash(filePath, controller.signal, hooks)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(closedRoles).toEqual(["file"]);
    });

    it("detects deterministic mutation during hashing", async () => {
      const filePath = testPath("changing.flac");
      await writeFile(filePath, Buffer.alloc(131_089, 0x31));
      let mutated = false;
      const hooks: IntegrityTestHooks = {
        afterRead: async ({ operation }) => {
          if (operation === "hash" && !mutated) {
            mutated = true;
            await appendFile(filePath, "changed");
          }
        },
      };

      await expect(calculateHash(filePath, undefined, hooks)).rejects.toBeInstanceOf(
        FileChangedDuringReadError,
      );
    });
  });

  describe("compareFileBytes", () => {
    it("matches equal files with bounded fragmented reads", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      const content = Buffer.from("fragmented reads still compare exact bytes");
      await Promise.all([writeFile(sourcePath, content), writeFile(destinationPath, content)]);

      const result = await compareFileBytes(sourcePath, destinationPath, undefined, {
        maxReadBytes: 3,
      });

      expect(result).toEqual({
        status: "match",
        sameInode: false,
        bytesCompared: content.length,
      });
    });

    it("matches empty and multi-chunk files", async () => {
      const emptySource = testPath("empty-source.flac");
      const emptyDestination = testPath("empty-destination.flac");
      const largeSource = testPath("large-source.flac");
      const largeDestination = testPath("large-destination.flac");
      const largeContent = Buffer.alloc(196_731, 0x7f);
      await Promise.all([
        writeFile(emptySource, ""),
        writeFile(emptyDestination, ""),
        writeFile(largeSource, largeContent),
        writeFile(largeDestination, largeContent),
      ]);

      await expect(compareFileBytes(emptySource, emptyDestination)).resolves.toEqual({
        status: "match",
        sameInode: false,
        bytesCompared: 0,
      });
      await expect(compareFileBytes(largeSource, largeDestination)).resolves.toEqual({
        status: "match",
        sameInode: false,
        bytesCompared: largeContent.length,
      });
    });

    it("reports different bytes without returning their digests", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      await Promise.all([
        writeFile(sourcePath, "same-prefix-source"),
        writeFile(destinationPath, "same-prefix-target"),
      ]);

      const result = await compareFileBytes(sourcePath, destinationPath);

      expect(result).toEqual({
        status: "mismatch",
        sameInode: false,
        bytesCompared: 18,
      });
      expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
    });

    it("detects unequal EOF after an equal prefix", async () => {
      const sourcePath = testPath("short.flac");
      const destinationPath = testPath("long.flac");
      await Promise.all([
        writeFile(sourcePath, "equal-prefix"),
        writeFile(destinationPath, "equal-prefix-and-more"),
      ]);

      await expect(compareFileBytes(sourcePath, destinationPath)).resolves.toEqual({
        status: "mismatch",
        sameInode: false,
        bytesCompared: 12,
      });
    });

    it("reports same-inode hardlinks without redundant reads", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      await writeFile(sourcePath, "shared inode");
      await link(sourcePath, destinationPath);

      await expect(compareFileBytes(sourcePath, destinationPath)).resolves.toEqual({
        status: "match",
        sameInode: true,
        bytesCompared: 0,
      });
    });

    it("rejects non-regular files", async () => {
      const sourcePath = testPath("source.flac");
      const directoryPath = testPath("album");
      await writeFile(sourcePath, "content");
      await mkdir(directoryPath);

      await expect(compareFileBytes(sourcePath, directoryPath)).rejects.toThrow(/regular file/i);
    });

    it.each(["source", "destination"] as const)(
      "rejects a symbolic-link %s artifact",
      async (linkedRole) => {
        const sourceTarget = testPath("source-target.flac");
        const destinationTarget = testPath("destination-target.flac");
        const sourcePath = testPath("source.flac");
        const destinationPath = testPath("destination.flac");
        await Promise.all([
          writeFile(sourceTarget, "same content"),
          writeFile(destinationTarget, "same content"),
        ]);
        if (linkedRole === "source") {
          await symlink(sourceTarget, sourcePath);
          await link(destinationTarget, destinationPath);
        } else {
          await link(sourceTarget, sourcePath);
          await symlink(destinationTarget, destinationPath);
        }

        await expect(compareFileBytes(sourcePath, destinationPath)).rejects.toThrow(
          /symbolic link/i,
        );
      },
    );

    it("reports deterministic mutation as unstable", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      const content = Buffer.alloc(131_089, 0x42);
      await Promise.all([writeFile(sourcePath, content), writeFile(destinationPath, content)]);
      let mutated = false;
      const hooks: IntegrityTestHooks = {
        afterRead: async ({ operation, role }) => {
          if (operation === "compare" && role === "source" && !mutated) {
            mutated = true;
            await appendFile(sourcePath, "changed");
          }
        },
      };

      await expect(
        compareFileBytes(sourcePath, destinationPath, undefined, hooks),
      ).resolves.toEqual({
        status: "unstable",
        sameInode: false,
        bytesCompared: content.length,
      });
    });

    it("aborts between chunks and closes both handles", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      const content = Buffer.alloc(196_731, 0x55);
      const controller = new AbortController();
      const closedRoles: string[] = [];
      await Promise.all([writeFile(sourcePath, content), writeFile(destinationPath, content)]);
      let aborted = false;
      const hooks: IntegrityTestHooks = {
        afterRead: ({ operation }) => {
          if (operation === "compare" && !aborted) {
            aborted = true;
            controller.abort();
          }
        },
        afterClose: ({ role }) => {
          closedRoles.push(role);
        },
      };

      await expect(
        compareFileBytes(sourcePath, destinationPath, controller.signal, hooks),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(closedRoles.sort()).toEqual(["destination", "source"]);
    });
  });

  describe("verifyFileIntegrity", () => {
    it("returns true for equal files", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      await Promise.all([writeFile(sourcePath, "same"), writeFile(destinationPath, "same")]);

      await expect(verifyFileIntegrity(sourcePath, destinationPath)).resolves.toBe(true);
    });

    it.each(["source", "destination"] as const)(
      "rejects a symbolic-link %s artifact",
      async (linkedRole) => {
        const sourceTarget = testPath("source-target.flac");
        const destinationTarget = testPath("destination-target.flac");
        const sourcePath = testPath("source.flac");
        const destinationPath = testPath("destination.flac");
        await Promise.all([
          writeFile(sourceTarget, "same content"),
          writeFile(destinationTarget, "same content"),
        ]);
        if (linkedRole === "source") {
          await symlink(sourceTarget, sourcePath);
          await link(destinationTarget, destinationPath);
        } else {
          await link(sourceTarget, sourcePath);
          await symlink(destinationTarget, destinationPath);
        }

        await expect(verifyFileIntegrity(sourcePath, destinationPath)).rejects.toThrow(
          /symbolic link/i,
        );
      },
    );

    it("returns false without logging full digests for different files", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("destination.flac");
      await Promise.all([writeFile(sourcePath, "source"), writeFile(destinationPath, "target")]);

      await expect(verifyFileIntegrity(sourcePath, destinationPath)).resolves.toBe(false);

      const messages = loggerMocks.logDebug.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      expect(messages).not.toMatch(/[a-f0-9]{64}/);
      expect(messages).not.toContain("Source (");
      expect(messages).not.toContain("Dest   (");
    });

    it("propagates missing-file errors", async () => {
      const sourcePath = testPath("source.flac");
      const destinationPath = testPath("missing.flac");
      await writeFile(sourcePath, "source");

      await expect(verifyFileIntegrity(sourcePath, destinationPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
