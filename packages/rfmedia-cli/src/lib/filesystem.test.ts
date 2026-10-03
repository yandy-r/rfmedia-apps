/**
 * Unit tests for filesystem utility functions.
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ReadStream, WriteStream } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transform } from "node:stream";

import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  copyOrLink,
  copyOrLinkWithHash,
  createOpenFileVerificationTarget,
  replaceFileWithValidatedStage,
  sanitizeForFilesystem,
} from "./filesystem.js";

const pipelineMock = vi.hoisted(() => vi.fn());
const lstatMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());
const renameMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: (...args: Parameters<typeof actual.lstat>) => lstatMock(actual.lstat, ...args),
    open: (...args: Parameters<typeof actual.open>) => openMock(actual.open, ...args),
    rename: (...args: Parameters<typeof actual.rename>) => renameMock(actual.rename, ...args),
  };
});

vi.mock("node:stream/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream/promises")>();
  return {
    ...actual,
    pipeline: (...args: unknown[]) => pipelineMock(actual.pipeline, ...args),
  };
});

beforeEach(() => {
  lstatMock.mockReset();
  lstatMock.mockImplementation((realLstat, ...args) => realLstat(...args));
  openMock.mockReset();
  openMock.mockImplementation((realOpen, ...args) => realOpen(...args));
  renameMock.mockReset();
  renameMock.mockImplementation((realRename, ...args) => realRename(...args));
  pipelineMock.mockReset();
  pipelineMock.mockImplementation((realPipeline, ...args) => realPipeline(...args));
});

async function closePipelineStreams(
  input: ReadStream,
  transform: Transform,
  output: WriteStream,
): Promise<void> {
  input.destroy();
  transform.destroy();
  output.destroy();
  if (!output.closed) {
    await once(output, "close");
  }
}

async function expectNoStagedArtifacts(directory: string): Promise<void> {
  const entries = await readdir(directory);
  expect(entries.filter((entry) => entry.includes(".rfmedia-stage-"))).toEqual([]);
}

describe("replaceFileWithValidatedStage", () => {
  it("atomically replaces an existing file after materialization and validation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-replace-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");

      await replaceFileWithValidatedStage(destination, {
        materialize: async (stagedPath, signal, stagedHandle) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(stagedPath).toMatch(/\.track\.flac\.rfmedia-stage-.*\.tmp$/);
          expect((await stat(stagedPath)).mode & 0o077).toBe(0);
          await stagedHandle.writeFile("replacement", "utf-8");
        },
        validate: async (stagedPath, signal) => {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
          await expect(readFile(stagedPath, "utf-8")).resolves.toBe("replacement");
        },
      });

      await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a validated destination when the destination is missing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-missing-test-"));
    try {
      const destination = join(tempDir, "track.flac");

      await replaceFileWithValidatedStage(destination, {
        materialize: async (stagedPath) => {
          await writeFile(stagedPath, "replacement", "utf-8");
        },
        validate: async (stagedPath) => {
          await expect(readFile(stagedPath, "utf-8")).resolves.toBe("replacement");
        },
      });

      await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the stage private through validation and applies a requested publication mode", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-mode-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const publicationEvents: string[] = [];
      const chmodEvents: string[] = [];
      let stagedInode: number | undefined;
      await writeFile(destination, "original", "utf-8");

      openMock.mockImplementation(async (realOpen, ...args) => {
        const handle = await realOpen(...args);
        if (args[1] !== "wx+") {
          return handle;
        }
        let publicationApplied = false;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "chmod") {
              return async (mode: number) => {
                await target.chmod(mode);
                chmodEvents.push(`chmod:${mode.toString(8)}`);
                if (mode === 0o640) {
                  publicationApplied = true;
                  publicationEvents.push(`chmod:${mode.toString(8)}`);
                }
              };
            }
            if (property === "sync") {
              return async () => {
                await target.sync();
                if (publicationApplied) publicationEvents.push("sync-complete");
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      renameMock.mockImplementationOnce(async (realRename, ...args) => {
        // The staging floor is applied to the handle before materialization; the
        // publication mode is applied last and followed by exactly one sync.
        expect(chmodEvents).toEqual(["chmod:600", "chmod:640"]);
        expect(publicationEvents).toEqual(["chmod:640", "sync-complete"]);
        return realRename(...args);
      });

      await replaceFileWithValidatedStage(destination, {
        publishMode: 0o7640,
        materialize: async (stagedPath) => {
          await writeFile(stagedPath, "replacement", "utf-8");
        },
        validate: async (stagedPath) => {
          const stagedStat = await stat(stagedPath);
          expect(stagedStat.mode & 0o777).toBe(0o600);
          stagedInode = stagedStat.ino;
        },
      });

      await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
      const destinationStat = await stat(destination);
      expect(destinationStat.mode & 0o7777).toBe(0o640);
      expect(destinationStat.ino).toBe(stagedInode);
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: "existing destination",
      existingMode: 0o640,
      missingDestinationMode: 0o604,
      expectedMode: 0o640,
    },
    {
      label: "missing destination",
      existingMode: undefined,
      missingDestinationMode: 0o604,
      expectedMode: 0o604,
    },
  ])(
    "captures identity and publication mode together for an $label",
    async ({ existingMode, missingDestinationMode, expectedMode }) => {
      const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-preserved-mode-test-"));
      try {
        const destination = join(tempDir, "track.flac");
        if (existingMode !== undefined) {
          await writeFile(destination, "original", "utf-8");
          await chmod(destination, existingMode);
        }

        await replaceFileWithValidatedStage(destination, {
          preserveDestinationMode: true,
          missingDestinationMode,
          materialize: async (_stagedPath, _signal, stagedHandle) => {
            await stagedHandle.writeFile("replacement", "utf-8");
          },
          validate: async (stagedPath) => {
            expect((await stat(stagedPath)).mode & 0o777).toBe(0o600);
          },
        });

        await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
        expect((await stat(destination)).mode & 0o777).toBe(expectedMode);
        await expectNoStagedArtifacts(tempDir);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("rejects a destination that aliases a forbidden identity at the stage boundary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-alias-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const destination = join(tempDir, "track.flac");
      await writeFile(source, "source", "utf-8");
      await link(source, destination);
      const sourceStat = await stat(source);
      const materialize = vi.fn();

      await expect(
        replaceFileWithValidatedStage(destination, {
          forbidDestinationIdentity: { dev: sourceStat.dev, ino: sourceStat.ino },
          materialize,
          validate: async () => {},
        }),
      ).rejects.toThrow(/aliases the protected source/i);

      expect(materialize).not.toHaveBeenCalled();
      await expect(readFile(source, "utf-8")).resolves.toBe("source");
      await expect(readFile(destination, "utf-8")).resolves.toBe("source");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a group- or world-writable destination parent before staging", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-shared-parent-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const materialize = vi.fn();
      await writeFile(destination, "original", "utf-8");
      await chmod(tempDir, 0o770);

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize,
          validate: async () => {},
        }),
      ).rejects.toThrow(/group- or world-writable/i);

      expect(materialize).not.toHaveBeenCalled();
      expect(renameMock).not.toHaveBeenCalled();
      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await chmod(tempDir, 0o700);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5])(
    "rejects invalid publication mode %s without publishing",
    async (publishMode) => {
      const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-invalid-mode-test-"));
      try {
        const destination = join(tempDir, "track.flac");
        await writeFile(destination, "original", "utf-8");

        await expect(
          replaceFileWithValidatedStage(destination, {
            publishMode,
            materialize: async (stagedPath) => {
              await writeFile(stagedPath, "replacement", "utf-8");
            },
            validate: async () => {},
          }),
        ).rejects.toThrow(/finite nonnegative integer/i);

        expect(renameMock).not.toHaveBeenCalled();
        await expect(readFile(destination, "utf-8")).resolves.toBe("original");
        await expectNoStagedArtifacts(tempDir);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("does not publish when cancelled after applying the requested mode", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-mode-abort-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const controller = new AbortController();
      const abortReason = Object.assign(new Error("cancelled after mode application"), {
        name: "AbortError",
      });
      await writeFile(destination, "original", "utf-8");

      lstatMock.mockImplementation(async (realLstat, path, ...args) => {
        const result = await realLstat(path, ...args);
        if (String(path).includes(".rfmedia-stage-") && (result.mode & 0o777) === 0o640) {
          controller.abort(abortReason);
        }
        return result;
      });

      await expect(
        replaceFileWithValidatedStage(destination, {
          signal: controller.signal,
          publishMode: 0o640,
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "replacement", "utf-8");
          },
          validate: async () => {},
        }),
      ).rejects.toBe(abortReason);

      expect(renameMock).not.toHaveBeenCalled();
      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not publish when the staged identity changes after mode application", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-mode-identity-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");

      lstatMock.mockImplementation(async (realLstat, path, ...args) => {
        const result = await realLstat(path, ...args);
        if (String(path).includes(".rfmedia-stage-") && (result.mode & 0o777) === 0o640) {
          return new Proxy(result, {
            get(target, property) {
              if (property === "ino") {
                return target.ino + 1;
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        }
        return result;
      });

      await expect(
        replaceFileWithValidatedStage(destination, {
          publishMode: 0o640,
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "replacement", "utf-8");
          },
          validate: async () => {},
        }),
      ).rejects.toThrow(/changed after mode application/i);

      expect(renameMock).not.toHaveBeenCalled();
      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a destination replaced while publication mode is syncing", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-mode-destination-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const concurrentDestination = join(tempDir, "concurrent.flac");
      await writeFile(destination, "original", "utf-8");
      await writeFile(concurrentDestination, "concurrent", "utf-8");

      openMock.mockImplementation(async (realOpen, ...args) => {
        const handle = await realOpen(...args);
        if (args[1] !== "wx+") {
          return handle;
        }
        let modeApplied = false;
        return new Proxy(handle, {
          get(target, property) {
            if (property === "chmod") {
              return async (mode: number) => {
                await target.chmod(mode);
                // Latch on the publication mode only. The staging floor chmod
                // runs first, and latching on it would move the swap to the
                // post-materialization sync — still rejected, but by a
                // different guard, silently losing this test's coverage.
                if (mode === 0o640) modeApplied = true;
              };
            }
            if (property === "sync") {
              return async () => {
                await target.sync();
                if (modeApplied) {
                  await unlink(destination);
                  await link(concurrentDestination, destination);
                }
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });

      await expect(
        replaceFileWithValidatedStage(destination, {
          publishMode: 0o640,
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "replacement", "utf-8");
          },
          validate: async () => {},
        }),
      ).rejects.toThrow(/destination changed before commit/i);

      expect(renameMock).not.toHaveBeenCalled();
      await expect(readFile(destination, "utf-8")).resolves.toBe("concurrent");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the original and removes the stage after materialization fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-materialize-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "partial", "utf-8");
            throw new Error("materialization failed");
          },
          validate: async () => {
            throw new Error("validation should not run");
          },
        }),
      ).rejects.toThrow("materialization failed");

      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the original and removes the stage after validation fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-validation-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "invalid", "utf-8");
          },
          validate: async () => {
            throw new Error("validation failed");
          },
        }),
      ).rejects.toThrow("validation failed");

      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the original and removes the stage when aborted before validation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-abort-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const controller = new AbortController();
      await writeFile(destination, "original", "utf-8");

      await expect(
        replaceFileWithValidatedStage(destination, {
          signal: controller.signal,
          materialize: async (stagedPath, signal) => {
            expect(signal).toBe(controller.signal);
            await writeFile(stagedPath, "replacement", "utf-8");
            controller.abort();
          },
          validate: async () => {
            throw new Error("validation should not run");
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the original and removes the stage after atomic commit fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-commit-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const commitError = Object.assign(new Error("commit failed"), { code: "EIO" });
      await writeFile(destination, "original", "utf-8");
      renameMock.mockRejectedValueOnce(commitError);

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "replacement", "utf-8");
          },
          validate: async () => {},
        }),
      ).rejects.toBe(commitError);

      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps materialization on the authoritative handle when the stage path becomes a symlink", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-symlink-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      const outside = join(tempDir, "outside.flac");
      await writeFile(destination, "original", "utf-8");
      await writeFile(outside, "outside", "utf-8");

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath, _signal, stagedHandle) => {
            await unlink(stagedPath);
            await symlink(outside, stagedPath);
            await stagedHandle.writeFile("replacement", "utf-8");
          },
          validate: async () => {},
        }),
      ).rejects.toThrow(/staged artifact/i);

      await expect(readFile(destination, "utf-8")).resolves.toBe("original");
      await expect(readFile(outside, "utf-8")).resolves.toBe("outside");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps validation bound to the open handle across a pathname swap-back", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-validation-swap-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");

      await replaceFileWithValidatedStage(destination, {
        materialize: async (_stagedPath, _signal, stagedHandle) => {
          await stagedHandle.writeFile("replacement", "utf-8");
        },
        validate: async (stagedPath, _signal, stagedHandle) => {
          const movedStage = `${stagedPath}.moved`;
          await rename(stagedPath, movedStage);
          await writeFile(stagedPath, "attacker-controlled", "utf-8");

          const target = createOpenFileVerificationTarget(stagedHandle);
          await expect(target.dependencies.calculateHash(target.path)).resolves.toBe(
            createHash("sha256").update("replacement").digest("hex"),
          );
          await expect(readFile(stagedPath, "utf-8")).resolves.toBe("attacker-controlled");

          await unlink(stagedPath);
          await rename(movedStage, stagedPath);
        },
      });

      await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects a changed destination parent before commit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-parent-test-"));
    try {
      const originalParent = join(tempDir, "original-parent");
      const replacementParent = join(tempDir, "replacement-parent");
      const linkedParent = join(tempDir, "destination");
      await mkdir(originalParent);
      await mkdir(replacementParent);
      await symlink(originalParent, linkedParent, "dir");

      const destination = join(linkedParent, "track.flac");
      const originalDestination = join(originalParent, "track.flac");
      await writeFile(originalDestination, "original", "utf-8");

      await expect(
        replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath) => {
            await writeFile(stagedPath, "replacement", "utf-8");
          },
          validate: async () => {
            await unlink(linkedParent);
            await symlink(replacementParent, linkedParent, "dir");
          },
        }),
      ).rejects.toThrow(/parent changed/i);

      await expect(readFile(originalDestination, "utf-8")).resolves.toBe("original");
      await expectNoStagedArtifacts(originalParent);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("holds and publishes the staging floor under a restrictive umask", async () => {
    // `open(2)` masks its mode argument with the process umask, so under 0277 the
    // stage would be created 0o400. On the no-publish-mode path — the shape
    // `verify --fix` uses — that mode is what `rename` publishes.
    // The fixture must be built BEFORE the umask change: `mkdtemp` under 0277
    // yields a 0o500 directory in which stage creation fails EACCES.
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-staged-umask-test-"));
    try {
      const destination = join(tempDir, "track.flac");
      await writeFile(destination, "original", "utf-8");
      await chmod(destination, 0o644);

      let materializeStageMode: number | undefined;
      let validateStageMode: number | undefined;

      const previousUmask = process.umask(0o277);
      try {
        await replaceFileWithValidatedStage(destination, {
          materialize: async (stagedPath, _signal, stagedHandle) => {
            // Record, never assert: an inline failure rejects the helper before
            // `rename`, so the published mode — the reported symptom — would
            // never be observed on a pre-fix run.
            materializeStageMode = (await stat(stagedPath)).mode & 0o777;
            await stagedHandle.writeFile("replacement", "utf-8");
          },
          validate: async (stagedPath) => {
            validateStageMode = (await stat(stagedPath)).mode & 0o777;
          },
        });
      } finally {
        // Mandatory: the describes that follow would otherwise `mkdtemp` a
        // 0o500 directory and cascade EACCES.
        process.umask(previousUmask);
      }

      await expect(readFile(destination, "utf-8")).resolves.toBe("replacement");
      expect((await stat(destination)).mode & 0o777).toBe(0o600);
      expect(materializeStageMode).toBe(0o600);
      expect(validateStageMode).toBe(0o600);
      await expectNoStagedArtifacts(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("copyOrLink with an authoritative destination handle", () => {
  it("copies bytes through the handle and preserves source timestamps", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-handle-copy-test-"));
    const source = join(tempDir, "source.flac");
    const destination = join(tempDir, "stage.tmp");
    const sourceTimestamp = new Date("2024-01-02T03:04:05.000Z");
    try {
      await writeFile(source, "source-audio", "utf-8");
      await utimes(source, sourceTimestamp, sourceTimestamp);
      await writeFile(destination, "old-stage-data", "utf-8");
      const handle = await open(destination, "r+");
      try {
        await expect(copyOrLink(source, handle, false)).resolves.toBe("copy");
        await expect(handle.stat()).resolves.toMatchObject({ size: 12 });
      } finally {
        await handle.close();
      }

      await expect(readFile(destination, "utf-8")).resolves.toBe("source-audio");
      expect(Math.trunc((await stat(destination)).mtimeMs)).toBe(sourceTimestamp.getTime());
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sanitizeForFilesystem", () => {
  describe("basic functionality", () => {
    it("should return unchanged valid names", () => {
      expect(sanitizeForFilesystem("Teen Pop")).toBe("Teen Pop");
      expect(sanitizeForFilesystem("Rock Music")).toBe("Rock Music");
      expect(sanitizeForFilesystem("Album 2024")).toBe("Album 2024");
    });

    it("should preserve emojis", () => {
      expect(sanitizeForFilesystem("❤️ Tracks")).toBe("❤️ Tracks");
      expect(sanitizeForFilesystem("Evanescence 🎧❤️")).toBe("Evanescence 🎧❤️");
      expect(sanitizeForFilesystem("Female Singers ❤️🎤")).toBe("Female Singers ❤️🎤");
      expect(sanitizeForFilesystem("Fresh ❤️")).toBe("Fresh ❤️");
      expect(sanitizeForFilesystem("Pop Divas 🎶")).toBe("Pop Divas 🎶");
      expect(sanitizeForFilesystem("Rock 🎸")).toBe("Rock 🎸");
    });

    it("should preserve Unicode characters", () => {
      expect(sanitizeForFilesystem("Música Latina")).toBe("Música Latina");
      expect(sanitizeForFilesystem("日本語")).toBe("日本語");
      expect(sanitizeForFilesystem("Café")).toBe("Café");
    });
  });

  describe("invalid character handling", () => {
    it("should replace forward slash with dash", () => {
      expect(sanitizeForFilesystem("Rock/Pop")).toBe("Rock-Pop");
      expect(sanitizeForFilesystem("80s/90s Hits")).toBe("80s-90s Hits");
    });

    it("should replace backslash with dash", () => {
      expect(sanitizeForFilesystem("Rock\\Pop")).toBe("Rock-Pop");
    });

    it("should replace colon with dash", () => {
      expect(sanitizeForFilesystem("Best: Collection")).toBe("Best- Collection");
      expect(sanitizeForFilesystem("File: Test")).toBe("File- Test");
    });

    it("should replace asterisk with dash", () => {
      expect(sanitizeForFilesystem("Star * Wars")).toBe("Star - Wars");
    });

    it("should replace question mark with dash", () => {
      expect(sanitizeForFilesystem("What?")).toBe("What");
    });

    it("should replace quotes with dash", () => {
      expect(sanitizeForFilesystem('"Quoted"')).toBe("Quoted");
    });

    it("should replace angle brackets with dash", () => {
      expect(sanitizeForFilesystem("<Title>")).toBe("Title");
    });

    it("should replace pipe with dash", () => {
      expect(sanitizeForFilesystem("Rock | Pop")).toBe("Rock - Pop");
    });

    it("should handle multiple invalid characters", () => {
      expect(sanitizeForFilesystem("path/to\\file:name")).toBe("path-to-file-name");
    });
  });

  describe("whitespace handling", () => {
    it("should collapse multiple spaces", () => {
      expect(sanitizeForFilesystem("Rock  Music")).toBe("Rock Music");
      expect(sanitizeForFilesystem("Too   Many    Spaces")).toBe("Too Many Spaces");
    });

    it("should trim leading and trailing whitespace", () => {
      expect(sanitizeForFilesystem("  Trimmed  ")).toBe("Trimmed");
      expect(sanitizeForFilesystem("  Leading")).toBe("Leading");
      expect(sanitizeForFilesystem("Trailing  ")).toBe("Trailing");
    });
  });

  describe("dash handling", () => {
    it("should collapse multiple consecutive dashes", () => {
      expect(sanitizeForFilesystem("Rock--Pop")).toBe("Rock-Pop");
      expect(sanitizeForFilesystem("Many---Dashes")).toBe("Many-Dashes");
    });

    it("should remove leading and trailing dashes", () => {
      expect(sanitizeForFilesystem("-Leading")).toBe("Leading");
      expect(sanitizeForFilesystem("Trailing-")).toBe("Trailing");
      expect(sanitizeForFilesystem("-Both-")).toBe("Both");
    });
  });

  describe("Windows reserved names", () => {
    it("should prefix CON with underscore", () => {
      expect(sanitizeForFilesystem("CON")).toBe("_CON");
      expect(sanitizeForFilesystem("con")).toBe("_con");
    });

    it("should prefix PRN with underscore", () => {
      expect(sanitizeForFilesystem("PRN")).toBe("_PRN");
      expect(sanitizeForFilesystem("prn")).toBe("_prn");
    });

    it("should prefix AUX with underscore", () => {
      expect(sanitizeForFilesystem("AUX")).toBe("_AUX");
    });

    it("should prefix NUL with underscore", () => {
      expect(sanitizeForFilesystem("NUL")).toBe("_NUL");
    });

    it("should prefix COM ports with underscore", () => {
      expect(sanitizeForFilesystem("COM1")).toBe("_COM1");
      expect(sanitizeForFilesystem("COM9")).toBe("_COM9");
    });

    it("should prefix LPT ports with underscore", () => {
      expect(sanitizeForFilesystem("LPT1")).toBe("_LPT1");
      expect(sanitizeForFilesystem("LPT9")).toBe("_LPT9");
    });

    it("should not modify names containing reserved words", () => {
      expect(sanitizeForFilesystem("CONTROL")).toBe("CONTROL");
      expect(sanitizeForFilesystem("CONTEXT")).toBe("CONTEXT");
      expect(sanitizeForFilesystem("MY CON")).toBe("MY CON");
    });
  });

  describe("error handling", () => {
    it("should throw error for empty string", () => {
      expect(() => sanitizeForFilesystem("")).toThrow("Name is required");
    });

    it("should throw error for null or undefined", () => {
      expect(() => sanitizeForFilesystem(null as unknown as string)).toThrow("Name is required");
      expect(() => sanitizeForFilesystem(undefined as unknown as string)).toThrow(
        "Name is required",
      );
    });

    it("should throw error for strings that sanitize to empty", () => {
      expect(() => sanitizeForFilesystem("   ")).toThrow("Cannot create valid folder name");
      expect(() => sanitizeForFilesystem("---")).toThrow("Cannot create valid folder name");
      expect(() => sanitizeForFilesystem("//")).toThrow("Cannot create valid folder name");
    });

    it("should throw error for dot-only names", () => {
      expect(() => sanitizeForFilesystem(".")).toThrow("Cannot create valid folder name");
      expect(() => sanitizeForFilesystem("..")).toThrow("Cannot create valid folder name");
    });
  });

  describe("real-world playlist names", () => {
    it("should handle actual Plex playlist names", () => {
      // From the user's examples
      expect(sanitizeForFilesystem("❤️ Tracks")).toBe("❤️ Tracks");
      expect(sanitizeForFilesystem("All Music")).toBe("All Music");
      expect(sanitizeForFilesystem("Britney Spears")).toBe("Britney Spears");
      expect(sanitizeForFilesystem("Evanescence 🎧❤️")).toBe("Evanescence 🎧❤️");
      expect(sanitizeForFilesystem("Female Singers ❤️🎤")).toBe("Female Singers ❤️🎤");
      expect(sanitizeForFilesystem("Fresh ❤️")).toBe("Fresh ❤️");
      expect(sanitizeForFilesystem("Mariah Carey")).toBe("Mariah Carey");
      expect(sanitizeForFilesystem("Pop Divas 🎶")).toBe("Pop Divas 🎶");
      expect(sanitizeForFilesystem("Recently Added")).toBe("Recently Added");
      expect(sanitizeForFilesystem("Recently Played")).toBe("Recently Played");
      expect(sanitizeForFilesystem("Rock 🎸")).toBe("Rock 🎸");
      expect(sanitizeForFilesystem("Teen Pop")).toBe("Teen Pop");
    });
  });
});

describe("copyOrLinkWithHash", () => {
  it("copies a file and returns its SHA-256 content hash", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-hash-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "dest.flac");
      const content = "test audio bytes";
      await writeFile(source, content, "utf-8");

      const result = await copyOrLinkWithHash(source, dest, false);

      expect(result.method).toBe("copy");
      expect(result.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
      expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.size).toBe(Buffer.byteLength(content));
      await expect(readFile(dest, "utf-8")).resolves.toBe(content);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a hardlink and returns its SHA-256 content hash", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-hardlink-hash-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "dest.flac");
      const content = "hardlinked audio bytes";
      await writeFile(source, content, "utf-8");

      const result = await copyOrLinkWithHash(source, dest, true);

      expect(result.method).toBe("hardlink");
      expect(result.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
      expect(await stat(dest)).toMatchObject({ ino: (await stat(source)).ino });
      await expect(readFile(dest, "utf-8")).resolves.toBe(content);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("propagates cancellation and removes a newly created partial destination", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-abort-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "dest.flac");
      const controller = new AbortController();
      const abortError = Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
        code: "ABORT_ERR",
      });
      await writeFile(source, "source bytes", "utf-8");

      pipelineMock.mockImplementationOnce(
        async (
          _realPipeline,
          input: ReadStream,
          transform: Transform,
          output: WriteStream,
          options: { signal?: AbortSignal },
        ) => {
          expect(options.signal).toBe(controller.signal);
          await closePipelineStreams(input, transform, output);
          await writeFile(String(output.path), "partial", "utf-8");
          controller.abort();
          throw abortError;
        },
      );

      await expect(
        copyOrLinkWithHash(source, dest, false, controller.signal),
      ).rejects.toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
        cause: abortError,
      });
      await expect(readFile(dest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes a newly created partial destination after exhausted retries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-failure-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "dest.flac");
      const writeError = Object.assign(new Error("simulated transient failure"), { code: "EBUSY" });
      await writeFile(source, "source bytes", "utf-8");

      pipelineMock.mockImplementation(
        async (_realPipeline, input: ReadStream, transform: Transform, output: WriteStream) => {
          await closePipelineStreams(input, transform, output);
          await writeFile(String(output.path), "partial", "utf-8");
          throw writeError;
        },
      );

      await expect(copyOrLinkWithHash(source, dest, false)).rejects.toMatchObject({
        code: "EBUSY",
        cause: writeError,
      });
      expect(pipelineMock).toHaveBeenCalledTimes(3);
      await expect(readFile(dest)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not recursively remove a destination that existed before copying", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-existing-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "existing-destination");
      await writeFile(source, "source bytes", "utf-8");
      await mkdir(dest);

      await expect(copyOrLinkWithHash(source, dest, false)).rejects.toBeInstanceOf(Error);
      expect((await stat(dest)).isDirectory()).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses fresh stream and hash state for every retry attempt", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "rfmedia-copy-retry-test-"));
    try {
      const source = join(tempDir, "source.flac");
      const dest = join(tempDir, "dest.flac");
      const content = "retry-safe audio bytes";
      const retryError = Object.assign(new Error("simulated transient failure"), { code: "EBUSY" });
      await writeFile(source, content, "utf-8");

      pipelineMock.mockImplementationOnce(async (realPipeline, ...args) => {
        await realPipeline(...args);
        throw retryError;
      });

      const result = await copyOrLinkWithHash(source, dest, false);

      expect(pipelineMock).toHaveBeenCalledTimes(2);
      expect(result.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
      await expect(readFile(dest, "utf-8")).resolves.toBe(content);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
