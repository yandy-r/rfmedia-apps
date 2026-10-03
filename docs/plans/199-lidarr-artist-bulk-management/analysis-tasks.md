# Task Structure Analysis: 199-lidarr-artist-bulk-management

## Executive Summary

Issue #199 is not a small command addition. It extends the existing Lidarr plan/apply protocol
across four architectural seams: the stable generated-client facade, strict versioned plan
contracts, operation-owned mutation semantics, and the command/output surface. The safest task
shape is therefore two parallel foundations followed by a deliberate convergence at the v2
operation registry, then producer, apply, presentation, and release-evidence phases.

The implementation should stay in the existing
`feat/199-lidarr-artist-bulk-management` checkout. No new worktree or branch setup task is needed.
Most implementation tasks should own one source/test pair or at most three tightly coupled files.
The only justified larger atomic unit is shell completion parity, where Bash, Zsh, Fish, and their
shared parity test must move together.

The critical path is:

```text
v2 contracts ───────────────┐
                            ├─> operation registry ─> plan producers ─> apply ─> CLI
domain projections ─> facade┤
                  └─> selector
```

Version 1 parsing, canonical bytes, checksum identity, history, and resume behavior are immutable
compatibility boundaries. Generated code remains private, the authenticated transport remains the
only production Fetch owner, and `lidarr apply` remains the only remote-write entry point.

## Recommended Phase Structure

### Phase 0: Existing-Branch Baseline

This phase is verification-only and performs no source edits.

| Task                | Owned files | Purpose                                                                                                                                                                                  | Depends on |
| ------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P0.1 Baseline audit | None        | Confirm the current checkout is `feat/199-lidarr-artist-bulk-management`, preserve all existing planning artifacts, record focused test commands, and verify no new worktree is created. | None       |

