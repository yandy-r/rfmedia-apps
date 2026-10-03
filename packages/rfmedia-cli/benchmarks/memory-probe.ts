/**
 * Memory usage probe for copy, verify, and clean operations (issue #57).
 *
 * Not a timing benchmark: each operation runs once per scale while
 * process.memoryUsage() is sampled on an interval to capture peak heap and
 * RSS deltas relative to the pre-operation baseline. Use it to spot memory
 * growth that the throughput benchmarks cannot see.
 *
 * Scales follow the same RFMEDIA_BENCH_SCALES variable as the bench suite.
 * Run with: npm run bench:memory --workspace packages/rfmedia-cli
 * (optionally under `node --expose-gc` for cleaner baselines)
 */

import path from "node:path";

import { findEmptyAlbums } from "../src/actions/clean.js";
import { executeAlbumCopy } from "../src/actions/copy-album.js";
import { executeAlbumVerify } from "../src/actions/verify-album.js";
import {
  benchScales,
  buildArtistLibrary,
  buildCleanLibrary,
  createBenchRoot,
  makeCopyOptions,
  makeVerifyOptions,
  silenceCliOutput,
} from "./helpers.js";

const SAMPLE_INTERVAL_MS = 10;

interface MemoryReport {
  scale: number;
  operation: string;
  /** Peak heapUsed above the pre-operation baseline, in MiB */
  peakHeapDeltaMiB: number;
  /** Peak RSS above the pre-operation baseline, in MiB */
  peakRssDeltaMiB: number;
  /** heapUsed still retained after the operation, in MiB */
  retainedHeapMiB: number;
}

function toMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/** Runs one operation while sampling memory, returning peak deltas. */
async function probe(
  scale: number,
  operation: string,
  run: () => Promise<unknown>,
): Promise<MemoryReport> {
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;

  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  }, SAMPLE_INTERVAL_MS);

  try {
    await run();
  } finally {
    clearInterval(sampler);
  }

  const after = process.memoryUsage();
  peakHeap = Math.max(peakHeap, after.heapUsed);
  peakRss = Math.max(peakRss, after.rss);

  return {
    scale,
    operation,
    peakHeapDeltaMiB: toMiB(peakHeap - baseline.heapUsed),
    peakRssDeltaMiB: toMiB(peakRss - baseline.rss),
    retainedHeapMiB: toMiB(after.heapUsed - baseline.heapUsed),
  };
}

async function main(): Promise<void> {
  silenceCliOutput();
  const reports: MemoryReport[] = [];

  for (const scale of benchScales()) {
    const root = await createBenchRoot("rfmedia-bench-memory-");
    const source = await buildArtistLibrary(root, "Bench Artist", scale);
    const destination = path.join(root, "dest");
    const cleanLibrary = await buildCleanLibrary(root, scale);

    reports.push(
      await probe(scale, "copy", () => executeAlbumCopy(source, destination, makeCopyOptions())),
      await probe(scale, "verify (existence + size)", () =>
        executeAlbumVerify(source, destination, makeVerifyOptions({ verifySize: true })),
      ),
      await probe(scale, "clean scan", () => findEmptyAlbums(cleanLibrary)),
    );
  }

  if (!globalThis.gc) {
    console.error(
      "note: run under `node --expose-gc` (e.g. NODE_OPTIONS=--expose-gc) for cleaner baselines",
    );
  }
  console.table(reports);
}

await main();
