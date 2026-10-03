<!-- markdownlint-disable MD026 -->

# Task Structure Analysis:

<!-- markdownlint-enable MD026 -->

## Executive Summary

Implement issue #200 as six dependency-aware tasks in four mergeable batches. The first batch
separates the Lidarr facade from the sealed plan contract so both can progress without overlapping
file ownership; planning follows the contract, apply joins both foundations, and the final batch
adds the command surface, presentation, completions, and public documentation.

The critical path is contract → planning → apply → command/presentation. Artist deletion remains
inside issue #200, while album deletion remains issue #223; no child issue is required. Keep facade,
contract, and apply ownership isolated because each area has a different safety boundary: generated
request serialization, immutable reviewed intent, and durable destructive execution.

## Recommended Phase Structure

### Batch 1: Independent Foundations

#### Task 1A — Add the narrow Lidarr artist-delete facade

- **Owner files**:
  - `packages/rfmedia-cli/src/lib/lidarr/client.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/errors.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/errors.test.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
  - `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- **Actions**:
  - Add `LidarrClientApi.deleteArtist(artistId, deleteFiles, signal?)`.
  - Validate the positive safe-integer ID and boolean before transport.
  - Call generated `deleteApiV1ArtistById` with explicit `deleteFiles` and
    `addImportListExclusion: false`; use the existing empty/void response path.
  - Preserve generated-code privacy and the single authenticated transport owner.
  - Add a typed `not-found` classification for authoritative 404 responses without weakening
    authentication, authorization, timeout, cancellation, or transport errors.
  - Forward the facade method through the resilient client, but keep delete dispatch outside the
    in-place retry allowlist.
- **Output**: A tested single-artist delete primitive and reliable typed absence signal, with no
  upper-layer generated imports and no handwritten API route.
- **Dependencies**: None.
- **Risk**: Medium; an incorrect 404 classification or retry policy would invalidate apply safety.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/lib/lidarr/client.test.ts packages/rfmedia-cli/src/lib/lidarr/errors.test.ts packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`

#### Task 1B — Extend the strict v2 plan contract

- **Owner files**:
  - `packages/rfmedia-cli/src/types/lidarr-plan.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- **Actions**:
  - Add closed `artist-delete` operation, source, entry, summary, evidence, observed-state, risk,
    authorization, scan-result, and durable possible-dispatch history shapes.
  - Seal plan-wide `deleteFiles`, per-entry path/count/byte evidence, `{ exists: false }`,
    deterministic stable-ID ordering, aggregate totals, high-risk facts, and idempotency keys.
  - Extend canonicalization, checksum material, exact-key parsing, correlation validation, history
    validation, and resume selection while preserving v1 and existing v2 canonical bytes.
  - Make deferred execution capability explicit in the operation registry and mark
    `artist-delete` non-deferable; do not register it with the SQLite deferred-intent subsystem.
  - Model present/absent observation without synthesizing a placeholder `LidarrArtist`.
- **Output**: A round-trippable, tamper-evident v2 deletion artifact and safe durable history model.
- **Dependencies**: None.
- **Risk**: High; checksum compatibility, strict parsing, and resume evidence are safety-critical.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

### Batch 2: Planning Slice

#### Task 2A — Build file-aware artist-delete plans

- **Owner files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/index.ts`
- **Actions**:
  - Reuse `selectLidarrArtists()` for exactly one of IDs, AND-combined filters, or explicit
    `--all`; retain zero-match rejection, stable ordering, and whole-cohort `--max-batch`
    enforcement without truncation.
  - Resolve one fresh complete artist snapshot and fail closed unless every selected artist has a
    non-empty terminal-safe path and non-negative safe-integer album, track-file, and byte counts.
  - Build the strict v2 operation with keep-files as the default and delete-files only when
    explicitly selected.
  - Return the complete in-memory plan for planning dry-run but skip artifact creation.
  - Export the action and public action types through the existing Lidarr action barrel.
- **Output**: A Commander-independent planning action that creates complete reviewed evidence and
  performs no filesystem traversal or deletion.
- **Dependencies**: Task 1B.
- **Risk**: Medium; coercing incomplete statistics to zero would understate destructive impact.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`

### Batch 3: Destructive Apply State Machine

#### Task 3A — Execute, verify, persist, and resume artist deletion