Implementation must run directly in
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-199`. Existing untracked planning
artifacts are shared inputs and must not be overwritten by implementation tasks.

### Phase 1: Parallel Contract Foundations

P1.1 and P1.2 are the two primary parallel lanes. They touch disjoint files and define the types
needed by every later task.

| Task                          | Owned files                                                                                       | Purpose                                                                                                                                                                                                                             | Depends on |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1.1 Versioned plan contracts | `src/types/lidarr-plan.ts`, `src/lib/lidarr/plan-engine.ts`, `src/lib/lidarr/plan-engine.test.ts` | Preserve an exact v1 path; add strict v2 operation, selector, entry, result, stale-finding, canonicalization, checksum, and version-dispatch contracts; make monitoring the first v2 producer shape without rewriting v1 artifacts. | P0.1       |
| P1.2 Stable resource domain   | `src/types/lidarr.ts`, `src/lib/lidarr/types.ts`                                                  | Add immutable profile/tag projections, normalize artist tag arrays, and enforce bounded positive IDs plus safe non-empty labels at the unknown-to-domain boundary.                                                                  | P0.1       |

P1.1 intentionally owns both the public plan types and the engine tests because v1 compatibility
cannot be validated by type changes alone. It must add golden or fixture-based v1 assertions before
changing current-producer behavior.

P1.2 should not add generated types to public signatures. Projector coverage can be completed in
the facade task, where real generated response envelopes are already tested.

### Phase 2: Parallel Client and Pure-Semantics Work

Once the domain contract is stable, the facade and selector can proceed in parallel.

| Task                                        | Owned files                                                                                      | Purpose                                                                                                                                                                                                                                                                                                     | Depends on |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P2.1 Narrow client facade                   | `src/lib/lidarr/client.ts`, `src/lib/lidarr/client.test.ts`                                      | Add fresh quality-profile, metadata-profile, tag, and targeted-artist reads plus one-artist intent-bearing profile/tag mutations. Assert exact generated operation, one-ID body, explicit `applyTags`, successful `2xx`/`202`, ignored response body, cancellation, and absence of unrelated editor fields. | P1.2       |
| P2.2 Resilience delegation                  | `src/lib/lidarr/resilience.ts`, `src/lib/lidarr/resilience.test.ts`                              | Explicitly forward every new facade method; allow only classified safe reads into retry policy; keep mutations uncached and outside in-place retry.                                                                                                                                                         | P2.1       |
| P2.3 Pure selection and resource resolution | `src/lib/lidarr/artist-selection.ts` (new), `src/lib/lidarr/artist-selection.test.ts` (new)      | Own IDs/filter/`--all` exclusivity, exact `name:` resolution, ambiguity errors, AND/all-of filters, complete-cohort cap checks, ascending-ID order, zero-match failure, and normalized tag set algebra.                                                                                                     | P1.2       |
| P2.4 Typed action fixtures                  | `src/actions/test-helpers/lidarr-client-mocks.ts`, `src/actions/test-helpers/lidarr-fixtures.ts` | Extend the typed facade mock and add reusable artist/profile/tag fixtures for producer and apply tests.                                                                                                                                                                                                     | P2.1       |

P2.3 must not import or reuse the `list` action. It may extract equivalent predicate semantics, but
must not inherit `list.ts` paging, default limit, offset, or stale-cache behavior.

### Phase 3: Operation and Producer Convergence

This is the first convergence phase. The v2 engine, facade, selector, and test fixtures must be
stable before operation definitions or plan producers are implemented.

| Task                                  | Owned files                                                                                                 | Purpose                                                                                                                                                                                                                              | Depends on       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| P3.1 Operation-owned semantics        | `src/lib/lidarr/plan-engine.ts`, `src/lib/lidarr/plan-engine.test.ts`                                       | Register profile assignment and tag mutation; own canonical operation state, risk, entry construction, change detection, classification, idempotency, exact deferred payload validation, executor registration, and replay matching. | P1.1, P2.1, P2.3 |
| P3.2 Profile plan producer            | `src/actions/lidarr/plan-artist-profiles.ts` (new), `src/actions/lidarr/plan-artist-profiles.test.ts` (new) | Resolve a fresh complete cohort and requested profiles, build exact before/after profile entries, preserve all-no-op plans, and write a sealed v2 artifact without mutation.                                                         | P3.1, P2.2, P2.4 |
| P3.3 Tag plan producer                | `src/actions/lidarr/plan-artist-tags.ts` (new), `src/actions/lidarr/plan-artist-tags.test.ts` (new)         | Resolve fresh tags and artists, enforce one add/remove/set/clear mode, compute full normalized deltas, emphasize replacement removals, and write a sealed v2 artifact without mutation.                                              | P3.1, P2.2, P2.4 |
| P3.4 Monitoring migration and exports | `src/actions/lidarr/plan.ts`, `src/actions/lidarr/plan.test.ts`, `src/actions/lidarr/index.ts`              | Move the existing monitoring producer to v2, preserve its command behavior, and export all three plan producers through the established action barrel.                                                                               | P3.1             |

P3.2 and P3.3 can run in parallel because they own separate action/test pairs. Both must consume
the same selector and operation contracts rather than duplicating validation or tag algebra.

P3.1 is serialized after P1.1 because both edit `plan-engine.ts` and its test. This avoids merge
conflicts and lets v1/v2 dispatch stabilize before operation-specific rules are added.

### Phase 4: Generic Apply Lifecycle

| Task                                           | Owned files                                                       | Purpose                                                                                                                                                                                                                                                         | Depends on       |
| ---------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| P4.1 Apply preflight, verification, and resume | `src/actions/lidarr/apply.ts`, `src/actions/lidarr/apply.test.ts` | Add whole-plan artist/resource preflight, operation-aware stale details, targeted late reads, one-ID execution, post-write verification, observed evidence, replacement authorization input, durable admission stops, and exact deferred/resume reconciliation. | P3.2, P3.3, P3.4 |

P4.1 is intentionally one source/test pair. The existing apply action already owns claims,
history, deferred replay, cancellation, and admission control; splitting those state transitions
across tasks would make correctness harder to review.

The apply task must prove:

- dry-run creates no claim, history, deferred intent, or editor request;
- initial resource or artist failure produces zero writes;
- profile classification tolerates safe partial convergence only on managed fields;
- tag add/remove tolerates unrelated tag changes;
- tag set/clear rejects third-state replacement drift;
- each accepted write is followed by a targeted read before success is persisted;
- definite verification failure and uncertain post-dispatch state stop later admissions;
- resume exact-matches origin, operation, payload, and idempotency key.

### Phase 5: Command, Output, Approval, and Completion Surface

| Task                           | Owned files                                                                                                                                                 | Purpose                                                                                                                                                                                                                       | Depends on |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P5.1 CLI and rendering         | `src/commands/lidarr.ts`, `src/commands/lidarr.test.ts`                                                                                                     | Register both plan leaves, group and validate options, render bounded 20-row human previews, keep full machine output, require `--yes` in non-interactive/machine modes, and enforce `--allow-tag-replacement` for set/clear. | P4.1       |
| P5.2 Static completion parity  | `src/lib/shell-completions/bash.ts`, `src/lib/shell-completions/zsh.ts`, `src/lib/shell-completions/fish.ts`, `src/lib/shell-completions/templates.spec.ts` | Add both leaves, selection/change/safety flags, repeatable tag options, and exact cross-shell hierarchy/value parity.                                                                                                         | P5.1       |
| P5.3 Conditional CSV hardening | `src/lib/formatters/index.ts`, `src/lib/formatters/formatters.test.ts`                                                                                      | Only if implementation-time evidence shows `@rfmedia/common` does not already neutralize formula-leading labels, add the smallest shared protection and focused regression test.                                              | P5.1       |

P5.2 is the deliberate four-file exception to the normal task size. The repository treats the
three completion templates as a mirrored static API, and `templates.spec.ts` is their parity gate;
splitting them would create an invalid intermediate command surface.

P5.3 must remain conditional. Do not modify the formatter seam without first proving the shared
serializer is insufficient.

### Phase 6: Executable Architecture and Codegen Policy

These tasks can run in parallel after the facade and operation call sites exist.

| Task                         | Owned files                                                                           | Purpose                                                                                                                                                                                                                               | Depends on |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P6.1 Generated contract gate | `scripts/generate-lidarr-client.mjs`, `scripts/generate-lidarr-client.test.mjs`       | Require the checked-in targeted artist/resource/editor operations and keep offline generation/check behavior deterministic. Do not refresh the OpenAPI snapshot.                                                                      | P2.1       |
| P6.2 Architecture audit      | `scripts/check-direct-plex-imports.mjs`, `scripts/check-direct-plex-imports.test.mjs` | Preserve private generated imports, exactly one production Fetch owner, and no handwritten endpoints; add allowlisted mutation-owner checks that reject direct editor calls outside the stable client and registered operation owner. | P3.1, P4.1 |

The oddly named `check-direct-plex-imports.mjs` is already the cross-provider architecture gate.
Extend it rather than adding a second Lidarr-only audit or weakening its existing Plex rules.

### Phase 7: Documentation and Lifecycle Evidence

| Task                              | Owned files                                                                                                                            | Purpose                                                                                                                                    | Depends on                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| P7.1 Operator workflow docs       | `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`              | Document selectors, profile/tag modes, dry-run/apply/resume, risks, one-ID execution, verification, uncertainty, and local-only admission. | P5.1, P6.2                        |
| P7.2 Client and package docs      | `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`, `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/CHANGELOG.md` | Document new facade contracts and commands; add an `[Unreleased]` entry without claiming a release.                                        | P5.1, P6.1                        |
| P7.3 Roadmap and archive evidence | `ROADMAP.md`, `docs/roadmap-archive.md`                                                                                                | Record #199 and the real PR number/status. Do not invent a PR number or claim the feature shipped before verified merge evidence exists.   | P7.1, P7.2, PR lifecycle evidence |

P7.3 is intentionally lifecycle-bound. If the feature PR is not yet merged, use accurate
in-progress/PR wording; mark shipped and archive it only after the merge and issue-closure evidence
required by the repository workflow exists.

### Phase 8: Integration and Completion Gate

This phase owns validation evidence, not implementation files.

| Task                                       | Owned files                                            | Purpose                                                                                                                                                                                                                                       | Depends on |
| ------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P8.1 Focused and package validation        | None                                                   | Run owning test files first, then typecheck, package tests, build, format/lint, architecture tests, offline codegen drift, and packaging checks.                                                                                              | P1.1-P7.2  |
| P8.2 Compatibility and behavioral evidence | None                                                   | Verify v1 fixture read/apply/resume, v2 strictness, successful `202` reconciliation, and profile/tag-only non-effects on supported Lidarr behavior. Resolve whether one bounded reconciliation delay is necessary.                            | P8.1       |
| P8.3 PR completion                         | `.github/pull_request_template.md` is read, not edited | Create the issue-closing PR using the required template, include exact commands/outcomes, address review findings, reach green CI, squash-merge, verify issue closure, then perform P7.3 with real evidence if required by repository policy. | P8.2       |

## Task Granularity Recommendations

### Default unit: one source/test pair

Most behavioral tasks should own one implementation file and its focused test:

- facade: `client.ts` + `client.test.ts`;
- selector: new `artist-selection.ts` + test;
- each new plan producer + its test;
- apply: `apply.ts` + `apply.test.ts`;
- command: `commands/lidarr.ts` + its test;
- resilience: `resilience.ts` + its test.

This keeps tests with the behavior owner and prevents a late monolithic “add tests” phase.

### Three-file units only for inseparable contracts

Use three files where a public type, implementation, and focused test must change together:

- v2 plan types + engine + engine tests;
- monitoring producer + producer tests + action barrel;
- client documentation + README + changelog.

Do not combine client, selection, producer, and apply work into a single task merely because they
all concern Lidarr. They have different failure modes and validation owners.

### Avoid shared-file parallelism

The following files are convergence hotspots and must have one active owner at a time:

- `src/lib/lidarr/plan-engine.ts`;
- `src/lib/lidarr/plan-engine.test.ts`;
- `src/commands/lidarr.ts`;
- `src/actions/lidarr/apply.ts`;
- `src/actions/lidarr/index.ts`;
- `ROADMAP.md`.

Tasks P1.1 and P3.1 deliberately serialize changes to the plan engine. P3.2 and P3.3 stay parallel
by using separate producer files. Documentation and roadmap tasks wait until the command and
behavior contracts stop moving.

### New-file guidance

Prefer these bounded additions:

- `src/lib/lidarr/artist-selection.ts` and its test for pure selection/reference/tag algebra;
- `src/actions/lidarr/plan-artist-profiles.ts` and its test;
- `src/actions/lidarr/plan-artist-tags.ts` and its test.

Do not add:

- `lib/lidarr/editor.ts`;
- a generic editor payload type;
- a schema DSL or plugin registry;
- a new database table, job runner, rollback engine, or transport;
- a direct profile/tag mutation command.

## Dependency Analysis

### Foundation dependencies

- `src/types/lidarr.ts` is the stable public domain seam. Projectors, facade methods, selector
  helpers, fixtures, and actions depend on it.
- `src/types/lidarr-plan.ts` defines the versioned protocol. The plan engine, producers, apply
  action, command renderers, history, and resume selection depend on it.
- `src/lib/lidarr/plan-engine.ts` is the semantic registry and artifact owner. Producer work must
  not start until its strict v2 dispatch and v1 compatibility path are established.

### Convergence dependencies

P3.1 is the central convergence point:

```text
P1.1 v2 plan contract
P2.1 facade mutation/read contract
P2.3 pure selector semantics
             │
             ▼
