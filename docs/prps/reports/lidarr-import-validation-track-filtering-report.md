---
title: Lidarr Import Validation and Track Filtering Implementation Report
date: 07/25/2026
original-plan: docs/prps/plans/completed/lidarr-import-validation-track-filtering.plan.md
---

## Overview

Implemented read-only pre-import validation using Lidarr's manual-import matcher and an exact,
album-scoped trackfile retention workflow using the existing sealed plan/apply engine. The design
keeps generated transport details behind `LidarrClientApi`, preserves uncertain files, defaults to
preview, and dispatches deletion only through Lidarr's bulk trackfile endpoint after owned exact-state
admission. Bash, Zsh, Fish, documentation, architecture contracts, and the Layer 1 roadmap are kept
in parity.

## Files Changed

### Created

- `docs/prps/specs/lidarr-import-validation-track-filtering.spec.md`: Approved revised defaults.
- `docs/prps/plans/completed/lidarr-import-validation-track-filtering.plan.md`: Completed plan.
- `docs/prps/reviews/local-20260725-201343-review.md`: Local review and fixed findings.
- `docs/prps/reviews/fixes/local-20260725-201343-fixes.md`: Review-fix audit trail.
- `packages/rfmedia-cli/docs/features/lidarr-import-validation-track-filtering.md`: User guide.
- `packages/rfmedia-cli/src/types/lidarr-import-validation.ts`: Stable validation report model.
- `packages/rfmedia-cli/src/actions/lidarr/validate-import.ts`: Read-only classification action.
- `packages/rfmedia-cli/src/actions/lidarr/validate-import.test.ts`: Classification regressions.
- `packages/rfmedia-cli/src/commands/lidarr-import-validation.ts`: CLI and output projections.
- `packages/rfmedia-cli/src/commands/lidarr-import-validation.test.ts`: Output and exit-gate tests.
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`: Sealed plan contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts`: Integrity tests.
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`: Fail-closed retention planner.
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`: Selection tests.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts`: Exact apply lifecycle.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.test.ts`: Apply regressions.
- `packages/rfmedia-cli/src/commands/lidarr-track-filter.ts`: Preview/write plan command.

### Modified

- `packages/rfmedia-cli/src/types/lidarr.ts`: Manual-import, track, and trackfile projections.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Trackfile-filter plan/result/history unions.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Strict wire projectors and selected release MBID.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Stable read and bulk-delete facade methods.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Facade query/body/projection coverage.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Resilient facade parity.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`: Exact read-retry allowlist contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: V2 parsing, validation, and persistence routing.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Trackfile-filter apply routing.
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: End-to-end plan/apply coverage.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public action exports.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Client mock parity.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Command registration and authorization.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: CLI contract coverage.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review/apply presentation.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Bash parity.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Zsh parity.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Fish parity.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Cross-shell parity tests.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Bulk-delete ownership rule.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`: Architecture regression.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Required endpoint/operation contracts.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`: Codegen contract coverage.
- `packages/rfmedia-cli/README.md`: Command discovery.
- `ROADMAP.md`: Post-merge Layer 1 state and open-count projection.
- `docs/roadmap-archive.md`: Layer 1 archive entry.

## New Features

**Read-only import validation**: `lidarr validate-import <folder>` exposes Lidarr's own mapping and
rejection evidence as deterministic human, JSON, or CSV reports with optional automation gates.

**MusicBrainz conflict protection**: Available parsed artist, album, release, recording, and track
identities are compared with selected Lidarr resources; mismatches are ambiguous.

**Fail-closed retention**: Explicit keep IDs and optional embedded-rating thresholds form a union,
while missing, unreadable, unrated, unmapped, ambiguous, and cross-parent records are retained.

**Sealed trackfile deletion**: `lidarr plan track-filter` previews by default and writes an exact,
origin-bound plan only with `--out`; apply requires `--allow-file-delete`.

**Owned admission and verification**: Non-dry-run apply claims the plan before exact parent/path/size
admission, sends one non-retryable bulk delete, and performs bounded absence verification.

**Completion parity**: Bash, Zsh, and Fish expose both commands, their positional values, enum values,
numeric values, and output paths.

## Additional Notes

- No new package or configuration dependency was added.
- The validator never submits a manual import.
- The filter never deletes directly from the filesystem and makes no trash or recovery guarantee.
- Rating reads occur only when `--min-stars` is supplied and uncertain reads retain the file.
- Explicit `--resume` attributes complete target absence without redispatch, per the revised default.
- The root aggregate typecheck also enters the unrelated `rfapps` workspace, whose current shared
  dependency tree lacks `ipaddr.js`; scoped `rf-common` and `rfmedia` typechecks pass.

## E2E Tests To Perform

### Test 1: Validate a complete and conflicting import folder

1. Run `rfmedia lidarr validate-import <folder> --json`.
2. Repeat with media whose parsed MusicBrainz IDs conflict with Lidarr's selected release.
3. Repeat with `--fail-on ambiguous`.

**Expected result:** Complete matches report `ready`; conflicting evidence reports `ambiguous`; the
failure gate changes the exit status only after the complete report is written.

### Test 2: Preview and seal a retention union

1. Run `rfmedia lidarr plan track-filter --album-id N --keep-track-ids 1,2 --min-stars 3`.
2. Review retained tracks, candidates, warnings, and risk text.
3. Repeat with `--out /private/path/plan.json`.

**Expected result:** Preview writes no artifact; the sealed plan contains only exact certain
candidates, and explicit IDs win over the rating threshold.

### Test 3: Apply exact deletion

1. Run `rfmedia lidarr apply --plan /private/path/plan.json --dry-run`.
2. Run without `--allow-file-delete` and confirm authorization is refused.
3. Run with `--allow-file-delete` and confirmation.

**Expected result:** Admission rejects drift; an authorized run sends one Lidarr bulk-delete request,
verifies every planned ID absent, and records terminal history.

### Test 4: Verify fail-closed edge cases

1. Include an unreadable rating file, an unmapped trackfile, and a cross-parent track record.
2. Generate the track-filter preview.

**Expected result:** Each uncertain record is retained with a warning while safe same-parent
candidates remain reviewable.
