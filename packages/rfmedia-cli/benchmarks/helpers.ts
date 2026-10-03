/**
 * Shared fixture builders and scale configuration for rfmedia benchmarks.
 *
 * Benchmarks run against real temp-directory fixtures (no mocks) so that
 * results reflect actual filesystem and SQLite behavior.
 *
 * Scales (total file counts) are controlled via the RFMEDIA_BENCH_SCALES
 * environment variable:
 * - unset: 10, 100, 1000 (default)
 * - "full": 10, 100, 1000, 10000
 * - comma-separated list: explicit scales (e.g. "10,100")
 *
 * Per-track fixture size is controlled by RFMEDIA_BENCH_TRACK_BYTES:
 * - unset: ~1 KiB (default)
 * - positive integer: exact bytes per track (e.g. "8388608" for 8 MiB)
 */

import { rmSync } from "node:fs";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BenchOptions } from "vitest";

import { setJsonMode } from "../src/lib/logger.js";
import type { CopyOptions, CopyRange, VerifyOptions } from "../src/types/options.js";

/** Number of track files placed in each album fixture directory. */
export const TRACKS_PER_ALBUM = 10;

const DEFAULT_SCALES = [10, 100, 1000];
const FULL_SCALES = [10, 100, 1000, 10000];

/**
 * Resolves benchmark scales (total file counts) from RFMEDIA_BENCH_SCALES.
 *
 * @throws Error if the variable is set but contains non-positive or non-numeric values
 */
export function benchScales(): number[] {
  const raw = process.env["RFMEDIA_BENCH_SCALES"]?.trim();
  if (!raw) {
    return DEFAULT_SCALES;
  }
  if (raw === "full") {
    return FULL_SCALES;
  }

  const scales = raw.split(",").map((part) => {
    const value = Number.parseInt(part.trim(), 10);
    if (Number.isNaN(value) || value <= 0) {
      throw new Error(`Invalid RFMEDIA_BENCH_SCALES entry: "${part}" (expected positive integers)`);
    }
    return value;
  });

  if (scales.length === 0) {
    throw new Error("RFMEDIA_BENCH_SCALES is set but contains no scales");
  }
  return scales;
}

/**
 * Returns bounded tinybench options for a given scale so large fixtures
 * cannot run for minutes (tinybench honors `iterations` as a minimum even
 * after `time` has elapsed).
 */
export function benchOptionsFor(scale: number): BenchOptions {
  return {
    time: 500,
    iterations: scale >= 1000 ? 3 : 5,
    warmupTime: 100,
    warmupIterations: 1,
    throws: true,
  };
}

/**
 * Silences interactive CLI output (spinners, progress bars, [INFO] logs)
 * by switching the shared logger into machine-output mode.
 * Call once at module load in every benchmark file.
 */
export function silenceCliOutput(): void {
  setJsonMode(true);
}

/**
 * Cleanup registry. Vitest benchmark mode does not execute beforeAll/afterAll
 * lifecycle hooks, so fixtures are built with top-level await and torn down
 * synchronously on process exit (LIFO order).
 */
const cleanups: Array<() => void> = [];
let exitHookInstalled = false;

/** Registers a synchronous cleanup callback to run when the process exits. */
export function registerBenchCleanup(cleanup: () => void): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {
          // Best-effort teardown; never mask benchmark results with cleanup errors
        }
      }
    });
  }
  cleanups.push(cleanup);
}

/**
 * Creates an isolated temp root for one benchmark suite and registers its
 * removal on process exit.
 */
export async function createBenchRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  registerBenchCleanup(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** ~1 KiB default; small enough to keep fixtures fast at 10k files. */
const DEFAULT_TRACK_CONTENT = Buffer.from("rfmedia-bench-audio-data ".repeat(40), "utf-8");
const FIXTURE_TIMESTAMP = new Date("2024-01-01T00:00:00.000Z");

/** Returns the exact byte size used for each generated benchmark track. */
export function benchTrackBytes(): number {
  const raw = process.env["RFMEDIA_BENCH_TRACK_BYTES"]?.trim();
  if (!raw) {
    return DEFAULT_TRACK_CONTENT.byteLength;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `Invalid RFMEDIA_BENCH_TRACK_BYTES value: "${raw}" (expected a positive integer)`,
    );
  }

  const bytes = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      `Invalid RFMEDIA_BENCH_TRACK_BYTES value: "${raw}" (expected a positive integer)`,
    );
  }

  return bytes;
}

