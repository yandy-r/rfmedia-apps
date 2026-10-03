import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { LIDARR_PLAN_MAX_ENTRIES } from "../../types/lidarr-plan.js";
import {
  LidarrError,
  LidarrNotFoundError,
  LidarrTimeoutError,
  LidarrUnreachableError,
  LidarrValidationError,
  RateLimitedError,
} from "./errors.js";
import { LidarrClient, type LidarrClientDependencies } from "./client.js";
import {
  StaticLidarrApiKeyProvider,
  createLidarrConnectionSettings,
  type LidarrApiKeyProvider,
} from "./types.js";

type FetchImplementation = NonNullable<LidarrClientDependencies["fetch"]>;

const ORIGIN = "http://localhost:8686";

function createClient(
  apiKey = "opaque-api-key",
  dependencies: LidarrClientDependencies = {},
  origin = ORIGIN,
  provider?: LidarrApiKeyProvider,
): LidarrClient {
  const connection = createLidarrConnectionSettings({
    origin,
    apiKey,
    request: { timeoutMs: 30_000, delayMs: 0 },
  });
  return new LidarrClient(
    connection,
    provider ?? new StaticLidarrApiKeyProvider(connection),
    dependencies,
  );
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function asLidarrError(error: unknown): LidarrError {
  expect(error).toBeInstanceOf(LidarrError);
  return error as LidarrError;
}

const SYSTEM_STATUS = { version: "2.1.7.4030", instanceName: "Lidarr" };
const ARTIST = {
  id: 1,
  artistName: "Radiohead",
  foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  monitored: true,
  qualityProfileId: 1,
  metadataProfileId: 1,
  tags: [3, 7],
  statistics: { albumCount: 9, trackFileCount: 100, trackCount: 120, sizeOnDisk: 5_000_000 },
};
const HEALTH_CHECK = {
  source: "IndexerStatusCheck",
  type: "warning",
  message: "Indexer unavailable",
};
const WANTED_PAGE = {
  page: 2,
  pageSize: 25,
  totalRecords: 3,
  records: [
    {
      id: 42,
      title: "OK Computer",
      artist: { id: 1, artistName: "Radiohead" },
      monitored: true,
    },
  ],
};
const QUALITY_PROFILES = [{ id: 5, name: "Lossless" }];
const METADATA_PROFILE_RESPONSE = [
  {
    id: 2,
    name: "Albums",
    primaryAlbumTypes: [
      { id: 101, albumType: { id: 1, name: "Album" }, allowed: true },
      { id: 102, albumType: { id: 2, name: "EP" }, allowed: false },
    ],
    secondaryAlbumTypes: [{ id: 201, albumType: { id: 10, name: "Live" }, allowed: false }],
  },
];
const METADATA_PROFILES = [
  {
    id: 2,
    name: "Albums",
    primaryAlbumTypes: [
      { id: 1, name: "Album", allowed: true },
      { id: 2, name: "EP", allowed: false },
    ],
    secondaryAlbumTypes: [{ id: 10, name: "Live", allowed: false }],
  },
];
const METADATA_PROFILE_SUMMARIES = [{ id: 2, name: "Albums" }];
const TAGS = [
  { id: 9, label: "Archive" },
  { id: 4, label: "Favorite" },
];
const ARTIST_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const ALBUM_MBID = "11111111-2222-3333-4444-555555555555";
const PRESET_CUSTOM_FORMAT_RESPONSE = {
  id: 7,
  name: "Lossless",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    {
      id: 17,
      name: "Release title",
      implementation: "ReleaseTitleSpecification",
      negate: false,
      required: false,
      fields: [{ name: "value", value: "" }],
    },
  ],
};
const PRESET_CUSTOM_FORMAT_INPUT = {
  name: "Lossless",
  includeCustomFormatWhenRenaming: false,
  specifications: [
    {
      name: "Release title",
      implementation: "ReleaseTitleSpecification",
      negate: false,
      required: false,
      fields: { value: "" },
    },
  ],
} as const;
const PRESET_QUALITY_PROFILE_RESPONSE = {
  id: 8,
  name: "Music",
  upgradeAllowed: false,
  cutoff: 1,
  items: [
    {
      id: 1,
      quality: { id: 1, name: "FLAC" },
      allowed: true,
      items: [],
    },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  formatItems: [{ format: 7, name: "Lossless", score: 0 }],
};
const PRESET_QUALITY_PROFILE_INPUT = {
  name: "Music",
  upgradeAllowed: false,
  cutoff: 1,
  items: [
    {
      kind: "quality",
      id: 1,
      quality: { id: 1, name: "FLAC" },
      allowed: true,
    },
  ],
  minFormatScore: 0,
  cutoffFormatScore: 0,
  formatItems: [{ customFormat: { id: 7, name: "Lossless" }, score: 0 }],
} as const;
const PRESET_NAMING = {
  id: 1,
  renameTracks: false,
  replaceIllegalCharacters: false,
  colonReplacementFormat: 0,
  standardTrackFormat: "",
  multiDiscTrackFormat: "",
  artistFolderFormat: "",
} as const;
const PRESET_NAMING_EXAMPLES = {
  singleTrackExample: "",
  multiDiscTrackExample: "Disc 1/01 - Track",
  artistFolderExample: "Artist",
  albumFolderExample: "Album",
};

describe("LidarrClient generated facade", () => {
  it("serializes both artist delete-files modes through the generated endpoint", async () => {
    for (const [deleteFiles, serializedDeleteFiles] of [
      [false, "false"],
      [true, "true"],
    ] as const) {
      const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
        new Response(JSON.stringify({ ignored: "response body" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const client = createClient("secret", { fetch: fetchMock });

      await expect(client.deleteArtist(7, deleteFiles)).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledOnce();
      const request = fetchMock.mock.calls[0]?.[0] as Request;
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe(
        `${ORIGIN}/api/v1/artist/7?deleteFiles=${serializedDeleteFiles}&addImportListExclusion=false`,
      );
    }
  });

  it("rejects every invalid artist-delete input class before transport", async () => {
    const cases = [
      ["zero artist ID", 0, false],
      ["fractional artist ID", 1.5, false],
      ["unsafe artist ID", Number.MAX_SAFE_INTEGER + 1, false],
      ["missing delete-files mode", 7, undefined],
      ["string delete-files mode", 7, "true"],
    ] as const;

    for (const [label, artistId, mode] of cases) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(
        client.deleteArtist(artistId, mode as unknown as boolean),
        label,
      ).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr delete artist",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("forwards cancellation through the generated artist delete", async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      return new Promise<Response>((_resolvePromise, rejectPromise) => {
        request.signal.addEventListener("abort", () => rejectPromise(request.signal.reason), {
          once: true,
        });
      });
    });
    const client = createClient("secret", { fetch: fetchMock });
    const controller = new AbortController();
    const reason = new DOMException("delete cancelled", "AbortError");

    const pending = client
      .deleteArtist(7, false, controller.signal)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });

  it("maps a targeted artist 404 to typed absence", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.getArtist(7)).rejects.toMatchObject({
      code: "not-found",
      operation: "lidarr get artist",
      retryable: false,
      statusCode: 404,
    });
    await expect(client.getArtist(7)).rejects.toBeInstanceOf(LidarrNotFoundError);
  });

  it("updates artist monitoring through the generated editor operation", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = createClient("secret", { fetch: fetchMock });

    await client.setArtistsMonitored([7, 3], false);

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${ORIGIN}/api/v1/artist/editor`);
    expect(await request.json()).toEqual({ artistIds: [7, 3], monitored: false });
  });

  it("rejects invalid artist mutation IDs before transport", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.setArtistsMonitored([3, 3], true)).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr update artist monitoring",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the targeted artist and resource GET operations with fresh projections", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      switch (new URL(request.url).pathname) {
        case "/api/v1/artist/1":
          return jsonResponse({ ...ARTIST, tags: [7, 3, 7] });
        case "/api/v1/qualityprofile":
          return jsonResponse(QUALITY_PROFILES);
        case "/api/v1/metadataprofile":
          return jsonResponse(METADATA_PROFILE_RESPONSE);
        case "/api/v1/tag":
          return jsonResponse(TAGS);
        default:
          return new Response(null, { status: 404 });
      }
    });
    const client = createClient("secret", { fetch: fetchMock });

    const [artist, qualityProfiles, metadataProfiles, metadataProfileDetails, tags] =
      await Promise.all([
        client.getArtist(1),
        client.listQualityProfiles(),
        client.listMetadataProfiles(),
        client.listMetadataProfileDetails(),
        client.listTags(),
      ]);

    expect(artist).toEqual(ARTIST);
    expect(artist).not.toBe(ARTIST);
    expect(artist.tags).not.toBe(ARTIST.tags);
    expect(artist.tags).toEqual([3, 7]);
    expect(qualityProfiles).toEqual(QUALITY_PROFILES);
    expect(metadataProfiles).toEqual(METADATA_PROFILE_SUMMARIES);
    expect(metadataProfileDetails).toEqual(METADATA_PROFILES);
    expect(tags).toEqual(TAGS);
    expect(qualityProfiles[0]).not.toBe(QUALITY_PROFILES[0]);
    expect(metadataProfiles[0]).not.toBe(METADATA_PROFILE_RESPONSE[0]);
    expect(metadataProfileDetails[0]).not.toBe(METADATA_PROFILES[0]);
    expect(metadataProfileDetails[0]?.primaryAlbumTypes).not.toBe(
      METADATA_PROFILE_RESPONSE[0]?.primaryAlbumTypes,
    );
    expect(metadataProfileDetails[0]?.primaryAlbumTypes[0]).not.toBe(
      METADATA_PROFILE_RESPONSE[0]?.primaryAlbumTypes[0]?.albumType,
    );
    expect(tags[0]).not.toBe(TAGS[0]);
    expect(
      [
        artist,
        artist.tags,
        qualityProfiles,
        qualityProfiles[0],
        metadataProfiles,
        metadataProfiles[0],
        metadataProfileDetails,
        metadataProfileDetails[0],
        metadataProfileDetails[0]?.primaryAlbumTypes,
        metadataProfileDetails[0]?.primaryAlbumTypes[0],
        metadataProfileDetails[0]?.secondaryAlbumTypes,
        metadataProfileDetails[0]?.secondaryAlbumTypes[0],
        tags,
      ].every(Object.isFrozen),
    ).toBe(true);
    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN}/api/v1/artist/1`,
      `GET ${ORIGIN}/api/v1/metadataprofile`,
      `GET ${ORIGIN}/api/v1/metadataprofile`,
      `GET ${ORIGIN}/api/v1/qualityprofile`,
      `GET ${ORIGIN}/api/v1/tag`,
    ]);
    expect(fetchMock.mock.calls.every((args) => args.length === 1)).toBe(true);
  });

  it("accepts sparse metadata-profile summaries while keeping detailed reads strict", async () => {
    const payload = [{ id: 2, name: "Albums" }];
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockImplementation(async () => jsonResponse(payload));
    const client = createClient("secret", { fetch: fetchMock });

    const summaries = await client.listMetadataProfiles();

    expect(summaries).toEqual(payload);
    expect(summaries).not.toBe(payload);
    expect(summaries[0]).not.toBe(payload[0]);
    expect([summaries, summaries[0]].every(Object.isFrozen)).toBe(true);
    await expect(client.listMetadataProfileDetails()).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr list metadata profile details",
    });
  });

  it("rejects malformed complete-resource responses at every facade method", async () => {
    const cases = [
      ["getArtist", [{ ...ARTIST }]] as const,
      ["listQualityProfiles", [{ id: 1, name: "\u001b[31munsafe" }]] as const,
      ["listMetadataProfiles", [{ id: 0, name: "Invalid" }]] as const,
      [
        "listMetadataProfileDetails",
        [
          {
            ...METADATA_PROFILE_RESPONSE[0],
            secondaryAlbumTypes: [{ id: 201, allowed: false }],
          },
        ],
      ] as const,
      ["listTags", [{ id: 1, label: "" }]] as const,
    ];

    for (const [method, payload] of cases) {
      const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse(payload));
      const client = createClient("secret", { fetch: fetchMock });
      const pending =
        method === "getArtist"
          ? client.getArtist(1)
          : method === "listQualityProfiles"
            ? client.listQualityProfiles()
            : method === "listMetadataProfiles"
              ? client.listMetadataProfiles()
              : method === "listMetadataProfileDetails"
                ? client.listMetadataProfileDetails()
                : client.listTags();
      const error = await pending.catch((failure: unknown) => failure);

      expect(asLidarrError(error), method).toMatchObject({
        code: "invalid-response",
        operation:
          method === "getArtist"
            ? "lidarr get artist"
            : method === "listQualityProfiles"
              ? "lidarr list quality profiles"
              : method === "listMetadataProfiles"
                ? "lidarr list metadata profiles"
                : method === "listMetadataProfileDetails"
                  ? "lidarr list metadata profile details"
                  : "lidarr list tags",
      });
    }
  });

  it("assigns one artist's requested profile fields with an allowlisted body", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response("not-json accepted", {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    await client.setArtistProfiles(7, { qualityProfileId: 5, metadataProfileId: 2 });

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${ORIGIN}/api/v1/artist/editor`);
    const body = await request.json();
    expect(body).toEqual({ artistIds: [7], qualityProfileId: 5, metadataProfileId: 2 });
    expect(body).not.toHaveProperty("monitored");
    expect(body).not.toHaveProperty("monitorNewItems");
    expect(body).not.toHaveProperty("rootFolderPath");
    expect(body).not.toHaveProperty("moveFiles");
    expect(body).not.toHaveProperty("deleteFiles");
    expect(body).not.toHaveProperty("addImportListExclusion");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("applyTags");
  });

  const validationFetchMock = vi.fn<FetchImplementation>();
  const clientForValidation = createClient("secret", { fetch: validationFetchMock });

  it("maps every tag intent to one minimal editor request", async () => {
    const cases = [
      ["add", [9, 4, 9], { artistIds: [7], tags: [4, 9], applyTags: "add" }],
      ["remove", [9, 4], { artistIds: [7], tags: [4, 9], applyTags: "remove" }],
      ["set", [9, 4], { artistIds: [7], tags: [4, 9], applyTags: "replace" }],
      ["clear", [], { artistIds: [7], tags: [], applyTags: "replace" }],
    ] as const;

    for (const [mode, tagIds, expectedBody] of cases) {
      const fetchMock = vi
        .fn<FetchImplementation>()
        .mockResolvedValue(new Response(null, { status: 204 }));
      const client = createClient("secret", { fetch: fetchMock });

      await client.updateArtistTags(7, { mode, tagIds });

      const request = fetchMock.mock.calls[0]?.[0] as Request;
      expect(request.method).toBe("PUT");
      expect(request.url).toBe(`${ORIGIN}/api/v1/artist/editor`);
      const body = await request.json();
      expect(body).toEqual(expectedBody);
      expect(body).not.toHaveProperty("monitored");
      expect(body).not.toHaveProperty("monitorNewItems");
      expect(body).not.toHaveProperty("qualityProfileId");
      expect(body).not.toHaveProperty("metadataProfileId");
      expect(body).not.toHaveProperty("rootFolderPath");
      expect(body).not.toHaveProperty("moveFiles");
      expect(body).not.toHaveProperty("deleteFiles");
      expect(body).not.toHaveProperty("addImportListExclusion");
    }
  });

  it("accepts successful editor responses independently of their body", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: "body" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.setArtistProfiles(7, { qualityProfileId: 5 })).resolves.toBeUndefined();
    await expect(client.updateArtistTags(7, { mode: "add", tagIds: [4] })).resolves.toBeUndefined();
  });

  it("rejects every malformed or out-of-bounds artist mutation before transport", async () => {
    const cases = [
      ["artist id", () => clientForValidation.getArtist(0)],
      ["missing profiles", () => clientForValidation.setArtistProfiles(1, {} as never)],
      ["invalid profile", () => clientForValidation.setArtistProfiles(1, { qualityProfileId: 0 })],
      [
        "unknown profile field",
        () =>
          clientForValidation.setArtistProfiles(1, {
            qualityProfileId: 2,
            monitored: true,
          } as { qualityProfileId: number }),
      ],
      ["empty add", () => clientForValidation.updateArtistTags(1, { mode: "add", tagIds: [] })],
      [
        "nonempty clear",
        () => clientForValidation.updateArtistTags(1, { mode: "clear", tagIds: [4] }),
      ],
      [
        "invalid tag id",
        () => clientForValidation.updateArtistTags(1, { mode: "set", tagIds: [0] }),
      ],
      [
        "unknown tag mode",
        () =>
          clientForValidation.updateArtistTags(1, {
            mode: "replace",
            tagIds: [4],
          } as never),
      ],
      [
        "too many tags",
        () =>
          clientForValidation.updateArtistTags(1, {
            mode: "set",
            tagIds: Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => index + 1),
          }),
      ],
    ] as const;

    for (const [name, invoke] of cases) {
      await expect(invoke(), name).rejects.toMatchObject({ code: "validation" });
      expect(validationFetchMock).not.toHaveBeenCalled();
    }
  });

  it("accepts the maximum supported artist mutation batch", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = createClient("secret", { fetch: fetchMock });
    const artistIds = Array.from({ length: LIDARR_PLAN_MAX_ENTRIES }, (_, index) => index + 1);

    await client.setArtistsMonitored(artistIds, true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(await request.json()).toEqual({ artistIds, monitored: true });
  });

  it("rejects artist mutation batches above the supported bound before transport", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });
    const artistIds = Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => index + 1);

    await expect(client.setArtistsMonitored(artistIds, true)).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr update artist monitoring",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an over-bound complete resource response", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      jsonResponse(
        Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => ({
          id: index + 1,
          label: `Tag ${index + 1}`,
        })),
      ),
    );
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.listTags()).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr list tags",
    });
  });

  it("rejects every non-boolean artist monitored value before transport", async () => {
    for (const monitored of [undefined, "true", 1]) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(
        client.setArtistsMonitored([3], monitored as unknown as boolean),
      ).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr update artist monitoring",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("calls the four generated GET operations and returns fresh domain projections", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      switch (new URL(request.url).pathname) {
        case "/api/v1/system/status":
          return jsonResponse(SYSTEM_STATUS);
        case "/api/v1/health":
          return jsonResponse([HEALTH_CHECK]);
        case "/api/v1/artist":
          return jsonResponse([ARTIST]);
        case "/api/v1/wanted/missing":
          return jsonResponse(WANTED_PAGE);
        default:
          return new Response(null, { status: 404 });
      }
    });
    const client = createClient("secret", { fetch: fetchMock });

    const [status, health, artists, wanted] = await Promise.all([
      client.getSystemStatus(),
      client.getHealth(),
      client.listArtists(),
      client.getWantedMissing({
        page: 2,
        pageSize: 25,
        sortKey: "title",
        sortDirection: "ascending",
      }),
    ]);

    expect(status).toEqual(SYSTEM_STATUS);
    expect(health).toEqual([HEALTH_CHECK]);
    expect(artists).toEqual([ARTIST]);
    expect(wanted).toEqual(WANTED_PAGE);
    expect(status).not.toBe(SYSTEM_STATUS);
    expect(health[0]).not.toBe(HEALTH_CHECK);
    expect(artists[0]).not.toBe(ARTIST);
    expect(wanted).not.toBe(WANTED_PAGE);
    expect(wanted.records[0]).not.toBe(WANTED_PAGE.records[0]);
    expect([status, health, artists, wanted].every(Object.isFrozen)).toBe(true);

    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN}/api/v1/artist`,
      `GET ${ORIGIN}/api/v1/health`,
      `GET ${ORIGIN}/api/v1/system/status`,
      `GET ${ORIGIN}/api/v1/wanted/missing?page=2&pageSize=25&sortKey=title&sortDirection=ascending`,
    ]);
    expect(fetchMock.mock.calls.every((args) => args.length === 1)).toBe(true);
  });

  it("accepts unpaged artist libraries larger than the mutation batch limit", async () => {
    const artists = Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => ({
      ...ARTIST,
      id: index + 1,
      artistName: `Artist ${index + 1}`,
    }));
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse(artists));
    const client = createClient("secret", { fetch: fetchMock });

    const result = await client.listArtists();

    expect(result).toHaveLength(LIDARR_PLAN_MAX_ENTRIES + 1);
    expect(result.at(-1)).toMatchObject({
      id: LIDARR_PLAN_MAX_ENTRIES + 1,
      artistName: `Artist ${LIDARR_PLAN_MAX_ENTRIES + 1}`,
    });
  });

  it("applies wanted defaults and omits an unset sort direction", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(jsonResponse({ ...WANTED_PAGE, page: 1, pageSize: 50 }));
    const client = createClient("secret", { fetch: fetchMock });

    await client.getWantedMissing();

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(
      `${ORIGIN}/api/v1/wanted/missing?page=1&pageSize=50&sortKey=releaseDate`,
    );
    expect(new URL(request.url).searchParams.has("sortDirection")).toBe(false);
  });

  it("rejects failed strict projections for every generated GET facade", async () => {
    const cases = [
      ["getSystemStatus", {}] as const,
      ["getHealth", [{ source: "s", type: "unknown", message: "m" }]] as const,
      ["listArtists", [{ id: "not-a-number" }]] as const,
      ["getWantedMissing", { page: 1 }] as const,
    ];

    for (const [method, payload] of cases) {
      const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse(payload));
      const client = createClient("secret", { fetch: fetchMock });
      const error = await (
        client[
          method as "getSystemStatus" | "getHealth" | "listArtists" | "getWantedMissing"
        ]() as Promise<unknown>
      ).catch((failure: unknown) => failure);

      expect(asLidarrError(error), method).toMatchObject({
        code: "invalid-response",
        operation:
          method === "getSystemStatus"
            ? "lidarr system status"
            : method === "getHealth"
              ? "lidarr health"
              : method === "listArtists"
                ? "lidarr list artists"
                : "lidarr wanted missing",
      });
    }
  });

  it("maps generated JSON parsing failures to a sanitized invalid-response", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response("not-json secret-body", {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client.getSystemStatus().catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "invalid-response",
      operation: "lidarr system status",
      message: "Lidarr returned an invalid JSON response",
    });
    expect(inspect(error)).not.toContain("secret-body");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("LidarrClient search and lookup operations", () => {
  const ARTIST_LOOKUP = {
    id: 7,
    artistName: "Radiohead",
    foreignArtistId: ARTIST_MBID,
    disambiguation: "English rock band",
    artistType: "Group",
  };
  const ALBUM_LOOKUP = {
    id: 11,
    title: "OK Computer",
    foreignAlbumId: ALBUM_MBID,
    artist: {
      artistName: "Radiohead",
      foreignArtistId: ARTIST_MBID,
    },
    albumType: "Album",
    releaseDate: "1997-05-21",
  };

  it("calls each generated operation with the exact term query and projects optional local IDs", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      switch (new URL(request.url).pathname) {
        case "/api/v1/search":
          return jsonResponse([
            { id: 999, foreignId: ARTIST_MBID, artist: ARTIST_LOOKUP },
            {
              id: 1_000,
              foreignId: ALBUM_MBID,
              album: { ...ALBUM_LOOKUP, id: undefined },
            },
          ]);
        case "/api/v1/artist/lookup":
          return jsonResponse([{ ...ARTIST_LOOKUP, id: undefined }, ARTIST_LOOKUP]);
        case "/api/v1/album/lookup":
          return jsonResponse([{ ...ALBUM_LOOKUP, id: undefined }, ALBUM_LOOKUP]);
        default:
          return new Response(null, { status: 404 });
      }
    });
    const client = createClient("secret", { fetch: fetchMock });
    const term = "radiohead / live?";

    const [search, artists, albums] = await Promise.all([
      client.search({ mode: "search", term }),
      client.lookupArtists({ mode: "artist", term }),
      client.lookupAlbums({ mode: "album", term }),
    ]);

    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN}/api/v1/album/lookup?term=radiohead%20%2F%20live%3F`,
      `GET ${ORIGIN}/api/v1/artist/lookup?term=radiohead%20%2F%20live%3F`,
      `GET ${ORIGIN}/api/v1/search?term=radiohead%20%2F%20live%3F`,
    ]);
    expect(search).toEqual([
      {
        kind: "artist",
        foreignId: ARTIST_MBID,
        name: "Radiohead",
        lidarrId: 7,
        disambiguation: "English rock band",
        artistType: "Group",
      },
      {
        kind: "album",
        foreignId: ALBUM_MBID,
        name: "OK Computer",
        artistName: "Radiohead",
        artistForeignId: ARTIST_MBID,
        albumType: "Album",
        releaseDate: "1997-05-21",
      },
    ]);
    expect(artists.map((candidate) => candidate.lidarrId)).toEqual([undefined, 7]);
    expect(albums.map((candidate) => candidate.lidarrId)).toEqual([undefined, 11]);
  });

  it("returns fresh frozen empty arrays from every operation", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockImplementation(async () => jsonResponse([]));
    const client = createClient("secret", { fetch: fetchMock });

    const first = await Promise.all([
      client.search({ mode: "search", term: "empty" }),
      client.lookupArtists({ mode: "artist", term: "empty" }),
      client.lookupAlbums({ mode: "album", term: "empty" }),
    ]);
    const second = await Promise.all([
      client.search({ mode: "search", term: "empty" }),
      client.lookupArtists({ mode: "artist", term: "empty" }),
      client.lookupAlbums({ mode: "album", term: "empty" }),
    ]);

    expect(first).toEqual([[], [], []]);
    expect(first.every(Object.isFrozen)).toBe(true);
    expect(first.every((value, index) => value !== second[index])).toBe(true);
  });

  it("returns fresh deeply frozen candidate projections", async () => {
    const payload = [{ ...ARTIST_LOOKUP, id: 7 }];
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockImplementation(async () => jsonResponse(payload));
    const client = createClient("secret", { fetch: fetchMock });

    const first = await client.lookupArtists({ mode: "artist", term: "radiohead" });
    const second = await client.lookupArtists({ mode: "artist", term: "radiohead" });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects malformed responses from every search facade", async () => {
    const cases = [
      [
        "search",
        [{ foreignId: ARTIST_MBID, artist: ARTIST_LOOKUP, album: ALBUM_LOOKUP }],
        "lidarr search",
      ],
      ["lookupArtists", [{ artistName: "Missing foreign ID" }], "lidarr lookup artists"],
      ["lookupAlbums", Array.from({ length: 1_001 }, () => ALBUM_LOOKUP), "lidarr lookup albums"],
    ] as const;

    for (const [method, payload, operation] of cases) {
      const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse(payload));
      const client = createClient("secret", { fetch: fetchMock });
      const query =
        method === "search"
          ? ({ mode: "search", term: "bad" } as const)
          : method === "lookupArtists"
            ? ({ mode: "artist", term: "bad" } as const)
            : ({ mode: "album", term: "bad" } as const);
      const error = await client[method](query as never).catch((failure: unknown) => failure);

      expect(asLidarrError(error), method).toMatchObject({
        code: "invalid-response",
        operation,
      });
    }
  });

  it("preserves caller abort identity through a generated lookup operation", async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      return new Promise<Response>((_resolvePromise, rejectPromise) => {
        request.signal.addEventListener("abort", () => rejectPromise(request.signal.reason), {
          once: true,
        });
      });
    });
    const client = createClient("secret", { fetch: fetchMock });
    const controller = new AbortController();
    const reason = new DOMException("lookup cancelled", "AbortError");

    const pending = client
      .lookupAlbums({ mode: "album", term: "radiohead", signal: controller.signal })
      .catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });

  it("returns redacted typed failures from every search facade", async () => {
    const cases = [
      [
        "search",
        (client: LidarrClient) => client.search({ mode: "search", term: "secret" }),
        "lidarr search",
      ],
      [
        "artist lookup",
        (client: LidarrClient) => client.lookupArtists({ mode: "artist", term: "secret" }),
        "lidarr lookup artists",
      ],
      [
        "album lookup",
        (client: LidarrClient) => client.lookupAlbums({ mode: "album", term: "secret" }),
        "lidarr lookup albums",
      ],
    ] as const;

    for (const [label, invoke, operation] of cases) {
      const apiKey = "lookup-api-secret";
      const body = "lookup-response-secret";
      const fetchMock = vi
        .fn<FetchImplementation>()
        .mockResolvedValue(new Response(body, { status: 503 }));
      const client = createClient(apiKey, { fetch: fetchMock });
      const error = await invoke(client).catch((failure: unknown) => failure);

      expect(asLidarrError(error), label).toMatchObject({
        code: "lidarr-unreachable",
        operation,
        statusCode: 503,
      });
      expect(inspect(error), label).not.toContain(apiKey);
      expect(inspect(error), label).not.toContain(body);
      expect((error as Error).cause, label).toBeUndefined();
    }
  });
});

describe("LidarrClient artist-add facade", () => {
  const ROOT_FOLDERS = [
    {
      id: 4,
      path: "/music",
      accessible: true,
      freeSpace: 123_456,
      defaultMetadataProfileId: 2,
      defaultQualityProfileId: 99,
    },
  ];
  const ADD_INPUT = {
    artistName: "Recommendation name",
    foreignArtistId: ARTIST_MBID,
    rootFolderPath: "/music",
    qualityProfileId: 5,
    metadataProfileId: 2,
    monitored: false,
    monitorNewItems: "none",
    searchForMissingAlbums: false,
  } as const;

  it("reads exact installed identity and strict root folders through generated GETs", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      return new URL(request.url).pathname === "/api/v1/rootfolder"
        ? jsonResponse(ROOT_FOLDERS)
        : jsonResponse([{ ...ARTIST, foreignArtistId: ARTIST_MBID }]);
    });
    const client = createClient("secret", { fetch: fetchMock });
    const controller = new AbortController();

    const [artist, roots] = await Promise.all([
      client.getArtistByForeignId(ARTIST_MBID, controller.signal),
      client.listRootFolders(controller.signal),
    ]);

    expect(artist).toEqual(ARTIST);
    expect(roots).toEqual([
      {
        id: 4,
        path: "/music",
        accessible: true,
        freeSpace: 123_456,
        defaultMetadataProfileId: 2,
      },
    ]);
    expect(Object.isFrozen(roots)).toBe(true);
    expect(Object.isFrozen(roots[0])).toBe(true);
    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN}/api/v1/artist?mbId=${ARTIST_MBID}`,
      `GET ${ORIGIN}/api/v1/rootfolder`,
    ]);
  });

  it("returns undefined only for an empty exact read and rejects mismatched results", async () => {
    const emptyClient = createClient("secret", {
      fetch: vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse([])),
    });
    await expect(emptyClient.getArtistByForeignId(ARTIST_MBID)).resolves.toBeUndefined();

    const mismatchClient = createClient("secret", {
      fetch: vi
        .fn<FetchImplementation>()
        .mockResolvedValue(jsonResponse([{ ...ARTIST, foreignArtistId: ALBUM_MBID }])),
    });
    const error = await mismatchClient
      .getArtistByForeignId(ARTIST_MBID)
      .catch((failure: unknown) => failure);
    expect(asLidarrError(error)).toMatchObject({
      code: "invalid-response",
      operation: "lidarr get artist by foreign id",
    });
  });

  it("rejects malformed detailed root-folder evidence as an invalid response", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(jsonResponse([{ id: 4, path: "/music", accessible: true }]));
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.listRootFolders()).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr list root folders",
    });
  });

  it.each([
    ["default unmonitored", false],
    ["explicit monitored", true],
  ] as const)(
    "builds the exact %s create body with fixed album safety",
    async (_label, monitored) => {
      const requests: Request[] = [];
      const created = {
        ...ARTIST,
        artistName: "Authoritative name",
        foreignArtistId: ARTIST_MBID,
        monitored,
        monitorNewItems: "none",
        qualityProfileId: 5,
        metadataProfileId: 2,
        tags: [],
      };
      const fetchMock = vi.fn<FetchImplementation>(async (input) => {
        const request = input as Request;
        requests.push(request);
        return request.method === "POST"
          ? jsonResponse(created)
          : jsonResponse([
              {
                artistName: "Authoritative name",
                foreignArtistId: ARTIST_MBID,
                overview: "must not be copied",
                tags: [99],
              },
            ]);
      });
      const client = createClient("secret", { fetch: fetchMock });
      const controller = new AbortController();

      const prepared = await client.prepareArtistAdd(
        { ...ADD_INPUT, monitored },
        controller.signal,
      );
      await expect(client.addArtist(prepared, controller.signal)).resolves.toEqual(created);

      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        `GET ${ORIGIN}/api/v1/artist/lookup?term=lidarr%3A${ARTIST_MBID}`,
        `POST ${ORIGIN}/api/v1/artist`,
      ]);
      const postRequest = requests[1] as Request;
      expect(await postRequest.clone().json()).toEqual({
        artistName: "Authoritative name",
        foreignArtistId: ARTIST_MBID,
        rootFolderPath: "/music",
        qualityProfileId: 5,
        metadataProfileId: 2,
        monitored,
        monitorNewItems: "none",
        addOptions: {
          monitor: "none",
          searchForMissingAlbums: false,
        },
      });
    },
  );

  it.each([
    ["foreign artist identity", { foreignArtistId: ALBUM_MBID }],
    ["artist monitoring", { monitored: true }],
    ["new-item monitoring", { monitorNewItems: "all" }],
    ["quality profile", { qualityProfileId: 6 }],
    ["metadata profile", { metadataProfileId: 3 }],
  ] as const)("rejects a create response with mismatched %s", async (_label, override) => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      jsonResponse({
        ...ARTIST,
        foreignArtistId: ARTIST_MBID,
        monitored: false,
        monitorNewItems: "none",
        qualityProfileId: 5,
        metadataProfileId: 2,
        ...override,
      }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.addArtist(ADD_INPUT)).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr add artist",
    });
  });

  it.each([
    ["non-boolean artist monitoring", { ...ADD_INPUT, monitored: "true" }],
    ["automatic new-item monitoring", { ...ADD_INPUT, monitorNewItems: "all" }],
    ["missing-album search", { ...ADD_INPUT, searchForMissingAlbums: true }],
    ["unknown search field", { ...ADD_INPUT, searchForNewArtist: false }],
  ] as const)("rejects %s before transport", async (_label, input) => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.addArtist(input as never)).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr add artist",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-canonical identity and ambiguous exact lookup before POST", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      jsonResponse([
        { artistName: "One", foreignArtistId: ARTIST_MBID },
        { artistName: "Two", foreignArtistId: ARTIST_MBID },
      ]),
    );
    const client = createClient("secret", { fetch: fetchMock });

    await expect(
      client.prepareArtistAdd({ ...ADD_INPUT, foreignArtistId: ARTIST_MBID.toUpperCase() }),
    ).rejects.toMatchObject({ code: "validation", operation: "lidarr add artist" });
    await expect(client.prepareArtistAdd(ADD_INPUT)).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr add artist",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[0] as Request).method).toBe("GET");
  });
});

