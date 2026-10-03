import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioFileCandidateLimitError, findAudioFilesNoFollow } from "./audio.js";

describe("findAudioFilesNoFollow", () => {
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "rfmedia-audio-"));
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("finds nested audio files in stable order without following symbolic links", async () => {
    const sourceDirectory = join(testDirectory, "source");
    const nestedDirectory = join(sourceDirectory, "album");
    const externalDirectory = join(testDirectory, "external-album");
    const firstFile = join(nestedDirectory, "01-first.FLAC");
    const lastFile = join(sourceDirectory, "z-last.mp3");
    const externalFile = join(testDirectory, "external.mp3");
    const externalNestedFile = join(externalDirectory, "linked-track.ogg");

    await Promise.all([
      mkdir(nestedDirectory, { recursive: true }),
      mkdir(externalDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(firstFile, "first"),
      writeFile(lastFile, "last"),
      writeFile(externalFile, "linked file target"),
      writeFile(externalNestedFile, "linked directory target"),
      writeFile(join(nestedDirectory, "notes.txt"), "not audio"),
    ]);
    await Promise.all([
      symlink(externalFile, join(sourceDirectory, "linked-file.mp3")),
      symlink(externalDirectory, join(sourceDirectory, "linked-directory")),
    ]);

    const firstDiscovery = await findAudioFilesNoFollow(sourceDirectory);
    const secondDiscovery = await findAudioFilesNoFollow(sourceDirectory, 2);

    expect(firstDiscovery).toEqual([firstFile, lastFile]);
    expect(secondDiscovery).toEqual(firstDiscovery);
    await expect(findAudioFilesNoFollow(sourceDirectory, 1)).rejects.toBeInstanceOf(
      AudioFileCandidateLimitError,
    );
  });
});
