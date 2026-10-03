# Architecture Research: 199-lidarr-artist-bulk-management

## System Overview

Issue #199 extends the existing `rfmedia lidarr plan` / `rfmedia lidarr apply` pipeline; it does not
introduce a second mutation path. The dependency direction remains:

```text
Commander command
  -> plan/apply action
  -> pure selection and operation policy
  -> versioned plan engine
  -> stable Lidarr facade
  -> private generated client
  -> authenticated transport
  -> Lidarr
```

Planning resolves a fresh, complete artist/resource snapshot, freezes a deterministically sorted
cohort, computes exact per-artist before/after state, seals it in a strict version 2 artifact, and
performs no writes. Apply retains the existing origin, checksum, approval, claim, history,
deferred-intent, cancellation, and resume boundaries, but must add operation-specific resource
preflight, targeted artist reads, and post-write verification before recording success.

Version 1 monitoring plans are persisted identities: their parser, canonical representation,
checksum, history lookup, and resume behavior must remain byte-compatible. All new producers,
including monitoring, should write the strict `rfmedia.lidarr-plan.v2` union.

## Relevant Components

- `packages/rfmedia-cli/src/commands/lidarr.ts` — Commander grammar, lazy action dispatch, interactive
  dry-run-before-confirmation, human rendering, machine envelopes, CSV projection, exit status, and
  the registration point for `artist-profiles`, `artist-tags`, and replacement authorization.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` — current monitoring-only producer and reference
  for fresh client resolution, scheduler admission, default plan paths, and atomic artifact writes.
- `packages/rfmedia-cli/src/actions/lidarr/artist-selection.ts` — recommended new pure module for
  selector-mode validation, exact reference resolution, AND/all-of filtering, sorted-set tag
  algebra, deterministic ordering, zero-match handling, and cap enforcement; it must perform no I/O.
- `packages/rfmedia-cli/src/actions/lidarr/plan-profiles.ts` — recommended profile producer:
  orchestrates fresh artist/profile reads and builds profile-assignment entries without importing
  generated code or calling mutations.
- `packages/rfmedia-cli/src/actions/lidarr/plan-tags.ts` — recommended tag producer: resolves one
  explicit add/remove/set/clear mode and builds full normalized before/after/delta entries.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` — shared apply lifecycle: artifact/origin/history
  validation, whole-plan preflight, per-target admission, claims, durable outcomes, deferred replay,
  cancellation, and resume. It currently re-reads the full artist list per target and records
  success immediately after the editor response; #199 must replace that path with targeted reads
  and verified postconditions.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts` — existing monitored, quality-profile, and
  repeated-tag all-of predicates. Its paging and optional stale fallback are unsuitable for
  mutation authority; only pure predicate semantics should be extracted or mirrored.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` — action barrel that must export the two new
  plan entry points and their option/result contracts.
- `packages/rfmedia-cli/src/types/lidarr.ts` — generated-independent artist domain model; add narrow
  immutable quality-profile, metadata-profile, and tag references here.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts` — current v1-only plan, monitoring entry, history,
  stale finding, apply entry, and summary types. This is the primary v1/v2 discriminated-union
  boundary and must carry operation-specific before/after/observed evidence.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` — runtime wire-to-domain guards/projectors. Current
  artist tags accept arbitrary finite numbers and preserve order; mutation planning requires
  positive safe integer IDs and sorted unique tag arrays, plus bounded profile/tag projections.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` — only permitted generated-operation importer.
  Extend `LidarrClientApi` with resource lists, one-artist lookup, and intent-bearing profile/tag
  mutations; construct allowlisted editor bodies and discard editor response bodies.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` — facade decorator and retry/cache policy.
  Forward every new method, allowlist only idempotent reads for in-place retry, and keep
  mutation-authorizing reads free of stale cache.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — current strict v1 parser/canonicalizer,
  checksum, artifact I/O, monitoring operation definition, executor map, JSONL history, resume
  selection, and exclusive claims. Add strict version dispatch while keeping infrastructure
  behavior operation-neutral.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operations.ts` — recommended extraction for monitoring,
  profile, and tag definitions once the current monitoring-specific registry is generalized.
  Definitions own canonical operation/entry state, risk, change detection, classification,
  idempotency, minimal execution, verification, and exact deferred payload matching.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts` — operation-generic SQLite intent storage,
  claims, and replay. No schema migration is needed; new executor names and credential-free payloads
  fit the existing opaque operation/payload/idempotency columns.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/tiers.ts` — shared `local-only` execution lane. Planning reads
  are idempotent; editor writes must not be automatically retried after a possibly dispatched
  request without reconciliation.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` — sole authenticated Fetch owner, with
  same-origin API-key injection, redirect rejection, timeout composition, and bounded bodies.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts` — private generated contracts already
  provide artist-by-ID, quality profiles, metadata profiles, tags, artist editor, and
  `add | remove | replace` tag modes.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` — offline codegen contract currently
  requires only four baseline reads; add all #199 generated operations/paths to its drift gate.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` — existing cross-provider architecture
  audit for private generated imports, handwritten `/api/v1/` paths, and Fetch ownership; extend it
  with narrow mutation-call ownership.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` — static command surface and
  cross-shell parity gate.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` and
  `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts` — typed facade mock and artist
  fixtures that must gain safe profile/tag defaults and mutation spies.

