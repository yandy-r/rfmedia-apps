import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  execDocker,
  getComposeContainerObservations,
  stopServices,
  type ComposeContainerObservation,
  type ComposeContainerObservationOptions,
  type DockerComposeExecOptions,
  type DockerExecOptions,
  type DockerExecResult,
} from "./docker.js";
import { buildEnvCommand } from "./env-tools.js";
import { redactManagedMessage } from "./managed-redaction.js";
import {
  BACKUP_HELPER_IMAGE_REFERENCE,
  type BackupBindTopologyEntry,
  type BackupBindTopologyProbeResult,
  type BackupSource,
  type BackupSourceProbeResult,
  type BackupStage,
} from "../types/backup.js";

const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TOPOLOGY_EVIDENCE_BYTES = 256 * 1024;
const TOPOLOGY_TARGET_PREFIX = "/rfapps-bind-";
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const TERMINATION_GRACE_MS = 50;
const FINAL_SETTLEMENT_GRACE_MS = 50;

export type BackupDockerErrorCode =
  | "ARCHIVE_CANCELLED"
  | "ARCHIVE_DESTINATION_EXISTS"
  | "ARCHIVE_HELPER_FAILED"
  | "ARCHIVE_INACTIVITY_TIMEOUT"
  | "ARCHIVE_WRITE_FAILED"
  | "HELPER_IMAGE_PULL_FAILED"
  | "HELPER_IMAGE_RESOLUTION_FAILED"
  | "HELPER_CLEANUP_FAILED"
  | "INVALID_CONTAINER_ID"
  | "PROCESS_SETTLEMENT_FAILED"
  | "SOURCE_PROBE_FAILED"
  | "UNSAFE_DOCKER_OPERAND"
  | "WRITER_OBSERVATION_FAILED"
  | "WRITER_STOP_FAILED"
  | "WRITER_START_FAILED";

/** Sanitized operational failure from the native-backup Docker boundary. */
export class BackupDockerError extends Error {
  override readonly name = "BackupDockerError";

  constructor(
    message: string,
    readonly code: BackupDockerErrorCode,
    readonly stage: BackupStage,
    options?: ErrorOptions,
  ) {
    super(redactManagedMessage(message), options);
  }
}

export interface BackupArchiveProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly wait: Promise<{ readonly code: number; readonly signal: NodeJS.Signals | null }>;
  readonly terminated?: boolean;
  terminate(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface BackupArchiveSpawnOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly replaceEnv?: boolean;
  readonly envTool?: DockerExecOptions["envTool"];
}

export interface BackupDockerDependencies {
  readonly execDocker: (args: string[], options?: DockerExecOptions) => Promise<DockerExecResult>;
  readonly stopServices: (
    composePath: string,
    services?: string[],
    options?: DockerComposeExecOptions,
  ) => Promise<DockerExecResult>;
  readonly getComposeContainerObservations: (
    composePath: string,
    options?: ComposeContainerObservationOptions,
  ) => Promise<readonly ComposeContainerObservation[]>;
  readonly spawnArchive: (
    args: readonly string[],
    options: BackupArchiveSpawnOptions,
  ) => BackupArchiveProcess;
  readonly createArchiveSink: (handle: FileHandle) => Writable;
  readonly createId: () => string;
}

function spawnArchive(
  args: readonly string[],
  options: BackupArchiveSpawnOptions,
): BackupArchiveProcess {
  const wrapper =
    options.envTool === undefined
      ? { command: "", args: [] }
      : buildEnvCommand({
          tool: options.envTool.tool,
          envFile: options.envTool.envFile,
        });
  const command = wrapper.command === "" ? "docker" : wrapper.command;
  const commandArgs = wrapper.command === "" ? [...args] : [...wrapper.args, "docker", ...args];
  const environment =
    options.replaceEnv === true ? { ...options.env } : { ...process.env, ...options.env };
  const child = spawn(command, commandArgs, {
    cwd: options.cwd,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const wait = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    wait,
    terminate(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to terminating the direct child.
        }
      }
      child.kill(signal);
    },
  };
}

