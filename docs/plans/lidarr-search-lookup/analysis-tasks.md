# Task Structure Analysis: Lidarr Search and Lookup

## Executive Summary

Implement issue #222 in three phases: stabilize the generated-independent boundary, add
query-aware execution/resilience, then expose and document the CLI. Parallel tracks are safe only
with one owner per hot file: facade owns `client.ts`, resilience owns `resilience.ts`, composition
owns `index.ts`, and CLI owns `commands/lidarr.ts`.

Tasks are limited to one to three files where practical. Tests stay with their source owner except
for shell completions, where three implementations form one task and the parity spec follows as a
separate task. Documentation begins only after the action/output contracts stabilize; ROADMAP
history waits until the issue/PR completion facts are known.

## Recommended Phase Structure

### Phase 1 — Stable Boundary

Run T1, T2, and T3 in parallel. T4 follows T1; T5 follows T1 and T2.

- **T1 — Domain contracts and strict projectors:** Own
  `packages/rfmedia-cli/src/types/lidarr.ts` and `src/lib/lidarr/types.ts`; add independent
  candidate/result types and atomic frozen projectors. Require one combined-result branch, durable
  foreign IDs, optional positive local IDs, and the 1,000-record bound.
- **T2 — Generated-client fail-closed contract:** Own
  `scripts/generate-lidarr-client.mjs`, its test, and `src/lib/lidarr/generated-contract.test.ts`;
  require all three operations/endpoints and pin method, query, envelopes, imports, and per-client
  isolation. Never refresh or hand-edit generated files.
- **T3 — Pure query and result shaping:** Own new `src/lib/lidarr/search.ts` and its test;
  implement term validation, UUID canonicalization, hashed discriminator, first-win dedupe,
  rank-before-slice, and paging. Test Unicode bounds, privacy, empty/out-of-range pages, stable
  order, duplicates, and immutability.
- **T4 — Cache discriminator plumbing:** Own `src/lib/lidarr/metadata-cache.ts` and its test; add
  category `lookup` without a migration. Prove origin/mode/term/version isolation, empty-array
  storage, stale/corruption behavior, pruning, and secret/cleartext absence.
- **T5 — Facade methods and client seam:** Own `src/lib/lidarr/client.ts`, its test, and
  `src/actions/test-helpers/lidarr-client-mocks.ts`; add the three explicit methods through
  `#execute`. Test exact requests, aborts, empty/optional IDs, malformed/oversized responses,
  frozen copies, and frozen-empty mock defaults.

### Phase 2 — Execution and Resilience

T6 follows T1, T3, T4, and T5. T7 follows T6. T8 follows T3, T5, and T7.

- **T6 — Query-aware resilience:** Own `src/lib/lidarr/resilience.ts` and its test; add exhaustive
  method/retry metadata, discriminators, cached-payload validation, and scheduler-owned preflight.
  Test live-first full-set writes, consent/error eligibility, one warning, breakers, bounded calls,
  and primary result/error preservation.
- **T7 — Shared execution context:** Own `src/lib/lidarr/index.ts` and its test; add
  `resolveRequiredLidarrExecutionContext()` returning one shared `{ client, preflight }`. Preserve
  the old resolver and test one health probe/context, safe config, lazy DB access, and redaction.
- **T8 — Mode-parameterized action:** Own new `src/actions/lidarr/search.ts`, its test, and the
  action barrel; submit one idempotent `metadata-dependent` task with preflight/signal. Return query,
  ranked page, provenance, cache/execution metadata; test exact operations, retry ownership,
  fallback, and failure behavior.

### Phase 3 — Surface, Documentation, and Release Gates

T9 follows T8. T10 may start after the command hierarchy in T9 is fixed; T11 follows T10. T12 and
T13 follow T9 and may run in parallel. T14 follows implementation completion and known PR facts.
T15 runs after all file-writing tasks converge.

- **T9 — CLI and output:** Own new `src/commands/lidarr-search.ts`, `commands/lidarr.ts`, and its
  test; register exact paths/IDs/options with bounded paging, lazy imports, redaction, and exits.
  Add stderr tables, `{ command, result }` JSON/YAML, and CSV summary/candidate rows; test empty/
  degraded/hostile output and stream/formula/ANSI safety.
