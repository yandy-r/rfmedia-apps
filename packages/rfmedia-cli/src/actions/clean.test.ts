/**
 * Tests for clean action.
 *
 * Tests findEmptyAlbums (recursive depth-limited scanning),
 * findEmptyArtists (cascading parent cleanup), and executeClean
 * (orchestration) at various depth settings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { findEmptyAlbums, findEmptyArtists, executeClean } from "./clean.js";
import type { CleanOptions } from "../types/options.js";

// Mock the logger to suppress output during tests
vi.mock("../lib/logger.js", () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  formatDryRun: vi.fn((msg: string) => `[DRY-RUN] ${msg}`),
  isJsonMode: vi.fn(() => false),
}));

// Mock progress.js - runTasks must execute the task functions
vi.mock("../lib/progress.js", () => ({
  runTasks: vi.fn(
    async <T>(
      tasks: Array<{
        title: string;
        task: (ctx: T, task: { title: string }) => Promise<void>;
        skip?: (ctx: T) => string | boolean;
      }>,
      options: { ctx?: T } = {},
    ) => {
      const ctx = options.ctx as T;
      for (const t of tasks) {
        if (t.skip) {
          const skipResult = t.skip(ctx);
          if (skipResult !== false) continue;
        }
        await t.task(ctx, { title: t.title });
      }
    },
  ),
  withSpinner: vi.fn(async (_msg: string, fn: () => Promise<unknown>) => fn()),
}));

// Mock prompt to auto-confirm
vi.mock("../lib/prompt.js", () => ({
  confirm: vi.fn(() => true),
}));

// Mock history to avoid side effects
vi.mock("../lib/history.js", () => ({
  isHistoryEnabled: vi.fn(() => false),
  createHistorySession: vi.fn(),
}));

/**
 * Tree structure type for createDirStructure helper.
 *
 * Keys are directory/file names. Values are:
 * - null: create an empty directory
 * - string: create a file with that content
 * - object: create a directory and recurse into it
 */
type DirTree = {
  [name: string]: DirTree | string | null;
};

/**
 * Creates a directory/file structure from a tree-like object.
 *
 * @param basePath - Root directory to create structure in
 * @param structure - Tree describing directories and files
 */
async function createDirStructure(basePath: string, structure: DirTree): Promise<void> {
  for (const [name, value] of Object.entries(structure)) {
    const fullPath = path.join(basePath, name);

    if (value === null) {
      // Create empty directory
      await mkdir(fullPath, { recursive: true });
    } else if (typeof value === "string") {
      // Create file with content
      await writeFile(fullPath, value);
    } else {
      // Create directory and recurse
      await mkdir(fullPath, { recursive: true });
      await createDirStructure(fullPath, value);
    }
  }
}

/**
 * Helper to create CleanOptions with sensible defaults.
 */
function createOptions(overrides: Partial<CleanOptions> = {}): CleanOptions {
  return {
    force: true,
    dryRun: true,
    useTrash: false,
    ...overrides,
  };
}

/**
 * Normalizes paths in an array for consistent comparison.
 * Sorts the array so order does not matter.
 */
function sortedPaths(paths: string[]): string[] {
  return [...paths].sort();
}