## Data Flow

### Plan generation

1. `commands/lidarr.ts` parses exactly one selection mode (`--ids`, filters, or `--all`) and one
   desired operation. Commander handles simple conflicts; the action repeats all invariants for
   non-CLI callers.
2. A profile/tag plan action resolves the canonical origin and a resilient `local-only` client with
   `retryAttemptsOverride: 0` and no stale consent.
3. The action fetches the complete artist list once and only the resource lists required by the
   selector and desired operation. It does not call `executeLidarrList()`.
4. `artist-selection.ts` resolves decimal IDs or exact case-insensitive names (`name:` forces name
   interpretation), rejects unknown/ambiguous resources, applies AND/all-of predicates, sorts by
   artist ID, then checks the complete result against the 25-default/1,000-hard cap.
5. The operation definition constructs each canonical entry:
   profile plans seal only managed quality/metadata dimensions; tag plans seal sorted unique full
   before/after sets plus added/removed/retained deltas.
6. The v2 builder computes operation-owned idempotency keys, review counts, and risk, then the plan
   engine seals every authoritative field into the checksum.
7. `writeLidarrPlanArtifact()` performs private, no-follow, bounded, atomic no-overwrite storage.
   Human and machine renderers consume the returned complete plan; text may show 20 entries while
   artifacts and structured output retain the full cohort.

### Apply and resume

1. `commands/lidarr.ts` performs an interactive dry-run before default-no approval; machine and
   non-interactive modes require `--yes`, while tag set/clear also require
   `--allow-tag-replacement`.
2. `readLidarrPlanArtifact()` dispatches by exact version, validates keys and sensitive-key bans,
   recomputes the matching version's checksum, and returns the v1/v2 union. Apply then checks
   expected plan identity, canonical origin, history, and resume eligibility.
3. Apply resolves the operation definition and performs one fresh zero-write preflight over all
   pending artists and referenced resources. Deleted resources or initial managed-state drift block
   the complete run.
4. Dry-run returns `satisfied`, `would-apply`, and blocked classifications without a claim, history
   row, deferred row, or editor call.
5. Real apply holds the exclusive plan claim. Before each admission it uses `getArtist(id)` and the
   operation classifier; late drift or a lost claim stops later entries.
6. The definition sends one minimal editor request with `artistIds: [id]`. Profile bodies contain
   only requested profile IDs; tag bodies contain only `tags` and explicit `applyTags`.
7. After any accepted `2xx`, apply performs a fresh targeted read and asks the definition to verify
   the managed postcondition. Only verified state is persisted as `succeeded`; an unreconciled
   post-dispatch result is `uncertain` and stops admission.
8. `appendLidarrPlanHistory()` durably records the target outcome before the next admission. A
   retryable pre-dispatch failure may enqueue the exact operation/payload/idempotency tuple.
9. `--resume` skips durable success/satisfaction, exact-matches pending deferred intents, rereads
   live state, and either classifies the target satisfied or replays only the reviewed payload.
   Replay must use the same post-write verification rule as first execution.

## Integration Points

- **Version dispatch:** `readLidarrPlanArtifact()` currently calls only
  `assertLidarrMutationPlanV1()`. Introduce explicit v1/v2 parser and canonicalizer dispatch; do not
  widen or rewrite the v1 representation.
