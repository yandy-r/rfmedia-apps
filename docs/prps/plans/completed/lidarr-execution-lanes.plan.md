# Plan: Lidarr Metadata-Dependency Execution Lanes

## Summary

Implement issue #196 as a typed, per-lane Lidarr scheduler that isolates concurrency and operation budgets, owns overload-aware retries for scheduled actions, and projects stable execution metadata into existing human and machine output. The scheduler reuses the four shipped `LidarrTier` identifiers and the #195 resilience primitives; current read actions adopt the `local-only` lane while future mutation and discovery commands consume the same API later.

## User Story

As an rfmedia operator or automation author, I want Lidarr work isolated by dependency and risk lane with explicit failure metadata, so that a metadata outage, overload response, or destructive batch cannot obscure or starve reliable local operations.

## Problem → Solution

All current Lidarr calls execute directly through one resilient client and expose domain results or loosely classified errors → all scheduled calls pass through independent lane admission, finite budgets, a single retry owner, ordered structured execution results, and additive human/machine reporting.

## Metadata

- **Complexity**: Large
- **Source PRD**: `docs/prps/specs/lidarr-execution-lanes.spec.md`
- **PRD Phase**: N/A
- **Estimated Files**: 22

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-196/` (branch: `feat/lidarr-execution-lanes`)

---

## Step-by-Step Tasks

### Task 1: Add validated scheduler configuration and resolved defaults

- **ACTION**: Extend `LidarrConfigOptions` with `scheduler.lanes` partial overrides keyed by the canonical `LidarrTier`, and validate every object/field before use.
- **IMPLEMENT**: Define `concurrency`, `operationBudget`, `retryAttempts`, and `retryBackoffCapMs`. Resolve frozen defaults: local-only `8/1000/1/15000`, metadata-dependent `2/50/1/30000`, discovery `4/100/2/30000`, destructive `1/25/0/15000`; enforce bounds `concurrency 1..32`, `operationBudget 1..10000`, `retryAttempts 0..10`, and `retryBackoffCapMs 1..300000` with exact `lidarr.scheduler.lanes.<lane>.<field>` paths.
- **MIRROR**: `FROZEN_RESOLVED_POLICY` and `CONFIG_SUBOBJECT_VALIDATION`.
- **IMPORTS**: `LidarrTier`; existing `ConfigError`, integer validators, and `LidarrConfigOptions` plumbing.
- **GOTCHA**: YAML keys retain hyphens (`local-only`, `metadata-dependent`); defaults stay consumption-side and unknown keys follow current config behavior.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/config.test.ts src/lib/lidarr/index.test.ts` and `npm run typecheck -w packages/rfmedia-cli` pass.

### Task 2: Implement the isolated lane scheduler and structured outcomes

- **ACTION**: Create `scheduler.ts` with one persistent `p-limit` admission pool per lane, per-invocation operation budgets, ordered batch results, a single-task helper, and error metadata lookup.
- **IMPLEMENT**: Model succeeded/failed/skipped discriminated unions plus summaries; skip over-budget tasks as `budget-exhausted`, prevent aborted queued work from starting, and retain input ordering. Retry only idempotent tasks and retryable codes; never retry metadata-provider/validation/config/auth/not-found/invalid-response/unknown failures or destructive/non-idempotent tasks. Use exact `Retry-After` within cap, otherwise exponential full-jitter (500 ms base, 2000 ms for timeout); attach final metadata to object errors in a module-local `WeakMap` and rethrow the exact original error from `runSingle`.
- **MIRROR**: `CANONICAL_LANE_UNION`, `EXHAUSTIVE_ERROR_CLASSIFICATION`, `ORIGINAL_ERROR_IDENTITY`, and `DETERMINISTIC_RETRY_SEAMS`.
- **IMPORTS**: `p-limit`, `LidarrError`, `LidarrErrorCode`, `LidarrTier`, `LIDARR_TIER_DESCRIPTORS`, and resolved policy types.
- **GOTCHA**: Separate lane limiters must share no global capacity; promises queued before abort still resolve as skipped; enumerable scheduler objects must never contain credentials or task closures.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/lidarr/scheduler.test.ts` proves cross-run same-lane limits, simultaneous cross-lane isolation, ordering, budgets, exact attempts/delays, abort behavior, WeakMap lookup, and secret-safe serialization.

### Task 3: Establish a single retry owner and classify overload-signaled 503s

- **ACTION**: Add a per-invocation resilient-client retry override and refine status classification so scheduler-controlled calls do not amplify retries.
- **IMPLEMENT**: Add an optional `retryAttemptsOverride` to `LidarrResilienceCallOptions`; scheduled actions pass `0`, while unscheduled callers retain configured resilience behavior. In `classifyLidarrStatus`, map `503` with a parsed `Retry-After` to `RateLimitedError`; keep `503` without the overload hint as `LidarrUnreachableError` and leave other 5xx behavior unchanged.
- **MIRROR**: Existing `shouldAttemptRetry`/`retryDelayMs` logic and `EXHAUSTIVE_ERROR_CLASSIFICATION`.
- **IMPORTS**: Existing Lidarr error subclasses and resilience call-option types only.
- **GOTCHA**: The override disables only the inner retry loop; it must not bypass health gates, breaker feeding, cache write-through, stale fallback, or retry defaults for non-scheduled consumers.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/lidarr/errors.test.ts src/lib/lidarr/resilience.test.ts` pins 429, hinted/unhinted 503, cap behavior, zero inner retries, and unchanged gate/cache/breaker semantics.

