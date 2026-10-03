# Lidarr Cascade Analysis and Indexer Budgets Implementation Plan

Issue #219 will add a strict `rfmedia.lidarr-plan.v3` contract to every newly written Lidarr
mutation plan. A pure, credential-free analyzer will derive immediate and conditional effects from
canonical plan facts plus a bounded plan-time configuration snapshot, then the artifact engine will
seal and semantically validate that analysis. All nine current producers will migrate together,
while v1/v2 checksum bytes, validation, reads, and apply behavior remain compatible. Apply and
presentation will expose sealed plan-time evidence without turning advisory allowances into
execution controls or adding a network, database, CLI, dependency, or completion surface.

## Critically Relevant Files and Documentation

- `docs/plans/lidarr-cascade-analysis/feature-spec.md`: authoritative v3 contract, estimation
  matrix, and resolved product decisions.
- `docs/plans/lidarr-cascade-analysis/shared.md`: consolidated architecture, boundaries, testing,
  documentation, and non-goals.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: persisted plan families and public result types.
- `packages/rfmedia-cli/src/types/config.ts`: Lidarr configuration contract.
- `packages/rfmedia-cli/src/lib/config.ts`: config loading and strict validation patterns.
- `packages/rfmedia-cli/src/lib/loaded-config.ts`: existing process-level source for validated
  Lidarr configuration.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: canonicalization, validation, checksums,
  artifact storage, history, claims, and common builders.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: artist-family canonical
  change semantics.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`: album edit/delete family.
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`: track-filter family.
- `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`: fail-closed untrusted-data primitives.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: authoritative apply admission and execution
  orchestration.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: shared human and CSV
  presentation.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: operator-facing artifact/apply
  contract.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: private generated API boundary
  that must remain unchanged.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Bash/Zsh/Fish parity guard.
- `.github/pull_request_template.md`: mandatory delivery template.

## Implementation Plan

### Phase 1: Contracts and Configuration

#### Task 1.1: Add Strict Cascade Configuration Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

Add optional `lidarr.cascadeAnalysis` with exact nested `budgets` and `assumptions` objects. Support
only `indexerQueries`, `acquisitionCandidates`, `albumsPerArtist`, and
`indexerQueriesPerCandidate`; each value must be a positive safe integer no greater than
`1_000_000`. Preserve omission, reject arrays/unknown keys/invalid values with precise
`ConfigError` paths, and cover the contract with one valid/omitted case plus a compact
parameterized invalid matrix.

#### Task 1.2: Define Cascade and Correlated v3 Plan Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `docs/plans/lidarr-cascade-analysis/feature-spec.md`
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`

Add the v3 discriminator, immutable policy/metric/assessment/warning/recommendation contracts,
stable code unions, correlated v3 plan families, and recorded-versus-legacy result evidence.
Preserve every v1/v2 interface exactly. Use a distributive mapping where it retains family
correlation, but define any v3-only entry fact needed for deterministic validation explicitly.
Track-filter v3 must seal the album monitored state because v2 delete-candidate facts alone cannot
deterministically distinguish zero from one conditional reacquisition candidate.

### Phase 2: Pure Analysis and Artifact Foundation

#### Task 2.1: Implement the Pure Cascade Estimator Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-cascade-analysis/feature-spec.md`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.test.ts`

Files to Modify

- None.

Resolve and freeze the bounded plan-time policy with explicit `null` omissions. Implement checked
safe-integer addition/multiplication, an exhaustive operation-family estimator, separate
conditional query and acquisition allowance assessments, and deterministic ordered/deduplicated
warning/recommendation codes. Analyze changed scope only; preserve known zero versus unknown.
Centralize the critical matrix here: changed/no-op cases, monitored directions, delete/edit/tag
families, tracked-file monitoring evidence, missing assumptions, omitted/equal/exceeded
allowances, stable ordering, and overflow. The module must be synchronous, `O(entries)`, and free
of clients, credentials, configuration globals, databases, and I/O.

#### Task 2.2: Add v3 Sealing, Validation, and Legacy Dispatch Depends on [1.2, 2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

Add a common v3 sealer plus fixed-order nested canonicalization, exact structural/semantic
validation, checksum dispatch, and artifact read/write support for every correlated v3 family.
Widen the stored-plan union and add v3 entry points for the engine-owned ordinary artist,
artist-add, and album-monitoring facts; Tasks 3.1 and 3.2 will adapt the remaining family builders
to this complete engine contract. The semantic validator must recompute expected analysis from
canonical facts plus sealed assumptions/limits and reject a false re-checksummed artifact. Retain
current v1/v2 builders, canonicalizers, exact-key validators, and checksum bytes. Cover
deterministic v3 round-trip/checksum behavior, structural and semantic tampering, and
representative unchanged legacy fixtures.

### Phase 3: Family Builders

#### Task 3.1: Add the Album-Mutation v3 Builder Depends on [2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts`

