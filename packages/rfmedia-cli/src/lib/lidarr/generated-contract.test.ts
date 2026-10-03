import { describe, expect, it, vi } from "vitest";

import { createClient } from "./generated/client/index.js";
import {
  deleteApiV1AlbumById,
  getApiV1Album,
  getApiV1AlbumById,
  getApiV1AlbumLookup,
  getApiV1Artist,
  getApiV1ArtistById,
  getApiV1ArtistLookup,
  getApiV1ConfigNaming,
  getApiV1ConfigNamingExamples,
  getApiV1Customformat,
  getApiV1CustomformatById,
  getApiV1CustomformatSchema,
  getApiV1Health,
  getApiV1Metadataprofile,
  getApiV1Qualityprofile,
  getApiV1QualityprofileById,
  getApiV1QualityprofileSchema,
  getApiV1Rootfolder,
  getApiV1Search,
  getApiV1SystemStatus,
  getApiV1Tag,
  getApiV1WantedMissing,
  postApiV1Artist,
  postApiV1Customformat,
  postApiV1Qualityprofile,
  putApiV1AlbumById,
  putApiV1AlbumMonitor,
  putApiV1ArtistEditor,
  putApiV1ConfigNamingById,
  putApiV1CustomformatById,
  putApiV1QualityprofileById,
} from "./generated/sdk.gen.js";
import type {
  AlbumResource,
  AlbumResourcePagingResource,
  AlbumResourceWritable,
  AlbumsMonitoredResource,
  ArtistResource,
  ArtistResourceWritable,
  CustomFormatResource,
  HealthResource,
  MetadataProfileResource,
  NamingConfigResource,
  QualityProfileResource,
  RootFolderResource,
  SearchResource,
  SystemResource,
  TagResource,
} from "./generated/types.gen.js";

const ORIGIN_A = "https://lidarr-a.example.test";
const ORIGIN_B = "https://lidarr-b.example.test";

const SYSTEM_STATUS = {
  appName: "Lidarr A",
  version: "2.1.7.4030",
} satisfies SystemResource;

const HEALTH_ERROR = { message: "unavailable" };

const ARTISTS = [
  {
    id: 1,
    artistName: "Radiohead",
    foreignArtistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711",
  },
] satisfies Array<ArtistResource>;

const ALBUMS = [
  {
    id: 1,
    title: "OK Computer",
    artistId: 1,
    monitored: true,
    albumType: "Album",
    secondaryTypes: [],
  },
] satisfies Array<AlbumResource>;

const LOOKUP_ARTISTS = [
  {
    artistName: "Massive Attack",
    foreignArtistId: "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c",
    disambiguation: "Bristol group",
  },
] satisfies Array<ArtistResource>;

const LOOKUP_ALBUMS = [
  {
    title: "Mezzanine",
    foreignAlbumId: "28e2d3ea-84c1-34e9-8c0a-6a810d6c6f33",
    artist: LOOKUP_ARTISTS[0],
  },
] satisfies Array<AlbumResource>;

const SEARCH_RESULTS = [
  {
    id: 1,
    foreignId: LOOKUP_ARTISTS[0]!.foreignArtistId,
    artist: LOOKUP_ARTISTS[0],
  },
  {
    id: 2,
    foreignId: LOOKUP_ALBUMS[0]!.foreignAlbumId,
    album: LOOKUP_ALBUMS[0],
  },
] satisfies Array<SearchResource>;

const HEALTH_CHECKS = [
  {
    source: "IndexerStatusCheck",
    type: "warning",
    message: "Indexer unavailable",
  },
] satisfies Array<HealthResource>;

const METADATA_PROFILES = [{ id: 20, name: "Standard" }] satisfies Array<MetadataProfileResource>;
const QUALITY_PROFILES = [{ id: 10, name: "Lossless" }] satisfies Array<QualityProfileResource>;
const TAGS = [{ id: 30, label: "Favorite" }] satisfies Array<TagResource>;
const ROOT_FOLDERS = [
  { id: 40, path: "/music", accessible: true, freeSpace: 123_456 },
] satisfies Array<RootFolderResource>;
const ARTIST_ADD_BODY = {
  artistName: "Massive Attack",
  foreignArtistId: LOOKUP_ARTISTS[0]!.foreignArtistId,
  rootFolderPath: "/music",
  qualityProfileId: 10,
  metadataProfileId: 20,
  monitored: false,
  monitorNewItems: "none",
  addOptions: {
    monitor: "none",
    monitored: false,
    searchForMissingAlbums: false,
  },
} satisfies ArtistResourceWritable;
const CUSTOM_FORMAT = {
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
} satisfies CustomFormatResource;
const QUALITY_PROFILE = {
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
} satisfies QualityProfileResource;
const NAMING_CONFIG = {
  id: 1,
  renameTracks: false,
  replaceIllegalCharacters: false,
  colonReplacementFormat: 0,
  standardTrackFormat: "",
  multiDiscTrackFormat: "",
  artistFolderFormat: "",
} satisfies NamingConfigResource;
const NAMING_EXAMPLES = {
  singleTrackExample: "",
  multiDiscTrackExample: "Disc 1/01 - Track",
  artistFolderExample: "Artist",
  albumFolderExample: "Album",
};

