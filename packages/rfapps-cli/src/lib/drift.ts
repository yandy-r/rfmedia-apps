/**
 * Drift detection logic for rfapps CLI
 *
 * Compares running containers against compose.yml to detect configuration drift.
 */

import { logDebug } from "@rfmedia/common";

import type {
  DriftOptions,
  DriftResult,
  ServiceDrift,
  DriftCategory,
  DriftDirection,
  ReconcileDriftEvidence,
  ReconcileDriftOptions,
  RuntimeStatusDrift,
} from "../types/drift.js";
import { DRIFT_SCHEMA_VERSION } from "../types/drift.js";
import type { ReconcileContainerEvidence } from "../types/reconcile.js";
import type {
  ConfigDiff,
  EnvChange,
  ImageDiff,
  PortMapping,
  VolumeMapping,
} from "../types/plan.js";
import type { EnvToolExecConfig } from "../types/index.js";
import type { ContainerState, HealthStatus } from "../types/results.js";
import type { ComposeContainerObservation, ContainerInspect } from "./docker.js";
import {
  getComposeConfig,
  getComposeContainerObservations,
  getRunningServiceContainerMap,
  inspectImageDefaultEnvironments,
  inspectContainers,
} from "./docker.js";
import { getServiceStatusMap } from "./service-status.js";

interface ComposeService {
  image?: string;
  build?: unknown;
  environment?: Array<string> | Record<string, string | number | boolean>;
  ports?: Array<string | { target: number; published?: number; protocol?: string }>;
  volumes?: Array<string | { source: string; target: string; read_only?: boolean }>;
  networks?: string[] | Record<string, unknown>;
  network_mode?: string;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

/**
 * Check if an environment variable name suggests it contains a secret
 */
export function isSecretEnvVar(name: string): boolean {
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
 * Parse environment variables from container inspect
 */
export function parseEnvArray(envArray: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of envArray) {
    const index = entry.indexOf("=");
    // Note: index > 0 (not >= 0) is intentional - rejects empty keys like "=value"
    // which are invalid in POSIX and rejected by Docker
    if (index > 0) {
      const key = entry.substring(0, index);
      const value = entry.substring(index + 1);
      env[key] = value;
    }
  }
  return env;
}

/**
 * Parse port bindings from container inspect
 */
export function parsePortBindings(
  portBindings?: Record<string, Array<{ HostIp: string; HostPort: string }>> | null,
): PortMapping[] {
  if (!portBindings || typeof portBindings !== "object") return [];

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
export function parseComposePorts(
  ports?: Array<string | { target: number; published?: number; protocol?: string }>,
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
      const readonly = mode === "ro" || mode === "readonly";
      volumes.push({
        source: source ?? "",
        target: target ?? "",
        readonly,
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
      const parts = volume.split(":");
      if (parts.length >= 2) {
        const [source, target, mode] = parts;
        mappings.push({
          source: source ?? "",
          target: target ?? "",
          readonly: mode === "ro" || mode === "readonly",
        });
      }
    } else {
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
 * Uses Set-based comparison for better performance on larger arrays
 */
export function arraysEqualIgnoreOrder<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;

  // For primitive types or small arrays, use Set comparison
  // For objects, we need to serialize for comparison
  const serialize = (item: T): string =>
    typeof item === "object" ? JSON.stringify(item) : String(item);

  const setA = new Set(a.map(serialize));
  const setB = new Set(b.map(serialize));

  // If sizes differ after deduplication, arrays had different duplicates
  if (setA.size !== setB.size) return false;

  // Check if all items in setA exist in setB
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }

  return true;
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
    updateAvailable: undefined,
    localDigest: undefined,
    remoteDigest: undefined,
  };
}

/**
 * Compare environment variables
 */
function compareEnv(
  current?: Record<string, string>,
  desired?: Record<string, string>,
  imageDefaults?: Readonly<Record<string, string>>,
): EnvChange[] {
  const changes: EnvChange[] = [];
  const effectiveDesired = { ...(imageDefaults ?? {}), ...(desired ?? {}) };
  const candidateKeys = new Set(Object.keys(desired ?? {}));
  if (imageDefaults !== undefined) {
    for (const [key, value] of Object.entries(current ?? {})) {
      if (value !== imageDefaults[key]) candidateKeys.add(key);
    }
  }

  const comparisonKeys =
    imageDefaults === undefined
      ? Object.keys(desired ?? {})
      : [...candidateKeys].sort(compareCodePoint);
  for (const key of comparisonKeys) {
    const currentValue = current?.[key];
    const desiredValue = effectiveDesired[key];
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
      current: isSecret && currentValue !== undefined ? "********" : currentValue,
      desired: isSecret && desiredValue !== undefined ? "********" : desiredValue,
      changeType,
      isSecret,
    });
  }

