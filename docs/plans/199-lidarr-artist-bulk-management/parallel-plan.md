# Lidarr Artist Bulk Profile and Tag Management Implementation Plan

Issue #199 extends the current Lidarr sealed plan/apply protocol with separate profile and tag plan
producers while retaining `lidarr apply` as the sole write entry point. The implementation first
stabilizes strict version 2 plans with immutable version 1 compatibility and, in parallel, adds
bounded profile/tag domain projections; it then converges through the narrow client facade, pure
selection, operation definitions, producers, verified apply lifecycle, CLI, completions, executable
architecture policy, and documentation. Work runs in the existing
`feat/199-lidarr-artist-bulk-management` checkout with tests owned alongside each behavioral change.
Final release evidence must prove v1 read/apply/resume compatibility, v2 strictness, one-artist
verified writes, complete output/completion parity, and the full PR/CI/merge/issue-cleanup lifecycle.

## Critically Relevant Files and Documentation

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`: Settled product, safety,
  compatibility, and completion contract.
- `docs/plans/199-lidarr-artist-bulk-management/shared.md`: Repository map, patterns, and required
  reading.
- `docs/plans/199-lidarr-artist-bulk-management/analysis-code.md`: Exact implementation seams and
  gotchas.
- `packages/rfmedia-cli/AGENTS.md`: Package-local TypeScript, command/action, test, and
  documentation rules.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Existing v1 plan and apply-result protocol.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Schemas, checksums, operations, artifacts,
  history, resume, and claims.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-operation importer and artist
  editor body owner.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Generic preflight, execution, durability,
  deferred, and resume lifecycle.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Commander grammar, rendering, approval, and output
  envelopes.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Current operator and security contract.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Generated/manual ownership and
  drift contract.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Scheduler lane and retry
  ownership.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`: Immutable snapshot and generator
  provenance.
- `.github/pull_request_template.md`: Required final PR structure and testing evidence.
- `ROADMAP.md`: Living issue status that must be updated with real delivery evidence.

## Implementation Plan

Every implementation task that touches `packages/rfmedia-cli` code, tests, or documentation must
first read `packages/rfmedia-cli/AGENTS.md` in addition to its task-specific reading.

### Phase 1: Parallel Protocol and Domain Foundations

#### Task 1.1: Preserve v1 and introduce strict Lidarr plan v2 Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Create

- None; this task extends the existing versioned protocol.

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

Freeze current v1 behavior with fixture-based assertions before changing current plan construction.
Add an exact `rfmedia.lidarr-plan.v2` discriminated union for monitoring, profile assignment, and
tag mutation, including canonical selection context, operation-specific entries, observed apply
evidence, stale findings, risk, and summaries. Dispatch artifact validation and checksum generation
strictly by version; retain the v1 parser, canonical key order, checksum bytes, history identity,
and resume behavior without rewriting old artifacts. Reject unknown versions, operation/entry/risk
inconsistency, unknown keys, recursively sensitive/prototype keys, invalid bounds, unsorted targets
or sets, and incorrect idempotency. Keep artifact I/O, history, claims, and resume infrastructure
operation-neutral. Run
`npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/plan-engine.test.ts`
and `git diff --check`.

#### Task 1.2: Add bounded Lidarr profile and tag domain projections Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

**Instructions**

Files to Create

- None; these are additions to the stable domain boundary.

Files to Modify

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`

Add immutable generated-independent `LidarrProfile` and `LidarrTag` types plus any narrow
profile-assignment/tag-mode inputs shared by the facade and actions. Add whole-response projectors
for quality profiles, metadata profiles, tags, and targeted artists. Require bounded collection
sizes, positive safe integer IDs, bounded non-empty labels without terminal/control/bidirectional
characters, and normalized ascending unique artist tag IDs. Reject a malformed whole response
rather than partially accepting mutation authority, return fresh immutable values, add JSDoc for
exports, and avoid exposing generated DTOs. Use client tests for wire projection coverage in the
dependent facade task; run `npm run typecheck --workspace packages/rfmedia-cli` and
`git diff --check`.

### Phase 2: Parallel Facade, Selection, and Generated Contracts

#### Task 2.1: Extend the narrow Lidarr client facade Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`

