/**
 * Mock `docker` executable for CLI integration tests.
 *
 * Generates a dependency-free CJS script that shadows the real `docker` binary on
 * the child process PATH. The script is driven by a JSON scenario file (a list of
 * argv-matching rules with canned responses) and appends every invocation to a
 * JSONL log that tests read back for assertions.
 *
 * The scenario/log paths are passed to the script via the
 * `RFAPPS_MOCK_DOCKER_SCENARIO` / `RFAPPS_MOCK_DOCKER_LOG` environment variables,
 * so a single generated script serves any scenario.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Matcher over the argv the CLI passed to `docker` (argv excludes the "docker" token itself). */
export interface MockArgvMatcher {
  /** argv must exactly equal these tokens */
  readonly exact?: readonly string[];
  /** argv must start with these tokens, in order */
  readonly prefix?: readonly string[];
  /** every token must appear somewhere in argv */
  readonly contains?: readonly string[];
  /** tokens that must NOT appear */
  readonly absent?: readonly string[];
}

export interface MockDockerResponse {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: number;
  readonly delayMs?: number;
}

export interface MockDockerRule {
  /** unique within a scenario; echoed into the invocation log */
  readonly id: string;
  /** first matching (non-exhausted) rule wins */
  readonly match: MockArgvMatcher;
  /** consume after N matches, then fall through to later rules */
  readonly times?: number;
  readonly response: MockDockerResponse;
}

export interface MockDockerScenario {
  readonly rules: readonly MockDockerRule[];
  // NO fallback: unmatched argv => exit 1 + "mock-docker: unmatched argv: ..." on stderr
}

export interface DockerInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly matchedRuleId: string | null;
  /** RFAPPS_* / COMPOSE_* subset of the environment seen by the fake docker */
  readonly env: Readonly<Record<string, string>>;
  /** ISO 8601, ms precision — used by S7's retry-delay assertion (plan correction 18) */
  readonly timestamp: string;
}

export interface MockDockerPaths {
  readonly dockerPath: string;
  readonly scenarioPath: string;
  readonly logPath: string;
}

/**
 * Generated `docker` script: dependency-free CommonJS so it runs under the plain
 * `#!/usr/bin/env node` shebang with zero module-resolution concerns.
 *
 * NOTE: the script's `matches` function is the JS twin of the exported TS
 * `matchesArgv` below — keep their matching behavior identical.
 */
