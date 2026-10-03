import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type {
  ConflictMountProjection,
  ConflictValidationCheckKind,
  ConflictValidationFailureCode,
  PortAddressFamily,
  PortProtocol,
  RuntimeContainerProjection,
  RuntimeNetworkProjection,
  RuntimePortClaim,
  RuntimeVolumeProjection,
} from "../types/validation.js";
import type { DockerExecOptions, DockerExecResult } from "./docker.js";

export interface ConflictEvidenceAdapterDependencies {
  readonly defaultTimeoutMs: number;
  readonly execDocker: (args: string[], options?: DockerExecOptions) => Promise<DockerExecResult>;
  readonly execDockerCompose: (
    args: string[],
    options?: DockerExecOptions,
  ) => Promise<DockerExecResult>;
  readonly filterToolOutput: (lines: string[]) => string[];
  readonly safeComposePaths: (paths: readonly string[]) => Promise<string[]>;
  readonly safeEnvironmentFilePath: (path: string) => Promise<string>;
}

const COMPOSE_OBSERVATION_MAX_FIELD_BYTES = 1024;
const CONFLICT_EVIDENCE_LIST_MAX_OUTPUT_BYTES = 512 * 1024;
const CONFLICT_EVIDENCE_INSPECT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CONFLICT_EVIDENCE_TOTAL_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CONFLICT_COMPOSE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CONFLICT_EVIDENCE_MAX_STDERR_BYTES = 64 * 1024;
const CONFLICT_EVIDENCE_MAX_ITEMS = 4096;
const CONFLICT_EVIDENCE_INSPECT_BATCH_SIZE = 64;
const CONFLICT_EVIDENCE_MAX_FIELD_BYTES = 64 * 1024;
const CONFLICT_EVIDENCE_MAX_MAP_ENTRIES = 4096;
const CONFLICT_EVIDENCE_MAX_OPTIONS = 256;
const FULL_DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_DOCKER_RESOURCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_COMPOSE_MODEL_KEY = /^[a-zA-Z0-9._-]+$/;
const SAFE_COMPOSE_OPERAND = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function normalizeCaptureLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

function compareCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Long-form published-port entry returned by canonical Compose JSON. */
export interface CanonicalComposePortConfig {
  target: string;
  published?: string;
  host_ip?: string;
  protocol: PortProtocol;
  mode?: string;
}

/** Long-form service mount returned by canonical Compose JSON. */
export interface CanonicalComposeMountConfig {
  type: "bind" | "volume" | "tmpfs";
  source?: string;
  target: string;
  read_only: boolean;
}

/** Unsupported long-form mount retained for explicit backup-planning rejection. */
export interface CanonicalComposeUnsupportedMountConfig {
  type: string;
  source?: string;
  target: string;
  read_only: boolean;
}

/** Strict, allowlisted service projection used by pre-deploy validation. */
export interface CanonicalComposeServiceConfig {
  name: string;
  image?: string;
  depends_on: readonly string[];
  ports: readonly (string | CanonicalComposePortConfig)[];
  volumes: readonly (string | CanonicalComposeMountConfig)[];
  unsupported_volumes?: readonly CanonicalComposeUnsupportedMountConfig[];
  networks: readonly string[];
  network_mode?: string;
}

/** Effective top-level named-volume definition returned by Compose. */
export interface CanonicalComposeVolumeConfig {
  name: string;
  external: boolean;
  driver: string;
  driver_opts: Readonly<Record<string, string>>;
}

/** One explicit network IPAM entry. `ip_range` remains subordinate to `subnet`. */
export interface CanonicalComposeNetworkIpamConfig {
  subnet?: string;
  ip_range?: string;
}

/** Effective top-level network definition returned by Compose. */
export interface CanonicalComposeNetworkConfig {
  name: string;
  external: boolean;
  driver: string;
  ipam: {
    driver?: string;
    config: readonly CanonicalComposeNetworkIpamConfig[];
  };
}

/**
 * Strict canonical Compose projection for conflict validation.
 *
 * Unlike {@link ComposeConfig}, this type contains only fields needed for
 * effective scope and resource-conflict evaluation.
 */
export interface CanonicalComposeConfig {
  name: string;
  services: Readonly<Record<string, CanonicalComposeServiceConfig>>;
  volumes: Readonly<Record<string, CanonicalComposeVolumeConfig>>;
  networks: Readonly<Record<string, CanonicalComposeNetworkConfig>>;
}

/** Secret-free projection plus a one-way identity of the complete parsed Compose payload. */
export interface CanonicalComposeConfigEvidence {
  readonly config: CanonicalComposeConfig;
  readonly resolvedConfigFingerprint: string;
}

/** Sanitized failure from a strict conflict-validation evidence reader. */
export class DockerEvidenceError extends Error {
  override readonly name = "DockerEvidenceError";