function trackContent(): Buffer {
  return process.env["RFMEDIA_BENCH_TRACK_BYTES"]?.trim()
    ? Buffer.alloc(benchTrackBytes(), 0x61)
    : DEFAULT_TRACK_CONTENT;
}

/**
 * Builds an artist library fixture: `root/<artistName>/Album NNN/Track NN.flac`.
 *
 * Creates `fileCount` total files spread across albums of TRACKS_PER_ALBUM
 * tracks each (the last album holds the remainder).
 *
 * @returns Absolute path to the artist directory (the copy/verify source)
 */
export async function buildArtistLibrary(
  root: string,
  artistName: string,
  fileCount: number,
): Promise<string> {
  const artistDir = path.join(root, artistName);
  const albumCount = Math.ceil(fileCount / TRACKS_PER_ALBUM);
  const content = trackContent();

  let remaining = fileCount;
  for (let albumIndex = 1; albumIndex <= albumCount; albumIndex++) {
    const albumDir = path.join(artistDir, `Album ${String(albumIndex).padStart(3, "0")}`);
    await mkdir(albumDir, { recursive: true });

    const trackCount = Math.min(TRACKS_PER_ALBUM, remaining);
    remaining -= trackCount;

    for (let trackIndex = 1; trackIndex <= trackCount; trackIndex++) {
      const trackFile = path.join(
        albumDir,
        `${String(trackIndex).padStart(2, "0")} - Track ${trackIndex}.flac`,
      );
      await writeFile(trackFile, content);
      // Whole-second timestamps survive copy/preserve round trips consistently,
      // keeping quick-tier metadata evidence identical on every supported FS.
      await utimes(trackFile, FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP);
    }
  }

  return artistDir;
}

/**
 * Builds a multi-artist library for clean-scan benchmarks:
 * populated albums holding `fileCount` files total, plus ~10% empty album
 * directories (minimum 2) for the scanner to find.
 *
 * @returns Absolute path to the library root passed to findEmptyAlbums()
 */
export async function buildCleanLibrary(root: string, fileCount: number): Promise<string> {
  const libraryDir = path.join(root, "library");
  const artistDir = await buildArtistLibrary(libraryDir, "Bench Artist", fileCount);

  const emptyCount = Math.max(2, Math.floor(fileCount / TRACKS_PER_ALBUM / 10));
  for (let index = 1; index <= emptyCount; index++) {
    const emptyAlbum = path.join(artistDir, `Empty Album ${String(index).padStart(3, "0")}`);
    await mkdir(emptyAlbum, { recursive: true });
  }

  return libraryDir;
}

/** Single-copy range (001-001) used by the copy/verify benchmarks. */
export function singleCopyRange(): CopyRange {
  return { start: 1, end: 1, padWidth: 3 };
}

/**
 * Copy options for offline benchmarking: no tracking, no Plex, no progress
 * bars, no disk-space pre-scan. `force` defaults to true so every iteration
 * performs the same overwrite work instead of skipping existing copies.
 */
export function makeCopyOptions(overrides: Partial<CopyOptions> = {}): CopyOptions {
  return {
    mode: { type: "album", range: singleCopyRange() },
    albumOnly: false,
    hardlink: false,
    force: true,
    dryRun: false,
    workers: 1,
    progress: false,
    trackCompleted: false,
    plexScan: false,
    requireDiskSpace: false,
    ...overrides,
  };
}

/** Verify options matching makeCopyOptions() fixtures. */
export function makeVerifyOptions(overrides: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    mode: { type: "album", range: singleCopyRange() },
    tier: "quick",
    albumOnly: false,
    dryRun: false,
    workers: 1,
    progress: false,
    verifySize: false,
    ...overrides,
  };
}
