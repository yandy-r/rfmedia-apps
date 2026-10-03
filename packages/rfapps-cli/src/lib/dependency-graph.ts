/**
 * Dependency graph module for parallel service execution.
 *
 * Builds a service dependency graph from Docker Compose `depends_on` declarations,
 * implicit `network_mode: service:<name>` dependencies, and sidecar pair mappings.
 * Performs topological sort via Kahn's algorithm to produce execution phases where
 * services within each phase can execute concurrently.
 *
 * This module is pure functional -- all functions accept data and return results
 * without side effects.
 *
 * @module rfapps-cli/lib/dependency-graph
 */

import type { RfappsConfig } from "../types/config.js";
import type { EnvToolExecConfig } from "../types/options.js";
import type { DependencyGraph, ExecutionPhase } from "../types/parallel.js";
import { getComposeConfig, getComposeServiceDependencies } from "./docker.js";
import type { ComposeServiceConfig } from "./docker.js";

export type EffectiveServiceClosureErrorCode = "MISSING_SERVICE_REFERENCE" | "DEPENDENCY_CYCLE";

/** Typed failure raised when a resolved Compose service graph is not safe to use. */
export class EffectiveServiceClosureError extends Error {
  override readonly name = "EffectiveServiceClosureError";
  readonly services: readonly string[];

  constructor(
    message: string,
    readonly code: EffectiveServiceClosureErrorCode,
    services: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.services = [...services];
  }
}

type ServiceVisitState = "visiting" | "visited";

interface EffectiveServiceDependencyConfig {
  readonly depends_on?: readonly string[] | Readonly<Record<string, unknown>>;
  readonly network_mode?: string;
}

function compareServiceNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function getEffectiveServiceDependencies(service: EffectiveServiceDependencyConfig): string[] {
  const dependsOn = service.depends_on;
  const dependencies = new Set(
    dependsOn === undefined
      ? []
      : Array.isArray(dependsOn)
        ? dependsOn.filter((name): name is string => typeof name === "string")
        : Object.keys(dependsOn),
  );
  const networkModeMatch =
    service.network_mode === undefined ? null : /^service:(.+)$/u.exec(service.network_mode);
  const networkProvider = networkModeMatch?.[1];

  if (networkProvider !== undefined) {
    dependencies.add(networkProvider);
  }

  return [...dependencies].sort(compareServiceNames);
}

/**
 * Resolve the concrete service scope used by fail-closed safety checks.
 *
 * Targeted scopes expand through transitive `depends_on` and
 * `network_mode: service:<name>` references. An empty target scope means every
 * concrete service present in the already-resolved Compose model. Missing
 * services and dependency cycles throw instead of producing partial evidence.
 */
export function resolveEffectiveServiceClosure(
  composeServices: Readonly<Record<string, EffectiveServiceDependencyConfig>>,
  targetServices: readonly string[],
): string[] {
  const roots =
    targetServices.length === 0
      ? Object.keys(composeServices).sort(compareServiceNames)
      : [...new Set(targetServices)].sort(compareServiceNames);
  const closure = new Set<string>();
  const visitStates = new Map<string, ServiceVisitState>();
  const visitPath: string[] = [];
  const visitPathIndexes = new Map<string, number>();

  const visit = (serviceName: string, referencedBy?: string): void => {
    if (!Object.hasOwn(composeServices, serviceName)) {
      const message =
        referencedBy === undefined
          ? `Selected service "${serviceName}" is missing from resolved Compose services`
          : `Service "${referencedBy}" references missing service "${serviceName}"`;
      const services = referencedBy === undefined ? [serviceName] : [referencedBy, serviceName];
      throw new EffectiveServiceClosureError(message, "MISSING_SERVICE_REFERENCE", services);
    }

    const state = visitStates.get(serviceName);
    if (state === "visited") {
      return;
    }
    if (state === "visiting") {
      const cycleStart = visitPathIndexes.get(serviceName) ?? 0;
      const cycleServices = [...visitPath.slice(cycleStart), serviceName];
      throw new EffectiveServiceClosureError(
        `Effective service dependency cycle detected: ${cycleServices.join(" -> ")}`,
        "DEPENDENCY_CYCLE",
        cycleServices,
      );
    }

    const service = composeServices[serviceName];
    if (service === undefined) {
      throw new EffectiveServiceClosureError(
        `Selected service "${serviceName}" is missing from resolved Compose services`,
        "MISSING_SERVICE_REFERENCE",
        [serviceName],
      );
    }

    visitStates.set(serviceName, "visiting");
    visitPathIndexes.set(serviceName, visitPath.length);
    visitPath.push(serviceName);

    for (const dependency of getEffectiveServiceDependencies(service)) {
      visit(dependency, serviceName);
    }

    visitPath.pop();
    visitPathIndexes.delete(serviceName);
    visitStates.set(serviceName, "visited");
    closure.add(serviceName);
  };

  for (const serviceName of roots) {
    visit(serviceName);
  }

  return [...closure].sort(compareServiceNames);
}