const WANTED_PAGE = {
  page: 1,
  pageSize: 50,
  sortKey: "releaseDate",
  totalRecords: 0,
  records: [],
} satisfies AlbumResourcePagingResource;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("generated Lidarr NodeNext contract", () => {
  it("loads required generated operations through NodeNext .js specifiers", async () => {
    const runtimeModule = await import("./generated/sdk.gen.js");

    expect(runtimeModule.getApiV1SystemStatus).toBe(getApiV1SystemStatus);
    expect(runtimeModule.getApiV1Health).toBe(getApiV1Health);
    expect(runtimeModule.getApiV1Artist).toBe(getApiV1Artist);
    expect(runtimeModule.getApiV1ArtistById).toBe(getApiV1ArtistById);
    expect(runtimeModule.getApiV1Metadataprofile).toBe(getApiV1Metadataprofile);
    expect(runtimeModule.getApiV1Qualityprofile).toBe(getApiV1Qualityprofile);
    expect(runtimeModule.getApiV1Search).toBe(getApiV1Search);
    expect(runtimeModule.getApiV1ArtistLookup).toBe(getApiV1ArtistLookup);
    expect(runtimeModule.getApiV1Album).toBe(getApiV1Album);
    expect(runtimeModule.getApiV1AlbumLookup).toBe(getApiV1AlbumLookup);
    expect(runtimeModule.putApiV1AlbumMonitor).toBe(putApiV1AlbumMonitor);
    expect(runtimeModule.getApiV1Rootfolder).toBe(getApiV1Rootfolder);
    expect(runtimeModule.getApiV1Tag).toBe(getApiV1Tag);
    expect(runtimeModule.getApiV1WantedMissing).toBe(getApiV1WantedMissing);
    expect(runtimeModule.putApiV1ArtistEditor).toBe(putApiV1ArtistEditor);
    expect(runtimeModule.getApiV1Customformat).toBe(getApiV1Customformat);
    expect(runtimeModule.getApiV1CustomformatById).toBe(getApiV1CustomformatById);
    expect(runtimeModule.getApiV1CustomformatSchema).toBe(getApiV1CustomformatSchema);
    expect(runtimeModule.postApiV1Customformat).toBe(postApiV1Customformat);
    expect(runtimeModule.postApiV1Artist).toBe(postApiV1Artist);
    expect(runtimeModule.putApiV1CustomformatById).toBe(putApiV1CustomformatById);
    expect(runtimeModule.getApiV1QualityprofileById).toBe(getApiV1QualityprofileById);
    expect(runtimeModule.getApiV1QualityprofileSchema).toBe(getApiV1QualityprofileSchema);
    expect(runtimeModule.postApiV1Qualityprofile).toBe(postApiV1Qualityprofile);
    expect(runtimeModule.putApiV1QualityprofileById).toBe(putApiV1QualityprofileById);
    expect(runtimeModule.getApiV1ConfigNaming).toBe(getApiV1ConfigNaming);
    expect(runtimeModule.getApiV1ConfigNamingExamples).toBe(getApiV1ConfigNamingExamples);
    expect(runtimeModule.putApiV1ConfigNamingById).toBe(putApiV1ConfigNamingById);
  });

  it("keeps bulk-management operation methods and paths in the generated contract", async () => {
    const requests: Request[] = [];
    const generatedFetch = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const [request] = args;
      expect(request).toBeInstanceOf(Request);
      const finalRequest = request as Request;
      requests.push(finalRequest);
      const pathname = new URL(finalRequest.url).pathname;

      if (pathname === "/api/v1/artist/1") return jsonResponse(ARTISTS[0]);
      if (pathname === "/api/v1/metadataprofile") return jsonResponse(METADATA_PROFILES);
      if (pathname === "/api/v1/qualityprofile") return jsonResponse(QUALITY_PROFILES);
      if (pathname === "/api/v1/tag") return jsonResponse(TAGS);
      return jsonResponse({}, 202);
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: generatedFetch as typeof fetch });
    const editorRequest = putApiV1ArtistEditor({
      client,
      body: { artistIds: [1], qualityProfileId: 10, metadataProfileId: 20 },
    });

    const [artist, metadataProfiles, qualityProfiles, tags, editor] = await Promise.all([
      getApiV1ArtistById({ client, path: { id: 1 } }),
      getApiV1Metadataprofile({ client }),
      getApiV1Qualityprofile({ client }),
      getApiV1Tag({ client }),
      editorRequest,
    ]);

    expect(artist).toMatchObject({ data: ARTISTS[0] });
    expect(metadataProfiles).toMatchObject({ data: METADATA_PROFILES });
    expect(qualityProfiles).toMatchObject({ data: QUALITY_PROFILES });
    expect(tags).toMatchObject({ data: TAGS });
    expect(editor.response.status).toBe(202);
    const expectedRequests = [
      "PUT /api/v1/artist/editor",
      "GET /api/v1/artist/1",
      "GET /api/v1/metadataprofile",
      "GET /api/v1/qualityprofile",
      "GET /api/v1/tag",
    ];
    const actualRequests = requests.map(
      (request) => `${request.method} ${new URL(request.url).pathname}`,
    );
    expect(actualRequests).toEqual(expectedRequests);
    const editorHttpRequest = requests.find((request) => request.method === "PUT");
    expect(await editorHttpRequest?.clone().json()).toEqual({
      artistIds: [1],
      metadataProfileId: 20,
      qualityProfileId: 10,
    });
  });

  it("pins search and lookup GETs, term serialization, envelopes, and client isolation", async () => {
    const requestsA: Request[] = [];
    const requestsB: Request[] = [];
    const fetchA = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const request = args[0] as Request;
      requestsA.push(request);
      return jsonResponse(SEARCH_RESULTS);
    });
    const fetchB = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const request = args[0] as Request;
      requestsB.push(request);
      return new URL(request.url).pathname === "/api/v1/artist/lookup"
        ? jsonResponse(LOOKUP_ARTISTS)
        : jsonResponse(LOOKUP_ALBUMS);
    });
    const clientA = createClient({ baseUrl: ORIGIN_A, fetch: fetchA as typeof fetch });
    const clientB = createClient({ baseUrl: ORIGIN_B, fetch: fetchB as typeof fetch });

    const [search, artists, albums] = await Promise.all([
      getApiV1Search({ client: clientA, query: { term: "Massive Attack" } }),
      getApiV1ArtistLookup({ client: clientB, query: { term: "mbid:artist-id" } }),
      getApiV1AlbumLookup({ client: clientB, query: { term: "mbid:album-id" } }),
    ]);

    expect(Object.keys(search)).toEqual(["data", "request", "response"]);
    expect(Object.keys(artists)).toEqual(["data", "request", "response"]);
    expect(Object.keys(albums)).toEqual(["data", "request", "response"]);
    expect(search).toMatchObject({ data: SEARCH_RESULTS });
    expect(artists).toMatchObject({ data: LOOKUP_ARTISTS });
    expect(albums).toMatchObject({ data: LOOKUP_ALBUMS });

    const requests = [...requestsA, ...requestsB]
      .map((request) => {
        const url = new URL(request.url);
        return {
          method: request.method,
          origin: url.origin,
          path: url.pathname,
          queryKeys: [...url.searchParams.keys()],
          term: url.searchParams.get("term"),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(requests).toEqual([
      {
        method: "GET",
        origin: ORIGIN_B,
        path: "/api/v1/album/lookup",
        queryKeys: ["term"],
        term: "mbid:album-id",
      },
      {
        method: "GET",
        origin: ORIGIN_B,
        path: "/api/v1/artist/lookup",
        queryKeys: ["term"],
        term: "mbid:artist-id",
      },
      {
        method: "GET",
        origin: ORIGIN_A,
        path: "/api/v1/search",
        queryKeys: ["term"],
        term: "Massive Attack",
      },
    ]);
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(2);
  });

  it("pins root-folder and metadata-profile GETs plus artist POST methods, paths, bodies, and envelopes", async () => {
    const requests: Request[] = [];
    const createdArtist = { ...ARTISTS[0], ...ARTIST_ADD_BODY, tags: [] };
    const generatedFetch = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request = args[0] as Request;
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (request.method === "POST") return jsonResponse(createdArtist);
      if (pathname === "/api/v1/rootfolder") return jsonResponse(ROOT_FOLDERS);
      return jsonResponse(METADATA_PROFILES);
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: generatedFetch as typeof fetch });

    const [roots, metadataProfiles, artist] = await Promise.all([
      getApiV1Rootfolder({ client }),
      getApiV1Metadataprofile({ client }),
      postApiV1Artist({ client, body: ARTIST_ADD_BODY }),
    ]);

    expect(Object.keys(roots)).toEqual(["data", "request", "response"]);
    expect(Object.keys(metadataProfiles)).toEqual(["data", "request", "response"]);
    expect(Object.keys(artist)).toEqual(["data", "request", "response"]);
    expect(roots).toMatchObject({ data: ROOT_FOLDERS });
    expect(metadataProfiles).toMatchObject({ data: METADATA_PROFILES });
    expect(artist).toMatchObject({ data: createdArtist });
    expect(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname}`).sort(),
    ).toEqual(["GET /api/v1/metadataprofile", "GET /api/v1/rootfolder", "POST /api/v1/artist"]);
    const postRequest = requests.find((request) => request.method === "POST") as Request;
    expect(await postRequest.clone().json()).toEqual(ARTIST_ADD_BODY);
  });

  it("forwards caller aborts through every search and lookup operation", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request = args[0] as Request;
      requests.push(request);
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(request.signal.reason);
          return;
        }
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: fetchImpl as typeof fetch });
    const controller = new AbortController();
    const pending = [
      getApiV1Search({
        client,
        query: { term: "Massive Attack" },
        signal: controller.signal,
      }),
      getApiV1ArtistLookup({
        client,
        query: { term: "Massive Attack" },
        signal: controller.signal,
      }),
      getApiV1AlbumLookup({
        client,
        query: { term: "Mezzanine" },
        signal: controller.signal,
      }),
    ];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    const reason = new DOMException("cancel lookup", "AbortError");
    controller.abort(reason);
    const results = await Promise.all(pending);

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
    expect(results.every((result) => result.error === reason)).toBe(true);
  });

  it("keeps real operation requests and envelopes isolated per generated client", async () => {
    const requestsA: Request[] = [];
    const requestsB: Request[] = [];

    const fetchA = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const [request] = args;
      expect(request).toBeInstanceOf(Request);
      const finalRequest = request as Request;
      requestsA.push(finalRequest);

      if (new URL(finalRequest.url).pathname === "/api/v1/system/status") {
        return jsonResponse(SYSTEM_STATUS);
      }
      return jsonResponse(HEALTH_ERROR, 503);
    });
    const fetchB = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const [request] = args;
      expect(request).toBeInstanceOf(Request);
      const finalRequest = request as Request;
      requestsB.push(finalRequest);

      if (new URL(finalRequest.url).pathname === "/api/v1/artist") {
        return jsonResponse(ARTISTS);
      }
      return jsonResponse(WANTED_PAGE);
    });

    const clientA = createClient({ baseUrl: ORIGIN_A, fetch: fetchA as typeof fetch });
    const clientB = createClient({ baseUrl: ORIGIN_B, fetch: fetchB as typeof fetch });

    const [statusResult, healthResult, artistResult, wantedResult] = await Promise.all([
      getApiV1SystemStatus({ client: clientA }),
      getApiV1Health({ client: clientA }),
      getApiV1Artist({ client: clientB }),
      getApiV1WantedMissing({
        client: clientB,
        query: { page: 1, pageSize: 50, sortKey: "releaseDate" },
      }),
    ]);

    expect(Object.keys(statusResult)).toEqual(["data", "request", "response"]);
    expect(statusResult).toMatchObject({ data: SYSTEM_STATUS });
    expect(Object.keys(healthResult)).toEqual(["error", "request", "response"]);
    expect(healthResult).toMatchObject({ error: HEALTH_ERROR });
    expect(Object.keys(artistResult)).toEqual(["data", "request", "response"]);
    expect(artistResult).toMatchObject({ data: ARTISTS });
    expect(Object.keys(wantedResult)).toEqual(["data", "request", "response"]);
    expect(wantedResult).toMatchObject({ data: WANTED_PAGE });

    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(2);
    expect(fetchA.mock.calls.every((args) => args.length === 1)).toBe(true);
    expect(fetchB.mock.calls.every((args) => args.length === 1)).toBe(true);

    expect(requestsA.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN_A}/api/v1/health`,
      `GET ${ORIGIN_A}/api/v1/system/status`,
    ]);
    expect(requestsB.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN_B}/api/v1/artist`,
      `GET ${ORIGIN_B}/api/v1/wanted/missing?page=1&pageSize=50&sortKey=releaseDate`,
    ]);
    expect(requestsA.every((request) => new URL(request.url).origin === ORIGIN_A)).toBe(true);
    expect(requestsB.every((request) => new URL(request.url).origin === ORIGIN_B)).toBe(true);
  });

  it("loads the album operations through NodeNext .js specifiers", async () => {
    const runtimeModule = await import("./generated/sdk.gen.js");

    expect(runtimeModule.getApiV1Album).toBe(getApiV1Album);
    expect(runtimeModule.putApiV1AlbumMonitor).toBe(putApiV1AlbumMonitor);
  });

  it("pins the album operations' method, url, exploded query, and body shape", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const [request] = args;
      expect(request).toBeInstanceOf(Request);
      const finalRequest = request as Request;
      requests.push(finalRequest);
      if (finalRequest.method === "GET") {
        return jsonResponse(ALBUMS);
      }
      return jsonResponse({});
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: fetchImpl as typeof fetch });
    const monitorBody = { albumIds: [1, 2], monitored: false } satisfies AlbumsMonitoredResource;

    const [listResult, monitorResult] = await Promise.all([
      getApiV1Album({ client, query: { artistId: 7 } }),
      putApiV1AlbumMonitor({ client, body: monitorBody }),
    ]);

    expect(Object.keys(listResult)).toEqual(["data", "request", "response"]);
    expect(listResult).toMatchObject({ data: ALBUMS });
    expect(Object.keys(monitorResult)).toEqual(["data", "request", "response"]);

    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `GET ${ORIGIN_A}/api/v1/album?artistId=7`,
      `PUT ${ORIGIN_A}/api/v1/album/monitor`,
    ]);
    const putRequest = requests.find((request) => request.method === "PUT") as Request;
    expect(putRequest.headers.get("content-type")).toContain("application/json");
    expect(await putRequest.json()).toEqual(monitorBody);
  });

  it("loads the album-by-id operations through NodeNext .js specifiers", async () => {
    const runtimeModule = await import("./generated/sdk.gen.js");

    expect(runtimeModule.deleteApiV1AlbumById).toBe(deleteApiV1AlbumById);
    expect(runtimeModule.getApiV1AlbumById).toBe(getApiV1AlbumById);
    expect(runtimeModule.putApiV1AlbumById).toBe(putApiV1AlbumById);
  });

  it("pins the album-by-id operations' methods, urls, delete query, and PUT body passthrough", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      expect(args).toHaveLength(1);
      const [request] = args;
      expect(request).toBeInstanceOf(Request);
      const finalRequest = request as Request;
      requests.push(finalRequest);
      if (finalRequest.method === "DELETE") {
        return jsonResponse({});
      }
      return jsonResponse(ALBUMS[0]);
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: fetchImpl as typeof fetch });
    const putBody = {
      id: 1,
      title: "OK Computer",
      artistId: 1,
      monitored: true,
      anyReleaseOk: true,
      secondaryTypes: [],
    } satisfies AlbumResourceWritable;

    const [deleted, fetched, updated] = await Promise.all([
      deleteApiV1AlbumById({
        client,
        path: { id: 1 },
        query: { deleteFiles: true, addImportListExclusion: false },
      }),
      getApiV1AlbumById({ client, path: { id: 1 } }),
      // OpenAPI quirk: the PUT path id is string-typed (types.gen.ts).
      putApiV1AlbumById({ client, path: { id: "1" }, body: putBody }),
    ]);

    expect(Object.keys(deleted)).toEqual(["data", "request", "response"]);
    expect(Object.keys(fetched)).toEqual(["data", "request", "response"]);
    expect(fetched).toMatchObject({ data: ALBUMS[0] });
    expect(Object.keys(updated)).toEqual(["data", "request", "response"]);

    expect(requests.map((request) => `${request.method} ${request.url}`).sort()).toEqual([
      `DELETE ${ORIGIN_A}/api/v1/album/1?deleteFiles=true&addImportListExclusion=false`,
      `GET ${ORIGIN_A}/api/v1/album/1`,
      `PUT ${ORIGIN_A}/api/v1/album/1`,
    ]);
    const putRequest = requests.find((request) => request.method === "PUT") as Request;
    expect(putRequest.headers.get("content-type")).toContain("application/json");
    expect(await putRequest.json()).toEqual(putBody);
  });

  it("pins preset operation methods, paths, string PUT IDs, bodies, and envelopes", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request = args[0] as Request;
      requests.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/v1/customformat/schema") return jsonResponse([]);
      if (pathname === "/api/v1/customformat" && request.method === "GET") {
        return jsonResponse([CUSTOM_FORMAT]);
      }
      if (pathname.startsWith("/api/v1/customformat")) return jsonResponse(CUSTOM_FORMAT);
      if (pathname === "/api/v1/qualityprofile/schema") return jsonResponse(QUALITY_PROFILE);
      if (pathname === "/api/v1/qualityprofile" && request.method === "GET") {
        return jsonResponse([QUALITY_PROFILE]);
      }
      if (pathname.startsWith("/api/v1/qualityprofile")) return jsonResponse(QUALITY_PROFILE);
      if (pathname === "/api/v1/config/naming/examples") return jsonResponse(NAMING_EXAMPLES);
      return jsonResponse(NAMING_CONFIG);
    });
    const client = createClient({ baseUrl: ORIGIN_A, fetch: fetchImpl as typeof fetch });

    const results = await Promise.all([
      getApiV1Customformat({ client }),
      getApiV1CustomformatById({ client, path: { id: 7 } }),
      getApiV1CustomformatSchema({ client }),
      postApiV1Customformat({ client, body: CUSTOM_FORMAT }),
      putApiV1CustomformatById({ client, path: { id: "7" }, body: CUSTOM_FORMAT }),
      getApiV1Qualityprofile({ client }),
      getApiV1QualityprofileById({ client, path: { id: 8 } }),
      getApiV1QualityprofileSchema({ client }),
      postApiV1Qualityprofile({ client, body: QUALITY_PROFILE }),
      putApiV1QualityprofileById({ client, path: { id: "8" }, body: QUALITY_PROFILE }),
      getApiV1ConfigNaming({ client }),
      getApiV1ConfigNamingExamples({ client, query: NAMING_CONFIG }),
      putApiV1ConfigNamingById({ client, path: { id: "1" }, body: NAMING_CONFIG }),
    ]);

    expect(
      results.every((result) => Object.keys(result).join(",") === "data,request,response"),
    ).toBe(true);
    expect(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname}`).sort(),
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
        "POST /api/v1/customformat",
        "POST /api/v1/qualityprofile",
        "PUT /api/v1/config/naming/1",
        "PUT /api/v1/customformat/7",
        "PUT /api/v1/qualityprofile/8",
      ].sort(),
    );
    const writes = requests.filter(
      (request) => request.method === "POST" || request.method === "PUT",
    );
    const writeBodies = await Promise.all(
      writes.map(async (request) => ({
        operation: `${request.method} ${new URL(request.url).pathname}`,
        body: await request.clone().json(),
      })),
    );
    expect(writeBodies).toEqual([
      { operation: "POST /api/v1/customformat", body: CUSTOM_FORMAT },
      { operation: "PUT /api/v1/customformat/7", body: CUSTOM_FORMAT },
      { operation: "POST /api/v1/qualityprofile", body: QUALITY_PROFILE },
      { operation: "PUT /api/v1/qualityprofile/8", body: QUALITY_PROFILE },
      { operation: "PUT /api/v1/config/naming/1", body: NAMING_CONFIG },
    ]);
    const examplesRequest = requests.find(
      (request) => new URL(request.url).pathname === "/api/v1/config/naming/examples",
    );
    expect(new URL(examplesRequest?.url ?? ORIGIN_A).searchParams.get("id")).toBe("1");
    expect(new URL(examplesRequest?.url ?? ORIGIN_A).searchParams.get("renameTracks")).toBe(
      "false",
    );
  });

  it("keeps representative generated wire types available to NodeNext consumers", () => {
    expect(SYSTEM_STATUS.version).toBe("2.1.7.4030");
    expect(HEALTH_CHECKS[0]?.type).toBe("warning");
    expect(ARTISTS[0]?.artistName).toBe("Radiohead");
    expect(METADATA_PROFILES[0]?.name).toBe("Standard");
    expect(QUALITY_PROFILES[0]?.name).toBe("Lossless");
    expect(TAGS[0]?.label).toBe("Favorite");
    expect(ROOT_FOLDERS[0]?.path).toBe("/music");
    expect(WANTED_PAGE.records).toEqual([]);
  });
});
