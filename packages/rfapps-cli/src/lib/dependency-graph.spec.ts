import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanonicalComposeConfig, ComposeServiceConfig } from "./docker.js";

vi.mock("./docker.js", () => ({
  getComposeConfig: vi.fn(),
  getComposeServiceDependencies: vi.fn((service: ComposeServiceConfig | undefined) => {
    if (service?.depends_on === undefined) {
      return [];
    }
    if (Array.isArray(service.depends_on)) {
      return service.depends_on;
    }
    return Object.keys(service.depends_on);
  }),
}));

import { getComposeConfig } from "./docker.js";
import {
  buildServiceDependencyGraph,
  computeExecutionPhases,
  EffectiveServiceClosureError,
  resolveEffectiveServiceClosure,
  topologicalSort,
} from "./dependency-graph.js";
import type { RfappsConfig } from "../types/config.js";

/** Helper to create a minimal ComposeServiceConfig */
function svc(
  name: string,
  options: {
    depends_on?: string[] | Record<string, unknown>;
    network_mode?: string;
  } = {},
): ComposeServiceConfig {
  return { name, ...options };
}

/** Helper to build a compose config object from service entries */
function composeConfig(services: Record<string, ComposeServiceConfig>): {
  services: Record<string, ComposeServiceConfig>;
} {
  return { services };
}

/** Minimal RfappsConfig for tests -- only sidecars.mapping is used by the graph module */
function makeConfig(sidecarMapping: Record<string, string> = {}): RfappsConfig {
  return {
    composePath: "compose.yml",
    envFile: ".env",
    sidecars: { mapping: sidecarMapping, enabled: true },
    groups: {},
    profiles: { mapping: {}, defaultProfile: "all", validProfiles: ["all"] },
    healthCheck: { timeout: 60, interval: 1, retries: 3, waitForReady: true },
    envTool: { tool: "none" },
    docker: {},
    interactive: { pageSize: 10 },
    state: { enabled: true },
    parallel: { enabled: false, workers: 4 },
  };
}

describe("resolveEffectiveServiceClosure", () => {
  it("accepts strict canonical Compose services with readonly dependencies", () => {
    const services: CanonicalComposeConfig["services"] = {
      app: {
        name: "app",
        depends_on: ["database"],
        ports: [],
        volumes: [],
        networks: [],
      },
      database: {
        name: "database",
        depends_on: [],
        ports: [],
        volumes: [],
        networks: [],
      },
    };

    expect(resolveEffectiveServiceClosure(services, ["app"])).toEqual(["app", "database"]);
  });

  it("expands targeted services through transitive depends_on dependencies", () => {
    const services = {
      app: svc("app", { depends_on: ["database"] }),
      database: svc("database", { depends_on: ["storage"] }),
      storage: svc("storage"),
      unrelated: svc("unrelated"),
    };

    expect(resolveEffectiveServiceClosure(services, ["app"])).toEqual([
      "app",
      "database",
      "storage",
    ]);
  });

  it("includes network_mode service providers and their dependencies", () => {
    const services = {
      app: svc("app", { network_mode: "service:gateway" }),
      gateway: svc("gateway", { depends_on: ["dns"] }),
      dns: svc("dns"),
    };

    expect(resolveEffectiveServiceClosure(services, ["app"])).toEqual(["app", "dns", "gateway"]);
  });

  it("expands an untargeted empty scope to every concrete service", () => {
    const services = {
      worker: svc("worker"),
      api: svc("api"),
      database: svc("database"),
    };

    expect(resolveEffectiveServiceClosure(services, [])).toEqual(["api", "database", "worker"]);
  });

  it("returns a sorted result without mutating the targeted scope", () => {
    const targeted = ["zebra", "apple"];
    const services = {
      zebra: svc("zebra", { depends_on: ["mango"] }),
      mango: svc("mango"),
      apple: svc("apple"),
    };

    expect(resolveEffectiveServiceClosure(services, targeted)).toEqual(["apple", "mango", "zebra"]);
    expect(targeted).toEqual(["zebra", "apple"]);
  });

  it("fails explicitly when a dependency references a missing service", () => {
    const services = {
      app: svc("app", { depends_on: ["missing"] }),
    };

    expect(() => resolveEffectiveServiceClosure(services, ["app"])).toThrowError(
      new EffectiveServiceClosureError(
        'Service "app" references missing service "missing"',
        "MISSING_SERVICE_REFERENCE",
        ["app", "missing"],
      ),
    );
  });

  it("fails explicitly when the effective service graph contains a cycle", () => {
    const services = {
      api: svc("api", { depends_on: ["worker"] }),
      worker: svc("worker", { depends_on: ["database"] }),
      database: svc("database", { depends_on: ["api"] }),
    };

    expect(() => resolveEffectiveServiceClosure(services, ["api"])).toThrowError(
      new EffectiveServiceClosureError(
        "Effective service dependency cycle detected: api -> worker -> database -> api",
        "DEPENDENCY_CYCLE",
        ["api", "worker", "database", "api"],
      ),
    );
  });
});

