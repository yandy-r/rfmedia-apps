# Practices Research — Lidarr Artist Bulk Profile and Tag Management

## Executive Summary

Issue #199 should extend the shipped Lidarr plan/apply architecture, not add a second bulk-mutation
path. The reusable core already owns artifact sealing, strict validation, target-origin binding,
staleness preflight, immediate revalidation, scheduling, durable per-target history, deferred
replay, claims, cancellation, approval, and machine-output parity. New code should supply only
fresh selection/resource resolution and operation-specific before/after, classification, payload,
risk, and rendering behavior.

The issue's older proposed layout of `actions/lidarr/profile.ts`,
`actions/lidarr/tag.ts`, and `lib/lidarr/editor.ts` no longer fits as written. Separate profile/tag
action files are acceptable only as thin plan producers if the final CLI has separate leaves; they
must not mutate directly or duplicate plan creation. A new `editor.ts` should not call the API:
`lib/lidarr/client.ts` is the sole handwritten importer of generated Lidarr operations, and the
architecture gate enforces that boundary. The smallest coherent design is to extend the stable
client facade, add pure shared selector/resolver helpers, and make the existing plan operation
registry cover monitoring, profiles, and tags.

## Existing Reusable Code

| Existing module or function                                                                                                                     | Reuse for issue #199                                                                                                                                                        | Required adaptation or caution                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/lidarr.ts:LidarrArtist`                                                                                                              | Already carries artist ID/name, monitored state, quality-profile ID, metadata-profile ID, and tag IDs needed for selection and staleness checks.                            | Add only narrow `LidarrProfile` and `LidarrTag` projections; never expose generated resource types.                                                                                                                                                                        |
| `src/lib/lidarr/types.ts:projectLidarrArtistArray()` and focused guard/copy pattern                                                             | Template for strict unknown-to-domain projection and fresh frozen values.                                                                                                   | Add bounded positive-ID/non-empty-name projectors for quality profiles, metadata profiles, and tags. Reject a malformed whole response rather than passing partial generated DTOs upward.                                                                                  |
| `src/lib/lidarr/client.ts:LidarrClientApi` and `LidarrClient`                                                                                   | Stable action-facing seam, per-instance generated client, operation context, sanitized errors, cancellation, and `2xx` handling.                                            | Add `listQualityProfiles()`, `listMetadataProfiles()`, `listTags()`, `setArtistProfiles()`, and `updateArtistTags()`. Keep mutation inputs singular per artist and narrower than `ArtistEditorResource`.                                                                   |
| `src/lib/lidarr/client.ts:#execute()` / `#executeVoid()`                                                                                        | Generated-envelope validation, projector application, and facade error normalization.                                                                                       | Profile/tag reads use `#execute`; editor calls use `#executeVoid` and must not depend on the generated editor response body because upstream returns `202` while the snapshot declares `200 unknown`.                                                                      |
| `src/lib/lidarr/resilience.ts:createResilientLidarrClient()`                                                                                    | Preserves tier, retry, circuit, cache, and error behavior around every facade method.                                                                                       | The wrapper is an explicit object, so every new facade method must be delegated and tested. Planning/apply must use `retryAttemptsOverride: 0` and no stale fallback. Do not cache mutation-authorizing reads for this feature.                                            |
| `src/actions/lidarr/list.ts:matchesFilters()`                                                                                                   | Existing AND semantics for monitored/unmonitored, quality profile, and all-of tag filters.                                                                                  | Extract or mirror the pure predicate, not `executeLidarrList()`: list has stale-cache consent plus default `limit: 50`/`offset`, which must never define a mutation cohort. Add metadata-profile filtering and exact-ID candidate handling in the mutation selector.       |
| `src/actions/lidarr/plan.ts:executeLidarrPlan()`                                                                                                | Fresh client resolution, scheduler use, missing-ID rejection, default artifact path, and atomic artifact write.                                                             | Generalize options to a discriminated plan request and delegate pure selection/resolution/entry construction. Do not create independent profile/tag mutation workflows.                                                                                                    |
| `src/lib/lidarr/plan-engine.ts:buildLidarrMutationPlan()`                                                                                       | Canonical origin, cap enforcement, deterministic artist-ID ordering, duplicate rejection, review counts, idempotency keys, risk, checksum, and immutable plan construction. | Entry construction and changed-state comparison are hard-coded to monitoring. Move those operation-specific decisions behind the operation definition or a small exhaustive switch.                                                                                        |
| `src/lib/lidarr/plan-engine.ts:assertLidarrMutationPlanV1()`                                                                                    | Exact-key validation, sensitive/prototype-key rejection, bounds, operation consistency, risk consistency, sorted targets, and idempotency validation.                       | Add strict per-kind parsers for profile/tag operation and entry shapes. Do not weaken exact-key validation into permissive generic records. Decide explicitly whether additive kinds remain schema v1 or require v2.                                                       |
| `src/lib/lidarr/plan-engine.ts:LidarrMutationOperationDefinition`                                                                               | Existing owner of canonical operation state, risk, deferred operation, payload, idempotency, live classification, execution, deferred replay, and intent matching.          | Monitoring-specific types currently leak through the interface. Generalize only the state/payload portions required by the three shipped variants and let each definition retain exact runtime validation.                                                                 |
| `src/lib/lidarr/plan-engine.ts:getLidarrMutationOperationDefinition()` / `createLidarrMutationExecutors()`                                      | Explicit allowlist and deferred-executor registry.                                                                                                                          | Register profile and tag definitions here; do not add runtime discovery or a plugin mechanism.                                                                                                                                                                             |
| `src/actions/lidarr/apply.ts:classifyLiveTarget()` and operation `classify()`                                                                   | Correct seam for operation-relevant staleness and already-satisfied detection.                                                                                              | `staleFinding()` currently hard-codes “monitoring state changed.” Return operation-specific drift detail from classification, or add a narrow definition-owned formatter.                                                                                                  |
| `src/actions/lidarr/apply.ts:executeMutations()`                                                                                                | One artist per admission, immediate re-read, scheduler invocation, retryable deferral, durable outcome before the next target, and stop-on-uncertain behavior.              | Reuse unchanged orchestration. New definitions execute minimal facade calls and should verify resulting state with a fresh read before success is considered authoritative. Do not batch multiple artist IDs until history can represent partial/uncertain batch outcomes. |
| `src/actions/lidarr/apply.ts:reconcileDeferredEntries()`                                                                                        | Exact deferred-intent matching, explicit resume-only replay, claim restoration, and satisfied-target reconciliation.                                                        | Profile/tag payload matchers must compare normalized exact payloads and reject old/malformed/mismatched intents.                                                                                                                                                           |
| `src/lib/lidarr/plan-engine.ts:appendLidarrPlanHistory()`, `readLidarrPlanHistory()`, `selectLidarrResumeEntries()`, `acquireLidarrPlanClaim()` | Durable per-entry authority, resume filtering, bounded safe I/O, and exclusive apply ownership.                                                                             | Reuse without a new schema or history store; entry IDs remain `artist:<id>` because profile and tag plans are separate artifacts.                                                                                                                                          |
| `src/lib/lidarr/deferred-queue.ts` domain API                                                                                                   | Idempotent enqueue, claim, replay, completion/restoration, backoff, and explicit executor map.                                                                              | Reuse its opaque operation/payload design. No new table or queue abstraction is needed.                                                                                                                                                                                    |
| `src/lib/lidarr/scheduler.ts` and `resolveLidarrScheduler()`                                                                                    | Existing local-only admission, cancellation, execution metadata, and configured policy.                                                                                     | Profile/tag operations remain `local-only`; do not add metadata-server gates or command-level concurrency flags.                                                                                                                                                           |
| `src/commands/lidarr.ts:parsePositiveInt()`, `parseArtistIds()`, `parseMaxBatch()`                                                              | Existing strict numeric parsing and cap enforcement.                                                                                                                        | Add small collectors for reference strings and tag modes. Keep semantic conflicts in command/action validation rather than encoding them in loosely typed option bags.                                                                                                     |
| `src/commands/lidarr.ts:renderMutationPlan()`, `renderMutationApply()`, and CSV projectors                                                      | Correct stdout/stderr split, machine envelope, human tables, and apply summaries.                                                                                           | Render by the plan operation discriminant. Keep complete entries in artifact/machine output; any text truncation must state the omitted count and offer an explicit expansion.                                                                                             |
| `src/commands/lidarr.ts` interactive apply flow                                                                                                 | Dry-run-before-confirmation, plan ID/checksum binding, default-no confirmation, and `--yes` enforcement for non-TTY/machine output.                                         | Reuse unchanged for ordinary profile/tag plans. If tag replacement is admitted, its extra authorization belongs here and in machine-mode validation.                                                                                                                       |
| `src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`                                                                          | Static completion templates plus cross-shell parity tests for the current plan/apply surface.                                                                               | Update all three templates in one change and lock operation names/options/value suggestions together. Do not make normal completion contact Lidarr.                                                                                                                        |
| `scripts/check-direct-plex-imports.mjs:auditPlexBoundaries()`                                                                                   | Rejects generated imports/re-exports outside `client.ts`, handwritten `/api/v1/` paths, extra Fetch owners, and incorrect Fetch-owner counts.                               | Keep the allowlist unchanged. Add architecture fixtures only if a new rule is needed; an `editor.ts` generated importer would correctly fail today.                                                                                                                        |
| `src/actions/test-helpers/lidarr-client-mocks.ts:createLidarrClientMock()` and `lidarr-fixtures.ts`                                             | Typed facade mock and valid artist fixture builders for action/apply tests.                                                                                                 | Add new facade methods with safe defaults and profile/tag fixture factories. This explicit mock forces all consumers to acknowledge interface growth.                                                                                                                      |
| `src/lib/lidarr/plan-engine.test.ts`, `actions/lidarr/{plan,apply}.test.ts`, `commands/lidarr.test.ts`                                          | Established layers for invariant, orchestration, approval/output, resume, drift, cancellation, and uncertain-state tests.                                                   | Extend at the owning layer; avoid duplicating end-to-end cases for every set-algebra permutation.                                                                                                                                                                          |

