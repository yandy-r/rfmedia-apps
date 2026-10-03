# Implementation Plan — Issue #209: Consumption-Driven Lidarr Policy Engine

> Binding execution plan for `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md`.
> The design is final. This document turns it into an ordered, file-disjoint task plan.
> Every repo line number below was verified against the working tree at `a71eb245`.

---

## 0. Ground rules

1. **One worktree.** Tasks in the same batch run in parallel **only** because their file sets are
   strictly disjoint. Two tasks never write the same file.
2. **No task consumes an artifact produced by a task in its own batch.** Every producer/consumer
   edge crosses a batch boundary.
3. **Tests.** Only the four §14 CRITICAL suites, the two §14.6 hard suite gates, and the §14.5
   config rejection table. §14.7's exclusions are encoded as _negative_ acceptance criteria on the
   tasks that would otherwise write them.
4. **`env -u FORCE_COLOR` prefixes every vitest invocation.** Known repo gotcha.
5. **Never run bare `npm run format`.** Verified: root `format` is `prettier --write` with no path
   argument; it prints `No parser and no file path given` and exits 2. Use `npm run format:cli` and
   `npm run format:md`, then `npm run format:check`.

---

## 1. Corrections to the design that this plan makes binding

The design contains four internal gaps/contradictions. Each is resolved once, here, and assigned to
exactly one owning task. No other task may re-decide them.

| #   | Gap                                                                                                                                                                                                                                                         | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| R1  | §5.3's YAML comment says an unresolvable `targetQualityProfile` raises `LookupNotFoundError`; §16.1 (binding) says the engine does **not** throw.                                                                                                           | §16.1 wins. The §5.3 YAML comment is corrected in the design doc before any task copies it.                                                                                                                                                                                                                                                                                                                                                                | **T0**                                         |
| R2  | §4's `PolicyRuleVerdict = { proposals, skips }` has no rule-level skip channel, yet §6.2 (`consumption-signal-empty`) and §16.1 require rule-level skips.                                                                                                   | `src/types/lidarr-policy.ts` declares `PolicyRuleOutcome = PolicyRuleVerdict \| { readonly ruleSkip: { readonly reason: PolicyRuleSkipReason; readonly detail: string } }` and `PolicyRuleEvaluator` returns it.                                                                                                                                                                                                                                           | **T1**                                         |
| R3  | §4/§4.1 name `requiredSignalsFor` / `enrichedSignalsFor` (§8.1 item 7) and the gathered-slot bundle, but declare neither. `resolvedProfileId` cannot be produced from config alone. Nothing binds the leaf's Commander options to the completion templates. | `src/types/lidarr-policy.ts` additionally declares `PolicySignalBundle`, `PolicyIdentityIndex` / `PolicyRatingIndex` / `PolicyPlayIndex`, `PolicyEvaluationInput`, `PolicyNonAuthoritativeSubject`, `requiredSignalsFor()`, `enrichedSignalsFor()`, `LIDARR_POLICY_EVALUATE_OPTION_LONGS`. Precedent: `LidarrAuditGatheredData` (`src/types/lidarr-audit.ts:360`), `LidarrAuditEvaluator` (`:569`). `resolvePolicyConfig` takes the quality-profiles slot. | **T1** (types), **T8** (`resolvePolicyConfig`) |
| R4  | §6.0 says the universal `identity-not-authoritative` refusals are emitted "once, not per rule", but `PolicySkip.ruleId` is required and §10.2's arithmetic (18 refusals inside a 21-skip total across 2 running rules) forbids duplication.                 | `indexAuthoritativeIdentities` (T4) computes the subject list **once**, with no `ruleId`. The engine (T8) emits each as a `PolicySkip` **exactly once**, attributed to the first rule in `POLICY_RULE_IDS` declaration order whose status is `proposals` or `clean`; if no rule ran, to the first registered rule id.                                                                                                                                      | **T8**                                         |

Two further clarifications that are _not_ design changes, only assignments:

- **§16.3 vs §4.** §16.3 says the cap ranking is stated "in each rule's `description`", but §4's
  frozen `POLICY_RULE_DESCRIPTORS` carries no such wording and its `description` strings are printed
  verbatim in the zero-config table (§10.2). **§4's strings stay verbatim.** The cap-ranking
  disclosure lives in the feature doc (T12) and in the presenter, next to any `cohort-cap-exceeded`
  skip (T6).
- **§16.1's phrase "trips `--fail-on degraded`"** describes a level that does not exist
  (`POLICY_FAIL_ON_LEVELS = ["none", "proposals"]`). `shouldFailPolicyEvaluation` already handles it
  correctly. **No help text, completion, or doc may advertise `degraded` as a `--fail-on` value.**

