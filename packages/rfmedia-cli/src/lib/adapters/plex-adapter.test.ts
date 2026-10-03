import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLoadedConfig = vi.hoisted(() => vi.fn());
const mockGetLoadedPlexConfig = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());

vi.mock("../logger.js", () => ({
  logWarn: mockLogWarn,
}));

vi.mock("../loaded-config.js", () => ({
  getLoadedConfig: mockGetLoadedConfig,
  getLoadedPlexConfig: mockGetLoadedPlexConfig,
}));

/**
 * Records which connection factory the composer chose, so the resolver's
 * enrolled branch can be pinned to a ROTATABLE credential cell. Both wrappers
 * delegate to the real implementation, so nothing about connection behaviour,
 * origin validation, or the credential `WeakMap` changes.
 */
const capturedConnections = vi.hoisted(
  () => [] as { kind: "static" | "rotating"; settings: PlexConnectionSettings }[],
);

vi.mock("./plex/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plex/types.js")>();
  return {
    ...actual,
    createPlexConnectionSettings: (input: PlexConnectionInput): PlexConnectionSettings => {
      const settings = actual.createPlexConnectionSettings(input);
      capturedConnections.push({ kind: "static", settings });
      return settings;
    },
    createPlexRotatingConnectionSettings: (input: PlexConnectionInput): PlexConnectionSettings => {
      const settings = actual.createPlexRotatingConnectionSettings(input);
      capturedConnections.push({ kind: "rotating", settings });
      return settings;
    },
  };
});

import type { PlexConfigOptions } from "../../types/config.js";
import {
  createMediaServerAdapter,
  createOptionalMediaServerAdapter,
  requireMediaServerAdapter,
} from "./index.js";
import {
  PlexAdapter,
  getPlexConnectionCredentialCell,
  rotatePlexCredentialCell,
} from "./plex-adapter.js";
import type { PlexConnectionInput, PlexConnectionSettings } from "./plex-adapter.js";

const testConfig: PlexConfigOptions = {
  url: "http://localhost:32400",
  token: "test-token",
  pageSize: 250,
  scanAfterCopy: true,
};

/** Canonical origin the fixture credential store is enrolled for. */
const STORE_ORIGIN = "http://localhost:32400";

/** Same server, no static credential — the input to precedence branches 2 and 4. */
const tokenlessConfig: PlexConfigOptions = {
  url: STORE_ORIGIN,
  pageSize: 250,
  scanAfterCopy: true,
};

const PRIVATE_KEY_SENTINEL =
  "-----BEGIN PRIVATE KEY-----PRIVATEKEYSENTINELBODY-----END PRIVATE KEY-----";
const STORED_JWT_SENTINEL = "eyJhbGciOiJFZERTQSJ9.STOREDJWTSENTINEL.storedjwtsignature";
const PIN_CODE_SENTINEL = "PINCODESENTINEL0123456789";
const NONCE_SENTINEL = "noncesentinel-4f9c-4a2b-9c31-1d0e5a7b3c9d";
const DEVICE_ASSERTION_SENTINEL = "eyJhbGciOiJFZERTQSJ9.DEVICEASSERTIONSENTINEL.assertionsig";

/** Every secret that must never reach a serialized adapter. */
const SECRET_SENTINELS = [
  PRIVATE_KEY_SENTINEL,
  STORED_JWT_SENTINEL,
  PIN_CODE_SENTINEL,
  NONCE_SENTINEL,
  DEVICE_ASSERTION_SENTINEL,
];

/**
 * Writes an owner-only credential store enrolled for `origins`.
 *
 * The pin/nonce/assertion sentinels are written as extra document keys they are
 * never supposed to have, so the "absent from the adapter" assertions cannot
 * pass vacuously.
 */
