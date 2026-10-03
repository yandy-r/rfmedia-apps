/**
 * Tracking-layer benchmarks: database mode vs legacy file mode (issue #57).
 *
 * Compares the two completed-source tracking backends at each scale:
 * - write throughput: recordCompleted() for N sources per iteration
 * - read latency: loadTrackingState() over a pre-populated state of N entries
 *
 * Database mode routes through better-sqlite3 (operations + completed_sources
 * tables); legacy mode appends to / parses `.completed.*.txt` sidecar files.
 *
 * Fixtures are built with top-level await because vitest benchmark mode
 * does not run beforeAll/afterAll hooks; cleanup happens on process exit.
 *
 * Run with: npm run bench --workspace packages/rfmedia-cli
 */

import path from "node:path";

import { bench, describe } from "vitest";

import { loadTrackingState, recordCompleted } from "../src/lib/completed-tracker.js";
import { createOperation, initializeDatabase } from "../src/lib/db.js";
import type { DbConnection } from "../src/types/db.js";
import type { TrackingConfig } from "../src/types/tracking.js";
import {
  benchOptionsFor,
  benchScales,
  createBenchRoot,
  registerBenchCleanup,
  silenceCliOutput,
} from "./helpers.js";

silenceCliOutput();

let operationCounter = 0;

/** Builds a legacy (file-based) tracking config rooted in the bench dir. */
function legacyConfig(root: string, name: string): TrackingConfig {
  return {
    enabled: true,
    completedFilePath: path.join(root, `${name}.completed.bench.txt`),
    failedFilePath: path.join(root, `${name}.failed.bench.txt`),
    reset: false,
  };
}

/** Builds a database-backed tracking config with its own operation. */
function dbConfig(root: string, db: DbConnection, scale: number): TrackingConfig {
  const operationId = createOperation(db, {
    command: "copy-album",
    mode: "album",
    inputFile: null,
    optionsHash: `bench-${scale}-${operationCounter++}`,
    ratingKey: null,
    rangeKey: "001-001",
    convertKey: null,
    totalSources: scale,
  });

  return {
    enabled: true,
    completedFilePath: path.join(root, "unused.completed.bench.txt"),
    failedFilePath: path.join(root, "unused.failed.bench.txt"),
    reset: false,
    db,
    operationId,
  };
}

/**
 * Write benchmarks intentionally append to the same fixture across
 * iterations: legacy tracking is an O(1) appendFile regardless of file size,
 * and SQLite b-tree insert cost grows only logarithmically over the few
 * thousand rows accumulated in a run. Resetting the fixture inside the
 * measured function would dominate the cost being measured.
 */
let writeCounter = 0;

for (const scale of benchScales()) {
  const root = await createBenchRoot("rfmedia-bench-tracking-");
  const db = await initializeDatabase(path.join(root, "tracking.db"));
  registerBenchCleanup(() => db.close());

  const dbWrite = dbConfig(root, db, scale);
  const dbRead = dbConfig(root, db, scale);
  const legacyWrite = legacyConfig(root, "write");
  const legacyRead = legacyConfig(root, "read");

  // Pre-populate the read fixtures with exactly `scale` entries
  for (let index = 0; index < scale; index++) {
    const sourcePath = `/bench/library/artist-${index}`;
    await recordCompleted(dbRead, sourcePath);
    await recordCompleted(legacyRead, sourcePath);
  }

  describe(`tracking ${scale} entries`, () => {
    bench(
      `database: record ${scale} completions`,
      async () => {
        for (let index = 0; index < scale; index++) {
          await recordCompleted(dbWrite, `/bench/library/db-write-${writeCounter++}`);
        }
      },
      benchOptionsFor(scale),
    );

    bench(
      `legacy: record ${scale} completions`,
      async () => {
        for (let index = 0; index < scale; index++) {
          await recordCompleted(legacyWrite, `/bench/library/legacy-write-${writeCounter++}`);
        }
      },
      benchOptionsFor(scale),
    );

    bench(
      "database: load tracking state",
      async () => {
        await loadTrackingState(dbRead);
      },
      benchOptionsFor(scale),
    );

    bench(
      "legacy: load tracking state",
      async () => {
        await loadTrackingState(legacyRead);
      },
      benchOptionsFor(scale),
    );
  });
}