---

## 2. Verified repo facts every task may rely on

| Fact                                                                                                                                                                                                                                                                            | Evidence                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Root `npm run format` is `prettier --write` with no path — **exits 2**.                                                                                                                                                                                                         | `package.json:12`; ran it.           |
| `npm run lint:md` (markdownlint-cli2, 489 files) fails at baseline with 2 MD018 errors, both in `design.md:45` and `:53`.                                                                                                                                                       | Ran `npx markdownlint-cli2`.         |
| `npm run lint` = `typecheck && lint:md`, so it inherits that failure.                                                                                                                                                                                                           | `package.json:26`.                   |
| `npm run typecheck -w packages/rfmedia-cli` chains `codegen:lidarr:check` + `check:architecture` + `test:architecture` via `pretypecheck`.                                                                                                                                      | `packages/rfmedia-cli/package.json`. |
| `vitest.config.ts` sets **no coverage thresholds**. `test:coverage` cannot fail on ratios.                                                                                                                                                                                      | `vitest.config.ts:11-20`.            |
| `src/types/lidarr-audit.ts` carries **five** `import type` lines (`:17-21`) and still satisfies the "ZERO value imports" discipline §4 cites. The rule is _no value imports_, not _one import line_.                                                                            | Read.                                |
| `LidarrAuditGatheredData` at `types/lidarr-audit.ts:360`; `LidarrAuditEvaluator` at `:569`; `EVALUATORS` is a **module-private** `const` at `lib/lidarr/audit.ts:93`; `LidarrAuditRunInput` at `audit.ts:111`.                                                                  | Read.                                |
| `src/types/index.ts` does **not** re-export `lidarr-audit.ts`; `lidarr-policy.ts` follows suit.                                                                                                                                                                                 | `src/types/index.ts:95-124`.         |
| `probeLidarrAuditPlex`'s catch returns `{ status: "available", data: { reachable: false, … } }` (`audit-plex.ts:172-177`) — **not** the `unavailable` slot the design mandates. Only the readiness-gate ordering, adapter-inside-`try`, and raw-override forwarding are copied. | Read.                                |
| `templates.spec.ts` never constructs the Commander program. Nothing in the repo reconciles declared leaf options against the completion templates.                                                                                                                              | Read `:1-70`, `:984-1045`.           |
| `templates.spec.ts:1050` is the **only** place a generated bash branch is executed. There is no `bash -n` / `zsh -n` / `fish --no-execute` check anywhere.                                                                                                                      | Read.                                |
| `lidarr.test.ts:963` replaces the actions barrel with an **exhaustive** `vi.mock(… () => mockActions)` factory (`mockActions` at `:44-63`, no `importActual`).                                                                                                                  | Read.                                |
| `LIDARR_COMMAND_NAMES` (`lidarr.test.ts:25-40`) is asserted with `toEqual` at `:1052`. `reconcile` is registered at index **6** (`lidarr.ts:1474-1480`); `validate-import` follows.                                                                                             | Read.                                |
| bash needs **six** edit sites, not five (§4 below).                                                                                                                                                                                                                             | Read `bash.ts:204-269`.              |
| `ROADMAP.md` names #209 in **five** places: `:42`, `:63`, `:183-187`, `:195`, `:202`.                                                                                                                                                                                           | `grep -n 209 ROADMAP.md`.            |
| `lidarr-mutation-presenter.ts` is **1022 lines** — the presenter is exempt from the ~500-line cap. `lidarr-reconcile.ts` is exactly 500 and is the cap reference for the _command_ file.                                                                                        | `wc -l`.                             |

---

## 3. Where the ambiguous types live (single source of truth)

```
src/types/lidarr-policy.ts          ← T1. Zero VALUE imports; type-only imports allowed.
  §4 verbatim
  + PolicyRuleOutcome, PolicyRuleEvaluator            (R2)
  + PolicySignalBundle                                (audit precedent :360)
  + PolicyIdentityIndex / PolicyRatingIndex / PolicyPlayIndex
  + PolicyNonAuthoritativeSubject, PolicyEvaluationInput
  + requiredSignalsFor() / enrichedSignalsFor()       (§8.1 item 7)
  + LIDARR_POLICY_EVALUATE_OPTION_LONGS               (binds T3 ↔ T10)

src/lib/bridge/policy-rule-support.ts ← T4. §4.1's eight primitives only. Declares NO types
                                        (audit-check-support.ts precedent, :42).
src/lib/bridge/policy-signals.ts      ← T4. Index BUILDERS returning T1's index types.
src/lib/bridge/policy-rules.ts        ← T7. Three exported evaluator FUNCTIONS. No map.
src/lib/bridge/policy-engine.ts       ← T8. Module-private EVALUATORS map (audit.ts:93 shape),
                                        resolvePolicyConfig, runLidarrPolicyEvaluation.
```

