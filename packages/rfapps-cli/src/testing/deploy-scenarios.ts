/**
 * Shared mock-docker scenario rules for deploy-shaped integration flows
 * (`rfapps deploy` and `rfapps apply`) — imported by the CLI integration specs.
 */

import {
  canonicalComposeConfig,
  canonicalComposePort,
  canonicalComposeService,
  composeConfigJson,
  composeConfigServices,
  composePsRunningNames,
  composePsServiceMap,
  composePsStatusJson,
  containerInspectEntry,
  containerInspectJson,
  dockerInspectJson,
  networkInspectEntry,
  networkInspectJson,
  volumeInspectEntry,
  volumeInspectJson,
} from "./mock-docker.js";
import type {
  CanonicalComposeConfigPayload,
  ContainerInspectPayload,
  MockDockerRule,
  NetworkInspectPayload,
  VolumeInspectPayload,
} from "./mock-docker.js";

const BLOCKING_CONTAINER_ID = "a".repeat(64);
const PASSING_NETWORK_ID = "b".repeat(64);
const PASSING_VOLUME_NAME = "unrelated-data";

export const preflightRuleIds = {
  composeCanonical: "preflight-compose-canonical",
  composeRevalidation: "preflight-compose-revalidation",
  authorityContextShow: "preflight-authority-context-show",
  authorityContextInspect: "preflight-authority-context-inspect",
  authorityInfo: "preflight-authority-info",
  containerList: "preflight-container-list",
  containerInspect: "preflight-container-inspect",
  networkList: "preflight-network-list",
  networkInspect: "preflight-network-inspect",
  volumeList: "preflight-volume-list",
  volumeInspect: "preflight-volume-inspect",
} as const;

/** Complete read-only rule-ID membership list; independent lanes may execute concurrently. */
export const preflightReadRuleIds = [
  preflightRuleIds.composeCanonical,
  preflightRuleIds.composeRevalidation,
  preflightRuleIds.authorityContextShow,
  preflightRuleIds.authorityContextInspect,
  preflightRuleIds.authorityInfo,
  preflightRuleIds.containerList,
  preflightRuleIds.containerInspect,
  preflightRuleIds.networkList,
  preflightRuleIds.networkInspect,
  preflightRuleIds.volumeList,
  preflightRuleIds.volumeInspect,
] as const;

export interface PreflightComposePaths {
  /** Canonical absolute path passed to Docker Compose with `-f`. */
  readonly composePath: string;
  /** Canonical absolute path passed to Docker Compose with `--env-file`. */
  readonly envFile: string;
}

interface PreflightRuntimeOptions extends PreflightComposePaths {
  readonly compose: CanonicalComposeConfigPayload;
  readonly containerIds?: readonly string[];
  readonly containers?: readonly ContainerInspectPayload[];
  readonly containerInspectResponse?: MockDockerRule["response"];
  readonly networkIds?: readonly string[];
  readonly networks?: readonly NetworkInspectPayload[];
  readonly volumeNames?: readonly string[];
  readonly volumes?: readonly VolumeInspectPayload[];
}

