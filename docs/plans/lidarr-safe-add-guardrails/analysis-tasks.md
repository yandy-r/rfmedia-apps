# Task Structure Analysis: lidarr-safe-add-guardrails

## Executive Summary

Implement issue #206 by extending the existing `lidarr discover --add` sealed
artist-add plan/apply lane, not by creating the stale direct-add files named in
the issue. The work should be split into independently testable contract,
facade, planning, CLI, apply/recovery, completion, and documentation tasks, with
the crash-safe apply integration intentionally last: artist creation is
non-idempotent, while post-add album normalization is a separate idempotent but
verified stage that must remain resumable without a second artist POST.

## Scope Decisions That Shape the Tasks

- Keep `searchForMissingAlbums: false`, `monitorNewItems: "none"`, and initial
  album monitoring `"none"` as fixed safe policy. The live Lidarr schema does
  not contain the issue's stale `searchForNewArtist` field.
- Change artist `monitored: false` from a fixed literal to an omitted-safe
  default with an explicit positive override only. Do not make one boolean
  implicitly enable new-album monitoring or missing-album search.
- When `--metadata-profile` is omitted, select a profile only if exactly one
  live profile structurally permits primary type `Album` and no secondary album
  types. Zero or multiple matches must fail closed and request an explicit
  profile; profile names are not policy evidence.
- Seal the resolved artist-monitoring policy and canonical post-add album-type
  selectors into the plan, entry postcondition, checksum, idempotency material,
  and review/risk output. Apply must not recompute defaults.
- Preserve old exact-key artist-add plans and their historical checksums. New
  plans should emit a distinct extended exact shape; parsing must explicitly
  recognize legacy versus extended shapes rather than weakening unknown-key
  rejection.
- Apply post-add normalization only to artists created by the reviewed add
  plan. Existing exact-MBID artists remain planning no-ops unless a separate
  reviewed album-monitoring plan targets them.
- Treat normalization as staged work after an authoritative artist ID is known:
  reconcile/create once, persist that creation is verified and normalization is
  pending, read albums for that artist only, update matching monitored albums,
  re-read to verify, and only then append terminal success.
- A crash after artist POST, after creation reconciliation, after the album
  monitoring PUT, or before terminal history append must resume from fresh
  exact-MBID/album state without issuing a second artist POST. An empty album
  listing when normalization was requested must remain bounded and explicitly
  resumable; it is not proof of terminal normalization success.
- Do not edit generated Lidarr output, add handwritten `/api/v1/` calls, expose
  generated DTOs, add another `fetch` owner, or enqueue the composite add in the
  deferred-intent database.

## Recommended Phase Structure

### Phase 1: Stable Contracts and Facade Evidence

Three foundation tasks may proceed in parallel. They establish the
generated-independent types, authoritative metadata-profile evidence, and
codegen boundary before plan or apply behavior changes.

#### Task 1.1: Extend Stable Artist-Add and Plan Contracts

**Dependencies**: None

**Files (2)**:

- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`

**Instructions**:

- Model an explicit artist monitored boolean while retaining `false` as the
  resolved default.
- Keep new-item monitoring and missing-album search fixed to their existing
  safe values.
- Add a generated-independent detailed metadata-profile projection.
- Add canonical optional post-add unmonitor selectors and the minimum
  history/result stage data required to distinguish creation pending,
  creation verified/normalization pending, normalization awaiting
  verification, and terminal success.
- Preserve the existing public legacy artist-add shapes so old artifacts remain
  representable.

**Focused proof**: Typecheck must force every current artist-add fixture and
consumer to make the legacy/extended distinction explicit; do not add a broad
type-only test suite.

#### Task 1.2: Project Metadata-Profile Safety Evidence

**Dependencies**: None

**Files (2)**:

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`

**Instructions**:

- Strictly project allowed primary and secondary album-type entries from
  unknown generated responses into the stable domain type.
- Preserve bounded validation, fresh copies, frozen output, and whole-response
  failure for malformed nested data.
- Do not expand the generic `{id, name}` quality-profile contract merely to
  accommodate metadata profiles.

**Focused proof**: Cover a valid albums-only profile, a mixed profile, malformed
nested entries, and immutability. Avoid duplicating generated DTO coverage.

#### Task 1.3: Seal Required Generated Operations

**Dependencies**: None

**Files (3)**:

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

