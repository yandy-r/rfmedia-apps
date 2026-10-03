/**
 * Plan generation and diff logic for rfapps CLI
 *
 * Compares current running state with desired compose configuration
 * to generate deployment plans showing what will change.
 */

import { createHash, randomUUID } from "node:crypto";
import { logDebug } from "@rfmedia/common";

import type {
  DeploymentPlan,
  ServiceChange,
  ChangeType,
  ConfigDiff,
  ImageDiff,
  EnvChange,
  PortMapping,
  VolumeMapping,
  PlanOptions,
  PlanSummary,
  ImageUpdateCheck,
} from "../types/plan.js";

import type { ChangeDimension } from "../types/plan-intelligence.js";

import type { ContainerInspect } from "./docker.js";
import {
  getComposeConfig,
  inspectContainers,
  getRunningServiceContainerMap,
  checkImageUpdate,
} from "./docker.js";
import { buildPlanIntelligence } from "./plan-intelligence.js";
import type { EnvToolExecConfig } from "../types/index.js";

interface LegacyImageUpdateCheck {
  hasUpdate: boolean;
  localDigest?: string;
  remoteDigest?: string;
  error?: string;
}

interface RegistryFailure {
  status: "unsupported" | "local-missing" | "unknown";
  errorCode: RegistryFailureCode;
  error: string;
}

interface ServiceUpdateMetadata {
  canonicalImage?: string;
  platform?: string;
  buildOnly: boolean;
}

const REGISTRY_FAILURE_MESSAGES = {
  "build-only": "Build-only services do not support registry update detection.",
  "local-image-missing": "The image is not available in the local Docker daemon.",
  "registry-auth": "Registry authentication or authorization failed.",
  "registry-not-found": "The registry image or manifest was not found.",
  "registry-timeout": "The registry lookup timed out.",
  "registry-rate-limit": "The registry rate limit was exceeded.",
  "registry-unsupported":
    "The registry image does not support the selected platform or media type.",
  "registry-response-invalid": "The registry returned an invalid manifest response.",
  "registry-check-limit": "Registry update detection exceeded the per-plan service limit.",
  "registry-unavailable": "The registry lookup failed.",
} as const;

/** Bound registry subprocess pressure for large or untrusted Compose models. */
const REGISTRY_CHECK_CONCURRENCY = 4;
const MAX_REGISTRY_CHECK_SERVICES = 128;

type RegistryFailureCode = keyof typeof REGISTRY_FAILURE_MESSAGES;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

/** Hash a fully resolved Compose service without exposing resolved values. */
export function resolvedServiceConfigFingerprint(service: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(service)))
    .digest("hex");
}

/** Normalize an image reference so equivalent Docker Hub forms share one lookup. */
function canonicalizeImageReference(image: string): string {
  const trimmed = image.trim();
  const atIndex = trimmed.indexOf("@");
  const nameAndTag = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
  const digest = atIndex === -1 ? "" : trimmed.slice(atIndex);
  const slashIndex = nameAndTag.indexOf("/");
  const firstSegment = slashIndex === -1 ? nameAndTag : nameAndTag.slice(0, slashIndex);
  const hasRegistry =
    slashIndex !== -1 &&
    (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost");

  let registry = hasRegistry ? firstSegment.toLowerCase() : "docker.io";
  if (registry === "index.docker.io" || registry === "registry-1.docker.io") {
    registry = "docker.io";
  }

  let repositoryAndTag = hasRegistry ? nameAndTag.slice(slashIndex + 1) : nameAndTag;
  if (registry === "docker.io" && !repositoryAndTag.includes("/")) {
    repositoryAndTag = `library/${repositoryAndTag}`;
  }

  const lastSlash = repositoryAndTag.lastIndexOf("/");
  const lastColon = repositoryAndTag.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const tag = digest === "" && !hasTag ? ":latest" : "";
  return `${registry}/${repositoryAndTag}${tag}${digest}`;
}

function normalizePlatform(platform: string | undefined): string | undefined {
  if (platform === undefined || platform.trim() === "") return undefined;

  const [os, rawArchitecture, variant] = platform
    .trim()
    .toLowerCase()
    .split("/")
    .map((part) => part.trim());
  if (os === undefined || rawArchitecture === undefined || os === "" || rawArchitecture === "") {
    return undefined;
  }

  const architecture =
    rawArchitecture === "x86_64"
      ? "amd64"
      : rawArchitecture === "aarch64"
        ? "arm64"
        : rawArchitecture;
  return [os, architecture, variant].filter((part) => part !== undefined && part !== "").join("/");
}

async function forEachBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item !== undefined) await worker(item);
      }
    }),
  );
}