## Modularity Design

### Recommended boundaries

1. **Transport and wire projection remain private.** Extend `lib/lidarr/client.ts` with named
   generated operations and minimal facade methods. Extend `lib/lidarr/types.ts` with strict
   profile/tag projectors and `types/lidarr.ts` with their narrow public domain shapes. No action,
   command, plan, or helper imports from `lib/lidarr/generated/`.
2. **Selection and reference resolution are pure plan-time policy.** A small
   `actions/lidarr/artist-selection.ts` may own:
   - explicit selector validation;
   - AND/all-of predicate evaluation over a supplied live artist array;
   - numeric-ID or exact normalized-name resolution over supplied profiles/tags;
   - sorted unique tag-set operations;
   - deterministic selected-target ordering and cap checks.

   It must perform no I/O, paging, stale-cache reads, rendering, or mutation.

3. **Plan operations own operation semantics.** With monitoring, profiles, and tags, the rule of
   three now justifies extracting the existing operation definitions into a focused private
   `lib/lidarr/plan-operations.ts` if keeping them in `plan-engine.ts` would further inflate that
   already large file. Definitions own canonical operation state, entry construction,
   idempotency, risk, classification, minimal execution, deferred payload validation, and matching.
4. **The plan engine remains infrastructure.** `plan-engine.ts` should retain exact artifact
   validation, canonical serialization/checksum, safe file I/O, history, resume selection, and
   claims. It should dispatch operation-specific parsing and entry validation exhaustively rather
   than become a generic workflow/plugin framework.