describe("LidarrClient error boundary", () => {
  it("maps every HTTP error class without leaking response bodies", async () => {
    const cases = [
      [401, LidarrValidationError, "configuration", undefined, false],
      [403, LidarrValidationError, "configuration", undefined, false],
      [404, LidarrValidationError, "validation", undefined, false],
      [429, RateLimitedError, "rate-limited", 429, true],
      [503, LidarrUnreachableError, "lidarr-unreachable", 503, true],
    ] as const;

    for (const [status, ctor, code, statusCode, retryable] of cases) {
      const fetchMock = vi
        .fn<FetchImplementation>()
        .mockResolvedValue(new Response("untrusted secret body", { status }));
      const client = createClient("secret", { fetch: fetchMock });

      const error = await client.listArtists().catch((failure: unknown) => failure);

      expect(asLidarrError(error)).toBeInstanceOf(ctor);
      expect(asLidarrError(error)).toMatchObject({
        code,
        operation: "lidarr list artists",
        statusCode,
        retryable,
      });
      expect(inspect(error)).not.toContain("untrusted secret body");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("preserves Retry-After metadata on a rate-limited generated operation", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "12" } }));
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client.getWantedMissing().catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toBeInstanceOf(RateLimitedError);
    expect(asLidarrError(error)).toMatchObject({
      operation: "lidarr wanted missing",
      retryAfterSeconds: 12,
      statusCode: 429,
    });
  });

  it("maps a timeout with the active operation label", async () => {
    const scheduleTimeout = (callback: () => void): unknown => {
      callback();
      return 1;
    };
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", {
      fetch: fetchMock,
      scheduleTimeout,
      cancelTimeout: () => {},
    });

    const error = await client.getHealth().catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toBeInstanceOf(LidarrTimeoutError);
    expect(asLidarrError(error)).toMatchObject({
      code: "timeout",
      operation: "lidarr health",
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves caller abort identity across the generated operation", async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      return new Promise<Response>((_resolvePromise, rejectPromise) => {
        request.signal.addEventListener("abort", () => rejectPromise(request.signal.reason), {
          once: true,
        });
      });
    });
    const client = createClient("secret", { fetch: fetchMock });
    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");

    const pending = client.getHealth(controller.signal).catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(pending).resolves.toBe(reason);
  });

  it("does not fetch an already-aborted generated operation", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });
    const controller = new AbortController();
    const reason = new DOMException("already cancelled", "AbortError");
    controller.abort(reason);

    const error = await client.getHealth(controller.signal).catch((failure: unknown) => failure);

    expect(error).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves cancellation for targeted reads and editor mutations", async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      return new Promise<Response>((_resolvePromise, rejectPromise) => {
        request.signal.addEventListener("abort", () => rejectPromise(request.signal.reason), {
          once: true,
        });
      });
    });
    const client = createClient("secret", { fetch: fetchMock });
    const alreadyAborted = new AbortController();
    const alreadyReason = new DOMException("target read cancelled", "AbortError");
    alreadyAborted.abort(alreadyReason);

    await expect(client.getArtist(1, alreadyAborted.signal)).rejects.toBe(alreadyReason);
    expect(fetchMock).not.toHaveBeenCalled();

    const inFlight = new AbortController();
    const inFlightReason = new DOMException("editor cancelled", "AbortError");
    const pending = client
      .updateArtistTags(1, { mode: "add", tagIds: [4] }, inFlight.signal)
      .catch((failure: unknown) => failure);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    inFlight.abort(inFlightReason);

    await expect(pending).resolves.toBe(inFlightReason);
  });

  it("keeps mutation errors credential- and body-free", async () => {
    const apiKey = "mutation-super-secret";
    const responseSecret = "mutation-response-secret";
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(responseSecret, { status: 503 }));
    const client = createClient(apiKey, { fetch: fetchMock });

    const error = await client
      .setArtistProfiles(1, { metadataProfileId: 2 })
      .catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "lidarr-unreachable",
      operation: "lidarr set artist profiles",
      statusCode: 503,
    });
    expect(inspect(error)).not.toContain(apiKey);
    expect(inspect(error)).not.toContain(responseSecret);
    expect((error as Error).cause).toBeUndefined();
  });

  it("sanitizes network and provider failures without exposing causes or client state", async () => {
    const apiKey = "reflected-super-secret";
    const providerSecret = "provider-internal-secret";
    const networkClient = createClient(apiKey, {
      fetch: vi.fn(async () => {
        throw new TypeError(`failed with X-Api-Key=${apiKey}`);
      }),
    });
    const providerClient = createClient("unused", { fetch: vi.fn<FetchImplementation>() }, ORIGIN, {
      getApiKey: async () => {
        throw new Error(providerSecret);
      },
    });

    const [networkError, providerError] = await Promise.all([
      networkClient.getSystemStatus().catch((failure: unknown) => failure),
      providerClient.getSystemStatus().catch((failure: unknown) => failure),
    ]);

    expect(asLidarrError(networkError)).toMatchObject({
      code: "lidarr-unreachable",
      operation: "lidarr system status",
      message: "Lidarr is unreachable",
    });
    expect(asLidarrError(providerError)).toMatchObject({
      code: "configuration",
      operation: "lidarr system status",
      message: "Lidarr API key is unavailable or invalid",
    });
    expect(inspect(networkError)).not.toContain(apiKey);
    expect(inspect(providerError)).not.toContain(providerSecret);
    expect((networkError as Error).cause).toBeUndefined();
    expect((providerError as Error).cause).toBeUndefined();
    expect(Object.keys(networkClient)).toEqual([]);
    expect(JSON.stringify(networkClient)).toBe("{}");
    expect(inspect(networkClient)).not.toContain(apiKey);
  });
});

