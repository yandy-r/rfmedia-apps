import { describe, expect, it } from "vitest";

import { McpSchemaValidationError } from "@rfmedia/common";

import { RFMEDIA_MCP_TOOL_NAMES, rfmediaMcpSchemas } from "./schema.js";

describe("rfmedia MCP schemas", () => {
  it("parses valid inputs for all rfmedia MCP tools", () => {
    expect(rfmediaMcpSchemas.filterList.input.parse({ dryRun: true })).toMatchObject({
      dryRun: true,
    });

    expect(rfmediaMcpSchemas.filterShow.input.parse({ name: "liked" })).toMatchObject({
      name: "liked",
    });

    expect(
      rfmediaMcpSchemas.copyAlbum.input.parse({
        destination: "/dest",
        source: "/src",
        range: { start: 1, end: 3, padWidth: 3 },
      }),
    ).toMatchObject({
      destination: "/dest",
      range: { start: 1, end: 3, padWidth: 3 },
    });
    expect(
      rfmediaMcpSchemas.copyAlbum.input.parse({
        paths: "paths.yml",
      }),
    ).toMatchObject({
      paths: "paths.yml",
    });

    expect(
      rfmediaMcpSchemas.copyFilter.input.parse({
        destination: "/dest",
        source: "/src",
        minStars: 4,
      }),
    ).toMatchObject({
      destination: "/dest",
      minStars: 4,
    });
    expect(
      rfmediaMcpSchemas.copyFilter.input.parse({
        paths: "paths.yml",
      }),
    ).toMatchObject({
      paths: "paths.yml",
    });

    expect(
      rfmediaMcpSchemas.sync.input.parse({
        destination: "/dest",
        file: "sources.txt",
        mode: "album",
        range: { start: 1, end: 2, padWidth: 3 },
      }),
    ).toMatchObject({
      destination: "/dest",
      mode: "album",
    });

    expect(
      rfmediaMcpSchemas.plexQuery.input.parse({
        library: "Music",
        type: "track",
        minTrackRating: 4,
      }),
    ).toMatchObject({
      library: "Music",
      type: "track",
      minTrackRating: 4,
    });
  });

  it("rejects invalid nested payloads with deterministic array index paths", () => {
    expect(() =>
      rfmediaMcpSchemas.copyAlbum.input.parse({
        destination: "/dest",
        sources: [{ path: "/ok" }, { path: 42 }],
      }),
    ).toThrowError(McpSchemaValidationError);

    try {
      rfmediaMcpSchemas.copyAlbum.input.parse({
        destination: "/dest",
        sources: [{ path: "/ok" }, { path: 42 }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(McpSchemaValidationError);
      const validationError = error as McpSchemaValidationError;
      expect(validationError.issues[0]).toMatchObject({
        path: "$.sources[1].path",
        expected: "string",
      });
    }
  });

  it("rejects unknown properties for strict request contracts", () => {
    expect(() =>
      rfmediaMcpSchemas.filterList.input.parse({
        unexpected: true,
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("validates mutation and query output schemas", () => {
    expect(
      rfmediaMcpSchemas.copyFilter.output.parse({
        source: "/src",
        created: 1,
        skipped: 0,
        filtered: 0,
        failed: [],
      }),
    ).toMatchObject({
      created: 1,
    });

    expect(
      rfmediaMcpSchemas.plexQuery.output.parse({
        tracks: [
          {
            ratingKey: "track-1",
            title: "Track",
            artist: "Artist",
            album: "Album",
            userRating: 8,
            viewCount: 2,
            duration: 180000,
            year: 2024,
            filePath: "/music/Track.flac",
            moods: ["Focused"],
          },
        ],
        totalSize: 1,
        offset: 0,
        hasMore: false,
        queryId: 7,
      }),
    ).toEqual({
      tracks: [
        {
          ratingKey: "track-1",
          title: "Track",
          artist: "Artist",
          album: "Album",
          userRating: 8,
          viewCount: 2,
          duration: 180000,
          year: 2024,
          filePath: "/music/Track.flac",
          moods: ["Focused"],
        },
      ],
      totalSize: 1,
      offset: 0,
      hasMore: false,
      queryId: 7,
    });
  });

  it("keeps overrides optional without synthesizing credentials before factory resolution", () => {
    const urlOnly = rfmediaMcpSchemas.plexQuery.input.parse({
      library: "Music",
      plexUrl: "https://other.example:32400",
    });
    expect(urlOnly).toEqual({ library: "Music", plexUrl: "https://other.example:32400" });
    expect(urlOnly.plexToken).toBeUndefined();
    expect(JSON.parse(JSON.stringify(urlOnly))).toEqual({
      library: "Music",
      plexUrl: "https://other.example:32400",
    });

    expect(
      rfmediaMcpSchemas.plexQuery.input.parse({
        library: "Music",
        plexToken: "replacement-token",
      }),
    ).toEqual({ library: "Music", plexToken: "replacement-token" });
    expect(
      rfmediaMcpSchemas.plexQuery.input.parse({
        library: "Music",
        plexUrl: "https://other.example:32400",
        plexToken: "paired-token",
      }),
    ).toEqual({
      library: "Music",
      plexUrl: "https://other.example:32400",
      plexToken: "paired-token",
    });
  });

  it("freezes every optional Plex query input field in the serialized MCP schema", () => {
    expect(JSON.parse(JSON.stringify(rfmediaMcpSchemas.plexQuery.input.jsonSchema))).toEqual({
      type: "object",
      properties: {
        library: { type: "string" },
        type: { enum: ["track", "album", "artist"] },
        minArtistRating: { type: "number", minimum: 1, maximum: 5 },
        maxArtistRating: { type: "number", minimum: 1, maximum: 5 },
        minAlbumRating: { type: "number", minimum: 1, maximum: 5 },
        maxAlbumRating: { type: "number", minimum: 1, maximum: 5 },
        minTrackRating: { type: "number", minimum: 1, maximum: 5 },
        maxTrackRating: { type: "number", minimum: 1, maximum: 5 },
        genre: { type: "string" },
        year: { type: "integer" },
        minYear: { type: "integer" },
        maxYear: { type: "integer" },
        minPlays: { type: "integer", minimum: 0 },
        artist: { type: "string" },
        title: { type: "string" },
        album: { type: "string" },
        style: { type: "string" },
        mood: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        plexUrl: { type: "string" },
        plexToken: { type: "string" },
        name: { type: "string" },
        noSave: { type: "boolean" },
        filter: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    });
  });

  it("freezes serialized Plex result variants and required compatibility fields", () => {
    const serialized = JSON.parse(
      JSON.stringify(rfmediaMcpSchemas.plexQuery.output.jsonSchema),
    ) as {
      oneOf: Array<{
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      }>;
    };

    expect(serialized.oneOf).toHaveLength(3);
    expect(
      serialized.oneOf.map((variant) => ({
        fields: Object.keys(variant.properties),
        required: variant.required,
        additionalProperties: variant.additionalProperties,
      })),
    ).toEqual([
      {
        fields: ["tracks", "totalSize", "offset", "hasMore", "queryId"],
        required: ["hasMore", "offset", "totalSize", "tracks"],
        additionalProperties: false,
      },
      {
        fields: ["albums", "totalSize", "offset", "hasMore", "queryId"],
        required: ["albums", "hasMore", "offset", "totalSize"],
        additionalProperties: false,
      },
      {
        fields: ["artists", "totalSize", "offset", "hasMore", "queryId"],
        required: ["artists", "hasMore", "offset", "totalSize"],
        additionalProperties: false,
      },
    ]);
  });

  it("adds no JWT-specific MCP auth field", () => {
    const properties = rfmediaMcpSchemas.plexQuery.input.jsonSchema.properties ?? {};
    const jwtFields = Object.keys(properties).filter((field) =>
      field.toLowerCase().includes("jwt"),
    );

    expect(jwtFields).toEqual([]);
    expect(properties).not.toHaveProperty("tokenProvider");
    expect(() =>
      rfmediaMcpSchemas.plexQuery.input.parse({
        library: "Music",
        plexJwt: "new-required-auth-field",
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("keeps album and artist result variants and their Plex compatibility fields", () => {
    expect(
      rfmediaMcpSchemas.plexQuery.output.parse({
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
      }),
    ).toMatchObject({
      albums: [
        expect.objectContaining({
          ratingKey: "album-1",
          userRating: 6,
          trackCount: 12,
          styles: ["Indie"],
        }),
      ],
    });

    expect(
      rfmediaMcpSchemas.plexQuery.output.parse({
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
      }),
    ).toMatchObject({
      artists: [
        expect.objectContaining({
          ratingKey: "artist-1",
          userRating: 10,
          albumCount: 4,
          moods: ["Warm"],
        }),
      ],
    });
  });

  it("rejects provider-neutral fields at the unchanged Plex MCP boundary", () => {
    expect(() =>
      rfmediaMcpSchemas.plexQuery.output.parse({
        tracks: [
          {
            id: "track-1",
            kind: "track",
            title: "Track",
            artist: "Artist",
            album: "Album",
            rating: 0.8,
            viewCount: 2,
            duration: 180000,
            filePath: "/music/Track.flac",
          },
        ],
        totalSize: 1,
        offset: 0,
        hasMore: false,
      }),
    ).toThrowError(McpSchemaValidationError);
  });

  it("keeps tool-name constants stable and namespaced", () => {
    expect(Object.values(RFMEDIA_MCP_TOOL_NAMES).sort()).toEqual(
      [
        "rfmedia.filter.list",
        "rfmedia.filter.show",
        "rfmedia.copy.album",
        "rfmedia.copy.filter",
        "rfmedia.sync",
        "rfmedia.plex.query",
      ].sort(),
    );
  });
});