const MOCK_DOCKER_SCRIPT = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const scenarioPath = process.env.RFAPPS_MOCK_DOCKER_SCENARIO;
const logPath = process.env.RFAPPS_MOCK_DOCKER_LOG;
if (!scenarioPath || !logPath) {
  process.stderr.write("mock-docker: RFAPPS_MOCK_DOCKER_SCENARIO/LOG not set\\n");
  process.exit(1);
}
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const argv = process.argv.slice(2);
const countersDir = path.join(path.dirname(scenarioPath), "counters");
function matches(m, a) {
  if (m.exact && (m.exact.length !== a.length || !m.exact.every((t, i) => a[i] === t))) return false;
  if (m.prefix && !m.prefix.every((t, i) => a[i] === t)) return false;
  if (m.contains && !m.contains.every((t) => a.includes(t))) return false;
  if (m.absent && m.absent.some((t) => a.includes(t))) return false;
  return true;
}
let matched = null;
for (const rule of scenario.rules) {
  if (!matches(rule.match, argv)) continue;
  if (rule.times !== undefined) {
    // Sidecar counter file: read-increment-write; no log-scanning.
    const counterFile = path.join(countersDir, rule.id + ".count");
    let count = 0;
    try { count = Number(fs.readFileSync(counterFile, "utf8")) || 0; } catch {}
    if (count >= rule.times) continue;          // exhausted: fall through to later rules
    fs.mkdirSync(countersDir, { recursive: true });
    fs.writeFileSync(counterFile, String(count + 1));
  }
  matched = rule;
  break;
}
const env = {};
for (const key of Object.keys(process.env)) {
  if (key.startsWith("RFAPPS_") || key.startsWith("COMPOSE_")) env[key] = process.env[key];
}
fs.appendFileSync(
  logPath,
  JSON.stringify({ argv, cwd: process.cwd(), matchedRuleId: matched ? matched.id : null, env, timestamp: new Date().toISOString() }) + "\\n",
);
function finish() {
  if (!matched) {
    process.stderr.write("mock-docker: unmatched argv: " + argv.join(" ") + "\\n");
    process.exit(1);
  }
  if (matched.response.stdout) process.stdout.write(matched.response.stdout);
  if (matched.response.stderr) process.stderr.write(matched.response.stderr);
  process.exit(matched.response.exitCode);
}
if (matched && matched.response.delayMs) setTimeout(finish, matched.response.delayMs);
else finish();
`;

/**
 * Write the fake `docker` executable, scenario file, and counters dir into
 * `binDir`. Does NOT set any environment variables — the harness does that.
 */
export async function writeMockDocker(
  binDir: string,
  scenario: MockDockerScenario,
): Promise<MockDockerPaths> {
  await mkdir(binDir, { recursive: true });
  const dockerPath = join(binDir, "docker");
  const scenarioPath = join(binDir, "scenario.json");
  const logPath = join(binDir, "invocations.jsonl");
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), "utf8");
  await writeFile(dockerPath, MOCK_DOCKER_SCRIPT, "utf8");
  await chmod(dockerPath, 0o755);
  await mkdir(join(binDir, "counters"), { recursive: true });
  return { dockerPath, scenarioPath, logPath };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Read and parse the JSONL invocation log. Returns `[]` if the log does not
 * exist yet (no docker invocations happened). Throws on malformed lines —
 * fail fast rather than silently dropping evidence.
 */
export async function readDockerInvocations(logPath: string): Promise<readonly DockerInvocation[]> {
  let content: string;
  try {
    content = await readFile(logPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index): DockerInvocation => {
      const parsed = JSON.parse(line) as Partial<DockerInvocation>;
      if (!isStringArray(parsed.argv)) {
        throw new Error(`mock-docker log line ${index + 1} missing argv: ${line}`);
      }
      return parsed as DockerInvocation;
    });
}

/** Space-joined argv per invocation, for substring/regex assertions. */
export function argvLines(invocations: readonly DockerInvocation[]): readonly string[] {
  return invocations.map((i) => i.argv.join(" "));
}

/**
 * Shared matcher used by both the generated script (JS twin embedded in
 * `MOCK_DOCKER_SCRIPT` above) and TS-side assertion helpers.
 * Keep its behavior identical to the script's `matches` function.
 */
export function matchesArgv(match: MockArgvMatcher, argv: readonly string[]): boolean {
  if (
    match.exact &&
    (match.exact.length !== argv.length || !match.exact.every((t, i) => argv[i] === t))
  )
    return false;
  if (match.prefix && !match.prefix.every((t, i) => argv[i] === t)) return false;
  if (match.contains && !match.contains.every((t) => argv.includes(t))) return false;
  if (match.absent && match.absent.some((t) => argv.includes(t))) return false;
  return true;
}

// ---- Canned-output builders (shapes match the real parsers) ----

/** Shape of one `docker ps --format json` line (status.ts DockerPsJson parser). */
export interface DockerPsEntry {
  readonly ID: string;
  readonly Image: string;
  readonly Command: string;
  readonly CreatedAt: string;
  readonly RunningFor: string;
  readonly Ports: string;
  readonly State: string;
  readonly Status: string;
  readonly Size: string;
  readonly Names: string;
  readonly Labels: string;
  readonly Mounts: string;
  readonly Networks: string;
}

/** JSON-lines for `docker ps --format json` (status.ts parser: one JSON object per line). */
export function dockerPsJson(entries: readonly DockerPsEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** Convenience: full DockerPsEntry with sane defaults, overriding Names/State/Status/Image/ID. */
export function dockerPsEntry(
  overrides: Partial<DockerPsEntry> & { readonly Names: string },
): DockerPsEntry {
  return {
    ID: "abcdef0123456789",
    Image: "nginx:1.27",
    Command: "",
    CreatedAt: "",
    RunningFor: "",
    Ports: "",
    State: "running",
    Status: "Up 5 seconds",
    Size: "",
    Labels: "",
    Mounts: "",
    Networks: "",
    ...overrides,
  };
}

/** Output for `compose ... ps --status running --format {{.Name}}` — newline-joined names. */
export function composePsRunningNames(names: readonly string[]): string {
  return names.join("\n") + "\n";
}

/** Output for `compose ... ps --status running --format {{.Service}}\t{{.Name}}` — TAB-separated lines. */
export function composePsServiceMap(
  entries: readonly { readonly service: string; readonly container: string }[],
): string {
  return entries.map((e) => `${e.service}\t${e.container}`).join("\n") + "\n";
}

/** One entry for `compose ... ps -a --format json` (getServiceStatusMap parser). */
export interface ComposePsStatusEntry {
  readonly Service: string;
  readonly State: string;
  readonly Health?: string;
  readonly Status?: string;
}

/** Output for `compose ... ps -a --format json` — a single JSON array (getServiceStatusMap accepts whole-blob arrays). */
export function composePsStatusJson(entries: readonly ComposePsStatusEntry[]): string {
  return JSON.stringify(entries);
}

export interface CanonicalComposePortPayload {
  readonly target: string | number;
  readonly published?: string | number;
  readonly host_ip?: string;
  readonly protocol?: "tcp" | "udp" | "sctp";
  readonly mode?: string;
}

export interface CanonicalComposeMountPayload {
  readonly type: "bind" | "volume" | "tmpfs";
  readonly source?: string;
  readonly target: string;
  readonly read_only?: boolean;
}

export interface CanonicalComposeServicePayload {
  readonly image?: string;
  readonly depends_on?:
    | readonly string[]
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly ports?: readonly (string | CanonicalComposePortPayload)[];
  readonly volumes?: readonly (string | CanonicalComposeMountPayload)[];
  readonly networks?:
    | readonly string[]
    | Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly network_mode?: string;
}

export interface CanonicalComposeVolumePayload {
  readonly name?: string;
  readonly external?: boolean;
  readonly driver?: string;
  readonly driver_opts?: Readonly<Record<string, string>>;
}

export interface CanonicalComposeNetworkPayload {
  readonly name?: string;
  readonly external?: boolean;
  readonly driver?: string;
  readonly ipam?: {
    readonly driver?: string;
    readonly config?: readonly {
      readonly subnet?: string;
      readonly ip_range?: string;
    }[];
  };
}

export interface CanonicalComposeConfigPayload {
  readonly name?: string;
  readonly services: Readonly<Record<string, CanonicalComposeServicePayload>>;
  readonly volumes?: Readonly<Record<string, CanonicalComposeVolumePayload>>;
  readonly networks?: Readonly<Record<string, CanonicalComposeNetworkPayload>>;
}

/** Long-form canonical Compose port payload accepted by the strict adapter. */
export function canonicalComposePort(
  overrides: Partial<CanonicalComposePortPayload> = {},
): CanonicalComposePortPayload {
  return {
    target: 8080,
    published: 8080,
    protocol: "tcp",
    ...overrides,
  };
}

/** Long-form canonical Compose mount payload accepted by the strict adapter. */
export function canonicalComposeMount(
  overrides: Partial<CanonicalComposeMountPayload> = {},
): CanonicalComposeMountPayload {
  return {
    type: "volume",
    source: "fixture-data",
    target: "/data",
    read_only: false,
    ...overrides,
  };
}

/** Canonical Compose service payload with all conflict-relevant collections present. */
export function canonicalComposeService(
  overrides: Partial<CanonicalComposeServicePayload> = {},
): CanonicalComposeServicePayload {
  return {
    image: "nginx:1.27",
    depends_on: {},
    ports: [],
    volumes: [],
    networks: {},
    ...overrides,
  };
}

/** Canonical top-level named-volume payload accepted by the strict adapter. */
export function canonicalComposeVolume(
  overrides: Partial<CanonicalComposeVolumePayload> = {},
): CanonicalComposeVolumePayload {
  return {
    name: "fixture-data",
    external: false,
    driver: "local",
    driver_opts: {},
    ...overrides,
  };
}

/** Canonical top-level network payload accepted by the strict adapter. */
export function canonicalComposeNetwork(
  overrides: Partial<CanonicalComposeNetworkPayload> = {},
): CanonicalComposeNetworkPayload {
  return {
    name: "fixture_default",
    external: false,
    driver: "bridge",
    ipam: { driver: "default", config: [] },
    ...overrides,
  };
}

/** Complete resolved Compose resource payload for preflight scenarios. */
export function canonicalComposeConfig(
  overrides: Partial<CanonicalComposeConfigPayload> = {},
): CanonicalComposeConfigPayload {
  return {
    name: "fixture",
    services: {
      web: canonicalComposeService(),
      db: canonicalComposeService({ image: "postgres:16" }),
    },
    volumes: {},
    networks: {},
    ...overrides,
  };
}

/** Output for `compose ... config --format json`. */
export function composeConfigJson(config: CanonicalComposeConfigPayload): string {
  return JSON.stringify(config);
}

/** Output for `compose ... config --services` — newline-joined service names. */
export function composeConfigServices(services: readonly string[]): string {
  return services.join("\n") + "\n";
}

/** Output for `docker inspect ...` — JSON array of {Id, Name: "/<name>", Config: {Image}, State: {Running: true}}. */
export function dockerInspectJson(
  entries: readonly { readonly name: string; readonly image: string }[],
): string {
  return JSON.stringify(
    entries.map((entry) => ({
      Id: `sha256:${entry.name}-container-id`,
      Name: `/${entry.name}`,
      Config: { Image: entry.image },
      State: { Running: true },
    })),
  );
}

export interface ContainerPortBindingPayload {
  readonly HostIp: string;
  readonly HostPort: string;
}

export interface ContainerMountPayload {
  readonly Type: "bind" | "volume" | "tmpfs";
  readonly Source?: string;
  readonly Name?: string;
  readonly Destination: string;
  readonly RW: boolean;
}

export interface ContainerInspectPayload {
  readonly Id: string;
  readonly Name: string;
  readonly Config: {
    readonly Labels: Readonly<Record<string, string>>;
  };
  readonly NetworkSettings: {
    readonly Ports: Readonly<Record<string, readonly ContainerPortBindingPayload[] | null>>;
  };
  readonly Mounts: readonly ContainerMountPayload[];
}

export interface ContainerInspectOptions {
  readonly id?: string;
  readonly name?: string;
  readonly project?: string;
  readonly service?: string;
  readonly ports?: Readonly<Record<string, readonly ContainerPortBindingPayload[] | null>>;
  readonly mounts?: readonly ContainerMountPayload[];
}

/** Strict container-inspect payload projected by `getConflictRuntimeContainers()`. */
export function containerInspectEntry(
  options: ContainerInspectOptions = {},
): ContainerInspectPayload {
  const labels: Record<string, string> = {};
  if (options.project !== undefined) {
    labels["com.docker.compose.project"] = options.project;
  }
  if (options.service !== undefined) {
    labels["com.docker.compose.service"] = options.service;
  }
  const name = options.name ?? "runtime-owner";
  return {
    Id: options.id ?? "a".repeat(64),
    Name: name.startsWith("/") ? name : `/${name}`,
    Config: { Labels: labels },
    NetworkSettings: { Ports: options.ports ?? {} },
    Mounts: options.mounts ?? [],
  };
}

/** JSON array returned by `docker inspect <container-id>...`. */
export function containerInspectJson(entries: readonly ContainerInspectPayload[]): string {
  return JSON.stringify(entries);
}

export interface NetworkInspectPayload {
  readonly Id: string;
  readonly Name: string;
  readonly Driver: string;
  readonly IPAM: {
    readonly Config: readonly { readonly Subnet?: string }[];
  };
}

export interface NetworkInspectOptions {
  readonly id?: string;
  readonly name?: string;
  readonly driver?: string;
  readonly subnets?: readonly string[];
}

/** Strict network-inspect payload projected by `getConflictRuntimeNetworks()`. */
export function networkInspectEntry(options: NetworkInspectOptions = {}): NetworkInspectPayload {
  return {
    Id: options.id ?? "b".repeat(64),
    Name: options.name ?? "fixture-shared",
    Driver: options.driver ?? "bridge",
    IPAM: {
      Config: (options.subnets ?? []).map((Subnet) => ({ Subnet })),
    },
  };
}

/** JSON array returned by `docker network inspect <network-id>...`. */
export function networkInspectJson(entries: readonly NetworkInspectPayload[]): string {
  return JSON.stringify(entries);
}

export interface VolumeInspectPayload {
  readonly Name: string;
  readonly Driver: string;
  readonly Options: Readonly<Record<string, string>>;
}

export interface VolumeInspectOptions {
  readonly name?: string;
  readonly driver?: string;
  readonly driverOptions?: Readonly<Record<string, string>>;
}

/** Strict volume-inspect payload projected by `getConflictRuntimeVolumes()`. */
export function volumeInspectEntry(options: VolumeInspectOptions = {}): VolumeInspectPayload {
  return {
    Name: options.name ?? "fixture-data",
    Driver: options.driver ?? "local",
    Options: options.driverOptions ?? {},
  };
}

/** JSON array returned by `docker volume inspect <volume-name>...`. */
export function volumeInspectJson(entries: readonly VolumeInspectPayload[]): string {
  return JSON.stringify(entries);
}