### Task 4: Route all current Lidarr actions through the local-only lane

- **ACTION**: Integrate status, list, wanted, and health with the scheduler while preserving action inputs, domain fields, cache/resilience snapshots, and thrown-error identity.
- **IMPLEMENT**: Resolve one configured scheduler per action, execute the whole framework-agnostic action body as an idempotent `local-only` task, pass `retryAttemptsOverride: 0` into client resolution, and attach the successful `LidarrExecutionMetadata` additively as `execution` on each action result. Keep filtering/projection and logging outside scheduler internals but inside the retried task where consistency requires it.
- **MIRROR**: `ACTION_TIER_DECLARATION` and current cache-status callbacks.
- **IMPORTS**: Scheduler resolver/types from the Lidarr barrel; no direct generated-client imports.
- **GOTCHA**: Status performs two reads and health performs multiple diagnostics; one scheduler attempt covers the complete action so partial attempts cannot be reported as full success. Existing tests require `rejects.toBe(failure)`.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/actions/lidarr/status.test.ts src/actions/lidarr/list.test.ts src/actions/lidarr/wanted.test.ts src/actions/lidarr/health.test.ts` passes with added lane, attempt, retry, cache, and identity assertions.

### Task 5: Surface lane and failure classification in human and machine output

- **ACTION**: Extend Lidarr command rendering with additive success summaries and structured failure envelopes.
- **IMPLEMENT**: Render one quiet human summary containing lane/outcome/attempts after success. On failure, merge structural taxonomy fields with `readLidarrExecutionMetadata(error)`; human mode retains recovery hints and adds lane/failure/attempt detail, while JSON/YAML/CSV formats call `formatOutput` with `{ command, error: { message, code, lane, outcome, attempts, retryAfterSeconds } }`. Keep `process.exitCode = 1` and never call `process.exit()`.
- **MIRROR**: `MACHINE_OUTPUT_ENVELOPE` and existing `reportLidarrFailure` recovery-hint contract.
- **IMPORTS**: Scheduler metadata reader and existing formatter/logger utilities.
- **GOTCHA**: Machine-format logging is intentionally suppressed, so failure rendering must use the formatter exactly once; do not emit a human line to stdout or duplicate JSON.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/commands/lidarr.test.ts` covers all four commands, human success/failure, bare `--json`, explicit JSON, YAML/CSV, retry-after, and exit code.

### Task 6: Document behavior, verify completion parity, and update the roadmap

- **ACTION**: Add focused lane documentation, update the example config and README, verify all completion templates, and mark #196 shipped in `ROADMAP.md` only after code validation.
- **IMPLEMENT**: Document lane mapping, default/bounds table, overload and failure semantics, JSON examples, explicit replay/non-goals, and future adoption. Since accepted scope adds no flags/subcommands, keep bash/zsh/fish generators unchanged and add/adjust parity assertions proving the command surface is unchanged; if implementation adds CLI surface, update all three templates together. Strike #196 in Next Up/Phase A, add the ship date `2026-07-22`, and preserve #202+ as open.
- **MIRROR**: Existing #195 ROADMAP shipped formatting, `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`, and `templates.spec.ts` three-shell parity tests.
- **IMPORTS**: None.
- **GOTCHA**: Do not claim future mutation/discovery lanes are active commands; do not expose secrets or copy real local `.rfmedia.yaml` values into examples.
- **VALIDATE**: `npm run test:run -w packages/rfmedia-cli -- src/lib/shell-completions/templates.spec.ts`, `npm run lint:md`, and `git diff --check` pass; searches show #196 shipped and #202+ open.

