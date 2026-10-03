/**
 * Copy operation benchmarks (issue #57).
 *
 * Measures executeAlbumCopy() throughput at each scale for both regular
 * copies and hardlinks. One iteration = one full album-mode copy of the
 * fixture library (scale files), so files/sec = hz x scale.
 *
 * Fixtures are built with top-level await because vitest benchmark mode
 * does not run beforeAll/afterAll hooks; cleanup happens on process exit.
 *
 * Run with: npm run bench --workspace packages/rfmedia-cli
 */

import path from "node:path";

import { bench, describe } from "vitest";

import { executeAlbumCopy } from "../src/actions/copy-album.js";
import { closeDatabase, createOperation, initializeDatabase } from "../src/lib/db.js";
import type { CopyOptions } from "../src/types/options.js";
import type { TrackingConfig } from "../src/types/tracking.js";
import {
  benchOptionsFor,
  benchScales,
  buildArtistLibrary,
  createBenchRoot,
  makeCopyOptions,
  silenceCliOutput,
} from "./helpers.js";

silenceCliOutput();

type BenchmarkCopyOptions = CopyOptions & { benchmarkDisableContentHashing?: boolean };

for (const scale of benchScales()) {
  const root = await createBenchRoot("rfmedia-bench-copy-");
  const source = await buildArtistLibrary(root, "Bench Artist", scale);
  const copyDest = path.join(root, "dest-copy");
  const trackedBaselineDest = path.join(root, "dest-copy-tracked-baseline");
  const trackedCopyDest = path.join(root, "dest-copy-tracked");
  const hardlinkDest = path.join(root, "dest-hardlink");
  const trackingDb = await initializeDatabase(path.join(root, "tracking.db"));

  const createTrackingBaselineConfig = (): TrackingConfig => ({
    enabled: true,
    completedFilePath: path.join(root, "baseline.completed.jsonl"),
    failedFilePath: path.join(root, "baseline.failed.jsonl"),
    reset: false,
    db: trackingDb,
    operationId: createOperation(trackingDb, {
      command: "copy-album",
      mode: "album",
      inputFile: null,
      optionsHash: "bench-sqlite-inventory-baseline",
      ratingKey: null,
      rangeKey: "001-001",
      convertKey: null,
    }),
  });
  const createTrackingConfig = (): TrackingConfig => ({
    enabled: true,
    completedFilePath: path.join(root, "completed.jsonl"),
    failedFilePath: path.join(root, "failed.jsonl"),
    reset: false,
    db: trackingDb,
    operationId: createOperation(trackingDb, {
      command: "copy-album",
      mode: "album",
      inputFile: null,
      optionsHash: "bench-content-hash",
      ratingKey: null,
      rangeKey: "001-001",
      convertKey: null,
    }),
  });

  process.once("exit", () => closeDatabase(trackingDb));

  describe(`copy ${scale} files`, () => {
    bench(
      "copy (force overwrite)",
      async () => {
        await executeAlbumCopy(source, copyDest, makeCopyOptions());
      },
      benchOptionsFor(scale),
    );

    bench(
      "copy with SQLite inventory baseline (hash disabled)",
      async () => {
        const options = makeCopyOptions({
          trackCompleted: true,
        }) as BenchmarkCopyOptions;
        options.benchmarkDisableContentHashing = true;
        await executeAlbumCopy(
          source,
          trackedBaselineDest,
          options,
          undefined,
          createTrackingBaselineConfig(),
        );
      },
      benchOptionsFor(scale),
    );

    bench(
      "copy with content hashing + SQLite inventory",
      async () => {
        await executeAlbumCopy(
          source,
          trackedCopyDest,
          makeCopyOptions({ trackCompleted: true }),
          undefined,
          createTrackingConfig(),
        );
      },
      benchOptionsFor(scale),
    );

    bench(
      "hardlink (force overwrite)",
      async () => {
        await executeAlbumCopy(source, hardlinkDest, makeCopyOptions({ hardlink: true }));
      },
      benchOptionsFor(scale),
    );

    bench(
      "dry-run preview",
      async () => {
        await executeAlbumCopy(source, copyDest, makeCopyOptions({ dryRun: true }));
      },
      benchOptionsFor(scale),
    );
  });
}
