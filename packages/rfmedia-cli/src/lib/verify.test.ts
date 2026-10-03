import path from "node:path";

import { describe, expect, it } from "vitest";

import { allocateUniqueDestinationPaths, getExpectedDestFilename } from "./verify.js";

describe("allocateUniqueDestinationPaths", () => {
  it("adds stable numeric suffixes to duplicate basenames", () => {
    const destinationPaths = [
      "/destination/track.flac",
      "/destination/track.flac",
      "/destination/track.flac",
    ];

    expect(allocateUniqueDestinationPaths(destinationPaths)).toEqual([
      "/destination/track.flac",
      "/destination/track-002.flac",
      "/destination/track-003.flac",
    ]);
  });

  it("matches duplicate basenames case-insensitively while preserving input casing", () => {
    expect(
      allocateUniqueDestinationPaths([
        "/destination/Track.FLAC",
        "/destination/track.flac",
        "/destination/TRACK.FlAc",
      ]),
    ).toEqual([
      "/destination/Track.FLAC",
      "/destination/track-002.flac",
      "/destination/TRACK-003.FlAc",
    ]);
  });

  it("places duplicate suffixes before converted extensions", () => {
    const destinationPaths = [
      "/source/one/Song.flac",
      "/source/two/song.wav",
      "/source/three/SONG.mp3",
    ].map((sourcePath) => path.join("/destination", getExpectedDestFilename(sourcePath, "alac")));

    expect(allocateUniqueDestinationPaths(destinationPaths)).toEqual([
      "/destination/Song.m4a",
      "/destination/song-002.m4a",
      "/destination/SONG-003.m4a",
    ]);
  });

  it("tracks duplicate basenames separately for each destination directory", () => {
    expect(
      allocateUniqueDestinationPaths([
        "/destination/one/track.flac",
        "/destination/two/TRACK.flac",
        "/destination/one/Track.flac",
        "/destination/two/track.flac",
      ]),
    ).toEqual([
      "/destination/one/track.flac",
      "/destination/two/TRACK.flac",
      "/destination/one/Track-002.flac",
      "/destination/two/track-002.flac",
    ]);
  });

  it("suffixes a naturally numbered input when an earlier allocation already uses its name", () => {
    expect(
      allocateUniqueDestinationPaths([
        "/destination/track.flac",
        "/destination/track.flac",
        "/destination/TRACK-002.flac",
      ]),
    ).toEqual([
      "/destination/track.flac",
      "/destination/track-002.flac",
      "/destination/TRACK-002-002.flac",
    ]);
  });

  it("skips generated suffixes that collide with an earlier natural name", () => {
    expect(
      allocateUniqueDestinationPaths([
        "/destination/track.flac",
        "/destination/TRACK-002.FLAC",
        "/destination/Track.flac",
        "/destination/track.flac",
      ]),
    ).toEqual([
      "/destination/track.flac",
      "/destination/TRACK-002.FLAC",
      "/destination/Track-003.flac",
      "/destination/track-004.flac",
    ]);
  });

  it("is pure and deterministic for the same ordered input", () => {
    const destinationPaths = [
      "/destination/b.flac",
      "/destination/a.flac",
      "/destination/B.flac",
      "/destination/A.flac",
    ];
    const originalInput = [...destinationPaths];

    const first = allocateUniqueDestinationPaths(destinationPaths);
    const second = allocateUniqueDestinationPaths(destinationPaths);

    expect(first).toEqual([
      "/destination/b.flac",
      "/destination/a.flac",
      "/destination/B-002.flac",
      "/destination/A-002.flac",
    ]);
    expect(second).toEqual(first);
    expect(destinationPaths).toEqual(originalInput);
  });
});