### Task 7: Run full validation and refresh the project graph

- **ACTION**: Execute the complete affected-package and repository gates, inspect coverage, and update graphify after final code changes.
- **IMPLEMENT**: Format only touched files, run codegen/architecture checks, targeted tests, package typecheck/build/coverage, root markdown/format checks, and the complete workspace suite. Run `graphify update .` after code stabilizes and inspect the final diff/status for generated or unrelated changes.
- **MIRROR**: `.github/workflows/rfmedia-cli.yml` commands and repository-native package scripts.
- **IMPORTS**: None.
- **GOTCHA**: Do not accept narrow tests as proof of the broad objective; distinguish unrelated pre-existing noise only with exact evidence. Dirty `graphify-out/` is expected, but only include graph changes the update actually produces.
- **VALIDATE**: Every command in `## Validation Commands` returns zero, the coverage report exercises scheduler branches, `git diff --check` is clean, and the final completion audit maps each spec requirement F1-F12/NF1-NF6 to code/tests/docs evidence.

---

## Patterns to Mirror

Code patterns discovered in the codebase. Follow these exactly.

### CANONICAL_LANE_UNION

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/tiers.ts:27-27
export type LidarrTier = "local-only" | "metadata-dependent" | "discovery" | "destructive";
```

Use this type everywhere; do not add `Lane`, `SchedulerTier`, or string aliases that can drift.

### FROZEN_RESOLVED_POLICY

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/resilience.ts:85-93
export function resolveResiliencePolicy(config?: LidarrResilienceConfigOptions): ResolvedResiliencePolicy {
  return Object.freeze({
    failureThreshold: config?.failureThreshold ?? 3,
    retryAttempts: config?.retryAttempts ?? 1,
  });
}
```

Resolve optional config at the consumption boundary into a complete frozen policy; never write defaults back into loaded config.

### EXHAUSTIVE_ERROR_CLASSIFICATION

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/resilience.ts:130-148
switch (code) {
  case "lidarr-unreachable":
  case "timeout":
    return "lidarr";
  default: {
    const exhaustive: never = code;
    throw new Error(String(exhaustive));
  }
}
```

All lane and error-code switches must have a `never` exhaustiveness guard.

### CONFIG_SUBOBJECT_VALIDATION

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/config.ts:1277-1287
if ("resilience" in raw && raw["resilience"] !== undefined) {
  const resilienceRaw = raw["resilience"];
  if (typeof resilienceRaw !== "object" || resilienceRaw === null || Array.isArray(resilienceRaw)) {
    throw new ConfigError(/* path-aware message */);
  }
}
```

Validate `lidarr.scheduler` and every lane object with path-specific `ConfigError`s before any client resolution.

### ACTION_TIER_DECLARATION

```typescript
// SOURCE: packages/rfmedia-cli/src/actions/lidarr/status.ts:16-17,105-111
export const TIER: LidarrTier = "local-only";
const client = resolveRequiredLidarrClient(overrides, {
  tier: TIER,
});
```

Keep action-owned declarative tiers and pass the same constant into scheduler and resilience options.

### ORIGINAL_ERROR_IDENTITY

```typescript
// SOURCE: packages/rfmedia-cli/src/actions/lidarr/status.test.ts:183-183
await expect(executeLidarrStatus({ allowStale: true })).rejects.toBe(failure);
```

Record scheduler failure metadata in a module-local `WeakMap<object, ...>` and rethrow the exact caught object; do not wrap current action failures.

### MACHINE_OUTPUT_ENVELOPE

```typescript
// SOURCE: packages/rfmedia-cli/src/commands/lidarr.ts:273-274
const jsonOutput: LidarrStatusJsonOutput = { command: "lidarr-status", result };
await formatOutput(format, jsonOutput);
```

Use the same formatter for success and structured machine failure envelopes; human diagnostics remain on stderr.

### DETERMINISTIC_RETRY_SEAMS

