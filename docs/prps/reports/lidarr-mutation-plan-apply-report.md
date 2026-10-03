---
title: Lidarr Mutation Plan/Apply Implementation Report
date: 07/22/2026
original-plan: docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md
---

## Overview

Implemented a sealed review/apply boundary for Lidarr mutations with exact-ID artist monitoring as
the first real producer. Planning is read-only; apply verifies a versioned secret-free artifact,
binds it to the canonical Lidarr origin, rechecks live state, requires explicit approval, executes
through the scheduler and narrow facade, and durably records each target. Retryable failures enter
the existing deferred queue and are replayed only by an explicit `apply --resume` invocation.

## Files Changed

### Created

- `docs/prps/specs/lidarr-mutation-plan-apply.spec.md`: Accepted issue #202 requirements and scope.
- `docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md`: Validated implementation plan.
- `docs/prps/reports/lidarr-mutation-plan-apply-report.md`: Implementation and validation record.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Operator workflow and security guide.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Plan, risk, drift, history, and result contracts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Artifact, checksum, claim, history, resume, and executor engine.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Security, determinism, history, claim, and executor tests.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`: Read-only exact-ID plan generation action.
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`: Planning, no-mutation, and unknown-target tests.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Drift-gated apply, history, deferral, and resume action.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: Check, approval, drift, history, and replay tests.

### Modified

- `ROADMAP.md`: Marks #202 shipped and promotes Layer 1 Lidarr commands.
- `docs/roadmap-archive.md`: Archives the shipped Lidarr resilience and mutation-safety milestone.
- `packages/rfmedia-cli/README.md`: Links and summarizes the plan/apply workflow.
- `packages/rfmedia-cli/src/types/index.ts`: Exports the Lidarr plan contracts.
- `packages/rfmedia-cli/src/lib/errors.ts`: Adds distinct artifact, validation, stale, and claim errors.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Adds validated artist-monitoring mutation support.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Covers request narrowing, 202 success, and input rejection.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Exports the engine and canonical-origin resolver.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Decorates the mutation without enabling in-place retries.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`: Adds exact bounded deferred-intent lookup for safe resume.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue-db.ts`: Adds SQLite-safe origin, operation, and idempotency-key filters.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.test.ts`: Covers bounded domain-level resume filtering.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue-db.test.ts`: Covers chunked exact-key database filtering.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Exports plan and apply actions.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Extends the typed client mock.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Adds plan/apply parsing, gates, rendering, and envelopes.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: Covers hierarchy, flags, approvals, and machine output.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Adds nested plan and apply completion.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Adds nested plan and apply completion.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Adds nested plan and apply completion.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Enforces three-shell parity.

## New Features

**Sealed desired-state artifacts**: `rfmedia.lidarr-plan.v1` stores canonical sorted targets,
expected and desired state, provenance, risk facts, batch cap, idempotency keys, and a SHA-256 seal
without credentials.

**Hardened artifact boundary**: Plan files use bounded no-follow reads, exact-key validation,
forbidden-key checks, private modes, exclusive temporary creation, and atomic no-overwrite linking.

**Read-only exact-ID planning**: `lidarr plan artist-monitoring` resolves current artists, rejects
unknown or duplicate IDs and cap overflow, records no-ops, and never invokes a mutation.

**Explicit apply gate**: `lidarr apply` confirms in interactive text mode; machine or non-TTY real
apply requires `--yes`, while `--dry-run` performs a zero-write live check.

**Drift and origin protection**: Apply rejects schema, checksum, version, operation, canonical-origin,
missing-artist, and unexpected-state drift before mutation; already-desired state is satisfied.

**Crash-safe progress and resume**: An ownership-token-safe per-plan claim prevents concurrent
application, bounded per-plan history is synced and compacted after every outcome, and `--resume`
skips durable success/satisfaction records.

**Explicit deferred replay**: Retryable writes are idempotently queued with a strict registered
executor; only a matching explicit resume pass replays them.