/** Collapse untrusted registry text into a fixed, redacted classification. */
function classifyRegistryFailure(value: unknown): RegistryFailure {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const normalized = text.toLowerCase().replaceAll("_", "-");

  let status: RegistryFailure["status"] = "unknown";
  let errorCode: RegistryFailureCode = "registry-unavailable";

  if (/local-image-missing|local.*(not found|missing)|no such image/.test(normalized)) {
    status = "local-missing";
    errorCode = "local-image-missing";
  } else if (
    /registry-auth|unauthorized|authentication|authorization|forbidden|access denied|\b40[13]\b/.test(
      normalized,
    )
  ) {
    errorCode = "registry-auth";
  } else if (
    /registry-not-found|manifest unknown|name unknown|not found|\b404\b/.test(normalized)
  ) {
    errorCode = "registry-not-found";
  } else if (/registry-rate-limit|too many requests|rate.?limit|\b429\b/.test(normalized)) {
    errorCode = "registry-rate-limit";
  } else if (/registry-timeout|timed? out|timeout|deadline exceeded/.test(normalized)) {
    errorCode = "registry-timeout";
  } else if (
    /registry-unsupported|no matching manifest|unsupported (media|manifest|platform)|platform mismatch/.test(
      normalized,
    )
  ) {
    status = "unsupported";
    errorCode = "registry-unsupported";
  } else if (
    /registry-response-invalid|parse|invalid (json|manifest|response)|unexpected token/.test(
      normalized,
    )
  ) {
    errorCode = "registry-response-invalid";
  }

  return { status, errorCode, error: REGISTRY_FAILURE_MESSAGES[errorCode] };
}

function isExplicitUpdateCheck(
  check: LegacyImageUpdateCheck | ImageUpdateCheck,
): check is ImageUpdateCheck {
  return "status" in check;
}