```typescript
// SOURCE: packages/rfmedia-cli/src/lib/lidarr/resilience.ts:110-117
readonly now?: () => Date;
readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
readonly random?: () => number;
```

Inject clock, abortable delay, and randomness so scheduler tests never depend on real time.

### TEST_MOCK_LIFECYCLE

```typescript
// SOURCE: packages/rfmedia-cli/src/test-utils/mock-lifecycle.ts:1-20
clearMocksPreservingImplementations();
```

Preserve hoisted mock implementations between tests; avoid `vi.resetAllMocks()`.

---

## UX Design

### Before

```text
rfmedia lidarr <command>
  └─ action → resilient client → domain result OR unstructured command failure
```

### After

```text
rfmedia lidarr <command>
  └─ lane scheduler → resilient client (internal retries disabled)
       ├─ success → domain result + execution { lane, outcome, attempts }
       └─ failure → original error + attached classified execution metadata
```

### Interaction Changes

| Touchpoint                      | Before                                          | After                                                                  | Notes                                         |
| ------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| Successful human Lidarr command | Domain table only                               | Domain table plus one concise lane/attempt summary                     | No renamed commands or flags.                 |
| Successful JSON/YAML/CSV        | Existing result envelope                        | Existing result envelope with additive `result.execution`              | Primary domain fields remain compatible.      |
| Failed human Lidarr command     | Message and selected recovery hints             | Message, lane, failure type, attempts, retry-after, and existing hints | Original error remains the thrown value.      |
| Failed machine-format command   | Log suppression could leave no structured error | Stable command error envelope with execution metadata                  | stdout remains the only machine-data channel. |
| Configuration                   | Global resilience knobs only                    | Validated `lidarr.scheduler.lanes` overrides over frozen defaults      | No new CLI flags.                             |

---

## Mandatory Reading

Files that MUST be read before implementing:

| Priority       | File                                                                | Lines           | Why                                                                                 |
| -------------- | ------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------- |
| P0 (critical)  | `docs/prps/specs/lidarr-execution-lanes.spec.md`                    | all             | Accepted scope, requirements, and non-goals.                                        |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/tiers.ts`                      | 1-104           | Canonical four-lane identifiers and health-gate descriptors.                        |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`                 | 80-177, 250-520 | Existing retry owner, delay seams, circuit feeding, gate order, and stale fallback. |
| P0 (critical)  | `packages/rfmedia-cli/src/lib/lidarr/errors.ts`                     | 18-270          | Stable error taxonomy, `Retry-After`, and status classification.                    |
| P0 (critical)  | `packages/rfmedia-cli/src/commands/lidarr.ts`                       | 99-220, 219-585 | Human/machine output parity and current failure rendering.                          |
| P1 (important) | `packages/rfmedia-cli/src/types/config.ts`                          | 275-312         | Existing nested Lidarr configuration types.                                         |
| P1 (important) | `packages/rfmedia-cli/src/lib/config.ts`                            | 1168-1297       | Validation pattern for Lidarr sub-objects and numeric knobs.                        |
| P1 (important) | `packages/rfmedia-cli/src/actions/lidarr/status.ts`                 | 1-125           | Representative action tier, client resolution, and result projection.               |
| P1 (important) | `packages/rfmedia-cli/src/actions/lidarr/list.ts`                   | 1-160           | Representative filtered result and cache-status pattern.                            |
| P1 (important) | `packages/rfmedia-cli/src/lib/parallel.ts`                          | all             | Existing bounded-concurrency conventions and abort/progress semantics.              |
| P1 (important) | `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`            | 1-760           | Deterministic clock/delay/random seams and exact retry tests.                       |
| P2 (reference) | `docs/plans/lidarr-metadata-resilience/design.md`                   | 480-553         | Predecessor retry matrix and explicit #196 integration contract.                    |
| P2 (reference) | `research/rfmedia-lidarr-integration/persona-findings/analogist.md` | 73-87, 153-165  | Bulkhead lanes and overload-signal rationale.                                       |
| P2 (reference) | `ROADMAP.md`                                                        | 35-64, 188-218  | Phase ordering and shipped/open state to update.                                    |

## External Documentation