**Output and completion parity**: Text tables and JSON/YAML/CSV envelopes cover risk, identity,
counts, outcomes, lane, and status, with matching Bash, Zsh, and Fish surfaces.

## Additional Notes

- No dependency, database migration, generated-client edit, or child issue was required.
- The implementation uses the existing schema-v10 deferred-intent table and circuit state.
- Mutations are intentionally dispatched one target at a time through scheduler `runSingle`; this
  guarantees the durable history write completes before the next target is admitted.
- The shipped operation registry contains only the concrete artist-monitoring executor. #198–#201
  remain open and add their own selectors or operation definitions without bypassing this boundary.
- The CLI uses its established leaf-level `--dry-run` convention; this repository explicitly has no
  global dry-run option. Artifact output is named `--plan-file` to avoid collision with global
  machine-format `--output`.
- The generic code-report skill expected `docs/plans/<feature>/parallel-plan.md` and could not consume
  the PRP plan. This repository-native report was generated from the completed PRP artifact instead.
- Repository-wide Markdown lint reports 174 errors: four pre-existing bare URLs in
  `docs/prps/plans/completed/content-hashing-during-copy-operations.plan.md` plus generated
  `graphify-out/GRAPH_REPORT.md` formatting. All Markdown files created or modified for #202 pass
  `markdownlint-cli2 --no-globs`.

## Validation

- Focused plan/apply/deferred/facade/command safety matrix: 199 tests passed across 8 files.
- Completion parity: 24 tests passed for Bash, Zsh, and Fish.
- Full rfmedia suite: 2,612 tests passed across 100 files.
- Full workspace suite: rfmedia passed 2,612 tests; rfapps passed 1,317 and skipped 2.
- Generated client drift and architecture boundary: passed (16 generated files, 24 tests).
- Workspace build: common, rfmedia, and rfapps passed.
- Formatting: repository-wide Prettier check passed.
- Runtime help: both `lidarr plan artist-monitoring --help` and `lidarr apply --help` passed.

## E2E Tests To Perform

### Test 1: Review and Check a Real Plan

**Steps:**

1. Configure a reachable Lidarr instance with artist IDs 12 and 34.
2. Run `rfmedia lidarr plan artist-monitoring --ids 12,34 --unmonitored --plan-file ./review.json`.
3. Inspect `review.json`, then run `rfmedia lidarr apply ./review.json --dry-run`.

**Expected Result:** Planning lists current and desired state without a PUT request. The artifact
contains no credential, has private permissions and a valid checksum, and check mode reports
`would-apply` or `satisfied` without history writes.

**Edge Cases:** Include an unknown ID, duplicate ID, and target count above `--max-batch`; each must
fail before artifact creation.

### Test 2: Apply and Resume

**Steps:**

1. Apply the reviewed artifact interactively, or use `--yes` in automation.
2. Interrupt after at least one target completes.
3. Re-run with `--resume --yes`.

**Expected Result:** Completed targets are skipped, incomplete targets run once, and the final result
is `completed`. A second apply without `--resume` rejects the existing history.

**Edge Cases:** Run two applies concurrently; one must fail with the already-running claim without
issuing a mutation.

### Test 3: Drift and Target Binding

**Steps:**

1. Create a plan, then change one artist's monitoring state independently.
2. Run apply against that plan.
3. Repeat while pointing the CLI at a different Lidarr origin.

**Expected Result:** Unexpected state drift and origin mismatch both block all writes. If the artist
was independently changed to the exact desired state, apply records it as satisfied.

### Test 4: Deferred Retry

**Steps:**

1. Make the Lidarr artist-editor request fail with a retryable connection error.
2. Apply with `--yes`, restore Lidarr, and run `apply --resume --yes` after the retry is due.

**Expected Result:** The first pass records `deferred`; the resume pass invokes the strict executor,
marks the queue row succeeded, records target success, and does not replay from health or status.
