/**
 * Unit tests for Plex filter type guards in plex-filters.ts.
 *
 * Tests cover:
 * - isPlexFilterRule() type guard
 * - isPlexFilterGroup() type guard
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import { isMediaFilterGroup, isMediaFilterRule } from "./media-filters.js";
import { isPlexFilterRule, isPlexFilterGroup } from "./plex-filters.js";
import type {
  MediaFilter,
  MediaFilterGroup,
  MediaFilterNode,
  MediaFilterRule,
} from "./media-filters.js";
import type { MediaAlbum, MediaArtist, MediaKind, MediaTrack } from "./media-server.js";
import type {
  MediaFilter as PublicMediaFilter,
  MediaPage as PublicMediaPage,
  MediaTrack as PublicMediaTrack,
} from "./index.js";
import type { PlexAlbum, PlexArtist, PlexMediaType, PlexTrack } from "./plex.js";
import type {
  PlexFilterGroup,
  PlexFilterRule,
  PlexSmartFilter,
  PlexSmartFilterRule,
} from "./plex-filters.js";

// ============================================================================
// PUBLIC COMPATIBILITY CONTRACT
// ============================================================================

describe("Plex compatibility contract", () => {
  it("uses the generic media-kind vocabulary", () => {
    expectTypeOf<PlexMediaType>().toEqualTypeOf<MediaKind>();

    const kinds = ["track", "album", "artist"] as const satisfies readonly PlexMediaType[];
    expect(kinds).toEqual(["track", "album", "artist"]);
  });

  it("projects opaque IDs and normalized ratings to the established Plex fields", () => {
    const genericTrack: MediaTrack = {
      id: "track-opaque-id",
      kind: "track",
      title: "Track",
      rating: 0.8,
      artist: "Artist",
      album: "Album",
      playCount: 3,
      durationMs: 180_000,
      filePath: "/music/track.flac",
    };
    const plexTrack: PlexTrack = {
      ratingKey: "track-opaque-id",
      title: "Track",
      userRating: 8,
      artist: "Artist",
      album: "Album",
      viewCount: 3,
      duration: 180_000,
      filePath: "/music/track.flac",
    };

    const genericAlbum: MediaAlbum = {
      id: "album-opaque-id",
      kind: "album",
      title: "Album",
      rating: 0.5,
      artist: "Artist",
      trackCount: 10,
    };
    const plexAlbum: PlexAlbum = {
      ratingKey: "album-opaque-id",
      title: "Album",
      userRating: 5,
      artist: "Artist",
      trackCount: 10,
    };

    const genericArtist: MediaArtist = {
      id: "artist-opaque-id",
      kind: "artist",
      title: "Artist",
      rating: null,
      albumCount: 2,
    };
    const plexArtist: PlexArtist = {
      ratingKey: "artist-opaque-id",
      title: "Artist",
      userRating: 0,
      albumCount: 2,
    };

    expect(genericTrack.kind).toBe("track");
    expect(genericTrack.id).toBe(plexTrack.ratingKey);
    expect(genericTrack.rating).toBe(0.8);
    expect(plexTrack.userRating).toBe(8);

    expect(genericAlbum.kind).toBe("album");
    expect(genericAlbum.id).toBe(plexAlbum.ratingKey);
    expect(genericAlbum.rating).toBe(0.5);
    expect(plexAlbum.userRating).toBe(5);

    expect(genericArtist.kind).toBe("artist");
    expect(genericArtist.id).toBe(plexArtist.ratingKey);
    expect(genericArtist.rating).toBeNull();
    expect(plexArtist.userRating).toBe(0);

    expectTypeOf<PlexTrack["ratingKey"]>().toEqualTypeOf<MediaTrack["id"]>();
    expectTypeOf<PlexAlbum["ratingKey"]>().toEqualTypeOf<MediaAlbum["id"]>();
    expectTypeOf<PlexArtist["ratingKey"]>().toEqualTypeOf<MediaArtist["id"]>();
    expectTypeOf<PlexTrack["userRating"]>().toEqualTypeOf<number>();
  });

  it("exports the generic contract and filter vocabulary from the public barrel", () => {
    expectTypeOf<PublicMediaTrack>().toEqualTypeOf<MediaTrack>();
    expectTypeOf<PublicMediaPage<MediaTrack>["items"]>().toEqualTypeOf<readonly MediaTrack[]>();
    expectTypeOf<PublicMediaFilter>().toEqualTypeOf<MediaFilter>();
  });
});

describe("deprecated Plex filter aliases", () => {
  it("are exact aliases of the generic filter vocabulary", () => {
    expectTypeOf<PlexFilterRule>().toEqualTypeOf<MediaFilterRule>();
    expectTypeOf<PlexFilterGroup>().toEqualTypeOf<MediaFilterGroup>();
    expectTypeOf<PlexSmartFilterRule>().toEqualTypeOf<MediaFilterNode>();
    expectTypeOf<PlexSmartFilter>().toEqualTypeOf<MediaFilter>();
  });

  it("delegate to the same generic type guards", () => {
    expect(isPlexFilterRule).toBe(isMediaFilterRule);
    expect(isPlexFilterGroup).toBe(isMediaFilterGroup);
  });
});

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Creates a PlexFilterRule for testing.
 */
