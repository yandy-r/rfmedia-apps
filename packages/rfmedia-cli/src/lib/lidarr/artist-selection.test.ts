import { describe, expect, it } from "vitest";

import type {
  LidarrArtist,
  LidarrProfile,
  LidarrRootFolder,
  LidarrTag,
  LidarrTagMutationMode,
} from "../../types/lidarr.js";
import { LIDARR_PLAN_DEFAULT_MAX_BATCH, LIDARR_PLAN_MAX_BATCH } from "../../types/lidarr-plan.js";
import {
  calculateLidarrTagSetChange,
  normalizeLidarrTagIds,
  resolveLidarrProfileReference,
  resolveLidarrRootFolderReference,
  resolveLidarrTagReference,
  selectLidarrArtists,
  type LidarrArtistSelectionInput,
} from "./artist-selection.js";

function artist(id: number, overrides: Partial<LidarrArtist> = {}): LidarrArtist {
  return {
    id,
    artistName: `Artist ${id}`,
    foreignArtistId: `mbid-${id}`,
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 1,
    tags: [],
    ...overrides,
  };
}

describe("selectLidarrArtists", () => {
  const artists = [
    artist(3, {
      monitored: false,
      qualityProfileId: 2,
      metadataProfileId: 3,
      tags: [1, 2, 3],
    }),
    artist(1, {
      monitored: false,
      qualityProfileId: 2,
      metadataProfileId: 3,
      tags: [1, 2],
    }),
    artist(2, {
      monitored: true,
      qualityProfileId: 2,
      metadataProfileId: 3,
      tags: [1, 2, 3],
    }),
    artist(4, {
      monitored: false,
      qualityProfileId: 2,
      metadataProfileId: 4,
      tags: [1, 2, 3],
    }),
  ];

  it("rejects every missing or conflicting selection-mode combination", () => {
    const cases = [
      ["missing mode", {}],
      ["ids and all", { ids: [1], all: true }],
      ["ids and filters", { ids: [1], monitored: true }],
      ["filters and all", { all: true, monitored: true }],
      ["all three modes", { ids: [1], all: true, monitored: true }],
    ] satisfies ReadonlyArray<readonly [string, LidarrArtistSelectionInput]>;

    for (const [name, input] of cases) {
      expect(() => selectLidarrArtists(artists, input), name).toThrow(
        "Exactly one artist selection mode",
      );
    }
  });

  it("rejects conflicting monitored filters", () => {
    expect(() => selectLidarrArtists(artists, { monitored: true, unmonitored: true })).toThrow(
      "mutually exclusive",
    );
  });

  it("rejects every invalid artist-ID collection class", () => {
    const cases = [
      ["empty", []],
      ["duplicate", [1, 1]],
      ["zero", [0]],
      ["negative", [-1]],
      ["fraction", [1.5]],
      ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
    ] satisfies ReadonlyArray<readonly [string, readonly number[]]>;

    for (const [name, ids] of cases) {
      expect(() => selectLidarrArtists(artists, { ids }), name).toThrow();
    }
  });

  it("reports every unknown artist ID deterministically", () => {
    expect(() => selectLidarrArtists(artists, { ids: [9, 8] })).toThrow("Unknown artist IDs: 8, 9");
  });

  it("applies AND across filter families and all-of tag selectors", () => {
    const selected = selectLidarrArtists(artists, {
      unmonitored: true,
      qualityProfileId: 2,
      metadataProfileId: 3,
      tagIds: [3, 1, 3],
    });

    expect(selected.map(({ id }) => id)).toEqual([3]);
  });

  it("sorts exact-ID and all-mode cohorts without mutating the snapshot", () => {
    const exact = selectLidarrArtists(artists, { ids: [3, 1] });
    const all = selectLidarrArtists(artists, { all: true });

    expect(exact.map(({ id }) => id)).toEqual([1, 3]);
    expect(all.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(artists.map(({ id }) => id)).toEqual([3, 1, 2, 4]);
  });

  it("fails a complete-cohort zero match", () => {
    expect(() => selectLidarrArtists(artists, { qualityProfileId: 99 })).toThrow(
      "matched zero artists",
    );
  });

  it("allows the default cap boundary", () => {
    const cohort = Array.from({ length: LIDARR_PLAN_DEFAULT_MAX_BATCH }, (_, index) =>
      artist(index + 1),
    );

    expect(selectLidarrArtists(cohort, { all: true })).toHaveLength(LIDARR_PLAN_DEFAULT_MAX_BATCH);
  });

  it("checks the full matched cohort instead of truncating to the default cap", () => {
    const selectedCount = LIDARR_PLAN_DEFAULT_MAX_BATCH + 1;
    const cohort = Array.from({ length: selectedCount + 4 }, (_, index) =>
      artist(index + 1, { monitored: index < selectedCount }),
    );

    expect(() => selectLidarrArtists(cohort, { monitored: true })).toThrow(
      `matched ${selectedCount} artists, exceeding maxBatch ${LIDARR_PLAN_DEFAULT_MAX_BATCH}`,
    );
  });

  it("does not apply the cap to non-matching artists", () => {
    const cohort = Array.from({ length: 40 }, (_, index) =>
      artist(index + 1, { monitored: index < LIDARR_PLAN_DEFAULT_MAX_BATCH }),
    );

    expect(selectLidarrArtists(cohort, { monitored: true })).toHaveLength(
      LIDARR_PLAN_DEFAULT_MAX_BATCH,
    );
  });

  it("allows the hard cap boundary without truncation", () => {
    const cohort = Array.from({ length: LIDARR_PLAN_MAX_BATCH }, (_, index) => artist(index + 1));

    expect(
      selectLidarrArtists(cohort, { all: true, maxBatch: LIDARR_PLAN_MAX_BATCH }),
    ).toHaveLength(LIDARR_PLAN_MAX_BATCH);
  });

  it("rejects every invalid maxBatch boundary class", () => {
    for (const maxBatch of [0, LIDARR_PLAN_MAX_BATCH + 1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => selectLidarrArtists([artist(1)], { all: true, maxBatch })).toThrow("maxBatch");
    }
  });
});

describe("resource reference resolution", () => {
  const profiles: readonly LidarrProfile[] = [
    { id: 42, name: "Lossless" },
    { id: 7, name: "  Standard  " },
    { id: 9, name: "123" },
    { id: 123, name: "Numeric ID target" },
  ];
  const tags: readonly LidarrTag[] = [
    { id: 4, label: "Favorite" },
    { id: 8, label: "Road Trip" },
  ];
  const rootFolders: readonly LidarrRootFolder[] = [
    { id: 2, path: "/music", accessible: true },
    { id: 7, path: "123", accessible: true },
    { id: 123, path: "/archive", accessible: false },
  ];

  it("resolves positive decimal profile references by ID", () => {
    expect(resolveLidarrProfileReference(" 42 ", profiles)).toEqual({
      id: 42,
      name: "Lossless",
    });
  });

  it("resolves trimmed case-insensitive exact profile names", () => {
    expect(resolveLidarrProfileReference(" STANDARD ", profiles)).toEqual({
      id: 7,
      name: "  Standard  ",
    });
  });

  it("uses name: to force interpretation of a numeric name", () => {
    expect(resolveLidarrProfileReference("name:123", profiles)).toEqual({
      id: 9,
      name: "123",
    });
    expect(resolveLidarrProfileReference("123", profiles)).toEqual({
      id: 123,
      name: "Numeric ID target",
    });
  });

  it("resolves root folders by ID or exact path without guessing numeric paths", () => {
    expect(resolveLidarrRootFolderReference("2", rootFolders)).toEqual(rootFolders[0]);
    expect(resolveLidarrRootFolderReference("/music", rootFolders)).toEqual(rootFolders[0]);
    expect(resolveLidarrRootFolderReference("path:123", rootFolders)).toEqual(rootFolders[1]);
    expect(resolveLidarrRootFolderReference("123", rootFolders)).toEqual(rootFolders[2]);
    expect(() =>
      resolveLidarrRootFolderReference("/music", [
        ...rootFolders,
        { id: 8, path: "/music", accessible: true },
      ]),
    ).toThrow(/ambiguous root folder reference/iu);
  });

  it("resolves tag IDs and exact labels with the same syntax", () => {
    expect(resolveLidarrTagReference("4", tags)).toEqual({ id: 4, label: "Favorite" });
    expect(resolveLidarrTagReference(" road trip ", tags)).toEqual({
      id: 8,
      label: "Road Trip",
    });
  });

  it("rejects duplicate normalized names with bounded matching choices", () => {
    const ambiguous: readonly LidarrProfile[] = [
      { id: 3, name: "Lossless" },
      { id: 1, name: " lossless " },
    ];

    expect(() => resolveLidarrProfileReference("LOSSLESS", ambiguous)).toThrow(
      'Ambiguous profile reference "LOSSLESS". Matches:  lossless  (1), Lossless (3)',
    );
  });

  it("bounds unknown-reference choices and orders them by ID", () => {
    const manyTags = Array.from({ length: 12 }, (_, index) => ({
      id: 12 - index,
      label: `Tag ${12 - index}`,
    }));

    expect(() => resolveLidarrTagReference("missing", manyTags)).toThrow(
      "Tag 1 (1), Tag 2 (2), Tag 3 (3), Tag 4 (4), Tag 5 (5), Tag 6 (6), Tag 7 (7), Tag 8 (8), Tag 9 (9), Tag 10 (10), ...",
    );
    try {
      resolveLidarrTagReference("missing", manyTags);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).not.toContain("Tag 11 (11)");
        expect(error.message).not.toContain("Tag 12 (12)");
      }
    }
  });

  it("rejects every invalid or unknown reference class", () => {
    for (const reference of ["", "   ", "name:", "name:   ", "999999999999999999999999"]) {
      expect(() => resolveLidarrProfileReference(reference, profiles)).toThrow();
    }
  });
});

