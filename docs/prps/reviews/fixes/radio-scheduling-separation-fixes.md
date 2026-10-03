# Fix Plan: Radio-Scheduling Separation

**Source**: `docs/prps/reviews/local-20260724-150655-review.md`
**Prepared**: 2026-07-24T15:06:55Z
**Severity threshold**: HIGH
**Status**: Complete

## Summary

- **Total findings in source**: 2
- **Eligible this run**: 2
- **Fix order**: Shared scheduler-state refactor, wider bounded search, regression/performance
  validation
- **Fixed this run**: 2
- **Failed this run**: 0

## Fixes

### F002: Precompute and maintain sequencing state

- Replace repeated normalization and prefix scans with prepared candidates containing normalized
  artist/genre sets, decade, and BPM band.
- Maintain current position, artist/genre last-seen maps, decade counts, and previous known BPM band
  in a small sequencing state.
- Scan remaining candidates once per placement and compare score/path without sorting.
- Rebuild state only after a bounded backtracking replacement.

### F001: Progressively widen bounded backtracking

- Search deterministic suffix windows of 4, 8, and 12 tracks, capped by the selected prefix.
- Retain a fixed branch width and node budget per window so the search remains bounded.
- Add the reported seven-track feasible catalog and require zero relaxations.
- Describe relaxation honestly as the outcome after bounded search cannot find a valid
  rearrangement, not proof that no global schedule exists.

## Validation

- Focused scheduler, config, playlist, and completion tests.
- A deterministic 1,000-track performance smoke with a generous non-flaky ceiling.
- rfmedia coverage and typecheck.
- Full build, formatting, markdownlint, repository-standard whitespace check, and Graphify update.
- Independent re-review with both source findings marked `Fixed`.

## Results

| ID   | Severity | Status | Evidence                                                     |
| ---- | -------- | ------ | ------------------------------------------------------------ |
| F001 | HIGH     | Fixed  | Seven-track feasible catalog completes with zero relaxations |
| F002 | HIGH     | Fixed  | Thousand-track focused suite completes in 83 ms              |

Independent re-review decision: **APPROVE** with no new findings.