  return changes;
}

/**
 * Determine drift direction from a diffed array
 */
function determineArrayDirection<T>(
  current: T[] | undefined,
  desired: T[] | undefined,
): { composeAhead: boolean; containerAhead: boolean } {
  const currentSet = new Set((current ?? []).map((item) => JSON.stringify(item)));
  const desiredSet = new Set((desired ?? []).map((item) => JSON.stringify(item)));

  let composeAhead = false;
  let containerAhead = false;

  for (const item of desiredSet) {
    if (!currentSet.has(item)) {
      composeAhead = true;
    }
  }

  for (const item of currentSet) {
    if (!desiredSet.has(item)) {
      containerAhead = true;
    }
  }

  return { composeAhead, containerAhead };
}

/**
 * Determine drift direction
 */
function determineDriftDirection(
  imageDiff: ImageDiff,
  envChanges: EnvChange[],
  portsDiff: ConfigDiff<PortMapping[]>,
  volumesDiff: ConfigDiff<VolumeMapping[]>,
  networksDiff: ConfigDiff<string[]>,
  runtimeStatus: RuntimeStatusDrift,
): DriftDirection {
  const flags = { composeAhead: false, containerAhead: false };

  if (imageDiff.changed) {
    if (imageDiff.current === undefined && imageDiff.desired !== undefined) {
      flags.composeAhead = true;
    } else if (imageDiff.current !== undefined && imageDiff.desired === undefined) {
      flags.containerAhead = true;
    } else {
      flags.composeAhead = true;
      flags.containerAhead = true;
    }
  }

  for (const env of envChanges) {
    if (env.changeType === "added") {
      flags.composeAhead = true;
    } else if (env.changeType === "removed") {
      flags.containerAhead = true;
    } else if (env.changeType === "modified") {
      flags.composeAhead = true;
      flags.containerAhead = true;
    }
  }

  if (portsDiff.changed) {
    const direction = determineArrayDirection(portsDiff.current, portsDiff.desired);
    flags.composeAhead ||= direction.composeAhead;
    flags.containerAhead ||= direction.containerAhead;
  }

  if (volumesDiff.changed) {
    const direction = determineArrayDirection(volumesDiff.current, volumesDiff.desired);
    flags.composeAhead ||= direction.composeAhead;
    flags.containerAhead ||= direction.containerAhead;
  }

  if (networksDiff.changed) {
    const direction = determineArrayDirection(networksDiff.current, networksDiff.desired);
    flags.composeAhead ||= direction.composeAhead;
    flags.containerAhead ||= direction.containerAhead;
  }

  if (runtimeStatus.changed) {
    flags.composeAhead = true;
  }

  if (flags.composeAhead && flags.containerAhead) {
    return "diverged";
  }
  if (flags.composeAhead) {
    return "compose_ahead";
  }
  if (flags.containerAhead) {
    return "container_ahead";
  }

  return "compose_ahead";
}

/**
 * Build a desired environment map from compose service
 */
function buildDesiredEnv(service: ComposeService): Record<string, string> {
  const desiredEnv: Record<string, string> = {};

  if (Array.isArray(service.environment)) {
    for (const entry of service.environment) {
      const index = entry.indexOf("=");
      // Note: index > 0 (not >= 0) is intentional - rejects empty keys like "=value"
      if (index > 0) {
        const key = entry.substring(0, index);
        const value = entry.substring(index + 1);
        desiredEnv[key] = value;
      }
    }
  } else if (service.environment && typeof service.environment === "object") {
    for (const [key, value] of Object.entries(service.environment)) {
      desiredEnv[key] = String(value);
    }
  }

  return desiredEnv;
}

/**
 * Create drift categories list based on diffs
 */