function writeAuthStore(directory: string, origins: readonly string[] = [STORE_ORIGIN]): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const document = {
    schema: 1,
    version: 1,
    clientIdentifier: "8f0c2b1e-0000-4000-8000-000000000001",
    deviceName: "test-device",
    kid: "test-kid",
    privateKeyPkcs8Pem: PRIVATE_KEY_SENTINEL,
    credential: STORED_JWT_SENTINEL,
    issuedAtEpochSeconds: nowSeconds,
    lifetimeSeconds: 6 * 24 * 60 * 60,
    lifetimeAssumed: true,
    refreshNotBeforeEpochSeconds: 0,
    lastObservedSkewSeconds: null,
    authorizedOrigins: origins.map((origin) => ({
      origin,
      machineIdentifier: "machine-1",
      authorizedAtEpochSeconds: nowSeconds,
      lastVerifiedAtEpochSeconds: nowSeconds,
    })),
    pinCode: PIN_CODE_SENTINEL,
    nonce: NONCE_SENTINEL,
    deviceJwt: DEVICE_ASSERTION_SENTINEL,
  };
  const path = join(directory, "store.json");
  writeFileSync(path, JSON.stringify(document), "utf8");
  chmodSync(path, 0o600);
}

function lastConnection(): { kind: "static" | "rotating"; settings: PlexConnectionSettings } {
  const captured = capturedConnections.at(-1);
  if (captured === undefined) {
    throw new Error("No Plex connection was created");
  }
  return captured;
}

/**
 * MANDATORY hermeticity: the resolver now reads the filesystem, so every test in
 * this file is pointed at an empty private directory. Without it a developer's
 * real `~/.config/rfmedia/plex-auth/store.json` would change the outcome of the
 * opportunistic branch and the suite would pass for exactly one person.
 */
let storeDirectory: string;

