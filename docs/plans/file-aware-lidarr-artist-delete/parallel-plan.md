# File-Aware Lidarr Artist Delete Implementation Plan

Issue #200 adds an artist-only `artist-delete` operation to the existing strict Lidarr v2
plan/apply pipeline. The implementation seals Lidarr-reported path and file-impact evidence,
defaults to keeping files, requires cumulative destructive authorization, and verifies success
through a typed targeted absence after a durable possible-dispatch record. Deletes remain
single-ID, sequential, non-retried, and non-deferable; the optional Plex scan is an isolated
apply-time follow-up, and issue #223 retains all album-delete scope.

## Critically Relevant Files and Documentation

- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`: Authoritative final behavior and scope.
- `docs/plans/file-aware-lidarr-artist-delete/shared.md`: Architecture, file, pattern, and documentation map.
- `packages/rfmedia-cli/AGENTS.md`: Package architecture, TypeScript, testing, and validation rules.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Closed operation, entry, history, and result contracts.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Private generated-client facade and request boundary.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: V2 operation behavior registry.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Strict artifact, checksum, history, and claim engine.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Authorization, preflight, resume, and apply orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`: Just-in-time admission boundary.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Commander hierarchy and option forwarding.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Human and structured mutation output.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Canonical operator workflow documentation.
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`: Completion architecture and parity contract.
- `ROADMAP.md`: Issue status, architectural layer, and #223 ownership.

## Implementation Plan

### Phase 1: Safety Foundations

#### Task 1.1: Add the single-artist delete facade and typed absence Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`
- `packages/rfmedia-cli/src/lib/lidarr/errors.test.ts`

Add `LidarrClientApi.deleteArtist(artistId, deleteFiles, signal?)` and implement it only through
generated `deleteApiV1ArtistById`. Validate a positive safe-integer ID and a boolean before
transport; explicitly send both `deleteFiles` and `addImportListExclusion: false`, use the existing
void response path, and never handwrite the API route or use the bulk editor endpoint. Map an
authoritative targeted 404 to a typed `not-found` code without weakening authentication,
authorization, timeout, cancellation, or transport classifications. Focus tests on exact method,
path/query serialization for keep/delete modes, ignored response body, invalid inputs before
transport, signal forwarding, and the typed 404 boundary.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/lib/lidarr/client.test.ts packages/rfmedia-cli/src/lib/lidarr/errors.test.ts
```

#### Task 1.2: Forward deletion without adding retries Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`

Forward the new method through the resilient facade and shared action mocks, but keep deletion out
of every in-place retry allowlist. Preserve one caller-supplied signal and one underlying request.
Add only the critical structural and no-retry assertions needed to keep client implementations and
action tests type-correct.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts
```

#### Task 1.3: Define the strict artist-delete operation contract Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`

Add closed `artist-delete` source, operation, entry, summary, observed-state, authorization,
possible-dispatch history, and result shapes. Before changing the public apply result, inspect
every `LidarrApplyResult` consumer and structured serializer: use an additive optional
discriminated scan status only if it preserves all existing structured contracts; otherwise keep
scan status as a sanitized warning and assign its tests to Tasks 2.3 and 3.1. The plan-wide
operation seals `deleteFiles`; every entry seals a non-empty path, non-negative safe-integer
album/track-file/byte evidence, `{ exists: false }`, and an operation-bound idempotency key. Make
deferability an explicit operation capability so deletion cannot acquire a fake deferred executor.
Define operation-owned present/absent and exact path/statistics drift semantics while preserving
all existing operation behavior and exhaustive switches.

Validate with:

```bash
npm run typecheck --workspace packages/rfmedia-cli
```

#### Task 1.4: Extend strict artifacts, checksums, history, and resume Depends on [1.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

Extend exact-key parsing, canonicalization, checksum material, summary/risk correlation, history
validation, and resume selection for artist deletion. Preserve v1 and existing v2 canonical bytes.
Bind stable artist order, exact evidence totals, delete mode, high-risk cascade, expected absence,
and idempotency material. Add a durable per-entry `possibly-dispatched` boundary that can be
persisted before a delete request and later replaced by a terminal result; resume may attribute an
absent artist only when matching plan/checksum/entry/idempotency evidence proves this plan could
have dispatched it. Test round-trip, stable checksum/order, tampering and unknown-key rejection,
missing/invalid evidence, initial versus proven absence, and unchanged existing fixtures.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts
```

### Phase 2: Planning and Destructive Execution

#### Task 2.1: Build file-aware artist-delete plans Depends on [1.3, 1.4]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Create a Commander-independent planning action that loads one fresh artist snapshot, reuses
`selectLidarrArtists()` for exactly one ID/filter/explicit-all mode, and retains zero-match,
stable-order, and whole-cohort cap behavior. Fail closed for every selected artist unless path is
non-empty and album count, track-file count, and bytes are non-negative safe integers; zero remains
valid. Default to keep-files and set delete-files only from explicit input. Normal planning writes
the private no-overwrite artifact; planning dry-run returns the same complete in-memory plan but
writes no artifact. Add focused tests for selection forwarding, evidence validation, deterministic
construction, default/opt-in mode, cap failure, and dry-run purity.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts
```

