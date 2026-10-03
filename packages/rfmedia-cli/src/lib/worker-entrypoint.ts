import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface LocalWorkerEntrypoint {
  readonly path: string;
  readonly runtimeArgs: readonly string[];
}

/**
 * Resolve a private worker beside its caller in both supported layouts:
 * compiled JavaScript under dist and TypeScript executed through the documented
 * tsx development command.
 */
export function resolveLocalWorkerEntrypoint(
  callerUrl: string,
  workerBasename: string,
): LocalWorkerEntrypoint {
  if (!/^[a-z0-9-]+$/u.test(workerBasename)) {
    throw new Error("Worker basename must be a local kebab-case module name");
  }

  const javascriptPath = fileURLToPath(new URL(`./${workerBasename}.js`, callerUrl));
  if (existsSync(javascriptPath)) {
    return { path: javascriptPath, runtimeArgs: [] };
  }

  const typescriptPath = fileURLToPath(new URL(`./${workerBasename}.ts`, callerUrl));
  if (existsSync(typescriptPath)) {
    return { path: typescriptPath, runtimeArgs: ["--import", "tsx"] };
  }

  throw new Error(`Worker entrypoint is unavailable: ${workerBasename}`);
}
