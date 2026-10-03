import { describe, expect, it } from "vitest";

import {
  projectLidarrAlbumLookupCandidates,
  projectLidarrArtist,
  projectLidarrArtistLookupCandidates,
  projectLidarrCustomFormatDefinitions,
  projectLidarrCustomFormatSchema,
  projectLidarrMetadataProfiles,
  projectLidarrNamingConfig,
  projectLidarrNamingExamples,
  projectLidarrQualityProfileDefinitions,
  projectLidarrQualityProfileSchema,
  projectLidarrRootFolders,
  projectLidarrSearchCandidates,
} from "./types.js";

const ARTIST_ID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const ALBUM_ID = "2f176e00-9f5f-4a34-8e4b-57d0419b0d72";

describe("projectLidarrArtist", () => {
  const artist = {
    id: 1,
    artistName: "Björk",
    foreignArtistId: ARTIST_ID,
    monitored: false,
    monitorNewItems: "none",
    qualityProfileId: 9,
    metadataProfileId: 3,
    path: "/music/Björk",
    tags: [2, 1, 2],
  };

  it("preserves the new-item monitoring policy in an immutable projection", () => {
    const result = projectLidarrArtist(artist);

    expect(result).toEqual({
      ...artist,
      tags: [1, 2],
    });
    expect(result).not.toBe(artist);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects an unknown new-item monitoring policy", () => {
    expect(projectLidarrArtist({ ...artist, monitorNewItems: "future-policy" })).toBeUndefined();
  });
});

describe("projectLidarrSearchCandidates", () => {
  it("projects both branches, ignores response-local ids, and omits generated fields", () => {
    const response = [
      {
        id: "not-a-durable-id",
        foreignId: ARTIST_ID,
        artist: {
          id: 7,
          artistName: "Nina Simone",
          foreignArtistId: ARTIST_ID,
          disambiguation: "US singer and pianist",
          artistType: "Person",
          path: "/music/nina-simone",
          tags: [1, 2],
        },
      },
      {
        id: -99,
        foreignId: ALBUM_ID,
        album: {
          id: 0,
          title: "Pastel Blues",
          foreignAlbumId: ALBUM_ID,
          albumType: "Album",
          releaseDate: "1965-10-01",
          artist: {
            artistName: "Nina Simone",
            foreignArtistId: ARTIST_ID,
            overview: "not projected",
          },
          releases: [{ id: 1 }],
          images: [{ url: "https://example.invalid/cover.jpg" }],
        },
      },
    ];

    const result = projectLidarrSearchCandidates(response);

    expect(result).toEqual([
      {
        kind: "artist",
        foreignId: ARTIST_ID,
        name: "Nina Simone",
        lidarrId: 7,
        disambiguation: "US singer and pianist",
        artistType: "Person",
      },
      {
        kind: "album",
        foreignId: ALBUM_ID,
        name: "Pastel Blues",
        artistName: "Nina Simone",
        artistForeignId: ARTIST_ID,
        albumType: "Album",
        releaseDate: "1965-10-01",
      },
    ]);
    expect(result).not.toBe(response);
    expect(result?.[0]).not.toBe(response[0]?.artist);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result?.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ["a non-array", {}],
    ["a missing branch", [{ foreignId: ARTIST_ID }]],
    [
      "ambiguous branches",
      [
        {
          foreignId: ARTIST_ID,
          artist: { artistName: "Artist", foreignArtistId: ARTIST_ID },
          album: { title: "Album", foreignAlbumId: ARTIST_ID },
        },
      ],
    ],
    ["a malformed durable id", [{ foreignId: "not-an-mbid", artist: { artistName: "Artist" } }]],
    [
      "a mismatched nested id",
      [
        {
          foreignId: ARTIST_ID,
          artist: { artistName: "Artist", foreignArtistId: ALBUM_ID },
        },
      ],
    ],
    [
      "an unsafe required name",
      [
        {
          foreignId: ARTIST_ID,
          artist: { artistName: "Artist\u001b[31m", foreignArtistId: ARTIST_ID },
        },
      ],
    ],
  ])("rejects the complete response containing %s", (_name, response) => {
    expect(projectLidarrSearchCandidates(response)).toBeUndefined();
  });

  it("rejects the complete response when one otherwise valid member is malformed", () => {
    expect(
      projectLidarrSearchCandidates([
        {
          foreignId: ARTIST_ID,
          artist: { artistName: "Artist", foreignArtistId: ARTIST_ID },
        },
        {
          foreignId: ALBUM_ID,
          album: { title: "Album", foreignAlbumId: ALBUM_ID, albumType: "\u202eunsafe" },
        },
      ]),
    ).toBeUndefined();
  });

  it("uses the nested durable id when the combined envelope omits its duplicate", () => {
    expect(
      projectLidarrSearchCandidates([
        {
          artist: { artistName: "Artist", foreignArtistId: ARTIST_ID },
        },
      ]),
    ).toEqual([{ kind: "artist", foreignId: ARTIST_ID, name: "Artist" }]);
  });
});