#### Task 2.2: Add operation-aware admission and reconciliation Depends on [1.1, 1.2, 1.4]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply-target-types.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`

Represent a targeted artist read as present or typed absent without synthesizing an artist.
Initial or unproven absence is stale. Absence verified after dispatch during the current run is
`succeeded`; absence attributed on resume from matching durable possible-dispatch evidence is
`satisfied`. For a present artist, compare path and all sealed statistics exactly both just in time
and during reconciliation. Before the request can reach Lidarr, verify claim ownership and durably
persist possible-dispatch evidence; dispatch one non-idempotent single-ID delete with zero retry;
then use bounded targeted reads to verify typed absence. A lost response followed by authoritative
absence succeeds, while inconclusive reads or durability failure are uncertain and stop later
admission. Never enqueue an artist-delete target into the deferred queue.

Validate with:

```bash
npm run typecheck --workspace packages/rfmedia-cli
```

#### Task 2.3: Integrate authorization, resume, stop-admission, and optional scan Depends on [2.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay.ts`
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`
- `packages/rfmedia-cli/src/types/media-server.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

Require `allowArtistDelete` on every real artist-delete apply and additionally
`allowFileDelete` for delete-files plans, including resume; approval/`--yes` remains independent
and dry-run needs no destructive authority. Whole-plan preflight must reject any pending artist
that is absent or whose path/count/byte evidence drifted before the first mutation. Preserve
sealed sequential order and stop admission on stale, uncertain, lost-claim, persistence, or
verification boundaries. Exclude deletion from generic deferred reconciliation and replay. Keep
apply dry-run free of claims, history, SQLite initialization, mutations, and scans. If requested,
after durable results issue at most one best-effort full provider-neutral scan only when a newly
verified delete-files `succeeded` result from this run has nonzero reviewed file impact;
resume-only `satisfied` results never qualify. Report scan absence/failure through the compatible
structured-or-warning representation selected in Task 1.3 without changing deletion outcomes. Add
focused safety tests covering cumulative authorization, whole-plan/JIT drift, current-run
`succeeded` versus resume `satisfied` absence, one-at-a-time dispatch, no retry or defer,
uncertainty stop, resume without blind resend, dry-run purity, scan eligibility, and scan-result
compatibility.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/actions/lidarr/apply.test.ts
```

### Phase 3: Public CLI and Parity

#### Task 3.1: Register commands and present exact review/recovery evidence Depends on [2.1, 2.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/README.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Register `rfmedia lidarr plan artist-delete` in the pinned child order, reuse selector and plan
safety options, add `--delete-files`, and forward planning dry-run. Add apply flags
`--allow-artist-delete`, `--allow-file-delete`, and `--plex-scan`. Human review and confirmation
must state keep/delete mode, path, album count, track-file count, exact bytes plus formatted size,
totals, and irreversible risk; JSON/YAML preserve exact typed evidence and CSV adds stable delete
columns without changing existing rows. Render deletion results and scan status independently
using the compatible structured-or-warning representation selected in Task 1.3, and produce
checksum-pinned resume commands with every authorization flag required by the plan. Tests should
protect hierarchy/conflicts, forwarding, noninteractive authorization, prompts, the selected scan
compatibility path, structured output, recovery commands, and exit status without exhaustive
presentation snapshots.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/commands/lidarr.test.ts
```

#### Task 3.2: Synchronize Bash, Zsh, and Fish completions Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add the `artist-delete` child, its selector/safety/delete/dry-run/plan-file/connection/output
options, and all three apply flags to each hand-maintained template. Preserve pinned order and
ensure the parity test covers command detection and exact option availability in all shells.

Validate with:

```bash
npx vitest run packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
```

