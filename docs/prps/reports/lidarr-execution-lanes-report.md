---
title: Lidarr Execution Lanes Implementation Report
date: 07/22/2026
original-plan: docs/prps/plans/completed/lidarr-execution-lanes.plan.md
---

## Overview

Implemented four fault-isolated Lidarr execution lanes with validated per-lane concurrency,
operation budgets, retry limits, and delay caps. A reusable scheduler now owns retries for scheduled
work. Gated batches require the shipped health/circuit preflight, while the existing resilient
client retains per-attempt gates, circuit state, cache, and stale fallback. The four current read
actions use the local-only lane and surface additive execution and failure metadata in human and
machine output without adding CLI flags or subcommands.

## Files Changed

### Created

- `docs/prps/specs/lidarr-execution-lanes.spec.md`: Accepted issue #196 design and requirements.
- `docs/prps/plans/completed/lidarr-execution-lanes.plan.md`: Validated implementation plan.
- `docs/prps/reports/lidarr-execution-lanes-report.md`: Implementation and validation record.
- `docs/prps/reviews/local-20260722-162316-review.md`: Structured pre-publication review.
- `docs/prps/reviews/fixes/local-20260722-162316-fixes.md`: Applied review-fix audit trail.
- `docs/prps/reviews/local-20260722-164057-review.md`: Focused re-review after the first fixes.
- `docs/prps/reviews/fixes/local-20260722-164057-fixes.md`: Applied re-review fix audit trail.
- `docs/prps/reviews/local-20260722-164638-review.md`: Clean final pre-publication review.
- `docs/prps/reviews/pr-257-review.md`: Clean review of the published pull-request diff.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Operator and maintainer guide.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Lane scheduler, policies, results, retries, and metadata lookup.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`: Isolation, ordering, budget, retry, abort, and safety coverage.

### Modified

- `ROADMAP.md`: Marks issue #196 shipped and keeps mutation/discovery follow-ups open.
- `rfmedia.example.yaml`: Documents optional scheduler lane overrides and defaults.
- `packages/rfmedia-cli/README.md`: Links and summarizes the execution-lane contract.
- `packages/rfmedia-cli/src/types/config.ts`: Adds typed scheduler configuration.
- `packages/rfmedia-cli/src/types/index.ts`: Exports the new configuration types.
- `packages/rfmedia-cli/src/lib/config.ts`: Validates scheduler objects and bounded integer fields.
- `packages/rfmedia-cli/src/lib/config.test.ts`: Covers valid, invalid, bounded, and unknown configuration.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Exports and process-shares the configured scheduler.
- `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`: Covers scheduler resolver defaults, sharing, and invalidation.
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`: Distinguishes hinted overload 503 from plain 503.
- `packages/rfmedia-cli/src/lib/lidarr/errors.test.ts`: Pins overload and reachability classification.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Adds the scheduler-owned retry override.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`: Proves zero inner retries without changing other resilience behavior.
- `packages/rfmedia-cli/src/actions/lidarr/status.ts`: Schedules the status action and returns execution metadata.
- `packages/rfmedia-cli/src/actions/lidarr/status.test.ts`: Covers lane integration and preserved output.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`: Schedules listing while preserving filters and cache status.
- `packages/rfmedia-cli/src/actions/lidarr/list.test.ts`: Covers lane, cache, filter, and resolver behavior.
- `packages/rfmedia-cli/src/actions/lidarr/wanted.ts`: Schedules the wanted page read.
- `packages/rfmedia-cli/src/actions/lidarr/wanted.test.ts`: Covers lane and pagination integration.
- `packages/rfmedia-cli/src/actions/lidarr/health.ts`: Schedules diagnostics without changing exit semantics.
- `packages/rfmedia-cli/src/actions/lidarr/health.test.ts`: Covers lane, health, and resilience snapshots.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Renders human summaries and structured machine failures.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: Covers success metadata, classified failures, streams, and exits.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Proves scheduler controls remain config-only in all shells.

## New Features

**Independent execution lanes**: `local-only`, `metadata-dependent`, `discovery`, and `destructive`
use separate process-shared admission pools so one failure domain cannot consume another's capacity.

**Bounded batches**: Each lane has a validated operation budget, ordered structured results, and
aggregate admitted/succeeded/failed/skipped/attempt totals.

**Single retry owner**: Scheduled actions disable resilient-client retries; the scheduler retries
only eligible idempotent non-destructive work with bounded backoff and exact supported
`Retry-After` delays.

**Mandatory gated preflight**: A non-empty metadata-dependent batch requires one typed preflight
adapted from `ensureTierHealthy`; missing or rejected gates settle safely before task closures run.