describe("findEmptyAlbums with default depth (2)", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should detect empty album directories in standard Artist/Album structure", async () => {
    await createDirStructure(tempDir, {
      Artist1: {
        EmptyAlbum: null,
        AlbumWithMusic: {
          "track1.flac": "audio",
        },
      },
      Artist2: {
        EmptyAlbum2: null,
      },
    });

    const result = await findEmptyAlbums(tempDir);

    expect(sortedPaths(result)).toEqual(
      sortedPaths([
        path.join(tempDir, "Artist1", "EmptyAlbum"),
        path.join(tempDir, "Artist2", "EmptyAlbum2"),
      ]),
    );
  });

  it("should skip non-empty albums containing audio files", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        AlbumWithFlac: {
          "track.flac": "audio",
        },
        AlbumWithMp3: {
          "track.mp3": "audio",
        },
        AlbumWithM4a: {
          "track.m4a": "audio",
        },
      },
    });

    const result = await findEmptyAlbums(tempDir);

    expect(result).toHaveLength(0);
  });

  it("should exclude directories matching protection patterns", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        EmptyAlbum: null,
        ProtectedAlbum: null,
      },
    });

    const result = await findEmptyAlbums(tempDir, {
      exclude: ["*ProtectedAlbum*"],
    });

    expect(result).toEqual([path.join(tempDir, "Artist", "EmptyAlbum")]);
  });

  it("should preserve backward compatibility (depth=2 by default)", async () => {
    // With default depth=2, depth 3 directories should NOT be scanned as individual leaves
    // at depth 3. Instead, the structure Artist/Album is the leaf level.
    await createDirStructure(tempDir, {
      Artist: {
        Album: {
          SubDir: null, // This is at depth 3, but Album at depth 2 has no audio
        },
      },
    });

    const result = await findEmptyAlbums(tempDir);

    // Album at depth 2 has a subdirectory child (SubDir), but at depth 2 it is the leaf.
    // Since Album has no audio files directly, it should be detected as empty.
    expect(result).toEqual([path.join(tempDir, "Artist", "Album")]);
  });
});

describe("findEmptyAlbums with depth=1", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should only check immediate subdirectories of music dir", async () => {
    await createDirStructure(tempDir, {
      EmptyDir1: null,
      EmptyDir2: null,
      DirWithMusic: {
        "track.flac": "audio",
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 1 });

    expect(sortedPaths(result)).toEqual(
      sortedPaths([path.join(tempDir, "EmptyDir1"), path.join(tempDir, "EmptyDir2")]),
    );
  });

  it("should not detect deeper nested empty dirs at depth=1", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        EmptyAlbum: null,
        "track.mp3": "audio",
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 1 });

    // At depth=1, Artist is the leaf. Artist has audio file track.mp3, so it's not empty.
    expect(result).toHaveLength(0);
  });

  it("should detect empty directories at depth=1 even if they have empty subdirectories", async () => {
    await createDirStructure(tempDir, {
      EmptyParent: {
        EmptyChild: null,
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 1 });

    // At depth=1, EmptyParent is the leaf. It has no audio files, so it's empty.
    expect(result).toEqual([path.join(tempDir, "EmptyParent")]);
  });
});

describe("findEmptyAlbums with depth=3+", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should detect empty dirs at depth 3 in Genre/Artist/Album structure", async () => {
    await createDirStructure(tempDir, {
      Rock: {
        Artist1: {
          EmptyAlbum: null,
          AlbumWithMusic: {
            "track.flac": "audio",
          },
        },
      },
      Jazz: {
        Artist2: {
          EmptyAlbum2: null,
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 3 });

    expect(sortedPaths(result)).toEqual(
      sortedPaths([
        path.join(tempDir, "Rock", "Artist1", "EmptyAlbum"),
        path.join(tempDir, "Jazz", "Artist2", "EmptyAlbum2"),
      ]),
    );
  });

  it("should NOT detect dirs at depth 4 when depth=3", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist: {
          Album: {
            CD1: null, // Depth 4 -- should not be individually detected
          },
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 3 });

    // At depth 3, Album is the leaf. Album has no audio files, so it's empty.
    // CD1 at depth 4 is NOT scanned individually.
    expect(result).toEqual([path.join(tempDir, "Genre", "Artist", "Album")]);
  });

  it("should not detect dirs beyond depth limit as separate entries", async () => {
    await createDirStructure(tempDir, {
      L1: {
        L2: {
          L3: {
            L4: null,
          },
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 3 });

    // L3 at depth 3 is the leaf. It has no audio files. L4 is beyond the limit.
    expect(result).toEqual([path.join(tempDir, "L1", "L2", "L3")]);
  });
});