/**
 * Build a service dependency graph from compose config, sidecar mappings, and target services.
 *
 * Extracts dependencies from three sources:
 * 1. `depends_on` declarations in compose config
 * 2. Implicit `network_mode: service:<name>` dependencies
 * 3. Sidecar pair merging from config mapping (shared external deps propagated to both members)
 *
 * Only dependencies within the `targetServices` set are included.
 *
 * `network_mode: service:<X>` dependencies are tracked separately and preserved through
 * the sidecar-merge step so that the correct startup ordering is maintained: the network
 * namespace provider (X) must be fully running before the service that mounts its namespace.
 *
 * @param composeConfig - Parsed compose config from `getComposeConfig()`
 * @param sidecarMapping - Map of service name to sidecar name from config
 * @param targetServices - Services being operated on (dependency filtering scope)
 * @returns Map of service name to its dependencies within the target set
 */
export function buildServiceDependencyGraph(
  composeConfig: { services: Record<string, ComposeServiceConfig> },
  sidecarMapping: Record<string, string>,
  targetServices: string[],
): Map<string, string[]> {
  const targetSet = new Set(targetServices);
  const dependencyMap = new Map<string, string[]>();
  // Track network_mode deps separately so they are never merged away.
  // Key: service that uses network_mode; Value: the service whose namespace it mounts.
  const networkModeDeps = new Map<string, string>();

  // Step 1: Extract raw dependencies for each target service
  for (const service of targetServices) {
    const serviceConfig = composeConfig.services[service];
    const deps = new Set<string>();

    // Extract depends_on dependencies
    const dependsOnDeps = getComposeServiceDependencies(serviceConfig);
    for (const dep of dependsOnDeps) {
      if (dep !== service) {
        deps.add(dep);
      }
    }

    // Extract implicit network_mode: service:<name> dependencies
    if (serviceConfig?.network_mode !== undefined) {
      const networkModeMatch = /^service:(.+)$/.exec(serviceConfig.network_mode);
      if (networkModeMatch !== null && networkModeMatch[1] !== undefined) {
        const networkDep = networkModeMatch[1];
        if (networkDep !== service) {
          deps.add(networkDep);
          networkModeDeps.set(service, networkDep);
        }
      }
    }

    dependencyMap.set(service, [...deps]);
  }

  // Step 2: Propagate shared external deps to both sidecar pair members while
  // preserving each member's own network_mode ordering constraint.
  mergeSidecarDependencies(dependencyMap, sidecarMapping, targetSet, networkModeDeps);

  // Step 3: Filter dependencies to only include services within the target set
  for (const [service, deps] of dependencyMap) {
    dependencyMap.set(
      service,
      deps.filter((dep) => targetSet.has(dep)),
    );
  }

  return dependencyMap;
}

/**
 * Propagate shared external dependencies to both sidecar pair members while
 * preserving each member's own `network_mode` ordering constraint.
 *
 * For each sidecar pair (main + sidecar):
 * - Compute the union of their external deps (deps that are not the partner).
 * - Re-apply each member's own `network_mode` dep on top of the shared union.
 *
 * This ensures that both members inherit each other's external readiness
 * requirements (so they land in the same phase when there is no network_mode
 * relationship between them), while still preserving the startup ordering
 * required by `network_mode: service:<partner>` (the provider must start first).
 */