- **Owner files**:
  - `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay-reconciliation.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- **Actions**:
  - Require `--allow-artist-delete` for every real deletion apply and additionally require
    `--allow-file-delete` for delete-files plans; keep these independent from `--yes` and enforce
    them on resume.
  - During whole-plan preflight, require every pending target to exist and match sealed
    path/count/byte evidence before any mutation.
  - Immediately before each dispatch, reread the target and recheck evidence.
  - Persist matching possible-dispatch evidence while the claim is owned, then send one
    non-idempotent single-ID delete in sealed order with no automatic retry.
  - Treat only typed not-found after this plan's possible dispatch as verified success. Classify
    initial absence as stale, and stop later admission on drift, lost claim, failed verification,
    cancellation after possible dispatch, or any uncertain result.
  - Use durable attempt evidence to reconcile resume without blindly resending. Ensure deletion is
    never enqueued, matched, or replayed by generic deferred-intent handling.
  - Preserve dry-run as read/classification only: no claim, history, SQLite initialization,
    Lidarr mutation, file effect, or Plex scan.
  - After durable entry results, optionally resolve `MediaServerAdapter` and run at most one full
    Plex scan only for a newly verified delete-files success with non-zero reviewed file impact.
    Report scan absence/failure separately without changing or replaying deletion outcomes.
- **Output**: Sequential, attributable artist deletion with verified absence, durable recovery,
  stop-admission semantics, and isolated optional Plex follow-up.
- **Dependencies**: Tasks 1A and 1B; Task 2A provides representative plan fixtures.
- **Risk**: High; dispatch certainty, history timing, and absence semantics determine whether
  resume can duplicate an irreversible operation.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

### Batch 4: User Surface and Parity

#### Task 4A — Register commands and render review/recovery output

- **Owner files**:
  - `packages/rfmedia-cli/src/commands/lidarr.ts`
  - `packages/rfmedia-cli/src/commands/lidarr.test.ts`
  - `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
  - `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.test.ts`
- **Actions**:
  - Register `rfmedia lidarr plan artist-delete` in the pinned child-command order.
  - Reuse artist selector and plan safety options; add `--delete-files`, planning `--dry-run`, and
    action forwarding.
  - Add apply flags `--allow-artist-delete`, `--allow-file-delete`, and `--plex-scan`.
  - Present keep-files/delete-files mode, artist path, album count, track-file count, exact bytes,
    formatted size, totals, and irreversible-risk language in human output.
  - Preserve full exact evidence in JSON/YAML and add stable deletion columns in CSV without
    changing existing-operation projections.
  - Render per-target outcomes and scan status independently, and emit a pinned resume command
    containing all authorization flags required by the plan.
- **Output**: Complete CLI entry points and consistent human/machine review, prompt, result, and
  recovery behavior.
- **Dependencies**: Tasks 2A and 3A.
- **Risk**: Medium; a missing forwarded authorization flag or incomplete recovery command could
  bypass or obstruct the reviewed workflow.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/commands/lidarr.test.ts packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.test.ts`

#### Task 4B — Synchronize Bash, Zsh, and Fish completions

- **Owner files**:
  - `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
  - `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
  - `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
  - `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- **Actions**:
  - Add `artist-delete` detection, description, selection options, delete mode, plan dry-run, plan
    file, connection/output options, and the three new apply flags to all templates.
  - Preserve pinned hierarchy/order and assert exact Bash/Zsh/Fish parity.
- **Output**: All supported shells expose the shipped command and safety flags consistently.
- **Dependencies**: Task 4A defines the final command surface.
- **Risk**: Low; templates are hand-maintained and order-sensitive.
- **Minimal validation**:
  `npx vitest run packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

#### Task 4C — Publish operator documentation and roadmap status