**Instructions**

Files to Create

- None; generated output already contains the required operations.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

Extend `LidarrClientApi` and `LidarrClient` with fresh quality-profile, metadata-profile, tag, and
targeted-artist reads plus intent-bearing one-artist profile assignment and tag mutation methods.
Import generated operations only in `packages/rfmedia-cli/src/lib/lidarr/client.ts`; validate all
inputs before transport and construct minimal allowlisted bodies containing `artistIds: [id]` plus
only requested profile fields or normalized `tags` and explicit `applyTags`. Make monitoring,
movement, deletion, import exclusion, search, and all other editor fields unrepresentable. Accept
successful empty/unknown-body `2xx`, including `202`, but never treat the body as authoritative.
Assert exact generated operation/path/body behavior, dangerous-field absence, malformed resource
rejection, bounds, already-aborted and in-flight cancellation, two-client origin/key isolation, and
credential-free errors. Run
`npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/client.test.ts`.

#### Task 2.2: Implement pure artist selection and resource resolution Depends on [1.2]

**READ THESE BEFORE TASK**

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`
- `packages/rfmedia-cli/src/actions/lidarr/list.ts`
- `packages/rfmedia-cli/src/actions/lidarr/list.test.ts`
- `packages/rfmedia-cli/src/types/lidarr.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.test.ts`

Files to Modify

- None; do not couple mutation selection to the paged list action.

Implement a pure, I/O-free selector and resolver. Require exactly one mode: unique known positive
artist IDs, one or more filters, or explicit `--all`. Parse resource references so positive decimal
means ID, `name:` forces a name, and other text uses trimmed case-insensitive exact matching;
unknown or duplicate normalized matches fail with bounded `name (id)` choices. Implement AND across
filter families, all-of repeated tag selectors, ascending artist order, complete-cohort zero-match
failure, and cap enforcement only after full matching (default 25, hard maximum 1,000). Add sorted
unique tag algebra for add/remove/set/clear and exact added/removed/retained deltas. Table-test
conflicts, ambiguity, numeric names, unknown IDs, all-of semantics, no truncation, cap boundaries,
deterministic ordering, no-op sets, and every tag mode. Do not import or call `executeLidarrList`.

#### Task 2.3: Protect required generated operations offline Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

**Instructions**

Files to Create

- None; this task extends existing executable contracts.

Files to Modify

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Require the checked-in artist-by-ID, quality-profile, metadata-profile, tag, and artist-editor
operations and paths in the offline codegen contract. Preserve deterministic staging, manifest/
config identity, compilation, drift behavior, generated authentication disablement, and rollback
tests. Do not edit or refresh the OpenAPI snapshot and do not add a dependency. Run
`codegen:lidarr:check`, `test:codegen:lidarr`, and the focused generated-contract test.

### Phase 3: Facade Delegation, Fixtures, and Operation Convergence

#### Task 3.1: Forward new facade methods without mutation retries Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

**Instructions**

Files to Create

- None; extend the explicit decorator.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`

Delegate every new `LidarrClientApi` method explicitly. Classify only safe reads for bounded
in-place retry where repository policy permits, keep planning/apply mutation-authorizing reads out
of stale-cache fallback, and prove profile/tag mutations are never cached or automatically retried
in place. Preserve cancellation identity, breaker feeds, operation metadata, and per-instance
client isolation. Run
`npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/resilience.test.ts`.

#### Task 3.2: Extend typed Lidarr action mocks and fixtures Depends on [2.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`

**Instructions**

Files to Create

- None; extend shared test helpers.

Files to Modify

- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`

Keep the mapped mock exhaustive over `LidarrClientApi`, add safe resolved defaults and mutation
spies, and provide reusable bounded profile/tag fixtures plus artist variants with deterministic
profile/tag state. Return fresh immutable values so tests cannot share mutable state. Preserve
existing monitoring, health, status, wanted, and list test behavior. Run the action suites most
directly consuming these helpers:
`npm run test:run --workspace packages/rfmedia-cli -- src/actions/lidarr/plan.test.ts src/actions/lidarr/apply.test.ts`.

#### Task 3.3: Register profile and tag operation semantics Depends on [1.1, 2.1, 2.2]

**READ THESE BEFORE TASK**

- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`

**Instructions**

Files to Create

- None; keep operation definitions in the existing plan engine for this task.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

Generalize the operation-definition seam only as far as monitoring, profile assignment, and tag
mutation require. Each definition owns canonical operation state, risk/cascade facts, entry
construction, change detection, idempotency, structured live classification, referenced-resource
preflight, minimal execution, verified postcondition rules, exact deferred payload validation, and
replay matching. Profiles manage quality, metadata, or both and permit safe partial convergence.
Tag add/remove tolerate unrelated tags; set/clear require exact reviewed-before or exact desired
sets. Register exact executor identities and credential-free payloads without changing the
schema-v10 queue. Classify profiles medium risk, tag deltas low risk, and tag replacement high risk.
Test deterministic checksums, operation/entry/risk consistency, all no-op states, drift rules,
payload exactness, idempotency, and v1 regression behavior. Run
`npm run test:run --workspace packages/rfmedia-cli -- src/lib/lidarr/plan-engine.test.ts`.

### Phase 4: Parallel Plan Producers and Monitoring Migration

#### Task 4.1: Add the artist profile plan producer Depends on [3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.test.ts`

Files to Modify

- None; exports are integrated in Task 4.3.

Add a read-only plan action that resolves a fresh `local-only` no-stale/no-retry client, fetches
the complete artist list and only required profile resources once, validates selectors and at least
one desired profile, resolves IDs/names exactly, builds exact managed before/after entries, and
writes an atomic sealed v2 artifact only after successful construction. Preserve a non-empty
all-no-op cohort as an auditable plan and fail zero matches, unknown/ambiguous resources, duplicate/
unknown IDs, or cap overflow without writing an artifact. Assert combined quality+metadata
assignment, partial/no-op states, deterministic order, fresh reads, and zero editor calls.

#### Task 4.2: Add the artist tag plan producer Depends on [3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.test.ts`

Files to Modify

- None; exports are integrated in Task 4.3.

Add a read-only plan action that fetches fresh artists/tags once, validates exactly one
add/remove/set/clear mode, resolves existing tags exactly, selects a complete deterministic cohort,
and seals normalized full before/after sets plus added/removed/retained deltas. Add/remove/set
require at least one unique tag; only explicit clear produces an empty replacement. Set/clear plans
must carry high-risk destructive-to-assignment facts and exact removal evidence. Test all four
modes, unrelated tag preservation, replacement removals, all-no-op, selection by a tag being
changed, reference failures, cap/zero-match behavior, and zero editor calls.

#### Task 4.3: Move monitoring writes to v2 and export all producers Depends on [3.3, 4.1, 4.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

**Instructions**

Files to Create

- None; preserve the current monitoring command surface.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Make new artist-monitoring plans write strict v2 while retaining the exact existing command
behavior, selection semantics, risk, output, and v1 read/apply/resume compatibility. Export the
profile and tag producer actions and their public option/result contracts through the established
barrel without eager-loading generated code. Prove planning remains mutation-free and current
monitoring tests remain green.

### Phase 5: Verified Generic Apply

#### Task 5.1: Add resource preflight, targeted verification, and exact resume Depends on [3.1, 3.2, 3.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`

**Instructions**

Files to Create

