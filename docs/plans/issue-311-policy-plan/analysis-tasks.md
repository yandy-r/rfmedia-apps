# Task Structure Analysis: issue-311-policy-plan

## Executive Summary

Implement issue #311 in seven bounded edit tasks plus one read-only validation gate. The critical
path is contracts -> projector -> action -> command/presenter -> final validation. Shell templates
and operator documentation can start beside the contract work, then converge through one completion
parity test task. Maximum safe parallelism is **three workers**: more would create overlapping edits
in the policy command, presenter, completion parity suite, or barrel exports.

The decomposition preserves the architectural seams already present: a zero-value-import result
contract, a pure total projector, an impure action that composes existing producers, a Commander and
presentation boundary, handwritten completion templates, and documentation. Tests target only the
new safety contracts; existing suites continue to own plan checksums, secure writes, apply, and
generated-client behavior.

## Recommended Phase Structure

1. **Phase 1 — Independent foundations (maximum parallelism: 3)**
   - T1 contracts and exports.
   - T5 completion templates, using the fixed feature-spec surface.
   - T7 operator docs and ROADMAP, using the fixed workflow.
2. **Phase 2 — Core implementation (maximum parallelism: 2)**
   - T2 projector follows T1.
   - T5/T7 may finish in parallel without touching core files.
3. **Phase 3 — Orchestration and CLI (maximum parallelism: 2)**
   - T3 action follows T2.
   - T4 command/presenter follows T3; T6 completion parity may begin once T4's exact Commander
     surface and T5's templates are both stable.
4. **Phase 4 — Integration gate (maximum parallelism: 1)**
   - V1 runs focused tests, package gates, documentation lint, and a scope review. Failures return to
     the task that owns the implicated file; the validator does not make opportunistic edits.

Recommended merge order is T1, T2, T3, T4, T5, T6, T7, then V1, regardless of safe execution
parallelism. This yields a reviewable history from data contract through compatibility surfaces.

## Task Granularity

### T1 — Define policy-plan contracts and public type export

**Owned files (2):**

- `packages/rfmedia-cli/src/types/lidarr-policy-plan.ts`
- `packages/rfmedia-cli/src/types/index.ts`

Define mode constants, discriminated cohorts, refusal codes, proposal changes, ordered outcomes,
summary accounting, statuses, and the versioned result. Preserve zero value imports and immutable
arrays. Model partial outcomes so completed artifact path/ID/checksum data survives later failure.

**Acceptance:** `recommend|plan` is exhaustive; result types represent reviewed, no-change,
refused, sealed, partial, and failed states without widening v3 artifacts.

### T2 — Build the pure, total proposal projector

**Owned files (2):**

- `packages/rfmedia-cli/src/lib/bridge/policy-plan.ts`
- `packages/rfmedia-cli/src/lib/bridge/policy-plan.test.ts`

Validate unique decision keys, descriptor/handoff agreement, authoritative artist IDs, numeric
profile targets, boolean monitoring targets, bounds, and same-artist conflicts. Emit discovery as an
explicit refusal. Group by producer and desired scalar; sort by `POLICY_PRODUCER_IDS`, target, and
artist ID. Freeze output and assert exact input-key-to-cohort/refusal accounting.

**Critical tests:** both supported producer shapes; discovery refusal; deterministic dedupe/order;
cross-intent withholding; malformed identity/target/descriptor and oversized cohort fail before a
usable projection is returned.

### T3 — Compose evaluation and sealed-plan producers

**Owned files (3):**

- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.ts`
- `packages/rfmedia-cli/src/actions/lidarr/policy-plan.test.ts`
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Run evaluation once, call the projector, return immediately in recommend mode, and globally block
plan mode on any refusal. Seal sequentially through existing profile then monitoring producers, bind
numeric profile ID and exact cohort-sized `maxBatch`, and acquire no wrapper scheduler slot. Preserve
completed outcomes in a typed partial result when a later producer fails; never call apply or delete
an artifact.

**Critical tests:** recommend calls no producer; refusal calls neither producer; clean plan dispatches
exact typed options in stable order; no-proposal success writes nothing; producer two failure exposes
producer one's artifact.

### T4 — Add command, presentation, and command contract

**Owned files (3):**

- `packages/rfmedia-cli/src/commands/lidarr-policy.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`

Register `plan` after `evaluate`; reuse rule/cap/library/connection/explain/verbose parsing and add
`--mode recommend|plan`, default recommend. Validate before lazy import. Render total counts,
cohorts, refusals, ordered artifacts, partial failures, and checksum-pinned separate apply commands.
Keep human output on stderr and JSON/YAML/CSV as one prose-free stdout document. Update the parent
description because one child may write artifacts while retaining evaluate's stronger read-only text.

**Critical tests:** child and option order; default/explicit mode forwarding; invalid mode/rule/cap
before lazy loading; redaction; refused/partial exit 1 after evidence; one human and one machine
boundary case.

### T5 — Extend all completion templates

**Owned files (3):**

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Add the `policy plan` child, its exact options, `recommend plan` mode values, policy rule values, and
nested routing/predicates. Keep completion static, offline, and side-effect free.

### T6 — Lock Commander/completion parity

**Owned file (1):**

- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add one cross-shell matrix for child, option, and enumerated-value parity plus one executable Bash
nested-routing case. Do not duplicate equivalent assertions once per shell.

### T7 — Complete operator and roadmap documentation

**Owned files (3):**

- `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`
- `packages/rfmedia-cli/README.md`
- `ROADMAP.md`

Replace manual transcription with recommend -> explicit plan -> separate pinned apply examples.
State that discovery blocks plan mode, evaluate remains write-free, planning never applies, multiple
artifacts are independent, and no output override exists in v1. Update delivery status/counts without
rewriting unrelated roadmap entries.

### V1 — Validate the integrated change

**Owned files:** none; this is deliberately a read-only gate.

Run focused projector/action/command/completion tests first, then rfmedia-cli typecheck, architecture
and codegen checks, package tests/build, formatter/linter, and markdown validation. Confirm `git diff`
contains no config, generated client, plan schema, apply, operation-definition, database, or unrelated
roadmap changes. Route any failure back to T1-T7 ownership.

## Dependency Analysis

```text
T1 contracts
  -> T2 projector
     -> T3 action
        -> T4 command/presenter
           -> T6 completion parity

T5 completion templates -----------> T6
T7 docs/ROADMAP --------------------> V1
T1 -> T2 -> T3 -> T4 -> T6 --------> V1
T5 ---------------------------------> V1
```

T5 and T7 depend on the approved feature spec, not implementation internals, so they are the only
safe early parallel branches. T6 waits for both T4 and T5 because it compares the runtime command
surface with all templates. Barrel ownership stays with T1/T3 to prevent export conflicts. T4 keeps
the command, presenter, and their shared test together because their output schema and exit behavior
must land atomically.

## File-to-Task Mapping

| Task                    |         Files | Depends on   |
| ----------------------- | ------------: | ------------ |
| T1 contracts            |             2 | Feature spec |
| T2 projector            |             2 | T1           |
| T3 action               |             3 | T2           |
| T4 command/presenter    |             3 | T3           |
| T5 completion templates |             3 | Feature spec |
| T6 completion parity    |             1 | T4, T5       |
| T7 docs/ROADMAP         |             3 | Feature spec |
| V1 validation           | 0 (read-only) | T1-T7        |

No task shares an owned file. Keep corrective edits with the original owner and serialize merges on
the critical path; this is what permits three-way parallel work without hidden merge conflicts.