**Clear overload classification**: HTTP 429 and hinted 503 responses are rate-limited; plain 503
responses remain local Lidarr unavailability.

**Additive observability**: Successful results expose `execution`, while human and machine failures
include lane, attempts, classification, HTTP status, retryability, and retry-after metadata.
CSV success output uses flat dot-path columns and JSON-encoded compound cells so the shared CSV
serializer retains lane metadata without exceeding its nesting limit.

**Config-only tuning**: Operators can override any lane policy in `lidarr.scheduler.lanes`; the
existing command and completion surfaces remain unchanged.

## Additional Notes

- No package dependency, database migration, generated Lidarr file, or child issue was required.
- Future metadata-dependent callers must supply the scheduler preflight through
  `createLidarrSchedulerPreflight` and use the matching resilient-client tier so the batch gate runs
  once before admission and the existing per-attempt gate remains active.
- Future mutation/discovery/search commands remain owned by their existing follow-up issues; no
  automatic deferred replay was introduced.
- The PRP worktree already existed before plan execution, so the generic plan setup/move helpers
  were not rerun. Two prescribed research dispatches timed out; the plan records the direct
  codebase and existing Lidarr research used instead.
- `graphify update .` rebuilt the ignored local graph to 6,665 nodes, 19,446 edges, and 158
  communities; graph outputs are not part of the commit.
- `npm run lint` completes all workspace typechecks, then hits repository-baseline Markdown errors
  in `docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md`. After the required
  graph refresh, the local run also sees ignored `graphify-out/GRAPH_REPORT.md` formatting noise;
  that file is not part of a fresh checkout or this commit. All 12 Markdown files changed for
  #196 pass `markdownlint-cli2 --no-globs` with zero errors.
- The user-global Git `core.whitespace` includes `indent-with-non-tab`, which rejects normal
  Prettier spaces. Content hygiene passes with the repository-appropriate
  `git -c core.whitespace=trailing-space,space-before-tab diff --check`.

## Validation

- Generated client/tooling: 28 tests passed; drift and architecture checks passed.
- Focused issue suite: 399 tests passed across 11 files.
- Full rfmedia coverage: passed; `scheduler.ts` reached 82.88% statements and 79.38% branches.
- Workspace tests: rfmedia passed 2,540 tests across 97 files; rfapps passed 1,317 and skipped 2
  across 76 files.
- Workspace build: common, rfmedia, and rfapps passed.
- Formatting: repository-wide Prettier check passed.
- Completion parity: 23 tests passed; Bash, Zsh, and Fish generated successfully.
- Manual command check: `rfmedia lidarr --help` retained exactly status/list/wanted/health.

## E2E Tests To Perform

### Test 1: Local-Only Success Metadata

**Steps:**

1. Configure a reachable Lidarr instance.
2. Run `rfmedia --json lidarr status`.
3. Run `rfmedia lidarr list` in text mode.

**Expected Result:** The JSON result contains `execution.lane: local-only`, `outcome: succeeded`,
and a positive attempt count. Text output ends with the same lane and attempt count on stderr.

**Edge Cases:** Repeat with an empty library and with `--allow-stale`; domain and cache fields remain
present alongside execution metadata.

### Test 2: Classified Machine Failure

**Steps:**

1. Point `--lidarr-url` at an unavailable local endpoint.
2. Run `rfmedia --json lidarr status`.

**Expected Result:** Stdout contains one error envelope with exit code 1, `lane: local-only`,
`outcome: failed`, the final attempt count, and `failureType: lidarr-unreachable`. Human log lines do
not contaminate stdout.

**Edge Cases:** Verify a validation/configuration failure reports one attempt and does not retry.

### Test 3: Retry-After Overload

**Steps:**

1. Use a test Lidarr proxy that returns 429 or 503 with a delta-seconds `Retry-After`.
2. Run a read command with a hint below the configured lane delay cap.
3. Repeat with a hint above the cap.

**Expected Result:** The in-cap request waits exactly the hint and consumes one scheduler retry. The
over-cap request fails immediately with `rate-limited` and includes `retryAfterSeconds`.

**Edge Cases:** A 503 without `Retry-After` reports `lidarr-unreachable`.

### Test 4: Lane Isolation and Budget

**Steps:**

1. Submit concurrent test batches to local-only and metadata-dependent lanes.
2. Saturate the metadata lane and exceed its operation budget.
3. Abort while one same-lane task is queued.

**Expected Result:** Local-only work reaches its independent concurrency, budget overflow is ordered
and skipped, and queued aborted work settles without invoking its closure.

**Edge Cases:** Submit simultaneous batches to the same lane and confirm their combined active count
never exceeds the configured lane concurrency.