function createRule(
  field: PlexFilterRule["field"],
  operator: PlexFilterRule["operator"],
  value: string | number,
): PlexFilterRule {
  return { type: "rule", field, operator, value };
}

/**
 * Creates a PlexFilterGroup for testing.
 */
function createGroup(match: "all" | "any", rules: PlexSmartFilterRule[]): PlexFilterGroup {
  return { type: "group", match, rules };
}

// ============================================================================
// isPlexFilterRule TESTS
// ============================================================================

describe("isPlexFilterRule", () => {
  describe("returns true for rule objects", () => {
    it("should return true for rating rule", () => {
      const rule = createRule("artistRating", ">=", 4);
      expect(isPlexFilterRule(rule)).toBe(true);
    });

    it("should return true for genre rule", () => {
      const rule = createRule("genre", "contains", "Rock");
      expect(isPlexFilterRule(rule)).toBe(true);
    });

    it("should return true for year rule", () => {
      const rule = createRule("year", "==", 2020);
      expect(isPlexFilterRule(rule)).toBe(true);
    });

    it("should return true for text field rule", () => {
      const rule = createRule("artist", "contains", "Beatles");
      expect(isPlexFilterRule(rule)).toBe(true);
    });

    it("should return true for minPlays rule", () => {
      const rule = createRule("minPlays", ">=", 10);
      expect(isPlexFilterRule(rule)).toBe(true);
    });
  });

  describe("returns false for group objects", () => {
    it("should return false for empty group", () => {
      const group = createGroup("all", []);
      expect(isPlexFilterRule(group)).toBe(false);
    });

    it("should return false for group with single rule", () => {
      const rule = createRule("artistRating", ">=", 4);
      const group = createGroup("all", [rule]);
      expect(isPlexFilterRule(group)).toBe(false);
    });

    it("should return false for group with multiple rules", () => {
      const rules = [createRule("artistRating", ">=", 4), createRule("genre", "contains", "Rock")];
      const group = createGroup("any", rules);
      expect(isPlexFilterRule(group)).toBe(false);
    });

    it("should return false for nested group", () => {
      const innerGroup = createGroup("any", [
        createRule("genre", "contains", "Rock"),
        createRule("genre", "contains", "Alternative"),
      ]);
      const outerGroup = createGroup("all", [createRule("artistRating", ">=", 4), innerGroup]);
      expect(isPlexFilterRule(outerGroup)).toBe(false);
    });
  });
});

// ============================================================================
// isPlexFilterGroup TESTS
// ============================================================================

describe("isPlexFilterGroup", () => {
  describe("returns true for group objects", () => {
    it("should return true for empty group", () => {
      const group = createGroup("all", []);
      expect(isPlexFilterGroup(group)).toBe(true);
    });

    it("should return true for group with single rule", () => {
      const rule = createRule("artistRating", ">=", 4);
      const group = createGroup("all", [rule]);
      expect(isPlexFilterGroup(group)).toBe(true);
    });

    it("should return true for group with match: all", () => {
      const rules = [createRule("artistRating", ">=", 4), createRule("genre", "contains", "Rock")];
      const group = createGroup("all", rules);
      expect(isPlexFilterGroup(group)).toBe(true);
    });

    it("should return true for group with match: any", () => {
      const rules = [
        createRule("genre", "contains", "Rock"),
        createRule("genre", "contains", "Alternative"),
      ];
      const group = createGroup("any", rules);
      expect(isPlexFilterGroup(group)).toBe(true);
    });

    it("should return true for nested group", () => {
      const innerGroup = createGroup("any", [
        createRule("genre", "contains", "Rock"),
        createRule("genre", "contains", "Alternative"),
      ]);
      const outerGroup = createGroup("all", [createRule("artistRating", ">=", 4), innerGroup]);
      expect(isPlexFilterGroup(outerGroup)).toBe(true);
    });
  });

  describe("returns false for rule objects", () => {
    it("should return false for rating rule", () => {
      const rule = createRule("artistRating", ">=", 4);
      expect(isPlexFilterGroup(rule)).toBe(false);
    });

    it("should return false for genre rule", () => {
      const rule = createRule("genre", "contains", "Rock");
      expect(isPlexFilterGroup(rule)).toBe(false);
    });

    it("should return false for year rule", () => {
      const rule = createRule("year", "==", 2020);
      expect(isPlexFilterGroup(rule)).toBe(false);
    });

    it("should return false for text field rule", () => {
      const rule = createRule("artist", "contains", "Beatles");
      expect(isPlexFilterGroup(rule)).toBe(false);
    });

    it("should return false for minPlays rule", () => {
      const rule = createRule("minPlays", ">=", 10);
      expect(isPlexFilterGroup(rule)).toBe(false);
    });
  });
});
