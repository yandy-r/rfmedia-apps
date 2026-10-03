import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseEnvArray,
  parsePortBindings,
  parseComposePorts,
  isSecretEnvVar,
  arraysEqualIgnoreOrder,
  detectDrift,
  hasImportableDrift,
  observeReconcileDrift,
} from "./drift.js";
import { buildReconcilePlan, runReconcile } from "./reconcile.js";
import { RECONCILE_MAX_SERVICES } from "../types/reconcile.js";
import * as docker from "./docker.js";
import * as serviceStatus from "./service-status.js";

// Mock docker module
vi.mock("./docker.js", () => ({
  getComposeConfig: vi.fn(),
  getComposeContainerObservations: vi.fn(),
  getRunningServiceContainerMap: vi.fn(),
  inspectImageDefaultEnvironments: vi.fn(),
  inspectContainers: vi.fn(),
}));
vi.mock("./service-status.js", () => ({
  getServiceStatusMap: vi.fn(),
}));

describe("Drift Library", () => {
  describe("isSecretEnvVar", () => {
    it("should identify secret variables", () => {
      expect(isSecretEnvVar("DB_PASSWORD")).toBe(true);
      expect(isSecretEnvVar("API_KEY")).toBe(true);
      expect(isSecretEnvVar("AUTH_TOKEN")).toBe(true);
      expect(isSecretEnvVar("MY_SECRET")).toBe(true);
      expect(isSecretEnvVar("private_key")).toBe(true);
    });

    it("should identify non-secret variables", () => {
      expect(isSecretEnvVar("DB_HOST")).toBe(false);
      expect(isSecretEnvVar("PORT")).toBe(false);
      expect(isSecretEnvVar("NODE_ENV")).toBe(false);
    });
  });

  describe("parseEnvArray", () => {
    it("should parse environment array correctly", () => {
      const input = ["KEY1=value1", "KEY2=value2"];
      const expected = { KEY1: "value1", KEY2: "value2" };
      expect(parseEnvArray(input)).toEqual(expected);
    });

    it("should handle variables with multiple equals signs", () => {
      const input = ["CONN_STR=host=localhost;db=test"];
      const expected = { CONN_STR: "host=localhost;db=test" };
      expect(parseEnvArray(input)).toEqual(expected);
    });

    it("should handle empty values", () => {
      const input = ["EMPTY="];
      const expected = { EMPTY: "" };
      expect(parseEnvArray(input)).toEqual(expected);
    });

    it("should ignore entries without equals sign", () => {
      const input = ["INVALID"];
      expect(parseEnvArray(input)).toEqual({});
    });

    it("should ignore entries with empty key", () => {
      const input = ["=value"];
      expect(parseEnvArray(input)).toEqual({});
    });
  });

  describe("parsePortBindings", () => {
    it("should return empty array for null/undefined", () => {
      expect(parsePortBindings(null)).toEqual([]);
      expect(parsePortBindings(undefined)).toEqual([]);
    });

    it("should parse port bindings correctly", () => {
      const input = {
        "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "8443" }],
      };
      const expected = [
        { host: "8080", container: "80", protocol: "tcp" },
        { host: "8443", container: "443", protocol: "tcp" },
      ];
      expect(parsePortBindings(input)).toEqual(expected);
    });

    it("should handle multiple bindings for same port", () => {
      const input = {
        "80/tcp": [
          { HostIp: "0.0.0.0", HostPort: "8080" },
          { HostIp: "::", HostPort: "8081" },
        ],
      };
      const expected = [
        { host: "8080", container: "80", protocol: "tcp" },
        { host: "8081", container: "80", protocol: "tcp" },
      ];
      expect(parsePortBindings(input)).toEqual(expected);
    });
  });

  describe("parseComposePorts", () => {
    it("should parse string format ports", () => {
      const input = ["8080:80", "8443:443/tcp", "53:53/udp"];
      const expected = [
        { host: "8080", container: "80", protocol: "tcp" },
        { host: "8443", container: "443", protocol: "tcp" },
        { host: "53", container: "53", protocol: "udp" },
      ];
      expect(parseComposePorts(input)).toEqual(expected);
    });

    it("should parse object format ports", () => {
      const input = [
        { target: 80, published: 8080, protocol: "tcp" },
        { target: 53, published: 53, protocol: "udp" },
      ];
      const expected = [
        { host: "8080", container: "80", protocol: "tcp" },
        { host: "53", container: "53", protocol: "udp" },
      ];
      expect(parseComposePorts(input)).toEqual(expected);
    });
  });

  describe("arraysEqualIgnoreOrder", () => {
    it("should return true for identical arrays", () => {
      expect(arraysEqualIgnoreOrder([1, 2], [1, 2])).toBe(true);
    });

    it("should return true for same elements different order", () => {
      expect(arraysEqualIgnoreOrder([1, 2], [2, 1])).toBe(true);
    });

    it("should return false for different lengths", () => {
      expect(arraysEqualIgnoreOrder([1, 2], [1])).toBe(false);
    });

    it("should return false for different elements", () => {
      expect(arraysEqualIgnoreOrder([1, 2], [1, 3])).toBe(false);
    });

    it("should handle objects", () => {
      const a = [{ id: 1 }, { id: 2 }];
      const b = [{ id: 2 }, { id: 1 }];
      expect(arraysEqualIgnoreOrder(a, b)).toBe(true);
    });

    it("should handle undefined", () => {
      expect(arraysEqualIgnoreOrder(undefined, undefined)).toBe(true);
      expect(arraysEqualIgnoreOrder([], undefined)).toBe(false);
    });
  });

  describe("detectDrift", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(serviceStatus.getServiceStatusMap).mockResolvedValue(
        new Map([["app", { state: "running", health: "none" }]]),
      );
    });

    it("should return undefined if compose config is missing", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue(undefined);
      const result = await detectDrift({ composePath: "compose.yml" });
      expect(result).toBeUndefined();
    });

    it("should detect no drift when states match", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            name: "app",
            image: "app:latest",
            environment: {
              KEY: "value",
            },
            networks: ["bridge"],
          },
        },
      } as any);

      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );

      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: {
            Image: "app:latest",
            Env: ["KEY=value"],
          },
          HostConfig: {
            PortBindings: {},
            Binds: [],
            NetworkMode: "bridge",
          },
          NetworkSettings: {
            Networks: { bridge: {} },
          },
        } as any,
      ]);

      const result = await detectDrift({ composePath: "compose.yml" });

      expect(result).toBeDefined();
      expect(result?.schemaVersion).toBe("1.0.0");
      expect(result?.summary.drifted).toBe(0);
      expect(result?.services[0]?.hasDrift).toBe(false);
      expect(result?.services[0]?.runtimeStatus.changed).toBe(false);
    });

    it("should detect drift when image differs", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            name: "app",
            image: "app:v2",
          },
        },
      });

      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );

      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: {
            Image: "app:v1",
            Env: [],
          },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: { Networks: { bridge: {} } },
        } as any,
      ]);

      const result = await detectDrift({ composePath: "compose.yml" });

      expect(result).toBeDefined();
      expect(result?.summary.drifted).toBe(1);
      expect(result?.services[0]?.hasDrift).toBe(true);
      expect(result?.services[0]?.categories).toContain("image");
      expect(result?.services[0]?.direction).toBe("diverged");
    });

    it("should ignore image-provided environment variables that are not declared in compose", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            name: "app",
            image: "app:latest",
            environment: {
              PUID: "1000",
              PGID: "1000",
            },
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: {
            Image: "app:latest",
            Env: [
              "PUID=1000",
              "PGID=1000",
              "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              "APP_DIR=/app",
              "CONFIG_DIR=/config",
              "IMAGE_STATS=base64-payload",
              "VPN_PIA_DIP_TOKEN=runtime-secret",
            ],
          },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: {},
        } as any,
      ]);

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result?.summary.drifted).toBe(0);
      expect(result?.services[0]?.categories).not.toContain("environment");
      expect(result?.services[0]?.environment).toEqual([
        {
          name: "PUID",
          current: "1000",
          desired: "1000",
          changeType: "unchanged",
          isSecret: false,
        },
        {
          name: "PGID",
          current: "1000",
          desired: "1000",
          changeType: "unchanged",
          isSecret: false,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("runtime-secret");
    });

    it("should detect drift for declared environment variables that are missing or changed", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            name: "app",
            image: "app:latest",
            environment: {
              PUID: "1000",
              PGID: "1000",
              TZ: "Etc/UTC",
            },
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: {
            Image: "app:latest",
            Env: ["PUID=1001", "PATH=/usr/bin"],
          },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: {},
        } as any,
      ]);

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result?.summary.drifted).toBe(1);
      expect(result?.services[0]?.categories).toContain("environment");
      expect(result?.services[0]?.environment).toEqual([
        {
          name: "PUID",
          current: "1001",
          desired: "1000",
          changeType: "modified",
          isSecret: false,
        },
        {
          name: "PGID",
          current: undefined,
          desired: "1000",
          changeType: "added",
          isSecret: false,
        },
        {
          name: "TZ",
          current: undefined,
          desired: "Etc/UTC",
          changeType: "added",
          isSecret: false,
        },
      ]);
    });

    it("should detect runtime-status drift when a selected service is missing", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            image: "app:latest",
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(new Map());
      vi.mocked(docker.inspectContainers).mockResolvedValue([]);
      vi.mocked(serviceStatus.getServiceStatusMap).mockResolvedValue(
        new Map([["app", { state: "created", health: "none" }]]),
      );

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result?.summary.drifted).toBe(1);
      expect(result?.services[0]?.categories).toContain("runtime-status");
      expect(result?.services[0]?.runtimeStatus).toEqual({
        current: { state: "created", health: "none" },
        desired: { state: "running", health: "none" },
        changed: true,
      });
    });

    it("should detect runtime-status drift for exited and unhealthy services", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            image: "app:latest",
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: { Image: "app:latest", Env: [] },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: {},
        } as any,
      ]);
      vi.mocked(serviceStatus.getServiceStatusMap).mockResolvedValue(
        new Map([["app", { state: "exited", health: "unhealthy" }]]),
      );

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result?.services[0]?.categories).toContain("runtime-status");
      expect(result?.services[0]?.runtimeStatus.current).toEqual({
        state: "exited",
        health: "unhealthy",
      });
      expect(result?.services[0]?.runtimeStatus.desired).toEqual({
        state: "running",
        health: "healthy",
      });
    });

    it("should not detect runtime-status drift for healthy running services", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            image: "app:latest",
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: { Image: "app:latest", Env: [] },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: {},
        } as any,
      ]);
      vi.mocked(serviceStatus.getServiceStatusMap).mockResolvedValue(
        new Map([["app", { state: "running", health: "healthy" }]]),
      );

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result?.summary.drifted).toBe(0);
      expect(result?.services[0]?.categories).not.toContain("runtime-status");
      expect(result?.services[0]?.runtimeStatus.changed).toBe(false);
    });

    it("should mask secret environment values in serialized drift results", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            image: "app:latest",
            environment: {
              DB_PASSWORD: "desired-secret",
            },
          },
        },
      } as any);
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-container"]]),
      );
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          Name: "/app-container",
          Config: {
            Image: "app:latest",
            Env: ["DB_PASSWORD=current-secret"],
          },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: { Networks: {} },
        } as any,
      ]);

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });
      const serialized = JSON.stringify(result);

      expect(serialized).toContain("********");
      expect(serialized).not.toContain("current-secret");
      expect(serialized).not.toContain("desired-secret");
    });
  });

  describe("observeReconcileDrift", () => {
    const containerId = "aaaaaaaaaaaa";
    const runningObservation: docker.ComposeContainerObservation = {
      containerId,
      containerName: "app-1",
      serviceName: "app",
      state: "running",
      health: "",
    };
    const matchingInspect: docker.ContainerInspect = {
      Id: containerId,
      Name: "/app-1",
      Image: "sha256:image-id",
      Config: { Image: "app:latest", Env: ["KEY=value"] },
      HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
      NetworkSettings: {},
      State: { Running: true, ExitCode: 0, Status: "running" },
    };

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: {
          app: {
            name: "app",
            image: "app:latest",
            environment: { KEY: "value" },
          },
        },
      } as never);
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue([runningObservation]);
      vi.mocked(docker.inspectContainers).mockResolvedValue([matchingInspect]);
      vi.mocked(docker.inspectImageDefaultEnvironments).mockResolvedValue(
        new Map([[matchingInspect.Image, { KEY: "value" }]]),
      );
    });

    it("returns a missing observation and comparator drift for a selected service", async () => {
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue([]);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.service).toBe("app");
      expect(evidence[0]?.observation).toEqual({ kind: "missing" });
      expect(evidence[0]?.drift?.categories).toEqual(["image", "environment", "runtime-status"]);
      expect(evidence[0]?.drift?.runtimeStatus.current.state).toBe("created");
      expect(docker.inspectContainers).not.toHaveBeenCalled();
    });

    it("distinguishes one stopped container while reusing the field comparator", async () => {
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue([
        { ...runningObservation, state: "exited" },
      ]);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.observation).toEqual({
        kind: "present",
        containers: [{ id: containerId, name: "app-1", state: "exited", health: "none" }],
      });
      expect(evidence[0]?.drift?.categories).toEqual(["runtime-status"]);
      expect(evidence[0]?.drift?.runtimeStatus.current.state).toBe("exited");
    });

    it("returns one running container with the existing no-drift comparison", async () => {
      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
        projectName: "reviewed-project",
        envFile: "/project/reviewed.env",
      });

      expect(evidence[0]?.observation.kind).toBe("present");
      expect(evidence[0]?.drift?.hasDrift).toBe(false);
      expect(evidence[0]?.drift?.categories).toEqual([]);
      expect(docker.getComposeContainerObservations).toHaveBeenCalledWith(
        "compose.yml",
        expect.objectContaining({
          projectName: "reviewed-project",
          envFile: "/project/reviewed.env",
        }),
      );
    });

    it("batches maximum-scope image evidence into one bounded inspection", async () => {
      const services = Array.from(
        { length: RECONCILE_MAX_SERVICES },
        (_, index) => `service-${index}`,
      );
      const observations = services.map((service, index) => ({
        containerId: `container-${index}`,
        containerName: `${service}-1`,
        serviceName: service,
        state: "running",
        health: "",
      }));
      const inspected = services.map(
        (service, index): docker.ContainerInspect => ({
          Id: `container-${index}`,
          Name: `/${service}-1`,
          Image: `sha256:${index.toString(16).padStart(64, "0")}`,
          Config: { Image: `${service}:latest`, Env: [] },
          HostConfig: { PortBindings: {}, Binds: [], NetworkMode: "bridge" },
          NetworkSettings: {},
          State: { Running: true, ExitCode: 0, Status: "running" },
        }),
      );
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: Object.fromEntries(
          services.map((service) => [service, { name: service, image: `${service}:latest` }]),
        ),
      } as never);
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue(observations);
      vi.mocked(docker.inspectContainers).mockResolvedValue(inspected);
      vi.mocked(docker.inspectImageDefaultEnvironments).mockImplementation(
        async (imageIds) => new Map(imageIds.map((imageId) => [imageId, {}])),
      );

      const evidence = await observeReconcileDrift({ composePath: "compose.yml", services });

      expect(evidence).toHaveLength(RECONCILE_MAX_SERVICES);
      expect(docker.inspectImageDefaultEnvironments).toHaveBeenCalledOnce();
      expect(vi.mocked(docker.inspectImageDefaultEnvironments).mock.calls[0]?.[0]).toHaveLength(
        RECONCILE_MAX_SERVICES,
      );
    });

    it("detects a removed Compose override while ignoring unchanged image defaults", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: { app: { name: "app", image: "app:latest", environment: {} } },
      } as never);
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          ...matchingInspect,
          Config: {
            ...matchingInspect.Config,
            Env: ["PATH=/usr/bin", "OLD_PASSWORD=runtime-secret"],
          },
        },
      ]);
      vi.mocked(docker.inspectImageDefaultEnvironments).mockResolvedValue(
        new Map([[matchingInspect.Image, { PATH: "/usr/bin" }]]),
      );

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.drift?.categories).toEqual(["environment"]);
      expect(evidence[0]?.drift?.environment).toEqual([
        {
          name: "OLD_PASSWORD",
          current: "********",
          desired: undefined,
          changeType: "removed",
          isSecret: true,
        },
      ]);
      expect(JSON.stringify(evidence)).not.toContain("runtime-secret");
    });

    it("keeps image-default-only environment variables in sync", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: { app: { name: "app", image: "app:latest", environment: {} } },
      } as never);
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        {
          ...matchingInspect,
          Config: { ...matchingInspect.Config, Env: ["PATH=/usr/bin"] },
        },
      ]);
      vi.mocked(docker.inspectImageDefaultEnvironments).mockResolvedValue(
        new Map([[matchingInspect.Image, { PATH: "/usr/bin" }]]),
      );

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.drift?.hasDrift).toBe(false);
      expect(evidence[0]?.drift?.environment).toEqual([]);
    });

    it("recreates a removed override and proves convergence against image defaults", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: { app: { name: "app", image: "app:latest", environment: {} } },
      } as never);
      vi.mocked(docker.inspectImageDefaultEnvironments).mockResolvedValue(
        new Map([[matchingInspect.Image, { PATH: "/usr/bin" }]]),
      );
      vi.mocked(docker.inspectContainers)
        .mockResolvedValueOnce([
          {
            ...matchingInspect,
            Config: { ...matchingInspect.Config, Env: ["PATH=/usr/bin", "REMOVED=value"] },
          },
        ])
        .mockResolvedValueOnce([
          {
            ...matchingInspect,
            Config: { ...matchingInspect.Config, Env: ["PATH=/usr/bin"] },
          },
        ]);
      const before = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });
      const after = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });
      const snapshot = (evidence: typeof before) => ({
        mode: "auto-apply" as const,
        dryRun: false,
        scope: {
          composePath: "/project/compose.yml",
          project: "project",
          profiles: [],
          services: ["app"],
        },
        authority: {
          composeFingerprint: "compose",
          resolvedComposeFingerprint: "resolved-compose",
          dockerAuthorityFingerprint: "docker",
          environmentSourceFingerprint: "environment",
        },
        services: evidence.map((entry) => ({
          service: entry.service,
          resolvedConfigFingerprint: "config",
          observation: entry.observation,
          ...(entry.drift === undefined ? {} : { drift: entry.drift }),
        })),
      });
      const initial = snapshot(before);
      const converged = snapshot(after);
      const reconcileTarget = vi.fn(async () => ({ success: true }));
      const captures = [initial, initial, converged];

      const result = await runReconcile(
        initial,
        {},
        {
          observation: { capture: vi.fn(async () => structuredClone(captures.shift()!)) },
          order: { phases: vi.fn(async () => [["app"]]) },
          execution: {
            reconcileService: reconcileTarget,
            verifyReadiness: vi.fn(async () => true),
          },
          lock: {
            acquire: vi.fn(async () => ({
              path: "/state/reconcile.lock",
              owner: {
                pid: 1,
                startedAt: "2026-07-18T00:00:00.000Z",
                projectPath: "/project",
                dockerContext: "docker",
              },
              release: vi.fn(async () => undefined),
            })),
          },
          policy: { evaluate: () => ({ status: "allowed" }) },
          signal: { getInterruption: () => undefined },
          clock: { now: () => 0 },
        },
      );

      expect(buildReconcilePlan(initial).services[0]?.action.kind).toBe("recreate");
      expect(reconcileTarget).toHaveBeenCalledWith(expect.objectContaining({ action: "recreate" }));
      expect(result.services[0]?.outcome).toBe("converged");
      expect(result.exitCode).toBe(0);
    });

    it("retains every container when multiplicity is ambiguous", async () => {
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue([
        { ...runningObservation, containerId: "bbbbbbbbbbbb", containerName: "app-2" },
        runningObservation,
      ]);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.observation).toEqual({
        kind: "ambiguous",
        containers: [
          { id: containerId, name: "app-1", state: "running", health: "none" },
          { id: "bbbbbbbbbbbb", name: "app-2", state: "running", health: "none" },
        ],
      });
      expect(evidence[0]?.drift).toBeUndefined();
      expect(docker.inspectContainers).not.toHaveBeenCalled();
    });

    it("returns one failed entry per selected service when Compose intent cannot be observed", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue(undefined);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["worker", "app"],
      });

      expect(evidence).toEqual([
        {
          service: "app",
          observation: {
            kind: "failed",
            reasonCode: "RECONCILE_COMPOSE_OBSERVATION_FAILED",
          },
        },
        {
          service: "worker",
          observation: {
            kind: "failed",
            reasonCode: "RECONCILE_COMPOSE_OBSERVATION_FAILED",
          },
        },
      ]);
      expect(docker.getComposeContainerObservations).not.toHaveBeenCalled();
    });

    it("returns one failed entry per selected service when container observation fails", async () => {
      vi.mocked(docker.getComposeConfig).mockResolvedValue({
        services: { app: { name: "app", image: "app:latest" }, worker: { name: "worker" } },
      });
      vi.mocked(docker.getComposeContainerObservations).mockRejectedValue(new Error("private"));

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app", "worker"],
      });

      expect(evidence.map(({ service, observation }) => ({ service, observation }))).toEqual([
        {
          service: "app",
          observation: {
            kind: "failed",
            reasonCode: "RECONCILE_CONTAINER_OBSERVATION_FAILED",
          },
        },
        {
          service: "worker",
          observation: {
            kind: "failed",
            reasonCode: "RECONCILE_CONTAINER_OBSERVATION_FAILED",
          },
        },
      ]);
      expect(JSON.stringify(evidence)).not.toContain("private");
    });

    it("retains container identity when exact inspection fails", async () => {
      vi.mocked(docker.inspectContainers).mockResolvedValue(undefined);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence).toEqual([
        {
          service: "app",
          observation: {
            kind: "failed",
            containers: [{ id: containerId, name: "app-1", state: "running", health: "none" }],
            reasonCode: "RECONCILE_CONTAINER_INSPECTION_FAILED",
          },
        },
      ]);
    });

    it("fails closed when the inspected container identity changed after observation", async () => {
      vi.mocked(docker.inspectContainers).mockResolvedValue([
        { ...matchingInspect, Id: "cccccccccccc" },
      ]);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.observation).toEqual({
        kind: "failed",
        containers: [{ id: containerId, name: "app-1", state: "running", health: "none" }],
        reasonCode: "RECONCILE_CONTAINER_IDENTITY_CHANGED",
      });
      expect(evidence[0]?.drift).toBeUndefined();
    });

    it("fails closed on unsupported runtime observation values", async () => {
      vi.mocked(docker.getComposeContainerObservations).mockResolvedValue([
        { ...runningObservation, state: "mystery" },
      ]);

      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["app"],
      });

      expect(evidence[0]?.observation).toEqual({
        kind: "failed",
        reasonCode: "RECONCILE_CONTAINER_OBSERVATION_INVALID",
      });
      expect(evidence[0]?.drift).toBeUndefined();
    });

    it("does not omit a selected service absent from resolved Compose intent", async () => {
      const evidence = await observeReconcileDrift({
        composePath: "compose.yml",
        services: ["missing-service", "app"],
      });

      expect(evidence.map((entry) => entry.service)).toEqual(["app", "missing-service"]);
      expect(evidence[1]?.observation).toEqual({
        kind: "failed",
        reasonCode: "RECONCILE_DESIRED_SERVICE_MISSING",
      });
    });

    it("keeps legacy detectDrift output free of reconciliation-only fields", async () => {
      vi.mocked(docker.getRunningServiceContainerMap).mockResolvedValue(
        new Map([["app", "app-1"]]),
      );
      vi.mocked(serviceStatus.getServiceStatusMap).mockResolvedValue(
        new Map([["app", { state: "running", health: "none" }]]),
      );

      const result = await detectDrift({ composePath: "compose.yml", services: ["app"] });

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty("observations");
      expect(result?.services[0]).not.toHaveProperty("observation");
      expect(docker.getComposeContainerObservations).not.toHaveBeenCalled();
    });
  });

  describe("hasImportableDrift", () => {
    it("returns false when only runtime-status drift is present", () => {
      expect(
        hasImportableDrift({
          service: "app",
          hasDrift: true,
          direction: "container_ahead",
          categories: ["runtime-status"],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            current: { state: "running", health: "unhealthy" },
            desired: { state: "running", health: "healthy" },
            changed: true,
          },
        }),
      ).toBe(false);
    });

    it("returns true when compose-importable categories are present", () => {
      expect(
        hasImportableDrift({
          service: "app",
          hasDrift: true,
          direction: "container_ahead",
          categories: ["image", "runtime-status"],
          image: { changed: true, current: "app:v2", desired: "app:v1" },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            current: { state: "running", health: "unhealthy" },
            desired: { state: "running", health: "healthy" },
            changed: true,
          },
        }),
      ).toBe(true);
    });
  });
});