Keep v2 sorting, deduplication, operation-owned `hasChange`, entry/summary validation, and builder
behavior intact. Add a v3 builder that hands canonical album facts and resolved policy to the
shared sealer. Add focused cases for album-edit unknown conditional exposure and album-delete
exact-zero new acquisition exposure while preserving file evidence.

#### Task 3.2: Add the Track-Filter v3 Builder Depends on [2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.test.ts`

Keep the exact v2 single-album shape and builder unchanged. Add a v3 builder that seals the
reviewed album monitored fact before calling the shared sealer. Prove one conditional
reacquisition candidate when reviewed removals affect a monitored album and zero when the album is
unmonitored or no files are removed.

### Phase 4: Producer Migration

Every producer task must first read `packages/rfmedia-cli/src/lib/loaded-config.ts`, obtain the
validated Lidarr cascade subtree once through the existing loaded-config boundary, resolve it into
the credential-free explicit-null policy, and pass that policy to its v3 builder. Do not add new
global state or read cascade configuration during apply.

#### Task 4.1: Migrate Artist Monitoring Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`

Resolve policy once, use the ordinary-artist v3 builder before the preview/write branch, and prove
v3 output plus monitored modelling and unmonitored exact-zero exposure. Preserve selection,
batching, no-op, dry-run, and artifact behavior.

#### Task 4.2: Migrate Artist Profile Assignment Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`

Resolve policy once, call the ordinary-artist v3 builder, and preserve unknown conditional
exposure where release/automation evidence is absent. Assert v3 wiring and preview/write parity
without duplicating the estimator matrix.

#### Task 4.3: Migrate Artist Tag Mutation Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.test.ts`

Resolve policy once and use the ordinary-artist v3 builder. Retain tag authorization and selection
semantics, and prove unknown conditional exposure and stable v3 artifact output.

#### Task 4.4: Migrate Artist Deletion Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.test.ts`

Resolve policy once and use the ordinary-artist v3 builder. Reuse canonical album, track-file, and
byte evidence while reporting exact zero newly exposed acquisition work; preserve destructive
authorization inputs and delete semantics.

#### Task 4.5: Migrate Artist Add Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`

Resolve policy once and use the artist-add v3 builder. Preserve
`searchForMissingAlbums: false`; unmonitored adds remain exact zero, and monitored extended adds
use the sealed albums-per-artist assumption or remain unknown. Preserve expected-absence and
foreign-ID safeguards.

#### Task 4.6: Migrate Album Monitoring from v1 to v3 Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.test.ts`

Replace the production v1 builder call with the v3 album-monitoring entry point and resolve policy
once. Prove false-to-true albums count exactly, true-to-false/no-op entries add zero exposure, and
preview/write output is the same. Do not remove or change the v1 builder retained for compatibility.

#### Task 4.7: Migrate Album Edit Depends on [1.1, 3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.test.ts`

Resolve policy once, use the album-mutation v3 builder, and prove the preview and persisted plan
share the same unknown conditional assessment. Preserve resource references, batching, and
idempotency.

#### Task 4.8: Migrate Album Delete Depends on [1.1, 3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.test.ts`

Resolve policy once, use the album-mutation v3 builder, preserve destructive authorization and
canonical file evidence, and assert exact zero newly exposed acquisition work.

#### Task 4.9: Migrate Track-File Filtering Depends on [1.1, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.test.ts`

Pass the already-read album monitored state and resolved policy into the v3 builder. Prove
preview/write parity for monitored and unmonitored albums without adding an apply-time live read.

### Phase 5: Apply and Presentation

#### Task 5.1: Propagate Sealed Analysis Through Apply Depends on [1.2, 2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

Reuse the widened stored union where practical and copy the validated artifact's recorded
analysis—or an output-only legacy `not-recorded` state—into every dry-run and real apply result,
including specialized artist-add and track-filter returns. Prove apply never reads current cascade
config or recomputes analysis, and exceeded/unknown evidence does not affect authorization,
admission, ordering, scope, claims, history, retry/resume, scanning, result status, or exit status.

#### Task 5.2: Render Consistent Human and Machine Projections Depends on [1.2, 2.2, 5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Render a compact cascade block before entry rows, label apply values as plan-time evidence, map
stable codes to bounded prose, and add bounded aggregate CSV fields. JSON/YAML should retain the
structured sealed value through existing envelopes. Prove one clean machine document, human
stderr separation, `NO_COLOR` meaning, preview/apply parity, and legacy `NOT RECORDED`. Presenter
implementation may proceed alongside producer migrations; run final cross-producer parity
assertions only after Tasks 4.1–4.9 are complete.

