# PR #258 Agent Review

- **Reviewed**: 2026-07-22
- **Base**: `origin/master`
- **Head**: `feat/202-lidarr-plan-apply`
- **Mode**: Parallel correctness and security review
- **Status**: Approved after fix

## Finding

### PR258-F001 — Public mutation facade did not enforce the 1,000-ID bound

- **Severity**: MEDIUM
- **Status**: Fixed
- **File**: `packages/rfmedia-cli/src/lib/lidarr/client.ts`

The plan/apply path already enforced the supported bound and dispatched one artist at a time, but
the exported `setArtistsMonitored()` facade could accept a larger array directly. The facade now
rejects more than `LIDARR_PLAN_MAX_ENTRIES` IDs before transport, with a regression proving that a
1,001-ID request never calls `fetch`; a second boundary test proves exactly 1,000 IDs reach the
transport intact.

### PR258-F002 — Global signal cleanup was not connected to Lidarr apply

- **Severity**: MEDIUM
- **Status**: Fixed
- **File**: `packages/rfmedia-cli/src/actions/lidarr/apply.ts`

The real command did not inject a signal, so SIGINT or SIGTERM could terminate the process before a
claimed deferred intent was restored and the plan lock released. Apply now bridges the global and
caller signals into a local controller and registers a shutdown barrier that waits for its existing
restoration and release finalizers.

### PR258-F003 — Same-plan applies could collide on cleanup handler names

- **Severity**: HIGH
- **Status**: Fixed
- **File**: `packages/rfmedia-cli/src/actions/lidarr/apply.ts`

The first signal fix keyed its cleanup handler only by plan ID. A losing concurrent invocation could
replace and then unregister the winner's handler. Each invocation now includes a UUID in its cleanup
name, and an overlapping same-plan regression proves the loser cannot remove the winner's barrier.

## Review Result

- Correctness review: finding fixed; final scoped diff review clean.
- Security review: no actionable findings.
- Independent code review of the two-file boundary fix: no actionable findings after the boundary
  acceptance test was added.
- PR-thread signal finding: fixed; final concurrency re-review found no actionable findings.

## Validation

- Focused Lidarr client suite: 27 tests passed.
- Focused Lidarr apply suite: 16 tests passed.
- Full rfmedia suite: 2,612 tests passed across 100 files.
- Full rfapps suite: 1,317 tests passed and 2 skipped.
- Typecheck, generated-client drift, and 24 architecture tests: passed.
- Workspace build and Prettier check: passed.