function normalizeUpdateCheck(
  rawCheck: LegacyImageUpdateCheck | ImageUpdateCheck,
  canonicalImage: string,
  platform: string | undefined,
): ImageUpdateCheck {
  const evidence = { canonicalImage, ...(platform === undefined ? {} : { platform }) };

  if (isExplicitUpdateCheck(rawCheck)) {
    if (rawCheck.status === "update-available" || rawCheck.status === "up-to-date") {
      if (rawCheck.localDigest === undefined || rawCheck.remoteDigest === undefined) {
        const failure = classifyRegistryFailure("invalid registry response");
        return {
          ...evidence,
          status: "unknown",
          updateAvailable: false,
          errorCode: failure.errorCode,
          error: failure.error,
        };
      }
      if (rawCheck.localDigest === rawCheck.remoteDigest) {
        return {
          ...evidence,
          status: "up-to-date",
          updateAvailable: false,
          localDigest: rawCheck.localDigest,
          remoteDigest: rawCheck.remoteDigest,
        };
      }
      return {
        ...evidence,
        status: "update-available",
        updateAvailable: true,
        localDigest: rawCheck.localDigest,
        remoteDigest: rawCheck.remoteDigest,
      };
    }

    if (rawCheck.status === "local-missing") {
      return {
        ...evidence,
        status: "local-missing",
        updateAvailable: false,
        remoteDigest: rawCheck.remoteDigest,
        errorCode: "local-image-missing",
        error: REGISTRY_FAILURE_MESSAGES["local-image-missing"],
      };
    }

    const failure = classifyRegistryFailure(rawCheck.errorCode ?? rawCheck.error);
    if (rawCheck.status === "unsupported") {
      return {
        ...evidence,
        status: "unsupported",
        updateAvailable: false,
        localDigest: rawCheck.localDigest,
        remoteDigest: rawCheck.remoteDigest,
        errorCode: "registry-unsupported",
        error: REGISTRY_FAILURE_MESSAGES["registry-unsupported"],
      };
    }
    return {
      ...evidence,
      status: "unknown",
      updateAvailable: false,
      localDigest: rawCheck.localDigest,
      remoteDigest: rawCheck.remoteDigest,
      errorCode: failure.errorCode,
      error: failure.error,
    };
  }

  if (rawCheck.localDigest !== undefined && rawCheck.remoteDigest !== undefined) {
    if (rawCheck.localDigest === rawCheck.remoteDigest) {
      return {
        ...evidence,
        status: "up-to-date",
        updateAvailable: false,
        localDigest: rawCheck.localDigest,
        remoteDigest: rawCheck.remoteDigest,
      };
    }
    return {
      ...evidence,
      status: "update-available",
      updateAvailable: true,
      localDigest: rawCheck.localDigest,
      remoteDigest: rawCheck.remoteDigest,
    };
  }

  if (rawCheck.remoteDigest !== undefined && rawCheck.localDigest === undefined) {
    return {
      ...evidence,
      status: "local-missing",
      updateAvailable: false,
      remoteDigest: rawCheck.remoteDigest,
      errorCode: "local-image-missing",
      error: REGISTRY_FAILURE_MESSAGES["local-image-missing"],
    };
  }

  const failure = classifyRegistryFailure(rawCheck.error);
  if (failure.status === "local-missing") {
    return { ...evidence, updateAvailable: false, ...failure };
  }
  if (failure.status === "unsupported") {
    return { ...evidence, updateAvailable: false, ...failure };
  }
  return { ...evidence, updateAvailable: false, ...failure };
}

function annotateImageDiff(image: ImageDiff, check: ImageUpdateCheck): void {
  image.updateStatus = check.status;
  image.updateAvailable = check.status === "update-available";
  image.canonicalImage = check.canonicalImage;
  image.platform = check.platform;
  image.localDigest = check.localDigest;
  image.remoteDigest = check.remoteDigest;
  image.errorCode = check.errorCode;
  image.updateError = check.error;
}

/**
 * Check if an environment variable name suggests it contains a secret.
 *
 * Used to mask sensitive values in plan output. Matches common secret
 * naming patterns like PASSWORD, API_KEY, TOKEN, etc.
 *
 * @param name - Environment variable name
 * @returns true if the name suggests a secret value
 */
function isSecretEnvVar(name: string): boolean {
  const secretKeywords = [
    "token",
    "key",
    "secret",
    "password",
    "passwd",
    "pwd",
    "api_key",
    "apikey",
    "auth",
    "credential",
    "private",
  ];
  const lowerName = name.toLowerCase();
  return secretKeywords.some((keyword) => lowerName.includes(keyword));
}

/**
 * Parse environment variables from array format
 */
function parseEnvArray(envArray: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envArray) {
    const index = entry.indexOf("=");
    if (index > 0) {
      const key = entry.substring(0, index);
      const value = entry.substring(index + 1);
      env[key] = value;
    }
  }
  return env;
}

/**
 * Parse port mappings from container inspect
 */