Import direction is strictly `types ← support ← signals ← rules ← engine`. No cycle is possible.

---

## 4. The bash completion sites — six, not five

§9.4/§12 list five. Verified against `bash.ts`, a sixth is required or the `evaluate` arm never
fires, and **no existing test would catch it**:

| #   | Site                                                                                     | Anchor                                   | Model                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `"policy"` in `lidarr_subcommands`                                                       | `bash.ts:164`                            | —                                                                                                                                                                    |
| 2   | `lidarr_policy_evaluate_opts`, `lidarr_policy_rules`, `lidarr_policy_fail_levels` locals | `bash.ts:173-174`                        | `lidarr_audit_checks` / `lidarr_audit_fail_levels`                                                                                                                   |
| 3   | A **dedicated guarded `policy)` arm** in the detection `case`                            | `bash.ts:226-231`                        | the `audit)` arm — **not** membership in the shared list at `:209`, from which `audit`/`albums` are deliberately excluded so `filter`/`queue`/`plex` cannot misroute |
| 4   | **A `policy` → `evaluate` subsubcmd loop**                                               | `bash.ts:261-269`                        | the `presets` loop. **The missing sixth site.** Without it `$subsubcmd` is never set and site 6's evaluate arm is dead.                                              |
| 5   | Value-taking flags in the shared `case "$prev" in` list                                  | `bash.ts:320-360` (string arm at `:355`) | —                                                                                                                                                                    |
| 6   | `elif [[ "$subcmd" == "policy" ]]` routing branch, routing on `evaluate`                 | `bash.ts:617-643`                        | the `presets` branch; `--rule`/`--fail-on` value arms model on the `audit` branch at `:583-590`                                                                      |

zsh: 2 sites (`zsh.ts:404-423` describe array; a nested `policy)` `_arguments` block ending with
`${globalOpts}`). fish: 3 sites (two predicates in the **global-option-skipping** form at
`fish.ts:1243-1266` — _not_ the naive `test "$cmd[3]"` form at `:1268-1275`; the `-a "policy"` line
in the block at `fish.ts:1482-1494`; one `complete … -l <flag>` per option with `-r` on every
value-taking flag).

---

## 5. Task DAG

```
T0 design.md preflight ─┐
T1 types ───────────────┼─► T2 config
                        ├─► T3 completions ──────────────────────────────────────┐
                        ├─► T4 support+signals+test ─► T7 rules+test ─► T8 engine+test ─► T9 action ─► T10 command+test ─► T11 registration
                        ├─► T5 gatherers ───────────────────────────────────────────────────────────► T9              │
                        └─► T6 presenter ──────────────────────────────────────────────────────────────────────► T10 ┘
                                                                                                      └─► T12 docs
```

## 6. Batches and gates

| Batch | Tasks              | Expected                                                                                                                            |
| ----- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1     | T0, T1             | **green** — markdownlint goes green _because of_ T0 (it is red on `master`).                                                        |
| 2     | T2, T3, T4, T5, T6 | green                                                                                                                               |
| 3     | T7                 | green                                                                                                                               |
| 4     | T8                 | green                                                                                                                               |
| 5     | T9                 | green                                                                                                                               |
| 6     | T10                | green — `lidarr.test.ts` is untouched until batch 7 and the command is not yet registered, so `LIDARR_COMMAND_NAMES` still matches. |
| 7     | T11, T12           | green — full CI chain                                                                                                               |

**No batch is knowingly red.** The registration lockstep (`lidarr.ts` + `lidarr.test.ts`) is a single
task (T11), and the completions lockstep (3 templates + spec) is a single task (T3), so neither
assertion pair can sit half-applied at a batch boundary.

Batch 7 gate, in the real CI order:

```bash
npm run test:codegen:lidarr -w packages/rfmedia-cli \
 && npm run codegen:lidarr:check -w packages/rfmedia-cli \
 && npm run build -w packages/rf-common \
 && npm run typecheck -w packages/rfmedia-cli \
 && env -u FORCE_COLOR npm run test:coverage -w packages/rfmedia-cli \
 && npm run bench -w packages/rfmedia-cli \
 && npm run format:cli && npm run format:md \
 && npm run format:check \
 && npx markdownlint-cli2
```

---

## 7. File ownership — 29 files, each owned exactly once

