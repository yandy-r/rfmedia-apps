/**
 * Deploy-specific conflict-validation coordination.
 *
 * This module binds canonical Compose inputs, projects the effective deploy
 * scope, collects independent Docker evidence lanes, and prepares the narrow
 * execution options consumed by the deploy action.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, parse, resolve } from "node:path";

import type {
  ConflictDesiredState,
  ConflictMountProjection,
  ConflictValidationCheck,
  ConflictValidationCheckKind,
  ConflictValidationFailure,
  ConflictValidationInput,
  ConflictValidationResult,
  ConflictValidationScope,
  DependencyGraph,
  DesiredPortClaim,
  DesiredServiceProjection,
  EnvToolExecConfig,
  PortInterval,
} from "../types/index.js";
import { CONFLICT_VALIDATION_SCHEMA_VERSION } from "../types/index.js";
import { evaluateConflictValidation } from "./conflict-validation.js";
import {
  DockerEvidenceError,
  getCanonicalComposeConfigEvidence,
  getConflictRuntimeContainers,
  getConflictRuntimeNetworks,
  getConflictRuntimeVolumes,
  type CanonicalComposeConfig,
  type CanonicalComposeMountConfig,
  type CanonicalComposePortConfig,
  type ComposeServiceConfig,
  type ConflictEvidenceOptions,
  type DockerComposeExecOptions,
  type DockerExecOptions,
} from "./docker.js";
import {
  buildServiceDependencyGraph,
  EffectiveServiceClosureError,
  resolveEffectiveServiceClosure,
  topologicalSort,
} from "./dependency-graph.js";
import { captureEffectiveEnvironment } from "./env-tools.js";
import {
  DockerAuthorityDeadlineError,
  dockerAuthorityFingerprintFromEnvironment,
  resolveComposeEnvironmentFilePath,
} from "./identity.js";
import { hashFile } from "./plan-storage.js";

export interface DeployValidationBinding {
  readonly composePath: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly envFile: string;
  readonly profiles: readonly string[];
  readonly environment: Record<string, string>;
  readonly composeFileFingerprint: string;
  readonly resolvedComposeFingerprint: string;
  readonly authorityFingerprint: string;
}

export interface DeployValidationOutcome {
  readonly binding: DeployValidationBinding;
  readonly canonicalCompose: CanonicalComposeConfig;
  readonly effectiveServices: string[];
  readonly result: ConflictValidationResult;
}

class DesiredProjectionError extends Error {
  override readonly name = "DesiredProjectionError";
}

const CHECK_ORDER: Readonly<Record<ConflictValidationCheckKind, number>> = {
  compose: 0,
  scope: 1,
  authority: 2,
  containers: 3,
  volumes: 4,
  networks: 5,
  normalization: 6,
  revalidation: 7,
};

const DEPLOY_VALIDATION_STAGE_TIMEOUT_MS = 300_000;

function hasPathCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function resolveCanonicalComposePath(composePath: string): Promise<string> {
  if (composePath === "" || composePath.includes("\0")) {
    throw new Error("Compose path must be a non-empty filesystem path");
  }
  const absolutePath = resolve(composePath);
  const root = parse(absolutePath).root;
  const components: string[] = [];
  let cursor = absolutePath;
  while (cursor !== root) {
    components.push(cursor);
    cursor = dirname(cursor);
  }
  components.push(root);
  for (const component of components.reverse()) {
    try {
      if ((await lstat(component)).isSymbolicLink()) {
        throw new Error("Compose path contains a symbolic link");
      }
    } catch (error) {
      if (hasPathCode(error, "ENOENT")) {
        throw new Error("Compose path does not exist");
      }
      throw error;
    }
  }
  const canonicalPath = await realpath(absolutePath);
  if (!(await stat(canonicalPath)).isFile()) {
    throw new Error("Compose path must resolve to a regular file");
  }
  return canonicalPath;
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareChecks(left: ConflictValidationCheck, right: ConflictValidationCheck): number {
  return CHECK_ORDER[left.id] - CHECK_ORDER[right.id];
}

function compareFailures(
  left: ConflictValidationFailure,
  right: ConflictValidationFailure,
): number {
  return CHECK_ORDER[left.check] - CHECK_ORDER[right.check];
}

function parsePortInterval(value: string): PortInterval {
  const match = /^([0-9]{1,5})(?:-([0-9]{1,5}))?$/u.exec(value);
  const start = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const end = match?.[2] === undefined ? start : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end > 65_535 ||
    end < start
  ) {
    throw new DesiredProjectionError("Resolved Compose port range is unsupported");
  }
  return { start, end };
}

function projectDesiredPortForHostIp(
  port: string | CanonicalComposePortConfig,
  project: string,
  service: string,
  hostIp: string,
): DesiredPortClaim {
  if (typeof port === "string") {
    throw new DesiredProjectionError("Resolved Compose short port syntax is unsupported");
  }

  const target = parsePortInterval(port.target);
  const ipFamily = isIP(hostIp);
  if (ipFamily !== 4 && ipFamily !== 6) {
    throw new DesiredProjectionError("Resolved Compose host IP is unsupported");
  }

  if (port.published === undefined) {
    return {
      kind: "port",
      origin: "desired",
      project,
      service,
      family: ipFamily === 4 ? "ipv4" : "ipv6",
      hostIp,
      protocol: port.protocol,
      allocation: { mode: "dynamic" },
    };
  }

  const published = parsePortInterval(port.published);
  const targetWidth = target.end - target.start;
  const publishedWidth = published.end - published.start;
  if (targetWidth > 0 && targetWidth !== publishedWidth) {
    throw new DesiredProjectionError("Resolved Compose port range widths do not match");
  }

  return {
    kind: "port",
    origin: "desired",
    project,
    service,
    family: ipFamily === 4 ? "ipv4" : "ipv6",
    hostIp,
    protocol: port.protocol,
    allocation:
      targetWidth === 0 && publishedWidth > 0
        ? { mode: "choice", published }
        : { mode: "fixed", published },
  };
}

function projectDesiredPorts(
  port: string | CanonicalComposePortConfig,
  project: string,
  service: string,
): DesiredPortClaim[] {
  if (typeof port === "string") {
    throw new DesiredProjectionError("Resolved Compose short port syntax is unsupported");
  }
  const hostIps =
    port.host_ip === undefined || port.host_ip === "" ? ["0.0.0.0", "::"] : [port.host_ip];
  return hostIps.map((hostIp) => projectDesiredPortForHostIp(port, project, service, hostIp));
}

function projectDesiredMount(mount: string | CanonicalComposeMountConfig): ConflictMountProjection {
  if (typeof mount === "string") {
    throw new DesiredProjectionError("Resolved Compose short mount syntax is unsupported");
  }
  if ((mount.type === "bind" || mount.type === "volume") && mount.source === undefined) {
    throw new DesiredProjectionError("Resolved Compose persistent mount source is missing");
  }
  return {
    type: mount.type,
    ...(mount.source === undefined ? {} : { source: mount.source }),
    target: mount.target,
    readOnly: mount.read_only,
  };
}

function projectDesiredState(
  compose: CanonicalComposeConfig,
  effectiveServices: readonly string[],
): ConflictDesiredState {
  const services: DesiredServiceProjection[] = effectiveServices.map((serviceName) => {
    const service = compose.services[serviceName];
    if (service === undefined) {
      throw new DesiredProjectionError("Resolved Compose service scope changed");
    }
    if ((service.unsupported_volumes?.length ?? 0) > 0) {
      throw new DesiredProjectionError("Resolved Compose mount type is unsupported");
    }
    const networkModeDependency = service.network_mode?.startsWith("service:")
      ? service.network_mode.slice("service:".length)
      : undefined;
    return {
      project: compose.name,
      service: serviceName,
      ports: service.ports.flatMap((port) => projectDesiredPorts(port, compose.name, serviceName)),
      mounts: service.volumes.map(projectDesiredMount),
      networks: [...service.networks],
      dependencies: [
        ...new Set([
          ...service.depends_on,
          ...(networkModeDependency === undefined ? [] : [networkModeDependency]),
        ]),
      ].sort(compareCodePoint),
    };
  });
  const referencedVolumes = new Set(
    services.flatMap((service) =>
      service.mounts.flatMap((mount) =>
        mount.type === "volume" && mount.source !== undefined ? [mount.source] : [],
      ),
    ),
  );
  const referencedNetworks = new Set(services.flatMap((service) => service.networks));

  return {
    project: compose.name,
    services,
    volumes: Object.entries(compose.volumes)
      .filter(([key, volume]) => referencedVolumes.has(key) || referencedVolumes.has(volume.name))
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(([key, volume]) => ({
        key,
        name: volume.name,
        external: volume.external,
        driver: volume.driver,
        driverOptions: volume.driver_opts,
      })),
    networks: Object.entries(compose.networks)
      .filter(
        ([key, network]) => referencedNetworks.has(key) || referencedNetworks.has(network.name),
      )
      .sort(([left], [right]) => compareCodePoint(left, right))
      .map(([key, network]) => ({
        key,
        name: network.name,
        external: network.external,
        driver: network.driver,
        subnets: network.ipam.config.flatMap((entry) =>
          entry.subnet === undefined ? [] : [entry.subnet],
        ),
      })),
  };
}

export function validationScope(
  project: string,
  services: readonly string[],
  profiles: readonly string[],
): ConflictValidationScope {
  return {
    project,
    services: [...new Set(services)].sort(compareCodePoint),
    profiles: [...new Set(profiles)].sort(compareCodePoint),
  };
}

export function inconclusiveValidation(
  scope: ConflictValidationScope,
  failures: ConflictValidationFailure | readonly ConflictValidationFailure[],
  previous?: ConflictValidationResult,
): ConflictValidationResult {
  const orderedFailures = (Array.isArray(failures) ? failures : [failures])
    .slice()
    .sort(compareFailures);
  const primaryFailure = orderedFailures[0];
  if (primaryFailure === undefined) {
    throw new Error("An inconclusive validation result requires at least one failure");
  }
  const failedChecks = new Map(
    orderedFailures.map((failure) => [
      failure.check,
      {
        id: failure.check,
        status: "failed" as const,
        required: true,
        resources: 0,
        failure,
      } satisfies ConflictValidationCheck,
    ]),
  );
  const checks =
    previous === undefined
      ? [...failedChecks.values()].sort(compareChecks)
      : [
          ...previous.checks
            .filter((check) => !failedChecks.has(check.id))
            .map((check) => ({ ...check })),
          ...failedChecks.values(),
        ].sort(compareChecks);

  return {
    schemaVersion: CONFLICT_VALIDATION_SCHEMA_VERSION,
    status: "inconclusive",
    scope,
    checks,
    summary: previous?.summary ?? {
      total: 0,
      errors: 0,
      warnings: 0,
      ports: 0,
      volumes: 0,
      networks: 0,
    },
    conflicts: previous?.conflicts ?? [],
    warnings: previous?.warnings ?? [],
    limitations: previous?.limitations ?? [
      {
        code: "POINT_IN_TIME_SNAPSHOT",
        message:
          "Docker resources can change after inspection; Docker remains the final allocator.",
      },
    ],
    error: primaryFailure,
  };
}

export function validationFailureFromError(error: unknown): ConflictValidationFailure {
  if (error instanceof DockerEvidenceError) {
    return { code: error.code, check: error.check, message: error.message };
  }
  if (error instanceof EffectiveServiceClosureError) {
    return {
      code: "EFFECTIVE_SCOPE_UNAVAILABLE",
      check: "scope",
      message: "The effective Compose service scope could not be resolved safely.",
    };
  }
  if (error instanceof DesiredProjectionError) {
    return {
      code: "UNSUPPORTED_RESOURCE_SHAPE",
      check: "normalization",
      message: "The resolved Compose resource shape could not be validated safely.",
    };
  }
  return {
    code: "COMPOSE_CONFIG_UNAVAILABLE",
    check: "compose",
    message: "Pre-deploy validation inputs could not be resolved safely.",
  };
}

function evidenceFailure(
  error: unknown,
  check: "containers" | "networks" | "volumes",
): ConflictValidationFailure {
  if (error instanceof DockerEvidenceError) {
    return { code: error.code, check: error.check, message: error.message };
  }
  const details = {
    containers: {
      code: "CONTAINER_SNAPSHOT_UNAVAILABLE" as const,
      message: "Running Docker container evidence could not be collected safely.",
    },
    networks: {
      code: "NETWORK_SNAPSHOT_UNAVAILABLE" as const,
      message: "Docker network evidence could not be collected safely.",
    },
    volumes: {
      code: "VOLUME_SNAPSHOT_UNAVAILABLE" as const,
      message: "Docker volume evidence could not be collected safely.",
    },
  } satisfies Record<typeof check, Pick<ConflictValidationFailure, "code" | "message">>;
  return { ...details[check], check };
}

function authorityFailure(error?: unknown): ConflictValidationFailure {
  if (error instanceof DockerAuthorityDeadlineError) {
    return {
      code: "EVIDENCE_LIMIT_EXCEEDED",
      check: "authority",
      message: "Docker authority evidence exceeded safety limits.",
    };
  }
  return {
    code: "DOCKER_AUTHORITY_UNAVAILABLE",
    check: "authority",
    message: "The effective Docker authority could not be identified safely.",
  };
}

function validationProgress(
  canonicalCompose: CanonicalComposeConfig,
  effectiveServices: readonly string[],
  profiles: readonly string[],
  failure: ConflictValidationFailure,
  scopeResolved: boolean,
): ConflictValidationResult {
  const scope = validationScope(canonicalCompose.name, effectiveServices, profiles);
  const failed = inconclusiveValidation(scope, failure);
  const checks: ConflictValidationCheck[] = [
    {
      id: "compose",
      status: "passed",
      required: true,
      resources:
        Object.keys(canonicalCompose.services).length +
        Object.keys(canonicalCompose.volumes).length +
        Object.keys(canonicalCompose.networks).length,
    },
    ...(scopeResolved
      ? [
          {
            id: "scope",
            status: "passed",
            required: true,
            resources: effectiveServices.length,
          } satisfies ConflictValidationCheck,
        ]
      : []),
    ...failed.checks,
  ];
  return {
    ...failed,
    checks: checks.sort(compareChecks),
  };
}

function stagedValidationOutcome(
  canonicalCompose: CanonicalComposeConfig,
  effectiveServices: readonly string[],
  profiles: readonly string[],
  failure: ConflictValidationFailure,
  scopeResolved: boolean,
  binding: Omit<
    DeployValidationBinding,
    | "projectName"
    | "profiles"
    | "composeFileFingerprint"
    | "resolvedComposeFingerprint"
    | "authorityFingerprint"
  > & {
    readonly resolvedComposeFingerprint: string;
  },
): DeployValidationOutcome {
  return {
    canonicalCompose,
    effectiveServices: [...effectiveServices],
    result: validationProgress(
      canonicalCompose,
      effectiveServices,
      profiles,
      failure,
      scopeResolved,
    ),
    binding: {
      ...binding,
      projectName: canonicalCompose.name,
      profiles: [...profiles],
      composeFileFingerprint: "",
      authorityFingerprint: "",
    },
  };
}

function evidenceDeadlineError(check: "containers" | "networks" | "volumes"): DockerEvidenceError {
  return new DockerEvidenceError(
    `${check} evidence exceeded safety limits`,
    "EVIDENCE_LIMIT_EXCEEDED",
    check,
  );
}

/**
 * Resolve a secrets-provider file against the original invocation directory.
 *
 * Validation later switches to the canonical Compose project directory, so
 * only an absolute canonical provider path may cross that boundary.
 */
