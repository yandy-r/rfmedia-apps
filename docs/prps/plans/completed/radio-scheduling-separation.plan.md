# Plan: Radio-Scheduling Separation

## Summary

Implement GitHub issue #113 as an optional, deterministic sequencing stage for local
filter-backed playlists. Add typed configuration, a pure greedy sequencer with bounded local
backtracking and explicit relaxation diagnostics, focused integration, documentation, roadmap
closeout, and completion-parity verification.

## User Story

As a music operator, I want filtered tracks sequenced with radio-style spacing and variety, so that
large personal playlists avoid obvious repetition without an external service.

## Problem → Solution

Local smart playlists currently preserve a deterministic path sort after filtering, which can
cluster artists, genres, tempos, and eras → named filters may opt into a post-selection sequencing
policy that reorders every matched track deterministically and degrades visibly when a hard gap is
impossible.

## Metadata

- **Complexity**: Medium
- **Source PRD**: `docs/plans/radio-scheduling-separation/feature-spec.md`
- **PRD Phase**: Implementation-ready
- **Estimated Files**: 12

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-radio-scheduling-separation/ (branch: feat/radio-scheduling-separation)

---

## UX Design

### Before

```text
named filter → select matching tracks → path sort → M3U
```

### After

```text
named filter → select matching tracks → path sort
                                      ↓
                        optional separation policy
                         ↙                    ↘
                  ordered tracks       relaxation warning
                         ↓
                        M3U
```

### Interaction Changes

| Touchpoint                 | Before                                 | After                                       | Notes                      |
| -------------------------- | -------------------------------------- | ------------------------------------------- | -------------------------- |
| Local filter YAML          | `match` plus `rules`                   | Optional `separation` block                 | Existing filters unchanged |
| `playlist create --filter` | Path-sorted output                     | Policy-sequenced output when configured     | No new flag                |
| Runtime warnings           | Metadata/read failures                 | Also summarizes unavoidable gap relaxations | Generation still succeeds  |
| Shell completions          | Existing commands/options/filter names | Unchanged                                   | Config-only feature        |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                     | Lines                            | Why                                          |
| -------------- | -------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| P0 (critical)  | `docs/plans/radio-scheduling-separation/feature-spec.md` | all                              | Final behavior and scope contract            |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/playlist.ts`           | 320-520                          | Exact filter → select → output pipeline      |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/config.ts`                 | 1565-1820                        | Recursive filter validation and error paths  |
| P0 (critical)  | `packages/rfmedia-cli/src/types/filters.ts`              | 1-180                            | Public smart-filter types                    |
| P1 (important) | `packages/rfmedia-cli/src/lib/metadata.ts`               | 18-48                            | Existing artist, genre, year, and BPM source |
| P1 (important) | `packages/rfmedia-cli/src/actions/playlist.test.ts`      | relevant filter-create tests     | Mocking and action integration pattern       |
| P1 (important) | `packages/rfmedia-cli/src/lib/config.test.ts`            | relevant filter validation tests | `ConfigError` assertion pattern              |
| P2 (reference) | `research/rfmedia-new-features/synthesis/innovation.md`  | 53-87                            | Original sequencing recommendation           |
| P2 (reference) | `docs/features/smart-playlists.md`                       | all                              | User-facing pipeline documentation           |
| P2 (reference) | `packages/rfmedia-cli/docs/features/smart-filters.md`    | all                              | Filter configuration documentation           |

## External Documentation

| Topic                   | Source | Key Takeaway                                    |
| ----------------------- | ------ | ----------------------------------------------- |
| External APIs/libraries | N/A    | The feature is local, pure, and dependency-free |

---

## Patterns to Mirror

### DISCRIMINATED_CONFIGURATION_TYPES

```ts
// SOURCE: packages/rfmedia-cli/src/types/filters.ts:142-147
export interface SmartFilter {
  match: FilterMatch;
  rules: SmartFilterRule[];
}
```

Extend the named-filter model with a small optional object and literal-union modes; do not create a
parallel configuration tree.

### PROPERTY_PATH_VALIDATION

```ts
// SOURCE: packages/rfmedia-cli/src/lib/config.ts:1750-1758
if (!("match" in rawFilter) || rawFilter["match"] === undefined) {
  throw new ConfigError(`Missing required field 'match' at ${propertyPath}`, configPath, propertyPath);
}
```

