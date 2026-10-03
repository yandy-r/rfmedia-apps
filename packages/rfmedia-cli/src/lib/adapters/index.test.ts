import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLoadedPlexConfig = vi.hoisted(() => vi.fn());

vi.mock("../loaded-config.js", () => ({
  getLoadedConfig: vi.fn(),
  getLoadedPlexConfig: mockGetLoadedPlexConfig,
}));

import { resolveRequiredPlexOriginWithoutCredentials } from "./index.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetLoadedPlexConfig.mockReturnValue({});
});

describe("resolveRequiredPlexOriginWithoutCredentials", () => {
  it("canonicalizes configured and overridden origins without requiring credentials", () => {
    mockGetLoadedPlexConfig.mockReturnValue({ url: "HTTP://PLEX.EXAMPLE:80/" });

    expect(resolveRequiredPlexOriginWithoutCredentials()).toBe("http://plex.example");
    mockGetLoadedPlexConfig.mockClear();
    expect(
      resolveRequiredPlexOriginWithoutCredentials({
        plexUrl: "https://OTHER.EXAMPLE:443/",
      }),
    ).toBe("https://other.example");
    expect(mockGetLoadedPlexConfig).not.toHaveBeenCalled();
  });

  it("rejects a missing configured or overridden URL", () => {
    expect(() => resolveRequiredPlexOriginWithoutCredentials()).toThrow(
      "Plex URL is required. Set in config or use --plex-url",
    );
  });

  it.each([
    "http://user:password@plex.example:32400",
    "http://plex.example:32400/library",
    "http://plex.example:32400?token=value",
    "http://plex.example:32400#fragment",
    "not a url",
    "ftp://plex.example:32400",
  ])("rejects unsafe Plex origin %s", (plexUrl) => {
    expect(() => resolveRequiredPlexOriginWithoutCredentials({ plexUrl })).toThrow(
      "Invalid Plex URL format",
    );
  });
});