function createArchiveSink(handle: FileHandle): Writable {
  let position = 0;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      handle
        .write(buffer, 0, buffer.byteLength, position)
        .then(({ bytesWritten }) => {
          if (bytesWritten !== buffer.byteLength) {
            callback(new Error("Short backup artifact write"));
            return;
          }
          position += bytesWritten;
          callback();
        })
        .catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error("Backup artifact write failed"));
        });
    },
  });
}

const DEFAULT_DEPENDENCIES: BackupDockerDependencies = {
  execDocker,
  stopServices,
  getComposeContainerObservations,
  spawnArchive,
  createArchiveSink,
  createId: randomUUID,
};

export interface PrepareBackupHelperResult {
  readonly reference: typeof BACKUP_HELPER_IMAGE_REFERENCE;
  readonly resolvedImageId: string;
}

function commandOptions(options: DockerExecOptions): DockerExecOptions {
  return {
    ...options,
    captureOutput: true,
    streamOutput: false,
    maxStdoutBytes: 4096,
    maxStderrBytes: MAX_STDERR_BYTES,
    maxRetries: 1,
  };
}

async function inspectHelperImage(
  options: DockerExecOptions,
  dependencies: BackupDockerDependencies,
): Promise<string | undefined> {
  const result = await dependencies.execDocker(
    ["image", "inspect", "--format", "{{.Id}}", BACKUP_HELPER_IMAGE_REFERENCE],
    commandOptions(options),
  );
  if (!result.success) return undefined;
  const imageId = result.stdout.trim().toLowerCase();
  return IMAGE_ID_PATTERN.test(imageId) ? imageId : undefined;
}

/**
 * Inspect the pinned helper without pulling or otherwise mutating Docker.
 *
 * Missing and malformed local identities are both represented as absence so a
 * dry-run caller can report the prerequisite without preparing it.
 */