function buildDriftCategories(
  imageDiff: ImageDiff,
  envChanges: EnvChange[],
  portsDiff: ConfigDiff<PortMapping[]>,
  volumesDiff: ConfigDiff<VolumeMapping[]>,
  networksDiff: ConfigDiff<string[]>,
  runtimeStatus: RuntimeStatusDrift,
): DriftCategory[] {
  const categories: DriftCategory[] = [];
  if (imageDiff.changed) categories.push("image");
  if (envChanges.some((c) => c.changeType !== "unchanged")) categories.push("environment");
  if (portsDiff.changed) categories.push("ports");
  if (volumesDiff.changed) categories.push("volumes");
  if (networksDiff.changed) categories.push("networks");
  if (runtimeStatus.changed) categories.push("runtime-status");
  return categories;
}

function isProblemContainerState(state: ContainerState): boolean {
  return state !== "running";
}

function isProblemHealthStatus(health: HealthStatus): boolean {
  return health === "unhealthy" || health === "starting";
}

function createRuntimeStatusDrift(
  status: { state: ContainerState; health: HealthStatus } | undefined,
): RuntimeStatusDrift {
  const current = status ?? { state: "created", health: "none" };
  const desiredHealth: RuntimeStatusDrift["desired"]["health"] =
    current.health === "none" ? "none" : "healthy";

  return {
    current,
    desired: {
      state: "running",
      health: desiredHealth,
    },
    changed: isProblemContainerState(current.state) || isProblemHealthStatus(current.health),
  };
}

/**
 * Generate drift data for a single service
 */