function preflightRules(options: PreflightRuntimeOptions): MockDockerRule[] {
  const containerIds = options.containerIds ?? [];
  const containers = options.containers ?? [];
  const networkIds = options.networkIds ?? [];
  const networks = options.networks ?? [];
  const volumeNames = options.volumeNames ?? [];
  const volumes = options.volumes ?? [];
  const rules: MockDockerRule[] = [
    {
      id: preflightRuleIds.composeCanonical,
      match: {
        exact: [
          "compose",
          "-f",
          options.composePath,
          "--env-file",
          options.envFile,
          "--profile",
          "all",
          "config",
          "--format",
          "json",
        ],
      },
      response: { stdout: composeConfigJson(options.compose), exitCode: 0 },
    },
    {
      id: preflightRuleIds.composeRevalidation,
      match: {
        exact: [
          "compose",
          "--project-name",
          "fixture",
          "-f",
          options.composePath,
          "--env-file",
          options.envFile,
          "--profile",
          "all",
          "config",
          "--format",
          "json",
        ],
      },
      response: { stdout: composeConfigJson(options.compose), exitCode: 0 },
    },
    {
      id: preflightRuleIds.authorityContextShow,
      match: { exact: ["context", "show"] },
      response: { stdout: "default\n", exitCode: 0 },
    },
    {
      id: preflightRuleIds.authorityContextInspect,
      match: {
        exact: ["context", "inspect", "default", "--format", "{{json .Endpoints.docker.Host}}"],
      },
      response: { stdout: '"unix:///var/run/docker.sock"\n', exitCode: 0 },
    },
    {
      id: preflightRuleIds.authorityInfo,
      match: { exact: ["info", "--format", "{{json .ID}}"] },
      response: { stdout: '"fixture-daemon"\n', exitCode: 0 },
    },
    {
      id: preflightRuleIds.containerList,
      match: { exact: ["ps", "--filter", "status=running", "--quiet", "--no-trunc"] },
      response: {
        stdout: containerIds.length === 0 ? "" : `${containerIds.join("\n")}\n`,
        exitCode: 0,
      },
    },
  ];
  if (containerIds.length > 0) {
    rules.push({
      id: preflightRuleIds.containerInspect,
      match: { exact: ["inspect", ...containerIds] },
      response:
        options.containerInspectResponse ??
        ({
          stdout: containerInspectJson(containers),
          exitCode: 0,
        } satisfies MockDockerRule["response"]),
    });
  }
  rules.push({
    id: preflightRuleIds.networkList,
    match: { exact: ["network", "ls", "--quiet", "--no-trunc"] },
    response: {
      stdout: networkIds.length === 0 ? "" : `${networkIds.join("\n")}\n`,
      exitCode: 0,
    },
  });
  if (networkIds.length > 0) {
    rules.push({
      id: preflightRuleIds.networkInspect,
      match: { exact: ["network", "inspect", ...networkIds] },
      response: { stdout: networkInspectJson(networks), exitCode: 0 },
    });
  }
  rules.push({
    id: preflightRuleIds.volumeList,
    match: { exact: ["volume", "ls", "--quiet"] },
    response: {
      stdout: volumeNames.length === 0 ? "" : `${volumeNames.join("\n")}\n`,
      exitCode: 0,
    },
  });
  if (volumeNames.length > 0) {
    rules.push({
      id: preflightRuleIds.volumeInspect,
      match: { exact: ["volume", "inspect", ...volumeNames] },
      response: { stdout: volumeInspectJson(volumes), exitCode: 0 },
    });
  }
  return rules;
}

function preflightCompose(): CanonicalComposeConfigPayload {
  return canonicalComposeConfig({
    services: {
      web: canonicalComposeService({
        ports: [canonicalComposePort({ target: 80, published: 8080 })],
      }),
      db: canonicalComposeService({ image: "postgres:16" }),
    },
  });
}

/** Read-only evidence for a deterministic passing preflight. */
export function preflightPassRules(paths: PreflightComposePaths): MockDockerRule[] {
  return preflightRules({
    ...paths,
    compose: preflightCompose(),
    networkIds: [PASSING_NETWORK_ID],
    networks: [
      networkInspectEntry({
        id: PASSING_NETWORK_ID,
        name: "unrelated-network",
        subnets: ["10.90.0.0/24"],
      }),
    ],
    volumeNames: [PASSING_VOLUME_NAME],
    volumes: [volumeInspectEntry({ name: PASSING_VOLUME_NAME })],
  });
}

/** Runtime port evidence that deterministically blocks desired `web` port 8080/tcp. */
export function preflightBlockedRules(paths: PreflightComposePaths): MockDockerRule[] {
  return preflightRules({
    ...paths,
    compose: preflightCompose(),
    containerIds: [BLOCKING_CONTAINER_ID],
    containers: [
      containerInspectEntry({
        id: BLOCKING_CONTAINER_ID,
        name: "unrelated-owner",
        project: "other-project",
        service: "other-service",
        ports: {
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        },
      }),
    ],
  });
}