describe("projectLidarrArtistLookupCandidates", () => {
  it("projects nullable optional fields as omissions and returns immutable copies", () => {
    const source = [
      {
        id: 0,
        artistName: "Björk",
        foreignArtistId: ARTIST_ID,
        disambiguation: null,
        artistType: "Person",
        qualityProfileId: 9,
      },
    ];

    const result = projectLidarrArtistLookupCandidates(source);

    expect(result).toEqual([
      {
        kind: "artist",
        foreignId: ARTIST_ID,
        name: "Björk",
        artistType: "Person",
      },
    ]);
    expect(result).not.toBe(source);
    expect(result?.[0]).not.toBe(source[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.[0])).toBe(true);
  });

  it.each([
    ["missing foreign id", [{ artistName: "Artist" }]],
    ["null foreign id", [{ artistName: "Artist", foreignArtistId: null }]],
    ["fractional local id", [{ id: 1.5, artistName: "Artist", foreignArtistId: ARTIST_ID }]],
    [
      "unsafe disambiguation",
      [
        {
          artistName: "Artist",
          foreignArtistId: ARTIST_ID,
          disambiguation: "safe\u0000unsafe",
        },
      ],
    ],
    [
      "oversized artist type",
      [
        {
          artistName: "Artist",
          foreignArtistId: ARTIST_ID,
          artistType: "x".repeat(2_049),
        },
      ],
    ],
  ])("rejects %s atomically", (_name, response) => {
    expect(projectLidarrArtistLookupCandidates(response)).toBeUndefined();
  });
});