#### Task 3.3: Publish workflow documentation and roadmap completion Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `ROADMAP.md`
- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`

**Instructions**

Files to Modify

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `ROADMAP.md`

Document selector exclusivity, complete Lidarr-reported evidence, keep-files default, explicit
delete-files mode, layered authority, distinct planning/apply dry runs, whole-plan and JIT drift,
verified absence, uncertainty/resume guidance, and optional Plex scan isolation with concrete
commands. Update both #200 roadmap references, date/count summaries as applicable, and mark only
artist deletion delivered; keep album deletion under #223 and create no child issue.

Validate with:

```bash
npx prettier --check packages/rfmedia-cli/README.md packages/rfmedia-cli/docs/features/lidarr-plan-apply.md ROADMAP.md
```

### Phase 4: Integrated Validation

#### Task 4.1: Run critical package and architecture gates Depends on [3.2, 3.3]

**READ THESE BEFORE TASK**

- `package.json`
- `packages/rfmedia-cli/package.json`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `.github/workflows/rfmedia-cli.yml`

**Instructions**

Files to Create

- Review and fix artifacts under `docs/prps/reviews/` using the formal review workflow's resolved filenames.

Files to Modify

- Only previously scoped source, test, completion, and documentation files from Tasks 1.1-3.3 when an actionable review or CI finding requires a fix.

Run focused suites first and fix only failures attributable to issue #200. Reproduce the
`.github/workflows/rfmedia-cli.yml` contract locally: Lidarr codegen tooling tests,
generated-client drift, rf-common build, rfmedia-cli typecheck and coverage, plus the reduced-scale
benchmark smoke run. Then run the architecture test, monorepo build gate, scoped Prettier and
markdownlint checks, and `git diff --check`. Verify no generated file, SQLite migration,
filesystem-delete helper, album-delete surface, or unplanned dependency changed. Run
`graphify update .` after code changes as required by the repository and inspect the final diff.

Validate with:

```bash
npm run test:codegen:lidarr --workspace packages/rfmedia-cli
npm run codegen:lidarr:check --workspace packages/rfmedia-cli
npm run build --workspace packages/rf-common
npm run typecheck --workspace packages/rfmedia-cli
npm run test:coverage --workspace packages/rfmedia-cli
npm run test:architecture --workspace packages/rfmedia-cli
npm run check:architecture --workspace packages/rfmedia-cli
RFMEDIA_BENCH_SCALES=10,100 npm run bench --workspace packages/rfmedia-cli
npm run build:all
npx prettier --check docs/plans/file-aware-lidarr-artist-delete packages/rfmedia-cli/src packages/rfmedia-cli/README.md packages/rfmedia-cli/docs/features/lidarr-plan-apply.md ROADMAP.md
npx markdownlint-cli2 "docs/plans/file-aware-lidarr-artist-delete/*.md" packages/rfmedia-cli/README.md packages/rfmedia-cli/docs/features/lidarr-plan-apply.md ROADMAP.md
git diff --check
```

#### Task 4.2: Review, publish, merge, and clean up Depends on [4.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/file-aware-lidarr-artist-delete/feature-spec.md`
- `docs/plans/file-aware-lidarr-artist-delete/parallel-plan.md`
- `.github/workflows/rfmedia-cli.yml`

**Instructions**

Files to Create

- Review and fix artifacts under `docs/prps/reviews/` using the formal review workflow's resolved filenames.

Files to Modify

- Only previously scoped source, test, completion, and documentation files from Tasks 1.1-3.3 when an actionable review or CI finding requires a fix.

Run a formal local code review covering correctness, security, architecture, compatibility, and
minimal critical test coverage; persist its review artifact under `docs/prps/reviews/`, fix every
actionable finding, rerun affected gates, and review the fixes. Commit intentionally, push the
feature branch, and open a PR using every required repository-template section with exact
pass/fail validation evidence and `Closes #200`. Run the formal review in PR mode, resolve every
actionable thread/finding, push fixes and review artifacts, and keep monitoring GitHub Actions and
external review status until all required checks are green. If CI fails, diagnose from the
authoritative job logs, apply the smallest in-scope fix, and rerun local affected gates before
pushing. Capture the PR number and exact feature-branch name before merge. Squash-merge only after
the review and CI gates pass. Verify by captured PR number that the PR is merged, issue #200 is
closed, #223 remains open for albums, the remote feature branch is gone, and the default branch
contains the squash commit. Switch to the parent checkout before cleanup; from there remove only
the dedicated issue #200 worktree and its exact local feature branch, prune stale refs, and leave
unrelated worktrees/branches untouched. Run all post-cleanup verification from the parent checkout,
never from the worktree being removed.

Validate with:

```bash
gh pr view "$PR_NUMBER" --json state,mergedAt,mergeCommit,statusCheckRollup
gh issue view 200 --json state
gh issue view 223 --json state
git -C /home/yandy/Projects/github.com/yandy-r/rfmedia-apps worktree list
git -C /home/yandy/Projects/github.com/yandy-r/rfmedia-apps branch --all --list "$FEATURE_BRANCH" "remotes/*/$FEATURE_BRANCH"
```

## Advice

- Treat `feature-spec.md` as authoritative where individual research artifacts preserve rejected alternatives.
- Persist possible-dispatch evidence before the delete request; a transient runtime flag cannot make resume safe.
- Keep initial absence distinct from post-dispatch absence so an unrelated prior deletion is never credited to this plan.
- Never detect absence by message text or expose generated SDK types above `client.ts`.
- Do not use Lidarr paths as local filesystem authority; they are reviewed remote evidence only.
- `--yes` bypasses a prompt, not destructive authorization, and recovery output must retain both required allow flags.
- Keep deletion out of the deferred-intent database and executor registry even when reads fail transiently.
- Call at most one full Plex scan after durable qualifying success, and keep scan failure outside deletion classification.
- Keep tests boundary-focused: request shape, sealed evidence, drift, dispatch certainty, no-replay, authorization, and shell parity.