- None; extend the existing generic lifecycle.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`

Generalize apply across v1 monitoring and all v2 operations without duplicating lifecycle branches.
Before any write, freshly resolve referenced resource IDs and all pending artists, reporting every
missing/stale item; same-ID renames warn and update display context, while deletions block the run.
Keep dry-run claim-, history-, deferred-, and mutation-free. For real apply, hold the exclusive
claim, target-read immediately before each admission, send one `artistIds: [id]` editor request,
target-read again, and persist success only when the operation definition verifies its managed
postcondition. Preserve before/after/observed evidence. Reconcile post-dispatch timeouts/
cancellation; if unresolved, record uncertain, stop later admissions, and require `--resume`.
Exercise delayed-visibility tests and choose an explicit small bounded reconciliation policy only
if a single immediate targeted read is insufficient; cap its attempts/time, keep it cancellable,
and never turn it into a blind editor retry.
Defer only confirmed retryable pre-write failures, exact-match deferred operation/payload/
idempotency on resume, and preserve history-write uncertainty. Cover initial zero-write block,
satisfied no-op, profile partial convergence, tag delta tolerance, replacement drift, claim loss,
cancellation, verification failure, uncertain stop, deferred replay, and v1 resume regression.
Assert stable structured failure fields for code, stage, plan identity, target IDs, dispatch state,
verification state, retryability, and safe next action without persisting secrets.

### Phase 6: CLI, Output, Completion, and Conditional CSV Safety

#### Task 6.1: Add CLI grammar, rendering, and replacement authorization Depends on [4.3, 5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/formatters/index.ts`
- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`

**Instructions**

Files to Create

- None; extend the established Lidarr command namespace.

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

Register `lidarr plan artist-profiles` and `lidarr plan artist-tags` with the settled selection,
resource-reference, change, cap, plan-path, and safety options. Commander expresses simple
conflicts, while actions remain the semantic trust boundary. Render operation-aware aggregate and
per-artist before/after state, names with IDs, all-no-op, stale/uncertain recovery, and destructive
tag removals. Show 20 human rows by default and every row under global `--verbose`; artifacts and
JSON/YAML/CSV remain complete. Preserve exactly one machine document on stdout, human review on
stderr, live dry-run before default-no interactive confirmation, reviewed plan ID/checksum pinning,
and `--yes` for machine/non-TTY apply. Require purpose-specific `--allow-tag-replacement` for
set/clear in addition to generic approval. Test hierarchy, bare-help no-network behavior, parsers,
conflicts, forwarding, output parity, truncation, approvals, replacement authorization, exits, and
copy-pasteable recovery. Group help under selection, desired changes, safety, connection, and
output, and assert stable machine error-envelope fields mirror the action result without leaking
credentials.

#### Task 6.2: Update Bash, Zsh, and Fish completion parity Depends on [6.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**

Files to Create

- None; completions remain static and offline.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add both plan leaves and every shared selection, profile/tag change, cap, plan-path, and replacement
safety option to all three shells. Preserve static zero-network generation, repeatable tag-option
behavior, plan-file completion, value candidates, hierarchy, descriptions, and existing commands.
Extend parity tests to prove exact operation and option agreement across Bash, Zsh, and Fish.

#### Task 6.3: Verify and harden CSV formula handling if needed Depends on [6.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/formatters/index.ts`
- `packages/rfmedia-cli/src/lib/formatters/formatters.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr.ts`

**Instructions**

Files to Create

- None; this is an evidence-driven compatibility check.

Files to Modify

- `packages/rfmedia-cli/src/lib/formatters/index.ts` only if the existing shared serializer lacks
  formula neutralization.
- `packages/rfmedia-cli/src/lib/formatters/formatters.test.ts`

First prove whether the existing shared serializer already neutralizes untrusted cells beginning
with `=`, `+`, `-`, or `@`. If it does, add only the smallest regression coverage needed for the
new artist/profile/tag projection and leave production code unchanged. If it does not, implement
the narrowest shared neutralization consistent with existing CSV contracts and test it without
changing JSON/YAML/text output. Do not duplicate CSV escaping in the Lidarr command.