/** Required container-inspect evidence fails, producing an inconclusive preflight. */
export function preflightInconclusiveRules(paths: PreflightComposePaths): MockDockerRule[] {
  return preflightRules({
    ...paths,
    compose: preflightCompose(),
    containerIds: [BLOCKING_CONTAINER_ID],
    containerInspectResponse: {
      stderr: "permission denied\n",
      exitCode: 1,
    },
  });
}

// Streamed rules (plan correction 9): stdout must stay empty — the mock's fds are
// inherited by the CLI, so any stdout here would break --json stdout purity.
export const pullOk: MockDockerRule = {
  id: "pull",
  match: { prefix: ["compose"], contains: ["pull"] },
  response: { exitCode: 0 },
};
export const upOk: MockDockerRule = {
  id: "up",
  match: { prefix: ["compose"], contains: ["up", "-d"] },
  response: { exitCode: 0 },
};

/**
 * Full happy-path readiness rule set for deploy/apply (plan corrections 8 and 16).
 *
 * `waitForDependencyReadiness` runs unconditionally after `up` (even with
 * `healthCheck.waitForReady: false`), so every happy-path deploy needs the
 * config/ps sextet plus TWO disambiguated inspect rules:
 * - `inspect-readiness`: argv carries CONTAINER names from the running-service
 *   map (health.ts inspects `fixture-web-1`).
 * - `inspect-db`: argv carries SERVICE names (deploy.ts:774
 *   `inspectContainersWithRetry(deployedServices)`).
 */
export function deployReadinessRules(opts: {
  runningNames: readonly string[];
  /** MUST exactly equal the test's deployed-service list so
   *  inspectContainersWithRetry's `size === services.length` early-return fires on attempt 1
   *  (action-helpers.ts:49) — inspectContainers does NOT filter canned JSON by requested
   *  names, so extra entries force the full ~3s retry loop (plan correction 16). */
  dbInspectServices: readonly { readonly name: string; readonly image: string }[];
}): MockDockerRule[] {
  return [
    {
      id: "config-json",
      match: { prefix: ["compose"], contains: ["config", "--format", "json"] },
      response: {
        stdout: composeConfigJson({
          name: "fixture",
          services: { web: { image: "nginx:1.27" }, db: { image: "postgres:16" } },
        }),
        exitCode: 0,
      },
    },
    {
      id: "config-services",
      match: { prefix: ["compose"], contains: ["config", "--services"] },
      response: { stdout: composeConfigServices(["web", "db"]), exitCode: 0 },
    },
    {
      id: "ps-a-json",
      match: { prefix: ["compose"], contains: ["ps", "-a", "--format", "json"] },
      response: {
        stdout: composePsStatusJson([
          { Service: "web", State: "running" },
          { Service: "db", State: "running" },
        ]),
        exitCode: 0,
      },
    },
    {
      id: "ps-service-map",
      match: {
        prefix: ["compose"],
        contains: ["ps", "--status", "running", "--format", "{{.Service}}\t{{.Name}}"],
      },
      response: {
        stdout: composePsServiceMap([{ service: "web", container: "fixture-web-1" }]),
        exitCode: 0,
      },
    },
    {
      id: "ps-running-names",
      match: {
        prefix: ["compose"],
        contains: ["ps", "--status", "running", "--format", "{{.Name}}"],
      },
      response: { stdout: composePsRunningNames(opts.runningNames), exitCode: 0 },
    },
    // Readiness inspect (health.ts): argv carries CONTAINER names from the running map.
    {
      id: "inspect-readiness",
      match: { prefix: ["inspect"], contains: ["fixture-web-1"] },
      response: {
        stdout: dockerInspectJson([{ name: "fixture-web-1", image: "nginx:1.27" }]),
        exitCode: 0,
      },
    },
    // DB-phase inspect (deploy.ts): argv carries SERVICE names; canned entries exactly
    // match the deployed list so the retry loop early-returns on attempt 1.
    {
      id: "inspect-db",
      match: { prefix: ["inspect"], absent: ["fixture-web-1"] },
      response: { stdout: dockerInspectJson([...opts.dbInspectServices]), exitCode: 0 },
    },
  ];
}