**Instructions**:

- Require the already-generated artist lookup/create, artist-scoped album list,
  album monitor, and metadata-profile operations/endpoints used by the feature.
- Preserve offline deterministic code generation and the last-known-good
  generated tree.
- Do not refresh the OpenAPI snapshot or hand-edit generated files.

**Focused proof**: Contract tests should fail when a required operation or
endpoint disappears and pass against the committed snapshot.

### Phase 2: Facade, Sealed Plan, and Producer

Tasks 2.1 and 2.2 may run in parallel after their Phase 1 dependencies. Task 2.3
joins them and must complete before any CLI or apply integration.

#### Task 2.1: Implement Facade Defaults and Profile Projection

**Dependencies**: Tasks 1.1 and 1.2

**Files (2)**:

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`

**Instructions**:

- Return the stable detailed metadata-profile projection through the existing
  handwritten client facade.
- Serialize the exact current Lidarr wire field
  `addOptions.searchForMissingAlbums`; never emit `searchForNewArtist`.
- Map the resolved artist monitored choice explicitly while keeping
  `monitorNewItems`, initial album monitoring, and search disabled.
- Continue validating before transport and verifying the returned artist
  against the requested desired state.

**Focused proof**: Assert exact default and explicit-monitored POST bodies,
structural profile projection, malformed-response rejection, and zero transport
for invalid input.

#### Task 2.2: Extend Exact Plan Parsing and Durable Stage Records

**Dependencies**: Task 1.1

**Files (3)**:

- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`

**Instructions**:

- Canonicalize artist monitoring and sorted, deduplicated post-add selectors
  into the extended operation, entries, checksum, idempotency material, risk,
  and referenced-resource validation.
- Parse legacy and extended artist-add operation/entry shapes with separate
  exact-key sets; retain legacy checksum behavior and reject hybrid or unknown
  shapes.
- Extend history parsing and resume selection so intermediate normalization
  stages remain eligible while terminal verified success remains skipped.
- Keep artist-add non-deferable and foreign-ID keyed.

**Focused proof**: Lock legacy round-trip/checksum compatibility, extended
checksum and idempotency changes, selector canonicalization, hybrid/unknown-key
rejection, and resume selection for each durable stage.

#### Task 2.3: Resolve Safe Defaults and Build the Reviewed Plan

**Dependencies**: Tasks 2.1 and 2.2

**Files (2)**:

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`

**Instructions**:

- Resolve omitted monitoring to `false`.
- Resolve an omitted metadata profile only from a unique structural
  albums-only candidate; fail closed on zero or multiple candidates.
- Parse/canonicalize post-add album-type selectors with the existing closed
  selector vocabulary and seal them into the artifact.
- Preserve provenance validation before I/O, exact-MBID absence checks,
  resource caps, ordered ranks, no partial artifact writes, and existing-artist
  no-op behavior.

**Focused proof**: Cover safe omission, explicit monitored override, unique/zero/
ambiguous albums-only resolution, canonical selectors, and failure-before-plan
write. Reuse existing album-type unit coverage instead of duplicating it.

### Phase 3: Public CLI and Completion Parity

The command task depends on the final producer signature. Completion source
updates may then run in parallel with the command tests, but completion parity
is not complete until Task 3.3 passes.

#### Task 3.1: Expose Guardrails Through the Existing Discover Add Handoff

**Dependencies**: Task 2.3

**Files (3)**:

- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`

**Instructions**:

- Make metadata-profile input optional only through the unique structural
  fallback.
- Add one explicit positive artist-monitoring override and an optional
  post-add unmonitor-by-album-type input.
- Validate conflicts and selector grammar before config/client resolution,
  then forward normalized values to the existing plan producer.
- Preserve the current discover-to-plan handoff, human/machine stream
  separation, and generic `lidarr apply`; do not add a direct mutation command.

**Focused proof**: Cover omitted defaults, explicit override, selector mapping,
invalid input before lazy action import, and unchanged JSON/human handoff
behavior.

#### Task 3.2: Update Bash, Zsh, and Fish Completion Sources Together

**Dependencies**: Task 3.1

**Files (3)**:

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**:

- Add identical discover-add options and canonical album-type values to all
  three templates.
- Preserve existing command scoping and argument/file completion behavior.

#### Task 3.3: Prove Completion Parity and Side-Effect Freedom