beforeEach(() => {
  storeDirectory = realpathSync(mkdtempSync(join(tmpdir(), "rfmedia-plex-auth-")));
  vi.stubEnv("RFMEDIA_PLEX_AUTH_DIR", storeDirectory);
  capturedConnections.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(storeDirectory, { recursive: true, force: true });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

function libraryResponse(title = "Music", key = "1"): Response {
  return jsonResponse({
    MediaContainer: {
      Directory: [{ key, title, type: "artist" }],
    },
  });
}

function trackResponse(userRating = 5): Response {
  return jsonResponse({
    MediaContainer: {
      totalSize: 1,
      offset: 0,
      Metadata: [
        {
          ratingKey: "track-1",
          title: "Track",
          grandparentTitle: "Artist",
          parentTitle: "Album",
          userRating,
          viewCount: 2,
          duration: 180_000,
          Media: [{ Part: [{ file: "/music/track.flac" }] }],
        },
      ],
    },
  });
}

function artistIdentityResponse(): Response {
  return jsonResponse({
    MediaContainer: {
      size: 1,
      totalSize: 1,
      offset: 0,
      Metadata: [
        {
          ratingKey: "artist-1",
          title: "Artist",
          Guid: [
            { id: "mbid://12345678-1234-1234-1234-123456789abc" },
            { id: "unknown://private-wire-value" },
          ],
        },
      ],
    },
  });
}

function serverIdentityResponse(machineIdentifier = "machine-1"): Response {
  return jsonResponse({ MediaContainer: { machineIdentifier } });
}

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, index = 0): URL {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`Missing fetch call ${index}`);
  }
  const input = call[0] as string | URL | Request;
  return new URL(input instanceof Request ? input.url : String(input));
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>, index = 0): Headers {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`Missing fetch call ${index}`);
  }
  const init = call[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

describe("PlexAdapter", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mockGetLoadedConfig.mockReturnValue({ plex: testConfig });
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("composes every generic capability without exposing credentials or machine identity", () => {
    const adapter = requireMediaServerAdapter();

    expect(adapter).toBeInstanceOf(PlexAdapter);
    expect(adapter.capabilities).toEqual({
      query: true,
      library: true,
      scan: true,
      playlist: true,
      collection: true,
      metadata: true,
    });
    expect(adapter.identity).toBeDefined();
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(Object.isFrozen(adapter.identity)).toBe(true);
    expect(Object.keys(adapter).sort()).toEqual([
      "capabilities",
      "collection",
      "features",
      "identity",
      "library",
      "metadata",
      "playlist",
      "query",
      "scan",
      "type",
    ]);
    expect("machineIdentifier" in adapter.library).toBe(false);
    expect("getMachineIdentifier" in adapter.library).toBe(false);
    expect("machineIdentifier" in (adapter.identity ?? {})).toBe(false);
    expect("getMachineIdentifier" in (adapter.identity ?? {})).toBe(false);
    expect("getConfig" in adapter).toBe(false);
    expect(JSON.stringify(adapter)).not.toContain("test-token");
    expect(JSON.stringify(adapter)).not.toContain("machineIdentifier");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("composes identity from the shared library, transport, cache, and machine-ID seams", async () => {
    mockGetLoadedPlexConfig.mockReturnValue({
      ...testConfig,
      cache: { enabled: true, ttlSeconds: 60 },
    });
    fetchMock
      .mockResolvedValueOnce(libraryResponse("Music", "music/7"))
      .mockResolvedValueOnce(artistIdentityResponse())
      .mockResolvedValueOnce(serverIdentityResponse("stable-machine-id"));
    const adapter = requireMediaServerAdapter();
    const identity = adapter.identity;
    if (identity === undefined) {
      throw new Error("Expected Plex identity capability");
    }

    await adapter.library.list();
    const page = await identity.listArtists({ library: "Music" });
    const firstInstanceId = await identity.getInstanceId();
    const secondInstanceId = await identity.getInstanceId();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestUrl(fetchMock, 1).pathname).toBe("/library/sections/music%2F7/all");
    expect(requestUrl(fetchMock, 1).searchParams.get("type")).toBe("8");
    expect(requestUrl(fetchMock, 1).searchParams.get("includeGuids")).toBe("1");
    expect(requestUrl(fetchMock, 1).searchParams.get("X-Plex-Container-Size")).toBe("250");
    expect(requestHeaders(fetchMock, 1).get("X-Plex-Token")).toBe("test-token");
    expect(requestUrl(fetchMock, 2).pathname).toBe("/");
    expect(firstInstanceId).toBe("stable-machine-id");
    expect(secondInstanceId).toBe("stable-machine-id");
    expect(page).toEqual({
      libraryId: "music/7",
      items: [
        {
          id: "artist-1",
          kind: "artist",
          title: "Artist",
          externalIds: [
            {
              namespace: "musicbrainz",
              kind: "artist",
              value: "12345678-1234-1234-1234-123456789abc",
            },
          ],
        },
      ],
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });
    expect(page.items[0]).not.toHaveProperty("Guid");
    expect(JSON.stringify(page)).not.toContain("mbid://");
    expect(JSON.stringify(page)).not.toContain("unknown://private-wire-value");
    expect(JSON.stringify(adapter)).not.toContain("test-token");
    expect(JSON.stringify(adapter)).not.toContain("stable-machine-id");
  });

  it("publishes exact Plex rating and semantic feature metadata without a Sonic operation", () => {
    const adapter = requireMediaServerAdapter();

    expect(adapter.features).toEqual({
      ratings: {
        readable: true,
        writable: true,
        normalized: true,
        nativeScale: { min: 0, max: 10, step: 1 },
      },
      smartPlaylists: true,
      smartCollections: true,
      pathScopedScans: true,
      filterPushdown: {
        supported: true,
        fields: [
          "album",
          "albumRating",
          "artist",
          "artistRating",
          "genre",
          "maxYear",
          "minPlays",
          "minYear",
          "mood",
          "style",
          "title",
          "trackRating",
          "year",
        ],
        operators: [">=", "<=", "==", "!=", "contains", "not_contains"],
      },
      sonicAnalysis: "server-dependent",
    });
    expect("sonic" in adapter).toBe(false);
    expect("sonicAnalysis" in adapter).toBe(false);
  });

  it("returns normalized query ratings through the composed query and library families", async () => {
    fetchMock.mockResolvedValueOnce(libraryResponse()).mockResolvedValueOnce(trackResponse(5));
    const adapter = requireMediaServerAdapter();

    const page = await adapter.query.tracks({ library: "Music", kind: "track" });

    expect(page).toEqual({
      items: [
        {
          id: "track-1",
          kind: "track",
          title: "Track",
          rating: 0.5,
          artist: "Artist",
          album: "Album",
          playCount: 2,
          durationMs: 180_000,
          moods: [],
          filePath: "/music/track.flac",
          year: undefined,
        },
      ],
      total: 1,
      offset: 0,
      returned: 1,
      hasMore: false,
    });
    expect(requestUrl(fetchMock, 1).searchParams.get("type")).toBe("10");
    expect(requestUrl(fetchMock, 1).searchParams.get("X-Plex-Container-Size")).toBe("250");
  });

  it("converts normalized writes to the native Plex rating scale", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse());
    const adapter = requireMediaServerAdapter();

    const result = await adapter.metadata.updateTrackRating("track-1", 0.5);

    expect(result).toEqual({ success: true, message: "Rating updated" });
    expect(requestUrl(fetchMock).pathname).toBe("/:/rate");
    expect(requestUrl(fetchMock).searchParams.get("rating")).toBe("5");
  });

  it("passes opaque JWT-looking credentials unchanged in the header", async () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.payload.signature";
    fetchMock.mockResolvedValueOnce(libraryResponse());
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig, token: jwt });
    const adapter = requireMediaServerAdapter();

    await adapter.library.list();

    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe(jwt);
    expect(requestUrl(fetchMock).href).not.toContain(jwt);
  });

  it("creates isolated caches for separate adapter and credential lifecycles", async () => {
    mockGetLoadedPlexConfig.mockReturnValue({
      ...testConfig,
      cache: { enabled: true, ttlSeconds: 60 },
    });
    fetchMock
      .mockResolvedValueOnce(libraryResponse())
      .mockResolvedValueOnce(trackResponse(8))
      .mockResolvedValueOnce(libraryResponse())
      .mockResolvedValueOnce(trackResponse(8));
    const first = requireMediaServerAdapter();
    const second = requireMediaServerAdapter({ plexToken: "other-token" });

    const options = { library: "Music", kind: "track" } as const;
    const firstLive = await first.query.tracks(options);
    const firstCached = await first.query.tracks(options);
    const secondLive = await second.query.tracks(options);

    expect(firstCached).toEqual(firstLive);
    expect(secondLive).toEqual(firstLive);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requestHeaders(fetchMock, 1).get("X-Plex-Token")).toBe("test-token");
    expect(requestHeaders(fetchMock, 3).get("X-Plex-Token")).toBe("other-token");
  });
});

