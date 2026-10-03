# Tiered Verification Benchmark Results

## Conclusion

The independently confirmed warm-cache run achieved issue #116's 10× target for the tested
workload. Quick metadata verification measured `26.22×` the default stored-fingerprint rate and
`45.96×` the cumulative deep rate. The target is therefore met for this ten-file, 10 MiB fixture.

This result is local evidence, not a universal performance promise. It does not justify a timing
assertion in CI because cache state, storage, CPU scaling, thermal state, and host load can dominate
short benchmark cases. CI remains a smoke check that all three production tier rows execute.

## Method

Measured on July 19, 2026 from checkpoint
`d651dfd41bbc591e8c60966367b3c7790550b639`, the implementation checkpoint used by draft PR #249.
The exact command was:

```bash
RFMEDIA_BENCH_SCALES=10 RFMEDIA_BENCH_TRACK_BYTES=1048576 npm run bench:rfmedia
```

The verification fixture contained one artist, one album, and ten files of exactly 1 MiB each: 10
MiB of logical content per action iteration. Fixture creation copied range `001-001` once with
content hashing and SQLite inventory enabled. The producing database connection was closed before
measurement. Quick, default, and deep then used the same source paths, destination paths, bytes,
range, one-worker configuration, and unchanged database snapshot.

- **Quick** ran the production metadata-only path and did not open SQLite or read file content.
- **Default** resolved the exact stored final-artifact fingerprint and hashed destination content.
- **Deep** performed default verification first, then compared applicable source and destination
  bytes.

The rows ran in fixed quick/default/deep order. The benchmark did not drop filesystem caches between
warmup or measurement iterations, so the result is explicitly warm-cache evidence. At scale 10,
`benchOptionsFor()` configures a 100 ms warmup, one minimum warmup iteration, 500 ms measurement
time, and five minimum measured iterations. Tinybench may execute more samples until the configured
time elapses.

The confirmed summary retained the aggregate rate, observed sample count, and relative ratios, but
the default Vitest table did not emit p50 latency. Those medians are therefore recorded as
unavailable rather than inferred from the arithmetic mean rate. Mean time below is the reciprocal
of the reported Hz value.

## Environment

| Item          | Value                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Host          | Linux `6.8.0-136-generic`, x86-64                                                                                         |
| CPU           | Intel Core i9-13900H, 14 cores / 20 logical CPUs                                                                          |
| CPU governor  | `powersave`; frequency scaling remained enabled                                                                           |
| Memory        | 62 GiB physical, 8 GiB swap configured                                                                                    |
| Node.js / npm | Node.js `v25.9.0`, npm `11.17.0`                                                                                          |
| Vitest        | `v4.0.17`; benchmark mode is marked experimental                                                                          |
| Storage       | ADATA SX8200PNP NVMe SSD through LVM                                                                                      |
| Filesystem    | Source, destination, SQLite database, and worktree on the same `ext4` logical volume, mounted `rw,relatime`; 4 KiB blocks |
| Isolation     | No CPU pinning, cache dropping, thermal control, or exclusive-host reservation                                            |

Fixtures lived below the system temporary directory on the same filesystem as the worktree. The
result includes directory traversal, SQLite baseline lookup for content tiers, filesystem cache,
and ordinary host scheduling effects.

## Confirmed Results

| Tier    |  Rate (Hz) | Mean time (ms) | Files/s | Logical MiB/s | Samples | Configured minimum iterations | p50 median  |
| ------- | ---------: | -------------: | ------: | ------------: | ------: | ----------------------------: | ----------- |
| Quick   | 2,077.3000 |         0.4814 |  20,773 |           n/a |   1,039 |                             5 | unavailable |
| Default |    79.2307 |        12.6214 |     792 |         792.3 |      40 |                             5 | unavailable |
| Deep    |    45.2019 |        22.1230 |     452 |         452.0 |      23 |                             5 | unavailable |

Files/s is `Hz × 10 files`. Logical MiB/s for default and deep is `Hz × 10 MiB`. Quick is driven by
metadata operations and reads no content bytes, so a content MiB/s value would be misleading.

| Comparison       | Rate ratio | Result against 10× target |
| ---------------- | ---------: | ------------------------- |
| Quick vs default |     26.22× | Exceeds target            |
| Quick vs deep    |     45.96× | Exceeds target            |

The primary issue target compares quick metadata verification with cumulative deep verification;
the confirmed `45.96×` result exceeds that target for this workload. The default comparison is
included to make the cost of stored-fingerprint verification visible.

## Required Validation Run

Task 3.8's larger whole-suite validation also completed successfully at the same checkpoint:

```bash
RFMEDIA_BENCH_SCALES=25 RFMEDIA_BENCH_TRACK_BYTES=8388608 npm run bench:rfmedia
```

That run used 25 files of 8 MiB each, or 200 MiB of logical content per verification iteration.
All benchmark suites passed, including all three verification rows.

| Tier    | Rate (Hz) | Mean time (ms) | Samples | Files/s | Logical MiB/s |
| ------- | --------: | -------------: | ------: | ------: | ------------: |
| Quick   | 1,001.350 |         0.9986 |     501 |  25,034 |           n/a |
| Default |     4.658 |       214.6800 |       5 |     116 |         931.6 |
| Deep    |     3.172 |       315.2600 |       5 |      79 |         634.4 |

Vitest reported quick as `214.98×` the default rate and `315.68×` the deep rate in this validation
process. The content rows had only the configured five minimum samples and relatively high RME, so
these local values are corroborating executability evidence rather than a replacement for the
independently confirmed result above.

## Qualifications and Follow-Up

- This is one independently confirmed process run, not a distribution of independent repetitions.
  No min-max spread or cross-run median is claimed.
- The fixture uses ten 1 MiB files and warm caches. Results may differ materially for larger
  libraries, colder caches, remote filesystems, rotating media, or different worker counts.
- Logical MiB/s measures verified fixture content per second. Deep can physically read more than one
  fixture volume because it performs the default destination hash before direct comparison.
- Fixed row order can favor later rows through cache warming, although every row uses the same
  immutable fixture and receives Tinybench warmup.
- A stronger manual evidence run should repeat independent processes, retain p50/sample/RME output,
  vary representative media sizes and workers, and control CPU policy where practical.
- CI should continue to run reduced fixtures only as an executability smoke. No ratio or wall-clock
  threshold should be encoded in the workflow.