- **Operation registry:** `LidarrMutationOperationDefinition` is monitoring-shaped (`monitored`
  state and payload). Generalize it around discriminated entries and structured classification,
  resource preflight, execution, and verification, preferably in `plan-operations.ts`; keep file
  I/O/history/claims in `plan-engine.ts`.
- **Plan construction:** `buildLidarrMutationPlan()` currently creates monitoring entries and
  computes changes by comparing `monitored`. Move entry creation and change detection behind the
  operation definition so profile/tag builders cannot diverge from apply semantics.
- **Fresh selection:** reuse the logical predicates from `actions/lidarr/list.ts`, not its
  `limit`/`offset` slice or `allowStale` path. Freeze the matched IDs in the plan; apply never reruns
  selectors.
- **Facade boundary:** add generated imports only in `lib/lidarr/client.ts`. `getApiV1ArtistById`,
  the three resource-list operations, and `putApiV1ArtistEditor` already exist; no OpenAPI refresh
  or handwritten path is necessary.
- **Projection boundary:** normalize artist tags at the client boundary. Whole-response rejection
  is required for malformed IDs, labels, counts, or arrays so partial wire data cannot authorize a
  mutation.
- **Resilience:** add read methods to the idempotent allowlist only where appropriate, but do not
  cache profile/tag lists or targeted verification reads. Keep both editor methods outside
  in-place retry.
- **Scheduler retry:** current `executeMutations()` labels the editor task `idempotent: true`, so
  the `local-only` scheduler may retry it. For #199, a timeout after dispatch requires live
  reconciliation, not an automatic second editor call.
- **Verification gap:** current apply records `succeeded` immediately after the mutation method
  returns. Add a targeted verification read before durable success for both first execution and
  deferred replay.
- **Deferred replay gap:** `replayDeferredIntents()` treats an executor return as success. New
  operation executors or the apply reconciliation wrapper must carry postcondition verification
  before completing the queue row and history record.
- **Resource preflight:** apply currently preflights artists only. Add one whole-plan lookup of all
  referenced profile/tag IDs before any write; stable ID is authority, while a renamed label is
  warning context and deletion is blocking.
- **Approval:** preserve generic plan approval, but enforce replacement authorization in both
  command and action layers so embedding callers cannot bypass it.
- **Output:** render and project by operation discriminant. Apply results need operation-specific
  `before`, `after`, and optional `observed`; stdout remains one machine document and human review
  stays on stderr.
- **Architecture/codegen gates:** require the targeted/resource/editor generated contracts and add
  negative checks proving generated imports, editor calls, handwritten paths, and extra Fetch
  owners cannot appear above their designated layer.
- **Completions/tests/docs:** update all three shell templates together; extend client, projector,
  selection, plan-engine, apply/resume, command, generated-contract, and architecture tests at
  their owning boundaries rather than duplicating every lifecycle permutation.

## Key Dependencies

- **No new package or database migration:** the checked-in generated SDK, native `Set`, Node
  crypto/fs, Commander, scheduler, JSONL history, and generic deferred-intent table cover the
  feature.
- **Generated contract:** `@hey-api/openapi-ts` remains exactly pinned and generated modules remain
  private. Offline codegen/check scripts use `packages/rfmedia-cli/openapi/lidarr-v1.json`; only the
  explicit refresh workflow contacts upstream.
- **Transport/security:** all requests flow through `transport.ts`; credentials never enter plans,
  history, deferred payloads, logs, or output. Existing private modes, no-follow checks, canonical
  origin binding, response limits, control-character rejection, and sensitive-key bans apply to v2.
- **Lidarr semantics:** editor success is any `2xx` (commonly `202`), but its response body is not
  authoritative. Add/remove tolerate unrelated tag changes; set/clear require exact full-set
  comparison; unmanaged profile dimensions do not participate in drift.
- **Durability:** plan identity is `(planId, payloadChecksum)`. JSONL history is one authoritative
  outcome per entry; deferred intents are keyed by origin plus exact idempotency key; exclusive
  claims protect concurrent apply.
- **Execution policy:** profile/tag work stays in `local-only`, uses one artist per editor request,
  and persists each verified result synchronously before admitting the next target.
- **Primary internal references:** `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`,
  `docs/plans/199-lidarr-artist-bulk-management/research-technical.md`,
  `docs/plans/199-lidarr-artist-bulk-management/research-security.md`, and
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`.