export async function canonicalizeDeployEnvTool(
  envTool: EnvToolExecConfig | undefined,
  invocationCwd: string,
): Promise<EnvToolExecConfig | undefined> {
  if (envTool?.envFile === undefined) return envTool;
  return {
    ...envTool,
    envFile: await resolveComposeEnvironmentFilePath(resolve(invocationCwd, envTool.envFile)),
  };
}

export async function runDeployValidation(
  composePath: string,
  envFile: string,
  profiles: readonly string[],
  selectedServices: readonly string[],
  envTool: EnvToolExecConfig | undefined,
): Promise<DeployValidationOutcome> {
  const canonicalComposePath = await resolveCanonicalComposePath(composePath);
  const projectDir = dirname(canonicalComposePath);
  const canonicalEnvFile = await resolveComposeEnvironmentFilePath(envFile);
  const environment = await captureEffectiveEnvironment({
    tool: envTool?.tool ?? "none",
    ...(envTool?.envFile === undefined ? {} : { envFile: envTool.envFile }),
    cwd: projectDir,
  });
  const execution: Pick<DockerExecOptions, "cwd" | "env" | "replaceEnv"> = {
    cwd: projectDir,
    env: environment,
    replaceEnv: true,
  };
  const deadline = Date.now() + DEPLOY_VALIDATION_STAGE_TIMEOUT_MS;
  const composeOptions: ConflictEvidenceOptions = {
    ...execution,
    envFile: canonicalEnvFile,
    profiles,
    deadline,
    timeout: DEPLOY_VALIDATION_STAGE_TIMEOUT_MS,
    maxRetries: 1,
  };
  const composeEvidence = await getCanonicalComposeConfigEvidence(
    canonicalComposePath,
    composeOptions,
  );
  const canonicalCompose = composeEvidence.config;
  const stagedBinding = {
    composePath: canonicalComposePath,
    projectDir,
    envFile: canonicalEnvFile,
    environment,
    resolvedComposeFingerprint: composeEvidence.resolvedConfigFingerprint,
  };
  const bestKnownServices =
    selectedServices.length === 0
      ? Object.keys(canonicalCompose.services).sort(compareCodePoint)
      : [...new Set(selectedServices)].sort(compareCodePoint);
  let effectiveServices: string[];
  try {
    effectiveServices = resolveEffectiveServiceClosure(canonicalCompose.services, selectedServices);
  } catch (error) {
    return stagedValidationOutcome(
      canonicalCompose,
      bestKnownServices,
      profiles,
      validationFailureFromError(error),
      false,
      stagedBinding,
    );
  }
  let desired: ConflictDesiredState;
  try {
    desired = projectDesiredState(canonicalCompose, effectiveServices);
  } catch (error) {
    return stagedValidationOutcome(
      canonicalCompose,
      effectiveServices,
      profiles,
      validationFailureFromError(error),
      true,
      stagedBinding,
    );
  }
  const scope = validationScope(canonicalCompose.name, effectiveServices, profiles);
  let composeFileFingerprint: string;
  try {
    composeFileFingerprint = await hashFile(canonicalComposePath);
    if (composeFileFingerprint === "") {
      throw new Error("empty Compose fingerprint");
    }
  } catch {
    return stagedValidationOutcome(
      canonicalCompose,
      effectiveServices,
      profiles,
      {
        code: "VALIDATION_INPUT_CHANGED",
        check: "revalidation",
        message: "The Compose file could not be bound to this validation run safely.",
      },
      true,
      stagedBinding,
    );
  }
  const resolvedComposeFingerprint = composeEvidence.resolvedConfigFingerprint;
  const evidenceOptions: ConflictEvidenceOptions = {
    ...execution,
    deadline,
    timeout: DEPLOY_VALIDATION_STAGE_TIMEOUT_MS,
    maxRetries: 1,
  };
  const evidence =
    Date.now() >= deadline
      ? ([
          {
            status: "rejected",
            reason: new DockerAuthorityDeadlineError(
              "Docker authority evidence exceeded safety limits",
            ),
          },
          { status: "rejected", reason: evidenceDeadlineError("containers") },
          { status: "rejected", reason: evidenceDeadlineError("networks") },
          { status: "rejected", reason: evidenceDeadlineError("volumes") },
        ] as const)
      : await Promise.allSettled([
          dockerAuthorityFingerprintFromEnvironment(environment, undefined, {
            deadline,
            timeout: DEPLOY_VALIDATION_STAGE_TIMEOUT_MS,
            maxRetries: 1,
          }),
          getConflictRuntimeContainers(evidenceOptions),
          getConflictRuntimeNetworks(evidenceOptions),
          getConflictRuntimeVolumes(evidenceOptions),
        ] as const);
  const [authorityEvidence, containerEvidence, networkEvidence, volumeEvidence] = evidence;
  if (
    authorityEvidence === undefined ||
    containerEvidence === undefined ||
    networkEvidence === undefined ||
    volumeEvidence === undefined
  ) {
    throw new Error("Runtime evidence lanes could not be scheduled safely");
  }
  const authorityFingerprint =
    authorityEvidence.status === "fulfilled" ? authorityEvidence.value : "";
  const containers = containerEvidence.status === "fulfilled" ? containerEvidence.value : [];
  const networks = networkEvidence.status === "fulfilled" ? networkEvidence.value : [];
  const volumes = volumeEvidence.status === "fulfilled" ? volumeEvidence.value : [];
  const failures = [
    ...(authorityEvidence.status === "rejected"
      ? [authorityFailure(authorityEvidence.reason)]
      : []),
    ...(containerEvidence.status === "rejected"
      ? [evidenceFailure(containerEvidence.reason, "containers")]
      : []),
    ...(networkEvidence.status === "rejected"
      ? [evidenceFailure(networkEvidence.reason, "networks")]
      : []),
    ...(volumeEvidence.status === "rejected"
      ? [evidenceFailure(volumeEvidence.reason, "volumes")]
      : []),
  ];
  const evaluated = evaluateConflictValidation({
    scope,
    desired,
    runtime: {
      containers,
      networks,
      volumes,
      volumeEvidenceAvailable: volumeEvidence.status === "fulfilled",
      authorityFingerprint,
      composeFingerprint: resolvedComposeFingerprint,
    },
  } satisfies ConflictValidationInput);
  const result =
    failures.length === 0 ? evaluated : inconclusiveValidation(scope, failures, evaluated);

  return {
    canonicalCompose,
    effectiveServices,
    result,
    binding: {
      composePath: canonicalComposePath,
      projectDir,
      projectName: canonicalCompose.name,
      envFile: canonicalEnvFile,
      profiles: [...profiles],
      environment,
      composeFileFingerprint,
      resolvedComposeFingerprint,
      authorityFingerprint,
    },
  };
}