describe("buildServiceDependencyGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty deps for services with no dependencies", () => {
    const config = composeConfig({
      a: svc("a"),
      b: svc("b"),
      c: svc("c"),
    });

    const result = buildServiceDependencyGraph(config, {}, ["a", "b", "c"]);

    expect(result.get("a")).toEqual([]);
    expect(result.get("b")).toEqual([]);
    expect(result.get("c")).toEqual([]);
  });

  it("extracts depends_on array dependencies", () => {
    const config = composeConfig({
      app: svc("app", { depends_on: ["db", "cache"] }),
      db: svc("db"),
      cache: svc("cache"),
    });

    const result = buildServiceDependencyGraph(config, {}, ["app", "db", "cache"]);

    expect(result.get("app")).toEqual(expect.arrayContaining(["db", "cache"]));
    expect(result.get("db")).toEqual([]);
    expect(result.get("cache")).toEqual([]);
  });

  it("extracts depends_on object dependencies", () => {
    const config = composeConfig({
      worker: svc("worker", { depends_on: { server: { condition: "service_healthy" } } }),
      server: svc("server"),
    });

    const result = buildServiceDependencyGraph(config, {}, ["worker", "server"]);

    expect(result.get("worker")).toEqual(["server"]);
  });

  it("extracts network_mode: service:<name> dependencies", () => {
    const config = composeConfig({
      plex: svc("plex", { network_mode: "service:plex-ts" }),
      "plex-ts": svc("plex-ts"),
    });

    const result = buildServiceDependencyGraph(config, {}, ["plex", "plex-ts"]);

    expect(result.get("plex")).toEqual(expect.arrayContaining(["plex-ts"]));
  });

  it("ignores network_mode values that are not service:<name>", () => {
    const config = composeConfig({
      app: svc("app", { network_mode: "bridge" }),
    });

    const result = buildServiceDependencyGraph(config, {}, ["app"]);

    expect(result.get("app")).toEqual([]);
  });

  it("filters dependencies to only include target services", () => {
    const config = composeConfig({
      app: svc("app", { depends_on: ["db", "external-svc"] }),
      db: svc("db"),
      "external-svc": svc("external-svc"),
    });

    // external-svc is NOT in target services
    const result = buildServiceDependencyGraph(config, {}, ["app", "db"]);

    expect(result.get("app")).toEqual(["db"]);
    expect(result.get("app")).not.toContain("external-svc");
  });

  it("merges sidecar pair dependencies into union", () => {
    const config = composeConfig({
      plex: svc("plex", { depends_on: ["some-service"] }),
      "plex-ts": svc("plex-ts", { depends_on: ["network-svc"] }),
      "some-service": svc("some-service"),
      "network-svc": svc("network-svc"),
    });

    const sidecarMapping = { plex: "plex-ts" };
    const result = buildServiceDependencyGraph(config, sidecarMapping, [
      "plex",
      "plex-ts",
      "some-service",
      "network-svc",
    ]);

    // Both should have the union of deps (excluding each other)
    const plexDeps = result.get("plex") ?? [];
    const plexTsDeps = result.get("plex-ts") ?? [];

    expect(plexDeps).toEqual(expect.arrayContaining(["some-service", "network-svc"]));
    expect(plexTsDeps).toEqual(expect.arrayContaining(["some-service", "network-svc"]));
    // Neither should list the other as a dependency
    expect(plexDeps).not.toContain("plex-ts");
    expect(plexTsDeps).not.toContain("plex");
  });

  it("skips sidecar merging when only one of the pair is in target set", () => {
    const config = composeConfig({
      plex: svc("plex", { depends_on: ["some-service"] }),
      "plex-ts": svc("plex-ts"),
      "some-service": svc("some-service"),
    });

    const sidecarMapping = { plex: "plex-ts" };
    // plex-ts is NOT in target services
    const result = buildServiceDependencyGraph(config, sidecarMapping, ["plex", "some-service"]);

    expect(result.get("plex")).toEqual(["some-service"]);
    expect(result.has("plex-ts")).toBe(false);
  });
});