Validate each separation key with the existing property-path convention so YAML errors remain
actionable.

### PARALLEL_METADATA_PROJECTION

```ts
// SOURCE: packages/rfmedia-cli/src/actions/playlist.ts:375-387
const matches = evaluateSmartFilter(metadata, filter);
if (matches) {
  const trackInfo: M3UTrackInfo = { filePath, title: metadata.common.title?.trim() };
  return { filePath, matched: true, trackInfo };
}
```

Keep metadata reads parallel, return one richer internal candidate for matched files, and sequence
only after results have been collected.

### DETERMINISTIC_ORDERING

```ts
// SOURCE: packages/rfmedia-cli/src/actions/playlist.ts:432-433
// Sort tracks by path for consistent ordering
matchingTracks.sort((a, b) => a.filePath.localeCompare(b.filePath));
```

Retain path ordering as the deterministic input and unchanged fallback for filters without a
separation policy.

### BEST_EFFORT_LOGGING

```ts
// SOURCE: packages/rfmedia-cli/src/actions/playlist.ts:351-354
if (allFiles.length === 0) {
  logWarn("No audio files found in configured library paths.");
  result.success = true;
}
```

An impossible runtime schedule is a visible best-effort outcome, not a fatal playlist error.

### TEST_STRUCTURE

```ts
// SOURCE: packages/rfmedia-cli/src/lib/ratings.test.ts
describe("formatFilterRule", () => {
  it("formats a rating rule", () => {
    expect(formatFilterRule(rule)).toBe("rating >= 4");
  });
});
```

Use focused behavioral cases with explicit inputs and outputs; avoid combinatorial coverage of
equivalent policy combinations.

---

## Files to Change

| File                                                     | Action | Justification                                        |
| -------------------------------------------------------- | ------ | ---------------------------------------------------- |
| `packages/rfmedia-cli/src/types/filters.ts`              | UPDATE | Define the optional separation schema                |
| `packages/rfmedia-cli/src/types/index.ts`                | UPDATE | Export the new public filter policy types            |
| `packages/rfmedia-cli/src/lib/config.ts`                 | UPDATE | Validate and retain separation configuration         |
| `packages/rfmedia-cli/src/lib/separation.ts`             | CREATE | Implement the pure deterministic scheduler           |
| `packages/rfmedia-cli/src/lib/separation.test.ts`        | CREATE | Cover the critical scheduler contracts               |
| `packages/rfmedia-cli/src/actions/playlist.ts`           | UPDATE | Insert sequencing after selection and before output  |
| `packages/rfmedia-cli/src/actions/playlist.test.ts`      | UPDATE | Prove action integration and no-policy compatibility |
| `packages/rfmedia-cli/src/lib/config.test.ts`            | UPDATE | Cover valid and invalid separation YAML              |
| `rfmedia.example.yaml`                                   | UPDATE | Provide a copyable radio-filter example              |
| `docs/features/smart-playlists.md`                       | UPDATE | Document the new pipeline and runtime semantics      |
| `packages/rfmedia-cli/docs/features/smart-filters.md`    | UPDATE | Document policy fields and examples                  |
| `ROADMAP.md`                                             | UPDATE | Mark #113 shipped through the final PR               |
| `docs/plans/radio-scheduling-separation/feature-spec.md` | CREATE | Preserve the approved design contract                |
| `docs/prps/plans/radio-scheduling-separation.plan.md`    | CREATE | Preserve this implementation plan                    |

## NOT Building

- Child issues: #113 is cohesive and has no subissues; #114 and #134 remain independent future
  enrichment work.
- New commands, flags, prompts, or completion candidates.
- Editing or displaying separation in the human filter-management surface; JSON output already
  returns the full typed filter.
- Plex playlist reordering or changes to Plex adapter behavior.
- Sticker/category storage, acoustic analysis, or durable energy metadata.
- A database migration or snapshotting policy configuration into playlist records.
- Random shuffling or a globally optimal scheduling solver.

---

## Step-by-Step Tasks

### Task 1: Define and validate the policy schema

