import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions/filter.js", () => ({
  executeFilterList: vi.fn(),
  executeFilterShow: vi.fn(),
}));

vi.mock("../actions/copy-album.js", () => ({
  executeAlbumCopyWithFileInput: vi.fn(),
}));

vi.mock("../actions/copy-filter.js", () => ({
  executeFilterCopyWithFileInput: vi.fn(),
}));

vi.mock("../actions/sync.js", () => ({
  executeSyncWithFileInput: vi.fn(),
}));

vi.mock("../actions/plex-query.js", () => ({
  executePlexQuery: vi.fn(),
}));

vi.mock("../lib/convert.js", () => ({
  requireFfmpeg: vi.fn(),
}));

vi.mock("../lib/paths-yaml.js", () => ({
  loadAndValidatePathsYaml: vi.fn(),
}));

import { executeAlbumCopyWithFileInput } from "../actions/copy-album.js";
import { executeFilterCopyWithFileInput } from "../actions/copy-filter.js";
import { executeFilterList, executeFilterShow } from "../actions/filter.js";
import { executePlexQuery } from "../actions/plex-query.js";
import { executeSyncWithFileInput } from "../actions/sync.js";
import { resolveRequiredMediaServerAdapter } from "../lib/adapters/action-helpers.js";
import { requireFfmpeg } from "../lib/convert.js";
import { setLoadedConfig } from "../lib/loaded-config.js";
import { loadAndValidatePathsYaml } from "../lib/paths-yaml.js";

import {
  invokeCopyAlbum,
  invokeCopyFilter,
  invokeFilterList,
  invokeFilterShow,
  invokePlexQuery,
  invokeSync,
  RfmediaMcpAdapterError,
} from "./adapters.js";