5. **Actions orchestrate; commands present.** `actions/lidarr/plan.ts` fetches fresh resources,
   invokes pure selection/resolution, builds one sealed plan, and writes it. `apply.ts` continues to
   orchestrate generic preflight/revalidation/history/deferred behavior. `commands/lidarr.ts` owns
   Commander grammar, output projection, approval, and exit code.

### Shared versus feature-specific

| Shared across monitoring/profile/tag plans                                                                                                                                                   | Profile-specific                                                                                                                                                      | Tag-specific                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Origin/client/scheduler resolution, explicit selection, caps, sorting, artifact write/read, checksum, exact-key security, claims, history, resume, deferred queue, approval, output envelope | Quality/metadata reference resolution, managed-field before/after projection, partial-convergence classification, medium cascade risk, minimal profile editor payload | Tag reference resolution, sorted set algebra, add/remove/replace classification, exact replacement drift, low/high risk by mode, explicit `applyTags`, replacement authorization |

The old `profile.ts` and `tag.ts` names may survive as thin wrappers only if separate CLI leaves are
chosen. They should call the shared plan orchestration and contain no editor calls, history, or
artifact I/O. A single `plan.ts` with discriminated options is simpler if the command uses one
`artist-edit` leaf. The old `editor.ts` proposal should be dropped: it would either duplicate client
validation/transport or require weakening the generated-import architecture gate.

