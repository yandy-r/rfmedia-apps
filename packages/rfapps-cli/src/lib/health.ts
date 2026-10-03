/**
 * Dependency readiness polling utilities for deploy/rebuild/apply/health flows.
 */

import net from "node:net";
import { logDebug } from "@rfmedia/common";

import type { EnvToolExecConfig } from "../types/options.js";
import type {
  DependencyProbeResult,
  DependencyReadinessResult,
  DependencyReadinessSummary,
  DependencyReadinessStatus,
  ReadinessSignalAvailability,
  ReadinessSignalType,
  ReadinessPollSettings,
  ServiceVerificationSummary,
  ServiceReadinessResult,
  TargetRuntimeState,
  TargetServiceObservation,
  TargetVerificationAssurance,
  TargetVerificationResult,
} from "../types/health.js";

import {
  getComposeConfig,
  getComposeServiceDependencies,
  getRunningServiceContainerMap,
  inspectContainers,
} from "./docker.js";
import type { ComposeServiceConfig, ContainerInspect } from "./docker.js";
import { getServiceStatusMap } from "./service-status.js";

const DEFAULT_PORT_PROBE_TIMEOUT_MS = 1000;

interface HealthContainerNetwork {
  IPAddress?: string;
}

interface SharedNetworkReference {
  mode: "container" | "service";
  value: string;
  raw: string;
}

interface SharedNetworkProvider {
  inspect?: ContainerInspect;
  description: string;
  mode: string;
}

export interface WaitForDependencyReadinessOptions {
  composePath: string;
  projectName?: string;
  envFile?: string;
  targetServices: string[];
  projectDir?: string;
  profiles?: string[];
  envTool?: EnvToolExecConfig;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  poll: ReadinessPollSettings;
  waitForReady?: boolean;
  portProbeTimeoutMs?: number;
  tcpProbeMode?: "local" | "state-and-health-only";
  onProgress?: (summary: DependencyReadinessSummary) => void;
}

export interface VerifyServiceReadinessOptions {
  composePath: string;
  projectName?: string;
  envFile?: string;
  targetService: string;
  expectedImageId: string;
  projectDir?: string;
  profiles?: string[];
  envTool?: EnvToolExecConfig;
  env?: Record<string, string>;
  replaceEnv?: boolean;
  poll: ReadinessPollSettings;
  stableRunningSeconds?: number;
  portProbeTimeoutMs?: number;
  tcpProbeMode?: "local" | "state-and-health-only";
  onProgress?: (summary: ServiceVerificationSummary) => void;
}