describe("LidarrClient concurrent operation context", () => {
  it("isolates labels, origins, and keys across simultaneous generated operations", async () => {
    const originA = "https://lidarr-a.example.test";
    const originB = "https://lidarr-b.example.test";
    const seen: string[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      await Promise.resolve();
      seen.push(
        `${new URL(request.url).origin}:${request.headers.get("x-api-key")}:${new URL(request.url).pathname}`,
      );
      return new Response(null, { status: 503 });
    });
    const clientA = createClient("key-a", { fetch: fetchMock }, originA);
    const clientB = createClient("key-b", { fetch: fetchMock }, originB);

    const errors = await Promise.all([
      clientA.listQualityProfiles().catch((failure: unknown) => failure),
      clientA.setArtistProfiles(1, { qualityProfileId: 2 }).catch((failure: unknown) => failure),
      clientB.getArtist(3).catch((failure: unknown) => failure),
      clientB
        .updateArtistTags(3, { mode: "remove", tagIds: [4] })
        .catch((failure: unknown) => failure),
    ]);

    expect(errors.map((error) => asLidarrError(error).operation)).toEqual([
      "lidarr list quality profiles",
      "lidarr set artist profiles",
      "lidarr get artist",
      "lidarr update artist tags",
    ]);
    expect(errors.every((error) => asLidarrError(error).statusCode === 503)).toBe(true);
    expect(seen.sort()).toEqual([
      `${originA}:key-a:/api/v1/artist/editor`,
      `${originA}:key-a:/api/v1/qualityprofile`,
      `${originB}:key-b:/api/v1/artist/3`,
      `${originB}:key-b:/api/v1/artist/editor`,
    ]);
  });
});