## KISS Assessment

- Keep separate profile and tag operation kinds unless product explicitly requires one combined
  atomic intent. Their risk, no-op, staleness, payload, and replacement semantics differ enough
  that a single optional-field “artist edit” object invites invalid states.
- Preserve one artist per editor request. “Bulk” already means one bounded reviewed cohort; remote
  batching adds partial-response and crash-recovery semantics without improving the first useful
  release.
- Reuse the existing plan artifact/history/claim/deferred machinery. Do not create a second plan
  format, database table, generic job runner, or rollback subsystem.
- Resolve existing resources only. Implicit tag creation is a second mutation with different
  rollback and concurrency behavior and should not hide inside selection.
- Use exact, case-normalized name matching plus explicit IDs. Do not use fuzzy matching or
  `fastest-levenshtein` for mutation authority.
- Use sorted arrays and native `Set` for tag math. A collection library adds no value at the
  1,000-entry hard bound.
- Keep static shell completions. Dynamic profile/tag completion would need cache freshness,
  latency, failure, and credential policy that is not required to solve issue #199.
- Do not generalize selectors beyond current requirements. IDs, monitored state, quality profile,
  metadata profile, all-of tags, and explicit `--all` are enough; path/genre/date/statistics
  expression languages are scope creep.
- Avoid a “universal resource resolver.” One small internal helper parameterized by `id` and
  display-label access is enough; exported quality/metadata/tag functions should retain domain
  names and actionable errors.

## Abstraction vs Repetition

The operation registry was arguably ahead of need when monitoring was the only operation, but
issue #199 creates the third concrete variant: monitoring, profile assignment, and tag mutation. The
rule of three now supports one shared operation-definition boundary. It does not support a dynamic
plugin API, generic schema DSL, reflection-based renderer, or arbitrary editor payload.

Extract behavior only where at least two new operations must agree:

- explicit selector validation, deterministic filtering/sorting, and cap enforcement;
- numeric-ID/exact-name resolution with duplicate detection;
- normalized sorted integer sets;
- operation registration, deferred executor creation, and common apply lifecycle;
- common plan/apply output envelope and summary.

Keep repeated code where semantics differ:

- profile partial convergence versus tag delta/replacement drift;
- profile and tag risk/cascade text;
- exact deferred payload validators;
- human before/after columns;
- command conflicts and replacement authorization.

Do not reuse `executeLidarrList()` to avoid a few filter lines. Its paging and stale fallback are
deliberately wrong for mutation authority. Reusing a small pure predicate is appropriate; reusing
the list action is not.

## Interface Design

### Stable client facade

Prefer narrow intent-bearing methods:

```ts
interface LidarrProfile {
  readonly id: number;
  readonly name: string;
}

interface LidarrTag {
  readonly id: number;
  readonly label: string;
}

interface LidarrProfileAssignment {
  readonly qualityProfileId?: number;
  readonly metadataProfileId?: number;
}

type LidarrTagMode = "add" | "remove" | "replace";

interface LidarrClientApi {
  listQualityProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]>;
  listMetadataProfiles(signal?: AbortSignal): Promise<readonly LidarrProfile[]>;
  listTags(signal?: AbortSignal): Promise<readonly LidarrTag[]>;
  setArtistProfiles(artistId: number, assignment: LidarrProfileAssignment, signal?: AbortSignal): Promise<void>;
  updateArtistTags(
    artistId: number,
    mode: LidarrTagMode,
    tagIds: readonly number[],
    signal?: AbortSignal,
  ): Promise<void>;
}
```

Do not expose `ArtistEditorResource`, generated response envelopes, endpoint functions, or one
general `editArtist(payload)` method. The proposed facade makes dangerous fields such as
`rootFolderPath`, `moveFiles`, `deleteFiles`, and `addImportListExclusion` unrepresentable. Require
at least one profile field; normalize unique tag IDs; require explicit tag mode; and validate all
IDs before invoking the generated operation.

### Selection and resolution

Use a discriminated selector instead of an all-optional bag:

```ts
type LidarrArtistSelector =
  | { readonly mode: "ids"; readonly ids: readonly number[] }
  | { readonly mode: "filters"; readonly filters: LidarrArtistFilters }
  | { readonly mode: "all" };
```

