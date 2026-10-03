import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";

import { createLidarrAlbumFixture } from "../../actions/test-helpers/lidarr-fixtures.js";
import {
  LIDARR_ALBUM_TYPE_SELECTORS,
  matchesAlbumTypeSelectors,
  parseAlbumTypeSelectors,
  type LidarrAlbumTypeSelector,
} from "./album-types.js";

describe("parseAlbumTypeSelectors", () => {
  it("accepts every canonical token", () => {
    for (const selector of LIDARR_ALBUM_TYPE_SELECTORS) {
      expect(parseAlbumTypeSelectors(selector)).toEqual([selector]);
    }
  });

  it("maps every singular alias to its canonical token", () => {
    const aliases = [
      ["album", "albums"],
      ["ep", "eps"],
      ["single", "singles"],
      ["broadcast", "broadcasts"],
      ["other", "others"],
      ["compilation", "compilations"],
      ["remix", "remixes"],
      ["soundtrack", "soundtracks"],
      ["demo", "demos"],
      ["mixtape", "mixtapes"],
    ] as const;
    for (const [alias, canonical] of aliases) {
      expect(parseAlbumTypeSelectors(alias), alias).toEqual([canonical]);
    }
  });

  it("normalizes case and whitespace while preserving live as its own token", () => {
    expect(parseAlbumTypeSelectors("live")).toEqual(["live"]);
    expect(parseAlbumTypeSelectors(" SiNgLeS , EP ")).toEqual(["eps", "singles"]);
  });

  it("returns a frozen, canonically sorted array", () => {
    const selectors = parseAlbumTypeSelectors("soundtracks,eps,albums");
    expect(selectors).toEqual(["albums", "eps", "soundtracks"]);
    expect(Object.isFrozen(selectors)).toBe(true);
  });

  it("rejects an unknown token with the full allowlist named", () => {
    let caught: unknown;
    try {
      parseAlbumTypeSelectors("singles,vinyls");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError);
    expect((caught as Error).message).toContain("vinyls");
    for (const selector of LIDARR_ALBUM_TYPE_SELECTORS) {
      expect((caught as Error).message).toContain(selector);
    }
  });

  it("rejects every form of an empty token", () => {
    for (const raw of ["", " , ", "singles,"]) {
      expect(() => parseAlbumTypeSelectors(raw), JSON.stringify(raw)).toThrow(InvalidArgumentError);
    }
  });

  it("rejects exact and alias-colliding duplicate selectors", () => {
    expect(() => parseAlbumTypeSelectors("singles,singles")).toThrow(InvalidArgumentError);
    expect(() => parseAlbumTypeSelectors("singles,singles")).toThrow(
      "Duplicate album type selector 'singles'",
    );
    expect(() => parseAlbumTypeSelectors("single,singles")).toThrow(InvalidArgumentError);
    expect(() => parseAlbumTypeSelectors("ep,EPs")).toThrow("Duplicate album type selector 'eps'");
  });
});

describe("matchesAlbumTypeSelectors", () => {
  it("matches every primary selector against albumType", () => {
    const cases = [
      ["albums", "Album"],
      ["eps", "EP"],
      ["singles", "Single"],
      ["broadcasts", "Broadcast"],
      ["others", "Other"],
    ] as const;
    for (const [selector, albumType] of cases) {
      const album = createLidarrAlbumFixture({ albumType, secondaryTypes: [] });
      expect(matchesAlbumTypeSelectors(album, [selector]), selector).toBe(true);
    }
  });

  it("matches every secondary selector only against secondaryTypes membership", () => {
    const cases = [
      ["compilations", "Compilation"],
      ["live", "Live"],
      ["remixes", "Remix"],
      ["soundtracks", "Soundtrack"],
      ["demos", "Demo"],
      ["mixtapes", "Mixtape"],
    ] as const;
    for (const [selector, secondaryType] of cases) {
      const album = createLidarrAlbumFixture({
        albumType: "Album",
        secondaryTypes: [secondaryType],
      });
      expect(matchesAlbumTypeSelectors(album, [selector]), selector).toBe(true);
      expect(matchesAlbumTypeSelectors(album, ["eps"]), selector).toBe(false);
    }
  });

  it("matches primary and secondary names case-insensitively", () => {
    expect(
      matchesAlbumTypeSelectors({ albumType: "sInGlE", secondaryTypes: [] }, ["singles"]),
    ).toBe(true);
    expect(
      matchesAlbumTypeSelectors({ albumType: "Album", secondaryTypes: ["LIVE"] }, ["live"]),
    ).toBe(true);
  });

  it("keeps primary and secondary selector namespaces separate", () => {
    const album = { albumType: "Album", secondaryTypes: ["Single"] };
    expect(matchesAlbumTypeSelectors(album, ["singles"])).toBe(false);
    expect(matchesAlbumTypeSelectors({ albumType: "Live", secondaryTypes: [] }, ["live"])).toBe(
      false,
    );
  });

  it("ORs multiple selectors", () => {
    const single = createLidarrAlbumFixture({ albumType: "Single", secondaryTypes: [] });
    const liveAlbum = createLidarrAlbumFixture({
      albumType: "Album",
      secondaryTypes: ["Live"],
    });
    const selectors: readonly LidarrAlbumTypeSelector[] = ["live", "singles"];
    expect(matchesAlbumTypeSelectors(single, selectors)).toBe(true);
    expect(matchesAlbumTypeSelectors(liveAlbum, selectors)).toBe(true);
    expect(matchesAlbumTypeSelectors(single, ["compilations", "eps"])).toBe(false);
  });

  it("matches nothing when album metadata or selectors are empty", () => {
    for (const selector of LIDARR_ALBUM_TYPE_SELECTORS) {
      expect(matchesAlbumTypeSelectors({ secondaryTypes: [] }, [selector]), selector).toBe(false);
    }
    expect(matchesAlbumTypeSelectors(createLidarrAlbumFixture(), [])).toBe(false);
  });
});