### Phase 6: Documentation and Verification

#### Task 6.1: Document Operator Behavior and Configuration Depends on [2.1, 5.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `rfmedia.example.yaml`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

Document operator-chosen budgets and assumptions, metrics/horizons/certainty/basis, allowance
states, stable codes, output formats, legacy `NOT RECORDED`, and zero-versus-unknown. Make clear
that this is static conditional plan-time evidence, not live Prowlarr quota, provider capacity,
elapsed-time prediction, scheduler `operationBudget`, or apply enforcement.

#### Task 6.2: Record the Unreleased Change Depends on [5.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/CHANGELOG.md`
- `docs/plans/lidarr-cascade-analysis/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/CHANGELOG.md`

Add a concise `[Unreleased]` entry for v3 analysis, legacy compatibility, configured advisory
allowances, and the no-network/no-new-CLI boundary. Do not claim a release.

#### Task 6.3: Verify Client, CLI, Completion, and Repository Boundaries Depends on [4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5.2, 6.1, 6.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- None; this is a verification task unless a genuine in-scope contract defect is exposed.

From the repository worktree root, run focused changed suites with
`npm run test:run -w packages/rfmedia-cli -- <test files>`, then
`npm run test:rfmedia`, `npm run test:coverage:rfmedia`, `npm run test:contracts`,
`npm run typecheck`, `npm run build:all`, `npm run lint`, `npm run format:check`, and the exact
pre-push gate `npm run test:run`. Run
`npm run test:run -w packages/rfmedia-cli -- src/lib/shell-completions/templates.spec.ts`
explicitly to record Bash/Zsh/Fish parity. Confirm no
generated/OpenAPI/client/transport/completion/command/flag/dependency/database surface changed.
Use a standard umask for the known environment-sensitive caller-owned-directory mode assertion;
do not weaken that contract to accommodate a restrictive runner umask. Refresh graphify only when
operating against the configured graph workspace.

### Phase 7: Review, Delivery, and Authoritative Closeout

#### Task 7.1: Review, PR, CI, and Squash Merge Depends on [6.3]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/lidarr-cascade-analysis/feature-spec.md`
- `packages/rfmedia-cli/AGENTS.md`

**Instructions**

Files to Create

- A local code-review artifact under `docs/prps/reviews/` if required by the review workflow.

Files to Modify

- Only files needed to resolve actionable review or CI findings.

Perform a structured code review after implementation, fix every actionable finding, and rerun
affected gates. Commit and push without bypassing hooks, open a PR using every required template
section with `Closes #219`, inspect all review-thread/comment surfaces, obtain green authoritative
CI on the active head SHA, and squash merge. Verify the PR is merged and #219 is closed before
removing the implementation worktree. Treat each review or CI repair as a newly scoped step that
names its affected one-to-three files and the exact gates to rerun; do not use this lifecycle task
as authorization for unrelated broad edits.

#### Task 7.2: Archive Roadmap Evidence in a Closeout PR Depends on [7.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

After authoritative implementation merge and issue closure, recompute live GitHub issue totals,
remove #219 from the active roadmap, and archive it with the actual implementation PR/date. Use a
fresh isolated closeout branch/worktree, a templated PR, green CI, review resolution, and squash
merge so roadmap claims are based on delivered evidence rather than predeclared in the
implementation PR. Verify final default-branch alignment, then clean the closeout branch/worktree.

## Advice

- Treat `types/lidarr-plan.ts`, `plan-engine.ts`, `apply.ts`, and the presenter as single-owner
  hotspots. Parallelize around them, not within them.
- The v3 track-filter contract must seal album monitored state; neither v2 facts nor apply-time
  state can support deterministic semantic recomputation.
- Album monitoring is the only current production writer still using v1. Keep the v1 builder for
  compatibility while explicitly migrating that action to a distinct v3 entry point.
- A version discriminator alone does not identify artist-add, album-mutation, and track-filter
  families. Keep operation/entry/summary correlation and family-specific validation strict.
- Build canonical facts, analyze once, canonicalize v3, validate semantics, checksum, freeze, then
  preview or write that exact object.
- The estimator must preserve `0` versus `null`, use explicit assumptions only, and fail on safe
  integer overflow. Never invent provider quota, elapsed time, downloads, or universal defaults.
- Exceeded and unknown findings are evidence only. They must not influence any apply control flow.
- Completion templates should remain byte-unchanged because no command or flag is added; prove
  Bash/Zsh/Fish parity with the existing test.
- The implementation PR should not predeclare roadmap completion. Archive #219 only after
  authoritative merge and issue closure, using a separate closeout PR if repository policy
  requires evidence to precede the roadmap claim.