If IDs plus filters are eventually allowed, model that decision explicitly as a candidate-ID set
plus filters and report excluded IDs. Do not infer whole-library intent from an empty selector.
Resolution should return stable ID plus review label, while plan authority binds the ID.

### Plan operation contract

Keep `LidarrMutationOperation` and `LidarrMutationPlanEntry` as discriminated unions. Each
definition should own:

- exact operation and entry canonicalization/validation;
- deterministic entry construction and changed/no-op comparison;
- risk and cascade facts;
- idempotency input;
- live `ready`/`satisfied`/`drifted` classification with operation-specific detail;
- exact deferred payload creation, validation, and matching;
- minimal facade execution.

For profiles, classification examines only managed fields: every field equal to desired is
`satisfied`; every field equal to either reviewed-before or desired with at least one before value
is `ready`; any other managed value is drift. For tag add/remove, unrelated tags do not cause
drift because the server applies a delta. For replace, only the exact reviewed-before or exact
desired set is safe.

The classifier should return structured detail rather than force `apply.ts` to know every state
shape:

```ts
type LidarrPlanEntryClassification =
  | { readonly state: "ready" }
  | { readonly state: "satisfied" }
  | { readonly state: "drifted"; readonly message: string };
```

### Output contract

Keep one typed plan/apply result on the action boundary. Machine JSON/YAML should preserve the
operation discriminant, resolved names/IDs, selection summary, complete entries, checksum, risk,
and outcome counts. CSV may retain JSON-encoded nested entries, matching the existing serializer
contract. Human rendering should switch exhaustively on operation kind and stay on stderr.

## Extension Points

- **Another artist mutation:** add one discriminated operation/entry pair, one strict definition,
  facade capability if needed, plan command grammar, renderer, and focused tests. The shared apply
  lifecycle should not change.
- **Tag creation:** implement later as a separate operation/plan because it creates a resource and
  changes rollback/idempotency semantics. Existing-only resolution remains fail-closed.
- **Multi-ID editor batching:** add only after the execution/history contract can represent
  per-member acceptance, missing response members, uncertain batch outcomes, and crash recovery.
- **Additional selectors:** add pure predicates to the selector module and serialized selector
  review context. They must not affect the frozen target cohort at apply time.
- **Plan schema evolution:** preserve strict rejection of unknown versions/kinds. Do not add
  permissive forward compatibility; an older CLI must fail closed on a new operation.
- **Post-write verification optimization:** begin with a per-target fresh read. A later shared
  refresh is safe only if it preserves per-target evidence and never converts an unverified
  acceptance into durable success.
- **Read-only discovery:** profile/tag listing can be added independently through the same narrow
  facade projections, but should not be a prerequisite if resolution errors can list bounded valid
  choices.

## Testability Patterns/Anti-patterns

### Patterns to preserve

- Inject Fetch and response limits through `LidarrClientDependencies`; assert exact generated
  method/path/body behavior at the facade boundary.
- Extend `createLidarrClientMock()` and fixture factories, then mock only `LidarrClientApi` in
  actions. This keeps generated DTOs out of unit tests above the client.
- Test selector, name/ID resolver, profile classification, and tag set algebra as pure
  table-driven functions: duplicate/unknown/ambiguous references, zero matches, intersections,
  no-op, partial convergence, unrelated tag drift, replacement drift, and deterministic sorting.
- Reuse `LidarrPlanBuildDependencies` for UUID/time/host/user/cwd determinism and
  `LidarrPlanClaimDependencies` for ownership races. Add per-operation checksum/tamper fixtures to
  `plan-engine.test.ts`.
- Extend `apply.test.ts` at lifecycle transitions: all-stale preflight means zero writes;
  satisfied means no editor call; late drift stops later admissions; retryable failure creates an
  exact deferred payload; resume replays only a matching intent; remote success plus history
  failure is uncertain.
- Assert facade request bodies exactly and negatively assert the absence of file-moving/deletion
  fields. Include `202`, malformed profile/tag projections, already-aborted signals, and two-client
  isolation.
- Keep command tests focused on hierarchy, conflicts, flag forwarding, machine envelopes,
  interactive review binding, replacement authorization, exit status, and stdout silence in text
  mode.
- Extend `templates.spec.ts` to lock operation candidates/options/value suggestions across Bash,
  Zsh, and Fish, and run the existing architecture audit/tests.