describe("media server adapter factory", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mockGetLoadedConfig.mockReturnValue({ plex: testConfig });
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns undefined in optional mode when scan is disabled", () => {
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig, scanAfterCopy: false });

    const adapter = createOptionalMediaServerAdapter();

    expect(adapter).toBeUndefined();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("lets an explicit CLI scan disable override enabled config", () => {
    const adapter = createOptionalMediaServerAdapter({ plexScan: false });

    expect(adapter).toBeUndefined();
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("throws in required mode when credentials are missing", () => {
    mockGetLoadedPlexConfig.mockReturnValue({ scanAfterCopy: false });

    expect(() => requireMediaServerAdapter()).toThrow(
      "Plex URL and token are required. Set in config or use --plex-url and --plex-token",
    );
  });

  it.each([
    "ftp://localhost:32400",
    "http://user:password@localhost:32400",
    "http://localhost:32400/base",
    "http://localhost:32400?token=value",
    "http://localhost:32400#fragment",
  ])("rejects non-origin Plex base URL %s without exposing its contents", (url) => {
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig, url });

    expect(() => requireMediaServerAdapter()).toThrow("Invalid Plex URL format");
    try {
      requireMediaServerAdapter();
    } catch (error: unknown) {
      expect(String(error)).not.toContain("password");
      expect(String(error)).not.toContain("token=value");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a required adapter even when scan is disabled", () => {
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig, scanAfterCopy: false });

    const adapter = requireMediaServerAdapter({ plexLibrary: "Music" });

    expect(adapter).toBeInstanceOf(PlexAdapter);
    expect(adapter.capabilities.scan).toBe(true);
  });

  it.each([
    ["HTTP://LOCALHOST:80/", "http://localhost"],
    ["https://PLEX.example:443", "https://plex.example/"],
    ["http://localhost:32400", "http://LOCALHOST:32400/"],
  ])(
    "inherits the configured token for canonical same-origin overrides",
    async (configured, override) => {
      mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig, url: configured });
      fetchMock.mockResolvedValueOnce(libraryResponse());
      const adapter = requireMediaServerAdapter({ plexUrl: override });

      await adapter.library.list();

      expect(requestUrl(fetchMock).origin).toBe(new URL(configured).origin);
      expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe("test-token");
    },
  );

  it("rejects a changed-origin URL-only override before client creation or request", () => {
    expect(() => requireMediaServerAdapter({ plexUrl: "https://attacker.example:32400" })).toThrow(
      "A Plex URL override that changes origin requires an explicit --plex-token",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an explicitly paired changed-origin override", async () => {
    fetchMock.mockResolvedValueOnce(libraryResponse());
    const adapter = requireMediaServerAdapter({
      plexUrl: "https://other.example:32400/",
      plexToken: "paired-token",
    });

    await adapter.library.list();

    expect(requestUrl(fetchMock).origin).toBe("https://other.example:32400");
    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe("paired-token");
  });

  it("allows a token-only override to use the configured URL", async () => {
    fetchMock.mockResolvedValueOnce(libraryResponse());
    const adapter = requireMediaServerAdapter({ plexToken: "replacement-token" });

    await adapter.library.list();

    expect(requestUrl(fetchMock).origin).toBe("http://localhost:32400");
    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe("replacement-token");
  });

  it("preserves library override precedence and configured path mappings", async () => {
    mockGetLoadedPlexConfig.mockReturnValue({
      ...testConfig,
      libraryName: "Configured Music",
      libraries: [{ path: "/media/music", library: "Mapped Music" }],
    });
    fetchMock.mockResolvedValueOnce(libraryResponse("Mapped Music", "7"));
    fetchMock.mockResolvedValueOnce(emptyResponse());
    const mapped = requireMediaServerAdapter();

    const mappedResult = await mapped.scan.triggerSource("/media/music/Artist/Album");

    expect(mappedResult).toMatchObject({ success: true, libraryName: "Mapped Music" });
    expect(requestUrl(fetchMock, 1).pathname).toBe("/library/sections/7/refresh");
    expect(requestUrl(fetchMock, 1).searchParams.get("path")).toBe("/media/music/Artist/Album");

    fetchMock.mockResolvedValueOnce(libraryResponse("Override Music", "9"));
    fetchMock.mockResolvedValueOnce(emptyResponse());
    const overridden = requireMediaServerAdapter({ plexLibrary: "Override Music" });

    const overrideResult = await overridden.scan.trigger();

    expect(overrideResult).toMatchObject({ success: true, libraryName: "Override Music" });
    expect(requestUrl(fetchMock, 3).pathname).toBe("/library/sections/9/refresh");
  });

  it("rejects unsupported server types before resolving Plex config", () => {
    expect(() => requireMediaServerAdapter({ server: "unsupported" })).toThrow(
      "Unsupported media server type: unsupported",
    );
    expect(mockGetLoadedPlexConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enables optional mode when an explicit scan override supplies complete credentials", async () => {
    mockGetLoadedPlexConfig.mockReturnValue({ scanAfterCopy: false });
    fetchMock.mockResolvedValueOnce(emptyResponse());
    const adapter = createOptionalMediaServerAdapter({
      plexScan: true,
      plexUrl: "http://optional.example:32400",
      plexToken: "optional-token",
    });

    expect(adapter).toBeInstanceOf(PlexAdapter);
    await adapter?.scan.trigger();
    expect(requestUrl(fetchMock).origin).toBe("http://optional.example:32400");
    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe("optional-token");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each([[{ scanAfterCopy: true }], [{ ...testConfig, url: "not-a-url", scanAfterCopy: true }]])(
    "warns and skips optional scans when connection resolution fails",
    (config) => {
      mockGetLoadedPlexConfig.mockReturnValue(config);

      const adapter = createMediaServerAdapter({ mode: "optional", plexScan: true });

      expect(adapter).toBeUndefined();
      expect(mockLogWarn).toHaveBeenCalledWith(
        "Plex scan was requested but URL or token is missing or invalid; scan skipped.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("warns and skips an optional changed-origin URL without a paired token", () => {
    const adapter = createOptionalMediaServerAdapter({
      plexScan: true,
      plexUrl: "https://other.example:32400",
    });

    expect(adapter).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Plex scan was requested but URL or token is missing or invalid; scan skipped.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Plex credential precedence resolver", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mockGetLoadedConfig.mockReturnValue({ plex: testConfig });
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "cli-token wins unconditionally",
      config: testConfig,
      overrides: { plexToken: "cli-token" },
      enrolled: false,
      expectedToken: "cli-token",
      expectedKind: "static",
    },
    {
      name: "cli-token outranks an enrolled store in jwt mode",
      config: { ...tokenlessConfig, auth: { mode: "jwt" as const } },
      overrides: { plexToken: "cli-token" },
      enrolled: true,
      expectedToken: "cli-token",
      expectedKind: "static",
    },
    {
      name: "jwt mode uses the credential enrolled for this origin",
      config: { ...tokenlessConfig, auth: { mode: "jwt" as const } },
      overrides: {},
      enrolled: true,
      expectedToken: STORED_JWT_SENTINEL,
      expectedKind: "rotating",
    },
    {
      name: "config token outranks an enrolled store",
      config: testConfig,
      overrides: {},
      enrolled: true,
      expectedToken: "test-token",
      expectedKind: "static",
    },
    {
      name: "an enrolled store is used opportunistically with no configured token",
      config: tokenlessConfig,
      overrides: {},
      enrolled: true,
      expectedToken: STORED_JWT_SENTINEL,
      expectedKind: "rotating",
    },
  ])("$name", async ({ config, overrides, enrolled, expectedToken, expectedKind }) => {
    if (enrolled) {
      writeAuthStore(storeDirectory);
    }
    mockGetLoadedPlexConfig.mockReturnValue({ ...config });
    fetchMock.mockResolvedValueOnce(libraryResponse());

    const adapter = requireMediaServerAdapter(overrides);
    await adapter.library.list();

    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe(expectedToken);
    expect(requestUrl(fetchMock).origin).toBe(STORE_ORIGIN);
    expect(lastConnection().kind).toBe(expectedKind);
  });

  it.each([
    {
      // With nothing at the store path the legacy presence gate fires first, so
      // this stays byte-identical to today's behaviour for every existing user.
      name: "jwt mode with no store on disk keeps the legacy missing gate",
      config: { ...tokenlessConfig, auth: { mode: "jwt" as const } },
      enrolled: [] as readonly string[],
      message: "Plex URL and token are required. Set in config or use --plex-url and --plex-token",
    },
    {
      name: "jwt mode never falls back for an unenrolled origin",
      config: {
        ...tokenlessConfig,
        url: "http://other.example:32400",
        auth: { mode: "jwt" as const },
      },
      enrolled: [STORE_ORIGIN],
      message: "This Plex client is not enrolled; browser authorization was never completed.",
    },
    {
      name: "jwt mode plus a configured token reports the conflict instead of resolving it",
      config: { ...testConfig, auth: { mode: "jwt" as const } },
      enrolled: [STORE_ORIGIN],
      message:
        'plex.auth.mode is "jwt" but plex.token is also set. Remove plex.token, or set plex.auth.mode: static',
    },
    {
      name: "no token and no enrollment keeps the legacy missing message",
      config: tokenlessConfig,
      enrolled: [] as readonly string[],
      message: "Plex URL and token are required. Set in config or use --plex-url and --plex-token",
    },
  ])("$name", ({ config, enrolled, message }) => {
    if (enrolled.length > 0) {
      writeAuthStore(storeDirectory, enrolled);
    }
    mockGetLoadedPlexConfig.mockReturnValue({ ...config });

    expect(() => requireMediaServerAdapter()).toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still rejects a changed-origin override when that origin IS enrolled", () => {
    writeAuthStore(storeDirectory, [STORE_ORIGIN, "https://attacker.example:32400"]);
    mockGetLoadedPlexConfig.mockReturnValue({
      ...tokenlessConfig,
      auth: { mode: "jwt" as const },
    });

    expect(() => requireMediaServerAdapter({ plexUrl: "https://attacker.example:32400" })).toThrow(
      "A Plex URL override that changes origin requires an explicit --plex-token",
    );
    expect(capturedConnections).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * Regression for the credential-exfiltration bug: an explicitly-supplied
   * EMPTY `--plex-token` (or MCP `plexToken: ""`) must be refused outright and
   * never treated as "no override".
   *
   * `??` does not coalesce `""`, so an empty token used to satisfy the
   * cross-origin guard's presence test (`overrides.plexToken === undefined`)
   * while still falling through to the configured `plex.token` — binding a real
   * credential to a caller-supplied origin. A store on disk must not change the
   * answer: it was the store's presence that let the empty token slip past the
   * legacy `!staticToken` gate in the first place.
   *
   * Reachable from untrusted MCP arguments (`plex_query`'s `plexToken` is an
   * optional string with no `minLength`, so `""` validates) and from the CLI as
   * `--plex-token "$TOKEN"` with `TOKEN` unset.
   */
  it.each([
    { name: "with an enrolled store on disk", enrolled: true },
    { name: "with no store on disk", enrolled: false },
  ])("refuses an explicitly empty plex token $name", ({ enrolled }) => {
    if (enrolled) {
      writeAuthStore(storeDirectory);
    }
    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig });

    expect(() =>
      requireMediaServerAdapter({
        plexUrl: "http://attacker.example:32400",
        plexToken: "",
      }),
    ).toThrow("Plex URL and token are required. Set in config or use --plex-url and --plex-token");

    // No connection was constructed at all, so the configured `test-token` was
    // never bound to the attacker origin. The exfiltration primitive is absent,
    // not merely unused.
    expect(capturedConnections).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // The optional factory must decline for the same reason instead of
    // silently scanning the attacker origin with the configured credential.
    expect(
      createOptionalMediaServerAdapter({
        plexScan: true,
        plexUrl: "http://attacker.example:32400",
        plexToken: "",
      }),
    ).toBeUndefined();
    expect(capturedConnections).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds an enrolled credential to a rotatable cell and a static one to a fixed cell", () => {
    writeAuthStore(storeDirectory);
    mockGetLoadedPlexConfig.mockReturnValue({
      ...tokenlessConfig,
      auth: { mode: "jwt" as const },
    });
    requireMediaServerAdapter();
    const enrolled = lastConnection();

    expect(enrolled.kind).toBe("rotating");
    expect(() =>
      rotatePlexCredentialCell(
        getPlexConnectionCredentialCell(enrolled.settings),
        STORE_ORIGIN,
        "rotated-jwt",
      ),
    ).not.toThrow();

    mockGetLoadedPlexConfig.mockReturnValue({ ...testConfig });
    requireMediaServerAdapter();
    const staticConnection = lastConnection();

    expect(staticConnection.kind).toBe("static");
    expect(() =>
      rotatePlexCredentialCell(
        getPlexConnectionCredentialCell(staticConnection.settings),
        STORE_ORIGIN,
        "rotated-jwt",
      ),
    ).toThrow(TypeError);
  });

  it("keeps every enrollment secret out of the serialized adapter", async () => {
    writeAuthStore(storeDirectory);
    mockGetLoadedPlexConfig.mockReturnValue({
      ...tokenlessConfig,
      auth: { mode: "jwt" as const },
    });
    fetchMock.mockResolvedValueOnce(libraryResponse());
    const adapter = requireMediaServerAdapter();

    await adapter.library.list();

    expect(requestHeaders(fetchMock).get("X-Plex-Token")).toBe(STORED_JWT_SENTINEL);
    const serialized = JSON.stringify(adapter);
    for (const secret of SECRET_SENTINELS) {
      expect(serialized).not.toContain(secret);
      expect(requestUrl(fetchMock).href).not.toContain(secret);
    }
  });

  it("warns instead of throwing when an optional scan meets an unreadable store", () => {
    writeAuthStore(storeDirectory);
    chmodSync(join(storeDirectory, "store.json"), 0o644);
    mockGetLoadedPlexConfig.mockReturnValue({
      ...tokenlessConfig,
      auth: { mode: "jwt" as const },
    });

    const adapter = createOptionalMediaServerAdapter({ plexScan: true });

    expect(adapter).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      "Plex scan was requested but URL or token is missing or invalid; scan skipped.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => requireMediaServerAdapter()).toThrow(
      "The Plex credential store is readable by users other than its owner.",
    );
  });
});