describe("tag-set algebra", () => {
  it("normalizes tag IDs without mutating the source", () => {
    const source = [3, 1, 2, 3];

    expect(normalizeLidarrTagIds(source)).toEqual([1, 2, 3]);
    expect(source).toEqual([3, 1, 2, 3]);
  });

  it("calculates every tag transition and its exact delta", () => {
    const cases = [
      [
        "add",
        [3, 1],
        [4, 2, 4],
        {
          before: [1, 3],
          after: [1, 2, 3, 4],
          added: [2, 4],
          removed: [],
          retained: [1, 3],
        },
      ],
      [
        "remove",
        [4, 2, 3, 1],
        [3, 9, 3],
        {
          before: [1, 2, 3, 4],
          after: [1, 2, 4],
          added: [],
          removed: [3],
          retained: [1, 2, 4],
        },
      ],
      [
        "set",
        [4, 2, 3, 1],
        [5, 2, 5],
        {
          before: [1, 2, 3, 4],
          after: [2, 5],
          added: [5],
          removed: [1, 3, 4],
          retained: [2],
        },
      ],
      [
        "clear",
        [4, 2, 3, 1],
        [],
        {
          before: [1, 2, 3, 4],
          after: [],
          added: [],
          removed: [1, 2, 3, 4],
          retained: [],
        },
      ],
    ] satisfies ReadonlyArray<
      readonly [
        LidarrTagMutationMode,
        readonly number[],
        readonly number[],
        {
          readonly before: readonly number[];
          readonly after: readonly number[];
          readonly added: readonly number[];
          readonly removed: readonly number[];
          readonly retained: readonly number[];
        },
      ]
    >;

    for (const [mode, before, requested, expected] of cases) {
      expect(calculateLidarrTagSetChange(before, mode, requested), mode).toEqual(expected);
    }
  });

  it("represents every no-op mode exactly", () => {
    const cases = [
      ["add", [1, 2], [2], [1, 2]],
      ["remove", [1, 2], [9], [1, 2]],
      ["set", [2, 1, 2], [1, 2], [1, 2]],
      ["clear", [], [], []],
    ] satisfies ReadonlyArray<
      readonly [LidarrTagMutationMode, readonly number[], readonly number[], readonly number[]]
    >;

    for (const [mode, before, requested, after] of cases) {
      const change = calculateLidarrTagSetChange(before, mode, requested);

      expect(change.after, mode).toEqual(after);
      expect(change.added, mode).toEqual([]);
      expect(change.removed, mode).toEqual([]);
      expect(change.retained, mode).toEqual(after);
    }
  });

  it("rejects tag values incompatible with each mutation mode", () => {
    const cases = [
      ["add", []],
      ["remove", []],
      ["set", []],
      ["clear", [1]],
    ] satisfies ReadonlyArray<readonly [LidarrTagMutationMode, readonly number[]]>;

    for (const [mode, requested] of cases) {
      expect(() => calculateLidarrTagSetChange([], mode, requested)).toThrow();
    }
  });

  it("rejects every invalid tag-ID class", () => {
    const cases = [
      ["zero", [0]],
      ["negative", [-1]],
      ["fraction", [1.5]],
      ["unsafe", [Number.MAX_SAFE_INTEGER + 1]],
    ] satisfies ReadonlyArray<readonly [string, readonly number[]]>;

    for (const [name, tagIds] of cases) {
      expect(() => normalizeLidarrTagIds(tagIds), name).toThrow("positive safe integer");
    }
  });
});