### Anti-patterns to avoid

- Mocking or importing generated SDK functions in action/command tests.
- Authorizing selection from `executeLidarrList()` output, its first 50 rows, or stale cache.
- Snapshotting only rendered text while leaving discriminated result and exact payload behavior
  untested.
- Testing every lifecycle transition separately for every tag-set permutation; test pure semantics
  once and lifecycle integration once per operation family.
- Letting the plan definition call filesystem/history functions or the command layer call the
  facade directly.
- Treating a successful editor response body as authoritative or persisting it in plan/history.
- Using mutable arrays in plan state or comparing tag arrays without normalization.
- Adding time, database, network, or global-process dependencies to pure selection/resolution
  helpers.

## Build vs Depend

| Concern                        | Build/reuse decision                                                                               | Reason                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lidarr HTTP operations         | Reuse the checked-in generated SDK through `LidarrClient`; add no SDK dependency.                  | Required endpoints already exist, and the current transport supplies origin/key isolation, bounded parsing, redirects, timeout, and errors.        |
| Runtime schema validation      | Extend the existing focused guards and exact plan validators; add no schema library.               | The repository already has hardened, operation-aware validation. A new dependency would duplicate policy and still require custom semantic checks. |
| CLI parsing/conflicts          | Reuse Commander `Option`, parsers, `.choices()`, and `.conflicts()`.                               | Existing command tests and error flow already cover this surface.                                                                                  |
| Name resolution                | Build a small exact resolver with native strings/maps; do not use fuzzy-match dependencies.        | Mutation authority must reject ambiguity rather than guess.                                                                                        |
| Tag set algebra                | Use native `Set`, sorted arrays, and tiny pure helpers.                                            | Dataset bounds are small and semantics are simple.                                                                                                 |
| Planning/history/deferred work | Reuse `plan-engine.ts`, `apply.ts`, and `deferred-queue.ts`; add no workflow or queue package.     | They already implement the difficult safety, durability, and cancellation states.                                                                  |
| Scheduling/concurrency         | Reuse the Lidarr scheduler and one-target execution; do not add a batching/concurrency dependency. | Safety and per-target durable evidence matter more than throughput for the bounded first release.                                                  |
| Human/machine output           | Reuse `console-table-printer`, `picocolors`, and shared `formatOutput`.                            | Preserves current stdout/stderr and JSON/YAML/CSV contracts.                                                                                       |
| Hashing and safe artifact I/O  | Reuse Node crypto/fs plus existing plan-engine helpers.                                            | No new persistence or canonicalization package is needed.                                                                                          |
| Shell completion               | Extend the three static templates and parity tests.                                                | Remote/dynamic completion adds failure and credential paths without core product value.                                                            |

## Open Questions

1. Will the command expose separate `artist-profile` and `artist-tags` plan leaves, or one
   `artist-edit` leaf? Separate operation kinds are recommended even if aliases share one planner;
   combining profiles and tags changes drift, risk, and rollback semantics.
2. Do the new operation/entry shapes remain `rfmedia.lidarr-plan.v1`, relying on strict kind
   rejection by older CLIs, or does the artifact version advance to v2?
3. Are exact IDs and filters mutually exclusive, or do IDs define the candidate set that filters
   narrow with explicit excluded-ID reporting?
4. Are names matched with locale-independent lowercase or `toLocaleLowerCase()`? The rule must be
   deterministic across machines, and duplicate normalized names must fail with IDs shown.
5. Does a profile/tag rename at apply time merely update display context, warn, or block? Stable ID
   authority suggests warning; deletion must block before any write.
6. Is tag replacement in the first release? If yes, choose the explicit clear syntax and additional
   non-interactive authorization before finalizing command/completion contracts.
7. Must apply verify every target immediately after the editor call, or may it perform one bounded
   list refresh after a group? Per-target verification best matches current history semantics.
8. Should `lidarr list` adopt the extracted metadata-profile filter and shared predicate now, or
   should mutation selection remain feature-local to avoid expanding the read command?
9. Should text previews print all entries up to 1,000 or truncate at a documented row count while
   preserving the full artifact and machine result?
10. Can upstream integration tests prove that profile/tag-only editor calls never enqueue secondary
    work and that a `202` acceptance is visible on the immediate follow-up read? This evidence
    should freeze risk and verification wording before implementation.
