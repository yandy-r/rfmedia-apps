/**
 * Unit tests for YAML paths file parsing.
 *
 * Tests cover:
 * - Valid YAML files with destination and sources
 * - Source entries with count, range, or neither
 * - Validation errors for missing/invalid fields
 * - Edge cases (empty sources, metadata fields, file read errors)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePathsYaml,
  loadAndValidatePathsYaml,
  PathsYamlError,
  filterSourcesBySelection,
  SourceSelectionError,
} from "./paths-yaml.js";
import { LookupNotFoundError } from "./errors.js";
import { FfmpegNotFoundError } from "./convert.js";

// Mock the logger to avoid console output during tests
vi.mock("./logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const mockLoadedConfig = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({ filters: {} }),
}));

const mockConvert = vi.hoisted(() => ({
  requireFfmpeg: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./loaded-config.js", () => mockLoadedConfig);
vi.mock("./convert.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./convert.js")>();
  return {
    ...actual,
    requireFfmpeg: mockConvert.requireFfmpeg,
  };
});

import type { PathEntry } from "../types/index.js";

/**
 * Helper to check that sources match expected values, ignoring selection fields.
 * This allows tests to focus on parsing logic without being affected by
 * sourceNames, sourceGroups, sourceArtist, and sourceIndex fields.
 */
function expectSourcesToMatch(actual: PathEntry[], expected: Array<Partial<PathEntry>>) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toMatchObject(expected[i]!);
  }
}