function mergeSidecarDependencies(
  dependencyMap: Map<string, string[]>,
  sidecarMapping: Record<string, string>,
  targetSet: Set<string>,
  networkModeDeps: Map<string, string>,
): void {
  for (const [mainService, sidecar] of Object.entries(sidecarMapping)) {
    if (!targetSet.has(mainService) || !targetSet.has(sidecar)) {
      continue;
    }

    const mainDeps = dependencyMap.get(mainService) ?? [];
    const sidecarDeps = dependencyMap.get(sidecar) ?? [];

    // Compute the union of external deps (everything except the pair partner).
    const sharedExternalDeps = new Set<string>();
    for (const dep of mainDeps) {
      if (dep !== sidecar && dep !== mainService) {
        sharedExternalDeps.add(dep);
      }
    }
    for (const dep of sidecarDeps) {
      if (dep !== mainService && dep !== sidecar) {
        sharedExternalDeps.add(dep);
      }
    }

    // Re-apply each member's own network_mode dep so the ordering constraint
    // (provider starts before consumer) is never lost during the merge.
    const newMainDeps = [...sharedExternalDeps];
    const mainNetworkDep = networkModeDeps.get(mainService);
    if (mainNetworkDep !== undefined && !newMainDeps.includes(mainNetworkDep)) {
      newMainDeps.push(mainNetworkDep);
    }

    const newSidecarDeps = [...sharedExternalDeps];
    const sidecarNetworkDep = networkModeDeps.get(sidecar);
    if (sidecarNetworkDep !== undefined && !newSidecarDeps.includes(sidecarNetworkDep)) {
      newSidecarDeps.push(sidecarNetworkDep);
    }

    dependencyMap.set(mainService, newMainDeps);
    dependencyMap.set(sidecar, newSidecarDeps);
  }
}

/**
 * Invert a forward dependency map into `service -> services that depend on it`.
 *
 * Shared by staged rollout (fan-in counts) and plan intelligence (dependent
 * names + transitive closure) so both agree on what an edge is.
 *
 * Only services that have at least one dependent appear as keys, so callers
 * reading a leaf service must default to an empty list.
 *
 * @param dependencyMap - forward map from `buildServiceDependencyGraph`
 * @returns code-point-sorted dependent lists; pure, no I/O
 */
export function invertDependencyMap(
  dependencyMap: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const dependentSets = new Map<string, Set<string>>();
  for (const [service, dependencies] of dependencyMap) {
    for (const dependency of dependencies) {
      const dependents = dependentSets.get(dependency);
      if (dependents === undefined) {
        dependentSets.set(dependency, new Set([service]));
        continue;
      }
      dependents.add(service);
    }
  }

  const inverted = new Map<string, readonly string[]>();
  for (const [dependency, dependents] of dependentSets) {
    inverted.set(dependency, [...dependents].sort());
  }
  return inverted;
}

/**
 * Perform topological sort using Kahn's algorithm to produce execution phases.
 *
 * Services are grouped into phases where:
 * - Phase 0: all services with no dependencies (in-degree 0)
 * - Phase N: services whose dependencies are all in phases < N
 *
 * In-degree for a service is the count of its direct dependencies.
 * Edges go from dependency -> dependent (if B depends on A, edge is A -> B).
 * So in-degree(B) equals the number of services B depends on.
 *
 * If a cycle is detected (unprocessed nodes remain after algorithm completes),
 * `hasCycles` is true and `cycleServices` lists the involved services.
 *
 * @param dependencyMap - Map of service name to its dependency list
 * @param sidecarMapping - Map of main service to sidecar from config (for phase alignment)
 * @returns DependencyGraph with phases, cycle detection, and cycle services
 */
