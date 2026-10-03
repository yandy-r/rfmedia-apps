# PR Review #277 — feat(rfmedia): add Last.fm similar artist discovery

**Reviewed**: 2026-07-26T01:26:41Z
**Mode**: PR
**Author**: yandy-r
**Branch**: issue-203-lidarr-discovery → master
**Decision**: APPROVE

## Summary

The discovery and sealed-plan design is well covered, and the repaired artist-add dispatch
boundary now upholds its durability, scheduler, and recovery guarantees. All 11 findings are fixed,
the adversarial re-review is clean, and the repository-wide validation suite passes.

## Findings

### CRITICAL

- **[F001]** `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3124` — The possible-dispatch history writer fsyncs the temporary file and renames it, but never fsyncs the containing directory before reporting success. A crash or power loss after the artist POST can therefore lose the supposedly durable pre-dispatch record and permit a duplicate non-idempotent POST.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Open and fsync the validated parent directory after publishing the history file and before `appendLidarrPlanHistory` resolves, with platform-appropriate handling. Add an ordering test seam proving directory sync completes before `addArtist` can run.

### HIGH

- **[F002]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:43` — Root containment uses a raw string prefix, so a path such as `/music/../outside/Artist` is accepted as a child of `/music`. Reconciliation can consequently mark an artist stored outside the sealed root folder as satisfied.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Normalize and compare root and artist paths using the Lidarr host's path semantics, reject traversal and mixed-root forms, and require the normalized relative path to remain inside the normalized root. Add POSIX and Windows regression cases.

- **[F003]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts:384` — `possibly-dispatched` is persisted before scheduler health preflight and before the authoritative artist lookup. Known pre-POST failures are then recorded as ambiguous dispatches, permanently stranding a safe add.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Complete health gating and authoritative lookup before persisting possible-dispatch evidence, place the durable marker immediately before the sole POST, and distinguish proven pre-dispatch failures from post-dispatch uncertainty. Add health-preflight and lookup-failure tests proving retry remains safe.

- **[F004]** `packages/rfmedia-cli/src/actions/lidarr/apply.ts:1193` — The artist-add implementation adds a complete mutation workflow directly to an already large coordinator, making history, claim, cleanup, and recovery invariants difficult to audit.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Extract the artist-add apply workflow into a focused module with an explicit input/result contract, leaving `executeLidarrApply` responsible for shared validation, lifecycle setup, and kind-based dispatch.

- **[F005]** `packages/rfmedia-cli/src/actions/lidarr/apply.ts:1216` — A possible-dispatch resume performs full resource preflight before exact-MBID reconciliation. Stale or unavailable resources can therefore prevent the promised recovery path from determining whether the uncertain POST succeeded.
  - **Status**: Fixed
  - **Category**: Completeness
  - **Suggested fix**: On `resumePossibleDispatch`, acquire the claim and reconcile the exact MBID before resource admission checks because this path never sends another POST. Persist satisfied, drifted, absent, or unreadable state and add a regression test with stale resources.

- **[F006]** `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts:89` — The producer schedules a `metadata-dependent` task without the required scheduler preflight. The real scheduler rejects every `discover --add` handoff before `task.run`, while the permissive unit mock masks the failure.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Resolve a metadata-dependent `LidarrExecutionContext`, use its client in the task, and pass its preflight to `runSingle`. Keep the tier as a literal so the overload requires the third argument, and add a real-scheduler contract test.

- **[F007]** `packages/rfmedia-cli/src/lib/lidarr/resilience.ts:705` — `addArtist` uses the generic gated execution path after the scheduler already performed its preflight. The redundant network gate occurs after possible-dispatch evidence and can fail before the POST while leaving an ambiguous record.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Give scheduler-owned artist dispatch a no-retry, no-inner-gate path. Complete the one required health preflight before the durable marker, with no fallible network step between that marker and the POST.

### MEDIUM

- **[F008]** `packages/rfmedia-cli/src/actions/lidarr/discover.ts:131` — The handoff path duplicates credential and error-message redaction already used by the command failure renderer, and the copies have already diverged in control-character handling.
  - **Status**: Fixed
  - **Category**: Pattern Compliance
  - **Suggested fix**: Extract one pure redaction and control-character sanitization utility under `lib`, then use it from both the discovery handoff and command failure renderer with focused tests.

- **[F009]** `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts:98` — Exact-MBID planning downloads and projects the complete unpaged artist library even though the facade has a targeted `getArtistByForeignId` operation.
  - **Status**: Fixed
  - **Category**: Performance
  - **Suggested fix**: Replace `listArtists()` and its filter with `getArtistByForeignId(foreignArtistId)` while retaining the targeted facade's exact and ambiguous-response validation.

- **[F010]** `packages/rfmedia-cli/src/lib/discovery/lastfm.ts:34` — The provider boundary accepts any grouped hexadecimal UUID as a MusicBrainz ID, while plan and apply require a canonical UUID version and RFC variant. An invalid value is exposed as `exact-id` and fails only during handoff.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Reuse a canonical MusicBrainz UUID validator, lowercase only after validation, and add an atomic-response rejection test for a correctly grouped but invalid UUID.

### LOW

- **[F011]** `packages/rfmedia-cli/src/commands/lidarr-discover.ts:23` — The command duplicates discovery's default and maximum limits, creating two sources of truth for one CLI contract.
  - **Status**: Fixed
  - **Category**: Maintainability
  - **Suggested fix**: Move the discovery limit contract to a lightweight shared module imported by both command registration and the lazily loaded action.

## Validation Results

| Check      | Result |
| ---------- | ------ |
| Type check | Pass   |
| Lint       | Pass   |
| Tests      | Pass   |
| Build      | Pass   |

## Files Reviewed

- `ROADMAP.md` (Modified)
- `docs/README.md` (Modified)
- `docs/plans/lidarr-similar-artist-discovery/analysis-architecture.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/analysis-docs.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/analysis-integration.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/analysis-patterns.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/analysis-tasks.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/feature-spec.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/parallel-plan.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-business.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-external.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-practices.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-recommendations.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-security.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-technical.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/research-ux.md` (Added)
- `docs/plans/lidarr-similar-artist-discovery/shared.md` (Added)
- `docs/roadmap-archive.md` (Modified)
- `packages/rfmedia-cli/CHANGELOG.md` (Modified)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md` (Added)
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` (Modified)
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs` (Modified)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` (Modified)
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/discover.test.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts` (Added)
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` (Added)
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts` (Added)
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr.test.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr.ts` (Modified)
- `packages/rfmedia-cli/src/lib/config.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/config.ts` (Modified)
- `packages/rfmedia-cli/src/lib/discovery/lastfm.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts` (Modified)
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` (Modified)
- `packages/rfmedia-cli/src/types/config.ts` (Modified)
- `packages/rfmedia-cli/src/types/discovery.ts` (Added)
- `packages/rfmedia-cli/src/types/index.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr-plan.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr.ts` (Modified)
- `rfmedia.example.yaml` (Modified)
