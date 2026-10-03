# PR #278 Review — issue #205 Lidarr discovery safety controls

**Reviewed**: 2026-07-26T19:33:36Z
**Mode**: GitHub PR
**Pull request**: [#278](https://github.com/yandy-r/rfmedia-apps/pull/278)
**Branch**: feat/lidarr-discovery-safety
**Base**: master (`84aa787addb32ff6b9d816c342af23899a3ea7ac`)
**Decision**: APPROVE

## Summary

Three independent review lenses covered correctness, security/failure modes, and
maintainability/documentation across the complete issue #205 diff. The review found three
high-severity defects, four medium contract defects, and one low provenance-hardening gap. Every
finding and the additional adversarial edge cases were fixed. The final code-reviewer pass found no
actionable issue, and the complete post-fix validation suite is green.

## Findings

### CRITICAL

None.

### HIGH

- **[F001]** `packages/rfmedia-cli/src/lib/discovery/policy.ts:346` — MBID/name identity changes can
  bypass the invocation-wide visited set. The initial seed is registered only under a normalized
  name, while an observation carrying an MBID is compared only by MBID. Provider identity
  inconsistency can expose or schedule the initial seed again, consume request/visible slots, and
  distort exposure scoring.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Track normalized-name aliases alongside authoritative MBID identities for
    seeds and candidates, promote name-only observations when an MBID becomes known, preserve
    distinct MBIDs with colliding display names, and add initial-seed plus mixed-identity-path
    regressions.

- **[F002]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts:301` — Mixed resumes process
  all possible-dispatch entries before all fresh entries instead of preserving sealed order. An
  uncertain later rank can stop an earlier rank and mark it `not-attempted`, violating the reviewed
  plan order in both live and dry-run paths.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Iterate the original pending entries once in sealed order, reconcile
    possible dispatch inline, lazily run shared preflight before the first reached fresh entry, and
    mark only the remaining suffix `not-attempted`.

- **[F003]** `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts:223` — One scheduled planning
  task hides three shared reads plus 25 concurrent lookup/presence pairs. At the public maximum this
  bypasses the metadata lane bulkhead with 53 concurrent requests, does not propagate cancellation,
  and can repeat the entire successful fanout when the outer idempotent task retries.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Schedule candidate reads as separately budgeted lane tasks or enforce lane-
    bounded concurrency, resolve shared resources once, propagate the caller signal into every
    read, and ensure one candidate failure does not retry successful siblings.

### MEDIUM

- **[F004]** `packages/rfmedia-cli/src/actions/lidarr/discover.ts:468` — Atomic multi-rank approval
  failures always attribute the failure to the first requested rank and report `failed: 1`, even
  when a later rank caused the rejection. Machine output is therefore false for comma-separated
  selections.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Emit one consistent atomic-failure result for every requested rank, or carry
    structured offending-rank evidence, and keep approval rows and aggregate counts aligned.

- **[F005]** `packages/rfmedia-cli/src/commands/lidarr-discover.ts:450` — Handoff resource/path and
  basic rank validation is deferred until after provider or Lidarr work. Empty or terminal-unsafe
  resource/path inputs and malformed direct-call ranks can consume network budgets before failing.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Reuse terminal-safe bounded resource and path parsers on the command, add a
    pure handoff validator before configuration/provider resolution, and revalidate plan-producer
    inputs before Lidarr context resolution.

- **[F006]** `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts:304` — A resume with no
  pending entries returns a completed or checked result while retaining placeholder execution
  metadata with outcome `failed`, zero attempts, and unknown failure.
  - **Status**: Fixed
  - **Category**: API
  - **Suggested fix**: Return explicit successful no-op execution metadata for the empty-pending
    path and cover both live and dry-run all-terminal resumes.

- **[F007]** `packages/rfmedia-cli/src/lib/discovery/policy.ts:145` — The documented Unicode
  case-folded fallback uses locale-independent lowercasing, which does not equate forms such as
  `Straße`/`STRASSE` or Greek final/non-final sigma. Equivalent provider names can occupy separate
  visited and visible slots.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Implement stable full Unicode case folding followed by NFC normalization, or
    narrow every public contract to lowercasing. Add German sharp-s and Greek sigma regressions.

### LOW

- **[F008]** `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:883` — Extended artist-add
  provenance accepts depth zero and internally contradictory path, parent, and candidate evidence.
  A checksum-valid plan can therefore present impossible traversal provenance during approval.
  - **Status**: Fixed
  - **Category**: Validation
  - **Suggested fix**: Require depth 1 through the fixed maximum, exact path length, penultimate
    parent equality, and terminal planned-artist equality, with focused tamper regressions.

## Adversarial Re-review

- Candidate and seed alias sets now retain alternate provider names without collapsing distinct
  MBIDs; Unicode 17 full case-fold conformance passed 1,585 mappings.
- Live and dry-run apply classify only the current fresh entry and never inspect a later fresh
  suffix across a possible-dispatch barrier.
- Planning reads are metadata-lane tasks with task-local retries, caller cancellation, terminal
  fail-fast cancellation, queued-work suppression, original-error preservation, and atomic writes.
- Discovery and sealed plans share a 2,500 exposure ceiling (25 requests × 100 observations), and
  complete recommendation provenance is validated before any Lidarr resolver or read.
- The targeted final re-review decision is **APPROVE** with no actionable findings.

## Validation Results

| Check                                        | Result |
| -------------------------------------------- | ------ |
| rfmedia-cli focused final review (369 tests) | Pass   |
| rfmedia-cli full suite (3,385 tests)         | Pass   |
| rfmedia-cli coverage                         | Pass   |
| Type check and 57 architecture tests         | Pass   |
| Lidarr generated-client check and tests      | Pass   |
| Monorepo build                               | Pass   |
| Repository lint and markdownlint             | Pass   |
| Prettier and whitespace integrity            | Pass   |

## Files Reviewed

- `docs/plans/lidarr-discovery-safety/` (Added)
- `packages/rfmedia-cli/src/types/discovery.ts` (Modified)
- `packages/rfmedia-cli/src/types/lidarr-plan.ts` (Modified)
- `packages/rfmedia-cli/src/lib/discovery/policy.ts` (Added)
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` (Modified)
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts` (Modified)
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` (Modified)
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` (Modified)
- `packages/rfmedia-cli/README.md` (Modified)
- `packages/rfmedia-cli/CHANGELOG.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` (Modified)
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` (Modified)
- All directly affected focused test files (Modified/Added)