describe("LidarrClient captured settings", () => {
  it("rejects every invalid captured request setting", () => {
    for (const [request, message] of [
      [{ timeoutMs: 0, delayMs: 0 }, "timeoutMs must be a positive safe integer"],
      [{ timeoutMs: 30_000, delayMs: -1 }, "delayMs must be a non-negative safe integer"],
    ] as const) {
      const connection = createLidarrConnectionSettings({
        origin: ORIGIN,
        apiKey: "secret",
        request,
      });

      expect(
        () => new LidarrClient(connection, new StaticLidarrApiKeyProvider(connection)),
      ).toThrow(message);
    }
  });
});

describe("LidarrClient album operations", () => {
  const ALBUM = {
    id: 11,
    title: "OK Computer",
    artistId: 1,
    monitored: true,
    albumType: "Album",
    secondaryTypes: ["Live"],
    statistics: { trackCount: 12, trackFileCount: 12, sizeOnDisk: 1_000 },
  };

  /** Serves albums derived from the requested albumIds query parameters. */
  function albumEchoFetch(): ReturnType<typeof vi.fn<FetchImplementation>> {
    return vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      const ids = new URL(request.url).searchParams.getAll("albumIds").map(Number);
      return jsonResponse(
        ids.map((id) => ({ id, title: `Album ${id}`, artistId: 1, monitored: true })),
      );
    });
  }

  it("rejects an unscoped album query before transport (whole-library guard)", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.listAlbums({})).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr list albums",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects every invalid album-query artistId before transport", async () => {
    for (const artistId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(client.listAlbums({ artistId })).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr list albums",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("lists one artist's albums through a single scoped GET with a fresh frozen projection", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse([ALBUM]));
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ artistId: 7 });

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`${ORIGIN}/api/v1/album?artistId=7`);
    expect(albums).toEqual([ALBUM]);
    expect(albums[0]).not.toBe(ALBUM);
    expect(Object.isFrozen(albums)).toBe(true);
    expect(Object.isFrozen(albums[0])).toBe(true);
    expect(Object.isFrozen(albums[0]?.secondaryTypes)).toBe(true);
    expect(Object.isFrozen(albums[0]?.statistics)).toBe(true);
  });

  it("rejects every invalid albumIds query class before transport", async () => {
    const cases = [
      ["empty", []],
      ["duplicate", [3, 3]],
      ["zero", [0]],
      ["negative", [-2]],
      ["non-integer", [1.5]],
    ] as const;

    for (const [label, albumIds] of cases) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(client.listAlbums({ albumIds }), label).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr list albums",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects albumIds queries above the plan-entry bound before transport", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });
    const albumIds = Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => index + 1);

    await expect(client.listAlbums({ albumIds })).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr list albums",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes an at-most-one-chunk albumIds query form-exploded in one GET", async () => {
    const fetchMock = albumEchoFetch();
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ albumIds: [5, 9] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe(`${ORIGIN}/api/v1/album?albumIds=5&albumIds=9`);
    expect(albums.map((album) => album.id)).toEqual([5, 9]);
  });

  it("chunks every oversized albumIds shape into sequential GETs of at most 200", async () => {
    for (const [count, chunkSizes] of [
      [201, [200, 1]],
      [450, [200, 200, 50]],
    ] as const) {
      const fetchMock = albumEchoFetch();
      const client = createClient("secret", { fetch: fetchMock });
      const albumIds = Array.from({ length: count }, (_, index) => index + 1);

      const albums = await client.listAlbums({ albumIds });

      expect(fetchMock).toHaveBeenCalledTimes(chunkSizes.length);
      const requestedIds = fetchMock.mock.calls.map((call) =>
        new URL((call[0] as Request).url).searchParams.getAll("albumIds").map(Number),
      );
      expect(requestedIds.map((ids) => ids.length)).toEqual([...chunkSizes]);
      expect(requestedIds.flat()).toEqual(albumIds);
      expect(albums.map((album) => album.id)).toEqual(albumIds);
      expect(Object.isFrozen(albums)).toBe(true);
    }
  });

  it("throws invalid-response when one album in the response is malformed", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(jsonResponse([ALBUM, { id: 12, title: "No monitored", artistId: 1 }]));
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.listAlbums({ artistId: 1 })).rejects.toMatchObject({
      code: "invalid-response",
      operation: "lidarr list albums",
    });
  });

  it("projects a null wire title to the empty string without poisoning the list", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        jsonResponse([
          { id: 21, title: null, artistId: 1, monitored: false, secondaryTypes: null },
          ALBUM,
        ]),
      );
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ artistId: 1 });

    expect(albums).toHaveLength(2);
    expect(albums[0]).toMatchObject({ id: 21, title: "", secondaryTypes: [] });
    expect(albums[1]).toEqual(ALBUM);
  });

  it("strips terminal-control and bidi characters from projected titles", async () => {
    const bell = String.fromCharCode(0x07);
    const rlo = String.fromCharCode(0x202e);
    const del = String.fromCharCode(0x7f);
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      jsonResponse([
        {
          id: 31,
          title: `Bad${bell}Ti${rlo}tle${del}`,
          artistId: 1,
          monitored: true,
          albumType: `Sin${bell}gle`,
        },
      ]),
    );
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ artistId: 1 });

    expect(albums[0]?.title).toBe("BadTitle");
    expect(albums[0]?.albumType).toBe("Single");
  });

  it("preserves the maximum title length and truncates the first excess character", async () => {
    for (const [length, expected] of [
      [2_048, 2_048],
      [2_049, 2_048],
    ] as const) {
      const fetchMock = vi
        .fn<FetchImplementation>()
        .mockResolvedValue(
          jsonResponse([{ id: 41, title: "A".repeat(length), artistId: 1, monitored: true }]),
        );
      const client = createClient("secret", { fetch: fetchMock });
      const albums = await client.listAlbums({ artistId: 1 });

      expect(albums[0]?.title, String(length)).toBe("A".repeat(expected));
    }
  });

  it("omits albumType when it is empty or sanitizes to the empty string", async () => {
    const rlm = String.fromCharCode(0x20_0f);
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      jsonResponse([
        { id: 51, title: "Kid A", artistId: 1, monitored: true, albumType: rlm },
        { id: 52, title: "Amnesiac", artistId: 1, monitored: true, albumType: "" },
      ]),
    );
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ artistId: 1 });

    expect(albums[0]).not.toHaveProperty("albumType");
    expect(albums[1]).not.toHaveProperty("albumType");
  });

  it("truncates an oversized albumType to 2048 characters", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(
        jsonResponse([
          { id: 61, title: "OK", artistId: 1, monitored: true, albumType: "T".repeat(3_000) },
        ]),
      );
    const client = createClient("secret", { fetch: fetchMock });

    const albums = await client.listAlbums({ artistId: 1 });

    expect(albums[0]?.albumType).toBe("T".repeat(2_048));
  });

  it("updates album monitoring through the generated monitor operation", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = createClient("secret", { fetch: fetchMock });

    await client.setAlbumsMonitored([7, 3], false);

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`${ORIGIN}/api/v1/album/monitor`);
    expect(await request.json()).toEqual({ albumIds: [7, 3], monitored: false });
  });

  it("accepts the maximum supported album mutation batch", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const client = createClient("secret", { fetch: fetchMock });
    const albumIds = Array.from({ length: LIDARR_PLAN_MAX_ENTRIES }, (_, index) => index + 1);

    await client.setAlbumsMonitored(albumIds, true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(await request.json()).toEqual({ albumIds, monitored: true });
  });

  it("rejects every invalid album mutation batch class before transport", async () => {
    const cases = [
      ["empty", []],
      ["duplicate", [3, 3]],
      ["non-positive", [0]],
      ["oversized", Array.from({ length: LIDARR_PLAN_MAX_ENTRIES + 1 }, (_, index) => index + 1)],
    ] as const;

    for (const [label, albumIds] of cases) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(client.setAlbumsMonitored(albumIds, true), label).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr update album monitoring",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects every non-boolean album monitored value before transport", async () => {
    for (const monitored of [undefined, "true", 1]) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(
        client.setAlbumsMonitored([3], monitored as unknown as boolean),
      ).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr update album monitoring",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

describe("LidarrClient album mutation primitives", () => {
  /** Raw wire album with unprojected fields the edit round-trip must preserve. */
  const WIRE_ALBUM = {
    id: 11,
    title: "OK Computer",
    artistId: 1,
    monitored: true,
    anyReleaseOk: false,
    albumType: "Album",
    secondaryTypes: ["Live"],
    foreignAlbumId: ALBUM_MBID,
    releaseDate: "1997-05-21",
    ratings: { votes: 12, value: 4.5 },
    releases: [{ id: 501, title: "Deluxe Edition", monitored: false }],
    addOptions: { addType: "automatic", searchForNewAlbum: true },
    statistics: { trackCount: 12, trackFileCount: 12, sizeOnDisk: 1_000 },
    fieldNewerThanTheGeneratedSpec: "must survive the round-trip",
  };

  it("deletes one album with explicit flags as query parameters without parsing the body", async () => {
    // A non-JSON success body pins the parseAs:"stream" empty-body pattern.
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(
      new Response("not-json accepted", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createClient("secret", { fetch: fetchMock });

    await expect(
      client.deleteAlbum(11, { deleteFiles: true, addImportListExclusion: false }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const url = new URL(request.url);
    expect(request.method).toBe("DELETE");
    expect(url.pathname).toBe("/api/v1/album/11");
    expect(url.searchParams.get("deleteFiles")).toBe("true");
    expect(url.searchParams.get("addImportListExclusion")).toBe("false");
    expect([...url.searchParams.keys()].sort()).toEqual(["addImportListExclusion", "deleteFiles"]);
  });

  it("rejects every invalid album-delete ID before transport", async () => {
    for (const albumId of [0, -1, 1.5, Number.NaN]) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(
        client.deleteAlbum(albumId, { deleteFiles: false, addImportListExclusion: false }),
      ).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr delete album",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects every malformed album-delete option class before transport", async () => {
    const cases = [
      ["unsupported field", { deleteFiles: true, addImportListExclusion: false, moveFiles: true }],
      ["non-boolean deleteFiles", { deleteFiles: "true", addImportListExclusion: false }],
      ["non-boolean addImportListExclusion", { deleteFiles: false, addImportListExclusion: 1 }],
      ["missing flag", { deleteFiles: true }],
    ] as const;

    for (const [label, options] of cases) {
      const fetchMock = vi.fn<FetchImplementation>();
      const client = createClient("secret", { fetch: fetchMock });

      await expect(client.deleteAlbum(11, options as never), label).rejects.toMatchObject({
        code: "validation",
        operation: "lidarr delete album",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("propagates an album-delete 404 as a not-found LidarrError (no client-side swallowing)", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client
      .deleteAlbum(11, { deleteFiles: false, addImportListExclusion: false })
      .catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "not-found",
      operation: "lidarr delete album",
      statusCode: 404,
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps non-404 album-delete failures through the standard taxonomy", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response("untrusted secret body", { status: 503 }));
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client
      .deleteAlbum(11, { deleteFiles: true, addImportListExclusion: true })
      .catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "lidarr-unreachable",
      operation: "lidarr delete album",
      statusCode: 503,
      retryable: true,
    });
    expect(inspect(error)).not.toContain("untrusted secret body");
  });

  it("flips exactly anyReleaseOk and forwards every unprojected wire field verbatim", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      return request.method === "GET"
        ? jsonResponse(WIRE_ALBUM)
        : new Response("not-json accepted", {
            status: 202,
            headers: { "content-type": "application/json" },
          });
    });
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.setAlbumAnyReleaseOk(11, true)).resolves.toBeUndefined();

    // The numeric album ID coerces to the string-typed PUT path id
    // (types.gen.ts quirk) and serializes to the same path segment.
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["GET /api/v1/album/11", "PUT /api/v1/album/11"],
    );
    const putRequest = requests[1] as Request;
    expect(putRequest.headers.get("content-type")).toContain("application/json");
    expect(await putRequest.json()).toEqual({ ...WIRE_ALBUM, anyReleaseOk: true });
  });

  it("preserves an already-true anyReleaseOk wire value when setting it to false", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      return request.method === "GET"
        ? jsonResponse({ ...WIRE_ALBUM, anyReleaseOk: true })
        : new Response(null, { status: 202 });
    });
    const client = createClient("secret", { fetch: fetchMock });

    await client.setAlbumAnyReleaseOk(11, false);

    const putRequest = requests[1] as Request;
    expect(await putRequest.json()).toEqual({ ...WIRE_ALBUM, anyReleaseOk: false });
  });

  it("rejects an invalid release-policy album ID or value before transport", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.setAlbumAnyReleaseOk(0, true)).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr set album release policy",
    });
    await expect(
      client.setAlbumAnyReleaseOk(11, "true" as unknown as boolean),
    ).rejects.toMatchObject({
      code: "validation",
      operation: "lidarr set album release policy",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch the PUT when the album GET fails", async () => {
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client.setAlbumAnyReleaseOk(11, true).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "lidarr-unreachable",
      operation: "lidarr set album release policy",
      statusCode: 503,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[0] as Request).method).toBe("GET");
  });

  it("rejects a malformed album GET body without dispatching the PUT", async () => {
    const fetchMock = vi.fn<FetchImplementation>().mockResolvedValue(jsonResponse([WIRE_ALBUM]));
    const client = createClient("secret", { fetch: fetchMock });

    const error = await client.setAlbumAnyReleaseOk(11, true).catch((failure: unknown) => failure);

    expect(asLidarrError(error)).toMatchObject({
      code: "invalid-response",
      operation: "lidarr set album release policy",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[0] as Request).method).toBe("GET");
  });
});

