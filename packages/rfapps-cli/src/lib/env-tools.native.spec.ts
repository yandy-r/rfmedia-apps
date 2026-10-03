import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { captureEffectiveEnvironment, isStaticNativeElfExecutable } from "./env-tools.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("native effective environment capture", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
    );
  });

  it("captures NODE_OPTIONS as data without executing its import", async () => {
    const environment = await captureEffectiveEnvironment({
      tool: "none",
      env: {
        NODE_OPTIONS:
          "--import=data:text/javascript,process.env.RFAPPS_NODE_OPTIONS_PROBE=%22executed%22",
        RFAPPS_NODE_OPTIONS_PROBE: "not-executed",
      },
      replaceEnv: true,
    });

    expect(Object.keys(environment).sort()).toEqual(["NODE_OPTIONS", "RFAPPS_NODE_OPTIONS_PROBE"]);
    expect(environment["NODE_OPTIONS"]).toContain("--import=data:text/javascript");
    expect(environment["RFAPPS_NODE_OPTIONS_PROBE"]).toBe("not-executed");
  });

  it("rejects the dynamically linked system env executable", async () => {
    const systemEnv = await readFile("/usr/bin/env");
    expect(isStaticNativeElfExecutable(systemEnv)).toBe(false);
  });

  it("captures wrapper-injected loader controls without loading their code", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfapps-static-env-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "loader-probe.c");
    const libraryPath = join(directory, "loader-probe.so");
    const wrapperPath = join(directory, "op");

    await writeFile(
      sourcePath,
      [
        "#include <stdlib.h>",
        "__attribute__((constructor)) static void probe(void) {",
        '  setenv("RFAPPS_LOADER_PROBE", "executed", 1);',
        "}",
        "",
      ].join("\n"),
    );
    await execFileAsync("cc", ["-shared", "-fPIC", "-o", libraryPath, sourcePath]);
    await writeFile(
      wrapperPath,
      [
        "#!/bin/sh",
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        '[ "$#" -gt 0 ] || exit 64',
        "shift",
        `export LD_PRELOAD=${shellQuote(libraryPath)}`,
        `export LD_AUDIT=${shellQuote(libraryPath)}`,
        `export LD_LIBRARY_PATH=${shellQuote(directory)}`,
        'export RFAPPS_LOADER_PROBE="not-executed"',
        'exec "$@"',
        "",
      ].join("\n"),
    );
    await chmod(wrapperPath, 0o700);

    const environment = await captureEffectiveEnvironment({
      tool: "op",
      envFile: join(directory, "source.env"),
      env: { PATH: `${directory}:/usr/bin:/bin` },
      replaceEnv: true,
    });

    expect(environment["LD_PRELOAD"]).toBe(libraryPath);
    expect(environment["LD_AUDIT"]).toBe(libraryPath);
    expect(environment["LD_LIBRARY_PATH"]).toBe(directory);
    expect(environment["RFAPPS_LOADER_PROBE"]).toBe("not-executed");
  });
});
