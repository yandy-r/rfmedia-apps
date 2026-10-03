import { describe, expect, expectTypeOf, it } from "vitest";

import { createPlexResponseCache, type PlexCacheKey, type PlexResponseCache } from "./cache.js";

const librariesKey = { category: "libraries" } as const satisfies PlexCacheKey;
const playlistsKey = { category: "playlists" } as const satisfies PlexCacheKey;
const collectionOneKey = {
  category: "collections",
  discriminator: ["1"],
} as const satisfies PlexCacheKey;
const collectionTwoKey = {
  category: "collections",
  discriminator: ["2"],
} as const satisfies PlexCacheKey;

describe("createPlexResponseCache", () => {
  it("exposes a bounded category-based cache contract", () => {
    const cache = createPlexResponseCache({ enabled: true });

    expectTypeOf(cache).toEqualTypeOf<PlexResponseCache>();
    expectTypeOf<PlexCacheKey["category"]>().toEqualTypeOf<
      "identity" | "libraries" | "queries" | "playlists" | "collections"
    >();
  });

  it("does not store values while disabled", () => {
    const cache = createPlexResponseCache({ enabled: false, ttlSeconds: 60 });

    cache.set(librariesKey, [{ id: "music" }]);

    expect(cache.enabled).toBe(false);
    expect(cache.get(librariesKey)).toBeUndefined();
  });

  it("returns undefined for a cache miss and preserves generic result types", () => {
    const cache = createPlexResponseCache({ enabled: true });

    expect(cache.get(librariesKey)).toBeUndefined();

    const libraries = [{ id: "music", title: "Music" }] as const;
    cache.set(librariesKey, libraries);
    const result = cache.get<typeof libraries>(librariesKey);

    expect(result).toEqual(libraries);
    expectTypeOf(result).toEqualTypeOf<typeof libraries | undefined>();
  });

  it("uses the 300-second default TTL and keeps the boundary inclusive", () => {
    let now = 10_000;
    const cache = createPlexResponseCache({ enabled: true }, { now: () => now });
    cache.set(librariesKey, "value");

    now += 300_000;
    expect(cache.get<string>(librariesKey)).toBe("value");

    now += 1;
    expect(cache.get<string>(librariesKey)).toBeUndefined();
  });

  it("uses a captured custom TTL and removes expired entries lazily", () => {
    let now = 1_000;
    const settings: { enabled: boolean; ttlSeconds?: number } = {
      enabled: true,
      ttlSeconds: 2,
    };
    const cache = createPlexResponseCache(settings, { now: () => now });
    cache.set(playlistsKey, ["favorites"]);

    settings.enabled = false;
    settings.ttlSeconds = 600;
    now += 2_001;

    expect(cache.enabled).toBe(true);
    expect(cache.get(playlistsKey)).toBeUndefined();
    expect(cache.delete(playlistsKey)).toBe(false);
  });

  it("isolates entries between adapter lifecycles", () => {
    const firstCredentialCache = createPlexResponseCache({ enabled: true });
    const secondCredentialCache = createPlexResponseCache({ enabled: true });

    firstCredentialCache.set(librariesKey, ["private-library"]);

    expect(firstCredentialCache.get(librariesKey)).toEqual(["private-library"]);
    expect(secondCredentialCache.get(librariesKey)).toBeUndefined();
  });

  it("deletes an exact entry without invalidating its category", () => {
    const cache = createPlexResponseCache({ enabled: true });
    cache.set(collectionOneKey, "one");
    cache.set(collectionTwoKey, "two");

    expect(cache.delete(collectionOneKey)).toBe(true);
    expect(cache.get(collectionOneKey)).toBeUndefined();
    expect(cache.get(collectionTwoKey)).toBe("two");
  });

  it("invalidates every entry in one category only", () => {
    const cache = createPlexResponseCache({ enabled: true });
    cache.set(collectionOneKey, "one");
    cache.set(collectionTwoKey, "two");
    cache.set(playlistsKey, "playlist");

    expect(cache.invalidate("collections")).toBe(2);
    expect(cache.get(collectionOneKey)).toBeUndefined();
    expect(cache.get(collectionTwoKey)).toBeUndefined();
    expect(cache.get(playlistsKey)).toBe("playlist");
  });

  it("clears every category", () => {
    const cache = createPlexResponseCache({ enabled: true });
    cache.set(librariesKey, "library");
    cache.set(playlistsKey, "playlist");

    cache.clear();

    expect(cache.get(librariesKey)).toBeUndefined();
    expect(cache.get(playlistsKey)).toBeUndefined();
  });

  it.each([
    "https://plex.example.test/library?X-Plex-Token=secret",
    "X-Plex-Token: secret",
    "Authorization: Bearer secret",
    "token=secret",
  ])("rejects credential-bearing discriminator content: %s", (unsafePart) => {
    const cache = createPlexResponseCache({ enabled: true });
    const unsafeKey = {
      category: "queries",
      discriminator: [unsafePart],
    } as const satisfies PlexCacheKey;

    expect(() => cache.set(unsafeKey, "secret response")).toThrow(
      "Plex cache key cannot contain URLs or credential material",
    );
  });

  it("rejects oversized discriminator components", () => {
    const cache = createPlexResponseCache({ enabled: true });
    const oversizedKey = {
      category: "queries",
      discriminator: ["x".repeat(257)],
    } as const satisfies PlexCacheKey;

    expect(() => cache.set(oversizedKey, "value")).toThrow(
      "Plex cache key discriminator exceeds 256 characters",
    );
  });

  it("rejects keys with more than 16 discriminator components", () => {
    const cache = createPlexResponseCache({ enabled: true });
    const oversizedKey = {
      category: "queries",
      discriminator: Array.from({ length: 17 }, (_, index) => index),
    } as const satisfies PlexCacheKey;

    expect(() => cache.set(oversizedKey, "value")).toThrow(
      "Plex cache key cannot exceed 16 discriminator parts",
    );
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid TTL settings: %s",
    (ttlSeconds) => {
      expect(() => createPlexResponseCache({ enabled: true, ttlSeconds })).toThrow(
        "Plex cache TTL must be a positive integer",
      );
    },
  );
});