function parsePortBindings(
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>> | null,
): PortMapping[] {
  if (portBindings === undefined || portBindings === null || typeof portBindings !== "object")
    return [];

  const ports: PortMapping[] = [];
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    if (!Array.isArray(bindings)) continue;

    const [port, protocol] = containerPort.split("/");
    for (const binding of bindings) {
      ports.push({
        host: binding.HostPort,
        container: port ?? containerPort,
        protocol: protocol ?? "tcp",
      });
    }
  }
  return ports;
}

/**
 * Parse port mappings from compose config
 */
function parseComposePorts(
  ports?: Array<string | { target: number; published: number; protocol?: string }>,
): PortMapping[] {
  if (ports === undefined) return [];

  const mappings: PortMapping[] = [];
  for (const port of ports) {
    if (typeof port === "string") {
      // Format: "host:container" or "host:container/protocol"
      const parts = port.split(":");
      if (parts.length === 2) {
        const [host, containerPart] = parts;
        const [container, protocol] = (containerPart ?? "").split("/");
        mappings.push({
          host: host ?? "",
          container: container ?? "",
          protocol: protocol ?? "tcp",
        });
      }
    } else {
      // Object format
      mappings.push({
        host: port.published?.toString(),
        container: port.target.toString(),
        protocol: port.protocol ?? "tcp",
      });
    }
  }
  return mappings;
}

/**
 * Parse volume bindings from container inspect
 */
function parseVolumeBinds(binds?: string[] | null): VolumeMapping[] {
  if (binds === undefined || binds === null || !Array.isArray(binds)) return [];

  const volumes: VolumeMapping[] = [];
  for (const bind of binds) {
    const parts = bind.split(":");
    if (parts.length >= 2) {
      const [source, target, mode] = parts;
      volumes.push({
        source: source ?? "",
        target: target ?? "",
        readonly: mode === "ro",
      });
    }
  }
  return volumes;
}

/**
 * Parse volume mappings from compose config
 */
function parseComposeVolumes(
  volumes?: Array<string | { source: string; target: string; read_only?: boolean }>,
): VolumeMapping[] {
  if (volumes === undefined) return [];

  const mappings: VolumeMapping[] = [];
  for (const volume of volumes) {
    if (typeof volume === "string") {
      // Format: "source:target" or "source:target:ro"
      const parts = volume.split(":");
      if (parts.length >= 2) {
        const [source, target, mode] = parts;
        mappings.push({
          source: source ?? "",
          target: target ?? "",
          readonly: mode === "ro",
        });
      }
    } else {
      // Object format
      mappings.push({
        source: volume.source,
        target: volume.target,
        readonly: volume.read_only ?? false,
      });
    }
  }
  return mappings;
}

/**
 * Compare two values and create a diff
 */
function createDiff<T>(current: T | undefined, desired: T | undefined): ConfigDiff<T> {
  return {
    current,
    desired,
    changed: JSON.stringify(current) !== JSON.stringify(desired),
  };
}

/**
 * Compare two arrays in an order-independent way
 * Useful for volumes, ports, networks where order doesn't matter
 */
function arraysEqualIgnoreOrder<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;

  // Sort both arrays by JSON string for comparison
  const sortedA = [...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  const sortedB = [...b].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

  return JSON.stringify(sortedA) === JSON.stringify(sortedB);
}

/**
 * Create a diff for arrays where order doesn't matter
 */
function createArrayDiff<T>(current: T[] | undefined, desired: T[] | undefined): ConfigDiff<T[]> {
  return {
    current,
    desired,
    changed: !arraysEqualIgnoreOrder(current, desired),
  };
}

/**
 * Create an image diff
 */
function createImageDiff(current: string | undefined, desired: string | undefined): ImageDiff {
  return {
    current,
    desired,
    changed: JSON.stringify(current) !== JSON.stringify(desired),
    // Update fields will be populated later if checkUpdates is enabled
    updateAvailable: undefined,
    localDigest: undefined,
    remoteDigest: undefined,
  };
}

