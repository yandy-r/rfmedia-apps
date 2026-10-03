import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  inspectContainers: vi.fn(),
}));

const commonMocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
}));

vi.mock("./docker.js", () => dockerMocks);
vi.mock("@rfmedia/common", () => commonMocks);

import { inspectContainersWithRetry } from "./action-helpers.js";

describe("action helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns container image tags as soon as all requested services are inspected", async () => {
    dockerMocks.inspectContainers.mockResolvedValue([
      { Name: "/plex", Config: { Image: "plex:latest" } },
      { Name: "/sonarr", Config: { Image: "sonarr:latest" } },
    ]);

    await expect(inspectContainersWithRetry(["plex", "sonarr"])).resolves.toEqual(
      new Map([
        ["plex", "plex:latest"],
        ["sonarr", "sonarr:latest"],
      ]),
    );
    expect(dockerMocks.inspectContainers).toHaveBeenCalledTimes(1);
    expect(dockerMocks.inspectContainers).toHaveBeenCalledWith(["plex", "sonarr"], {});
  });

  it("retries incomplete inspection results with increasing delays", async () => {
    vi.useFakeTimers();
    const execution = {
      cwd: "/reviewed/project",
      env: { PATH: "/usr/bin", DOCKER_CONTEXT: "reviewed" },
      replaceEnv: true,
    };
    dockerMocks.inspectContainers
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ Name: "/plex", Config: { Image: "plex:v2" } }]);

    const resultPromise = inspectContainersWithRetry(["plex"], 2, 25, execution);
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual(new Map([["plex", "plex:v2"]]));
    expect(dockerMocks.inspectContainers).toHaveBeenCalledTimes(2);
    expect(dockerMocks.inspectContainers).toHaveBeenNthCalledWith(1, ["plex"], execution);
    expect(dockerMocks.inspectContainers).toHaveBeenNthCalledWith(2, ["plex"], execution);
    expect(commonMocks.logDebug).toHaveBeenCalledWith(
      "Container inspection attempt 1 incomplete, retrying...",
    );
    vi.useRealTimers();
  });

  it("returns partial results and logs missing services after the final attempt", async () => {
    dockerMocks.inspectContainers.mockResolvedValue([
      { Name: "/plex", Config: { Image: "plex:latest" } },
    ]);

    await expect(inspectContainersWithRetry(["plex", "sonarr"], 1, 1)).resolves.toEqual(
      new Map([["plex", "plex:latest"]]),
    );
    expect(commonMocks.logDebug).toHaveBeenCalledWith("Could not inspect containers for: sonarr");
  });
});