**Dependencies**: Task 3.2

**Files (1)**:

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

**Instructions**:

- Update exact option/value expectations for Bash, Zsh, and Fish together.
- Retain checks that completion generation does not load config, create a
  client, or access the network.

### Phase 4: Crash-Safe Post-Add Normalization

These tasks are intentionally sequential. Task 4.1 owns the mutation boundary;
Task 4.2 owns plan-wide admission, output, and resume orchestration. Splitting
them across parallel implementors would risk an incompatible terminal-state
contract around the non-idempotent POST.

#### Task 4.1: Execute and Verify the Composite Entry Safely

**Dependencies**: Tasks 2.1, 2.2, and 2.3

**Files (2)**:

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`

**Instructions**:

- Preserve this file as the sole `addArtist()` production owner.
- Reconcile exact MBID first; dispatch artist POST at most once behind the
  existing durable possible-dispatch marker.
- Once the authoritative artist ID is known, persist
  creation-verified/normalization-pending before normalization work.
- List only that artist's albums, select canonical requested types locally,
  mutate only currently monitored IDs in bounded batches, and re-read to verify
  the postcondition before terminal success.
- Before the album PUT, retain enough durable stage evidence that a crash can
  resume safely. On resume, re-read state and either verify already-applied
  changes or idempotently update only remaining monitored albums.
- Keep bounded cancellation-aware handling for albums not yet populated.
  Report an incomplete/resumable state rather than treating an empty
  asynchronous response as guaranteed success.
- Never resend the artist POST because normalization failed.

**Focused proof**: Exercise crashes/failures before POST, after
possibly-dispatched, after exact-MBID reconciliation, after the album PUT, and
before terminal history; prove every resume sends zero duplicate artist POSTs.
Also cover verification mismatch, cancellation, and a successful no-change
normalization after fresh non-empty scoped evidence.

#### Task 4.2: Integrate Admission, Resume, and Result Presentation

**Dependencies**: Task 4.1

**Files (3)**:

- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`

**Instructions**:

- Carry intermediate normalization outcomes through plan-wide history, resume
  selection, admission stopping, dry-run, summaries, and safe next-action text.
- Do not count creation-verified/normalization-pending as terminal success.
- Stop later non-idempotent admissions when the current entry is uncertain,
  while allowing `--resume` to continue normalization for the known artist.
- Make partial completion explicit in human and machine output without leaking
  raw response bodies or secrets.

**Focused proof**: Cover multi-entry stop-on-uncertainty, dry-run with no
mutation, partial summary/output, and a resume that completes normalization
without a second create.

### Phase 5: Boundary Gates, Documentation, and ROADMAP Parity

Run these after behavior is integrated. Task 5.1 may proceed in parallel with
Task 5.2, followed by the focused and full verification gates.

#### Task 5.1: Preserve Mutation and Generated-Client Ownership Gates

**Dependencies**: Task 4.2

**Files (2)**:

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`

**Instructions**:

- Keep generated Lidarr imports private, authenticated Fetch single-owned, and
  artist creation restricted to the established entry executor.
- If a tightly owned normalization helper is introduced later, allow only the
  minimum album-monitoring ownership needed; do not relax broad path or
  generated-import rules.

**Focused proof**: Negative fixtures must reject direct planner/command artist
adds, generated imports, and handwritten Lidarr paths.

#### Task 5.2: Document the Final Contract and Completion State

**Dependencies**: Tasks 3.3 and 4.2

**Files (3)**:

- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `ROADMAP.md`

**Instructions**:

- Document the safe defaults, explicit artist-monitoring override semantics,
  unique albums-only profile fallback, canonical post-add selectors, partial
  completion, and crash/resume behavior.
- State that missing-album search and new-item monitoring remain disabled and
  that post-add normalization never authorizes a second artist POST.
- Update the live ROADMAP entry/count only after the implementation, focused
  tests, completion parity, architecture checks, typecheck, build, and full
  rfmedia suite are green.

## Dependency Analysis

```text
1.1 contracts ---------> 2.1 facade ---------+
       |                                      |
       +---------------> 2.2 plan engine ----+--> 2.3 planner
1.2 projection --------> 2.1 facade          |         |
1.3 codegen contract -------------------------+         +--> 3.1 CLI
                                                        |      |
                                                        |      +--> 3.2 completions
                                                        |              |
                                                        |              +--> 3.3 parity
                                                        |
                                                        +--> 4.1 entry execution
                                                               |
                                                               +--> 4.2 orchestration
                                                                      |
                                                                      +--> 5.1 boundaries
                                                                      |