describe("paths-yaml: YAML file parsing", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadedConfig.getLoadedConfig.mockReturnValue({ filters: {} });
    mockConvert.requireFfmpeg.mockResolvedValue(undefined);

    // Create isolated temp directory for each test
    tempDir = await mkdtemp(join(tmpdir(), "paths-yaml-test-"));
  });

  afterEach(async () => {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("valid YAML files", () => {
    it("should parse basic YAML with destination and sources", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /data/media/music-manual
sources:
  - path: /data/media/music/Artist1
  - path: /data/media/music/Artist2
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.destination).toBe("/data/media/music-manual");
      expectSourcesToMatch(result.sources, [
        { path: "/data/media/music/Artist1" },
        { path: "/data/media/music/Artist2" },
      ]);
    });

    it("should parse sources with count", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    count: 5
  - path: /music/Artist2
    count: 10
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", count: 5 },
        { path: "/music/Artist2", count: 10 },
      ]);
    });

    it("should parse sources with range", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    range: 001-005
  - path: /music/Artist2
    range: 01-10
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", range: { start: 1, end: 5, padWidth: 3 } },
        { path: "/music/Artist2", range: { start: 1, end: 10, padWidth: 2 } },
      ]);
    });

    it("should parse mixed sources (count, range, and neither)", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    count: 3
  - path: /music/Artist2
    range: 001-010
  - path: /music/Artist3
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", count: 3 },
        { path: "/music/Artist2", range: { start: 1, end: 10, padWidth: 3 } },
        { path: "/music/Artist3" },
      ]);
    });

    it("should preserve metadata fields (artist, type, media)", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    artist: Artist Name
    type: directory
    media: music
    count: 5
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      // Metadata fields (artist) are now used for selection, not passed through
      // but the parser should not reject them
      expectSourcesToMatch(result.sources, [{ path: "/music/Artist1", count: 5 }]);
      // Verify artist is stored for selection
      expect(result.sources[0]?.sourceArtist).toBe("Artist Name");
    });

    it("should handle paths with special characters", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist (2024)/Album, Vol. 2
    count: 3
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist (2024)/Album, Vol. 2", count: 3 },
      ]);
    });

    it("should handle paths with UUIDs", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /data/media/music-manual
sources:
  - path: /data/media/music/Britney Spears (45a663b5-b1cb-4a91-bff6-2bef7bbfdd76)
    count: 3
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.sources[0]?.path).toBe(
        "/data/media/music/Britney Spears (45a663b5-b1cb-4a91-bff6-2bef7bbfdd76)",
      );
    });
  });

  describe("validation errors", () => {
    it("should throw error for missing destination", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Missing required field 'destination' in paths file",
      );
    });

    it("should throw error for missing sources", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(testFile, `destination: /output\n`, "utf-8");

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Missing required field 'sources' in paths file",
      );
    });

    it("should throw error for empty sources array", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources: []
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Sources array cannot be empty in paths file",
      );
    });

    it("should throw error for source missing path field", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - count: 5
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Source at index 0 missing required field 'path'",
      );
    });

    it("should throw error for source with both count and range", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    count: 5
    range: 001-010
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Source at index 0 has both 'count' and 'range' - use only one",
      );
    });

    it("should throw error for invalid count (non-positive)", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    count: 0
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected positive integer for 'sources[0].count'",
      );
    });

    it("should throw error for invalid range format", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    range: invalid
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Invalid range format at source index 0",
      );
    });

    it("should throw error for invalid range (start > end)", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    range: 010-001
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Failed to parse range at source index 0",
      );
    });

    it("should throw error for sources as non-array", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources: not-an-array
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Field 'sources' must be an array");
    });

    it("should throw error for empty destination", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: ""
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected non-empty string for 'destination'",
      );
    });

    it("should throw error for empty path in source", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: ""
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected non-empty string for 'sources[0].path'",
      );
    });
  });

  describe("file handling", () => {
    it("should throw error for non-existent file", async () => {
      const testFile = join(tempDir, "nonexistent.yml");

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Failed to read paths file");
    });

    it("should throw error for invalid YAML syntax", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(testFile, `destination: /output\n  invalid yaml::\n`, "utf-8");

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Invalid YAML syntax");
    });

    it("should throw error for non-object YAML content", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(testFile, `- just an array\n`, "utf-8");

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Paths file must be a YAML object");
    });
  });

  describe("edge cases", () => {
    it("should handle single source", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0]?.path).toBe("/music/Artist1");
    });

    it("should handle many sources", async () => {
      const testFile = join(tempDir, "paths.yml");
      const sources = Array.from({ length: 100 }, (_, i) => `  - path: /music/Artist${i}`).join(
        "\n",
      );
      await writeFile(testFile, `destination: /output\nsources:\n${sources}\n`, "utf-8");

      const result = await parsePathsYaml(testFile);

      expect(result.sources).toHaveLength(100);
      expect(result.sources[99]?.path).toBe("/music/Artist99");
    });

    it("should trim whitespace from destination and paths", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: "  /output  "
sources:
  - path: "  /music/Artist1  "
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.destination).toBe("/output");
      expect(result.sources[0]?.path).toBe("/music/Artist1");
    });

    it("should handle source as non-object in array", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - just a string
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Source at index 0 must be an object");
    });

    it("should ignore extra fields in source object", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    unknownField: some value
    anotherField: 123
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [{ path: "/music/Artist1" }]);
    });
  });

  describe("real-world example", () => {
    it("should parse the example from examples/paths.yml", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /data/media/music-manual
sources:
  - media: music
    type: directory
    path: /data/media/music
    count: 5
  - artist: Paulina Rubio
    type: directory
    media: music
    path: /data/media/music/Paulina Rubio (5938c629-1d06-480b-9780-859b153af11e)
    count: 20
  - artist: Britney Spears
    type: directory
    media: music
    path: /data/media/music/Britney Spears (45a663b5-b1cb-4a91-bff6-2bef7bbfdd76)
    count: 3
  - artist: Mariah Carey
    type: directory
    media: music
    path: /data/media/music/Mariah Carey (494e8d09-f85b-4543-892f-a5096aed1cd4)
    range: 001-003
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.destination).toBe("/data/media/music-manual");
      expect(result.sources).toHaveLength(4);
      expect(result.sources[0]).toMatchObject({ path: "/data/media/music", count: 5 });
      expect(result.sources[1]).toMatchObject({
        path: "/data/media/music/Paulina Rubio (5938c629-1d06-480b-9780-859b153af11e)",
        count: 20,
      });
      expect(result.sources[2]).toMatchObject({
        path: "/data/media/music/Britney Spears (45a663b5-b1cb-4a91-bff6-2bef7bbfdd76)",
        count: 3,
      });
      expect(result.sources[3]).toMatchObject({
        path: "/data/media/music/Mariah Carey (494e8d09-f85b-4543-892f-a5096aed1cd4)",
        range: { start: 1, end: 3, padWidth: 3 },
      });
    });
  });

  describe("defaults section", () => {
    it("should parse defaults and apply to all sources", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  filter: liked
  count: 5
  outputFolder: liked-songs
sources:
  - path: /music/Artist1
  - path: /music/Artist2
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", count: 5, filterName: "liked", outputFolder: "liked-songs" },
        { path: "/music/Artist2", count: 5, filterName: "liked", outputFolder: "liked-songs" },
      ]);
    });

    it("should parse defaults with range", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  range: 001-010
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", range: { start: 1, end: 10, padWidth: 3 } },
      ]);
    });

    it("should parse defaults with convert format", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  convert: mp3
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [{ path: "/music/Artist1", convertFormat: "mp3" }]);
    });

    it("should allow per-source values to override defaults", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  filter: liked
  count: 5
  outputFolder: liked-songs
  convert: mp3
sources:
  - path: /music/Artist1
  - path: /music/Artist2
    filter: rock-classics
  - path: /music/Artist3
    count: 10
    filter: female-pop
    outputFolder: female-pop-artists
    convert: alac
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        // Uses all defaults
        {
          path: "/music/Artist1",
          count: 5,
          filterName: "liked",
          outputFolder: "liked-songs",
          convertFormat: "mp3",
        },
        // Override filter only
        {
          path: "/music/Artist2",
          count: 5,
          filterName: "rock-classics",
          outputFolder: "liked-songs",
          convertFormat: "mp3",
        },
        // Full override
        {
          path: "/music/Artist3",
          count: 10,
          filterName: "female-pop",
          outputFolder: "female-pop-artists",
          convertFormat: "alac",
        },
      ]);
    });

    it("should work with empty defaults section", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults: {}
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [{ path: "/music/Artist1" }]);
    });

    it("should allow per-source range to override default count", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  count: 5
sources:
  - path: /music/Artist1
  - path: /music/Artist2
    range: 001-020
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", count: 5 },
        { path: "/music/Artist2", range: { start: 1, end: 20, padWidth: 3 } },
      ]);
    });
  });

  describe("defaults validation errors", () => {
    it("should throw error for defaults with both count and range", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  count: 5
  range: 001-010
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Defaults section has both 'count' and 'range' - use only one",
      );
    });

    it("should throw error for invalid count in defaults", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  count: -1
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected positive integer for 'defaults.count'",
      );
    });

    it("should throw error for invalid range format in defaults", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  range: invalid
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Invalid range format at defaults");
    });

    it("should throw error for invalid convert format in defaults", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults:
  convert: invalid
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        'Invalid convert format at defaults: "invalid"',
      );
    });

    it("should throw error for non-object defaults", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
defaults: "not an object"
sources:
  - path: /music/Artist1
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow("Field 'defaults' must be an object");
    });
  });

  describe("per-source options", () => {
    it("should parse per-source filter", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    filter: liked
  - path: /music/Artist2
    filter: rock-classics
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", filterName: "liked" },
        { path: "/music/Artist2", filterName: "rock-classics" },
      ]);
    });

    it("should parse per-source outputFolder", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    outputFolder: liked-songs
  - path: /music/Artist2
    outputFolder: rock-tracks
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", outputFolder: "liked-songs" },
        { path: "/music/Artist2", outputFolder: "rock-tracks" },
      ]);
    });

    it("should parse per-source convert format", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    convert: alac
  - path: /music/Artist2
    convert: mp3
  - path: /music/Artist3
    convert: aac
  - path: /music/Artist4
    convert: opus
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        { path: "/music/Artist1", convertFormat: "alac" },
        { path: "/music/Artist2", convertFormat: "mp3" },
        { path: "/music/Artist3", convertFormat: "aac" },
        { path: "/music/Artist4", convertFormat: "opus" },
      ]);
    });

    it("should parse all per-source options together", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    count: 5
    filter: female-pop
    outputFolder: female-pop-artists
    convert: alac
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expectSourcesToMatch(result.sources, [
        {
          path: "/music/Artist1",
          count: 5,
          filterName: "female-pop",
          outputFolder: "female-pop-artists",
          convertFormat: "alac",
        },
      ]);
    });
  });

  describe("per-source validation errors", () => {
    it("should throw error for invalid convert format in source", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    convert: wav
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        'Invalid convert format at source index 0: "wav"',
      );
    });

    it("should throw error for non-string filter", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    filter: 123
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected string for 'filter' at source index 0",
      );
    });

    it("should throw error for non-string outputFolder", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
    outputFolder: 123
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow(PathsYamlError);
      await expect(parsePathsYaml(testFile)).rejects.toThrow(
        "Expected string for 'outputFolder' at source index 0",
      );
    });
  });

  describe("full example with defaults and per-source", () => {
    it("should parse complex example with defaults and overrides", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /data/media/music-manual
defaults:
  filter: liked
  count: 5
  convert: mp3
  outputFolder: liked-songs
sources:
  - path: /music/Pop
    # Uses all defaults
  - path: /music/Rock
    filter: rock-favorites
    # Override filter only, uses defaults for rest
  - path: /music/Classical
    filter: classical-gems
    outputFolder: classical
    convert: alac
    count: 3
    # Full override
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.destination).toBe("/data/media/music-manual");
      expect(result.sources).toHaveLength(3);
      expect(result.sources[0]).toMatchObject({
        path: "/music/Pop",
        count: 5,
        filterName: "liked",
        outputFolder: "liked-songs",
        convertFormat: "mp3",
      });
      expect(result.sources[1]).toMatchObject({
        path: "/music/Rock",
        count: 5,
        filterName: "rock-favorites",
        outputFolder: "liked-songs",
        convertFormat: "mp3",
      });
      expect(result.sources[2]).toMatchObject({
        path: "/music/Classical",
        count: 3,
        filterName: "classical-gems",
        outputFolder: "classical",
        convertFormat: "alac",
      });
    });
  });

  describe("source selection", () => {
    it("should parse multiple groups for a source", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - groups:
      - pop-divas
      - latin-divas
    artist: Shakira
    path: /music/Shakira
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.sources[0]?.sourceGroups).toEqual(["pop-divas", "latin-divas"]);
      expect(result.sources[0]?.sourceNames).toEqual([
        "pop-divas",
        "latin-divas",
        "Shakira",
        "Shakira",
      ]);
      expect(result.sources[0]?.sourceArtist).toBe("Shakira");
    });

    it("should throw error for empty groups array", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - groups: []
    path: /music/Empty
`,
        "utf-8",
      );

      await expect(parsePathsYaml(testFile)).rejects.toThrow("Empty 'groups' array");
    });

    it("should include sourceGroups and sourceNames resolved from groups field", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - groups: pop-divas
    artist: Britney Spears
    path: /music/Britney Spears
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.sources[0]?.sourceGroups).toEqual(["pop-divas"]);
      // sourceNames includes groups + artist + basename
      expect(result.sources[0]?.sourceNames).toEqual([
        "pop-divas",
        "Britney Spears",
        "Britney Spears",
      ]);
      expect(result.sources[0]?.sourceArtist).toBe("Britney Spears");
      expect(result.sources[0]?.sourceIndex).toBe(1);
    });

    it("should include artist in sourceNames when no groups specified", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - artist: Mariah Carey
    path: /music/Mariah Carey
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      // sourceNames includes artist + basename
      expect(result.sources[0]?.sourceNames).toEqual(["Mariah Carey", "Mariah Carey"]);
      expect(result.sources[0]?.sourceArtist).toBe("Mariah Carey");
      expect(result.sources[0]?.sourceIndex).toBe(1);
    });

    it("should fallback sourceNames to basename when neither groups nor artist specified", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Unknown Artist
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      // sourceNames only includes basename
      expect(result.sources[0]?.sourceNames).toEqual(["Unknown Artist"]);
      expect(result.sources[0]?.sourceIndex).toBe(1);
    });

    it("should assign 1-based sourceIndex to each source", async () => {
      const testFile = join(tempDir, "paths.yml");
      await writeFile(
        testFile,
        `destination: /output
sources:
  - path: /music/Artist1
  - path: /music/Artist2
  - path: /music/Artist3
`,
        "utf-8",
      );

      const result = await parsePathsYaml(testFile);

      expect(result.sources[0]?.sourceIndex).toBe(1);
      expect(result.sources[1]?.sourceIndex).toBe(2);
      expect(result.sources[2]?.sourceIndex).toBe(3);
    });
  });
});

describe("loadAndValidatePathsYaml", () => {
  const fixturePath = fileURLToPath(new URL("./__fixtures__/paths-errors.yml", import.meta.url));

  beforeEach(() => {
    vi.clearAllMocks();
    mockConvert.requireFfmpeg.mockResolvedValue(undefined);
  });

  it("throws LookupNotFoundError when YAML filter is missing from config", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        liked: { condition: "rating >= 3" },
      },
    });

    await expect(loadAndValidatePathsYaml({ pathsFile: fixturePath })).rejects.toBeInstanceOf(
      LookupNotFoundError,
    );

    try {
      await loadAndValidatePathsYaml({ pathsFile: fixturePath });
    } catch (error) {
      expect(error).toBeInstanceOf(LookupNotFoundError);
      const lookupError = error as LookupNotFoundError;
      expect(lookupError.lookupType).toBe("filter");
      expect(lookupError.value).toBe("deep-cuts");
      expect(lookupError.availableValues).toEqual(["liked"]);
    }
  });

  it("throws SourceSelectionError with available source context when selection has no matches", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        liked: { condition: "rating >= 3" },
        "deep-cuts": { condition: "rating >= 4" },
      },
    });

    await expect(
      loadAndValidatePathsYaml({
        pathsFile: fixturePath,
        sourceName: "xxyyzz",
      }),
    ).rejects.toBeInstanceOf(SourceSelectionError);

    try {
      await loadAndValidatePathsYaml({
        pathsFile: fixturePath,
        sourceName: "xxyyzz",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSelectionError);
      const selectionError = error as SourceSelectionError;
      expect(selectionError.selectionSummary).toContain("--source-name=xxyyzz");
      expect(selectionError.availableSources).toContain("1:");
      expect(selectionError.cause).toBeUndefined();
    }
  });

  it("throws SourceSelectionError with available source context for invalid index selection", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        liked: { condition: "rating >= 3" },
        "deep-cuts": { condition: "rating >= 4" },
      },
    });

    await expect(
      loadAndValidatePathsYaml({
        pathsFile: fixturePath,
        sourceIdx: "9",
      }),
    ).rejects.toBeInstanceOf(SourceSelectionError);

    try {
      await loadAndValidatePathsYaml({
        pathsFile: fixturePath,
        sourceIdx: "9",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSelectionError);
      const selectionError = error as SourceSelectionError;
      expect(selectionError.message).toContain("Valid range is 1-5");
      expect(selectionError.availableSources).toContain("artist:");
      expect(selectionError.cause).toBeInstanceOf(SourceSelectionError);
      expect((selectionError.cause as Error).message).toContain("Valid range is 1-5");
    }
  });

  it("returns filtered source entries for a valid selection", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        liked: { condition: "rating >= 3" },
        "deep-cuts": { condition: "rating >= 4" },
      },
    });

    const result = await loadAndValidatePathsYaml({
      pathsFile: fixturePath,
      sourceGroup: "latin-divas",
    });

    expect(result.destination).toBe("/data/media/music-manual");
    expect(result.sourceEntries).toHaveLength(1);
    expect(result.sourceEntries[0]?.sourceArtist).toBe("Shakira");
  });

  it("bubbles FfmpegNotFoundError when per-source conversion is configured", async () => {
    mockLoadedConfig.getLoadedConfig.mockReturnValue({
      filters: {
        liked: { condition: "rating >= 3" },
      },
    });

    const convertPathsFile = fileURLToPath(
      new URL("./__fixtures__/paths-errors-convert.yml", import.meta.url),
    );

    mockConvert.requireFfmpeg.mockRejectedValue(new FfmpegNotFoundError());

    await expect(loadAndValidatePathsYaml({ pathsFile: convertPathsFile })).rejects.toBeInstanceOf(
      FfmpegNotFoundError,
    );
  });
});

describe("filterSourcesBySelection", () => {
  const sources = [
    {
      path: "/music/Britney Spears",
      sourceNames: ["pop-divas", "Britney Spears", "Britney Spears"],
      sourceGroups: ["pop-divas"],
      sourceArtist: "Britney Spears",
      sourceIndex: 1,
    },
    {
      path: "/music/Mariah Carey",
      sourceNames: ["pop-divas", "Mariah Carey", "Mariah Carey"],
      sourceGroups: ["pop-divas"],
      sourceArtist: "Mariah Carey",
      sourceIndex: 2,
    },
    {
      path: "/music/Shakira",
      sourceNames: ["pop-divas", "latin-divas", "Shakira", "Shakira"],
      sourceGroups: ["pop-divas", "latin-divas"],
      sourceArtist: "Shakira",
      sourceIndex: 3,
    },
    {
      path: "/music/Taylor Swift",
      sourceNames: ["rock-favorites", "Taylor Swift", "Taylor Swift"],
      sourceGroups: ["rock-favorites"],
      sourceArtist: "Taylor Swift",
      sourceIndex: 4,
    },
    { path: "/music/Unknown", sourceNames: ["Unknown"], sourceIndex: 5 },
  ];

  describe("index selection", () => {
    it("supports single, list, range, and mixed index syntax in source order", () => {
      const cases = [
        ["2", [2]],
        ["1,3,5", [1, 3, 5]],
        ["2-4", [2, 3, 4]],
        ["1,3-4", [1, 3, 4]],
      ] as const;

      for (const [selection, expectedIndices] of cases) {
        expect(
          filterSourcesBySelection(sources, selection).map(({ sourceIndex }) => sourceIndex),
          selection,
        ).toEqual(expectedIndices);
      }
    });

    it("rejects every invalid index syntax class with typed, specific errors", () => {
      const cases = [
        ["10", "Valid range is 1-5"],
        ["0", "must be 1 or greater"],
        ["-1", "must be 1 or greater"],
        ["4-2", "must be <= end"],
        ["abc", "Invalid index"],
      ] as const;

      for (const [selection, message] of cases) {
        expect(() => filterSourcesBySelection(sources, selection), selection).toThrow(
          SourceSelectionError,
        );
        expect(() => filterSourcesBySelection(sources, selection), selection).toThrow(message);
      }
    });
  });

  describe("unified name selection (--source-name)", () => {
    it("matches artists, groups, basenames, partial names, OR lists, and case-insensitive input", () => {
      const cases = [
        ["britney", [1]],
        ["pop-divas", [1, 2, 3]],
        ["Unknown", [5]],
        ["taylor", [4]],
        ["britney,taylor", [1, 4]],
        ["LATIN", [3]],
        ["nonexistent", []],
      ] as const;

      for (const [selection, expectedIndices] of cases) {
        expect(
          filterSourcesBySelection(sources, undefined, selection).map(
            ({ sourceIndex }) => sourceIndex,
          ),
          selection,
        ).toEqual(expectedIndices);
      }
    });
  });

  describe("artist selection (--artist)", () => {
    it("matches exact, partial, case-insensitive, and OR artist input without matching groups", () => {
      const cases = [
        ["britney spears", [1]],
        ["shakira", [3]],
        ["britney,taylor", [1, 4]],
        ["pop-divas", []],
        ["unknown", []],
      ] as const;

      for (const [selection, expectedIndices] of cases) {
        expect(
          filterSourcesBySelection(sources, undefined, undefined, selection).map(
            ({ sourceIndex }) => sourceIndex,
          ),
          selection,
        ).toEqual(expectedIndices);
      }
    });
  });

  describe("group selection (--group)", () => {
    it("matches exact, partial, case-insensitive, and OR group input without matching artists", () => {
      const cases = [
        ["pop-divas", [1, 2, 3]],
        ["latin", [3]],
        ["latin-divas,rock-favorites", [3, 4]],
        ["britney", []],
        ["test", []],
      ] as const;

      for (const [selection, expectedIndices] of cases) {
        expect(
          filterSourcesBySelection(sources, undefined, undefined, undefined, selection).map(
            ({ sourceIndex }) => sourceIndex,
          ),
          selection,
        ).toEqual(expectedIndices);
      }
    });
  });

  describe("combined selection (AND logic between filter types)", () => {
    it("intersects every supplied filter type", () => {
      const cases = [
        [["1-3", "shakira", undefined, undefined], [3]],
        [["1", "taylor", undefined, undefined], []],
        [[undefined, undefined, "shakira", "pop-divas"], [3]],
        [["1-3", undefined, undefined, "latin-divas"], [3]],
        [[undefined, undefined, "taylor", "pop-divas"], []],
      ] as const;

      for (const [[indices, name, artist, sourceGroup], expectedIndices] of cases) {
        expect(
          filterSourcesBySelection(sources, indices, name, artist, sourceGroup).map(
            ({ sourceIndex }) => sourceIndex,
          ),
          JSON.stringify([indices, name, artist, sourceGroup]),
        ).toEqual(expectedIndices);
      }
    });
  });

  describe("edge cases", () => {
    it("preserves all sources by default and normalizes whitespace and duplicate indices", () => {
      expect(filterSourcesBySelection(sources).map(({ sourceIndex }) => sourceIndex)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(
        filterSourcesBySelection(sources, " 1 , 2 ").map(({ sourceIndex }) => sourceIndex),
      ).toEqual([1, 2]);
      expect(
        filterSourcesBySelection(sources, "1,1,1").map(({ sourceIndex }) => sourceIndex),
      ).toEqual([1]);
    });
  });
});