export function topologicalSort(
  dependencyMap: Map<string, string[]>,
  sidecarMapping: Record<string, string>,
): DependencyGraph {
  if (dependencyMap.size === 0) {
    return { phases: [], hasCycles: false };
  }

  // Build in-degree map: in-degree(service) = number of its dependencies
  const inDegree = new Map<string, number>();
  for (const [service, deps] of dependencyMap) {
    inDegree.set(service, deps.length);
  }

  // Kahn's algorithm with phase grouping
  const phases: ExecutionPhase[] = [];
  const processed = new Set<string>();

  // Find initial nodes with in-degree 0 (no dependencies)
  let currentPhaseNodes: string[] = [];
  for (const [service, degree] of inDegree) {
    if (degree === 0) {
      currentPhaseNodes.push(service);
    }
  }

  let phaseNumber = 0;

  while (currentPhaseNodes.length > 0) {
    // Sort for deterministic output
    currentPhaseNodes.sort();

    // Compute dependsOn for this phase: all services in prior phases that
    // any service in this phase depends on
    const dependsOn = new Set<string>();
    for (const service of currentPhaseNodes) {
      const deps = dependencyMap.get(service) ?? [];
      for (const dep of deps) {
        if (processed.has(dep)) {
          dependsOn.add(dep);
        }
      }
    }

    const phase: ExecutionPhase = {
      phase: phaseNumber,
      services: [...currentPhaseNodes],
      dependsOn: [...dependsOn].sort(),
    };
    phases.push(phase);

    // Mark current phase nodes as processed
    for (const node of currentPhaseNodes) {
      processed.add(node);
    }

    // Find next phase: reduce in-degree for dependents of processed nodes
    const nextPhaseNodes: string[] = [];
    for (const processedNode of currentPhaseNodes) {
      // Find all services that depend on this processed node
      for (const [service, deps] of dependencyMap) {
        if (processed.has(service)) continue;
        if (deps.includes(processedNode)) {
          const newDegree = (inDegree.get(service) ?? 0) - 1;
          inDegree.set(service, newDegree);
          if (newDegree === 0 && !nextPhaseNodes.includes(service)) {
            nextPhaseNodes.push(service);
          }
        }
      }
    }

    currentPhaseNodes = nextPhaseNodes;
    phaseNumber++;
  }

  // Check for cycles: if any nodes remain unprocessed
  const allServices = new Set(dependencyMap.keys());
  const unprocessed = [...allServices].filter((s) => !processed.has(s));

  if (unprocessed.length > 0) {
    return {
      phases,
      hasCycles: true,
      cycleServices: unprocessed.sort(),
    };
  }

  // Enforce sidecar atomicity: ensure sidecar pairs are in the same phase
  return enforceSidecarPhaseAlignment(phases, dependencyMap, sidecarMapping);
}

/**
 * Ensure sidecar pairs are in the same execution phase.
 *
 * After topological sort, sidecar pairs should already be in the same phase
 * because their dependencies were merged. This function validates and corrects
 * any remaining misalignment by elevating the lower-phase member to match
 * the higher-phase member. Pairs are identified from config sidecar mapping,
 * not from dependency equality.
 */
