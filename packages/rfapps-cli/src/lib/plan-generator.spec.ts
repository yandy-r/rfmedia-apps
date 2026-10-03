import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeServiceConfig } from "./docker.js";

const dockerMocks = vi.hoisted(() => ({
  checkImageUpdate: vi.fn(),
  getComposeConfig: vi.fn(),
  getRunningServiceContainerMap: vi.fn(),
  inspectContainers: vi.fn(),
  // Mirrors `plan-intelligence.spec.ts`: reached via the intelligence pass's
  // dependency graph, and its dependency extraction is pure.
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

vi.mock("./docker.js", () => dockerMocks);

import { generatePlan, resolvedServiceConfigFingerprint } from "./plan-generator.js";

const OLD_DIGEST = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"c".repeat(64)}`;

describe("plan generator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        plex: {
          image: "plex:v2",
          environment: {
            TZ: "UTC",
            PLEX_TOKEN: "secret",
          },
          ports: ["32400:32400/tcp"],
          volumes: ["/data/plex:/config:ro"],
          networks: ["apps"],
        },
        worker: {
          build: ".",
          environment: ["MODE=prod"],
          network_mode: "service:plex",
        },
        newsvc: {
          image: "newsvc:latest",
        },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(
      new Map([
        ["plex", "rfapps-plex-1"],
        ["worker", "rfapps-worker-1"],
      ]),
    );
    dockerMocks.inspectContainers.mockResolvedValue([
      {
        Name: "/rfapps-plex-1",
        Config: {
          Image: "plex:v1",
          Env: ["TZ=UTC", "PLEX_TOKEN=old"],
        },
        HostConfig: {
          PortBindings: {
            "32400/tcp": [{ HostIp: "0.0.0.0", HostPort: "32400" }],
          },
          Binds: ["/data/plex:/config:ro"],
          NetworkMode: "default",
        },
        NetworkSettings: {
          Networks: {
            apps: {},
          },
        },
      },
      {
        Name: "/rfapps-worker-1",
        Config: {
          Image: "worker:local",
          Env: ["MODE=prod"],
        },
        HostConfig: {
          PortBindings: undefined,
          Binds: undefined,
          NetworkMode: "service:plex",
        },
        NetworkSettings: {
          Networks: {},
        },
      },
    ]);
    dockerMocks.checkImageUpdate.mockResolvedValue({
      hasUpdate: true,
      localDigest: "sha256:local",
      remoteDigest: "sha256:remote",
    });
  });

  it("returns undefined when compose config cannot be read", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue(undefined);

    await expect(generatePlan({ composePath: "compose.yml" })).resolves.toBeUndefined();
  });

  it("fingerprints the complete resolved service model canonically without exposing values", () => {
    const first = resolvedServiceConfigFingerprint({
      environment: { TOKEN: "canary-secret", MODE: "prod" },
      ports: ["8080:80"],
      volumes: ["/data:/data"],
    });
    const reordered = resolvedServiceConfigFingerprint({
      volumes: ["/data:/data"],
      ports: ["8080:80"],
      environment: { MODE: "prod", TOKEN: "canary-secret" },
    });
    const changed = resolvedServiceConfigFingerprint({
      environment: { TOKEN: "different-secret", MODE: "prod" },
      ports: ["8080:80"],
      volumes: ["/data:/data"],
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).not.toContain("canary-secret");
  });

  it("generates service diffs, summaries, secret flags, and update checks", async () => {
    const plan = await generatePlan(
      {
        composePath: "compose.yml",
        profiles: ["all"],
        checkUpdates: true,
      },
      { tool: "op", envFile: ".env" },
    );

    expect(plan).toMatchObject({
      composeHash: "",
      composePath: "compose.yml",
      profiles: ["all"],
      summary: {
        toCreate: 1,
        toUpdate: 0,
        toRecreate: 1,
        toDelete: 0,
        unchanged: 1,
        updatesAvailable: 2,
        total: 3,
      },
    });
    expect(plan?.id).toMatch(/[0-9a-f-]{36}/);
    expect(dockerMocks.getComposeConfig).toHaveBeenCalledWith("compose.yml", {
      profiles: ["all"],
      envTool: { tool: "op", envFile: ".env" },
    });

    const plex = plan?.services.find((service) => service.service === "plex");
    expect(plex).toMatchObject({
      resolvedConfigFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      changeType: "recreate",
      image: {
        current: "plex:v1",
        desired: "plex:v2",
        changed: true,
        updateStatus: "update-available",
        updateAvailable: true,
        canonicalImage: "docker.io/library/plex:v2",
      },
      ports: { changed: false },
      volumes: { changed: false },
      networks: { changed: false },
    });
    expect(plex?.environment).toEqual([
      {
        name: "TZ",
        current: "UTC",
        desired: "UTC",
        changeType: "unchanged",
        isSecret: false,
      },
      {
        name: "PLEX_TOKEN",
        current: "old",
        desired: "secret",
        changeType: "modified",
        isSecret: true,
      },
    ]);

    const worker = plan?.services.find((service) => service.service === "worker");
    expect(worker).toMatchObject({
      changeType: "unchanged",
      image: {
        current: "worker:local",
        desired: "worker:local",
        changed: false,
        updateStatus: "unsupported",
        updateAvailable: false,
        errorCode: "build-only",
      },
      networks: {
        current: undefined,
        desired: undefined,
        changed: false,
      },
    });

    const newsvc = plan?.services.find((service) => service.service === "newsvc");
    expect(newsvc).toMatchObject({
      changeType: "create",
      image: {
        current: undefined,
        desired: "newsvc:latest",
        changed: true,
      },
    });
    expect(dockerMocks.checkImageUpdate).toHaveBeenCalledTimes(2);
    expect(dockerMocks.checkImageUpdate).toHaveBeenCalledWith("docker.io/library/plex:v2", {
      envTool: { tool: "op", envFile: ".env" },
    });

    // `determineChangeType` now also reports which dimensions forced the verdict;
    // every verdict itself must stay exactly where it was.
    expect(plan?.services.map((service) => `${service.service}:${service.changeType}`)).toEqual([
      "plex:recreate",
      "worker:unchanged",
      "newsvc:create",
    ]);
    // Key presence, not a value-`undefined` check: a present-but-undefined key
    // would still break the byte-identical machine payload.
    expect("intelligence" in (plan ?? {})).toBe(false);
    expect(Object.keys(plan ?? {})).not.toContain("intelligence");
  });

  it("inspects containers through the same env-selected Docker authority", async () => {
    const envTool = { tool: "dotenvx" as const, envFile: ".env.remote" };

    await generatePlan({ composePath: "compose.yml", profiles: ["all"] }, envTool);

    expect(dockerMocks.getRunningServiceContainerMap).toHaveBeenCalledWith("compose.yml", {
      profiles: ["all"],
      envTool,
    });
    expect(dockerMocks.inspectContainers).toHaveBeenCalledWith(
      ["rfapps-plex-1", "rfapps-worker-1"],
      { envTool, timeout: 15_000 },
    );
  });

  it("pins resolved config and service inspection to the approved Compose project name", async () => {
    await generatePlan({ composePath: "compose.yml", projectName: "approved-project" });

    expect(dockerMocks.getComposeConfig).toHaveBeenCalledWith(
      "compose.yml",
      expect.objectContaining({ projectName: "approved-project" }),
    );
    expect(dockerMocks.getRunningServiceContainerMap).toHaveBeenCalledWith(
      "compose.yml",
      expect.objectContaining({ projectName: "approved-project" }),
    );
  });

  it("targets explicit services and handles no running containers", async () => {
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());

    const plan = await generatePlan({
      composePath: "compose.yml",
      services: ["newsvc", "missing"],
    });

    expect(plan?.targetServices).toEqual(["newsvc", "missing"]);
    expect(plan?.services.map((service) => service.service)).toEqual(["newsvc"]);
    expect(plan?.summary).toMatchObject({ toCreate: 1, total: 1 });
    expect(dockerMocks.inspectContainers).not.toHaveBeenCalled();
  });

  it("emits exact explicit update-available and up-to-date states", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        current: { image: "alpine:3.21" },
        available: { image: "alpine:latest" },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    dockerMocks.checkImageUpdate
      .mockResolvedValueOnce({
        status: "up-to-date",
        localDigest: "sha256:same",
        remoteDigest: "sha256:same",
      })
      .mockResolvedValueOnce({
        status: "update-available",
        localDigest: "sha256:old",
        remoteDigest: "sha256:new",
      });

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });

    expect(plan?.services.map(({ service, image }) => [service, image.updateStatus])).toEqual([
      ["current", "up-to-date"],
      ["available", "update-available"],
    ]);
    expect(plan?.services[0]?.image).toMatchObject({
      canonicalImage: "docker.io/library/alpine:3.21",
      updateAvailable: false,
      localDigest: "sha256:same",
      remoteDigest: "sha256:same",
    });
    expect(plan?.services[1]?.image.updateAvailable).toBe(true);
    expect(plan?.summary.updatesAvailable).toBe(1);
  });

  it("classifies and redacts auth, not-found, timeout, and rate-limit failures", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        auth: { image: "private.example/app:auth" },
        missing: { image: "private.example/app:missing" },
        timeout: { image: "private.example/app:timeout" },
        limited: { image: "private.example/app:limited" },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    dockerMocks.checkImageUpdate
      .mockResolvedValueOnce({ hasUpdate: false, error: "unauthorized token=do-not-persist" })
      .mockResolvedValueOnce({ hasUpdate: false, error: "manifest unknown: hidden/repository" })
      .mockRejectedValueOnce(new Error("request timed out password=do-not-persist"))
      .mockResolvedValueOnce({ hasUpdate: false, error: "429 too many requests secret=value" });

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });
    const evidence = plan?.services.map(({ image }) => ({
      status: image.updateStatus,
      code: image.errorCode,
      message: image.updateError,
    }));

    expect(evidence).toEqual([
      {
        status: "unknown",
        code: "registry-auth",
        message: "Registry authentication or authorization failed.",
      },
      {
        status: "unknown",
        code: "registry-not-found",
        message: "The registry image or manifest was not found.",
      },
      {
        status: "unknown",
        code: "registry-timeout",
        message: "The registry lookup timed out.",
      },
      {
        status: "unknown",
        code: "registry-rate-limit",
        message: "The registry rate limit was exceeded.",
      },
    ]);
    expect(JSON.stringify(plan)).not.toMatch(/do-not-persist|hidden\/repository|secret=value/);
    expect(plan?.services.every(({ image }) => image.updateAvailable === false)).toBe(true);
  });

  it("marks build-only and locally missing images as non-actionable", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        built: { build: "." },
        missing: { image: "example/missing:latest" },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    dockerMocks.checkImageUpdate.mockResolvedValue({
      hasUpdate: false,
      remoteDigest: "sha256:remote",
      error: "Local image not found",
    });

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });

    expect(plan?.services[0]?.image).toMatchObject({
      updateStatus: "unsupported",
      updateAvailable: false,
      errorCode: "build-only",
    });
    expect(plan?.services[1]?.image).toMatchObject({
      updateStatus: "local-missing",
      updateAvailable: false,
      canonicalImage: "docker.io/example/missing:latest",
      remoteDigest: "sha256:remote",
      errorCode: "local-image-missing",
    });
    expect(dockerMocks.checkImageUpdate).toHaveBeenCalledTimes(1);
  });

  it("deduplicates canonical images per normalized selected platform", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        amdShort: { image: "redis", platform: "linux/x86_64" },
        amdCanonical: { image: "docker.io/library/redis:latest", platform: "linux/amd64" },
        arm: { image: "redis:latest", platform: "linux/arm64/v8" },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    dockerMocks.checkImageUpdate.mockImplementation(
      async (_image: string, options: { platform?: string }) => {
        const remoteDigest =
          options.platform === "linux/arm64/v8"
            ? `docker.io/library/redis@${ARM64_DIGEST}`
            : `docker.io/library/redis@${AMD64_DIGEST}`;
        return {
          hasUpdate: true,
          localDigest: `docker.io/library/redis@${OLD_DIGEST}`,
          remoteDigest,
        };
      },
    );

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });

    expect(dockerMocks.checkImageUpdate).toHaveBeenCalledTimes(2);
    expect(dockerMocks.checkImageUpdate).toHaveBeenNthCalledWith(
      1,
      "docker.io/library/redis:latest",
      { envTool: undefined, platform: "linux/amd64" },
    );
    expect(dockerMocks.checkImageUpdate).toHaveBeenNthCalledWith(
      2,
      "docker.io/library/redis:latest",
      { envTool: undefined, platform: "linux/arm64/v8" },
    );
    expect(plan?.services.map(({ image }) => image.platform)).toEqual([
      "linux/amd64",
      "linux/amd64",
      "linux/arm64/v8",
    ]);
    expect(plan?.services.map(({ image }) => image.canonicalImage)).toEqual([
      "docker.io/library/redis:latest",
      "docker.io/library/redis:latest",
      "docker.io/library/redis:latest",
    ]);
    expect(plan?.services.map(({ image }) => image.remoteDigest)).toEqual([
      `docker.io/library/redis@${AMD64_DIGEST}`,
      `docker.io/library/redis@${AMD64_DIGEST}`,
      `docker.io/library/redis@${ARM64_DIGEST}`,
    ]);
    expect(plan?.services.every(({ image }) => image.updateStatus === "update-available")).toBe(
      true,
    );
  });

  it("bounds concurrent registry checks and marks services beyond the plan limit", async () => {
    const services = Object.fromEntries(
      Array.from({ length: 132 }, (_, index) => [
        `service${index}`,
        { image: `example/service${index}:latest` },
      ]),
    );
    dockerMocks.getComposeConfig.mockResolvedValue({ services });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    let active = 0;
    let maxActive = 0;
    dockerMocks.checkImageUpdate.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return {
        status: "up-to-date",
        localDigest: `docker.io/example/service@${OLD_DIGEST}`,
        remoteDigest: `docker.io/example/service@${OLD_DIGEST}`,
      };
    });

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });

    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxActive).toBeGreaterThan(1);
    expect(dockerMocks.checkImageUpdate).toHaveBeenCalledTimes(128);
    expect(plan?.services.slice(128).every(({ image }) => image.updateStatus === "unknown")).toBe(
      true,
    );
    expect(plan?.services[128]?.image).toMatchObject({
      errorCode: "registry-check-limit",
      updateError: "Registry update detection exceeded the per-plan service limit.",
    });
  });

  it("normalizes legacy booleans and preserves mixed aggregate outcomes", async () => {
    dockerMocks.getComposeConfig.mockResolvedValue({
      services: {
        available: { image: "repo/available:v1" },
        current: { image: "repo/current:v1" },
        unknown: { image: "repo/unknown:v1" },
        missing: { image: "repo/missing:v1" },
        built: { build: "." },
      },
    });
    dockerMocks.getRunningServiceContainerMap.mockResolvedValue(new Map());
    dockerMocks.checkImageUpdate.mockImplementation(async (image: string) => {
      if (image.includes("available")) {
        return { hasUpdate: true, localDigest: "sha256:old", remoteDigest: "sha256:new" };
      }
      if (image.includes("current")) {
        return { hasUpdate: false, localDigest: "sha256:same", remoteDigest: "sha256:same" };
      }
      if (image.includes("missing")) {
        return { hasUpdate: false, error: "Local image not found" };
      }
      return { hasUpdate: false, error: "unexpected registry failure raw-detail" };
    });

    const plan = await generatePlan({ composePath: "compose.yml", checkUpdates: true });

    expect(plan?.services.map(({ image }) => [image.updateStatus, image.updateAvailable])).toEqual([
      ["update-available", true],
      ["up-to-date", false],
      ["unknown", false],
      ["local-missing", false],
      ["unsupported", false],
    ]);
    expect(plan?.summary).toMatchObject({ updatesAvailable: 1, total: 5 });
    expect(JSON.stringify(plan)).not.toContain("raw-detail");
  });

  it("reports runtime state as unobserved when inspect fails after a successful ps", async () => {
    // `ps` sees running containers but the follow-up inspect fails, so nothing
    // populates the container map. Reporting this as observed would let every
    // running service be annotated `container-not-running` at full confidence.
    dockerMocks.inspectContainers.mockResolvedValue(undefined);

    const plan = await generatePlan({
      composePath: "compose.yml",
      intelligence: {
        profileMapping: {},
        baseline: { status: "unavailable", reason: "no-comparable-plan" },
      },
    });

    expect(plan?.intelligence?.runtimeStateObserved).toBe(false);
  });
});
