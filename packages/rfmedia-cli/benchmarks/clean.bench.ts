/**
 * Clean operation benchmarks (issue #57).
 *
 * Measures the scan phase that dominates `rfmedia clean` runtime:
 * findEmptyAlbums() directory traversal (default and unlimited depth) and
 * the findEmptyArtists() cascade analysis. The scan functions are
 * benchmarked directly because executeClean() interleaves unconditional
 * terminal output with the work being measured; deletion itself is a
 * non-idempotent rm of the found set.
 *
 * Fixtures are built with top-level await because vitest benchmark mode
 * does not run beforeAll/afterAll hooks; cleanup happens on process exit.
 *
 * Run with: npm run bench --workspace packages/rfmedia-cli
 */

import { bench, describe } from "vitest";

import { findEmptyAlbums, findEmptyArtists } from "../src/actions/clean.js";
import {
  benchOptionsFor,
  benchScales,
  buildCleanLibrary,
  createBenchRoot,
  silenceCliOutput,
} from "./helpers.js";

silenceCliOutput();

for (const scale of benchScales()) {
  const root = await createBenchRoot("rfmedia-bench-clean-");
  const library = await buildCleanLibrary(root, scale);
  // Pre-compute the empty set once for the cascade benchmark
  const emptyAlbums = await findEmptyAlbums(library);

  describe(`clean scan ${scale} files`, () => {
    bench(
      "findEmptyAlbums (default depth)",
      async () => {
        await findEmptyAlbums(library);
      },
      benchOptionsFor(scale),
    );

    bench(
      "findEmptyAlbums (unlimited depth)",
      async () => {
        await findEmptyAlbums(library, { depth: 0 });
      },
      benchOptionsFor(scale),
    );

    bench(
      "findEmptyArtists (cascade analysis)",
      async () => {
        await findEmptyArtists(library, emptyAlbums);
      },
      benchOptionsFor(scale),
    );
  });
}
