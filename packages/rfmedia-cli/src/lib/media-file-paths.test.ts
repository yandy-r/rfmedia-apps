import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  extractMediaFilePaths,
  type MediaFilePathSource,
  type SavedMediaFilePathRow,
} from "./media-file-paths.js";
import type { MediaTrack } from "../types/media-server.js";

const temporaryDirectories: string[] = [];

function createTrack(filePath: string): MediaTrack {
  return {
    id: `track:${filePath}`,
    kind: "track",
    title: "Track",
    rating: null,
    artist: "Artist",
    album: "Album",
    playCount: 0,
    durationMs: 180_000,
    filePath,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("extractMediaFilePaths", () => {
  it("extracts live and saved paths while ignoring absent saved paths", async () => {
    const liveTrack = createTrack("/music/live.flac");
    const savedRows = [
      { file_path: "/music/saved.flac" },
      { file_path: null },
      { file_path: "" },
    ] as const satisfies readonly SavedMediaFilePathRow[];
    const sources: readonly MediaFilePathSource[] = [liveTrack, ...savedRows, liveTrack];

    await expect(extractMediaFilePaths(sources)).resolves.toEqual({
      valid: ["/music/live.flac", "/music/saved.flac", "/music/live.flac"],
      missing: [],
    });

    expectTypeOf(savedRows).toMatchTypeOf<readonly SavedMediaFilePathRow[]>();
  });

  it("does not require paths to exist unless validation is requested", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfmedia-media-paths-test-"));
    temporaryDirectories.push(directory);
    const missingPath = join(directory, "missing.flac");

    await expect(extractMediaFilePaths([createTrack(missingPath)])).resolves.toEqual({
      valid: [missingPath],
      missing: [],
    });
  });

  it("partitions existing and missing paths in their original order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rfmedia-media-paths-test-"));
    temporaryDirectories.push(directory);
    const existingFirst = join(directory, "first.flac");
    const missing = join(directory, "missing.flac");
    const existingSecond = join(directory, "second.flac");
    await Promise.all([writeFile(existingFirst, "first"), writeFile(existingSecond, "second")]);

    const sources: readonly MediaFilePathSource[] = [
      createTrack(existingFirst),
      { file_path: missing },
      { file_path: existingSecond },
    ];

    await expect(extractMediaFilePaths(sources, { validateExistence: true })).resolves.toEqual({
      valid: [existingFirst, existingSecond],
      missing: [missing],
    });
  });

  it("returns empty partitions for empty input", async () => {
    await expect(extractMediaFilePaths([])).resolves.toEqual({ valid: [], missing: [] });
  });
});
