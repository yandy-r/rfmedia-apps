import { posix } from "node:path";

import type {
  BackupBindMountIdentity,
  BackupBindTopologyProbeResult,
  BackupConsumer,
  BackupPlan,
  BackupPlannedMount,
  BackupPreflightFailureCode,
  BackupSkippedSource,
  BackupSource,
  BackupSourceProbeResult,
  BackupWarning,
} from "../types/backup.js";
import type {
  CanonicalComposeConfig,
  CanonicalComposeConfigEvidence,
  CanonicalComposeMountConfig,
  CanonicalComposeServiceConfig,
} from "./docker-conflict-evidence.js";
import {
  EffectiveServiceClosureError,
  resolveEffectiveServiceClosure,
  topologicalSort,
} from "./dependency-graph.js";

export type BackupPlannerErrorCode =
  | BackupPreflightFailureCode
  | "DEPENDENCY_CYCLE"
  | "SERVICE_NOT_FOUND"
  | "INVALID_SCOPE";

/** Sanitized fail-closed planning error. */
export class BackupPlannerError extends Error {
  override readonly name = "BackupPlannerError";

  constructor(
    message: string,
    readonly code: BackupPlannerErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface BackupPlannerDependencies {
  readonly probeSource: (source: BackupSource) => Promise<BackupSourceProbeResult>;
  readonly probeBindTopology: (
    sourcePaths: readonly string[],
  ) => Promise<BackupBindTopologyProbeResult>;
}

export interface BackupPlannerInput {
  readonly composeEvidence: CanonicalComposeConfigEvidence;
  readonly requestedServices: readonly string[];
  readonly canonicalDestination: string;
  readonly dockerAuthorityFingerprint: string;
  readonly localDockerAuthority: boolean;
}

interface Candidate {
  readonly key: string;
  readonly source: BackupSource;
}

interface PendingSkip {
  readonly key: string;
  readonly mountType: string;
  readonly reasonCode: BackupSkippedSource["reasonCode"];
  readonly source?: string;
  readonly consumers: BackupConsumer[];
}

const SYSTEM_WARNINGS: readonly BackupWarning[] = [
  {
    code: "APPLICATION_CONSISTENCY_NOT_GUARANTEED",
    message: "Filesystem archives do not provide application-native database consistency.",
  },
  {
    code: "EXTERNAL_WRITERS_NOT_QUIESCED",
    message: "Host processes and writers outside the resolved Compose project are not excluded.",
  },
  {
    code: "INTEGRITY_NOT_AUTHENTICITY",
    message: "SHA-256 verifies archive bytes but does not authenticate their origin.",
  },
];
const EMPTY_BIND_TOPOLOGY_FINGERPRINT =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: BackupPlannerErrorCode, message: string, cause?: unknown): never {
  throw new BackupPlannerError(message, code, cause === undefined ? undefined : { cause });
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function assertSafeRequestedServices(
  services: readonly string[],
  compose: CanonicalComposeConfig,
): string[] {
  const requested = uniqueSorted(services);
  if (requested.length === 0) fail("INVALID_SCOPE", "Backup requires an explicit service scope");
  for (const name of requested) {
    if (!Object.hasOwn(compose.services, name)) {
      fail("SERVICE_NOT_FOUND", "A requested service is absent from resolved Compose evidence");
    }
  }
  return requested;
}

function resolveServices(compose: CanonicalComposeConfig, requested: readonly string[]): string[] {
  try {
    return resolveEffectiveServiceClosure(compose.services, requested);
  } catch (error) {
    if (error instanceof EffectiveServiceClosureError) {
      fail(
        error.code === "DEPENDENCY_CYCLE" ? "DEPENDENCY_CYCLE" : "SERVICE_NOT_FOUND",
        error.code === "DEPENDENCY_CYCLE"
          ? "The selected service dependency graph contains a cycle"
          : "The selected service dependency graph references a missing service",
        error,
      );
    }
    throw error;
  }
}

function requireCanonicalBindPath(path: string | undefined): string {
  if (
    path === undefined ||
    !path.startsWith("/") ||
    path === "/" ||
    posix.normalize(path) !== path ||
    path.endsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    fail("AMBIGUOUS_BIND_PATH", "A bind source path is not canonical and unambiguous");
  }
  return path;
}

function isSameOrDescendant(path: string, root: string): boolean {
  return path === root || (root === "/" ? path.startsWith("/") : path.startsWith(`${root}/`));
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function identitiesEqual(left: BackupBindMountIdentity, right: BackupBindMountIdentity): boolean {
  return left.majorMinor === right.majorMinor && left.mountRoot === right.mountRoot;
}

function identitiesOverlap(left: BackupBindMountIdentity, right: BackupBindMountIdentity): boolean {
  return left.majorMinor === right.majorMinor && pathsOverlap(left.mountRoot, right.mountRoot);
}

function consumer(
  serviceName: string,
  mount: Pick<CanonicalComposeMountConfig, "target" | "read_only">,
): BackupConsumer {
  return { service: serviceName, target: mount.target, readOnly: mount.read_only };
}

function compareConsumers(left: BackupConsumer, right: BackupConsumer): number {
  return (
    compare(left.service, right.service) ||
    compare(left.target, right.target) ||
    Number(left.readOnly) - Number(right.readOnly)
  );
}

function uniqueConsumers(consumers: readonly BackupConsumer[]): BackupConsumer[] {
  const byIdentity = new Map<string, BackupConsumer>();
  for (const item of consumers) {
    byIdentity.set(`${item.service}\0${item.target}\0${String(item.readOnly)}`, item);
  }
  return [...byIdentity.values()].sort(compareConsumers);
}

function volumeSource(
  compose: CanonicalComposeConfig,
  sourceKey: string | undefined,
): BackupSource {
  if (sourceKey === undefined) {
    fail("ANONYMOUS_VOLUME", "Anonymous volumes are not supported by native backup");
  }
  const definition = compose.volumes[sourceKey];
  if (definition === undefined) {
    fail(
      "NAMED_VOLUME_MISSING",
      "A selected named volume is absent from resolved Compose evidence",
    );
  }
  return {
    kind: "volume",
    name: definition.name,
    driver: definition.driver,
    external: definition.external,
  };
}

function sourceKey(source: BackupSource): string {
  return source.kind === "bind" ? `bind\0${source.path}` : `volume\0${source.name}`;
}

function selectedCandidates(
  compose: CanonicalComposeConfig,
  resolvedServices: readonly string[],
): { candidates: Candidate[]; skips: PendingSkip[] } {
  const candidates = new Map<string, Candidate>();
  const skips: PendingSkip[] = [];
  for (const serviceName of resolvedServices) {
    const service = compose.services[serviceName];
    if (service === undefined) fail("SERVICE_NOT_FOUND", "A resolved service is missing");
    if ((service.unsupported_volumes?.length ?? 0) > 0) {
      fail("UNSUPPORTED_MOUNT_TYPE", "A selected service uses an unsupported mount type");
    }
    for (const mount of service.volumes) {
      if (typeof mount === "string") {
        fail("UNSUPPORTED_MOUNT_TYPE", "Short-form Compose mounts are not valid backup evidence");
      }
      if (mount.type === "tmpfs") {
        skips.push({
          key: `tmpfs\0${serviceName}\0${mount.target}`,
          mountType: "tmpfs",
          reasonCode: "NON_PERSISTENT_TMPFS",
          consumers: [consumer(serviceName, mount)],
        });
        continue;
      }
      const source: BackupSource =
        mount.type === "bind"
          ? { kind: "bind", path: requireCanonicalBindPath(mount.source) }
          : volumeSource(compose, mount.source);
      candidates.set(sourceKey(source), { key: sourceKey(source), source });
    }
  }
  return { candidates: [...candidates.values()].sort((a, b) => compare(a.key, b.key)), skips };
}

function effectiveVolumeName(
  compose: CanonicalComposeConfig,
  mount: CanonicalComposeMountConfig,
): string | undefined {
  if (mount.type !== "volume" || mount.source === undefined) return undefined;
  return compose.volumes[mount.source]?.name;
}

function exactConsumers(
  compose: CanonicalComposeConfig,
  source: BackupSource,
  topology?: ReadonlyMap<string, BackupBindMountIdentity>,
): BackupConsumer[] {
  const consumers: BackupConsumer[] = [];
  const selectedIdentity = source.kind === "bind" ? topology?.get(source.path) : undefined;
  for (const [serviceName, service] of Object.entries(compose.services)) {
    for (const mount of service.volumes) {
      if (typeof mount === "string") continue;
      const matches =
        source.kind === "bind"
          ? mount.type === "bind" &&
            (mount.source === source.path ||
              (selectedIdentity !== undefined &&
                topology?.get(mount.source ?? "") !== undefined &&
                identitiesEqual(
                  selectedIdentity,
                  topology.get(mount.source ?? "") as BackupBindMountIdentity,
                )))
          : effectiveVolumeName(compose, mount) === source.name;
      if (matches) consumers.push(consumer(serviceName, mount));
    }
  }
  return uniqueConsumers(consumers);
}

function overlappingBindWriters(
  compose: CanonicalComposeConfig,
  selectedPath: string,
  topology: ReadonlyMap<string, BackupBindMountIdentity>,
): string[] {
  const writers = new Set<string>();
  const selectedIdentity = topology.get(selectedPath);
  if (selectedIdentity === undefined) {
    fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
  }
  for (const [serviceName, service] of Object.entries(compose.services)) {
    for (const mount of service.volumes) {
      if (typeof mount === "string" || mount.type !== "bind" || mount.read_only) continue;
      const path = requireCanonicalBindPath(mount.source);
      const writerIdentity = topology.get(path);
      if (writerIdentity === undefined) {
        fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
      }
      if (pathsOverlap(path, selectedPath) || identitiesOverlap(writerIdentity, selectedIdentity)) {
        writers.add(serviceName);
      }
    }
  }
  return [...writers].sort(compare);
}

function writableBindPaths(compose: CanonicalComposeConfig): string[] {
  const paths: string[] = [];
  for (const service of Object.values(compose.services)) {
    for (const mount of service.volumes) {
      if (typeof mount === "string" || mount.type !== "bind" || mount.read_only) continue;
      paths.push(requireCanonicalBindPath(mount.source));
    }
  }
  return uniqueSorted(paths);
}

function isCanonicalMountRoot(path: string): boolean {
  return (
    path.startsWith("/") &&
    posix.normalize(path) === path &&
    (path === "/" || !path.endsWith("/")) &&
    !/[\u0000-\u001f\u007f]/u.test(path)
  );
}

function protectedSkip(path: string): BackupSkippedSource["reasonCode"] | undefined {
  if (isSameOrDescendant(path, "/dev")) return "DEVICE_SOURCE";
  if (
    isSameOrDescendant(path, "/proc") ||
    isSameOrDescendant(path, "/sys") ||
    isSameOrDescendant(path, "/run") ||
    isSameOrDescendant(path, "/var/run")
  ) {
    return "HOST_SYSTEM_PATH";
  }
  return undefined;
}

async function classifyCandidate(
  candidate: Candidate,
  compose: CanonicalComposeConfig,
  dependencies: BackupPlannerDependencies,
): Promise<
  | { readonly kind: "mount"; readonly source: BackupSource; readonly consumers: BackupConsumer[] }
  | { readonly kind: "skip"; readonly skip: PendingSkip }
> {
  const consumers = exactConsumers(compose, candidate.source);
  const bindPath = candidate.source.kind === "bind" ? candidate.source.path : undefined;
  const protectedReason = bindPath === undefined ? undefined : protectedSkip(bindPath);
  if (protectedReason !== undefined) {
    return {
      kind: "skip",
      skip: {
        key: candidate.key,
        mountType: "bind",
        reasonCode: protectedReason,
        source: bindPath,
        consumers,
      },
    };
  }

  let probe: BackupSourceProbeResult;
  try {
    probe = await dependencies.probeSource(candidate.source);
  } catch (error) {
    fail("SOURCE_PROBE_FAILED", "Docker authority source probing failed", error);
  }
  if (probe.status === "missing") {
    fail(
      candidate.source.kind === "bind" ? "BIND_SOURCE_MISSING" : "NAMED_VOLUME_MISSING",
      "A selected persistent source is missing",
    );
  }
  if (probe.status === "not-directory") {
    if (probe.kind === "socket" || probe.kind === "device") {
      return {
        kind: "skip",
        skip: {
          key: candidate.key,
          mountType: "bind",
          reasonCode: probe.kind === "socket" ? "SOCKET_SOURCE" : "DEVICE_SOURCE",
          ...(candidate.source.kind === "bind" ? { source: candidate.source.path } : {}),
          consumers,
        },
      };
    }
    if (consumers.every((item) => item.readOnly)) {
      return {
        kind: "skip",
        skip: {
          key: candidate.key,
          mountType: "bind",
          reasonCode: "READ_ONLY_SYSTEM_FILE",
          ...(candidate.source.kind === "bind" ? { source: candidate.source.path } : {}),
          consumers,
        },
      };
    }
    fail("BIND_SOURCE_NOT_DIRECTORY", "A writable bind source is not a directory");
  }
  return { kind: "mount", source: candidate.source, consumers };
}

function assertNoNestedSelectedBinds(
  mounts: readonly { readonly source: BackupSource }[],
  topology: ReadonlyMap<string, BackupBindMountIdentity>,
): void {
  const paths = mounts
    .filter(
      (mount): mount is { readonly source: { readonly kind: "bind"; readonly path: string } } =>
        mount.source.kind === "bind",
    )
    .map((mount) => mount.source.path)
    .sort(compare);
  for (let index = 1; index < paths.length; index += 1) {
    const previous = paths[index - 1];
    const current = paths[index];
    if (previous !== undefined && current !== undefined && isSameOrDescendant(current, previous)) {
      fail("NESTED_SELECTED_BIND", "Selected bind sources have nested restore ownership");
    }
  }
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    const leftPath = paths[leftIndex];
    const leftIdentity = leftPath === undefined ? undefined : topology.get(leftPath);
    if (leftIdentity === undefined) {
      fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
    }
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const rightPath = paths[rightIndex];
      const rightIdentity = rightPath === undefined ? undefined : topology.get(rightPath);
      if (rightIdentity === undefined) {
        fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
      }
      if (identitiesEqual(leftIdentity, rightIdentity)) {
        fail("AMBIGUOUS_BIND_PATH", "Distinct selected bind paths resolve to one daemon identity");
      }
      if (identitiesOverlap(leftIdentity, rightIdentity)) {
        fail("NESTED_SELECTED_BIND", "Selected bind sources have nested restore ownership");
      }
    }
  }
}

async function resolveBindTopology(
  selected: readonly Candidate[],
  compose: CanonicalComposeConfig,
  localDestination: string | undefined,
  dependencies: BackupPlannerDependencies,
): Promise<{
  readonly byPath: ReadonlyMap<string, BackupBindMountIdentity>;
  readonly fingerprint: string;
}> {
  const selectedBindPaths = selected
    .filter(
      (
        candidate,
      ): candidate is Candidate & {
        readonly source: { readonly kind: "bind"; readonly path: string };
      } => candidate.source.kind === "bind",
    )
    .map((candidate) => candidate.source.path);
  if (selectedBindPaths.length === 0) {
    return { byPath: new Map(), fingerprint: EMPTY_BIND_TOPOLOGY_FINGERPRINT };
  }
  const sourcePaths = uniqueSorted([
    ...selectedBindPaths,
    ...writableBindPaths(compose),
    ...(localDestination === undefined ? [] : [localDestination]),
  ]);
  let topology: BackupBindTopologyProbeResult;
  try {
    topology = await dependencies.probeBindTopology(sourcePaths);
  } catch (error) {
    fail("AMBIGUOUS_BIND_PATH", "Unable to prove daemon bind path relationships", error);
  }
  if (
    !SHA256_PATTERN.test(topology.fingerprint) ||
    topology.entries.length !== sourcePaths.length
  ) {
    fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is malformed");
  }
  const byPath = new Map<string, BackupBindMountIdentity>();
  for (const entry of topology.entries) {
    if (
      !sourcePaths.includes(entry.sourcePath) ||
      byPath.has(entry.sourcePath) ||
      !/^\d+:\d+$/u.test(entry.majorMinor) ||
      !isCanonicalMountRoot(entry.mountRoot)
    ) {
      fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is malformed");
    }
    byPath.set(entry.sourcePath, {
      majorMinor: entry.majorMinor,
      mountRoot: entry.mountRoot,
    });
  }
  if (sourcePaths.some((sourcePath) => !byPath.has(sourcePath))) {
    fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
  }
  return { byPath, fingerprint: topology.fingerprint };
}

function recoveryLayers(compose: CanonicalComposeConfig, services: readonly string[]): string[][] {
  const serviceSet = new Set(services);
  const dependencies = new Map<string, string[]>();
  for (const serviceName of services) {
    const config = compose.services[serviceName];
    if (config === undefined) fail("SERVICE_NOT_FOUND", "A writer service is missing");
    const direct = new Set(config.depends_on.filter((dependency) => serviceSet.has(dependency)));
    const match = config.network_mode?.match(/^service:(.+)$/u);
    if (match?.[1] !== undefined && serviceSet.has(match[1])) direct.add(match[1]);
    dependencies.set(serviceName, [...direct].sort(compare));
  }
  const graph = topologicalSort(dependencies, {});
  if (graph.hasCycles) fail("DEPENDENCY_CYCLE", "The writer recovery graph contains a cycle");
  return graph.phases.map((phase) => [...phase.services].sort(compare));
}

function buildSkip(item: PendingSkip, index: number): BackupSkippedSource {
  return {
    id: `mount-skip-${String(index + 1).padStart(4, "0")}`,
    mountType: item.mountType,
    reasonCode: item.reasonCode,
    ...(item.source === undefined ? {} : { source: item.source }),
    consumers: uniqueConsumers(item.consumers),
  };
}

/** Build a complete deterministic backup plan without filesystem or Docker mutation. */
export async function planBackup(
  input: BackupPlannerInput,
  dependencies: BackupPlannerDependencies,
): Promise<BackupPlan> {
  const compose = input.composeEvidence.config;
  const requestedServices = assertSafeRequestedServices(input.requestedServices, compose);
  const resolvedServices = resolveServices(compose, requestedServices);
  const selected = selectedCandidates(compose, resolvedServices);
  const bindTopology = await resolveBindTopology(
    selected.candidates,
    compose,
    input.localDockerAuthority ? input.canonicalDestination : undefined,
    dependencies,
  );
  const classified = [];
  const pendingSkips = [...selected.skips];
  for (const candidate of selected.candidates) {
    const result = await classifyCandidate(candidate, compose, dependencies);
    if (result.kind === "skip") pendingSkips.push(result.skip);
    else classified.push(result);
  }
  assertNoNestedSelectedBinds(classified, bindTopology.byPath);

  if (input.localDockerAuthority) {
    const selectedBinds = classified.filter(
      (
        item,
      ): item is typeof item & {
        readonly source: { readonly kind: "bind"; readonly path: string };
      } => item.source.kind === "bind",
    );
    if (selectedBinds.length > 0) {
      const destinationIdentity = bindTopology.byPath.get(input.canonicalDestination);
      if (destinationIdentity === undefined) {
        fail("AMBIGUOUS_BIND_PATH", "Daemon destination identity evidence is incomplete");
      }
      for (const item of selectedBinds) {
        const sourceIdentity = bindTopology.byPath.get(item.source.path);
        if (sourceIdentity === undefined) {
          fail("AMBIGUOUS_BIND_PATH", "Daemon bind identity evidence is incomplete");
        }
        if (
          isSameOrDescendant(input.canonicalDestination, item.source.path) ||
          identitiesOverlap(destinationIdentity, sourceIdentity)
        ) {
          fail(
            "DESTINATION_INSIDE_SOURCE",
            "The local backup destination overlaps a selected bind source",
          );
        }
      }
    }
  }

  const mounts: BackupPlannedMount[] = classified.map((item, index) => {
    const consumers = exactConsumers(compose, item.source, bindTopology.byPath);
    const writerServices =
      item.source.kind === "bind"
        ? overlappingBindWriters(compose, item.source.path, bindTopology.byPath)
        : uniqueSorted(
            consumers.filter((consumer) => !consumer.readOnly).map((consumer) => consumer.service),
          );
    const id = `mount-${String(index + 1).padStart(4, "0")}`;
    return {
      id,
      artifactPath: `artifacts/${id}.tar.gz`,
      source: item.source,
      consumers,
      writerServices,
      restore:
        item.source.kind === "bind"
          ? {
              kind: "bind-tar",
              destinationPath: item.source.path,
              precondition: "writers-stopped",
            }
          : {
              kind: "volume-tar",
              volumeName: item.source.name,
              driver: item.source.driver,
              external: item.source.external,
              precondition: "writers-stopped",
            },
    };
  });
  const quiescedServices = uniqueSorted(mounts.flatMap((mount) => mount.writerServices));
  const skipped = pendingSkips.sort((left, right) => compare(left.key, right.key)).map(buildSkip);

  return {
    requestedServices,
    resolvedServices,
    quiescedServices,
    recoveryLayers: recoveryLayers(compose, quiescedServices),
    mounts,
    skipped,
    warnings: SYSTEM_WARNINGS.map((warning) => ({ ...warning })),
    resolvedConfigSha256: input.composeEvidence.resolvedConfigFingerprint,
    dockerAuthorityFingerprint: input.dockerAuthorityFingerprint,
    bindTopologyFingerprint: bindTopology.fingerprint,
    canonicalDestination: input.canonicalDestination,
  };
}