| Topic                        | Source                                                                                                                               | Key Takeaway                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Bulkhead isolation           | [AWS Well-Architected bulkheads](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_fault_isolation_use_bulkhead.html) | Separate capacity pools contain dependency failure blast radius.                     |
| Circuit breaker coordination | [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)                           | Retries and admission must respect open/half-open dependency state.                  |
| `Retry-After` semantics      | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)                                                             | Honor delta-seconds on overload only within the configured wait cap.                 |
| HTTP 429                     | [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)                                                                    | Rate-limited responses may carry `Retry-After` and must not trigger unbounded retry. |

> Research dispatch note: both prescribed `prp-researcher` calls failed to return after one bounded retry and produced no backstop artifact. The plan uses direct traces across all eight discovery categories plus the repository's completed Lidarr research corpus.

---

## Files to Change

| File                                                               | Action | Justification                                                                                                     |
| ------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `docs/prps/specs/lidarr-execution-lanes.spec.md`                   | CREATE | Record the accepted issue #196 design and requirements.                                                           |
| `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`                 | CREATE | Own lane policies, admission, concurrency, budgets, retries, ordered results, classification, and error metadata. |
| `packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts`            | CREATE | Prove isolation, ordering, budgets, retries, overload handling, aborts, and secret-safe metadata.                 |
| `packages/rfmedia-cli/src/lib/lidarr/index.ts`                     | UPDATE | Re-export scheduler APIs and resolve scheduler policy from loaded config.                                         |
| `packages/rfmedia-cli/src/lib/lidarr/index.test.ts`                | UPDATE | Verify resolver wiring and frozen configured/default policy.                                                      |
| `packages/rfmedia-cli/src/lib/lidarr/errors.ts`                    | UPDATE | Treat overload-signaled 503 responses as rate-limited while retaining plain 503 reachability semantics.           |
| `packages/rfmedia-cli/src/lib/lidarr/errors.test.ts`               | UPDATE | Pin 429/503/Retry-After classification and non-retryable validation behavior.                                     |
| `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`                | UPDATE | Add a per-call internal-retry override so scheduled work has exactly one retry owner.                             |
| `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`           | UPDATE | Prove retry override disables internal attempts without bypassing gates, breakers, or stale fallback.             |
| `packages/rfmedia-cli/src/types/config.ts`                         | UPDATE | Add `lidarr.scheduler` and typed per-lane optional overrides.                                                     |
| `packages/rfmedia-cli/src/lib/config.ts`                           | UPDATE | Validate scheduler/lane objects and bounded integer knobs with exact property paths.                              |
| `packages/rfmedia-cli/src/lib/config.test.ts`                      | UPDATE | Cover valid partial overrides, every lane, wrong shapes, invalid bounds, and unknown-key behavior.                |
| `packages/rfmedia-cli/src/actions/lidarr/status.ts`                | UPDATE | Route the local-only status read through the scheduler and return execution metadata.                             |
| `packages/rfmedia-cli/src/actions/lidarr/list.ts`                  | UPDATE | Route the local-only list read through the scheduler and preserve cache metadata.                                 |
| `packages/rfmedia-cli/src/actions/lidarr/wanted.ts`                | UPDATE | Route the local-only wanted read through the scheduler.                                                           |
| `packages/rfmedia-cli/src/actions/lidarr/health.ts`                | UPDATE | Route the diagnostic read/snapshot through the scheduler without changing diagnostic exit semantics.              |
| `packages/rfmedia-cli/src/actions/lidarr/status.test.ts`           | UPDATE | Pin scheduler invocation, success metadata, retries, and original-error identity.                                 |
| `packages/rfmedia-cli/src/actions/lidarr/list.test.ts`             | UPDATE | Pin scheduler integration with filters/cache metadata and original errors.                                        |
| `packages/rfmedia-cli/src/actions/lidarr/wanted.test.ts`           | UPDATE | Pin scheduler integration with pagination and original errors.                                                    |
| `packages/rfmedia-cli/src/actions/lidarr/health.test.ts`           | UPDATE | Pin scheduler integration with health/resilience snapshots and original errors.                                   |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                      | UPDATE | Render success execution summaries and structured human/machine failures.                                         |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                 | UPDATE | Cover additive success output and classified failure envelopes for every format path.                             |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | UPDATE | Assert all three shells remain in parity and no scheduler-only config creates CLI completion churn.               |
| `rfmedia.example.yaml`                                             | UPDATE | Document safe scheduler defaults and optional per-lane overrides.                                                 |
| `packages/rfmedia-cli/README.md`                                   | UPDATE | Document lanes, configuration, failure fields, and current/future action mapping.                                 |
| `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`     | CREATE | Provide focused user and architecture documentation.                                                              |
| `ROADMAP.md`                                                       | UPDATE | Mark #196 shipped only after implementation and validation complete.                                              |

