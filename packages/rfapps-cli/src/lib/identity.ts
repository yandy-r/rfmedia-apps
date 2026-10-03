/**
 * Canonical project and Docker authority identity helpers.
 *
 * Raw Docker endpoints, daemon identifiers, environment-source paths, and
 * resolved Compose values remain process-local. Callers receive only the
 * canonical Compose scope or a one-way authority fingerprint.
 */

import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, parse, resolve } from "node:path";

import type { EnvToolExecConfig } from "../types/options.js";
import {
  execDocker,
  getComposeConfig,
  type DockerExecOptions,
  type DockerExecResult,
} from "./docker.js";
import { execWithEnv } from "./env-tools.js";

export interface ComposeProjectIdentity {
  composePath: string;
  projectDir: string;
  projectName: string;
}

export interface ResolveComposeProjectIdentityOptions extends Pick<
  DockerExecOptions,
  "env" | "replaceEnv"
> {
  requireCanonicalInput?: boolean;
  /** Canonical plain Compose environment file used for interpolation. */
  envFile?: string;
  envTool?: EnvToolExecConfig;
}

type DockerCommandRunner = (
  args: string[],
  options?: DockerExecOptions,
) => Promise<DockerExecResult>;

type DockerHostProbe = (envTool?: EnvToolExecConfig) => Promise<string>;
const DOCKER_ENDPOINT_MAX_BYTES = 4096;
const SAFE_DOCKER_CONTEXT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;

/** Raised before starting an authority command once its shared deadline expires. */
export class DockerAuthorityDeadlineError extends Error {
  override readonly name = "DockerAuthorityDeadlineError";
}

interface DockerAuthorityFingerprintOptions extends Pick<
  DockerExecOptions,
  "timeout" | "maxRetries" | "retryDelay"
> {
  readonly deadline?: number;
}

function authorityExecution(
  execution: DockerExecOptions,
  options: DockerAuthorityFingerprintOptions,
): DockerExecOptions {
  const localTimeout =
    options.timeout === undefined || !Number.isSafeInteger(options.timeout) || options.timeout <= 0
      ? 300_000
      : options.timeout;
  const remaining =
    options.deadline === undefined
      ? localTimeout
      : Math.min(localTimeout, options.deadline - Date.now());
  if (remaining <= 0) {
    throw new DockerAuthorityDeadlineError("Docker authority evidence exceeded safety limits");
  }
  return {
    ...execution,
    timeout: remaining,
    maxRetries: options.maxRetries ?? 1,
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
  };
}

async function effectiveDockerHost(envTool?: EnvToolExecConfig): Promise<string> {
  const result = await execWithEnv(
    process.execPath,
    ["-e", "process.stdout.write(process.env.DOCKER_HOST ?? '')"],
    {
      tool: envTool?.tool ?? "none",
      ...(envTool?.envFile === undefined ? {} : { envFile: envTool.envFile }),
      timeout: 10_000,
    },
  );
  if (!result.success) throw new Error("Unable to identify the effective Docker host override");
  return result.stdout;
}