describe("topologicalSort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty phases for empty dependency map", () => {
    const result = topologicalSort(new Map(), {});

    expect(result.phases).toEqual([]);
    expect(result.hasCycles).toBe(false);
  });

  it("places all independent services in Phase 0", () => {
    const depMap = new Map<string, string[]>([
      ["a", []],
      ["b", []],
      ["c", []],
      ["d", []],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.phase).toBe(0);
    expect(result.phases[0]?.services).toEqual(["a", "b", "c", "d"]);
    expect(result.phases[0]?.dependsOn).toEqual([]);
  });

  it("produces linear phases for a chain A -> B -> C", () => {
    // C depends on B, B depends on A
    const depMap = new Map<string, string[]>([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(3);

    expect(result.phases[0]?.phase).toBe(0);
    expect(result.phases[0]?.services).toEqual(["a"]);
    expect(result.phases[0]?.dependsOn).toEqual([]);

    expect(result.phases[1]?.phase).toBe(1);
    expect(result.phases[1]?.services).toEqual(["b"]);
    expect(result.phases[1]?.dependsOn).toEqual(["a"]);

    expect(result.phases[2]?.phase).toBe(2);
    expect(result.phases[2]?.services).toEqual(["c"]);
    expect(result.phases[2]?.dependsOn).toEqual(["b"]);
  });

  it("produces diamond dependency phases: D -> B+C -> A", () => {
    // A depends on B and C, both B and C depend on D
    const depMap = new Map<string, string[]>([
      ["d", []],
      ["b", ["d"]],
      ["c", ["d"]],
      ["a", ["b", "c"]],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(3);

    expect(result.phases[0]?.phase).toBe(0);
    expect(result.phases[0]?.services).toEqual(["d"]);

    expect(result.phases[1]?.phase).toBe(1);
    expect(result.phases[1]?.services).toEqual(["b", "c"]);
    expect(result.phases[1]?.dependsOn).toEqual(["d"]);

    expect(result.phases[2]?.phase).toBe(2);
    expect(result.phases[2]?.services).toEqual(["a"]);
    expect(result.phases[2]?.dependsOn).toEqual(expect.arrayContaining(["b", "c"]));
  });

  it("detects cycles: A -> B -> C -> A", () => {
    const depMap = new Map<string, string[]>([
      ["a", ["c"]],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(true);
    expect(result.cycleServices).toBeDefined();
    expect(result.cycleServices).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(result.cycleServices).toHaveLength(3);
  });

  it("detects partial cycle with non-cyclic services", () => {
    // d has no deps, a -> b -> c -> a forms a cycle
    const depMap = new Map<string, string[]>([
      ["d", []],
      ["a", ["c"]],
      ["b", ["a"]],
      ["c", ["b"]],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(true);
    expect(result.cycleServices).toEqual(expect.arrayContaining(["a", "b", "c"]));
    // Phase 0 should still have "d" processed
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.services).toEqual(["d"]);
  });

  it("handles disconnected components in Phase 0", () => {
    // Two independent subgraphs: (a -> b) and (c -> d)
    const depMap = new Map<string, string[]>([
      ["a", []],
      ["b", ["a"]],
      ["c", []],
      ["d", ["c"]],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(2);

    // Phase 0: roots from both subgraphs
    expect(result.phases[0]?.services).toEqual(["a", "c"]);
    // Phase 1: dependents from both subgraphs
    expect(result.phases[1]?.services).toEqual(["b", "d"]);
  });

  it("handles fully disconnected independent components all in Phase 0", () => {
    // Two completely independent subgraphs with no internal deps
    const depMap = new Map<string, string[]>([
      ["x1", []],
      ["x2", []],
      ["y1", []],
      ["y2", []],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.services).toEqual(["x1", "x2", "y1", "y2"]);
  });

  it("aligns sidecar pairs that share identical merged dependency arrays", () => {
    // Sidecar pair with merged deps should already be in the same phase
    // after merging, but if they end up misaligned, enforceSidecarPhaseAlignment fixes it
    const sharedDeps = ["base-svc"];
    const depMap = new Map<string, string[]>([
      ["base-svc", []],
      ["main-svc", sharedDeps],
      ["sidecar-svc", sharedDeps],
    ]);

    const sidecarMapping = { "main-svc": "sidecar-svc" };
    const result = topologicalSort(depMap, sidecarMapping);

    expect(result.hasCycles).toBe(false);

    // Both should be in the same phase (alignment uses config mapping)
    const mainPhase = result.phases.find((p) => p.services.includes("main-svc"));
    const sidecarPhase = result.phases.find((p) => p.services.includes("sidecar-svc"));
    expect(mainPhase?.phase).toBe(sidecarPhase?.phase);
  });

  it("sorts services deterministically within phases", () => {
    const depMap = new Map<string, string[]>([
      ["zebra", []],
      ["apple", []],
      ["mango", []],
    ]);

    const result = topologicalSort(depMap, {});

    expect(result.phases[0]?.services).toEqual(["apple", "mango", "zebra"]);
  });
});

describe("buildServiceDependencyGraph + topologicalSort integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sidecar with network_mode: sidecar starts before main service", () => {
    // plex uses network_mode: service:plex-ts so it mounts plex-ts's
    // network namespace. plex-ts must be fully running before plex starts.
    const config = composeConfig({
      plex: svc("plex", {
        depends_on: ["plex-ts"],
        network_mode: "service:plex-ts",
      }),
      "plex-ts": svc("plex-ts"),
      sonarr: svc("sonarr"),
    });

    const sidecarMapping = { plex: "plex-ts" };
    const targets = ["plex", "plex-ts", "sonarr"];

    const depMap = buildServiceDependencyGraph(config, sidecarMapping, targets);
    const result = topologicalSort(depMap, sidecarMapping);

    expect(result.hasCycles).toBe(false);

    // plex-ts must be in an earlier phase than plex so it starts first.
    const plexPhase = result.phases.find((p) => p.services.includes("plex"));
    const plexTsPhase = result.phases.find((p) => p.services.includes("plex-ts"));
    expect(plexTsPhase!.phase).toBeLessThan(plexPhase!.phase);

    // sonarr and plex-ts have no deps — both in Phase 0
    expect(result.phases[0]?.services).toContain("sonarr");
    expect(result.phases[0]?.services).toContain("plex-ts");
  });

  it("sidecar pair elevated when service depends on a Phase 1 item", () => {
    // Setup:
    // - sidecar-ts has no deps -> normally Phase 0
    // - main-svc depends on intermediate -> normally Phase 1
    // - intermediate depends on base -> Phase 1
    // - base has no deps -> Phase 0
    // After sidecar merging, both main-svc and sidecar-ts share merged deps,
    // so both should end up in the same phase (Phase 2)
    const config = composeConfig({
      base: svc("base"),
      intermediate: svc("intermediate", { depends_on: ["base"] }),
      "main-svc": svc("main-svc", { depends_on: ["intermediate"] }),
      "sidecar-ts": svc("sidecar-ts"),
    });

    const sidecarMapping = { "main-svc": "sidecar-ts" };
    const targets = ["base", "intermediate", "main-svc", "sidecar-ts"];

    const depMap = buildServiceDependencyGraph(config, sidecarMapping, targets);
    const result = topologicalSort(depMap, sidecarMapping);

    expect(result.hasCycles).toBe(false);

    // main-svc depends on intermediate (Phase 1), so main-svc is Phase 2
    // sidecar-ts should be elevated to match main-svc's phase
    const mainPhase = result.phases.find((p) => p.services.includes("main-svc"));
    const sidecarPhase = result.phases.find((p) => p.services.includes("sidecar-ts"));
    expect(mainPhase).toBeDefined();
    expect(sidecarPhase).toBeDefined();
    expect(mainPhase?.phase).toBe(sidecarPhase?.phase);

    // Both should be after intermediate
    const intermediatePhase = result.phases.find((p) => p.services.includes("intermediate"));
    expect(mainPhase!.phase).toBeGreaterThan(intermediatePhase!.phase);
  });

  it("target service filtering ignores external dependencies", () => {
    const config = composeConfig({
      app: svc("app", { depends_on: ["db", "external-svc"] }),
      db: svc("db"),
      "external-svc": svc("external-svc"),
    });

    // Only targeting app and db; external-svc is not in target set
    const depMap = buildServiceDependencyGraph(config, {}, ["app", "db"]);
    const result = topologicalSort(depMap, {});

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]?.services).toEqual(["db"]);
    expect(result.phases[1]?.services).toEqual(["app"]);
    // external-svc should not appear anywhere
    const allServices = result.phases.flatMap((p) => p.services);
    expect(allServices).not.toContain("external-svc");
  });

  it("real-world compose dependency map: authentik chain, immich cluster, unpackerr", () => {
    const config = composeConfig({
      // Phase 0: ~40 independent services (representing a subset)
      sonarr: svc("sonarr"),
      radarr: svc("radarr"),
      bazarr: svc("bazarr"),
      prowlarr: svc("prowlarr"),
      sabnzbd: svc("sabnzbd"),
      "plex-ts": svc("plex-ts"),
      "immich-ts": svc("immich-ts"),
      "authentik-db": svc("authentik-db"),
      "authentik-redis": svc("authentik-redis"),
      "immich-ml": svc("immich-ml"),
      "immich-postgres": svc("immich-postgres"),
      "immich-redis": svc("immich-redis"),
      homarr: svc("homarr"),
      tautulli: svc("tautulli"),

      // Phase 0: traefik (no tailscale sidecar depends_on)
      traefik: svc("traefik"),
      plex: svc("plex", {
        network_mode: "service:plex-ts",
      }),
      "authentik-server": svc("authentik-server", {
        depends_on: {
          "authentik-db": { condition: "service_started" },
          "authentik-redis": { condition: "service_started" },
        },
      }),
      "immich-server": svc("immich-server", {
        depends_on: {
          "immich-ts": { condition: "service_started" },
          "immich-ml": { condition: "service_started" },
          "immich-postgres": { condition: "service_started" },
          "immich-redis": { condition: "service_started" },
        },
        network_mode: "service:immich-ts",
      }),
      unpackerr: svc("unpackerr", {
        depends_on: {
          sabnzbd: { condition: "service_healthy" },
          radarr: { condition: "service_healthy" },
          sonarr: { condition: "service_healthy" },
        },
      }),

      // Phase 2: services that depend on Phase 1 items
      "authentik-worker": svc("authentik-worker", {
        depends_on: {
          "authentik-server": { condition: "service_healthy" },
          "authentik-db": { condition: "service_started" },
          "authentik-redis": { condition: "service_started" },
        },
      }),
      "authentik-media": svc("authentik-media", {
        depends_on: {
          "authentik-server": { condition: "service_healthy" },
          "authentik-db": { condition: "service_started" },
          "authentik-redis": { condition: "service_started" },
        },
      }),
    });

    const sidecarMapping = {
      plex: "plex-ts",
      "immich-server": "immich-ts",
    };

    const allTargets = Object.keys(config.services);
    const depMap = buildServiceDependencyGraph(config, sidecarMapping, allTargets);
    const result = topologicalSort(depMap, sidecarMapping);

    expect(result.hasCycles).toBe(false);

    // Phase 0: all independent services
    const phase0 = result.phases.find((p) => p.phase === 0);
    expect(phase0).toBeDefined();
    expect(phase0!.services).toContain("sonarr");
    expect(phase0!.services).toContain("radarr");
    expect(phase0!.services).toContain("authentik-db");
    expect(phase0!.services).toContain("authentik-redis");
    expect(phase0!.services).toContain("immich-ml");
    expect(phase0!.services).toContain("immich-postgres");
    expect(phase0!.services).toContain("immich-redis");
    expect(phase0!.services).toContain("sabnzbd");
    expect(phase0!.services).toContain("homarr");
    expect(phase0!.services).toContain("tautulli");
    expect(phase0!.services).toContain("traefik");
    expect(phase0!.dependsOn).toEqual([]);

    // Phase 1: services that depend on Phase 0 items
    const phase1 = result.phases.find((p) => p.phase === 1);
    expect(phase1).toBeDefined();
    expect(phase1!.services).toContain("authentik-server");
    expect(phase1!.services).toContain("unpackerr");
    // plex uses network_mode: service:plex-ts — plex-ts must start first
    const plexPhase = result.phases.find((p) => p.services.includes("plex"));
    const plexTsPhase = result.phases.find((p) => p.services.includes("plex-ts"));
    expect(plexTsPhase!.phase).toBeLessThan(plexPhase!.phase);
    // immich-server uses network_mode: service:immich-ts — immich-ts must start first
    const immichPhase = result.phases.find((p) => p.services.includes("immich-server"));
    const immichTsPhase = result.phases.find((p) => p.services.includes("immich-ts"));
    expect(immichTsPhase!.phase).toBeLessThan(immichPhase!.phase);

    // Phase 2: authentik-worker and authentik-media depend on authentik-server
    const phase2 = result.phases.find((p) => p.phase === 2);
    expect(phase2).toBeDefined();
    expect(phase2!.services).toContain("authentik-worker");
    expect(phase2!.services).toContain("authentik-media");

    // Verify all services are accounted for
    const allSorted = result.phases.flatMap((p) => p.services);
    expect(allSorted).toHaveLength(allTargets.length);
    for (const target of allTargets) {
      expect(allSorted).toContain(target);
    }
  });
});

describe("computeExecutionPhases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty phases for empty service list", async () => {
    const config = makeConfig();
    const result = await computeExecutionPhases("compose.yml", config, []);

    expect(result.phases).toEqual([]);
    expect(result.hasCycles).toBe(false);
  });

  it("returns single Phase 0 when compose config is undefined", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue(undefined);
    const config = makeConfig();

    const result = await computeExecutionPhases("compose.yml", config, ["svc-a", "svc-b"]);

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]?.phase).toBe(0);
    expect(result.phases[0]?.services).toEqual(["svc-a", "svc-b"]);
  });

  it("orchestrates full pipeline: compose config -> dependency graph -> phases", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        db: svc("db"),
        app: svc("app", { depends_on: ["db"] }),
        worker: svc("worker", { depends_on: ["app"] }),
      },
    });

    const config = makeConfig();
    const result = await computeExecutionPhases("compose.yml", config, ["db", "app", "worker"]);

    expect(result.hasCycles).toBe(false);
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]?.services).toEqual(["db"]);
    expect(result.phases[1]?.services).toEqual(["app"]);
    expect(result.phases[2]?.services).toEqual(["worker"]);
  });

  it("passes composePath to getComposeConfig", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: svc("app"),
      },
    });

    const config = makeConfig();
    await computeExecutionPhases("/path/to/compose.yml", config, ["app"]);

    expect(getComposeConfig).toHaveBeenCalledWith("/path/to/compose.yml", { envTool: undefined });
  });

  it("forwards envTool to getComposeConfig so compose interpolation resolves", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        app: svc("app"),
      },
    });

    const config = makeConfig();
    const envTool = { tool: "dotenvx" as const, envFile: ".env.local" };
    await computeExecutionPhases("/path/to/compose.yml", config, ["app"], envTool);

    expect(getComposeConfig).toHaveBeenCalledWith("/path/to/compose.yml", { envTool });
  });

  it("uses sidecar mapping from config for merging", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        base: svc("base"),
        plex: svc("plex", { depends_on: ["base"] }),
        "plex-ts": svc("plex-ts"),
      },
    });

    const config = makeConfig({ plex: "plex-ts" });
    const result = await computeExecutionPhases("compose.yml", config, ["base", "plex", "plex-ts"]);

    expect(result.hasCycles).toBe(false);

    // plex and plex-ts should be in the same phase, after base
    const plexPhase = result.phases.find((p) => p.services.includes("plex"));
    const plexTsPhase = result.phases.find((p) => p.services.includes("plex-ts"));
    expect(plexPhase?.phase).toBe(plexTsPhase?.phase);
    expect(plexPhase!.phase).toBeGreaterThan(0);
  });

  it("detects cycles and reports cycleServices", async () => {
    vi.mocked(getComposeConfig).mockResolvedValue({
      services: {
        a: svc("a", { depends_on: ["c"] }),
        b: svc("b", { depends_on: ["a"] }),
        c: svc("c", { depends_on: ["b"] }),
      },
    });

    const config = makeConfig();
    const result = await computeExecutionPhases("compose.yml", config, ["a", "b", "c"]);

    expect(result.hasCycles).toBe(true);
    expect(result.cycleServices).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });
});