- **ACTION**: Add separation policy types and make config loading validate and retain the optional
  per-filter block.
- **IMPLEMENT**: Add `SeparationConfig` plus literal mode types in `types/filters.ts`, export them
  through the type barrel, and add a focused `validateSeparationConfig()` called by
  `validateSmartFilter()`. Accept artist/genre integers `1..100`; accept only documented mode
  strings; reject unknown keys with precise `ConfigError` property paths.
- **MIRROR**: `DISCRIMINATED_CONFIGURATION_TYPES` and `PROPERTY_PATH_VALIDATION`.
- **IMPORTS**: Type-only imports from `../types/index.js` in config; no runtime dependency.
- **GOTCHA**: The current validator reconstructs `{ match, rules }`, so the optional block must be
  explicitly returned or YAML silently loses it. Do not weaken existing rule validation.
- **VALIDATE**: Run focused config tests covering one valid full policy, each invalid value class,
  an unknown key, and a filter without separation.

### Task 2: Implement the pure deterministic sequencer

- **ACTION**: Create a reusable separation module with greedy scoring, bounded local backtracking,
  and structured relaxation diagnostics.
- **IMPLEMENT**: Define a generic sequencing candidate contract, normalize artist/genre keys,
  derive BPM terciles, score tempo/era/energy preferences, and enforce artist/genre lookback gaps.
  When greedy selection stalls, reorder a bounded trailing window before choosing the
  least-violating candidate and recording the hard constraints relaxed.
- **MIRROR**: `DETERMINISTIC_ORDERING` and the pure evaluation style in
  `packages/rfmedia-cli/src/lib/ratings.ts`.
- **IMPORTS**: Type-only import of `SeparationConfig`; otherwise standard JavaScript/TypeScript
  primitives only.
- **GOTCHA**: Preserve the generic object identities exactly once, treat missing metadata as no
  constraint/category, compare all artist contributors and all genres case-insensitively, and use
  file path as the final tie-break.
- **VALIDATE**: Run `separation.test.ts` cases for feasible gaps, bounded-backtracking recovery,
  unavoidable relaxation, soft preferences, missing metadata, permutation preservation, and
  repeat-call determinism.

### Task 3: Insert sequencing into playlist generation

- **ACTION**: Apply separation to filter-backed playlist candidates after selection and before
  dry-run/write/history output.
- **IMPLEMENT**: Retain artist contributors, genres, year, and BPM in an internal candidate while
  metadata is available; preserve the existing path sort; call the sequencer only when the filter
  has a policy; then project back to `M3UTrackInfo`. Log one warning summary and debug details for
  relaxations.
- **MIRROR**: `PARALLEL_METADATA_PROJECTION` and `BEST_EFFORT_LOGGING`.
- **IMPORTS**: `sequenceTracks` from `../lib/separation.js` and policy types as type-only imports.
- **GOTCHA**: Plex-sourced playlists must not change. Dry-run and non-dry-run paths must consume the
  exact same ordered array, and the existing public result/DB schemas must stay compatible.
- **VALIDATE**: Run focused action tests proving configured sequencing reaches the M3U writer and
  dry-run result, while an unconfigured filter retains lexical path order.

### Task 4: Add only critical regression tests

- **ACTION**: Complete the minimum tests needed to lock issue #113's externally meaningful
  contracts.
- **IMPLEMENT**: Keep algorithm cases in the pure module; add only one configured playlist
  integration path, one compatibility path, and config acceptance/rejection cases. Reuse existing
  fixtures and hoisted mocks.
- **MIRROR**: `TEST_STRUCTURE` and existing `playlist.test.ts` mock reset conventions.
- **IMPORTS**: Vitest primitives and existing typed fixtures; no new test dependency.
- **GOTCHA**: Do not create exhaustive cross-products of modes, repeat M3U writer coverage, or add
  end-to-end filesystem tests for behavior already established by unit/action boundaries.
- **VALIDATE**: Run the three affected test files together and inspect coverage for the new module's
  relaxation and backtracking branches.

### Task 5: Document the contract and close the roadmap

