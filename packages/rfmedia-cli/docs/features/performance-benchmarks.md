# Performance Benchmarks

Benchmark suite for the rfmedia CLI's core operations: copy, verify, clean, and the completed-source
tracking layer. Establishes performance baselines at multiple library scales so regressions are
caught before they reach real libraries ([#57](https://github.com/yandy-r/rfmedia-apps/issues/57)).

## Running

```bash
# From the repo root (default scales: 10, 100, 1000 files)
npm run bench:rfmedia

# From packages/rfmedia-cli
npm run bench

# Full sweep including the 10,000-file scale
RFMEDIA_BENCH_SCALES=full npm run bench

# Explicit scales (comma-separated file counts)
RFMEDIA_BENCH_SCALES=10,100 npm run bench
```

The suite uses [vitest bench](https://vitest.dev/guide/features.html#benchmarking) (tinybench under
the hood) — no extra dependencies. Results report `hz` (operations/sec), latency percentiles, and
relative speed within each group.

## What is measured

| File                | Operation                                                       | Variants                                                                 |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `copy.bench.ts`     | `executeAlbumCopy()` full album-mode copy                       | regular copy, hardlink, dry-run preview                                  |
| `verify.bench.ts`   | `executeAlbumVerify()` against one inventory-backed destination | quick metadata, default stored fingerprint, deep fingerprint + bytes     |
| `clean.bench.ts`    | clean scan phase                                                | `findEmptyAlbums` (default/unlimited depth), `findEmptyArtists` cascade  |
| `tracking.bench.ts` | tracking backends: database vs legacy files                     | `recordCompleted()` write throughput, `loadTrackingState()` read latency |

One benchmark iteration covers the whole fixture at that scale, so **files/sec = hz × scale** for
the copy and verify groups.

### Tiered verification comparison

`verify.bench.ts` builds one copied destination and exact SQLite inventory, closes the producing
database connection, and then runs the production quick, default, and deep verification paths
against that unchanged fixture. Source files, destination files, range `001-001`, one-worker
configuration, logical bytes, and database state are identical for all three rows. Quick does not
open the configured database; default reads the stored final-artifact fingerprint and destination;
deep adds the applicable source/destination byte comparison.

The rows are explicitly warm-cache measurements. Tinybench repeatedly verifies the same fixture
without dropping filesystem caches, using a 100 ms warmup, one minimum warmup iteration, 500 ms
measurement time, and five minimum measured iterations at representative scales below 1,000 files.
Quick reports files/s. Default and deep additionally report logical-content MiB/s as `hz × fixture
MiB`; this is comparable verified-content throughput, not a claim about physical device bytes read.

The independently confirmed July 19, 2026 run at checkpoint
`d651dfd41bbc591e8c60966367b3c7790550b639` used ten 1 MiB files. Quick measured 26.22× the default
rate and 45.96× the deep rate, exceeding issue #116's 10× quick-versus-deep target for that workload.
This is local warm-cache evidence, not a portable runtime guarantee or CI threshold. See the full
[tiered verification benchmark results](../../../../docs/plans/tiered-verification/benchmark-results.md)
for the command, environment, rates, derived throughput, qualifications, and draft PR #249.

### Fixture shape

Fixtures are real temp-directory trees (no mocks): an artist folder with albums of 10 tracks each
(~1 KiB per file). The clean fixture adds ~10% empty album directories for the scanner to find. Copy
benchmarks run with `force: true` so every iteration performs identical overwrite work instead of
skipping already-complete copies.

### Database vs legacy tracking

`tracking.bench.ts` compares the SQLite-backed tracking database (better-sqlite3, `operations` +
`completed_sources` tables) against the legacy `.completed.*.txt` sidecar files at each scale, in
both directions:

- **write**: `recordCompleted()` for N sources per iteration
- **read**: `loadTrackingState()` over a pre-populated state of N entries

This isolates database query time from filesystem work and gives the baseline for the SQLite
optimization audit ([#112](https://github.com/yandy-r/rfmedia-apps/issues/112)).

### Content-hashing paired comparison

`copy.bench.ts` also contains a benchmark-only seam for comparing direct copies with destination
fingerprinting disabled and enabled. This is not a runtime CLI option. The paired comparison keeps
SQLite tracking, inventory persistence, source fixture, destination filesystem, overwrite policy,
range, and worker count identical; the baseline's `benchmarkDisableContentHashing = true` setting is
the only behavioral difference.

For repeatable evidence, run each fixture in multiple independent Vitest processes. Each process
uses a new isolated temporary root and executes the two rows in a fixed order:

1. hash-disabled SQLite-tracked baseline;
2. hash-enabled SQLite inventory.

Report every independent result, the median and min-max spread, throughput, and relative margin of
error. Use the default 1 KiB files to expose metadata/SQLite overhead and
`RFMEDIA_BENCH_TRACK_BYTES` for representative media-sized byte-copy samples.

```bash
# Small-file comparison
RFMEDIA_BENCH_SCALES=1000 npm run bench --workspace=packages/rfmedia-cli -- copy.bench.ts

# Ten 8 MiB files (80 MiB copied per action iteration)
RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=8388608 \
  npm run bench --workspace=packages/rfmedia-cli -- copy.bench.ts
```

The July 18, 2026 measurement completed successfully, but its result against issue #111's `<5%`
direct-copy overhead target is **inconclusive**. Hash-enabled median time was lower than the baseline
for both fixture sets, while individual representative-size paired results ranged from `-15.83%` to
`+112.70%`. Baseline variation was also high. The evidence therefore supports neither a performance
regression claim nor a target-pass claim.

See the complete [content-hashing benchmark results](../../../../docs/plans/content-hashing-during-copy-operations/benchmark-results.md)
for raw samples, medians, throughput, memory observation, environment, and limitations. Hardlink and
conversion timing are excluded from the issue's direct byte-copy decision because the harness does
not provide equivalent paired cases for them.

## Scales

| `RFMEDIA_BENCH_SCALES` | Scales (total files) | Use                        |
| ---------------------- | -------------------- | -------------------------- |
| unset                  | 10, 100, 1000        | local default              |
| `full`                 | 10, 100, 1000, 10000 | deep baseline runs         |
| `10,100`               | as listed            | CI smoke / quick iteration |

Iteration counts are bounded per scale (see `benchOptionsFor()` in `benchmarks/helpers.ts`) so the
1000+ file scales cannot run for minutes.

## CI

`.github/workflows/rfmedia-cli.yml` runs the suite at reduced scales (`RFMEDIA_BENCH_SCALES=10,100`)
on PRs touching the package. Shared CI runners are too noisy for automated regression gating, so the
CI job is a smoke check that the suite stays executable; compare absolute numbers only between runs
on the same machine.

Content-hashing overhead remains a manual evidence workflow. Do not add a wall-clock threshold to CI:
runner scheduling, page-cache state, CPU frequency scaling, and fixed case order can dominate these
short measurements. A future acceptance run should alternate or randomize case order, increase case
duration and repetitions, control CPU policy, and use an otherwise idle host.

## Tracking baselines over time

To record a baseline for later comparison:

```bash
RFMEDIA_BENCH_SCALES=full npm run bench 2>&1 | tee bench-$(date +%Y%m%d).txt
```

Compare `hz` and `mean` columns between runs on the same hardware.

## Memory usage

`benchmarks/memory-probe.ts` complements the timing benchmarks: it runs each operation once per
scale while sampling `process.memoryUsage()`, reporting peak heap/RSS deltas and retained heap per
operation.

```bash
# Same RFMEDIA_BENCH_SCALES variable as the timing suite
npm run bench:memory --workspace packages/rfmedia-cli

# Cleaner baselines with explicit GC between probes
NODE_OPTIONS=--expose-gc npm run bench:memory --workspace packages/rfmedia-cli
```

For deeper investigation of anything the probe surfaces, use `node --inspect` heap snapshots.

## Implementation notes

- Benchmarks live in `packages/rfmedia-cli/benchmarks/`, outside `src/`, and are excluded from the
  published build; they are typechecked via `benchmarks/tsconfig.json` as part of
  `npm run typecheck`.
- Vitest benchmark mode does not execute `beforeAll`/`afterAll` hooks, so fixtures are created with
  top-level `await` and removed by a process-exit hook (`registerBenchCleanup()` in `helpers.ts`).
- CLI output (spinners, progress bars, `[INFO]` logs) is silenced by switching the shared logger to
  machine-output mode (`setJsonMode(true)`).