Shell completion generator files (`bash.ts`, `zsh.ts`, `fish.ts`) are verification-only unless implementation adds a CLI flag or subcommand contrary to the accepted default. If that occurs, update all three templates and their parity tests in the same task.

## NOT Building

- Lidarr mutation, plan/apply, discovery-provider, search/lookup, or destructive command suites owned by #202, #198-#200, #203+, #222, and #223.
- Automatic deferred-intent replay from health checks or unrelated commands.
- Direct calls from rfmedia-cli to `api.lidarr.audio`.
- A second lane enum, global cross-lane concurrency pool, daemon, persistent scheduler queue, or schema migration.
- Per-invocation scheduler flags; configuration is the control surface for #196.
- Changes to generated OpenAPI files or the generated client operation set.

---

## Testing Strategy

### Unit Tests

| Test                      | Input                                                                                               | Expected Output                                                                                   | Edge Case? |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- |
| Policy defaults           | No scheduler config                                                                                 | Frozen exhaustive policies with the documented values                                             | No         |
| Partial policy override   | One field on one lane                                                                               | Only that field changes; other lanes/defaults remain intact                                       | No         |
| Invalid config matrix     | Wrong object shapes, floats, negatives, zero where disallowed, and values over caps                 | Path-specific `ConfigError` before client I/O                                                     | Yes        |
| Cross-lane isolation      | Slow local-only and metadata tasks scheduled together                                               | Each lane independently reaches but never exceeds its own concurrency                             | Yes        |
| Same-lane sharing         | Two concurrent `runBatch` calls on one scheduler                                                    | Combined active tasks never exceed that lane's limit                                              | Yes        |
| Operation budget          | More tasks than lane budget                                                                         | Prefix admitted; overflow returns ordered `skipped/budget-exhausted` entries                      | Yes        |
| Ordered results           | Tasks finish out of order                                                                           | Results remain in input order with correct ids                                                    | Yes        |
| Retryable read            | Idempotent task throws timeout/unreachable/rate-limited then succeeds                               | Exact attempt count and injected delay sequence; success metadata records attempts                | No         |
| Retry cap                 | `Retry-After` exceeds lane cap                                                                      | No wait/retry; terminal classified rate-limited result carries the hint                           | Yes        |
| Hinted 503                | HTTP 503 plus delta-seconds `Retry-After`                                                           | `rate-limited` classification and exact scheduler wait                                            | Yes        |
| Plain 503                 | HTTP 503 without overload hint                                                                      | `lidarr-unreachable` classification and normal bounded backoff                                    | Yes        |
| Non-retryable/destructive | Validation error, metadata-provider outage, unknown error, non-idempotent task, or destructive lane | Exactly one attempt                                                                               | Yes        |
| Abort before start        | Abort while jobs are queued                                                                         | Running task receives signal; queued work resolves skipped and never invokes its closure          | Yes        |
| Error identity            | Current action task rejects with an object error                                                    | Action rejects with the same object and metadata remains retrievable                              | Yes        |
| Resilience override       | Scheduled client with override `0`                                                                  | Inner retry disabled; gates, breakers, cache, and stale fallback unchanged                        | Yes        |
| Action integration        | Each current action succeeds/fails                                                                  | `local-only` execution metadata added on success; existing result fields/error identity preserved | No         |
| Machine failure output    | Each command under `--json` and explicit machine formats                                            | Exactly one stable error envelope on stdout and exit code 1                                       | Yes        |
| Human output              | Success, retry, and terminal failure                                                                | Concise lane/attempt/failure details on stderr with existing hints                                | No         |
| Completion parity         | Generate bash/zsh/fish scripts                                                                      | Existing four Lidarr subcommands/options remain identical because no CLI surface changed          | No         |

### Edge Cases Checklist

