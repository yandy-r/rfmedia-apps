# Plan: Lidarr Mutation Plan/Apply

## Summary

Implement issue #202 as a strict, registry-driven Lidarr mutation plan/apply engine with a
checksum-sealed artifact, bounded preview, immediate remote-state revalidation, explicit apply
gates, durable per-target history, and explicit deferred resume. Ship exact-ID artist monitoring as
the first complete producer/executor while preserving #198–#201 for richer domain selectors and
mutation UX.

## User Story

As an rfmedia operator or automation author, I want to review, save, apply, and safely resume a
bounded Lidarr mutation plan, so that bulk changes cannot silently target the wrong instance, stale
state, or already-completed work.

## Problem → Solution

Lidarr has read-only rfmedia commands plus scheduler/deferred seams but no safe write contract →
mutations are expressed as desired state, serialized into a secret-free reviewed plan, revalidated
at apply time, executed through the existing facade/scheduler, and recorded per target for audit and
resume.

## Metadata

- **Complexity**: XL
- **Source PRD**: `docs/prps/specs/lidarr-mutation-plan-apply.spec.md`
- **PRD Phase**: N/A
- **Estimated Files**: 22

---

## UX Design

### Before

```text
rfmedia lidarr status|list|wanted|health
  └─ read-only action → scheduler → resilient facade → Lidarr

No supported Lidarr mutation path exists.
```

### After

```text
rfmedia lidarr plan artist-monitoring --ids 12,34 --unmonitored --max-batch 25
  └─ read current artists → bounded desired-state preview → sealed plan JSON

rfmedia lidarr apply <plan.json> [--yes] [--resume] [--dry-run]
  └─ validate + bind origin → re-read targets → explicit gate
       └─ scheduler → facade mutation → durable per-target outcome
            └─ retryable failure → deferred intent → explicit --resume only
```

### Interaction Changes

| Touchpoint             | Before                                | After                                                                             | Notes                                                                 |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `rfmedia lidarr plan`  | Missing                               | Creates and renders a read-only exact-ID artist-monitoring plan                   | Default cap is conservative; exceeding `maxBatch` fails before write. |
| `rfmedia lidarr apply` | Missing                               | Checks and applies a reviewed artifact                                            | Interactive text confirms; machine/non-TTY mutation requires `--yes`. |
| `--dry-run`            | Global option unused by Lidarr writes | Validates artifact and current state without mutation/history                     | Global dry-run always wins.                                           |
| `--resume`             | Missing                               | Skips durable successes/satisfied targets and retries incomplete eligible work    | Replay is never incidental.                                           |
| Machine output         | Read command envelopes only           | Stable plan/apply envelopes with risk, counts, lane, outcomes, and deferred state | stdout remains machine-only.                                          |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                               | Lines              | Why                                                                                     |
| -------------- | ------------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/lidarr-mutation-plan-apply.spec.md`               | all                | Authoritative requirements, resolved scope, and non-goals.                              |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/plan.ts`                             | 1010-1595          | Hardened artifact parsing, canonical checksum, safe I/O, staleness, and audit patterns. |
| P0 (critical)  | `packages/rfmedia-cli/src/actions/copy-plan.ts`                    | 230-576            | Preview generation, apply gates, typed failures, and aggregate result behavior.         |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/client.ts`                    | 1-272              | Generated-client privacy boundary and strict domain projection pattern.                 |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`            | 1-414              | Operation registry, idempotent enqueue, explicit replay, and executor contract.         |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`                 | 26-178, 520-646    | Lane policy, task idempotency, batch budgets, ordered outcomes, and retry ownership.    |
| P1 (important) | `packages/rfmedia-cli/src/commands/lidarr.ts`                      | 1-724              | Commander, lazy-action, human/machine rendering, and failure conventions.               |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`         | 585-655            | Private artist and artist-editor mutation calls already generated from the pinned spec. |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`       | 104-116, 1958-1984 | Broad optional wire types that must be narrowed before use.                             |
| P1 (important) | `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | 102-146            | Three-shell parity contract.                                                            |
| P2 (reference) | `docs/plans/lidarr-metadata-resilience/design.md`                  | 250-297, 470-510   | #202 deferred producer/replay decisions and idempotency rationale.                      |
| P2 (reference) | `research/rfmedia-lidarr-integration/synthesis/innovation.md`      | 181-253            | Original plan/apply and cascade-preview operator workflow.                              |

## External Documentation