export async function inspectBackupHelper(
  options: DockerExecOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrepareBackupHelperResult | undefined> {
  const resolvedImageId = await inspectHelperImage(options, dependencies);
  return resolvedImageId === undefined
    ? undefined
    : Object.freeze({
        reference: BACKUP_HELPER_IMAGE_REFERENCE,
        resolvedImageId,
      });
}

/** Ensure the pinned helper is daemon-local and return its immutable image ID. */
export async function prepareBackupHelper(
  options: DockerExecOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<PrepareBackupHelperResult> {
  let helper = await inspectBackupHelper(options, dependencies);
  if (helper === undefined) {
    const pull = await dependencies.execDocker(
      ["image", "pull", BACKUP_HELPER_IMAGE_REFERENCE],
      commandOptions(options),
    );
    if (!pull.success) {
      throw new BackupDockerError(
        "Unable to pull the pinned backup helper image",
        "HELPER_IMAGE_PULL_FAILED",
        "prepare-helper",
      );
    }
    helper = await inspectBackupHelper(options, dependencies);
  }
  if (helper === undefined) {
    throw new BackupDockerError(
      "Docker did not resolve the pinned backup helper to an immutable image ID",
      "HELPER_IMAGE_RESOLUTION_FAILED",
      "prepare-helper",
    );
  }
  return helper;
}

function requireSafeName(value: string): string {
  if (
    !SAFE_DOCKER_NAME_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > 255 ||
    /[\u0000-\u001f\u007f,]/u.test(value)
  ) {
    throw new BackupDockerError(
      "Unsafe Docker resource operand",
      "UNSAFE_DOCKER_OPERAND",
      "validate",
    );
  }
  return value;
}

function requireImageId(value: string): string {
  const normalized = value.toLowerCase();
  if (!IMAGE_ID_PATTERN.test(normalized)) {
    throw new BackupDockerError(
      "Invalid immutable backup helper image ID",
      "UNSAFE_DOCKER_OPERAND",
      "validate",
    );
  }
  return normalized;
}

function mountOperand(source: BackupSource): string {
  if (source.kind === "volume") {
    return `type=volume,src=${requireSafeName(source.name)},dst=/source,readonly,volume-nocopy`;
  }
  if (
    !isAbsolute(source.path) ||
    posix.normalize(source.path) !== source.path ||
    /[\u0000-\u001f\u007f,]/u.test(source.path)
  ) {
    throw new BackupDockerError(
      "Unsafe bind mount source operand",
      "UNSAFE_DOCKER_OPERAND",
      "validate",
    );
  }
  return `type=bind,src=${source.path},dst=/source,readonly`;
}

function topologyMountOperand(sourcePath: string, target: string): string {
  if (
    !isAbsolute(sourcePath) ||
    posix.normalize(sourcePath) !== sourcePath ||
    /[\u0000-\u001f\u007f,]/u.test(sourcePath)
  ) {
    throw new BackupDockerError(
      "Unsafe bind mount source operand",
      "UNSAFE_DOCKER_OPERAND",
      "validate",
    );
  }
  return `type=bind,src=${sourcePath},dst=${target},readonly`;
}

/** Build the reviewed direct-argv helper invocation shared by probes and archives. */
export function buildBackupHelperArgs(
  source: BackupSource,
  resolvedImageId: string,
  helperName: string,
  helperCommand: readonly string[],
): string[] {
  requireSafeName(helperName);
  if (helperCommand.length === 0 || helperCommand.some((item) => item.includes("\0"))) {
    throw new BackupDockerError(
      "Unsafe backup helper command",
      "UNSAFE_DOCKER_OPERAND",
      "validate",
    );
  }
  return [
    "run",
    "--rm",
    "--name",
    helperName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--mount",
    mountOperand(source),
    "--pull",
    "never",
    requireImageId(resolvedImageId),
    ...helperCommand,
  ];
}

/** Build the hardened multi-mount helper invocation used for bind topology evidence. */
export function buildBackupTopologyProbeArgs(
  sourcePaths: readonly string[],
  resolvedImageId: string,
  helperName: string,
): string[] {
  requireSafeName(helperName);
  const args = [
    "run",
    "--rm",
    "--name",
    helperName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  sourcePaths.forEach((sourcePath, index) => {
    args.push(
      "--mount",
      topologyMountOperand(
        sourcePath,
        `${TOPOLOGY_TARGET_PREFIX}${String(index).padStart(4, "0")}`,
      ),
    );
  });
  args.push("--pull", "never", requireImageId(resolvedImageId), "cat", "/proc/self/mountinfo");
  return args;
}

function classifyBindSourceType(output: string): BackupSourceProbeResult {
  switch (output.trim().toLowerCase()) {
    case "directory":
      return Object.freeze({ status: "available" });
    case "regular file":
      return Object.freeze({ status: "not-directory", kind: "file" });
    case "socket":
      return Object.freeze({ status: "not-directory", kind: "socket" });
    case "block special file":
    case "character special file":
      return Object.freeze({ status: "not-directory", kind: "device" });
    default:
      return Object.freeze({ status: "not-directory", kind: "other" });
  }
}

function decodeMountInfoPath(value: string): string {
  if (!/^(?:[^\\]|\\(?:040|011|012|134))*$/u.test(value)) {
    throw new BackupDockerError(
      "Docker returned malformed bind topology evidence",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  return value.replace(/\\(040|011|012|134)/gu, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}

function requireCanonicalMountRoot(value: string): string {
  const decoded = decodeMountInfoPath(value);
  if (
    !decoded.startsWith("/") ||
    posix.normalize(decoded) !== decoded ||
    (decoded !== "/" && decoded.endsWith("/")) ||
    /[\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    throw new BackupDockerError(
      "Docker returned malformed bind topology evidence",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  return decoded;
}

function parseBindTopologyEvidence(
  output: string,
  sourcePaths: readonly string[],
): BackupBindTopologyProbeResult {
  if (Buffer.byteLength(output, "utf8") > MAX_TOPOLOGY_EVIDENCE_BYTES) {
    throw new BackupDockerError(
      "Docker returned oversized bind topology evidence",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  const expectedTargets = new Map(
    sourcePaths.map((sourcePath, index) => [
      `${TOPOLOGY_TARGET_PREFIX}${String(index).padStart(4, "0")}`,
      sourcePath,
    ]),
  );
  const byTarget = new Map<string, BackupBindTopologyEntry>();
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split(" ");
    if (fields.length < 10) continue;
    const mountPoint = fields[4] ?? "";
    const sourcePath = expectedTargets.get(mountPoint);
    if (sourcePath === undefined) continue;
    const separator = fields.indexOf("-", 6);
    const majorMinor = fields[2] ?? "";
    if (separator < 6 || !/^\d+:\d+$/u.test(majorMinor) || byTarget.has(mountPoint)) {
      throw new BackupDockerError(
        "Docker returned malformed bind topology evidence",
        "SOURCE_PROBE_FAILED",
        "validate",
      );
    }
    byTarget.set(
      mountPoint,
      Object.freeze({
        sourcePath,
        majorMinor,
        mountRoot: requireCanonicalMountRoot(fields[3] ?? ""),
      }),
    );
  }
  if (byTarget.size !== expectedTargets.size) {
    throw new BackupDockerError(
      "Docker returned incomplete bind topology evidence",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  const entries = [...byTarget.values()].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );
  const fingerprint = createHash("sha256")
    .update(
      entries
        .map((entry) => `${entry.sourcePath}\0${entry.majorMinor}\0${entry.mountRoot}\n`)
        .join(""),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({ entries: Object.freeze(entries), fingerprint });
}

/** Probe daemon-side bind mount identity for alias and containment decisions. */
export async function probeBackupBindTopology(
  sourcePaths: readonly string[],
  resolvedImageId: string,
  options: DockerExecOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<BackupBindTopologyProbeResult> {
  const uniquePaths = [...new Set(sourcePaths)].sort();
  if (uniquePaths.length !== sourcePaths.length) {
    throw new BackupDockerError(
      "Duplicate bind topology source path",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  if (uniquePaths.length === 0) {
    return Object.freeze({
      entries: Object.freeze([]),
      fingerprint: createHash("sha256").digest("hex"),
    });
  }

  const helperName = `rfapps-backup-topology-${dependencies.createId()}`;
  const args = buildBackupTopologyProbeArgs(uniquePaths, resolvedImageId, helperName);
  let probeResult: BackupBindTopologyProbeResult | undefined;
  let probeFailure: BackupDockerError | undefined;
  try {
    const result = await dependencies.execDocker(args, {
      ...commandOptions(options),
      maxStdoutBytes: MAX_TOPOLOGY_EVIDENCE_BYTES,
    });
    if (!result.success) {
      throw new BackupDockerError(
        "Unable to probe bind topology through Docker",
        "SOURCE_PROBE_FAILED",
        "validate",
      );
    }
    probeResult = parseBindTopologyEvidence(result.stdout, uniquePaths);
  } catch (error) {
    probeFailure =
      error instanceof BackupDockerError
        ? error
        : new BackupDockerError(
            "Unable to probe bind topology through Docker",
            "SOURCE_PROBE_FAILED",
            "validate",
            { cause: error },
          );
  }

  let cleanupFailure: BackupDockerError | undefined;
  try {
    await cleanupBackupHelper(helperName, options, dependencies);
  } catch (error) {
    cleanupFailure = archiveFailure(error);
  }
  if (probeFailure !== undefined && cleanupFailure !== undefined) {
    throw aggregateArchiveFailures(probeFailure, [cleanupFailure]);
  }
  if (probeFailure !== undefined) throw probeFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (probeResult === undefined) {
    throw new BackupDockerError(
      "Docker returned no bind topology probe result",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  return probeResult;
}

/** Probe a source from the selected Docker authority, never the client filesystem. */
export async function probeBackupSource(
  source: BackupSource,
  resolvedImageId: string,
  options: DockerExecOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<BackupSourceProbeResult> {
  if (source.kind === "volume") {
    requireSafeName(source.name);
    const result = await dependencies.execDocker(
      ["volume", "inspect", source.name],
      commandOptions(options),
    );
    if (result.success) return Object.freeze({ status: "available" });
    if (/no such volume/u.test(result.stderr.toLowerCase())) {
      return Object.freeze({ status: "missing" });
    }
    throw new BackupDockerError(
      "Unable to inspect a named volume through Docker",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }

  const helperName = `rfapps-backup-probe-${dependencies.createId()}`;
  const args = buildBackupHelperArgs(source, resolvedImageId, helperName, [
    "stat",
    "-c",
    "%F",
    "/source",
  ]);
  let probeResult: BackupSourceProbeResult | undefined;
  let probeFailure: BackupDockerError | undefined;
  try {
    const result = await dependencies.execDocker(args, commandOptions(options));
    if (result.success) {
      probeResult = classifyBindSourceType(result.stdout);
    } else if (/bind source path does not exist/u.test(result.stderr.toLowerCase())) {
      probeResult = Object.freeze({ status: "missing" });
    } else {
      throw new BackupDockerError(
        "Unable to probe a bind source through Docker",
        "SOURCE_PROBE_FAILED",
        "validate",
      );
    }
  } catch (error) {
    probeFailure =
      error instanceof BackupDockerError
        ? error
        : new BackupDockerError(
            "Unable to probe a bind source through Docker",
            "SOURCE_PROBE_FAILED",
            "validate",
            { cause: error },
          );
  }

  let cleanupFailure: BackupDockerError | undefined;
  try {
    await cleanupBackupHelper(helperName, options, dependencies);
  } catch (error) {
    cleanupFailure = archiveFailure(error);
  }
  if (probeFailure !== undefined && cleanupFailure !== undefined) {
    throw aggregateArchiveFailures(probeFailure, [cleanupFailure]);
  }
  if (probeFailure !== undefined) throw probeFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (probeResult === undefined) {
    throw new BackupDockerError(
      "Docker returned no bind source probe result",
      "SOURCE_PROBE_FAILED",
      "validate",
    );
  }
  return probeResult;
}

export interface ArchiveBackupSourceInput extends BackupArchiveSpawnOptions {
  readonly source: BackupSource;
  readonly resolvedImageId: string;
  readonly destinationPath: string;
  readonly inactivityTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly signal?: AbortSignal;
}

export interface ArchiveBackupSourceResult {
  readonly compressedBytes: number;
  readonly sha256: string;
}

class CompressedOutputMeter extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.byteLength;
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return milliseconds <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ArchiveAttemptSettlement {
  readonly operation: Promise<
    readonly [void, { readonly code: number; readonly signal: NodeJS.Signals | null }]
  >;
  readonly pipeline: Promise<void>;
  readonly process: Promise<{
    readonly code: number;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly isSettled: () => boolean;
}

function trackArchiveAttempt(
  pipelinePromise: Promise<void>,
  processPromise: BackupArchiveProcess["wait"],
): ArchiveAttemptSettlement {
  let pipelineSettled = false;
  let processSettled = false;
  const trackedPipeline = pipelinePromise.then(
    () => {
      pipelineSettled = true;
    },
    (error: unknown) => {
      pipelineSettled = true;
      throw error;
    },
  );
  const trackedProcess = processPromise.then(
    (result) => {
      processSettled = true;
      return result;
    },
    (error: unknown) => {
      processSettled = true;
      throw error;
    },
  );
  return {
    operation: Promise.all([trackedPipeline, trackedProcess]),
    pipeline: trackedPipeline,
    process: trackedProcess,
    isSettled: () => pipelineSettled && processSettled,
  };
}

async function settlesWithin(
  settlement: ArchiveAttemptSettlement,
  milliseconds: number,
): Promise<boolean> {
  if (settlement.isSettled()) return true;
  return Promise.race([
    Promise.allSettled([settlement.pipeline, settlement.process]).then(() => true),
    sleep(milliseconds).then(() => false),
  ]);
}

async function settleArchiveAttempt(
  process: BackupArchiveProcess,
  settlement: ArchiveAttemptSettlement,
): Promise<void> {
  if (settlement.isSettled()) return;
  process.terminate("SIGTERM");
  if (await settlesWithin(settlement, TERMINATION_GRACE_MS)) return;
  process.terminate("SIGKILL");
  if (await settlesWithin(settlement, FINAL_SETTLEMENT_GRACE_MS)) return;
  throw new BackupDockerError(
    "Backup helper did not settle after forced termination",
    "PROCESS_SETTLEMENT_FAILED",
    "cleanup",
  );
}

async function cleanupBackupHelper(
  helperName: string,
  options: DockerExecOptions,
  dependencies: BackupDockerDependencies,
): Promise<void> {
  const result = await dependencies.execDocker(
    ["container", "rm", "--force", helperName],
    commandOptions(options),
  );
  if (result.success || /no such container/u.test(result.stderr.toLowerCase())) return;
  throw new BackupDockerError(
    "Unable to confirm backup helper cleanup",
    "HELPER_CLEANUP_FAILED",
    "cleanup",
  );
}

function archiveFailure(error: unknown): BackupDockerError {
  return error instanceof BackupDockerError
    ? error
    : new BackupDockerError(
        "Unable to stream the backup archive",
        "ARCHIVE_WRITE_FAILED",
        "archive",
        { cause: error },
      );
}

function aggregateArchiveFailures(
  primary: BackupDockerError,
  additional: readonly BackupDockerError[],
): BackupDockerError {
  return new BackupDockerError(
    [primary.message, ...additional.map((failure) => failure.message)].join("; "),
    primary.code,
    primary.stage,
    { cause: new AggregateError([primary, ...additional]) },
  );
}

function containsTerminalCleanupFailure(failure: BackupDockerError): boolean {
  const cause = failure.cause;
  return (
    cause instanceof AggregateError &&
    cause.errors.some(
      (error: unknown) =>
        error instanceof BackupDockerError &&
        (error.code === "HELPER_CLEANUP_FAILED" || error.code === "PROCESS_SETTLEMENT_FAILED"),
    )
  );
}

async function archiveAttempt(
  input: ArchiveBackupSourceInput,
  attemptId: string,
  dependencies: BackupDockerDependencies,
): Promise<ArchiveBackupSourceResult> {
  const helperName = `rfapps-backup-${requireSafeName(attemptId)}`;
  const attemptPath = `${input.destinationPath}.${attemptId}.tmp`;
  const args = buildBackupHelperArgs(input.source, input.resolvedImageId, helperName, [
    "tar",
    "-C",
    "/source",
    "-cf",
    "-",
    ".",
  ]);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let process: BackupArchiveProcess | undefined;
  let settlement: ArchiveAttemptSettlement | undefined;
  let helperCleanupAttempted = false;
  let primaryFailure: BackupDockerError | undefined;
  let published = false;
  try {
    handle = await open(
      attemptPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    process = dependencies.spawnArchive(args, input);
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    process.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const retained = buffer.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderrChunks.push(retained);
      stderrBytes += retained.byteLength;
    });

    const meter = new CompressedOutputMeter();
    const gzip = createGzip();
    const output = dependencies.createArchiveSink(handle);
    let inactivityTimer: NodeJS.Timeout | undefined;
    let rejectInactivity: ((error: BackupDockerError) => void) | undefined;
    const inactivity = new Promise<never>((_resolve, reject) => {
      rejectInactivity = reject;
    });
    const resetInactivity = (): void => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => {
          rejectInactivity?.(
            new BackupDockerError(
              "Backup helper produced no archive data before the inactivity deadline",
              "ARCHIVE_INACTIVITY_TIMEOUT",
              "archive",
            ),
          );
        },
        normalizePositiveInteger(input.inactivityTimeoutMs, DEFAULT_INACTIVITY_TIMEOUT_MS),
      );
    };
    process.stdout.on("data", resetInactivity);
    resetInactivity();

    let rejectCancellation: ((error: BackupDockerError) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (): void => {
      rejectCancellation?.(
        new BackupDockerError("Backup cancelled", "ARCHIVE_CANCELLED", "cancelled"),
      );
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted === true) cancel();

    try {
      settlement = trackArchiveAttempt(pipeline(process.stdout, gzip, meter, output), process.wait);
      const [, exit] = await Promise.race([settlement.operation, inactivity, cancellation]);
      if (exit.code !== 0) {
        const stderr = redactManagedMessage(Buffer.concat(stderrChunks).toString("utf8"));
        throw new BackupDockerError(
          stderr === "" ? "Backup helper failed" : `Backup helper failed: ${stderr}`,
          "ARCHIVE_HELPER_FAILED",
          "archive",
        );
      }
    } catch (error) {
      throw archiveFailure(error);
    } finally {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      input.signal?.removeEventListener("abort", cancel);
    }

    await handle.sync();
    await handle.close();
    handle = undefined;
    await settleArchiveAttempt(process, settlement);
    helperCleanupAttempted = true;
    await cleanupBackupHelper(helperName, input, dependencies);
    try {
      await link(attemptPath, input.destinationPath);
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "EEXIST") {
        throw new BackupDockerError(
          "Backup artifact destination already exists",
          "ARCHIVE_DESTINATION_EXISTS",
          "archive",
          { cause: error },
        );
      }
      throw error;
    }
    await unlink(attemptPath);
    published = true;
    return Object.freeze({
      compressedBytes: meter.bytes,
      sha256: meter.hash.digest("hex"),
    });
  } catch (error) {
    primaryFailure = archiveFailure(error);
    throw primaryFailure;
  } finally {
    const additionalFailures: BackupDockerError[] = [];
    if (process !== undefined && settlement !== undefined) {
      await settleArchiveAttempt(process, settlement).catch((error: unknown) => {
        additionalFailures.push(archiveFailure(error));
      });
    }
    if (handle !== undefined) {
      await handle.close().catch((error: unknown) => {
        additionalFailures.push(
          new BackupDockerError(
            "Unable to close the backup artifact attempt",
            "ARCHIVE_WRITE_FAILED",
            "cleanup",
            { cause: error },
          ),
        );
      });
    }
    if (process !== undefined && !helperCleanupAttempted) {
      helperCleanupAttempted = true;
      await cleanupBackupHelper(helperName, input, dependencies).catch((error: unknown) => {
        additionalFailures.push(archiveFailure(error));
      });
    }
    if (!published) await unlink(attemptPath).catch(() => undefined);
    if (additionalFailures.length > 0) {
      throw primaryFailure === undefined
        ? additionalFailures[0]!
        : aggregateArchiveFailures(primaryFailure, additionalFailures);
    }
  }
}

/**
 * Stream a source into a fresh gzip/hash/file pipeline on every attempt.
 *
 * Publication uses a hard-link no-replace primitive, so an existing artifact
 * is never overwritten.
 */
export async function archiveBackupSource(
  input: ArchiveBackupSourceInput,
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<ArchiveBackupSourceResult> {
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  const retryDelayMs =
    input.retryDelayMs !== undefined &&
    Number.isSafeInteger(input.retryDelayMs) &&
    input.retryDelayMs >= 0
      ? input.retryDelayMs
      : DEFAULT_RETRY_DELAY_MS;
  let lastError: BackupDockerError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await archiveAttempt(input, dependencies.createId(), dependencies);
    } catch (error) {
      const failure =
        error instanceof BackupDockerError
          ? error
          : new BackupDockerError(
              "Unable to create the backup artifact",
              "ARCHIVE_WRITE_FAILED",
              "archive",
              { cause: error },
            );
      if (
        failure.code === "ARCHIVE_CANCELLED" ||
        failure.code === "ARCHIVE_DESTINATION_EXISTS" ||
        failure.code === "HELPER_CLEANUP_FAILED" ||
        failure.code === "PROCESS_SETTLEMENT_FAILED" ||
        failure.code === "UNSAFE_DOCKER_OPERAND" ||
        containsTerminalCleanupFailure(failure) ||
        attempt === maxAttempts
      ) {
        throw failure;
      }
      lastError = failure;
      await sleep(retryDelayMs);
    }
  }
  throw (
    lastError ??
    new BackupDockerError("Unable to create the backup artifact", "ARCHIVE_WRITE_FAILED", "archive")
  );
}

export interface BackupComposeAuthorityOptions extends DockerExecOptions {
  readonly projectName?: string;
  readonly envFile?: string;
  readonly profiles?: readonly string[];
}

/** Capture full IDs of currently active containers for the selected writers. */
export async function observeRunningBackupContainers(
  composePath: string,
  writerServices: readonly string[],
  options: BackupComposeAuthorityOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<readonly ComposeContainerObservation[]> {
  if (writerServices.length === 0) return Object.freeze([]);
  try {
    const observations = await dependencies.getComposeContainerObservations(composePath, options);
    const writerSet = new Set(writerServices);
    const active = observations
      .filter(
        (item) =>
          writerSet.has(item.serviceName) &&
          (item.state.toLowerCase() === "running" || item.state.toLowerCase() === "restarting"),
      )
      .sort((left, right) => left.containerId.localeCompare(right.containerId));
    if (active.some((item) => !CONTAINER_ID_PATTERN.test(item.containerId))) {
      throw new BackupDockerError(
        "Docker did not return an exact container ID for backup recovery",
        "WRITER_OBSERVATION_FAILED",
        "observe",
      );
    }
    return Object.freeze(active);
  } catch (error) {
    if (error instanceof BackupDockerError) throw error;
    throw new BackupDockerError(
      "Unable to observe backup writer containers",
      "WRITER_OBSERVATION_FAILED",
      "observe",
      { cause: error },
    );
  }
}

/** Stop only the planner-selected services using the pinned Compose authority. */
export async function stopBackupWriterServices(
  composePath: string,
  writerServices: readonly string[],
  options: BackupComposeAuthorityOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (writerServices.length === 0) return;
  const result = await dependencies.stopServices(composePath, [...writerServices], {
    ...options,
    profiles: options.profiles === undefined ? undefined : [...options.profiles],
  });
  if (!result.success) {
    throw new BackupDockerError(
      "Unable to stop backup writer services",
      "WRITER_STOP_FAILED",
      "stop",
    );
  }
}

/** Restart one exact captured container without reparsing or mutating Compose. */
export async function startBackupContainer(
  containerId: string,
  options: DockerExecOptions = {},
  dependencies: BackupDockerDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const normalized = containerId.toLowerCase();
  if (!CONTAINER_ID_PATTERN.test(normalized)) {
    throw new BackupDockerError("Invalid exact container ID", "INVALID_CONTAINER_ID", "recover");
  }
  const result = await dependencies.execDocker(
    ["container", "start", normalized],
    commandOptions(options),
  );
  if (!result.success) {
    throw new BackupDockerError(
      "Unable to restart an exact backup writer container",
      "WRITER_START_FAILED",
      "recover",
    );
  }
}