- **T10 — Static completion implementations**
  - Files: `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
    `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
    `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`.
  - Add both nested paths and every shared option without network-backed term/identifier lookup.
- **T11 — Completion parity gate**
  - File: `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
  - Pin exact Bash/Zsh/Fish hierarchy, leaf options, argument-taking flags, help order, and static
    behavior.
- **T12 — Canonical feature and architecture guides**
  - Files: `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`,
    `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`,
    `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`.
  - Document operator workflows/output/fallback plus the three generated operations and the final
    single-preflight/scheduler-retry ownership model.
- **T13 — Discovery and changelog**
  - Files: `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/CHANGELOG.md`,
    `docs/README.md`.
  - Add concise discovery/examples, `[Unreleased]` notes, and guide indexing; do not rewrite the
    historical resilience design or generic completion guide.
- **T14 — Completion records**
  - Files: `ROADMAP.md`, `docs/roadmap-archive.md`.
  - Only after implementation/PR evidence exists, update both #222 roadmap entries and archive the
    issue with the real PR/date; never invent either value.
- **T15 — Integrated validation**
  - Owns no files; it reports/fixes failures through the original owning task.
  - Run focused Vitest first, then codegen check/tests, architecture gates, completion parity,
    typecheck, coverage, build, formatter/markdown checks, and `git diff --check`.

## Task Granularity

- Keep public types and projectors together because projector signatures directly encode those
  types; keep facade implementation, facade tests, and exhaustive mock defaults together.
- Separate pure shaping from cache/resilience so its contract can stabilize without SQLite,
  scheduler, or generated-client dependencies.
- Keep `resilience.ts` and `index.ts` in sequential tasks: both participate in execution
  composition, but assigning one owner per hot file prevents competing breaker/preflight designs.
- Keep the large `commands/lidarr.test.ts` with the CLI owner; a second output-only task would
  create unavoidable edit conflicts in the same command and test files.
- Split completion implementations from their parity spec because the implementations already
  consume three files; start the parity task only after all three templates are complete.
- Documentation tasks are file-disjoint from implementation and from each other, but must describe
  the implemented contract rather than an earlier research proposal.

## Dependency Analysis

```text
T1 ─┬─> T3 ───────────────┐
    ├─> T5 ───────────┐   │
T2 ─┘                 │   │
T4 <─ T1              ├─> T6 -> T7 ─┐
T3 + T5 + T7 ─────────┴─────────────> T8 -> T9 -> T10 -> T11
                                             ├──────> T12
                                             ├──────> T13
                                             └──────> T14
T11 + T12 + T13 + T14 ─────────────────────────────> T15
```

- T1/T2/T3 are the main safe parallel boundary work; T4 and T5 converge on their settled types.
- T6 must precede T7 so the composition root consumes a finalized resilience construction seam.
- T8 is the integration checkpoint: do not begin CLI implementation until its result and failure
  contracts pass focused action tests.
- T14 is intentionally late because closure history requires real completion evidence.
- When validation finds a defect, return it to the task owning the implicated file; do not let T15
  become a broad cross-file rewrite task.

## File-to-Task Mapping

| Task    | Exclusive ownership                                 |
| ------- | --------------------------------------------------- |
| T1      | `src/types/lidarr.ts`; `src/lib/lidarr/types.ts`    |
| T2      | generator script/test; `generated-contract.test.ts` |
| T3      | new `src/lib/lidarr/search.ts` and test             |
| T4      | `metadata-cache.ts` and test                        |
| T5      | `client.ts`, client test, typed client mocks        |
| T6      | `resilience.ts` and test                            |
| T7      | Lidarr `index.ts` and test                          |
| T8      | action `search.ts`, action test, action barrel      |
| T9      | command factory, `commands/lidarr.ts`, command test |
| T10–T11 | three completion templates; then parity spec        |
| T12     | canonical feature guide and two architecture guides |
| T13     | package README/changelog and docs index             |
| T14     | active roadmap and archive                          |
| T15     | validation only; no persistent file ownership       |