export interface ServiceVerificationDependencies {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  inspectTarget: () => Promise<TargetServiceObservation>;
  inspectDependencies: () => Promise<DependencyReadinessSummary>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Narrow a raw `docker compose ps` state string to the closed TargetRuntimeState union.
 *
 * `undefined` maps to `"missing"`; any unrecognised string maps to `"unknown"`.
 */
export function normalizeTargetState(state: string | undefined): TargetRuntimeState {
  switch (state) {
    case "running":
    case "restarting":
    case "exited":
    case "paused":
    case "dead":
    case "created":
      return state;
    case undefined:
      return "missing";
    default:
      return "unknown";
  }
}

async function inspectTargetService(
  options: VerifyServiceReadinessOptions,
): Promise<TargetServiceObservation> {
  const projectDir = options.projectDir ?? process.cwd();
  const [statusMap, serviceContainerMap] = await Promise.all([
    getServiceStatusMap(options.composePath, projectDir, {
      projectName: options.projectName,
      envFile: options.envFile,
      envTool: options.envTool,
      env: options.env,
      replaceEnv: options.replaceEnv,
      profiles: options.profiles,
      cacheTtlMs: 0,
      forceRefresh: true,
      timeoutMs: 15_000,
    }),
    getRunningServiceContainerMap(options.composePath, {
      projectName: options.projectName,
      profiles: options.profiles,
      envFile: options.envFile,
      envTool: options.envTool,
      env: options.env,
      replaceEnv: options.replaceEnv,
      timeout: 15_000,
    }),
  ]);
  const serviceStatus = statusMap.get(options.targetService);
  const containerName = serviceContainerMap?.get(options.targetService);
  const inspected =
    containerName === undefined
      ? undefined
      : (
          await inspectContainers([containerName], {
            envTool: options.envTool,
            env: options.env,
            replaceEnv: options.replaceEnv,
            timeout: 15_000,
          })
        )?.[0];

  return {
    imageId: inspected?.Image,
    state: normalizeTargetState(serviceStatus?.state),
    exitCode: inspected?.State.ExitCode,
    health: serviceStatus?.health ?? "unknown",
  };
}

/**
 * Classify a single target observation into a readiness verdict.
 *
 * Ordering is load-bearing: terminal runtime states are tested before image and
 * exit-code assertions so degraded image telemetry can never mask a real failure.
 * A healthcheck-less target only reaches `ready` once `stableForMs` has met the
 * `stableRunningMs` soak bound.
 */
export function classifyTargetObservation(
  observation: TargetServiceObservation,
  expectedImageId: string,
  stableForMs: number,
  stableRunningMs: number,
): TargetVerificationResult {
  const assurance: TargetVerificationAssurance =
    observation.health === "none" ? "running-only" : "healthcheck";
  const imageMatches = observation.imageId === expectedImageId;
  const base = { ...observation, assurance, imageMatches, stableForMs };

  if (observation.state === "restarting") {
    return { ...base, status: "pending", reason: "restarting" };
  }
  if (observation.state === "exited" || observation.state === "dead") {
    return { ...base, status: "failed", reason: "exited" };
  }
  if (observation.state !== "running") {
    return { ...base, status: "pending", reason: "not-running" };
  }
  if (observation.imageId === undefined) {
    return { ...base, status: "pending", reason: "telemetry-unavailable" };
  }
  if (!imageMatches) {
    return { ...base, status: "pending", reason: "image-mismatch" };
  }
  if (observation.exitCode === undefined) {
    return { ...base, status: "pending", reason: "telemetry-unavailable" };
  }
  if (observation.exitCode !== 0) {
    return { ...base, status: "failed", reason: "exit-code-nonzero" };
  }
  if (observation.health === "unhealthy") {
    return { ...base, status: "failed", reason: "health-unhealthy" };
  }
  if (observation.health === "starting") {
    return { ...base, status: "pending", reason: "health-starting" };
  }
  if (observation.health === "unknown") {
    return { ...base, status: "pending", reason: "health-unknown" };
  }
  if (observation.health === "healthy") {
    return { ...base, status: "ready", reason: "ready" };
  }
  if (stableForMs < stableRunningMs) {
    return { ...base, status: "pending", reason: "stabilizing" };
  }
  return { ...base, status: "ready", reason: "ready" };
}

/**
 * True when a healthcheck-less target satisfies every non-health precondition and
 * may therefore accumulate its bounded stable-running window.
 *
 * `expectedImageId === undefined` skips the image assertion; the staged batch gate
 * has no reviewed image to compare against, whereas verifyServiceReadiness always
 * has one (VerifyServiceReadinessOptions.expectedImageId is a required string,
 * lib/health.ts:74), so passing it through is semantically identical.
 */
export function canAccumulateStableRunning(
  observation: TargetServiceObservation,
  expectedImageId: string | undefined,
): boolean {
  return (
    observation.health === "none" &&
    observation.state === "running" &&
    (expectedImageId === undefined || observation.imageId === expectedImageId) &&
    observation.exitCode === 0
  );
}

function statusPriority(status: DependencyReadinessStatus): number {
  if (status === "failed") return 3;
  if (status === "pending") return 2;
  return 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePortNumber(value: string): number | undefined {
  const match = value.match(/(\d+)(?:\/[a-z]+)?$/i);
  if (match?.[1] === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function extractPortsFromCompose(service?: ComposeServiceConfig): number[] {
  if (service === undefined) {
    return [];
  }

  const ports = new Set<number>();

  for (const rawPort of service.expose ?? []) {
    const parsed = parsePortNumber(rawPort);
    if (parsed !== undefined) {
      ports.add(parsed);
    }
  }

  for (const rawPort of service.ports ?? []) {
    const parsed = parsePortNumber(rawPort);
    if (parsed !== undefined) {
      ports.add(parsed);
    }
  }

  return [...ports];
}

function extractPortsFromInspect(container?: ContainerInspect): number[] {
  if (container === undefined) {
    return [];
  }

  const ports = new Set<number>();
  const exposed = container.Config.ExposedPorts;
  if (exposed !== undefined) {
    for (const key of Object.keys(exposed)) {
      const parsed = parsePortNumber(key);
      if (parsed !== undefined) {
        ports.add(parsed);
      }
    }
  }

  return [...ports];
}

function extractContainerIp(container?: ContainerInspect): string | undefined {
  if (container === undefined) {
    return undefined;
  }

  const networks = container.NetworkSettings.Networks;
  if (networks === undefined) {
    return undefined;
  }

  for (const details of Object.values(networks)) {
    if (!isRecord(details)) {
      continue;
    }
    const network = details as HealthContainerNetwork;
    if (typeof network.IPAddress === "string" && network.IPAddress.length > 0) {
      return network.IPAddress;
    }
  }

  return undefined;
}

function parseSharedNetworkReference(networkMode?: string): SharedNetworkReference | undefined {
  if (typeof networkMode !== "string" || networkMode.length === 0) {
    return undefined;
  }

  if (networkMode.startsWith("container:")) {
    const containerValue = networkMode.slice("container:".length).trim();
    if (containerValue.length > 0) {
      return { mode: "container", value: containerValue, raw: networkMode };
    }
  }

  if (networkMode.startsWith("service:")) {
    const serviceValue = networkMode.slice("service:".length).trim();
    if (serviceValue.length > 0) {
      return { mode: "service", value: serviceValue, raw: networkMode };
    }
  }

  return undefined;
}

function findInspectByContainerId(
  inspectById: Map<string, ContainerInspect>,
  containerId: string,
): ContainerInspect | undefined {
  const exact = inspectById.get(containerId);
  if (exact !== undefined) {
    return exact;
  }

  for (const [id, inspectData] of inspectById) {
    if (id.startsWith(containerId)) {
      return inspectData;
    }
  }

  return undefined;
}

function resolveSharedNetworkProvider(
  composeDependency: ComposeServiceConfig | undefined,
  inspectData: ContainerInspect | undefined,
  serviceContainerMap: Map<string, string> | undefined,
  inspectByName: Map<string, ContainerInspect>,
  inspectById: Map<string, ContainerInspect>,
): SharedNetworkProvider | undefined {
  const hostNetworkRef = parseSharedNetworkReference(inspectData?.HostConfig.NetworkMode);
  const composeNetworkRef = parseSharedNetworkReference(composeDependency?.network_mode);
  const sharedNetworkRef = hostNetworkRef ?? composeNetworkRef;

  if (sharedNetworkRef === undefined) {
    return undefined;
  }

  if (sharedNetworkRef.mode === "service") {
    const providerContainerName = serviceContainerMap?.get(sharedNetworkRef.value);
    const providerInspect =
      providerContainerName === undefined ? undefined : inspectByName.get(providerContainerName);
    return {
      inspect: providerInspect,
      description:
        providerContainerName === undefined
          ? `service '${sharedNetworkRef.value}'`
          : `service '${sharedNetworkRef.value}' (${providerContainerName})`,
      mode: sharedNetworkRef.raw,
    };
  }

  const providerInspect =
    findInspectByContainerId(inspectById, sharedNetworkRef.value) ??
    inspectByName.get(sharedNetworkRef.value);
  const providerName =
    providerInspect === undefined
      ? sharedNetworkRef.value
      : providerInspect.Name.replace(/^\//, "");

  return {
    inspect: providerInspect,
    description: `container '${providerName}'`,
    mode: sharedNetworkRef.raw,
  };
}

async function probeTcpPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function resolveTargetServices(
  composeServices: Record<string, ComposeServiceConfig>,
  requestedServices: string[],
): string[] {
  if (requestedServices.length === 0) {
    return Object.keys(composeServices);
  }

  for (const service of requestedServices) {
    if (composeServices[service] === undefined) {
      throw new Error(`Service '${service}' not found in compose config`);
    }
  }

  return requestedServices;
}

function buildDependencyMap(
  composeServices: Record<string, ComposeServiceConfig>,
  targetServices: string[],
): Map<string, string[]> {
  const dependenciesByService = new Map<string, string[]>();

  for (const service of targetServices) {
    const serviceConfig = composeServices[service];
    const dependencies = getComposeServiceDependencies(serviceConfig).filter(
      (dependency) => dependency !== service,
    );
    dependenciesByService.set(service, dependencies);
  }

  return dependenciesByService;
}

async function evaluateDependencies(
  composePath: string,
  projectDir: string,
  projectName: string | undefined,
  envFile: string | undefined,
  composeServices: Record<string, ComposeServiceConfig>,
  dependenciesByService: Map<string, string[]>,
  profiles: string[] | undefined,
  envTool: EnvToolExecConfig | undefined,
  env: Record<string, string> | undefined,
  replaceEnv: boolean | undefined,
  portProbeTimeoutMs: number,
  tcpProbeMode: "local" | "state-and-health-only",
): Promise<{
  serviceResults: ServiceReadinessResult[];
  totalDependencies: number;
  readyDependencies: string[];
  pendingDependencies: string[];
  failedDependencies: string[];
  signalAvailability: ReadinessSignalAvailability;
  warnings: string[];
  allReady: boolean;
}> {
  const warnings: string[] = [];
  const unavailableSignals = new Set<ReadinessSignalType>();
  const statusMap = await getServiceStatusMap(composePath, projectDir, {
    projectName,
    envFile,
    envTool,
    env,
    replaceEnv,
    profiles,
    cacheTtlMs: 0,
    forceRefresh: true,
    timeoutMs: 15_000,
  });

  const serviceContainerMap = await getRunningServiceContainerMap(composePath, {
    projectName,
    profiles,
    envFile,
    envTool,
    env,
    replaceEnv,
    timeout: 15_000,
  });

  if (serviceContainerMap === undefined) {
    unavailableSignals.add("service-container-map");
    warnings.push("Unable to retrieve running service/container map during readiness checks");
  }

  const containerNames =
    serviceContainerMap === undefined ? [] : [...new Set(serviceContainerMap.values())];

  const inspectedContainers =
    containerNames.length === 0
      ? []
      : ((await inspectContainers(containerNames, {
          envTool,
          env,
          replaceEnv,
          timeout: 15_000,
        })) ?? []);

  if (containerNames.length > 0 && inspectedContainers.length === 0) {
    unavailableSignals.add("container-inspect");
    warnings.push("Unable to inspect running containers during readiness checks");
  }

  const inspectByName = new Map<string, ContainerInspect>();
  const inspectById = new Map<string, ContainerInspect>();
  for (const container of inspectedContainers) {
    const normalizedName = container.Name.replace(/^\//, "");
    inspectByName.set(normalizedName, container);
    inspectById.set(container.Id, container);
  }

  const serviceResults: ServiceReadinessResult[] = [];
  const aggregateByDependency = new Map<string, DependencyReadinessStatus>();

  for (const [service, dependencies] of dependenciesByService) {
    const dependencyResults: DependencyReadinessResult[] = [];

    for (const dependency of dependencies) {
      const composeDependency = composeServices[dependency];
      const serviceStatus = statusMap.get(dependency);
      const containerName = serviceContainerMap?.get(dependency);
      const inspectData =
        containerName === undefined ? undefined : inspectByName.get(containerName);

      if (containerName !== undefined && inspectData === undefined) {
        unavailableSignals.add("container-inspect");
        warnings.push(
          `Missing inspect data for dependency '${dependency}' container '${containerName}'`,
        );
      }
      const probes: DependencyProbeResult[] = [];

      if (serviceStatus?.state === "running") {
        probes.push({
          type: "container-state",
          status: "ready",
          target: dependency,
          message: "container is running",
        });
      } else if (serviceStatus?.state === "exited" || serviceStatus?.state === "dead") {
        probes.push({
          type: "container-state",
          status: "failed",
          target: dependency,
          message: `container state is ${serviceStatus.state}`,
        });
      } else {
        probes.push({
          type: "container-state",
          status: "pending",
          target: dependency,
          message:
            serviceStatus === undefined
              ? "container state is unknown"
              : `container state is ${serviceStatus.state}`,
        });
      }

      if (serviceStatus?.health === "healthy") {
        probes.push({
          type: "container-health",
          status: "ready",
          target: dependency,
          message: "container health is healthy",
        });
      } else if (serviceStatus?.health === "unhealthy") {
        probes.push({
          type: "container-health",
          status: "failed",
          target: dependency,
          message: "container health is unhealthy",
        });
      } else if (serviceStatus?.health === "starting") {
        probes.push({
          type: "container-health",
          status: "pending",
          target: dependency,
          message: "container health check is starting",
        });
      } else {
        probes.push({
          type: "container-health",
          status: "ready",
          target: dependency,
          message: "no container health check configured",
        });
      }

      let portProbe: DependencyProbeResult;
      const candidatePorts = new Set<number>([
        ...extractPortsFromCompose(composeDependency),
        ...extractPortsFromInspect(inspectData),
      ]);

      if (serviceStatus?.state !== "running") {
        portProbe = {
          type: "tcp-port",
          status: "pending",
          target: dependency,
          message: "port probe skipped because dependency is not running",
        };
      } else if (candidatePorts.size === 0) {
        portProbe = {
          type: "tcp-port",
          status: "ready",
          target: dependency,
          message: "no ports exposed for probe",
        };
      } else if (tcpProbeMode === "state-and-health-only") {
        portProbe = {
          type: "tcp-port",
          status: "ready",
          target: dependency,
          message: "tcp probe skipped; using container state and health only",
        };
      } else {
        let probeHost = extractContainerIp(inspectData);
        let probeTarget = dependency;
        let skippedProbeMessage: string | undefined;

        if (probeHost === undefined) {
          const sharedNetworkProvider = resolveSharedNetworkProvider(
            composeDependency,
            inspectData,
            serviceContainerMap,
            inspectByName,
            inspectById,
          );

          if (sharedNetworkProvider !== undefined) {
            const providerIp = extractContainerIp(sharedNetworkProvider.inspect);
            if (providerIp !== undefined) {
              probeHost = providerIp;
              probeTarget = `${dependency} via ${sharedNetworkProvider.description}`;
            } else {
              skippedProbeMessage =
                `TCP probe skipped for '${dependency}': shared network provider ` +
                `${sharedNetworkProvider.description} (${sharedNetworkProvider.mode}) has no IP`;
              warnings.push(skippedProbeMessage);
            }
          }
        }

        if (probeHost === undefined && skippedProbeMessage === undefined) {
          portProbe = {
            type: "tcp-port",
            status: "pending",
            target: dependency,
            message: "container IP not available for probe",
          };
        } else if (skippedProbeMessage !== undefined) {
          portProbe = {
            type: "tcp-port",
            status: "ready",
            target: dependency,
            message: "tcp probe skipped due to unavailable shared network provider IP",
          };
        } else {
          const resolvedProbeHost = probeHost;
          if (resolvedProbeHost === undefined) {
            throw new Error("TCP probe host resolution failed unexpectedly");
          }
          let isReachable = false;
          for (const port of candidatePorts) {
            // A dependency is considered port-ready when at least one advertised
            // endpoint accepts a TCP connection.
            // eslint-disable-next-line no-await-in-loop
            const reachable = await probeTcpPort(resolvedProbeHost, port, portProbeTimeoutMs);
            if (reachable) {
              isReachable = true;
              break;
            }
          }

          portProbe = {
            type: "tcp-port",
            status: isReachable ? "ready" : "pending",
            target: probeTarget,
            message: isReachable
              ? "tcp probe succeeded"
              : "tcp probe failed for all advertised ports",
          };
        }
      }

      probes.push(portProbe);

      let dependencyStatus: DependencyReadinessStatus = "ready";
      if (probes.some((probe) => probe.status === "failed")) {
        dependencyStatus = "failed";
      } else if (probes.some((probe) => probe.status === "pending")) {
        dependencyStatus = "pending";
      }

      dependencyResults.push({
        dependency,
        containerName,
        status: dependencyStatus,
        probes,
      });

      const previous = aggregateByDependency.get(dependency);
      if (previous === undefined || statusPriority(dependencyStatus) > statusPriority(previous)) {
        aggregateByDependency.set(dependency, dependencyStatus);
      }
    }

    serviceResults.push({
      service,
      dependencies: dependencyResults,
    });
  }

  const readyDependencies = [...aggregateByDependency.entries()]
    .filter(([, status]) => status === "ready")
    .map(([dependency]) => dependency)
    .sort();
  const pendingDependencies = [...aggregateByDependency.entries()]
    .filter(([, status]) => status === "pending")
    .map(([dependency]) => dependency)
    .sort();
  const failedDependencies = [...aggregateByDependency.entries()]
    .filter(([, status]) => status === "failed")
    .map(([dependency]) => dependency)
    .sort();

  const totalDependencies = aggregateByDependency.size;
  const allReady = totalDependencies === 0 || readyDependencies.length === totalDependencies;
  const signalAvailability: ReadinessSignalAvailability = {
    available: unavailableSignals.size === 0,
    unavailableSignals: [...unavailableSignals].sort(),
  };

  return {
    serviceResults,
    totalDependencies,
    readyDependencies,
    pendingDependencies,
    failedDependencies,
    signalAvailability,
    warnings,
    allReady,
  };
}

function buildProgressSignature(summary: DependencyReadinessSummary): string {
  return [
    summary.readyDependencies.join(","),
    summary.pendingDependencies.join(","),
    summary.failedDependencies.join(","),
  ].join("|");
}

/**
 * Wait for dependencies to become ready using health-state and TCP probes.
 */
export async function waitForDependencyReadiness(
  options: WaitForDependencyReadinessOptions,
): Promise<DependencyReadinessSummary> {
  const composeConfig = await getComposeConfig(options.composePath, {
    projectName: options.projectName,
    profiles: options.profiles,
    envFile: options.envFile,
    envTool: options.envTool,
    env: options.env,
    replaceEnv: options.replaceEnv,
    timeout: 30_000,
  });

  if (composeConfig === undefined) {
    throw new Error("Unable to load docker compose configuration for readiness checks");
  }

  const targetServices = resolveTargetServices(composeConfig.services, options.targetServices);
  const dependenciesByService = buildDependencyMap(composeConfig.services, targetServices);

  const waitForReady = options.waitForReady ?? true;
  const projectDir = options.projectDir ?? process.cwd();
  const timeoutMs = options.poll.timeoutSeconds * 1000;
  const intervalMs = options.poll.intervalSeconds * 1000;
  const maxAttempts = options.poll.retries;
  const portProbeTimeoutMs = options.portProbeTimeoutMs ?? DEFAULT_PORT_PROBE_TIMEOUT_MS;
  const tcpProbeMode = options.tcpProbeMode ?? "local";

  const startedAt = Date.now();
  let attempt = 0;
  let previousSignature = "";

  while (true) {
    attempt += 1;

    const evaluation = await evaluateDependencies(
      options.composePath,
      projectDir,
      options.projectName,
      options.envFile,
      composeConfig.services,
      dependenciesByService,
      options.profiles,
      options.envTool,
      options.env,
      options.replaceEnv,
      portProbeTimeoutMs,
      tcpProbeMode,
    );

    const elapsedMs = Date.now() - startedAt;
    const shouldTimeOut =
      waitForReady && !evaluation.allReady && (elapsedMs >= timeoutMs || attempt >= maxAttempts);

    const summary: DependencyReadinessSummary = {
      ready: evaluation.allReady,
      timedOut: shouldTimeOut,
      totalDependencies: evaluation.totalDependencies,
      readyDependencies: evaluation.readyDependencies,
      pendingDependencies: evaluation.pendingDependencies,
      failedDependencies: evaluation.failedDependencies,
      elapsedMs,
      attempts: attempt,
      services: evaluation.serviceResults,
      signalAvailability: evaluation.signalAvailability,
      warnings: evaluation.warnings.length > 0 ? evaluation.warnings : undefined,
    };

    if (options.onProgress !== undefined) {
      const signature = buildProgressSignature(summary);
      if (signature !== previousSignature || summary.ready || summary.timedOut) {
        previousSignature = signature;
        options.onProgress(summary);
      }
    }

    if (summary.ready) {
      return summary;
    }

    if (!waitForReady) {
      return summary;
    }

    if (summary.timedOut) {
      return summary;
    }

    logDebug(
      `Dependency readiness pending (attempt ${attempt}/${maxAttempts}, elapsed ${elapsedMs}ms)`,
    );
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
}

/**
 * Verify one target service against its reviewed image and runtime readiness.
 * Direct-dependency readiness is retained as supplementary evidence and cannot
 * make an unready target pass.
 */
export async function verifyServiceReadiness(
  options: VerifyServiceReadinessOptions,
  injected: Partial<ServiceVerificationDependencies> = {},
): Promise<ServiceVerificationSummary> {
  const now = injected.now ?? Date.now;
  const pollSleep = injected.sleep ?? sleep;
  const inspectTarget = injected.inspectTarget ?? (() => inspectTargetService(options));
  const inspectDependencies =
    injected.inspectDependencies ??
    (() =>
      waitForDependencyReadiness({
        composePath: options.composePath,
        projectName: options.projectName,
        envFile: options.envFile,
        targetServices: [options.targetService],
        projectDir: options.projectDir,
        profiles: options.profiles,
        envTool: options.envTool,
        env: options.env,
        replaceEnv: options.replaceEnv,
        poll: { ...options.poll, retries: 1 },
        waitForReady: false,
        portProbeTimeoutMs: options.portProbeTimeoutMs,
        tcpProbeMode: options.tcpProbeMode,
      }));

  const timeoutMs = options.poll.timeoutSeconds * 1000;
  const intervalMs = options.poll.intervalSeconds * 1000;
  const maxAttempts = Math.max(1, options.poll.retries);
  const stableRunningMs = (options.stableRunningSeconds ?? 5) * 1000;
  const startedAt = now();
  let stableSince: number | undefined;

  for (let attempt = 1; ; attempt += 1) {
    // Target and dependency observations are independent Docker snapshots.
    // eslint-disable-next-line no-await-in-loop
    const [observation, dependencies] = await Promise.all([inspectTarget(), inspectDependencies()]);
    const observedAt = now();
    const canAccumulateStability = canAccumulateStableRunning(observation, options.expectedImageId);

    if (canAccumulateStability) {
      stableSince ??= observedAt;
    } else {
      stableSince = undefined;
    }

    const stableForMs = stableSince === undefined ? 0 : observedAt - stableSince;
    const target = classifyTargetObservation(
      observation,
      options.expectedImageId,
      stableForMs,
      stableRunningMs,
    );
    const elapsedMs = observedAt - startedAt;
    const ready = target.status === "ready" && dependencies.ready;
    const timedOut = !ready && (elapsedMs >= timeoutMs || attempt >= maxAttempts);
    const summary: ServiceVerificationSummary = {
      service: options.targetService,
      expectedImageId: options.expectedImageId,
      ready,
      timedOut,
      assurance: target.assurance,
      target,
      dependencies,
      elapsedMs,
      attempts: attempt,
    };

    options.onProgress?.(summary);

    if (ready || timedOut) {
      return summary;
    }

    logDebug(
      `Service verification pending for ${options.targetService} ` +
        `(attempt ${attempt}/${maxAttempts}, elapsed ${elapsedMs}ms)`,
    );
    // eslint-disable-next-line no-await-in-loop
    await pollSleep(intervalMs);
  }
}