### Phase 7: Executable Architecture and Ownership Gates

#### Task 7.1: Confine generated imports and artist editor mutation ownership Depends on [5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`

**Instructions**

Files to Create

- None; extend the existing cross-provider architecture audit.

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

Preserve every existing Plex and Lidarr rule: private generated imports/re-exports, no handwritten
`/api/v1/` paths, and exactly one production authenticated Fetch owner. Add focused checks and
failing fixtures that confine generated editor operations and broad editor body construction to
the stable client, and confine remote profile/tag mutation invocation to the registered operation/
apply ownership path. Avoid brittle text matching that rejects legitimate tests or comments. Run
`npm run check:architecture --workspace packages/rfmedia-cli` and
`npm run test:architecture --workspace packages/rfmedia-cli`.

### Phase 8: Documentation, Changelog, and Roadmap

#### Task 8.1: Update the operator plan/apply and execution-lane guides Depends on [6.1, 7.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`

**Instructions**

Files to Create

- None; update the canonical guides.

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`

Document strict v2 writes with immutable v1 read/apply/resume compatibility, both commands, exact
selection/reference semantics, all profile/tag modes, caps, zero-match versus all-no-op behavior,
before/after review, risk levels, replacement authorization, one-ID writes, targeted verification,
uncertain-state stop/resume, and secret/artifact handling. Correct stale future-mutation wording
while retaining `local-only` admission and no automatic mutation retry. Use tested commands and do
not claim unverified external behavior.

#### Task 8.2: Update generated-client docs, package README, and changelog Depends on [2.3, 6.1, 7.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`

**Instructions**

Files to Create

- None; update user and maintainer documentation.

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/CHANGELOG.md`

Document the new required generated contracts, narrow facade, targeted verification, and editor
body ownership without presenting generated modules as public API. Add concise package examples for
profile assignment, tag delta, destructive replacement/clear, planning, dry-run, apply, and resume,
linking to the canonical guide for detail. Add an `[Unreleased]` entry for the operator-visible
commands and safety behavior without claiming a release. Keep all examples consistent with actual
Commander syntax and completion options.

### Phase 9: Integration and Delivery Validation

#### Task 9.1: Run focused and full rfmedia-cli release gates Depends on [6.2, 6.3, 7.1, 8.1, 8.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `.github/workflows/rfmedia-cli.yml`
- `.github/pull_request_template.md`
- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`

**Instructions**

Files to Create

- None; validation evidence is reported to the orchestrator and PR.

Files to Modify

- None; fix failures only in the owning task/file scope and rerun the failed gate.

Run focused selector, client, plan-engine, producer, apply, command, formatter, completion, and
generated-contract tests first:

```bash
npm run test:run --workspace packages/rfmedia-cli -- \
  src/lib/lidarr/artist-selection.test.ts \
  src/lib/lidarr/client.test.ts \
  src/lib/lidarr/plan-engine.test.ts \
  src/actions/lidarr/plan-artist-profiles.test.ts \
  src/actions/lidarr/plan-artist-tags.test.ts \
  src/actions/lidarr/plan.test.ts \
  src/actions/lidarr/apply.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/formatters/formatters.test.ts \
  src/lib/shell-completions/templates.spec.ts \
  src/lib/lidarr/generated-contract.test.ts
```

Then run exactly:

```bash
npm run codegen:lidarr:check --workspace packages/rfmedia-cli
npm run test:codegen:lidarr --workspace packages/rfmedia-cli
npm run check:architecture --workspace packages/rfmedia-cli
npm run test:architecture --workspace packages/rfmedia-cli
npm run typecheck --workspace packages/rfmedia-cli
npm run test:run --workspace packages/rfmedia-cli
npm run test:coverage --workspace packages/rfmedia-cli
npm run build --workspace packages/rfmedia-cli
npm run format:check
npm run lint:md
git diff --check
npm pack --dry-run --workspace packages/rfmedia-cli
```