describe("findEmptyAlbums with depth=0 (unlimited)", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should detect deeply nested empty directories at various depths", async () => {
    await createDirStructure(tempDir, {
      L1: {
        L2: {
          L3: {
            L4: {
              L5: null,
            },
          },
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 0 });

    // With unlimited depth, the deepest leaf (L5) has no audio and no subdirectories
    expect(result).toEqual([path.join(tempDir, "L1", "L2", "L3", "L4", "L5")]);
  });

  it("should detect all empty leaves across different branches", async () => {
    await createDirStructure(tempDir, {
      A: {
        B: {
          EmptyLeaf1: null,
        },
      },
      C: {
        D: {
          E: {
            EmptyLeaf2: null,
          },
        },
      },
      F: {
        EmptyLeaf3: null,
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 0 });

    expect(sortedPaths(result)).toEqual(
      sortedPaths([
        path.join(tempDir, "A", "B", "EmptyLeaf1"),
        path.join(tempDir, "C", "D", "E", "EmptyLeaf2"),
        path.join(tempDir, "F", "EmptyLeaf3"),
      ]),
    );
  });

  it("should skip branches with audio files at leaf level", async () => {
    await createDirStructure(tempDir, {
      Deep: {
        Nested: {
          WithMusic: {
            "track.ogg": "audio",
          },
          WithoutMusic: null,
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 0 });

    expect(result).toEqual([path.join(tempDir, "Deep", "Nested", "WithoutMusic")]);
  });
});

describe("findEmptyArtists cascading parent cleanup", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should cascade single-level (artist becomes empty when all albums deleted)", async () => {
    await createDirStructure(tempDir, {
      Artist1: {
        EmptyAlbum1: null,
        EmptyAlbum2: null,
      },
    });

    const emptyAlbums = [
      path.join(tempDir, "Artist1", "EmptyAlbum1"),
      path.join(tempDir, "Artist1", "EmptyAlbum2"),
    ];

    const result = await findEmptyArtists(tempDir, emptyAlbums);

    expect(result).toEqual([path.join(tempDir, "Artist1")]);
  });

  it("should not cascade when parent has non-deleted children", async () => {
    await createDirStructure(tempDir, {
      Artist1: {
        EmptyAlbum: null,
        AlbumWithMusic: {
          "track.flac": "audio",
        },
      },
    });

    const emptyAlbums = [path.join(tempDir, "Artist1", "EmptyAlbum")];

    const result = await findEmptyArtists(tempDir, emptyAlbums);

    // Artist1 still has AlbumWithMusic, so it should NOT cascade
    expect(result).toHaveLength(0);
  });

  it("should cascade multi-level at depth=3+: leaf -> parent -> grandparent", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist: {
          EmptyAlbum1: null,
          EmptyAlbum2: null,
        },
      },
    });

    const emptyAlbums = [
      path.join(tempDir, "Genre", "Artist", "EmptyAlbum1"),
      path.join(tempDir, "Genre", "Artist", "EmptyAlbum2"),
    ];

    const result = await findEmptyArtists(tempDir, emptyAlbums);

    // Artist has all children deleted -> cascade to Artist
    // Genre has all children (Artist) deleted -> cascade to Genre
    expect(sortedPaths(result)).toEqual(
      sortedPaths([path.join(tempDir, "Genre", "Artist"), path.join(tempDir, "Genre")]),
    );
  });

  it("should stop cascading when a parent has mixed empty/non-empty children", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        ArtistEmpty: {
          EmptyAlbum: null,
        },
        ArtistWithMusic: {
          Album: {
            "track.flac": "audio",
          },
        },
      },
    });

    const emptyAlbums = [path.join(tempDir, "Genre", "ArtistEmpty", "EmptyAlbum")];

    const result = await findEmptyArtists(tempDir, emptyAlbums);

    // ArtistEmpty has all children deleted -> cascade
    // Genre has ArtistWithMusic remaining -> NO cascade
    expect(result).toEqual([path.join(tempDir, "Genre", "ArtistEmpty")]);
  });

  it("should respect protection patterns and block cascade", async () => {
    await createDirStructure(tempDir, {
      ProtectedArtist: {
        EmptyAlbum1: null,
        EmptyAlbum2: null,
      },
    });

    const emptyAlbums = [
      path.join(tempDir, "ProtectedArtist", "EmptyAlbum1"),
      path.join(tempDir, "ProtectedArtist", "EmptyAlbum2"),
    ];

    const result = await findEmptyArtists(tempDir, emptyAlbums, ["ProtectedArtist"]);

    // ProtectedArtist matches protection pattern, so no cascade
    expect(result).toHaveLength(0);
  });

  it("should handle empty emptyAlbums input", async () => {
    const result = await findEmptyArtists(tempDir, []);

    expect(result).toHaveLength(0);
  });

  it("should not cascade past the music directory root", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        EmptyAlbum: null,
      },
    });

    const emptyAlbums = [path.join(tempDir, "Artist", "EmptyAlbum")];

    const result = await findEmptyArtists(tempDir, emptyAlbums);

    // Artist cascades, but tempDir (musicDir) should never be added
    expect(result).toEqual([path.join(tempDir, "Artist")]);
    expect(result).not.toContain(tempDir);
  });
});