describe("projectLidarrRootFolders", () => {
  it("projects immutable root folders and omits nullable capacity", () => {
    const source = [
      {
        id: 4,
        path: "/music",
        accessible: true,
        freeSpace: 123_456,
        defaultMetadataProfileId: 3,
        defaultQualityProfileId: 7,
      },
      {
        id: 8,
        path: "/archive",
        accessible: false,
        freeSpace: null,
        defaultMetadataProfileId: 5,
      },
    ];

    const result = projectLidarrRootFolders(source);

    expect(result).toEqual([
      {
        id: 4,
        path: "/music",
        accessible: true,
        freeSpace: 123_456,
        defaultMetadataProfileId: 3,
      },
      {
        id: 8,
        path: "/archive",
        accessible: false,
        defaultMetadataProfileId: 5,
      },
    ]);
    expect(result).not.toBe(source);
    expect(result?.[0]).not.toBe(source[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result?.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    [
      "an unsafe path",
      [{ id: 1, path: "/music\u0000", accessible: true, defaultMetadataProfileId: 3 }],
    ],
    ["a missing accessibility flag", [{ id: 1, path: "/music", defaultMetadataProfileId: 3 }]],
    [
      "negative free space",
      [
        {
          id: 1,
          path: "/music",
          accessible: true,
          freeSpace: -1,
          defaultMetadataProfileId: 3,
        },
      ],
    ],
    ["a missing default metadata profile", [{ id: 1, path: "/music", accessible: true }]],
    [
      "an invalid default metadata profile",
      [{ id: 1, path: "/music", accessible: true, defaultMetadataProfileId: 0 }],
    ],
    [
      "duplicate ids",
      [
        { id: 1, path: "/music", accessible: true, defaultMetadataProfileId: 3 },
        { id: 1, path: "/archive", accessible: true, defaultMetadataProfileId: 4 },
      ],
    ],
  ])("rejects %s atomically", (_name, response) => {
    expect(projectLidarrRootFolders(response)).toBeUndefined();
  });
});

describe("projectLidarrMetadataProfiles", () => {
  const albumsOnly = {
    id: 3,
    name: "Albums",
    primaryAlbumTypes: [
      { id: 101, albumType: { id: 1, name: "Album" }, allowed: true },
      { id: 102, albumType: { id: 2, name: "EP" }, allowed: false },
    ],
    secondaryAlbumTypes: [{ id: 201, albumType: { id: 10, name: "Live" }, allowed: false }],
  };
  const mixed = {
    id: 4,
    name: "Albums and live releases",
    primaryAlbumTypes: [{ id: 103, albumType: { id: 1, name: "Album" }, allowed: true }],
    secondaryAlbumTypes: [{ id: 202, albumType: { id: 10, name: "Live" }, allowed: true }],
  };

  it("projects albums-only and mixed structural evidence into fresh frozen values", () => {
    const source = [albumsOnly, mixed];

    const result = projectLidarrMetadataProfiles(source);

    expect(result).toEqual([
      {
        id: 3,
        name: "Albums",
        primaryAlbumTypes: [
          { id: 1, name: "Album", allowed: true },
          { id: 2, name: "EP", allowed: false },
        ],
        secondaryAlbumTypes: [{ id: 10, name: "Live", allowed: false }],
      },
      {
        id: 4,
        name: "Albums and live releases",
        primaryAlbumTypes: [{ id: 1, name: "Album", allowed: true }],
        secondaryAlbumTypes: [{ id: 10, name: "Live", allowed: true }],
      },
    ]);
    expect(result).not.toBe(source);
    expect(result?.[0]).not.toBe(source[0]);
    expect(result?.[0]?.primaryAlbumTypes).not.toBe(source[0]?.primaryAlbumTypes);
    expect(result?.[0]?.primaryAlbumTypes[0]).not.toBe(source[0]?.primaryAlbumTypes[0]?.albumType);
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      result?.every(
        (profile) =>
          Object.isFrozen(profile) &&
          Object.isFrozen(profile.primaryAlbumTypes) &&
          profile.primaryAlbumTypes.every(Object.isFrozen) &&
          Object.isFrozen(profile.secondaryAlbumTypes) &&
          profile.secondaryAlbumTypes.every(Object.isFrozen),
      ),
    ).toBe(true);
  });

  it.each([
    ["missing primary types", [{ ...albumsOnly, primaryAlbumTypes: undefined }]],
    ["missing secondary types", [{ ...albumsOnly, secondaryAlbumTypes: undefined }]],
    ["nullable primary types", [{ ...albumsOnly, primaryAlbumTypes: null }]],
    [
      "a missing profile-item id",
      [
        {
          ...albumsOnly,
          primaryAlbumTypes: [{ albumType: { id: 1, name: "Album" }, allowed: true }],
        },
      ],
    ],
    [
      "a missing nested album type",
      [{ ...albumsOnly, primaryAlbumTypes: [{ id: 101, allowed: true }] }],
    ],
    [
      "a malformed nested type id",
      [
        {
          ...albumsOnly,
          primaryAlbumTypes: [{ id: 101, albumType: { id: 0, name: "Album" }, allowed: true }],
        },
      ],
    ],
    [
      "an unsafe nested type name",
      [
        {
          ...albumsOnly,
          secondaryAlbumTypes: [
            { id: 201, albumType: { id: 10, name: "Live\u0000" }, allowed: false },
          ],
        },
      ],
    ],
    [
      "a malformed allowed flag",
      [
        {
          ...albumsOnly,
          primaryAlbumTypes: [{ id: 101, albumType: { id: 1, name: "Album" }, allowed: "yes" }],
        },
      ],
    ],
  ])("rejects %s as a whole response", (_name, response) => {
    expect(projectLidarrMetadataProfiles(response)).toBeUndefined();
  });

  it("preserves the collection bound without returning partial output", () => {
    expect(
      projectLidarrMetadataProfiles(
        Array.from({ length: 1_000 }, (_, index) => ({
          ...albumsOnly,
          id: index + 1,
        })),
      ),
    ).toHaveLength(1_000);
    expect(
      projectLidarrMetadataProfiles(
        Array.from({ length: 1_001 }, (_, index) => ({
          ...albumsOnly,
          id: index + 1,
        })),
      ),
    ).toBeUndefined();
  });
});

describe("projectLidarrAlbumLookupCandidates", () => {
  it("projects the allowlisted album and artist fields", () => {
    const result = projectLidarrAlbumLookupCandidates([
      {
        id: 42,
        title: "Homogenic",
        foreignAlbumId: ALBUM_ID,
        albumType: "Album",
        releaseDate: "1997-09-22T00:00:00Z",
        artist: {
          artistName: "Björk",
          foreignArtistId: ARTIST_ID,
          path: "/music/bjork",
        },
        secondaryTypes: ["Studio"],
        overview: "not projected",
      },
    ]);

    expect(result).toEqual([
      {
        kind: "album",
        foreignId: ALBUM_ID,
        name: "Homogenic",
        lidarrId: 42,
        artistName: "Björk",
        artistForeignId: ARTIST_ID,
        albumType: "Album",
        releaseDate: "1997-09-22T00:00:00Z",
      },
    ]);
  });

  it.each([
    ["missing title", [{ foreignAlbumId: ALBUM_ID }]],
    ["malformed album id", [{ title: "Album", foreignAlbumId: "album-id" }]],
    [
      "unsafe artist name",
      [
        {
          title: "Album",
          foreignAlbumId: ALBUM_ID,
          artist: { artistName: "\u009funsafe" },
        },
      ],
    ],
    [
      "malformed artist id",
      [
        {
          title: "Album",
          foreignAlbumId: ALBUM_ID,
          artist: { foreignArtistId: "artist-id" },
        },
      ],
    ],
    [
      "unsafe release date",
      [{ title: "Album", foreignAlbumId: ALBUM_ID, releaseDate: "2026-01-01\u202e" }],
    ],
  ])("rejects %s atomically", (_name, response) => {
    expect(projectLidarrAlbumLookupCandidates(response)).toBeUndefined();
  });

  it("accepts exactly 1,000 records and rejects 1,001 without partial output", () => {
    const record = { title: "Album", foreignAlbumId: ALBUM_ID };

    expect(
      projectLidarrAlbumLookupCandidates(Array.from({ length: 1_000 }, () => record)),
    ).toHaveLength(1_000);
    expect(
      projectLidarrAlbumLookupCandidates(Array.from({ length: 1_001 }, () => record)),
    ).toBeUndefined();
  });
});

describe("rich Lidarr configuration projectors", () => {
  const customFormat = {
    id: 11,
    name: "Lossless",
    includeCustomFormatWhenRenaming: false,
    specifications: [
      {
        id: 21,
        name: "Release title",
        implementation: "ReleaseTitleSpecification",
        negate: false,
        required: false,
        fields: [{ name: "value", value: "" }],
      },
      {
        id: 22,
        name: "Size",
        implementation: "SizeSpecification",
        negate: true,
        required: true,
        fields: [
          { name: "min", value: 0 },
          { name: "max", value: 1.5 },
        ],
      },
    ],
  };

  const qualityProfile = {
    id: 31,
    name: "Music",
    upgradeAllowed: false,
    cutoff: 1,
    items: [
      {
        id: 100,
        name: "Lossless group",
        allowed: true,
        items: [
          {
            id: 1,
            quality: { id: 1, name: "FLAC" },
            allowed: false,
            items: [],
          },
        ],
      },
      {
        id: 2,
        quality: { id: 2, name: "MP3-320" },
        allowed: true,
      },
    ],
    minFormatScore: 0,
    cutoffFormatScore: 0,
    formatItems: [{ id: 41, format: 11, name: "Lossless", score: 0 }],
  };

  it("projects ordered custom-format definitions and deeply freezes explicit empty values", () => {
    const result = projectLidarrCustomFormatDefinitions([customFormat]);

    expect(result).toEqual([
      {
        id: 11,
        name: "Lossless",
        includeCustomFormatWhenRenaming: false,
        specifications: [
          {
            id: 21,
            name: "Release title",
            implementation: "ReleaseTitleSpecification",
            negate: false,
            required: false,
            fields: { value: "" },
          },
          {
            id: 22,
            name: "Size",
            implementation: "SizeSpecification",
            negate: true,
            required: true,
            fields: { min: 0, max: 1.5 },
          },
        ],
      },
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.[0]?.specifications)).toBe(true);
    expect(Object.isFrozen(result?.[0]?.specifications[0]?.fields)).toBe(true);
  });

  it("projects custom-format schema metadata and scalar select options", () => {
    const result = projectLidarrCustomFormatSchema([
      {
        implementation: "IndexerFlagSpecification",
        implementationName: "Indexer Flag",
        fields: [
          {
            name: "value",
            label: "Flag",
            type: "select",
            advanced: false,
            selectOptions: [
              { value: 0, name: "None" },
              { value: false, name: "Disabled" },
              { value: "", name: "Empty" },
            ],
          },
        ],
      },
    ]);

    expect(result?.[0]?.fields[0]?.selectOptions.map(({ value }) => value)).toEqual([0, false, ""]);
    expect(Object.isFrozen(result?.[0]?.fields[0]?.selectOptions)).toBe(true);
    expect(Object.isFrozen(result?.[0]?.fields[0]?.selectOptions[0])).toBe(true);
  });

  it.each([
    [
      "a normalized duplicate name",
      [customFormat, { ...customFormat, id: 12, name: " lossless " }],
    ],
    [
      "an object-valued dynamic field",
      [
        {
          ...customFormat,
          specifications: [
            {
              ...customFormat.specifications[0],
              fields: [{ name: "value", value: { regex: "FLAC" } }],
            },
          ],
        },
      ],
    ],
    [
      "an unsupported dynamic field",
      [
        {
          ...customFormat,
          specifications: [
            {
              ...customFormat.specifications[0],
              fields: [{ name: "unexpected", value: "FLAC" }],
            },
          ],
        },
      ],
    ],
  ])("rejects complete custom-format collections containing %s", (_name, value) => {
    expect(projectLidarrCustomFormatDefinitions(value)).toBeUndefined();
  });

  it("rejects a custom-format collection above the response bound", () => {
    expect(
      projectLidarrCustomFormatDefinitions(
        Array.from({ length: 1_001 }, (_entry, index) => ({
          ...customFormat,
          id: index + 1,
          name: `Format ${index + 1}`,
        })),
      ),
    ).toBeUndefined();
  });

  it("projects recursive quality definitions and schemas without changing order or falsy values", () => {
    const definitions = projectLidarrQualityProfileDefinitions([qualityProfile]);
    const schema = projectLidarrQualityProfileSchema({
      items: qualityProfile.items,
      formatItems: qualityProfile.formatItems,
    });

    expect(definitions?.[0]).toMatchObject({
      id: 31,
      upgradeAllowed: false,
      minFormatScore: 0,
      cutoffFormatScore: 0,
      items: [
        {
          kind: "group",
          name: "Lossless group",
          items: [{ kind: "quality", quality: { id: 1, name: "FLAC" }, allowed: false }],
        },
        { kind: "quality", quality: { id: 2, name: "MP3-320" }, allowed: true },
      ],
      formatItems: [{ customFormat: { id: 11, name: "Lossless" }, score: 0 }],
    });
    expect(schema).toEqual({
      items: definitions?.[0]?.items,
      formatItems: definitions?.[0]?.formatItems,
    });
    expect(Object.isFrozen(definitions?.[0]?.items[0])).toBe(true);
    expect(Object.isFrozen(definitions?.[0]?.formatItems[0]?.customFormat)).toBe(true);
  });

  it("rejects ambiguous quality nodes, duplicate identities, non-finite scores, and deep trees", () => {
    expect(
      projectLidarrQualityProfileDefinitions([
        {
          ...qualityProfile,
          items: [
            {
              id: 1,
              quality: { id: 1, name: "FLAC" },
              allowed: true,
              items: [{ id: 2, quality: { id: 2, name: "MP3" }, allowed: true }],
            },
          ],
        },
      ]),
    ).toBeUndefined();
    expect(
      projectLidarrQualityProfileDefinitions([
        qualityProfile,
        { ...qualityProfile, id: 32, name: " music " },
      ]),
    ).toBeUndefined();
    expect(
      projectLidarrQualityProfileDefinitions([
        {
          ...qualityProfile,
          formatItems: [{ format: 11, name: "Lossless", score: Number.POSITIVE_INFINITY }],
        },
      ]),
    ).toBeUndefined();

    let item: unknown = { id: 1, quality: { id: 1, name: "FLAC" }, allowed: true };
    for (let depth = 0; depth < 16; depth += 1) {
      item = { id: depth + 100, name: `Group ${depth}`, allowed: true, items: [item] };
    }
    expect(projectLidarrQualityProfileSchema({ items: [item], formatItems: [] })).toBeUndefined();

    const oversizedTree = Array.from({ length: 5 }, (_, groupIndex) => ({
      id: 10_000 + groupIndex,
      name: `Group ${groupIndex}`,
      allowed: true,
      items: Array.from({ length: 1_000 }, (_entry, leafIndex) => {
        const id = groupIndex * 1_000 + leafIndex + 1;
        return { id, quality: { id, name: `Quality ${id}` }, allowed: true };
      }),
    }));
    expect(
      projectLidarrQualityProfileSchema({ items: oversizedTree, formatItems: [] }),
    ).toBeUndefined();
  });

  it("projects naming config/examples while preserving zero, false, and empty strings", () => {
    const config = projectLidarrNamingConfig({
      id: 1,
      renameTracks: false,
      replaceIllegalCharacters: false,
      colonReplacementFormat: 0,
      standardTrackFormat: "",
      multiDiscTrackFormat: "",
      artistFolderFormat: "",
      includeQuality: true,
    });
    const examples = projectLidarrNamingExamples({
      singleTrackExample: "",
      multiDiscTrackExample: "Disc 1/01 - Track",
      artistFolderExample: "Artist",
      albumFolderExample: "Album",
    });

    expect(config).toEqual({
      id: 1,
      renameTracks: false,
      replaceIllegalCharacters: false,
      colonReplacementFormat: 0,
      standardTrackFormat: "",
      multiDiscTrackFormat: "",
      artistFolderFormat: "",
    });
    expect(examples?.singleTrackExample).toBe("");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(examples)).toBe(true);
    expect(
      projectLidarrNamingExamples({
        singleTrackExample: "safe\u202eunsafe",
        multiDiscTrackExample: "",
        artistFolderExample: "",
        albumFolderExample: "",
      }),
    ).toBeUndefined();
  });
});