function classifyDockerEndpoint(endpoint: string): boolean {
  if (
    endpoint === "" ||
    Buffer.byteLength(endpoint, "utf8") > DOCKER_ENDPOINT_MAX_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(endpoint)
  ) {
    throw new Error("invalid Docker endpoint");
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/u.exec(endpoint);
  if (match === null) throw new Error("invalid Docker endpoint");
  const scheme = match[1];
  const authority = match[2]!;
  if (scheme === "unix") {
    if (!authority.startsWith("/") || /[?#]/u.test(authority)) {
      throw new Error("invalid Docker endpoint");
    }
    return true;
  }
  if (scheme === "npipe") {
    if (!/^\/\/\.\/pipe\/[^?#]+$/u.test(authority)) {
      throw new Error("invalid Docker endpoint");
    }
    return true;
  }
  if (scheme === "ssh" || scheme === "tcp" || scheme === "http" || scheme === "https") {
    const parsed = new URL(endpoint);
    if (parsed.hostname === "") throw new Error("invalid Docker endpoint");
    return false;
  }
  throw new Error("unsupported Docker endpoint");
}

function requireDockerContextName(result: DockerExecResult): string {
  const contextName = result.stdout.trim();
  if (
    !result.success ||
    !SAFE_DOCKER_CONTEXT_NAME.test(contextName) ||
    Buffer.byteLength(contextName, "utf8") > 255
  ) {
    throw new Error("invalid Docker context");
  }
  return contextName;
}

function requireDockerContextEndpoint(result: DockerExecResult): string {
  if (!result.success || Buffer.byteLength(result.stdout, "utf8") > DOCKER_ENDPOINT_MAX_BYTES) {
    throw new Error("invalid Docker context endpoint");
  }
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(result.stdout);
  } catch {
    throw new Error("invalid Docker context endpoint");
  }
  if (typeof endpoint !== "string") throw new Error("invalid Docker context endpoint");
  return endpoint;
}

/**
 * Determine whether the effective Docker authority is client-local.
 *
 * DOCKER_HOST takes precedence when present. Otherwise the active context
 * endpoint is inspected. Only validated unix and Windows named-pipe endpoints
 * are considered local; endpoint evidence never crosses this boolean boundary.
 */
export async function isLocalDockerAuthority(
  envTool?: EnvToolExecConfig,
  runDocker: DockerCommandRunner = execDocker,
  probeDockerHost: DockerHostProbe = effectiveDockerHost,
): Promise<boolean> {
  try {
    const dockerHost = await probeDockerHost(envTool);
    if (dockerHost !== "") return classifyDockerEndpoint(dockerHost);
    const execution = {
      captureOutput: true,
      streamOutput: false,
      maxStdoutBytes: DOCKER_ENDPOINT_MAX_BYTES,
      maxStderrBytes: DOCKER_ENDPOINT_MAX_BYTES,
      maxRetries: 1,
      envTool,
    } satisfies DockerExecOptions;
    const contextName = requireDockerContextName(await runDocker(["context", "show"], execution));
    const endpoint = requireDockerContextEndpoint(
      await runDocker(
        ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
        execution,
      ),
    );
    return classifyDockerEndpoint(endpoint);
  } catch {
    throw new Error("Unable to classify Docker authority locality");
  }
}

/** Classify locality using one already-captured effective execution environment. */
export async function isLocalDockerAuthorityFromEnvironment(
  environment: Record<string, string>,
  runDocker: DockerCommandRunner = execDocker,
): Promise<boolean> {
  try {
    const dockerHost = environment["DOCKER_HOST"] ?? "";
    if (dockerHost !== "") return classifyDockerEndpoint(dockerHost);
    const execution = {
      captureOutput: true,
      streamOutput: false,
      maxStdoutBytes: DOCKER_ENDPOINT_MAX_BYTES,
      maxStderrBytes: DOCKER_ENDPOINT_MAX_BYTES,
      maxRetries: 1,
      env: environment,
      replaceEnv: true,
    } satisfies DockerExecOptions;
    const contextName = requireDockerContextName(await runDocker(["context", "show"], execution));
    const endpoint = requireDockerContextEndpoint(
      await runDocker(
        ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
        execution,
      ),
    );
    return classifyDockerEndpoint(endpoint);
  } catch {
    throw new Error("Unable to classify Docker authority locality");
  }
}

function requireDockerIdentityPart(result: DockerExecResult, description: string): string {
  const value = result.stdout.trim();
  if (!result.success || value === "") {
    throw new Error(`Unable to identify the active Docker ${description}`);
  }
  return value;
}

async function fingerprintDockerAuthority(
  execution: DockerExecOptions,
  dockerHost: Promise<string>,
  runDocker: DockerCommandRunner,
  options: DockerAuthorityFingerprintOptions = {},
): Promise<string> {
  const contextName = requireDockerIdentityPart(
    await runDocker(["context", "show"], authorityExecution(execution, options)),
    "context",
  );
  const [contextEndpoint, daemonId, effectiveHost] = await Promise.all([
    runDocker(
      ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
      authorityExecution(execution, options),
    ).then((result) => requireDockerIdentityPart(result, "context endpoint")),
    runDocker(["info", "--format", "{{json .ID}}"], authorityExecution(execution, options)).then(
      (result) => requireDockerIdentityPart(result, "daemon identity"),
    ),
    dockerHost,
  ]);
  return createHash("sha256")
    .update(contextName)
    .update("\0")
    .update(contextEndpoint)
    .update("\0")
    .update(effectiveHost === "" ? "<unset>" : effectiveHost)
    .update("\0")
    .update(daemonId)
    .digest("hex");
}

/** Build a non-secret authority fingerprint in the same environment used for Docker mutation. */
export async function dockerAuthorityFingerprint(
  envTool?: EnvToolExecConfig,
  runDocker: DockerCommandRunner = execDocker,
  probeDockerHost: DockerHostProbe = effectiveDockerHost,
): Promise<string> {
  const execution = { captureOutput: true, streamOutput: false, envTool };
  return fingerprintDockerAuthority(execution, probeDockerHost(envTool), runDocker);
}

/** Revalidate Docker authority using only the environment captured under the lifecycle lock. */
export async function dockerAuthorityFingerprintFromEnvironment(
  environment: Record<string, string>,
  runDocker: DockerCommandRunner = execDocker,
  options: DockerAuthorityFingerprintOptions = {},
): Promise<string> {
  return fingerprintDockerAuthority(
    {
      captureOutput: true,
      streamOutput: false,
      env: environment,
      replaceEnv: true,
    },
    Promise.resolve(environment["DOCKER_HOST"] ?? ""),
    runDocker,
    options,
  );
}

function hasPathCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  const components: string[] = [];
  let cursor = path;
  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.push(root);

  for (const component of components.reverse()) {
    try {
      if ((await lstat(component)).isSymbolicLink()) {
        throw new Error(`Compose path contains a symbolic link: ${component}`);
      }
    } catch (error) {
      if (hasPathCode(error, "ENOENT")) {
        throw new Error(`Compose path does not exist: ${component}`);
      }
      throw error;
    }
  }
}

/** Resolve one regular, symlink-free plain Compose environment file. */
export async function resolveComposeEnvironmentFilePath(envFile: string): Promise<string> {
  if (envFile === "" || envFile.includes("\0")) {
    throw new Error("Environment file must be a non-empty filesystem path");
  }
  const absolutePath = resolve(envFile);
  await assertNoSymlinkComponents(absolutePath);
  const canonicalPath = await realpath(absolutePath);
  const envStat = await stat(canonicalPath);
  if (!envStat.isFile()) throw new Error("Environment file must resolve to a regular file");
  return canonicalPath;
}

/** Resolve the one canonical Compose file and directory used for review, locking, and apply. */
export async function resolveComposeProjectIdentity(
  composePath: string,
  options: ResolveComposeProjectIdentityOptions = {},
): Promise<ComposeProjectIdentity> {
  if (composePath === "" || composePath.includes("\0")) {
    throw new Error("Compose path must be a non-empty filesystem path");
  }
  if (
    options.requireCanonicalInput === true &&
    (!isAbsolute(composePath) || normalize(composePath) !== composePath)
  ) {
    throw new Error("Saved plan Compose path must be absolute and normalized");
  }

  const absolutePath = resolve(composePath);
  await assertNoSymlinkComponents(absolutePath);
  const canonicalPath = await realpath(absolutePath);
  const composeStat = await stat(canonicalPath);
  if (!composeStat.isFile()) throw new Error("Compose path must resolve to a regular file");
  const projectDir = dirname(canonicalPath);
  const composeConfig = await getComposeConfig(canonicalPath, {
    cwd: projectDir,
    envFile: options.envFile,
    envTool: options.envTool,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.replaceEnv === undefined ? {} : { replaceEnv: options.replaceEnv }),
  });
  const projectName = composeConfig?.name;
  if (projectName === undefined || !/^[a-z0-9][a-z0-9_-]*$/u.test(projectName)) {
    throw new Error("Effective Compose project name could not be resolved safely");
  }
  return {
    composePath: canonicalPath,
    projectDir,
    projectName,
  };
}