describe("executeClean edge cases", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should return empty result for non-existent music directory", async () => {
    const nonExistent = path.join(tempDir, "does-not-exist");
    const options = createOptions();

    const result = await executeClean(nonExistent, options);

    expect(result.albumsDeleted).toBe(0);
    expect(result.artistsDeleted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("ENOENT");
  });

  it("should return zero deletions for empty music directory (no subdirectories)", async () => {
    // tempDir exists but has no subdirectories
    const options = createOptions();

    const result = await executeClean(tempDir, options);

    expect(result.albumsDeleted).toBe(0);
    expect(result.artistsDeleted).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should treat directories with only non-audio files as empty", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        AlbumWithTextOnly: {
          "readme.txt": "not audio",
          "cover.jpg": "image data",
          "info.nfo": "nfo data",
        },
      },
    });

    const result = await findEmptyAlbums(tempDir);

    // Directory has no audio files, so it should be treated as empty
    expect(result).toEqual([path.join(tempDir, "Artist", "AlbumWithTextOnly")]);
  });

  it("should apply olderThan filter at various depths", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        EmptyAlbum: null,
      },
    });

    // olderThan filter only applies when there ARE audio files with mtime checks.
    // Empty dirs (no audio files) are always considered "old enough" to delete.
    const result = await findEmptyAlbums(tempDir, { olderThan: 30 });

    expect(result).toEqual([path.join(tempDir, "Artist", "EmptyAlbum")]);
  });

  it("should handle olderThan filter with depth=3", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist: {
          EmptyAlbum: null,
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { olderThan: 30, depth: 3 });

    expect(result).toEqual([path.join(tempDir, "Genre", "Artist", "EmptyAlbum")]);
  });

  it("should return dry-run counts without actually deleting", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        EmptyAlbum1: null,
        EmptyAlbum2: null,
      },
    });

    const options = createOptions({ dryRun: true });

    const result = await executeClean(tempDir, options);

    expect(result.albumsDeleted).toBe(2);
    expect(result.artistsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should work with depth option passed through executeClean", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist: {
          EmptyAlbum: null,
        },
      },
    });

    const options = createOptions({ dryRun: true, depth: 3 });

    const result = await executeClean(tempDir, options);

    expect(result.albumsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should work with depth=1 passed through executeClean", async () => {
    await createDirStructure(tempDir, {
      EmptyDir: null,
      DirWithMusic: {
        "track.flac": "audio",
      },
    });

    const options = createOptions({ dryRun: true, depth: 1 });

    const result = await executeClean(tempDir, options);

    expect(result.albumsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should support unlimited depth (depth=0) through executeClean", async () => {
    await createDirStructure(tempDir, {
      L1: {
        L2: {
          L3: {
            L4: {
              EmptyLeaf: null,
            },
          },
        },
      },
    });

    const options = createOptions({ dryRun: true, depth: 0 });

    const result = await executeClean(tempDir, options);

    expect(result.albumsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should handle multiple audio extensions correctly", async () => {
    // Verify that all common audio extensions prevent a directory from being considered empty
    const audioExtensions = [
      "flac",
      "wav",
      "mp3",
      "ogg",
      "opus",
      "m4a",
      "aac",
      "wma",
      "aiff",
      "ape",
      "wv",
      "alac",
    ];

    for (const ext of audioExtensions) {
      const artistDir = path.join(tempDir, `Artist-${ext}`);
      const albumDir = path.join(artistDir, "Album");
      await mkdir(albumDir, { recursive: true });
      await writeFile(path.join(albumDir, `track.${ext}`), "audio");
    }

    const result = await findEmptyAlbums(tempDir);

    // None of the albums should be detected as empty
    expect(result).toHaveLength(0);
  });
});