- **ACTION**: Update operator docs, example configuration, and roadmap status.
- **IMPLEMENT**: Document `filter → select → sequence → output`, all schema fields, BPM-derived
  energy semantics, missing metadata, deterministic relaxation, and copyable YAML. Mark #113 as
  shipped in `ROADMAP.md` with the implementing PR number after PR creation; adjust high-priority
  counts/current focus without implying #114 or #134 shipped.
- **MIRROR**: The existing smart-playlist workflow and smart-filter configuration sections.
- **IMPORTS**: N/A.
- **GOTCHA**: Keep markdown headings surrounded by blank lines. Do not promise acoustic analysis or
  globally optimal schedules.
- **VALIDATE**: Run markdownlint, verify the example parses through config tests, and inspect every
  remaining `#113` roadmap reference for correct shipped formatting.

### Task 6: Audit completions and run repository validation

- **ACTION**: Prove the config-only feature does not require completion edits and run proportionate
  repository gates.
- **IMPLEMENT**: Inspect Bash, Zsh, and Fish sources plus the template parity tests; leave them
  unchanged because no CLI token changed, but run the parity suite. Run graphify update after code
  changes, inspect its diff, and execute focused tests followed by package/repository gates.
- **MIRROR**: Existing config-only completion assertions in
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
- **IMPORTS**: N/A.
- **GOTCHA**: Dirty `graphify-out/` output is expected and must be committed if caused by the code
  change. Separate any unrelated pre-existing validation noise with evidence rather than masking
  it.
- **VALIDATE**: All commands in `Validation Commands` pass, `git diff --check` is clean, and the
  worktree contains no unrelated changes.

---

## Testing Strategy

### Unit Tests

| Test                 | Input                                      | Expected Output                                        | Edge Case? |
| -------------------- | ------------------------------------------ | ------------------------------------------------------ | ---------- |
| Feasible hard gaps   | Repeating artists/genres with alternatives | Required intervening tracks are present                | No         |
| Bounded backtracking | Greedy tail that blocks the next placement | Tail is rearranged without relaxation                  | Yes        |
| Impossible hard gap  | Catalog dominated by one artist/genre      | All tracks returned once plus deterministic relaxation | Yes        |
| Soft policies        | Mixed BPM/year candidates                  | Tempo/era/energy scoring changes deterministic order   | No         |
| Missing metadata     | Candidates without artist/genre/year/BPM   | Candidates remain unique and schedulable               | Yes        |
| Stable output        | Same input and policy twice                | Identical tracks and diagnostics                       | Yes        |
| Config validation    | Valid full block and malformed values      | Typed policy or precise `ConfigError`                  | Yes        |
| Playlist integration | Filter with separation and mocked metadata | Writer/result receive sequenced order                  | No         |
| Compatibility        | Filter without separation                  | Historical lexical path order                          | Yes        |

### Edge Cases Checklist

- [ ] Empty input returns empty output without diagnostics.
- [ ] Single-track input is preserved.
- [ ] Duplicate metadata values do not duplicate or drop candidate identities.
- [ ] Missing metadata is not converted into a shared sentinel.
- [ ] Non-finite/non-positive BPM is treated as unavailable.
- [ ] A gap larger than the feasible catalog relaxes deterministically.
- [ ] Combined artist and genre violations report both constraints.
- [ ] Plex playlist source bypasses the sequencer.
- [ ] Dry-run performs no file or database writes and exposes the same sequence.

---

## Validation Commands

### Plan Validation

```bash
bash /home/yandy/.codex/plugins/cache/local-ycc-plugins/ycc/skills/prp-plan/scripts/validate-prp-plan.sh \
  docs/prps/plans/radio-scheduling-separation.plan.md
```

EXPECT: Plan passes with no structural errors.

### Focused Tests

```bash
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/separation.test.ts \
  src/lib/config.test.ts \
  src/actions/playlist.test.ts \
  src/lib/shell-completions/templates.spec.ts
```

EXPECT: Critical scheduler, config, integration, display, and completion-parity tests pass.

### Static Analysis

```bash
npm run typecheck -w packages/rfmedia-cli
```

EXPECT: Code generation/architecture prechecks and both TypeScript projects pass.

### Coverage Gate

```bash
npm run test:coverage -w packages/rfmedia-cli
```

EXPECT: The package suite and configured coverage thresholds pass.

### Build

```bash
npm run build:all
```