- **Owner files**:
  - `packages/rfmedia-cli/README.md`
  - `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
  - `ROADMAP.md`
- **Actions**:
  - Document selector exclusivity, keep-files default, file-impact evidence, layered authority,
    planning/apply dry-run behavior, drift rules, verified absence, partial recovery, and optional
    Plex scan eligibility/failure isolation.
  - Include concrete plan, apply, dry-run, delete-files, and resume command examples.
  - Update issue #200 roadmap status while retaining album deletion under issue #223; create no
    child issue.
- **Output**: Operator-facing behavior and roadmap ownership match the implemented CLI.
- **Dependencies**: Task 4A defines exact syntax and output.
- **Risk**: Low; stale examples can still cause unsafe operator assumptions.
- **Minimal validation**:
  `npx prettier --check packages/rfmedia-cli/README.md packages/rfmedia-cli/docs/features/lidarr-plan-apply.md ROADMAP.md`

## Task Granularity

- Each task owns a coherent safety boundary and can be reviewed with its focused tests.
- Tasks 1A and 1B are the only parallel foundation tasks. They deliberately do not share files.
- Task 2A is small enough to validate planning independently before destructive execution exists.
- Task 3A remains one integrated task because preflight, durable attempt evidence, dispatch,
  verification, stop-admission, resume, and scan eligibility form one state machine; splitting
  these across owners would create unsafe intermediate contracts.
- Task 4A keeps Commander registration and presenter behavior together because prompt, forwarding,
  exit status, structured output, and recovery command must agree.
- Tasks 4B and 4C may run in parallel after Task 4A, with disjoint completion and documentation
  ownership.
- Generated SDK files, `artist-selection.ts`, SQLite migrations, local filesystem helpers, and
  album-delete surfaces are explicitly out of scope.

## Dependency Analysis

```text
Batch 1
  Task 1A facade ───────────────┐
                                ├─> Task 3A apply state machine ─> Task 4A command/presenter
  Task 1B contract ─> Task 2A ──┘                                  ├─> Task 4B completions
                                                                  └─> Task 4C docs/ROADMAP
```

- **Critical path**: Task 1B → Task 2A → Task 3A → Task 4A → Tasks 4B/4C.
- **Parallel opportunity**: Task 1A runs alongside Task 1B; Tasks 4B and 4C run alongside one
  another after the command syntax stabilizes.
- **Integration checkpoint after Batch 1**: The facade exposes explicit delete query semantics,
  while the strict plan engine can round-trip and reject tampered deletion plans.
- **Integration checkpoint after Batch 2**: Planning produces deterministic file-aware artifacts
  and preview mode produces no file.
- **Integration checkpoint after Batch 3**: Focused apply tests prove layered authority,
  whole-plan/JIT drift checks, one-at-a-time mutation, typed absence verification, uncertain-stop,
  durable resume, no deferred replay, dry-run purity, and Plex isolation.
- **Final critical validation**:
  - `npm run typecheck`
  - `npm run build:all`
  - `npm run test --workspace packages/rfmedia-cli`
  - `npm run check:architecture --workspace packages/rfmedia-cli`
  - `git diff --check`

## File-to-Task Mapping

| Task           | Exclusive production ownership                                                                                                                                                                         | Exclusive test/document ownership                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 1A facade      | `client.ts`, `errors.ts`, `resilience.ts`, shared Lidarr client mocks                                                                                                                                  | `client.test.ts`, `errors.test.ts`, `resilience.test.ts`                                                  |
| 1B contract    | `types/lidarr-plan.ts`, `plan-operation-definitions.ts`, `plan-engine.ts`                                                                                                                              | `plan-engine.test.ts`                                                                                     |
| 2A planning    | `plan-artist-delete.ts`, `actions/lidarr/index.ts`                                                                                                                                                     | `plan-artist-delete.test.ts`                                                                              |
| 3A apply       | `apply.ts`, `apply-target-types.ts`, `apply-entry-execution.ts`, `apply-artist-entry-execution.ts`, `apply-target-execution.ts`, `apply-deferred-replay.ts`, `apply-deferred-replay-reconciliation.ts` | `apply.test.ts`                                                                                           |
| 4A command     | `commands/lidarr.ts`, `lidarr-mutation-presenter.ts`                                                                                                                                                   | `lidarr.test.ts`, `lidarr-mutation-presenter.test.ts`                                                     |
| 4B completions | `shell-completions/bash.ts`, `zsh.ts`, `fish.ts`                                                                                                                                                       | `shell-completions/templates.spec.ts`                                                                     |
| 4C docs        | None                                                                                                                                                                                                   | `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, `ROADMAP.md` |

No file is assigned to more than one task. In particular, facade files belong only to Task 1A,
sealed contract/registry files only to Task 1B, and apply state-machine files only to Task 3A.