describe("findEmptyAlbums with protection patterns", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should exclude directories matching glob patterns at depth 2", async () => {
    await createDirStructure(tempDir, {
      Artist: {
        "Holiday Album": null,
        "Regular Album": null,
      },
    });

    const result = await findEmptyAlbums(tempDir, {
      exclude: ["*Holiday*"],
    });

    expect(result).toEqual([path.join(tempDir, "Artist", "Regular Album")]);
  });

  it("should exclude directories matching glob patterns at depth 3", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        "Various Artists": {
          Compilation: null,
        },
        "Regular Artist": {
          EmptyAlbum: null,
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, {
      depth: 3,
      exclude: ["Various Artists/**"],
    });

    expect(result).toEqual([path.join(tempDir, "Genre", "Regular Artist", "EmptyAlbum")]);
  });
});

describe("findEmptyAlbums interaction between depth and directory structure", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should detect a directory as empty leaf when it has subdirectories but is at max depth", async () => {
    await createDirStructure(tempDir, {
      Dir: {
        SubDir: {
          DeepDir: null,
        },
      },
    });

    // At depth=1, Dir is the leaf. It has no audio files, so it's empty.
    const result = await findEmptyAlbums(tempDir, { depth: 1 });
    expect(result).toEqual([path.join(tempDir, "Dir")]);
  });

  it("should find empty dirs at the exact depth boundary", async () => {
    await createDirStructure(tempDir, {
      A: {
        B: {
          C: null,
        },
      },
    });

    // At depth=2: A/B is the leaf. B has subdirectory C but we're at max depth, so B is checked.
    // B has no audio files -> empty.
    const result2 = await findEmptyAlbums(tempDir, { depth: 2 });
    expect(result2).toEqual([path.join(tempDir, "A", "B")]);

    // At depth=3: A/B/C is the leaf. C has no audio files -> empty.
    const result3 = await findEmptyAlbums(tempDir, { depth: 3 });
    expect(result3).toEqual([path.join(tempDir, "A", "B", "C")]);
  });

  it("should handle mixed depth scenarios with unlimited depth", async () => {
    await createDirStructure(tempDir, {
      ShallowEmpty: null,
      Deep: {
        Nested: {
          EmptyLeaf: null,
        },
        AlbumWithMusic: {
          "track.flac": "audio",
        },
      },
    });

    const result = await findEmptyAlbums(tempDir, { depth: 0 });

    expect(sortedPaths(result)).toEqual(
      sortedPaths([
        path.join(tempDir, "ShallowEmpty"),
        path.join(tempDir, "Deep", "Nested", "EmptyLeaf"),
      ]),
    );
  });
});

describe("executeClean with cascading at various depths", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(path.join(tmpdir(), "rfmedia-clean-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should cascade properly with depth=3 in dry-run mode", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist: {
          EmptyAlbum1: null,
          EmptyAlbum2: null,
        },
      },
    });

    const options = createOptions({ dryRun: true, depth: 3 });
    const result = await executeClean(tempDir, options);

    // 2 empty albums found, Genre and Artist cascade
    expect(result.albumsDeleted).toBe(2);
    expect(result.artistsDeleted).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("should not cascade when parent has remaining children with depth=3", async () => {
    await createDirStructure(tempDir, {
      Genre: {
        Artist1: {
          EmptyAlbum: null,
        },
        Artist2: {
          AlbumWithMusic: {
            "track.mp3": "audio",
          },
        },
      },
    });

    const options = createOptions({ dryRun: true, depth: 3 });
    const result = await executeClean(tempDir, options);

    // Only 1 empty album found, Artist1 cascades but Genre does not
    expect(result.albumsDeleted).toBe(1);
    expect(result.artistsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("should pass exclude patterns to both album and artist scanning", async () => {
    await createDirStructure(tempDir, {
      ProtectedArtist: {
        EmptyAlbum: null,
      },
      RegularArtist: {
        EmptyAlbum: null,
      },
    });

    const options = createOptions({
      dryRun: true,
      exclude: ["ProtectedArtist/**"],
    });
    const result = await executeClean(tempDir, options);

    // Only RegularArtist/EmptyAlbum found; RegularArtist cascades
    expect(result.albumsDeleted).toBe(1);
    expect(result.artistsDeleted).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