Prove existing v1 plan read/apply/resume fixtures, strict v2 rejection/tamper behavior, dry-run
purity, one-ID profile/tag bodies, successful `2xx`/`202` reconciliation, no unintended editor
fields, all three completion templates, and accurate docs. Separate scoped correctness from
unrelated pre-existing repository lint noise only with concrete evidence.

#### Task 9.2: Publish, review, merge, close, and clean up issue #199 Depends on [9.1]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `ROADMAP.md`
- `docs/roadmap-archive.md`
- `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`

**Instructions**

Files to Create

- `docs/prps/reviews/pr-<real-pr-number>-review.md`
- `docs/prps/reviews/fixes/pr-<real-pr-number>-fixes.md` when review findings require changes.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Confirm the exact feature diff, commit intentionally, push
`feat/199-lidarr-artist-bulk-management`, and open a GitHub PR against the real default branch using
the required template, Conventional Commit title, exact validation outcomes, risk/rollback, and
`Closes #199`. Once GitHub assigns the real PR number, remove #199 from duplicate open-work roadmap
locations and add an archive entry with that PR number, delivered behavior, and validation
evidence. This repository uses a transactional merge-candidate convention: final shipped wording
may be staged in the issue-closing PR after its real number exists, but it is not treated as current
until the squash merge makes it true. If merge is abandoned, revert the wording to an accurate
pending state. Commit and push the roadmap amendment.

Run the formal PR code-review workflow, persist the review artifact, apply every actionable
finding through the review-fix workflow, persist its fix report, rerun affected/full gates, commit,
push, and resolve actionable threads. Monitor all required GitHub Actions and review states to
green; diagnose and fix actual code/CI failures without inventing changes for external review
latency. Squash-merge the PR and delete its remote branch, verify issue #199 closed through the PR
linkage, then resolve and remove only the exact issue #199 worktree and local branch, prune remote
tracking state, and verify the unrelated issue #198 worktree and user checkout remain intact.

## Advice

- Treat `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md` as authoritative where
  earlier research disagrees: two plan leaves, mutually exclusive IDs/filters/`--all`, one tag
  mode, one artist per request, and strict v2 with immutable v1 compatibility.
- Add v1 golden compatibility tests before generalizing the plan engine; a renamed “current
  version” constant must never change old checksum bytes or history identity.
- Generated TypeScript types are not runtime validation. Keep bounded whole-response projection and
  minimal body construction in the stable facade, with dangerous artist-editor fields
  unrepresentable.
- The list action's filters are a semantic precedent only. Its paging and stale-cache paths cannot
  authorize mutation, and the cap is checked after full matching rather than used as truncation.
- Keep `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.ts` under serialized ownership. Parallel work should
  use disjoint source/test pairs and converge only after contracts stabilize.
- Successful HTTP acceptance is not success evidence. Verify the operation-owned postcondition
  with a targeted fresh read before durable history, and stop admission on unresolved
  post-dispatch state.
- Tag add/remove and set/clear intentionally have different stale semantics. Do not force both
  through a generic full-set equality check.
- Keep completions static, offline, and mirrored across Bash, Zsh, and Fish. Any CLI option rename
  must update command tests and all completion parity assertions together.
- No new dependency, OpenAPI refresh, database migration, multi-ID batching, implicit tag creation,
  profile clearing, direct mutation command, automatic replay, or rollback framework belongs in
  issue #199.
- Open the PR with the required template, `Closes #199`, and exact commands/outcomes. After GitHub
  assigns the real number, update the transactional roadmap entry, run the formal review/fix pass,
  monitor CI to green, squash-merge, verify issue closure, and remove only the issue #199 branch/
  worktree.
