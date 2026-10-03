# Task Analysis: Lidarr Cascade Analysis and Indexer Budgets

## Executive Summary

Issue #219 is best implemented as a contract-first migration with one shared pure estimator and
one v3 sealing boundary. The critical path is configuration and persisted types, the estimator,
then v3 canonicalization and semantic validation in the plan engine. After that foundation is
stable, four builder families, nine plan producers, apply propagation, and presentation can be
worked in dependency-aware parallel lanes.

The main scheduling risk is not estimator complexity; it is partial migration across the current
plan families. Album monitoring still uses the v1 builder, ordinary artist operations and
artist-add use separate builders in `plan-engine.ts`, and album mutations and track filtering use
builders in their own modules. New production writers should switch to v3 together, while v1/v2
builders, canonicalizers, fixtures, checksums, reads, and apply behavior remain unchanged for
legacy compatibility.

Tasks below deliberately own one to three files each. Source and its focused test normally stay
together, while large shared hotspots (`lidarr-plan.ts`, `plan-engine.ts`, `apply.ts`, and the
presenter) are serialized rather than assigned to competing parallel tasks.

## Recommended Phase Structure

### Phase 1: Contracts and configuration

This phase establishes types and policy validation without changing any producer.

#### T01 — Add strict cascade configuration

- **Files**:
  - `packages/rfmedia-cli/src/types/config.ts`
  - `packages/rfmedia-cli/src/lib/config.ts`
  - `packages/rfmedia-cli/src/lib/config.test.ts`
- **Work**: Add optional `lidarr.cascadeAnalysis`, exact nested key allowlists, and validation for
  the four positive safe-integer fields capped at `1_000_000`. Cover omission, a complete valid
  policy, unknown keys, non-objects, zero, negative, fractional, unsafe, and over-cap values with
  exact property paths.
- **Depends on**: none.
- **Unlocks**: T03 and all producer migrations.

#### T02 — Define cascade and correlated v3 plan contracts

- **Files**:
  - `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- **Work**: Add the v3 discriminator, metric/policy/budget/code contracts, correlated v3 plan
  families, widened generation/apply output types, and a distributive v3 conversion type. Preserve
  the exact v1/v2 interfaces instead of making analysis optional on legacy shapes.
- **Depends on**: none.
- **Unlocks**: T03, T04, T05, T06, T16, and T17.

### Phase 2: Pure analysis and artifact foundation

The estimator and artifact boundary form the critical path. Do not start producer migration until
their APIs and v3 artifact representation are stable.

#### T03 — Implement the pure cascade estimator

- **Files**:
  - `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.test.ts`
- **Work**: Resolve and freeze the bounded plan-time policy, implement checked addition and
  multiplication, exhaustively map every operation family, assess both budgets, and derive stable,
  ordered, deduplicated warnings and recommendations. The table-driven suite should cover
  changed/no-op scope, exact zero versus unknown, modelled values, missing assumptions, omitted,
  equal, and exceeded allowances, deterministic ordering, and overflow.
- **Depends on**: T01 and T02.
- **Unlocks**: T04, T05, and T06.

#### T04 — Add v3 sealing, validation, and legacy dispatch

- **Files**:
  - `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- **Work**: Add a shared v3 sealing helper, fixed-order v3 canonicalizer, checksum dispatch,
  exact-key parser, semantic recomputation, widened stored-plan union, artifact read/write
  dispatch, and v3 entry points for ordinary artist, artist-add, and album-monitoring facts.
  Retain the current v1/v2 builders and canonicalizers byte-for-byte. Tests should freeze legacy
  checksums, prove deterministic v3 round trips, reject structural tampering, and reject
  semantically inconsistent analysis even after checksum recomputation.
- **Depends on**: T02 and T03.
- **Unlocks**: T05–T16.

### Phase 3: Family builders

These two tasks can run in parallel after T04. They must call the shared v3 sealing API rather than
copying analysis or checksum logic.

#### T05 — Add the album-mutation v3 builder

- **Files**:
  - `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts`