3.3 parity -----------------------------------------------------------+--> 5.2 docs/ROADMAP
```

- **Maximum useful parallelism**: Three tasks in Phase 1; two tasks in early
  Phase 2; two closeout tasks in Phase 5.
- **Critical path**: 1.1/1.2 -> 2.1/2.2 -> 2.3 -> 4.1 -> 4.2 -> 5.2.
- **Circular-dependency check**: None. The stable domain contract is below the
  client and plan layers; planning consumes facade projections; apply consumes
  sealed plans; commands only produce reviewed inputs.
- **Do not parallelize** Tasks 4.1 and 4.2. They share the meaning of terminal
  versus resumable state and jointly prevent duplicate non-idempotent dispatch.

## Task Granularity

- Keep each task to one cohesive contract boundary and one to three files.
- Bundle a production file with its focused test whenever the safety contract
  can be proven locally.
- Keep the three completion templates in one ownership task so shell parity
  cannot drift; keep their exact-set test separate because of the three-file
  task limit.
- Keep plan operation definitions and plan-engine canonicalization together:
  splitting them would permit temporary disagreement among exact keys,
  checksum material, risk, and resume parsing.
- Keep entry-level artist creation and album normalization together because
  their ordering is the core crash-safety invariant.
- Do not modify `album-types.ts` or its tests unless the existing closed
  vocabulary is demonstrably insufficient; reuse is preferable to adding a
  second selector contract.
- Do not add a new database/migration task. Existing sealed plan, claim, and
  JSONL history persistence are the intended synchronous recovery boundary.

## Critical Focused Test Set

The implementation should add only contract-focused cases:

1. Exact default/override artist POST bodies and metadata-profile projection.
2. Legacy versus extended plan exact-key/checksum compatibility.
3. Unique/zero/ambiguous albums-only default resolution.
4. Canonical post-add selector sealing and idempotency material.
5. Marker-before-POST and every post-create crash/resume boundary, proving one
   artist POST maximum.
6. Artist-scoped album update, verification mismatch, delayed empty results,
   cancellation, and partial/resumable output.
7. Bash/Zsh/Fish option and value parity with side-effect-free completion.
8. Generated-client and mutation-owner architecture gates.

Existing `album-types` and generic album-monitoring behavior should be reused,
not re-tested exhaustively. Final verification should still run package
typecheck/build, the focused files above, the full rfmedia test suite,
architecture checks, documentation lint/format checks, and offline Lidarr
codegen contract checks.

## File-to-Task Mapping

- `packages/rfmedia-cli/src/types/lidarr.ts`: Task 1.1
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Task 1.1
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Task 1.2
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`: Task 1.2
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`: Task 1.3
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`: Task 1.3
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Task 1.3
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Task 2.1
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: Task 2.1
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Task 2.2
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Task 2.2
- `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`: Task 2.2
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: Task 2.3
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.test.ts`: Task 2.3
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Task 3.1
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: Task 3.1
- `packages/rfmedia-cli/src/commands/lidarr.test.ts`: Task 3.1
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`: Task 3.2
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`: Task 3.2
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Task 3.2
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Task 3.3
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: Task 4.1
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.test.ts`: Task 4.1
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: Task 4.2
- `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`: Task 4.2
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Task 4.2
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Task 5.1
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`: Task 5.1
- `packages/rfmedia-cli/docs/features/lidarr-discovery.md`: Task 5.2
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Task 5.2
- `ROADMAP.md`: Task 5.2

## Completion Criteria

- The live issue's safe defaults are either already preserved or explicitly
  resolved and sealed; no unsupported wire field is introduced.
- Omitted metadata profile selection is deterministic and fail-closed.
- Post-add normalization is artist-scoped, bounded, verified, and represented
  in durable history before terminal success.
- Resume after every mutation boundary issues at most one artist POST.
- Legacy plans remain readable with unchanged checksum semantics, and extended
  plans reject unknown/hybrid keys.
- No generated file is edited manually and all architecture/codegen gates pass.
- Bash, Zsh, and Fish completions expose identical public additions.
- Feature docs and ROADMAP accurately reflect the delivered, tested behavior.
