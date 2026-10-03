# Implementation Report: Radio-Scheduling Separation

## Summary

Implemented GitHub issue #113 as an optional, deterministic sequencing stage for local
filter-backed playlists. Named filters can now request artist and genre spacing plus tempo, era,
and BPM-derived energy preferences without changing the historical order of filters that omit the
policy. The scheduler preserves every selected track exactly once and reports deterministic
relaxations when its bounded search cannot satisfy a hard spacing preference.

## Assessment vs Reality

| Dimension        | Planned | Actual | Notes                                                         |
| ---------------- | ------- | ------ | ------------------------------------------------------------- |
| Complexity       | Medium  | Medium | Pure scheduler plus narrow config/action integration          |
| Scope confidence | High    | High   | No child issue, persistence migration, or CLI surface needed  |
| Estimated files  | 12      | 17     | Includes design, plan, review, fix, report, and roadmap paths |

## Tasks Completed

| Task                                           | Outcome                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| 1. Define and validate the policy schema       | Complete — strict typed validation and round-trip loading            |
| 2. Implement the deterministic sequencer       | Complete — bounded widening search and structured diagnostics        |
| 3. Insert sequencing into playlist generation  | Complete — filter-only integration before all output paths           |
| 4. Add critical regression tests               | Complete — scheduler, config, action, and completion cases           |
| 5. Document the contract and close the roadmap | Complete — operator docs, example YAML, and PR #264 roadmap closeout |
| 6. Audit completions and repository validation | Complete — no completion source changes required                     |

## Validation Results

| Check                                    | Result                                                    |
| ---------------------------------------- | --------------------------------------------------------- |
| Focused tests                            | Pass — 4 files, 261 tests                                 |
| rfmedia typecheck and architecture gates | Pass                                                      |
| rfmedia coverage gate                    | Pass — scheduler at 98.89% statements and 95.87% branches |
| Full repository build                    | Pass                                                      |
| Prettier and markdownlint                | Pass after formatting review artifacts                    |
| Completion parity                        | Pass — Bash, Zsh, and Fish templates unchanged            |
| Repository-standard whitespace check     | Pass                                                      |
| Plan validator                           | Pass                                                      |
| Graphify update                          | Pass — 7,757 nodes, 23,269 edges, 175 communities         |

## Files Changed

- Added the pure scheduler and focused test suite under `packages/rfmedia-cli/src/lib/`.
- Extended smart-filter types and strict configuration validation.
- Integrated rich metadata candidates into local filter-backed playlist generation.
- Updated operator documentation, smart-filter documentation, and example YAML.
- Added the feature specification, implementation plan, local review, fix record, and this report.
- Updated `ROADMAP.md` with the assigned PR #264 and the closed high-priority queue.

## Deviations from Plan

- Backtracking was strengthened during review from one fixed trailing window to deterministic
  windows of 4, 8, and 12 candidates under fixed branch and node budgets.
- The initial scheduler rescanned and sorted candidate state too frequently. It was replaced with
  precomputed normalized metadata and incremental last-seen/decade/BPM state.
- Graphify produced no tracked graph diff after its incremental update, so there is no generated
  graph artifact to commit.

## Issues Encountered

- The user's global Git whitespace rule treats normal space indentation as an error. Validation
  uses the repository-standard scoped override
  `git -c core.whitespace=trailing-space,space-before-tab diff --check`.
- The worktree helper did not recognize the repository's nested `.codex/worktrees/` location.
  Cleanup therefore uses the explicit path shown below.

## Tests Written

- Eight scheduler tests cover feasible gaps, bounded backtracking, widened search, deterministic
  relaxation, combined soft modes, missing metadata, immutability, compatibility, and a
  1,000-track scale smoke.
- Four grouped configuration tests cover the complete valid schema and parameterized invalid
  values, types, keys, and shapes.
- Two playlist action tests prove configured sequencing and historical no-policy ordering.

## Review

The formal local review found two HIGH findings:

- `F001`: a fixed four-track window could relax a feasible catalog.
- `F002`: repeated normalization, rescanning, and sorting made the 1,000-track path too slow.

Both findings are fixed and marked `Fixed` in the review artifact. Independent re-review approved
the result with zero new findings; the focused 1,000-track case completes in approximately 83 ms.

## Worktree Summary

- Worktree:
  `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-radio-scheduling-separation`
- Branch: `feat/radio-scheduling-separation`
- Cleanup after merge:
  `git worktree remove /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-radio-scheduling-separation`
- Local branch cleanup: `git branch -d feat/radio-scheduling-separation`

## Next Steps

1. Complete PR #264 review and any required fixes.
2. Wait for green CI.
3. Squash merge, verify issue #113 closes, and remove the feature branch/worktree.