- [ ] Empty task list returns a zeroed summary without opening a client or gate.
- [ ] One task and exactly-at-budget task lists execute normally.
- [ ] Budget overflow is deterministic and does not invoke skipped closures.
- [ ] Maximum configured concurrency/budget/retries/delay remain finite and bounded.
- [ ] Invalid lane names cannot compile; invalid YAML lane keys are ignored or rejected consistently with existing unknown-key policy.
- [ ] Multiple simultaneous runs share same-lane admission but not cross-lane capacity.
- [ ] Abort occurs before enqueue, while queued, during retry delay, and during a running task.
- [ ] `Retry-After` absent, zero, equal to cap, and above cap.
- [ ] 429, hinted 503, plain 503, timeout, metadata-provider outage, validation, configuration, authentication, authorization, not-found, invalid-response, and unknown thrown values.
- [ ] Stale-cache success after a failed client attempt reports success without leaking the prior failure.
- [ ] Error/result serialization contains no API key, task closure, raw response body, or credential-bearing URL.
- [ ] Human, JSON, YAML, CSV, table, and text output paths emit exactly once to the correct stream.

---

## Validation Commands

### Formatting and Diff Hygiene

```bash
npx prettier --write docs/prps/specs/lidarr-execution-lanes.spec.md docs/prps/plans/lidarr-execution-lanes.plan.md ROADMAP.md rfmedia.example.yaml packages/rfmedia-cli/README.md packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md packages/rfmedia-cli/src/lib/lidarr/scheduler.ts packages/rfmedia-cli/src/lib/lidarr/scheduler.test.ts packages/rfmedia-cli/src/lib/lidarr/errors.ts packages/rfmedia-cli/src/lib/lidarr/errors.test.ts packages/rfmedia-cli/src/lib/lidarr/resilience.ts packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts packages/rfmedia-cli/src/lib/lidarr/index.ts packages/rfmedia-cli/src/lib/lidarr/index.test.ts packages/rfmedia-cli/src/types/config.ts packages/rfmedia-cli/src/lib/config.ts packages/rfmedia-cli/src/lib/config.test.ts packages/rfmedia-cli/src/actions/lidarr/status.ts packages/rfmedia-cli/src/actions/lidarr/status.test.ts packages/rfmedia-cli/src/actions/lidarr/list.ts packages/rfmedia-cli/src/actions/lidarr/list.test.ts packages/rfmedia-cli/src/actions/lidarr/wanted.ts packages/rfmedia-cli/src/actions/lidarr/wanted.test.ts packages/rfmedia-cli/src/actions/lidarr/health.ts packages/rfmedia-cli/src/actions/lidarr/health.test.ts packages/rfmedia-cli/src/commands/lidarr.ts packages/rfmedia-cli/src/commands/lidarr.test.ts packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts
git diff --check
```

EXPECT: Prettier completes and no whitespace errors remain.

### Static Analysis and Architecture

```bash
npm run test:codegen:lidarr -w packages/rfmedia-cli
npm run codegen:lidarr:check -w packages/rfmedia-cli
npm run check:architecture -w packages/rfmedia-cli
npm run test:architecture -w packages/rfmedia-cli
npm run typecheck -w packages/rfmedia-cli
```

EXPECT: Generated-client drift, architecture tests, and TypeScript checks all pass.

### Targeted Unit Tests

```bash
npm run test:run -w packages/rfmedia-cli -- \
  src/lib/lidarr/scheduler.test.ts \
  src/lib/lidarr/errors.test.ts \
  src/lib/lidarr/resilience.test.ts \
  src/lib/lidarr/index.test.ts \
  src/lib/config.test.ts \
  src/actions/lidarr/status.test.ts \
  src/actions/lidarr/list.test.ts \
  src/actions/lidarr/wanted.test.ts \
  src/actions/lidarr/health.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/shell-completions/templates.spec.ts
```

EXPECT: All focused scheduler, integration, output, and completion tests pass.

### Package Coverage and Build

```bash
npm run test:coverage -w packages/rfmedia-cli
npm run build:rfmedia
```

EXPECT: The full rfmedia suite passes; the coverage report demonstrates scheduler branch coverage; the package builds with copied assets and executable bootstrap.

### Repository Gates

```bash
npm run lint
npm run test:run
npm run build:all
npm run format:check
```

EXPECT: Markdown, all workspace tests, all builds, and repository formatting pass without regressions.

### Graph Update

```bash
graphify update .
```

EXPECT: The knowledge graph updates successfully after code changes; inspect and include only relevant graph outputs.

### Manual Validation

