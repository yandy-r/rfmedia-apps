# PR Re-review #239 — feat(rfapps): add managed update lifecycle

**Reviewed**: 2026-07-17T23:34:19Z
**Mode**: PR re-review
**Author**: @yandy-r
**Branch**: feat/148-managed-update-lifecycle → master
**Reviewed head**: `50524641d44430d30f7b45004fc962559283114b`
**Decision**: REQUEST CHANGES

## Worktree Setup

- **Parent**: `/home/yandy/.codex-worktrees/rfmedia-apps-issue-148/` (branch: `feat/148-managed-update-lifecycle`)

## Summary

The first review’s sixteen findings are materially improved and the pushed head passes CI, local typecheck/build, 1,060 tests, coverage, and the live Docker Compose smoke test. A fresh three-perspective re-review found four high- and three medium-severity cross-boundary defects that must be resolved before merge.

## Findings

### CRITICAL

_(none)_

### HIGH

- **[R001]** `packages/rfapps-cli/src/lib/managed-update.ts:252` — Approval binds the raw Compose file and image evidence, but not the fully resolved mutation-relevant service model; saved-plan apply also permits different environment sources. Changed interpolation can deploy unreviewed mounts, ports, privileges, networks, commands, or environment. [security, quality]
  - **Status**: Fixed
  - **Category**: Plan Integrity / TOCTOU
  - **Suggested fix**: Persist a secret-safe digest of the resolved selected-service configuration and compare it globally and immediately before each mutation; bind/reject saved-plan environment-source changes and add changed-env/volume/port tests.

- **[R002]** `packages/rfapps-cli/src/lib/health.ts:104` — Readiness drops the selected Docker environment when listing containers and guesses the Compose project from the directory, so remote authorities, top-level `name:`, `COMPOSE_PROJECT_NAME`, or custom names can falsely fail verification and trigger recovery. [correctness, security]
  - **Status**: Fixed
  - **Category**: Correctness / Authority
  - **Suggested fix**: Use Compose labels or Compose-scoped status through the same `envTool`, filter to the canonical Compose project, and test an injected authority plus a project name unrelated to the directory.

- **[R003]** `packages/rfapps-cli/src/lib/schema.sql:50` — Schema-first initialization of a real v2 database creates the new identity index before the v3 migration adds `image_id`, aborting with `no such column: image_id`. [quality]
  - **Status**: Fixed
  - **Category**: Database Migration
  - **Suggested fix**: Move identity-dependent index creation into the migration after conditional column creation and add an on-disk v2 `initializeDatabase()` test.

- **[R004]** `packages/rfapps-cli/src/lib/managed-update.ts:1489` — A cleanup or lock-release rejection in `finally` replaces an already completed lifecycle result before the action can persist its report. [security, quality]
  - **Status**: Fixed
  - **Category**: Reliability / Auditability
  - **Suggested fix**: Preserve completed lifecycle results and represent cleanup failures as bounded structured evidence or carry the result through a typed error so it is always persisted; test release/close/cleanup failures after success and recovery.

### MEDIUM

- **[R005]** `packages/rfapps-cli/src/actions/update.ts:181` — Docker authority fingerprinting hashes the configured context endpoint rather than an effective environment-injected `DOCKER_HOST`. [correctness, security]
  - **Status**: Fixed
  - **Category**: Authority Binding
  - **Suggested fix**: Probe and hash effective `DOCKER_HOST` inside the selected secrets environment independently of context inspection, without persisting its raw value.

- **[R006]** `packages/rfapps-cli/src/lib/docker.ts:1454` — Temporary override-file removal can throw after successful recreation; manual exact rollback then reports failure and skips identity verification even if the service was correctly restored. [quality]
  - **Status**: Fixed
  - **Category**: Error Handling
  - **Suggested fix**: Make cleanup best-effort without discarding the primary mutation result, or return separate cleanup evidence; add helper and manual rollback cleanup-failure tests.

- **[R007]** `packages/rfapps-cli/src/lib/managed-update.ts:152` — Raw unexpected exception messages are bounded but not centrally redacted before entering machine output and SQLite; artifact-only redaction occurs too late. [security]
  - **Status**: Fixed
  - **Category**: Secret Handling
  - **Suggested fix**: Redact before lifecycle-error construction and every database/output boundary; test bearer tokens, credentialed URLs, password assignments, and API-key diagnostics in JSON and SQLite.

### LOW

_(none)_

## Validation Results

| Check                 | Result                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| Type check            | Pass                                                                      |
| Formatting/whitespace | Pass                                                                      |
| Tests                 | Pass — 1,060 rfapps tests plus live Docker Compose smoke                  |
| Coverage              | Pass — 82.10% statements, 69.23% branches, 84.06% functions, 82.88% lines |
| Build                 | Pass                                                                      |
| GitHub CI             | Pass at reviewed head                                                     |

## Files Reviewed

- `packages/rfapps-cli/src/actions/update.ts` and `update.spec.ts` (Modified)
- `packages/rfapps-cli/src/actions/rollback.ts` and `rollback.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/docker.ts` and `docker.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/generations.ts` and `generations.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/health.ts` and `health.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts` and `lifecycle-lock.spec.ts` (Added)
- `packages/rfapps-cli/src/lib/managed-update.ts` and `managed-update.spec.ts` (Added)
- `packages/rfapps-cli/src/lib/migrations.ts` and `migrations.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-generator.ts` and `plan-generator.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/plan-storage.ts` and `plan-storage.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/schema.sql` (Modified)
- `packages/rfapps-cli/src/lib/service-status.ts` and `service-status.spec.ts` (Modified)
- `packages/rfapps-cli/src/lib/state-storage.ts` and `state-storage.spec.ts` (Modified)
- `packages/rfapps-cli/src/types/update.ts` (Added)
- `packages/rfapps-cli/src/managed-update.integration.spec.ts` (Added)
- `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts` (Added)
- All documentation, plan/research artifacts, CLI wiring, completion, schema, and tests listed in `docs/prps/reviews/pr-239-review.md`.