/**
 * Compare environment variables
 *
 * Only compares variables that are defined in the desired state (compose config).
 * System variables like PATH that Docker adds automatically are ignored.
 */
function compareEnv(
  current?: Record<string, string>,
  desired?: Record<string, string>,
): EnvChange[] {
  const changes: EnvChange[] = [];

  // Only check keys that are explicitly defined in the compose file
  // This avoids flagging system variables (PATH, HOME, etc.) as "removed"
  const desiredKeys = Object.keys(desired ?? {});

  for (const key of desiredKeys) {
    const currentValue = current?.[key];
    const desiredValue = desired?.[key];
    const isSecret = isSecretEnvVar(key);

    let changeType: EnvChange["changeType"];
    if (currentValue === undefined && desiredValue !== undefined) {
      changeType = "added";
    } else if (currentValue !== undefined && desiredValue === undefined) {
      changeType = "removed";
    } else if (currentValue !== desiredValue) {
      changeType = "modified";
    } else {
      changeType = "unchanged";
    }

    changes.push({
      name: key,
      current: currentValue,
      desired: desiredValue,
      changeType,
      isSecret,
    });
  }

  return changes;
}

/**
 * Determine change type based on diffs, recording which dimensions forced it.
 *
 * The cascade is unchanged: every `changeType` verdict is identical to the
 * verdict this function returned before it grew a second return field.
 * `decisive` exists so the plan-intelligence classifier reads this cascade's
 * verdict instead of re-implementing it — one cascade, one source of truth.
 *
 * @param isRunning - whether a running container was inspected for the service
 * @param imageDiff - image reference diff
 * @param envChanges - per-variable environment comparison
 * @param portsDiff - port mapping diff
 * @param volumesDiff - volume mount diff
 * @param networksDiff - network attachment diff
 * @returns the change type plus the dimensions that forced it
 */
function determineChangeType(
  isRunning: boolean,
  imageDiff: ImageDiff,
  envChanges: EnvChange[],
  portsDiff: ConfigDiff<PortMapping[]>,
  volumesDiff: ConfigDiff<VolumeMapping[]>,
  networksDiff: ConfigDiff<string[]>,
): { changeType: ChangeType; decisive: readonly ChangeDimension[] } {
  // Service doesn't exist yet
  if (!isRunning) {
    return { changeType: "create", decisive: ["runtime"] };
  }

  // Image changed - requires recreate
  if (imageDiff.changed) {
    return { changeType: "recreate", decisive: ["image"] };
  }

  // Check if any config changed
  const hasEnvChanges = envChanges.some((c) => c.changeType !== "unchanged");
  const hasChanges =
    hasEnvChanges || portsDiff.changed || volumesDiff.changed || networksDiff.changed;

  if (hasChanges) {
    const decisive: ChangeDimension[] = [];
    if (hasEnvChanges) decisive.push("environment");
    if (portsDiff.changed) decisive.push("ports");
    if (volumesDiff.changed) decisive.push("volumes");
    if (networksDiff.changed) decisive.push("networks");
    return { changeType: "update", decisive };
  }

  return { changeType: "unchanged", decisive: [] };
}

/**
 * Generate a deployment plan.
 *
 * Compares current running state with desired compose configuration
 * to produce a plan showing what changes would occur on deployment.
 *
 * The plan includes:
 * - Image changes (with optional registry update checking)
 * - Environment variable differences (secrets are masked)
 * - Port mapping changes
 * - Volume mount changes
 * - Network configuration changes
 *
 * Change types:
 * - create: Service doesn't exist, will be created
 * - update: Service config changed but image is same
 * - recreate: Image changed, container must be recreated
 * - delete: Service no longer in compose (not currently detected)
 * - unchanged: No differences detected
 *
 * @param options - Plan generation options
 * @param envTool - Optional environment tool config for secrets injection
 * @returns Generated plan or undefined if compose config couldn't be parsed
 *
 * @example
 * ```typescript
 * const plan = await generatePlan({
 *   composePath: '/path/to/compose.yml',
 *   profiles: ['all'],
 *   checkUpdates: true
 * });
 *
 * if (plan) {
 *   console.log(`${plan.summary.toCreate} to create`);
 *   console.log(`${plan.summary.updatesAvailable} updates available`);
 * }
 * ```
 */