P3.1 operation definitions and registry
```

The two plan producers depend on P3.1 but not on each other. Apply depends on both producers because
its generic lifecycle must be exercised against every current operation kind, including monitoring.

### Apply and presentation dependencies

- Apply must consume operation-owned classification, execution, verification, and deferred
  matching rather than switch on operation kinds in multiple lifecycle branches.
- CLI rendering and replacement approval wait for complete plan/apply result shapes.
- Shell completions wait for final Commander option names and conflicts.
- Architecture gates wait for final client and operation call sites so their allowlists are exact.
- Docs wait for final syntax, output, risks, and recovery behavior.

### External and lifecycle dependencies

- Normal development uses the committed OpenAPI snapshot; only the explicit refresh command uses
  the network, and refresh is not part of issue #199.
- A real supported-Lidarr contract check is needed to settle immediate visibility after `202` and
  confirm no search/file/delete side effects.
- `ROADMAP.md` and `docs/roadmap-archive.md` depend on real issue/PR lifecycle evidence rather than
  guessed identifiers.

## File-to-Task Mapping

| File                                                                          | Task              | Ownership note                                                                                   |
| ----------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `src/types/lidarr-plan.ts`                                                    | P1.1              | Version constants, v1/v2 discriminated unions, selectors, entries, results, stale/history types. |
| `src/lib/lidarr/plan-engine.ts`                                               | P1.1, then P3.1   | Serialized ownership: first version dispatch/canonicalization, then operation definitions.       |
| `src/lib/lidarr/plan-engine.test.ts`                                          | P1.1, then P3.1   | V1 golden compatibility followed by operation-specific v2 invariants.                            |
| `src/types/lidarr.ts`                                                         | P1.2              | Stable generated-independent resource types.                                                     |
| `src/lib/lidarr/types.ts`                                                     | P1.2              | Strict unknown-to-domain projectors and normalized tags.                                         |
| `src/lib/lidarr/client.ts`                                                    | P2.1              | Only generated-operation importer and minimal editor-body owner.                                 |
| `src/lib/lidarr/client.test.ts`                                               | P2.1              | Wire request, projection, `2xx`/`202`, abort, and secret/body-negative tests.                    |
| `src/lib/lidarr/resilience.ts`                                                | P2.2              | Explicit delegation and retry/cache classification.                                              |
| `src/lib/lidarr/resilience.test.ts`                                           | P2.2              | Every method forwarded; mutations never cached or retried in place.                              |
| `src/lib/lidarr/artist-selection.ts`                                          | P2.3              | New pure selector, reference resolver, cap, sorting, and set-algebra owner.                      |
| `src/lib/lidarr/artist-selection.test.ts`                                     | P2.3              | Table-driven selector/reference/tag semantics.                                                   |
| `src/actions/test-helpers/lidarr-client-mocks.ts`                             | P2.4              | Complete typed facade mock.                                                                      |
| `src/actions/test-helpers/lidarr-fixtures.ts`                                 | P2.4              | Reusable bounded artist/profile/tag fixtures.                                                    |
| `src/actions/lidarr/plan-artist-profiles.ts`                                  | P3.2              | New profile planning orchestration only.                                                         |
| `src/actions/lidarr/plan-artist-profiles.test.ts`                             | P3.2              | Fresh selection, resolution, combined profiles, no-op, cap, artifact tests.                      |
| `src/actions/lidarr/plan-artist-tags.ts`                                      | P3.3              | New tag planning orchestration only.                                                             |
| `src/actions/lidarr/plan-artist-tags.test.ts`                                 | P3.3              | Four modes, normalized deltas, replacement removals, no-op, artifact tests.                      |
| `src/actions/lidarr/plan.ts`                                                  | P3.4              | Existing monitoring producer migrated to current v2 writes.                                      |
| `src/actions/lidarr/plan.test.ts`                                             | P3.4              | Monitoring v2 and zero-mutation regression tests.                                                |
| `src/actions/lidarr/index.ts`                                                 | P3.4              | Stable action exports after both new producers exist.                                            |
| `src/actions/lidarr/apply.ts`                                                 | P4.1              | Generic preflight, targeted revalidation, write, verification, durability, resume.               |
| `src/actions/lidarr/apply.test.ts`                                            | P4.1              | Lifecycle state-transition and failure-boundary ownership.                                       |
| `src/commands/lidarr.ts`                                                      | P5.1              | Grammar, renderers, approval, output envelopes, exit status.                                     |
| `src/commands/lidarr.test.ts`                                                 | P5.1              | Hierarchy, conflicts, forwarding, truncation, machine output, approval, exits.                   |
| `src/lib/shell-completions/{bash,zsh,fish}.ts`                                | P5.2              | Mirrored static command/option surface.                                                          |
| `src/lib/shell-completions/templates.spec.ts`                                 | P5.2              | Cross-shell parity gate.                                                                         |
| `src/lib/formatters/index.ts`, `formatters.test.ts`                           | P5.3, conditional | Only if shared CSV formula neutralization is proven absent.                                      |
| `scripts/generate-lidarr-client.mjs`, `generate-lidarr-client.test.mjs`       | P6.1              | Required generated operations and offline drift contract.                                        |
| `scripts/check-direct-plex-imports.mjs`, `check-direct-plex-imports.test.mjs` | P6.2              | Cross-provider dependency and mutation-owner policy.                                             |
| `docs/features/lidarr-plan-apply.md`, `lidarr-execution-lanes.md`             | P7.1              | Operator safety, execution, and recovery workflow.                                               |
| `docs/features/lidarr-generated-client.md`, `README.md`, `CHANGELOG.md`       | P7.2              | Client maintenance and user-visible command contract.                                            |
| `ROADMAP.md`, `docs/roadmap-archive.md`                                       | P7.3              | Evidence-backed issue/PR completion state.                                                       |

## Optimization Opportunities

- Run P1.1 and P1.2 concurrently; they define independent plan and resource contracts.
- Run P2.1 and P2.3 concurrently after P1.2; the selector needs only domain types, not a live
  client.
- Start P2.4 immediately after the facade signature stabilizes so producer/apply tests do not
  create incompatible local mocks.
- Run profile and tag producers concurrently as separate source/test pairs.
- Run codegen-contract and architecture-audit work concurrently after their respective call sites
  stabilize.
- Use focused test commands per task before the full package suite. The fastest feedback order is
  pure selector tests, client tests, plan-engine tests, producer tests, apply tests, command tests,
  completion parity, then package-wide validation.
- Reuse the existing scheduler, claim, history, deferred queue, output formatters, and safe artifact
  I/O. No new persistence or orchestration layer is justified.
- Keep one whole-list artist read for planning and initial apply preflight, then use targeted reads
  for late checks and verification. This avoids full-library amplification at the 1,000-entry hard
  cap.
- Keep one artist per editor request. Network batching would reduce calls but would destroy the
  current per-target history and uncertain-outcome recovery model.
- Preserve all-no-op plans. They provide auditable convergence without special-case command logic
  or editor calls.

## Implementation Strategy Recommendations

1. Start in the existing issue branch and record the baseline; do not create or manage another
   worktree.
2. Lock v1 compatibility with fixtures before adding v2. Treat any v1 byte/checksum change as a
   release blocker.
3. Define stable domain types and strict projectors before exposing new facade methods.
4. Make dangerous editor fields unrepresentable in method signatures and assert their absence in
   client tests.
5. Centralize selectors and tag algebra in a pure module. Commands parse syntax; actions validate
   again and orchestrate fresh reads.
6. Keep operation-specific state, risk, classification, execution, verification, and deferred
   identity behind the operation registry. Keep artifact I/O and lifecycle control generic.
7. Add producer actions as separate files so profile and tag planning can be implemented and
   reviewed in parallel.
8. Extend apply only after every operation has deterministic entry and classification semantics.
   Persist a verified outcome before admitting the next target.
9. Finalize Commander syntax before editing completions, then update all three shells and the parity
   test atomically.
10. Extend existing codegen and architecture gates; do not refresh generated artifacts or add
    another audit framework.
11. Update operator docs after behavior stabilizes. Keep changelog language under `[Unreleased]`
    and roadmap claims tied to real PR/merge evidence.
12. Finish with focused tests, full rfmedia-cli regression, architecture/codegen checks,
    typecheck/build/format/lint/package checks, supported-Lidarr reconciliation evidence, review
    fixes, green CI, squash merge, and verified issue closure.

The implementation is complete only when the command surface, tests, all three completions,
operator docs, changelog, architecture/codegen gates, and evidence-backed roadmap state agree with
the shipped behavior.