function enforceSidecarPhaseAlignment(
  phases: ExecutionPhase[],
  dependencyMap: Map<string, string[]>,
  sidecarMapping: Record<string, string>,
): DependencyGraph {
  // Build service -> phase mapping
  const servicePhase = new Map<string, number>();
  for (const phase of phases) {
    for (const service of phase.services) {
      servicePhase.set(service, phase.phase);
    }
  }

  // Find misaligned sidecar pairs using config mapping (only pairs where both
  // are in the graph and in different phases)
  const pairsToAlign: Array<[string, string]> = [];
  for (const [main, sidecar] of Object.entries(sidecarMapping)) {
    const phaseMain = servicePhase.get(main);
    const phaseSidecar = servicePhase.get(sidecar);
    if (phaseMain !== undefined && phaseSidecar !== undefined && phaseMain !== phaseSidecar) {
      pairsToAlign.push([main, sidecar]);
    }
  }

  // If no misalignment found, return as-is
  if (pairsToAlign.length === 0) {
    return { phases, hasCycles: false };
  }

  // Move lower-phase member to higher-phase member's phase
  for (const [serviceA, serviceB] of pairsToAlign) {
    const phaseA = servicePhase.get(serviceA);
    const phaseB = servicePhase.get(serviceB);
    if (phaseA === undefined || phaseB === undefined) continue;

    const targetPhase = Math.max(phaseA, phaseB);
    const sourceService = phaseA < phaseB ? serviceA : serviceB;
    const sourcePhase = Math.min(phaseA, phaseB);
    const higherService = phaseA > phaseB ? serviceA : serviceB;

    // When the higher-phase service explicitly depends on the lower-phase service
    // (e.g. via network_mode: service:<sidecar>), the phase gap is intentional:
    // the provider must be fully running before the consumer starts.
    // Forcing them into the same phase would reintroduce the race condition.
    const higherServiceDeps = dependencyMap.get(higherService) ?? [];
    if (higherServiceDeps.includes(sourceService)) {
      continue;
    }

    // Remove from source phase
    const srcPhaseObj = phases.find((p) => p.phase === sourcePhase);
    if (srcPhaseObj !== undefined) {
      srcPhaseObj.services = srcPhaseObj.services.filter((s) => s !== sourceService);
    }

    // Add to target phase
    const tgtPhaseObj = phases.find((p) => p.phase === targetPhase);
    if (tgtPhaseObj !== undefined && !tgtPhaseObj.services.includes(sourceService)) {
      tgtPhaseObj.services.push(sourceService);
      tgtPhaseObj.services.sort();
    }

    servicePhase.set(sourceService, targetPhase);
  }

  // Remove empty phases and re-number
  const nonEmptyPhases = phases.filter((p) => p.services.length > 0);
  for (let i = 0; i < nonEmptyPhases.length; i++) {
    const phase = nonEmptyPhases[i];
    if (phase !== undefined) {
      phase.phase = i;
    }
  }

  // Recompute dependsOn for each phase
  const processedServices = new Set<string>();
  for (const phase of nonEmptyPhases) {
    const dependsOn = new Set<string>();
    for (const service of phase.services) {
      const deps = dependencyMap.get(service) ?? [];
      for (const dep of deps) {
        if (processedServices.has(dep)) {
          dependsOn.add(dep);
        }
      }
    }
    phase.dependsOn = [...dependsOn].sort();
    for (const service of phase.services) {
      processedServices.add(service);
    }
  }

  return { phases: nonEmptyPhases, hasCycles: false };
}

/**
 * Compute execution phases for a set of target services.
 *
 * High-level orchestrator that:
 * 1. Parses compose config from the compose file
 * 2. Extracts sidecar mapping from config
 * 3. Builds the service dependency graph
 * 4. Performs topological sort to produce execution phases
 *
 * @param composePath - Path to the Docker Compose file
 * @param config - rfapps configuration containing sidecar mappings
 * @param targetServices - Services to compute phases for
 * @param envTool - Optional secrets-injection config so `docker compose config`
 *   resolves environment variables (e.g. via dotenvx). Without it, interpolated
 *   variables like `${DOCKER_DIR}` are unset and the config call fails.
 * @returns DependencyGraph with execution phases; check `hasCycles` for errors
 */
export async function computeExecutionPhases(
  composePath: string,
  config: RfappsConfig,
  targetServices: string[],
  envTool?: EnvToolExecConfig,
): Promise<DependencyGraph> {
  if (targetServices.length === 0) {
    return { phases: [], hasCycles: false };
  }

  const composeConfig = await getComposeConfig(composePath, { envTool });
  if (composeConfig === undefined) {
    // If compose config cannot be parsed, treat all services as independent (Phase 0)
    return {
      phases: [
        {
          phase: 0,
          services: [...targetServices].sort(),
          dependsOn: [],
        },
      ],
      hasCycles: false,
    };
  }

  const sidecarMapping = config.sidecars.mapping;
  const dependencyMap = buildServiceDependencyGraph(composeConfig, sidecarMapping, targetServices);
  const graph = topologicalSort(dependencyMap, sidecarMapping);
  if (!graph.hasCycles) {
    return { ...graph, dependencyMap };
  }
  return graph;
}