- **Work**: Keep album ID sorting, deduplication, operation-owned `hasChange`, entry validation,
  summary validation, and the v2 builder intact. Add a v3 builder that hands the already canonical
  album facts and resolved policy to the shared sealer. Cover album-edit unknown exposure and
  album-delete exact-zero/new file evidence.
- **Depends on**: T04.
- **Unlocks**: T12 and T13.

#### T06 — Add the track-filter v3 builder

- **Files**:
  - `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`
  - `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts`
- **Work**: Keep the exact single-album v2 builder and shape checks. Add a v3 builder using the
  shared sealer and prove the conditional candidate rule: one when reviewed removals can expose a
  monitored album to reacquisition, otherwise zero.
- **Depends on**: T04.
- **Unlocks**: T14.

### Phase 4: Producer migration

All nine producer tasks can proceed in parallel within their builder dependencies. Each producer
must resolve policy once before building, attach analysis before the preview/write branch, and
return or write the same v3 object. The phase is complete only when every production writer emits
v3.

#### T07 — Migrate artist monitoring

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`
- **Work**: Use the ordinary-artist v3 builder and verify changed-to-monitored modelling,
  changed-to-unmonitored zero exposure, and v3 output.
- **Depends on**: T01 and T04.

#### T08 — Migrate artist profile assignment

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`
- **Work**: Use the ordinary-artist v3 builder and preserve unknown conditional exposure where
  release/automation evidence is absent.
- **Depends on**: T01 and T04.

#### T09 — Migrate artist tag mutation

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.test.ts`
- **Work**: Use the ordinary-artist v3 builder, retain tag authorization semantics, and assert
  unknown conditional exposure without duplicating the estimator matrix.
- **Depends on**: T01 and T04.

#### T10 — Migrate artist deletion

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`
- **Work**: Use the ordinary-artist v3 builder and reuse sealed album, track-file, and byte
  evidence while reporting exact zero newly exposed acquisition candidates.
- **Depends on**: T01 and T04.

#### T11 — Migrate artist add

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`
- **Work**: Use the artist-add v3 builder. Preserve `searchForMissingAlbums: false`; unmonitored
  adds remain exact zero, while monitored extended adds use the sealed albums-per-artist
  assumption or remain unknown.
- **Depends on**: T01 and T04.

#### T12 — Migrate album monitoring from v1 to v3

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts`
- **Work**: Replace the production v1 builder call with the new v3 album-monitoring entry point.
  Prove false-to-true albums count exactly and true-to-false/no-op entries contribute zero. Do not
  remove or modify the legacy v1 builder used by compatibility tests.
- **Depends on**: T01 and T04.

#### T13 — Migrate album edit

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.test.ts`
- **Work**: Use the album-mutation v3 builder and prove preview and persisted plan share the same
  unknown conditional assessment.
- **Depends on**: T01 and T05.

#### T14 — Migrate album delete

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.test.ts`
- **Work**: Use the album-mutation v3 builder, preserve destructive authorization inputs and file
  evidence, and assert exact zero newly exposed acquisition work.
- **Depends on**: T01 and T05.

#### T15 — Migrate track-file filtering

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`
- **Work**: Use the track-filter v3 builder and prove preview/write parity for monitored and
  unmonitored album evidence.
- **Depends on**: T01 and T06.

### Phase 5: Apply and presentation

Apply propagation and presentation can begin after T04, but final assertions should wait for all
producer migrations so tests exercise the complete stored-plan union.

#### T16 — Propagate sealed analysis through apply

- **Files**:
  - `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
  - `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- **Work**: Replace narrow local plan aliases with the widened stored union where practical and
  copy the validated artifact's cascade analysis into every apply result path. Legacy v1/v2 plans
  yield only the output-level `not-recorded` state. Prove current config changes do not alter
  apply evidence and exceeded/unknown findings do not affect authorization, admission, ordering,
  mutation scope, retry, resume, history, claims, scan behavior, or exit status.
- **Depends on**: T02 and T04.
- **Unlocks**: T17.

#### T17 — Render consistent human and machine projections

- **Files**:
  - `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
  - `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- **Work**: Render a bounded cascade block before entry rows, label apply values as plan-time
  evidence, map stable codes to bounded prose, and add aggregate CSV fields. Prove JSON/YAML retain
  the structured sealed value, CSV remains one bounded row, human meaning survives `NO_COLOR`,
  stdout stays clean, and legacy plans show `NOT RECORDED`.
- **Depends on**: T16 and the Phase 4 completion gate.

### Phase 6: Documentation and delivery evidence

Documentation can be drafted after T02/T03, but final examples and claims should be checked against
the implemented output after T17.

#### T18 — Document operator behavior and configuration

- **Files**:
  - `rfmedia.example.yaml`
  - `packages/rfmedia-cli/README.md`
  - `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- **Work**: Document optional operator-chosen budgets and assumptions, horizons, certainty/basis,
  allowance states, stable codes, output formats, legacy `NOT RECORDED`, and the distinction from
  live provider quota and scheduler `operationBudget`.