  constructor(
    message: string,
    readonly code: ConflictValidationFailureCode,
    readonly check: ConflictValidationCheckKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ConflictEvidenceOptions extends DockerExecOptions {
  /** Absolute coordinator deadline shared by all conflict-evidence commands. */
  readonly deadline?: number;
  /** Explicit effective Compose project name for canonical model resolution. */
  readonly projectName?: string;
  /** Canonical plain Compose environment file used for interpolation. */
  readonly envFile?: string;
  /** Effective Compose profiles. Arguments are de-duplicated and sorted. */
  readonly profiles?: readonly string[];
}

type EvidenceCheck = "compose" | "containers" | "networks" | "volumes";

interface EvidenceStageBudget {
  readonly deadline: number;
}

interface ContainerInspectEvidencePayload {
  readonly Id?: unknown;
  readonly Name?: unknown;
  readonly Config?: unknown;
  readonly NetworkSettings?: unknown;
  readonly Mounts?: unknown;
}

interface NetworkInspectEvidencePayload {
  readonly Id?: unknown;
  readonly Name?: unknown;
  readonly Driver?: unknown;
  readonly IPAM?: unknown;
}

interface VolumeInspectEvidencePayload {
  readonly Name?: unknown;
  readonly Driver?: unknown;
  readonly Options?: unknown;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function evidenceError(
  check: EvidenceCheck,
  reason: "unavailable" | "invalid" | "incomplete" | "limit",
  options?: ErrorOptions,
): DockerEvidenceError {
  const checkName =
    check === "compose"
      ? "Compose configuration"
      : check === "containers"
        ? "Docker container evidence"
        : check === "networks"
          ? "Docker network evidence"
          : "Docker volume evidence";
  const code: ConflictValidationFailureCode =
    reason === "limit"
      ? "EVIDENCE_LIMIT_EXCEEDED"
      : reason === "incomplete"
        ? "EVIDENCE_INCOMPLETE"
        : reason === "invalid"
          ? check === "compose"
            ? "COMPOSE_CONFIG_INVALID"
            : "EVIDENCE_MALFORMED"
          : check === "compose"
            ? "COMPOSE_CONFIG_UNAVAILABLE"
            : check === "containers"
              ? "CONTAINER_SNAPSHOT_UNAVAILABLE"
              : check === "networks"
                ? "NETWORK_SNAPSHOT_UNAVAILABLE"
                : "VOLUME_SNAPSHOT_UNAVAILABLE";
  const suffix =
    reason === "limit"
      ? "exceeded safety limits"
      : reason === "incomplete"
        ? "was incomplete"
        : reason === "invalid"
          ? "was malformed"
          : "was unavailable";
  return new DockerEvidenceError(`${checkName} ${suffix}`, code, check, options);
}

function requireBoundedEvidenceString(
  value: unknown,
  check: EvidenceCheck,
  options: { allowEmpty?: boolean; maxBytes?: number } = {},
): string {
  const maxBytes = options.maxBytes ?? CONFLICT_EVIDENCE_MAX_FIELD_BYTES;
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maxBytes) {
    throw evidenceError(check, "limit");
  }
  if (
    typeof value !== "string" ||
    (options.allowEmpty !== true && value.length === 0) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw evidenceError(check, "invalid");
  }
  return value;
}

function requireSafeResourceName(value: unknown, check: EvidenceCheck): string {
  const name = requireBoundedEvidenceString(value, check, {
    maxBytes: COMPOSE_OBSERVATION_MAX_FIELD_BYTES,
  });
  if (!SAFE_DOCKER_RESOURCE_NAME.test(name)) throw evidenceError(check, "invalid");
  return name;
}

function requireSafeComposeModelKey(value: unknown, check: EvidenceCheck = "compose"): string {
  const name = requireBoundedEvidenceString(value, check, {
    maxBytes: COMPOSE_OBSERVATION_MAX_FIELD_BYTES,
  });
  if (!SAFE_COMPOSE_MODEL_KEY.test(name)) throw evidenceError(check, "invalid");
  return name;
}

function requireSafeComposeServiceOperand(
  value: unknown,
  check: EvidenceCheck = "compose",
): string {
  const name = requireBoundedEvidenceString(value, check, {
    maxBytes: COMPOSE_OBSERVATION_MAX_FIELD_BYTES,
  });
  if (!SAFE_COMPOSE_OPERAND.test(name)) throw evidenceError(check, "invalid");
  return name;
}

function createNullPrototypeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function requireRecordEntries(
  value: unknown,
  check: EvidenceCheck,
  options: { optional?: boolean; maxEntries?: number } = {},
): readonly [string, unknown][] {
  if ((value === undefined || value === null) && options.optional === true) return [];
  if (!isUnknownRecord(value)) throw evidenceError(check, "invalid");
  const entries = Object.entries(value);
  if (entries.length > (options.maxEntries ?? CONFLICT_EVIDENCE_MAX_MAP_ENTRIES)) {
    throw evidenceError(check, "limit");
  }
  return entries;
}

function requireBoundedArray(
  value: unknown,
  check: EvidenceCheck,
  options: { optional?: boolean; maxItems?: number } = {},
): readonly unknown[] {
  if ((value === undefined || value === null) && options.optional === true) return [];
  if (!Array.isArray(value)) throw evidenceError(check, "invalid");
  if (value.length > (options.maxItems ?? CONFLICT_EVIDENCE_MAX_ITEMS)) {
    throw evidenceError(check, "limit");
  }
  return value;
}

function normalizeStringOptions(
  value: unknown,
  check: EvidenceCheck,
): Readonly<Record<string, string>> {
  const entries = requireRecordEntries(value, check, {
    optional: true,
    maxEntries: CONFLICT_EVIDENCE_MAX_OPTIONS,
  });
  const normalized = createNullPrototypeRecord<string>();
  for (const [rawKey, rawValue] of [...entries].sort(([a], [b]) => compareCodePoint(a, b))) {
    const key = requireBoundedEvidenceString(rawKey, check, {
      maxBytes: COMPOSE_OBSERVATION_MAX_FIELD_BYTES,
    });
    normalized[key] = requireBoundedEvidenceString(rawValue, check, { allowEmpty: true });
  }
  return Object.freeze(normalized);
}

function normalizeCanonicalPort(value: unknown): string | CanonicalComposePortConfig {
  if (typeof value === "string") return requireBoundedEvidenceString(value, "compose");
  if (!isUnknownRecord(value)) throw evidenceError("compose", "invalid");
  const rawTarget = value["target"];
  const target =
    typeof rawTarget === "number" && Number.isSafeInteger(rawTarget)
      ? String(rawTarget)
      : requireBoundedEvidenceString(rawTarget, "compose");
  const rawPublished = value["published"];
  const published =
    rawPublished === undefined || rawPublished === null
      ? undefined
      : typeof rawPublished === "number" && Number.isSafeInteger(rawPublished)
        ? String(rawPublished)
        : requireBoundedEvidenceString(rawPublished, "compose");
  const rawProtocol = value["protocol"];
  const protocol = rawProtocol === undefined ? "tcp" : rawProtocol;
  if (protocol !== "tcp" && protocol !== "udp" && protocol !== "sctp") {
    throw evidenceError("compose", "invalid");
  }
  const rawHostIp = value["host_ip"];
  const hostIp =
    rawHostIp === undefined || rawHostIp === null
      ? undefined
      : requireBoundedEvidenceString(rawHostIp, "compose", { allowEmpty: true });
  const rawMode = value["mode"];
  const mode =
    rawMode === undefined || rawMode === null
      ? undefined
      : requireBoundedEvidenceString(rawMode, "compose");
  return Object.freeze({
    target,
    ...(published === undefined ? {} : { published }),
    ...(hostIp === undefined ? {} : { host_ip: hostIp }),
    protocol,
    ...(mode === undefined ? {} : { mode }),
  });
}

function normalizeCanonicalMount(
  value: unknown,
): string | CanonicalComposeMountConfig | CanonicalComposeUnsupportedMountConfig {
  if (typeof value === "string") return requireBoundedEvidenceString(value, "compose");
  if (!isUnknownRecord(value)) throw evidenceError("compose", "invalid");
  const type = requireBoundedEvidenceString(value["type"], "compose");
  const rawSource = value["source"];
  const source =
    rawSource === undefined || rawSource === null
      ? undefined
      : requireBoundedEvidenceString(rawSource, "compose");
  const target = requireBoundedEvidenceString(value["target"], "compose");
  const rawReadOnly = value["read_only"];
  if (rawReadOnly !== undefined && typeof rawReadOnly !== "boolean") {
    throw evidenceError("compose", "invalid");
  }
  return Object.freeze({
    type,
    ...(source === undefined ? {} : { source }),
    target,
    read_only: rawReadOnly === true,
  });
}

function normalizeComposeDependencies(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const dependencies = Array.isArray(value)
    ? value.map((item) => requireSafeComposeServiceOperand(item))
    : requireRecordEntries(value, "compose").map(([name]) =>
        requireSafeComposeServiceOperand(name),
      );
  if (new Set(dependencies).size !== dependencies.length) throw evidenceError("compose", "invalid");
  return Object.freeze(dependencies.sort(compareCodePoint));
}

function normalizeComposeNetworks(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const networks = Array.isArray(value)
    ? value.map((item) => requireSafeComposeModelKey(item))
    : requireRecordEntries(value, "compose").map(([name]) => requireSafeComposeModelKey(name));
  if (new Set(networks).size !== networks.length) throw evidenceError("compose", "invalid");
  return Object.freeze(networks.sort(compareCodePoint));
}

function normalizeCanonicalComposeConfig(value: unknown): CanonicalComposeConfig {
  if (!isUnknownRecord(value)) throw evidenceError("compose", "invalid");
  const projectName = requireSafeResourceName(value["name"], "compose");
  const serviceEntries = requireRecordEntries(value["services"], "compose");
  const services = createNullPrototypeRecord<CanonicalComposeServiceConfig>();
  for (const [rawName, rawService] of [...serviceEntries].sort(([a], [b]) =>
    compareCodePoint(a, b),
  )) {
    const name = requireSafeComposeServiceOperand(rawName);
    if (!isUnknownRecord(rawService)) throw evidenceError("compose", "invalid");
    const rawImage = rawService["image"];
    const image =
      rawImage === undefined || rawImage === null
        ? undefined
        : requireBoundedEvidenceString(rawImage, "compose");
    const ports = requireBoundedArray(rawService["ports"], "compose", { optional: true }).map(
      normalizeCanonicalPort,
    );
    const normalizedVolumes = requireBoundedArray(rawService["volumes"], "compose", {
      optional: true,
    }).map(normalizeCanonicalMount);
    const volumes = normalizedVolumes.filter(
      (mount): mount is string | CanonicalComposeMountConfig =>
        typeof mount === "string" ||
        mount.type === "bind" ||
        mount.type === "volume" ||
        mount.type === "tmpfs",
    );
    const unsupportedVolumes = normalizedVolumes.filter(
      (mount): mount is CanonicalComposeUnsupportedMountConfig =>
        typeof mount !== "string" &&
        mount.type !== "bind" &&
        mount.type !== "volume" &&
        mount.type !== "tmpfs",
    );
    const rawNetworkMode = rawService["network_mode"];
    const networkMode =
      rawNetworkMode === undefined || rawNetworkMode === null
        ? undefined
        : requireBoundedEvidenceString(rawNetworkMode, "compose");
    if (networkMode?.startsWith("service:") === true) {
      requireSafeComposeServiceOperand(networkMode.slice("service:".length));
    }
    services[name] = Object.freeze({
      name,
      ...(image === undefined ? {} : { image }),
      depends_on: normalizeComposeDependencies(rawService["depends_on"]),
      ports: Object.freeze(ports),
      volumes: Object.freeze(volumes),
      ...(unsupportedVolumes.length === 0
        ? {}
        : { unsupported_volumes: Object.freeze(unsupportedVolumes) }),
      networks: normalizeComposeNetworks(rawService["networks"]),
      ...(networkMode === undefined ? {} : { network_mode: networkMode }),
    });
  }

  const volumes = createNullPrototypeRecord<CanonicalComposeVolumeConfig>();
  for (const [rawKey, rawVolume] of [
    ...requireRecordEntries(value["volumes"], "compose", {
      optional: true,
    }),
  ].sort(([a], [b]) => compareCodePoint(a, b))) {
    const key = requireSafeComposeModelKey(rawKey);
    if (!isUnknownRecord(rawVolume)) throw evidenceError("compose", "invalid");
    const rawExternal = rawVolume["external"];
    if (rawExternal !== undefined && typeof rawExternal !== "boolean") {
      throw evidenceError("compose", "invalid");
    }
    const rawName = rawVolume["name"];
    const name =
      rawName === undefined ? `${projectName}_${key}` : requireSafeResourceName(rawName, "compose");
    const rawDriver = rawVolume["driver"];
    const driver =
      rawDriver === undefined || rawDriver === null
        ? "local"
        : requireBoundedEvidenceString(rawDriver, "compose");
    volumes[key] = Object.freeze({
      name,
      external: rawExternal === true,
      driver,
      driver_opts: normalizeStringOptions(rawVolume["driver_opts"], "compose"),
    });
  }

  const networks = createNullPrototypeRecord<CanonicalComposeNetworkConfig>();
  for (const [rawKey, rawNetwork] of [
    ...requireRecordEntries(value["networks"], "compose", {
      optional: true,
    }),
  ].sort(([a], [b]) => compareCodePoint(a, b))) {
    const key = requireSafeComposeModelKey(rawKey);
    if (!isUnknownRecord(rawNetwork)) throw evidenceError("compose", "invalid");
    const rawExternal = rawNetwork["external"];
    if (rawExternal !== undefined && typeof rawExternal !== "boolean") {
      throw evidenceError("compose", "invalid");
    }
    const rawName = rawNetwork["name"];
    const name =
      rawName === undefined ? `${projectName}_${key}` : requireSafeResourceName(rawName, "compose");
    const rawDriver = rawNetwork["driver"];
    const driver =
      rawDriver === undefined || rawDriver === null
        ? "bridge"
        : requireBoundedEvidenceString(rawDriver, "compose");
    const rawIpam = rawNetwork["ipam"];
    if (rawIpam !== undefined && rawIpam !== null && !isUnknownRecord(rawIpam)) {
      throw evidenceError("compose", "invalid");
    }
    const rawIpamDriver = isUnknownRecord(rawIpam) ? rawIpam["driver"] : undefined;
    const ipamDriver =
      rawIpamDriver === undefined || rawIpamDriver === null
        ? undefined
        : requireBoundedEvidenceString(rawIpamDriver, "compose");
    const ipamConfig = requireBoundedArray(
      isUnknownRecord(rawIpam) ? rawIpam["config"] : undefined,
      "compose",
      { optional: true },
    ).map((rawEntry): CanonicalComposeNetworkIpamConfig => {
      if (!isUnknownRecord(rawEntry)) throw evidenceError("compose", "invalid");
      const rawSubnet = rawEntry["subnet"];
      const subnet =
        rawSubnet === undefined || rawSubnet === null
          ? undefined
          : requireBoundedEvidenceString(rawSubnet, "compose");
      const rawIpRange = rawEntry["ip_range"];
      const ipRange =
        rawIpRange === undefined || rawIpRange === null
          ? undefined
          : requireBoundedEvidenceString(rawIpRange, "compose");
      return Object.freeze({
        ...(subnet === undefined ? {} : { subnet }),
        ...(ipRange === undefined ? {} : { ip_range: ipRange }),
      });
    });
    networks[key] = Object.freeze({
      name,
      external: rawExternal === true,
      driver,
      ipam: Object.freeze({
        ...(ipamDriver === undefined ? {} : { driver: ipamDriver }),
        config: Object.freeze(ipamConfig),
      }),
    });
  }

  return Object.freeze({
    name: projectName,
    services: Object.freeze(services),
    volumes: Object.freeze(volumes),
    networks: Object.freeze(networks),
  });
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (isUnknownRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoint(left, right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

function fingerprintParsedComposePayload(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest("hex");
}

function validateConflictEvidenceOptions(options: ConflictEvidenceOptions): readonly string[] {
  if (
    options.projectName !== undefined &&
    (typeof options.projectName !== "string" ||
      !SAFE_COMPOSE_OPERAND.test(options.projectName) ||
      Buffer.byteLength(options.projectName, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES)
  ) {
    throw evidenceError("compose", "invalid");
  }
  if (options.profiles !== undefined && !Array.isArray(options.profiles)) {
    throw evidenceError("compose", "invalid");
  }
  const profiles = [...new Set(options.profiles ?? [])].sort(compareCodePoint);
  for (const profile of profiles) {
    if (
      typeof profile !== "string" ||
      !SAFE_COMPOSE_OPERAND.test(profile) ||
      Buffer.byteLength(profile, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
    ) {
      throw evidenceError("compose", "invalid");
    }
  }
  return profiles;
}

/**
 * Resolve the effective Compose model, bind its complete parsed payload, and
 * discard secret-bearing fields before returning.
 */
export async function readCanonicalComposeConfigEvidence(
  dependencies: ConflictEvidenceAdapterDependencies,
  composePath: string,
  options: ConflictEvidenceOptions = {},
): Promise<CanonicalComposeConfigEvidence> {
  const budget = createEvidenceStageBudget(dependencies, options);
  const profiles = validateConflictEvidenceOptions(options);
  let canonicalComposePath: string;
  let canonicalEnvFile: string | undefined;
  try {
    const paths = await dependencies.safeComposePaths([composePath]);
    const resolvedPath = paths[0];
    if (resolvedPath === undefined) throw new Error("missing Compose path");
    canonicalComposePath = resolvedPath;
    canonicalEnvFile =
      options.envFile === undefined
        ? undefined
        : await dependencies.safeEnvironmentFilePath(options.envFile);
  } catch (error) {
    throw evidenceError("compose", "invalid", { cause: error });
  }
  const args = [
    ...(options.projectName === undefined ? [] : ["--project-name", options.projectName]),
    "-f",
    canonicalComposePath,
    ...(canonicalEnvFile === undefined ? [] : ["--env-file", canonicalEnvFile]),
    ...profiles.flatMap((profile) => ["--profile", profile]),
    "config",
    "--format",
    "json",
  ];
  const maxStdoutBytes = Math.min(
    normalizeCaptureLimit(options.maxStdoutBytes, CONFLICT_COMPOSE_MAX_OUTPUT_BYTES),
    CONFLICT_COMPOSE_MAX_OUTPUT_BYTES,
  );
  const result = await dependencies.execDockerCompose(args, {
    ...options,
    timeout: remainingEvidenceStageTime(budget, "compose"),
    maxRetries: 1,
    captureOutput: true,
    streamOutput: false,
    maxStdoutBytes,
    maxStderrBytes: Math.min(
      normalizeCaptureLimit(options.maxStderrBytes, CONFLICT_EVIDENCE_MAX_STDERR_BYTES),
      CONFLICT_EVIDENCE_MAX_STDERR_BYTES,
    ),
  });
  if (!result.success) {
    if (isEvidenceCaptureLimitFailure(result)) {
      throw evidenceError("compose", "limit");
    }
    throw evidenceError("compose", "unavailable");
  }
  remainingEvidenceStageTime(budget, "compose");

  let parsed: unknown;
  try {
    const filtered = dependencies.filterToolOutput(result.stdout.split("\n")).join("\n");
    parsed = JSON.parse(filtered) as unknown;
  } catch {
    throw evidenceError("compose", "invalid");
  }
  const resolvedConfigFingerprint = fingerprintParsedComposePayload(parsed);
  const config = normalizeCanonicalComposeConfig(parsed);
  return Object.freeze({ config, resolvedConfigFingerprint });
}

/** Resolve and strictly project the effective Compose model without retaining secrets. */
export async function readCanonicalComposeConfig(
  dependencies: ConflictEvidenceAdapterDependencies,
  composePath: string,
  options: ConflictEvidenceOptions = {},
): Promise<CanonicalComposeConfig> {
  return (await readCanonicalComposeConfigEvidence(dependencies, composePath, options)).config;
}

function normalizeInventory(
  dependencies: ConflictEvidenceAdapterDependencies,
  output: string,
  check: Exclude<EvidenceCheck, "compose">,
  pattern: RegExp,
): readonly string[] {
  const identities = dependencies.filterToolOutput(output.split("\n")).map((line) => line.trim());
  if (identities.length > CONFLICT_EVIDENCE_MAX_ITEMS) throw evidenceError(check, "limit");
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const identity of identities) {
    if (
      !pattern.test(identity) ||
      Buffer.byteLength(identity, "utf8") > COMPOSE_OBSERVATION_MAX_FIELD_BYTES
    ) {
      throw evidenceError(check, "invalid");
    }
    const key = check === "volumes" ? identity : identity.toLowerCase();
    if (seen.has(key)) throw evidenceError(check, "invalid");
    seen.add(key);
    normalized.push(key);
  }
  return Object.freeze(normalized.sort(compareCodePoint));
}

function evidenceCaptureLimit(options: DockerExecOptions, fallback: number): number {
  return Math.min(normalizeCaptureLimit(options.maxStdoutBytes, fallback), fallback);
}

function createEvidenceStageBudget(
  dependencies: ConflictEvidenceAdapterDependencies,
  options: ConflictEvidenceOptions,
): EvidenceStageBudget {
  const requested = options.timeout;
  const duration =
    requested === undefined || !Number.isSafeInteger(requested) || requested <= 0
      ? dependencies.defaultTimeoutMs
      : Math.min(requested, dependencies.defaultTimeoutMs);
  const localDeadline = Date.now() + duration;
  return {
    deadline:
      options.deadline === undefined ||
      !Number.isSafeInteger(options.deadline) ||
      options.deadline <= 0
        ? localDeadline
        : Math.min(options.deadline, localDeadline),
  };
}

function remainingEvidenceStageTime(budget: EvidenceStageBudget, check: EvidenceCheck): number {
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) {
    throw evidenceError(check, "limit");
  }
  return remaining;
}

function isEvidenceCaptureLimitFailure(result: DockerExecResult): boolean {
  return (
    result.stderr.startsWith("Command stdout exceeded capture limit") ||
    result.stderr.startsWith("Command stderr exceeded capture limit")
  );
}

async function runEvidenceCommand(
  dependencies: ConflictEvidenceAdapterDependencies,
  args: readonly string[],
  check: Exclude<EvidenceCheck, "compose">,
  options: DockerExecOptions,
  maxOutputBytes: number,
  budget: EvidenceStageBudget,
): Promise<string> {
  const result = await dependencies.execDocker([...args], {
    ...options,
    timeout: remainingEvidenceStageTime(budget, check),
    maxRetries: 1,
    captureOutput: true,
    streamOutput: false,
    maxStdoutBytes: evidenceCaptureLimit(options, maxOutputBytes),
    maxStderrBytes: Math.min(
      normalizeCaptureLimit(options.maxStderrBytes, CONFLICT_EVIDENCE_MAX_STDERR_BYTES),
      CONFLICT_EVIDENCE_MAX_STDERR_BYTES,
    ),
  });
  if (!result.success) {
    if (isEvidenceCaptureLimitFailure(result)) {
      throw evidenceError(check, "limit");
    }
    throw evidenceError(check, "unavailable");
  }
  return result.stdout;
}

async function inspectEvidenceBatches(
  dependencies: ConflictEvidenceAdapterDependencies,
  identities: readonly string[],
  commandPrefix: readonly string[],
  check: Exclude<EvidenceCheck, "compose">,
  options: DockerExecOptions,
  budget: EvidenceStageBudget,
): Promise<readonly unknown[]> {
  const inspected: unknown[] = [];
  let totalBytes = 0;
  for (let offset = 0; offset < identities.length; offset += CONFLICT_EVIDENCE_INSPECT_BATCH_SIZE) {
    const batch = identities.slice(offset, offset + CONFLICT_EVIDENCE_INSPECT_BATCH_SIZE);
    const output = await runEvidenceCommand(
      dependencies,
      [...commandPrefix, ...batch],
      check,
      options,
      CONFLICT_EVIDENCE_INSPECT_MAX_OUTPUT_BYTES,
      budget,
    );
    totalBytes += Buffer.byteLength(output, "utf8");
    if (totalBytes > CONFLICT_EVIDENCE_TOTAL_MAX_OUTPUT_BYTES) {
      throw evidenceError(check, "limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      throw evidenceError(check, "invalid");
    }
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw evidenceError(check, "incomplete");
    }
    inspected.push(...parsed);
  }
  return inspected;
}

function parsePortInterval(value: unknown, check: EvidenceCheck): { start: number; end: number } {
  const raw = requireBoundedEvidenceString(value, check);
  const match = /^([0-9]{1,5})(?:-([0-9]{1,5}))?$/.exec(raw);
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? start : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end > 65535 ||
    end < start
  ) {
    throw evidenceError(check, "invalid");
  }
  return { start, end };
}

function parseContainerPortKey(value: string): PortProtocol {
  const match = /^([0-9]{1,5})(?:-([0-9]{1,5}))?\/(tcp|udp|sctp)$/.exec(value);
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? start : Number(match[2]);
  const protocol = match?.[3];
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end > 65535 ||
    end < start ||
    (protocol !== "tcp" && protocol !== "udp" && protocol !== "sctp")
  ) {
    throw evidenceError("containers", "invalid");
  }
  return protocol;
}

function normalizeRuntimeHostIp(value: unknown): {
  family: PortAddressFamily;
  hostIp: string;
} {
  const raw = requireBoundedEvidenceString(value, "containers", { allowEmpty: true });
  const hostIp = raw === "" ? "0.0.0.0" : raw;
  const family = isIP(hostIp);
  if (family !== 4 && family !== 6) throw evidenceError("containers", "invalid");
  return { family: family === 4 ? "ipv4" : "ipv6", hostIp };
}

function normalizeRuntimePorts(
  value: unknown,
  containerId: string,
  containerName: string,
): readonly RuntimePortClaim[] {
  const ports: RuntimePortClaim[] = [];
  const identities = new Set<string>();
  for (const [containerPort, rawBindings] of [...requireRecordEntries(value, "containers")].sort(
    ([a], [b]) => compareCodePoint(a, b),
  )) {
    const protocol = parseContainerPortKey(containerPort);
    if (rawBindings === null) continue;
    for (const rawBinding of requireBoundedArray(rawBindings, "containers")) {
      if (!isUnknownRecord(rawBinding)) throw evidenceError("containers", "invalid");
      const { family, hostIp } = normalizeRuntimeHostIp(rawBinding["HostIp"]);
      const published = parsePortInterval(rawBinding["HostPort"], "containers");
      const identity = `${family}\0${hostIp}\0${protocol}\0${published.start}\0${published.end}`;
      if (identities.has(identity)) throw evidenceError("containers", "invalid");
      identities.add(identity);
      ports.push(
        Object.freeze({
          kind: "port",
          origin: "runtime",
          containerId,
          containerName,
          family,
          hostIp,
          protocol,
          published: Object.freeze(published),
        }),
      );
    }
  }
  return Object.freeze(
    ports.sort(
      (a, b) =>
        compareCodePoint(a.family, b.family) ||
        compareCodePoint(a.hostIp, b.hostIp) ||
        compareCodePoint(a.protocol, b.protocol) ||
        a.published.start - b.published.start ||
        a.published.end - b.published.end,
    ),
  );
}

function normalizeRuntimeMounts(value: unknown): readonly ConflictMountProjection[] {
  const mounts = requireBoundedArray(value, "containers").map(
    (rawMount): ConflictMountProjection => {
      if (!isUnknownRecord(rawMount)) throw evidenceError("containers", "invalid");
      const type = rawMount["Type"];
      if (type !== "bind" && type !== "volume" && type !== "tmpfs") {
        throw evidenceError("containers", "invalid");
      }
      const target = requireBoundedEvidenceString(rawMount["Destination"], "containers");
      const rawRw = rawMount["RW"];
      if (typeof rawRw !== "boolean") throw evidenceError("containers", "invalid");
      const rawSource =
        type === "volume" ? (rawMount["Name"] ?? rawMount["Source"]) : rawMount["Source"];
      const source =
        rawSource === undefined || rawSource === null || (type === "tmpfs" && rawSource === "")
          ? undefined
          : requireBoundedEvidenceString(rawSource, "containers");
      if ((type === "bind" || type === "volume") && source === undefined) {
        throw evidenceError("containers", "invalid");
      }
      return Object.freeze({
        type,
        ...(source === undefined ? {} : { source }),
        target,
        readOnly: !rawRw,
      });
    },
  );
  return Object.freeze(
    mounts.sort(
      (a, b) =>
        compareCodePoint(a.target, b.target) ||
        compareCodePoint(a.type, b.type) ||
        compareCodePoint(a.source ?? "", b.source ?? "") ||
        Number(a.readOnly) - Number(b.readOnly),
    ),
  );
}

function normalizeContainerEvidence(
  value: unknown,
  requested: ReadonlySet<string>,
): RuntimeContainerProjection {
  if (!isUnknownRecord(value)) throw evidenceError("containers", "invalid");
  const payload: ContainerInspectEvidencePayload = value;
  const id = requireBoundedEvidenceString(payload.Id, "containers").toLowerCase();
  if (!FULL_DOCKER_ID_PATTERN.test(id) || !requested.has(id)) {
    throw evidenceError("containers", "incomplete");
  }
  const rawName = requireBoundedEvidenceString(payload.Name, "containers");
  const name = rawName.startsWith("/") ? rawName.slice(1) : rawName;
  if (!SAFE_DOCKER_RESOURCE_NAME.test(name)) throw evidenceError("containers", "invalid");
  if (!isUnknownRecord(payload.Config)) throw evidenceError("containers", "invalid");
  const labelEntries = requireRecordEntries(payload.Config["Labels"], "containers", {
    optional: true,
  });
  const labels = new Map(labelEntries);
  const rawProject = labels.get("com.docker.compose.project");
  const rawService = labels.get("com.docker.compose.service");
  const project =
    rawProject === undefined ? undefined : requireSafeResourceName(rawProject, "containers");
  const service =
    rawService === undefined ? undefined : requireSafeComposeModelKey(rawService, "containers");
  if (!isUnknownRecord(payload.NetworkSettings)) throw evidenceError("containers", "invalid");
  return Object.freeze({
    id,
    name,
    ...(project === undefined ? {} : { project }),
    ...(service === undefined ? {} : { service }),
    ports: normalizeRuntimePorts(payload.NetworkSettings["Ports"], id, name),
    mounts: normalizeRuntimeMounts(payload.Mounts),
  });
}

function normalizeNetworkEvidence(
  value: unknown,
  requested: ReadonlySet<string>,
): RuntimeNetworkProjection {
  if (!isUnknownRecord(value)) throw evidenceError("networks", "invalid");
  const payload: NetworkInspectEvidencePayload = value;
  const id = requireBoundedEvidenceString(payload.Id, "networks").toLowerCase();
  if (!FULL_DOCKER_ID_PATTERN.test(id) || !requested.has(id)) {
    throw evidenceError("networks", "incomplete");
  }
  const name = requireSafeResourceName(payload.Name, "networks");
  const driver = requireBoundedEvidenceString(payload.Driver, "networks");
  if (!isUnknownRecord(payload.IPAM)) throw evidenceError("networks", "invalid");
  const subnets = requireBoundedArray(payload.IPAM["Config"], "networks", {
    optional: true,
  })
    .map((rawEntry) => {
      if (!isUnknownRecord(rawEntry)) throw evidenceError("networks", "invalid");
      const rawSubnet = rawEntry["Subnet"];
      return rawSubnet === undefined || rawSubnet === null
        ? undefined
        : requireBoundedEvidenceString(rawSubnet, "networks");
    })
    .filter((subnet): subnet is string => subnet !== undefined)
    .sort(compareCodePoint);
  if (new Set(subnets).size !== subnets.length) throw evidenceError("networks", "invalid");
  return Object.freeze({ id, name, driver, subnets: Object.freeze(subnets) });
}

function normalizeVolumeEvidence(
  value: unknown,
  requested: ReadonlySet<string>,
): RuntimeVolumeProjection {
  if (!isUnknownRecord(value)) throw evidenceError("volumes", "invalid");
  const payload: VolumeInspectEvidencePayload = value;
  const name = requireSafeResourceName(payload.Name, "volumes");
  if (!requested.has(name)) throw evidenceError("volumes", "incomplete");
  const driver = requireBoundedEvidenceString(payload.Driver, "volumes");
  return Object.freeze({
    name,
    driver,
    driverOptions: normalizeStringOptions(payload.Options, "volumes"),
  });
}

async function getStrictDockerEvidence<T>(
  dependencies: ConflictEvidenceAdapterDependencies,
  listArgs: readonly string[],
  inspectPrefix: readonly string[],
  check: Exclude<EvidenceCheck, "compose">,
  identityPattern: RegExp,
  normalize: (value: unknown, requested: ReadonlySet<string>) => T,
  identity: (value: T) => string,
  options: ConflictEvidenceOptions,
): Promise<readonly T[]> {
  const budget = createEvidenceStageBudget(dependencies, options);
  const inventoryOutput = await runEvidenceCommand(
    dependencies,
    listArgs,
    check,
    options,
    CONFLICT_EVIDENCE_LIST_MAX_OUTPUT_BYTES,
    budget,
  );
  const requested = normalizeInventory(dependencies, inventoryOutput, check, identityPattern);
  if (requested.length === 0) return Object.freeze([]);
  const requestedSet = new Set(requested);
  const rawItems = await inspectEvidenceBatches(
    dependencies,
    requested,
    inspectPrefix,
    check,
    options,
    budget,
  );
  const normalized: T[] = [];
  const observed = new Set<string>();
  for (const rawItem of rawItems) {
    const item = normalize(rawItem, requestedSet);
    const itemIdentity = identity(item);
    if (observed.has(itemIdentity)) throw evidenceError(check, "invalid");
    observed.add(itemIdentity);
    normalized.push(item);
  }
  if (
    observed.size !== requestedSet.size ||
    [...requestedSet].some((requestedIdentity) => !observed.has(requestedIdentity))
  ) {
    throw evidenceError(check, "incomplete");
  }
  remainingEvidenceStageTime(budget, check);
  return Object.freeze(normalized.sort((a, b) => compareCodePoint(identity(a), identity(b))));
}

/** List and inspect all running containers with strict, bounded projection. */
export function readConflictRuntimeContainers(
  dependencies: ConflictEvidenceAdapterDependencies,
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeContainerProjection[]> {
  return getStrictDockerEvidence(
    dependencies,
    ["ps", "--filter", "status=running", "--quiet", "--no-trunc"],
    ["inspect"],
    "containers",
    FULL_DOCKER_ID_PATTERN,
    normalizeContainerEvidence,
    (container) => container.id,
    options,
  );
}

/** List and inspect Docker networks with strict, bounded projection. */
export function readConflictRuntimeNetworks(
  dependencies: ConflictEvidenceAdapterDependencies,
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeNetworkProjection[]> {
  return getStrictDockerEvidence(
    dependencies,
    ["network", "ls", "--quiet", "--no-trunc"],
    ["network", "inspect"],
    "networks",
    FULL_DOCKER_ID_PATTERN,
    normalizeNetworkEvidence,
    (network) => network.id,
    options,
  );
}

/** List and inspect named Docker volumes with strict, bounded projection. */
export function readConflictRuntimeVolumes(
  dependencies: ConflictEvidenceAdapterDependencies,
  options: ConflictEvidenceOptions = {},
): Promise<readonly RuntimeVolumeProjection[]> {
  return getStrictDockerEvidence(
    dependencies,
    ["volume", "ls", "--quiet"],
    ["volume", "inspect"],
    "volumes",
    SAFE_DOCKER_RESOURCE_NAME,
    normalizeVolumeEvidence,
    (volume) => volume.name,
    options,
  );
}