describe("LidarrClient manual-import and trackfile facade", () => {
  it("uses generated read and bulk-delete contracts behind frozen projections", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (input) => {
      const request = input as Request;
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/manualimport")) {
        return jsonResponse([
          {
            id: 1,
            path: "/music/album/01.flac",
            artist: { id: 2, artistName: "Artist", foreignArtistId: "artist-mbid" },
            album: {
              id: 3,
              artistId: 2,
              title: "Album",
              foreignAlbumId: "album-mbid",
              releases: [
                { id: 6, foreignReleaseId: "other-release-mbid" },
                { id: 4, foreignReleaseId: "release-mbid" },
              ],
            },
            albumReleaseId: 4,
            tracks: [{ id: 5, artistId: 2, albumId: 3, title: "Track" }],
            rejections: [],
            audioTags: { trackMBId: "track-mbid", trackNumbers: [1] },
          },
        ]);
      }
      if (pathname.endsWith("/trackfile/bulk")) return new Response(null, { status: 200 });
      if (pathname.endsWith("/trackfile")) {
        return jsonResponse([
          { id: 6, artistId: 2, albumId: 3, path: "/music/album/01.flac", size: 42 },
        ]);
      }
      return jsonResponse([
        { id: 5, artistId: 2, albumId: 3, title: "Track", trackFileId: 6, hasFile: true },
      ]);
    });
    const client = createClient("secret", { fetch: fetchMock });

    const candidates = await client.probeManualImport({
      folder: "/incoming/album",
      artistId: 2,
      filterExistingFiles: true,
      replaceExistingFiles: false,
    });
    const tracks = await client.listTracks({ albumId: 3 });
    const trackFiles = await client.listTrackFiles({ trackFileIds: [6] });
    await client.bulkDeleteTrackFiles([6]);

    expect(candidates[0]).toMatchObject({
      path: "/music/album/01.flac",
      albumReleaseId: 4,
      albumReleaseForeignId: "release-mbid",
      audioTags: { trackMbId: "track-mbid", trackNumbers: [1] },
    });
    expect(tracks[0]).toMatchObject({ id: 5, albumId: 3, trackFileId: 6 });
    expect(trackFiles[0]).toEqual({
      id: 6,
      artistId: 2,
      albumId: 3,
      path: "/music/album/01.flac",
      size: 42,
    });
    expect(Object.isFrozen(candidates[0]?.tracks)).toBe(true);
    expect(Object.isFrozen(trackFiles)).toBe(true);
    const [manualRequest, trackRequest, trackFileRequest, deleteRequest] = requests;
    const manualUrl = new URL(manualRequest?.url ?? ORIGIN);
    expect(manualUrl.searchParams.get("folder")).toBe("/incoming/album");
    expect(manualUrl.searchParams.get("artistId")).toBe("2");
    expect(manualUrl.searchParams.get("filterExistingFiles")).toBe("true");
    expect(new URL(trackRequest?.url ?? ORIGIN).searchParams.get("albumId")).toBe("3");
    expect(new URL(trackFileRequest?.url ?? ORIGIN).searchParams.getAll("trackFileIds")).toEqual([
      "6",
    ]);
    expect(deleteRequest?.method).toBe("DELETE");
    expect(await deleteRequest?.clone().json()).toEqual({ trackFileIds: [6] });
  });

  it("rejects unscoped or duplicate trackfile IDs before transport", async () => {
    const fetchMock = vi.fn<FetchImplementation>();
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.listTrackFiles({})).rejects.toMatchObject({ code: "validation" });
    await expect(client.bulkDeleteTrackFiles([2, 2])).rejects.toMatchObject({
      code: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LidarrClient rich preset facade", () => {
  it("selects every rich GET endpoint and returns deeply frozen projections", async () => {
    const fetchMock = vi.fn<FetchImplementation>(async (request) => {
      const pathname = new URL((request as Request).url).pathname;
      switch (pathname) {
        case "/api/v1/customformat":
          return jsonResponse([PRESET_CUSTOM_FORMAT_RESPONSE]);
        case "/api/v1/customformat/7":
          return jsonResponse(PRESET_CUSTOM_FORMAT_RESPONSE);
        case "/api/v1/customformat/schema":
          return jsonResponse([
            {
              implementation: "ReleaseTitleSpecification",
              implementationName: "Release Title",
              fields: [
                {
                  name: "value",
                  label: "Value",
                  type: "textbox",
                  advanced: false,
                  selectOptions: [],
                },
              ],
            },
          ]);
        case "/api/v1/qualityprofile":
          return jsonResponse([PRESET_QUALITY_PROFILE_RESPONSE]);
        case "/api/v1/qualityprofile/8":
        case "/api/v1/qualityprofile/schema":
          return jsonResponse(PRESET_QUALITY_PROFILE_RESPONSE);
        case "/api/v1/config/naming":
          return jsonResponse(PRESET_NAMING);
        case "/api/v1/config/naming/examples":
          return jsonResponse(PRESET_NAMING_EXAMPLES);
        default:
          return jsonResponse({}, { status: 404 });
      }
    });
    const client = createClient("secret", { fetch: fetchMock });

    const [
      customFormats,
      customFormat,
      customFormatSchema,
      qualityProfiles,
      qualityProfile,
      qualitySchema,
      naming,
      examples,
    ] = await Promise.all([
      client.listCustomFormats(),
      client.getCustomFormat(7),
      client.getCustomFormatSchema(),
      client.listQualityProfileDefinitions(),
      client.getQualityProfileDefinition(8),
      client.getQualityProfileSchema(),
      client.getNamingConfig(),
      client.getNamingExamples(PRESET_NAMING),
    ]);

    expect(
      fetchMock.mock.calls
        .map(
          ([request]) =>
            `${(request as Request).method} ${new URL((request as Request).url).pathname}`,
        )
        .sort(),
    ).toEqual(
      [
        "GET /api/v1/config/naming",
        "GET /api/v1/config/naming/examples",
        "GET /api/v1/customformat",
        "GET /api/v1/customformat/7",
        "GET /api/v1/customformat/schema",
        "GET /api/v1/qualityprofile",
        "GET /api/v1/qualityprofile/8",
        "GET /api/v1/qualityprofile/schema",
      ].sort(),
    );
    expect(Object.isFrozen(customFormats)).toBe(true);
    expect(Object.isFrozen(customFormat.specifications[0]?.fields)).toBe(true);
    expect(Object.isFrozen(customFormatSchema[0]?.fields)).toBe(true);
    expect(Object.isFrozen(qualityProfiles[0]?.items)).toBe(true);
    expect(Object.isFrozen(qualityProfile.formatItems[0]?.customFormat)).toBe(true);
    expect(Object.isFrozen(qualitySchema.items[0])).toBe(true);
    expect(Object.isFrozen(naming)).toBe(true);
    expect(Object.isFrozen(examples)).toBe(true);
    const examplesRequest = fetchMock.mock.calls
      .map(([request]) => request as Request)
      .find((request) => new URL(request.url).pathname.endsWith("/naming/examples"));
    expect(new URL(examplesRequest?.url ?? ORIGIN).searchParams.get("id")).toBe("1");
    expect(new URL(examplesRequest?.url ?? ORIGIN).searchParams.get("renameTracks")).toBe("false");
    expect(new URL(examplesRequest?.url ?? ORIGIN).searchParams.get("standardTrackFormat")).toBe(
      "",
    );
  });

  it("constructs complete create/update bodies and keeps string PUT IDs private", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (request) => {
      const finalRequest = request as Request;
      requests.push(finalRequest);
      const pathname = new URL(finalRequest.url).pathname;
      if (pathname.startsWith("/api/v1/customformat")) {
        return jsonResponse(PRESET_CUSTOM_FORMAT_RESPONSE);
      }
      if (pathname.startsWith("/api/v1/qualityprofile")) {
        return jsonResponse(PRESET_QUALITY_PROFILE_RESPONSE);
      }
      return jsonResponse(PRESET_NAMING);
    });
    const client = createClient("secret", { fetch: fetchMock });

    await client.createCustomFormat(PRESET_CUSTOM_FORMAT_INPUT);
    await client.updateCustomFormat({ ...PRESET_CUSTOM_FORMAT_INPUT, id: 7 });
    await client.createQualityProfile(PRESET_QUALITY_PROFILE_INPUT);
    await client.updateQualityProfile({ ...PRESET_QUALITY_PROFILE_INPUT, id: 8 });
    await client.updateNamingConfig(PRESET_NAMING);

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      [
        "POST /api/v1/customformat",
        "PUT /api/v1/customformat/7",
        "POST /api/v1/qualityprofile",
        "PUT /api/v1/qualityprofile/8",
        "PUT /api/v1/config/naming/1",
      ],
    );
    const expectedCustomFormatBody = {
      name: "Lossless",
      includeCustomFormatWhenRenaming: false,
      specifications: [
        {
          name: "Release title",
          implementation: "ReleaseTitleSpecification",
          negate: false,
          required: false,
          fields: [{ name: "value", value: "" }],
        },
      ],
    };
    expect(await requests[0]?.clone().json()).toEqual(expectedCustomFormatBody);
    expect(await requests[1]?.clone().json()).toEqual({ id: 7, ...expectedCustomFormatBody });
    const expectedQualityProfileBody = {
      name: "Music",
      upgradeAllowed: false,
      cutoff: 1,
      items: [
        {
          id: 1,
          quality: { id: 1, name: "FLAC" },
          allowed: true,
          items: [],
        },
      ],
      minFormatScore: 0,
      cutoffFormatScore: 0,
      formatItems: [{ format: 7, name: "Lossless", score: 0 }],
    };
    expect(await requests[2]?.clone().json()).toEqual(expectedQualityProfileBody);
    expect(await requests[3]?.clone().json()).toEqual({ id: 8, ...expectedQualityProfileBody });
    expect(await requests[4]?.clone().json()).toEqual(PRESET_NAMING);
  });

  it("preserves cancellation identity and sanitizes malformed rich responses", async () => {
    const reason = new DOMException("cancel preset read", "AbortError");
    const controller = new AbortController();
    controller.abort(reason);
    const fetchMock = vi
      .fn<FetchImplementation>()
      .mockResolvedValue(jsonResponse({ ...PRESET_NAMING_EXAMPLES, albumFolderExample: "\u202e" }));
    const client = createClient("secret", { fetch: fetchMock });

    await expect(client.getCustomFormatSchema(controller.signal)).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();

    const error = await client.getNamingExamples(PRESET_NAMING).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LidarrValidationError);
    expect(asLidarrError(error)).toMatchObject({
      code: "invalid-response",
      operation: "lidarr naming examples",
    });
    expect(inspect(error)).not.toContain("\u202e");
  });
});
