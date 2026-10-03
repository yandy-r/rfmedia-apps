import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  execDockerCompose: vi.fn(),
  filterToolOutput: vi.fn((lines: string[]) => lines),
  getComposeServices: vi.fn(),
}));

const commonMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("./docker.js", () => dockerMocks);
vi.mock("@rfmedia/common", () => commonMocks);

import { clearServiceStatusCache, getServiceStatusMap } from "./service-status.js";

describe("service status map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearServiceStatusCache();
    dockerMocks.getComposeServices.mockResolvedValue(["traefik", "plex", "worker"]);
    dockerMocks.execDockerCompose.mockResolvedValue({
      success: true,
      stdout: [
        JSON.stringify({
          Service: "traefik",
          State: "running",
          Status: "Up 2 hours (healthy)",
        }),
        JSON.stringify({
          Service: "plex",
          State: "exited",
          Status: "Exited (0) 1 hour ago",
        }),
        "not json",
      ].join("\n"),
      stderr: "",
      code: 0,
    });
  });

  it("maps compose services to container state and health", async () => {
    const statusMap = await getServiceStatusMap("compose.yml", "/srv/RFmedia Apps", {
      cacheTtlMs: 0,
    });

    expect(statusMap.get("traefik")).toEqual({ state: "running", health: "healthy" });
    expect(statusMap.get("plex")).toEqual({ state: "exited", health: "none" });
    expect(statusMap.get("worker")).toEqual({ state: "created", health: "none" });
    expect(dockerMocks.getComposeServices).toHaveBeenCalledWith("compose.yml", {
      envTool: undefined,
      timeout: 15000,
    });
    expect(commonMocks.logDebug).toHaveBeenCalledWith("Failed to parse container line: not json");
  });

  it("uses preloaded services and parses unhealthy, starting, and unknown states", async () => {
    dockerMocks.execDockerCompose.mockResolvedValue({
      success: true,
      stdout: [
        JSON.stringify({
          Service: "api",
          State: "paused",
          Status: "Up 1 minute (unhealthy)",
        }),
        JSON.stringify({
          Service: "db",
          State: "mystery",
          Status: "Up 1 minute (health: starting)",
        }),
      ].join("\n"),
      stderr: "",
      code: 0,
    });

    const statusMap = await getServiceStatusMap("compose.yml", "/srv/project", {
      preloadedServices: ["api", "db"],
      cacheTtlMs: 0,
      timeoutMs: 500,
    });

    expect(dockerMocks.getComposeServices).not.toHaveBeenCalled();
    expect(statusMap.get("api")).toEqual({ state: "paused", health: "unhealthy" });
    expect(statusMap.get("db")).toEqual({ state: "exited", health: "starting" });
    expect(dockerMocks.execDockerCompose).toHaveBeenCalledWith(
      ["-f", "compose.yml", "ps", "-a", "--format", "json"],
      {
        cwd: "/srv/project",
        envTool: undefined,
        timeout: 500,
      },
    );
  });

  it("queries the exact Compose project under the selected environment", async () => {
    dockerMocks.execDockerCompose.mockResolvedValue({
      success: true,
      stdout: JSON.stringify([
        {
          Service: "api",
          State: "running",
          Health: "healthy",
          Status: "Up 1 minute",
        },
      ]),
      stderr: "",
      code: 0,
    });
    const envTool = { tool: "op" as const, envFile: "/private/runtime.env" };
    const envFile = "/srv/app/reviewed.env";

    const statusMap = await getServiceStatusMap("/srv/app/compose.yml", "/unrelated/worktree", {
      preloadedServices: ["api"],
      envFile,
      envTool,
      cacheTtlMs: 0,
    });

    expect(statusMap.get("api")).toEqual({ state: "running", health: "healthy" });
    expect(dockerMocks.execDockerCompose).toHaveBeenCalledWith(
      ["-f", "/srv/app/compose.yml", "--env-file", envFile, "ps", "-a", "--format", "json"],
      { cwd: "/unrelated/worktree", envTool, timeout: 15000 },
    );
  });

  it("returns cached copies until forced to refresh", async () => {
    const first = await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      cacheTtlMs: 10000,
    });
    const second = await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      cacheTtlMs: 10000,
    });

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(dockerMocks.execDockerCompose).toHaveBeenCalledTimes(1);

    await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      cacheTtlMs: 10000,
      forceRefresh: true,
    });
    expect(dockerMocks.execDockerCompose).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached status across environment-selected Compose projects", async () => {
    await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      envTool: { tool: "op", envFile: "/private/blue.env" },
    });
    await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      envTool: { tool: "op", envFile: "/private/green.env" },
    });

    expect(dockerMocks.execDockerCompose).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached status across plain Compose env files", async () => {
    await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      envFile: "/project/blue.env",
    });
    await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      envFile: "/project/green.env",
    });

    expect(dockerMocks.execDockerCompose).toHaveBeenCalledTimes(2);
  });

  it("returns defaults and logs when Docker container listing fails", async () => {
    dockerMocks.execDockerCompose.mockResolvedValue({
      success: false,
      stdout: "",
      stderr: "docker unavailable",
      code: 1,
    });

    const statusMap = await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      cacheTtlMs: 0,
    });

    expect(statusMap.get("traefik")).toEqual({ state: "created", health: "none" });
    expect(commonMocks.logError).toHaveBeenCalledWith(
      "Failed to list containers: docker unavailable",
    );
  });

  it("returns an empty map when compose has no services", async () => {
    dockerMocks.getComposeServices.mockResolvedValue([]);

    const statusMap = await getServiceStatusMap("compose.yml", "/srv/rfmediaapps", {
      cacheTtlMs: 0,
    });

    expect(statusMap.size).toBe(0);
    expect(commonMocks.logError).toHaveBeenCalledWith("No services found in compose file");
  });
});