function buildServiceDrift(
  serviceName: string,
  desiredService: ComposeService,
  containerInspect?: ContainerInspect,
  runtimeStatus?: { state: ContainerState; health: HealthStatus },
  imageDefaults?: Readonly<Record<string, string>>,
): ServiceDrift {
  const currentImage = containerInspect?.Config.Image;
  const currentEnv =
    containerInspect !== undefined ? parseEnvArray(containerInspect.Config.Env) : undefined;
  const currentPorts = parsePortBindings(containerInspect?.HostConfig.PortBindings);
  const currentVolumes = parseVolumeBinds(containerInspect?.HostConfig.Binds);

  const currentNetworkMode = containerInspect?.HostConfig?.NetworkMode;
  const usesSharedNetwork =
    currentNetworkMode !== undefined &&
    (currentNetworkMode.startsWith("container:") || currentNetworkMode.startsWith("service:"));
  const currentNetworks = usesSharedNetwork
    ? undefined
    : containerInspect?.NetworkSettings.Networks !== undefined
      ? Object.keys(containerInspect.NetworkSettings.Networks)
      : undefined;

  const hasBuildContext = desiredService.build !== undefined;
  const desiredImage = hasBuildContext
    ? currentImage
    : (desiredService.image ?? `${serviceName}:latest`);
  const desiredEnv = buildDesiredEnv(desiredService);
  const desiredPorts = parseComposePorts(desiredService.ports);
  const desiredVolumes = parseComposeVolumes(desiredService.volumes);

  const networkMode = desiredService.network_mode;
  const desiredNetworks =
    networkMode !== undefined
      ? undefined
      : desiredService.networks !== undefined
        ? Array.isArray(desiredService.networks)
          ? desiredService.networks
          : Object.keys(desiredService.networks)
        : undefined;

  const imageDiff = createImageDiff(currentImage, desiredImage);
  const envChanges = compareEnv(currentEnv, desiredEnv, imageDefaults);
  const portsDiff = createArrayDiff(currentPorts, desiredPorts);
  const volumesDiff = createArrayDiff(currentVolumes, desiredVolumes);
  const networksDiff = createArrayDiff(currentNetworks, desiredNetworks);
  const runtimeStatusDiff = createRuntimeStatusDrift(runtimeStatus);

  const categories = buildDriftCategories(
    imageDiff,
    envChanges,
    portsDiff,
    volumesDiff,
    networksDiff,
    runtimeStatusDiff,
  );
  const hasDrift = categories.length > 0;
  const direction = determineDriftDirection(
    imageDiff,
    envChanges,
    portsDiff,
    volumesDiff,
    networksDiff,
    runtimeStatusDiff,
  );

  return {
    service: serviceName,
    hasDrift,
    direction,
    categories,
    image: imageDiff,
    environment: envChanges,
    ports: portsDiff,
    volumes: volumesDiff,
    networks: networksDiff,
    runtimeStatus: runtimeStatusDiff,
  };
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeObservedState(state: string): ContainerState | undefined {
  switch (state.trim().toLowerCase()) {
    case "running":
    case "exited":
    case "paused":
    case "restarting":
    case "dead":
    case "created":
      return state.trim().toLowerCase() as ContainerState;
    default:
      return undefined;
  }
}

function normalizeObservedHealth(health: string): HealthStatus | undefined {
  switch (health.trim().toLowerCase()) {
    case "healthy":
    case "unhealthy":
    case "starting":
      return health.trim().toLowerCase() as HealthStatus;
    case "":
    case "none":
      return "none";
    default:
      return undefined;
  }
}

function toReconcileContainerEvidence(
  observation: ComposeContainerObservation,
): ReconcileContainerEvidence | undefined {
  const state = normalizeObservedState(observation.state);
  const health = normalizeObservedHealth(observation.health);
  if (state === undefined || health === undefined) return undefined;
  return {
    id: observation.containerId,
    name: observation.containerName,
    state,
    health,
  };
}

function failedReconcileEvidence(
  services: readonly string[],
  reasonCode: string,
): ReconcileDriftEvidence[] {
  return services.map((service) => ({
    service,
    observation: { kind: "failed", reasonCode },
  }));
}

function containerIdsMatch(observed: string, inspected: string): boolean {
  const normalizedObserved = observed.toLowerCase();
  const normalizedInspected = inspected.toLowerCase();
  return (
    normalizedObserved === normalizedInspected ||
    normalizedInspected.startsWith(normalizedObserved) ||
    normalizedObserved.startsWith(normalizedInspected)
  );
}

/**
 * Observe a frozen reconciliation scope without changing the legacy DriftResult contract.
 *
 * Every selected service produces exactly one evidence entry. The adapter keeps
 * raw comparator values process-local while retaining zero/one/many container
 * cardinality for the value-free reconciliation planner.
 */
export async function observeReconcileDrift(
  options: ReconcileDriftOptions,
  envTool?: EnvToolExecConfig,
): Promise<ReconcileDriftEvidence[]> {
  const selectedServices = [...new Set(options.services)].sort(compareCodePoint);
  if (selectedServices.length === 0) return [];

  let composeConfig: ComposeConfig | undefined;
  try {
    composeConfig = (await getComposeConfig(options.composePath, {
      profiles: options.profiles,
      projectName: options.projectName,
      envFile: options.envFile,
      cwd: options.cwd,
      timeout: options.timeout,
      env: options.env,
      replaceEnv: options.replaceEnv,
      envTool,
    })) as unknown as ComposeConfig | undefined;
  } catch {
    composeConfig = undefined;
  }
  if (composeConfig === undefined) {
    return failedReconcileEvidence(selectedServices, "RECONCILE_COMPOSE_OBSERVATION_FAILED");
  }
  if (
    composeConfig.services === null ||
    typeof composeConfig.services !== "object" ||
    Array.isArray(composeConfig.services)
  ) {
    return failedReconcileEvidence(selectedServices, "RECONCILE_COMPOSE_OBSERVATION_FAILED");
  }
  const resolvedComposeConfig = composeConfig;

  let observations: readonly ComposeContainerObservation[];
  try {
    observations = await getComposeContainerObservations(options.composePath, {
      profiles: options.profiles,
      projectName: options.projectName,
      envFile: options.envFile,
      cwd: options.cwd,
      timeout: options.timeout,
      env: options.env,
      replaceEnv: options.replaceEnv,
      envTool,
    });
  } catch {
    return failedReconcileEvidence(selectedServices, "RECONCILE_CONTAINER_OBSERVATION_FAILED");
  }

  const observationsByService = new Map<string, ComposeContainerObservation[]>();
  for (const observation of observations) {
    const entries = observationsByService.get(observation.serviceName) ?? [];
    entries.push(observation);
    observationsByService.set(observation.serviceName, entries);
  }

  const inspectNames = selectedServices.flatMap((service) => {
    const entries = observationsByService.get(service) ?? [];
    return entries.length === 1 && resolvedComposeConfig.services[service] !== undefined
      ? [entries[0]!.containerName]
      : [];
  });
  let inspectByName: Map<string, ContainerInspect> | undefined;
  if (inspectNames.length > 0) {
    try {
      const inspected = await inspectContainers(inspectNames, {
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env,
        replaceEnv: options.replaceEnv,
        envTool,
      });
      if (inspected !== undefined) {
        inspectByName = new Map();
        for (const inspect of inspected) {
          const name = inspect.Name.startsWith("/") ? inspect.Name.substring(1) : inspect.Name;
          if (inspectByName.has(name)) {
            inspectByName = undefined;
            break;
          }
          inspectByName.set(name, inspect);
        }
      }
    } catch {
      inspectByName = undefined;
    }
  } else {
    inspectByName = new Map();
  }

  let imageDefaultsById: Map<string, Readonly<Record<string, string>>> | undefined;
  if (inspectByName !== undefined && inspectByName.size > 0) {
    try {
      const imageIds = [...new Set([...inspectByName.values()].map((inspect) => inspect.Image))];
      imageDefaultsById = await inspectImageDefaultEnvironments(imageIds, {
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env,
        replaceEnv: options.replaceEnv,
        envTool,
      });
    } catch {
      imageDefaultsById = undefined;
    }
  } else if (inspectByName !== undefined) {
    imageDefaultsById = new Map();
  }

  return selectedServices.map((service): ReconcileDriftEvidence => {
    const desiredService = resolvedComposeConfig.services[service];
    if (desiredService === undefined) {
      return {
        service,
        observation: { kind: "failed", reasonCode: "RECONCILE_DESIRED_SERVICE_MISSING" },
      };
    }

    const serviceObservations = [...(observationsByService.get(service) ?? [])].sort(
      (left, right) =>
        compareCodePoint(left.containerId, right.containerId) ||
        compareCodePoint(left.containerName, right.containerName),
    );
    if (serviceObservations.length === 0) {
      const observation = { kind: "missing" } as const;
      let drift: ServiceDrift;
      try {
        drift = buildServiceDrift(service, desiredService, undefined, {
          state: "created",
          health: "none",
        });
      } catch {
        return {
          service,
          observation: { kind: "failed", reasonCode: "RECONCILE_COMPARISON_FAILED" },
        };
      }
      return {
        service,
        observation,
        drift,
      };
    }

    const containers = serviceObservations.map(toReconcileContainerEvidence);
    if (containers.some((container) => container === undefined)) {
      return {
        service,
        observation: {
          kind: "failed",
          reasonCode: "RECONCILE_CONTAINER_OBSERVATION_INVALID",
        },
      };
    }
    const completeContainers = containers as ReconcileContainerEvidence[];
    if (completeContainers.length > 1) {
      return { service, observation: { kind: "ambiguous", containers: completeContainers } };
    }

    const container = completeContainers[0]!;
    const inspect = inspectByName?.get(container.name);
    if (inspect === undefined) {
      return {
        service,
        observation: {
          kind: "failed",
          containers: completeContainers,
          reasonCode: "RECONCILE_CONTAINER_INSPECTION_FAILED",
        },
      };
    }
    if (!containerIdsMatch(container.id, inspect.Id)) {
      return {
        service,
        observation: {
          kind: "failed",
          containers: completeContainers,
          reasonCode: "RECONCILE_CONTAINER_IDENTITY_CHANGED",
        },
      };
    }
    const imageDefaults = imageDefaultsById?.get(inspect.Image.toLowerCase());
    if (imageDefaults === undefined) {
      return {
        service,
        observation: {
          kind: "failed",
          containers: completeContainers,
          reasonCode: "RECONCILE_IMAGE_INSPECTION_FAILED",
        },
      };
    }
    let drift: ServiceDrift;
    try {
      drift = buildServiceDrift(
        service,
        desiredService,
        inspect,
        {
          state: container.state as ContainerState,
          health: container.health as HealthStatus,
        },
        imageDefaults,
      );
    } catch {
      return {
        service,
        observation: {
          kind: "failed",
          containers: completeContainers,
          reasonCode: "RECONCILE_CONTAINER_INSPECTION_FAILED",
        },
      };
    }
    return {
      service,
      observation: { kind: "present", containers: completeContainers },
      drift,
    };
  });
}

/**
 * Detect configuration drift across services.
 *
 * Compares running container state with compose.yml definitions to identify
 * services that have drifted from their desired configuration.
 *
 * Drift can occur from:
 * - Manual docker exec/run commands
 * - compose.yml updates not yet applied
 * - Container restarts with different configuration
 * - Image updates in registry
 *
 * For each service, returns:
 * - hasDrift: Whether any configuration differs
 * - direction: Who has the newer changes
 * - categories: Which aspects differ (image, env, ports, etc.)
 * - Detailed diffs for each category
 *
 * @param options - Drift detection options
 * @param envTool - Optional environment tool for secrets injection
 * @returns Drift result with per-service details and summary
 */
export async function detectDrift(
  options: DriftOptions,
  envTool?: EnvToolExecConfig,
): Promise<DriftResult | undefined> {
  logDebug(`Detecting drift for compose: ${options.composePath}`);

  const composeConfig = await getComposeConfig(options.composePath, {
    profiles: options.profiles,
    envTool,
  });

  if (composeConfig === undefined) {
    return undefined;
  }

  const fullConfig = composeConfig as unknown as ComposeConfig;

  const serviceContainerMap = await getRunningServiceContainerMap(options.composePath, {
    profiles: options.profiles,
    envTool,
  });

  const containerMap = new Map<string, ContainerInspect>();

  if (serviceContainerMap !== undefined && serviceContainerMap.size > 0) {
    const containerNames = [...new Set(serviceContainerMap.values())];
    logDebug(
      `Found ${serviceContainerMap.size} running services, ${containerNames.length} unique containers`,
    );

    const containerInspects = await inspectContainers(containerNames);
    if (containerInspects !== undefined) {
      const inspectByContainerName = new Map<string, ContainerInspect>();
      for (const inspect of containerInspects) {
        const name = inspect.Name.startsWith("/") ? inspect.Name.substring(1) : inspect.Name;
        inspectByContainerName.set(name, inspect);
      }

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

  const services: ServiceDrift[] = [];
  const composeServices = fullConfig.services;
  const targetServiceNames =
    options.services !== undefined && options.services.length > 0
      ? options.services
      : Object.keys(composeServices);
  const statusMap = await getServiceStatusMap(options.composePath, process.cwd(), {
    profiles: options.profiles,
    envTool,
    cacheTtlMs: 0,
    forceRefresh: true,
    preloadedServices: targetServiceNames,
  });

  for (const serviceName of targetServiceNames) {
    const desiredService = composeServices[serviceName];
    if (desiredService === undefined) continue;

    const containerInspect = containerMap.get(serviceName);
    services.push(
      buildServiceDrift(serviceName, desiredService, containerInspect, statusMap.get(serviceName)),
    );
  }

  const drifted = services.filter((s) => s.hasDrift).length;
  const directions = {
    composeAhead: services.filter((s) => s.hasDrift && s.direction === "compose_ahead").length,
    containerAhead: services.filter((s) => s.hasDrift && s.direction === "container_ahead").length,
    diverged: services.filter((s) => s.hasDrift && s.direction === "diverged").length,
  };

  return {
    schemaVersion: DRIFT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    composePath: options.composePath,
    services,
    summary: {
      total: services.length,
      drifted,
      unchanged: services.length - drifted,
      directions,
    },
  };
}

/**
 * Get drift details for a single service
 */
export async function getDriftForService(
  service: string,
  options: DriftOptions,
  envTool?: EnvToolExecConfig,
): Promise<ServiceDrift | undefined> {
  const result = await detectDrift({ ...options, services: [service] }, envTool);
  return result?.services[0];
}

/**
 * Whether drift includes categories that can be written back to compose.yml.
 * Runtime status is detect-only and must not trigger import mutations.
 */
export function hasImportableDrift(drift: ServiceDrift): boolean {
  return drift.categories.some((category) => category !== "runtime-status");
}

/**
 * Format a drift summary line
 */
export function formatDriftDiff(drift: ServiceDrift): string {
  if (!drift.hasDrift) {
    return `${drift.service}: unchanged`;
  }
  const categories = drift.categories.join(", ");
  return `${drift.service}: drift (${categories})`;
}
