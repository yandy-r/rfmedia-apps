# Content Hashing Copy Benchmark Results

## Conclusion

The current direct-copy evidence is **inconclusive** against the issue's `<5%` overhead target.
The median hash-enabled time was lower than the hash-disabled SQLite baseline in both fixture sets,
but the representative 80 MiB runs ranged from `-15.83%` to `+112.70%` paired overhead and therefore
crossed the target by a wide margin. The hash-disabled baseline also showed high within-run
variation. These results do not support claiming either a regression or a pass.

No wall-clock assertion should be added to CI. The historical single-run result in
`docs/prps/reports/content-hashing-during-copy-operations-report.md` is not sufficient acceptance
evidence because it did not report independent repetitions or spread.

## Method

Measured at `2026-07-18T18:01:21Z` from worktree commit
`7ec902af5ab304b663334df2f36da155907bbca9`, including the current uncommitted issue-hardening
changes. Each row invokes the same `executeAlbumCopy()` action with:

- SQLite tracking and inventory enabled;
- one worker and range `001-001`;
- forced overwrite of an isolated destination on every iteration;
- the same source fixture, database, filesystem, warmup, and minimum iteration settings;
- distinct baseline and hash-enabled destination directories; and
- `benchmarkDisableContentHashing = true` as the only behavioral difference in the baseline.

The two compared rows execute in a fixed order inside each Vitest process: hash-disabled baseline,
then hash-enabled inventory. Each independent run starts a new process and isolated temporary root.
Vitest/tinybench uses a 100 ms warmup and, at these scales, a minimum of three or five measured
iterations. Reported run values below are tinybench arithmetic means; spread across independent runs
is reported separately.

Commands:

```bash
# Three independent small-file process runs
RFMEDIA_BENCH_SCALES=1000 npm run bench --workspace=packages/rfmedia-cli -- copy.bench.ts

# Three independent representative-size process runs
RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=8388608 \
  npm run bench --workspace=packages/rfmedia-cli -- copy.bench.ts

# One separate whole-suite memory observation using the small-file fixture
/usr/bin/time -v env RFMEDIA_BENCH_SCALES=1000 \
  npm run bench --workspace=packages/rfmedia-cli -- copy.bench.ts
```

## Environment

| Item          | Value                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Host          | `ubsrv`, Linux `6.8.0-136-generic`, x86-64                                                                                 |
| CPU           | Intel Core i9-13900H, 14 cores / 20 logical CPUs                                                                           |
| CPU governor  | `powersave`; frequency scaling remained enabled                                                                            |
| Memory        | 62 GiB physical, 8 GiB swap configured                                                                                     |
| Node.js / npm | Node.js `v25.9.0`, npm `11.17.0`                                                                                           |
| Vitest        | `v4.0.17`; benchmark mode is marked experimental                                                                           |
| Filesystem    | Source, destinations, SQLite database, and worktree on the same `ext4` logical volume, mounted `rw,relatime`; 4 KiB blocks |
| Isolation     | No CPU pinning, cache dropping, thermal control, or exclusive-host reservation                                             |

All fixtures live below the system temporary directory. Results therefore include filesystem cache,
SQLite, directory traversal, overwrite/removal, and host scheduling effects. They are local evidence,
not portable hardware numbers.

## Small-File Repetitions

The default fixture contains 1,000 files of exactly 1,000 bytes each. This is useful for exposing
metadata and SQLite overhead, but it is not representative of media byte-copy cost.

| Run | Baseline mean (ms) | Hash mean (ms) | Baseline files/s | Hash files/s | Paired overhead | Baseline RME | Hash RME |
| --: | -----------------: | -------------: | ---------------: | -----------: | --------------: | -----------: | -------: |
|   1 |             355.57 |         293.13 |            2,812 |        3,411 |         -17.56% |       23.37% |   10.22% |
|   2 |             337.30 |         294.35 |            2,965 |        3,397 |         -12.73% |       45.35% |    4.11% |
|   3 |             291.16 |         294.52 |            3,435 |        3,395 |          +1.15% |       10.41% |    1.77% |

| Statistic         | Hash-disabled baseline |     Hash enabled |
| ----------------- | ---------------------: | ---------------: |
| Median mean time  |              337.30 ms |        294.35 ms |
| Min-max mean time |       291.16-355.57 ms | 293.13-294.52 ms |
| Median throughput |          2,965 files/s |    3,397 files/s |

The ratio of independent-run medians and median paired overhead are both `-12.73%`. That favorable
point estimate is not a pass: baseline RME reached `45.35%`, and the workload is dominated by
per-file metadata rather than media bytes.

## Representative-Size Repetitions

The benchmark-only `RFMEDIA_BENCH_TRACK_BYTES` fixture control was set to 8 MiB. Each run copied ten
files, or 80 MiB per action iteration. The default remains unchanged when the variable is absent.

| Run | Baseline mean (ms) | Hash mean (ms) | Baseline MiB/s | Hash MiB/s | Paired overhead | Baseline RME | Hash RME |
| --: | -----------------: | -------------: | -------------: | ---------: | --------------: | -----------: | -------: |
|   1 |            97.4071 |        89.7742 |          821.3 |      891.1 |          -7.84% |       63.99% |    7.81% |
|   2 |           109.2600 |        91.9621 |          732.2 |      869.9 |         -15.83% |       36.49% |    8.68% |
|   3 |            78.9942 |       168.0200 |        1,012.7 |      476.1 |        +112.70% |        8.34% |    2.85% |

| Statistic         | Hash-disabled baseline |        Hash enabled |
| ----------------- | ---------------------: | ------------------: |
| Median mean time  |             97.4071 ms |          91.9621 ms |
| Min-max mean time |    78.9942-109.2600 ms | 89.7742-168.0200 ms |
| Median throughput |            821.3 MiB/s |         869.9 MiB/s |

The ratio of independent-run medians is `-5.59%`, and the median paired overhead is `-7.84%`.
However, one stable run measured `+112.70%` overhead while the other two favored hashing. Fixed case
order, page-cache state, CPU frequency scaling, and an unreserved host can plausibly dominate these
short operations. Because the observed range crosses `+5%`, the acceptance result is inconclusive.

## Memory Observation

A separate `/usr/bin/time -v` small-file run reported a whole-process peak resident set of
`225,624 KiB` (about `220.3 MiB`) and zero process swaps. This peak covers fixture construction,
Vitest, SQLite, and every benchmark row; the harness cannot attribute incremental peak memory to the
hash-enabled row. It is recorded as a bound, not as evidence of equal per-variant memory use.

## Exclusions and Follow-Up

- Hardlink timing is deliberately excluded from the `<5%` direct-copy decision. The current
  standalone hardlink row is not a like-for-like tracked hash-disabled/hash-enabled pair.
- Conversion is not measured by this harness and is also excluded from the direct byte-copy target.
- A stronger follow-up would randomize or alternate case order, increase per-case duration and
  sample counts, pin CPU policy, and run on an otherwise idle host. This should remain a manual
  evidence workflow rather than a CI timing gate.
