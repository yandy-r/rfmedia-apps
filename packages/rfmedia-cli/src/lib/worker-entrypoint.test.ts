import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveLocalWorkerEntrypoint } from "./worker-entrypoint.js";

const temporaryDirectories: string[] = [];

async function makeCallerUrl(): Promise<{ directory: string; callerUrl: string }> {
  const directory = await mkdtemp(join(tmpdir(), "rfmedia-worker-entrypoint-"));
  temporaryDirectories.push(directory);
  const callerPath = join(directory, "caller.js");
  await writeFile(callerPath, "");
  return { directory, callerUrl: pathToFileURL(callerPath).href };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveLocalWorkerEntrypoint", () => {
  it("prefers compiled JavaScript without a development loader", async () => {
    const { directory, callerUrl } = await makeCallerUrl();
    const workerPath = join(directory, "metadata-worker.js");
    await writeFile(workerPath, "");
    await writeFile(join(directory, "metadata-worker.ts"), "");

    expect(resolveLocalWorkerEntrypoint(callerUrl, "metadata-worker")).toEqual({
      path: workerPath,
      runtimeArgs: [],
    });
  });

  it("uses the tsx loader for the documented source-mode layout", async () => {
    const { directory, callerUrl } = await makeCallerUrl();
    const workerPath = join(directory, "metadata-worker.ts");
    await writeFile(workerPath, "");

    expect(resolveLocalWorkerEntrypoint(callerUrl, "metadata-worker")).toEqual({
      path: workerPath,
      runtimeArgs: ["--import", "tsx"],
    });
  });

  it("fails closed for invalid or missing worker names", async () => {
    const { callerUrl } = await makeCallerUrl();

    expect(() => resolveLocalWorkerEntrypoint(callerUrl, "../worker")).toThrow(
      "Worker basename must be a local kebab-case module name",
    );
    expect(() => resolveLocalWorkerEntrypoint(callerUrl, "missing-worker")).toThrow(
      "Worker entrypoint is unavailable",
    );
  });
});