export async function generatePlan(
  options: PlanOptions,
  envTool?: EnvToolExecConfig,
): Promise<DeploymentPlan | undefined> {
  logDebug(`Generating plan for compose: ${options.composePath}`);

  // Get desired state from compose file
  const composeConfig = await getComposeConfig(options.composePath, {
    profiles: options.profiles,
    projectName: options.projectName,
    envTool,
  });

  if (composeConfig === undefined) {
    return undefined;
  }

  // Get service → container name mapping for running containers
  // This maps by service name (stable) rather than container name (can have prefixes)
  const serviceContainerMap = await getRunningServiceContainerMap(options.composePath, {
    profiles: options.profiles,
    projectName: options.projectName,
    envTool,
  });

  // Build a map from service name to container inspect data
  const containerMap = new Map<string, ContainerInspect>();
  // Hoisted so the intelligence pass can tell "inspect succeeded" from
  // "`docker compose ps` succeeded": only the former populates `containerMap`.
  let containerInspects: ContainerInspect[] | undefined;

  if (serviceContainerMap !== undefined && serviceContainerMap.size > 0) {
    // Get unique container names for inspection
    const containerNames = [...new Set(serviceContainerMap.values())];
    logDebug(
      `Found ${serviceContainerMap.size} running services, ${containerNames.length} unique containers`,
    );

    // Inspect through the same authority used to resolve the service/container map.
    containerInspects = await inspectContainers(containerNames, {
      envTool,
      timeout: 15_000,
    });

    if (containerInspects !== undefined) {
      // Build a temporary map from container name to inspect data
      const inspectByContainerName = new Map<string, ContainerInspect>();
      for (const inspect of containerInspects) {
        // Container names start with '/', remove it
        const name = inspect.Name.startsWith("/") ? inspect.Name.substring(1) : inspect.Name;
        inspectByContainerName.set(name, inspect);
      }

      // Map service names to their container inspect data
      for (const [serviceName, containerName] of serviceContainerMap) {
        const inspect = inspectByContainerName.get(containerName);
        if (inspect !== undefined) {
          containerMap.set(serviceName, inspect);
        }
      }
    }
  } else {
    logDebug("No running services found");
  }

  // Generate service changes
  const services: ServiceChange[] = [];
  const updateMetadata = new Map<string, ServiceUpdateMetadata>();
  // Dimensions that forced each verdict, for the optional intelligence pass.
  const decisiveByService = new Map<string, readonly ChangeDimension[]>();
  const composeServices = composeConfig.services;

  // Filter to target services if specified
  const targetServiceNames =
    options.services !== undefined && options.services.length > 0
      ? options.services
      : Object.keys(composeServices);

  for (const serviceName of targetServiceNames) {
    const desiredService = composeServices[serviceName];
    if (desiredService === undefined) continue;

    const containerInspect = containerMap.get(serviceName);
    const isRunning = containerInspect !== undefined;

    // Parse current state
    const currentImage = containerInspect?.Config.Image;
    const currentEnv =
      containerInspect !== undefined ? parseEnvArray(containerInspect.Config.Env) : undefined;
    const currentPorts = parsePortBindings(containerInspect?.HostConfig.PortBindings);
    const currentVolumes = parseVolumeBinds(containerInspect?.HostConfig.Binds);

    // Handle current networks
    // If container uses network_mode, NetworkSettings.Networks will be empty
    // Check HostConfig.NetworkMode to determine if this is a shared network namespace
    const currentNetworkMode = containerInspect?.HostConfig?.NetworkMode;
    const usesSharedNetwork =
      currentNetworkMode !== undefined &&
      (currentNetworkMode.startsWith("container:") || currentNetworkMode.startsWith("service:"));
    const currentNetworks = usesSharedNetwork
      ? undefined // Skip network comparison for shared network namespaces
      : containerInspect?.NetworkSettings.Networks !== undefined
        ? Object.keys(containerInspect.NetworkSettings.Networks)
        : undefined;

    // Parse desired state
    // If service uses 'build' instead of 'image', use the current image as desired
    // (built images are managed locally, not pulled from registry)
    const hasBuildContext = (desiredService as { build?: unknown }).build !== undefined;
    const desiredImage = hasBuildContext
      ? currentImage // For built images, current = desired (no registry to compare)
      : (desiredService.image ?? `${serviceName}:latest`);
    const platform = normalizePlatform((desiredService as { platform?: string }).platform);
    updateMetadata.set(serviceName, {
      canonicalImage:
        desiredImage === undefined ? undefined : canonicalizeImageReference(desiredImage),
      platform,
      buildOnly: hasBuildContext,
    });
    const desiredEnv: Record<string, string> = {};
    if (Array.isArray((desiredService as { environment?: string[] }).environment)) {
      const envArray = (desiredService as { environment?: string[] }).environment ?? [];
      for (const entry of envArray) {
        const index = entry.indexOf("=");
        if (index > 0) {
          const key = entry.substring(0, index);
          const value = entry.substring(index + 1);
          desiredEnv[key] = value;
        }
      }
    } else if (
      typeof (desiredService as { environment?: Record<string, string> }).environment === "object"
    ) {
      Object.assign(
        desiredEnv,
        (desiredService as { environment?: Record<string, string> }).environment,
      );
    }

    const desiredPorts = parseComposePorts(
      (desiredService as { ports?: Array<string | { target: number; published: number }> }).ports,
    );
    const desiredVolumes = parseComposeVolumes(
      (desiredService as { volumes?: Array<string | { source: string; target: string }> }).volumes,
    );

    // Handle network configuration
    // If network_mode is set (e.g., "service:xxx" or "container:xxx"), the container
    // doesn't have its own network namespace, so we should skip network comparison
    const networkMode = (desiredService as { network_mode?: string }).network_mode;
    const desiredNetworks =
      networkMode !== undefined
        ? undefined // Skip network comparison for containers using network_mode
        : (desiredService as { networks?: string[] | Record<string, unknown> }).networks !==
            undefined
          ? Array.isArray((desiredService as { networks?: string[] }).networks)
            ? (desiredService as { networks?: string[] }).networks
            : Object.keys((desiredService as { networks?: Record<string, unknown> }).networks ?? {})
          : undefined;

    // Create diffs
    const imageDiff = createImageDiff(currentImage, desiredImage);
    const envChanges = compareEnv(currentEnv, desiredEnv);
    const portsDiff = createArrayDiff(currentPorts, desiredPorts);
    const volumesDiff = createArrayDiff(currentVolumes, desiredVolumes);
    const networksDiff = createArrayDiff(currentNetworks, desiredNetworks);

    // Determine change type
    const { changeType, decisive } = determineChangeType(
      isRunning,
      imageDiff,
      envChanges,
      portsDiff,
      volumesDiff,
      networksDiff,
    );
    decisiveByService.set(serviceName, decisive);

    services.push({
      service: serviceName,
      resolvedConfigFingerprint: resolvedServiceConfigFingerprint(desiredService),
      changeType,
      image: imageDiff,
      environment: envChanges,
      ports: portsDiff,
      volumes: volumesDiff,
      networks: networksDiff,
    });
  }

  // Check for image updates if requested
  if (options.checkUpdates === true) {
    logDebug("Checking for image updates...");
    const checkCache = new Map<string, Promise<ImageUpdateCheck>>();
    let registryCandidates = 0;

    await forEachBounded(services, REGISTRY_CHECK_CONCURRENCY, async (service) => {
      const metadata = updateMetadata.get(service.service);
      if (metadata?.buildOnly === true) {
        annotateImageDiff(service.image, {
          status: "unsupported",
          updateAvailable: false,
          canonicalImage: metadata.canonicalImage,
          platform: metadata.platform,
          errorCode: "build-only",
          error: REGISTRY_FAILURE_MESSAGES["build-only"],
        });
        return;
      }

      if (metadata?.canonicalImage === undefined) return;
      const canonicalImage = metadata.canonicalImage;
      registryCandidates += 1;
      if (registryCandidates > MAX_REGISTRY_CHECK_SERVICES) {
        annotateImageDiff(service.image, {
          status: "unknown",
          updateAvailable: false,
          canonicalImage,
          platform: metadata.platform,
          errorCode: "registry-check-limit",
          error: REGISTRY_FAILURE_MESSAGES["registry-check-limit"],
        });
        return;
      }

      const cacheKey = `${canonicalImage}\u0000${metadata.platform ?? ""}`;
      let updatePromise = checkCache.get(cacheKey);
      if (updatePromise === undefined) {
        updatePromise = (async () => {
          try {
            const rawCheck = await checkImageUpdate(canonicalImage, {
              envTool,
              ...(metadata.platform === undefined ? {} : { platform: metadata.platform }),
            });
            return normalizeUpdateCheck(rawCheck, canonicalImage, metadata.platform);
          } catch (error: unknown) {
            const failure = classifyRegistryFailure(error);
            return normalizeUpdateCheck(
              { hasUpdate: false, error: failure.errorCode },
              canonicalImage,
              metadata.platform,
            );
          }
        })();
        checkCache.set(cacheKey, updatePromise);
      }

      const updateCheck = await updatePromise;
      annotateImageDiff(service.image, updateCheck);

      if (updateCheck.status === "update-available") {
        logDebug(`Update available for ${service.service}: ${canonicalImage}`);
      }
    });
  }

  // Calculate summary
  const summary: PlanSummary = {
    toCreate: services.filter((s) => s.changeType === "create").length,
    toUpdate: services.filter((s) => s.changeType === "update").length,
    toRecreate: services.filter((s) => s.changeType === "recreate").length,
    toDelete: services.filter((s) => s.changeType === "delete").length,
    unchanged: services.filter((s) => s.changeType === "unchanged").length,
    updatesAvailable: services.filter((s) => s.image.updateAvailable === true).length,
    total: services.length,
  };

  // Create plan
  const plan: DeploymentPlan = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    composeHash: "", // Will be set by plan-storage when saving
    composePath: options.composePath,
    targetServices: options.services,
    profiles: options.profiles,
    services,
    summary,
  };

  // Gated: without `options.intelligence` the plan carries no `intelligence`
  // key at all, so the machine payload stays byte-identical to today.
  if (options.intelligence !== undefined) {
    plan.intelligence = buildPlanIntelligence({
      services,
      decisiveByService,
      composeServices,
      runningServices: new Set(containerMap.keys()),
      // Runtime state counts as observed only when the data the classifier reads
      // was actually obtained: a successful `ps` whose follow-up inspect failed
      // leaves `containerMap` empty, which would otherwise read as "nothing is
      // running" at `confirmed` confidence. An empty `ps` is a genuine
      // observation — inspect is never called for it.
      runtimeStateObserved:
        serviceContainerMap !== undefined &&
        (serviceContainerMap.size === 0 || containerInspects !== undefined),
      registryChecked: options.checkUpdates === true,
      profileMapping: options.intelligence.profileMapping,
      baseline: options.intelligence.baseline,
    });
  }

  return plan;
}