- **Depends on**: T03 and T17.

#### T19 — Record the unreleased change

- **Files**:
  - `packages/rfmedia-cli/CHANGELOG.md`
- **Work**: Add a concise `[Unreleased]` entry describing v3 analysis, legacy compatibility, and
  the advisory/no-network boundary.
- **Depends on**: T17.

#### T20 — Close roadmap evidence after authoritative delivery

- **Files**:
  - `ROADMAP.md`
  - `docs/roadmap-archive.md`
- **Work**: Only after review, green CI, and authoritative merge/issue evidence, archive #219 with
  the real PR and date and recompute live issue totals.
- **Depends on**: all implementation, review, CI, and merge gates.

### Phase 7: Cross-cutting verification

#### T21 — Verify unchanged client and completion boundaries

- **Files**:
  - `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`
  - `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
  - `packages/rfmedia-cli/package.json`
- **Work**: Run the existing generated-client/codegen/architecture contracts and Bash/Zsh/Fish
  completion parity. No completion template, generated client, OpenAPI snapshot, endpoint, command,
  or flag should change; modify these files only if a real pre-existing contract gap is exposed.
- **Depends on**: T17.

## Task Granularity Recommendations

- Keep type ownership in T02. Do not let apply, presenter, or producer tasks independently widen
  `lidarr-plan.ts`; that would turn the central contract into a merge-conflict hotspot.
- Keep estimator implementation and its full operation matrix together in T03. Producer tests
  should assert their distinctive fact mapping and v3 wiring, not repeat every budget boundary.
- Keep all `plan-engine.ts` changes in T04. Splitting canonicalization, checksum dispatch,
  semantic validation, and stored-union work among parallel workers would create overlapping edits
  in a large, security-sensitive file.
- Pair each producer with its existing action test. This makes the nine-writer migration auditable
  and prevents one large integration test from obscuring which family was left on v1/v2.
- Treat T12 as a separate migration even though album monitoring looks similar to ordinary
  monitoring. It is the only current production writer still calling the v1 builder.
- Keep apply propagation separate from presentation. T16 proves advisory findings cannot influence
  execution; T17 proves the already-sealed evidence is represented consistently.
- Do not create tasks for Prowlarr, download clients, databases, generated Lidarr code, CLI flags,
  or completion-template edits. Those are explicit non-goals and boundary checks, not work lanes.
- Each task should leave its focused tests green before integration. Cross-package and repository
  gates belong to the final verification pass, not every producer task.

## Dependency Analysis

### Critical path

```text
T01 configuration contracts ─┐
                             ├─> T03 estimator ─> T04 v3 artifact engine ─> T16 apply ─> T17 output
T02 plan contracts ──────────┘                         │
                                                      ├─> T05 album builder ─> T13/T14
                                                      ├─> T06 track builder ─> T15
                                                      └─> T07–T12