| File                                                                | Owner |
| ------------------------------------------------------------------- | ----- |
| `packages/rfmedia-cli/docs/plans/issue-209-policy-engine/design.md` | T0    |
| `packages/rfmedia-cli/src/types/lidarr-policy.ts`                   | T1    |
| `packages/rfmedia-cli/src/types/config.ts`                          | T2    |
| `packages/rfmedia-cli/src/types/index.ts`                           | T2    |
| `packages/rfmedia-cli/src/lib/config.ts`                            | T2    |
| `packages/rfmedia-cli/src/lib/loaded-config.ts`                     | T2    |
| `packages/rfmedia-cli/src/lib/config.test.ts`                       | T2    |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`            | T3    |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`             | T3    |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`            | T3    |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`  | T3    |
| `packages/rfmedia-cli/src/lib/bridge/policy-rule-support.ts`        | T4    |
| `packages/rfmedia-cli/src/lib/bridge/policy-signals.ts`             | T4    |
| `packages/rfmedia-cli/src/lib/bridge/policy-signals.test.ts`        | T4    |
| `packages/rfmedia-cli/src/actions/lidarr/policy-gather.ts`          | T5    |
| `packages/rfmedia-cli/src/commands/lidarr-policy-presenter.ts`      | T6    |
| `packages/rfmedia-cli/src/lib/bridge/policy-rules.ts`               | T7    |
| `packages/rfmedia-cli/src/lib/bridge/policy-rules.test.ts`          | T7    |
| `packages/rfmedia-cli/src/lib/bridge/policy-engine.ts`              | T8    |
| `packages/rfmedia-cli/src/lib/bridge/policy-engine.test.ts`         | T8    |
| `packages/rfmedia-cli/src/actions/lidarr/policy-evaluate.ts`        | T9    |
| `packages/rfmedia-cli/src/actions/lidarr/index.ts`                  | T9    |
| `packages/rfmedia-cli/src/commands/lidarr-policy.ts`                | T10   |
| `packages/rfmedia-cli/src/commands/lidarr-policy.test.ts`           | T10   |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                       | T11   |
| `packages/rfmedia-cli/src/commands/lidarr.test.ts`                  | T11   |
| `packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md`   | T12   |
| `packages/rfmedia-cli/README.md`                                    | T12   |
| `ROADMAP.md`                                                        | T12   |

28 design files + `design.md` (T0 preflight) = **29**, no file listed twice.

---

## 8. Tests written, and tests deliberately not written

**Written:** `policy-signals.test.ts` (§14.1, T4), `policy-rules.test.ts` (§14.2, T7),
`policy-engine.test.ts` (§14.3, T8), `lidarr-policy.test.ts` (§14.4, T10), plus the two §14.6 hard
gates (`templates.spec.ts` in T3, `lidarr.test.ts` in T11) and the §14.5 rejection table
(`config.test.ts` in T2). **Each CRITICAL suite is owned by the same task as the module it pins**, so
a red gate always has an open owner who can fix the implementation.

**Not written (§14.7), enforced as negative acceptance criteria on the tasks that would write them:**
no `policy-gather.test.ts` (T5), no action-level integration test for `policy-evaluate` (T9), no
plan-engine/apply tests, no snapshot tests, no new benchmark.

---

## 9. Standing invariants (apply to every task)

- Strict TypeScript, no `any`, `.js` extensions on every relative import.
- No `fetch(` / `trustedFetch(`. No specifier naming `./plex/*`, `src/lib/plex*`, or
  `src/types/plex*` — including `import type`, since the matcher is raw text. No `/api/v1/` literal.
  No `musicbrainz` import. No `FETCH_OWNERS` entry.
- Every subject/proposal/skip object literal keeps id keys **singular** (`artistId`, never
  `artistIds`) so `lidarr-editor-body-owner` is structurally unreachable.
- No writer import (`writeLidarrPlanArtifact`, `appendLidarrPlanHistory`, `acquireLidarrPlanClaim`)
  and no governed `LidarrClientApi` mutation call anywhere in the new modules. `adapter.metadata` is
  never referenced.
- No `handoff.argv` may contain `"apply"` or `"--plan-file"`.
- `vi.clearAllMocks()` in `beforeEach`, never `vi.resetAllMocks()`. Mocks declared via `vi.hoisted()`
  before `vi.mock()` factories.
- Run `node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` continuously, not once.

---

## 10. Tasks

Per-task briefs, acceptance criteria, owned files, and dependency edges are carried in the structured
task list accompanying this document. Each brief is self-contained and cites the exact line ranges to
read in the four oversized files (`config.ts` 4794, `templates.spec.ts` 1810, `lidarr.test.ts` 4625,
`README.md` 5772).
