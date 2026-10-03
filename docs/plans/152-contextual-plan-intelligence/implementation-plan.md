# Implementation Plan: Contextual Plan Intelligence (#152)

Authoritative design: `docs/plans/152-contextual-plan-intelligence/design.md` (read the sections cited per task; do not re-derive decisions).
Repo root for every path below: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.claude/worktrees/rfmedia-apps-rfmedia-apps-feat-152-contextual-plan-intelligence`.

## Execution model (how batches and ownership work)

**Batches.** Tasks in one batch run concurrently in the same worktree. A batch begins only after every task in the previous batch has reported done **and** the orchestrator's batch barrier gate (below) has passed.

**Ownership is a write allowlist.** A task may write only files in its `Owns` list. It may read anything. No file appears in two tasks' `Owns` lists anywhere in this plan. Every barrel file (`src/types/index.ts`, `src/lib/index.ts`, `src/lib/formatters/index.ts`) has exactly one owner. `src/actions/completion.ts` has exactly one owner covering all three shell templates.

**Batch barrier gate (run by the orchestrator, not a task).** After each batch of work tasks completes, run:

```bash
umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli
```

If it fails, the failure belongs to whichever task owns the file `tsc` names; re-dispatch that task with the error text. Do not start the next batch until it exits 0.

**Whole-package `tsc` is NOT a per-task gate.** `npm run typecheck` is `tsc --noEmit` over `src/**/*.ts` — it compiles every concurrent sibling's in-flight file, including spec files. Per-task `Done when` criteria are therefore file-scoped (targeted `vitest run <file>`, greps, and `git` checks). Every task that writes a `.ts` file must additionally run `env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` **as an advisory self-check** and apply this rule: _type errors reported in files outside my `Owns` list are expected mid-batch and are not my failure; type errors in files I own are._

**Environment traps (mandatory, recorded workspace issues).** Prefix every test/typecheck/build command with `umask 022 && env -u FORCE_COLOR`. `FORCE_COLOR` is set by the agent shell and fails two unrelated rf-common logger tests (and blocks `git push` via the pre-push hook); `umask 002` fails one unrelated filesystem test.

**Git comparison base.** `docs/plans/152-contextual-plan-intelligence/design.md` is already **staged** in this worktree, so bare `git diff` compares against the index and passes vacuously. Every diff-based check in this plan pins the base to `HEAD` (`git diff HEAD -- <path>`, `git status --porcelain -- <path>`).

**Markdown lint is file-scoped per task.** `npm run lint:md` is repo-wide (`markdownlint-cli2` with `globs: ["**/*.md"]`) and would fail one doc task because a sibling is mid-write. Doc tasks run `npx markdownlint-cli2 <their own files>`. The repo-wide run lives only in the final verification gate.

**No commits, no PR.** Committing is out of scope. For whoever commits later: code goes under `feat(rfapps): …`; `docs/plans/152-contextual-plan-intelligence/design.md` must go in under `docs(internal): …` per repo policy.

**Test scope is frozen.** Exactly the eight designed tests T1–T8 (design.md:849-875) plus the two non-numbered regression additions the checklist mandates (items 22 and 23). Nothing from "Deliberately not written" (design.md:877-884) is created: no `src/cli.plan.integration.spec.ts`, no Commander↔completion parity case for `plan`, no `apply` compatibility test, no threshold/constant test, no renderer test beyond T8's two rules.

---

## Batch 0 — Toolchain bootstrap (serialized, one task)

This worktree has **no** `node_modules/` and **no** `packages/rf-common/dist/` (both verified absent). `@rfmedia/common` resolves only through `"types": "./dist/index.d.ts"`, and every rfapps-cli source file imports it. Without this batch, every gate in Batch 1 fails with `TS2307: Cannot find module '@rfmedia/common'` and `npm run lint:md` fails for want of `markdownlint-cli2`. This must be one task alone in its batch: concurrent `npm ci` runs against a single `node_modules` corrupt it.

### Task T0: Bootstrap the worktree toolchain

- **Owns:** `node_modules/` (generated), `packages/*/node_modules/` (generated), `packages/rf-common/dist/` (generated). No tracked source file.
- **Reads:** `package.json`, `package-lock.json`, `packages/rf-common/package.json`.
- **Depends on:** none.
- **Instructions:**
  1. From the worktree root run `umask 022 && npm ci`. If `npm ci` fails because the lockfile is out of sync, fall back to `npm install` and report that you did so.
  2. Run `umask 022 && env -u FORCE_COLOR npm run build -w packages/rf-common`. This mirrors the first stage of the design's own verification gate (design.md:889).
  3. Do not modify any tracked file. Do not run `npm run format:all`.
- **Done when:**
  - `test -d node_modules && test -f packages/rf-common/dist/index.d.ts` succeeds.
  - `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` exits 0 against the **unmodified** tree.
  - `npx markdownlint-cli2 ROADMAP.md` runs (exit code irrelevant; the binary must resolve).
  - `git status --porcelain` lists no new or modified tracked file beyond the pre-existing staged `docs/plans/152-contextual-plan-intelligence/design.md`.

---

## Batch 1 — Foundation contracts, graph primitive, CLI surface, docs

Five tasks over five strictly disjoint file sets. Nothing in this batch imports anything created in this batch. T1 (types) and T2 (`invertDependencyMap`) gate Batch 2 and are the critical path — start those first.

### Task T1: Plan-intelligence type contracts, `DeploymentPlan`/`PlanOptions` keys, types barrel

- **Owns:** `packages/rfapps-cli/src/types/plan-intelligence.ts` (new), `packages/rfapps-cli/src/types/plan.ts`, `packages/rfapps-cli/src/types/index.ts`
- **Reads:** design.md:26-265 (full data model), design.md:771-788 (module rules), `packages/rfapps-cli/src/types/index.ts` (existing barrel style, the `./plan.js` block ends ~:169).
- **Depends on:** T0
- **Instructions:**
  1. Create `src/types/plan-intelligence.ts` transcribing design.md:28-247 **verbatim**, including every JSDoc block and every `/** Discriminant */` marker. Exports required: `PLAN_INTELLIGENCE_SCHEMA_VERSION`, `MAX_CHANGE_REASONS`, `MAX_REASON_EVIDENCE`, `MAX_IMPACT_DEPENDENTS`, `MAX_CHANGING_DEPENDENCIES`, `MAX_BASELINE_CANDIDATES`, `CHANGE_REASON_CODES`, `ChangeReasonCode`, `ChangeReasonKind`, `ReasonConfidence`, `ChangeReason`, `ServiceEffect`, `ServiceImpact`, `ServiceIntelligence`, `BaselineUnavailableReason`, `PlanProvenance`, `PlanIntelligenceSummary`, `PlanIntelligence`, `PlanBaselineService`, `PlanBaseline`, `PlanBaselineResult`, `PlanIntelligenceInput`.
  2. `CHANGE_REASON_CODES` must be an `as const` **tuple** in exactly the design's order (design.md:57-71): the six triggers, then the three provenance codes, then `registry-image-drifted`. That order is load-bearing — it is the `codeIndex` used by the ranking rule (design.md:470).
  3. **Deliberate, flagged deviation from design.md:290.** Also declare `ChangeDimension` in this file, in the "Inputs. Never serialized into a plan" block below design.md:216:

     ```ts
     /**
      * Diff dimension that can force a change type.
      *
      * Build-time only: consumed by `determineChangeType` and
      * `PlanIntelligenceBuildInput`, never serialized into a plan, and therefore
      * deliberately NOT mirrored in `src/mcp/schema.ts`.
      */
     export type ChangeDimension = "runtime" | "image" | "environment" | "ports" | "volumes" | "networks";
     ```

     Rationale to record in the task output: design.md:290 homes it in `src/lib/plan-generator.ts`, but `PlanIntelligenceBuildInput` (design.md:326) in `src/lib/plan-intelligence.ts` consumes it while `plan-generator.ts` imports `buildPlanIntelligence` from that same module — a lib↔lib type cycle. The union members and their order are unchanged.

  4. **Hard layering rule (design.md:788):** this file must import nothing from `src/lib/*`. In particular do **not** import `ComposeServiceConfig` — it lives in `src/lib/docker.ts`, not `src/types/`, and is referenced only from `src/lib/plan-intelligence.ts`.
  5. Modify `src/types/plan.ts` per design.md:249-265: add `intelligence?: PlanIntelligence` to `DeploymentPlan` and `intelligence?: PlanIntelligenceInput` to `PlanOptions`, plus the one `import type` line. Exactly one new optional field on each interface; change nothing else.
  6. Modify `src/types/index.ts` (checklist item 6): re-export the new **types** _and_ the runtime **values** `PLAN_INTELLIGENCE_SCHEMA_VERSION` and `CHANGE_REASON_CODES`. The value re-export must be a plain `export { ... } from "./plan-intelligence.js"` — a type-only `export type { ... }` compiles fine and silently drops both constants. Follow the existing `./plan.js` block's placement and style.

- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` exits 0 (Batch 1 siblings touch no `.ts` this file depends on, so this gate is deterministic here).
  - `grep -REn 'from "\.\./lib/' packages/rfapps-cli/src/types/` produces **no output** (real layering check; the string `src/lib` never appears in any import in this repo, so grepping for it is vacuous).
  - `grep -c '"' packages/rfapps-cli/src/types/plan-intelligence.ts` confirms all ten codes present, and `node -e` (or inspection) confirms `CHANGE_REASON_CODES` order matches design.md:57-71 exactly.
  - `grep -n 'CHANGE_REASON_CODES\|PLAN_INTELLIGENCE_SCHEMA_VERSION' packages/rfapps-cli/src/types/index.ts` returns hits on a **value** re-export (`export {`, not `export type {`).
  - `git diff HEAD -- packages/rfapps-cli/src/types/plan.ts` shows exactly one added optional field per interface plus one import line.

### Task T2: Extract `invertDependencyMap`; rebuild `computeFanIn` on it

- **Owns:** `packages/rfapps-cli/src/lib/dependency-graph.ts`, `packages/rfapps-cli/src/lib/staged-rollout.ts`
- **Reads:** design.md:267-284, design.md:944 (why not export `computeFanIn`), `packages/rfapps-cli/src/lib/staged-rollout.ts:60` (existing private inverter), existing `dependency-graph.spec.ts` and `staged-rollout.spec.ts`.
- **Depends on:** T0
- **Instructions:**
  1. Add and export `invertDependencyMap` in `src/lib/dependency-graph.ts` with the exact signature and JSDoc at design.md:269-282. Pure, no I/O. Dependent lists must be **code-point sorted** (`Array.prototype.sort()` default) so both consumers agree.
  2. Rewrite `staged-rollout.ts`'s private `computeFanIn` as a short derivation over `invertDependencyMap(...)` (design.md:284). Leave `compareBlastRadius` and `criticalityTier` untouched.
  3. Do **not** split `dependency-graph.ts` even though it is already ~542 lines, past the ~500-line soft cap. design.md:788 explicitly rules that adding this function there is correct (it is the graph domain; a new file for one function or a second private inverter are both worse) and that splitting is a separate refactor.
  4. Do not modify either existing spec file.
- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/lib/staged-rollout.spec.ts src/lib/dependency-graph.spec.ts` passes.
  - `git diff HEAD --stat -- packages/rfapps-cli/src/lib/staged-rollout.spec.ts packages/rfapps-cli/src/lib/dependency-graph.spec.ts` is empty (proving no test was adjusted to fit).
  - `grep -n 'export function invertDependencyMap' packages/rfapps-cli/src/lib/dependency-graph.ts` returns one hit.
  - `computeFanIn` contains no manual inversion loop.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in either owned file.

### Task T3: `--explain` flag registration, all three shell-completion templates, and T7

- **Owns:** `packages/rfapps-cli/src/cli.ts`, `packages/rfapps-cli/src/actions/completion.ts`, `packages/rfapps-cli/src/actions/completion.spec.ts`
- **Reads:** design.md:532-540 (flag), design.md:816-820 (three templates, with line anchors), design.md:871-872 (T7 rationale), `src/cli.ts:530` (the `--check-updates` option on the plan command).
- **Depends on:** T0
- **Instructions:**
  1. `src/cli.ts`: register on the **plan** command immediately after `--check-updates`, description **verbatim**:

     ```ts
     .option("--explain", "Annotate changes with likely cause and dependency impact", false)
     ```

     Exactly one added line. Add no `preAction` hook and no cross-flag validation — `--explain` mutates nothing (design.md:542).

  2. `src/actions/completion.ts` — **bash**, the `local plan_opts="…"` string at ~:71: append space-prefixed `--explain`. No `case "$prev"` arm (boolean, takes no value); the `plan)` dispatch arm at ~:297-299 already splices `$plan_opts $global_opts`.
  3. `src/actions/completion.ts` — **zsh**, the `plan)` `_arguments` arm at ~:634-648: insert
     `'--explain[Annotate changes with likely cause and dependency impact]' \\`
     **immediately after** the `--check-updates` line (~:644) and **inside** the `plan)` arm — not the `doctor)` arm at ~:782. Mid-arm insertion avoids the trailing-backslash surgery that appending after the `--profile` line would require (it is the only line with no continuation).
  4. `src/actions/completion.ts` — **fish**, the plan block at ~:1119-1130: add
     `complete -c rfapps -n "__fish_seen_subcommand_from plan" -l explain -d "Annotate changes with likely cause and dependency impact"`.
     **CRITICAL:** fish's `-l` takes the long name **without** leading dashes — the verified in-file precedent is `-l check-updates` at :1128. Writing `-l --explain` registers a completion literally named `----explain` and silently breaks the fish shell while every existing assertion still passes. No `and not` guard is needed (no other subcommand is named `plan`).
  5. `src/actions/completion.spec.ts` (T7, checklist item 21): add the single string `"explain"` to the hard-coded `required` token array at ~:414-427. This is the _only_ guard for the three template edits — `getCommanderCommandOptions` is typed `"deploy" | "rebuild"`, so there is no Commander↔completion parity test for `plan`. Add nothing else to this spec.

- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/actions/completion.spec.ts` passes.
  - `grep -c 'plan_opts=.*--explain' packages/rfapps-cli/src/actions/completion.ts` returns 1.
  - `grep -c "'--explain\[" packages/rfapps-cli/src/actions/completion.ts` returns 1, and that line is inside the `plan)` arm (verify by line number relative to `plan)` at ~:634 and `update)` at ~:649).
  - `grep -c 'subcommand_from plan" -l explain' packages/rfapps-cli/src/actions/completion.ts` returns 1.
  - `grep -c -- '-l --explain' packages/rfapps-cli/src/actions/completion.ts` returns **0**.
  - `grep -c -- '--explain' packages/rfapps-cli/src/actions/completion.ts` returns **2** (bash + zsh only; fish contributes zero by convention).
  - `git diff HEAD -- packages/rfapps-cli/src/cli.ts | grep -c '^+[^+]'` returns 1.
  - `git diff HEAD -- packages/rfapps-cli/src/actions/completion.spec.ts | grep -c '^+[^+]'` returns 1.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in any owned file.

### Task T4: Feature documentation cluster (checklist items 24-28) + docs index

- **Owns:** `docs/features/rfapps-plan-intelligence.md` (new), `docs/features/plan-apply-workflow.md`, `docs/features/shell-completion.md`, `docs/features/quick-reference.md`, `packages/rfapps-cli/README.md`, `docs/README.md`
- **Reads:** design.md in full (this task writes the user-facing account of it), especially :390-527 (derivation rules and impact model), :530-663 (rendering), :900-924 (risks and non-goals).
- **Depends on:** T0
- **Instructions:**
  1. **New page** `docs/features/rfapps-plan-intelligence.md` (checklist item 26). It must contain: a reason-code table covering **all ten** codes from `CHANGE_REASON_CODES` with kind, when-emitted, and confidence; the `confirmed` vs `inferred` semantics (design.md:78-85, :436-440); the full degradation ladder (design.md:395-401 plus the three degraded banner lines at :627-631); and a **Limitations** section naming all seven documented limitations from design.md:836 and :904-914 — multi-file compose (`hashFile` covers only the top-level `composePath`), secrets-tool / Compose-CLI-upgrade false positives on `resolved-config-changed`, profile scoping, `--out` plans invisible to `listPlans()`, `depends_on` conditions flattened, `{}` sidecar mapping, and stopped containers reported as `create`.
     **Wording rules are non-negotiable (design.md:18, :524):** write "N services declare `depends_on` X", never "N services will break"; write "no running container found (a stopped container is not inspected)", never "service absent"; write "the locally cached image for this reference is behind the registry", never "the running container is behind".
  2. `docs/features/plan-apply-workflow.md` (item 25): add an `--explain` row to the canonical options table (verified at :102-115, `--check-updates` at :110) **directly after** `--check-updates`, matching the existing 3-column `| Option | Short | Description |` shape with an empty short column. Add a new "Change origin and impact" section that summarizes the feature in a few paragraphs and links to `rfapps-plan-intelligence.md`.
  3. `docs/features/shell-completion.md` (item 27): add the currently-missing `rfapps plan --<TAB>` block (~:145-198 region, matching the surrounding blocks' format). Its token list must be an exact match of the post-T3 bash `plan_opts` at `completion.ts:~71`, i.e. `--service --services --group --no-sidecars --apply --out --show-unchanged --check-updates --explain --compose --env-file --profile`.
  4. `docs/features/quick-reference.md` (item 28): add `rfapps plan --explain` to the plan block (~:203-223).
  5. `packages/rfapps-cli/README.md` (item 24) — **two separate edits, both required:**
     - the plan options table (verified at :1090-1101, `--check-updates` at :1097) gains an `--explain` row directly after `--check-updates`;
     - the `### Plan/Apply Workflow` fenced example block (verified at :2127-2149) gains an `rfapps plan … --explain` example line.
  6. `docs/README.md` — **a 32nd file, deliberately added beyond the design's 31-item checklist.** `docs/README.md` is the repo's `**CLI Features:**` index (verified: `[Plan/Apply Workflow](features/plan-apply-workflow.md)` at :54, `[rfapps Drift Command]` at :56). The design omits it, and `npm run lint:md` is markdownlint-only with no link/orphan checking, so the new page would ship unreachable with green CI. Add one bullet linking `features/rfapps-plan-intelligence.md` adjacent to the Plan/Apply Workflow entry, matching the surrounding two-line wrapped style. Record this addition explicitly in your task output.
  7. Markdown conventions: headings surrounded by blank lines, markdownlint-clean, and do not reflow untouched lines.
- **Done when:**
  - `npx markdownlint-cli2 docs/features/rfapps-plan-intelligence.md docs/features/plan-apply-workflow.md docs/features/shell-completion.md docs/features/quick-reference.md packages/rfapps-cli/README.md docs/README.md` exits 0.
  - `docs/features/rfapps-plan-intelligence.md` mentions all ten reason codes (`for c in container-not-running image-reference-changed environment-changed ports-changed volumes-changed networks-changed compose-file-edited resolved-config-changed unchanged-since-baseline registry-image-drifted; do grep -q "$c" docs/features/rfapps-plan-intelligence.md || echo "MISSING $c"; done` prints nothing) and has a Limitations section with all seven items.
  - `grep -c -- '--explain' packages/rfapps-cli/README.md` returns **at least 2** — one table row after `--check-updates` at ~:1097, one example line inside the `### Plan/Apply Workflow` block at ~:2127-2149.
  - `grep -l -- '--explain' docs/features/plan-apply-workflow.md docs/features/shell-completion.md docs/features/quick-reference.md` lists all three.
  - `grep -n 'features/rfapps-plan-intelligence.md' docs/README.md` returns a hit inside the `**CLI Features:**` block (~:48-72).
  - `grep -rn 'will break' docs/features/rfapps-plan-intelligence.md docs/features/plan-apply-workflow.md` returns nothing.
  - `test ! -d packages/rfapps-cli/docs` (these docs live at the repo root; only `packages/rfmedia-cli` has a package-local `docs/` tree).

### Task T5: Repo-root docs — `AGENTS.md` flag list, `ROADMAP.md` delivery

- **Owns:** `AGENTS.md` (**repo root only**), `ROADMAP.md` (**repo root only**)
- **Reads:** design.md:839-840; root `AGENTS.md:53` (``- `--check-updates` - Check registry for newer image versions (plan command only)``); `ROADMAP.md:37`, `:54`, `:103`, `:110`; commit `be525239` for the delivered-issue convention.
- **Depends on:** T0
- **Instructions:**
  1. **Path disambiguation (mandatory).** Three `AGENTS.md` files exist: `./AGENTS.md`, `./packages/rfapps-cli/AGENTS.md`, `./packages/rfmedia-cli/AGENTS.md`. Only the **root** one carries the global flag list. Edit `<repo-root>/AGENTS.md` and nothing else.
  2. `AGENTS.md` (item 29): insert immediately after the `--check-updates` bullet at :53, mirroring its exact shape:
     `- \`--explain\` - Annotate changes with likely cause and dependency impact (plan command only)`
  3. `ROADMAP.md` (item 30) — **three coordinated edits**, because #152 appears in three places:
     - `:54` — the Sprint 1 order-2 row: mark delivered following the repo's in-file convention for an already-delivered sprint row (see the `#159` treatment at `:49`, which folds the mention into the sprint intro sentence rather than leaving a live Next Up row).
     - `:110` — remove the #152 row from the "Medium priority — state, security & deploy" table, and decrement the heading count at `:103` from `(9)` to `(8)` so it matches the remaining row count.
     - `:37` — the "Current focus" prose reads `the rfapps post-staged-deploy medium backlog (#160, #152, #161 / #162)`. Remove `#152` from that list; otherwise the ROADMAP is left self-contradictory and `npm run lint:md` cannot detect it.
  4. **Scope boundary:** do **not** touch `docs/roadmap-archive.md`. The full archive convention (commit `be525239`) also adds an archive entry, but that happens at sprint close, not at issue delivery, and `docs/roadmap-archive.md` is outside this change's checklist. Note this scoping decision in your task output.
  5. Do not modify `packages/rfapps-cli/AGENTS.md`, `packages/rfmedia-cli/AGENTS.md`, or any `CLAUDE.md` — `CLAUDE.md` is on the design's "Not changed (verified)" list (design.md:845).
- **Done when:**
  - `npx markdownlint-cli2 AGENTS.md ROADMAP.md` exits 0.
  - `grep -c -- '--explain' AGENTS.md` returns 1, on the line immediately after the `--check-updates` bullet.
  - `grep -c '152' ROADMAP.md` returns 0 in the medium-priority table region and the `:37` prose; the only surviving mention is the delivered Sprint 1 record.
  - `grep -n 'Medium priority — state, security & deploy' ROADMAP.md` shows `(8)`, and the table beneath it has exactly 8 rows.
  - `git status --porcelain -- packages/rfapps-cli/AGENTS.md packages/rfmedia-cli/AGENTS.md CLAUDE.md docs/roadmap-archive.md` is empty.

---

## Batch 2 — The three self-contained modules (pure classifier, I/O loader, renderer)

Each is one implementation file plus its own spec, from design.md:771-788 ("Module layout & file boundaries"). All three consume T1's contracts; T6 additionally consumes T2's `invertDependencyMap`. None imports another Batch-2 output. T8 owns the formatters barrel and no sibling touches it. T6 is by far the largest unit (~330 lines plus four `it.each` matrices) — start it first.

### Task T6: `src/lib/plan-intelligence.ts` — pure classifier, impact graph, rollup (tests T1-T4)

- **Owns:** `packages/rfapps-cli/src/lib/plan-intelligence.ts` (new), `packages/rfapps-cli/src/lib/plan-intelligence.spec.ts` (new)
- **Reads:** design.md:321-346 (signature), :390-484 (all derivation rules), :488-526 (impact model), :853-863 (T1-T4), :851 (spec conventions).
- **Depends on:** T1, T2
- **Instructions:**
  1. Create `src/lib/plan-intelligence.ts` exporting `PlanIntelligenceBuildInput` and `buildPlanIntelligence` with the **exact** shapes at design.md:324-345. `ComposeServiceConfig` is imported from `./docker.js`; `ChangeDimension` and all annotation types from `../types/plan-intelligence.js`.
  2. **Import `invertDependencyMap` and `buildServiceDependencyGraph` directly from `"./dependency-graph.js"`, never from `"./index.js"`.** The lib barrel does not re-export `invertDependencyMap` until T9 (Batch 3), and no non-spec module under `src/lib/` imports from its own barrel in this repo.
  3. **Purity is a hard contract (design.md:341-344):** no `await`, no `fs`/`child_process` import, no `console.*`, no `process.exitCode`, no mutation of `input`.
  4. Implement the four global suppression rules (design.md:395-401) exactly, including: a service with `reasons.length === 0` is **omitted** from `intelligence.services`.
  5. Triggers (design.md:403-422): emit from `decisiveByService` plus the raw diffs per the table at :407-414. Enforce the **create-suppression rule** (:416): when `changeType === "create"`, emit **only** `container-not-running`. Multi-cause is first class (:418): a `recreate` emits `image-reference-changed` at `decisive: true` **plus** every concurrently changed declaration dimension at `decisive: false`. `environment-changed` evidence carries variable **NAMES + change type only** (`PLEX_CLAIM (modified)`) — never a value, `EnvChange.current`, or `EnvChange.desired` (:420).
  6. Provenance (design.md:424-440): implement the five-row table at :428-434 exactly. Both "moved" cases ship at `confidence: "inferred"` with alternatives named in the reason's own `summary`; `unchanged-since-baseline` is `confirmed`. A `prev` that is absent or not 64-hex yields **no** provenance reason.
  7. Advisory (design.md:451-459): emit `registry-image-drifted` only when `registryChecked && image.changed === false && image.updateStatus === "update-available"`. **Never** discriminate on the retained-for-compat `updateAvailable` boolean — `unsupported`, `unknown`, and `local-missing` must never render as drift.
  8. Impact graph (design.md:492-517): build `forward` with **`Object.keys(composeServices)`** — all service keys, never `options.services` — and `{}` as the sidecar mapping; invert with `invertDependencyMap`. Upward BFS uses a `Set` visited guard (an unguarded traversal **hangs the CLI** on a `depends_on` cycle). Derive every field per the table at :510-517.
  9. Ranking (design.md:468-470): sort ascending by `[kindRank, decisiveRank, codeIndex]`; truncate at `MAX_CHANGE_REASONS`.
  10. Summary (design.md:472-484): `downstreamImpacted` must be an explicit **set difference** `|reached \ changing|`, never `|reached| - |changing|` — the subtraction goes negative for the modal leaf-service case and fails the MCP `schemaNumber({ minimum: 0 })` constraint with an unnameable union error.
  11. Write `src/lib/plan-intelligence.spec.ts` with **exactly four** top-level `describe`/`it.each` groups, one per T1-T4 (design.md:853-863). Use `import { describe, it, expect, vi } from "vitest"` explicitly, `vi.clearAllMocks()` in `beforeEach`, module-level factory helpers for `ServiceChange` fixtures (`resolvedConfigFingerprint`, `ports`, `volumes`, `networks` are all non-optional — a fixture missing one compiles under `vitest run` but fails the whole-package `tsc`), and union-narrowing helpers that **throw** on a wrong variant rather than silently skipping assertions. Add no test beyond T1-T4.
  12. T3's secret-freedom row must assert against a **canary plaintext** planted in `EnvChange.current`/`.desired` on a var flagged `isSecret: true`, checking `JSON.stringify(intelligence)` does not contain it.
- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/lib/plan-intelligence.spec.ts` passes with exactly four top-level groups.
  - `grep -nE 'console\.|process\.exitCode|require\(|from "node:fs|from "node:child_process|await ' packages/rfapps-cli/src/lib/plan-intelligence.ts` returns nothing.
  - `grep -c 'updateAvailable' packages/rfapps-cli/src/lib/plan-intelligence.ts` returns 0.
  - `grep -c 'from "./index.js"' packages/rfapps-cli/src/lib/plan-intelligence.ts` returns 0; `grep -c 'from "./dependency-graph.js"' …` returns 1.
  - `grep -c 'Object.keys(composeServices)' packages/rfapps-cli/src/lib/plan-intelligence.ts` returns at least 1; the BFS uses a `Set` visited guard; `downstreamImpacted` is computed by set difference.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in either owned file (**both** files — spec files are inside the tsconfig `include`, and a spec type error would fail Batch 3's barrier for a file nobody in Batch 3 owns).

### Task T7: `src/lib/plan-baseline.ts` — scope-gated, never-throwing baseline loader (test T5)

- **Owns:** `packages/rfapps-cli/src/lib/plan-baseline.ts` (new), `packages/rfapps-cli/src/lib/plan-baseline.spec.ts` (new)
- **Reads:** design.md:348-369 (signature), :442-449 (eligibility), :865-866 (T5), `src/lib/plan-storage.ts:48` (`DEFAULT_PLAN_DIR`, module-private), `:1586-1607` (`listPlans` swallows every error and returns `[]`), `:1495` (`loadPlan` is a bare `readFile` + `JSON.parse` + unchecked cast).
- **Depends on:** T1
- **Instructions:**
  1. Create `src/lib/plan-baseline.ts` exporting `loadPlanBaseline` with the exact two-parameter signature and JSDoc at design.md:351-368.
  2. **Do the directory scan yourself; do not call `listPlans()`.** Verified: `listPlans` wraps its whole body in `try { … } catch { logDebug(…); return []; }` (plan-storage.ts:1602-1606), so a missing, unreadable, and empty plan directory are indistinguishable — yet T5 requires `plan-history-unreadable` to be distinguished from `no-comparable-plan`. Adding a probe _on top of_ `listPlans` would also cost two `readdir` calls, breaking the design's stated I/O budget of "One `readdir`, up to 10 `readFile` calls, and one `hashFile`" (design.md:913). Implement exactly:
     - `readdir(PLAN_DIR)` inside a `try/catch`; **any** rejection (including `ENOENT`) resolves to `{ status: "unavailable", reason: "plan-history-unreadable" }`;
     - filter to `plan-*.json`, `stat` each, sort by mtime descending;
     - `.slice(0, MAX_BASELINE_CANDIDATES)` **before** any `loadPlan` call;
     - only a successfully-read directory with no eligible candidate resolves to `{ status: "unavailable", reason: "no-comparable-plan" }`.
  3. `src/lib/plan-storage.ts` is on the design's "Not changed (verified)" list (design.md:845) and `DEFAULT_PLAN_DIR` is module-private there, so declare a local `const PLAN_DIR = ".rfapps/plans";` in this file. This duplication is design-mandated, not an oversight — say so in a code comment.
  4. Eligibility: the first candidate satisfying **all four** predicates at design.md:444-447 wins — `intent !== "managed-update"`, `composePath` equal, sorted `profiles` deep-equal, `composeHash` a non-empty string.
  5. Then `composeFileChanged = (await hashFile(composePath)) !== plan.composeHash`. The per-service map keeps **only** 64-hex `resolvedConfigFingerprint` values. **No other field crosses this boundary — in particular no `EnvChange`**, since saved plans persist resolved secrets unmasked (design.md:449).
  6. **Never throws.** The function body must contain no `throw`. Wrap each candidate's `loadPlan` in its own `try/catch` (it is a bare `readFile` + `JSON.parse`, so a truncated `plan-*.json` throws `SyntaxError` inside the loop) and `continue` on failure. Log nothing above `logDebug`. Use `unknown` + narrowing at the parse boundary; no `any`.
  7. Write `src/lib/plan-baseline.spec.ts` covering **exactly the six T5 rows** at design.md:865 — different `composePath` (an older matching plan wins), different `profiles`, `intent: "managed-update"`, `composeHash: ""`, no candidate → `no-comparable-plan`, directory absent/unreadable → `plan-history-unreadable`. Do **not** add a seventh row. No `expect(...).rejects` assertion may appear anywhere in the file.
- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/lib/plan-baseline.spec.ts` passes with exactly the six T5 rows.
  - `grep -c 'throw' packages/rfapps-cli/src/lib/plan-baseline.ts` returns 0; `grep -c 'rejects' packages/rfapps-cli/src/lib/plan-baseline.spec.ts` returns 0.
  - `grep -c 'listPlans' packages/rfapps-cli/src/lib/plan-baseline.ts` returns 0; `grep -c 'readdir' …` returns exactly 1; `grep -c 'MAX_BASELINE_CANDIDATES' …` returns at least 1.
  - `git status --porcelain -- packages/rfapps-cli/src/lib/plan-storage.ts` is empty.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in either owned file.

### Task T8: `src/lib/formatters/plan-intelligence.ts` — renderers + formatters barrel (test T8)

- **Owns:** `packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts` (new), `packages/rfapps-cli/src/lib/formatters/plan-intelligence.spec.ts` (new), `packages/rfapps-cli/src/lib/formatters/index.ts`
- **Reads:** design.md:371-386 (signatures), :570-658 (**the complete rendering spec, with sample output**), :874-875 (T8), `src/lib/formatters/diff-helpers.spec.ts` (in-repo precedent for output-string testing with identity-mocked colors).
- **Depends on:** T1
- **Instructions:**
  1. Create `src/lib/formatters/plan-intelligence.ts` exporting `formatServiceIntelligenceLines` and `formatPlanIntelligenceLines` with the exact signatures at design.md:375-385. Both are **pure**: they return `string[]` with no leading indent and contain **no `console.` call**. Both return `[]` for `undefined` input.
  2. `formatServiceIntelligenceLines` — **concise mode** (design.md:593-601), prescriptively:
     - lead clause = the **provenance** reason's summary if one exists, else the top-ranked **trigger** summary with `(forces <changeType>)` appended when `decisive`;
     - optional second clause joined by `"; "` — if the lead was provenance, the decisive trigger dimensions abbreviated (`environment, volumes differ`); if the lead was a trigger, the non-decisive dimensions (`environment also differs`), or nothing;
     - space-prefixed suffix `[inferred]` **only** when the lead reason's `confidence === "inferred"`;
     - the `impact:` line is emitted **only when `dependentCount > 0`** — omitted entirely at zero, never printed as a reassuring `0 dependents`.
  3. `formatServiceIntelligenceLines` — **verbose mode** (design.md:633-658): the `[kind/confidence/forces <changeType>]`-tagged reason block with indented evidence lines, the `impact:` sub-block (`effect`, `core service`, `dependents: N declared (M running) — a, b, …`, `changing dependencies`), and an explicit `(+N more)` suffix when `dependentsTruncated` is true.
  4. `formatPlanIntelligenceLines` must emit, per design.md:603-631:
     - the `Registry drift (compose unchanged, upstream image moved):` section built from `registry-image-drifted` reasons — this is the **only** way registry-drifted `unchanged` services ever become visible, since default text output iterates only the create/recreate/update/delete buckets (design.md:459);
     - the `→ N downstream services declare depends_on a changing service` summary line;
     - the `Change origin: …` line for the `previous-plan` provenance arm;
     - the three degraded one-liners, verbatim: `Change origin: unavailable (…)`, `Registry drift not checked (add --check-updates)`, `Runtime state unavailable (docker compose ps failed); cause annotations suppressed`.
  5. Wording rules (design.md:18, :524) are load-bearing: "N services declare depends_on X", never "will break"; "the locally cached image for this reference is behind the registry"; "no running container found (a stopped container is not inspected)".
  6. Re-export both functions from `src/lib/formatters/index.ts` following the existing barrel style.
  7. Write `src/lib/formatters/plan-intelligence.spec.ts` with **exactly two** `it` blocks (or two `it.each` groups) covering only T8's two rules (design.md:874): (a) `impact:` omitted entirely when `dependentCount === 0`; (b) the concise `why:` line carries space-prefixed `[inferred]` when the lead reason is inferred and omits it when `confirmed`. Add no other test — renderer tests beyond these two are explicitly "deliberately not written".
- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/lib/formatters/plan-intelligence.spec.ts src/lib/formatters/formatters.spec.ts src/lib/formatters/diff-helpers.spec.ts` passes.
  - The new spec contains exactly two `it`/`it.each` groups.
  - `grep -c 'console\.' packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts` returns 0.
  - Each of these greps over `packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts` returns ≥ 1: `'Registry drift ('`, `'Change origin'`, `'Registry drift not checked (add --check-updates)'`, `'Runtime state unavailable'`, `'downstream services declare depends_on'`, `'(+'` (the `(+N more)` truncation), `'[inferred]'`.
  - `grep -c 'will break' packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts` returns 0.
  - `grep -n 'formatServiceIntelligenceLines\|formatPlanIntelligenceLines' packages/rfapps-cli/src/lib/formatters/index.ts` returns two hits.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in any owned file.

---

## Batch 3 — Wiring: generator + lib barrel, and the action layer

Two tasks over disjoint files. They are mutually independent: `actions/plan.ts` type-checks against `PlanOptions.intelligence` (T1) and imports `generatePlan` directly from `../lib/plan-generator.js`, so it needs T9's _file contents_ not at all. Neither task touches an MCP file.

### Task T9: `plan-generator` refactor, gated `buildPlanIntelligence` call, lib barrel (checklist item 23)

- **Owns:** `packages/rfapps-cli/src/lib/plan-generator.ts`, `packages/rfapps-cli/src/lib/plan-generator.spec.ts`, `packages/rfapps-cli/src/lib/index.ts`
- **Reads:** design.md:286-318, :830 (item 23), :922 (non-goal 5), `plan-generator.ts:588-595` (private `determineChangeType`, six params), `plan-generator.spec.ts:98-119` (the fingerprint secret-freedom assertion).
- **Depends on:** T2, T6, T7
- **Instructions:**
  1. Refactor the private `determineChangeType` to return `{ changeType, decisive: readonly ChangeDimension[] }` (design.md:298-301). Import `ChangeDimension` from `../types/plan-intelligence.js` (see T1 step 3). **Change no verdict** — every existing `changeType` outcome must be byte-identical (design.md:922, non-goal 5). One cascade, one source of truth; the classifier reads this verdict instead of re-implementing it.
  2. `generatePlan` accumulates `decisiveByService: Map<string, readonly ChangeDimension[]>` and, immediately before building the returned plan object (after the `checkUpdates` pass, after `summary`), makes **exactly one** gated call, transcribed from design.md:306-318:

     ```ts
     if (options.intelligence !== undefined) {
       plan.intelligence = buildPlanIntelligence({ … });
     }
     ```

     Import `buildPlanIntelligence` from `"./plan-intelligence.js"` directly, not from the barrel. `runtimeStateObserved` is `serviceContainerMap !== undefined`; `runningServices` is `new Set(containerMap.keys())`; `registryChecked` is `options.checkUpdates === true`.

  3. `src/lib/index.ts` (checklist item 10): re-export `buildPlanIntelligence`, `loadPlanBaseline`, and `invertDependencyMap`, following the existing barrel style (note `buildServiceDependencyGraph` is already re-exported from `./dependency-graph.js` at ~:291-295). This criterion describes the **barrel's contents** — consumers inside `src/lib/` continue to import directly by path.
  4. `src/lib/plan-generator.spec.ts` (checklist item 23): add ~4 assertion lines to the **existing** full-plan test (~:121) proving (a) the refactor moved no `changeType` verdict and (b) **no `intelligence` key appears** when `options.intelligence` is absent. The no-key assertion must test **key presence** (`expect("intelligence" in plan).toBe(false)` or `Object.keys(plan)`), not a value-`undefined` check — a present-but-undefined key would still break the byte-identical machine contract. Modify no other assertion in the file.

- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/lib/plan-generator.spec.ts` passes.
  - `git diff HEAD -- packages/rfapps-cli/src/lib/plan-generator.spec.ts | grep -c '^-[^-]'` returns 0 (additions only — no pre-existing assertion was modified or deleted).
  - `grep -c 'buildPlanIntelligence' packages/rfapps-cli/src/lib/plan-generator.ts` returns 2 (the import and the single call site), and the call site is inside an `options.intelligence !== undefined` guard.
  - `grep -n 'invertDependencyMap\|buildPlanIntelligence\|loadPlanBaseline' packages/rfapps-cli/src/lib/index.ts` returns three hits.
  - `grep -c '"intelligence" in \|Object.keys' packages/rfapps-cli/src/lib/plan-generator.spec.ts` returns ≥ 1.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in any owned file.

### Task T10: `actions/plan.ts` — `--explain` plumbing, rendering, `planResultForOutput` (checklist item 22)

- **Owns:** `packages/rfapps-cli/src/actions/plan.ts`, `packages/rfapps-cli/src/actions/plan.spec.ts`
- **Reads:** design.md:544-568 (plumbing, with the exact conditional-spread snippet), :570-663 (what must be rendered), :829 (item 22), `actions/plan.ts:43` (`RawPlanOptions`, module-private), `:60` (normalized `PlanOptions`), `:82` (`displayServiceChange`), `:170` (`displayPlan`), `:275` (the `executePlan(rawOptions, …)` entry), `deploy.ts:159-167` (`deployResultForOutput`, the pattern to mirror), `plan.spec.ts:12` (wholesale `vi.mock("../lib/index.js")`), `plan.spec.ts:168-176` (the exact-literal `generatePlan` assertion).
- **Depends on:** T1, T7, T8
- **Instructions:**
  1. Add `explain?: boolean` to the module-private `RawPlanOptions` (`plan.ts:43`) and `explain: boolean` to the normalized `PlanOptions` (`plan.ts:60`), normalizing in the existing options-normalization block. **This `RawPlanOptions.explain` field is a hard prerequisite for Batch 4's `mcp/adapters.ts` edit** — `invokePlan` passes a fresh object literal into `executePlan`, so TypeScript's excess-property check rejects `explain` until this field exists (reproduced: `TS2353: Object literal may only specify known properties, and 'explain' does not exist in type 'RawPlanOptions'`).
  2. Build the intelligence input and call the generator using the **conditional spread verbatim** from design.md:549-565:

     ```ts
     const intelligence = options.explain
       ? {
           profileMapping: finalConfig.profiles?.mapping ?? {},
           baseline: await loadPlanBaseline(finalConfig.composePath, profiles),
         }
       : undefined;

     const plan = await generatePlan(
       {
         composePath: finalConfig.composePath,
         services: services.length > 0 ? services : undefined,
         profiles,
         checkUpdates: options.checkUpdates,
         ...(intelligence === undefined ? {} : { intelligence }),
       },
       envTool,
     );
     ```

     **Do not "simplify" this to `intelligence: options.explain ? {…} : undefined`.** That adds an `intelligence: undefined` key to the object literal and breaks the exact-literal assertion at `plan.spec.ts:168-176`, plus every other existing plan-action test. The conditional spread is the sole mechanism preserving the byte-identical machine contract.

  3. **Import `loadPlanBaseline` from `"../lib/plan-baseline.js"` directly, never from `"../lib/index.js"`.** `plan.spec.ts:12` does a wholesale `vi.mock("../lib/index.js")`, so a barrel import would be silently auto-mocked and the new `--explain` test would assert against a ghost.
  4. `loadPlanBaseline` must be called **only** inside the `options.explain` branch — baseline loading is filesystem I/O and must not run on every `rfapps plan`, nor for `managed-update`/`doctor`, which also call `generatePlan` (design.md:12).
  5. **Rendering wiring (checklist item 12, the half of the feature with no test coverage by design):**
     - in `displayServiceChange` (`plan.ts:82`), call `formatServiceIntelligenceLines(plan.intelligence?.services[change.service], { verbose })` and emit each returned line via `console.error` with the existing two-space indent, **before** the existing diff block;
     - in the plan-level path (`displayPlan`, `plan.ts:170`), call `formatPlanIntelligenceLines(plan.intelligence, plan.services, { verbose })` and emit each line via `console.error` for the registry-drift section, the summary `→` line, the `Change origin:` line, and the degraded banners.
       All human rendering stays on **stderr**; stdout remains reserved for the machine payload (design.md:568).
  6. Add `planResultForOutput(format, payload)` mirroring `deployResultForOutput` (`deploy.ts:159-167`): it strips `plan.intelligence` for `table` and `csv` **only** (design.md:662). JSON and YAML carry the payload. This does not fix `--output csv`, which already throws today; it only guarantees the new payload does not deepen an already-broken path.
  7. `src/actions/plan.spec.ts` (item 22): add **exactly one** new `it` block for the `--explain` path, extending the existing mock set with a mock of `"../lib/plan-baseline.js"`. It must assert (a) `generatePlan` was called with an object carrying `intelligence`, and (b) `consoleErrorSpy` received at least one line matching `/^\s+why:/` — proving the renderer is actually wired, not dead code. Touch no existing `it` block; the exact-literal assertion at `:168-176` must stay byte-identical (existing cases never set `explain`).

- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/actions/plan.spec.ts` passes.
  - `git diff HEAD -- packages/rfapps-cli/src/actions/plan.spec.ts | grep -c '^-[^-]'` returns 0 (additions only).
  - `grep -n 'formatServiceIntelligenceLines' packages/rfapps-cli/src/actions/plan.ts` hits inside `displayServiceChange`; `grep -n 'formatPlanIntelligenceLines' packages/rfapps-cli/src/actions/plan.ts` hits in the plan-level path; both emit via `console.error`.
  - `grep -n 'function planResultForOutput' packages/rfapps-cli/src/actions/plan.ts` returns a hit, and its body strips `intelligence` for `table` and `csv` only.
  - `grep -n 'from "../lib/plan-baseline.js"' packages/rfapps-cli/src/actions/plan.ts` returns a hit; `grep -c 'loadPlanBaseline' packages/rfapps-cli/src/actions/plan.ts` shows the call occurring only inside the `options.explain` branch.
  - `grep -c 'intelligence === undefined ? {} : { intelligence }' packages/rfapps-cli/src/actions/plan.ts` returns 1.
  - `grep -n 'explain' packages/rfapps-cli/src/actions/plan.ts` shows `explain?: boolean` on `RawPlanOptions` and `explain: boolean` on the normalized `PlanOptions`.
  - Advisory: `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` reports no error in either owned file.

---

## Batch 4 — MCP mirror (schema, adapter, T6 round-trip)

One task owning all three MCP files. It is terminal by necessity: `mcp/adapters.ts` compiles only after **both** `PlanToolArgs.explain` (this task's own `schema.ts` edit) and `RawPlanOptions.explain` (T10, Batch 3) exist, and the T6 round-trip test needs a real `buildPlanIntelligence` output (T6, Batch 2). Keeping `schema.ts` and `adapters.ts` in one task removes the cross-task type dependency entirely.

### Task T11: MCP schema mirror, `explain` passthrough, and the T6 real round-trip

- **Owns:** `packages/rfapps-cli/src/mcp/schema.ts`, `packages/rfapps-cli/src/mcp/adapters.ts`, `packages/rfapps-cli/src/mcp/schema.spec.ts`
- **Reads:** design.md:666-749 (the complete schema block), :868-869 (T6 rationale), `mcp/schema.ts:~1028-1048` (the `_typeCheck` anchor), `mcp/adapters.ts:402-427` (`invokePlan`), `mcp/schema.spec.ts:~583` (the existing legacy-payload / unknown-key test), `packages/rf-common/src/mcp/schema.ts:344` (`schemaRecord`) and `:182` (`schemaNumber({ integer, minimum })`).
- **Depends on:** T1, T6, T10
- **Instructions:**
  1. `src/mcp/schema.ts` — transcribe design.md:677-736 exactly. Import `CHANGE_REASON_CODES` and `PLAN_INTELLIGENCE_SCHEMA_VERSION` from `"../types/plan-intelligence.js"`. Add `changeReasonSchema`, `serviceImpactSchema`, and `planIntelligenceSchema`. `schemaRecord` and `schemaNumber` exist in `@rfmedia/common` but are not currently imported by this file — add them to the import list.
  2. **`dominantReason` must be `schemaOptional(schemaEnum(CHANGE_REASON_CODES))`, not `schemaString()`** (design.md:741). `schemaOptional(schemaString())` infers `string | undefined`, which is not assignable to `ChangeReasonCode | undefined`; `McpSchema<T>` is covariant, so the `_typeCheck` anchor would fail to compile, and dropping the anchor would publish an unconstrained string to MCP clients.
  3. Five mandatory sub-edits (checklist item 15): `deploymentPlanSchema` gains exactly one key `intelligence: schemaOptional(planIntelligenceSchema)`; `planInputSchema` gains `explain: schemaOptional(schemaBoolean())`; `PlanToolArgs` gains `explain?: boolean`; `_typeCheck` gains `planIntelligence: McpSchema<PlanIntelligence>`. `serviceChangeSchema`, `planSummarySchema`, and `planResultSchema` are **unchanged** (design.md:739).
  4. **Non-goal (explicit):** do **not** add any MCP schema entry for `ChangeDimension`. It is build-time only and never serialized (see T1 step 3).
  5. `src/mcp/adapters.ts` (checklist item 16): add exactly one line — `explain: args.explain,` — to the object literal inside `invokePlan` (`:402-427`).
  6. `src/mcp/schema.spec.ts` (T6, checklist item 20): add one test that imports `buildPlanIntelligence` from `"../lib/plan-intelligence.js"`, feeds an **actual builder output** — no hand-written `PlanIntelligence` literal — into `rfappsMcpSchemas.plan.output.parse`, and asserts it parses and retains `plan.intelligence`. Exercise **both** `provenance` union arms (`baseline: "none"` and `baseline: "previous-plan"`). A hand-written literal defeats the test's entire purpose: `McpSchema<T>` is covariant, so a schema _omitting_ an optional field still satisfies the `_typeCheck` anchor and `npm run typecheck` cannot catch it — only a real round-trip can. Leave every pre-existing test in the file, including the unknown-key rejection case at ~:583, unchanged.
- **Done when:**
  - `umask 022 && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli -- src/mcp/` passes, including the new round-trip case and all pre-existing cases.
  - `umask 022 && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli` exits 0 (this is authoritative here — T11 is alone in its batch).
  - `grep -c 'schemaEnum(CHANGE_REASON_CODES)' packages/rfapps-cli/src/mcp/schema.ts` returns 2 (the `code` field and `dominantReason`).
  - `grep -n 'planIntelligence: McpSchema<PlanIntelligence>' packages/rfapps-cli/src/mcp/schema.ts` returns one hit in the `_typeCheck` anchor.
  - `grep -n 'explain' packages/rfapps-cli/src/mcp/schema.ts` shows both `explain?: boolean` on `PlanToolArgs` and `explain: schemaOptional(schemaBoolean())` on `planInputSchema`.
  - `grep -c 'ChangeDimension' packages/rfapps-cli/src/mcp/schema.ts` returns 0.
  - `git diff HEAD -- packages/rfapps-cli/src/mcp/adapters.ts | grep -c '^+[^+]'` returns 1.
  - `git diff HEAD -- packages/rfapps-cli/src/mcp/schema.spec.ts | grep -c '^-[^-]'` returns 0 (additions only).
  - The new spec test contains no hand-written `PlanIntelligence` object literal.

---

## Batch 5 — Full verification gate (serialized, one task)

Alone in its batch. It must observe the fully assembled tree — cross-module type resolution, all eight tests together, `prettier --write .` across every source, spec, and markdown file, and repo-wide markdownlint — none of which any earlier batch can see in isolation. `npm run format:all` rewrites files across the whole repo, which is safe only because nothing else is running.

### Task T12: Run the design's verification gate and repair integration fallout

- **Owns:** every path owned by T0-T11 (the union below). T12 holds exclusive whole-tree write access for the `prettier --write .` pass; no other task may run concurrently.
  `packages/rfapps-cli/src/types/plan-intelligence.ts`, `packages/rfapps-cli/src/types/plan.ts`, `packages/rfapps-cli/src/types/index.ts`, `packages/rfapps-cli/src/lib/dependency-graph.ts`, `packages/rfapps-cli/src/lib/staged-rollout.ts`, `packages/rfapps-cli/src/lib/plan-intelligence.ts`, `packages/rfapps-cli/src/lib/plan-intelligence.spec.ts`, `packages/rfapps-cli/src/lib/plan-baseline.ts`, `packages/rfapps-cli/src/lib/plan-baseline.spec.ts`, `packages/rfapps-cli/src/lib/formatters/plan-intelligence.ts`, `packages/rfapps-cli/src/lib/formatters/plan-intelligence.spec.ts`, `packages/rfapps-cli/src/lib/formatters/index.ts`, `packages/rfapps-cli/src/lib/plan-generator.ts`, `packages/rfapps-cli/src/lib/plan-generator.spec.ts`, `packages/rfapps-cli/src/lib/index.ts`, `packages/rfapps-cli/src/actions/plan.ts`, `packages/rfapps-cli/src/actions/plan.spec.ts`, `packages/rfapps-cli/src/actions/completion.ts`, `packages/rfapps-cli/src/actions/completion.spec.ts`, `packages/rfapps-cli/src/cli.ts`, `packages/rfapps-cli/src/mcp/schema.ts`, `packages/rfapps-cli/src/mcp/schema.spec.ts`, `packages/rfapps-cli/src/mcp/adapters.ts`, `packages/rfapps-cli/README.md`, `docs/features/rfapps-plan-intelligence.md`, `docs/features/plan-apply-workflow.md`, `docs/features/shell-completion.md`, `docs/features/quick-reference.md`, `docs/README.md`, `AGENTS.md`, `ROADMAP.md`, plus whatever `prettier --write .` reformats.
- **Reads:** design.md:792-845 (the 31-item checklist), :886-896 (the gate).
- **Depends on:** T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11
- **Instructions:**
  1. Run the design's five-stage gate as **one uninterrupted command** (see Final verification below).
  2. Repair any failure. Record every repair edit made to a file another task owns, so a reviewer can distinguish gate repairs from the owning task's work.
  3. Run the checklist accounting below. Use `git status --porcelain` (not bare `git diff`), because `git diff --stat` reports tracked modifications only and never lists the eight brand-new files, and because `design.md` is already staged.
  4. Assert the seven "Not changed (verified)" paths are absent from the change set (design.md:845): `src/actions/apply.ts`, `src/lib/plan-storage.ts`, `src/lib/managed-update.ts`, `src/lib/schema.sql`, `src/lib/migrations.ts`, `src/types/state.ts`, `CLAUDE.md`.
  5. Assert the spec-file inventory is exactly right: **three added** spec files (`src/lib/plan-intelligence.spec.ts`, `src/lib/plan-baseline.spec.ts`, `src/lib/formatters/plan-intelligence.spec.ts`) and **four modified** spec files (`src/mcp/schema.spec.ts`, `src/actions/completion.spec.ts`, `src/actions/plan.spec.ts`, `src/lib/plan-generator.spec.ts`), with no other `*.spec.ts` path in the change set. (The repo already contains ~100 spec files; the check is on the _change set_, not the tree.)
  6. Report the exact command output.
- **Done when:**
  - The five-stage gate exits 0 end to end in a single run.
  - `git status --porcelain` covers all 32 actionable files (the design's 30 actionable code/doc/test files + `docs/README.md` + the already-staged `design.md`) and none of the seven "Not changed (verified)" paths.
  - `git ls-files --error-unmatch docs/plans/152-contextual-plan-intelligence/design.md` exits 0 (checklist item 31).
  - The spec-file inventory check in step 5 passes exactly.
  - `git status --porcelain -- packages/rfapps-cli/AGENTS.md packages/rfmedia-cli/AGENTS.md CLAUDE.md packages/rfapps-cli/CLAUDE.md docs/roadmap-archive.md` is empty.

---

## Coverage matrix

| #   | Checklist item (design.md:792-845)                                                     | Owner                                                |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | `src/types/plan-intelligence.ts` (new)                                                 | T1                                                   |
| 2   | `src/lib/plan-intelligence.ts` (new)                                                   | T6                                                   |
| 3   | `src/lib/plan-baseline.ts` (new)                                                       | T7                                                   |
| 4   | `src/lib/formatters/plan-intelligence.ts` (new)                                        | T8                                                   |
| 5   | `src/types/plan.ts` — `DeploymentPlan.intelligence?`, `PlanOptions.intelligence?`      | T1                                                   |
| 6   | `src/types/index.ts` — re-export types + both runtime constants                        | T1                                                   |
| 7   | `src/lib/dependency-graph.ts` — export `invertDependencyMap`                           | T2                                                   |
| 8   | `src/lib/staged-rollout.ts` — `computeFanIn` derives from it                           | T2                                                   |
| 9   | `src/lib/plan-generator.ts` — `{changeType, decisive}` + gated call                    | T9                                                   |
| 10  | `src/lib/index.ts` — barrel                                                            | T9                                                   |
| 11  | `src/lib/formatters/index.ts` — barrel                                                 | T8                                                   |
| 12  | `src/actions/plan.ts` — plumbing, baseline, rendering, `planResultForOutput`           | T10                                                  |
| 13  | `src/cli.ts` — `.option("--explain", …, false)`                                        | T3                                                   |
| 14  | `src/actions/completion.ts` — bash + zsh + fish templates                              | T3                                                   |
| 15  | `src/mcp/schema.ts` — 5 sub-edits                                                      | T11                                                  |
| 16  | `src/mcp/adapters.ts` — `explain` passthrough                                          | T11                                                  |
| 17  | `src/lib/plan-intelligence.spec.ts` (new)                                              | T6                                                   |
| 18  | `src/lib/plan-baseline.spec.ts` (new)                                                  | T7                                                   |
| 19  | `src/lib/formatters/plan-intelligence.spec.ts` (new)                                   | T8                                                   |
| 20  | `src/mcp/schema.spec.ts` (modified)                                                    | T11                                                  |
| 21  | `src/actions/completion.spec.ts` (modified)                                            | T3                                                   |
| 22  | `src/actions/plan.spec.ts` (modified)                                                  | T10                                                  |
| 23  | `src/lib/plan-generator.spec.ts` (modified)                                            | T9                                                   |
| 24  | `packages/rfapps-cli/README.md` — table row **and** workflow example                   | T4                                                   |
| 25  | `docs/features/plan-apply-workflow.md`                                                 | T4                                                   |
| 26  | `docs/features/rfapps-plan-intelligence.md` (new)                                      | T4                                                   |
| 27  | `docs/features/shell-completion.md`                                                    | T4                                                   |
| 28  | `docs/features/quick-reference.md`                                                     | T4                                                   |
| 29  | `AGENTS.md` (repo root)                                                                | T5                                                   |
| 30  | `ROADMAP.md` (repo root)                                                               | T5                                                   |
| 31  | `docs/plans/152-contextual-plan-intelligence/design.md`                                | already present and staged; presence verified by T12 |
| +1  | `docs/README.md` — features index (added beyond the design's checklist; see T4 step 6) | T4                                                   |

| Test | Subject                                                                             | Owner |
| ---- | ----------------------------------------------------------------------------------- | ----- |
| T1   | trigger cascade matrix (`plan-intelligence.spec.ts`)                                | T6    |
| T2   | provenance matrix + degradation (`plan-intelligence.spec.ts`)                       | T6    |
| T3   | bounds, secret-freedom, non-negative counters (`plan-intelligence.spec.ts`)         | T6    |
| T4   | impact graph — cycle, diamond, out-of-scope dependent (`plan-intelligence.spec.ts`) | T6    |
| T5   | baseline scope gating + never-throws (`plan-baseline.spec.ts`)                      | T7    |
| T6   | MCP real round-trip (`mcp/schema.spec.ts`)                                          | T11   |
| T7   | completion parity token (`actions/completion.spec.ts`)                              | T3    |
| T8   | two safety-critical rendering rules (`formatters/plan-intelligence.spec.ts`)        | T8    |

No other test is created. Checklist items 22 and 23 are non-numbered regression additions to existing specs that the design's checklist mandates; they are not new T-tests.

---

## Final verification

Run by T12, from the worktree root, as one uninterrupted command:

```bash
umask 022 && env -u FORCE_COLOR npm run build -w packages/rf-common \
  && env -u FORCE_COLOR npm run typecheck -w packages/rfapps-cli \
  && env -u FORCE_COLOR npm run test:run -w packages/rfapps-cli \
  && npm run format:all \
  && npm run lint:md
```

Then the accounting checks:

```bash
# 1. No "Not changed (verified)" file was touched (design.md:845)
git status --porcelain -- \
  packages/rfapps-cli/src/actions/apply.ts \
  packages/rfapps-cli/src/lib/plan-storage.ts \
  packages/rfapps-cli/src/lib/managed-update.ts \
  packages/rfapps-cli/src/lib/schema.sql \
  packages/rfapps-cli/src/lib/migrations.ts \
  packages/rfapps-cli/src/types/state.ts \
  CLAUDE.md packages/rfapps-cli/CLAUDE.md \
  packages/rfapps-cli/AGENTS.md packages/rfmedia-cli/AGENTS.md \
  docs/roadmap-archive.md
# expected: empty output

# 2. Exact spec inventory: 3 added, 4 modified, nothing else
git status --porcelain | grep '\.spec\.ts$'
# expected exactly:
#   ?? packages/rfapps-cli/src/lib/plan-intelligence.spec.ts
#   ?? packages/rfapps-cli/src/lib/plan-baseline.spec.ts
#   ?? packages/rfapps-cli/src/lib/formatters/plan-intelligence.spec.ts
#    M packages/rfapps-cli/src/mcp/schema.spec.ts
#    M packages/rfapps-cli/src/actions/completion.spec.ts
#    M packages/rfapps-cli/src/actions/plan.spec.ts
#    M packages/rfapps-cli/src/lib/plan-generator.spec.ts

# 3. Checklist item 31 is present in the index
git ls-files --error-unmatch docs/plans/152-contextual-plan-intelligence/design.md

# 4. Full change set covers all 32 actionable files
git status --porcelain | wc -l
```

`format:all` (not `format`) is required — `format` is `prettier --write` with no path argument. `env -u FORCE_COLOR` and `umask 022` are known environment traps in this workspace that otherwise fail unrelated rf-common logger and filesystem tests.