EXPECT: Common, rfmedia, and rfapps packages build successfully.

### Formatting and Documentation

```bash
npm run format:check
npm run lint:md
git -c core.whitespace=trailing-space,space-before-tab diff --check
```

EXPECT: Prettier, markdownlint, and the repository-standard whitespace check pass. The scoped Git
override excludes the user's global `indent-with-non-tab` rule, which conflicts with the
repository's space-indented TypeScript and YAML.

### Knowledge Graph

```bash
graphify update .
git status --short
```

EXPECT: Graph update succeeds and only feature-related source, documentation, and generated graph
changes are present.

### Manual Validation

- [ ] Inspect a small deterministic fixture sequence and verify gap semantics mean intervening
      tracks, not index distance.
- [ ] Confirm one impossible policy warns but still yields every matched track.
- [ ] Confirm no command/help/completion token changed in Bash, Zsh, or Fish templates.

---

## Acceptance Criteria

- [ ] The documented per-filter separation schema validates and round-trips through config loading.
- [ ] The runtime pipeline is `filter → select → sequence → output`.
- [ ] Artist and genre gaps are honored whenever the bounded deterministic search constructs a
      valid schedule.
- [ ] Greedy scheduling uses bounded local backtracking before relaxing a hard gap.
- [ ] Relaxations are deterministic, structured, and visible without failing generation.
- [ ] Every selected track is returned exactly once with missing metadata preserved.
- [ ] Tempo, era, and BPM-derived energy modes are optional and composable.
- [ ] Filters without a policy retain their exact historical path ordering.
- [ ] Plex-sourced playlists remain unchanged.
- [ ] Only critical unit/action/config/display tests are added and all validation commands pass.
- [ ] Bash, Zsh, and Fish completion parity passes with no source changes required.
- [ ] User docs, example YAML, graph output, and `ROADMAP.md` are current.
- [ ] The PR closes #113, passes review and CI, and is squash merged.

## Completion Checklist

- [ ] Code follows discovered type, validation, logging, and action boundaries.
- [ ] The pure scheduler has no I/O or external dependency.
- [ ] Public result and persistence schemas remain backward compatible.
- [ ] Error handling matches existing `ConfigError` and best-effort warning conventions.
- [ ] Tests cover contracts rather than implementation permutations.
- [ ] Documentation distinguishes BPM-derived energy from future enrichment.
- [ ] No unnecessary child issue or scope addition was created.
- [ ] Shell completions were explicitly audited.
- [ ] `graphify update .` was run after code modifications.
- [ ] Review findings were fixed and re-reviewed.
- [ ] CI is green, issue #113 is closed, and branch/worktree cleanup is complete.
- [ ] Self-contained — no questions needed during implementation.

## Risks

| Risk                                        | Likelihood | Impact | Mitigation                                                    |
| ------------------------------------------- | ---------- | ------ | ------------------------------------------------------------- |
| Impossible constraints lose or stall tracks | Medium     | High   | Bounded backtracking, explicit relaxation, permutation tests  |
| Backtracking grows excessively              | Low        | Medium | Fixed small trailing window and deterministic candidate order |
| Soft scoring is unstable                    | Low        | Medium | Stable path input and final tie-break                         |
| Energy is mistaken for audio analysis       | Medium     | Medium | Name the BPM proxy in config docs and output                  |
| Config typos are silently ignored           | Medium     | Medium | Reject unknown separation keys with property paths            |
| Rich metadata leaks into public schemas     | Low        | Medium | Private candidate projection before M3U/DB boundaries         |
| Unrelated playlist source changes           | Low        | High   | Filter-only integration and Plex bypass regression evidence   |

## Notes

- GitHub issue #113 currently has no subissues or dependencies. Issues #114 and #134 are related
  future enrichment surfaces, not child tasks required for this implementation.
- The issue's referenced `lib/smart-filter.ts` path is stale; current smart-filter evaluation lives
  in `packages/rfmedia-cli/src/lib/ratings.ts`.
- The existing research recommends a post-filter sequencing pass with greedy selection and
  backtracking. This plan resolves its schema and failure-mode gaps in the feature spec.
- The ROADMAP PR link can only be finalized after GitHub assigns the PR number; add it to the same
  feature branch before final review/merge.