export async function revalidateDeployBinding(
  binding: DeployValidationBinding,
): Promise<ConflictValidationFailure | undefined> {
  try {
    const execution: Pick<DockerExecOptions, "cwd" | "env" | "replaceEnv"> = {
      cwd: binding.projectDir,
      env: binding.environment,
      replaceEnv: true,
    };
    const [composeFileFingerprint, authorityFingerprint, composeEvidence] = await Promise.all([
      hashFile(binding.composePath),
      dockerAuthorityFingerprintFromEnvironment(binding.environment),
      getCanonicalComposeConfigEvidence(binding.composePath, {
        ...execution,
        envFile: binding.envFile,
        profiles: binding.profiles,
        projectName: binding.projectName,
      }),
    ]);
    if (authorityFingerprint !== binding.authorityFingerprint) {
      return {
        code: "VALIDATION_AUTHORITY_CHANGED",
        check: "revalidation",
        message: "The effective Docker authority changed after pre-deploy validation.",
      };
    }
    if (
      composeFileFingerprint === "" ||
      composeFileFingerprint !== binding.composeFileFingerprint ||
      composeEvidence.config.name !== binding.projectName ||
      composeEvidence.resolvedConfigFingerprint !== binding.resolvedComposeFingerprint
    ) {
      return {
        code: "VALIDATION_INPUT_CHANGED",
        check: "revalidation",
        message: "The effective Compose inputs changed after pre-deploy validation.",
      };
    }
    return undefined;
  } catch {
    return {
      code: "VALIDATION_INPUT_CHANGED",
      check: "revalidation",
      message: "The validation authority could not be rechecked before deployment.",
    };
  }
}

export function composeExecutionOptions(
  binding: DeployValidationBinding,
): Pick<DockerComposeExecOptions, "cwd" | "env" | "replaceEnv" | "envFile" | "projectName"> {
  return {
    cwd: binding.projectDir,
    env: binding.environment,
    replaceEnv: true,
    envFile: binding.envFile,
    projectName: binding.projectName,
  };
}

export function validationDependencyGraph(
  validation: DeployValidationOutcome,
  sidecarMapping: Record<string, string>,
): DependencyGraph {
  const services = Object.fromEntries(
    Object.entries(validation.canonicalCompose.services).map(([name, service]) => [
      name,
      {
        name: service.name,
        ...(service.image === undefined ? {} : { image: service.image }),
        depends_on: [...service.depends_on],
        ...(service.network_mode === undefined ? {} : { network_mode: service.network_mode }),
      } satisfies ComposeServiceConfig,
    ]),
  );
  const dependencyMap = buildServiceDependencyGraph(
    { services },
    sidecarMapping,
    validation.effectiveServices,
  );
  const graph = topologicalSort(dependencyMap, sidecarMapping);
  return graph.hasCycles ? graph : { ...graph, dependencyMap };
}