describe("rfmedia MCP adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLoadedConfig({});
  });

  it("translates filter list args with dryRun default", async () => {
    vi.mocked(executeFilterList).mockResolvedValue({ filters: [], total: 0 });

    const result = await invokeFilterList({});

    expect(result).toMatchObject({ total: 0 });
    expect(executeFilterList).toHaveBeenCalledWith({ dryRun: false });
  });

  it("translates copy album args to action options", async () => {
    vi.mocked(executeAlbumCopyWithFileInput).mockResolvedValue({
      source: "/src",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    await invokeCopyAlbum({
      destination: "/dest",
      source: "/src",
      range: { start: 1, end: 3, padWidth: 3 },
      sources: [{ path: "/src-a" }],
      workers: 2,
    });

    expect(executeAlbumCopyWithFileInput).toHaveBeenCalledOnce();
    const [sourceArg, destinationArg, optionsArg] = vi.mocked(executeAlbumCopyWithFileInput).mock
      .calls[0]!;

    expect(sourceArg).toBeUndefined();
    expect(destinationArg).toBe("/dest");
    expect(optionsArg).toMatchObject({
      mode: {
        type: "album",
        range: { start: 1, end: 3, padWidth: 3 },
      },
      cliRange: { start: 1, end: 3, padWidth: 3 },
      workers: 2,
      cliSourceEntries: [{ path: "/src-a" }],
    });
  });

  it("loads copy album sources from paths YAML input", async () => {
    vi.mocked(loadAndValidatePathsYaml).mockResolvedValue({
      sourceEntries: [{ path: "/src-a" }],
      destination: "/yaml-dest",
      hasYamlFilters: false,
    });
    vi.mocked(executeAlbumCopyWithFileInput).mockResolvedValue({
      source: "/src-a",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    await invokeCopyAlbum({
      paths: "paths.yml",
      range: { start: 1, end: 3, padWidth: 3 },
    });

    expect(loadAndValidatePathsYaml).toHaveBeenCalledWith({
      pathsFile: "paths.yml",
      dryRun: false,
    });
    const [sourceArg, destinationArg, optionsArg] = vi.mocked(executeAlbumCopyWithFileInput).mock
      .calls[0]!;
    expect(sourceArg).toBeUndefined();
    expect(destinationArg).toBe("/yaml-dest");
    expect(optionsArg.cliSourceEntries).toMatchObject([{ path: "/src-a" }]);
  });

  it("rejects copy album paths input when destination mismatches YAML", async () => {
    vi.mocked(loadAndValidatePathsYaml).mockResolvedValue({
      sourceEntries: [{ path: "/src-a" }],
      destination: "/yaml-dest",
      hasYamlFilters: false,
    });

    await expect(
      invokeCopyAlbum({
        destination: "/other-dest",
        paths: "paths.yml",
        range: { start: 1, end: 2, padWidth: 3 },
      }),
    ).rejects.toBeInstanceOf(RfmediaMcpAdapterError);
  });

  it("rejects interactive conflict strategy in MCP mode", async () => {
    await expect(
      invokeCopyAlbum({
        destination: "/dest",
        source: "/src",
        range: { start: 1, end: 1, padWidth: 3 },
        conflictStrategy: "ask",
      }),
    ).rejects.toBeInstanceOf(RfmediaMcpAdapterError);

    expect(executeAlbumCopyWithFileInput).not.toHaveBeenCalled();
  });

  it("resolves configured smart filter names for copy.filter", async () => {
    setLoadedConfig({
      filters: {
        liked: {
          match: "all",
          rules: [{ type: "rule", field: "rating", operator: ">=", value: 4 }],
        },
      },
    });

    vi.mocked(executeFilterCopyWithFileInput).mockResolvedValue({
      source: "/src",
      created: 2,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    await invokeCopyFilter({
      destination: "/dest",
      source: "/src",
      filterName: "liked",
    });

    expect(executeFilterCopyWithFileInput).toHaveBeenCalledOnce();
    const optionsArg = vi.mocked(executeFilterCopyWithFileInput).mock.calls[0]?.[2];
    expect(optionsArg).toMatchObject({
      mode: {
        type: "filter",
        rating: {
          filterName: "liked",
          smartFilter: {
            match: "all",
          },
        },
      },
    });
  });

  it("loads copy filter sources from paths YAML and auto-applies first YAML filter", async () => {
    setLoadedConfig({
      filters: {
        liked: {
          match: "all",
          rules: [{ type: "rule", field: "rating", operator: ">=", value: 4 }],
        },
      },
    });
    vi.mocked(loadAndValidatePathsYaml).mockResolvedValue({
      sourceEntries: [{ path: "/src-a", filterName: "liked" }],
      destination: "/yaml-dest",
      hasYamlFilters: true,
      firstFilterName: "liked",
    });
    vi.mocked(executeFilterCopyWithFileInput).mockResolvedValue({
      source: "/src-a",
      created: 2,
      skipped: 0,
      filtered: 0,
      failed: [],
    });

    await invokeCopyFilter({
      paths: "paths.yml",
    });

    const [sourceArg, destinationArg, optionsArg] = vi.mocked(executeFilterCopyWithFileInput).mock
      .calls[0]!;
    expect(sourceArg).toBeUndefined();
    expect(destinationArg).toBe("/yaml-dest");
    expect(optionsArg).toMatchObject({
      cliSourceEntries: [{ path: "/src-a", filterName: "liked" }],
      mode: {
        type: "filter",
        rating: {
          filterName: "liked",
          smartFilter: {
            match: "all",
          },
        },
      },
    });
  });

  it("wraps action failures in deterministic adapter errors", async () => {
    vi.mocked(executeFilterShow).mockRejectedValue(new Error("boom"));

    await expect(invokeFilterShow({ name: "liked" })).rejects.toBeInstanceOf(
      RfmediaMcpAdapterError,
    );

    try {
      await invokeFilterShow({ name: "liked" });
    } catch (error) {
      expect(error).toBeInstanceOf(RfmediaMcpAdapterError);
      const adapterError = error as RfmediaMcpAdapterError;
      expect(adapterError.envelope).toMatchObject({
        code: "ERROR",
        message: "boom",
      });
    }
  });

  it("translates sync args and defaults deleteDowngraded to true", async () => {
    vi.mocked(executeSyncWithFileInput).mockResolvedValue({
      inputFile: "sources.txt",
      sourcesScanned: 1,
      newFilesCopied: 1,
      updatedFilesCopied: 0,
      unchangedFilesSkipped: 0,
      deletedFiles: 0,
      failedFiles: 0,
      failed: [],
    });

    await invokeSync({
      destination: "/dest",
      file: "sources.txt",
      mode: "album",
      range: { start: 1, end: 2, padWidth: 3 },
    });

    expect(executeSyncWithFileInput).toHaveBeenCalledOnce();
    const [, syncOptions] = vi.mocked(executeSyncWithFileInput).mock.calls[0]!;
    expect(syncOptions).toMatchObject({
      deleteDowngraded: true,
      copyOptions: {
        mode: { type: "album" },
      },
    });
  });

  it("treats mode=album as authoritative even when filter criteria exist", async () => {
    setLoadedConfig({
      copy: {
        minStars: 4.0,
      },
    });

    vi.mocked(executeSyncWithFileInput).mockResolvedValue({
      inputFile: "sources.txt",
      sourcesScanned: 1,
      newFilesCopied: 0,
      updatedFilesCopied: 0,
      unchangedFilesSkipped: 1,
      deletedFiles: 0,
      failedFiles: 0,
      failed: [],
    });

    await invokeSync({
      destination: "/dest",
      file: "sources.txt",
      mode: "album",
      range: { start: 1, end: 2, padWidth: 3 },
      minStars: 5.0,
    });

    const [, syncOptions] = vi.mocked(executeSyncWithFileInput).mock.calls[0]!;
    expect(syncOptions.copyOptions.mode).toEqual({
      type: "album",
      range: { start: 1, end: 2, padWidth: 3 },
    });
  });

  it("rejects mode=filter when no rating criteria are available", async () => {
    await expect(
      invokeSync({
        destination: "/dest",
        file: "sources.txt",
        mode: "filter",
      }),
    ).rejects.toBeInstanceOf(RfmediaMcpAdapterError);

    expect(executeSyncWithFileInput).not.toHaveBeenCalled();
  });

  it("allows mode=filter when rating criteria come from config defaults", async () => {
    setLoadedConfig({
      copy: {
        minRating: 85,
      },
    });

    vi.mocked(executeSyncWithFileInput).mockResolvedValue({
      inputFile: "sources.txt",
      sourcesScanned: 1,
      newFilesCopied: 0,
      updatedFilesCopied: 0,
      unchangedFilesSkipped: 1,
      deletedFiles: 0,
      failedFiles: 0,
      failed: [],
    });

    await invokeSync({
      destination: "/dest",
      file: "sources.txt",
      mode: "filter",
    });

    const [, syncOptions] = vi.mocked(executeSyncWithFileInput).mock.calls[0]!;
    expect(syncOptions.copyOptions.mode).toMatchObject({
      type: "filter",
      rating: {
        minRating: 85,
      },
    });
  });

  it("requires ffmpeg when copy/sync conversion is requested", async () => {
    vi.mocked(executeAlbumCopyWithFileInput).mockResolvedValue({
      source: "/src",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });
    vi.mocked(executeSyncWithFileInput).mockResolvedValue({
      inputFile: "sources.txt",
      sourcesScanned: 0,
      newFilesCopied: 0,
      updatedFilesCopied: 0,
      unchangedFilesSkipped: 0,
      deletedFiles: 0,
      failedFiles: 0,
      failed: [],
    });

    await invokeCopyAlbum({
      destination: "/dest",
      source: "/src",
      range: { start: 1, end: 1, padWidth: 3 },
      convertFormat: "alac",
    });

    await invokeSync({
      destination: "/dest",
      file: "sources.txt",
      mode: "album",
      range: { start: 1, end: 1, padWidth: 3 },
      convertFormat: "mp3",
    });

    expect(requireFfmpeg).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent read-tool adapter calls isolated", async () => {
    vi.mocked(executeFilterShow).mockImplementation(async (options) => {
      const delay = options.name === "one" ? 15 : 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      return {
        name: options.name,
        filter: { match: "all", rules: [] },
        ruleTree: options.name,
      };
    });

    const [resultOne, resultTwo] = await Promise.all([
      invokeFilterShow({ name: "one" }),
      invokeFilterShow({ name: "two" }),
    ]);

    expect(resultOne).toMatchObject({ name: "one", ruleTree: "one" });
    expect(resultTwo).toMatchObject({ name: "two", ruleTree: "two" });
  });

  it("projects the exact track result fields and forwards every query option unchanged", async () => {
    const actionResult = {
      tracks: [
        {
          ratingKey: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          userRating: 8,
          viewCount: 7,
          duration: 180_000,
          year: 2024,
          filePath: "/music/Track.flac",
          moods: ["Focused"],
          kind: "track",
          providerInternalId: "must-not-cross-mcp",
        },
      ],
      totalSize: 27,
      offset: 10,
      pageItemCount: 10,
      hasMore: true,
      queryId: 42,
    };
    vi.mocked(executePlexQuery).mockResolvedValue(actionResult);

    const args = {
      library: "Music",
      type: "track" as const,
      minArtistRating: 2,
      maxArtistRating: 5,
      minAlbumRating: 2.5,
      maxAlbumRating: 4.5,
      minTrackRating: 3,
      maxTrackRating: 4,
      genre: "Jazz",
      year: 2024,
      minYear: 2000,
      maxYear: 2025,
      minPlays: 7,
      artist: "Artist",
      title: "Title",
      album: "Album",
      style: "Fusion",
      mood: "Focused",
      limit: 10,
      plexUrl: "https://plex.example.test",
      plexToken: "opaque-token",
      name: "mcp-query",
      noSave: true,
      filter: "liked",
    };

    const result = await invokePlexQuery(args);

    expect(executePlexQuery).toHaveBeenCalledOnce();
    expect(executePlexQuery).toHaveBeenCalledWith(args);
    expect(vi.mocked(executePlexQuery).mock.calls[0]?.[0]).toBe(args);
    expect(result).toEqual({
      tracks: [
        {
          ratingKey: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          userRating: 8,
          viewCount: 7,
          duration: 180_000,
          year: 2024,
          filePath: "/music/Track.flac",
          moods: ["Focused"],
        },
      ],
      totalSize: 27,
      offset: 10,
      hasMore: true,
      queryId: 42,
    });
    expect(result).not.toBe(actionResult);
    expect(result).not.toHaveProperty("pageItemCount");
    if (!("tracks" in result)) {
      expect.fail("Expected the track result discriminator");
    }
    expect(result.tracks[0]).not.toHaveProperty("kind");
    expect(result.tracks[0]).not.toHaveProperty("providerInternalId");
  });

  it("preserves the album and artist result discriminators and compatibility fields", async () => {
    const albumResult = {
      albums: [
        {
          ratingKey: "album-1",
          title: "Album",
          artist: "Artist",
          userRating: 6,
          year: 2020,
          trackCount: 12,
          thumb: "/thumb/album",
          styles: ["Indie"],
          moods: ["Calm"],
          providerInternalId: "must-not-cross-mcp",
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      provider: "plex",
    };
    const artistResult = {
      artists: [
        {
          ratingKey: "artist-1",
          title: "Artist",
          userRating: 10,
          albumCount: 4,
          thumb: "/thumb/artist",
          styles: ["Soul"],
          moods: ["Warm"],
          providerInternalId: "must-not-cross-mcp",
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 9,
      provider: "plex",
    };
    vi.mocked(executePlexQuery)
      .mockResolvedValueOnce(albumResult)
      .mockResolvedValueOnce(artistResult);

    await expect(invokePlexQuery({ library: "Music", type: "album" })).resolves.toEqual({
      albums: [
        {
          ratingKey: "album-1",
          title: "Album",
          artist: "Artist",
          userRating: 6,
          year: 2020,
          trackCount: 12,
          thumb: "/thumb/album",
          styles: ["Indie"],
          moods: ["Calm"],
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
    });
    await expect(invokePlexQuery({ library: "Music", type: "artist" })).resolves.toEqual({
      artists: [
        {
          ratingKey: "artist-1",
          title: "Artist",
          userRating: 10,
          albumCount: 4,
          thumb: "/thumb/artist",
          styles: ["Soul"],
          moods: ["Warm"],
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 9,
    });
  });

  it("forwards same-origin, token-only, and explicitly paired connection overrides", async () => {
    setLoadedConfig({
      plex: {
        url: "https://plex.example.test/",
        token: "configured-secret-token",
      },
    });
    vi.mocked(executePlexQuery).mockImplementation(async (options) => {
      resolveRequiredMediaServerAdapter(options);
      return {
        tracks: [],
        totalSize: 0,
        offset: 0,
        hasMore: false,
      };
    });

    const sameOrigin = {
      library: "Music",
      plexUrl: "https://plex.example.test",
      noSave: true,
    };
    const tokenOnly = {
      library: "Music",
      plexToken: "replacement-secret-token",
      noSave: true,
    };
    const paired = {
      library: "Music",
      plexUrl: "https://other.example.test:32400",
      plexToken: "paired-secret-token",
      noSave: true,
    };

    await invokePlexQuery(sameOrigin);
    await invokePlexQuery(tokenOnly);
    await invokePlexQuery(paired);

    expect(executePlexQuery).toHaveBeenNthCalledWith(1, sameOrigin);
    expect(executePlexQuery).toHaveBeenNthCalledWith(2, tokenOnly);
    expect(executePlexQuery).toHaveBeenNthCalledWith(3, paired);
  });

  it("normalizes shared-factory cross-origin rejection without exposing secrets", async () => {
    const configuredSecret = "configured-secret-token";
    setLoadedConfig({
      plex: {
        url: "https://plex.example.test",
        token: configuredSecret,
      },
    });
    vi.mocked(executePlexQuery).mockImplementation(async (options) => {
      resolveRequiredMediaServerAdapter(options);
      return {
        tracks: [],
        totalSize: 0,
        offset: 0,
        hasMore: false,
      };
    });
    const args = {
      library: "Music",
      plexUrl: "https://other.example.test:32400",
      noSave: true,
    };

    try {
      await invokePlexQuery(args);
      expect.fail("Expected the shared adapter factory to reject a cross-origin URL-only override");
    } catch (error) {
      expect(error).toBeInstanceOf(RfmediaMcpAdapterError);
      const adapterError = error as RfmediaMcpAdapterError;
      expect(adapterError.envelope).toEqual({
        code: "ERROR",
        message: "A Plex URL override that changes origin requires an explicit --plex-token",
        suggestions: ["Run with --debug for more details"],
        details: { errorName: "Error" },
      });
      expect(JSON.stringify(adapterError.envelope)).not.toContain(configuredSecret);
    }

    expect(executePlexQuery).toHaveBeenCalledOnce();
    expect(executePlexQuery).toHaveBeenCalledWith(args);
  });
});
