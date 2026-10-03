/**
 * Verify operation benchmarks (issue #57).
 *
 * Measures the production quick/default/deep executeAlbumVerify() paths at
 * each scale against one inventory-backed, pre-copied destination.
 * One iteration = one full album-mode verification of scale files.
 *
 * Fixtures are built with top-level await because vitest benchmark mode
 * does not run beforeAll/afterAll hooks; cleanup happens on process exit.
 *
 * Run with: npm run bench --workspace packages/rfmedia-cli
 */

import path from "node:path";

import { bench, describe } from "vitest";

import { executeAlbumCopy } from "../src/actions/copy-album.js";
import { executeAlbumVerify } from "../src/actions/verify-album.js";
import { closeDatabase, createOperation, initializeDatabase } from "../src/lib/db.js";
import type { VerificationTier } from "../src/types/options.js";
import type { TrackingConfig } from "../src/types/tracking.js";
import {
  benchOptionsFor,
  benchScales,
  benchTrackBytes,
  buildArtistLibrary,
  createBenchRoot,
  makeCopyOptions,
  makeVerifyOptions,
  silenceCliOutput,
} from "./helpers.js";

silenceCliOutput();

for (const scale of benchScales()) {
  const root = await createBenchRoot("rfmedia-bench-verify-");
  const source = await buildArtistLibrary(root, "Bench Artist", scale);
  const destination = path.join(root, "dest");
  const trackingDatabase = path.join(root, "tracking.db");
  const fixtureMiB = (scale * benchTrackBytes()) / (1024 * 1024);
  const commonVerifyOptions = {
    trackingDatabase,
    workers: 1,
  } as const;

  // Populate one exact destination and final-artifact inventory. All benchmark
  // rows below are read-only and reuse this unchanged database snapshot.
  const database = await initializeDatabase(trackingDatabase);
  const trackingConfig: TrackingConfig = {
    enabled: true,
    completedFilePath: path.join(root, "completed.jsonl"),
    failedFilePath: path.join(root, "failed.jsonl"),
    reset: false,
    db: database,
    operationId: createOperation(database, {
      command: "copy-album",
      mode: "album",
      inputFile: null,
      optionsHash: "bench-tiered-verification",
      ratingKey: null,
      rangeKey: "001-001",
      convertKey: null,
    }),
  };
  let copyResult;
  try {
    copyResult = await executeAlbumCopy(
      source,
      destination,
      makeCopyOptions({ trackCompleted: true }),
      undefined,
      trackingConfig,
    );
  } finally {
    closeDatabase(database);
  }
  if (copyResult.failed.length > 0) {
    throw new Error(
      `Inventory fixture copy failed: ${copyResult.failed.map((failure) => `${failure.path}: ${failure.message}`).join("; ")}`,
    );
  }

  const runTier = async (tier: VerificationTier): Promise<void> => {
    const result = await executeAlbumVerify(
      source,
      destination,
      makeVerifyOptions({ ...commonVerifyOptions, tier }),
    );
    if (result.verified !== scale || result.failed.length > 0 || result.issues.length > 0) {
      throw new Error(
        `${tier} benchmark fixture verification failed: ${result.verified}/${scale} verified, ${result.issues.length} issues (${result.issues.map((issue) => `${issue.status}:${issue.path}`).join(", ")}), ${result.failed.length} failures`,
      );
    }
  };

  describe(`warm-cache verify ${scale} files (${fixtureMiB.toFixed(2)} MiB logical content)`, () => {
    bench(
      `quick metadata [files/s = hz × ${scale}]`,
      async () => {
        await runTier("quick");
      },
      benchOptionsFor(scale),
    );

    bench(
      `default stored fingerprint [files/s = hz × ${scale}; MiB/s = hz × ${fixtureMiB.toFixed(2)}]`,
      async () => {
        await runTier("default");
      },
      benchOptionsFor(scale),
    );

    bench(
      `deep fingerprint + bytes [files/s = hz × ${scale}; MiB/s = hz × ${fixtureMiB.toFixed(2)}]`,
      async () => {
        await runTier("deep");
      },
      benchOptionsFor(scale),
    );
  });
}