```

T18/T19 follow the stable output contract. T20 follows authoritative delivery evidence rather
than merely passing local tests.

### Parallel lanes

- T01 and T02 are independent and can start together.
- After T04, T05 and T06 can run together.
- T07–T12 can run concurrently once T04 is stable.
- T13/T14 can run concurrently after T05; T15 can run concurrently after T06.
- T16 can proceed alongside producer migrations after T04, but its final union coverage must be
  rebased onto all nine migrated families.
- T18 documentation drafting can overlap late implementation, while final verification waits for
  T17.

### Shared-file conflict controls

| Hotspot                                 | Single owner | Reason                                                     |
| --------------------------------------- | ------------ | ---------------------------------------------------------- |
| `types/lidarr-plan.ts`                  | T02          | Central v3, generation, and apply contracts                |
| `lib/lidarr/plan-engine.ts`             | T04          | Canonicalization, validation, checksums, storage, builders |
| `actions/lidarr/apply.ts`               | T16          | Admission and all result-return paths                      |
| `commands/lidarr-mutation-presenter.ts` | T17          | Shared human and CSV projection                            |
| `commands/lidarr.test.ts`               | T17          | Large shared command/presenter suite                       |

### Integration gates

1. **Foundation gate**: T01–T04 focused tests pass; v1/v2 golden contracts remain unchanged.
2. **Builder gate**: T05/T06 prove family-specific v3 sealing through the shared engine.
3. **Producer gate**: a search for production calls to v1/v2 builders finds no new-plan writer;
   compatibility tests may still call legacy builders.
4. **Apply gate**: T16 proves analysis is copied, not recomputed, and is never an admission input.
5. **Output gate**: T17 proves human/JSON/YAML/CSV parity and clean stdout.
6. **Boundary gate**: no generated/OpenAPI/client/completion surface diff; contracts and parity pass.
7. **Delivery gate**: focused suite, full `rfmedia-cli` suite, typecheck, build, coverage,
   architecture/codegen contracts, markdown lint, repository pre-push checks, review, and CI pass.

## File-to-Task Mapping

| File                                                                       | Task | Responsibility                                    |
| -------------------------------------------------------------------------- | ---- | ------------------------------------------------- |
| `packages/rfmedia-cli/src/types/config.ts`                                 | T01  | Optional cascade config shape                     |
| `packages/rfmedia-cli/src/lib/config.ts`                                   | T01  | Exact bounded validation                          |
| `packages/rfmedia-cli/src/lib/config.test.ts`                              | T01  | Valid/omitted and invalid matrix                  |
| `packages/rfmedia-cli/src/types/lidarr-plan.ts`                            | T02  | Cascade contracts, v3 unions, result types        |
| `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`                  | T03  | Pure policy resolution and estimator              |
| `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.test.ts`             | T03  | Exhaustive estimator matrix                       |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                       | T04  | V3 sealing, canonicalization, validation, storage |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`                  | T04  | V3 tamper and legacy checksum contracts           |
| `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`             | T05  | Album edit/delete v3 builder                      |
| `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts`        | T05  | Album-family analysis facts                       |
| `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`      | T06  | Track-filter v3 builder                           |
| `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts` | T06  | Reacquisition candidate rule                      |
| `packages/rfmedia-cli/src/actions/lidarr/plan.ts`                          | T07  | Artist-monitoring producer                        |
| `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`                     | T07  | Artist-monitoring v3 wiring                       |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`          | T08  | Profile producer                                  |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`     | T08  | Profile unknown exposure                          |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`              | T09  | Tag producer                                      |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.test.ts`         | T09  | Tag unknown exposure                              |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`            | T10  | Artist-delete producer                            |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`       | T10  | Delete evidence and exact zero                    |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`               | T11  | Artist-add producer                               |
| `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`          | T11  | Monitored/unmonitored add rules                   |
| `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`                   | T12  | Album-monitoring v1-to-v3 migration               |
| `packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts`              | T12  | Exact album monitoring counts                     |
| `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts`               | T13  | Album-edit producer                               |
| `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.test.ts`          | T13  | Preview/write unknown parity                      |
| `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.ts`             | T14  | Album-delete producer                             |
| `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.test.ts`        | T14  | Delete evidence and exact zero                    |
| `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`             | T15  | Track-filter producer                             |
| `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`        | T15  | Preview/write candidate parity                    |
| `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                         | T16  | Sealed analysis propagation                       |
| `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`                    | T16  | Advisory and legacy apply invariants              |
| `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`           | T17  | Human and CSV representation                      |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                         | T17  | Human/machine/apply parity                        |
| `rfmedia.example.yaml`                                                     | T18  | Operator-chosen configuration example             |
| `packages/rfmedia-cli/README.md`                                           | T18  | Public configuration and limitations              |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`                  | T18  | Canonical v3 plan/apply semantics                 |
| `packages/rfmedia-cli/CHANGELOG.md`                                        | T19  | Unreleased feature entry                          |
| `ROADMAP.md`                                                               | T20  | Live roadmap accounting                           |
| `docs/roadmap-archive.md`                                                  | T20  | Shipped issue evidence                            |
| `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`           | T21  | Generated-client boundary guard                   |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`         | T21  | Bash/Zsh/Fish parity guard                        |
| `packages/rfmedia-cli/package.json`                                        | T21  | Authoritative verification scripts                |

