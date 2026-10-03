import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shortReads = vi.hoisted(() => ({ asyncCalls: 0, chunkBytes: 0, syncCalls: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readSync = ((
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    shortReads.syncCalls += 1;
    return actual.readSync(
      descriptor,
      buffer,
      offset,
      Math.min(length, shortReads.chunkBytes),
      position,
    );
  }) as typeof actual.readSync;
  return { ...actual, readSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...arguments_: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...arguments_);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: async (buffer: Buffer, offset: number, length: number, position: number | null) => {
          shortReads.asyncCalls += 1;
          return read(buffer, offset, Math.min(length, shortReads.chunkBytes), position);
        },
      });
      return handle;
    },
  };
});

import { readBoundedPrivateFile, readBoundedPrivateFileSync } from "./paths.js";

const CONTENT = '{"short":"reads-are-legal"}';
const MAX_BYTES = 1024;
const SUBJECT = "Bounded short-read test";
let tempDir: string;
let storePath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "secure-store-short-read-"));
  storePath = join(tempDir, "store.json");
  writeFileSync(storePath, CONTENT, { mode: 0o600 });
  chmodSync(storePath, 0o600);
  shortReads.asyncCalls = 0;
  shortReads.chunkBytes = 3;
  shortReads.syncCalls = 0;
});

afterEach(async () => {
  shortReads.chunkBytes = 0;
  await rm(tempDir, { recursive: true, force: true });
});

describe("bounded short reads", () => {
  it("accumulates asynchronous reads until EOF", async () => {
    expect((await readBoundedPrivateFile(storePath, MAX_BYTES, SUBJECT))?.text).toBe(CONTENT);
    expect(shortReads.asyncCalls).toBeGreaterThan(1);
  });

  it("accumulates synchronous reads until EOF", () => {
    expect(readBoundedPrivateFileSync(storePath, MAX_BYTES, SUBJECT)?.text).toBe(CONTENT);
    expect(shortReads.syncCalls).toBeGreaterThan(1);
  });
});