| Topic                       | Source                                                                                                                                                             | Key Takeaway                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Album monitoring controller | [Pinned album controller](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Albums/AlbumController.cs#L173-L179)    | Bulk monitoring receives IDs plus desired boolean and returns `Accepted`.                                                                                  |
| Artist editor controller    | [Pinned artist editor](https://github.com/Lidarr/Lidarr/blob/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/Artist/ArtistEditorController.cs#L30-L118) | Artist editor conditionally applies monitoring/profiles/tags/moves/deletion; #202 must expose only the narrow safe monitoring subset.                      |
| Pinned OpenAPI              | [Pinned OpenAPI snapshot](https://raw.githubusercontent.com/Lidarr/Lidarr/3e2858439ff35b372d0af00bcea1b0a357572d26/src/Lidarr.Api.V1/openapi.json)                 | Generated request bodies are broad/optional and some success codes differ from controller behavior; the facade must accept valid 2xx and project strictly. |

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### VERSIONED_DESIRED_STATE_ARTIFACT

```typescript
// SOURCE: packages/rfmedia-cli/src/types/plan.ts:133-149
export interface CopyPlanV1 {
  version: typeof COPY_PLAN_VERSION;
  id: string;
  createdAt: string;
```

Use a separate `LidarrMutationPlanV1` discriminated contract with provenance, frozen desired state,
risk/review data, target identity, and a canonical checksum. Do not alias or widen the copy schema.

### CANONICAL_CHECKSUM

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/plan.ts:317-349
return `sha256:${createHash("sha256").update(canonical, "utf-8").digest("hex")}`;
```

Build checksum input from fixed-key canonical objects and deterministically sorted target entries;
never hash arbitrary parsed-object insertion order.

### ACTION_SCHEDULER_FLOW

```typescript
// SOURCE: packages/rfmedia-cli/src/actions/lidarr/status.ts:104-142
export const TIER: LidarrTier = "local-only";
const scheduled = await scheduler.runSingle(TIER, task);
return { ...scheduled.value, execution: scheduled.execution };
```

Actions declare their lane, create stable task IDs, resolve the client inside the scheduled closure,
and return additive execution metadata without rendering.

### PRIVATE_GENERATED_CLIENT_BOUNDARY

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/client.ts:198-220
return this.#operationContext.run(operation, async () => {
  const result = await invoke();
  const data = this.#unwrapGeneratedResult(result, operation, callerSignal);
```

Only the handwritten client imports the generated artist-editor call. It validates a narrow input,
accepts the transport's safe successful-2xx result, and normalizes failures through the existing
typed error boundary.

### ORDERED_BOUNDED_BATCH

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/scheduler.ts:560-606
const admitted = Math.min(tasks.length, budget);
const results = internal.map(({ result }) => result);
return Object.freeze({ lane, summary: Object.freeze(summary), results: Object.freeze(results) });
```

Preserve plan-entry ordering in all outcomes. The artifact `maxBatch` rejection happens before this
independent scheduler admission budget.

### EXPLICIT_DEFERRED_EXECUTOR

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts:110-130
execute(
  payload: Readonly<Record<string, unknown>>,
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<void>;
```

Register a narrow, validated operation-keyed executor and call replay only from `apply --resume`.
Unknown or malformed operation payloads remain pending/no-executor or fail validation; they never
fall through to a generic API call.

### COMPARE_AND_SET_STATE

```sql
-- SOURCE: packages/rfmedia-cli/src/lib/lidarr/deferred-queue-db.ts:198-220
UPDATE lidarr_deferred_intents
SET status = 'in-progress'
WHERE id = ? AND status = 'pending'
```

Use an atomic per-plan apply claim and durable per-target state transitions. Resume authority must
not depend on the existing copy audit's best-effort warning behavior.

### TYPED_FAILURE_RENDERING

```typescript
// SOURCE: packages/rfmedia-cli/src/commands/lidarr.ts:225-270
const message = error instanceof Error ? error.message : String(error);
await formatOutput(options.format, output);
process.exitCode = 1;
```

Catch `unknown`, preserve typed metadata, use the shared formatter exactly once for machine output,
keep human diagnostics on stderr, and set exit codes without terminating the process.

### COMPLETION_PARITY

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts:102-146
expect(subcommands).toEqual(["status", "list", "wanted", "health"]);
```

Update the expected command/option vocabulary and all Bash, Zsh, and Fish generators in the same
task; no shell may lag the implemented Commander tree.

### STRICT_TYPE_AND_TEST_BOUNDARIES

Use discriminated unions with `never` exhaustiveness, `readonly` public data, `unknown` plus runtime
assertion functions at JSON boundaries, dependency injection for clocks/UUID/filesystem/client
seams, and deterministic Vitest cases. Do not use `any`, double casts, non-null assertions, real
network access, or real timers in tests.

---

## Files to Change

| File                                                               | Action | Justification                                                                                                                            |
| ------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/types/lidarr-plan.ts`                    | CREATE | Versioned plan, operation, risk, drift, history, outcome, and output contracts.                                                          |
| `packages/rfmedia-cli/src/types/index.ts`                          | UPDATE | Re-export stable Lidarr plan types.                                                                                                      |
| `packages/rfmedia-cli/src/lib/errors.ts`                           | UPDATE | Add distinct typed Lidarr plan artifact/schema/stale/already-running errors or safely generalize existing plan errors.                   |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`               | CREATE | Registry, canonicalization, validation, checksum, hardened I/O, origin binding, claims, history, resume selection, and deferred mapping. |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`          | CREATE | Artifact, security, drift, claim, history, resume, and registry coverage.                                                                |
| `packages/rfmedia-cli/src/lib/lidarr/client.ts`                    | UPDATE | Add the narrow validated artist-monitoring facade mutation.                                                                              |
| `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`               | UPDATE | Pin generated call input, valid 2xx handling, abort/error behavior, and secret-safe diagnostics.                                         |
| `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`                | UPDATE | Keep new mutation retry ownership deny-by-default and expose any origin/context seam without credentials.                                |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                     | UPDATE | Export the plan engine and resolve canonical secret-free target identity.                                                                |
| `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts`            | UPDATE | Register/compose the shipped artist-monitoring executor without adding automatic replay.                                                 |
| `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.test.ts`       | UPDATE | Verify mutation payload validation, dedupe, explicit replay, and malformed/unknown behavior.                                             |
| `packages/rfmedia-cli/src/actions/lidarr/plan.ts`                  | CREATE | Read-only exact-ID selection, desired-state preview, risk summary, and artifact generation.                                              |
| `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`             | CREATE | Planning/no-mutation/max-batch/unknown/no-op/determinism tests.                                                                          |
| `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                 | CREATE | Validate, claim, re-read, gate, dispatch, record, defer, and resume.                                                                     |
| `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`            | CREATE | Apply/check/stale/tamper/origin/partial/history/resume/concurrency/cancellation tests.                                                   |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                 | UPDATE | Export the two new framework actions and types.                                                                                          |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                      | UPDATE | Add plan/apply Commander leaves and human/machine rendering.                                                                             |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                 | UPDATE | Cover parsing, conflicts, confirmation gates, formats, exit codes, and lazy-action forwarding.                                           |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`           | UPDATE | Add plan/apply commands, flags, and monitoring choices.                                                                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`            | UPDATE | Add plan/apply commands, flags, and monitoring choices.                                                                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`           | UPDATE | Add plan/apply commands, flags, and monitoring choices.                                                                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | UPDATE | Assert exact three-shell parity for the expanded Lidarr surface.                                                                         |
| `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`          | CREATE | User workflow, schema/security contract, examples, resume, errors, and future-consumer guidance.                                         |
| `packages/rfmedia-cli/README.md`                                   | UPDATE | Add concise command discovery and documentation link.                                                                                    |
| `ROADMAP.md`                                                       | UPDATE | Mark #202 shipped only after validation; keep dependent issues open and resequence Next Up.                                              |
| `docs/roadmap-archive.md`                                          | UPDATE | Record shipped #202 narrative consistent with roadmap maintenance policy.                                                                |
| `docs/prps/specs/lidarr-mutation-plan-apply.spec.md`               | UPDATE | Mark implemented after all acceptance criteria pass.                                                                                     |

## NOT Building

- Album-type selection, pagination, or independent album/release monitoring UX from #198.
- Quality/metadata profile and tag selectors or tag CRUD from #199.
- Artist/album deletion, file-impact discovery, irreversible-delete policy, or Plex scans from #200.
- CSV/JSON/YAML bulk import/export formats from #201.
- Add/search/discovery operations, indexer-budget estimation, or Prowlarr integration from #203+/#219.
- Background, startup, health-triggered, or unrelated-command replay of deferred mutations.
- Raw generated-model exports, raw HTTP-path operations, API keys in artifacts, or a generic unsafe mutation escape hatch.

---

## Step-by-Step Tasks

### Task 1: Define strict plan and failure contracts

- **ACTION**: Add the complete `rfmedia.lidarr-plan.v1` type model and distinct typed failure classes before writing runtime logic.
- **IMPLEMENT**: Model one shipped `artist-monitoring` desired-state operation, branded plan/entry identities where useful, creator and canonical-origin binding, before/after projections, risk/cascade facts, `maxBatch`, checksum, drift findings, per-target apply/deferred outcomes, aggregate statuses, authoritative history records, and stable command envelopes as readonly discriminated unions. Reuse existing plan errors only if their names/codes remain unambiguous for both copy and Lidarr; otherwise add Lidarr-specific subclasses without changing copy behavior.
- **MIRROR**: `VERSIONED_DESIRED_STATE_ARTIFACT`, `STRICT_TYPE_AND_TEST_BOUNDARIES`, and existing plan error subclasses.
- **IMPORTS**: Node-free domain types, `LidarrTier`, and existing error base conventions; ESM `.js` paths only.
- **GOTCHA**: Do not persist a credential, raw generated type, optional-field soup, force flag, callback, or executable closure. Encode terminal and resumable states so impossible combinations do not compile.
- **VALIDATE**: `npm run typecheck -w packages/rfmedia-cli` passes after adding type-level/exhaustiveness assertions in the first failing test scaffold.

### Task 2: Build the hardened mutation registry and artifact engine test-first

- **ACTION**: Implement `plan-engine.ts` from failing tests covering the untrusted artifact and durable resume boundary.
- **IMPLEMENT**: Add a minimal operation registry; fixed-key canonicalization; deterministic target sorting; SHA-256 sealing; exact-key and forbidden-key recursive validation; string/array/count bounds; 10 MiB cap; canonical-path, no-symlink, private-directory/file, exclusive-temp, fsync, atomic-rename I/O; origin/version/operation checks; plan claim acquisition/release with stale-claim recovery; and durable per-target history append/read. History writes are mandatory before further targets are admitted, and resume derives pending work only from validated artifact plus durable terminal records.
- **MIRROR**: `CANONICAL_CHECKSUM`, safe artifact I/O in `src/lib/plan.ts`, `COMPARE_AND_SET_STATE`, and `STRICT_TYPE_AND_TEST_BOUNDARIES`.
- **IMPORTS**: `node:crypto`, `node:fs/promises`, `node:os`, `node:path`, package version JSON, shared logger/errors, and `lidarr-plan` types.
- **GOTCHA**: Hard corruption/identity failures are never `--force-stale`; reject `__proto__`, `prototype`, `constructor`, credential-like keys, non-finite numbers, duplicate entry IDs, checksum confusion, lock traversal, malformed JSONL, and partial final writes. Keep the registry concrete to the shipped operation.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/lidarr/plan-engine.test.ts` passes artifact round-trip, deterministic checksum, tamper/version/schema/size/symlink/permission/origin failures, concurrent claim, crash/stale claim, authoritative history, malformed history, and resume-selection cases; then package typecheck passes.

### Task 3: Add the narrow artist-monitoring facade mutation

- **ACTION**: Extend `LidarrClientApi` and its private implementation with an exact-ID desired-monitoring operation.
- **IMPLEMENT**: Validate a non-empty bounded unique positive-ID list and boolean desired state before entering the generated boundary; call `putApiV1ArtistEditor` through the existing bound generated client with only `artistIds` and `monitored`; accept the hardened transport's successful 2xx result including `202`; return a narrow secret-free acknowledgement and normalize all failures through the existing facade. Keep the resilience retry allowlist unchanged unless an explicit safe policy is proven; scheduler owns retries for this idempotent desired-state unit.
- **MIRROR**: `PRIVATE_GENERATED_CLIENT_BOUNDARY`, current list/status projectors, and generated-client architecture rules.
- **IMPORTS**: Private generated SDK function/type only inside `client.ts`; public Lidarr domain types and existing typed errors.
- **GOTCHA**: The generated response map says `200` while the pinned controller returns `202`; do not reject a valid 2xx or expose `unknown`. Never set move/delete/profile/tag fields, and never import generated code from an action.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/lidarr/client.test.ts src/lib/lidarr/generated-contract.test.ts` passes exact request projection, 200/202, malformed input, auth/error/abort identity, no extra fields, and secret-redaction cases; architecture and typecheck gates pass.

### Task 4: Implement read-only plan generation

- **ACTION**: Create `executeLidarrPlan` for exact-ID artist monitoring with a complete bounded preview and no mutation path.
- **IMPLEMENT**: Accept parsed positive IDs, desired monitoring state, optional output, and validated `maxBatch` (default 25, upper bound no greater than the local-only scheduler budget). Resolve canonical origin and current artist list through the scheduled read path, reject unknown/duplicate/over-cap targets, separate no-ops from changes, build sorted expected-before/desired-after entries plus low-risk cascade facts (files unchanged, queue unchanged, no search), seal/write the artifact, and return a formatter-ready result.
- **MIRROR**: `ACTION_SCHEDULER_FLOW`, copy plan generation, `VERSIONED_DESIRED_STATE_ARTIFACT`, and sanitized action logging.
- **IMPORTS**: Plan-engine builders, Lidarr resolver/scheduler, shared logger, plan types, and package test helpers.
- **GOTCHA**: Planning may issue GETs but never the artist-editor mutation, enqueue, history append, confirmation, or direct rendering. Empty effective change sets must be explicit (valid no-op plan or typed empty-plan rejection, as fixed by tests/docs) and deterministic.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/actions/lidarr/plan.test.ts` proves zero mutation/history, exact current-state projection, unknown IDs, duplicates, empty IDs, default/custom/overflow cap, no-ops, deterministic order/checksum seam, risk facts, output path, and read failure identity; typecheck passes.

### Task 5: Implement guarded apply, durable partial outcomes, deferral, and resume

- **ACTION**: Create `executeLidarrApply` and the explicit deferred executor for the shipped operation.
- **IMPLEMENT**: Read/verify the plan; match its canonical origin; acquire the per-plan claim; load authoritative history; reject a prior run unless `--resume`; re-read all pending targets immediately; classify expected, already-desired, missing, and stale states; render review/drift; make global dry-run a zero-write check; enforce interactive confirmation or `--yes`; dispatch bounded ordered idempotent tasks through `local-only`; append a mandatory per-target outcome before admitting the next unit; enqueue retryable failures with canonical payload/idempotency keys; and on `--resume` explicitly replay eligible deferred IDs then continue only incomplete plan entries. Always release the claim in `finally`.
- **MIRROR**: Copy apply gates, `ORDERED_BOUNDED_BATCH`, `EXPLICIT_DEFERRED_EXECUTOR`, `COMPARE_AND_SET_STATE`, and scheduler failure metadata.
- **IMPORTS**: Plan engine/history, scheduler/client resolver, deferred queue/store APIs, typed errors, prompt helper, logger, and plan result types.
- **GOTCHA**: Already-desired means satisfied, not stale; unexpected before state blocks before any mutation. A succeeded remote call followed by history-write failure must stop later admissions and emit explicit uncertain recovery data. No automatic retries outside scheduler policy and no replay outside `--resume`.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/actions/lidarr/apply.test.ts src/lib/lidarr/deferred-queue.test.ts src/lib/lidarr/scheduler.test.ts` covers tamper/origin/stale/dry-run/TTY gates, ordered success, already-satisfied, partial failure, retryable deferral, non-retryable failure, mandatory-history failure, duplicate/concurrent apply, resume skip, explicit replay, cancellation, claim release, and zero incidental replay; typecheck passes.

### Task 6: Add Commander UX and machine/human parity

- **ACTION**: Wire `lidarr plan artist-monitoring` and `lidarr apply <plan>` into the existing command namespace.
- **IMPLEMENT**: Add reusable parsers for comma-separated positive IDs and bounded integers; mutually exclusive `--monitored`/`--unmonitored`; `--max-batch`, `--out`; apply path, `--yes`, `--resume`, and any narrowly justified stale/claim recovery option; global dry-run/output resolution; lazy action imports; human risk/review/outcome tables on stderr; stable JSON/YAML/CSV envelopes on stdout; and structured typed failures with existing exit semantics.
- **MIRROR**: Existing Lidarr leaf registration, `TYPED_FAILURE_RENDERING`, and copy `--apply` non-TTY gating.
- **IMPORTS**: Commander `Command`/`Option`/`InvalidArgumentError`, shared formatters, tables/colors/logger, and new action/result types.
- **GOTCHA**: Do not add a second local `--dry-run` that can disagree with the global flag. Machine mutation requires `--yes`; do not prompt in machine mode; never log a plan body or API key.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/commands/lidarr.test.ts` covers help/tree, parser bounds/conflicts, option forwarding, text and every machine format, confirmation requirements, dry-run precedence, resume, typed errors, stdout purity, and exit codes; manual `npm run rfmedia -- lidarr plan --help` and `lidarr apply --help` smoke tests succeed.

### Task 7: Update all completion templates and operator documentation

- **ACTION**: Mirror the exact new command surface in Bash/Zsh/Fish and document the safety model.
- **IMPLEMENT**: Add both leaves, nested `artist-monitoring`, option/value choices, and file completion for apply/out paths to all generators plus parity tests. Add a focused guide covering examples, artifact schema/version, risk facts, cap versus scheduler budget, origin/tamper/stale gates, dry-run, outcomes, authoritative history, explicit resume/deferred behavior, storage/permissions, failure recovery, security, and how #198–#201 register future operations; link it from the package README.
- **MIRROR**: `COMPLETION_PARITY`, existing Lidarr execution-lanes guide, and markdown conventions.
- **IMPORTS**: None.
- **GOTCHA**: Avoid claiming delete/profile/tag/import features exist. Completion vocabulary must match Commander exactly, including mutually exclusive flags and value choices.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/shell-completions/templates.spec.ts`, targeted CLI help snapshots, `npm run lint:md`, and Prettier checks on touched docs all pass.

### Task 8: Complete roadmap, report, and full validation gates

- **ACTION**: Prove every spec requirement, update project planning artifacts, and refresh Graphify after code stabilizes.
- **IMPLEMENT**: Mark the spec implemented; strike/archive #202 with ship date `2026-07-22`; move #198 to the next Lidarr item while preserving #198–#201 open; create the PRP implementation report with planned-versus-actual files/tasks/deviations and exact results; format only touched files; run focused, package, architecture, codegen, full monorepo, build, pack, markdown, and diff/security gates. Run `graphify update .` from this issue worktree as required, but do not stage ignored graph output unless tracked changes are intentional.
- **MIRROR**: Completed Lidarr execution-lanes plan/report and current ROADMAP/archive formatting.
- **IMPORTS**: None.
- **GOTCHA**: Do not claim completion from narrow tests; map F1–F14/NF1–NF6 to direct code/test/docs evidence. Preserve unrelated work and inspect every changed/staged path before commit.
- **VALIDATE**: Every command in `## Validation Commands` returns zero; coverage demonstrates critical plan/apply branches; `git diff --check`, secret/path searches, completion parity, spec/roadmap state, implementation report, and final status audit are clean.

---

## Testing Strategy

Follow RED → GREEN → REFACTOR for every boundary. Tests inject clients, schedulers, clock, UUID,
filesystem paths, prompt, history writer, and deferred store; no live Lidarr/network, nondeterministic
timers, shared mutable temp state, `any`, or implementation-only assertions.

### Unit Tests

| Test                   | Input                                                                                                 | Expected Output                                                                            | Edge Case? |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- |
| Canonical plan sealing | Same semantic entries in different input order                                                        | Byte-stable canonical checksum and sorted plan                                             | Yes        |
| Artifact round trip    | Valid plan in private temp directory                                                                  | Exact validated plan; mode `0600`                                                          | No         |
| Untrusted JSON matrix  | Extra/missing keys, prototypes, credentials, NaN-like values, oversized arrays/strings/files, symlink | Typed non-overridable artifact/schema error; no mutation/history                           | Yes        |
| Origin binding         | Valid sealed plan for a different canonical origin                                                    | Apply rejected before prompt/mutation                                                      | Yes        |
| Apply claim            | Two concurrent apply attempts for one plan                                                            | Exactly one owner; other receives typed already-running error                              | Yes        |
| History authority      | Success records plus incomplete/deferred records                                                      | Resume selects only incomplete eligible entries in artifact order                          | Yes        |
| Facade mutation        | Positive unique IDs + boolean; generated 200 or 202                                                   | Exact artist-editor request and narrow acknowledgement                                     | No         |
| Facade validation      | Empty/duplicate/invalid IDs or extra mutation fields                                                  | Typed validation error before generated call                                               | Yes        |
| Read-only planning     | Known artist IDs and desired monitoring                                                               | Review + risk + artifact; no mutation/history/enqueue                                      | No         |
| Planning cap           | Requested targets over default/custom cap                                                             | Typed validation failure; no artifact                                                      | Yes        |
| Stale revalidation     | Current state differs from expected and desired                                                       | Whole apply blocked before mutation                                                        | Yes        |
| Already desired        | Current state equals desired                                                                          | Satisfied durable outcome; no API mutation                                                 | Yes        |
| Guarded apply          | TTY yes/no, non-TTY, machine format, global dry-run                                                   | Correct confirmation/`--yes` behavior and zero-write check mode                            | Yes        |
| Partial result         | Early successes then remote failure                                                                   | Each prior success durable; failure recorded/deferred; later admissions follow stop policy | Yes        |
| Explicit resume        | Prior success plus due deferred/incomplete work                                                       | Success skipped; explicit replay/remaining work only                                       | Yes        |
| Incidental command     | Run status/list/health after queued mutation                                                          | No mutation replay                                                                         | Yes        |
| Output parity          | Human, JSON, YAML, CSV                                                                                | Stable counts/risk/lane/outcomes; no stdout contamination                                  | No         |
| Completion parity      | Bash, Zsh, Fish generation                                                                            | Identical command/option/choice vocabulary                                                 | No         |

### Edge Cases Checklist

- [ ] Empty, duplicate, non-numeric, zero, negative, unsafe-integer, and over-cap ID input
- [ ] All targets already desired and mixed desired/changed targets
- [ ] Target disappears or changes between plan and apply
- [ ] Plan checksum, version, operation, origin, key set, history, or claim is malformed
- [ ] Artifact/history/claim path is a symlink or has denied permissions
- [ ] Maximum artifact, target, string, and history-line sizes
- [ ] Concurrent apply and stale/crashed claim recovery
- [ ] Abort before admission, while queued, and during client request
- [ ] Retryable failure, Retry-After, non-retryable failure, and history-write failure after remote success
- [ ] Deferred dedupe, not-due row, no executor, malformed payload, max attempts, and explicit resume
- [ ] Non-TTY/machine mutation without `--yes`; dry-run with `--yes`; interactive decline
- [ ] API key/control characters never appear in serialized or logged output

---

## Validation Commands

### Static Analysis

```bash
npm run codegen:lidarr:check -w packages/rfmedia-cli
npm run check:architecture -w packages/rfmedia-cli
npm run test:architecture -w packages/rfmedia-cli
npm run typecheck -w packages/rfmedia-cli
npm run typecheck
```

EXPECT: Offline generated-client drift is clean; architecture tests pass; zero TypeScript errors in
the package and all workspaces.

### Focused Unit and Integration Tests

```bash
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/lidarr/plan-engine.test.ts \
  src/lib/lidarr/client.test.ts \
  src/lib/lidarr/deferred-queue.test.ts \
  src/lib/lidarr/scheduler.test.ts \
  src/actions/lidarr/plan.test.ts \
  src/actions/lidarr/apply.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/shell-completions/templates.spec.ts
```

EXPECT: Every plan/apply, security, state, resume, command, and completion case passes without live
network access.

### Coverage

```bash
npm run test:coverage -w packages/rfmedia-cli
```

EXPECT: Repository thresholds pass; new plan/apply critical business logic is fully exercised or
each uncovered defensive branch is justified in the implementation report.

### Build and Packaging

```bash
npm run build:all
npm pack --dry-run --workspace packages/rfmedia-cli
```

EXPECT: All packages build; the tarball contains required runtime/docs/assets and no plan/history,
secret, temp, lock, coverage, or worktree files.

### Full Test Suite

```bash
npm run test:run
```

EXPECT: All rfmedia and rfapps tests pass with no regressions.

### Documentation and Formatting

```bash
npx prettier --check \
  docs/prps/specs/lidarr-mutation-plan-apply.spec.md \
  docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md \
  docs/prps/reports/lidarr-mutation-plan-apply-report.md \
  packages/rfmedia-cli/docs/features/lidarr-plan-apply.md \
  packages/rfmedia-cli/README.md ROADMAP.md docs/roadmap-archive.md
npm run lint:md
git diff --check
```

EXPECT: Changed artifacts are formatted, all markdown passes, and no whitespace errors exist.

### Graph and Security Validation

```bash
graphify update .
rg -n -i '(api[_-]?key|authorization|bearer|token|secret)' \
  packages/rfmedia-cli/src/{types/lidarr-plan.ts,lib/lidarr/plan-engine.ts,actions/lidarr/plan.ts,actions/lidarr/apply.ts} \
  packages/rfmedia-cli/docs/features/lidarr-plan-apply.md
git status --short
git diff --stat
```

EXPECT: Graphify completes (ignored graph output is not staged), every credential-related code match
is a validator/redaction/documented prohibition rather than a value, and only issue-scoped paths are
modified.

### Manual Validation

- [ ] `npm run rfmedia -- lidarr --help` shows `plan` and `apply` with the four existing commands.
- [ ] `npm run rfmedia -- lidarr plan artist-monitoring --help` documents exact IDs, desired state,
      output, and cap without profile/tag/delete/import flags.
- [ ] `npm run rfmedia -- lidarr apply --help` documents dry-run precedence, `--yes`, and `--resume`.
- [ ] Missing Lidarr configuration produces the existing typed configuration failure and no artifact.
- [ ] A fixture-backed plan renders complete risk/cascade facts and a secret-free machine envelope.
- [ ] A fixture-backed dry-run apply validates current state and makes zero mutation/history writes.

---

## Acceptance Criteria

- [ ] F1–F14 and NF1–NF6 from the source spec each map to direct code, test, and/or documentation evidence.
- [ ] A real exact-ID artist-monitoring plan can be generated, reviewed, applied, and explicitly resumed end-to-end.
- [ ] Plans are deterministic, checksum-sealed, bounded, secret-free, privately/atomically written, and origin-bound.
- [ ] Corruption, unsupported schema/operation, wrong origin, unsafe paths, and unexpected target drift block before all mutation.
- [ ] Apply requires the correct interactive/noninteractive gate; global dry-run never mutates or changes history.
- [ ] Per-target successes are durable resume authority; concurrent/partial/retryable failures cannot silently duplicate completed work.
- [ ] Deferred mutation replay occurs only through explicit `apply --resume` and uses a validated registered executor.
- [ ] All writes remain behind the handwritten Lidarr facade and execute through the shipped scheduler without retry amplification.
- [ ] Human and JSON/YAML/CSV outputs are stable, complete, and secret-safe.
- [ ] Bash, Zsh, and Fish completions exactly mirror Commander.
- [ ] #198–#201 remain open and out of scope; `ROADMAP.md` and archive accurately show #202 shipped.
- [ ] Focused tests, full coverage, typecheck, architecture, codegen drift, full suite, build, pack, markdown, formatting, diff, graph, and security gates pass.

## Completion Checklist

- [ ] Every task completed with its immediate validation green
- [ ] Code follows the discovered plan, facade, scheduler, deferred, error, logging, and completion patterns
- [ ] TypeScript uses strict discriminated unions, runtime assertion functions, readonly boundaries, and zero `any`
- [ ] Tests were written first for security and failure behavior and use deterministic injected seams
- [ ] No generated files were hand-edited and no upper layer imports generated Lidarr code
- [ ] No credentials or local artifact/history/lock paths are committed
- [ ] Documentation, spec status, implementation report, ROADMAP, and archive are current
- [ ] Shell completion templates and tests are updated together
- [ ] No unnecessary #198–#201 scope or unrelated cleanup is included
- [ ] Plan is archived under `docs/prps/plans/completed/`
- [ ] Final diff and requirement-by-requirement completion audit are self-contained

## Risks

| Risk                                                                                      | Likelihood | Impact | Mitigation                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Successful remote mutation followed by failed history persistence creates uncertain state | L          | H      | Stop admissions immediately, surface the exact entry as uncertain, and let resume re-read desired/current state before deciding. |
| Concurrent processes apply one plan                                                       | M          | H      | Atomic per-plan claim, ownership metadata, tested stale-claim recovery, and `finally` release.                                   |
| Controller returns 202 while generated response map says 200                              | M          | H      | Rely on hardened transport success semantics and test both statuses behind the facade.                                           |
| Broad generated artist-editor payload leaks dangerous fields                              | M          | H      | Handwrite a narrow monitoring-only facade method and assert the exact request body.                                              |
| Additive/removal tag semantics are not safely idempotent                                  | M          | H      | Exclude profile/tag work from the shipped operation; future registry kinds persist full desired-state projections.               |
| Copy-plan reuse couples unrelated schemas or inherits best-effort audit                   | M          | H      | Reuse patterns/helpers only where contracts align; keep Lidarr artifact and authoritative history types separate.                |
| Plan locks survive a crash                                                                | M          | M      | Persist owner/age metadata, validate lock path, and allow only explicit tested stale-claim recovery.                             |
| Registry abstraction grows beyond one real operation                                      | M          | M      | Implement only hooks exercised by artist monitoring and deferred resume; future issues extend through tests.                     |

## Notes

- Planning mode is implemented in the already-created worktree
  `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-202` on
  `feat/202-lidarr-plan-apply`; `prp-implement --no-worktree` must stay in that checkout.
- No child issue is required for #202. #198–#201 are ordered downstream consumers, not blockers.
- The pinned generated SDK already contains the artist-editor call; do not refresh OpenAPI or edit
  generated output for this issue.
- If implementation evidence shows the JSONL history cannot provide authoritative concurrent state
  without excessive bespoke locking, prefer the existing SQLite infrastructure and migration
  conventions; record the deviation and keep the behavior/acceptance contract unchanged.