- [ ] `npm run rfmedia -- lidarr --help` shows the existing four subcommands and no unintended scheduler flags.
- [ ] `npm run rfmedia -- completion bash`, `zsh`, and `fish` generate scripts containing the current Lidarr commands/options.
- [ ] JSON success/failure test snapshots show `lane`, `outcome`, `attempts`, and classified failure metadata without secrets.
- [ ] `git status --short` contains only issue #196 design, plan, implementation, tests, docs, ROADMAP, and graph updates.

---

## Acceptance Criteria

- [ ] F1: Exactly four scheduler lanes reuse the canonical `LidarrTier` union and every scheduled task declares one.
- [ ] F2: Every lane has independent validated concurrency, operation budget, retry attempts, delay cap, and safe defaults.
- [ ] F3: Single/batch scheduling is abort-aware, bounded, ordered, and reports succeeded/failed/skipped work.
- [ ] F4: Metadata-gated attempts retain the shipped gate/circuit behavior while local-only work performs no metadata gate.
- [ ] F5: Scheduler failures preserve stable taxonomy plus lane, attempts, status, retryability, and retry-after.
- [ ] F6: 429, hinted 503, plain 503, and Retry-After cap behavior are deterministic and tested.
- [ ] F7: Status, list, wanted, and health execute through `local-only` without breaking domain payloads.
- [ ] F8: Human and machine success/failure output surfaces execution metadata on correct streams.
- [ ] F9: Invalid configuration and non-retryable errors fail before additional attempts.
- [ ] F10: Tests, docs, example config, completion parity, and `ROADMAP.md` are updated.
- [ ] F11: No implicit deferred replay or unrelated command side effects are introduced.
- [ ] F12: Future lanes are consumable without implementing future command suites now.
- [ ] NF1-NF6: Isolation, determinism, compatibility, type safety, secret safety, and finite resource bounds are each proven by tests.
- [ ] All validation commands pass and the graph is current.

## Completion Checklist

- [ ] Code follows discovered tier, config, error, output, and test patterns.
- [ ] The scheduler is the sole in-place retry owner for scheduled actions.
- [ ] Health gates, circuit breakers, cache, and stale fallback remain active.
- [ ] Original thrown object identity is preserved for current actions.
- [ ] All exported functions/types have JSDoc and ESM imports use `.js` extensions.
- [ ] No `any`, unsafe assertions, hardcoded secrets, unbounded queues, or real-time sleeps in tests.
- [ ] No generated OpenAPI or unrelated files changed.
- [ ] Bash, zsh, and fish completion parity is explicitly verified.
- [ ] User documentation and ROADMAP match actual shipped scope.
- [ ] No unnecessary child issue or scope addition is required.
- [ ] Plan is self-contained and implementation can proceed without new decisions.

## Risks

| Risk                                              | Likelihood | Impact | Mitigation                                                                                                                   |
| ------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Double retry amplification                        | M          | H      | Scheduled actions force resilient retry override to zero; exact call/delay tests prove one owner.                            |
| Circuit state receives each scheduler attempt     | M          | M      | Treat each actual network failure as a breaker event and test circuit-open short-circuit behavior.                           |
| Machine failure output regression                 | M          | H      | Route through existing formatter and test exactly-once stdout for every format.                                              |
| Action result compatibility                       | M          | H      | Add only `execution`; preserve field values, cache metadata, and original thrown objects.                                    |
| Queue abort leaves unresolved promises            | M          | H      | Let queued limiter closures start only to observe abort and resolve skipped; never clear queued promises without settlement. |
| Per-lane defaults are unsafe for future mutations | L          | H      | Destructive defaults to concurrency 1/retries 0; all non-idempotent tasks bypass retry regardless of lane.                   |
| Config surface becomes unwieldy                   | M          | M      | Limit to four numeric knobs per lane and publish a single defaults/bounds table.                                             |

## Notes

- No child issue is required: the accepted scope is cohesive and future command suites already have dedicated issues.
- `LidarrTier` is the scheduler lane type even though older comments call it a reliability tier; update documentation wording carefully without creating a replacement type.
- The `503` distinction is evidence-based: only a 503 carrying `Retry-After` is treated as overload/rate-limited; an unhinted 503 remains local Lidarr unavailability.
- Existing `.rfmedia.yaml` is local configuration and must never be read into documentation, modified, or committed; use only `rfmedia.example.yaml`.
