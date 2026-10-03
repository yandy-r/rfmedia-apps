# Implementation Plan: #161 vulnerability scanning + #162 `rfapps harden`

**Repository:** `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps`
**Worktree:** `.claude/worktrees/rfmedia-apps-feat-security-scan-harden`
**Branch:** `feat-security-scan-harden` (base `master`)
**Package shorthand used throughout:** `P/` = `packages/rfapps-cli/`

This document supersedes `docs/plans/security-scan-harden-161-162/design.md` wherever the two disagree. Implementer agents receive their own task section plus the **Verification gates** section, and nothing else. Each task section is self-contained by construction — do not consult the design document.

---

## Design corrections applied

| #     | Severity | Design said                                                                                                                | Reality                                                                                                                                                                                                                                            | Resolution                                                                                                                                                                                                                                                                                          | Absorbed by     |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1     | MATERIAL | Dry-run `scan` spread goes next to the `validation` spread at `deploy.ts:508-510`                                          | `:508-513` is the staged `batches` object literal; the `validation` spread is `:514-516`                                                                                                                                                           | Insert the `scan` spread immediately after `:516`, before the `});` at `:517`                                                                                                                                                                                                                       | T4              |
| 2     | BLOCKING | `HardenComposeService` (as written in §4.3) can be passed to `hasWritableBindMounts`/`hasCapAdd`/`hasDevices`/`runsAsRoot` | Those four take `LintComposeService`; the §4.3 shape produces 3 stacked TS2345s (`readonly T[]`, `healthcheck.test?: unknown`, `deploy.restart_policy?: unknown`)                                                                                  | Corrected `HardenComposeService` shipped verbatim in T2 §1: arrays mutable, `healthcheck.test?: string \| string[]`, `deploy.restart_policy?: { condition?: string }`, `deploy.resources.limits?: { memory?: string; cpus?: string \| number }`. Compile-verified. `lint-context.ts` is NOT edited. | T2              |
| 3     | MATERIAL | `deploy.spec.ts` uses `vi.mock("../lib/index.js", importOriginal)`                                                         | `deploy.spec.ts:15` is a **bare automock**; the `importOriginal` form is used only for `../lib/deploy-validation.js`                                                                                                                               | New deploy scan cases wire each new barrel export via `vi.mocked(lib.X).mock*Value(...)`                                                                                                                                                                                                            | T4              |
| 4     | MATERIAL | Insert new bash `case "$prev"` arms after `completion.ts:293`                                                              | `:293` is the `else` inside the `--fail-on)` arm; splicing there produces a script bash refuses to `source`                                                                                                                                        | Insert after `:297` (the `;;` closing `--fail-on)`), before `esac` at `:298`. Gated by `bash -n`.                                                                                                                                                                                                   | T7              |
| 5     | COSMETIC | "42 of 47 services", "47-service compose"                                                                                  | `compose.yml` has **44** services (AST, awk, and `docker compose config` all agree). 42/42 numerators are exact.                                                                                                                                   | Write "42 of 44" or omit counts entirely. Forbidden string in all docs: `47 service`.                                                                                                                                                                                                               | T8, T9, T10     |
| 6     | COSMETIC | `lineDelta: 6` / "+6"                                                                                                      | Measured `1605 → 1599`, i.e. `out − src = −6`                                                                                                                                                                                                      | `lineDelta` is signed (`serialized − source`) and is **−6** here. Tests assert `toBeLessThan(0)`. Prose says "one region, 6 lines".                                                                                                                                                                 | T2, T8, T9, T10 |
| 7     | COSMETIC | `-s`/`--service`/`--services` route to `__rfapps_service_completion` "unconditionally at `:274`"                           | `--service\|--services` is `:259-262`; `-s)` is `:235-242` and is **guarded** on `$cmd == "completion"`; `:274` closes `--limit)`                                                                                                                  | Conclusion holds (harden falls to the else branch). Anchors corrected; "unconditionally" dropped.                                                                                                                                                                                                   | T7              |
| 8     | COSMETIC | `RawDeployOptions` at `deploy.ts:88-115`                                                                                   | `:95-114`                                                                                                                                                                                                                                          | Anchor corrected                                                                                                                                                                                                                                                                                    | T4              |
| 9     | COSMETIC | `planResultForOutput(format, …)` call at `plan.ts:463`                                                                     | `:466`                                                                                                                                                                                                                                             | Anchor corrected                                                                                                                                                                                                                                                                                    | T4              |
| 10    | COSMETIC | `pullImages`/`startServices` at `deploy.ts:574`, `:923`                                                                    | `pullImages` `:931`; `startServices` `:726` (parallel) and `:964` (sequential)                                                                                                                                                                     | Anchors corrected; safety conclusion unchanged                                                                                                                                                                                                                                                      | T4              |
| 11    | COSMETIC | Add the MCP note "next to the existing closed-schema warning" in `P/CLAUDE.md`                                             | No such warning exists                                                                                                                                                                                                                             | Create it as a NEW subsection under `## Architecture Patterns`                                                                                                                                                                                                                                      | T9              |
| 12    | COSMETIC | Add `harden.ts` to the actions tree at `P/CLAUDE.md:44`; model on `:255-285`                                               | `:44` is `completion.ts`; the listing is alphabetical so `harden.ts` goes after `drift.ts` (`:47`); the backup subsection is `:246-285`                                                                                                            | Anchors corrected                                                                                                                                                                                                                                                                                   | T9              |
| 13    | COSMETIC | `invokeDeploy` and `invokePlan` at `adapters.ts:403-427`                                                                   | `invokeDeploy` `:276-303`; `invokePlan` `:402-428`                                                                                                                                                                                                 | Anchors corrected; conclusion holds                                                                                                                                                                                                                                                                 | T4, T6, T9      |
| 14    | COSMETIC | Plan scan flags go after `--explain` at `cli.ts:563`                                                                       | `--explain` is `:561`; `:563` is `-e, --env-file`                                                                                                                                                                                                  | Insert after `:561`                                                                                                                                                                                                                                                                                 | T6              |
| 15    | BLOCKING | (duplicate of #2, from the API-signature pass)                                                                             | —                                                                                                                                                                                                                                                  | Same resolution as #2                                                                                                                                                                                                                                                                               | T2              |
| 16    | MATERIAL | `DeployOptions` is covered by T3's ownership list                                                                          | `DeployOptions` lives in `P/src/types/options.ts`, which appeared under **zero** owners                                                                                                                                                            | `P/src/types/options.ts` added to T3's ownership; `DeployOptions.scan: boolean` added there; `deploy.ts:212` initializer sets it (T4)                                                                                                                                                               | T3              |
| 17    | MATERIAL | (duplicate of #6) `detectReformat` returns a **positive** `lineDelta` for a multi-line flow sequence                       | Negative                                                                                                                                                                                                                                           | Assertion restated as `toBeLessThan(0)`                                                                                                                                                                                                                                                             | T2              |
| 18    | COSMETIC | Assorted exact anchors across §3.6/§3.7/§3.8/§5.1/§5.2                                                                     | Off by 1–7 lines throughout                                                                                                                                                                                                                        | **Global rule: every line number in this plan is a hint. Re-anchor by searching for the quoted construct before inserting.** All anchors in this plan were re-read at HEAD `56eed039`.                                                                                                              | all             |
| 19    | COSMETIC | `security-scan.ts` header imports `createHash` from `node:crypto`                                                          | Unused                                                                                                                                                                                                                                             | Import dropped                                                                                                                                                                                                                                                                                      | T1              |
| 20    | COSMETIC | plan's scan block uses `setExitCode`/`getComposeConfig` as if already imported                                             | `plan.ts` imports neither                                                                                                                                                                                                                          | Both imports added explicitly. **Correction to the correction:** the pre-existing `process.exitCode = 1` at `plan.ts:455` is left ALONE (see critic resolution C7).                                                                                                                                 | T4              |
| 21    | COSMETIC | (duplicate of #5)                                                                                                          | —                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                   | T8, T9, T10     |
| 22    | MATERIAL | "`envFile` is mandatory — omitting it produces 42 spurious findings"                                                       | Measured false: byte-equivalent output either way; without an env tool `docker compose config` fails outright rather than returning empty interpolations                                                                                           | `envFile` is passed for parity with `audit.ts`, described neutrally. The "42 spurious findings" story is deleted and must not appear in any doc or test.                                                                                                                                            | T5, T8, T9      |
| 23    | MATERIAL | `harden-log-rotation` is alias-refused on 42 services in this repo                                                         | The rule never fires on them (resolved `max-size` is `"200k"`); it fires only on `ofelia` and `immich-postgres`, which have no `logging` key and patch cleanly                                                                                     | Alias refusal is documented as a **generic guard with no count**; the spec uses a synthetic fixture whose anchor omits `max-size`. Never assert against the real `compose.yml`.                                                                                                                     | T2, T8, T9      |
| 24    | COSMETIC | (duplicate of #6)                                                                                                          | —                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                   | T2, T8          |
| 25    | MATERIAL | MCP invariant is "`options.scan` is always undefined on the MCP path"                                                      | Too weak. `schemaObject`'s strict check iterates `Object.keys(input)` and the MCP path passes the raw object by reference with **no JSON round-trip**, so `{ scan: undefined }` throws `Unexpected properties at $: scan` while typechecking clean | Invariant restated as **never CREATE the key**. `result.scan = …` only inside `if (options.scan)`; plan uses a conditional spread. `ScanConfig` must never gain an `enabled`/`always` key without mirroring `scanReportSchema` into both output schemas.                                            | T3, T4, T6, T9  |
| 26–29 | COSMETIC | Assorted `plan.ts`/`deploy.ts`/`cli.ts`/`docker.ts` anchors                                                                | Off by 1–3 lines                                                                                                                                                                                                                                   | Corrected in each brief                                                                                                                                                                                                                                                                             | T4, T6          |
| 30    | COSMETIC | "reusing bare rule ids would add a **fourth** collision"                                                                   | All nine provenance ids would collide; the only pre-existing Lint/Audit overlap is `cap-drop-missing`                                                                                                                                              | Wording corrected; `harden-*` namespace decision unchanged                                                                                                                                                                                                                                          | T2              |
| 31    | COSMETIC | plan gate snippet uses untyped `planResultForOutput(format, payload)`                                                      | Would fail `noImplicitAny`; real signature is `(format: OutputFormat, payload: PlanOutputPayload): PlanOutputPayload \| object`                                                                                                                    | Explicit parameter types preserved                                                                                                                                                                                                                                                                  | T4              |
| 32    | BLOCKING | (duplicate of #4)                                                                                                          | —                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                   | T7              |
| 33    | BLOCKING | `<HARDEN_RULE_IDS>` placeholder in all three shell templates                                                               | Unbound; `completion.ts` has no precedent for importing a code-level registry, and there is no shared template                                                                                                                                     | New import `HARDEN_RULE_IDS` from `../lib/hardening.js`, a module-level `const hardenRuleIds = HARDEN_RULE_IDS.join(" ")`, and three separate `${hardenRuleIds}` interpolations. Comma-continuation is zsh-only and documented as such.                                                             | T7              |
| 34    | BLOCKING | Widen `getCommanderCommandOptions`'s union to include `"harden"`                                                           | `harden` uses `.configureHelp({ showGlobalOptions: true })`; the `/^\s+-/` extractor cannot separate `Global Options:` from `Options:` (empirically 8 phantom globals leak for `import`)                                                           | Use the registrar pattern (`getHardenCommand()` mirroring `getImportCommand()`). Only `getCommandCompletionOptions`'s union takes `"harden"`.                                                                                                                                                       | T7              |
| 35    | MATERIAL | `completion.spec.ts` edits are "CI-breaking otherwise"                                                                     | Only the pre-existing `deploy` parity case breaks; `plan` and `harden` are ungated today                                                                                                                                                           | Restated as mandatory-by-policy. New `plan` and `harden` parity cases are required.                                                                                                                                                                                                                 | T7              |
| 36    | MATERIAL | Fish harden block is "14 lines modelled on the audit block"                                                                | harden has 15 long options; the fish extractor compares an exact set                                                                                                                                                                               | 15 `complete` lines, one per long option                                                                                                                                                                                                                                                            | T7              |
| 37    | MATERIAL | zsh `harden)` arm goes "after `:904`"                                                                                      | Correct, but the load-bearing indentation constraint is unstated: the extractor regex hard-requires 8-space `harden)` and 10-space `;;`                                                                                                            | Constraint stated explicitly; plus: no harden description may contain a `--word`                                                                                                                                                                                                                    | T7              |
| 38    | MATERIAL | plan/deploy gain a `Vulnerability scanning:` after-help paragraph                                                          | `getCommanderCommandOptions` keeps **every** help line matching `/^\s+-/`, including `addHelpText` bodies                                                                                                                                          | Hard constraint: no indented help line may begin with `-`. Verified by a `grep -nE '^[[:space:]]+-'` acceptance check.                                                                                                                                                                              | T6              |
| 39–41 | COSMETIC | `completion.ts:256`/`:274`, `shell-completion.md:141-216`                                                                  | `:255`, `:235`/`:259`, `:145-215`; the doc's command list is also already stale (omits `import`, `force-unlock`)                                                                                                                                   | Anchors corrected; the stale list is fixed as part of the line already being edited                                                                                                                                                                                                                 | T7, T9          |

**Rejected corrections:** none. Every fact-check item is absorbed above.

---

## Critic resolutions

| #   | Finding                                                                                                                                                                                                                                                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Task changed |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| C1  | `docs/features/json-output.md`, `output-formats.md`, `error-handling.md` are unowned but repo precedent (commit `6e78968b`) requires per-command sections                                                                                                               | **ACCEPT** — assigned to a new task **T11 — Reference doc surfaces**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | new T11      |
| C2  | `packages/rf-common/README.md` is unowned; rf-common's own `CLAUDE.md` step 5 requires an API entry for `checkExternalTool`; T0 explicitly refuses to touch it                                                                                                          | **ACCEPT** — assigned to **T11**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | new T11      |
| C3  | `rfapps harden --json` will emit text: `cli.ts:129-133` gives `--output` `.default("text")`, so `globalOptions.output` is never `undefined` and `resolveHardenFormat` returns it before reading `rawOptions.json`. T8/T9 document the flag as working; T7 completes it. | **ACCEPT (fix the code, keep the surface)** — `resolveHardenFormat` checks `rawOptions.json === true` **first**. The 15-option surface, docs, and completions are unchanged. `audit.ts`'s identical pre-existing quirk is **out of scope** and stays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T5           |
| C4  | Command description string differs three ways (T5 vs T7 vs T9)                                                                                                                                                                                                          | **ACCEPT** — canonical string is **`Propose or apply compose security hardening`**. T5's `.description()` changed to match T7 and T9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T5           |
| C5  | `getEnvToolExecConfig` arity contradiction between T4 (1-arg, inherited) and T5 (2-arg, GAP 6)                                                                                                                                                                          | **ACCEPT with corrected rationale.** Verified: `rfapps.config.yaml` declares `envTool.tool: dotenvx` + `envFile: .env.local`, and the 1-arg form returns `undefined`. But `plan.ts:352`, `deploy.ts:210` and `audit.ts:68` **all** use the 1-arg form today — that is pre-existing, not something #161 introduces. **T4 reuses each host action's existing `envTool`/`deployExecution` verbatim (zero behaviour change to plan/deploy).** **T5 (a new command) uses the 2-arg `lint.ts:368` form** because a new command should be config-aware. T5's premise ("the 1-arg form fails outright on this repo") is corrected to "the 1-arg form ignores config-declared env tools; `lint` is the better model for a new compose-resolving command." Do NOT change `plan.ts`, `deploy.ts`, or `audit.ts`. | T4, T5       |
| C6  | T3's §0.1 rationale for omitting `?? []` on `harden.rules` contradicts T2's `selectRules` (which treats `[]` as _all_ rules)                                                                                                                                            | **ACCEPT** — instruction kept (leave `rules` undefined), rationale corrected: `selectRules` already treats an empty array as the full catalog, so `?? []` is redundant, not dangerous. A T3 implementer must NOT alter `selectRules`. T9's config sample no longer teaches `rules: []`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | T3, T9       |
| C7  | T4's deviation D3 (rewriting the untouched `process.exitCode = 1` at `plan.ts:455`) is scope creep                                                                                                                                                                      | **ACCEPT the objection — REJECT D3.** `plan.ts:455` is left byte-unchanged. New scan code uses `setExitCode(ExitCode.OperationalError)`. Two idioms coexist; that is pre-existing and not this PR's problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | T4           |
| C8  | T9's fix of the pre-existing `import`/`force-unlock` omission in `shell-completion.md:120-121` is inconsistent with the same brief refusing to fix `docs/README.md:5`                                                                                                   | **ACCEPT with an explicit policy:** _fix staleness on a line you are already editing; do not go hunting for stale lines elsewhere._ `shell-completion.md:120-121` IS being edited (to add `harden`) → fix it. `docs/README.md:5` is not otherwise touched → leave it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T9           |
| C9  | T10 deletes a live sprint section AND renumbers `Sprint 2 → Sprint 1`; design asked only to close a row                                                                                                                                                                 | **PARTIALLY ACCEPT — REJECT the renumber.** The fully-closed `### Sprint 1 — rfapps recovery & operator trust` section is deleted (documented behaviour per `ROADMAP.md:271-272`). `### Sprint 2 — Lidarr policy follow-through` keeps its number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T10          |
| C10 | Design's T11 final verification gate was dropped; T3 and T6 deliberately ship red intermediate states                                                                                                                                                                   | **ACCEPT** — new task **T12 — Integration verification** (owns nothing) runs the full gate suite and closes both known-red states.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | new T12      |
| C11 | `P/README.md`'s `**Key Features:**` bullet list is stale (T9 owns the file but the brief never edits it)                                                                                                                                                                | **ACCEPT** — two bullets added to T9's edit list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | T9           |
| C12 | T8 §5.6 tells the doc writer to copy design §4.9's text sample, which contains a `Suppressed by config: …` line that T2's `formatHardenText` deliberately does not emit                                                                                                 | **ACCEPT** — T8 must derive the text sample from the landed `formatHardenText`, and its cross-check list gains a renderer line-inventory item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | T8           |
| C13 | Issue #162 asks for "patch-style recommendations or editable output"; no unified diff is delivered                                                                                                                                                                      | **ACCEPT as a documented scope call** — satisfied by the _editable output_ branch (`--out` override fragment). T12's PR-body checklist must state the mapping explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T12          |
| C14 | T2's `it("declares unique rule ids")` and `it.each(advisory)("%s proposes no patches")` are tautological                                                                                                                                                                | **ACCEPT — drop both.** Keep the patch-key-shape case (guards the `nested-path` contract) and the idempotence case (guards the `--apply`-twice invariant).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T2           |
| C15 | `lib/security-scan.ts` will hit ~600 lines with mandated JSDoc even after the backends split                                                                                                                                                                            | **ACCEPT** — deterministic 4-way split: `security-scan-backends.ts`, `security-scan-settings.ts`, `security-scan-format.ts`, `security-scan.ts`. All re-exported from `security-scan.ts` so T3's barrel block names a single source module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T1           |
| C16 | T2's `hardening.ts` ~430-line estimate under-measures a 10-step renderer                                                                                                                                                                                                | **ACCEPT** — `hardening-format.ts` split is mandatory, not an escape hatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T2           |
| C17 | The `"remove"` patch operation has zero producers, four code paths, zero tests, on the only compose.yml-mutating path                                                                                                                                                   | **ACCEPT — cut it.** `HardenPatchOperation` becomes `"set" \| "merge-unique"`. Re-add in the commit that ships the first rule needing it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T2, T5       |
| C18 | `HardenOptions.listRules` is structurally always `false`                                                                                                                                                                                                                | **ACCEPT — cut the field.** `--list-rules` short-circuits before `HardenOptions` is constructed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | T2, T5       |
| C19 | `scan.concurrency` / `scan.maxTargets` are weak config knobs that could be constants                                                                                                                                                                                    | **REJECT** — `maxTargets` is load-bearing (it produces the `target-cap` skip reason, which is a tested `ImageScan` arm and a documented operator-visible outcome), and `concurrency` bounds a fan-out over up to 44 images on a shared host. Both stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —            |
| C20 | `nested-path` refusal code is dead                                                                                                                                                                                                                                      | **REJECT the cut (critic concurs)** — it is a fail-closed guard on the file-mutating path costing four lines                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —            |
| C21 | T3's barrel over-exports ~8 symbols with no external consumer                                                                                                                                                                                                           | **REJECT** — matches shipped precedent (5 of 9 `security-audit.js` barrel exports have no consumer today), and every barrel entry is what lets `deploy.spec.ts`'s bare automock stub the engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —            |
| C22 | T0's wave-0 cross-package gate exists for a 6-line function with one caller                                                                                                                                                                                             | **REJECT the restructure, ACCEPT the operational note** — `checkExternalTool` stays in rf-common beside `checkDotenvx`/`checkOp`. `npm run build -w packages/rf-common` is promoted to an **explicit orchestrator step between wave 0 and wave 1**, not merely a bullet inside T0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | gates        |
| C23 | T1's `tool: "none"` case forces two file-level `vi.mock`s onto a spec whose other ~25 cases use injected deps                                                                                                                                                           | **ACCEPT** — that single case moves to its own file `P/src/lib/security-scan-deps.spec.ts` (owned by T1); `security-scan.spec.ts` stays mock-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T1           |
| C24 | Wave-ordering hazards: T3-before-T4 (typecheck), T5-before-T6 (signature), T6-before-T7 (completion parity)                                                                                                                                                             | **ACCEPT** — recorded as explicit wave-gate rules; T3 and T6 have documented allowed-red acceptance criteria and cannot be gated on a green package run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | waves, T12   |
| C25 | Ownership bookkeeping: T1/T2 add files beyond design §7; `types/options.ts` added to T3                                                                                                                                                                                 | **ACCEPT** — recorded in the wave disjointness tables below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | waves        |
| C26 | File-ownership conflicts                                                                                                                                                                                                                                                | **NONE FOUND** — re-verified path-by-path across all 13 tasks; see the per-wave tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —            |

---

## Wave and dependency graph

```
wave 0   T0  rf-common checkExternalTool
              │
   [ORCHESTRATOR GATE: npm run build -w packages/rf-common]
              │
wave 1   T1  Scan types + engine (#161)        T2  Harden types + engine (#162)
              └───────────────┬────────────────────┘
wave 2                       T3  Barrels, config, exit codes
                              ├──────────────┬─────────────┐
wave 3   T4  Plan + deploy integration     T5  Harden command + action
              └──────────────┬───────────────┘
wave 4                      T6  cli.ts wiring
                              ├──────────────┐
wave 5   T7  Completion templates + parity   T8  Feature docs
              └──────────────┬───────────────┘
wave 6   T9  Indexes and tables    T10 Roadmap (no deps)    T11 Reference doc surfaces
              └──────────────┬───────────────┴───────────────┘
wave 7                      T12 Integration verification
```

### Wave 0 — T0 (alone)

| Task | Files                                                                    |
| ---- | ------------------------------------------------------------------------ |
| T0   | `packages/rf-common/src/env-tools.ts`, `packages/rf-common/src/index.ts` |

Single task; disjointness trivially holds.

**Orchestrator gate before wave 1:** run `env -u FORCE_COLOR npm run build -w packages/rf-common` and confirm `grep -q checkExternalTool packages/rf-common/dist/env-tools.d.ts`. `@rfmedia/common` resolves through `dist/`; skipping this makes every wave-1+ typecheck fail with a misleading TS2305.

### Wave 1 — T1 ∥ T2

| Task | Files                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `P/src/types/security-scan.ts`, `P/src/lib/security-scan-backends.ts`, `P/src/lib/security-scan-settings.ts`, `P/src/lib/security-scan-format.ts`, `P/src/lib/security-scan.ts`, `P/src/lib/security-scan.spec.ts`, `P/src/lib/security-scan-deps.spec.ts` |
| T2   | `P/src/types/hardening.ts`, `P/src/lib/hardening-rules.ts`, `P/src/lib/hardening-format.ts`, `P/src/lib/hardening.ts`, `P/src/lib/hardening.spec.ts`                                                                                                       |

**Disjoint:** 7 files vs 5 files, zero overlap (`security-*` vs `harden*`). No file repeats.

### Wave 2 — T3 (alone)

| Task | Files                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3   | `P/src/types/index.ts`, `P/src/lib/index.ts`, `P/src/types/config.ts`, `P/src/lib/config.ts`, `P/src/lib/exit-codes.ts`, `P/src/types/results.ts`, `P/src/types/options.ts` |

Single task; disjointness trivially holds. **Allowed-red:** T3 ends with exactly one typecheck error (`deploy.ts:212` missing `scan`), closed by T4.

### Wave 3 — T4 ∥ T5

| Task | Files                                                                                 |
| ---- | ------------------------------------------------------------------------------------- |
| T4   | `P/src/actions/plan.ts`, `P/src/actions/deploy.ts`, `P/src/actions/deploy.spec.ts`    |
| T5   | `P/src/commands/harden.ts`, `P/src/actions/harden.ts`, `P/src/actions/harden.spec.ts` |

**Disjoint:** 3 files vs 3 files, zero overlap. No file repeats.

### Wave 4 — T6 (alone)

| Task | Files          |
| ---- | -------------- |
| T6   | `P/src/cli.ts` |

**Allowed-red:** T6 ends with exactly one failing spec case (`deploy` completion parity), closed by T7.

### Wave 5 — T7 ∥ T8

| Task | Files                                                                                      |
| ---- | ------------------------------------------------------------------------------------------ |
| T7   | `P/src/actions/completion.ts`, `P/src/actions/completion.spec.ts`                          |
| T8   | `docs/features/rfapps-vulnerability-scanning.md`, `docs/features/rfapps-harden-command.md` |

**Disjoint:** TypeScript vs two new markdown files. No file repeats.

### Wave 6 — T9 ∥ T10 ∥ T11

| Task | Files                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T9   | `docs/README.md`, `README.md`, `packages/rfapps-cli/README.md`, `docs/features/shell-completion.md`, `docs/features/quick-reference.md`, `docs/features/rfapps-configuration.md`, `rfapps.config.yaml`, `packages/rfapps-cli/CLAUDE.md` |
| T10  | `ROADMAP.md`, `docs/roadmap-archive.md`                                                                                                                                                                                                 |
| T11  | `docs/features/json-output.md`, `docs/features/output-formats.md`, `docs/features/error-handling.md`, `packages/rf-common/README.md`                                                                                                    |

**Disjoint:** 8 + 2 + 4 = 14 distinct paths, verified pairwise. No file repeats. In particular T9 owns `packages/rfapps-cli/README.md` while T11 owns `packages/rf-common/README.md` — different packages, different files.

### Wave 7 — T12 (alone)

Owns no files. Read-only verification plus a PR-body checklist.

---

## Tasks

---

## T0 — rf-common `checkExternalTool`

**Owns:** `packages/rf-common/src/env-tools.ts`, `packages/rf-common/src/index.ts`
**Depends on:** nothing
**Wave:** 0

### Verified anchors

| Symbol                      | Location                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ToolCheckResult`           | `packages/rf-common/src/env-tools.ts:32-39` — `{ available: boolean; version?: string; error?: string }`         |
| private `commandExists`     | `:57`                                                                                                            |
| private `getCommandVersion` | `:73`                                                                                                            |
| `checkDotenvx`              | `:111` (its JSDoc `:97-110`, its return literal `:123-126`)                                                      |
| `checkOp`                   | `:143`, closing `}` at `:160`                                                                                    |
| `envFileExists`             | JSDoc opens `:162`                                                                                               |
| barrel line                 | `packages/rf-common/src/index.ts:117` — `export { checkDotenvx, checkOp, envFileExists } from "./env-tools.js";` |
| type re-export              | `index.ts:119` — `export type { EnvTool, ToolCheckResult } from "./env-tools.js";`                               |

`packages/rf-common/tsconfig.json` is `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `noPropertyAccessFromIndexSignature`, but does **not** set `exactOptionalPropertyTypes`. The design's literal function body was compiled against the real module with the repo's own tsc: **zero errors**.

### Edit 1.1 — insert `checkExternalTool` between `checkOp` and `envFileExists`

`checkOp` ends at `:160`; `:161` is blank; `:162` opens the `envFileExists` JSDoc. Insert in that gap so the three PATH probes sit together.

````ts
/**
 * Probe an arbitrary external tool on PATH.
 *
 * Generic counterpart to {@link checkDotenvx} and {@link checkOp} for callers that
 * carry their own binary name and install instructions (for example pluggable
 * vulnerability-scanner backends). Performs a `which` lookup followed by a version
 * read; it never throws.
 *
 * @param command - Executable name to look up in PATH
 * @param versionFlag - Flag that prints a version (e.g. `"--version"`, `"version"`)
 * @param installHint - Operator-facing install instruction, returned verbatim as `error`
 * @returns Promise resolving to ToolCheckResult with availability and version info
 *
 * @example
 * ```typescript
 * const result = await checkExternalTool(
 *   "trivy",
 *   "--version",
 *   "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
 * );
 * if (!result.available) {
 *   console.error(result.error); // the install hint, verbatim
 * }
 * ```
 */
export async function checkExternalTool(
  command: string,
  versionFlag: string,
  installHint: string,
): Promise<ToolCheckResult> {
  if (!(await commandExists(command))) {
    return { available: false, error: installHint };
  }

  return { available: true, version: await getCommandVersion(command, versionFlag) };
}
````

Binding constraints:

- **No default parameter values.** The sole consumer always passes all three, and grype's version argument is the bare word `version`, not a `--` flag.
- **`installHint` is returned verbatim as `error`.** No prefix, no wrapping, no interpolation. The downstream engine reads `probe.error ?? backend.installHint`, and a T1 test asserts the hint reaches the operator unchanged.
- **No logging, no throwing, no new imports.** This module is pure; the private helpers already swallow spawn errors.
- Do **not** add `?? undefined` or a conditional spread on `version` — `exactOptionalPropertyTypes` is off, and `checkDotenvx:123-126` uses exactly this shape.

### Edit 1.2 — module header accuracy

`env-tools.ts:8-13` currently reads:

```ts
 * ## Supported Tools
 *
 * - **dotenvx**: Local .env file with encryption support
 * - **op (1Password CLI)**: Secrets from 1Password vaults
 *
 * @module @rfmedia/common/env-tools
```

Add one bullet:

```ts
 * - **any PATH executable**: via `checkExternalTool` (caller supplies binary, version flag, install hint)
```

If `format:check` complains about width, wrap across two `*` lines rather than shortening the meaning.

**Do not touch** `commandExists`, `getCommandVersion`, `checkDotenvx`, `checkOp`, `envFileExists`, or `ToolCheckResult`. Refactoring `checkDotenvx`/`checkOp` to delegate to the new function is explicitly out of scope: their exact error strings and `spawn` call counts are asserted by 16 cases in `packages/rf-common/src/env-tools.test.ts`, which this task does not own.

### Edit 2 — barrel

`packages/rf-common/src/index.ts:117`:

```ts
export { checkDotenvx, checkExternalTool, checkOp, envFileExists } from "./env-tools.js";
```

Alphabetical insertion as the second name. Line `:119` already re-exports `ToolCheckResult`; no change. Do not add a new `// ---` section and do not edit the file's `@module` header at `:1-31`.

### `packages/rf-common/package.json` — NO CHANGE

`"./env-tools"` already exists in the `exports` map and covers the new symbol. Both `import { checkExternalTool } from "@rfmedia/common"` and `from "@rfmedia/common/env-tools"` resolve without a manifest edit.

### `packages/rf-common/README.md` — NOT YOURS

It needs a `### Environment Tools` entry for `checkExternalTool` (rf-common's `CLAUDE.md` step 5). That file is owned by **T11**. Do not edit it; do not flag it — it is already assigned.

### Tests — WRITE NONE

Zero test items are assigned to this task. Do not create `env-tools.spec.ts`, do not add cases to the existing `env-tools.test.ts`, and do not add an export-surface test. The only interesting behaviour (returning `installHint` as `error`) is asserted indirectly by T1's `scanner-unavailable` case.

### Contract downstream depends on (do not drift)

```ts
(command: string, versionFlag: string, installHint: string) => Promise<ToolCheckResult>;
```

Positional, non-optional. The two real call sites will be:

- `checkExternalTool("trivy", "--version", "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/")`
- `checkExternalTool("grype", "version", "grype not found in PATH. Install from https://github.com/anchore/grype#installation")`

Do not convert to an options object, do not add a `timeoutMs`, do not add an `auto`-probe convenience.

### Acceptance

- [ ] `packages/rf-common/src/env-tools.ts` exports `checkExternalTool(command: string, versionFlag: string, installHint: string): Promise<ToolCheckResult>`, defined between `checkOp` and `envFileExists`, with a JSDoc block containing summary, three `@param` tags, `@returns`, and a fenced `typescript` `@example`.
- [ ] The body is exactly the two statements shown above — no default parameter values, no logging, no throw, no wrapping of `installHint`.
- [ ] `packages/rf-common/src/index.ts:117` reads `export { checkDotenvx, checkExternalTool, checkOp, envFileExists } from "./env-tools.js";` and nothing else in that file changed.
- [ ] The `## Supported Tools` list in the `env-tools.ts` module header gained one bullet naming `checkExternalTool`.
- [ ] `git diff packages/rf-common/src/env-tools.ts` shows only the header bullet and one contiguous added function block.
- [ ] No new test file; `packages/rf-common/src/env-tools.test.ts` unmodified; `packages/rf-common/package.json` unmodified; `packages/rf-common/README.md` unmodified.
- [ ] `env -u FORCE_COLOR npm run typecheck -w packages/rf-common` exits 0.
- [ ] `env -u FORCE_COLOR npm run build -w packages/rf-common` exits 0 and `grep -n checkExternalTool packages/rf-common/dist/env-tools.d.ts packages/rf-common/dist/index.d.ts` matches in both.
- [ ] `env -u FORCE_COLOR npm run test:run -w packages/rf-common` exits 0.
- [ ] `env -u FORCE_COLOR npm run format:check` exits 0.

### Pitfalls

- **The build is not optional and it is not yours alone.** `@rfmedia/common`'s `exports` map resolves to `./dist/*`. Report completion only after `npm run build -w packages/rf-common` succeeds and `dist/env-tools.d.ts` contains the symbol; the orchestrator re-runs it as a wave gate.
- `FORCE_COLOR` is set in agent shells and breaks two rf-common logger tests plus the pre-push hook. Prefix every gate with `env -u FORCE_COLOR`. Run under `umask 022`.
- Do **not** refactor `checkDotenvx`/`checkOp` to delegate. DRY does not license perturbing a green suite you do not own tests for.
- `exactOptionalPropertyTypes` is off — `version: await getCommandVersion(...)` into `version?: string` compiles. Do not add defensive `?? undefined`.
- grype's version argument is the bare word `version`. Do not default `versionFlag` and do not validate that it starts with `--`.
- Prefixing `installHint` (e.g. `Scanner unavailable: ${hint}`) silently breaks a T1 assertion you cannot see.
- A fresh worktree needs `npm ci` once, serially, before any gate passes.

---

## T1 — Scan types + engine (#161)

**Owns (all NEW):**
`P/src/types/security-scan.ts`, `P/src/lib/security-scan-backends.ts`, `P/src/lib/security-scan-settings.ts`, `P/src/lib/security-scan-format.ts`, `P/src/lib/security-scan.ts`, `P/src/lib/security-scan.spec.ts`, `P/src/lib/security-scan-deps.spec.ts`
**Depends on:** T0 (and the orchestrator's `npm run build -w packages/rf-common`)
**Wave:** 1

No existing repo file is modified by this task.

### 0. Mandatory five-file split (supersedes any single-module instruction)

The engine measures ~750 lines without JSDoc, far past the repo's ~500-line soft cap. Split it deterministically. All four `lib/` modules are yours; `security-scan.ts` re-exports the other three so **T3's barrel block names exactly one source module** (`from "./security-scan.js"`), matching the shipped `security-audit.js` block at `P/src/lib/index.ts:207-216`.

| File                            | Responsibility                                                                            | Est. lines |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ---------- |
| `types/security-scan.ts`        | contracts only                                                                            | ~170       |
| `lib/security-scan-backends.ts` | untrusted-report normalization + scanner registry                                         | ~210       |
| `lib/security-scan-settings.ts` | severity rank/order constants, CLI??config??default resolution, suppression normalization | ~150       |
| `lib/security-scan-format.ts`   | `ScanReport → string[]` renderer                                                          | ~110       |
| `lib/security-scan.ts`          | dependencies, target classification, summary, gate, worker pool, runner, re-exports       | ~340       |

Dependency direction is strictly one-way: `security-scan.ts → {settings, backends, format}`; `format → settings` (for `SEVERITY_ORDER`); `backends → nothing local except`docker.js`/`errors.js`. Never import`security-scan.ts` from any of the three.

### 1. Verified anchors in files you do NOT own

| Symbol                 | Location                                                                      | Signature                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolCheckResult`      | `packages/rf-common/src/env-tools.ts:32-39`                                   | `{ available: boolean; version?: string; error?: string }`                                                                            |
| `checkExternalTool`    | created by T0, exported from `packages/rf-common/src/index.ts:117`            | `(command, versionFlag, installHint) => Promise<ToolCheckResult>`                                                                     |
| `execWithEnv`          | `P/src/lib/env-tools.ts:303-312`                                              | `(command: string, args: string[], options: EnvToolOptions) => Promise<{code:number; stdout:string; stderr:string; success:boolean}>` |
| `EnvToolOptions`       | `P/src/lib/env-tools.ts:29-46`                                                | carries `tool`, `cwd?`, `timeout?`, `maxStdoutBytes?`, `maxStderrBytes?`                                                              |
| timeout sentinel       | `P/src/lib/env-tools.ts:367`                                                  | literal `"Command timed out"`                                                                                                         |
| overflow sentinel      | `P/src/lib/env-tools.ts:365`                                                  | literal `"Command output exceeded capture limit"`                                                                                     |
| `filterToolOutput`     | `P/src/lib/docker.ts:219`                                                     | `(lines: string[]) => string[]`                                                                                                       |
| `InvalidArgumentError` | `P/src/lib/errors.ts:382-407`                                                 | `(argument, value, reason, validValues?)`                                                                                             |
| style model            | `P/src/lib/security-audit.ts` (417 lines), `P/src/types/audit.ts` (107 lines) | file docblock, module-private rank map, `parse*FailOn` throwing, pure `format*Text(): string[]`                                       |
| DI-factory model       | `P/src/lib/backup-docker.spec.ts:66-100`                                      | `createDependencies(overrides: Partial<X> = {}): X`                                                                                   |
| partial-mock model     | `P/src/lib/config.test.ts:26-32`                                              | `vi.mock(mod, async (importOriginal) => ({ ...(await importOriginal<…>()), ...overrides }))`                                          |

**T0 gate:** if `checkExternalTool` is missing from `packages/rf-common/dist/env-tools.d.ts`, stop — the build was not re-run.

### 2. `P/src/types/security-scan.ts` (NEW)

File docblock (matching `types/audit.ts:1-6` density), then the contracts. **Do not import `node:crypto`.** The only import is the type below.

```ts
/**
 * Image vulnerability scan contracts for rfapps CLI.
 *
 * Import-free except for `ToolCheckResult`, so `types/config.ts` can import
 * `ScanConfig` from here without a runtime cycle.
 */

import type { ToolCheckResult } from "@rfmedia/common";

export const SCAN_SCHEMA_VERSION = "security-scan.v1" as const;

export type ScannerId = "trivy" | "grype";
export type ScanSeverity = "critical" | "high" | "medium" | "low" | "negligible" | "unknown";
export type ScanFailOn = ScanSeverity | "none";

export interface ScanTarget {
  readonly service: string;
  readonly image: string;
}

export interface ScanVulnerability {
  readonly id: string;
  readonly severity: ScanSeverity;
  readonly rawSeverity: string;
  readonly packageName: string;
  readonly installedVersion: string;
  readonly fixedVersion?: string;
  readonly reference?: string;
}

export interface ScanSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly negligible: number;
  readonly unknown: number;
}

export type ScanSkipReason = "build-only" | "no-image" | "duplicate-image" | "target-cap";

export type ScanFailureCode = "scanner-unavailable" | "timeout" | "output-limit" | "scanner-error" | "invalid-report";

export type ImageScan =
  | {
      readonly status: "scanned";
      readonly service: string;
      readonly image: string;
      readonly counts: ScanSeverityCounts;
      readonly vulnerabilities: readonly ScanVulnerability[];
      readonly suppressed: number;
      readonly truncated: boolean;
      readonly durationMs: number;
    }
  | {
      readonly status: "skipped";
      readonly service: string;
      readonly image: string;
      readonly reason: ScanSkipReason;
      readonly scannedBy?: string;
    }
  | {
      readonly status: "failed";
      readonly service: string;
      readonly image: string;
      readonly reason: ScanFailureCode;
      readonly detail: string;
    };

export type ScanGateStatus = "passed" | "blocked" | "inconclusive";

export interface ScanGate {
  readonly failOn: ScanFailOn;
  readonly status: ScanGateStatus;
  readonly blocking: boolean;
  readonly blockedBy: readonly string[];
}

export interface ScanSummary extends ScanSeverityCounts {
  readonly total: number;
  readonly suppressed: number;
  readonly targetsScanned: number;
  readonly targetsSkipped: number;
  readonly targetsFailed: number;
}

export interface ScanScope {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
}

export interface ScannerIdentity {
  readonly id: ScannerId;
  readonly binary: string;
  readonly version?: string;
  readonly available: boolean;
}

export interface ScanReport {
  readonly schemaVersion: typeof SCAN_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly scanner: ScannerIdentity;
  readonly scope: ScanScope;
  readonly gate: ScanGate;
  readonly summary: ScanSummary;
  readonly images: readonly ImageScan[];
  readonly notes: readonly string[];
}

export interface ScanSuppression {
  readonly id: string;
  readonly service?: string;
  readonly reason: string;
  readonly until?: string;
}

export interface ScanConfig {
  readonly scanner?: ScannerId;
  readonly failOn?: ScanFailOn;
  readonly ignore?: readonly ScanSuppression[];
  readonly timeoutMs?: number;
  readonly maxTargets?: number;
  readonly concurrency?: number;
}

export interface ResolvedScanSettings {
  readonly scanner: ScannerId;
  readonly failOn: ScanFailOn;
  readonly ignore: readonly ScanSuppression[];
  readonly timeoutMs: number;
  readonly maxTargets: number;
  readonly concurrency: number;
  readonly cwd: string;
}

export interface ScanComposeService {
  readonly image?: string;
  readonly build?: unknown;
}

export interface ScanComposeConfig {
  readonly services: Readonly<Record<string, ScanComposeService>>;
}

export type ScannerParseResult =
  | { readonly ok: true; readonly vulnerabilities: readonly ScanVulnerability[] }
  | { readonly ok: false; readonly detail: string };

export interface ScannerBackend {
  readonly id: ScannerId;
  readonly binary: string;
  readonly versionFlag: string;
  readonly installHint: string;
  buildArgs(target: ScanTarget, settings: ResolvedScanSettings): readonly string[];
  parseReport(stdout: string): ScannerParseResult;
}

export interface SecurityScanDependencies {
  readonly probeScanner: (backend: ScannerBackend) => Promise<ToolCheckResult>;
  readonly runScanner: (
    backend: ScannerBackend,
    args: readonly string[],
    settings: ResolvedScanSettings,
  ) => Promise<{ code: number; stdout: string; stderr: string; success: boolean }>;
  readonly now: () => Date;
  readonly elapsedMs: () => number;
}
```

Keep a short JSDoc on each exported type. Do **not** add a `ScanOptions extends GlobalOptions` interface — scan flags ride on `RawPlanOptions`/`RawDeployOptions` in T4's files.

**ScanConfig must never gain an `enabled`/`always` key.** The entire no-MCP-schema-change argument depends on `scan` being reachable only via a CLI flag the MCP adapters do not forward.

### 3. `P/src/lib/security-scan-settings.ts` (NEW)

```ts
/**
 * Scan severity ordering and CLI ?? config ?? default settings resolution.
 */

import { InvalidArgumentError } from "./errors.js";
import { resolveScannerBackend, SCANNER_IDS } from "./security-scan-backends.js";
import type {
  ResolvedScanSettings,
  ScanConfig,
  ScanFailOn,
  ScanSeverity,
  ScannerId,
  ScanSuppression,
} from "../types/security-scan.js";

/** Ascending severity rank. The gate blocks at or above the threshold's rank. */
export const SCAN_SEVERITY_RANK: Readonly<Record<ScanSeverity, number>> = {
  unknown: 0,
  negligible: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/** Highest severity first. Drives counting and the renderer's section order. */
export const SEVERITY_ORDER: readonly ScanSeverity[] = ["critical", "high", "medium", "low", "negligible", "unknown"];

const VALID_FAIL_ON: readonly ScanFailOn[] = ["none", "unknown", "negligible", "low", "medium", "high", "critical"];

const DEFAULT_SCANNER: ScannerId = "trivy";
const DEFAULT_FAIL_ON: ScanFailOn = "none";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TARGETS = 64;
const DEFAULT_CONCURRENCY = 2;

/** Returns undefined when the flag was absent, so config can win. @throws {InvalidArgumentError} */
export function parseScanFailOn(value: string | undefined): ScanFailOn | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase().trim();
  if (VALID_FAIL_ON.includes(normalized as ScanFailOn)) return normalized as ScanFailOn;
  throw new InvalidArgumentError("--scan-fail-on", value, "Invalid scan severity threshold", [...VALID_FAIL_ON]);
}

function positiveInteger(value: number | undefined, fallback: number, key: string, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new InvalidArgumentError(key, String(value), `expected an integer between 1 and ${maximum}`);
  }
  return value;
}

/** @throws {InvalidArgumentError} on a blank id or reason, or an unparsable `until`. */
export function normalizeScanSuppressions(entries: readonly ScanSuppression[]): readonly ScanSuppression[] {
  return entries.map((entry, index) => {
    const id = entry.id.trim();
    if (id === "") {
      throw new InvalidArgumentError(`scan.ignore[${index}].id`, entry.id, "id must not be blank");
    }
    const reason = entry.reason?.trim() ?? "";
    if (reason === "") {
      throw new InvalidArgumentError(
        `scan.ignore[${index}].reason`,
        String(entry.reason ?? ""),
        "a suppression must document why the finding is accepted",
      );
    }
    if (entry.until !== undefined && Number.isNaN(Date.parse(entry.until))) {
      throw new InvalidArgumentError(`scan.ignore[${index}].until`, entry.until, "expected an ISO-8601 date");
    }
    const service = entry.service?.trim();
    return {
      id,
      reason,
      ...(service === undefined || service === "" ? {} : { service }),
      ...(entry.until === undefined ? {} : { until: entry.until }),
    };
  });
}

/** CLI ?? config ?? hard default. @throws {InvalidArgumentError} */
export function resolveScanSettings(
  raw: { readonly scanFailOn?: string; readonly scanner?: string },
  configured: ScanConfig | undefined,
  cwd: string,
): ResolvedScanSettings {
  let scanner: ScannerId = DEFAULT_SCANNER;
  if (raw.scanner !== undefined) {
    scanner = resolveScannerBackend(raw.scanner).id;
  } else if (configured?.scanner !== undefined) {
    // rfapps.config.yaml is not schema-validated, so the declared ScannerId can
    // be any string at runtime; refuse it rather than crash in the runner.
    if (!SCANNER_IDS.includes(configured.scanner)) {
      throw new InvalidArgumentError("scan.scanner", String(configured.scanner), "Unknown scanner backend", [
        ...SCANNER_IDS,
      ]);
    }
    scanner = configured.scanner;
  }
  const failOn = parseScanFailOn(raw.scanFailOn) ?? configured?.failOn ?? DEFAULT_FAIL_ON;
  return {
    scanner,
    failOn,
    ignore: normalizeScanSuppressions(configured?.ignore ?? []),
    timeoutMs: positiveInteger(configured?.timeoutMs, DEFAULT_TIMEOUT_MS, "scan.timeoutMs", 3_600_000),
    maxTargets: positiveInteger(configured?.maxTargets, DEFAULT_MAX_TARGETS, "scan.maxTargets", 1000),
    concurrency: positiveInteger(configured?.concurrency, DEFAULT_CONCURRENCY, "scan.concurrency", 16),
    cwd,
  };
}
```

`raw` is a structural subset — T4 passes the whole `RawPlanOptions`/`RawDeployOptions` object. Excess-property checking does not apply to non-literal arguments, so no cast is needed on either side.

### 4. `P/src/lib/security-scan-backends.ts` (NEW)

```ts
/**
 * Scanner backend registry and untrusted-report normalization.
 *
 * Every field is narrowed from `unknown` with `typeof` guards; neither parser
 * ever throws and neither is handed the scanner's own gate flag
 * (`trivy --exit-code` / `grype --fail-on`) — rfapps owns the threshold, so a
 * non-zero exit unambiguously means *error*, never *findings*.
 */

import { filterToolOutput } from "./docker.js";
import { InvalidArgumentError } from "./errors.js";
import type {
  ScannerBackend,
  ScannerId,
  ScannerParseResult,
  ScanSeverity,
  ScanVulnerability,
} from "../types/security-scan.js";

export const SCANNER_IDS: readonly ScannerId[] = ["trivy", "grype"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

const TRIVY_SEVERITIES: Readonly<Record<string, ScanSeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  UNKNOWN: "unknown",
};

const GRYPE_SEVERITIES: Readonly<Record<string, ScanSeverity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NEGLIGIBLE: "negligible",
  UNKNOWN: "unknown",
};

function mapSeverity(map: Readonly<Record<string, ScanSeverity>>, raw: string): ScanSeverity {
  return map[raw.trim().toUpperCase()] ?? "unknown";
}

function buildVulnerability(fields: {
  id: string;
  severity: ScanSeverity;
  rawSeverity: string;
  packageName: string;
  installedVersion: string;
  fixedVersion?: string;
  reference?: string;
}): ScanVulnerability {
  return {
    id: fields.id,
    severity: fields.severity,
    rawSeverity: fields.rawSeverity,
    packageName: fields.packageName,
    installedVersion: fields.installedVersion,
    ...(fields.fixedVersion === undefined ? {} : { fixedVersion: fields.fixedVersion }),
    ...(fields.reference === undefined ? {} : { reference: fields.reference }),
  };
}

function parseScannerJson(
  stdout: string,
  scanner: ScannerId,
): { ok: true; value: unknown } | { ok: false; detail: string } {
  const cleaned = filterToolOutput(stdout.split("\n")).join("\n").trim();
  if (cleaned === "") {
    return { ok: false, detail: `${scanner} produced no report output` };
  }
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `${scanner} report was not valid JSON: ${reason}` };
  }
}

function parseTrivyReport(stdout: string): ScannerParseResult {
  const parsed = parseScannerJson(stdout, "trivy");
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  if (!isRecord(parsed.value)) {
    return { ok: false, detail: "unexpected trivy report shape: top level is not an object" };
  }
  const results = parsed.value["Results"];
  if (results === undefined || results === null) return { ok: true, vulnerabilities: [] };
  if (!Array.isArray(results)) {
    return { ok: false, detail: "unexpected trivy report shape: Results is not an array" };
  }

  const vulnerabilities: ScanVulnerability[] = [];
  for (const result of results) {
    if (!isRecord(result)) continue;
    const entries = result["Vulnerabilities"];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = readString(entry, "VulnerabilityID");
      const packageName = readString(entry, "PkgName");
      const installedVersion = readString(entry, "InstalledVersion");
      if (id === undefined || packageName === undefined || installedVersion === undefined) continue;
      const rawSeverity = readString(entry, "Severity") ?? "";
      vulnerabilities.push(
        buildVulnerability({
          id,
          severity: mapSeverity(TRIVY_SEVERITIES, rawSeverity),
          rawSeverity,
          packageName,
          installedVersion,
          fixedVersion: readString(entry, "FixedVersion"),
          reference: readString(entry, "PrimaryURL"),
        }),
      );
    }
  }
  return { ok: true, vulnerabilities };
}

function parseGrypeReport(stdout: string): ScannerParseResult {
  const parsed = parseScannerJson(stdout, "grype");
  if (!parsed.ok) return { ok: false, detail: parsed.detail };
  if (!isRecord(parsed.value)) {
    return { ok: false, detail: "unexpected grype report shape: top level is not an object" };
  }
  const matches = parsed.value["matches"];
  if (matches === undefined || matches === null) return { ok: true, vulnerabilities: [] };
  if (!Array.isArray(matches)) {
    return { ok: false, detail: "unexpected grype report shape: matches is not an array" };
  }

  const vulnerabilities: ScanVulnerability[] = [];
  for (const match of matches) {
    if (!isRecord(match)) continue;
    const vulnerability = match["vulnerability"];
    const artifact = match["artifact"];
    if (!isRecord(vulnerability) || !isRecord(artifact)) continue;
    const id = readString(vulnerability, "id");
    const packageName = readString(artifact, "name");
    const installedVersion = readString(artifact, "version");
    if (id === undefined || packageName === undefined || installedVersion === undefined) continue;
    const rawSeverity = readString(vulnerability, "severity") ?? "";
    const fix = vulnerability["fix"];
    let fixedVersion: string | undefined;
    if (isRecord(fix) && Array.isArray(fix["versions"])) {
      const first = fix["versions"][0];
      fixedVersion = typeof first === "string" && first.trim() !== "" ? first : undefined;
    }
    vulnerabilities.push(
      buildVulnerability({
        id,
        severity: mapSeverity(GRYPE_SEVERITIES, rawSeverity),
        rawSeverity,
        packageName,
        installedVersion,
        fixedVersion,
        reference: readString(vulnerability, "dataSource"),
      }),
    );
  }
  return { ok: true, vulnerabilities };
}

const trivyBackend: ScannerBackend = {
  id: "trivy",
  binary: "trivy",
  versionFlag: "--version",
  installHint: "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
  buildArgs: (target, settings) => [
    "image",
    "--quiet",
    "--no-progress",
    "--scanners",
    "vuln",
    "--format",
    "json",
    "--timeout",
    `${Math.max(1, Math.ceil(settings.timeoutMs / 1000))}s`,
    target.image,
  ],
  parseReport: parseTrivyReport,
};

const grypeBackend: ScannerBackend = {
  id: "grype",
  binary: "grype",
  versionFlag: "version",
  installHint: "grype not found in PATH. Install from https://github.com/anchore/grype#installation",
  buildArgs: (target) => [target.image, "-o", "json", "-q"],
  parseReport: parseGrypeReport,
};

export const SCANNER_BACKENDS = {
  trivy: trivyBackend,
  grype: grypeBackend,
} as const satisfies Record<ScannerId, ScannerBackend>;

/** @throws {InvalidArgumentError} on an unknown id. */
export function resolveScannerBackend(id: string): ScannerBackend {
  const normalized = id.toLowerCase().trim();
  const backend = SCANNER_IDS.includes(normalized as ScannerId) ? SCANNER_BACKENDS[normalized as ScannerId] : undefined;
  if (backend === undefined) {
    throw new InvalidArgumentError("--scanner", id, "Unknown scanner backend", [...SCANNER_IDS]);
  }
  return backend;
}
```

Notes: severity maps are keyed uppercase and looked up via `.toUpperCase()`; trivy deliberately has no `NEGLIGIBLE` key (an unrecognised string maps to `"unknown"`); `readString` treats `""` and whitespace as absent, which is what makes trivy's very common `FixedVersion: ""` render as `(no fix available)`. `noPropertyAccessFromIndexSignature` is on — always `value["Results"]`, never `value.Results`.

### 5. `P/src/lib/security-scan-format.ts` (NEW)

```ts
/**
 * Pure `ScanReport -> string[]` renderer. The host action prints these to stderr.
 */

import { SEVERITY_ORDER } from "./security-scan-settings.js";
import type { ImageScan, ScanReport } from "../types/security-scan.js";

function skipDetail(image: ImageScan): string {
  if (image.status !== "skipped") return "";
  return image.reason === "duplicate-image"
    ? `${image.service}: duplicate-image of ${image.scannedBy ?? "?"}`
    : `${image.service}: ${image.reason}`;
}

/** Render a scan report for terminal output (stderr). */
export function formatScanText(report: ScanReport): string[] {
  const { scanner, scope, summary, gate } = report;
  const skipped = report.images.filter((image) => image.status === "skipped");
  const failed = report.images.filter((image) => image.status === "failed");

  const lines: string[] = [
    "Image Vulnerability Scan",
    `Scanner: ${scanner.binary}${
      scanner.available ? (scanner.version === undefined ? "" : ` ${scanner.version}`) : " (unavailable)"
    }`,
    `Scope: ${scope.services.length > 0 ? scope.services.join(", ") : "all services"} (${scope.composePath})`,
    `Targets: ${summary.targetsScanned} scanned, ${summary.targetsSkipped} skipped${
      skipped.length > 0 ? ` (${skipped.map(skipDetail).join("; ")})` : ""
    }, ${summary.targetsFailed} failed`,
    `Findings: ${summary.total} total - ${summary.critical} critical, ${summary.high} high, ` +
      `${summary.medium} medium, ${summary.low} low, ${summary.negligible} negligible, ` +
      `${summary.unknown} unknown (${summary.suppressed} suppressed)`,
    `Gate: --scan-fail-on ${gate.failOn} -> ${gate.status.toUpperCase()}`,
  ];

  for (const severity of SEVERITY_ORDER) {
    const withSeverity = report.images.filter((image) => image.status === "scanned" && image.counts[severity] > 0);
    if (withSeverity.length === 0) continue;
    lines.push("", severity.toUpperCase());
    for (const image of withSeverity) {
      if (image.status !== "scanned") continue;
      lines.push(`  ${image.service}  ${image.image}`);
      for (const vulnerability of image.vulnerabilities) {
        if (vulnerability.severity !== severity) continue;
        lines.push(
          `    - ${vulnerability.id}  ${vulnerability.packageName} ${vulnerability.installedVersion}` +
            (vulnerability.fixedVersion === undefined
              ? " (no fix available)"
              : ` -> fixed in ${vulnerability.fixedVersion}`),
        );
        if (vulnerability.reference !== undefined) lines.push(`      ${vulnerability.reference}`);
      }
    }
  }

  if (failed.length > 0) {
    lines.push("", "FAILED");
    for (const image of failed) {
      if (image.status !== "failed") continue;
      lines.push(`  ${image.service}  ${image.reason}: ${image.detail}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  if (gate.status === "blocked") {
    lines.push("", "Gate blocked by:");
    for (const entry of gate.blockedBy) lines.push(`  - ${entry}`);
    lines.push("Re-run with --scan-fail-on none to report only, or accept a finding via scan.ignore.");
  } else if (gate.status === "inconclusive") {
    lines.push(
      "",
      "A scan that cannot run does not pass. Install a scanner, or pass --scan-fail-on none",
      "to keep scanning advisory.",
    );
  }

  return lines;
}
```

The `Scanner:` identity line is emitted first so a cold trivy database does not look like a hang. This module does no logging.

### 6. `P/src/lib/security-scan.ts` (NEW)

Header, constants, dependencies, classification, summary, gate, worker pool, runner, re-exports.

```ts
/**
 * Image vulnerability scan engine.
 *
 * Pure core plus a single injected exec boundary (`SecurityScanDependencies`).
 * `runSecurityScan` never throws and never touches `process.exitCode`: every
 * failure becomes an `ImageScan` arm so the gate can reason about it.
 */

import { checkExternalTool } from "@rfmedia/common";

import { execWithEnv } from "./env-tools.js";
import { SCANNER_BACKENDS } from "./security-scan-backends.js";
import { SCAN_SEVERITY_RANK, SEVERITY_ORDER } from "./security-scan-settings.js";
import { SCAN_SCHEMA_VERSION } from "../types/security-scan.js";
import type {
  ImageScan,
  ResolvedScanSettings,
  ScanComposeConfig,
  ScanFailOn,
  ScanFailureCode,
  ScanGate,
  ScannerBackend,
  ScannerIdentity,
  ScanReport,
  ScanScope,
  ScanSeverityCounts,
  ScanSummary,
  ScanSuppression,
  ScanTarget,
  ScanVulnerability,
  SecurityScanDependencies,
} from "../types/security-scan.js";

export { resolveScannerBackend, SCANNER_BACKENDS, SCANNER_IDS } from "./security-scan-backends.js";
export {
  normalizeScanSuppressions,
  parseScanFailOn,
  resolveScanSettings,
  SCAN_SEVERITY_RANK,
} from "./security-scan-settings.js";
export { formatScanText } from "./security-scan-format.js";

/** Scanner reports are unbounded external input; cap capture and retention. */
const MAX_SCAN_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_STDERR_BYTES = 256 * 1024;
const MAX_RETAINED_PER_TARGET = 200;
const MAX_DETAIL_CHARS = 400;

// Matched exactly. These are the literals execWithEnv produces at
// lib/env-tools.ts:365-370 and nothing else distinguishes truncation or a
// timeout from a scanner crash. Known limitation: execWithEnv SIGTERMs only the
// direct child and never escalates to SIGKILL; scanners are single-process and
// short-lived, so that is acceptable here.
const TIMEOUT_SENTINEL = "Command timed out";
const OUTPUT_LIMIT_SENTINEL = "Command output exceeded capture limit";

function truncateDetail(detail: string): string {
  const collapsed = detail.trim();
  return collapsed.length > MAX_DETAIL_CHARS ? collapsed.slice(0, MAX_DETAIL_CHARS) : collapsed;
}

function lastNonBlankLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "" : (lines[lines.length - 1] ?? "");
}

const DEFAULT_DEPENDENCIES: SecurityScanDependencies = {
  probeScanner: (backend) => checkExternalTool(backend.binary, backend.versionFlag, backend.installHint),
  runScanner: (backend, args, settings) =>
    execWithEnv(backend.binary, [...args], {
      // A vulnerability scanner is never handed decrypted application secrets,
      // and `none` removes the dotenvx/op banner JSON-corruption hazard.
      tool: "none",
      cwd: settings.cwd,
      timeout: settings.timeoutMs,
      maxStdoutBytes: MAX_SCAN_STDOUT_BYTES,
      maxStderrBytes: MAX_SCAN_STDERR_BYTES,
    }),
  now: () => new Date(),
  elapsedMs: () => performance.now(),
};
```

`performance` is a `@types/node` global under `"lib": ["ES2023"]` — no import needed (precedent: `P/src/testing/cli-harness.ts:211`). `[...args]` is required: `execWithEnv` takes `string[]`, `buildArgs` returns `readonly string[]`. There is **no** `PROBE_TIMEOUT_MS` — `checkExternalTool` takes no timeout.

Target classification (skip order is load-bearing):

```ts
/** Resolved compose config -> targets, with build-only / no-image / cap / dedupe classification. */
export function resolveScanTargets(
  config: ScanComposeConfig,
  services: readonly string[],
  maxTargets: number,
): { readonly targets: readonly ScanTarget[]; readonly skipped: readonly ImageScan[] } {
  const names = (services.length > 0 ? [...services] : Object.keys(config.services)).sort();
  const targets: ScanTarget[] = [];
  const skipped: ImageScan[] = [];
  const claimedBy = new Map<string, string>();

  for (const name of names) {
    const service = config.services[name];
    if (service === undefined) continue;
    // 1. `build:` — compose.yml gives lidarr one; an unbuilt local image makes
    //    the scanner error, which the gate would turn into `inconclusive`.
    if (service.build !== undefined) {
      skipped.push({ status: "skipped", service: name, image: "", reason: "build-only" });
      continue;
    }
    const image = service.image?.trim() ?? "";
    if (image === "") {
      skipped.push({ status: "skipped", service: name, image: "", reason: "no-image" });
      continue;
    }
    const owner = claimedBy.get(image);
    if (owner !== undefined) {
      skipped.push({ status: "skipped", service: name, image, reason: "duplicate-image", scannedBy: owner });
      continue;
    }
    if (targets.length >= maxTargets) {
      skipped.push({ status: "skipped", service: name, image, reason: "target-cap" });
      continue;
    }
    claimedBy.set(image, name);
    targets.push({ service: name, image });
  }

  return { targets, skipped };
}
```

Summary and gate:

```ts
export function buildScanSummary(images: readonly ImageScan[]): ScanSummary {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  let suppressed = 0;
  let targetsScanned = 0;
  let targetsSkipped = 0;
  let targetsFailed = 0;

  for (const image of images) {
    if (image.status === "scanned") {
      targetsScanned += 1;
      suppressed += image.suppressed;
      for (const severity of SEVERITY_ORDER) counts[severity] += image.counts[severity];
    } else if (image.status === "skipped") {
      targetsSkipped += 1;
    } else {
      targetsFailed += 1;
    }
  }

  return {
    ...counts,
    total: SEVERITY_ORDER.reduce((sum, severity) => sum + counts[severity], 0),
    suppressed,
    targetsScanned,
    targetsSkipped,
    targetsFailed,
  };
}

/** The single authoritative blocking decision. No caller re-derives it. */
export function evaluateScanGate(images: readonly ImageScan[], failOn: ScanFailOn): ScanGate {
  if (failOn === "none") {
    return { failOn, status: "passed", blocking: false, blockedBy: [] };
  }
  const threshold = SCAN_SEVERITY_RANK[failOn];
  const blockedBy: string[] = [];
  let breached = false;
  let degraded = false;

  for (const scan of images) {
    if (scan.status === "failed") {
      degraded = true;
      blockedBy.push(`${scan.service}: scan did not complete (${scan.reason})`);
      continue;
    }
    if (scan.status !== "scanned") continue;
    for (const vuln of scan.vulnerabilities) {
      if (SCAN_SEVERITY_RANK[vuln.severity] >= threshold) {
        breached = true;
        blockedBy.push(
          `${scan.service}: ${vuln.id} (${vuln.severity}) in ${vuln.packageName}@${vuln.installedVersion}`,
        );
      }
    }
  }

  if (breached) return { failOn, status: "blocked", blocking: true, blockedBy };
  if (degraded) return { failOn, status: "inconclusive", blocking: true, blockedBy };
  return { failOn, status: "passed", blocking: false, blockedBy: [] };
}
```

Suppression, ordering, worker pool, per-target scan:

```ts
function isExpired(entry: ScanSuppression, now: Date): boolean {
  if (entry.until === undefined) return false;
  const until = Date.parse(entry.until);
  return !Number.isNaN(until) && until < now.getTime();
}

function suppresses(entry: ScanSuppression, service: string, id: string): boolean {
  if (entry.service !== undefined && entry.service !== service) return false;
  return entry.id === "*" || entry.id === id;
}

/** Total order: severity desc, then packageName asc, then id asc. */
function compareVulnerabilities(left: ScanVulnerability, right: ScanVulnerability): number {
  const bySeverity = SCAN_SEVERITY_RANK[right.severity] - SCAN_SEVERITY_RANK[left.severity];
  if (bySeverity !== 0) return bySeverity;
  if (left.packageName !== right.packageName) return left.packageName < right.packageName ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function countBySeverity(vulnerabilities: readonly ScanVulnerability[]): ScanSeverityCounts {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 };
  for (const vulnerability of vulnerabilities) counts[vulnerability.severity] += 1;
  return counts;
}

/** Private bounded worker pool. `forEachBounded` in plan-generator.ts is deliberately not extracted. */
async function mapBounded<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function failedScan(target: ScanTarget, reason: ScanFailureCode, detail: string): ImageScan {
  return { status: "failed", service: target.service, image: target.image, reason, detail: truncateDetail(detail) };
}

async function scanOneTarget(
  target: ScanTarget,
  backend: ScannerBackend,
  settings: ResolvedScanSettings,
  active: readonly ScanSuppression[],
  dependencies: SecurityScanDependencies,
): Promise<ImageScan> {
  const startedAt = dependencies.elapsedMs();
  const result = await dependencies.runScanner(backend, backend.buildArgs(target, settings), settings);
  const durationMs = Math.max(0, Math.round(dependencies.elapsedMs() - startedAt));

  // Classification order is load-bearing; the two sentinels are matched exactly.
  if (result.stderr === TIMEOUT_SENTINEL) {
    return failedScan(target, "timeout", `scanner exceeded ${settings.timeoutMs}ms for this image`);
  }
  if (result.stderr === OUTPUT_LIMIT_SENTINEL) {
    return failedScan(target, "output-limit", OUTPUT_LIMIT_SENTINEL);
  }
  if (!result.success) {
    const detail = lastNonBlankLine(result.stderr);
    return failedScan(
      target,
      "scanner-error",
      detail === "" ? `${backend.binary} exited with code ${result.code}` : detail,
    );
  }

  const parsed = backend.parseReport(result.stdout);
  if (!parsed.ok) return failedScan(target, "invalid-report", parsed.detail);

  let suppressed = 0;
  const surviving: ScanVulnerability[] = [];
  for (const vulnerability of parsed.vulnerabilities) {
    if (active.some((entry) => suppresses(entry, target.service, vulnerability.id))) {
      suppressed += 1;
      continue;
    }
    surviving.push(vulnerability);
  }
  surviving.sort(compareVulnerabilities);

  return {
    status: "scanned",
    service: target.service,
    image: target.image,
    // counts covers EVERY surviving finding; only the retained list is capped,
    // so a truncated target can never hide an above-threshold entry.
    counts: countBySeverity(surviving),
    vulnerabilities: surviving.slice(0, MAX_RETAINED_PER_TARGET),
    suppressed,
    truncated: surviving.length > MAX_RETAINED_PER_TARGET,
    durationMs,
  };
}

function compareByService(left: ImageScan, right: ImageScan): number {
  if (left.service === right.service) return 0;
  return left.service < right.service ? -1 : 1;
}
```

Use plain `<`, **not** `localeCompare` — `images` ordering feeds `gate.blockedBy` and the `--json` payload, which must be byte-deterministic across locales.

The runner:

```ts
/** Never throws. Every failure becomes an ImageScan arm. */
export async function runSecurityScan(
  targets: readonly ScanTarget[],
  preskipped: readonly ImageScan[],
  scope: ScanScope,
  settings: ResolvedScanSettings,
  dependencies: SecurityScanDependencies = DEFAULT_DEPENDENCIES,
): Promise<ScanReport> {
  const backend = SCANNER_BACKENDS[settings.scanner];
  const notes: string[] = [];
  const images: ImageScan[] = [...preskipped];

  const now = dependencies.now();
  // Expiry is evaluated once, before fan-out, so `notes` is deterministic.
  const active: ScanSuppression[] = [];
  for (const entry of settings.ignore) {
    if (isExpired(entry, now)) {
      notes.push(
        `suppression for ${entry.id}${entry.service === undefined ? "" : ` (${entry.service})`}` +
          ` expired on ${entry.until ?? "?"} and is no longer applied`,
      );
      continue;
    }
    active.push(entry);
  }

  let scanner: ScannerIdentity = { id: backend.id, binary: backend.binary, available: false };

  if (targets.length > 0) {
    // One probe, not N. An explicitly selected-and-absent scanner never falls
    // back to the other backend: silent substitution changes the finding set.
    const probe = await dependencies.probeScanner(backend);
    scanner = {
      id: backend.id,
      binary: backend.binary,
      available: probe.available,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    };

    if (!probe.available) {
      const detail = probe.error ?? backend.installHint;
      for (const target of targets) images.push(failedScan(target, "scanner-unavailable", detail));
    } else {
      const scanned = await mapBounded(targets, settings.concurrency, (target) =>
        scanOneTarget(target, backend, settings, active, dependencies),
      );
      images.push(...scanned);
    }
  }

  images.sort(compareByService);

  for (const image of images) {
    if (image.status === "scanned" && image.truncated) {
      const total = SEVERITY_ORDER.reduce((sum, severity) => sum + image.counts[severity], 0);
      notes.push(`${image.service}: ${MAX_RETAINED_PER_TARGET} of ${total} findings shown; counts above are complete`);
    }
  }

  const capped = images.filter((image) => image.status === "skipped" && image.reason === "target-cap").length;
  if (capped > 0) {
    notes.push(
      `scan target cap of ${settings.maxTargets} distinct images reached; ${capped} service(s) were not scanned`,
    );
  }

  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    timestamp: now.toISOString(),
    scanner,
    scope,
    gate: evaluateScanGate(images, settings.failOn),
    summary: buildScanSummary(images),
    images,
    notes,
  };
}
```

Fixed note sequence (determinism requirement): expired suppressions → truncation (in sorted service order) → target cap. `targets.length === 0` short-circuits with `scanner.available: false`, spawns nothing, and still computes the gate over `preskipped`.

### 7. `P/src/lib/security-scan.spec.ts` (NEW) — dependency-injected, **no `vi.mock` at all**

Model: `P/src/lib/security-audit.spec.ts:1-40` and the DI factory at `P/src/lib/backup-docker.spec.ts:66-100`.

```ts
import { describe, expect, it, vi } from "vitest";

import {
  buildScanSummary,
  evaluateScanGate,
  resolveScanTargets,
  runSecurityScan,
  SCANNER_BACKENDS,
} from "./security-scan.js";
import type { ImageScan, ResolvedScanSettings, ScanScope, SecurityScanDependencies } from "../types/security-scan.js";

const SCOPE: ScanScope = {
  services: ["plex"],
  profiles: ["media"],
  composePath: "/srv/rfmedia-apps/compose.yml",
};

function settings(overrides: Partial<ResolvedScanSettings> = {}): ResolvedScanSettings {
  return {
    scanner: "trivy",
    failOn: "none",
    ignore: [],
    timeoutMs: 180_000,
    maxTargets: 64,
    concurrency: 2,
    cwd: "/srv/rfmedia-apps",
    ...overrides,
  };
}

function createDependencies(overrides: Partial<SecurityScanDependencies> = {}): SecurityScanDependencies {
  return {
    probeScanner: vi.fn(async () => ({ available: true, version: "0.58.1" })),
    runScanner: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "", success: true })),
    now: () => new Date("2026-07-30T18:00:00.000Z"),
    elapsedMs: () => 0,
    ...overrides,
  };
}

function trivyReport(entries: ReadonlyArray<Record<string, string>>): string {
  return JSON.stringify({ Results: [{ Target: "plex", Vulnerabilities: entries }] });
}
```

Required cases:

**`describe("trivy report parsing")`** (via `SCANNER_BACKENDS.trivy.parseReport`)

1. Realistic 2-entry report (one with `FixedVersion` + `PrimaryURL`, one without) → `ok: true`; every field normalized; the fix-less entry has **no** `fixedVersion` key.
2. `""` → `{ ok: false }`, detail mentions no report output.
3. `"{}"` → `{ ok: true, vulnerabilities: [] }`.
4. `'{"Results":"nope"}'` → `{ ok: false, detail: "unexpected trivy report shape: Results is not an array" }`.
5. `Severity: "IMPORTANT"` → `severity === "unknown"`, `rawSeverity === "IMPORTANT"`.

**`describe("grype report parsing")`** — the same five against `matches`, plus `"Negligible"` → `"negligible"`, `fixedVersion` from `vulnerability.fix.versions[0]`, `reference` from `vulnerability.dataSource`.

**`describe("retention cap")`** — one target, 250 HIGH entries → `vulnerabilities.length === 200`, `truncated === true`, `counts.high === 250`, `summary.high === 250`, and `notes` contains `plex: 200 of 250 findings shown; counts above are complete`.

**`describe("evaluateScanGate")`** (pure)

- `failOn: "high"` + one `high` → `blocked`, `blocking: true`, `blockedBy[0]` matches `plex: CVE-… (high) in openssl@3.3.1`.
- `failOn: "high"` + only `medium` → `passed`, `blockedBy: []`.
- `failOn: "none"` + `critical` → `passed`, `blocking: false`.
- one `failed` arm, no findings, `failOn: "critical"` → `inconclusive`, `blocking: true`, `blockedBy[0] === "plex: scan did not complete (timeout)"`.

**`describe("suppressions")`**

- id-scoped suppression removes CVE-1, `image.suppressed === 1`, `summary.suppressed === 1`, counts exclude it.
- suppression scoped to a different service does not suppress.
- `id: "*"` scoped to plex suppresses everything on plex.
- expired `until: "2026-06-30"` with `now: 2026-07-30` → CVE-1 **present**, `suppressed === 0`, `notes` contains `suppression for CVE-1 expired on 2026-06-30 and is no longer applied`.

**`describe("resolveScanTargets")`** (pure) — config with `lidarr` (`build: {}`), `bare` (no image), `sonarr` + `radarr` (same image), `plex` (unique). Assert targets = `plex` + `radarr` (sorted names → radarr claims first), `sonarr` skipped with `scannedBy === "radarr"`, and all four skip reasons including `target-cap` with `maxTargets: 1`.

**`describe("degradation")`**

1. `probeScanner` → `{ available: false, error: "trivy not found in PATH. Install from …" }`, two targets → both `failed` / `scanner-unavailable` with that exact `detail`; `expect(dependencies.runScanner).toHaveBeenCalledTimes(0)`; `report.scanner.available === false`.
2. `stderr: "Command timed out"` → `reason: "timeout"`.
3. `stderr: "Command output exceeded capture limit"` → `reason: "output-limit"`.
4. plex succeeds, sonarr `{ success: false, stderr: "FATAL unable to fetch vulnerability DB\n" }` → one `scanned`, one `failed` / `scanner-error` with `detail: "FATAL unable to fetch vulnerability DB"`; `targetsFailed === 1`, `targetsScanned === 1`.

### 8. `P/src/lib/security-scan-deps.spec.ts` (NEW) — the only mocked spec

Isolated so its two file-level mocks cannot leak into the DI cases above.

```ts
import { describe, expect, it, vi } from "vitest";

import { checkExternalTool } from "@rfmedia/common";
import { execWithEnv } from "./env-tools.js";
import { runSecurityScan } from "./security-scan.js";
import type { ResolvedScanSettings, ScanScope, ScanTarget } from "../types/security-scan.js";

// Partial mocks, modelled on lib/config.test.ts:26-32. Only the exec boundary is
// replaced; the logger and every other rf-common export stay real.
vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return { ...actual, checkExternalTool: vi.fn() };
});
vi.mock("./env-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env-tools.js")>();
  return { ...actual, execWithEnv: vi.fn() };
});

const SCOPE: ScanScope = { services: ["plex"], profiles: ["media"], composePath: "compose.yml" };
const SETTINGS: ResolvedScanSettings = {
  scanner: "trivy",
  failOn: "none",
  ignore: [],
  timeoutMs: 180_000,
  maxTargets: 64,
  concurrency: 2,
  cwd: "/srv/rfmedia-apps",
};

describe("default scan dependencies", () => {
  it("hands the scanner no env-tool injection", async () => {
    vi.mocked(checkExternalTool).mockResolvedValue({ available: true, version: "0.58.1" });
    vi.mocked(execWithEnv).mockResolvedValue({ code: 0, stdout: "{}", stderr: "", success: true });

    const target: ScanTarget = { service: "plex", image: "lscr.io/linuxserver/plex:1.41.3" };
    await runSecurityScan([target], [], SCOPE, SETTINGS);

    expect(vi.mocked(execWithEnv).mock.calls[0]?.[2]).toMatchObject({
      tool: "none",
      cwd: "/srv/rfmedia-apps",
      timeout: 180_000,
    });
  });
});
```

**Write nothing else.** No `formatScanText` snapshot, no `resolveScanSettings` precedence table, no `normalizeScanSuppressions` throw cases, no exit-code cases.

### 9. Handoff facts (state these in your completion message)

- Exported from `./security-scan.js` for T3's `lib/index.ts` block: `SCAN_SEVERITY_RANK`, `SCANNER_IDS`, `SCANNER_BACKENDS`, `resolveScannerBackend`, `parseScanFailOn`, `resolveScanSettings`, `normalizeScanSuppressions`, `resolveScanTargets`, `buildScanSummary`, `evaluateScanGate`, `runSecurityScan`, `formatScanText` — **one source module**.
- Exported from `../types/security-scan.js` for T3's `types/index.ts` block: value `SCAN_SCHEMA_VERSION`; types `ScannerId`, `ScanSeverity`, `ScanFailOn`, `ScanTarget`, `ScanVulnerability`, `ScanSeverityCounts`, `ScanSkipReason`, `ScanFailureCode`, `ImageScan`, `ScanGateStatus`, `ScanGate`, `ScanSummary`, `ScanScope`, `ScannerIdentity`, `ScanReport`, `ScanSuppression`, `ScanConfig`, `ResolvedScanSettings`, `ScanComposeService`, `ScanComposeConfig`, `ScannerParseResult`, `ScannerBackend`, `SecurityScanDependencies`.
- **T4:** `ComposeConfig` (`P/src/lib/docker.ts:1086-1091`) is directly structurally assignable to `ScanComposeConfig` — verified by compiling `function check(c: ComposeConfig): ScanComposeConfig { return c; }` with the repo's tsc (exit 0). **No cast is needed.**
- **T4:** `runSecurityScan` never throws and never sets `process.exitCode`; `gate.blocking` is the single authoritative predicate.
- **T3:** `resolveScanExitCode(report)` reads `report.gate.blocking` only.

### Acceptance

- [ ] All seven owned files exist; `git status --porcelain` lists only those seven as added.
- [ ] `types/security-scan.ts` declares every symbol in the handoff list and imports nothing but `type { ToolCheckResult } from "@rfmedia/common"`.
- [ ] `lib/security-scan.ts` exports exactly the twelve handoff symbols (three declared locally, nine re-exported from the three sibling modules).
- [ ] `wc -l` reports roughly 170 / 210 / 150 / 110 / 340 for the five source files; **none exceeds 500**.
- [ ] `grep -n 'node:crypto' packages/rfapps-cli/src/lib/security-scan*.ts` finds nothing.
- [ ] `grep -rn ': any\|as any' packages/rfapps-cli/src/lib/security-scan*.ts packages/rfapps-cli/src/types/security-scan.ts` finds nothing.
- [ ] `grep -n 'vi.mock' packages/rfapps-cli/src/lib/security-scan.spec.ts` finds nothing; the two mocks live only in `security-scan-deps.spec.ts`.
- [ ] `SCANNER_BACKENDS.trivy.parseReport('')`, `('{}')`, `('{"Results":"nope"}')` return `{ok:false}`, `{ok:true,vulnerabilities:[]}`, and `{ok:false,detail:'unexpected trivy report shape: Results is not an array'}` — asserted in the spec.
- [ ] `evaluateScanGate([...], 'none')` returns `blocking:false` even with critical findings; one `status:'failed'` image with any non-`none` threshold returns `status:'inconclusive', blocking:true` — asserted.
- [ ] The spec proves `runScanner` is never called when `probeScanner` reports unavailable; `security-scan-deps.spec.ts` proves `tool: "none"`.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` exits 0.
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/lib/security-scan.spec.ts src/lib/security-scan-deps.spec.ts` passes under `umask 022`.
- [ ] `env -u FORCE_COLOR npm run format:check` exits 0.

### Pitfalls

- **T0 is a hard gate.** `@rfmedia/common` resolves through `dist/`. If T0 landed but `npm run build -w packages/rf-common` was not re-run, you get a misleading "no exported member" error.
- `noUncheckedIndexedAccess`: `config.services[name]`, `items[index]`, `lines[lines.length-1]` are all `T | undefined`. Every guard in this brief is mandatory; do not "simplify" them away.
- `noPropertyAccessFromIndexSignature`: on a `Record<string, unknown>` write `value["Results"]`, never `value.Results`.
- `verbatimModuleSyntax`: type-only imports MUST use `import type`; all local imports carry `.js`.
- The two sentinels are matched with `===`, never `.includes()`. A substring match would misclassify a scanner whose own stderr contains them.
- **Never pass the scanner's own gate flag** (`trivy --exit-code`, `grype --fail-on`). `success === false` must unambiguously mean _error_.
- `counts` is computed from every surviving finding; only `vulnerabilities` is sliced. Reversing that lets a truncated target hide an above-threshold CVE from the gate — the exact bug class this feature prevents.
- Suppression expiry is evaluated **once, before fan-out**. Doing it inside `scanOneTarget` makes `notes` ordering depend on completion order.
- Sort with plain `<`, not `localeCompare`.
- Build optional fields with conditional spread (`...(x === undefined ? {} : { x })`), never `{ x: undefined }` — T4 embeds `ScanReport` in MCP-adjacent payloads whose strict check iterates `Object.keys`.
- `ScanConfig` must never gain an `enabled`/`always` key.
- `execWithEnv` takes `string[]`; `buildArgs` returns `readonly string[]`. Spread it or you get TS2345.
- Prettier `printWidth` is 100 and `format:check` is a gate. Run `npm run format` before declaring done.
- Do not add tests beyond the list above.
- Do not touch `lib/index.ts`, `types/index.ts`, `types/config.ts`, `lib/config.ts`, or `lib/exit-codes.ts` — all five belong to T3.

---

## T2 — Harden types + engine (#162)

**Owns (all NEW):**
`P/src/types/hardening.ts`, `P/src/lib/hardening-rules.ts`, `P/src/lib/hardening-format.ts`, `P/src/lib/hardening.ts`, `P/src/lib/hardening.spec.ts`
**Depends on:** nothing
**Wave:** 1

No existing repo file is modified by this task. In particular, **do not edit `P/src/lib/lint-context.ts`.**

### 0. Decisions that override the original design

1. **Mandatory four-file split.** The catalog and the renderer each become their own module, re-exported from `hardening.ts`, so downstream consumers (T3's barrel, T5's action, T7's completion import) import from `./hardening.js` only. Precedent: `state-rebuild.ts` / `state-rebuild-files.ts`.
2. **`HardenComposeService` must be structurally assignable to `LintComposeService`** (`P/src/types/lint.ts:224-251`). The corrected interface in §1 was compiled against the real `lint-context.js` with `--strict --noUncheckedIndexedAccess --module NodeNext`: **exit 0**. Property-level `readonly` is fine; `readonly T[]` is not.
3. **`HardenRefusal.ruleId` is widened to `HardenRuleId | "*"`** and `service` may be `"*"`, for the one document-level refusal ("compose document has no services map"). Throwing instead would violate the module's purity contract.
4. **`lineDelta` is signed (`serialized − source`) and is negative on real input** (this repo: 1605 → 1599 = **−6**). Tests assert `toBeLessThan(0)`.
5. **`formatHardenText` does not print a `Suppressed by config: …` list.** `HardenResult` carries only `summary.suppressed: number`. Render the count inside the summary line. Do not grow the JSON contract.
6. **`HardenPatchOperation` is `"set" | "merge-unique"` only.** The `"remove"` arm is cut: zero producers, four code paths, zero tests, on the only compose.yml-mutating path. Re-add it in the commit that ships the first rule needing it.
7. **`HardenOptions` has no `listRules` field.** `--list-rules` short-circuits before `HardenOptions` is constructed, so the field could never be `true`.
8. **Nothing in this task may reference the real `compose.yml`.** On this repo `harden-log-rotation` never fires on the 42 alias-logging services (their resolved `max-size` is `"200k"`), so the alias path is unreachable through real data. The spec uses a synthetic fixture whose `&logging-default` anchor omits `max-size`. Never assert a service count (`compose.yml` has 44, not 47).
9. Rule-id namespacing rationale: reusing the bare provenance ids would collide with **all nine** ids across `LintRuleId` and `AuditRuleId`. (The only pre-existing Lint/Audit overlap is `cap-drop-missing`.)

### 1. `P/src/types/hardening.ts` (NEW, ~205 lines)

Style model: `P/src/types/audit.ts`.

```ts
/**
 * Compose security hardening contracts for rfapps CLI.
 *
 * Harden proposes (and optionally writes) remediations for the same compose
 * posture that `rfapps lint` and `rfapps audit` report. Rule ids are namespaced
 * `harden-*` so they never collide with LintRuleId or AuditRuleId.
 */

import type { OutputFormat } from "@rfmedia/common";

import type { AuditRuleId } from "./audit.js";
import type { LintRuleId } from "./lint.js";
import type { ComposeOptions, GlobalOptions, ServiceTargetOptions } from "./options.js";

export const HARDEN_SCHEMA_VERSION = "harden.v1" as const;

export type HardenSeverity = "error" | "warn" | "info";

export type HardenCategory =
  | "capabilities"
  | "identity"
  | "filesystem"
  | "logging"
  | "limits"
  | "health"
  | "availability";

/**
 * How a proposal may be written.
 *  safe      -> mechanical and workload-neutral; eligible for --apply by default
 *  review    -> can break the workload; excluded from every write unless --include-review
 *  advisory  -> no safe automatic value exists; never written, ever
 */
export type HardenConfidence = "safe" | "review" | "advisory";

/** Namespaced so they never collide with LintRuleId or AuditRuleId. */
export type HardenRuleId =
  | "harden-no-new-privileges"
  | "harden-cap-drop-all"
  | "harden-log-rotation"
  | "harden-restart-policy"
  | "harden-read-only-rootfs"
  | "harden-run-as-non-root"
  | "harden-healthcheck"
  | "harden-memory-limit"
  | "harden-cpu-limit";

export type HardenMode = "propose" | "override" | "apply";

/** JSON-serializable compose value. Recursive, never `any`. */
export type HardenPatchValue =
  | string
  | number
  | boolean
  | readonly HardenPatchValue[]
  | { readonly [key: string]: HardenPatchValue };

/**
 * The two operations the YAML engine understands.
 *  set          -> overwrite (or create) the node at key
 *  merge-unique -> union a sequence into an existing sequence, order-preserving
 */
export type HardenPatchOperation = "set" | "merge-unique";

/**
 * One compose edit.
 *
 * INVARIANT: `key` is a single top-level key under `services.<name>`. Nested
 * paths are forbidden by design (alias/merge hazard) and asserted by
 * hardening.spec.ts; a rule needing a nested write must be `advisory` instead.
 */
export interface HardenPatch {
  readonly key: string;
  readonly operation: HardenPatchOperation;
  /** Must be an array of scalars for "merge-unique". */
  readonly value: HardenPatchValue;
  /** One-line human rendering, e.g. `security_opt += ["no-new-privileges:true"]`. */
  readonly description: string;
}

export interface HardenRule {
  readonly id: HardenRuleId;
  readonly category: HardenCategory;
  readonly severity: HardenSeverity;
  readonly confidence: HardenConfidence;
  readonly title: string;
  readonly rationale: string;
  readonly guidance: string;
  /** Provenance: the lint/audit rule this remediates. Keeps the catalogs coherent. */
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
}

export interface HardenProposal {
  readonly ruleId: HardenRuleId;
  readonly service: string;
  readonly category: HardenCategory;
  readonly severity: HardenSeverity;
  readonly confidence: HardenConfidence;
  readonly title: string;
  readonly rationale: string;
  readonly guidance: string;
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
  /** Why the rule fired, in operator language. */
  readonly evidence: readonly string[];
  /** Extra caution, e.g. "plex has writable bind mounts". */
  readonly note?: string;
  /** Empty for advisory proposals. */
  readonly patches: readonly HardenPatch[];
}

export type HardenRefusalCode =
  /** The target key is a YAML alias (*anchor); editing it would change every sharer. */
  | "alias-target"
  /** The service is absent from the compose document. */
  | "service-missing"
  /** The existing node is not the kind the operation requires. */
  | "unexpected-node"
  /** Defensive: a patch declared a nested path. Should be unreachable. */
  | "nested-path";

export interface HardenRefusal {
  readonly code: HardenRefusalCode;
  /** Service the refused patch targeted, or "*" for a document-level refusal. */
  readonly service: string;
  /** Rule the refused patch came from, or "*" for a document-level refusal. */
  readonly ruleId: HardenRuleId | "*";
  readonly detail: string;
  /** What to do instead. Always populated. */
  readonly alternative: string;
}

export interface HardenSuppression {
  readonly rule: HardenRuleId | "*";
  readonly service?: string;
  /** Optional: suppressing "add a healthcheck" needs no justification trail. */
  readonly reason?: string;
}

export interface HardenSummary {
  readonly total: number;
  readonly safe: number;
  readonly review: number;
  readonly advisory: number;
  readonly suppressed: number;
  readonly servicesAffected: number;
  /** Patches actually written. Always 0 in propose mode. */
  readonly applied: number;
  readonly refused: number;
}

export interface HardenScope {
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly composePath: string;
}

/** Disclosure of serialization churn --apply would introduce on untouched lines. */
export interface HardenReformat {
  /** True when parse -> canonical serialize is not byte-identical to the source. */
  readonly wouldReformat: boolean;
  /**
   * Signed line-count delta of the canonical serialization minus the source.
   * Negative when the canonical serializer collapses a multi-line flow sequence
   * onto one line (the only reformat this repo's compose.yml triggers).
   */
  readonly lineDelta: number;
}

export type HardenWriteOutcome =
  | { readonly mode: "propose" }
  | { readonly mode: "override"; readonly path: string; readonly patchesWritten: number }
  | {
      readonly mode: "apply";
      readonly path: string;
      readonly backupPath?: string;
      readonly patchesWritten: number;
      readonly servicesPatched: readonly string[];
    };

export interface HardenResult {
  readonly schemaVersion: typeof HARDEN_SCHEMA_VERSION;
  readonly timestamp: string;
  readonly mode: HardenMode;
  readonly includeReview: boolean;
  readonly scope: HardenScope;
  readonly summary: HardenSummary;
  readonly proposals: readonly HardenProposal[];
  readonly refusals: readonly HardenRefusal[];
  readonly reformat: HardenReformat;
  /** Compose override document holding the writable patches. "" when none. */
  readonly override: string;
  readonly write: HardenWriteOutcome;
}

/** `harden:` section of rfapps.config.yaml. */
export interface HardenConfig {
  readonly ignore?: readonly HardenSuppression[];
  readonly rules?: readonly HardenRuleId[];
  readonly includeReview?: boolean;
  /** Take a compose.yml.bak before --apply. Default true. */
  readonly backup?: boolean;
}

export interface HardenOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  readonly apply: boolean;
  readonly overridePath?: string;
  readonly includeReview: boolean;
  readonly rules?: readonly HardenRuleId[];
  readonly backup: boolean;
  readonly allowReformat: boolean;
  readonly output?: OutputFormat;
}

// --- Harden's own structural view of a resolved compose service. Local by
// --- convention (a third view alongside LintComposeService and
// --- AuditComposeService). Array members are intentionally MUTABLE so this type
// --- stays assignable to LintComposeService, which the reused lint-context
// --- predicates require. Do not add `readonly` to any array type here.
export interface HardenComposeVolumeMount {
  readonly target?: string;
  readonly read_only?: boolean;
  readonly bind?: { readonly create_host_path?: boolean };
}

export interface HardenComposeService {
  readonly image?: string;
  readonly build?: unknown;
  readonly restart?: string;
  readonly user?: string;
  readonly privileged?: boolean;
  readonly read_only?: boolean;
  readonly security_opt?: string[];
  readonly cap_add?: string[];
  readonly cap_drop?: string[];
  readonly devices?: string[];
  readonly volumes?: (string | HardenComposeVolumeMount)[];
  readonly logging?: {
    readonly driver?: string;
    readonly options?: Readonly<Record<string, string>>;
  };
  readonly healthcheck?: { readonly test?: string | string[] } | null;
  readonly deploy?: {
    readonly restart_policy?: { readonly condition?: string };
    readonly resources?: {
      readonly limits?: { readonly memory?: string; readonly cpus?: string | number };
    };
  };
}

export interface HardenComposeConfig {
  readonly services: Readonly<Record<string, HardenComposeService>>;
}
```

Do **not** add these to `P/src/types/index.ts` — T3 owns that barrel.

### 2. `P/src/lib/hardening-rules.ts` (NEW, ~285 lines)

Model: `P/src/lib/lint.ts:22-143`. Keep `EvaluableHardenRule` **unexported**.

```ts
/**
 * Declarative harden rule catalog.
 *
 * Each rule is a pure, synchronous detector over one resolved compose service
 * plus a pure proposer returning the compose edits which would satisfy it.
 * No daemon, filesystem, logging, or exit-code access.
 */

import { hasCapAdd, hasDevices, hasWritableBindMounts, runsAsRoot } from "./lint-context.js";
import type {
  HardenComposeService,
  HardenConfidence,
  HardenPatch,
  HardenRule,
  HardenRuleId,
} from "../types/hardening.js";

/** Harden rule plus its pure detection and proposal functions. */
type EvaluableHardenRule = HardenRule & {
  /** undefined = already satisfied for this service. Pure and synchronous. */
  detect: (
    service: HardenComposeService,
    serviceName: string,
  ) =>
    | undefined
    | {
        readonly evidence: readonly string[];
        readonly note?: string;
        readonly confidence?: HardenConfidence;
      };
  /** Only called when detect returned a value. Empty for advisory rules. */
  propose: (service: HardenComposeService) => readonly HardenPatch[];
};

const NO_NEW_PRIVILEGES_OPT = "no-new-privileges:true";
const CAP_DROP_ALL = "ALL";
const DEFAULT_RESTART = "unless-stopped";
/** This repo's x-common-env convention; a plain double-quoted string so compose interpolates it. */
const REPO_USER = "${PUID}:${PGID}";

/** Order-preserving union so `merge-unique` patches carry the full resolved list. */
function unionSequence(existing: readonly string[] | undefined, additions: readonly string[]): string[] {
  const result = [...(existing ?? [])];
  for (const addition of additions) {
    if (!result.includes(addition)) result.push(addition);
  }
  return result;
}

function hasRestartPolicy(service: HardenComposeService): boolean {
  if (service.restart !== undefined && service.restart.trim() !== "") return true;
  return service.deploy?.restart_policy !== undefined;
}

function hasCapDropAll(service: HardenComposeService): boolean {
  return service.cap_drop?.some((capability) => capability.toUpperCase() === CAP_DROP_ALL) === true;
}

function isPresent(value: string | number | undefined): boolean {
  return value !== undefined && String(value).trim() !== "";
}
```

Then the nine rules, in this **exact declaration order** (declaration order is a sort key and the catalog's print order):

```ts
export const HARDEN_RULES: readonly EvaluableHardenRule[] = [
  {
    id: "harden-no-new-privileges",
    category: "capabilities",
    severity: "info",
    confidence: "safe",
    title: "no-new-privileges not set",
    rationale: "A setuid binary inside the container can still escalate privileges.",
    guidance: 'Add `security_opt: ["no-new-privileges:true"]` unless the service requires privilege escalation.',
    detects: { lint: "no-new-privileges-missing" },
    detect: (service) =>
      service.security_opt?.includes(NO_NEW_PRIVILEGES_OPT) === true
        ? undefined
        : { evidence: [`security_opt does not include ${NO_NEW_PRIVILEGES_OPT}`] },
    propose: (service) => [
      {
        key: "security_opt",
        operation: "merge-unique",
        value: unionSequence(service.security_opt, [NO_NEW_PRIVILEGES_OPT]),
        description: `security_opt += ["${NO_NEW_PRIVILEGES_OPT}"]`,
      },
    ],
  },
  {
    id: "harden-restart-policy",
    category: "availability",
    severity: "warn",
    confidence: "safe",
    title: "Restart policy missing",
    rationale: "Without a restart policy the container stays stopped after host reboot or unexpected exit.",
    guidance:
      "Set top-level `restart: unless-stopped` or `deploy.restart_policy` so the service recovers automatically.",
    detects: { lint: "restart-policy-missing" },
    detect: (service) =>
      hasRestartPolicy(service) ? undefined : { evidence: ["restart and deploy.restart_policy are both absent"] },
    propose: () => [
      { key: "restart", operation: "set", value: DEFAULT_RESTART, description: `restart = "${DEFAULT_RESTART}"` },
    ],
  },
  {
    id: "harden-log-rotation",
    category: "logging",
    severity: "warn",
    confidence: "safe",
    title: "Log rotation not configured",
    rationale: "Unbounded container logs fill disk and take down every service on the host.",
    guidance: "Configure `logging.options.max-size` (and typically `max-file`) on a rotation-capable driver.",
    detects: { lint: "log-rotation-missing" },
    detect: (service) =>
      isPresent(service.logging?.options?.["max-size"])
        ? undefined
        : { evidence: ["logging.options.max-size is absent or empty"] },
    // The whole logging map: a compose override replaces it wholesale.
    propose: () => [
      {
        key: "logging",
        operation: "set",
        value: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
        description: 'logging = { driver: "json-file", options: { max-size: "10m", max-file: "3" } }',
      },
    ],
  },
  {
    id: "harden-cap-drop-all",
    category: "capabilities",
    severity: "info",
    confidence: "review",
    title: "Capability drop not configured",
    rationale: "Dropping every capability and re-adding only what is used minimises post-compromise capability.",
    guidance: 'Set `cap_drop: ["ALL"]` and re-add only the capabilities the workload uses with `cap_add`.',
    detects: { lint: "cap-drop-missing", audit: "cap-drop-missing" },
    detect: (service) => {
      if (hasCapDropAll(service)) return undefined;
      const notes: string[] = [];
      if (hasCapAdd(service)) notes.push("service uses cap_add; tune cap_drop and cap_add together");
      if (hasDevices(service)) {
        notes.push("device mounts present; verify required capabilities before dropping ALL");
      }
      return {
        evidence: [
          service.cap_drop === undefined || service.cap_drop.length === 0
            ? "cap_drop is absent"
            : `cap_drop=${service.cap_drop.join(",")}`,
        ],
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    },
    propose: (service) => [
      {
        key: "cap_drop",
        operation: "merge-unique",
        value: unionSequence(service.cap_drop, [CAP_DROP_ALL]),
        description: 'cap_drop += ["ALL"]',
      },
    ],
  },
  {
    id: "harden-read-only-rootfs",
    category: "filesystem",
    severity: "info",
    confidence: "review",
    title: "Read-only root filesystem not enabled",
    rationale: "A writable root filesystem lets a compromised process persist changes inside the container.",
    guidance: "Set `read_only: true` after moving every writable path to a tmpfs or volume mount.",
    detects: { lint: "read-only-rootfs" },
    detect: (service) =>
      service.read_only === true
        ? undefined
        : {
            evidence: ["read_only is not true"],
            ...(hasWritableBindMounts(service)
              ? {
                  note: "writable bind mounts detected; provide tmpfs or volume mounts for every writable path first",
                }
              : {}),
          },
    propose: () => [{ key: "read_only", operation: "set", value: true, description: "read_only = true" }],
  },
  {
    id: "harden-run-as-non-root",
    category: "identity",
    severity: "warn",
    confidence: "review",
    title: "Root-equivalent container user",
    rationale:
      "A root process shares uid 0 with the host, so a container escape or a writable bind mount becomes host-level compromise.",
    guidance:
      "Set `user` to a non-root UID:GID that owns the mounted host paths (this deployment uses ${PUID}:${PGID}).",
    detects: { audit: "root-user" },
    detect: (service) =>
      runsAsRoot(service)
        ? {
            evidence: [
              service.user === undefined || service.user.trim() === ""
                ? "user is absent (container defaults to root)"
                : `user=${service.user}`,
            ],
          }
        : undefined,
    propose: () => [{ key: "user", operation: "set", value: REPO_USER, description: 'user = "${PUID}:${PGID}"' }],
  },
  {
    id: "harden-healthcheck",
    category: "health",
    severity: "warn",
    confidence: "advisory",
    title: "Health check missing",
    rationale: "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
    guidance:
      "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`. rfapps will not invent a probe command; a wrong probe marks a healthy service unhealthy.",
    detects: { lint: "healthcheck-missing" },
    detect: (service) =>
      service.healthcheck !== undefined && service.healthcheck !== null
        ? undefined
        : { evidence: ["healthcheck absent"] },
    propose: () => [],
  },
  {
    id: "harden-memory-limit",
    category: "limits",
    severity: "info",
    confidence: "advisory",
    title: "Memory limit missing",
    rationale: "Without a ceiling one runaway service can OOM the whole host.",
    guidance:
      "Set `deploy.resources.limits.memory` explicitly. Ceilings are host- and workload-specific and rfapps will not guess one.",
    detects: { lint: "resource-limits-missing", audit: "memory-limit-missing" },
    detect: (service) =>
      isPresent(service.deploy?.resources?.limits?.memory)
        ? undefined
        : { evidence: ["deploy.resources.limits.memory is absent or empty"] },
    propose: () => [],
  },
  {
    id: "harden-cpu-limit",
    category: "limits",
    severity: "info",
    confidence: "advisory",
    title: "CPU limit missing",
    rationale: "An unbounded service can starve every other container on the host.",
    guidance:
      "Set `deploy.resources.limits.cpus` explicitly. Ceilings are host- and workload-specific and rfapps will not guess one.",
    detects: { audit: "cpu-limit-missing" },
    detect: (service) =>
      isPresent(service.deploy?.resources?.limits?.cpus)
        ? undefined
        : { evidence: ["deploy.resources.limits.cpus is absent or empty"] },
    propose: () => [],
  },
];

/** Rule ids in declaration order. Consumed by --rule parsing and shell completion. */
export const HARDEN_RULE_IDS: readonly HardenRuleId[] = HARDEN_RULES.map((rule) => rule.id);
```

Notes: `service.logging?.options?.["max-size"]` — bracket access is required and yields `string | undefined`. `REPO_USER` is a **double-quoted string, not a template literal**, and the description is single-quoted, so `${…}` survives to compose. The four `lint-context.js` predicates are consumed directly with `HardenComposeService`; do not copy their bodies.

### 3. `P/src/lib/hardening-format.ts` (NEW, ~150 lines)

Both renderers return `string[]`; T5 writes them to **stderr**. No colours, no snapshots.

```ts
/**
 * Pure renderers for `rfapps harden` terminal output.
 */

import { HARDEN_RULES } from "./hardening-rules.js";
import type { HardenConfidence, HardenProposal, HardenResult } from "../types/hardening.js";

const CONFIDENCE_SECTIONS: readonly { confidence: HardenConfidence; heading: string }[] = [
  { confidence: "safe", heading: "SAFE - write with `rfapps harden --apply`" },
  {
    confidence: "review",
    heading: "REVIEW - verify the workload first: `rfapps harden --apply --include-review`",
  },
  { confidence: "advisory", heading: "ADVISORY - no safe automatic value exists" },
];

/** "detects: lint/no-new-privileges-missing, audit/cap-drop-missing"; undefined when both absent. */
function detectsLabel(detects: HardenProposal["detects"]): string | undefined {
  /* … */
}

/** Render a harden result for terminal output (stderr). */
export function formatHardenText(result: HardenResult): string[] {
  /* … see step list … */
}

/** Render the rule catalog for `rfapps harden --list-rules`. */
export function formatHardenRulesCatalog(): string[] {
  /* … see shape … */
}
```

`formatHardenText` emits, in order:

1. Header chosen on `result.write.mode`:
   - `propose` → `Security Hardening Proposals  (mode: propose -- nothing written)`
   - `override` → `Security Hardening  (mode: override)` then `Override written: <write.path>`
   - `apply` → `Security Hardening  (mode: apply)` then, when `write.backupPath !== undefined`, `Backup: <write.backupPath>`
2. `Compose: ${result.scope.composePath}`
3. `Scope: ${services.length > 0 ? services.join(", ") : "all services"} (profiles: ${profiles.length > 0 ? profiles.join(", ") : "none"})`
4. `Proposals: ${total} total - ${safe} safe, ${review} review, ${advisory} advisory | ${suppressed} suppressed | ${refused} refused`
   — **this is the only place suppression is rendered; there is no `Suppressed by config:` list.**
5. If `result.proposals.length === 0` → `""`, `"No hardening proposals."`, then skip to step 7.
6. One block per `CONFIDENCE_SECTIONS` entry that has proposals: `""`, the heading, then per service (2-space indent) its proposals (4-space indent), each as `${severity}  ${ruleId}  ${firstPatchDescription ?? "(advisory - no automatic value)"}`, then 10-space-indented continuations for additional patch descriptions, then `evidence: …`, `note: …` (only when present), `guidance: …` (advisory rules only), and `detects: …` (only when non-empty).
7. When `result.refusals.length > 0`: `""`, `REFUSED - reported, not written`, then per refusal `${service}  ${ruleId}  ${detail}` and `-> ${alternative}`.
8. When `result.reformat.wouldReformat`: `""`, then `Note: writing compose.yml would also reformat lines this command did not target` and `(line delta: ${result.reformat.lineDelta}). --apply requires --allow-reformat, or use --out.`
9. When `result.write.mode === "apply"`: `Applied ${write.patchesWritten} patch(es) to ${write.servicesPatched.length} service(s); ${summary.review} review and ${summary.advisory} advisory proposal(s) untouched.` and, when `summary.refused > 0`, `Refused ${summary.refused} patch(es) (see above). Exit code 3 (partial).`
10. When `result.override !== ""` **and** mode is not `apply`: `""`, `Compose override fragment (usable as \`docker compose -f <basename> -f compose.harden.yaml up -d\`):`,`""`, then`...result.override.split("\n")`.

`formatHardenRulesCatalog()` renders from `HARDEN_RULES`:

```
Harden Rules (9)

  <id>  <severity>  <category>  <confidence>
    <title>
    <rationale>
    Guidance: <guidance>
    Detects: <detectsLabel or "-">
```

### 4. `P/src/lib/hardening.ts` (NEW, ~340 lines)

Pure. No `node:fs`, no `@rfmedia/common`, no `process.exitCode`. Only `basename` from `node:path` (string manipulation).

```ts
/**
 * Compose hardening engine: evaluation, canonical YAML serialization, and the
 * anchor-safe patch applier behind `rfapps harden`.
 *
 * Every export is pure. The patch applier is string -> string: it never reads or
 * writes the filesystem, never logs, and never throws out of the patch path —
 * an edit it cannot make safely is reported as a HardenRefusal.
 */

import { basename } from "node:path";

import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";

import { InvalidArgumentError } from "./errors.js";
import { HARDEN_RULES, HARDEN_RULE_IDS } from "./hardening-rules.js";
import type {
  HardenComposeConfig,
  HardenConfidence,
  HardenPatch,
  HardenProposal,
  HardenRefusal,
  HardenRefusalCode,
  HardenReformat,
  HardenRuleId,
  HardenSummary,
  HardenSuppression,
} from "../types/hardening.js";

export { HARDEN_RULES, HARDEN_RULE_IDS } from "./hardening-rules.js";
export { formatHardenRulesCatalog, formatHardenText } from "./hardening-format.js";
```

**Serialization + reformat detection:**

```ts
/**
 * Serializer options chosen by measurement, not taste: on this repo's compose.yml
 * they reduce the parse -> serialize delta from many hunks to exactly one.
 */
const COMPOSE_SERIALIZE_OPTIONS = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Canonical serialization used for every write and for reformat detection. */
export function serializeComposeDocument(doc: Document): string {
  return doc.toString(COMPOSE_SERIALIZE_OPTIONS);
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * Disclosure of churn `--apply` would cause on lines harden did not target. Pure.
 *
 * `lineDelta` is signed (serialized minus source) and is negative when the
 * canonical serializer collapses a multi-line flow sequence onto one line.
 */
export function detectReformat(source: string): HardenReformat {
  const serialized = serializeComposeDocument(parseDocument(source));
  return {
    wouldReformat: serialized !== source,
    lineDelta: countLines(serialized) - countLines(source),
  };
}
```

Verified with `yaml@2.9.0`: this repo's `compose.yml` → `{ wouldReformat: true, lineDelta: -6 }`; `"services:\n  a:\n    image: nginx\n"` → `{ wouldReformat: false, lineDelta: 0 }`.

**Suppressions and rule selection** (model: `normalizeIgnoreEntries` at `lib/lint.ts:194-212`):

```ts
const VALID_SUPPRESSION_RULES: readonly string[] = [...HARDEN_RULE_IDS, "*"];

/** @throws {InvalidArgumentError} When an entry references an unknown rule id */
export function normalizeHardenSuppressions(entries: readonly HardenSuppression[]): readonly HardenSuppression[] {
  return entries.map((entry) => {
    const rule = entry.rule === "*" ? "*" : entry.rule.toLowerCase().trim();
    if (!VALID_SUPPRESSION_RULES.includes(rule)) {
      throw new InvalidArgumentError("harden.ignore[].rule", entry.rule, "unknown harden rule id", [
        ...VALID_SUPPRESSION_RULES,
      ]);
    }
    return {
      rule: rule as HardenRuleId | "*",
      ...(entry.service === undefined ? {} : { service: entry.service.toLowerCase().trim() }),
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    };
  });
}

/**
 * Parse a comma-separated `--rule` allowlist.
 * @returns undefined when no allowlist was given (all rules run)
 * @throws {InvalidArgumentError} On an unknown rule id
 */
export function parseHardenRuleIds(csv: string | undefined): readonly HardenRuleId[] | undefined {
  if (csv === undefined) return undefined;
  const entries = csv
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  if (entries.length === 0) return undefined;
  for (const entry of entries) {
    if (!HARDEN_RULE_IDS.includes(entry as HardenRuleId)) {
      throw new InvalidArgumentError("--rule", entry, "unknown harden rule id", [...HARDEN_RULE_IDS]);
    }
  }
  return entries as readonly HardenRuleId[];
}
```

**`evaluateHardening`:**

```ts
const CONFIDENCE_RANK: Record<HardenConfidence, number> = { safe: 0, review: 1, advisory: 2 };
const DECLARATION_ORDER = new Map<HardenRuleId, number>(HARDEN_RULES.map((r, i) => [r.id, i]));

function isSuppressed(ruleId: HardenRuleId, serviceName: string, suppressions: readonly HardenSuppression[]): boolean {
  const normalizedService = serviceName.toLowerCase().trim();
  return suppressions.some(
    (entry) =>
      (entry.rule === "*" || entry.rule === ruleId) &&
      (entry.service === undefined || entry.service === normalizedService),
  );
}

/**
 * An empty or absent allowlist means the FULL catalog.
 * @throws {InvalidArgumentError} On an unknown rule id
 */
function selectRules(rules: readonly HardenRuleId[] | undefined): typeof HARDEN_RULES {
  if (rules === undefined || rules.length === 0) return HARDEN_RULES;
  const allowed = new Set<string>();
  for (const id of rules) {
    if (!HARDEN_RULE_IDS.includes(id)) {
      throw new InvalidArgumentError("harden.rules", String(id), "unknown harden rule id", [...HARDEN_RULE_IDS]);
    }
    allowed.add(id);
  }
  return HARDEN_RULES.filter((rule) => allowed.has(rule.id));
}

function sortProposals(proposals: HardenProposal[]): HardenProposal[] {
  return proposals.slice().sort((left, right) => {
    const confidence = CONFIDENCE_RANK[left.confidence] - CONFIDENCE_RANK[right.confidence];
    if (confidence !== 0) return confidence;
    const service = left.service.localeCompare(right.service);
    if (service !== 0) return service;
    return (DECLARATION_ORDER.get(left.ruleId) ?? 0) - (DECLARATION_ORDER.get(right.ruleId) ?? 0);
  });
}

/**
 * Evaluate resolved compose configuration against the harden rule catalog.
 *
 * @param config - Resolved configuration from `docker compose config`
 * @param targets - Service names to evaluate (undefined evaluates all services)
 * @param options - Suppressions and an optional rule allowlist
 * @returns Proposals sorted confidence -> service -> declaration order, plus the suppressed count
 * @throws {InvalidArgumentError} On unknown service targets or unknown rule ids
 */
export function evaluateHardening(
  config: HardenComposeConfig,
  targets: readonly string[] | undefined,
  options: {
    readonly suppressions: readonly HardenSuppression[];
    readonly rules?: readonly HardenRuleId[];
  },
): { readonly proposals: readonly HardenProposal[]; readonly suppressed: number } {
  const suppressions = normalizeHardenSuppressions(options.suppressions);
  const rules = selectRules(options.rules);

  if (targets !== undefined) {
    const missing = targets.filter((name) => config.services[name] === undefined);
    if (missing.length > 0) {
      throw new InvalidArgumentError(
        "services",
        missing.join(","),
        "unknown service target(s)",
        Object.keys(config.services).sort(),
      );
    }
  }

  const serviceNames = (targets ?? Object.keys(config.services)).slice().sort();
  const proposals: HardenProposal[] = [];
  let suppressed = 0;

  for (const serviceName of serviceNames) {
    const service = config.services[serviceName];
    if (service === undefined) continue;
    for (const rule of rules) {
      const detected = rule.detect(service, serviceName);
      if (detected === undefined) continue;
      if (isSuppressed(rule.id, serviceName, suppressions)) {
        suppressed += 1;
        continue;
      }
      proposals.push({
        ruleId: rule.id,
        service: serviceName,
        category: rule.category,
        severity: rule.severity,
        confidence: detected.confidence ?? rule.confidence,
        title: rule.title,
        rationale: rule.rationale,
        guidance: rule.guidance,
        detects: rule.detects,
        evidence: detected.evidence,
        ...(detected.note === undefined ? {} : { note: detected.note }),
        patches: rule.propose(service),
      });
    }
  }

  return { proposals: sortProposals(proposals), suppressed };
}

/** Proposals eligible for a write. Advisory is always excluded. */
export function filterWritableProposals(
  proposals: readonly HardenProposal[],
  includeReview: boolean,
): readonly HardenProposal[] {
  return proposals.filter(
    (p) => p.patches.length > 0 && (p.confidence === "safe" || (includeReview && p.confidence === "review")),
  );
}
```

**`applyHardenPatches` (the load-bearing part):**

```ts
function refusalFor(
  code: HardenRefusalCode,
  proposal: HardenProposal,
  detail: string,
  alternative: string,
): HardenRefusal {
  return { code, service: proposal.service, ruleId: proposal.ruleId, detail, alternative };
}

function isNullNode(node: unknown): boolean {
  return node === undefined || node === null || (isScalar(node) && node.value === null);
}

function isScalarValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function sortRefusals(refusals: HardenRefusal[]): HardenRefusal[] {
  return refusals.slice().sort((left, right) => {
    const service = left.service.localeCompare(right.service);
    return service !== 0 ? service : left.ruleId.localeCompare(right.ruleId);
  });
}

/** Apply one patch, or return the refusal that explains why it was withheld. */
function applyPatch(doc: Document, proposal: HardenProposal, patch: HardenPatch): HardenRefusal | undefined {
  const service = proposal.service;

  if (patch.key.includes(".") || patch.key.includes("/") || patch.key.trim() === "") {
    return refusalFor(
      "nested-path",
      proposal,
      `patch key "${patch.key}" is not a single top-level service key`,
      "internal invariant violation: harden only writes single top-level service keys; report this",
    );
  }

  if (!isMap(doc.getIn(["services", service], true))) {
    return refusalFor(
      "service-missing",
      proposal,
      `services.${service} is not defined in this compose document`,
      "the service is defined outside this compose file; use --out to emit an override fragment",
    );
  }

  const existing = doc.getIn(["services", service, patch.key], true);

  // Load-bearing guard: writing through an alias rewrites the shared anchor.
  if (isAlias(existing)) {
    return refusalFor(
      "alias-target",
      proposal,
      `services.${service}.${patch.key} is a YAML alias (*anchor); editing it would change every service that shares the anchor`,
      `use: rfapps harden --rule ${proposal.ruleId} --out compose.harden.yaml`,
    );
  }

  switch (patch.operation) {
    case "set":
      // Safe on a `<<:`-merged service: creates a local key that overrides the merge.
      doc.setIn(["services", service, patch.key], patch.value);
      return undefined;

    case "merge-unique": {
      if (!Array.isArray(patch.value) || !patch.value.every(isScalarValue)) {
        return refusalFor(
          "unexpected-node",
          proposal,
          `merge-unique value for services.${service}.${patch.key} is not a sequence of scalars`,
          "internal invariant violation: report this",
        );
      }
      if (isNullNode(existing)) {
        doc.setIn(["services", service, patch.key], patch.value);
        return undefined;
      }
      if (!isSeq(existing)) {
        return refusalFor(
          "unexpected-node",
          proposal,
          `services.${service}.${patch.key} is not a sequence`,
          "edit the key by hand, or use --out to emit an override fragment",
        );
      }
      const present = new Set(existing.items.map((item) => (isScalar(item) ? String(item.value) : undefined)));
      for (const entry of patch.value) {
        const key = String(entry);
        if (present.has(key)) continue;
        existing.add(entry);
        present.add(key);
      }
      return undefined;
    }
  }
}

/**
 * Apply writable proposals to compose source. Pure string -> string.
 *
 * Returns the source unchanged when nothing was written, so a run that refuses
 * every patch never reformats the operator's file.
 */
export function applyHardenPatches(
  source: string,
  proposals: readonly HardenProposal[],
): {
  readonly content: string;
  readonly patchesWritten: number;
  readonly servicesPatched: readonly string[];
  readonly refusals: readonly HardenRefusal[];
} {
  const doc = parseDocument(source);

  if (!isMap(doc.get("services"))) {
    return {
      content: source,
      patchesWritten: 0,
      servicesPatched: [],
      refusals: [
        {
          code: "unexpected-node",
          service: "*",
          ruleId: "*",
          detail: "compose document has no services map",
          alternative: "check that the compose file parses and declares a top-level `services:` mapping",
        },
      ],
    };
  }

  const refusals: HardenRefusal[] = [];
  const patched = new Set<string>();
  let patchesWritten = 0;

  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const refusal = applyPatch(doc, proposal, patch);
      if (refusal !== undefined) {
        refusals.push(refusal);
        continue;
      }
      patchesWritten += 1;
      patched.add(proposal.service);
    }
  }

  return {
    content: patchesWritten > 0 ? serializeComposeDocument(doc) : source,
    patchesWritten,
    servicesPatched: [...patched].sort(),
    refusals: sortRefusals(refusals),
  };
}
```

Runtime behaviour verified with `yaml@2.9.0` on an anchored fixture: `getIn([...,"logging"], true)` on `logging: *logging-default` → `isAlias` true; `getIn([...,"restart"], true)` where `restart` comes only from `<<: *service-base` → **`undefined`** (merge keys are not resolved), so `set` creates a local override and leaves `<<:` intact; `getIn(["services","nope"], true)` → `undefined` → `service-missing`; `existing.add(value)` appends in place with the anchor definition block byte-unchanged; `setIn` with a nested map creates it correctly.

**Override and summary:**

```ts
/**
 * Compose override document containing only the writable patches. "" when none.
 *
 * Sequence-valued patches carry the full union computed from the resolved config,
 * because a compose override REPLACES sequences rather than appending to them.
 */
export function buildHardenOverride(
  proposals: readonly HardenProposal[],
  meta: { readonly composePath: string; readonly timestamp: string; readonly includeReview: boolean },
): { readonly content: string; readonly patchesWritten: number } {
  const services: Record<string, Record<string, unknown>> = {};
  let patchesWritten = 0;

  for (const proposal of proposals) {
    for (const patch of proposal.patches) {
      const entry = services[proposal.service] ?? {};
      entry[patch.key] = patch.value;
      services[proposal.service] = entry;
      patchesWritten += 1;
    }
  }

  if (patchesWritten === 0) return { content: "", patchesWritten: 0 };

  const header = [
    `# Generated by rfapps harden at ${meta.timestamp}`,
    `# Source: ${meta.composePath}`,
    `# Apply with: docker compose -f ${basename(meta.composePath)} -f compose.harden.yaml up -d`,
    meta.includeReview
      ? "# Includes review-confidence rules. Verify each workload before applying."
      : "# Safe-confidence rules only. Re-run with --include-review to include review rules.",
  ].join("\n");

  return { content: `${header}\n${stringify({ services }, { lineWidth: 0 })}`, patchesWritten };
}

/** Aggregate proposal, suppression, write, and refusal counts. */
export function buildHardenSummary(
  proposals: readonly HardenProposal[],
  suppressed: number,
  applied: number,
  refusals: readonly HardenRefusal[],
): HardenSummary {
  const byConfidence = (confidence: HardenConfidence): number =>
    proposals.filter((p) => p.confidence === confidence).length;

  return {
    total: proposals.length,
    safe: byConfidence("safe"),
    review: byConfidence("review"),
    advisory: byConfidence("advisory"),
    suppressed,
    servicesAffected: new Set(proposals.map((p) => p.service)).size,
    applied,
    refused: refusals.length,
  };
}
```

### 5. `P/src/lib/hardening.spec.ts` (NEW)

Model: `P/src/lib/security-audit.spec.ts:1-40` — pure spec, **no `vi.mock` at all**.

Fixtures:

```ts
/**
 * Harden rule catalog and YAML patch engine tests.
 */

import { describe, expect, it } from "vitest";

import {
  applyHardenPatches,
  buildHardenOverride,
  detectReformat,
  evaluateHardening,
  HARDEN_RULES,
} from "./hardening.js";
import type { HardenComposeConfig, HardenComposeService, HardenPatch, HardenProposal } from "../types/hardening.js";

/**
 * Anchor-bearing source. `&logging-default` deliberately omits `max-size` so
 * harden-log-rotation fires on the alias and the alias guard is reachable.
 * NEVER assert against the repository's real compose.yml.
 */
const ANCHORED_COMPOSE = `x-service-base: &service-base
  restart: unless-stopped
  pull_policy: missing

x-logging-default: &logging-default
  driver: journald

services:
  sonarr:
    <<: *service-base
    image: sonarr:latest
    logging: *logging-default
    cap_drop:
      - ALL
  plex:
    <<: *service-base
    image: plex:latest
    logging: *logging-default
    security_opt: "no-new-privileges:true"
`;

const ANCHOR_BLOCK = "x-logging-default: &logging-default\n  driver: journald";

/** The resolved view Docker returns for ANCHORED_COMPOSE (anchors already merged). */
function resolvedConfig(): HardenComposeConfig {
  return {
    services: {
      sonarr: {
        image: "sonarr:latest",
        restart: "unless-stopped",
        logging: { driver: "journald" },
        cap_drop: ["ALL"],
      },
      plex: {
        image: "plex:latest",
        restart: "unless-stopped",
        logging: { driver: "journald" },
        security_opt: ["no-new-privileges:true"],
      },
    },
  };
}

function proposalsFor(service: string, ruleIds: readonly string[]): HardenProposal[] {
  const { proposals } = evaluateHardening(resolvedConfig(), [service], { suppressions: [] });
  return proposals.filter((p) => ruleIds.includes(p.ruleId));
}

function handBuilt(service: string, patches: readonly HardenPatch[]): HardenProposal {
  return {
    ruleId: "harden-no-new-privileges",
    service,
    category: "capabilities",
    severity: "info",
    confidence: "safe",
    title: "test",
    rationale: "test",
    guidance: "test",
    detects: {},
    evidence: [],
    patches,
  };
}
```

`plex.security_opt` is a **scalar in the source but a list in the resolved view** — that is the realistic `unexpected-node` case.

**`describe("applyHardenPatches")`** — five cases:

1. `proposalsFor("sonarr", ["harden-log-rotation"])` → exactly one `{ code: "alias-target", service: "sonarr", ruleId: "harden-log-rotation" }`, `patchesWritten === 0`, `content === ANCHORED_COMPOSE`.
2. `proposalsFor("sonarr", ["harden-no-new-privileges"])` → no refusals, `patchesWritten === 1`, `servicesPatched === ["sonarr"]`, content contains `<<: *service-base`, `- no-new-privileges:true`, and `ANCHOR_BLOCK` unchanged.
3. Hand-built `merge-unique` adding `"ALL"` to sonarr (source `cap_drop` is `[ALL]`) → `(content.match(/- ALL/g) ?? []).length === 1`, refusals empty.
4. Hand-built `merge-unique` on `plex.security_opt` (a scalar in source) → one `{ code: "unexpected-node" }`, `patchesWritten === 0`, `content === ANCHORED_COMPOSE`.
5. Hand-built proposal with `service: "radarr"` → `{ code: "service-missing" }` whose `alternative` names `--out`.

**`describe("buildHardenOverride")`** — one case: config with `sonarr.security_opt: ["seccomp=unconfined"]`; the `harden-no-new-privileges` override contains **both** `- seccomp=unconfined` and `- no-new-privileges:true`, `patchesWritten === 1`.

**`describe("detectReformat")`** — two cases:

- source `'services:\n  a:\n    healthcheck:\n      test:\n        [\n          "CMD",\n          "true",\n        ]\n'` → `wouldReformat: true` and `expect(lineDelta).toBeLessThan(0)`. (Measured: 9 → 5 lines, delta −4.)
- `"services:\n  a:\n    image: nginx\n"` → `{ wouldReformat: false, lineDelta: 0 }`.

**`describe("HARDEN_RULES")`** — exactly two cases (the tautological "unique ids" and "advisory proposes nothing" cases are **deliberately dropped**):

```ts
it.each(HARDEN_RULES.map((rule) => [rule.id, rule] as const))(
  "%s declares single-segment patch keys and array values for merge-unique",
  (_id, rule) => {
    for (const patch of rule.propose({})) {
      expect(patch.key).not.toContain(".");
      expect(patch.key).not.toContain("/");
      if (patch.operation === "merge-unique") {
        expect(Array.isArray(patch.value)).toBe(true);
      }
    }
  },
);

// Idempotence is why merge-unique exists: `rfapps harden --apply` twice must be a
// no-op. Advisory rules are excluded by construction — they propose nothing, so
// detect keeps firing and the assertion would be unsatisfiable.
it.each(HARDEN_RULES.filter((rule) => rule.confidence !== "advisory").map((rule) => [rule.id, rule] as const))(
  "%s is idempotent: re-detecting after its own proposal returns undefined",
  (_id, rule) => {
    const before: HardenComposeService = {};
    expect(rule.detect(before, "app")).toBeDefined();
    const after = applyPatchesToService(before, rule.propose(before));
    expect(rule.detect(after, "app")).toBeUndefined();
  },
);
```

with

```ts
/** Merge a rule's own patches into a resolved-service fixture (merge-unique values are full unions). */
function applyPatchesToService(service: HardenComposeService, patches: readonly HardenPatch[]): HardenComposeService {
  const next: Record<string, unknown> = { ...service };
  for (const patch of patches) next[patch.key] = patch.value;
  return next as unknown as HardenComposeService;
}
```

An empty `{}` fires all six patchable rules, and each rule's own proposal clears it (`"${PUID}:${PGID}"` makes `runsAsRoot` false because the uid segment is not `"0"`). `HARDEN_RULES` is typed `readonly EvaluableHardenRule[]` and that type is unexported; the spec accesses `.detect`/`.propose` structurally, which typechecks.

**Write no other cases.** No renderer tests, no suppression tests, no `parseHardenRuleIds` tests.

### 6. Handoff facts

- `./hardening.js` exports for T3's `lib/index.ts` block: `HARDEN_RULES`, `HARDEN_RULE_IDS`, `applyHardenPatches`, `buildHardenOverride`, `buildHardenSummary`, `detectReformat`, `evaluateHardening`, `filterWritableProposals`, `formatHardenRulesCatalog`, `formatHardenText`, `normalizeHardenSuppressions`, `parseHardenRuleIds`, `serializeComposeDocument`.
- `../types/hardening.js` exports for T3's `types/index.ts` block: value `HARDEN_SCHEMA_VERSION`; types `HardenSeverity`, `HardenCategory`, `HardenConfidence`, `HardenRuleId`, `HardenMode`, `HardenPatchValue`, `HardenPatchOperation`, `HardenPatch`, `HardenRule`, `HardenProposal`, `HardenRefusalCode`, `HardenRefusal`, `HardenSuppression`, `HardenSummary`, `HardenScope`, `HardenReformat`, `HardenWriteOutcome`, `HardenResult`, `HardenConfig`, `HardenOptions`, `HardenComposeVolumeMount`, `HardenComposeService`, `HardenComposeConfig`.
- **T7** imports `HARDEN_RULE_IDS` directly from `../lib/hardening.js`. `lib/hardening.ts` must not import `../lib/config.js` (T7's completion spec mocks that module wholesale).
- **T3:** `resolveHardenExitCode(result)` reads `write.mode === "apply" && write.patchesWritten > 0 && refusals.length > 0`.
- **T5/T8:** `formatHardenText` emits **no** `Suppressed by config:` line.

### Acceptance

- [ ] All five owned files exist and no file outside them is modified.
- [ ] `types/hardening.ts` exports every symbol in the handoff list; `HardenPatchOperation` is exactly `"set" | "merge-unique"`; `HardenOptions` has **no** `listRules` field; `HardenPatch.value` is non-optional.
- [ ] `HardenComposeService` is assignable to `LintComposeService`: a value of that type compiles as an argument to `hasWritableBindMounts`, `hasCapAdd`, `hasDevices`, `runsAsRoot` under `npm run typecheck --workspace packages/rfapps-cli`. `src/lib/lint-context.ts` is unmodified.
- [ ] `HARDEN_RULES` has exactly 9 entries in this order: `harden-no-new-privileges`, `harden-restart-policy`, `harden-log-rotation`, `harden-cap-drop-all`, `harden-read-only-rootfs`, `harden-run-as-non-root`, `harden-healthcheck`, `harden-memory-limit`, `harden-cpu-limit`.
- [ ] `lib/hardening.ts` exports the 13 handoff symbols (10 declared, 3 re-exported: `HARDEN_RULES`, `HARDEN_RULE_IDS` from `./hardening-rules.js`; the two renderers from `./hardening-format.js`).
- [ ] `applyHardenPatches` returns `content === source` and `patchesWritten === 0` whenever every patch was refused, and never throws for any input string.
- [ ] `grep -rn 'node:fs\|node:child_process\|@rfmedia/common' packages/rfapps-cli/src/lib/hardening*.ts` finds nothing except the `OutputFormat` type import in `types/hardening.ts`.
- [ ] `grep -c "remove" packages/rfapps-cli/src/lib/hardening.ts` shows no `case "remove"` / `deleteIn` branch.
- [ ] `hardening.spec.ts` contains exactly the case list above — 5 + 1 + 2 + 2 = 10 `it`/`it.each` declarations, no more. No `vi.mock`. No reference to the repository's `compose.yml`. No service-count assertion.
- [ ] Every owned source file is under 500 lines.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` reports no errors in the five owned files.
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/lib/hardening.spec.ts` passes under `umask 022`.
- [ ] `env -u FORCE_COLOR npm run format:check` passes.

### Pitfalls

- The original `HardenComposeService` (with `readonly T[]` arrays, `healthcheck.test?: unknown`, `deploy.restart_policy?: unknown`) **does not compile** against the four lint-context predicates — three stacked TS2345s. Use the corrected interface in §1 verbatim.
- `lineDelta` is **negative** on real input. Assert `toBeLessThan(0)`.
- The `alias-target` path is unreachable against the repo's real `compose.yml`. Your fixture's `&logging-default` must omit `max-size`.
- `const REPO_USER = "${PUID}:${PGID}";` must be a **double-quoted string, not a template literal**, or the placeholders get interpolated at build time. Same for the single-quoted description.
- `HardenRefusal.ruleId` must be `HardenRuleId | "*"`. Throwing on the document-level case violates the module's purity contract.
- `merge-unique` values must be the **full union** of the resolved list plus the additions. A compose override replaces sequences wholesale; emitting only the addition silently drops an existing `security_opt`/`cap_drop` entry — a hardening tool weakening security.
- Return `source` unchanged when `patchesWritten === 0`, or a run that wrote nothing still reformats the operator's file.
- Idempotence testing must **exclude** advisory rules.
- `noUncheckedIndexedAccess` / `noPropertyAccessFromIndexSignature`: guard `config.services[name]`, and read `options?.["max-size"]` with brackets.
- `verbatimModuleSyntax`: use `import type`, or the inline modifier (`import { parseDocument, type Document } from "yaml"`).
- Do not add exports to `src/lib/index.ts` or `src/types/index.ts` — T3 owns both barrels.
- Do not print a `Suppressed by config:` line; `HardenResult` carries only a count.
- Do not add tests beyond the ten above.
- Run gates with `env -u FORCE_COLOR` under `umask 022`.

---

## T3 — Barrels, config sections, exit codes

**Owns (all MODIFIED):**
`P/src/types/index.ts`, `P/src/lib/index.ts`, `P/src/types/config.ts`, `P/src/lib/config.ts`, `P/src/lib/exit-codes.ts`, `P/src/types/results.ts`, `P/src/types/options.ts`
**Depends on:** T1, T2
**Wave:** 2

**No new files. No spec file. Write zero tests.**

### 0. Two decisions you must not reverse

**0.1 `harden.rules` carries `undefined`, not `[]`.** `evaluateHardening`'s `selectRules` treats an empty array as the **full catalog**, so `?? []` would be redundant rather than dangerous — but `undefined` is the honest representation of "unconfigured" and keeps the merge chain readable. Write `rules: override.harden?.rules ?? base.harden?.rules` and `rules: partial.harden?.rules`. `ignore` keeps `?? []` in both branches, exactly as `lint` does. **Do not "defensively" alter `selectRules` in `P/src/lib/hardening.ts` — that file is T2's and its semantics are correct.**

**0.2 `DeployOptions.scan: boolean` is REQUIRED and knowingly breaks typecheck until T4 lands.** There is exactly one construction site in the package (`P/src/actions/deploy.ts:212`), owned by T4. After T3 alone, `npm run typecheck --workspace packages/rfapps-cli` reports **exactly one** error:

```
src/actions/deploy.ts:212 - error TS2739/TS2741: Property 'scan' is missing in type '{ ... }'
but required in type 'DeployOptions'.
```

This is expected. Do not weaken the field to `scan?: boolean` and do not edit `deploy.ts`.

**0.3 The four new exit-code helpers are NOT barrel-exported.** `P/src/lib/index.ts:200` exports only `resolveReconcileExitCode` from `./exit-codes.js`; actions import the rest directly (`deploy.ts:35`, `state-export.ts:36`, `import.ts:55`). Barrel-exporting `setScanExitCode` would put it inside `deploy.spec.ts`'s bare automock surface, where it would become an inert `vi.fn()` and silently stop setting `process.exitCode`.

### 1. `P/src/types/config.ts`

**Imports** — around `:5-6`, result:

```ts
import type { HardenConfig } from "./hardening.js";
import type { EnvTool, Profile } from "./options.js";
import type { ParallelConfig } from "./parallel.js";
import type { ScanConfig } from "./security-scan.js";
```

Both new lines MUST be `import type` — `verbatimModuleSyntax` + `isolatedModules` are on, and a value import would emit a real runtime import, closing a `config → hardening → options → config` cycle.

**`RfappsConfig`** — after `lint?: LintConfig;` (`:147`):

```ts
  /** Image vulnerability scanning configuration (`plan --scan`, `deploy --scan`) */
  scan?: ScanConfig;
  /** Compose security hardening configuration (`rfapps harden`) */
  harden?: HardenConfig;
```

Both **optional**, so the ~27 spec files that build full `RfappsConfig` literals keep compiling.

**`PartialRfappsConfig`** — after `lint: Partial<LintConfig>;` (`:165`):

```ts
scan: Partial<ScanConfig>;
harden: Partial<HardenConfig>;
```

### 2. `P/src/lib/config.ts`

**No import changes.** Two insertions only.

**`mergeConfig`** — after the `lint:` branch (`:160-162`):

```ts
    scan: {
      scanner: override.scan?.scanner ?? base.scan?.scanner,
      failOn: override.scan?.failOn ?? base.scan?.failOn,
      ignore: override.scan?.ignore ?? base.scan?.ignore ?? [],
      timeoutMs: override.scan?.timeoutMs ?? base.scan?.timeoutMs,
      maxTargets: override.scan?.maxTargets ?? base.scan?.maxTargets,
      concurrency: override.scan?.concurrency ?? base.scan?.concurrency,
    },
    harden: {
      ignore: override.harden?.ignore ?? base.harden?.ignore ?? [],
      rules: override.harden?.rules ?? base.harden?.rules,
      includeReview: override.harden?.includeReview ?? base.harden?.includeReview,
      backup: override.harden?.backup ?? base.harden?.backup,
    },
```

**`partialToFull`** — after its `lint:` branch (`:239-241`):

```ts
    scan: {
      scanner: partial.scan?.scanner,
      failOn: partial.scan?.failOn,
      ignore: partial.scan?.ignore ?? [],
      timeoutMs: partial.scan?.timeoutMs,
      maxTargets: partial.scan?.maxTargets,
      concurrency: partial.scan?.concurrency,
    },
    harden: {
      ignore: partial.harden?.ignore ?? [],
      rules: partial.harden?.rules,
      includeReview: partial.harden?.includeReview,
      backup: partial.harden?.backup,
    },
```

**Deliberately no hard defaults here.** `scanner: "trivy"`, `failOn: "none"`, `timeoutMs`, `maxTargets`, `concurrency` belong to `resolveScanSettings`; `includeReview: false` / `backup: true` belong to `actions/harden.ts`. Injecting them here would make "unset" indistinguishable from "explicitly set to the default" and duplicate the precedence chain.

**Nothing else in this file changes:** `loadConfigFromEnv` (no `RFAPPS_SCAN_*`/`RFAPPS_HARDEN_*` keys), `generateSampleConfig`, `generateConfigFromCompose`, `validateConfig`, `applyCliOverrides` (its `{ ...config }` spread already carries the new sections through). `{{ VAR }}` templating works for free — `injectSecrets` is textual and runs pre-YAML.

### 3. `P/src/lib/exit-codes.ts`

**Imports** — replace the `:1-4` block with (keeping path-alphabetical order):

```ts
import type { HardenResult } from "../types/hardening.js";
import type { LintResult, LintSeverity } from "../types/lint.js";
import type { ReconcileMode, ReconcileStatus } from "../types/reconcile.js";
import type { DeployResult } from "../types/results.js";
import type { ScanReport } from "../types/security-scan.js";
import type { StateRebuildResult, StateExportResult } from "../types/state-rebuild.js";
```

Direct module paths, not `../types/index.js`.

**New exports** — insert after `resolveStateExportExitCode`'s closing `}` (`:113`) and before the private `hasLintFindingAtOrAbove` helper (`:115`), keeping all exports above all private helpers:

```ts
/**
 * Derive the process exit category from an image vulnerability scan report.
 *
 * `gate.blocking` is the single authoritative blocking decision, computed once
 * by `evaluateScanGate`; plan's gate, deploy's gate, and the dry-run
 * `would block` line all read it and none re-derives it. A blocked or
 * inconclusive gate is an operational refusal, never a usage error.
 */
export function resolveScanExitCode(report: Pick<ScanReport, "gate">): ExitCodeValue {
  return report.gate.blocking ? ExitCode.OperationalError : ExitCode.Success;
}

/** Apply {@link resolveScanExitCode} to `process.exitCode`. */
export function setScanExitCode(report: Pick<ScanReport, "gate">): void {
  setExitCode(resolveScanExitCode(report));
}

/**
 * Derive the process exit category for a completed `rfapps harden` run.
 *
 * Harden is never a findings gate and has no `--fail-on`: proposals and
 * refusals alone exit 0, because refusing an unsafe edit is correct behaviour.
 * Only a partially-completed write — `--apply` wrote some patches and refused
 * others — reports `PartialSuccess`.
 */
export function resolveHardenExitCode(result: Pick<HardenResult, "write" | "refusals">): ExitCodeValue {
  if (result.write.mode === "apply" && result.write.patchesWritten > 0 && result.refusals.length > 0) {
    return ExitCode.PartialSuccess;
  }
  return ExitCode.Success;
}

/** Apply {@link resolveHardenExitCode} to `process.exitCode`. */
export function setHardenExitCode(result: Pick<HardenResult, "write" | "refusals">): void {
  setExitCode(resolveHardenExitCode(result));
}
```

`result.write.mode === "apply"` narrows the `HardenWriteOutcome` union so `.patchesWritten` is reachable; the `"override"` arm also carries `patchesWritten`, so the `mode` test is load-bearing. `resolveDeployExitCode` (`:46-58`) is **unchanged** — deploy's scan gate pushes a `FailedOperation` into `result.failed`, which that resolver already handles. `resolveHardenExitCode`'s signature is pre-wrapped because the one-line form is 103 chars and `printWidth` is 100.

### 4. `P/src/types/results.ts`

**Import** — after `:4`:

```ts
import type { ScanReport } from "./security-scan.js";
```

(result order: `./health.js`, `./security-scan.js`, `./staged.js`, `./validation.js`)

**`DeployResult`** — after `staged?: StagedRolloutSummary;` (`:121`):

```ts
  /**
   * Image vulnerability scan report, present only when `--scan` was passed.
   *
   * MCP invariant: `deployResultSchema` (`src/mcp/schema.ts:297-304`) is a
   * closed object and deliberately does not mirror this field. The key must
   * never be *created* on the result — assign it only inside `if (options.scan)`,
   * never `result.scan = undefined` and never via a `{ ...result, scan }`
   * spread. `schemaObject`'s strict-key check iterates `Object.keys(input)`
   * (`packages/rf-common/src/mcp/schema.ts:422-436`) and the MCP path passes the
   * raw object by reference without a JSON round-trip, so a present-but-
   * `undefined` key throws "Unexpected properties at $: scan" at runtime while
   * typechecking clean. `scan`/`scanner`/`scanFailOn` are absent from
   * `deployInputSchema` and are not forwarded by `invokeDeploy`
   * (`src/mcp/adapters.ts:276-303`), which is what keeps this branch unreachable
   * from MCP.
   */
  scan?: ScanReport;
```

This comment is denser than its neighbours on purpose: it encodes the one invariant `tsc` cannot enforce.

### 5. `P/src/types/options.ts`

**`DeployOptions`** — after `validateFirst: boolean;` (`:89`):

```ts
/** Scan resolved images for known vulnerabilities before any mutation */
scan: boolean;
```

Placed next to `validateFirst` because both are pre-mutation gates and `cli.ts` registers `--scan` immediately after `--validate-first`.

`scanner` and `scanFailOn` are **not** added here — `resolveScanSettings(rawOptions, …)` reads them off the file-local `RawDeployOptions`/`RawPlanOptions` in T4's files. `P/src/types/plan.ts`'s `PlanOptions` (the plan-_generator_ input) is untouched; the command-level `PlanOptions` that gains `scan: boolean` is file-local to `P/src/actions/plan.ts` and belongs to T4.

### 6. `P/src/types/index.ts`

**Module JSDoc** — add two bullets after the `lint` line in the `:1-16` header:

```
 * - **security-scan**: Image vulnerability scan contracts (ScanReport, ScanGate, etc.)
 * - **hardening**: Compose security hardening contracts (HardenResult, HardenPatch, etc.)
```

**New export blocks** — insert between the Audit block's close (`:350`) and `// Doctor types` (`:352`), matching the Audit block's exact style (value export line first, then one `export type`):

```ts
// Image vulnerability scan types
export { SCAN_SCHEMA_VERSION } from "./security-scan.js";
export type {
  ScannerId,
  ScanSeverity,
  ScanFailOn,
  ScanTarget,
  ScanVulnerability,
  ScanSeverityCounts,
  ScanSkipReason,
  ScanFailureCode,
  ImageScan,
  ScanGateStatus,
  ScanGate,
  ScanSummary,
  ScanScope,
  ScannerIdentity,
  ScanReport,
  ScanSuppression,
  ScanConfig,
  ResolvedScanSettings,
  ScanComposeService,
  ScanComposeConfig,
  ScannerParseResult,
  ScannerBackend,
  SecurityScanDependencies,
} from "./security-scan.js";

// Compose security hardening types
export { HARDEN_SCHEMA_VERSION } from "./hardening.js";
export type {
  HardenSeverity,
  HardenCategory,
  HardenConfidence,
  HardenRuleId,
  HardenMode,
  HardenPatchValue,
  HardenPatchOperation,
  HardenPatch,
  HardenRule,
  HardenProposal,
  HardenRefusalCode,
  HardenRefusal,
  HardenSuppression,
  HardenSummary,
  HardenScope,
  HardenReformat,
  HardenWriteOutcome,
  HardenResult,
  HardenConfig,
  HardenOptions,
  HardenComposeVolumeMount,
  HardenComposeService,
  HardenComposeConfig,
} from "./hardening.js";
```

`export type` is mandatory under `verbatimModuleSyntax`; the two `*_SCHEMA_VERSION` constants are runtime values and use a plain `export`, exactly like `AUDIT_SCHEMA_VERSION` (`:332`). The `// Config types` block at `:129-138` needs **no** change (`LintConfig` is likewise not re-exported there).

If T1/T2 declared a symbol under a different name, fix the **list**, not the source modules — and report the divergence.

### 7. `P/src/lib/index.ts`

**New export blocks** — insert between the Security-audit block's close (`:216`) and `// Doctor utilities` (`:218`):

```ts
// Image vulnerability scanning utilities
export {
  SCANNER_BACKENDS,
  SCANNER_IDS,
  SCAN_SEVERITY_RANK,
  buildScanSummary,
  evaluateScanGate,
  formatScanText,
  normalizeScanSuppressions,
  parseScanFailOn,
  resolveScanSettings,
  resolveScanTargets,
  resolveScannerBackend,
  runSecurityScan,
} from "./security-scan.js";

// Compose security hardening utilities
export {
  HARDEN_RULES,
  HARDEN_RULE_IDS,
  applyHardenPatches,
  buildHardenOverride,
  buildHardenSummary,
  detectReformat,
  evaluateHardening,
  filterWritableProposals,
  formatHardenRulesCatalog,
  formatHardenText,
  normalizeHardenSuppressions,
  parseHardenRuleIds,
  serializeComposeDocument,
} from "./hardening.js";
```

Constants first, then functions alphabetically — the convention the Security-audit and Doctor blocks use. Both blocks name **one** source module each; T1 and T2 re-export their split modules internally.

**Why every one of these must be on the barrel:** `deploy.spec.ts:15` is `vi.mock("../lib/index.js")` — a **bare automock**. Automock enumerates the barrel's exports; T4's new deploy scan cases stub `getComposeConfig`, `resolveScanSettings`, `resolveScanTargets`, `runSecurityScan`, `formatScanText` through it. A symbol missing from the barrel resolves to a **real** import and would spawn a real `trivy`/`docker` in CI.

**Not changed:** the module JSDoc at `:1-16` (already a partial list), no new `./exit-codes.js` exports, no `checkExternalTool` re-export.

### 8. Testing — NONE

Config-merge specs and exit-code-resolver specs are explicitly out of scope. Do not create `config.scan.spec.ts`, `exit-codes.spec.ts`, or any other new spec. Verified: `P/src/lib/config.test.ts` contains zero `toEqual`/`toStrictEqual` assertions, so two new always-present sections on `mergeConfig`/`partialToFull` output cannot break it, and `makeConfig()` at `P/src/lib/config-helpers.spec.ts:12-31` needs no change because both sections are optional.

### Acceptance

- [ ] `types/config.ts` imports `HardenConfig` from `./hardening.js` and `ScanConfig` from `./security-scan.js` with `import type`; `RfappsConfig` has `scan?`/`harden?`; `PartialRfappsConfig` has `scan`/`harden`.
- [ ] `lib/config.ts` `mergeConfig` and `partialToFull` each gain a `scan:` branch (6 keys) and a `harden:` branch (4 keys) immediately after the existing `lint:` branch.
- [ ] `grep -n 'rules:' packages/rfapps-cli/src/lib/config.ts` shows no `rules: … ?? []`; `harden.ignore` and `scan.ignore` **do** use `?? []`.
- [ ] `packages/rfapps-cli/src/lib/hardening.ts` is unmodified (`git diff --name-only` does not list it).
- [ ] `loadConfigFromEnv`, `generateSampleConfig`, `validateConfig`, `applyCliOverrides` are byte-unchanged.
- [ ] `lib/exit-codes.ts` exports exactly four new symbols with the signatures `Pick<ScanReport, "gate">` and `Pick<HardenResult, "write" | "refusals">`, placed above the private `hasLintFindingAtOrAbove`; `resolveDeployExitCode` unchanged.
- [ ] `grep -c 'ScanExitCode\|HardenExitCode' packages/rfapps-cli/src/lib/index.ts` is `0`.
- [ ] `types/results.ts` `DeployResult` gains `scan?: ScanReport` after `staged?`, with the never-create-the-key JSDoc.
- [ ] `types/options.ts` `DeployOptions` gains a required `scan: boolean`; `scanner`/`scanFailOn` are NOT added; `types/plan.ts` untouched.
- [ ] `types/index.ts` re-exports `SCAN_SCHEMA_VERSION` + 23 scan types and `HARDEN_SCHEMA_VERSION` + 23 harden types, `export type` for types and plain `export` for the constants, between the Audit and Doctor blocks.
- [ ] `lib/index.ts` re-exports all 12 `./security-scan.js` symbols and all 13 `./hardening.js` symbols, between the Security-audit and Doctor blocks.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` reports **at most one** error, and if present it is exactly the missing `scan` property on the `DeployOptions` literal at `src/actions/deploy.ts:212`. Any other error is a T3 defect.
- [ ] `env -u FORCE_COLOR npm run test:run --workspace packages/rfapps-cli` (under `umask 022`) shows no NEW failures vs the pre-T3 baseline; `config.test.ts`, `config-helpers.spec.ts`, `config-missing.spec.ts` all still pass.
- [ ] `npm run format:check` passes on all seven owned files.
- [ ] No new `.spec.ts` / `.test.ts` file was created.

### Pitfalls

- `verbatimModuleSyntax` + `isolatedModules`: a bare `export { ScanReport } from …` fails to compile, and a value-form `import { HardenConfig }` in `types/config.ts` emits a real runtime import, closing a `config → hardening → options → config` cycle. Every type edge must be `import type` / `export type`.
- Making `DeployOptions.scan` required breaks `tsc` at `deploy.ts:212` until T4 lands. That is the **only** acceptable typecheck error after T3. Do not edit `deploy.ts`; do not weaken the field.
- Do **not** barrel-export the four exit-code helpers. `deploy.spec.ts:15` is a bare automock; a barrel-exported `setScanExitCode` becomes an inert `vi.fn()` and silently breaks T4's `process.exitCode === 1` assertion. Precedent: only `resolveReconcileExitCode` is barrel-exported.
- Conversely, **every** scan/harden lib function a T4/T5 action calls MUST be barrel-exported, or that same automock lets a real `trivy` spawn in CI.
- Do not inject hard defaults in `partialToFull`. They belong to `resolveScanSettings` and `actions/harden.ts`.
- `DeployResult.scan` must never be _created_ with an `undefined` value — `schemaObject`'s strict check iterates `Object.keys(input)` and the MCP path passes the raw object by reference with no JSON round-trip. Record this in the field's JSDoc so T4 sees it.
- `ScanConfig` must never gain an `enabled`/`always` toggle without mirroring `scanReportSchema` into `deployResultSchema` (`src/mcp/schema.ts:297`) and `planResultSchema` (`:522`) in the same commit.
- `selectRules` in T2's `hardening.ts` already treats `[]` as the full catalog. Leaving `rules` undefined is a style choice, not a bug fix — do not "correct" T2's implementation.
- `lib/config.ts` reaches ~697 lines and `types/index.ts` ~545. Both exceed the ~500 soft cap and both are exempt (contiguous registry / barrel). Do not refactor here.
- Design line anchors drift 1–3 lines; re-anchor by searching for the quoted construct.
- Do not touch `rfapps.config.yaml`, `P/CLAUDE.md`, `docs/features/rfapps-configuration.md`, or `P/README.md` (all T9).

---

## T4 — Plan + deploy scan integration (#161)

**Owns (all MODIFIED):** `P/src/actions/plan.ts`, `P/src/actions/deploy.ts`, `P/src/actions/deploy.spec.ts`
**Depends on:** T1, T3
**Wave:** 3

### 0. Decisions that override the original design

**D1 — no cast.** `getComposeConfig` returns `ComposeConfig | undefined` (`P/src/lib/docker.ts:1086-1091`), and `ComposeServiceConfig` (`:1068-1086`) has `image?: string` plus `build?: { context?: string; dockerfile?: string }`, which is **directly structurally assignable** to `ScanComposeConfig`. Compile-verified against the real module with the repo's tsc, zero errors. Pass `composeConfig` **directly**. Writing `as unknown as ScanComposeConfig` is dead weight that hides future type drift.

**D2 — `scanFailureEntry` mirrors its neighbour's inline return type**, not `FailedOperation`. `validationFailureEntry` (`deploy.ts:116-132`) declares `: { name: string; code: string; error: string }` inline; the object is assignable to `FailedOperation` (`types/results.ts:195-202`) at the `result.failed.push(...)` site.

**D3 — REJECTED. Do NOT convert `plan.ts:455`.** The pre-existing `process.exitCode = 1;` inside the plan-generation-failure branch stays byte-unchanged. Rewriting an untouched line's idiom is scope creep in a security-feature diff. New scan code uses `setExitCode(ExitCode.OperationalError)`; two idioms coexisting in `plan.ts` is pre-existing and not this PR's problem.

**D4 — env tool.** Reuse each host action's **existing** env-tool resolution verbatim. `plan.ts:352` is `const envTool = getEnvToolExecConfig(globalOptions);` (1-arg) and `deploy.ts:281` derives `envTool`/`deployExecution`. Both are pre-existing and shared with `audit.ts`. **Do not change them, and do not add a second resolution.** (Only the new `rfapps harden` command, T5, uses the 2-arg config-aware form — a new-command choice, not a fix applied here.) Consequence to be aware of but not to act on: on this repo, running `rfapps plan --scan` without `--use-dotenvx` fails compose resolution exactly as `rfapps plan` alone already does.

**D5 — file size.** `plan.ts` 482 → ~530 and `deploy.ts` 1237 → ~1300. Both are already over the ~500 soft cap. **Do not refactor either file here** — any extraction collides with T3/T5/T6 ownership.

### 1. `P/src/actions/plan.ts`

#### 1.1 Imports

**(a)** Extend the barrel import at `:32-37` (keep the file's grouped, non-alphabetical style; append):

```ts
import {
  loadConfig,
  applyCliOverrides,
  isValidProfile,
  resolveServicesWithInteractive,
  getComposeConfig,
  resolveScanSettings,
  resolveScanTargets,
  runSecurityScan,
  formatScanText,
} from "../lib/index.js";
```

Barrel import is required, not optional: `plan.spec.ts:17` is `vi.mock("../lib/index.js")` (bare automock), and `audit.ts:13-23` is the in-repo precedent for pulling `getComposeConfig` from the barrel.

**(b)** New line immediately after `:39` (`import { DockerCommandError } from "../lib/errors.js";`):

```ts
import { ExitCode, setExitCode, setScanExitCode } from "../lib/exit-codes.js";
```

Module path, **not** the barrel — the barrel re-exports only `resolveReconcileExitCode`, and the direct path keeps the real implementation live under the automock.

**(c)** After `:29`:

```ts
import type { ScanReport } from "../types/security-scan.js";
```

#### 1.2 `RawPlanOptions` (`:50-63`)

After `explain?: boolean;` (`:59`), before `compose?: string;`:

```ts
  scan?: boolean;
  scanner?: string;
  scanFailOn?: string;
```

#### 1.3 `PlanOptions` (`:68-86`)

After `explain: boolean;` (`:82`):

```ts
scan: boolean;
```

Required, matching `explain`/`checkUpdates`. This interface is file-local.

#### 1.4 `PlanOutputPayload` (`:88-92`)

```ts
/** Machine-format payload for `rfapps plan`. */
interface PlanOutputPayload {
  planPath: string;
  plan: DeploymentPlan;
  /**
   * Image vulnerability scan report, present only under `--scan`.
   *
   * Lives on the output envelope, never on `DeploymentPlan`: `savePlan`
   * JSON-stringifies the whole plan, so an embedded CVE verdict would decay on
   * disk and `rfapps apply <path>` days later would re-assert it as authoritative.
   */
  scan?: ScanReport;
}
```

#### 1.5 `planResultForOutput` (`:107-118`)

Keep the signature and explicit parameter types (an untyped snippet would fail `noImplicitAny`). Extend the existing JSDoc's `@param payload` to say `the { planPath, plan, scan? } envelope` and add one sentence noting `scan` is stripped for the same flattening reason. New body:

```ts
function planResultForOutput(format: OutputFormat, payload: PlanOutputPayload): PlanOutputPayload | object {
  const flattens = format === "table" || format === "csv";
  if (!flattens) {
    return payload;
  }

  const { scan: _scan, ...rest } = payload;
  if (rest.plan.intelligence === undefined) {
    return rest;
  }

  const { intelligence: _intelligence, ...plan } = rest.plan;
  return { ...rest, plan };
}
```

#### 1.6 Options initializer (`:355-373`)

After `explain: rawOptions.explain ?? false,` (`:369`):

```ts
    scan: rawOptions.scan ?? false,
```

#### 1.7 The scan block — insert between `:457` and `:459`

`:445-457` is the `plan === undefined` guard (whose `process.exitCode = 1;` at `:455` you leave alone). `:459` is `// Save plan`. Insert after the guard's closing `}`:

```ts
// The scan runs after plan generation and before the plan is written: the
// report is evidence for this invocation only. `--dry-run` short-circuits at
// :415 before generation, so `plan --dry-run --scan` deliberately scans nothing.
let scan: ScanReport | undefined;
if (options.scan) {
  const settings = resolveScanSettings(rawOptions, finalConfig.scan, process.cwd());
  const composeConfig = await getComposeConfig(finalConfig.composePath, {
    profiles,
    envFile: finalConfig.envFile,
    envTool,
  });
  if (composeConfig === undefined) {
    const error = new DockerCommandError(
      "config",
      "Failed to resolve compose config for scanning",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    outputFormattedError(formatError(error));
    setExitCode(ExitCode.OperationalError);
    return;
  }

  const { targets, skipped } = resolveScanTargets(composeConfig, services, settings.maxTargets);
  scan = await runSecurityScan(
    targets,
    skipped,
    { services, profiles, composePath: finalConfig.composePath },
    settings,
  );
}
```

`resolveScanSettings` throws `InvalidArgumentError` on a bad `--scanner`/`--scan-fail-on` or a malformed `scan.ignore` entry; that propagates to `handleCliError` → exit 2. **Do not catch it.** `runSecurityScan` never throws and never touches `process.exitCode`.

#### 1.8 Machine output (`:466`)

```ts
await formatOutput(format, planResultForOutput(format, { planPath, plan, ...(scan === undefined ? {} : { scan }) }));
```

The conditional spread is load-bearing, not style — see §3.

#### 1.9 Text output — insert before the `}` at `:474`

```ts
if (scan !== undefined) {
  for (const line of formatScanText(scan)) {
    console.error(line);
  }
}
```

`plan.ts` writes human output with `console.error`, not `logInfo`. Match the file.

#### 1.10 The gate — insert immediately above `// Check if --apply flag is set` (`:476`)

```ts
// The plan file is still written when the gate blocks: a plan is evidence, not
// a mutation, and `rfapps apply <path>` remains the explicit operator override.
if (scan !== undefined && scan.gate.blocking) {
  setScanExitCode(scan);
  return;
}
```

### 2. `P/src/actions/deploy.ts`

#### 2.1 Imports

**(a)** Append to the barrel import (`:47-73`), after `createBatchObserver,`:

```ts
  getComposeConfig,
  resolveScanSettings,
  resolveScanTargets,
  runSecurityScan,
  formatScanText,
```

**(b)** Add a direct type import right after the `../types/index.js` type block (`:37-44`):

```ts
import type { ScanReport } from "../types/security-scan.js";
```

`ExitCode`/`setExitCode` are already imported at `:35`; `logInfo`, `confirm`, `isMachineFormat`, `formatError`, `outputFormattedError` at `:12-22`. **No `setScanExitCode` import** — deploy's gate uses `setExitCode(ExitCode.OperationalError)`, matching the validation gate at `:418`.

#### 2.2 `RawDeployOptions` (`:95-114`)

After `validateFirst?: boolean;` (`:110`):

```ts
  scan?: boolean;
  scanner?: string;
  scanFailOn?: string;
```

#### 2.3 New helpers — insert after `validationFailureEntry`'s closing `}` (`:132`), before `async function outputValidationFailure` (`:134`)

```ts
function scanFailureEntry(status: "blocked" | "inconclusive"): {
  name: string;
  code: string;
  error: string;
} {
  return status === "blocked"
    ? {
        name: "scan",
        code: "VULNERABILITY_THRESHOLD",
        error: "Image vulnerability scan found findings at or above the configured severity",
      }
    : {
        name: "scan",
        code: "SCAN_INCONCLUSIVE",
        error: "Image vulnerability scan could not complete for every target",
      };
}

/**
 * Compact severity annotation for the deploy confirmation prompt.
 *
 * A non-blocking scan still produces findings the operator must see before
 * answering "yes". Returns "" when there is no scan or no surviving finding, so
 * the prompt text is byte-identical to today without `--scan`.
 */
function scanConfirmAnnotation(report: ScanReport | undefined): string {
  if (report === undefined || report.summary.total === 0) {
    return "";
  }

  const severities = ["critical", "high", "medium", "low", "negligible", "unknown"] as const;
  const parts = severities
    .filter((severity) => report.summary[severity] > 0)
    .map((severity) => `${report.summary[severity]} ${severity}`);

  return parts.length === 0 ? "" : ` [scan: ${parts.join(", ")}]`;
}
```

#### 2.4 `deployResultForOutput` (`:159-167`)

```ts
function deployResultForOutput(format: OutputFormat, result: DeployResult): DeployResult | object {
  const flattens = format === "table" || format === "csv";
  if (!flattens || (result.validation === undefined && result.staged === undefined && result.scan === undefined)) {
    return result;
  }

  const { validation: _validation, staged: _staged, scan: _scan, ...deployResult } = result;
  return deployResult;
}
```

#### 2.5 Options initializer (`:212-245`)

After `validateFirst: rawOptions.validateFirst ?? false,` (`:222`):

```ts
    scan: rawOptions.scan ?? false,
```

This is the single construction site of `DeployOptions` in the package; it closes T3's known typecheck error.

#### 2.6 The scan run block — insert between `:425` and `:427`

`:423-425` defines `deployComposePath` and `deployExecution`; `:427` is `// Auto-enable forceRecreate`. Insert with a blank line either side:

```ts
// `options.scan` is only ever true on the CLI path: `scan`/`scanner`/`scanFailOn`
// are absent from `deployInputSchema` and are not forwarded by `invokeDeploy`
// (src/mcp/adapters.ts:276-303), so `result.scan` is never CREATED on the MCP
// path. `deployResultSchema` is `additionalProperties: false` and its strict-key
// check reads `Object.keys(result)`, so assigning `undefined` would break it.
if (options.scan) {
  const settings = resolveScanSettings(rawOptions, finalConfig.scan, invocationCwd);
  const composeConfig = await getComposeConfig(deployComposePath, {
    profiles,
    envFile: finalConfig.envFile,
    ...deployExecution,
  });
  if (composeConfig === undefined) {
    const error = new DockerCommandError(
      "config",
      "Failed to resolve compose config for scanning",
      1,
      services.length > 0 ? services : ["all"],
      false,
    );
    outputFormattedError(formatError(error));
    setExitCode(ExitCode.OperationalError);
    return;
  }

  const { targets, skipped } = resolveScanTargets(composeConfig, services, settings.maxTargets);
  result.scan = await runSecurityScan(
    targets,
    skipped,
    { services, profiles, composePath: deployComposePath },
    settings,
  );

  if (format === "text" || format === "table") {
    for (const line of formatScanText(result.scan)) {
      logInfo(line);
    }
  }
}
```

`...deployExecution` **must stay last**: when `--validate-first` passed, `composeExecutionOptions` (`P/src/lib/deploy-validation.ts:781-791`) supplies the authority-bound `envFile`/`cwd`/`env`/`replaceEnv`/`projectName` and must win over `finalConfig.envFile`. When it did not, `deployExecution` is `{ envTool }` and `finalConfig.envFile` survives.

Placement is load-bearing: after the conflict-validation gate (`:421`), after `deployComposePath`/`deployExecution` (`:423-425`), before the dry-run branch (`:443`), before the confirmation prompt (`:522`), far before `revalidateDeployBinding` (`:559`), `startServices` (`:726`, `:964`) and `pullImages` (`:931`).

#### 2.7 Dry-run "would block" line — insert after `:488`

`:488` closes the `if (useParallel && …)` block; `:490` is `if (format !== "text") {`.

```ts
// `--dry-run` means "preview, always succeed" everywhere else in this CLI, so a
// would-block gate reports and exits 0. `gate.blocking` in the machine payload
// plus this line gives CI everything it needs.
if (result.scan?.gate.blocking === true) {
  logInfo(`would block deploy (--scan-fail-on ${result.scan.gate.failOn})`);
}
```

The string is asserted verbatim by the new spec — keep it lowercase and exact.

#### 2.8 Dry-run machine payload — insert after `:516`

`:514-516` is the existing `validation` spread; `:517` is `});`. Insert one line between them:

```ts
        ...(result.scan === undefined || format === "table" ? {} : { scan: result.scan }),
```

**Do not** insert at `:508-510` — that is inside the staged `batches` object literal.

#### 2.9 The gate — insert between `:520` and `:522`

`:520` closes `if (options.dryRun)`; `:522` is `// Confirmation if not --yes`.

```ts
if (result.scan !== undefined && result.scan.gate.blocking) {
  result.failed.push(scanFailureEntry(result.scan.gate.status === "blocked" ? "blocked" : "inconclusive"));
  logInfo("Deploy blocked by vulnerability scan. No containers were modified.");
  if (format !== "text") {
    await outputDeployResult(format, result);
  }
  setExitCode(ExitCode.OperationalError);
  return;
}
```

`logInfo` writes to stderr, so it is safe in every format. `outputDeployResult` for machine formats mirrors the validation gate at `:415-420`.

#### 2.10 Prompt annotation (`:523-531`)

```ts
  if (!options.yes && !isMachineFormat(format)) {
    const serviceList = services.length > 0 ? services.join(", ") : "all services";
    const pullNote = options.skipPull ? "" : " (will pull images first)";
    // Only a non-blocking scan reaches here; the blocking gate returned above.
    const scanNote = scanConfirmAnnotation(result.scan);
    const confirmed = await confirm(`Deploy ${serviceList}${pullNote}${scanNote}?`);
```

Yields e.g. `Deploy plex (will pull images first) [scan: 1 critical, 2 high]?`. No existing spec asserts this prompt text, and the annotation is `""` without `--scan`, so the default prompt is byte-identical.

### 3. The MCP invariant you must not break

`schemaObject`'s runtime strict-key check iterates `Object.keys(input)` (`packages/rf-common/src/mcp/schema.ts:422-436`), and the MCP path does **not** JSON round-trip the payload: `withFormatOutputCapture` hands the raw object through (`formatters/index.ts:68-73`) → `parseCapturedOutput` returns the same reference (`adapters.ts:119-131`) → `tool.outputSchema.parse(rawResult)` (`core.ts:80`). Empirically, `{services:[],started:0,scan:undefined}` throws `Unexpected properties at $: scan`.

Therefore, in your files:

- `result.scan = …` appears **exactly once**, inside `if (options.scan) { … }`. Never `result.scan = undefined`, never `{ ...result, scan }`.
- plan's payload uses `...(scan === undefined ? {} : { scan })`.
- Do not add `scan`/`scanner`/`scanFailOn` to `src/mcp/schema.ts` or `src/mcp/adapters.ts` (not owned by T4).

### 4. `P/src/actions/deploy.spec.ts` — exactly two new cases

#### 4.1 Mocking model

`deploy.spec.ts:15` is `vi.mock("../lib/index.js");` — a **bare automock** (the file's own comment at `:117-126` documents the consequence). Every new barrel export resolves to a `vi.fn()` returning `undefined` and **must** be wired explicitly, exactly like `lib.planStagedBatches`/`lib.executeStagedRollout` at `:304-313`. `../lib/exit-codes.js` is **not** mocked (imported for real at `:8`), so `setExitCode` really sets `process.exitCode`; the outer `beforeEach` resets it at `:208`.

#### 4.2 Additional imports

Beside `import type { FailedOperation, StagedRolloutReport } from "../types/index.js";` (`:11`):

```ts
import { SCAN_SCHEMA_VERSION } from "../types/security-scan.js";
import type { ResolvedScanSettings, ScanReport } from "../types/security-scan.js";
```

#### 4.3 New `describe` block — appended as the last sibling of the top-level `describe("Deploy Action", …)`, after `describe("staged mode", …)`

```ts
describe("--scan", () => {
  const scanSettings: ResolvedScanSettings = {
    scanner: "trivy",
    failOn: "high",
    ignore: [],
    timeoutMs: 180_000,
    maxTargets: 64,
    concurrency: 2,
    cwd: "/project",
  };

  function blockingScanReport(): ScanReport {
    return {
      schemaVersion: SCAN_SCHEMA_VERSION,
      timestamp: "2026-07-30T18:00:00.000Z",
      scanner: { id: "trivy", binary: "trivy", version: "0.58.1", available: true },
      scope: { services: ["app"], profiles: ["core"], composePath: "compose.yml" },
      gate: {
        failOn: "high",
        status: "blocked",
        blocking: true,
        blockedBy: ["app: CVE-2024-45490 (critical) in expat@2.5.0"],
      },
      summary: {
        critical: 1,
        high: 0,
        medium: 0,
        low: 0,
        negligible: 0,
        unknown: 0,
        total: 1,
        suppressed: 0,
        targetsScanned: 1,
        targetsSkipped: 0,
        targetsFailed: 0,
      },
      images: [
        {
          status: "scanned",
          service: "app",
          image: "app:latest",
          counts: { critical: 1, high: 0, medium: 0, low: 0, negligible: 0, unknown: 0 },
          vulnerabilities: [
            {
              id: "CVE-2024-45490",
              severity: "critical",
              rawSeverity: "CRITICAL",
              packageName: "expat",
              installedVersion: "2.5.0",
              fixedVersion: "2.6.3",
            },
          ],
          suppressed: 0,
          truncated: false,
          durationMs: 10,
        },
      ],
      notes: [],
    };
  }

  beforeEach(() => {
    // `vi.mock("../lib/index.js")` is a bare automock, so every scan helper
    // resolves `undefined` unless it is driven here.
    vi.mocked(lib.getComposeConfig).mockResolvedValue({
      services: { app: { name: "app", image: "app:latest" } },
    });
    vi.mocked(lib.resolveScanSettings).mockReturnValue(scanSettings);
    vi.mocked(lib.resolveScanTargets).mockReturnValue({
      targets: [{ service: "app", image: "app:latest" }],
      skipped: [],
    });
    vi.mocked(lib.runSecurityScan).mockResolvedValue(blockingScanReport());
    vi.mocked(lib.formatScanText).mockReturnValue(["Image Vulnerability Scan"]);
  });

  it("refuses the deploy before any mutation when the gate blocks", async () => {
    await executeDeploy({ service: "app", scan: true }, { yes: true, output: "json" });

    expect(lib.runSecurityScan).toHaveBeenCalledTimes(1);
    expect(formatters.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        failed: [expect.objectContaining({ name: "scan", code: "VULNERABILITY_THRESHOLD" })],
        scan: expect.objectContaining({ gate: expect.objectContaining({ blocking: true }) }),
      }),
    );
    expect(process.exitCode).toBe(ExitCode.OperationalError);
    expect(common.confirm).not.toHaveBeenCalled();
    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(lib.startServices).not.toHaveBeenCalled();
    expect(lib.executeStagedRollout).not.toHaveBeenCalled();
    expect(lib.initializeDatabase).not.toHaveBeenCalled();
  });

  it("reports a would-block gate under --dry-run and still exits zero", async () => {
    await executeDeploy({ service: "app", scan: true }, { yes: true, dryRun: true, output: "json" });

    expect(lib.runSecurityScan).toHaveBeenCalledTimes(1);
    expect(common.logInfo).toHaveBeenCalledWith("would block deploy (--scan-fail-on high)");
    expect(formatters.formatOutput).toHaveBeenCalledWith(
      "json",
      expect.objectContaining({
        dryRun: true,
        scan: expect.objectContaining({ gate: expect.objectContaining({ blocking: true }) }),
      }),
    );
    expect(process.exitCode).toBeUndefined();
    expect(lib.pullImages).not.toHaveBeenCalled();
    expect(lib.startServices).not.toHaveBeenCalled();
  });
});
```

Case (a) is the only mechanical proof that the gate cannot be bypassed and cannot mutate; case (b) pins the deliberate "dry-run always succeeds" decision.

Mock-shape notes: `ComposeServiceConfig.name` is required, hence `{ name: "app", image: "app:latest" }` — no cast needed. The outer `beforeEach` (`:205`) already mocks `common.isMachineFormat` (`json` → true), so the prompt is skipped; it uses `vi.clearAllMocks()` (calls only) and re-seeds, and the nested `beforeEach` runs after it.

**Add nothing else.** No `plan.spec.ts` scan case, no `formatScanText` snapshot, no exit-code resolver specs.

### 5. Conventions

- ESM `.js` extensions; `verbatimModuleSyntax` requires `import type` for type-only imports.
- No `any`, no `as unknown as` (see D1). `noUncheckedIndexedAccess` is on.
- JSDoc: block comments on behaviour-bearing helpers (`scanConfirmAnnotation`, the `PlanOutputPayload.scan` field); mechanical helpers (`scanFailureEntry`) follow `validationFailureEntry` and carry none.
- Logging: `deploy.ts` → `logInfo` (stderr); `plan.ts` → `console.error`. stdout stays clean for machine output. Never `console.log` in `deploy.ts`.
- Errors (package hybrid rule): `resolveScanSettings`'s `InvalidArgumentError` **throws** (usage → exit 2); the `getComposeConfig === undefined` Docker failure uses **local formatting** (`formatError` + `outputFormattedError` + `setExitCode`) exactly like `audit.ts:130-143`.

### Acceptance

- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` exits 0 with no new diagnostics (this also closes T3's known error).
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/deploy.spec.ts` passes, including exactly two new `it(...)` cases inside `describe("--scan", …)`; no other spec case added or modified.
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/plan.spec.ts` still passes unchanged (`plan.spec.ts` is NOT edited).
- [ ] `git diff packages/rfapps-cli/src/actions/plan.ts | grep -c 'process.exitCode = 1'` shows the line was not touched (D3 rejected).
- [ ] `grep -n 'result.scan =' packages/rfapps-cli/src/actions/deploy.ts` returns exactly one line, inside `if (options.scan) {`; `grep -rn 'scan: undefined' packages/rfapps-cli/src/actions/` returns nothing.
- [ ] `grep -n 'as unknown as' packages/rfapps-cli/src/actions/plan.ts packages/rfapps-cli/src/actions/deploy.ts` returns nothing.
- [ ] `git diff --name-only` for this task lists only the three owned files.
- [ ] In `deploy.ts` the scan run block sits after `const deployExecution = …` and before `// Auto-enable forceRecreate`; the gate sits after the dry-run branch's closing `}` and before `// Confirmation if not --yes`; the dry-run `scan` spread sits after the `validation` spread and before `});`. Verified by reading the diff hunks.
- [ ] `env -u FORCE_COLOR npm run format:check` passes; no unused-import diagnostics.

### Pitfalls

- `deploy.spec.ts:15` is a **bare automock**, not the `importOriginal` form. Forgetting to wire one new barrel export produces a confusing `Cannot read properties of undefined` deep inside `executeDeploy`.
- Never create the `scan` key with an `undefined` value — `schemaObject` iterates `Object.keys(input)` and the MCP path passes the raw reference, so `{...result, scan: undefined}` throws at MCP runtime while typechecking clean.
- The `as unknown as ScanComposeConfig` cast is unnecessary; `ComposeConfig` is directly assignable. Writing it hides future type drift.
- Design anchors drift: `RawDeployOptions` is `:95-114`; the dry-run `validation` spread is `:514-516` (`:508-513` is the staged `batches` literal — inserting there yields a nonsense payload); `plan.ts`'s `savePlan` is `:460`, machine output `:466`, dry-run short-circuit `:415`. Re-anchor by searching.
- `...deployExecution` must be spread **last** in deploy's `getComposeConfig` call, or the authority-bound `envFile`/`cwd`/`env` are silently discarded when `--validate-first` passed.
- `deploy --dry-run --scan` **does** run the scan (the run block precedes the dry-run branch) and must exit 0. `plan --dry-run --scan` scans **nothing** (the dry-run short-circuit precedes plan generation). Both asymmetries are deliberate.
- Do **not** re-resolve the env tool. Reuse `plan.ts`'s existing `envTool` and deploy's `deployExecution`. The 2-arg config-aware form is T5's choice for a new command only.
- Do **not** convert `plan.ts:455`. D3 is rejected.
- `DeployOptions` lives in `types/options.ts` and `DeployResult.scan?` in `types/results.ts` — both T3's. If T3 has not landed, that is a dependency failure, not licence to edit them.
- The dry-run text line is asserted verbatim: `would block deploy (--scan-fail-on high)`.
- `plan.ts` uses `console.error`, `deploy.ts` uses `logInfo`. Mixing them is a real inconsistency reviewers will flag.
- `resolveScanSettings` throws `InvalidArgumentError` (exit 2). Do not wrap it in try/catch.
- Run gates under `umask 022` with `FORCE_COLOR` unset. A fresh worktree needs `npm ci` + `npm run build -w packages/rf-common` once, serially.
- Add no tests beyond the two cases.

---

## T5 — Harden command + action (#162)

**Owns (all NEW):** `P/src/commands/harden.ts`, `P/src/actions/harden.ts`, `P/src/actions/harden.spec.ts`
**Depends on:** T3
**Wave:** 3

### 0. Decisions that override the original design

**GAP 1 — `validateHardenOptions` takes two arguments.** The design declares `validateHardenOptions(options: RawHardenOptions): void` but then requires the rule "`--apply` with a machine `--output` and without `--yes`". `--output`/`--yes` are **program-level** globals (`P/src/cli.ts:123-134`), absent from `RawHardenOptions`. Corrected signature (mirroring `validateBackupCreateOptions`, `P/src/commands/backup.ts:54-58`):

```ts
export function validateHardenOptions(options: RawHardenOptions, globalOptions: HardenGlobalOptions): void;
```

T6 calls it in the `preAction` hook with the same globals shape backup uses.

**GAP 2 — `--include-review` is legal in every mode.** It widens `filterWritableProposals`, which produces the override fragment that **propose mode prints**. Rejecting it would make `rfapps harden --include-review` a usage error. Only `--allow-reformat` and `--no-backup` require `--apply`.

**GAP 3 — apply mode with zero writable proposals keeps `mode: "apply"`.** Set `write = { mode: "apply", path: composePath, patchesWritten: 0, servicesPatched: [] }`, log `No writable patches; compose.yml unchanged`, write nothing, and fall through to normal reporting. Exit stays 0.

**GAP 4 — `--dry-run` falls through to reporting, not `return`.** Log `formatDryRun(...)`, set the mode-appropriate `write` with `patchesWritten: 0`, skip the filesystem call, continue to the output step.

**GAP 5 — the reformat guard fires even under `--dry-run`.** Evaluate `wouldReformat && !allowReformat` **before** the dry-run branch, so `--dry-run --apply` also exits 2 on a would-reformat compose. A dry run that "succeeds" where the real run errors is a broken preview.

**GAP 6 — env tool: use the 2-argument config-aware form** `getEnvToolExecConfig(globalOptions, finalConfig)` (the `lint.ts:368` shape), computed **after** `applyCliOverrides`. Rationale (corrected): this is a **new** command, and `lint` — the closest model, since both resolve compose to evaluate rules — is config-aware. The 1-argument `audit.ts:68` form ignores a config-declared `envTool` (this repo declares `envTool.tool: dotenvx` + `envFile: .env.local`). The 2-arg form is a strict superset. **Do not "fix" `plan.ts`, `deploy.ts`, or `audit.ts` to match — they are not yours and their behaviour is pre-existing.**

**GAP 7 — `--json` must actually work.** `cli.ts:130-134` gives the global `--output` option `.default("text")`, so `globalOptions.output` is **never `undefined`**. The `resolveAuditFormat` ordering (global `--output` first) would therefore make a command-local `--json` dead. Since T7 completes `--json` in three shells and T8/T9 document it as functional, `resolveHardenFormat` checks `rawOptions.json` **first**:

```ts
function resolveHardenFormat(rawOptions: RawHardenOptions, globalOptions: HardenGlobalOptions): OutputFormat {
  // Command-local --json is checked first because cli.ts defaults the global
  // --output to "text", so globalOptions.output is never undefined and an
  // audit.ts-ordered check would make this flag permanently dead.
  if (rawOptions.json === true) {
    return "json";
  }
  if (globalOptions.output !== undefined) {
    return globalOptions.output;
  }
  if (globalOptions.json === true) {
    return "json";
  }
  return "text";
}
```

Known, accepted precedence quirk: `rfapps --output yaml harden --json` yields json. `audit.ts`'s identical pre-existing dead-flag bug is **out of scope** — do not touch `audit.ts`.

**GAP 8 — `HardenPatchOperation` has no `"remove"` arm and `HardenOptions` has no `listRules` field** (T2's cut). Do not reference either.

**GAP 9 — canonical command description string** is exactly `"Propose or apply compose security hardening"`. T7's completion templates and T9's docs copy it verbatim.

### 1. Contracts you consume (do not implement them)

From `../lib/index.js` (T3 re-exports these from T2's modules; import from the **barrel**, matching `audit.ts:13-23`):

```
evaluateHardening, filterWritableProposals, normalizeHardenSuppressions, parseHardenRuleIds,
detectReformat, applyHardenPatches, buildHardenOverride, buildHardenSummary,
formatHardenText, formatHardenRulesCatalog
```

plus the shipped `applyCliOverrides, getComposeConfig, isValidProfile, loadConfig, resolveServicesWithInteractive`.

From `../types/hardening.js` (direct import, as `audit.ts:24-25` does): value `HARDEN_SCHEMA_VERSION`; types `HardenComposeConfig, HardenMode, HardenOptions, HardenResult, HardenWriteOutcome`.

From `../lib/exit-codes.js` (direct, never the barrel — `deploy.ts:35`, `lint.ts:17`): `ExitCode, setExitCode, setHardenExitCode`.

If any name is missing, **stop** — T3 has not landed. Do not stub.

### 2. `P/src/commands/harden.ts` (NEW, ~110 lines)

Structure model: `P/src/commands/backup.ts` (injected-dependency registrar). Wording model: `P/src/commands/audit.ts`.

**Hard contract with T7:** exactly these **15 long options, no others**, in this order — `--service, --services, --group, --no-sidecars, --apply, --out, --include-review, --rule, --list-rules, --no-backup, --allow-reformat, --compose, --env-file, --profile, --json`. T7's bash/zsh/fish parity tests derive the set from `command.options`; adding, renaming, or omitting one breaks three shells.

**Help-text constraint:** inside `addHelpText("after", …)`, **no indented line may begin with `-`**. `getCommanderCommandOptions` keeps every help line matching `/^\s+-/` and harvests every `--word` from it.

```ts
import type { Command } from "commander";

import type { HardenGlobalOptions, RawHardenOptions } from "../actions/harden.js";
import { InvalidArgumentError } from "../lib/errors.js";

type ExecuteHarden = (rawOptions: RawHardenOptions, globalOptions: HardenGlobalOptions) => Promise<void>;

/** Lazily loaded action module, injectable so option wiring stays testable. */
export interface HardenCommandDependencies {
  loadAction(): Promise<{ executeHarden: ExecuteHarden }>;
}

const defaultDependencies: HardenCommandDependencies = {
  loadAction: () => import("../actions/harden.js"),
};

function isMachineOutput(globalOptions: HardenGlobalOptions): boolean {
  const format = globalOptions.output ?? (globalOptions.json === true ? "json" : "text");
  return format === "json" || format === "yaml";
}

/**
 * Reject incoherent harden flag combinations before config, Docker, or the
 * state lock are touched.
 *
 * The root CLI pre-action hook invokes this ahead of lock acquisition; the
 * action repeats it so independently embedded registrars stay guarded.
 *
 * @throws {InvalidArgumentError} On mutually exclusive or unsupported combinations
 */
export function validateHardenOptions(options: RawHardenOptions, globalOptions: HardenGlobalOptions): void {
  if (options.listRules === true) {
    return; // The catalog ignores every other flag.
  }
  if (options.apply === true && options.out !== undefined) {
    throw new InvalidArgumentError(
      "--apply",
      "true",
      "Cannot combine --apply with --out; --out writes a non-destructive override instead",
    );
  }
  if (options.allowReformat === true && options.apply !== true) {
    throw new InvalidArgumentError(
      "--allow-reformat",
      "true",
      "Only meaningful with --apply; propose and --out never rewrite compose.yml",
    );
  }
  if (options.backup === false && options.apply !== true) {
    throw new InvalidArgumentError(
      "--no-backup",
      "false",
      "Only meaningful with --apply; propose and --out never rewrite compose.yml",
    );
  }
  if (options.apply === true && isMachineOutput(globalOptions) && globalOptions.yes !== true) {
    throw new InvalidArgumentError(
      "--yes",
      "false",
      "Machine-format --apply requires explicit --yes; a prompt cannot be answered in a JSON pipeline",
    );
  }
}

/** Register the compose hardening command. Non-destructive unless --apply or --out. */
export function registerHardenCommand(
  program: Command,
  dependencies: HardenCommandDependencies = defaultDependencies,
): void {
  program
    .command("harden")
    .description("Propose or apply compose security hardening")
    .configureHelp({ showGlobalOptions: true })
    .option("-s, --service <name>", "Target a specific service")
    .option("--services <names>", "Target multiple services (comma-separated)")
    .option("-g, --group <name>", "Target a service group")
    .option("--no-sidecars", "Disable automatic sidecar linking")
    .option("--apply", "Edit compose.yml in place (requires confirmation)", false)
    .option("-o, --out <path>", "Write a compose override fragment to <path>")
    .option("--include-review", "Include review-confidence rules in written output", false)
    .option("--rule <ids>", "Restrict to a comma-separated rule allowlist")
    .option("--list-rules", "Print the rule catalog and exit", false)
    .option("--no-backup", "Skip the compose.yml.bak copy taken before --apply")
    .option("--allow-reformat", "Accept incidental YAML reformatting of untouched lines", false)
    .option("-f, --compose <path>", "Path to Docker Compose file")
    .option("-e, --env-file <path>", "Path to environment file")
    .option("-p, --profile <name>", "Docker Compose profile to use")
    .option("--json", "Output the harden result in JSON format", false)
    .addHelpText(
      "after",
      `
Non-destructive by default: with no write flag, harden resolves compose
configuration, reports proposed hardening, and prints an editable compose
override fragment. It writes nothing and does not touch containers, images, or
recorded state.

Proposals are split by confidence. Safe changes are mechanical and
workload-neutral. Review changes (cap_drop ALL, read-only rootfs, non-root
user) can break a workload and are excluded from writes unless --include-review
is passed. Health checks and resource limits are advisory only: rfapps will not
invent a probe command or a memory ceiling.

--apply refuses any edit whose target key is a YAML alias, because that would
change every service sharing the anchor; the refusal names the --out
alternative. It also refuses when serializing compose.yml would reformat lines
this command did not target, unless --allow-reformat is passed.

Rule suppressions come from the harden.ignore section of rfapps.config.yaml.

Exit codes:
  0  Proposals reported, override written, or apply completed
  1  Compose resolution failed, or a write failed
  2  Usage error, or reformatting untargeted lines was refused
  3  Apply completed with some patches refused`,
    )
    .action(async (options: RawHardenOptions) => {
      const globalOptions = program.opts<HardenGlobalOptions>();
      validateHardenOptions(options, globalOptions);
      const { executeHarden } = await dependencies.loadAction();
      await executeHarden(options, globalOptions);
    });
}
```

`--no-backup`/`--no-sidecars`: Commander defaults `backup`/`sidecars` to `true`; "was it passed" is `=== false`. `-o` is free (globals define no `-o`). Do not add a `--fail-on`. Do not create a `commands/harden.spec.ts`.

### 3. `P/src/actions/harden.ts` (NEW, ~300 lines)

Body order copied from `P/src/actions/audit.ts:55-170`, with the mutation envelope from `P/src/actions/drift.ts:740-778`.

**Imports:**

```ts
/**
 * Compose security hardening action for rfapps CLI.
 *
 * Detects hardening opportunities in the resolved compose configuration and,
 * on request, writes them back either as a compose override fragment or as an
 * in-place edit of compose.yml. Propose mode writes nothing.
 */

import { copyFile, readFile, writeFile } from "node:fs/promises";

import {
  confirm,
  formatDryRun,
  formatError,
  isMachineFormat,
  logDebug,
  logInfo,
  outputFormattedError,
} from "@rfmedia/common";
import type { OutputFormat } from "@rfmedia/common";

import { hasCode } from "../lib/backup-storage-shared.js";
import { DockerCommandError, InvalidArgumentError } from "../lib/errors.js";
import { ExitCode, setExitCode, setHardenExitCode } from "../lib/exit-codes.js";
import { formatOutput } from "../lib/formatters/index.js";
import {
  applyCliOverrides,
  applyHardenPatches,
  buildHardenOverride,
  buildHardenSummary,
  detectReformat,
  evaluateHardening,
  filterWritableProposals,
  formatHardenRulesCatalog,
  formatHardenText,
  getComposeConfig,
  isValidProfile,
  loadConfig,
  normalizeHardenSuppressions,
  parseHardenRuleIds,
  resolveServicesWithInteractive,
} from "../lib/index.js";
import { HARDEN_SCHEMA_VERSION } from "../types/hardening.js";
import type {
  HardenComposeConfig,
  HardenMode,
  HardenOptions,
  HardenResult,
  HardenWriteOutcome,
} from "../types/hardening.js";
import { getEnvToolExecConfig } from "../types/index.js";

import { validateHardenOptions } from "../commands/harden.js";
```

`hasCode` is the shipped errno helper at `P/src/lib/backup-storage-shared.ts:85` — do not hand-roll a fifth copy. The `../commands/harden.js` value import is cycle-free because `commands/harden.ts` imports only _types_ from the action (erased by `verbatimModuleSyntax`) and loads the action lazily.

**Exported option types:**

```ts
/** Raw Commander option values for `rfapps harden`. */
export interface RawHardenOptions {
  readonly service?: string;
  readonly services?: string;
  readonly group?: string;
  readonly sidecars?: boolean;
  readonly apply?: boolean;
  readonly out?: string;
  readonly includeReview?: boolean;
  readonly rule?: string;
  readonly listRules?: boolean;
  readonly backup?: boolean;
  readonly allowReformat?: boolean;
  readonly compose?: string;
  readonly envFile?: string;
  readonly profile?: string;
  readonly json?: boolean;
}

/** Program-level options harden reads. Mirrors `BackupGlobalOptions` (`actions/backup.ts:76-85`). */
export interface HardenGlobalOptions {
  readonly dryRun?: boolean;
  readonly debug?: boolean;
  readonly json?: boolean;
  readonly output?: OutputFormat;
  readonly verbose?: boolean;
  readonly yes?: boolean;
  readonly useDotenvx?: string;
  readonly useOp?: string;
}
```

Then `resolveHardenFormat` exactly as in GAP 7.

**`executeHarden`, step by step:**

```ts
export async function executeHarden(
  rawOptions: RawHardenOptions,
  globalOptions: HardenGlobalOptions,
): Promise<void> {
```

1. `const format = resolveHardenFormat(rawOptions, globalOptions);`
2. `validateHardenOptions(rawOptions, globalOptions);` — idempotent; guards embedded registrars and the spec.
3. `--list-rules` short circuit (model `lint.ts:339-342`):

   ```ts
   if (rawOptions.listRules === true) {
     for (const line of formatHardenRulesCatalog()) console.error(line);
     return;
   }
   ```

4. Derive mode:

   ```ts
   const mode: HardenMode = rawOptions.apply === true ? "apply" : rawOptions.out !== undefined ? "override" : "propose";
   ```

5. Config + profile guard (verbatim from `audit.ts:92-96`) + **2-arg** env tool:

   ```ts
   const config = await loadConfig();
   if (rawOptions.profile !== undefined && !isValidProfile(rawOptions.profile, config)) {
     throw new InvalidArgumentError("--profile", rawOptions.profile, "Invalid profile", [
       ...config.profiles.validProfiles,
     ]);
   }
   const finalConfig = applyCliOverrides(config, {
     composePath: rawOptions.compose,
     envFile: rawOptions.envFile,
     profile: rawOptions.profile,
     noSidecars: rawOptions.sidecars === false,
   });
   const envTool = getEnvToolExecConfig(globalOptions, finalConfig);
   ```

6. Build `HardenOptions` (note: **no `listRules` field**) and log it:

   ```ts
   const includeReview = rawOptions.includeReview === true || (finalConfig.harden?.includeReview ?? false);
   const backup = rawOptions.backup !== false && (finalConfig.harden?.backup ?? true);
   const rules = parseHardenRuleIds(rawOptions.rule) ?? finalConfig.harden?.rules;
   const suppressions = normalizeHardenSuppressions(finalConfig.harden?.ignore ?? []);

   const options: HardenOptions = {
     dryRun: globalOptions.dryRun ?? false,
     debug: globalOptions.debug ?? false,
     json: globalOptions.json ?? false,
     verbose: globalOptions.verbose ?? false,
     yes: globalOptions.yes ?? false,
     useDotenvx: globalOptions.useDotenvx,
     useOp: globalOptions.useOp,
     service: rawOptions.service,
     services: rawOptions.services?.split(",").map((service) => service.trim()),
     group: rawOptions.group,
     noSidecars: rawOptions.sidecars === false,
     composePath: rawOptions.compose,
     envFile: rawOptions.envFile,
     profile: rawOptions.profile,
     apply: rawOptions.apply === true,
     overridePath: rawOptions.out,
     includeReview,
     rules,
     backup,
     allowReformat: rawOptions.allowReformat === true,
     output: format,
   };
   logDebug(`Harden options: ${JSON.stringify(options)}`);
   ```

   `parseHardenRuleIds` and `normalizeHardenSuppressions` throw `InvalidArgumentError` on unknown ids — let them propagate (exit 2).

7. `resolveServicesWithInteractive` — copy `audit.ts:105-122` exactly (same five arguments, `if (resolved === null) return;`), then `const { services, profiles } = resolved; const targets = services.length > 0 ? services : undefined;`.
8. Compose resolution + never-thrown failure path (copy `audit.ts:126-143`, but use `setExitCode`):

   ```ts
   const composeConfig = await getComposeConfig(finalConfig.composePath, {
     profiles,
     envFile: finalConfig.envFile,
     envTool,
   });
   if (composeConfig === undefined) {
     const error = new DockerCommandError(
       "config",
       "Failed to get compose config",
       1,
       services.length > 0 ? services : ["all"],
       false,
     );
     outputFormattedError(formatError(error));
     setExitCode(ExitCode.OperationalError);
     return;
   }
   ```

9. Evaluate + compute the patch set in **every** mode, so propose reports exactly the refusals `--apply` would hit:

   ```ts
   const { proposals, suppressed } = evaluateHardening(composeConfig as unknown as HardenComposeConfig, targets, {
     suppressions,
     rules,
   });
   const timestamp = new Date().toISOString();
   const source = await readFile(finalConfig.composePath, "utf8");
   const reformat = detectReformat(source);
   const writable = filterWritableProposals(proposals, includeReview);
   const patched = applyHardenPatches(source, writable);
   const overrideDoc = buildHardenOverride(writable, {
     composePath: finalConfig.composePath,
     timestamp,
     includeReview,
   });
   ```

   The `as unknown as HardenComposeConfig` double cast is the deliberate, precedented one (`lint.ts:410`, `audit.ts:145`) — `ComposeServiceConfig` is much wider than `HardenComposeService`.

10. Mode branch producing `write` + `patchesWritten` (order is load-bearing — GAP 3/4/5):

    ```ts
    let write: HardenWriteOutcome = { mode: "propose" };
    let patchesWritten = 0;

    if (mode === "override") {
      const overridePath = rawOptions.out as string;
      if (overrideDoc.content === "") {
        logInfo(`No writable patches; nothing written to ${overridePath}`);
        write = { mode: "override", path: overridePath, patchesWritten: 0 };
      } else if (options.dryRun) {
        logInfo(formatDryRun(`write compose override fragment to ${overridePath}`));
        write = { mode: "override", path: overridePath, patchesWritten: 0 };
      } else {
        try {
          await writeFile(overridePath, overrideDoc.content, { encoding: "utf8", flag: "wx" });
        } catch (error) {
          if (hasCode(error, "EEXIST")) {
            throw new InvalidArgumentError("--out", overridePath, "file already exists");
          }
          const message = error instanceof Error ? error.message : String(error);
          outputFormattedError(formatError(new DockerCommandError("harden", message, 1, services, false)));
          setExitCode(ExitCode.OperationalError);
          return;
        }
        patchesWritten = overrideDoc.patchesWritten;
        write = { mode: "override", path: overridePath, patchesWritten };
      }
    } else if (mode === "apply") {
      const composePath = finalConfig.composePath;
      if (reformat.wouldReformat && !options.allowReformat) {
        throw new InvalidArgumentError(
          "--apply",
          "true",
          `writing compose.yml would also reformat lines this command did not target (line delta: ${reformat.lineDelta}); re-run with --allow-reformat to accept, or use --out for a non-destructive override`,
        );
      }
      if (writable.length === 0) {
        logInfo("No writable patches; compose.yml unchanged");
        write = { mode: "apply", path: composePath, patchesWritten: 0, servicesPatched: [] };
      } else if (options.dryRun) {
        logInfo(
          formatDryRun(
            `apply ${patched.patchesWritten} hardening patch(es) to ${patched.servicesPatched.length} service(s) in ${composePath}`,
          ),
        );
        write = { mode: "apply", path: composePath, patchesWritten: 0, servicesPatched: [] };
      } else {
        if (!options.yes && !isMachineFormat(format)) {
          const confirmed = await confirm(
            `Apply ${patched.patchesWritten} hardening patch(es) to ${patched.servicesPatched.length} service(s) in ${composePath}?`,
          );
          if (!confirmed) {
            logInfo("Cancelled");
            return;
          }
        }
        const backupPath = `${composePath}.bak`;
        try {
          if (backup) {
            await copyFile(composePath, backupPath);
          }
          await writeFile(composePath, patched.content, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outputFormattedError(
            formatError(new DockerCommandError("harden", message, 1, [...patched.servicesPatched], false)),
          );
          setExitCode(ExitCode.OperationalError);
          return;
        }
        patchesWritten = patched.patchesWritten;
        write = {
          mode: "apply",
          path: composePath,
          ...(backup ? { backupPath } : {}),
          patchesWritten,
          servicesPatched: patched.servicesPatched,
        };
      }
    }
    ```

    `DockerCommandError`'s 4th parameter is `string[]` while `servicesPatched` is `readonly string[]` — spread it.

11. Assemble, render, exit:

    ```ts
    const result: HardenResult = {
      schemaVersion: HARDEN_SCHEMA_VERSION,
      timestamp,
      mode,
      includeReview,
      scope: { services, profiles, composePath: finalConfig.composePath },
      summary: buildHardenSummary(proposals, suppressed, patchesWritten, patched.refusals),
      proposals,
      refusals: patched.refusals,
      reformat,
      override: overrideDoc.content,
      write,
    };

    if (format !== "text") {
      await formatOutput(format, result);
    } else {
      for (const line of formatHardenText(result)) {
        console.error(line);
      }
    }

    setHardenExitCode(result);
    ```

    Do **not** special-case `table`/`csv`. `setHardenExitCode` is called last so the operational/usage exits above win.

Add JSDoc on `executeHarden`, `RawHardenOptions`, `HardenGlobalOptions` at `audit.ts`/`drift.ts` density.

### 4. `P/src/actions/harden.spec.ts` (NEW) — exactly 4 cases

Mocking model: `P/src/actions/audit.spec.ts:1-100` (partial `importOriginal` mocks so the **real** hardening engine runs) plus `vi.mock("node:fs/promises")`.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as common from "@rfmedia/common";
import * as fs from "node:fs/promises";

import { InvalidArgumentError } from "../lib/errors.js";
import { formatOutput } from "../lib/formatters/index.js";
import * as lib from "../lib/index.js";
import { executeHarden } from "./harden.js";

vi.mock("../lib/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/index.js")>();
  return {
    ...actual,
    applyCliOverrides: vi.fn(),
    getComposeConfig: vi.fn(),
    isValidProfile: vi.fn(),
    loadConfig: vi.fn(),
    resolveServicesWithInteractive: vi.fn(),
  };
});

vi.mock("../lib/formatters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/formatters/index.js")>();
  return { ...actual, formatOutput: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@rfmedia/common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rfmedia/common")>();
  return {
    ...actual,
    confirm: vi.fn(),
    formatError: vi.fn(),
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    outputFormattedError: vi.fn(),
  };
});

vi.mock("node:fs/promises");
```

Leave `isMachineFormat` and `formatDryRun` **real** — the confirm gate depends on `isMachineFormat("text") === false`.

Fixtures (copy the `config` literal from `audit.spec.ts:39-56` verbatim; `RfappsConfig.harden` is optional so it needs no `harden` key):

```ts
// Round-trips byte-identically under { lineWidth: 0, flowCollectionPadding: false }
// (verified with the repo's own yaml@2.9.0), so detectReformat -> wouldReformat: false
// and the --apply reformat guard never fires in these cases.
const composeSource = "services:\n  sonarr:\n    image: sonarr:latest\n";

const composeConfig = {
  services: {
    sonarr: {
      name: "sonarr",
      image: "sonarr:latest",
      restart: "unless-stopped",
      user: "1000:1000",
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
      healthcheck: { test: ["CMD", "true"] },
      deploy: { resources: { limits: { memory: "1g", cpus: "1.0" } } },
      // no security_opt  -> harden-no-new-privileges (safe)
      // no cap_drop      -> harden-cap-drop-all      (review)
      // no read_only     -> harden-read-only-rootfs  (review)
    },
  },
};
```

`beforeEach` mirrors `audit.spec.ts:72-95` plus `vi.mocked(fs.readFile).mockResolvedValue(composeSource)`, `vi.mocked(fs.writeFile).mockResolvedValue()`, `vi.mocked(fs.copyFile).mockResolvedValue()`, and `vi.mocked(lib.resolveServicesWithInteractive).mockResolvedValue({ services: ["sonarr"], profiles: ["core"], preSidecarCount: 1, sidecarsExpanded: false })`. Save/restore `process.exitCode` and spy on `console.error` exactly as `audit.spec.ts:69-100` does.

The four cases:

1. **`"propose mode writes nothing"`** — `await executeHarden({}, { yes: true, output: "json" });` then `expect(fs.writeFile).not.toHaveBeenCalled()`, `expect(fs.copyFile).not.toHaveBeenCalled()`, and `expect(formatOutput).toHaveBeenCalledWith("json", expect.objectContaining({ schemaVersion: "harden.v1", mode: "propose", write: { mode: "propose" }, summary: expect.objectContaining({ applied: 0 }) }))`.
2. **`"--apply cancelled at the prompt writes nothing"`** — `vi.mocked(common.confirm).mockResolvedValue(false)`, then `await executeHarden({ apply: true }, {})` (text format, `yes` falsy); assert `confirm` called once, `writeFile`/`copyFile` not called, `process.exitCode` undefined.
3. **`"rejects --apply together with --out"`** — `await expect(executeHarden({ apply: true, out: "compose.harden.yaml" }, { yes: true })).rejects.toThrow(InvalidArgumentError)` and `expect(lib.loadConfig).not.toHaveBeenCalled()` (proves validation precedes config/Docker — mirrors `audit.spec.ts:158-163`).
4. **`"keeps review proposals out of written output without --include-review"`** — `await executeHarden({}, { yes: true, output: "json" });` capture `vi.mocked(formatOutput).mock.calls[0]?.[1] as HardenResult`, then assert `proposals` contains `expect.objectContaining({ ruleId: "harden-read-only-rootfs", confidence: "review" })`; `result.override` contains `"no-new-privileges"`; `result.override` does **not** contain `"read_only"`; `summary.applied === 0`.

**Do not add a fifth case. Do not create `commands/harden.spec.ts`.**

### 5. Conventions

- ESM `.js` extensions. No `any`. The two `as unknown as` casts named above are the only casts and both are precedented.
- `verbatimModuleSyntax`: types via `import type`, values via plain `import`.
- `noUncheckedIndexedAccess`: `mock.calls[0]?.[1]` needs the optional chain plus a single `as HardenResult`.
- Logging to **stderr** via `logInfo`/`logDebug`/`console.error` — never `console.log`.
- Error posture: usage/flag problems **throw** `InvalidArgumentError` (exit 2 centrally); operational failures are **locally formatted** with `outputFormattedError(formatError(new DockerCommandError(...)))` + `setExitCode(ExitCode.OperationalError)` + `return`.
- Both source files stay well under the ~500-line cap.

### Acceptance

- [ ] `commands/harden.ts` exports `registerHardenCommand`, `validateHardenOptions(options, globalOptions)`, and `HardenCommandDependencies`; the command's `.description()` is exactly `Propose or apply compose security hardening`.
- [ ] The command declares exactly 15 long options: service, services, group, no-sidecars, apply, out, include-review, rule, list-rules, no-backup, allow-reformat, compose, env-file, profile, json — no more, no fewer. Verify with `FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts harden --help` once T6 lands, or via `program.commands.find(c => c.name()==='harden').options` locally.
- [ ] `actions/harden.ts` exports `executeHarden`, `RawHardenOptions`, `HardenGlobalOptions`.
- [ ] `resolveHardenFormat` checks `rawOptions.json === true` **before** `globalOptions.output`; `grep -n 'rawOptions.json' packages/rfapps-cli/src/actions/harden.ts` shows it above the `globalOptions.output` check.
- [ ] `validateHardenOptions` throws `InvalidArgumentError` for: `--apply` with `--out`; `--allow-reformat` without `--apply`; `--no-backup` without `--apply`; `--apply` with json/yaml output and without `--yes`. It returns early when `--list-rules` is set and **never** rejects `--include-review`.
- [ ] Propose mode performs zero `writeFile`/`copyFile` calls and produces `write: { mode: "propose" }` with `summary.applied === 0`.
- [ ] Apply mode throws `InvalidArgumentError("--apply", …)` when `detectReformat(source).wouldReformat` and `--allow-reformat` was not passed — **including under `--dry-run`**.
- [ ] Apply mode prompts via `confirm` when neither `--yes` nor a machine format is in effect; a `false` answer logs `Cancelled`, writes nothing, leaves `process.exitCode` unset.
- [ ] Override mode writes with `{ encoding: "utf8", flag: "wx" }` and converts `EEXIST` into `InvalidArgumentError("--out", path, "file already exists")`.
- [ ] Compose-resolution failure emits a formatted `DockerCommandError` and `setExitCode(ExitCode.OperationalError)` without throwing.
- [ ] `getEnvToolExecConfig` is called with **two** arguments, after `applyCliOverrides`.
- [ ] `setHardenExitCode(result)` is the final statement on every successful reporting path.
- [ ] `HardenOptions` is constructed without a `listRules` property, and no code references a `"remove"` patch operation.
- [ ] `actions/harden.spec.ts` contains exactly 4 `it(...)` cases; no `commands/harden.spec.ts` exists.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` passes with no new errors.
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/harden.spec.ts` passes.
- [ ] `git diff --name-only` lists only the three owned files; `audit.ts`, `plan.ts`, `deploy.ts` are untouched.

### Pitfalls

- `validateHardenOptions` **cannot** have a single-parameter signature — the machine-output/`--yes` rule needs program globals. Tell T6 to call it with the backup-shaped globals object.
- Do not gate `--include-review` on a write mode; propose mode prints the override fragment and test case 4 depends on it.
- **`--json` would be dead** with the `audit.ts` ordering because `cli.ts` defaults `--output` to `"text"`. Check `rawOptions.json` first. Do not "fix" `audit.ts`.
- `vi.mock("../lib/index.js")` MUST use the `importOriginal` spread form here (`audit.spec.ts:9-19`). A bare automock (the `deploy.spec.ts` form) would stub out the real `evaluateHardening`/`applyHardenPatches`/`buildHardenOverride` and cases 1, 2, 4 would assert on `undefined`.
- The compose **source** fixture must round-trip byte-identically under `{ lineWidth: 0, flowCollectionPadding: false }`, or `detectReformat` reports `wouldReformat: true` and the `--apply` case throws before reaching `confirm`. `"services:\n  sonarr:\n    image: sonarr:latest\n"` was verified to round-trip exactly.
- `--no-backup`/`--no-sidecars` are Commander negations: test `=== false`, never falsiness. `!options.backup` is true on a default invocation and fires the wrong error.
- `DockerCommandError`'s 4th parameter is `string[]`; spread `patched.servicesPatched`.
- Do not add a sign prefix to the reformat message — `lineDelta` is `out − src` and is **−6** on this repo. Interpolate the raw number.
- Import `hasCode` from `../lib/backup-storage-shared.js`; the repo already carries four private copies.
- The action's value import of `validateHardenOptions` stays cycle-free only because `commands/harden.ts` imports the action's types with `import type` and loads it lazily inside `.action()`.
- `getEnvToolExecConfig` must be called **after** `applyCliOverrides` with **two** arguments.
- T7's parity tests derive harden's option set from `registerHardenCommand`. Any extra, renamed, or missing flag fails bash, zsh, and fish parity in a task you do not own.
- Inside `addHelpText("after", …)`, never start an indented line with `-`.
- `HardenPatchOperation` has no `"remove"` arm and `HardenOptions` has no `listRules` field.
- Run gates with `env -u FORCE_COLOR` under `umask 022`.

---

## T6 — `cli.ts` wiring

**Owns (MODIFIED):** `P/src/cli.ts`
**Depends on:** T4, T5
**Wave:** 4

**One file. No new files. No spec file — write zero tests.** Completion parity coverage belongs to T7.

`cli.ts` is 767 lines today and grows by ~45. The ~500 soft cap exempts inherently contiguous content; this is a flat command registry. **Do not refactor it.**

Seven edits, in file order. Apply them **bottom-up** (Edit 7 first) or re-locate by the quoted text after each insertion.

### Edit 1 — import the registrar

Anchor `:53-54`, inside the alphabetical registrar import block (`:45-57`):

```ts
import { registerForceUnlockCommand } from "./commands/force-unlock.js";
import { registerImportCommand } from "./commands/import.js";
```

Insert **between** them (force-unlock → harden → import):

```ts
import { registerHardenCommand, validateHardenOptions } from "./commands/harden.js";
```

83 chars, under `printWidth: 100`. Both are value imports; no `import type`.

### Edit 2 — `harden` branch in `resolveStateLockOperation`

Anchor `:107-112`:

```ts
if (commandName === "plan" || commandName === "update") {
  return options["apply"] === true ? commandName : undefined;
}
if (commandName === "reconcile") {
  return options["autoApply"] === true ? commandName : undefined;
}
```

Insert between the two blocks (after `:109`):

```ts
if (commandName === "harden") {
  // Propose and --out are read-only; only --apply writes compose.yml, the
  // same shared resource `drift import` locks.
  return options["apply"] === true ? "harden" : undefined;
}
```

`harden` must **not** be added to `ALWAYS_MUTATING_COMMANDS` (`:69-79`). `acquireStateLock` takes a free-form `operation: string` (`src/lib/state-lock.ts:35`), so there is no enum to update. The `globalOptions["dryRun"] === true` early return at `:85-87` already covers `--dry-run --apply`. `noPropertyAccessFromIndexSignature` requires bracket access.

### Edit 3 — (no edit; numbering preserved)

### Edit 4 — `harden` case in the `preAction` hook

Anchor `:196-203`:

```ts
    } else if (backupVerify) {
      validateBackupVerifyOptions(actionCommand.args[0] ?? "", {
        json: opts["json"] as boolean | undefined,
        output: resolvedOutputFormat,
      });
    }

    if (
      commandName === "deploy" &&
```

Insert a standalone block after the `}` at `:201` (keep the blank line at `:202` and the deploy blocks contiguous below it):

```ts
if (commandName === "harden") {
  // Reject incoherent write-mode combinations before the state lock is
  // taken; `executeHarden` repeats the check for embedded registrars.
  validateHardenOptions(actionCommand.opts(), {
    dryRun: opts["dryRun"] as boolean | undefined,
    json: opts["json"] as boolean | undefined,
    output: resolvedOutputFormat,
    yes: opts["yes"] as boolean | undefined,
  });
}
```

**Before writing this, open `packages/rfapps-cli/src/commands/harden.ts` and confirm the exported signature is the two-argument form.** T5's brief mandates it. If T5 shipped a one-argument form, call `validateHardenOptions(actionCommand.opts());` and note in the commit body that the machine-output/`--yes` rule is enforced only inside `executeHarden`. **Do not edit `commands/harden.ts` — it is not your file.**

Typing detail (verified): `Command.opts<T extends OptionValues>(): T` has no default type argument, so `T` is inferred from the parameter type. An `interface RawHardenOptions { readonly service?: string; … }` satisfies `OptionValues = Record<string, any>` through that inference path — the identical pattern already compiles at `:186-195` for `validateBackupCreateOptions`. No cast, no `as`, no `any`.

Placement rationale (must hold): the hook acquires the state lock at `:331-334`, so validation at `:202` runs strictly before the lock. Do not move it below that. `InvalidArgumentError` propagates out of `parseAsync` to `main()`'s catch and `handleCliError`, whose formatter uses `ExitCode.UsageError` (`src/lib/error-formatters.ts:255`) — exit 2, as required. Nothing to add.

### Edit 5 — deploy: three scan flags + help paragraph

**5a — flags.** Anchor `:428-433`:

```ts
  .option("--validate-first", "Validate Docker resource conflicts before deploying", false)
  .option(
    "--allow-partial",
```

Insert immediately after `:428`, before `--allow-partial`:

```ts
  .option("--scan", "Scan resolved images for known vulnerabilities", false)
  .option("--scanner <name>", "Scanner backend: trivy, grype")
  .option(
    "--scan-fail-on <severity>",
    "Block at or above severity: none, unknown, negligible, low, medium, high, critical",
  )
```

Hard requirements:

- **Do not use `new Option(...).choices([...])`** for `--scanner` or `--scan-fail-on`, even though `--on-failure` at `:438-443` does. Both values may legitimately come from `scan.scanner`/`scan.failOn` in `rfapps.config.yaml`; validation is owned by `resolveScanSettings`, which raises `InvalidArgumentError` → exit 2. A Commander argParser/choices error exits **before** `.action()` ever runs.
- **Do not give `--scanner`/`--scan-fail-on` a Commander default.** `undefined` is what lets the config layer win. Only `--scan` gets `false`.
- Commander maps `--scan-fail-on` → `options.scanFailOn`, matching `RawDeployOptions.scanFailOn`. Do not rename.

**5b — help paragraph.** Anchor: the deploy `addHelpText` block, `:453-469`. Append a paragraph inside the same template literal, after the staged-rollout paragraph, so the literal ends `…and the exit code stays 0.\`,`:

```
Vulnerability scanning:
  Pass --scan to resolve the targeted images and scan each distinct image with
  trivy or grype, which must already be installed. The gate runs after conflict
  validation and before the confirmation prompt, so a blocked deploy never pulls
  an image or touches a container. Findings at or above --scan-fail-on block the
  deploy and exit 1; a scan that cannot complete is inconclusive and blocks the
  same way unless --scan-fail-on is none. Under --dry-run the report is printed,
  the gate is reported as would-block, and the exit code stays 0.
```

**Load-bearing formatting constraint:** `getCommanderCommandOptions` (`src/actions/completion.spec.ts:168-184`) keeps **every** `--help` line matching `/^\s+-/` — including `addHelpText` body lines — and extracts every `--word`. An indented line beginning with `-` injects phantom options into the parity set T7 must match. Line-initial characters above are `V P t v a d s U t` — all safe. Existing precedent: `cli.ts:463` starts with `Requires`.

### Edit 6 — plan: three scan flags + its first `addHelpText`

**6a — flags.** Anchor `:561-562`:

```ts
  .option("--explain", "Annotate changes with likely cause and dependency impact", false)
  .option("-f, --compose <path>", "Path to Docker Compose file")
```

Insert the **byte-identical** three options between them (after `:561`) so the two surfaces cannot drift.

**6b — help block.** Anchor `:564-568`:

```ts
  .option("-p, --profile <name>", "Docker Compose profile to use")
  .action(async (options) => {
```

Insert between the `-p, --profile` option and `.action(` — modelled on `lint`'s block at `:592-599`:

```ts
  .addHelpText(
    "after",
    `
Exit codes:
  0  Success
  1  Operational error
  2  Usage error

Vulnerability scanning:
  Pass --scan to resolve the targeted images and scan each distinct image with
  trivy or grype, which must already be installed. The plan file is written
  before the gate runs, so a blocked plan is still saved as evidence. Findings
  at or above --scan-fail-on exit 1 and suppress --apply; run rfapps apply
  <plan-file> to override. A scan that cannot complete is inconclusive and
  blocks the same way unless --scan-fail-on is none. --dry-run generates no
  plan, so it scans nothing.`,
  )
```

Same no-leading-dash constraint; line-initial characters are `E 0 1 2 V P t b a < b p`.

### Edit 7 — register `harden` after `lint`

Anchor `:600-605`:

```ts
  .action(async (options) => {
    const { executeLint } = await import("./actions/lint.js");
    await executeLint(options, program.opts());
  });

// Apply command
```

Insert after the `});` at `:603` (blank line either side):

```ts
registerHardenCommand(program);
```

Placement is deliberate: Commander lists commands in registration order, so `rfapps --help` reads `lint → harden` (detect → remediate), mirroring `registerDriftCommand(program)` after `plan` at `:570`. **Do not** move it into the alphabetical registrar batch at `:376-383`.

### Conventions

- ESM `.js` extension on the new import.
- No `any`, no casts beyond the two `as boolean | undefined` reads copied verbatim from the existing hook idiom (`:189-192`).
- `noPropertyAccessFromIndexSignature`: bracket access on `opts`/`options`.
- No JSDoc — `cli.ts` documents only its module header; local rationale uses short `//` comments.
- Usage errors **throw**; this task adds no logging and no local error formatting.
- Run `npm run format` before finishing. Prettier does not reformat template-literal contents.

### What this task must NOT touch

`src/actions/completion.ts` / `completion.spec.ts` (T7); `src/actions/plan.ts`, `src/actions/deploy.ts`, `src/types/options.ts` (T3/T4); `src/commands/harden.ts` (T5); `src/mcp/schema.ts` / `src/mcp/adapters.ts` — **never add `scan`, `scanner`, or `scanFailOn` to an MCP input schema or adapter**; `ALWAYS_MUTATING_COMMANDS`; `packages/rfapps-cli/CLAUDE.md`, docs, `ROADMAP.md` (T9/T10/T11).

### Acceptance

- [ ] `git status --porcelain` shows exactly one modified file: `packages/rfapps-cli/src/cli.ts`.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` exits 0.
- [ ] `FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts deploy --help` lists `--scan`, `--scanner <name>`, `--scan-fail-on <severity>` immediately after `--validate-first` and ends with a `Vulnerability scanning:` paragraph.
- [ ] `FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts plan --help` lists the same three immediately after `--explain` and ends with an `Exit codes:` block followed by a `Vulnerability scanning:` paragraph.
- [ ] For both commands, `… --help | grep -nE '^[[:space:]]+-'` returns only Options-block lines — no line of the new help prose matches.
- [ ] `FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts harden --help` prints the harden option list, and `rfapps --help` lists `harden` immediately after `lint`.
- [ ] `FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts harden --apply --out /tmp/x.yaml` exits 2 (proves preAction validation runs before the state lock).
- [ ] `grep -n 'harden' packages/rfapps-cli/src/cli.ts` shows exactly four hits: import, `resolveStateLockOperation` branch, `preAction` case, `registerHardenCommand(program);` — and none inside `ALWAYS_MUTATING_COMMANDS`.
- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/completion.spec.ts` fails **only** the case `keeps deploy completions in exact parity with Commander without leaking deploy-only options to rebuild`, whose diff shows exactly `scan`, `scan-fail-on`, `scanner` missing from the completion script. Every other test in the package passes. **This failure is expected and is closed by T7.**
- [ ] `npm run format:check` passes.

### Pitfalls

- Read `validateHardenOptions`'s real signature from the landed `commands/harden.ts` before writing the call. Never edit that file to fit your preferred form.
- Adding `--scan*` to `deploy` breaks the pre-existing deploy parity case (`completion.spec.ts:529-557`), which spawns the real CLI and does exact set equality. That is expected wave ordering. **Do not "fix" it by editing `completion.ts`.**
- `getCommanderCommandOptions` harvests every `--word` from any help line matching `/^\s+-/`, including `addHelpText` bodies. Never start an indented help line with a hyphen; re-flow so flag mentions sit mid-line.
- No `.choices([...])` on `--scanner`/`--scan-fail-on`; a Commander argParser error exits before `.action()`.
- No Commander default on `--scanner`/`--scan-fail-on`.
- Do not add `harden` to `ALWAYS_MUTATING_COMMANDS`; it needs the dedicated `resolveStateLockOperation` branch so propose/`--out` stay lock-free.
- The preAction harden case must sit at ~`:202`, before the lock acquisition at `:331-334`.
- Never surface `scan`/`scanner`/`scanFailOn` on the MCP path; `schemaObject`'s strict check iterates `Object.keys`, so even `{ scan: undefined }` throws at runtime and typecheck cannot catch it.
- Anchors drift 1–3 lines: `--explain` is `:561` not `:563`; deploy's help block is `:453-469`; the `plan || update` lock branch is `:107-109`. Apply the edits bottom-up.
- Run gates with `env -u FORCE_COLOR` under `umask 022`; a fresh worktree needs `npm ci` + `npm run build -w packages/rf-common` once.
- `cli.ts` is already 767 lines; do not refactor or split it.

---

## T7 — Completion templates + parity tests

**Owns (both MODIFIED):** `P/src/actions/completion.ts` (1602 lines), `P/src/actions/completion.spec.ts` (735 lines)
**Depends on:** T6, T5, T2
**Wave:** 5

Every line number below is exact **as of HEAD `56eed039`**. If earlier waves shifted the files, re-anchor by searching for the quoted text.

### 0. Four corrections that override the design

1. **`--fail-on` insertion point.** `--fail-on)` starts at `:290`; `:293` is the `else` of its inner `if`. Inserting there splices `case` arms between `else` and its body — bash rejects the script at `source` time. **Insert after `:297` (the `;;` closing `--fail-on)`), before `esac` at `:298`.**
2. **Do NOT widen `getCommanderCommandOptions`'s union to include `"harden"`.** It spawns `rfapps <cmd> --help` and keeps every line matching `/^\s+-/`; `harden` uses `.configureHelp({ showGlobalOptions: true })`, and the extractor cannot separate `Global Options:` from `Options:`. Empirically, running it against `import` returns 8 phantom globals (`debug, dry-run, output, use-dotenvx, use-op, verbose, version, yes`). Use the **registrar pattern** for harden.
3. **`<HARDEN_RULE_IDS>` is an unbound placeholder.** It becomes a real import plus a real interpolation in all three generators (§1.1).
4. **The fish harden block is 15 lines, not 14** — harden has 15 long options and the fish extractor compares an exact set.

Minor anchor corrections, verified: `--out` reaches `_filedir` via the pattern line at `:255`; `-s)` is `:235-242` and is **guarded** on `$cmd == "completion"`; `--service|--services` is `:259-262`; `:274` closes `--limit)`. Conclusion holds — for `$cmd == "harden"`, `-s`, `--service`, `--services`, `--group`, `--profile`, `--compose`, `--env-file`, `--out` all already route correctly, so **no allowlist edit is needed**.

`docs/features/shell-completion.md` is **not yours** (T9). Do not touch it.

### 1. `P/src/actions/completion.ts`

#### 1.1 New import + module-level constant

Import block is `:8-14`. Add one line after `:13` (`../lib/errors.js`), keeping value imports before the type import:

```ts
import { HARDEN_RULE_IDS } from "../lib/hardening.js";
```

Then, after the `CompletionOptions` interface closes at `:22` and before the `/** Generate Bash completion script */` JSDoc at `:24`:

```ts
/**
 * Space-separated harden rule ids, interpolated into the `--rule` value
 * completion of every shell. Derived from the rule registry so a new rule is
 * completable without editing three templates.
 */
const hardenRuleIds = HARDEN_RULE_IDS.join(" ");
```

Import the module directly (`../lib/hardening.js`), **not** the `../lib/index.js` barrel — matching how the file already imports `../lib/config.js` and `../lib/errors.js`. The nine ids are `harden-no-new-privileges harden-restart-policy harden-log-rotation harden-cap-drop-all harden-read-only-rootfs harden-run-as-non-root harden-healthcheck harden-memory-limit harden-cpu-limit`.

#### 1.2 Template escaping

In the **TypeScript source** write `\\` for a shell line-continuation backslash, `\$` for a literal `$` the shell must see (`\$cur`, `\${global_opts[@]}`, `\$(compgen …)`), and `${groups}` / `${profiles}` / `${hardenRuleIds}` **unescaped**. Copy escaping verbatim from the neighbouring audit blocks.

#### 1.3 bash — seven edits

**(a) `:40` command list** — insert `harden` immediately after `audit`:

```
  local commands="status health pull build deploy stop rebuild delete prune plan update reconcile import backup apply history rollback drift lint audit harden doctor force-unlock completion init validate mcp state"
```

**(b) `:53` `deploy_opts`** — insert `--scan --scanner --scan-fail-on` immediately after `--validate-first`.

**(c) `:71` `plan_opts`** — insert the same three immediately after `--explain`.

**(d) new `harden_opts`** — after the audit block (`:116-117`), before `# Doctor command options` (`:119`):

```
  # Harden command options
  local harden_opts="--service --services --group --no-sidecars --apply --out --include-review --rule --list-rules --no-backup --allow-reformat --compose --env-file --profile --json"
```

Exactly 15 flags. **`--no-backup`, not `--backup`.**

**(e) `:175` command-detection alternation** — add `|harden` after `|audit`.

**(f) three new `case "$prev"` arms** — insert **between the `;;` at `:297` and `esac` at `:298`**:

```
    --scanner)
      COMPREPLY=(\$(compgen -W "trivy grype" -- "\$cur"))
      return
      ;;
    --scan-fail-on)
      COMPREPLY=(\$(compgen -W "none unknown negligible low medium high critical" -- "\$cur"))
      return
      ;;
    --rule)
      COMPREPLY=(\$(compgen -W "${hardenRuleIds}" -- "\$cur"))
      return
      ;;
```

Bash `case` patterns are whole-word globs, so `--fail-on)` never shadows `--scan-fail-on`; relative order is irrelevant. Known, accepted limitation: `--rule <ids>` is comma-separated and `compgen -W` completes one value; comma continuation is zsh-only. **Do not invent a `__rfapps_rule_completion` helper.**

**(g) dispatch arm** — after the audit arm's `;;` at `:403`, before `doctor)` at `:404`:

```
      harden)
        COMPREPLY=(\$(compgen -W "\$harden_opts \$global_opts" -- "\$cur"))
        ;;
```

#### 1.4 zsh — five edits

**(a)** after `:501` (`'audit:Run read-only Docker Compose security posture audit'`):

```
    'harden:Propose or apply compose security hardening'
```

This must match `.description(…)` in `src/commands/harden.ts` and the fish subcommand line. No test enforces it — verify by eye against the landed T5 file.

**(b) `:531` `__rfapps_find_command` alternation** — add `|harden` after `|audit`.

**(c) `deploy)` arm** — after `:630` (`'--validate-first[…]' \\`):

```
            '--scan[Scan resolved images for known vulnerabilities]' \\
            '--scanner[Scanner backend]:scanner:(trivy grype)' \\
            '--scan-fail-on[Block at or above severity]:severity:(none unknown negligible low medium high critical)' \\
```

**(d) `plan)` arm** — after `:706` (`'--explain[…]' \\`): the same three lines.

**(e) new `harden)` arm** — the `audit)` arm is `:892-904`; `doctor)` starts at `:905`. Insert after `:904`.

> **Load-bearing indentation.** The parity extractor is ``new RegExp(`\\n        ${command}\\)\\n([\\s\\S]*?)\\n          ;;`)`` (`completion.spec.ts:197-199`). It hard-requires an **8-space `harden)`** and a **10-space `;;`**, exactly matching `audit)` at `:892`/`:904`. Nested arms in this file use 16/18 spaces. Wrong indentation throws `"zsh harden options were not generated"` instead of reporting a missing flag.
>
> **No `--` in any harden description.** `getLongOptionNames` (`completion.spec.ts:164-166`) scans the whole arm text **including `[description]` brackets**, so a description mentioning e.g. `--allow-reformat` injects a phantom option and fails exact equality.

```
        harden)
          _arguments \\
            \${global_opts[@]} \\
            '(-s --service)'{-s,--service}'[Target a specific service]:service:(\$(__rfapps_get_services))' \\
            '--services[Target multiple services]: :__rfapps_services_values' \\
            '(-g --group)'{-g,--group}'[Target a service group]:group:(${groups})' \\
            '--no-sidecars[Disable automatic sidecar linking]' \\
            '--apply[Edit compose.yml in place after confirmation]' \\
            '(-o --out)'{-o,--out}'[Write a compose override fragment]:file:_files' \\
            '--include-review[Include review-confidence rules in written output]' \\
            '--rule[Restrict to specific rules]:rules:_values -s , rule ${hardenRuleIds}' \\
            '--list-rules[List available hardening rules and exit]' \\
            '--no-backup[Skip the compose.yml.bak copy taken before apply]' \\
            '--allow-reformat[Accept incidental YAML reformatting of untouched lines]' \\
            '--json[Output the harden result in JSON format]' \\
            '(-f --compose)'{-f,--compose}'[Docker Compose file]:file:_files' \\
            '(-e --env-file)'{-e,--env-file}'[Environment file]:file:_files' \\
            '(-p --profile)'{-p,--profile}'[Docker Compose profile]:profile:(${profiles})'
          ;;
```

Long-name set after de-duplication: `{service, services, group, no-sidecars, apply, out, include-review, rule, list-rules, no-backup, allow-reformat, json, compose, env-file, profile}` = 15 — exactly the Commander set. (Declaring a harden-local `--json` alongside `${global_opts[@]}` matches shipped practice: `lint)` does it at `:883` and `audit)` at `:899`.)

#### 1.5 fish — four edits

**(a)** after `:1162` (the audit subcommand line), before `doctor` at `:1163`:

```
complete -c rfapps -n "__fish_use_subcommand" -a "harden" -d "Propose or apply compose security hardening"
```

`harden` collides with no existing subcommand token, so **no `; and not __fish_seen_subcommand_from …` carve-out is needed**.

**(b)** deploy block, after `:1219` (`-l validate-first`):

```
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scan -d "Scan resolved images for known vulnerabilities"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scanner -d "Scanner backend" -xa "trivy grype"
complete -c rfapps -n "__fish_seen_subcommand_from deploy" -l scan-fail-on -d "Block at or above severity" -xa "none unknown negligible low medium high critical"
```

**(c)** plan block, after `:1297` (`-l explain`): the same three with `__fish_seen_subcommand_from plan`.

**(d) new harden block** — after `:1403` (last line of the audit block), followed by a blank line. **15 lines:**

```
# Harden command options
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s s -l service -d "Target a specific service" -xa "(__rfapps_get_services)"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l services -d "Target multiple services" -xa "(__rfapps_complete_services_list)"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s g -l group -d "Target a service group" -xa "${groups}"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l no-sidecars -d "Disable automatic sidecar linking"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l apply -d "Edit compose.yml in place after confirmation"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s o -l out -d "Write a compose override fragment" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l include-review -d "Include review-confidence rules in written output"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l rule -d "Restrict to specific rules" -xa "${hardenRuleIds}"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l list-rules -d "List available hardening rules and exit"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l no-backup -d "Skip the compose.yml.bak copy taken before apply"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l allow-reformat -d "Accept incidental YAML reformatting of untouched lines"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -l json -d "Output the harden result in JSON format"
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s f -l compose -d "Docker Compose file" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s e -l env-file -d "Environment file" -r
complete -c rfapps -n "__fish_seen_subcommand_from harden" -s p -l profile -d "Docker Compose profile" -xa "${profiles}"
```

Exactly one `-l <name>` per line — the fish extractor takes the first match per line and compares as an exact set.

### 2. `P/src/actions/completion.spec.ts`

Test scope: **new parity coverage only.** No pre-existing assertion breaks from adding `harden` to the hardcoded list; the only genuinely CI-breaking case is the pre-existing `deploy` parity case that T6 red-lights. The `plan` and `harden` cases are mandatory-by-policy — do not skip them believing CI covers it.

#### 2.1 New registrar import

After `:33`:

```ts
import { registerHardenCommand } from "../commands/harden.js";
```

#### 2.2 `getHardenCommand()` helper

Insert after `getBackupCommands()` closes at `:109`, before `IMPORT_FISH_GUARD` at `:111`. Modelled verbatim on `getImportCommand()` (`:75-83`):

```ts
function getHardenCommand(): Command {
  const program = new Command();
  registerHardenCommand(program, {
    loadAction: async () => ({ executeHarden: async () => {} }),
  });
  const command = program.commands.find((candidate) => candidate.name() === "harden");
  if (command === undefined) throw new Error("harden command was not registered");
  return command;
}
```

This reads `command.options` directly instead of parsing `--help`, so `showGlobalOptions` cannot leak. `command.options` excludes Commander's implicit `-h, --help` (that lives on `_helpOption`).

#### 2.3 Widen the two unions

`:168` — add `"plan"` **only**:

```ts
function getCommanderCommandOptions(command: "deploy" | "rebuild" | "plan"): string[] {
```

`:186-190` — add both:

```ts
function getCommandCompletionOptions(
  command: "deploy" | "rebuild" | "plan" | "harden",
  shell: (typeof shells)[number],
  script: string,
): string[] {
```

No body change to either. Verified: `getCommandCompletionOptions("plan", …)` already returns, for all three shells, the identical 12-name set `getCommanderCommandOptions("plan")` produces today — so `plan` parity holds before and after the symmetric additions.

#### 2.4 Hardcoded command list

`:381-383` — insert `"harden",` between `"audit"` and `"doctor"`. Consumed only by `expect(script).toContain(token)` at `:405`.

#### 2.5 New case — `plan` parity (insert after the deploy case closes at `:558`)

```ts
it("keeps plan completions in exact parity with Commander including the scan flags", async () => {
  const planOptions = getCommanderCommandOptions("plan");
  expect(planOptions).toEqual(expect.arrayContaining(["scan", "scanner", "scan-fail-on"]));

  for (const shell of shells) {
    const script = await render(shell);
    expect([...new Set(getCommandCompletionOptions("plan", shell, script))].sort(), shell).toEqual(planOptions);
  }
});
```

#### 2.6 New case — `harden` parity (insert after the plan case)

```ts
it("keeps harden completions in parity with Commander across all shells", async () => {
  const command = getHardenCommand();
  const commanderOptions = command.options
    .map((option) => option.long?.replace(/^--/, ""))
    .filter((option): option is string => option !== undefined)
    .sort();
  // The write-authorization flags must be advertised, in Commander's rendered
  // form: `.option("--no-backup", …)` yields only the negated long name.
  expect(commanderOptions).toEqual(
    expect.arrayContaining(["apply", "out", "include-review", "no-backup", "allow-reformat"]),
  );

  for (const shell of shells) {
    const script = await render(shell);
    expect([...new Set(getCommandCompletionOptions("harden", shell, script))].sort(), shell).toEqual(commanderOptions);
    // Guards an empty `${hardenRuleIds}` interpolation, which the option-name
    // parity assertion above cannot see.
    expect(script, shell).toContain("harden-no-new-privileges");
  }
});
```

**No other spec change.** Do not touch `deployOnlyOptions` (`:532-539`), the `"keeps command-specific safety and targeting options in every shell"` token list (`:631-653`), or any existing case.

### Conventions

- ESM `.js` on both new imports.
- No `any`. `const hardenRuleIds: string` is inferred — no annotation, matching the neighbouring `const profiles`/`groups`.
- JSDoc: the four-line block on `hardenRuleIds`; `#`-comments inside the generated scripts only.
- No logging or error-handling changes; `executeCompletion` untouched.
- `completion.ts` (1602) and `completion.spec.ts` (735) are the documented ~500-cap exception — do not split either.

### Acceptance

- [ ] `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/completion.spec.ts` passes with all pre-existing cases green plus the two new parity cases.
- [ ] `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` is clean (proves `HARDEN_RULE_IDS` and `registerHardenCommand` resolve and `HardenCommandDependencies.loadAction` matches the test double).
- [ ] `npm run rfapps -- completion bash | bash -n /dev/stdin` exits 0.
- [ ] `npm run rfapps -- completion fish | grep -c '__fish_seen_subcommand_from harden'` prints exactly `15`.
- [ ] `npm run rfapps -- completion zsh` contains a `harden)` arm indented with exactly 8 spaces, closed by a `;;` indented with exactly 10 spaces.
- [ ] All three rendered scripts contain every one of the nine `HARDEN_RULE_IDS` in their `--rule` value list.
- [ ] `getCommanderCommandOptions` is typed `"deploy" | "rebuild" | "plan"` (NOT `"harden"`); `getCommandCompletionOptions` is typed `"deploy" | "rebuild" | "plan" | "harden"`.
- [ ] bash `deploy_opts` and `plan_opts` each carry `--scan --scanner --scan-fail-on`; the zsh `deploy)`/`plan)` arms and the fish deploy/plan blocks carry the same three; `rebuild` carries none.
- [ ] `harden` appears in the bash `commands=` list, the bash `:175` alternation, the zsh `commands=()` array, the zsh `__rfapps_find_command` alternation, and the fish `__fish_use_subcommand` list.
- [ ] `npm run format:check` is clean.
- [ ] No file outside the two owned files is modified.

### Pitfalls

- **THE bash SPLICE TRAP:** inserting the new `case "$prev"` arms after `:293` (the `else`) yields a script bash refuses to source, and **no vitest assertion in this file would catch it** — they all operate on the string. Insert after the `;;` at `:297` and verify with `bash -n`.
- **THE showGlobalOptions LEAK:** do not widen `getCommanderCommandOptions` to include `"harden"`. Use `getHardenCommand()` + `command.options`.
- **THE zsh INDENTATION TRAP:** 8-space `harden)`, 10-space `;;`. Anything else throws a misleading "options were not generated" error.
- **THE zsh DESCRIPTION TRAP:** keep every harden description free of `--`.
- `--no-backup`, never `--backup`.
- The fish harden block is **15** lines.
- **T6 can break your plan parity test:** if T6's new plan after-help contains an indented line beginning with `-`, a phantom option enters `planOptions`. The fix belongs in `cli.ts` — do **not** weaken the extractor.
- `vi.mock("../lib/config.js", …)` at `:28` replaces that whole module. `../lib/hardening.js` is loaded for real. Confirm T2's `lib/hardening.ts` does not import `../lib/config.js`; if it ever does, the single-export mock factory breaks module load for the entire suite.
- `--rule` comma continuation works only in zsh. Do not build a bash helper.
- The harden description string must match T5's `.description(…)`: `Propose or apply compose security hardening`.
- Do not edit `docs/features/shell-completion.md` (T9), `src/cli.ts` (T6), or `src/commands/harden.ts` (T5).
- Add no tests beyond the two parity cases, the hardcoded-list entry, and the two union widenings.

---

## T8 — Feature docs

**Owns (both NEW):** `docs/features/rfapps-vulnerability-scanning.md`, `docs/features/rfapps-harden-command.md`
**Depends on:** T6
**Wave:** 5

Two new files. Nothing else is modified — `docs/README.md`, `README.md`, `packages/rfapps-cli/README.md`, `docs/features/quick-reference.md`, `docs/features/rfapps-configuration.md`, `docs/features/shell-completion.md`, `rfapps.config.yaml`, `packages/rfapps-cli/CLAUDE.md`, `ROADMAP.md`, `docs/features/json-output.md`, `docs/features/output-formats.md`, `docs/features/error-handling.md` all belong to T9/T10/T11 and will link **into** your two filenames. **The filenames are load-bearing and must be exactly as given.** No test files. No additional report markdown.

### 1. Repo conventions that bind these files

- `.prettierrc` markdown override: `{ "proseWrap": "preserve", "printWidth": 120 }`. `preserve` means **you** control wrapping — hard-wrap prose at ~100 columns to match `docs/features/rfapps-backup.md`. Prettier **will** re-pad tables; write them loosely and run `prettier --write`.
- `.markdownlint.json` disables MD002, MD003, MD013, MD024, MD029, MD033, MD036, MD040, MD041, MD042, MD051, MD056, MD059, MD060. Everything else is **on**, notably:
  - **MD034 (no bare URLs)** — the Trivy/Grype install URLs must be markdown links or inside code spans/fences.
  - MD012, MD022, MD025, MD031, MD032, MD047.
- Every heading surrounded by a blank line. Every fence carries a language (`bash`, `json`, `yaml`, `text`).
- Gates: `npm run lint:md`, `npm run format:check`.

### 2. Facts you may state (verified in this worktree)

- Exit enum: `Success 0`, `OperationalError 1`, `UsageError 2`, `PartialSuccess 3`.
- Global options: `--dry-run`, `--debug`, `--json`, `-v/--verbose`, `-y/--yes`, `--use-dotenvx <file>`, `--use-op <file>`, `--output <format>` (`json, yaml, csv, table, text`).
- `lidarr` declares a `build:` context (`context: .`, `dockerfile: ./lidarr.Dockerfile`) — a correct build-only skip example.
- All relative link targets used below exist: `rfapps-audit-command.md`, `rfapps-doctor-command.md`, `rfapps-drift-command.md`, `rfapps-configuration.md`, `plan-apply-workflow.md`, `json-output.md`, `output-formats.md`, `error-handling.md`, `docker-compose-extensions.md`, `../../packages/rfapps-cli/README.md`. `#plan`/`#deploy`/`#harden` fragments are created by T9; MD051 is off.

### 3. Corrections that bind this task

1. **Never write "47 services" or "42 of 47".** `compose.yml` has **44**. Prefer omitting counts; if needed, "42 of 44".
2. **Never claim the log-rotation rule is alias-refused on 42 services here.** Detection reads the resolved config, where the shared logging anchor already supplies `max-size`, so the rule does not fire on those services. Document the alias refusal **generically**: "any patch whose target key resolves to a YAML alias is refused." If you mention this deployment, say the shared logging anchor already sets a `max-size`, so the rule fires only on services that declare no `logging` key.
3. **`lineDelta` sign.** Measured **−6** on this repo (a 7-line prettier-wrapped flow sequence in `authentik-server.healthcheck.test` collapses to one line). In prose say "a six-line reduction". In the JSON sample, **read `detectReformat` in `packages/rfapps-cli/src/lib/hardening.ts` and use the sign it actually produces**. Never let the doc contradict the implementation.
4. **Do not repeat the "`envFile` is mandatory / 42 spurious findings" story.** It was measured false. Describe detection neutrally: harden resolves compose configuration using the configured compose file, profile, environment file, and secrets tool, exactly like `rfapps audit`.
5. **Do not cite `file:line` anchors** in prose. Name constructs, flags, and files.
6. **MCP:** scanning is not exposed through MCP (`rfapps.plan`/`rfapps.deploy` do not accept `scan`, `scanner`, `scanFailOn`, so an MCP result never carries a `scan` field), and `harden` is not MCP-surfaced at all (neither are `lint`, `audit`, `doctor`).
7. **The harden text sample must be derived from the landed `formatHardenText`, not from any older design sample.** In particular there is **no** `Suppressed by config: …` line — suppression is rendered only as a count inside the `Proposals:` summary line.

---

### FILE A — `docs/features/rfapps-vulnerability-scanning.md`

H2 sections, in this exact order: `## Read-Only Guarantees` · `## Usage` · `## Scanner Backends and Prerequisites` · `## Scan Targets and Skips` · `## Severity Model and Thresholds` · `## Fail-Closed Semantics` · `## Suppressions and Expiry` · `## Plan Integration` · `## Deploy Gate Position` · `## JSON Output` · `## Exit Behavior` · `## Limitations` · `## Related Documentation`

**Title and lead:**

```markdown
# rfapps Vulnerability Scanning

`rfapps plan --scan` and `rfapps deploy --scan` scan the container images that Docker Compose
resolves for the selected services against a locally installed vulnerability scanner, before any
image is pulled and before any container is touched. Scanning is opt-in per invocation and there is
no standalone `rfapps scan` command.

Scanning is advisory by default. It reports findings and exits zero unless `--scan-fail-on
<severity>` is supplied, in which case it becomes a gate that refuses the operation.
```

**`## Read-Only Guarantees`** (model: the drift doc's identically named section) — bullets:
resolves compose configuration and runs one scanner process per distinct image; does not pull, build, start, stop, recreate, remove, or prune, and does not write compose files or recorded state; the scanner is spawned with secrets injection disabled, so no decrypted application environment reaches a third-party binary; the report attaches to the plan/deploy **output envelope only** and is never embedded in the saved plan file, so `rfapps apply <path>` days later cannot re-assert a stale CVE verdict; scanning takes no rfapps state lock.

**`## Usage`** — a `bash` fence with `rfapps plan --scan`, `rfapps plan -g media-stack --scan --scanner grype`, `rfapps plan --scan --scan-fail-on high`, `rfapps deploy -s plex --scan --yes`, `rfapps deploy -g media-stack --scan --scan-fail-on critical --yes`, `rfapps deploy -s plex --scan --dry-run`, `rfapps plan --scan --output json | jq '.scan.summary'`, `rfapps deploy -s plex --scan --output json --yes | jq '.scan.gate'`. Then the flag table:

| Flag                        | Default                      | Meaning                                                                              |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `--scan`                    | off                          | Resolve compose config and scan every distinct image for the selected services       |
| `--scanner <name>`          | `scan.scanner`, then `trivy` | `trivy` or `grype`. An explicitly selected, absent scanner never falls back silently |
| `--scan-fail-on <severity>` | `scan.failOn`, then `none`   | Block at or above `none, unknown, negligible, low, medium, high, critical`           |

Then a paragraph: neither `--scanner` nor `--scan-fail-on` carries a CLI-level default so a value in `rfapps.config.yaml` can win; resolution is CLI, then `scan.*`, then the hard default. An unrecognised value is a usage error (exit 2). `--scan-fail-on` implies nothing — `--scan` is still required.

**`## Scanner Backends and Prerequisites`** — rfapps does not vendor a scanner; it requires `trivy` or `grype` on `PATH`. The selected backend is probed **once** per invocation (PATH lookup + version read); if absent, every target is recorded as `scanner-unavailable` with the install hint and no scan process is spawned. Then a `text` fence:

```text
trivy image --quiet --no-progress --scanners vuln --format json --timeout <timeout>s <image>
grype <image> -o json -q
```

Then, as its own paragraph (keep this — it is a substantive safety claim):

> rfapps never passes the scanner's own gate flag (`trivy --exit-code`, `grype --fail-on`). rfapps
> owns the threshold, so a non-zero scanner exit unambiguously means the scanner failed, never that
> it found something. That removes the classic findings-versus-error misdiagnosis.

Also: no `auto` backend selection; the vulnerability database belongs to the scanner and rfapps neither seeds nor refreshes it, so on an offline host a failed database fetch surfaces as `scanner-error`. Link both install pages as markdown links.

**`## Scan Targets and Skips`** — targets come from the resolved `docker compose config` output for the selected services, **not** from the generated plan; each distinct image reference is scanned once.

| Skip reason       | Cause                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| `build-only`      | The service declares `build:`; there is no registry artifact to scan       |
| `no-image`        | The service declares neither `image` nor `build`                           |
| `duplicate-image` | Another service already scanned this exact reference; `scannedBy` names it |
| `target-cap`      | The distinct-image count exceeded `scan.maxTargets` (default 64)           |

Every skip stays in the report as a per-service entry, so provenance is traceable when many services share one `lscr.io/linuxserver/*` image. In this deployment `lidarr` builds from `lidarr.Dockerfile`, so it is always reported as `build-only`. Runtime bounds: per-image timeout defaults to 180000 ms (`scan.timeoutMs`), scanner concurrency defaults to 2 (`scan.concurrency`), scanner stdout capture is capped at 32 MiB, and at most 200 findings are retained per target (`truncated: true`) while `counts` stays complete for every surviving finding.

**`## Severity Model and Thresholds`** — a `text` fence `critical > high > medium > low > negligible > unknown`; severities are normalised from the scanner's vocabulary, anything unrecognised maps to `unknown` and the original is preserved verbatim in `rawSeverity`; `--scan-fail-on <severity>` blocks at or above that severity; `none` never blocks.

**`## Fail-Closed Semantics`** — lead: whenever `--scan-fail-on` is not `none`, a scan that could not complete resolves to `inconclusive`, and `inconclusive` blocks exactly like `blocked`. A scan that "passes" because the scanner is missing is not a pass. Then the matrix:

| Situation                                                  | `--scan-fail-on none` (default)               | `--scan-fail-on <severity>`              |
| ---------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| Scanner binary missing (`scanner-unavailable`)             | Reported per target with install hint; exit 0 | `inconclusive`; exit 1                   |
| Scanner exited non-zero (`scanner-error`)                  | Reported; exit 0                              | `inconclusive`; exit 1                   |
| Per-image timeout (`timeout`)                              | Reported; exit 0                              | `inconclusive`; exit 1                   |
| Output exceeded the capture cap (`output-limit`)           | Reported; exit 0                              | `inconclusive`; exit 1                   |
| Unparsable or shape-drifted report (`invalid-report`)      | Reported as a failed target; exit 0           | `inconclusive`; exit 1                   |
| Findings below the threshold                               | `passed`; exit 0                              | `passed`; exit 0                         |
| Findings at or above the threshold                         | `passed` (threshold is `none`); exit 0        | `blocked`; exit 1, nothing is mutated    |
| Offline host, scanner present, database fetch fails        | `scanner-error`; exit 0                       | `inconclusive`; exit 1                   |
| `docker compose config` fails                              | Formatted Docker error; exit 1                | Same                                     |
| Invalid `--scanner` / `--scan-fail-on` / suppression entry | Usage error; exit 2                           | Same                                     |
| `deploy --dry-run --scan` with a gate that would block     | Report; exit 0                                | Report plus a `would block` line; exit 0 |
| `plan --dry-run --scan`                                    | No scan runs; exit 0                          | Same                                     |

Add: an unparsable report is **never** silently treated as zero findings — the target is explicitly failed and counted in `targetsFailed`.

**`## Suppressions and Expiry`** — a `yaml` fence:

```yaml
scan:
  scanner: trivy
  failOn: none
  ignore:
    - id: CVE-2024-56171
      service: plex
      reason: "no upstream fix in the linuxserver image; not reachable in this configuration"
      until: "2026-12-31"
```

Rules: `reason` is **required** (an undocumented suppression is a fallback that hides a real issue); `service` is optional; `id: "*"` suppresses every advisory on the matched target; `until` is an optional ISO-8601 date and an **expired** entry does not suppress — the finding reappears and the report gains a note naming the advisory and the expiry date; suppressed findings are excluded from `counts` and the gate and counted in `suppressed`; a blank `reason` or unparsable `until` is a usage error (exit 2).

**`## Plan Integration`** — the scan runs after the plan is generated and before the plan file is saved; the plan file is written **even when the gate blocks**; a blocking gate suppresses `--apply` and exits 1, with `rfapps apply <path>` as the explicit override; `plan --dry-run --scan` scans nothing; human output goes to stderr, machine output to stdout. Include a trimmed human sample (header, `Scanner:`, `Scope:`, `Targets:`, `Findings:`, `Gate:`, one CRITICAL block, the `Notes:` block, and the `Gate blocked by:` block ending with `Re-run with --scan-fail-on none to report only, or accept a finding via scan.ignore.`). Also include the scanner-unavailable sample verbatim:

```text
Image Vulnerability Scan
Scanner: trivy (unavailable)
Scope: plex, sonarr (/srv/rfmedia-apps/compose.yml)
Targets: 0 scanned, 0 skipped, 2 failed
Gate: --scan-fail-on critical -> INCONCLUSIVE

FAILED
  plex    scanner-unavailable: trivy not found in PATH
  sonarr  scanner-unavailable: trivy not found in PATH

A scan that cannot run does not pass. Install a scanner, or pass --scan-fail-on none
to keep scanning advisory.
```

**`## Deploy Gate Position`** — an ordered list, because the ordering is the safety claim:

1. after conflict validation (the cheaper gate runs first);
2. after the compose path and execution options are authority-verified;
3. before the `--dry-run` branch, so `deploy --dry-run --scan` reports without mutating;
4. before the confirmation prompt, so an operator is never asked to confirm a deploy about to be refused;
5. before the drift revalidation that immediately precedes mutation;
6. before any image pull and before any container is created, started, or recreated.

Then: a blocking gate records a failed operation with `code: "VULNERABILITY_THRESHOLD"` (threshold breached) or `code: "SCAN_INCONCLUSIVE"` (a target could not be scanned), emits `Deploy blocked by vulnerability scan. No containers were modified.`, and exits 1. Non-blocking findings annotate the confirmation prompt: `Deploy plex (will pull images first) [scan: 1 critical, 2 high]?`. `deploy --dry-run --scan` exits **0** even when the gate would block, printing `would block deploy (--scan-fail-on <severity>)` — `--dry-run` means "preview, always succeed" everywhere else in this CLI, and `gate.blocking` in JSON plus that line is what CI should read.

**`## JSON Output`** — `plan --scan --output json` emits `{ planPath, plan, scan }`; `deploy --scan --output json` emits the deploy result with a `scan` field and, when blocked, the matching `failed[]` entry. **`table` and `csv` omit the scan report** — use JSON or YAML for automation. Human text stays on stderr. Then the JSON sample (field names must match `packages/rfapps-cli/src/types/security-scan.ts` key for key), trimmed to one `scanned` image with one vulnerability plus the two `skipped` entries:

```json
{
  "planPath": "/home/op/.rfapps/plans/plan-1753900000.json",
  "plan": { "id": "…", "services": [], "summary": {} },
  "scan": {
    "schemaVersion": "security-scan.v1",
    "timestamp": "2026-07-30T18:00:00.000Z",
    "scanner": { "id": "trivy", "binary": "trivy", "version": "0.58.1", "available": true },
    "scope": {
      "services": ["plex", "sonarr", "radarr", "lidarr"],
      "profiles": ["media"],
      "composePath": "/srv/rfmedia-apps/compose.yml"
    },
    "gate": {
      "failOn": "high",
      "status": "blocked",
      "blocking": true,
      "blockedBy": ["plex: CVE-2024-45490 (critical) in expat@2.5.0"]
    },
    "summary": {
      "critical": 2,
      "high": 6,
      "medium": 18,
      "low": 13,
      "negligible": 2,
      "unknown": 0,
      "total": 41,
      "suppressed": 3,
      "targetsScanned": 3,
      "targetsSkipped": 2,
      "targetsFailed": 0
    },
    "images": [
      {
        "status": "scanned",
        "service": "plex",
        "image": "lscr.io/linuxserver/plex:1.41.3",
        "counts": { "critical": 2, "high": 1, "medium": 4, "low": 3, "negligible": 0, "unknown": 0 },
        "suppressed": 1,
        "truncated": false,
        "durationMs": 4210,
        "vulnerabilities": [
          {
            "id": "CVE-2024-45490",
            "severity": "critical",
            "rawSeverity": "CRITICAL",
            "packageName": "expat",
            "installedVersion": "2.5.0",
            "fixedVersion": "2.6.3",
            "reference": "https://avd.aquasec.com/nvd/cve-2024-45490"
          }
        ]
      },
      {
        "status": "skipped",
        "service": "radarr",
        "image": "lscr.io/linuxserver/sonarr:4.0.10",
        "reason": "duplicate-image",
        "scannedBy": "sonarr"
      },
      { "status": "skipped", "service": "lidarr", "image": "", "reason": "build-only" }
    ],
    "notes": ["suppression for CVE-2023-1111 (plex) expired on 2026-06-30 and is no longer applied"]
  }
}
```

Close with the determinism paragraph and the MCP note:

> `scope.services` and `images` are sorted by service name, findings use a total order (severity
> descending, then package, then advisory id), and `notes` follows a fixed sequence of checks. Two
> runs against the same image with the same scanner database differ only in `timestamp` and
> `durationMs`.
>
> Scanning is not exposed through the MCP server. `rfapps.plan` and `rfapps.deploy` do not accept
> `scan`, `scanner`, or `scanFailOn`, so an MCP result never carries a `scan` field.

**`## Exit Behavior`**

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | Scan completed and the gate passed, or `--scan-fail-on none` kept the scan advisory          |
| `1`  | Gate blocked or was inconclusive, or compose configuration could not be resolved             |
| `2`  | Usage error: unknown scanner, unknown severity, blank suppression reason, unparsable `until` |

Add: on `plan`, exit 1 from the gate also means `--apply` was suppressed; on `deploy`, it means nothing was pulled and no container was modified.

**`## Limitations`** — bullets, each a deliberate v1 scope call: mutable tags describe whatever the registry serves at scan time (pin digests for a hard guarantee); the scan runs **pre-pull** by design because the gate must precede mutation, so it does not describe a locally cached image; no SBOM or SARIF export and no on-disk finding cache (a stale "clean" verdict is worse than a slow scan); only `trivy` and `grype`; no `RFAPPS_SCAN_*` environment overrides; the per-image timeout terminates the direct scanner child only; build-only services are never scanned; scanning covers image contents while runtime posture is the subject of `rfapps lint`, `rfapps audit`, and [rfapps Harden Command](rfapps-harden-command.md).

**`## Related Documentation`**

```markdown
- [rfapps Harden Command](rfapps-harden-command.md)
- [rfapps Audit Command](rfapps-audit-command.md)
- [rfapps Doctor Command](rfapps-doctor-command.md)
- [Plan/Apply Workflow](plan-apply-workflow.md)
- [rfapps Configuration](rfapps-configuration.md)
- [rfapps CLI Reference](../../packages/rfapps-cli/README.md#plan)
- [Output Formats](output-formats.md)
- [JSON Output](json-output.md)
- [Error Handling](error-handling.md)
```

---

### FILE B — `docs/features/rfapps-harden-command.md`

H2 sections, in this exact order: `## Command Syntax` · `## Detection and Patching Inputs` · `## Rule Catalog` · `## Safe, Review, and Advisory` · `## Propose, Override, and Apply` · `## Override Fragment Semantics` · `## YAML Anchor Refusals` · `## Reformat Acknowledgement` · `## Idempotency` · `## Machine Result Contract` · `## Exit Codes` · `## Limitations` · `## Related Documentation`

**Title and lead:**

```markdown
# rfapps Harden Command

`rfapps harden` proposes security hardening changes for resolved Docker Compose services and can
write them either as a separate override fragment or, on explicit request, in place. It remediates
the same subject matter `rfapps lint` and `rfapps audit` report, with stable `harden-*` rule ids.

It is non-destructive by default. With no write flag it resolves compose configuration, reports what
it would change, prints an editable compose override fragment, and writes nothing. It never starts,
stops, recreates, or removes a container, never pulls an image, and never records deployment state.
```

**`## Command Syntax`** — `text` fence `rfapps harden [options]`, then the option table with **exactly these 15 long options** (matching `packages/rfapps-cli/src/commands/harden.ts`; the shell-completion parity test treats this set as authoritative):

| Option                  | Meaning                                                 |
| ----------------------- | ------------------------------------------------------- |
| `-s, --service <name>`  | Target one service                                      |
| `--services <names>`    | Target comma-separated services                         |
| `-g, --group <name>`    | Target a configured service group                       |
| `--no-sidecars`         | Disable automatic sidecar expansion                     |
| `--apply`               | Edit `compose.yml` in place after confirmation          |
| `-o, --out <path>`      | Write a compose override fragment to `<path>`           |
| `--include-review`      | Include review-confidence rules in written output       |
| `--rule <ids>`          | Restrict to a comma-separated rule allowlist            |
| `--list-rules`          | Print the rule catalog and exit                         |
| `--no-backup`           | Skip the `compose.yml.bak` copy taken before `--apply`  |
| `--allow-reformat`      | Accept incidental YAML reformatting of untargeted lines |
| `-f, --compose <path>`  | Use a specific compose file                             |
| `-e, --env-file <path>` | Use a specific environment file                         |
| `-p, --profile <name>`  | Use a specific Docker Compose profile                   |
| `--json`                | Emit the harden result as JSON                          |

Then a `bash` examples fence (propose for a group; `--list-rules`; `--out compose.harden.yaml` followed by `docker compose -f compose.yml -f compose.harden.yaml up -d`; `--rule harden-no-new-privileges --out …`; `-s sonarr --apply`; `-s sonarr --apply --include-review --allow-reformat --yes`; `--json | jq '.summary'`).

Then a paragraph on rejected combinations, all usage errors (exit 2): `--apply` with `--out`; `--allow-reformat` without `--apply`; `--no-backup` without `--apply`; `--apply` with machine output and without `--yes` (a prompt cannot be answered in a JSON pipeline); `--out` refuses to overwrite an existing file. Global `--dry-run` suppresses every write in both write modes and exits 0. **`--include-review` is legal in every mode** — propose mode prints the override fragment it widens.

Concurrency note: `--apply` takes the same rfapps state-mutation lock that `rfapps drift import` takes, because both write `compose.yml`. Propose mode and `--out` take no lock.

Config paragraph with the shipped sample:

```yaml
harden:
  includeReview: false
  backup: true
  ignore:
    - rule: harden-memory-limit
      service: plex # GPU workload; limits are host-dependent
    - rule: harden-run-as-non-root
      service: traefik # binds :80/:443
```

`rule` accepts a `harden-*` id or `*`; `service` is optional; `reason` is optional (unlike scan suppressions — suppressing "add a healthcheck" needs no justification trail). `harden.rules` narrows the catalog the same way `--rule` does, and `--rule` wins. An unknown rule id is a usage error (exit 2). There are no `RFAPPS_HARDEN_*` environment overrides.

**`## Detection and Patching Inputs`** — two short paragraphs (this is the mental model the rest depends on): **detection** reads the fully resolved compose model exactly like `rfapps audit` (anchors, `extends`, and `${VAR}` interpolation already flattened), so harden never proposes something an anchor already supplies; **patching** reads and edits the _source_ `compose.yml` through a comment- and anchor-preserving YAML document, the same path `rfapps drift import` uses. Consequence, stated explicitly: a proposal can be correctly detected against the resolved model and still be refused for automated writing, because the source document supplies that key through a shared anchor. Refusals are computed in **every** mode, so propose mode shows exactly the refusals `--apply` would hit.

**`## Rule Catalog`** — the nine-row table (Rule ID | Severity | Category | Confidence | Fires when | Proposed change) exactly as in T9 §1, plus a one-line "why it matters" list and a provenance block:

```text
harden-no-new-privileges  <- lint/no-new-privileges-missing
harden-restart-policy     <- lint/restart-policy-missing
harden-log-rotation       <- lint/log-rotation-missing
harden-cap-drop-all       <- lint/cap-drop-missing, audit/cap-drop-missing
harden-read-only-rootfs   <- lint/read-only-rootfs
harden-run-as-non-root    <- audit/root-user
harden-healthcheck        <- lint/healthcheck-missing
harden-memory-limit       <- lint/resource-limits-missing, audit/memory-limit-missing
harden-cpu-limit          <- audit/cpu-limit-missing
```

Add: `harden-cap-drop-all` and `harden-read-only-rootfs` attach an extra caution note when the service adds capabilities, maps devices, or has writable bind mounts. `rfapps lint` and `rfapps audit` remain the reporting commands; harden changes neither catalog nor their output.

**`## Safe, Review, and Advisory`** — the three-row table (`safe` → written by `--apply`; `review` → only with `--include-review`; `advisory` → never), then: rfapps will not invent a health-check probe command, a memory ceiling, or a CPU ceiling. A wrong probe marks a healthy service unhealthy; a wrong ceiling OOM-kills it. These three ship as detection plus guidance by deliberate scope decision.

**`## Propose, Override, and Apply`** — the three-row mode table, then bullets: mode is derived from flags, never passed as a value; `--apply` with nothing writable logs `No writable patches; compose.yml unchanged`, writes nothing, and still reports `mode: "apply"` with exit 0; cancelling the prompt exits 0 (matching `rfapps drift import`); `--no-backup` suppresses only the `.bak` copy and requires `--apply`.

Include a trimmed propose-mode text sample **derived from the landed `formatHardenText`** — header `Security Hardening Proposals  (mode: propose -- nothing written)`, `Compose:`, `Scope:`, the `Proposals:` counts line (which is where the suppressed count appears — **there is no separate `Suppressed by config:` line**), then a `SAFE`, a `REVIEW`, an `ADVISORY`, and a `REFUSED` block, and the `Compose override fragment (…)` block with its generated header comments. Prefix with "Illustrative output:" so the refusal block is not read as a claim about this repository. Then the apply-mode header replacement:

```text
Security Hardening  (mode: apply)
Backup: /srv/rfmedia-apps/compose.yml.bak
Applied 6 patch(es) to 4 service(s); 5 review and 3 advisory proposal(s) untouched.
Refused 4 patch(es) (see above). Exit code 3 (partial).
```

Close with: there is deliberately no unified diff. The `SAFE` and `REVIEW` blocks name every key and value that would be written, the override fragment renders them as literal YAML, and serialization churn is disclosed as a count.

**`## Override Fragment Semantics`** — the load-bearing rule:

> A compose override **replaces** a sequence rather than appending to it. Every sequence-valued patch
> therefore emits the **full union** computed from the resolved configuration, not just the entry
> being added. Emitting only the addition would silently drop an existing `security_opt` or `cap_add`
> entry — a hardening tool weakening security.

Plus: the fragment carries a generated header naming the source file, the timestamp, the `docker compose -f compose.yml -f compose.harden.yaml up -d` invocation, and whether review rules were included; it contains only writable proposals (advisory rules never appear); `--out` writes exclusively and fails if the path exists; the same text is available from the JSON result's `override` field, so CI can `jq -r '.override' > compose.harden.yaml`.

**`## YAML Anchor Refusals`** — the four-code table (`alias-target`, `service-missing`, `unexpected-node`, `nested-path`), then: a refusal is reported and non-fatal — detection stands, only the automated write is withheld, and the alternative is always named (usually `rfapps harden --rule <id> --out compose.harden.yaml`); writing a **new top-level key** on a service that merges an anchor (`<<: *service-base`) is safe and does not touch the anchor; harden never writes through a nested path by design, and a rule that would need one is advisory instead. Repo-specific sentence (correction 2 compliant): in this deployment the shared logging anchor already sets a `max-size`, so `harden-log-rotation` does not fire on the services that use it; the alias guard exists for any compose file where a targeted key is supplied by a shared anchor.

**`## Reformat Acknowledgement`** — every mode computes and reports whether re-serializing the source would change untargeted lines, and by how many; when it would, `--apply` refuses with a usage error (exit 2) naming `--allow-reformat` and `--out`, and nothing is ever silently reformatted; on this repository the canonical serializer collapses one prettier-wrapped flow sequence (`authentik-server.healthcheck.test`) onto a single line — a six-line reduction in exactly one region — so `--apply` here needs `--allow-reformat` once, or a one-time reflow of that block.

**`## Idempotency`** — `rfapps harden --apply` run twice is a no-op. Sequence-valued patches union rather than overwrite, so re-applying neither duplicates an entry nor clobbers an existing one; scalar patches are only proposed while the value is missing. Each rule's own proposal makes that rule stop firing for that service.

**`## Machine Result Contract`** — `--json` (or global `--output json`/`yaml`) emits exactly one `harden.v1` document on stdout; human text and diagnostics stay on stderr; `table` and `csv` flatten the top level and are not a substitute (`proposals`, `refusals`, `override` are JSON/YAML detail); `harden` is not exposed through the MCP server, like `lint`, `audit`, and `doctor`. Field list mirroring `HardenResult`: `schemaVersion`, `timestamp`, `mode`, `includeReview`, `scope`, `summary`, `proposals`, `refusals`, `reformat`, `override`, `write`. Then the JSON sample trimmed to one safe proposal, one advisory proposal, and one refusal — **with `lineDelta`'s sign taken from `detectReformat`**:

```json
{
  "schemaVersion": "harden.v1",
  "timestamp": "2026-07-30T18:00:00.000Z",
  "mode": "propose",
  "includeReview": false,
  "scope": {
    "services": ["plex", "sonarr", "radarr"],
    "profiles": ["media"],
    "composePath": "/srv/rfmedia-apps/compose.yml"
  },
  "summary": {
    "total": 14,
    "safe": 6,
    "review": 5,
    "advisory": 3,
    "suppressed": 2,
    "servicesAffected": 3,
    "applied": 0,
    "refused": 4
  },
  "proposals": [
    {
      "ruleId": "harden-no-new-privileges",
      "service": "sonarr",
      "category": "capabilities",
      "severity": "info",
      "confidence": "safe",
      "title": "no-new-privileges not set",
      "rationale": "A setuid binary inside the container can still escalate privileges.",
      "guidance": "Add `security_opt: [\"no-new-privileges:true\"]` unless the service requires privilege escalation.",
      "detects": { "lint": "no-new-privileges-missing" },
      "evidence": ["security_opt does not include no-new-privileges:true"],
      "patches": [
        {
          "key": "security_opt",
          "operation": "merge-unique",
          "value": ["no-new-privileges:true"],
          "description": "security_opt += [\"no-new-privileges:true\"]"
        }
      ]
    },
    {
      "ruleId": "harden-healthcheck",
      "service": "plex",
      "category": "health",
      "severity": "warn",
      "confidence": "advisory",
      "title": "Health check missing",
      "rationale": "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
      "guidance": "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`.",
      "detects": { "lint": "healthcheck-missing" },
      "evidence": ["healthcheck absent"],
      "patches": []
    }
  ],
  "refusals": [
    {
      "code": "alias-target",
      "service": "sonarr",
      "ruleId": "harden-log-rotation",
      "detail": "services.sonarr.logging is a YAML alias (*logging-default); editing it would change every service that shares the anchor",
      "alternative": "use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml"
    }
  ],
  "reformat": { "wouldReformat": true, "lineDelta": -6 },
  "override": "# Generated by rfapps harden at 2026-07-30T18:00:00.000Z\nservices:\n  sonarr:\n    security_opt:\n      - no-new-privileges:true\n",
  "write": { "mode": "propose" }
}
```

Follow with: in apply mode `write` becomes `{ "mode": "apply", "path": "…/compose.yml", "backupPath": "…/compose.yml.bak", "patchesWritten": 6, "servicesPatched": ["radarr", "sonarr"] }`; in override mode `{ "mode": "override", "path": "…", "patchesWritten": 6 }`. Determinism: proposals sort by confidence, then service, then catalog order; patches keep declaration order; refusals sort by service then rule id.

**`## Exit Codes`**

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | Proposals reported, override written, apply completed, or apply cancelled at the prompt                |
| `1`  | Compose resolution failed, or the backup/write failed                                                  |
| `2`  | Usage error, including `--apply` needing `--allow-reformat`, `--out` on an existing file, unknown rule |
| `3`  | Apply wrote some patches and refused others                                                            |

Closing paragraph: harden is never a findings gate and has no `--fail-on`. Refusing to make an unsafe edit is correct behaviour; reporting that as a failure would train operators to ignore the exit code. Use `rfapps lint --fail-on` when a CI threshold on this subject matter is wanted.

**`## Limitations`** — no unified diff or `git apply`-compatible patch; no synthesised health-check probe, memory limit, or CPU limit; no automated removal of `privileged: true`; no user-defined rules or presets (`--rule`, `harden.ignore`, `--include-review` are the selection surface); no MCP tool (a compose-file mutator reachable without the confirmation prompt is a different risk conversation); patches only write top-level keys under a service; `--apply` edits the single compose file rfapps resolved, and services defined elsewhere are reported as `service-missing` with `--out` named as the alternative.

**`## Related Documentation`**

```markdown
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md)
- [rfapps Audit Command](rfapps-audit-command.md)
- [rfapps Doctor Command](rfapps-doctor-command.md)
- [rfapps Drift Command](rfapps-drift-command.md)
- [rfapps Configuration](rfapps-configuration.md)
- [Docker Compose Extensions](docker-compose-extensions.md)
- [rfapps CLI Reference](../../packages/rfapps-cli/README.md#harden)
- [Output Formats](output-formats.md)
- [JSON Output](json-output.md)
- [Error Handling](error-handling.md)
```

### 4. Cross-checks before declaring done

Verify these **six** values against the landed code:

1. `HARDEN_RULE_IDS` in `packages/rfapps-cli/src/lib/hardening-rules.ts` — the nine ids and their order.
2. The 15 options registered in `packages/rfapps-cli/src/commands/harden.ts` — exact spelling.
3. The scan flag spelling in `packages/rfapps-cli/src/cli.ts` — `--scan`, `--scanner <name>`, `--scan-fail-on <severity>`.
4. `detectReformat`'s `lineDelta` sign in `packages/rfapps-cli/src/lib/hardening.ts` — must match your JSON sample.
5. Field names in `packages/rfapps-cli/src/types/security-scan.ts` and `packages/rfapps-cli/src/types/hardening.ts` — key for key against both JSON samples.
6. **The line inventory of `formatHardenText` in `packages/rfapps-cli/src/lib/hardening-format.ts`** — your text sample must not show a line the renderer never emits (in particular, no `Suppressed by config:` line).

Then:

```bash
cd /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-security-scan-harden
env -u FORCE_COLOR npx prettier --write docs/features/rfapps-vulnerability-scanning.md docs/features/rfapps-harden-command.md
env -u FORCE_COLOR npm run lint:md
env -u FORCE_COLOR npm run format:check
grep -n "47 service\|47 containerized" docs/features/rfapps-*.md   # must return nothing
```

### Acceptance

- [ ] Both files exist as new files with exactly one H1 each and the H2 sections in the orders listed above.
- [ ] `git status --porcelain` shows only the two new docs; no `.spec.ts`, fixture, or additional report markdown was added.
- [ ] `env -u FORCE_COLOR npm run lint:md` exits 0.
- [ ] `env -u FORCE_COLOR npm run format:check` exits 0 (run `prettier --write` on both first).
- [ ] `grep -rn '47 service\|47 containerized' <both files>` returns nothing; any service count reads "42 of 44".
- [ ] Neither file claims `harden-log-rotation` is alias-refused on 42 services here, and neither repeats the "42 spurious findings" / "envFile is mandatory" story.
- [ ] The harden rule catalog lists exactly the nine ids and matches `HARDEN_RULE_IDS`.
- [ ] The harden option table lists exactly the 15 long options registered in `commands/harden.ts`, identically spelled.
- [ ] The scan flag names match `cli.ts` exactly; no `rfapps scan` command is documented anywhere.
- [ ] The `lineDelta` in the harden JSON sample carries the same sign `detectReformat` produces; surrounding prose says "six-line reduction", never "+6".
- [ ] Every JSON sample field name matches the corresponding interface key for key.
- [ ] The harden text sample contains no `Suppressed by config:` line; the suppressed count appears only inside the `Proposals:` summary line.
- [ ] Every relative markdown link resolves (fragments excepted).
- [ ] Both docs state: scanning and harden are not MCP-exposed; `table`/`csv` omit the scan report; the scan report is never embedded in the saved plan file; `deploy --dry-run --scan` exits 0 even when the gate would block; `plan --dry-run --scan` runs no scan.
- [ ] Exit codes documented as 0/1/2 (scan) and 0/1/2/3 (harden).

### Pitfalls

- MD034 is **enabled** — Trivy/Grype URLs must be links or code spans, never bare in prose.
- `proseWrap: preserve` means prettier will **not** wrap your prose; hard-wrap at ~100 columns yourself. It **will** re-pad tables, so run `prettier --write` before `format:check`.
- `compose.yml` has 44 services, not 47.
- The alias-refusal-on-42-services claim is false here; present the guard generically.
- `lineDelta` is measured **−6**; read `detectReformat` before writing the sample.
- Do not copy `file:line` anchors into the docs.
- Do not repeat the "`envFile` is mandatory / 42 spurious findings" rationale.
- There is no `rfapps scan` command, no `--fail-on` on harden, no `auto` scanner selection, no SARIF/SBOM export, and no `RFAPPS_SCAN_*` / `RFAPPS_HARDEN_*` env vars.
- `deploy --dry-run --scan` exits 0 while a real blocking deploy exits 1 — getting this backwards is the most misleading thing these docs could say to a CI author.
- harden `--apply` cancelled at the prompt exits 0; partial apply exits 3. Cancellation is not a failure.
- Compose overrides **replace** sequences; documenting the fragment as "the added entry" would teach operators to hand-write fragments that drop existing values.
- T9 links to these two exact filenames; renaming either breaks T9's index edits.
- Verify the harden text sample against the landed `formatHardenText`, not against any older sample.
- Run gates with `env -u FORCE_COLOR` (and prefer `umask 022`).

---

## T9 — Indexes and tables

**Owns (all MODIFIED):** `docs/README.md`, `README.md`, `packages/rfapps-cli/README.md`, `docs/features/shell-completion.md`, `docs/features/quick-reference.md`, `docs/features/rfapps-configuration.md`, `rfapps.config.yaml`, `packages/rfapps-cli/CLAUDE.md`
**Depends on:** T6, T7, T8
**Wave:** 6

Eight files, all documentation/config-sample. **Zero TypeScript, zero tests.**

### 0. Corrections that bind this task

1. **Never write "47 services" or "42 of 47."** `compose.yml` has **44**. If the figure is needed, "42 of 44". Root `CLAUDE.md` is stale here but is **not yours**; `docs/README.md:5` says "38 containerized applications" — also stale, also **out of scope** (see policy 5).
2. **Never promise an alias refusal on 42 services.** `harden-log-rotation` does not fire on the 42 alias-logging services (their resolved `max-size` is `"200k"`); it fires only on `ofelia` and `immich-postgres`, which have no `logging` key and patch cleanly. Document the alias guard **generically, with no count**: "`--apply` refuses to edit a key that resolves to a YAML alias (for example `logging: *logging-default`) because the edit would change every service sharing the anchor; the refusal names `--out` as the alternative."
3. **Do not print a signed `lineDelta` in prose.** Measured: 1605 → 1599, i.e. the reformat **removes 6 lines**. Write "one region, 6 lines" and let the CLI print its own number.
4. **`P/CLAUDE.md` has no existing MCP closed-schema warning** to sit next to — create the note inside a **new** `## Architecture Patterns` subsection. Also: `harden.ts` goes **after `drift.ts` (`:47`)** in the alphabetical `src/actions/` listing (`:44` is `completion.ts`), and the model subsection is `### Native Backup Architecture` at **`:246-285`**.
5. **Staleness policy:** _fix staleness on a line you are already editing; do not go hunting elsewhere._ `docs/features/shell-completion.md:120-121` **is** being edited (to add `harden`) and already omits `import` and `force-unlock` → fix all three on that line. `docs/README.md:5` is not otherwise touched → leave it.
6. **`P/README.md` config blocks:** document `harden.*` inside the new `### harden` section and `scan.*` inside the new plan scanning block. **Do not put a `scan:` block inside `### lint`.**

### 1. Feature facts (single source of truth for wording)

**#161 `--scan`:**

| Flag                        | Default                        | Semantics                                                                                                |
| --------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `--scan`                    | `false`                        | Opt-in. One `docker compose config` plus one scanner process per distinct image.                         |
| `--scanner <name>`          | CLI → `scan.scanner` → `trivy` | `trivy` \| `grype`. Invalid → exit 2.                                                                    |
| `--scan-fail-on <severity>` | CLI → `scan.failOn` → `none`   | `none, unknown, negligible, low, medium, high, critical`. Does **not** imply `--scan`. Invalid → exit 2. |

Targets come from `getComposeConfig`, never the plan. Skip reasons `build-only`, `no-image`, `duplicate-image` (reports `scannedBy`), `target-cap`. Severity scale `critical|high|medium|low|negligible|unknown`, with `unknown` the sink for unrecognised strings. **Default threshold `none` = report only, exit 0.** With any other threshold the gate is **fail-closed**: `scanner-unavailable`, `timeout`, `output-limit`, `scanner-error`, `invalid-report` all resolve to `inconclusive`, which blocks (exit 1). On `plan`: the plan file **is still written**, the report prints, `--apply` is suppressed, exit 1; `rfapps apply <path>` remains the explicit override. On `deploy`: the gate runs **before** any pull or container start; it pushes a `failed[]` entry `{ name: "scan", code: "VULNERABILITY_THRESHOLD" }` (or `SCAN_INCONCLUSIVE"`), logs `Deploy blocked by vulnerability scan. No containers were modified.`, exits 1. `deploy --dry-run --scan` exits **0** with the report plus a "would block" line; `plan --dry-run --scan` scans **nothing**. The report rides the action output envelope (`{ planPath, plan, scan }` / `DeployResult.scan`), never the saved plan. `--output json`/`yaml` carry `scan`; `table`/`csv` strip it. Schema `security-scan.v1`. Suppressions in `scan.ignore[]`: `{ id, service?, reason (required), until? }`; an expired `until` no longer suppresses and emits a `notes[]` line. Scanning is pre-pull by design. **Not MCP-surfaced.**

**#162 `rfapps harden`** — 15 long options (`--service, --services, --group, --no-sidecars, --apply, --out, --include-review, --rule, --list-rules, --no-backup, --allow-reformat, --compose, --env-file, --profile, --json`). Note the negated spellings: `--no-sidecars` and `--no-backup` (never `--backup` for harden — `drift import`'s `--backup` is a different command). Modes: none → `propose` (nothing written); `--out <path>` → `override` (writes with `flag: "wx"`, refuses to clobber, `compose.yml` untouched); `--apply` → in-place after a `.bak` copy and a confirmation. `--out` and `--apply` are mutually exclusive (exit 2). Confidence: `safe` (written by `--apply`), `review` (only with `--include-review`), `advisory` (never — rfapps will not invent a probe command or a resource ceiling). Nine rules:

| Rule ID                    | Sev    | Category     | Confidence | Fires when                                    | Proposed change                                                    |
| -------------------------- | ------ | ------------ | ---------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `harden-no-new-privileges` | `info` | capabilities | safe       | `security_opt` lacks `no-new-privileges:true` | Union `no-new-privileges:true` into `security_opt`                 |
| `harden-restart-policy`    | `warn` | availability | safe       | No `restart` and no `deploy.restart_policy`   | `restart: unless-stopped`                                          |
| `harden-log-rotation`      | `warn` | logging      | safe       | `logging.options["max-size"]` absent or empty | Whole `logging` map: `json-file`, `max-size: 10m`, `max-file: "3"` |
| `harden-cap-drop-all`      | `info` | capabilities | review     | `cap_drop` does not include `ALL`             | Union `ALL` into `cap_drop`                                        |
| `harden-read-only-rootfs`  | `info` | filesystem   | review     | `read_only` is not `true`                     | `read_only: true`                                                  |
| `harden-run-as-non-root`   | `warn` | identity     | review     | `user` absent, `0`, `root`, or `0:*`          | `user: "${PUID}:${PGID}"`                                          |
| `harden-healthcheck`       | `warn` | health       | advisory   | `healthcheck` absent or null                  | None — guidance only                                               |
| `harden-memory-limit`      | `info` | limits       | advisory   | `deploy.resources.limits.memory` absent/empty | None — guidance only                                               |
| `harden-cpu-limit`         | `info` | limits       | advisory   | `deploy.resources.limits.cpus` absent/empty   | None — guidance only                                               |

Refusals (reported, non-fatal, always naming an alternative): `alias-target`, `service-missing`, `unexpected-node`, `nested-path`. Exit codes: `0` propose/override/apply-clean **and** apply cancelled; `3` apply wrote some and refused others; `1` compose or write failure; `2` usage errors. **No `--fail-on`; never a findings gate.** Schema `harden.v1`. Config section `harden:` with `ignore`, `rules`, `includeReview`, `backup`. **Not MCP-surfaced.** `harden --apply` takes the global state lock (operation `harden`); propose and `--out` are lock-free; global `--dry-run` suppresses the lock.

### 2. `docs/README.md` — two edits

**Edit A — `**CLI Features:**` list.** After the `rfapps Native Backup` entry (`:64-65`), before `Deployment History` (`:66`):

```markdown
- [rfapps Vulnerability Scanning](features/rfapps-vulnerability-scanning.md) - Opt-in `--scan` image
  CVE reporting on `plan` and a fail-closed pre-mutation gate on `deploy`
- [rfapps Harden Command](features/rfapps-harden-command.md) - Non-destructive compose hardening
  proposals, override fragments, and alias-safe `--apply`
```

**Edit B — rfapps command table** (`:319-334`). Insert one row after `:332`:

```markdown
| `rfapps harden` | Propose or apply compose security hardening | Apply only |
```

Do **not** add a row for scanning — it is a flag, not a command. Do not hand-align; `npm run format` re-pads.

### 3. `README.md` — one edit

After the `rfapps Native Backup` entry (`:249-250`), inside `### Feature Documentation`:

```markdown
- [rfapps Vulnerability Scanning](docs/features/rfapps-vulnerability-scanning.md) - Opt-in image CVE
  scanning with a fail-closed `deploy` gate
- [rfapps Harden Command](docs/features/rfapps-harden-command.md) - Propose, override, or apply
  compose security hardening
```

No other change; do not touch `## Security Notes` (`:263-270`).

### 4. `packages/rfapps-cli/README.md` — six edits (work bottom-up)

**Edit F — `**Key Features:**` bullet list (~`:15-33`).** Add two bullets in the list's existing style, near the audit/doctor entries:

```markdown
- **Opt-in vulnerability scanning** for `plan` and `deploy` with a fail-closed pre-mutation gate
- **Compose security hardening** via `harden`: propose, emit an override fragment, or apply in place
```

**Edit E — `### State mutation locking` (`:208-210`).** On `:209`, replace `and apply modes for plan, update,` with `` `harden --apply`, and apply modes for plan, update, ``.

**Edit D — plan section: `**Vulnerability Scanning:**` block.** Insert after `:1324` (end of the `--check-updates` paragraph), before `### update` at `:1326`:

```markdown
**Vulnerability Scanning:**

`--scan` resolves the images `docker compose config` produces for the targeted scope and reports
known vulnerabilities before the plan is applied. It is opt-in and read-only; the report is attached
to the command's output envelope as `scan` and is deliberately **not** embedded in the saved plan, so
`rfapps apply <path>` days later never re-asserts a stale CVE verdict.
```

then a `bash` fence (`rfapps plan -g media-stack --scan`; `rfapps plan -s plex --scan --scan-fail-on high --apply`; `rfapps plan -s sonarr --scan --scanner grype`; `rfapps plan -s plex --scan --output json`), then:

```markdown
The plan file is still written when the gate blocks — a plan is evidence, not a mutation — but
`--apply` does not run and the command exits `1`. `plan --dry-run` short-circuits before plan
generation, so `plan --dry-run --scan` scans nothing. `--output table` and `--output csv` strip the
nested `scan` payload.

`scan.scanner`, `scan.failOn`, `scan.ignore`, `scan.timeoutMs`, `scan.maxTargets`, and
`scan.concurrency` in `rfapps.config.yaml` supply the defaults; CLI flags win. Suppressions require a
`reason` and honour an optional ISO-8601 `until`, after which the entry stops suppressing and the
report says so:
```

then the `scan:` YAML fence (as in T8 File A), then `See [rfapps Vulnerability Scanning](../../docs/features/rfapps-vulnerability-scanning.md) for the backend prerequisites, skip classification, severity model, JSON shape, and limitations.`

**Edit C — plan option table rows.** Insert after `:1200` (`--explain`):

```markdown
| `--scan` | Scan resolved images for known vulnerabilities |
| `--scanner <name>` | Scanner backend: `trivy` or `grype` (default: `trivy`) |
| `--scan-fail-on <severity>` | Block at or above severity (default: `none`, report only) |
```

**Edit B — deploy.**
**B1.** Insert the same three rows after `:817` (`--validate-first`).
**B2.** Insert `#### Vulnerability Scan Gate` after `:865` (end of `#### Pre-Deploy Conflict Validation`), before `#### Staged Rollout`:

```markdown
#### Vulnerability Scan Gate

`--scan` resolves the images for the targeted scope and scans them **before** anything is pulled,
recreated, or started. A blocked scan returns before the confirmation prompt and modifies no
containers, images, or recorded state.
```

then a `bash` fence (advisory; gate at high; `--dry-run` preview), then:

```markdown
The gate is fail-closed whenever `--scan-fail-on` is not `none`: a missing scanner binary, a
per-image timeout, a capture overflow, a non-zero scanner exit, and an unparsable report all resolve
to `inconclusive` and block. A scan that "passes" because no scanner is installed would be a silent
fallback, so it is not offered. With the default `--scan-fail-on none` the same situations are
reported loudly and the deploy proceeds with exit `0`.

A blocked or inconclusive gate records a `failed[]` entry named `scan` with code
`VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`, logs
`Deploy blocked by vulnerability scan. No containers were modified.`, and exits `1`. `--yes` does not
waive the gate. `--dry-run --scan` always exits `0` and prints the report plus a `would block` line.

The `scan` payload rides on the `DeployResult` envelope for `--output json` and `--output yaml`; it
is stripped for `table` and `csv`. Scanning happens pre-pull by design, so it describes the image
reference Compose resolves rather than a local digest — pin digests in `compose.yml` if you need a
hard guarantee.

See [rfapps Vulnerability Scanning](../../docs/features/rfapps-vulnerability-scanning.md) for the
full failure-mode matrix and suppression contract.
```

**B3.** Do **not** add a row to the deploy `### Exit Codes` table (`:999-1004`) — the existing `1 / Operational error` row covers it. Instead insert after `:1011` (end of the closing paragraph), immediately before `### stop` at `:1013`:

```markdown
A blocked or inconclusive `--scan` gate is an operational failure with the same code `1`, raised
before any mutation, so a scan-blocked deploy has no partial result to report and `--allow-partial`
does not change it.
```

**Edit A — new `### harden` section.** Insert after `:762` (end of `### audit`), before `### pull` at `:764`. Structure model: `### audit` (`:697-762`) and `### lint` (`:1780-1877`).

````markdown
### harden

Propose, emit, or apply Docker Compose security hardening. `rfapps lint` and `rfapps audit` detect;
`harden` remediates.

```bash
rfapps harden [options]
```

| Option                  | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `-s, --service <name>`  | Target a specific service                              |
| `--services <names>`    | Target multiple services (comma-separated)             |
| `-g, --group <name>`    | Target a service group                                 |
| `--no-sidecars`         | Disable automatic sidecar linking                      |
| `--apply`               | Edit `compose.yml` in place (requires confirmation)    |
| `-o, --out <path>`      | Write a compose override fragment to `<path>`          |
| `--include-review`      | Include review-confidence rules in written output      |
| `--rule <ids>`          | Restrict to a comma-separated rule allowlist           |
| `--list-rules`          | Print the rule catalog and exit                        |
| `--no-backup`           | Skip the `compose.yml.bak` copy taken before `--apply` |
| `--allow-reformat`      | Accept incidental YAML reformatting of untouched lines |
| `-f, --compose <path>`  | Path to Docker Compose file                            |
| `-e, --env-file <path>` | Path to environment file                               |
| `-p, --profile <name>`  | Docker Compose profile to use                          |
| `--json`                | Output versioned `harden.v1` JSON                      |

**Non-destructive by default.** With no write flag, `harden` resolves Compose configuration, reports
proposed hardening, and prints an editable override fragment. It writes nothing and does not touch
containers, images, or recorded state.

| Flags          | Mode       | Side effects                                                           |
| -------------- | ---------- | ---------------------------------------------------------------------- |
| _(none)_       | `propose`  | Nothing written                                                        |
| `--out <path>` | `override` | Writes the override fragment; refuses to overwrite an existing file    |
| `--apply`      | `apply`    | Rewrites `compose.yml` after a `.bak` copy and one confirmation prompt |

`--out` and `--apply` are mutually exclusive. `--include-review` is legal in every mode; it widens
the proposals eligible for writing, which is what propose mode prints as an override fragment. Global
`--dry-run` suppresses every write in both write modes and still prints the proposals.

**Rule catalog:**

| Rule id                    | Severity | Category     | Confidence | Proposed remediation                              |
| -------------------------- | -------- | ------------ | ---------- | ------------------------------------------------- |
| `harden-no-new-privileges` | `info`   | capabilities | `safe`     | `security_opt += ["no-new-privileges:true"]`      |
| `harden-restart-policy`    | `warn`   | availability | `safe`     | `restart: unless-stopped`                         |
| `harden-log-rotation`      | `warn`   | logging      | `safe`     | full `logging` map with `max-size` and `max-file` |
| `harden-cap-drop-all`      | `info`   | capabilities | `review`   | `cap_drop += ["ALL"]`                             |
| `harden-read-only-rootfs`  | `info`   | filesystem   | `review`   | `read_only: true`                                 |
| `harden-run-as-non-root`   | `warn`   | identity     | `review`   | `user: "${PUID}:${PGID}"`                         |
| `harden-healthcheck`       | `warn`   | health       | `advisory` | none — detection and guidance only                |
| `harden-memory-limit`      | `info`   | limits       | `advisory` | none — detection and guidance only                |
| `harden-cpu-limit`         | `info`   | limits       | `advisory` | none — detection and guidance only                |

`safe` proposals are mechanical and workload-neutral. `review` proposals can break a workload and are
excluded from every write unless `--include-review`. `advisory` proposals are never written: rfapps
will not invent a health probe or a memory/CPU ceiling, because a wrong probe marks a healthy service
unhealthy and a wrong ceiling OOM-kills it.

Sequence-valued patches are unioned with what is already declared, never overwritten, so running
`harden --apply` twice is a no-op and an existing `security_opt` or `cap_drop` entry is never
dropped. Because a Compose override **replaces** a sequence rather than appending to it, the `--out`
fragment always emits the full merged list.

**Refusals.** `--apply` refuses to edit a key that resolves to a YAML alias (for example
`logging: *logging-default`), because the edit would change every service sharing the anchor; the
refusal names `--out` as the alternative. It also refuses when a service is absent from the compose
document or when the existing node is not the kind the operation needs. A refusal is reported and
non-fatal — the detection stands, only the automated write is withheld.

**Reformat acknowledgement.** Writing `compose.yml` means re-serializing the whole document. When
that would change lines `harden` did not target, `--apply` refuses and reports the size of the churn;
pass `--allow-reformat` to accept it, or use `--out` for a non-destructive override. On this
repository the round trip touches exactly one region (6 lines, a wrapped flow sequence in
`authentik-server.healthcheck.test`).

**Examples:**

```bash
# Propose only; writes nothing
rfapps harden

# One rule, non-destructive override fragment
rfapps harden --rule harden-no-new-privileges --out compose.harden.yaml
docker compose -f compose.yml -f compose.harden.yaml up -d

# Apply safe proposals in place after a .bak copy and one confirmation
rfapps harden --apply

# Include review-confidence rules in the write
rfapps harden --apply --include-review

# Catalog and machine output
rfapps harden --list-rules
rfapps harden --json
```

**Exit codes:**

| Code | Meaning           | Description                                                                                                          |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success           | Proposals reported, override written, apply completed, or apply cancelled                                            |
| `1`  | Operational error | Compose resolution failed, or the backup/write failed                                                                |
| `2`  | Usage error       | `--apply` with `--out`, `--out` on an existing file, missing `--allow-reformat`, invalid target, profile, or rule id |
| `3`  | Partial success   | `--apply` wrote some patches and refused others                                                                      |

Harden is deliberately **not** a findings gate and has no `--fail-on`: `rfapps lint --fail-on`
already gates this subject matter, and refusing an unsafe edit is correct behaviour rather than an
operational failure. Cancelling at the prompt exits `0`, matching `drift import`.

**Suppressing rules via `.rfapps.yaml`:**

```yaml
harden:
  includeReview: false
  backup: true
  # rules: [harden-no-new-privileges, harden-restart-policy]  # optional allowlist
  ignore:
    - rule: harden-memory-limit
      service: plex # GPU workload; limits are host-dependent
    - rule: harden-run-as-non-root
      service: traefik # binds :80/:443
```

Harden ids are namespaced `harden-*` and have their own catalog; `lint.ignore` does not apply to them
and `rfapps lint` output is unchanged by this command.

`harden --apply` takes the global state mutation lock (operation `harden`) because it writes the same
`compose.yml` that `drift import` writes. Propose mode, `--out`, and global `--dry-run` are
lock-free. Harden is not exposed over the MCP server.

See [rfapps Harden Command](../../docs/features/rfapps-harden-command.md) for the full operator
contract.
````

Note the `rules:` line is **commented out** with a real allowlist, not `rules: []` — an empty array means the full catalog, and showing it would teach the wrong idiom.

### 5. `docs/features/shell-completion.md` — four edits (work bottom-up)

**Edit D — `## Related Documentation`.** After `:541` (the audit entry):

```markdown
- [rfapps Harden Command](rfapps-harden-command.md) - Compose hardening proposals and `--apply`
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` on `plan` and `deploy`
```

**Edit C — value completion.** Insert after `:401` (end of the `### Diagnostic Severity Values` fence), before `## Usage Examples` at `:403`:

````markdown
### Scanner and Severity Values

The vulnerability scanning options complete their own closed value sets:

```bash
rfapps plan --scan --scanner <TAB>
rfapps deploy --scan --scanner <TAB>
# Shows: trivy grype

rfapps deploy --scan --scan-fail-on <TAB>
# Shows: none unknown negligible low medium high critical
```

`--scan-fail-on` uses the CVE severity scale, which is deliberately different from `--fail-on`'s
compose severity scale on `audit`, `doctor`, and `lint`.

### Harden Rule Ids

`--rule` completes the `harden-*` rule catalog:

```bash
rfapps harden --rule <TAB>
# Shows: harden-no-new-privileges harden-restart-policy harden-log-rotation
#        harden-cap-drop-all harden-read-only-rootfs harden-run-as-non-root
#        harden-healthcheck harden-memory-limit harden-cpu-limit
```

`--rule` accepts a comma-separated list. Zsh completes each entry of the list; Bash and Fish complete
the first id only.
````

> **Verify before committing:** T7 owns the generators. Run `npm run rfapps -- completion bash | grep -n 'harden\|--rule\|--scanner'` and the zsh/fish equivalents, and correct the last sentence if T7 implemented comma-segment handling in Bash.

**Edit B — new `### Harden Completion Behavior`.** Insert after `:300` (end of `### Managed Update Completion Behavior`), before `### Service Groups` at `:302`:

````markdown
### Harden Completion Behavior

Bash, Zsh, and Fish generate the same `rfapps harden` option surface as Commander:

```text
--service --services --group --no-sidecars --apply --out --include-review
--rule --list-rules --no-backup --allow-reformat --compose --env-file --profile
--json
```

| Options                                                                                                     | Completion behavior                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `-s, --service`, `--services`                                                                               | Suggest configured services plus services discovered from the local Compose file |
| `-g, --group`                                                                                               | Suggest groups from the loaded rfapps configuration                              |
| `-p, --profile`                                                                                             | Suggest configured Docker Compose profiles                                       |
| `-o, --out`, `-f, --compose`, `-e, --env-file`                                                              | Complete filesystem paths                                                        |
| `--rule`                                                                                                    | Suggest the `harden-*` rule ids                                                  |
| `--apply`, `--include-review`, `--list-rules`, `--no-backup`, `--no-sidecars`, `--allow-reformat`, `--json` | Complete the flag name; these take no value                                      |

The negated spellings are what Commander registers, so the templates carry `--no-backup` and
`--no-sidecars`, not `--backup` or `--sidecars`. Completion only inserts command text: it never
resolves Compose, evaluates a rule, answers the `--apply` confirmation, or writes `compose.yml`. A
bare `rfapps harden` remains propose-only. See
[rfapps Harden Command](rfapps-harden-command.md) for the write contract.
````

**Edit A — the two prose blocks.**

_A1 — command list (`:118-122`)._ Replace `:120-121` with (adds `harden`, and fixes the pre-existing omission of `import` and `force-unlock` per policy 5):

```markdown
# Includes: status health pull build deploy stop rebuild delete prune plan update reconcile import

# backup apply history rollback drift lint audit harden doctor force-unlock completion

# init validate mcp state
```

_A2 — per-command option blocks (the fence at `:145-215`)._ Three changes **inside** the fence:

- Line `:152` → `#        --scan --scanner --scan-fail-on --compose --env-file --profile`
- Line `:157` → `#        --show-unchanged --check-updates --explain --scan --scanner --scan-fail-on` plus a new continuation line `#        --compose --env-file --profile`
- Insert after `:192` (end of the audit block), blank-line separated:

```
# Harden command options
rfapps harden --<TAB>
# Shows: --service --services --group --no-sidecars --apply --out
#        --include-review --rule --list-rules --no-backup --allow-reformat
#        --compose --env-file --profile --json
```

Also update `### Deploy Completion Parity`'s canonical set (`:243-248`): change `:247` from `--env-file --profile` to `--env-file --profile --scan --scanner --scan-fail-on`.

### 6. `docs/features/quick-reference.md` — two edits

**Edit B — `## Related Documentation`.** After `:466` (the backup entry):

```markdown
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` CVE reporting and the deploy gate
- [rfapps Harden Command](rfapps-harden-command.md) - Compose hardening proposals, overrides, and `--apply`
```

**Edit A — two new `## Essential Commands` subsections.** Insert after `:176` (end of `### Native Filesystem Backup`), before `## Service Groups` at `:178`. Model: the `### Native Filesystem Backup` block at `:149-176` — a `bash` fence with `#` comments, two short prose paragraphs, a "See …" pointer.

````markdown
### Vulnerability Scanning

```bash
# Advisory report alongside a plan
rfapps plan -g media-stack --scan

# Gate a deploy at high and above; nothing is pulled or started when it blocks
rfapps deploy -s plex --scan --scan-fail-on high --yes

# Pick a backend explicitly
rfapps plan -s sonarr --scan --scanner grype

# Preview the verdict without deploying
rfapps deploy -s plex --scan --scan-fail-on critical --dry-run

# Machine envelope: { planPath, plan, scan }
rfapps plan -s plex --scan --output json
```

`--scan` is opt-in and resolves images from `docker compose config`, so build-only services are
skipped and each distinct image is scanned once. The default threshold is `--scan-fail-on none`
(report only, exit `0`).

With any other threshold the gate is fail-closed: a missing scanner, a timeout, a capture overflow, a
non-zero scanner exit, and an unparsable report all resolve to `inconclusive` and block with exit
`1`. On `deploy` the gate runs before any pull or container start, so a blocked run modifies nothing;
`--yes` does not waive it. `plan` still writes the plan file but suppresses `--apply`. `plan
--dry-run` short-circuits before plan generation, so it scans nothing.

See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) for backends, skips,
suppressions, JSON shape, and limitations.

### Security Hardening

```bash
# Propose only; writes nothing
rfapps harden

# Restrict to one rule and emit a compose override fragment
rfapps harden --rule harden-no-new-privileges --out compose.harden.yaml

# Edit compose.yml in place after a .bak copy and one confirmation
rfapps harden --apply

# Include review-confidence rules in the written output
rfapps harden --apply --include-review

# Catalog and machine output
rfapps harden --list-rules
rfapps harden --json
```

A bare `rfapps harden` writes nothing and touches no containers, images, or recorded state. Proposals
are split by confidence: `safe` changes are mechanical, `review` changes can break a workload and are
excluded from writes unless `--include-review`, and `advisory` proposals (healthcheck, memory, CPU)
are never written because rfapps will not invent a probe command or a resource ceiling.

`--apply` refuses to edit a key that resolves to a YAML alias, and refuses when re-serializing
`compose.yml` would reformat lines it did not target unless `--allow-reformat` is passed. Exit `0` on
a clean propose, override, apply, or cancellation; `3` when an apply wrote some patches and refused
others; `1` on compose or write failure; `2` on usage errors.

See [rfapps Harden Command](rfapps-harden-command.md) for the rule catalog, override semantics, and
exit-code contract.
````

### 7. `docs/features/rfapps-configuration.md` — two edits

**Edit B — `### Optional Fields`.** Insert after `:126` (`envTool.*`):

```markdown
- `scan.scanner` - Default backend for `plan --scan` / `deploy --scan` (`trivy` or `grype`; default:
  `trivy`)
- `scan.failOn` - Default gate threshold: `none`, `unknown`, `negligible`, `low`, `medium`, `high`,
  or `critical` (default: `none`, report only)
- `scan.ignore` - Time-boxed CVE suppressions; `reason` is required and an expired `until` stops
  suppressing
- `scan.timeoutMs` / `scan.maxTargets` / `scan.concurrency` - Per-image scanner timeout, cap on
  distinct images scanned per invocation, and concurrent scanner processes
- `harden.includeReview` - Include review-confidence proposals in `rfapps harden` written output
  (default: `false`)
- `harden.backup` - Take a `compose.yml.bak` before `rfapps harden --apply` (default: `true`)
- `harden.rules` - Restrict the harden catalog to specific `harden-*` rule ids
- `harden.ignore` - Rule/service suppressions for `rfapps harden`

Neither section has an environment-variable override: there are no `RFAPPS_SCAN_*` or
`RFAPPS_HARDEN_*` variables, by design.
```

**Edit A — complete YAML example.** Insert after `:98` (`tool: dotenvx # or 'op' or 'none'`), still inside the fence at `:22-99`:

```yaml
# Image vulnerability scanning (opt-in per invocation via plan/deploy --scan)
scan:
  scanner: trivy # trivy | grype
  failOn: none # none | unknown | negligible | low | medium | high | critical
  ignore:
    - id: CVE-2024-56171
      service: plex
      reason: "no upstream fix in the linuxserver image"
      until: "2026-12-31"

# Security hardening rules (`rfapps harden`)
harden:
  includeReview: false
  backup: true
  ignore:
    - rule: harden-memory-limit
      service: plex
```

### 8. `rfapps.config.yaml` — one edit

Append after `:168` (end of the `lint:` block). **Everything stays commented out** — this is the shipped base config and both sections are optional, so default behaviour must remain byte-identical.

```yaml
# Image vulnerability scanning (opt-in per invocation via --scan)
# scan:
#   scanner: trivy
#   failOn: none
#   ignore:
#     - id: CVE-2024-56171
#       service: plex
#       reason: "no upstream fix in the linuxserver image; not reachable in this configuration"
#       until: "2026-12-31"

# Security hardening rule suppressions (`rfapps harden`)
# harden:
#   includeReview: false
#   backup: true
#   ignore:
#     - rule: harden-memory-limit
#       service: plex # GPU workload; limits are host-dependent
#     - rule: harden-run-as-non-root
#       service: traefik # binds :80/:443
```

Exactly one blank line between the `lint:` block and the first new comment header, and one between the two new blocks. **Do not uncomment either section.**

### 9. `packages/rfapps-cli/CLAUDE.md` — two edits

**Edit B — two new `## Architecture Patterns` subsections.** Insert after `:285` (end of `### Native Backup Architecture`), before `### State Persistence with SQLite` at `:287`. Match the density and shape of `### Native Backup Architecture` (`:246-285`): one-line lead, a `text` fenced pipeline, an invariants bullet list, a closing pointer.

````markdown
### Image Vulnerability Scanning Architecture

Scanning is an opt-in read-only pre-flight bolted onto `plan` and `deploy`; there is no `rfapps scan`
command:

```text
cli.ts (plan --scan | deploy --scan)
  -> actions/plan.ts | actions/deploy.ts
  resolveScanSettings (CLI ?? scan: config ?? hard default)
  -> lib/docker.ts getComposeConfig            resolved image refs, build: exclusion for free
  -> lib/security-scan.ts resolveScanTargets   build-only / no-image / duplicate-image / target-cap
  -> lib/security-scan.ts runSecurityScan      bounded worker pool -> trivy|grype -> normalize
  -> evaluateScanGate -> ScanReport.gate.blocking
  -> lib/exit-codes.ts setScanExitCode
```

Invariants:

- the report attaches to the action's **output envelope** (`{ planPath, plan, scan }` and
  `DeployResult.scan`), never to `DeploymentPlan`. `savePlan` JSON-stringifies the whole plan, so an
  embedded CVE verdict would decay and `rfapps apply <path>` days later would re-assert it as
  authoritative;
- scan targets come from `getComposeConfig`, never from the generated plan;
- the gate is fail-closed: `scanner-unavailable`, `timeout`, `output-limit`, `scanner-error`, and
  `invalid-report` all resolve to `inconclusive`, which blocks whenever `--scan-fail-on` is not
  `none`. The hard default is `none` (advisory) — asking to scan is not asking to gate;
- `gate.blocking` is computed once by `evaluateScanGate`; no caller re-derives it;
- deploy evaluates the gate before `pullImages` and `startServices`, so a blocked deploy mutates
  nothing and pushes a `failed[]` entry rather than throwing;
- `scan`, `scanner`, and `scanFailOn` are deliberately absent from `planInputSchema` and
  `deployInputSchema` and are not forwarded by `invokeDeploy` (`src/mcp/adapters.ts:276-303`) or
  `invokePlan` (`:402-428`). **The invariant is "never create the key", not "never populate it":**
  `schemaObject` is `additionalProperties: false` and its strict-key check iterates
  `Object.keys(input)`, so `{ scan: undefined }` throws `Unexpected properties at $: scan` at MCP
  runtime while typechecking clean, and the MCP path hands the raw object to `outputSchema.parse`
  without a JSON round trip. Assign `result.scan` only inside `if (options.scan)`, and keep plan's
  conditional spread;
- if a future change surfaces these flags over MCP, `scanReportSchema` must be mirrored into
  `planResultSchema` (`src/mcp/schema.ts:522`) and `deployResultSchema` (`:297`) in the same commit.
  For the same reason `ScanConfig` must never gain an `enabled`/`always` key without that mirror —
  config alone would then turn scanning on for every `rfapps.plan` / `rfapps.deploy` MCP call.

Digest pinning of scan targets, SBOM/SARIF export, an on-disk finding cache, and `docker scout` /
`snyk` backends are deliberately outside v1. See
`docs/features/rfapps-vulnerability-scanning.md` for the operator contract.

### Compose Hardening Architecture

`rfapps harden` is the remediation counterpart to `lint` and `audit`, with a propose-first mutation
envelope modelled on `drift import`:

```text
commands/harden.ts (validateHardenOptions, also called from cli.ts preAction)
  -> actions/harden.ts
  config + scope + mode derivation + confirmation + backup + output
  -> lib/docker.ts getComposeConfig         resolved services -> detection input
  -> lib/hardening.ts evaluateHardening     HARDEN_RULES -> proposals, suppressions
  -> lib/hardening.ts filterWritableProposals / applyHardenPatches / buildHardenOverride
  -> lib/exit-codes.ts setHardenExitCode
```

Invariants:

- detection reads the **resolved** compose config; writes go through `parseDocument(source)` on the
  **raw** compose file, so anchors, aliases, and `x-` extension fields survive;
- **no patch may target a YAML alias.** `applyHardenPatches` refuses with
  `HardenRefusal{ code: "alias-target" }` and names `--out` instead; editing a key like
  `logging: *logging-default` would silently reconfigure every service sharing the anchor;
- **no patch may use a nested path.** `HardenPatch.key` is a single top-level key under
  `services.<name>`; a nested encoding is refused as `nested-path` and a rule that genuinely needs
  one must be `advisory` instead;
- sequence-valued patches use `merge-unique`, never `set`, so `--apply` twice is a no-op and an
  existing `security_opt`/`cap_drop` entry is never dropped — a hardening tool that weakens security
  is the bug class this prevents. Override fragments emit the full union because a Compose override
  replaces sequences rather than appending to them;
- `HARDEN_RULES` is a separate catalog. `LINT_RULES` is not extended, shipped `rfapps lint` output is
  unchanged, and `harden-*` ids never collide with `LintRuleId` or `AuditRuleId`. Consequently
  `harden` cannot reuse `lint.ignore` and has its own `harden:` config section;
- serialization is fixed at `{ lineWidth: 0, flowCollectionPadding: false }` in
  `serializeComposeDocument`, the only serializer. `detectReformat` runs in every mode and `--apply`
  refuses unacknowledged churn rather than silently reflowing untargeted lines;
- refusals are reported and non-fatal: detection stands, only the automated write is withheld, and an
  alternative is always named. A partial apply exits `3`;
- `harden` is not MCP-surfaced (neither are `lint`, `audit`, or `doctor`), and `harden --apply` takes
  the global state lock because it writes the same `compose.yml` as `drift import`.

Synthesised healthcheck probes, memory ceilings, and CPU ceilings; automated removal of
`privileged: true`; a unified-diff patch format; and user-defined rules are deliberately outside v1.
See `docs/features/rfapps-harden-command.md` for the operator contract.
````

**Edit A — directory tree.** Two insertions:

_A1._ After `:35` (`backup.ts` under `commands/`, alphabetical):

```
│   │   ├── harden.ts       # Compose security hardening command definition
```

_A2._ After `:47` (`drift.ts` under `actions/`, alphabetical):

```
│   │   ├── harden.ts       # Propose, emit, or apply compose hardening
```

Do **not** add `lib/hardening.ts`, `lib/security-scan.ts`, `types/hardening.ts`, or `types/security-scan.ts` to the tree: the `lib/` and `types/` listings are already curated subsets (they omit `lint.ts`, `audit.ts`, `exit-codes.ts`, `security-audit.ts`, `types/lint.ts`, `types/audit.ts`, and more). The two new architecture subsections name every new module explicitly.

### 10. Conventions

- `markdownlint-cli2` with MD013 and MD024 disabled — repeating `### Exit Codes` is fine. Prettier formats `*.md` at `printWidth: 120` with `proseWrap: "preserve"`: it will **not** rewrap prose but **will** re-pad every table. Do not hand-align pipes; run `npm run format`.
- Every heading surrounded by a blank line. Existing prose wraps at ~100 columns — match it by hand.
- Link style: from `docs/features/*.md` to the package README use `../../packages/rfapps-cli/README.md#anchor`; from `P/README.md` to feature docs `../../docs/features/<name>.md`; from `docs/README.md` `features/<name>.md`; from root `README.md` `docs/features/<name>.md`.
- `rfapps.config.yaml` is covered by `prettier --check .`; comment-only additions are preserved verbatim.
- No TypeScript in this task. The ~500-line cap does not apply to docs.
- Commit style if committing separately: `docs(rfapps): …`. `P/CLAUDE.md` is agent guidance, **not** `docs(internal)`.

### 11. What NOT to do

- Do not create `docs/features/rfapps-vulnerability-scanning.md` or `docs/features/rfapps-harden-command.md` (T8's) — you only link to them.
- Do not touch `ROADMAP.md` or `docs/roadmap-archive.md` (T10), `docs/features/json-output.md` / `output-formats.md` / `error-handling.md` / `packages/rf-common/README.md` (T11), or root `CLAUDE.md` (no change; its Topic/Location table is curated and already omits drift/audit/doctor/backup).
- Do not add a `rfapps scan` command row anywhere; there is no such command.
- Do not add a `--fail-on` to any harden documentation.
- Do not write any spec/test file.
- Do not "fix" `docs/README.md:5` ("38 containerized applications") or root `CLAUDE.md`'s service counts — out of scope per policy 5.

### Acceptance

- [ ] `env -u FORCE_COLOR npm run lint:md` exits 0.
- [ ] `env -u FORCE_COLOR npm run format:check` exits 0 (run `npm run format` first).
- [ ] `grep -c 'rfapps-vulnerability-scanning.md' docs/README.md README.md docs/features/quick-reference.md docs/features/shell-completion.md` returns ≥1 for each; same for `rfapps-harden-command.md`.
- [ ] Both T8 files exist on disk before T9 is marked done.
- [ ] `grep -n 'rfapps harden' docs/README.md` shows exactly one new command-table row with description `Propose or apply compose security hardening` and confirmation `Apply only`.
- [ ] `grep -n '^### harden' packages/rfapps-cli/README.md` returns exactly one hit, between `### audit` and `### pull`.
- [ ] The harden option table lists exactly the 15 long options; verify mechanically against `npm run rfapps -- harden --help`.
- [ ] `--scan`, `--scanner <name>`, `--scan-fail-on <severity>` appear in **both** the `### deploy` and `### plan` option tables of `packages/rfapps-cli/README.md`.
- [ ] `packages/rfapps-cli/README.md`'s `**Key Features:**` list gained scanning and hardening bullets, and the state-mutation-locking paragraph names `harden --apply`.
- [ ] For each shell, `npm run rfapps -- completion <shell>` output contains every option name documented in the new `### Harden Completion Behavior` block, and vice versa.
- [ ] `docs/features/shell-completion.md:120-121` contains `harden`, `import`, and `force-unlock` and is a superset of `packages/rfapps-cli/src/actions/completion.ts:40`.
- [ ] `node -e "const y=require('yaml');const c=y.parse(require('fs').readFileSync('rfapps.config.yaml','utf8'));console.log(c.scan, c.harden)"` prints `undefined undefined`.
- [ ] `env -u FORCE_COLOR npm run rfapps -- harden --list-rules` exits 0 (no config regression).
- [ ] `docs/features/rfapps-configuration.md` `### Optional Fields` has bullets for `scan.scanner`, `scan.failOn`, `scan.ignore`, `harden.includeReview`, `harden.backup`, `harden.ignore`, `harden.rules`, and states there are no `RFAPPS_SCAN_*` / `RFAPPS_HARDEN_*` overrides.
- [ ] `packages/rfapps-cli/CLAUDE.md` has exactly two new `###` subsections between `### Native Backup Architecture` and `### State Persistence with SQLite`, and `harden.ts` appears exactly twice in the directory tree, both in alphabetical position.
- [ ] No owned file contains `47 services`, `42 of 47`, or a signed `+6` line-delta claim.
- [ ] `git diff --name-only` lists only the 8 owned files.

### Pitfalls

- Design anchors drift 1–3 lines; re-anchor with `grep -n` for the named construct.
- Prettier re-pads markdown tables — write them loosely and format once, or `format:check` rewrites your hand-alignment.
- Prefix every gate with `env -u FORCE_COLOR`, run under `umask 022`, and bootstrap a fresh worktree with `npm ci` + `npm run build -w packages/rf-common` before any `npm run rfapps -- …` verification.
- Commander registers `--no-backup`/`--no-sidecars` for harden; there is **no** `--backup` flag on harden (unlike `drift import`). Documenting `--backup` diverges from T7's parity test.
- `compose.yml` has 44 services, not 47.
- Do not claim harden alias-refuses 42 services — measured, `harden-log-rotation` does not fire on them at all.
- The reformat **removes** 6 lines. Never write `+6`.
- `P/CLAUDE.md` has no pre-existing MCP warning to append to — create the note inside the new scanning subsection.
- State the MCP invariant as "never **CREATE** the key", not "never populate it", or the note is actively misleading.
- `shell-completion.md`'s per-command block is the fence at `:145-215`; editing outside it produces broken markdown.
- `--scan-fail-on` uses the CVE scale (`none unknown negligible low medium high critical`), **different** from `--fail-on`'s compose scale (`none info warn error critical`) on audit/doctor/lint. Do not mix them.
- Follow `### lint`'s pattern for harden's config YAML — do **not** insert a `scan:` block inside `### lint`.
- Show a commented allowlist for `harden.rules`, never `rules: []` (an empty array means the full catalog).
- If T7 has not landed, the shell-completion claims cannot be verified against generated scripts — do not mark T9 done on unverified completion prose.

---

## T10 — Roadmap

**Owns (both MODIFIED):** `ROADMAP.md`, `docs/roadmap-archive.md`
**Depends on:** nothing
**Wave:** 6

No TypeScript, no tests. Applicable conventions are markdown ones only.

### 0. Preconditions

**0.1 The closing PR number.** Verified today via `gh`: PR **#299** (`feat(rfapps): add vulnerability scanning and harden command`, head `feat-security-scan-harden`) exists but is **CLOSED** — a superseded earlier attempt on this same branch. **Never cite #299.** The highest allocated number is 299, so the real PR is **300 or higher**.

```bash
# Preferred, once the PR exists, from the branch:
gh pr view --json number --jq .number
# Before it exists, next number = highest allocated + 1:
gh api "repos/yandy-r/rfmedia-apps/issues?state=all&per_page=1" --jq '.[0].number'
```

Replace every `NNN` placeholder below with that number; **no literal `NNN` may survive.** If T10 runs before the PR is opened, write the predicted number and re-run the acceptance grep before merge.

**0.2 Issue counts — verified live, do not re-derive by hand.** `gh issue list --state open --limit 300` → total **81**, rfapps-cli **38**, rfmedia-cli **43**. Both #161 and #162 are OPEN and carry the `rfapps-cli` label. Closing them gives **79 (rfapps 36 · rfmedia 43)** — the post-merge number, matching precedent commit `df32f59a`. If unrelated issues move before merge, re-run and adjust; the invariant is `written total == live total − 2` at the time of writing.

**0.3 The date.** Use the commit date (today: **2026-07-30**) for `ROADMAP.md:8` and the archive H2 at `docs/roadmap-archive.md:11`. **Leave `docs/roadmap-archive.md:7`** (`**Archived:** 2026-07-29 (Layer 3 intelligence sprint closed)`) unchanged — it records when the archive split happened.

### 1. `ROADMAP.md` — six edits

**1.1 `:8`** — `**Last updated:** 2026-07-29` → `**Last updated:** 2026-07-30`

**1.2 `:10`** — `**Open issues:** 81 (rfapps 38 · rfmedia 43)` → `**Open issues:** 79 (rfapps 36 · rfmedia 43)`. The separator is U+00B7 MIDDLE DOT — preserve it.

**1.3 `:27-31`** — Current-focus first paragraph. Replace with:

```markdown
Lifecycle, copy-integrity, adapter isolation, Lidarr Layers 1–3 (through consumption policy and
ratings sync), radio-scheduling separation, state locking, deploy conflict validation,
runtime-state import/rebuild, staged group deploys, contextual plan intelligence, native cold
filesystem backup and offline verification, opt-in image vulnerability scanning and compose
security hardening, Plex JWT enrollment, and metadata drift reconciliation have shipped (see
[archive](docs/roadmap-archive.md)). No `priority:high` issue remains.
```

(`1–3` is an EN dash, U+2013.)

**1.4 `:36-38`** — Current-focus second paragraph tail. Replace with:

```markdown
[`docs/internal/plex-jwt-deferrals.md`](docs/internal/plex-jwt-deferrals.md). Near-term focus is
rfmedia post-JWT hygiene (#288, #289) and filing the #209 policy follow-ups before larger Lidarr
Phase E work.
```

**1.5 `:47-58`** — Delete lines **47 through 58 inclusive** (the `### Sprint 1 — rfapps recovery & operator trust` heading, prose, one-row table, exit criteria, and the trailing blank line). After deletion, `:46` (blank) is followed directly by `### Parallel — rfmedia post-JWT hygiene`.

**Do NOT renumber `### Sprint 2 — Lidarr policy follow-through`.** Renumbering a live sprint is roadmap restructuring beyond issue closure, and it would put a third meaning on the ordinal "1" while `docs/roadmap-archive.md:177` and the archive's "Next Up Sprint 1" item still refer to older ones. Also do not rename `### Parallel — rfmedia post-JWT hygiene`.

Deletion (rather than in-place row removal) is the documented behaviour for a fully-closed sprint: `ROADMAP.md:271-272` says "move narrative to `docs/roadmap-archive.md` only when a full sprint closes", and §2.2/§2.3 below do exactly that.

**1.6 `:102` and `:111-112`** — Medium-priority backlog.

`:102`: `### Medium priority — state, security & deploy (7)` → `### Medium priority — state, security & deploy (5)`. Keep the heading text; only the count changes.

Delete these two rows verbatim (`:111-112`), leaving the other five (#63, #66, #74, #153, #154) and the header untouched:

```markdown
| [#161](https://github.com/yandy-r/rfmedia-apps/issues/161) | Vulnerability scanning in deploy workflow |
| [#162](https://github.com/yandy-r/rfmedia-apps/issues/162) | Security hardening automation |
```

**Out of scope for `ROADMAP.md`:** `## Cross-cutting themes` (`:256-264`) — do not invent a security row; `## Maintenance` (`:268-273`) — unchanged; any link to the new feature docs — `ROADMAP.md` links issues, not feature docs.

### 2. `docs/roadmap-archive.md` — four edits

**2.1 `:11`** — `## What shipped (through 2026-07-29)` → `## What shipped (through 2026-07-30)`

**2.2 New What-shipped table row** — insert immediately after `:20` (the `rfapps operator trust & recovery` row added by `df32f59a`), before the `rfmedia integrity & performance` row at `:21`:

```markdown
| rfapps security & hardening | [#161](https://github.com/yandy-r/rfmedia-apps/issues/161), [#162](https://github.com/yandy-r/rfmedia-apps/issues/162) | [#NNN](https://github.com/yandy-r/rfmedia-apps/pull/NNN) |
```

Padding need not be hand-aligned; prettier re-pads. Note `/pull/` for PRs, `/issues/` for issues.

**2.3 Two operator-note bullets** — insert after `:65` (the `See [native backup docs](features/rfapps-backup.md).` line) and before the `Tiered verify (#116 / #249)` bullet at `:66`. Continuation lines indented exactly **2 spaces**; manual wraps at ≤100 columns.

```markdown
- **Image vulnerability scanning (#161 / #NNN):** opt-in `--scan` on `rfapps plan` and
  `rfapps deploy` scans the image references `docker compose config` resolves, one scanner process
  per distinct image, with `trivy` or `grype` selected explicitly — a requested-but-absent scanner is
  reported by name, never silently substituted. Scanning is advisory by default
  (`--scan-fail-on none`); once a threshold is set the gate is fail-closed, so a missing scanner, a
  per-image timeout, a capture overflow, or an unparsable report all resolve to `inconclusive` and
  block rather than passing on zero findings. Deploy's gate runs before pull and before any
  container mutation, and `deploy --dry-run --scan` still reports a would-block gate while exiting 0. The report rides the plan/deploy output envelope and is never persisted into the saved plan
  artifact, so `rfapps apply <path>` cannot re-assert a stale CVE verdict days later. Operator
  notes: images are scanned as compose resolves them, so a mutable tag describes whatever the
  registry serves at scan time — pin digests in `compose.yml` for a hard guarantee; there is no
  finding cache and no SBOM/SARIF export; `scan.ignore` suppressions require a reason and expire
  through `until`; and scan arguments are deliberately absent from the MCP surface. See
  [vulnerability scanning docs](features/rfapps-vulnerability-scanning.md).
- **Security hardening automation (#162 / #NNN):** `rfapps harden` proposes compose security
  changes across capabilities, identity, filesystem mode, logging, resource limits, health checks,
  and restart availability. Detection reads the resolved compose config, every write goes through
  the comment- and anchor-preserving YAML document, and the rule catalog is namespaced `harden-*`
  so shipped `rfapps lint` and `rfapps audit` output is unchanged. Propose mode is the default and
  writes nothing; `--out` emits an override fragment without clobbering an existing file; `--apply`
  edits `compose.yml` in place only after a `.bak` copy and a confirmation. Only `safe` proposals
  are written (`--include-review` adds the `review` tier), and the three advisory rules — health
  check, memory limit, cpu limit — are detection plus guidance by design: rfapps will not invent a
  probe command or a resource ceiling. A patch aimed at a YAML alias is refused with the `--out`
  alternative rather than rewriting every service that shares the anchor; override fragments emit
  the full resulting list for sequence-valued keys, because a compose override replaces sequences
  instead of appending to them; and `--apply` refuses to reformat lines it did not target unless
  `--allow-reformat` is given. Harden is not a findings gate and has no `--fail-on`: refusals are
  reported, and exit 3 means `--apply` wrote some patches and withheld others. Bash, Zsh, and Fish
  completions ship in parity. See [harden docs](features/rfapps-harden-command.md).
```

Two things you must **not** write: any service count (44 or 47 — the bullets above have none), and any reformat line-delta number or a claim that the log-rotation rule is alias-refused on this repo's services.

**2.4 `:197`** — Append one item to the former "Next Up" sprints list, as the new `:198`:

```markdown
15. rfapps recovery, operator trust & security — #152, #160, #161, #162
```

Deliberately no "(Next Up Sprint N)" suffix — item 14 already claims "Next Up Sprint 1". Leave the closing paragraph at `:199-201` and `### Minor docs follow-up (still open)` (`:175-178`) unchanged.

### 3. Character-level traps

Headings use EM dash `—` (U+2014); "Layers 1–3" uses EN dash `–` (U+2013); the issue-count line uses `·` (U+00B7); the archive H2 at `:182` uses curly quotes `"Next Up"`. **Copy-paste, do not retype.** Archive bullet continuation lines are indented exactly 2 spaces — 4 spaces turns wrapped text into an indented code block.

### 4. Formatting gates

```bash
cd <worktree-root>
env -u FORCE_COLOR npx prettier --write ROADMAP.md docs/roadmap-archive.md
env -u FORCE_COLOR npx prettier --check ROADMAP.md docs/roadmap-archive.md
env -u FORCE_COLOR npm run lint:md
```

`.prettierrc` sets `proseWrap: "preserve"` with `printWidth: 120` for `*.md`, so prettier will **not** rewrap prose (keep manual ~100-column wraps) but **will** re-pad tables. `.markdownlint.json` disables MD013; MD022 (blank line around headings) is active.

### 5. Commit

Neither file lives under `docs/plans|research|internal`, so this is user-facing docs. Following precedent `df32f59a`:

```
docs(roadmap): close vulnerability scanning and harden delivery
```

If squashed into the feature PR, no separate commit is needed.

### Acceptance

- [ ] `grep -n "16[12]" ROADMAP.md` returns no matches.
- [ ] `ROADMAP.md:8` reads `**Last updated:** 2026-07-30` (or the actual commit date) and `:10` reads `**Open issues:** 79 (rfapps 36 · rfmedia 43)`; `gh issue list --state open --limit 300 --json number | jq length` equals 79 after #161/#162 close.
- [ ] `grep -n '^### Sprint' ROADMAP.md` returns exactly one hit: `### Sprint 2 — Lidarr policy follow-through` (unrenamed); `grep -n '### Parallel — rfmedia post-JWT hygiene' ROADMAP.md` still matches.
- [ ] `grep -n '### Medium priority — state, security & deploy (5)' ROADMAP.md` matches and the table under it has exactly 5 issue rows (#63, #66, #74, #153, #154).
- [ ] `docs/roadmap-archive.md` contains exactly one new What-shipped row whose Track cell is `rfapps security & hardening`, citing both #161 and #162 and one `/pull/<N>` link.
- [ ] `docs/roadmap-archive.md` contains the two new bullets, positioned between the `Native backup (#160 / #297)` bullet and the `Tiered verify (#116 / #249)` bullet.
- [ ] `docs/roadmap-archive.md:11` reads `## What shipped (through 2026-07-30)`; `:7` is unchanged; the numbered list ends with `15. rfapps recovery, operator trust & security — #152, #160, #161, #162`.
- [ ] `grep -rn 'NNN\|#PR\|TODO\|pull/299' ROADMAP.md docs/roadmap-archive.md` returns no matches.
- [ ] `env -u FORCE_COLOR npx prettier --check ROADMAP.md docs/roadmap-archive.md` passes and `env -u FORCE_COLOR npm run lint:md` exits 0.
- [ ] `git diff --name-only` for this task lists only `ROADMAP.md` and `docs/roadmap-archive.md`.
- [ ] No service count and no reformat line-delta number appears anywhere in the added prose.

### Pitfalls

- **PR #299 is CLOSED** — a superseded attempt on this exact branch. Citing it links operators to a dead PR. Resolve the real number with `gh pr view --json number --jq .number`.
- Issue counts are **post-merge**: write 79 / 36 / 43, not today's live 81 / 38 / 43.
- The Sprint 1 block is `:47-57` (+ blank `:58`), not `:49-58`. Re-anchor by heading text.
- **Do not renumber Sprint 2**, and do not touch `docs/roadmap-archive.md:177` ("after Sprint 2" — a different, historical sprint).
- `compose.yml` has 44 services; keep counts out of roadmap prose entirely.
- The `+6` reformat delta is wrong in sign, and the "alias-refused on 42 services" claim is unreachable on the real compose. Promise neither.
- Prettier re-pads tables but does not rewrap prose — keep manual ~100-column wraps and always `prettier --write` after touching a table.
- Unicode: EM dash in headings, EN dash in `Layers 1–3`, MIDDLE DOT in the issue-count separator, curly quotes in the archive H2. Copy-paste.
- Archive continuation lines are exactly 2 spaces.
- The archive bullets link `features/rfapps-vulnerability-scanning.md` and `features/rfapps-harden-command.md` (relative to `docs/`), created by T8. No CI link checker exists, but the filenames must match T8 character for character.
- Do not add a Cross-cutting-themes row or any feature-doc link to `ROADMAP.md`, and do not edit `docs/README.md`, `README.md`, `P/README.md`, or `docs/features/*` (T8/T9/T11).
- Run gates with `env -u FORCE_COLOR` under `umask 022`.

---

## T11 — Reference doc surfaces

**Owns (all MODIFIED):** `docs/features/json-output.md`, `docs/features/output-formats.md`, `docs/features/error-handling.md`, `packages/rf-common/README.md`
**Depends on:** T6, T8
**Wave:** 6

**New task, created to close a real ownership gap.** The immediately preceding feature commit `6e78968b` (native backup, #297) touched `error-handling.md` (+51), `json-output.md` (+110), and `output-formats.md` (+35) in the same PR; every versioned schema in this repo has a per-command section in `json-output.md`. `packages/rf-common/CLAUDE.md` step 5 requires an API entry in `packages/rf-common/README.md` for every new utility. Without this task, T8's two feature docs link to `json-output.md` and `error-handling.md` and readers find no scan/harden entry, and `checkExternalTool` ships undocumented.

**Zero TypeScript, zero tests. Four files, all modified. No new files.**

### 0. Facts and constraints

Same markdown conventions as T9: `.prettierrc` markdown override `{ proseWrap: "preserve", printWidth: 120 }` (you hard-wrap prose at ~100 columns; prettier re-pads tables); `.markdownlint.json` disables MD013/MD024/MD040/MD041/MD051 but **enables MD034 (no bare URLs)**, MD012, MD022, MD025, MD031, MD032, MD047. Blank line around every heading; every fence carries a language.

Same forbidden claims as everywhere else: no "47 services"; no alias-refusal-count claim; no signed `+6` line delta; no `file:line` anchors in prose; no `rfapps scan` command; no `--fail-on` on harden.

Cross-check every schema field name against `packages/rfapps-cli/src/types/security-scan.ts` and `packages/rfapps-cli/src/types/hardening.ts` before writing, and every exit-code claim against `packages/rfapps-cli/src/lib/exit-codes.ts` (`Success 0`, `OperationalError 1`, `UsageError 2`, `PartialSuccess 3`).

### 1. `docs/features/json-output.md` — three edits

**Edit A — extend `### Deploy Command` (`:67`).** That section documents `DeployResult`. Add, after the existing field description and before the next `###`:

- One sentence: under `--scan`, the deploy result carries an additional optional `scan` field holding a `security-scan.v1` report, and when the gate blocks it also carries a `failed[]` entry named `scan` with code `VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`.
- A `json` fence showing only the delta — the existing deploy shape plus:

```json
{
  "services": ["plex"],
  "failed": [
    {
      "name": "scan",
      "code": "VULNERABILITY_THRESHOLD",
      "error": "Image vulnerability scan found findings at or above the configured severity"
    }
  ],
  "healthy": [],
  "unhealthy": [],
  "started": 0,
  "scan": { "schemaVersion": "security-scan.v1", "gate": { "status": "blocked", "blocking": true } }
}
```

- One sentence: the `scan` field is absent unless `--scan` was passed, and it is stripped for `--output table` and `--output csv`.
- One sentence: `scan` is not part of the MCP `rfapps.deploy` output schema — `rfapps.deploy` does not accept `scan`, `scanner`, or `scanFailOn`, so an MCP result never carries the field.
- A pointer: `See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md).`

**Edit B — new `### Plan Command` scan subsection.** `json-output.md` has no `### Plan Command` section today; add one **immediately before `### Doctor Command` (`:237`)**, styled like the neighbouring per-command sections:

- Lead: `rfapps plan --output json` emits `{ planPath, plan }`; with `--scan` the envelope gains a third top-level key, `scan`, carrying a `security-scan.v1` report.
- A `json` fence with `{ "planPath": "…", "plan": { … }, "scan": { "schemaVersion": "security-scan.v1", … } }` — trimmed, field names matching `types/security-scan.ts`.
- Sentences: the report lives on the **output envelope**, never inside the saved plan file, so `rfapps apply <path>` days later cannot re-assert a stale verdict; `table` and `csv` strip it; `plan --dry-run --scan` produces no plan and therefore no scan.
- Pointer to `rfapps-vulnerability-scanning.md`.

**Edit C — new `### Harden Command` section.** Insert after `### Audit Command` (`:404-449`), before `### Native Backup Commands` (`:450`), matching that section's shape (lead, field table or fence, exit-code note, pointer):

- Lead: `rfapps harden --json` (or `--output json` / `--output yaml`) emits exactly one `harden.v1` document on stdout; human text and diagnostics stay on stderr.
- Top-level field list: `schemaVersion`, `timestamp`, `mode` (`propose` | `override` | `apply`), `includeReview`, `scope`, `summary`, `proposals`, `refusals`, `reformat`, `override`, `write`.
- A trimmed `json` fence — reuse T8 File B's sample structure (one safe proposal, one advisory proposal, one refusal), with `lineDelta`'s sign taken from `detectReformat`.
- The three `write` shapes: `{ "mode": "propose" }`; `{ "mode": "override", "path": "…", "patchesWritten": 6 }`; `{ "mode": "apply", "path": "…", "backupPath": "…", "patchesWritten": 6, "servicesPatched": ["radarr", "sonarr"] }`.
- Determinism sentence: proposals sort by confidence, then service, then catalog order; patches keep declaration order; refusals sort by service then rule id.
- One sentence: `table` and `csv` flatten the top level and are not a substitute — `proposals`, `refusals`, and `override` are JSON/YAML detail. `harden` is not MCP-surfaced.
- Pointer: `See [rfapps Harden Command](rfapps-harden-command.md).`

### 2. `docs/features/output-formats.md` — two edits

**Edit A — `## Format Details` (`:77-459`), table/CSV flattening note.** Find the subsection that describes what `table` and `csv` drop for nested payloads (the same place `validation` / `staged` flattening is discussed for deploy) and add one bullet or sentence: `--output table` and `--output csv` strip the nested `scan` report from `plan` and `deploy` results and the nested `proposals` / `refusals` / `override` detail from `harden`; use `json` or `yaml` when automating against those payloads.

**Edit B — `## Related Documentation` (`:951`).** Add two entries in the existing style:

```markdown
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` report shape and which formats carry it
- [rfapps Harden Command](rfapps-harden-command.md) - `harden.v1` result shape and format behaviour
```

If `## Output Structure Examples` (`:460`) enumerates per-command example payloads, add a short `plan --scan` example there too, matching the surrounding density — otherwise skip it rather than inventing a new subsection shape.

### 3. `docs/features/error-handling.md` — two edits

**Edit A — new `### Vulnerability Scan Exit Semantics`.** Insert after `### Native Backup Exit Semantics` (`:64-77`), before `## User-Facing Error Messages` (`:78`), matching that subsection's shape:

- Default `--scan-fail-on none` is advisory: every failure mode is reported and the command exits `0`.
- With any other threshold the gate is fail-closed — `scanner-unavailable`, `timeout`, `output-limit`, `scanner-error`, `invalid-report` all resolve to `inconclusive` and exit `1`, exactly like a threshold breach. A scan that "passes" because no scanner is installed is not offered.
- On `plan`, exit `1` also means `--apply` was suppressed; the plan file is still written as evidence and `rfapps apply <path>` remains the explicit override.
- On `deploy`, exit `1` means nothing was pulled and no container was modified; the result carries a `failed[]` entry named `scan` with code `VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`, and `--allow-partial` does not change it.
- `deploy --dry-run --scan` exits `0` even when the gate would block, printing a `would block` line.
- Invalid `--scanner`, invalid `--scan-fail-on`, a blank suppression `reason`, or an unparsable `until` are usage errors (exit `2`).
- Pointer to `rfapps-vulnerability-scanning.md`.

**Edit B — new `### Harden Exit Semantics`.** Immediately after Edit A:

- `0` — proposals reported, override written, apply completed cleanly, **or apply cancelled at the prompt** (cancellation is not an error, matching `drift import`).
- `1` — compose resolution failed, or the backup/write failed.
- `2` — usage errors: `--apply` with `--out`; `--allow-reformat` or `--no-backup` without `--apply`; `--apply` with a machine format and without `--yes`; `--out` on an existing file; `--apply` needing `--allow-reformat`; an unknown rule id, service target, or profile.
- `3` — `--apply` wrote some patches and refused others.
- One paragraph: harden is deliberately **not** a findings gate and has no `--fail-on`; refusing an unsafe edit is correct behaviour, and reporting it as a failure would train operators to ignore the exit code. Use `rfapps lint --fail-on` when a CI threshold on this subject matter is wanted.
- Pointer to `rfapps-harden-command.md`.

If `## Error Categories` (`:272`) is an exhaustive taxonomy, add one short `### Vulnerability Scan Errors` entry there naming the five `ScanFailureCode` values and the four `HardenRefusalCode` values; otherwise skip it rather than inflating the file.

### 4. `packages/rf-common/README.md` — one edit

`### Environment Tools` is at `:492-518`, with `#### Checking Tool Availability` (`:497`) documenting `checkDotenvx`/`checkOp` and `#### Checking Environment Files` (`:521`) documenting `envFileExists`.

Insert a new `#### Probing an Arbitrary Tool` subsection **between** them — after the `#### Checking Tool Availability` fence closes (`:519`) and before `#### Checking Environment Files` (`:521`) — in the identical style (one lead sentence, one `typescript` fence with an inline result comment):

````markdown
#### Probing an Arbitrary Tool

`checkExternalTool` is the generic counterpart for callers that carry their own binary name and
install instructions, such as pluggable vulnerability-scanner backends. It performs a `which` lookup
followed by a version read and never throws; when the binary is absent it returns the install hint
verbatim as `error`.

```typescript
import { checkExternalTool } from "@rfmedia/common";

const trivy = await checkExternalTool(
  "trivy",
  "--version",
  "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/",
);

if (trivy.available) {
  console.log(`trivy version: ${trivy.version}`);
} else {
  console.error(trivy.error);
  // "trivy not found in PATH. Install from https://trivy.dev/latest/getting-started/installation/"
}
```

All three arguments are required and positional. The version flag is passed verbatim, so a tool whose
version subcommand is a bare word works too — for example `checkExternalTool("grype", "version", …)`.
````

The URL sits inside a fenced block and an inline comment, so MD034 is satisfied. Do **not** restructure `### Environment Tools`, and do not touch any other section of the file.

### Acceptance

- [ ] `env -u FORCE_COLOR npm run lint:md` exits 0.
- [ ] `env -u FORCE_COLOR npm run format:check` exits 0 (run `npm run format` first).
- [ ] `grep -n 'security-scan.v1' docs/features/json-output.md` matches in both the Deploy and the new Plan sections; `grep -n 'harden.v1' docs/features/json-output.md` matches in the new Harden section.
- [ ] `docs/features/json-output.md` has a `### Harden Command` section located between `### Audit Command` and `### Native Backup Commands`, and a `### Plan Command` section immediately before `### Doctor Command`.
- [ ] Every JSON field name in the new `json-output.md` content matches `packages/rfapps-cli/src/types/security-scan.ts` / `types/hardening.ts` key for key.
- [ ] `docs/features/error-handling.md` has `### Vulnerability Scan Exit Semantics` and `### Harden Exit Semantics`, both between `### Native Backup Exit Semantics` and `## User-Facing Error Messages`, and both exit tables match `packages/rfapps-cli/src/lib/exit-codes.ts`.
- [ ] `docs/features/error-handling.md` states that harden `--apply` cancelled at the prompt exits `0` and that a partial apply exits `3`.
- [ ] `docs/features/output-formats.md` states that `table`/`csv` strip the nested `scan` payload and harden's nested detail, and its `## Related Documentation` links both new feature docs.
- [ ] `grep -n 'checkExternalTool' packages/rf-common/README.md` matches inside a new `#### Probing an Arbitrary Tool` subsection under `### Environment Tools`; `checkDotenvx`, `checkOp`, and `envFileExists` documentation is unchanged.
- [ ] `grep -rn '47 service\|42 of 47' <all four files>` returns nothing; no signed `+6` line-delta claim appears; no bare URL appears outside a code span or fence.
- [ ] Every relative markdown link resolves; both T8 files exist on disk before T11 is marked done.
- [ ] `git diff --name-only` lists only the four owned files.

### Pitfalls

- MD034 is enabled — the Trivy URL must live inside the fence/comment as shown, or be a markdown link.
- `proseWrap: preserve` means prettier will not rewrap your prose; hard-wrap at ~100 columns. It **will** re-pad tables — run `prettier --write` before `format:check`.
- Do not invent section shapes. `json-output.md` and `error-handling.md` both have strong per-command/per-feature conventions; mirror the nearest neighbour (`### Audit Command`, `### Native Backup Exit Semantics`) rather than designing a new layout.
- `scan` is absent from MCP output schemas by design; say so, and state the invariant as "never created", not "never populated".
- harden `--apply` cancelled at the prompt exits `0`. Documenting cancellation as a failure is the single most likely error in this task.
- `--scan-fail-on` uses the CVE severity scale, **different** from `--fail-on`'s compose scale on audit/doctor/lint.
- Do not edit `docs/features/rfapps-vulnerability-scanning.md` or `rfapps-harden-command.md` (T8), `docs/README.md` / `README.md` / `packages/rfapps-cli/README.md` / `shell-completion.md` / `quick-reference.md` / `rfapps-configuration.md` / `rfapps.config.yaml` / `packages/rfapps-cli/CLAUDE.md` (T9), or `ROADMAP.md` / `docs/roadmap-archive.md` (T10). In particular note that T9 owns **`packages/rfapps-cli/README.md`** while you own **`packages/rf-common/README.md`** — different packages.
- Do not add TypeScript, tests, or a new module. `checkExternalTool` already exists (T0); you only document it.
- Run gates with `env -u FORCE_COLOR` under `umask 022`; bootstrap a fresh worktree with `npm ci` + `npm run build -w packages/rf-common` first.

---

## T12 — Integration verification

**Owns:** nothing (read-only verification + PR body)
**Depends on:** T0–T11 (all)
**Wave:** 7

This task exists because **two waves deliberately ship red intermediate states** and nothing else in the plan asserts the integrated end state is green:

- **T3** leaves exactly one typecheck error (`deploy.ts:212` missing `scan`), closed by T4.
- **T6** leaves exactly one failing spec case (`deploy` completion parity), closed by T7.

Neither is acceptable at merge. Additionally, no earlier task runs `npm run test:run` across **all** workspaces (`rf-common`, `rfapps-cli`, `rfmedia-cli`) or `npm run test:coverage`.

### 1. Run the full gate suite, in this order, from the repo root

See **Verification gates** below for the exact commands. All of them must pass. Do not proceed to §2 until they do.

### 2. Close the two known-red states explicitly

- [ ] Confirm `env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli` exits **0** — i.e. T3's deliberate `deploy.ts:212` error is gone because T4 landed. If it persists, T4 did not add `scan: rawOptions.scan ?? false,` to the `DeployOptions` literal.
- [ ] Confirm `env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli src/actions/completion.spec.ts` passes **every** case, including `keeps deploy completions in exact parity with Commander without leaking deploy-only options to rebuild` — i.e. T6's deliberate red is gone because T7 landed. If it persists, `deploy_opts` in `completion.ts` is missing one of `--scan`, `--scanner`, `--scan-fail-on`.

### 3. Cross-task consistency checks that no single task can perform

Each of these spans two or more ownership boundaries.

- [ ] **Description string is identical in three places:** `.description(…)` in `packages/rfapps-cli/src/commands/harden.ts`, the zsh `'harden:…'` entry and fish `__fish_use_subcommand` line in `packages/rfapps-cli/src/actions/completion.ts`, and the `rfapps harden` row in `docs/README.md`. Canonical value: `Propose or apply compose security hardening`.

  ```bash
  grep -rn "Propose or apply compose security hardening" packages/rfapps-cli/src docs/README.md | wc -l   # expect >= 4
  ```

- [ ] **`--json` on harden actually emits JSON:**

  ```bash
  env -u FORCE_COLOR npm run rfapps -- harden --json --list-rules >/dev/null   # catalog path, exits 0
  env -u FORCE_COLOR npm run rfapps -- harden --json 2>/dev/null | head -c 1   # must print "{"
  ```

  (If compose cannot resolve in this environment, at minimum assert `grep -n 'rawOptions.json' packages/rfapps-cli/src/actions/harden.ts` shows the check **above** the `globalOptions.output` check.)

- [ ] **Harden option-set parity across four surfaces:** Commander (`rfapps harden --help`), the three generated completion scripts, `packages/rfapps-cli/README.md`'s option table, and `docs/features/rfapps-harden-command.md`'s option table all list exactly the same 15 long options.
- [ ] **`lineDelta` sign consistency:** the value in `docs/features/rfapps-harden-command.md`'s JSON sample and in `docs/features/json-output.md`'s harden sample matches the sign `detectReformat` in `packages/rfapps-cli/src/lib/hardening.ts` produces. No doc says `+6`.
- [ ] **Rule-id consistency:** `HARDEN_RULE_IDS` in `packages/rfapps-cli/src/lib/hardening-rules.ts` matches, in count and spelling, the catalogs in `packages/rfapps-cli/README.md`, `docs/features/rfapps-harden-command.md`, and `docs/features/shell-completion.md`, and every id appears in all three generated completion scripts.
- [ ] **Forbidden strings repo-wide in changed files:**

  ```bash
  git diff master --name-only | xargs grep -n '47 service\|42 of 47\|lineDelta.*+6' 2>/dev/null   # expect no output
  ```

- [ ] **Text-sample fidelity:** no doc shows a `Suppressed by config:` line, since `formatHardenText` renders suppression only as a count.
- [ ] **MCP surface untouched:**

  ```bash
  git diff master --name-only | grep -c 'src/mcp/'   # expect 0
  grep -rn '"scan"\|scanner\|scanFailOn' packages/rfapps-cli/src/mcp/   # expect no matches
  ```

- [ ] **No stray files:** `git status --porcelain` is clean apart from intended changes; no `.md` report/summary/analysis file was written by any task; `git diff master --stat` touches only the union of the 13 tasks' owned paths.

### 4. PR body — required content

Follow `.github/pull_request_template.md`, preserving `## Summary`, `## Changes`, `## Testing`, `## Related Issues`, `## Breaking Changes`, `## Risk and Rollback`, `## Checklist`.

- `## Related Issues` must read `Closes #161` and `Closes #162`.
- `## Testing` must list the exact commands from **Verification gates** with pass/fail outcomes.
- `## Breaking Changes` — none. `DeployResult` gains one optional field; `DeployOptions.scan` is internal to the package.
- `## Risk and Rollback` must state: scanning is opt-in per invocation and advisory by default; `harden` is non-destructive by default and its only destructive mode (`--apply`) requires a confirmation, takes a `.bak`, takes the state lock, and refuses alias targets and unacknowledged reformatting. Rollback is reverting the commit; no migration, no state format change, no MCP schema change.
- **Explicit scope-mapping note (required):** issue #162's implementation note asks to "Generate patch-style recommendations **or editable output**". This PR delivers the _editable output_ branch — a compose override fragment emitted by `--out` (also available as the `override` field of the `harden.v1` JSON result) — and deliberately does **not** produce a unified diff or a `git apply`-compatible patch. That limitation is documented in `docs/features/rfapps-harden-command.md`. State this so the issue closer reads it as a scope call, not an omission.
- Labels: use the repo's existing taxonomy only (`type:feature`, `area:` scopes as they exist). Never invent labels.

### Acceptance

- [ ] Every command in **Verification gates** passes, in order.
- [ ] Both known-red states (§2) are confirmed closed.
- [ ] All ten cross-task checks in §3 pass.
- [ ] The PR body follows the template, links both issues with `Closes #…`, lists the exact verification commands with outcomes, and contains the #162 scope-mapping note verbatim in substance.
- [ ] `git diff master --stat` touches only files owned by T0–T11; no file outside the union appears.

### Pitfalls

- Do **not** fix defects yourself if they span another task's files — report them to the orchestrator with the owning task named. This task owns nothing.
- `FORCE_COLOR` breaks two rf-common logger tests **and blocks `git push`** via the pre-push hook. `umask 002` breaks an unrelated rfapps filesystem test. Every command below carries the prefixes for a reason.
- A fresh worktree needs `npm ci` and `npm run build -w packages/rf-common` once, serially, before anything passes.
- `npm test` is watch mode; use `npm run test:run`.
- `gh pr merge --delete-branch` from a worktree errors on local branch cleanup even when the merge succeeded — delete branches manually afterwards.

---

## Verification gates

Run from the repo root of the worktree
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-feat-security-scan-harden`.

**Every command must be prefixed `env -u FORCE_COLOR` and the shell must be under `umask 022`.** `FORCE_COLOR` is exported by agent shells and fails two `rf-common` logger tests plus the pre-push hook; `umask 002` fails an unrelated `rfapps-cli` filesystem test.

### 0. One-time bootstrap (fresh worktree only, run serially)

```bash
umask 022
env -u FORCE_COLOR npm ci
env -u FORCE_COLOR npm run build -w packages/rf-common
```

### 1. Orchestrator gate between wave 0 and wave 1 (mandatory)

```bash
env -u FORCE_COLOR npm run build -w packages/rf-common
grep -n checkExternalTool packages/rf-common/dist/env-tools.d.ts packages/rf-common/dist/index.d.ts
```

Both greps must match. `@rfmedia/common` resolves through `dist/`, so every wave-1+ typecheck depends on this.

### 2. Per-task local gates (run by the owning task)

```bash
# rf-common tasks (T0)
env -u FORCE_COLOR npm run typecheck -w packages/rf-common
env -u FORCE_COLOR npm run build     -w packages/rf-common
env -u FORCE_COLOR npm run test:run  -w packages/rf-common

# rfapps-cli code tasks (T1–T7)
env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli
env -u FORCE_COLOR npx vitest run --root packages/rfapps-cli <owned spec paths>

# CLI surface checks (T5, T6, T7, T9, T12)
FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts <command> --help
env -u FORCE_COLOR npm run rfapps -- completion bash | bash -n /dev/stdin
env -u FORCE_COLOR npm run rfapps -- completion fish | grep -c '__fish_seen_subcommand_from harden'

# doc tasks (T8, T9, T10, T11)
env -u FORCE_COLOR npx prettier --write <owned .md files>
env -u FORCE_COLOR npm run lint:md
```

**Allowed-red exceptions, and only these two:**

- After **T3** alone, `npm run typecheck --workspace packages/rfapps-cli` reports **exactly one** error: `src/actions/deploy.ts:212` missing `scan`. Closed by T4.
- After **T6** alone, `npx vitest run --root packages/rfapps-cli src/actions/completion.spec.ts` fails **exactly one** case: `keeps deploy completions in exact parity with Commander without leaking deploy-only options to rebuild`. Closed by T7.

### 3. Final integration gate (T12) — run in this order

```bash
umask 022

# 1. Clean install and shared-package build
env -u FORCE_COLOR npm ci
env -u FORCE_COLOR npm run build -w packages/rf-common

# 2. Typecheck every workspace
env -u FORCE_COLOR npm run typecheck -w packages/rf-common
env -u FORCE_COLOR npm run typecheck --workspace packages/rfapps-cli
env -u FORCE_COLOR npm run typecheck --workspace packages/rfmedia-cli

# 3. Full test suites (no watch mode)
env -u FORCE_COLOR npm run test:run
env -u FORCE_COLOR npm run test:coverage --workspace packages/rfapps-cli

# 4. Build everything
env -u FORCE_COLOR npm run build:all

# 5. Formatting and markdown
env -u FORCE_COLOR npm run format:check
env -u FORCE_COLOR npm run lint:md

# 6. Generated-surface sanity
env -u FORCE_COLOR npm run rfapps -- completion bash | bash -n /dev/stdin
env -u FORCE_COLOR npm run rfapps -- completion zsh  > /dev/null
env -u FORCE_COLOR npm run rfapps -- completion fish > /dev/null
env -u FORCE_COLOR npm run rfapps -- harden --list-rules > /dev/null
FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts plan --help   | grep -nE '^[[:space:]]+-' >/dev/null
FORCE_COLOR=0 node --import tsx packages/rfapps-cli/src/cli.ts deploy --help | grep -nE '^[[:space:]]+-' >/dev/null

# 7. Forbidden-string sweep over the diff
git diff master --name-only | xargs grep -n '47 service\|42 of 47' 2>/dev/null   # expect no output
grep -rn 'scanFailOn\|"scanner"' packages/rfapps-cli/src/mcp/                    # expect no output
git status --porcelain                                                            # expect clean
```

CI runs only `npm ci → build rf-common → typecheck → test:coverage` (`.github/workflows/rfapps-cli.yml:37-47`), and its `push` trigger targets `main` while the default branch is `master` — **PR CI is the only automated gate**, so steps 4–7 above are the human gate and must be run locally.

---

## Test inventory

### Test artifacts written by this plan

| File                                                           | Owner | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/lib/security-scan.spec.ts` (new)      | T1    | **trivy report parsing** (5): realistic 2-entry normalization incl. absent `fixedVersion` key; empty stdout → `{ok:false}`; `"{}"` → empty list; `{"Results":"nope"}` → shape error with exact detail; unrecognised `Severity` → `unknown` with `rawSeverity` preserved. **grype report parsing** (5): the same five against `matches`, plus `Negligible` mapping, `fix.versions[0]`, and `dataSource`. **retention cap** (1): 250 HIGH → 200 retained, `truncated:true`, `counts.high === 250`, exact truncation note. **evaluateScanGate** (4): breach → `blocked`; below threshold → `passed`; `failOn:"none"` with critical → `passed`; one `failed` arm → `inconclusive` with exact `blockedBy` string. **suppressions** (4): id-scoped; wrong-service no-op; `id:"*"`; expired `until` → not suppressed + exact note. **resolveScanTargets** (1): all four skip reasons plus `scannedBy` and `maxTargets:1` cap. **degradation** (4): probe-unavailable → all `scanner-unavailable`, `runScanner` never called; timeout sentinel; output-limit sentinel; mixed success/`scanner-error` with `lastNonBlankLine` detail. **No `vi.mock` in this file.** |
| `packages/rfapps-cli/src/lib/security-scan-deps.spec.ts` (new) | T1    | 1 case: default dependencies pass `{ tool: "none", cwd, timeout }` to `execWithEnv`. **The only mocked scan spec** (`@rfmedia/common`, `./env-tools.js`), isolated so its file-level mocks cannot leak into the 24 DI cases above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/rfapps-cli/src/lib/hardening.spec.ts` (new)          | T2    | **applyHardenPatches** (5): alias refusal leaves source byte-unchanged; top-level `merge-unique` on an anchor-merged service preserves `<<:` and the anchor block; no duplicate entry when already present; scalar-where-sequence → `unexpected-node`, nothing written; absent service → `service-missing` naming `--out`. **buildHardenOverride** (1): sequence patch emits the **full union**, not just the addition. **detectReformat** (2): multi-line flow sequence → `wouldReformat:true` and `lineDelta < 0`; canonical source → `{false, 0}`. **HARDEN_RULES** (2, via `it.each`): every rule declares single-segment patch keys and array values for `merge-unique`; every non-advisory rule is idempotent (re-detect after its own proposal returns `undefined`). **No `vi.mock`; no reference to the real `compose.yml`.**                                                                                                                                                                                                                                                                                                                       |
| `packages/rfapps-cli/src/actions/deploy.spec.ts` (extend)      | T4    | 2 new cases in `describe("--scan")`: (a) blocking gate refuses before any mutation — `failed[]` entry with `VULNERABILITY_THRESHOLD`, `scan` in the JSON payload, `process.exitCode === 1`, and `confirm`/`pullImages`/`startServices`/`executeStagedRollout`/`initializeDatabase` all uncalled; (b) `--dry-run` reports `would block deploy (--scan-fail-on high)` verbatim, emits `scan` in the payload, and leaves `process.exitCode` undefined. Both drive the five new barrel exports through the file's **bare automock**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/rfapps-cli/src/actions/harden.spec.ts` (new)         | T5    | 4 cases: propose mode performs zero `writeFile`/`copyFile` and emits `mode:"propose"`, `write:{mode:"propose"}`, `summary.applied === 0`; `--apply` cancelled at the prompt writes nothing and leaves `process.exitCode` unset; `--apply` with `--out` rejects with `InvalidArgumentError` **before** `loadConfig` is called; without `--include-review` the override contains `no-new-privileges` but not `read_only` while the review proposal still appears in `proposals`. Uses `importOriginal` partial mocks so the **real** hardening engine runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/rfapps-cli/src/actions/completion.spec.ts` (extend)  | T7    | 2 new cases: `plan` parity — Commander's option set (which must contain `scan`, `scanner`, `scan-fail-on`) equals the extracted set for bash, zsh, and fish; `harden` parity — the registrar-derived option set (via `getHardenCommand()`, **not** `--help` parsing) equals the extracted set for all three shells, plus each script contains `harden-no-new-privileges` to guard an empty `${hardenRuleIds}` interpolation. Plus: `"harden"` added to the hardcoded command list, `getCommanderCommandOptions` widened to `"deploy" \| "rebuild" \| "plan"`, `getCommandCompletionOptions` widened to include `"harden"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Total: 4 new spec files, 2 extended spec files, 33 new cases.**

### Explicitly NOT tested, with reasons

| Candidate                                                                                   | Owner it would fall to | Why not                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rf-common/src/env-tools` coverage for `checkExternalTool`                         | T0                     | Six lines delegating to the already-covered private `commandExists`/`getCommandVersion`. Its only interesting behaviour — returning `installHint` verbatim as `error` — is asserted indirectly by T1's `scanner-unavailable` case. Adding it would also risk perturbing the 16 existing cases in `env-tools.test.ts`.                          |
| `HARDEN_RULES` unique-id assertion                                                          | T2                     | **Dropped on critic review.** Asserts a property of nine hand-written object literals declared ~40 lines above, with no computation between declaration and assertion. Cannot regress except by an intentional edit visible in the same diff.                                                                                                  |
| `HARDEN_RULES` advisory-rules-propose-nothing assertion                                     | T2                     | **Dropped on critic review.** The three advisory rules are literally `propose: () => []` in the same file. Tautological.                                                                                                                                                                                                                       |
| `formatScanText` / `formatHardenText` / `formatHardenRulesCatalog` golden or snapshot tests | T1, T2                 | There is no `toMatchSnapshot` anywhere in `packages/rfapps-cli/src` — the repo does not use snapshot testing. A golden test on human output pins wording, not behaviour, and would make every copy edit a test failure. The load-bearing pieces (gate status, counts, notes) are asserted structurally on `ScanReport`/`HardenResult` instead. |
| `resolveScanSettings` precedence table (CLI ?? config ?? default)                           | T1                     | Mechanical `??` chains. The one non-mechanical branch — rejecting an unvalidated `scan.scanner` from YAML — throws `InvalidArgumentError`, which the CLI surfaces as exit 2 and which no other code path depends on.                                                                                                                           |
| `normalizeScanSuppressions` / `normalizeHardenSuppressions` throw cases                     | T1, T2                 | Copies of the shipped `normalizeIgnoreEntries` pattern (`lib/lint.ts:194-212`), already covered for lint.                                                                                                                                                                                                                                      |
| `parseHardenRuleIds`                                                                        | T2                     | Split/trim/validate over a nine-element array; the validation path is the same `InvalidArgumentError` shape covered above.                                                                                                                                                                                                                     |
| `evaluateHardening` suppression matching                                                    | T2                     | The `rule`/`service`/`*` matching logic mirrors lint's, and the load-bearing consequence (a suppressed proposal is absent from `proposals` and counted in `summary.suppressed`) is exercised end-to-end by T5's case 4 through the real engine.                                                                                                |
| Config merge/default specs for the new `scan:` and `harden:` sections                       | T3                     | `mergeConfig` and `partialToFull` are mechanical `??` chains copied verbatim from the shipped `lint:` precedent; `config.test.ts` already covers the merge machinery and contains zero `toEqual` assertions on whole-config output. Both sections are optional, so `makeConfig()` at `config-helpers.spec.ts:12-31` needs no change.           |
| `exit-codes.spec.ts` cases for `resolveScanExitCode` / `resolveHardenExitCode`              | T3                     | One-line boolean maps over `gate.blocking` and `write.mode`/`patchesWritten`/`refusals.length`. A test would assert a `?:`. Both are exercised through T4's `process.exitCode === 1` assertion and T5's cancelled-apply case.                                                                                                                  |
| A `plan.spec.ts` scan case                                                                  | T4                     | Deploy's two cases already prove gate ordering, payload shape, exit code, and non-mutation through the harder path (deploy has mutation to avoid; plan does not). Plan's gate is three lines reading the same `gate.blocking`.                                                                                                                 |
| `commands/harden.spec.ts`                                                                   | T5                     | `validateHardenOptions` is called from `executeHarden` on every path, so T5's case 3 covers it through the action. The registrar's option wiring is covered — far more strictly — by T7's parity test, which compares against Commander itself.                                                                                                |
| A CLI integration spec that spawns Docker or a scanner                                      | T1, T4, T5             | The worktree has no `.env`/`.env.local` (only `.env.example`), so `docker compose config` fails there with `invalid spec: :/data: empty section between colons`, and CI has neither a scanner binary nor a Docker daemon. Every daemon boundary is behind an injected dependency or a barrel export the specs stub.                            |
| A test asserting an `alias-target` refusal against the repository's real `compose.yml`      | T2                     | Unreachable: `harden-log-rotation` does not fire on the 42 alias-logging services because their **resolved** `max-size` is `"200k"`. The alias path is covered by a synthetic fixture whose anchor omits `max-size`.                                                                                                                           |
| Any test asserting a compose service count                                                  | T2, T8, T9, T10        | `compose.yml` has 44 services and the number changes with every service added. Counting is not this feature's contract.                                                                                                                                                                                                                        |
| `cli.ts` wiring tests (T6)                                                                  | T6                     | `cli.ts` has no spec file today. The three surfaces that matter are gated elsewhere: option registration by T7's parity tests, `preAction` validation by T5's case 3, and lock derivation by the existing `state-lock.spec.ts` behaviour. T6's acceptance uses `--help` invocations instead.                                                   |
| Doc tests / link checkers (T8–T11)                                                          | T8, T9, T10, T11       | The repo has no link checker; `npm run lint:md` and `npm run format:check` are the gates, plus T12's cross-surface greps.                                                                                                                                                                                                                      |