## Optimization Opportunities

- Introduce one shared v3 sealer that accepts canonical family facts and a resolved policy. This
  avoids four versions of checksum/analysis assembly and makes semantic recomputation use the same
  pure estimator as planning.
- Resolve policy once per producer invocation and pass a frozen credential-free value downward.
  This prevents repeated global-config reads and makes preview and artifact output identical.
- Derive `changed` from each family's existing `hasChange` evidence. Do not introduce another
  operation semantics registry merely for analysis.
- Use a compact, exhaustive estimator switch and constant-size metric output. Runtime remains
  `O(entries)` with no I/O and no need for progress, caching, concurrency, or dependencies.
- Centralize warning and recommendation order in allowlisted tuples. Deterministic derivation and
  canonicalization then need no locale-sensitive sorting or prose comparison.
- Reuse the shared widened plan union in apply and presenter instead of maintaining narrower local
  unions that can omit a new family.
- Concentrate boundary coverage: one dense estimator suite, one artifact-contract suite, and one
  family migration assertion per producer provide stronger evidence with less duplicated testing.
- Let existing JSON/YAML envelopes carry structured analysis naturally. Add custom logic only for
  human and flattened CSV output.
- Keep legacy paths behind explicit version dispatch rather than normalizing old artifacts into
  v3. This avoids data migration, synthetic evidence, and checksum drift.
- Audit completion templates without editing them. No command or flag changes means a zero-diff
  result is the intended optimization.

## Implementation Strategy Recommendations

1. Land T01 and T02 first and treat their public shapes as a review checkpoint. Changes after
   producer work begins will multiply conflicts.
2. Build T03 test-first from the feature-spec operation matrix. Include future-operation
   exhaustiveness so a new mutation kind cannot silently receive default analysis.
3. In T04, keep `canonicalizePlan` and `canonicalizePlanV2` untouched. Add separate v3 dispatch and
   prove frozen v1/v2 fixtures before migrating any writer.
4. Make the semantic validator recompute the expected analysis from canonical facts plus the
   sealed assumptions and limits. Shape validation and a recomputed checksum alone are not enough.
5. Complete the family builders before assigning their producer lanes. Producer tasks should be
   mechanical wiring plus focused family assertions, not alternate estimator implementations.
6. Use a producer completion checklist covering all nine writers. A repository search for
   `buildLidarrMutationPlan(` and `buildLidarr*PlanV2(` should leave production call sites only
   where explicitly retained for legacy compatibility.
7. Add analysis to every apply return path from the already validated plan object. Never call the
   estimator or read current cascade configuration during apply.
8. Verify exceeded and unknown assessments with a real non-dry-run apply test that observes
   unchanged entry scope and authorization behavior; do not rely only on presenter assertions.
9. Implement human and CSV projection after apply propagation. JSON/YAML should require little or
   no command-layer change because the structured plan/result envelopes already flow through the
   formatter.
10. Run focused tests in dependency order, then the package suite, coverage, typecheck/build,
    generated-client/codegen/architecture contracts, completion parity, markdown lint, and the
    full repository/pre-push gates.
11. After code changes, refresh the repository graph when the configured graphify workspace is
    available; do not create unrelated graph output in a worktree that lacks the existing graph.
12. Update ROADMAP/archive evidence only from confirmed PR, CI, merge, and issue state. Do not
    predeclare delivery from local implementation alone.
